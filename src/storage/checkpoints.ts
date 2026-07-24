import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  link,
  open,
  opendir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { TiledMcpError } from "../errors.js";
import { parseJsonDocument } from "../formats/json.js";
import type { ProjectPathResolver } from "../project/pathResolver.js";
import { revisionOf } from "./revision.js";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_CHECKPOINT_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_CHECKPOINT_LABEL_LENGTH = 1_024;
export const MAX_CHECKPOINT_TIMESTAMP_LENGTH = 64;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;
const DEFAULT_SCAN_LIMIT = 1_000;
const MAX_SCAN_LIMIT = 10_000;
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OBJECT_HASH_PATTERN = /^[0-9a-f]{64}$/u;
export const CHECKPOINT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CHECKPOINT_MANIFEST_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/iu;
const CHECKPOINT_TEMP_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/iu;

export interface CheckpointManifest {
  version: 1;
  id: string;
  createdAt: string;
  label: string;
  path: string;
  status: "prepared" | "committed";
  before:
    | { existed: false }
    | {
        existed: true;
        revision: string;
        objectHash: string;
        size: number;
      };
  afterRevision: string;
}

export interface CheckpointListOptions {
  /** Maximum valid and corrupt entries returned together. */
  limit?: number;
  /** Maximum directory entries inspected, including ignored atomic-write temp files. */
  scanLimit?: number;
  status?: CheckpointManifest["status"];
}

export interface CorruptCheckpointEntry {
  fileName: string;
  checkpointId?: string;
  code: "CHECKPOINT_CORRUPT";
  message: string;
}

export interface CheckpointListResult {
  manifests: CheckpointManifest[];
  corruptEntries: CorruptCheckpointEntry[];
  scannedEntries: number;
  truncated: boolean;
}

export class CheckpointStore {
  constructor(private readonly resolver: ProjectPathResolver) {}

  async prepare(
    projectPath: string,
    before: Buffer | undefined,
    afterRevision: string,
    label: string,
  ): Promise<CheckpointManifest> {
    if (label.length > MAX_CHECKPOINT_LABEL_LENGTH) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `Checkpoint labels may contain at most ${MAX_CHECKPOINT_LABEL_LENGTH} characters.`,
      );
    }
    if (!REVISION_PATTERN.test(afterRevision)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "Checkpoint afterRevision must be a SHA-256 revision.",
      );
    }
    const objectsDirectory = await this.resolver.ensureInternalDirectory(".tiledmcp/objects");
    const checkpointsDirectory =
      await this.resolver.ensureInternalDirectory(".tiledmcp/checkpoints");

    let beforeState: CheckpointManifest["before"] = { existed: false };
    if (before) {
      const objectHash = createHash("sha256").update(before).digest("hex");
      await writeOnce(join(objectsDirectory, objectHash), before);
      beforeState = {
        existed: true,
        revision: revisionOf(before),
        objectHash,
        size: before.byteLength,
      };
    }

    const manifest: CheckpointManifest = {
      version: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      label,
      path: projectPath,
      status: "prepared",
      before: beforeState,
      afterRevision,
    };
    await atomicWriteJson(join(checkpointsDirectory, `${manifest.id}.json`), manifest);
    return manifest;
  }

  async markCommitted(manifest: CheckpointManifest): Promise<CheckpointManifest> {
    const checkpointsDirectory =
      await this.resolver.ensureInternalDirectory(".tiledmcp/checkpoints");
    const current = await this.readManifest(
      checkpointsDirectory,
      manifest.id,
    );
    if (!sameManifestIntent(manifest, current)) {
      throw new TiledMcpError(
        "CHECKPOINT_CHANGED",
        `Checkpoint ${manifest.id} changed before it could be committed.`,
        { checkpointId: manifest.id },
      );
    }
    if (current.status === "committed") {
      return current;
    }
    const committed: CheckpointManifest = {
      ...current,
      status: "committed",
    };
    await atomicWriteJson(join(checkpointsDirectory, `${manifest.id}.json`), committed);
    return committed;
  }

  async read(id: string): Promise<CheckpointManifest> {
    assertCheckpointId(id);
    const checkpointsDirectory =
      await this.resolver.ensureInternalDirectory(".tiledmcp/checkpoints");
    return this.readManifest(checkpointsDirectory, id);
  }

  async list(options: CheckpointListOptions = {}): Promise<CheckpointListResult> {
    const limit = readListLimit(options.limit, "limit", DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const scanLimit = readListLimit(
      options.scanLimit,
      "scanLimit",
      DEFAULT_SCAN_LIMIT,
      MAX_SCAN_LIMIT,
    );
    if (
      options.status !== undefined &&
      options.status !== "prepared" &&
      options.status !== "committed"
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "Checkpoint status must be prepared or committed.",
      );
    }

    const checkpointsDirectory =
      await this.resolver.ensureInternalDirectory(".tiledmcp/checkpoints");
    const directory = await opendir(checkpointsDirectory);
    const manifests: CheckpointManifest[] = [];
    const corruptEntries: CorruptCheckpointEntry[] = [];
    let scannedEntries = 0;
    let truncated = false;
    try {
      while (true) {
        const entry = await directory.read();
        if (!entry) {
          break;
        }
        if (scannedEntries >= scanLimit) {
          truncated = true;
          break;
        }
        scannedEntries += 1;

        // Interrupted atomic manifest writes can leave these private temporary
        // files behind. They are not checkpoint entries and are safe to ignore.
        if (CHECKPOINT_TEMP_PATTERN.test(entry.name)) {
          continue;
        }

        const match = CHECKPOINT_MANIFEST_PATTERN.exec(entry.name);
        if (!match) {
          if (manifests.length + corruptEntries.length >= limit) {
            truncated = true;
            break;
          }
          corruptEntries.push({
            fileName: entry.name,
            code: "CHECKPOINT_CORRUPT",
            message: "Unexpected entry in the checkpoint manifest directory.",
          });
          continue;
        }

        const id = match[1] as string;
        try {
          const manifest = await this.readManifest(checkpointsDirectory, id);
          if (options.status !== undefined && manifest.status !== options.status) {
            continue;
          }
          if (manifests.length + corruptEntries.length >= limit) {
            truncated = true;
            break;
          }
          manifests.push(manifest);
        } catch (error) {
          if (manifests.length + corruptEntries.length >= limit) {
            truncated = true;
            break;
          }
          corruptEntries.push(toCorruptEntry(entry.name, id, error));
        }
      }
    } finally {
      await directory.close().catch((error: unknown) => {
        if (!hasCode(error, "ERR_DIR_CLOSED")) {
          throw error;
        }
      });
    }

    manifests.sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        left.id.localeCompare(right.id),
    );
    corruptEntries.sort((left, right) => left.fileName.localeCompare(right.fileName));
    return {
      manifests,
      corruptEntries,
      scannedEntries,
      truncated,
    };
  }

  private async readManifest(
    checkpointsDirectory: string,
    id: string,
  ): Promise<CheckpointManifest> {
    let raw: string;
    try {
      const bytes = await readBoundedNoFollow(
        join(checkpointsDirectory, `${id}.json`),
        MAX_MANIFEST_BYTES,
        "checkpoint manifest",
      );
      raw = decodeUtf8Strict(bytes, `checkpoint manifest ${id}`);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        throw new TiledMcpError("CHECKPOINT_NOT_FOUND", `Checkpoint ${id} does not exist.`, {
          checkpointId: id,
        });
      }
      throw error;
    }
    const manifest = parseManifest(raw, id);
    let normalizedPath: string;
    try {
      normalizedPath = this.resolver.normalize(manifest.path);
    } catch {
      throw new TiledMcpError(
        "CHECKPOINT_CORRUPT",
        `Checkpoint ${id} contains an invalid project path.`,
        { checkpointId: id },
      );
    }
    if (normalizedPath === ".tiledmcp" || normalizedPath.startsWith(".tiledmcp/")) {
      throw new TiledMcpError(
        "CHECKPOINT_CORRUPT",
        `Checkpoint ${id} targets internal server state.`,
        { checkpointId: id },
      );
    }
    return manifest;
  }

  async readBefore(manifest: CheckpointManifest): Promise<Buffer | undefined> {
    if (!manifest.before.existed) {
      return undefined;
    }
    const objectsDirectory = await this.resolver.ensureInternalDirectory(".tiledmcp/objects");
    const content = await readBoundedNoFollow(
      join(objectsDirectory, manifest.before.objectHash),
      MAX_CHECKPOINT_OBJECT_BYTES,
      "checkpoint object",
    ).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) {
        throw new TiledMcpError(
          "CHECKPOINT_CORRUPT",
          `Checkpoint ${manifest.id} is missing its content object.`,
          { checkpointId: manifest.id },
        );
      }
      throw error;
    });
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (
      actualHash !== manifest.before.objectHash ||
      revisionOf(content) !== manifest.before.revision ||
      content.byteLength !== manifest.before.size
    ) {
      throw new TiledMcpError(
        "CHECKPOINT_CORRUPT",
        `Checkpoint ${manifest.id} does not match its content hash.`,
        { checkpointId: manifest.id },
      );
    }
    return content;
  }
}

async function writeOnce(path: string, content: Buffer): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let temporaryHandle: FileHandle | undefined;
  let temporaryCreated = false;
  try {
    temporaryHandle = await open(
      temporaryPath,
      "wx",
      0o600,
    );
    temporaryCreated = true;
    await temporaryHandle.writeFile(content);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    try {
      await link(temporaryPath, path);
      await syncDirectory(dirname(path));
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
      const existing = await readBoundedNoFollow(
        path,
        MAX_CHECKPOINT_OBJECT_BYTES,
        "existing checkpoint object",
      );
      if (!existing.equals(content)) {
        throw new TiledMcpError(
          "CHECKPOINT_CORRUPT",
          "An existing content-addressed checkpoint object does not match its hash.",
        );
      }
    }
  } finally {
    await temporaryHandle
      ?.close()
      .catch(() => undefined);
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(
        () => undefined,
      );
    }
  }
}

async function atomicWriteJson(path: string, value: CheckpointManifest): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let temporaryHandle: FileHandle | undefined;
  let temporaryCreated = false;
  try {
    temporaryHandle = await open(
      temporaryPath,
      "wx",
      0o600,
    );
    temporaryCreated = true;
    await temporaryHandle.writeFile(
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await temporaryHandle
      ?.close()
      .catch(() => undefined);
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(
        () => undefined,
      );
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseManifest(raw: string, expectedId: string): CheckpointManifest {
  let value: unknown;
  try {
    value = parseJsonDocument(
      raw,
      `.tiledmcp/checkpoints/${expectedId}.json`,
    );
  } catch {
    throw new TiledMcpError(
      "CHECKPOINT_CORRUPT",
      `Checkpoint ${expectedId} is not valid safe JSON.`,
      { checkpointId: expectedId },
    );
  }
  if (!isRecord(value)) {
    throw corruptManifest(expectedId);
  }
  const before = value.before;
  const validBefore =
    isRecord(before) &&
    ((before.existed === false &&
      hasExactKeys(before, ["existed"])) ||
      (before.existed === true &&
        hasExactKeys(before, [
          "existed",
          "objectHash",
          "revision",
          "size",
        ]) &&
        typeof before.revision === "string" &&
        REVISION_PATTERN.test(before.revision) &&
        typeof before.objectHash === "string" &&
        OBJECT_HASH_PATTERN.test(before.objectHash) &&
        before.revision === `sha256:${before.objectHash}` &&
        typeof before.size === "number" &&
        Number.isSafeInteger(before.size) &&
        before.size >= 0 &&
        before.size <= MAX_CHECKPOINT_OBJECT_BYTES));
  if (
    !hasExactKeys(value, [
      "afterRevision",
      "before",
      "createdAt",
      "id",
      "label",
      "path",
      "status",
      "version",
    ]) ||
    value.id !== expectedId ||
    value.version !== 1 ||
    typeof value.createdAt !== "string" ||
    value.createdAt.length > MAX_CHECKPOINT_TIMESTAMP_LENGTH ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.label !== "string" ||
    value.label.length > MAX_CHECKPOINT_LABEL_LENGTH ||
    typeof value.path !== "string" ||
    (value.status !== "prepared" && value.status !== "committed") ||
    typeof value.afterRevision !== "string" ||
    !REVISION_PATTERN.test(value.afterRevision) ||
    !validBefore
  ) {
    throw corruptManifest(expectedId);
  }
  return value as unknown as CheckpointManifest;
}

function corruptManifest(expectedId: string): TiledMcpError {
  return new TiledMcpError(
    "CHECKPOINT_CORRUPT",
    `Checkpoint ${expectedId} has an invalid manifest.`,
    { checkpointId: expectedId },
  );
}

function sameManifestIntent(
  expected: CheckpointManifest,
  actual: CheckpointManifest,
): boolean {
  if (
    expected.version !== actual.version ||
    expected.id !== actual.id ||
    expected.createdAt !== actual.createdAt ||
    expected.label !== actual.label ||
    expected.path !== actual.path ||
    expected.afterRevision !== actual.afterRevision ||
    expected.before.existed !== actual.before.existed
  ) {
    return false;
  }
  if (!expected.before.existed || !actual.before.existed) {
    return true;
  }
  return (
    expected.before.revision === actual.before.revision &&
    expected.before.objectHash === actual.before.objectHash &&
    expected.before.size === actual.before.size
  );
}

async function readBoundedNoFollow(
  path: string,
  limit: number,
  description: string,
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (hasCode(error, "ELOOP")) {
      throw new TiledMcpError(
        "CHECKPOINT_CORRUPT",
        `Refusing to follow a symbolic link for ${description}.`,
      );
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) {
      throw new TiledMcpError(
        "CHECKPOINT_CORRUPT",
        `${description} is not a bounded regular file.`,
        {
          size:
            before.size <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(before.size)
              : before.size.toString(),
          limit,
        },
      );
    }
    const chunks: Buffer[] = [];
    const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1));
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(scratch, 0, scratch.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      if (total > limit) {
        throw new TiledMcpError(
          "CHECKPOINT_CORRUPT",
          `${description} exceeded its size limit while being read.`,
          { size: total, limit },
        );
      }
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
    const after = await handle.stat({ bigint: true });
    if (
      !sameFileSnapshot(before, after) ||
      BigInt(total) !== after.size
    ) {
      throw new TiledMcpError(
        "CHECKPOINT_CORRUPT",
        `${description} changed while it was being read.`,
      );
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function sameFileSnapshot(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertCheckpointId(id: string): void {
  if (!CHECKPOINT_ID_PATTERN.test(id)) {
    throw new TiledMcpError("INVALID_ARGUMENT", `Invalid checkpoint id: ${id}`);
  }
}

function readListLimit(
  value: number | undefined,
  name: string,
  defaultValue: number,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${name} must be a positive integer no greater than ${maximum}.`,
      { [name]: value, maximum },
    );
  }
  return value;
}

function toCorruptEntry(
  fileName: string,
  checkpointId: string,
  error: unknown,
): CorruptCheckpointEntry {
  if (error instanceof TiledMcpError) {
    return {
      fileName,
      checkpointId,
      code: "CHECKPOINT_CORRUPT",
      message:
        error.code === "CHECKPOINT_CORRUPT"
          ? error.message
          : `Checkpoint ${checkpointId} could not be safely read (${error.code}).`,
    };
  }
  const filesystemCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
      ? (error as NodeJS.ErrnoException).code
      : "UNKNOWN_ERROR";
  return {
    fileName,
    checkpointId,
    code: "CHECKPOINT_CORRUPT",
    message: `Checkpoint ${checkpointId} could not be safely read (${filesystemCode}).`,
  };
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function decodeUtf8Strict(content: Buffer, description: string): string {
  const decoded = content.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(content)) {
    throw new TiledMcpError(
      "CHECKPOINT_CORRUPT",
      `${description} is not valid UTF-8.`,
    );
  }
  return decoded;
}
