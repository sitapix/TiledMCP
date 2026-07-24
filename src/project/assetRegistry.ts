import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import { TiledMcpError } from "../errors.js";
import {
  parseJsonDocument,
  type JsonObject,
  type JsonValue,
} from "../formats/json.js";
import {
  fileIdentityOf,
  fileIdentityKey,
  sameFileIdentity,
  sameFileSnapshot,
  type FileIdentity,
} from "../storage/fileIdentity.js";
import { withProjectFileLock } from "../storage/fileLock.js";
import { KeyedMutex } from "../storage/keyedMutex.js";
import { shortHash } from "../storage/revision.js";
import type { ProjectPathResolver } from "./pathResolver.js";

export const ASSET_REGISTRY_FORMAT =
  "tiled-mcp-asset-registry" as const;
export const ASSET_REGISTRY_FORMAT_VERSION = 1 as const;
export const ASSET_REGISTRY_RELATIVE_PATH =
  ".tiledmcp/asset-registry.v1.json" as const;
export const MAX_ASSET_REGISTRY_BYTES =
  8 * 1024 * 1024;
export const MAX_ASSET_REGISTRY_ENTRIES = 20_000;
export const MAX_ASSET_REGISTRY_PATH_BYTES = 4_096;

const ASSET_ID_PATTERN =
  /^asset_[0-9a-f]{24}$/u;
const DECIMAL_IDENTITY_PATTERN =
  /^(?:0|[1-9][0-9]{0,31})$/u;
const REGISTRY_MUTEX = new KeyedMutex();
const REGISTRY_LOCK_RETRY_LIMIT = 100;
const REGISTRY_LOCK_RETRY_MS = 20;

export type AssetIdentityKind =
  | "external-tileset"
  | "image-layer";

export interface AssetIdentityObservation {
  kind: AssetIdentityKind;
  path: string;
  identity: FileIdentity;
}

export interface AssetRegistryOptions {
  generateAssetId?: () => string;
}

interface AssetRegistryEntry {
  assetId: string;
  kind: AssetIdentityKind;
  path: string;
  identity: FileIdentity;
}

interface AssetRegistryDocument {
  format: typeof ASSET_REGISTRY_FORMAT;
  formatVersion:
    typeof ASSET_REGISTRY_FORMAT_VERSION;
  generation: number;
  entries: AssetRegistryEntry[];
}

/**
 * Persistent identity for the two asset classes currently exposed on the MCP
 * wire: external TSJ bindings and prospective image-layer dependencies.
 *
 * A path that remains occupied keeps its ID across ordinary atomic saves.
 * When a path disappears, a unique strong file-identity match can move the
 * old ID to the new path. Content equality is deliberately not identity, and
 * known ambiguous matches receive a new ID instead of guessing.
 */
export class AssetRegistry {
  private cache: AssetRegistryDocument | undefined;
  private readonly generateAssetId: () => string;

  constructor(
    private readonly resolver: ProjectPathResolver,
    options: AssetRegistryOptions = {},
  ) {
    this.generateAssetId =
      options.generateAssetId ??
      (() =>
        `asset_${randomBytes(12).toString("hex")}`);
  }

  async initialize(): Promise<void> {
    if (this.cache !== undefined) {
      return;
    }
    this.cache = await this.readFromDisk();
  }

  async resolve(
    observationInput: AssetIdentityObservation,
  ): Promise<string> {
    const [assetId] = await this.resolveMany([
      observationInput,
    ]);
    if (assetId === undefined) {
      throw new TiledMcpError(
        "INTERNAL_ERROR",
        "Asset registry resolution returned no ID.",
      );
    }
    return assetId;
  }

  async resolveMany(
    observationInputs:
      readonly AssetIdentityObservation[],
  ): Promise<string[]> {
    return this.resolveManyChecked(
      observationInputs,
      () => undefined,
    );
  }

  /**
   * Tentatively resolves a batch, then runs the checker while the project
   * registry lock is still held. The checker may be asynchronous, but must be
   * bounded and must not re-enter this registry. Rejection leaves both the
   * registry file and in-memory cache unchanged.
   */
  async resolveManyChecked(
    observationInputs:
      readonly AssetIdentityObservation[],
    checkBeforeCommit: (
      assetIds: readonly string[],
    ) => void | Promise<void>,
  ): Promise<string[]> {
    const observations = observationInputs.map(
      (observation) =>
        this.validateObservation(observation),
    );
    if (observations.length === 0) {
      await this.initialize();
      await checkBeforeCommit(Object.freeze([]));
      return [];
    }

    return this.mutate(async (document) => {
      for (const observation of observations) {
        const currentIdentity =
          await this.observePathIdentity(
            observation.path,
          );
        if (
          !sameFileIdentity(
            observation.identity,
            currentIdentity,
          )
        ) {
          throw new TiledMcpError(
            observation.kind === "image-layer"
              ? "IMAGE_CHANGED_DURING_READ"
              : "DOCUMENT_CHANGED_DURING_READ",
            `${observation.path} changed before its asset identity could be recorded. Retry the operation.`,
            { path: observation.path },
          );
        }
      }

      const ambiguousIdentityKeys =
        collectAmbiguousIdentityKeys(
          observations,
        );
      const index = indexDocument(document);
      const assetIds: string[] = [];
      let changed = false;

      for (const observation of observations) {
        const identityIndexKey =
          registryIdentityKey(
            observation.kind,
            observation.identity,
          );
        const selected = await this.selectEntry(
          index,
          observation,
          !ambiguousIdentityKeys.has(
            identityIndexKey,
          ),
        );
        const entry =
          selected ??
          this.allocateEntry(
            document,
            index,
            observation,
          );
        if (selected === undefined) {
          changed = true;
        } else if (
          !sameEntryObservation(
            entry,
            observation,
          )
        ) {
          updateIndexedEntry(
            index,
            entry,
            observation,
          );
          changed = true;
        }
        assetIds.push(entry.assetId);
      }
      await checkBeforeCommit(
        Object.freeze([...assetIds]),
      );

      return {
        changed,
        value: assetIds,
      };
    });
  }

  async resolvePath(
    kind: AssetIdentityKind,
    projectPath: string,
  ): Promise<string> {
    const path = this.resolver.normalize(projectPath);
    const identity =
      await this.observePathIdentity(path);
    return this.resolve({
      kind,
      path,
      identity,
    });
  }

  private async observePathIdentity(
    projectPath: string,
  ): Promise<FileIdentity> {
    const path = this.resolver.normalize(projectPath);
    const absolutePath =
      await this.resolver.resolveExisting(path);
    let handle;
    try {
      handle = await open(
        absolutePath,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if (hasCode(error, "ELOOP")) {
        throw new TiledMcpError(
          "SYMLINK_NOT_ALLOWED",
          `Refusing to follow symbolic link ${path}.`,
          { path },
        );
      }
      throw error;
    }
    try {
      const fileStat = await handle.stat({
        bigint: true,
      });
      if (!fileStat.isFile()) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${path} is not a regular file.`,
          { path },
        );
      }
      return fileIdentityOf(fileStat);
    } finally {
      await handle.close();
    }
  }

  private async selectEntry(
    index: AssetRegistryIndex,
    observation: AssetIdentityObservation,
    allowIdentityMigration: boolean,
  ): Promise<AssetRegistryEntry | undefined> {
    const liveAtPath = index.byPath.get(
      registryPathKey(
        observation.kind,
        observation.path,
      ),
    );
    if (liveAtPath !== undefined) {
      return liveAtPath;
    }
    if (
      !allowIdentityMigration ||
      !supportsAssetRenameContinuity(
        observation.identity,
      )
    ) {
      return undefined;
    }

    const byIdentity = index.byIdentity.get(
      registryIdentityKey(
        observation.kind,
        observation.identity,
      ),
    );
    if (byIdentity?.size === 1) {
      const [candidate] = byIdentity;
      if (
        candidate !== undefined &&
        candidate.path !== observation.path &&
        !(await this.pathStillExists(
          candidate.path,
        ))
      ) {
        return candidate;
      }
    }

    return undefined;
  }

  private allocateEntry(
    document: AssetRegistryDocument,
    index: AssetRegistryIndex,
    observation: AssetIdentityObservation,
  ): AssetRegistryEntry {
    if (
      document.entries.length >=
      MAX_ASSET_REGISTRY_ENTRIES
    ) {
      throw new TiledMcpError(
        "ASSET_REGISTRY_LIMIT_EXCEEDED",
        "The persistent asset registry reached its entry limit; archive it only if invalidating all saved asset IDs is acceptable.",
        {
          limit: MAX_ASSET_REGISTRY_ENTRIES,
        },
      );
    }

    const legacyCandidate =
      `asset_${shortHash(
        `${observation.kind}:${observation.path}`,
      )}`;
    let assetId = legacyCandidate;
    if (index.assetIds.has(assetId)) {
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const candidate = this.generateAssetId();
        if (
          ASSET_ID_PATTERN.test(candidate) &&
          !index.assetIds.has(candidate)
        ) {
          assetId = candidate;
          break;
        }
      }
      if (index.assetIds.has(assetId)) {
        throw new TiledMcpError(
          "ASSET_ID_COLLISION",
          "Could not allocate a unique opaque asset ID.",
        );
      }
    }

    const entry: AssetRegistryEntry = {
      assetId,
      kind: observation.kind,
      path: observation.path,
      identity: { ...observation.identity },
    };
    document.entries.push(entry);
    addIndexedEntry(index, entry);
    return entry;
  }

  private validateObservation(
    input: AssetIdentityObservation,
  ): AssetIdentityObservation {
    if (
      input.kind !== "external-tileset" &&
      input.kind !== "image-layer"
    ) {
      throw new TiledMcpError(
        "ASSET_REGISTRY_CORRUPT",
        "An unsupported asset identity kind reached the registry.",
      );
    }
    const path = this.resolver.normalize(input.path);
    if (
      path === ".tiledmcp" ||
      path.startsWith(".tiledmcp/") ||
      Buffer.byteLength(path, "utf8") >
        MAX_ASSET_REGISTRY_PATH_BYTES
    ) {
      throw new TiledMcpError(
        "ASSET_REGISTRY_CORRUPT",
        "An unsafe asset path reached the registry.",
      );
    }
    try {
      validateFileIdentity(input.identity);
    } catch (error) {
      throw registryCorrupt(
        "invalid-observed-file-identity",
        error,
      );
    }
    return {
      kind: input.kind,
      path,
      identity: { ...input.identity },
    };
  }

  private async mutate<T>(
    operation: (
      document: AssetRegistryDocument,
    ) =>
      | MutationResult<T>
      | Promise<MutationResult<T>>,
  ): Promise<T> {
    return REGISTRY_MUTEX.runExclusive(
      this.resolver.root,
      async () =>
        this.withRegistryFileLock(async () => {
          const document =
            await this.readFromDisk();
          const result = await operation(document);
          if (result.changed) {
            if (
              document.generation >=
              Number.MAX_SAFE_INTEGER
            ) {
              throw new TiledMcpError(
                "ASSET_REGISTRY_LIMIT_EXCEEDED",
                "The persistent asset registry generation is exhausted.",
              );
            }
            document.generation += 1;
            document.entries.sort((left, right) =>
              left.assetId.localeCompare(
                right.assetId,
              ),
            );
            await this.writeToDisk(document);
          }
          this.cache = cloneDocument(document);
          return result.value;
        }),
    );
  }

  private async withRegistryFileLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 0;
      attempt < REGISTRY_LOCK_RETRY_LIMIT;
      attempt += 1
    ) {
      try {
        return await withProjectFileLock(
          this.resolver,
          ASSET_REGISTRY_RELATIVE_PATH,
          operation,
        );
      } catch (error) {
        if (
          !(
            error instanceof TiledMcpError
          ) ||
          error.code !== "FILE_LOCKED" ||
          attempt ===
            REGISTRY_LOCK_RETRY_LIMIT - 1
        ) {
          throw error;
        }
        await delay(REGISTRY_LOCK_RETRY_MS);
      }
    }
    throw new TiledMcpError(
      "INTERNAL_ERROR",
      "Asset registry lock retry exhausted.",
    );
  }

  private async readFromDisk(): Promise<AssetRegistryDocument> {
    const internalDirectory = join(
      this.resolver.root,
      ".tiledmcp",
    );
    try {
      const directoryStat =
        await lstat(internalDirectory);
      if (
        directoryStat.isSymbolicLink() ||
        !directoryStat.isDirectory()
      ) {
        throw registryCorrupt(
          "unsafe-internal-directory",
        );
      }
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return emptyDocument();
      }
      if (isRegistryCorrupt(error)) {
        throw error;
      }
      throw registryCorrupt(
        "unreadable-internal-directory",
        error,
      );
    }

    const registryPath = join(
      this.resolver.root,
      ASSET_REGISTRY_RELATIVE_PATH,
    );
    let handle;
    try {
      handle = await open(
        registryPath,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return emptyDocument();
      }
      throw registryCorrupt(
        "unsafe-or-unreadable-registry",
        error,
      );
    }

    try {
      const before = await handle.stat({
        bigint: true,
      });
      if (
        !before.isFile() ||
        before.size >
          BigInt(MAX_ASSET_REGISTRY_BYTES)
      ) {
        throw registryCorrupt(
          "invalid-registry-file",
        );
      }
      const chunks: Buffer[] = [];
      const scratch = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      while (true) {
        const { bytesRead } = await handle.read(
          scratch,
          0,
          scratch.byteLength,
          null,
        );
        if (bytesRead === 0) {
          break;
        }
        total += bytesRead;
        if (
          total > MAX_ASSET_REGISTRY_BYTES
        ) {
          throw registryCorrupt(
            "registry-grew-beyond-limit",
          );
        }
        chunks.push(
          Buffer.from(
            scratch.subarray(0, bytesRead),
          ),
        );
      }
      const after = await handle.stat({
        bigint: true,
      });
      if (
        !sameFileSnapshot(before, after) ||
        BigInt(total) !== after.size
      ) {
        throw registryCorrupt(
          "registry-changed-during-read",
        );
      }
      const bytes = Buffer.concat(chunks, total);
      let text: string;
      try {
        text = new TextDecoder("utf-8", {
          fatal: true,
        }).decode(bytes);
      } catch (error) {
        throw registryCorrupt(
          "invalid-registry-utf8",
          error,
        );
      }
      let parsed: JsonObject;
      try {
        parsed = parseJsonDocument(
          text,
          "asset registry",
        );
      } catch (error) {
        throw registryCorrupt(
          "invalid-registry-json",
          error,
        );
      }
      return this.validateDocument(parsed);
    } finally {
      await handle.close();
    }
  }

  private validateDocument(
    value: JsonObject,
  ): AssetRegistryDocument {
    try {
      if (
        !hasExactKeys(value, [
          "entries",
          "format",
          "formatVersion",
          "generation",
        ]) ||
        value.format !== ASSET_REGISTRY_FORMAT ||
        value.formatVersion !==
          ASSET_REGISTRY_FORMAT_VERSION ||
        typeof value.generation !== "number" ||
        !Number.isSafeInteger(value.generation) ||
        value.generation < 0 ||
        !Array.isArray(value.entries) ||
        value.entries.length >
          MAX_ASSET_REGISTRY_ENTRIES
      ) {
        throw new Error("invalid root");
      }

      const entries: AssetRegistryEntry[] = [];
      const assetIds = new Set<string>();
      const presentPaths = new Set<string>();
      for (const raw of value.entries) {
        if (
          !isObject(raw) ||
          !hasExactKeys(raw, [
            "assetId",
            "identity",
            "kind",
            "path",
          ]) ||
          typeof raw.assetId !== "string" ||
          !ASSET_ID_PATTERN.test(raw.assetId) ||
          (raw.kind !== "external-tileset" &&
            raw.kind !== "image-layer") ||
          typeof raw.path !== "string" ||
          !isObject(raw.identity) ||
          !hasExactKeys(raw.identity, [
            "birthtimeNs",
            "device",
            "inode",
          ]) ||
          typeof raw.identity.device !==
            "string" ||
          typeof raw.identity.inode !==
            "string" ||
          typeof raw.identity.birthtimeNs !==
            "string"
        ) {
          throw new Error("invalid entry");
        }
        const path = this.resolver.normalize(
          raw.path,
        );
        if (
          path === ".tiledmcp" ||
          path.startsWith(".tiledmcp/") ||
          Buffer.byteLength(path, "utf8") >
            MAX_ASSET_REGISTRY_PATH_BYTES
        ) {
          throw new Error("unsafe entry path");
        }
        const identity = {
          device: raw.identity.device,
          inode: raw.identity.inode,
          birthtimeNs:
            raw.identity.birthtimeNs,
        };
        validateFileIdentity(identity);
        if (assetIds.has(raw.assetId)) {
          throw new Error("duplicate asset id");
        }
        assetIds.add(raw.assetId);
        const pathKey = `${raw.kind}:${path}`;
        if (presentPaths.has(pathKey)) {
          throw new Error(
            "duplicate asset path",
          );
        }
        presentPaths.add(pathKey);
        entries.push({
          assetId: raw.assetId,
          kind: raw.kind,
          path,
          identity,
        });
      }
      return {
        format: ASSET_REGISTRY_FORMAT,
        formatVersion:
          ASSET_REGISTRY_FORMAT_VERSION,
        generation: value.generation,
        entries,
      };
    } catch (error) {
      if (isRegistryCorrupt(error)) {
        throw error;
      }
      throw registryCorrupt(
        "invalid-registry-schema",
        error,
      );
    }
  }

  private async writeToDisk(
    document: AssetRegistryDocument,
  ): Promise<void> {
    const directory =
      await this.resolver.ensureInternalDirectory(
        ".tiledmcp",
      );
    const registryPath = join(
      this.resolver.root,
      ASSET_REGISTRY_RELATIVE_PATH,
    );
    try {
      const existing = await lstat(registryPath);
      if (
        existing.isSymbolicLink() ||
        !existing.isFile()
      ) {
        throw registryCorrupt(
          "unsafe-registry-target",
        );
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    }

    const bytes = Buffer.from(
      `${JSON.stringify(document, null, 2)}\n`,
      "utf8",
    );
    if (
      bytes.byteLength >
      MAX_ASSET_REGISTRY_BYTES
    ) {
      throw new TiledMcpError(
        "ASSET_REGISTRY_LIMIT_EXCEEDED",
        "The persistent asset registry exceeds its byte limit.",
        {
          limit: MAX_ASSET_REGISTRY_BYTES,
        },
      );
    }
    const temporaryPath = join(
      directory,
      `.asset-registry.v1.${randomUUID()}.tmp`,
    );
    let temporaryHandle: FileHandle | undefined;
    let temporaryCreated = false;
    try {
      temporaryHandle = await open(
        temporaryPath,
        "wx",
        0o600,
      );
      temporaryCreated = true;
      await temporaryHandle.writeFile(bytes);
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;

      await rename(temporaryPath, registryPath);
      const directoryHandle = await open(
        directory,
        "r",
      );
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
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

  private async pathStillExists(
    projectPath: string,
  ): Promise<boolean> {
    try {
      await this.resolver.resolveExisting(
        projectPath,
      );
      return true;
    } catch (error) {
      return !(
        error instanceof TiledMcpError &&
        error.code === "FILE_NOT_FOUND"
      );
    }
  }
}

interface AssetRegistryIndex {
  assetIds: Set<string>;
  byIdentity: Map<
    string,
    Set<AssetRegistryEntry>
  >;
  byPath: Map<string, AssetRegistryEntry>;
}

interface MutationResult<T> {
  changed: boolean;
  value: T;
}

export function supportsAssetRenameContinuity(
  identity: FileIdentity,
): boolean {
  return (
    DECIMAL_IDENTITY_PATTERN.test(
      identity.device,
    ) &&
    DECIMAL_IDENTITY_PATTERN.test(
      identity.inode,
    ) &&
    DECIMAL_IDENTITY_PATTERN.test(
      identity.birthtimeNs,
    ) &&
    identity.inode !== "0" &&
    identity.birthtimeNs !== "0"
  );
}

function collectAmbiguousIdentityKeys(
  observations:
    readonly AssetIdentityObservation[],
): Set<string> {
  const pathsByIdentity = new Map<
    string,
    Set<string>
  >();
  for (const observation of observations) {
    if (
      !supportsAssetRenameContinuity(
        observation.identity,
      )
    ) {
      continue;
    }
    const key = registryIdentityKey(
      observation.kind,
      observation.identity,
    );
    let paths = pathsByIdentity.get(key);
    if (paths === undefined) {
      paths = new Set<string>();
      pathsByIdentity.set(key, paths);
    }
    paths.add(observation.path);
  }

  const ambiguous = new Set<string>();
  for (const [key, paths] of pathsByIdentity) {
    if (paths.size > 1) {
      ambiguous.add(key);
    }
  }
  return ambiguous;
}

function indexDocument(
  document: AssetRegistryDocument,
): AssetRegistryIndex {
  const index: AssetRegistryIndex = {
    assetIds: new Set<string>(),
    byIdentity: new Map<
      string,
      Set<AssetRegistryEntry>
    >(),
    byPath: new Map<
      string,
      AssetRegistryEntry
    >(),
  };
  for (const entry of document.entries) {
    addIndexedEntry(index, entry);
  }
  return index;
}

function addIndexedEntry(
  index: AssetRegistryIndex,
  entry: AssetRegistryEntry,
): void {
  index.assetIds.add(entry.assetId);
  index.byPath.set(
    registryPathKey(entry.kind, entry.path),
    entry,
  );
  const identityKey = registryIdentityKey(
    entry.kind,
    entry.identity,
  );
  let identityEntries =
    index.byIdentity.get(identityKey);
  if (identityEntries === undefined) {
    identityEntries =
      new Set<AssetRegistryEntry>();
    index.byIdentity.set(
      identityKey,
      identityEntries,
    );
  }
  identityEntries.add(entry);
}

function removeIndexedEntry(
  index: AssetRegistryIndex,
  entry: AssetRegistryEntry,
): void {
  index.byPath.delete(
    registryPathKey(entry.kind, entry.path),
  );
  const identityKey = registryIdentityKey(
    entry.kind,
    entry.identity,
  );
  const identityEntries =
    index.byIdentity.get(identityKey);
  identityEntries?.delete(entry);
  if (identityEntries?.size === 0) {
    index.byIdentity.delete(identityKey);
  }
}

function updateIndexedEntry(
  index: AssetRegistryIndex,
  entry: AssetRegistryEntry,
  observation: AssetIdentityObservation,
): void {
  removeIndexedEntry(index, entry);
  entry.kind = observation.kind;
  entry.path = observation.path;
  entry.identity = { ...observation.identity };
  addIndexedEntry(index, entry);
}

function registryPathKey(
  kind: AssetIdentityKind,
  path: string,
): string {
  return `${kind}\u0000${path}`;
}

function registryIdentityKey(
  kind: AssetIdentityKind,
  identity: FileIdentity,
): string {
  return `${kind}\u0000${fileIdentityKey(identity)}`;
}

function emptyDocument(): AssetRegistryDocument {
  return {
    format: ASSET_REGISTRY_FORMAT,
    formatVersion:
      ASSET_REGISTRY_FORMAT_VERSION,
    generation: 0,
    entries: [],
  };
}

function cloneDocument(
  document: AssetRegistryDocument,
): AssetRegistryDocument {
  return {
    format: document.format,
    formatVersion: document.formatVersion,
    generation: document.generation,
    entries: document.entries.map((entry) => ({
      ...entry,
      identity: { ...entry.identity },
    })),
  };
}

function sameEntryObservation(
  entry: AssetRegistryEntry,
  observation: AssetIdentityObservation,
): boolean {
  return (
    entry.kind === observation.kind &&
    entry.path === observation.path &&
    sameFileIdentity(
      entry.identity,
      observation.identity,
    )
  );
}

function validateFileIdentity(
  identity: FileIdentity,
): void {
  if (
    !DECIMAL_IDENTITY_PATTERN.test(
      identity.device,
    ) ||
    !DECIMAL_IDENTITY_PATTERN.test(
      identity.inode,
    ) ||
    !DECIMAL_IDENTITY_PATTERN.test(
      identity.birthtimeNs,
    )
  ) {
    throw new Error("invalid file identity");
  }
}

function hasExactKeys(
  value: JsonObject,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every(
      (key, index) => key === expected[index],
    )
  );
}

function isObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function registryCorrupt(
  reason: string,
  cause?: unknown,
): TiledMcpError {
  return new TiledMcpError(
    "ASSET_REGISTRY_CORRUPT",
    "The persistent asset registry is malformed or unsafe; inspect it instead of regenerating IDs.",
    {
      reason,
      ...(typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "string"
        ? { causeCode: cause.code }
        : {}),
    },
  );
}

function isRegistryCorrupt(
  error: unknown,
): error is TiledMcpError {
  return (
    error instanceof TiledMcpError &&
    error.code === "ASSET_REGISTRY_CORRUPT"
  );
}

function hasCode(
  error: unknown,
  code: string,
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function delay(
  milliseconds: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
