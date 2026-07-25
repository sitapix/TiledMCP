import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import {
  lstat,
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
import { withProjectFileLock } from "./fileLock.js";
import { KeyedMutex } from "./keyedMutex.js";
import { revisionOf } from "./revision.js";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_CHECKPOINT_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_CHECKPOINT_LABEL_LENGTH = 1_024;
export const DEFAULT_CHECKPOINT_STORAGE_BYTES =
  1024 * 1024 * 1024;
export const MAX_CHECKPOINT_OBSERVED_ENTRIES = 10_000;
export const CHECKPOINT_STORAGE_LOCK_TARGET =
  ".tiledmcp/checkpoint-store";
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
const CHECKPOINT_OBJECT_TEMP_PATTERN =
  /^[0-9a-f]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/iu;
const CHECKPOINT_STORAGE_MUTEX = new KeyedMutex();

export const CHECKPOINT_STORAGE_POLICY = Object.freeze({
  name: "tiled-mcp-checkpoint-storage",
  version: 2,
  quotaAccounting:
    "observed-logical-bytes-plus-prepared-commit-reservation-and-entry-count",
  quotaScope:
    ".tiledmcp/objects-and-.tiledmcp/checkpoints",
  capacityEnforcement:
    "before-publishing-checkpoint-state",
  garbageCollectionRoots:
    "all-valid-prepared-and-committed-manifests",
  garbageCollectionDeletion:
    "unreferenced-canonical-objects-and-private-crash-temporaries-only",
  validManifestDeletion:
    "explicit-raw-cas-committed-only",
  automaticValidManifestPruning: "never",
  explicitPruneCoordination:
    "target-lock-then-checkpoint-store-lock",
  explicitPruneDeletionOrder:
    "manifest-unlink-checkpoint-directory-fsync-then-fail-closed-orphan-sweep",
  incompleteInventoryPolicy:
    "block-entire-sweep-before-first-unlink",
  incompleteCapacityInventoryPolicy:
    "fail-new-prepare-when-byte-or-entry-accounting-cannot-be-proven",
  coordination:
    "project-wide-in-process-mutex-and-cross-process-file-lock",
  internalStateThreatBoundary:
    "trusted-local-state-and-cooperative-lock-following-writers-only",
  preparedManifestAccounting:
    "charged-as-max-of-observed-prepared-and-canonical-committed-bytes",
  temporaryStagingAccounting:
    "active-staging-excluded-crash-leftovers-counted",
  initialManifestPublication:
    "create-if-absent-no-replace",
  quotaExhaustion:
    "fail-write-before-target-promotion-no-automatic-valid-manifest-pruning",
  targetPromotionBeforeFailure:
    "quota-is-checked-before-checkpoint-publication-and-target-promotion",
} as const);

export interface CheckpointStoreObserver {
  afterObjectPublishedBeforeManifest?(context: {
    manifest: CheckpointManifest;
    objectHash: string;
  }): void | Promise<void>;
  afterManifestDeletedBeforeGarbageCollection?(context: {
    checkpointId: string;
  }): void | Promise<void>;
}

export interface CheckpointStoreOptions {
  maxBytes?: number;
  /** Test and constrained-deployment override; production defaults to 10,000. */
  maxEntries?: number;
  /** Deterministic concurrency/fault-injection seam for storage tests. */
  observer?: CheckpointStoreObserver;
}

export interface CheckpointGarbageCollectionBlocker {
  directory: "checkpoints" | "objects";
  fileName?: string;
  reason:
    | "entry-inspection-failed"
    | "byte-accounting-limit-exceeded"
    | "malformed-manifest"
    | "missing-referenced-object"
    | "non-regular-entry"
    | "scan-limit-exceeded"
    | "symbolic-link"
    | "unexpected-entry";
  message: string;
}

export interface CheckpointGarbageCollectionReport {
  observedBytes: number;
  chargedBytes: number;
  observedEntries: number;
  retainedBytes: number;
  retainedChargedBytes: number;
  retainedEntries: number;
  deletedBytes: number;
  deletedEntries: number;
  deletedObjects: number;
  deletedTemporaryFiles: number;
  blocked: boolean;
  blockers: CheckpointGarbageCollectionBlocker[];
}

interface CheckpointStorageDirectories {
  checkpoints: string;
  objects: string;
}

interface CheckpointStorageEntry {
  directory: "checkpoints" | "objects";
  fileName: string;
  path: string;
  size: number;
  kind:
    | "manifest"
    | "manifest-temporary"
    | "object"
    | "object-temporary";
}

interface CheckpointStorageInventory {
  observedBytes: number;
  chargedBytes: number;
  observedEntries: number;
  capacityAccountingComplete: boolean;
  blockers: CheckpointGarbageCollectionBlocker[];
  referencedObjectHashes: Set<string>;
  objectFileNames: Set<string>;
  manifestSizes: Map<string, number>;
  manifestChargedSizes: Map<string, number>;
  objects: CheckpointStorageEntry[];
  temporaryFiles: CheckpointStorageEntry[];
}

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

export interface CheckpointManifestSnapshot {
  manifest: CheckpointManifest;
  manifestRevision: string;
  manifestSize: number;
}

export interface CheckpointPruneStorageExpectation {
  id: string;
  createdAt: string;
  label?: string;
  path: string;
  status: "committed";
  before: CheckpointManifest["before"];
  afterRevision: string;
  manifestRevision: string;
  manifestSize: number;
}

export type CheckpointPruneGarbageCollectionResult =
  | {
      status: "completed";
      deletedBytes: number;
      deletedEntries: number;
      deletedObjects: number;
      deletedTemporaryFiles: number;
      blockerCount: 0;
      blockers: [];
      blockersTruncated: false;
    }
  | {
      status: "blocked";
      deletedBytes: 0;
      deletedEntries: 0;
      deletedObjects: 0;
      deletedTemporaryFiles: 0;
      blockerCount: number;
      blockers: CheckpointGarbageCollectionBlocker[];
      blockersTruncated: boolean;
    }
  | {
      status: "failed";
      failureCode: "INTERNAL_ERROR";
      deletionOutcome:
        "unknown-partial-or-none";
    };

export interface CheckpointPruneStorageResult {
  manifest: CheckpointManifest & {
    status: "committed";
  };
  manifestDeleted: true;
  garbageCollection:
    CheckpointPruneGarbageCollectionResult;
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
  readonly maxBytes: number;
  readonly maxEntries: number;
  private readonly observer:
    | CheckpointStoreObserver
    | undefined;

  constructor(
    private readonly resolver: ProjectPathResolver,
    options: CheckpointStoreOptions = {},
  ) {
    const maxBytes =
      options.maxBytes ??
      DEFAULT_CHECKPOINT_STORAGE_BYTES;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "Checkpoint retained storage quota must be a positive safe integer.",
        { maxBytes },
      );
    }
    const maxEntries =
      options.maxEntries ??
      MAX_CHECKPOINT_OBSERVED_ENTRIES;
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "Checkpoint observed entry limit must be a positive safe integer.",
        { maxEntries },
      );
    }
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.observer = options.observer;
  }

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
    if (
      before &&
      before.byteLength >
        MAX_CHECKPOINT_OBJECT_BYTES
    ) {
      throw new TiledMcpError(
        "DOCUMENT_TOO_LARGE",
        `Checkpoint content exceeds the ${MAX_CHECKPOINT_OBJECT_BYTES} byte limit.`,
        {
          size: before.byteLength,
          limit: MAX_CHECKPOINT_OBJECT_BYTES,
        },
      );
    }
    let beforeState: CheckpointManifest["before"] = { existed: false };
    let objectHash: string | undefined;
    if (before) {
      objectHash = createHash("sha256").update(before).digest("hex");
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
    return this.runStorageExclusive(async () => {
      const directories =
        await this.ensureStorageDirectories();
      await this.ensureCapacity(
        directories,
        manifest,
        before,
        objectHash,
      );
      if (before && objectHash) {
        await writeOnce(
          join(directories.objects, objectHash),
          before,
        );
        await this.observer
          ?.afterObjectPublishedBeforeManifest?.({
            manifest,
            objectHash,
          });
      }
      await atomicCreateJson(
        join(
          directories.checkpoints,
          `${manifest.id}.json`,
        ),
        manifest,
      );
      return manifest;
    });
  }

  async markCommitted(manifest: CheckpointManifest): Promise<CheckpointManifest> {
    return this.runStorageExclusive(async () => {
      const directories =
        await this.ensureStorageDirectories();
      const current = await this.readManifest(
        directories.checkpoints,
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
      await this.assertManifestReplacementReserved(
        directories,
        current,
        committed,
      );
      await atomicWriteJson(
        join(
          directories.checkpoints,
          `${manifest.id}.json`,
        ),
        committed,
      );
      return committed;
    });
  }

  async inspectPrune(
    id: string,
  ): Promise<CheckpointManifestSnapshot> {
    assertCheckpointId(id);
    return this.runStorageExclusive(async () => {
      const { checkpoints } =
        await this.ensureStorageDirectories();
      return this.readManifestSnapshot(
        checkpoints,
        id,
      );
    });
  }

  async pruneCommitted(
    expected: CheckpointPruneStorageExpectation,
  ): Promise<CheckpointPruneStorageResult> {
    assertCheckpointId(expected.id);
    let deletedManifest:
      | (CheckpointManifest & {
          status: "committed";
        })
      | undefined;
    let storeLockReleaseFailed = false;
    try {
      const result =
        await this.runStorageExclusive<CheckpointPruneStorageResult>(
        async () => {
          const directories =
            await this.ensureStorageDirectories();
          const snapshot =
            await this.readManifestSnapshot(
              directories.checkpoints,
              expected.id,
            );
          if (
            !sameCheckpointPruneExpectation(
              expected,
              snapshot,
            )
          ) {
            throw new TiledMcpError(
              "CHECKPOINT_CHANGED",
              `Checkpoint ${expected.id} changed after prune inspection.`,
              {
                checkpointId: expected.id,
              },
            );
          }
          const manifest = snapshot.manifest;
          if (manifest.status !== "committed") {
            throw new TiledMcpError(
              "CHECKPOINT_NOT_COMMITTED",
              `Checkpoint ${expected.id} is still prepared and cannot be pruned.`,
              {
                checkpointId: expected.id,
              },
            );
          }
          const committedManifest =
            manifest as CheckpointManifest & {
              status: "committed";
            };

          await unlink(
            join(
              directories.checkpoints,
              `${expected.id}.json`,
            ),
          );
          deletedManifest = committedManifest;

          try {
            await syncDirectory(
              directories.checkpoints,
            );
            await this.observer
              ?.afterManifestDeletedBeforeGarbageCollection?.(
                {
                  checkpointId: manifest.id,
                },
              );
            const inventory =
              await this.inventory(directories);
            const report =
              await this.sweepInventory(
                directories,
                inventory,
              );
            return {
              manifest: committedManifest,
              manifestDeleted: true,
              garbageCollection:
                checkpointPruneGarbageCollectionResult(
                  report,
                ),
            };
          } catch {
            return failedCheckpointPruneResult(
              committedManifest,
            );
          }
        },
          () => {
            storeLockReleaseFailed = true;
          },
        );
      if (
        storeLockReleaseFailed &&
        deletedManifest !== undefined
      ) {
        return failedCheckpointPruneResult(
          deletedManifest,
        );
      }
      return result;
    } catch (error) {
      // Once unlink has succeeded, even a checkpoint-store lock release
      // failure must not make the caller believe that no destructive action
      // occurred. The bounded failed outcome deliberately exposes no raw
      // filesystem diagnostics.
      if (deletedManifest !== undefined) {
        return failedCheckpointPruneResult(
          deletedManifest,
        );
      }
      throw error;
    }
  }

  async collectGarbage(): Promise<CheckpointGarbageCollectionReport> {
    return this.runStorageExclusive(async () => {
      const directories =
        await this.ensureStorageDirectories();
      const inventory =
        await this.inventory(directories);
      return this.sweepInventory(
        directories,
        inventory,
      );
    });
  }

  private async runStorageExclusive<T>(
    operation: () => Promise<T>,
    onLockReleaseFailure?: () => void,
  ): Promise<T> {
    const mutexKey =
      `${this.resolver.root}\0${CHECKPOINT_STORAGE_LOCK_TARGET}`;
    return CHECKPOINT_STORAGE_MUTEX.runExclusive(
      mutexKey,
      () =>
        withProjectFileLock(
          this.resolver,
          CHECKPOINT_STORAGE_LOCK_TARGET,
          operation,
          onLockReleaseFailure === undefined
            ? {}
            : {
                onReleaseFailure:
                  onLockReleaseFailure,
              },
        ),
    );
  }

  private async ensureStorageDirectories(): Promise<CheckpointStorageDirectories> {
    const [objects, checkpoints] =
      await Promise.all([
        this.resolver.ensureInternalDirectory(
          ".tiledmcp/objects",
        ),
        this.resolver.ensureInternalDirectory(
          ".tiledmcp/checkpoints",
        ),
      ]);
    return { checkpoints, objects };
  }

  private async ensureCapacity(
    directories: CheckpointStorageDirectories,
    manifest: CheckpointManifest,
    before: Buffer | undefined,
    objectHash: string | undefined,
  ): Promise<void> {
    let inventory =
      await this.inventory(directories);
    let projection = projectedCheckpointStorage(
      inventory,
      manifest,
      before,
      objectHash,
    );
    if (
      this.hasCapacity(
        inventory,
        projection,
      )
    ) {
      return;
    }

    await this.sweepInventory(
      directories,
      inventory,
    );
    inventory = await this.inventory(directories);
    projection = projectedCheckpointStorage(
      inventory,
      manifest,
      before,
      objectHash,
    );
    if (
      !this.hasCapacity(
        inventory,
        projection,
      )
    ) {
      this.throwQuotaExceeded(
        inventory,
        projection,
      );
    }
  }

  private async assertManifestReplacementReserved(
    directories: CheckpointStorageDirectories,
    current: CheckpointManifest,
    replacement: CheckpointManifest,
  ): Promise<void> {
    const inventory =
      await this.inventory(directories);
    const projection =
      projectedManifestReplacementStorage(
        inventory,
        current,
        replacement,
      );
    if (
      projection.bytes >
      inventory.chargedBytes
    ) {
      throw new TiledMcpError(
        "CHECKPOINT_CORRUPT",
        `Checkpoint ${current.id} did not reserve enough storage for its committed state.`,
        {
          checkpointId: current.id,
          chargedBytes: inventory.chargedBytes,
          projectedBytes: projection.bytes,
        },
      );
    }
  }

  private hasCapacity(
    inventory: CheckpointStorageInventory,
    projection: CheckpointStorageProjection,
  ): boolean {
    return (
      inventory.capacityAccountingComplete &&
      projection.bytes <=
        this.maxBytes &&
      projection.entries <=
        this.maxEntries
    );
  }

  private throwQuotaExceeded(
    inventory: CheckpointStorageInventory,
    projection: CheckpointStorageProjection,
  ): never {
    throw new TiledMcpError(
      "CHECKPOINT_QUOTA_EXCEEDED",
      "Checkpoint storage cannot retain the new state within its configured byte and entry limits.",
      {
        maxBytes: this.maxBytes,
        maxEntries: this.maxEntries,
        observedBytes: inventory.observedBytes,
        chargedBytes: inventory.chargedBytes,
        observedEntries:
          inventory.observedEntries,
        capacityAccountingComplete:
          inventory.capacityAccountingComplete,
        projectedBytes: projection.bytes,
        projectedEntries: projection.entries,
      },
    );
  }

  private async inventory(
    directories: CheckpointStorageDirectories,
  ): Promise<CheckpointStorageInventory> {
    const inventory: CheckpointStorageInventory = {
      observedBytes: 0,
      chargedBytes: 0,
      observedEntries: 0,
      capacityAccountingComplete: true,
      blockers: [],
      referencedObjectHashes: new Set(),
      objectFileNames: new Set(),
      manifestSizes: new Map(),
      manifestChargedSizes: new Map(),
      objects: [],
      temporaryFiles: [],
    };

    await this.inventoryCheckpointDirectory(
      directories.checkpoints,
      inventory,
    );
    if (
      inventory.observedEntries <=
      this.maxEntries
    ) {
      await this.inventoryObjectDirectory(
        directories.objects,
        inventory,
      );
      const scanIncomplete =
        inventory.blockers.some(
          ({ reason }) =>
            reason === "scan-limit-exceeded",
        );
      if (!scanIncomplete) {
        for (
          const objectHash of
          inventory.referencedObjectHashes
        ) {
          if (
            !inventory.objectFileNames.has(
              objectHash,
            )
          ) {
            inventory.blockers.push({
              directory: "objects",
              fileName: objectHash,
              reason:
                "missing-referenced-object",
              message:
                "A checkpoint manifest references a missing content object.",
            });
          }
        }
      }
    }
    return inventory;
  }

  private async inventoryCheckpointDirectory(
    checkpointsDirectory: string,
    inventory: CheckpointStorageInventory,
  ): Promise<void> {
    await scanStorageDirectory(
      checkpointsDirectory,
      "checkpoints",
      inventory,
      this.maxEntries,
      async (entry, entryPath, size) => {
        if (CHECKPOINT_TEMP_PATTERN.test(entry.name)) {
          inventory.temporaryFiles.push({
            directory: "checkpoints",
            fileName: entry.name,
            path: entryPath,
            size,
            kind: "manifest-temporary",
          });
          return;
        }

        const match =
          CHECKPOINT_MANIFEST_PATTERN.exec(entry.name);
        if (!match) {
          inventory.blockers.push({
            directory: "checkpoints",
            fileName: entry.name,
            reason: "unexpected-entry",
            message:
              "Unexpected entry in the checkpoint manifest directory.",
          });
          return;
        }

        const id = match[1] as string;
        let manifest: CheckpointManifest;
        try {
          manifest = await this.readManifest(
            checkpointsDirectory,
            id,
          );
        } catch (error) {
          inventory.blockers.push({
            directory: "checkpoints",
            fileName: entry.name,
            reason: "malformed-manifest",
            message:
              error instanceof Error
                ? error.message
                : "Checkpoint manifest could not be safely read.",
          });
          return;
        }
        inventory.manifestSizes.set(id, size);
        const chargedSize =
          manifest.status === "prepared"
            ? Math.max(
                size,
                serializedManifestByteLength({
                  ...manifest,
                  status: "committed",
                }),
              )
            : size;
        inventory.manifestChargedSizes.set(
          id,
          chargedSize,
        );
        const reservation =
          chargedSize - size;
        const reservedTotal =
          addSafeStorageBytes(
            inventory.chargedBytes,
            reservation,
          );
        if (reservedTotal === undefined) {
          blockUnsafeByteAccounting(
            inventory,
            "checkpoints",
            entry.name,
          );
        } else {
          inventory.chargedBytes =
            reservedTotal;
        }
        if (manifest.before.existed) {
          inventory.referencedObjectHashes.add(
            manifest.before.objectHash,
          );
        }
      },
    );
  }

  private async inventoryObjectDirectory(
    objectsDirectory: string,
    inventory: CheckpointStorageInventory,
  ): Promise<void> {
    await scanStorageDirectory(
      objectsDirectory,
      "objects",
      inventory,
      this.maxEntries,
      (entry, entryPath, size) => {
        if (
          CHECKPOINT_OBJECT_TEMP_PATTERN.test(
            entry.name,
          )
        ) {
          inventory.temporaryFiles.push({
            directory: "objects",
            fileName: entry.name,
            path: entryPath,
            size,
            kind: "object-temporary",
          });
          return;
        }
        if (!OBJECT_HASH_PATTERN.test(entry.name)) {
          inventory.blockers.push({
            directory: "objects",
            fileName: entry.name,
            reason: "unexpected-entry",
            message:
              "Unexpected entry in the checkpoint object directory.",
          });
          return;
        }
        inventory.objectFileNames.add(entry.name);
        inventory.objects.push({
          directory: "objects",
          fileName: entry.name,
          path: entryPath,
          size,
          kind: "object",
        });
      },
    );
  }

  private async sweepInventory(
    directories: CheckpointStorageDirectories,
    inventory: CheckpointStorageInventory,
  ): Promise<CheckpointGarbageCollectionReport> {
    if (inventory.blockers.length > 0) {
      return garbageCollectionReport(
        inventory,
        [],
      );
    }

    const garbage = [
      ...inventory.temporaryFiles,
      ...inventory.objects.filter(
        (entry) =>
          !inventory.referencedObjectHashes.has(
            entry.fileName,
          ),
      ),
    ];
    const touchedDirectories = new Set<
      "checkpoints" | "objects"
    >();
    for (const entry of garbage) {
      await unlink(entry.path);
      touchedDirectories.add(entry.directory);
    }
    for (const directory of touchedDirectories) {
      await syncDirectory(directories[directory]);
    }
    return garbageCollectionReport(
      inventory,
      garbage,
    );
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
    return (
      await this.readManifestSnapshot(
        checkpointsDirectory,
        id,
      )
    ).manifest;
  }

  private async readManifestSnapshot(
    checkpointsDirectory: string,
    id: string,
  ): Promise<CheckpointManifestSnapshot> {
    let bytes: Buffer;
    let raw: string;
    try {
      bytes = await readBoundedNoFollow(
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
    return {
      manifest,
      manifestRevision: revisionOf(bytes),
      manifestSize: bytes.byteLength,
    };
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

interface CheckpointStorageProjection {
  bytes: number;
  entries: number;
}

function projectedCheckpointStorage(
  inventory: CheckpointStorageInventory,
  manifest: CheckpointManifest,
  before: Buffer | undefined,
  objectHash: string | undefined,
): CheckpointStorageProjection {
  const objectAlreadyExists =
    objectHash !== undefined &&
    inventory.objectFileNames.has(objectHash);
  const committedManifest: CheckpointManifest = {
    ...manifest,
    status: "committed",
  };
  const manifestCharge = Math.max(
    serializedManifestByteLength(manifest),
    serializedManifestByteLength(
      committedManifest,
    ),
  );
  return {
    bytes:
      inventory.chargedBytes +
      manifestCharge +
      (before && !objectAlreadyExists
        ? before.byteLength
        : 0),
    entries:
      inventory.observedEntries +
      1 +
      (before && !objectAlreadyExists ? 1 : 0),
  };
}

function projectedManifestReplacementStorage(
  inventory: CheckpointStorageInventory,
  current: CheckpointManifest,
  replacement: CheckpointManifest,
): CheckpointStorageProjection {
  const currentSize =
    inventory.manifestChargedSizes.get(current.id);
  if (currentSize === undefined) {
    throw new TiledMcpError(
      "CHECKPOINT_CHANGED",
      `Checkpoint ${current.id} changed while its storage capacity was being checked.`,
      { checkpointId: current.id },
    );
  }
  return {
    bytes:
      inventory.chargedBytes -
      currentSize +
      serializedManifestByteLength(replacement),
    entries: inventory.observedEntries,
  };
}

function sameCheckpointPruneExpectation(
  expected: CheckpointPruneStorageExpectation,
  actual: CheckpointManifestSnapshot,
): boolean {
  const manifest = actual.manifest;
  return (
    expected.id === manifest.id &&
    expected.createdAt === manifest.createdAt &&
    (expected.label ?? "") === manifest.label &&
    expected.path === manifest.path &&
    expected.status === manifest.status &&
    expected.afterRevision ===
      manifest.afterRevision &&
    sameCheckpointBefore(
      expected.before,
      manifest.before,
    ) &&
    expected.manifestRevision ===
      actual.manifestRevision &&
    expected.manifestSize ===
      actual.manifestSize
  );
}

function sameCheckpointBefore(
  expected: CheckpointManifest["before"],
  actual: CheckpointManifest["before"],
): boolean {
  if (
    expected.existed !== actual.existed
  ) {
    return false;
  }
  if (
    !expected.existed ||
    !actual.existed
  ) {
    return true;
  }
  return (
    expected.revision === actual.revision &&
    expected.objectHash ===
      actual.objectHash &&
    expected.size === actual.size
  );
}

function serializedManifestByteLength(
  manifest: CheckpointManifest,
): number {
  return Buffer.byteLength(
    serializeManifest(manifest),
    "utf8",
  );
}

function addSafeStorageBytes(
  current: number,
  increment: number,
): number | undefined {
  if (
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(increment) ||
    current < 0 ||
    increment < 0 ||
    current >
      Number.MAX_SAFE_INTEGER - increment
  ) {
    return undefined;
  }
  return current + increment;
}

function blockUnsafeByteAccounting(
  inventory: CheckpointStorageInventory,
  directory: "checkpoints" | "objects",
  fileName: string,
): void {
  inventory.capacityAccountingComplete = false;
  inventory.observedBytes =
    Number.MAX_SAFE_INTEGER;
  inventory.chargedBytes =
    Number.MAX_SAFE_INTEGER;
  if (
    inventory.blockers.some(
      ({ reason }) =>
        reason ===
        "byte-accounting-limit-exceeded",
    )
  ) {
    return;
  }
  inventory.blockers.push({
    directory,
    fileName,
    reason:
      "byte-accounting-limit-exceeded",
    message:
      "Checkpoint storage bytes exceed the exact safe-integer accounting range.",
  });
}

async function scanStorageDirectory(
  directoryPath: string,
  directory: "checkpoints" | "objects",
  inventory: CheckpointStorageInventory,
  maxEntries: number,
  inspectRegularFile: (
    entry: Dirent,
    entryPath: string,
    size: number,
  ) => void | Promise<void>,
): Promise<void> {
  const handle = await opendir(directoryPath);
  try {
    while (true) {
      const entry = await handle.read();
      if (!entry) {
        break;
      }
      inventory.observedEntries += 1;
      if (
        inventory.observedEntries > maxEntries
      ) {
        inventory.capacityAccountingComplete =
          false;
        inventory.blockers.push({
          directory,
          fileName: entry.name,
          reason: "scan-limit-exceeded",
          message:
            `Checkpoint storage contains more than ${maxEntries} observed entries.`,
        });
        break;
      }

      const entryPath = join(
        directoryPath,
        entry.name,
      );
      let entryStat;
      try {
        entryStat = await lstat(entryPath, {
          bigint: true,
        });
      } catch (error) {
        inventory.capacityAccountingComplete =
          false;
        inventory.blockers.push({
          directory,
          fileName: entry.name,
          reason: "entry-inspection-failed",
          message:
            `Checkpoint storage entry could not be inspected safely (${filesystemErrorCode(error)}).`,
        });
        continue;
      }
      if (
        entryStat.size >
        BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        blockUnsafeByteAccounting(
          inventory,
          directory,
          entry.name,
        );
        continue;
      }
      const entrySize = Number(entryStat.size);
      const observedBytes = addSafeStorageBytes(
        inventory.observedBytes,
        entrySize,
      );
      const chargedBytes = addSafeStorageBytes(
        inventory.chargedBytes,
        entrySize,
      );
      if (
        observedBytes === undefined ||
        chargedBytes === undefined
      ) {
        blockUnsafeByteAccounting(
          inventory,
          directory,
          entry.name,
        );
        continue;
      }
      inventory.observedBytes = observedBytes;
      inventory.chargedBytes = chargedBytes;
      if (entryStat.isSymbolicLink()) {
        inventory.blockers.push({
          directory,
          fileName: entry.name,
          reason: "symbolic-link",
          message:
            "Symbolic links are not valid checkpoint storage entries.",
        });
        continue;
      }
      if (!entryStat.isFile()) {
        inventory.blockers.push({
          directory,
          fileName: entry.name,
          reason: "non-regular-entry",
          message:
            "Only regular files are valid checkpoint storage entries.",
        });
        continue;
      }
      await inspectRegularFile(
        entry,
        entryPath,
        entrySize,
      );
    }
  } finally {
    await handle.close().catch((error: unknown) => {
      if (!hasCode(error, "ERR_DIR_CLOSED")) {
        throw error;
      }
    });
  }
}

function garbageCollectionReport(
  inventory: CheckpointStorageInventory,
  deleted: readonly CheckpointStorageEntry[],
): CheckpointGarbageCollectionReport {
  const deletedBytes = deleted.reduce(
    (sum, entry) => sum + entry.size,
    0,
  );
  const deletedObjects = deleted.filter(
    ({ kind }) => kind === "object",
  ).length;
  const deletedTemporaryFiles =
    deleted.length - deletedObjects;
  return {
    observedBytes: inventory.observedBytes,
    chargedBytes: inventory.chargedBytes,
    observedEntries: inventory.observedEntries,
    retainedBytes:
      inventory.observedBytes - deletedBytes,
    retainedChargedBytes:
      inventory.chargedBytes - deletedBytes,
    retainedEntries:
      inventory.observedEntries - deleted.length,
    deletedBytes,
    deletedEntries: deleted.length,
    deletedObjects,
    deletedTemporaryFiles,
    blocked: inventory.blockers.length > 0,
    blockers: [...inventory.blockers],
  };
}

const CHECKPOINT_PRUNE_BLOCKER_SAMPLE_LIMIT = 32;

function checkpointPruneGarbageCollectionResult(
  report: CheckpointGarbageCollectionReport,
): CheckpointPruneGarbageCollectionResult {
  if (report.blocked) {
    const blockers = report.blockers
      .slice(
        0,
        CHECKPOINT_PRUNE_BLOCKER_SAMPLE_LIMIT,
      )
      .map(sanitizeCheckpointPruneBlocker);
    return {
      status: "blocked",
      deletedBytes: 0,
      deletedEntries: 0,
      deletedObjects: 0,
      deletedTemporaryFiles: 0,
      blockerCount: report.blockers.length,
      blockers,
      blockersTruncated:
        blockers.length <
        report.blockers.length,
    };
  }
  return {
    status: "completed",
    deletedBytes: report.deletedBytes,
    deletedEntries: report.deletedEntries,
    deletedObjects: report.deletedObjects,
    deletedTemporaryFiles:
      report.deletedTemporaryFiles,
    blockerCount: 0,
    blockers: [],
    blockersTruncated: false,
  };
}

function sanitizeCheckpointPruneBlocker(
  blocker: CheckpointGarbageCollectionBlocker,
): CheckpointGarbageCollectionBlocker {
  const messages: Record<
    CheckpointGarbageCollectionBlocker["reason"],
    string
  > = {
    "entry-inspection-failed":
      "Checkpoint storage entry could not be inspected safely.",
    "byte-accounting-limit-exceeded":
      "Checkpoint storage exceeds the exact byte-accounting range.",
    "malformed-manifest":
      "Checkpoint manifest could not be parsed and validated safely.",
    "missing-referenced-object":
      "Checkpoint manifest references a missing content object.",
    "non-regular-entry":
      "Checkpoint storage entry is not a regular file.",
    "scan-limit-exceeded":
      "Checkpoint storage scan limit was exceeded.",
    "symbolic-link":
      "Checkpoint storage entry is a symbolic link.",
    "unexpected-entry":
      "Checkpoint storage contains an unexpected entry.",
  };
  return {
    directory: blocker.directory,
    ...(blocker.fileName === undefined
      ? {}
      : { fileName: blocker.fileName }),
    reason: blocker.reason,
    message: messages[blocker.reason],
  };
}

function failedCheckpointPruneResult(
  manifest: CheckpointManifest & {
    status: "committed";
  },
): CheckpointPruneStorageResult {
  return {
    manifest,
    manifestDeleted: true,
    garbageCollection: {
      status: "failed",
      failureCode: "INTERNAL_ERROR",
      deletionOutcome:
        "unknown-partial-or-none",
    },
  };
}

function filesystemErrorCode(error: unknown): string {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error)
  ) {
    return "UNKNOWN_ERROR";
  }
  const code =
    (error as NodeJS.ErrnoException).code;
  return typeof code === "string"
    ? code
    : "UNKNOWN_ERROR";
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

async function atomicCreateJson(
  path: string,
  value: CheckpointManifest,
): Promise<void> {
  const temporaryPath =
    `${path}.${randomUUID()}.tmp`;
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
      serializeManifest(value),
      "utf8",
    );
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (hasCode(error, "EEXIST")) {
        throw new TiledMcpError(
          "CHECKPOINT_CHANGED",
          `Checkpoint ${value.id} already exists and was not replaced.`,
          { checkpointId: value.id },
        );
      }
      throw error;
    }
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
      serializeManifest(value),
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

function serializeManifest(
  value: CheckpointManifest,
): string {
  return `${JSON.stringify(value, null, 2)}\n`;
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
