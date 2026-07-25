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
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const CHECKPOINT_ID_INPUT_PATTERN =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/u;
const CHECKPOINT_MANIFEST_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/u;
const CHECKPOINT_TEMP_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;
const CHECKPOINT_OBJECT_TEMP_PATTERN =
  /^[0-9a-f]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/u;
const CHECKPOINT_STORAGE_MUTEX = new KeyedMutex();
const CHECKPOINT_RETENTION_SEQUENCE_FILE =
  "checkpoint-retention-sequence.json";
const CHECKPOINT_RETENTION_SEQUENCE_MAX_BYTES = 1_024;
export const MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT = 2;
export const ROLLING_CHECKPOINT_RETENTION_POLICY =
  "rolling-per-target-count-v1" as const;
export const MIN_CHECKPOINT_BATCH_PRUNE_COUNT = 2;
export const MAX_CHECKPOINT_BATCH_PRUNE_COUNT = 32;
export const CHECKPOINT_BATCH_PRUNE_STORE_LOCK_WARNING =
  "Checkpoint batch pruning deleted one or more manifests, but release of the checkpoint-store lock could not be confirmed.";
export const CHECKPOINT_BATCH_PRUNE_DURABILITY_WARNING =
  "Checkpoint batch pruning observed a manifest unlink whose directory durability could not be confirmed; later approved deletions were not attempted.";
export const CHECKPOINT_BATCH_PRUNE_STOPPED_WARNING =
  "Checkpoint batch pruning stopped after deleting a prefix; the other approved manifest deletions remain unresolved and require a fresh list and preview.";
export const CHECKPOINT_BATCH_PRUNE_GC_BLOCKED_WARNING =
  "Checkpoint batch pruning deleted every approved manifest, but garbage collection was blocked; unreferenced checkpoint storage was retained.";
export const CHECKPOINT_BATCH_PRUNE_GC_FAILED_WARNING =
  "Checkpoint batch pruning deleted every approved manifest, but garbage collection could not be completed; unreferenced checkpoint storage may remain.";
export const CHECKPOINT_BATCH_PRUNE_GC_NOT_RUN_WARNING =
  "Checkpoint batch pruning stopped after a manifest unlink, so garbage collection was not run.";

export const CHECKPOINT_STORAGE_POLICY = Object.freeze({
  name: "tiled-mcp-checkpoint-storage",
  version: 6,
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
    "explicit-approved-raw-cas-single-or-bounded-batch-committed-prune-safe-prepared-current-before-discard-ambiguous-prepared-abandon-or-opt-in-v2-rolling-post-commit-retention",
  explicitBatchPruneCoordination:
    "all-canonical-target-locks-sorted-then-single-checkpoint-store-lock",
  explicitBatchPrunePreflight:
    "all-approved-committed-manifest-pins-raw-and-semantic-cas-before-first-unlink",
  explicitBatchPruneDeletionOrder:
    "canonical-checkpoint-id-order-with-per-manifest-unlink-and-checkpoint-directory-fsync",
  explicitBatchPruneGarbageCollection:
    "once-after-all-approved-manifests-are-durably-unlinked-and-post-delete-hooks-complete",
  explicitBatchPruneFailure:
    "stop-after-first-failure-preserve-deleted-prefix-and-never-resume-cached-result",
  automaticValidManifestPruning:
    "explicitly-configured-v2-rolling-committed-manifests-only",
  automaticRetentionCoordination:
    "caller-held-target-lock-then-checkpoint-store-lock",
  automaticRetentionOrdering:
    "durable-global-positive-safe-integer-ordinal-only",
  automaticRetentionSequenceAccounting:
    "internal-control-file-outside-objects-and-checkpoints-retained-quota",
  automaticRetentionSequenceTemporary:
    "single-fixed-private-crash-temporary-cleaned-under-checkpoint-store-lock",
  automaticRetentionProtectedRoots:
    "legacy-v1-v2-protected-and-all-prepared-manifests",
  automaticRetentionDeletionLimit:
    "at-most-one-oldest-eligible-rolling-manifest-per-enforcement",
  automaticRetentionPreflight:
    "complete-inventory-valid-sequence-safe-independent-rolling-anchors-and-all-root-object-content-verification-before-first-unlink",
  automaticRetentionDeletionOrder:
    "raw-and-metadata-cas-manifest-unlink-checkpoint-directory-fsync-then-fail-closed-orphan-sweep",
  automaticRetentionQuotaPressure:
    "never-delete-valid-manifests-before-or-during-capacity-enforcement",
  explicitPruneCoordination:
    "target-lock-then-checkpoint-store-lock",
  explicitPruneDeletionOrder:
    "manifest-unlink-checkpoint-directory-fsync-then-fail-closed-orphan-sweep",
  explicitPreparedDiscardEligibility:
    "prepared-manifest-and-target-exactly-matches-before-state",
  explicitPreparedDiscardCoordination:
    "target-lock-then-checkpoint-store-lock",
  explicitPreparedDiscardDeletionOrder:
    "manifest-unlink-checkpoint-directory-fsync-then-fail-closed-orphan-sweep",
  explicitPreparedAdjudicationEligibility:
    "prepared-manifest-with-ambiguous-safe-target-state-only-machine-reconcilable-and-unsafe-states-rejected",
  explicitPreparedAdjudicationPins:
    "manifest-version-retention-full-semantic-state-raw-revision-and-size-plus-safe-target-revision-and-size",
  explicitPreparedAdjudicationCoordination:
    "target-mutex-then-target-file-lock-then-checkpoint-store-lock",
  explicitPreparedCommitEligibility:
    "prepared-create-manifest-and-safe-regular-target-exactly-matches-after-revision",
  explicitPreparedCommitOrder:
    "raw-and-semantic-cas-target-revalidation-atomic-prepared-to-committed-rename-then-checkpoint-directory-fsync",
  explicitPreparedCommitFailure:
    "rename-is-commit-point-and-post-rename-failures-return-bounded-unconfirmed-success-without-garbage-collection",
  explicitPreparedAbandonOrder:
    "raw-and-semantic-cas-target-revalidation-manifest-unlink-checkpoint-directory-fsync-then-fail-closed-orphan-sweep",
  explicitPreparedAbandonFailure:
    "unlink-is-commit-point-and-post-unlink-failures-return-bounded-success",
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
  /**
   * Batch-prune-only fault seam. Throwing here models failure after unlink
   * became observable but before checkpoint-directory durability is known.
   */
  afterBatchManifestUnlinkedBeforeDirectorySync?(context: {
    checkpointId: string;
  }): void | Promise<void>;
  /**
   * Prepared-commit-only fault seam. Throwing here models failure after the
   * prepared-to-committed rename became observable but before checkpoint
   * directory durability is known.
   */
  afterPreparedCheckpointCommitInstalledBeforeDirectorySync?(context: {
    checkpointId: string;
  }): void | Promise<void>;
  /**
   * Prepared-abandon-only fault seam. Throwing here models failure after the
   * manifest unlink became observable but before directory durability is
   * known.
   */
  afterPreparedCheckpointAbandonManifestUnlinkedBeforeDirectorySync?(context: {
    checkpointId: string;
  }): void | Promise<void>;
  afterManifestDeletedBeforeGarbageCollection?(context: {
    checkpointId: string;
  }): void | Promise<void>;
}

export interface CheckpointStoreOptions {
  maxBytes?: number;
  /** Test and constrained-deployment override; production defaults to 10,000. */
  maxEntries?: number;
  /**
   * Opt-in rolling committed checkpoint retention per target. Legacy,
   * protected, and prepared checkpoints are never counted or deleted.
   */
  retainCommittedPerTarget?: number;
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
  manifests: CheckpointInventoryManifest[];
  objects: CheckpointStorageEntry[];
  temporaryFiles: CheckpointStorageEntry[];
}

export interface CheckpointManifest {
  version: 1 | 2;
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
  retention?:
    | {
        class: "protected";
      }
    | {
        class: "rolling";
        ordinal: number;
      };
}

export type LegacyCheckpointManifest =
  CheckpointManifest & {
    version: 1;
    retention?: never;
  };

export type ProtectedCheckpointManifest =
  CheckpointManifest & {
    version: 2;
    retention: {
      class: "protected";
    };
  };

export type RollingCheckpointManifest =
  CheckpointManifest & {
    version: 2;
    retention: {
      class: "rolling";
      ordinal: number;
    };
  };

export type RollingCommittedCheckpointManifest =
  RollingCheckpointManifest & {
    status: "committed";
  };

export interface CheckpointManifestSnapshot {
  manifest: CheckpointManifest;
  manifestRevision: string;
  manifestSize: number;
}

interface CheckpointInventoryManifest
  extends CheckpointManifestSnapshot {
  metadata: BigIntStats;
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

export interface PreparedCheckpointDiscardStorageExpectation {
  id: string;
  createdAt: string;
  label?: string;
  path: string;
  status: "prepared";
  before: CheckpointManifest["before"];
  afterRevision: string;
  manifestRevision: string;
  manifestSize: number;
}

export type PreparedCheckpointAdjudicationTarget =
  | {
      existed: false;
    }
  | {
      existed: true;
      revision: string;
      size: number;
    };

export type PreparedCheckpointAdjudicationConflict =
  | "create-target-matches-after"
  | "create-target-unrelated"
  | "existing-target-missing"
  | "existing-target-unrelated";

export interface PreparedCheckpointAdjudicationStorageExpectation {
  version: CheckpointManifest["version"];
  retention?: CheckpointManifest["retention"];
  id: string;
  createdAt: string;
  label?: string;
  path: string;
  status: "prepared";
  before: CheckpointManifest["before"];
  afterRevision: string;
  manifestRevision: string;
  manifestSize: number;
  target: PreparedCheckpointAdjudicationTarget;
  conflict: PreparedCheckpointAdjudicationConflict;
}

export type CheckpointManifestDeletionGarbageCollectionResult =
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

export type CheckpointPruneGarbageCollectionResult =
  CheckpointManifestDeletionGarbageCollectionResult;

export type RollingCheckpointRetentionBlockedReason =
  | "current-checkpoint-changed"
  | "current-not-highest-rolling"
  | "incomplete-inventory"
  | "object-verification-failed"
  | "prepared-checkpoint-present"
  | "sequence-state-invalid"
  | "target-validation-failed"
  | "unsafe-lineage";

interface RollingCheckpointRetentionResultBase {
  policy: typeof ROLLING_CHECKPOINT_RETENTION_POLICY;
  retainCommittedPerTarget: number;
  manifestDeleted: boolean;
}

export type RollingCheckpointRetentionResult =
  | (RollingCheckpointRetentionResultBase & {
      status: "not-needed";
      manifestDeleted: false;
      rollingCommittedCount: number;
    })
  | (RollingCheckpointRetentionResultBase & {
      status: "blocked";
      manifestDeleted: false;
      reason: RollingCheckpointRetentionBlockedReason;
      rollingCommittedCount: number;
    })
  | (RollingCheckpointRetentionResultBase & {
      status: "deleted";
      manifestDeleted: true;
      deletedCheckpointId: string;
      rollingCommittedCountBefore: number;
      garbageCollection:
        CheckpointManifestDeletionGarbageCollectionResult;
    });

export interface CheckpointPruneStorageResult {
  manifest: CheckpointManifest & {
    status: "committed";
  };
  manifestDeleted: true;
  garbageCollection:
    CheckpointPruneGarbageCollectionResult;
}

export interface CheckpointBatchPruneStorageExpectation
  extends CheckpointPruneStorageExpectation {
  version: CheckpointManifest["version"];
  retention?: CheckpointManifest["retention"];
}

export type CheckpointBatchPruneOutcome =
  | {
      checkpointId: string;
      path: string;
      outcome: "deleted";
      manifestDeleted: true;
      durability:
        | "confirmed"
        | "unconfirmed";
    }
  | {
      checkpointId: string;
      path: string;
      outcome: "failed";
      failureCode: "INTERNAL_ERROR";
    }
  | {
      checkpointId: string;
      path: string;
      outcome: "not-attempted";
      reason:
        "batch-stopped-before-checkpoint";
    };

export type CheckpointBatchPruneGarbageCollectionResult =
  | CheckpointManifestDeletionGarbageCollectionResult
  | {
      status: "not-run";
      reason:
        "batch-stopped-before-garbage-collection";
    };

export interface CheckpointBatchPruneStorageResult {
  kind: "checkpointPruneBatch";
  status: "completed" | "partial";
  replayDisposition:
    "cached-final-no-resume";
  requestedCheckpointCount: number;
  manifestDeletedCount: number;
  unresolvedCheckpointCount: number;
  outcomes: CheckpointBatchPruneOutcome[];
  garbageCollection:
    CheckpointBatchPruneGarbageCollectionResult;
  warnings?: string[];
}

export interface PreparedCheckpointDiscardStorageResult {
  manifest: CheckpointManifest & {
    status: "prepared";
  };
  manifestDeleted: true;
  garbageCollection:
    CheckpointManifestDeletionGarbageCollectionResult;
}

export interface PreparedCheckpointCommitStorageResult {
  manifest: CheckpointManifest & {
    status: "committed";
  };
  previousStatus: "prepared";
  manifestCommitted: true;
  durability: "confirmed" | "unconfirmed";
}

export interface PreparedCheckpointAbandonStorageResult {
  manifest: CheckpointManifest & {
    status: "prepared";
  };
  manifestDeleted: true;
  garbageCollection:
    CheckpointManifestDeletionGarbageCollectionResult;
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
  readonly retainCommittedPerTarget:
    | number
    | undefined;
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
    const retainCommittedPerTarget =
      options.retainCommittedPerTarget;
    if (
      retainCommittedPerTarget !== undefined &&
      (!Number.isSafeInteger(
        retainCommittedPerTarget,
      ) ||
        retainCommittedPerTarget <
          MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT ||
        retainCommittedPerTarget > maxEntries)
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `Automatic checkpoint retention must be a safe integer from ${MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT} through maxEntries.`,
        {
          retainCommittedPerTarget,
          maxEntries,
        },
      );
    }
    this.retainCommittedPerTarget =
      retainCommittedPerTarget;
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

    return this.runStorageExclusive(async () => {
      const directories =
        await this.ensureStorageDirectories();
      const manifestBase = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        label,
        path: projectPath,
        status: "prepared" as const,
        before: beforeState,
        afterRevision,
      };
      let manifest: CheckpointManifest;
      if (
        this.retainCommittedPerTarget ===
        undefined
      ) {
        manifest = {
          version: 1,
          ...manifestBase,
        };
      } else if (
        !beforeState.existed ||
        beforeState.revision === afterRevision
      ) {
        manifest = {
          version: 2,
          ...manifestBase,
          retention: {
            class: "protected",
          },
        };
      } else {
        const ordinal =
          await this.reserveNextRetentionOrdinal(
            directories,
          );
        manifest = {
          version: 2,
          ...manifestBase,
          retention: {
            class: "rolling",
            ordinal,
          },
        };
      }
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

  async inspectManifest(
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

  async inspectPrune(
    id: string,
  ): Promise<CheckpointManifestSnapshot> {
    return this.inspectManifest(id);
  }

  async pruneCommitted(
    expected: CheckpointPruneStorageExpectation,
  ): Promise<CheckpointPruneStorageResult> {
    return this.deleteManifestPlanned(
      expected,
      "committed",
    );
  }

  async inspectBatchPrune(
    checkpointIds: readonly string[],
  ): Promise<CheckpointManifestSnapshot[]> {
    const orderedIds =
      canonicalCheckpointBatchIds(
        checkpointIds,
      );
    return this.runStorageExclusive(async () => {
      const { checkpoints } =
        await this.ensureStorageDirectories();
      const snapshots: CheckpointManifestSnapshot[] =
        [];
      for (const id of orderedIds) {
        const snapshot =
          await this.readManifestSnapshot(
            checkpoints,
            id,
          );
        if (
          snapshot.manifest.status !==
          "committed"
        ) {
          throw new TiledMcpError(
            "CHECKPOINT_NOT_COMMITTED",
            `Checkpoint ${id} is still prepared and cannot be batch pruned.`,
            { checkpointId: id },
          );
        }
        snapshots.push(snapshot);
      }
      return snapshots;
    });
  }

  /**
   * The caller must hold every distinct authoritative target lock, sorted by
   * normalized project path. This method acquires the checkpoint-store lock
   * once, pins every manifest before the first unlink, and then removes a
   * canonical-id prefix with one fsync commit point per manifest.
   */
  async pruneCommittedBatch(
    expectations: readonly CheckpointBatchPruneStorageExpectation[],
  ): Promise<CheckpointBatchPruneStorageResult> {
    const ordered =
      canonicalCheckpointBatchExpectations(
        expectations,
      );
    let outcomes: CheckpointBatchPruneOutcome[] =
      [];
    let manifestDeletedCount = 0;
    let storeLockReleaseFailed = false;
    let result:
      | CheckpointBatchPruneStorageResult
      | undefined;

    const finish = (
      garbageCollection: CheckpointBatchPruneGarbageCollectionResult,
      warnings: readonly string[],
    ): CheckpointBatchPruneStorageResult => {
      const completedOutcomes = [
        ...outcomes,
      ];
      const attemptedIds = new Set(
        completedOutcomes.map(
          ({ checkpointId }) =>
            checkpointId,
        ),
      );
      for (const expected of ordered) {
        if (
          attemptedIds.has(expected.id)
        ) {
          continue;
        }
        completedOutcomes.push({
          checkpointId: expected.id,
          path: expected.path,
          outcome: "not-attempted",
          reason:
            "batch-stopped-before-checkpoint",
        });
      }
      const uniqueWarnings = [
        ...new Set(warnings),
      ];
      return {
        kind: "checkpointPruneBatch",
        status:
          manifestDeletedCount ===
          ordered.length
            ? "completed"
            : "partial",
        replayDisposition:
          "cached-final-no-resume",
        requestedCheckpointCount:
          ordered.length,
        manifestDeletedCount,
        unresolvedCheckpointCount:
          ordered.length -
          manifestDeletedCount,
        outcomes: completedOutcomes,
        garbageCollection,
        ...(uniqueWarnings.length === 0
          ? {}
          : { warnings: uniqueWarnings }),
      };
    };

    try {
      result =
        await this.runStorageExclusive(
          async () => {
            const directories =
              await this.ensureStorageDirectories();
            const pinned: Array<
              CheckpointManifest & {
                status: "committed";
              }
            > = [];

            // This is deliberately a complete batch preflight, not a loop
            // around the single-prune kernel. Any pin drift aborts before the
            // first destructive operation.
            for (const expected of ordered) {
              const snapshot =
                await this.readManifestSnapshot(
                  directories.checkpoints,
                  expected.id,
                );
              if (
                !sameCheckpointBatchPruneExpectation(
                  expected,
                  snapshot,
                ) ||
                snapshot.manifest.status !==
                  "committed"
              ) {
                throw new TiledMcpError(
                  "CHECKPOINT_CHANGED",
                  `Checkpoint ${expected.id} changed after batch prune inspection.`,
                  {
                    checkpointId:
                      expected.id,
                  },
                );
              }
              pinned.push(
                snapshot.manifest as CheckpointManifest & {
                  status: "committed";
                },
              );
            }

            let stopped = false;
            let durabilityUnconfirmed = false;
            for (
              let index = 0;
              index < pinned.length;
              index += 1
            ) {
              const manifest =
                pinned[index] as CheckpointManifest & {
                  status: "committed";
                };
              try {
                await unlink(
                  join(
                    directories.checkpoints,
                    `${manifest.id}.json`,
                  ),
                );
              } catch (error) {
                if (
                  manifestDeletedCount === 0
                ) {
                  throw error;
                }
                outcomes.push({
                  checkpointId:
                    manifest.id,
                  path: manifest.path,
                  outcome: "failed",
                  failureCode:
                    "INTERNAL_ERROR",
                });
                stopped = true;
                break;
              }

              manifestDeletedCount += 1;
              let durability:
                | "confirmed"
                | "unconfirmed" =
                "confirmed";
              try {
                await this.observer
                  ?.afterBatchManifestUnlinkedBeforeDirectorySync?.(
                    {
                      checkpointId:
                        manifest.id,
                    },
                  );
                await syncDirectory(
                  directories.checkpoints,
                );
              } catch {
                durability =
                  "unconfirmed";
                durabilityUnconfirmed =
                  true;
              }
              outcomes.push({
                checkpointId: manifest.id,
                path: manifest.path,
                outcome: "deleted",
                manifestDeleted: true,
                durability,
              });
              if (
                durability ===
                "unconfirmed"
              ) {
                stopped = true;
                break;
              }
              try {
                await this.observer
                  ?.afterManifestDeletedBeforeGarbageCollection?.(
                    {
                      checkpointId:
                        manifest.id,
                    },
                  );
              } catch {
                stopped = true;
                break;
              }
            }

            if (stopped) {
              const allManifestsDeleted =
                manifestDeletedCount ===
                ordered.length;
              const warnings: string[] =
                allManifestsDeleted
                  ? [
                      CHECKPOINT_BATCH_PRUNE_GC_FAILED_WARNING,
                    ]
                  : [
                      CHECKPOINT_BATCH_PRUNE_GC_NOT_RUN_WARNING,
                      CHECKPOINT_BATCH_PRUNE_STOPPED_WARNING,
                    ];
              if (durabilityUnconfirmed) {
                warnings.push(
                  CHECKPOINT_BATCH_PRUNE_DURABILITY_WARNING,
                );
              }
              return finish(
                allManifestsDeleted
                  ? {
                      status: "failed",
                      failureCode:
                        "INTERNAL_ERROR",
                      deletionOutcome:
                        "unknown-partial-or-none",
                    }
                  : {
                      status: "not-run",
                      reason:
                        "batch-stopped-before-garbage-collection",
                    },
                warnings,
              );
            }

            let garbageCollection: CheckpointManifestDeletionGarbageCollectionResult;
            try {
              const inventory =
                await this.inventory(
                  directories,
                );
              const report =
                await this.sweepInventory(
                  directories,
                  inventory,
                );
              garbageCollection =
                checkpointManifestDeletionGarbageCollectionResult(
                  report,
                );
            } catch {
              garbageCollection = {
                status: "failed",
                failureCode:
                  "INTERNAL_ERROR",
                deletionOutcome:
                  "unknown-partial-or-none",
              };
            }
            const warnings: string[] = [];
            if (
              garbageCollection.status ===
              "blocked"
            ) {
              warnings.push(
                CHECKPOINT_BATCH_PRUNE_GC_BLOCKED_WARNING,
              );
            } else if (
              garbageCollection.status ===
              "failed"
            ) {
              warnings.push(
                CHECKPOINT_BATCH_PRUNE_GC_FAILED_WARNING,
              );
            }
            return finish(
              garbageCollection,
              warnings,
            );
          },
          () => {
            storeLockReleaseFailed = true;
          },
        );
    } catch (error) {
      if (manifestDeletedCount === 0) {
        throw error;
      }
      const allManifestsDeleted =
        manifestDeletedCount ===
        ordered.length;
      result = finish(
        allManifestsDeleted
          ? {
              status: "failed",
              failureCode:
                "INTERNAL_ERROR",
              deletionOutcome:
                "unknown-partial-or-none",
            }
          : {
              status: "not-run",
              reason:
                "batch-stopped-before-garbage-collection",
            },
        [
          allManifestsDeleted
            ? CHECKPOINT_BATCH_PRUNE_GC_FAILED_WARNING
            : CHECKPOINT_BATCH_PRUNE_GC_NOT_RUN_WARNING,
          ...(!allManifestsDeleted
            ? [
                CHECKPOINT_BATCH_PRUNE_STOPPED_WARNING,
              ]
            : []),
        ],
      );
    }

    if (
      storeLockReleaseFailed &&
      manifestDeletedCount > 0
    ) {
      result = addCheckpointBatchPruneWarning(
        result,
        CHECKPOINT_BATCH_PRUNE_STORE_LOCK_WARNING,
      );
    }
    return result;
  }

  async discardPrepared(
    expected: PreparedCheckpointDiscardStorageExpectation,
    validateTarget: (
      manifest: CheckpointManifest & {
        status: "prepared";
      },
    ) => Promise<void>,
  ): Promise<PreparedCheckpointDiscardStorageResult> {
    return this.deleteManifestPlanned(
      expected,
      "prepared",
      validateTarget,
    );
  }

  /**
   * The caller must hold the authoritative target lock. This method acquires
   * the checkpoint-store lock second, revalidates both the raw manifest and
   * its complete semantic state, and treats the atomic rename as the commit
   * point. No garbage collection runs for this state-only transition.
   */
  async commitPreparedCheckpoint(
    expected: PreparedCheckpointAdjudicationStorageExpectation,
    validateTarget: (
      manifest: CheckpointManifest & {
        status: "prepared";
      },
    ) => Promise<void>,
  ): Promise<PreparedCheckpointCommitStorageResult> {
    assertPreparedCheckpointAdjudicationStorageExpectation(
      expected,
    );
    if (
      expected.conflict !==
        "create-target-matches-after" ||
      expected.before.existed
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "Prepared checkpoint commit requires an ambiguous create whose target matches the after revision.",
        { checkpointId: expected.id },
      );
    }

    let installedManifest:
      | (CheckpointManifest & {
          status: "committed";
        })
      | undefined;
    let storeLockReleaseFailed = false;
    const unconfirmed =
      (): PreparedCheckpointCommitStorageResult => {
        if (installedManifest === undefined) {
          throw new Error(
            "Prepared checkpoint commit did not reach its rename commit point.",
          );
        }
        return {
          manifest: installedManifest,
          previousStatus: "prepared",
          manifestCommitted: true,
          durability: "unconfirmed",
        };
      };

    try {
      const result =
        await this.runStorageExclusive<PreparedCheckpointCommitStorageResult>(
          async () => {
            const directories =
              await this.ensureStorageDirectories();
            const snapshot =
              await this.readManifestSnapshot(
                directories.checkpoints,
                expected.id,
              );
            if (
              !samePreparedCheckpointAdjudicationExpectation(
                expected,
                snapshot,
              )
            ) {
              throw new TiledMcpError(
                "CHECKPOINT_CHANGED",
                `Checkpoint ${expected.id} changed after prepared commit inspection.`,
                { checkpointId: expected.id },
              );
            }
            const prepared =
              snapshot.manifest as CheckpointManifest & {
                status: "prepared";
              };
            await validateTarget(prepared);

            const committed: CheckpointManifest & {
              status: "committed";
            } = {
              ...prepared,
              status: "committed",
            };
            await this.assertManifestReplacementReserved(
              directories,
              prepared,
              committed,
            );
            await atomicWriteJson(
              join(
                directories.checkpoints,
                `${expected.id}.json`,
              ),
              committed,
              async () => {
                installedManifest = committed;
                await this.observer
                  ?.afterPreparedCheckpointCommitInstalledBeforeDirectorySync?.(
                    {
                      checkpointId:
                        committed.id,
                    },
                  );
              },
            );
            return {
              manifest: committed,
              previousStatus: "prepared",
              manifestCommitted: true,
              durability: "confirmed",
            };
          },
          () => {
            storeLockReleaseFailed = true;
          },
        );
      if (
        storeLockReleaseFailed &&
        installedManifest !== undefined
      ) {
        return unconfirmed();
      }
      return result;
    } catch (error) {
      // Rename is the state-transition commit point. Once it succeeds, an
      // observer, directory fsync, or lock-release failure must not expose a
      // retryable error that could cause the operator action to be repeated.
      if (installedManifest !== undefined) {
        return unconfirmed();
      }
      throw error;
    }
  }

  /**
   * The caller must hold the authoritative target lock. Unlike commit,
   * abandon never needs the before object: it deletes the ambiguous prepared
   * recovery point and then reuses the fail-closed garbage collector.
   */
  async abandonPreparedCheckpoint(
    expected: PreparedCheckpointAdjudicationStorageExpectation,
    validateTarget: (
      manifest: CheckpointManifest & {
        status: "prepared";
      },
    ) => Promise<void>,
  ): Promise<PreparedCheckpointAbandonStorageResult> {
    assertPreparedCheckpointAdjudicationStorageExpectation(
      expected,
    );
    return this.deleteManifestPlanned(
      expected,
      "prepared",
      async (manifest) => {
        if (
          !samePreparedCheckpointAdjudicationManifest(
            expected,
            manifest,
          )
        ) {
          throw new TiledMcpError(
            "CHECKPOINT_CHANGED",
            `Checkpoint ${expected.id} changed after prepared abandon inspection.`,
            { checkpointId: expected.id },
          );
        }
        await validateTarget(manifest);
      },
      async (manifest) => {
        await this.observer
          ?.afterPreparedCheckpointAbandonManifestUnlinkedBeforeDirectorySync?.(
            {
              checkpointId: manifest.id,
            },
          );
      },
    );
  }

  /**
   * Enforces the opt-in rolling retention window while the caller continues
   * to hold the target's mutation lock. This method acquires the checkpoint
   * store lock second and deletes at most one manifest.
   */
  async enforceRollingRetention(
    currentCommitted: RollingCommittedCheckpointManifest,
    validateTarget: (
      manifest: RollingCommittedCheckpointManifest,
    ) => Promise<void>,
  ): Promise<RollingCheckpointRetentionResult> {
    if (
      this.retainCommittedPerTarget ===
      undefined
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "Automatic checkpoint retention is disabled.",
      );
    }
    const retainCommittedPerTarget =
      this.retainCommittedPerTarget;
    const resultBase = {
      policy:
        ROLLING_CHECKPOINT_RETENTION_POLICY,
      retainCommittedPerTarget,
    } as const;
    if (!isRollingManifest(currentCommitted)) {
      return {
        ...resultBase,
        status: "not-needed",
        manifestDeleted: false,
        rollingCommittedCount: 0,
      };
    }

    let deleted:
      | RollingCommittedCheckpointManifest
      | undefined;
    let rollingCommittedCountBefore = 0;
    let storeLockReleaseFailed = false;
    const blocked = (
      reason: RollingCheckpointRetentionBlockedReason,
      rollingCommittedCount =
        rollingCommittedCountBefore,
    ): RollingCheckpointRetentionResult => ({
      ...resultBase,
      status: "blocked",
      manifestDeleted: false,
      reason,
      rollingCommittedCount,
    });
    const failedDeleted =
      (): RollingCheckpointRetentionResult => ({
        ...resultBase,
        status: "deleted",
        manifestDeleted: true,
        deletedCheckpointId:
          (deleted as RollingCommittedCheckpointManifest)
            .id,
        rollingCommittedCountBefore,
        garbageCollection: {
          status: "failed",
          failureCode: "INTERNAL_ERROR",
          deletionOutcome:
            "unknown-partial-or-none",
        },
      });

    try {
      const result =
        await this.runStorageExclusive<
          RollingCheckpointRetentionResult
        >(
          async () => {
            let directories: CheckpointStorageDirectories;
            let inventory: CheckpointStorageInventory;
            try {
              directories =
                await this.ensureStorageDirectories();
              inventory =
                await this.inventory(
                  directories,
                );
            } catch {
              return blocked(
                "incomplete-inventory",
              );
            }
            const targetRollingCommitted =
              rollingCommittedManifestsForPath(
                inventory.manifests,
                currentCommitted.path,
              );
            rollingCommittedCountBefore =
              targetRollingCommitted.length;
            if (
              inventory.blockers.length > 0
            ) {
              return blocked(
                "incomplete-inventory",
              );
            }
            if (
              inventory.manifests.some(
                ({ manifest }) =>
                  manifest.path ===
                    currentCommitted.path &&
                  manifest.status ===
                    "prepared",
              )
            ) {
              return blocked(
                "prepared-checkpoint-present",
              );
            }

            let sequence:
              | CheckpointRetentionSequence
              | undefined;
            try {
              sequence =
                await this.readRetentionSequence(
                  directories,
                );
            } catch {
              return blocked(
                "sequence-state-invalid",
              );
            }
            const sequenceAnalysis =
              analyzeRetentionSequence(
                inventory.manifests,
                sequence,
              );
            if (!sequenceAnalysis.valid) {
              return blocked(
                "sequence-state-invalid",
              );
            }
            if (
              !hasSafeRollingLineage(
                targetRollingCommitted,
              )
            ) {
              return blocked(
                "unsafe-lineage",
              );
            }

            const currentSnapshot =
              targetRollingCommitted.at(-1);
            if (
              currentSnapshot === undefined ||
              currentSnapshot.manifest.id !==
                currentCommitted.id
            ) {
              return blocked(
                "current-not-highest-rolling",
              );
            }
            if (
              !sameManifestIntent(
                currentCommitted,
                currentSnapshot.manifest,
              ) ||
              currentSnapshot.manifest.status !==
                "committed"
            ) {
              return blocked(
                "current-checkpoint-changed",
              );
            }
            if (
              rollingCommittedCountBefore <=
              this.retainCommittedPerTarget!
            ) {
              return {
                ...resultBase,
                status: "not-needed",
                manifestDeleted: false,
                rollingCommittedCount:
                  rollingCommittedCountBefore,
              };
            }
            if (
              !(await this.verifyInventoryObjects(
                directories,
                inventory,
              ))
            ) {
              return blocked(
                "object-verification-failed",
              );
            }
            try {
              await validateTarget(
                currentSnapshot.manifest,
              );
            } catch {
              return blocked(
                "target-validation-failed",
              );
            }

            const candidate =
              targetRollingCommitted[0];
            if (
              candidate === undefined ||
              !isSafeRollingDeletionCandidate(
                candidate.manifest,
              )
            ) {
              return blocked(
                "unsafe-lineage",
              );
            }
            if (
              !(await this.retentionCandidateMatches(
                directories,
                candidate,
              ))
            ) {
              return blocked(
                "current-checkpoint-changed",
              );
            }

            await unlink(
              join(
                directories.checkpoints,
                `${candidate.manifest.id}.json`,
              ),
            );
            deleted = candidate.manifest;
            try {
              await syncDirectory(
                directories.checkpoints,
              );
              await this.observer
                ?.afterManifestDeletedBeforeGarbageCollection?.(
                  {
                    checkpointId:
                      candidate.manifest.id,
                  },
                );
              const afterDeleteInventory =
                await this.inventory(
                  directories,
                );
              const report =
                await this.sweepInventory(
                  directories,
                  afterDeleteInventory,
                );
              return {
                ...resultBase,
                status: "deleted",
                manifestDeleted: true,
                deletedCheckpointId:
                  candidate.manifest.id,
                rollingCommittedCountBefore,
                garbageCollection:
                  checkpointManifestDeletionGarbageCollectionResult(
                    report,
                  ),
              };
            } catch {
              return failedDeleted();
            }
          },
          () => {
            storeLockReleaseFailed = true;
          },
        );
      if (
        storeLockReleaseFailed &&
        deleted !== undefined
      ) {
        return failedDeleted();
      }
      if (storeLockReleaseFailed) {
        return blocked(
          "incomplete-inventory",
        );
      }
      return result;
    } catch {
      if (deleted !== undefined) {
        return failedDeleted();
      }
      return blocked("incomplete-inventory");
    }
  }

  private async deleteManifestPlanned<
    TStatus extends CheckpointManifest["status"],
  >(
    expected: CheckpointManifestDeletionStorageExpectation<TStatus>,
    requiredStatus: TStatus,
    validateBeforeDelete?: (
      manifest: CheckpointManifest & {
        status: TStatus;
      },
    ) => Promise<void>,
    afterUnlinkBeforeDirectorySync?: (
      manifest: CheckpointManifest & {
        status: TStatus;
      },
    ) => Promise<void>,
  ): Promise<CheckpointManifestDeletionStorageResult<TStatus>> {
    assertCheckpointId(expected.id);
    let deletedManifest:
      | (CheckpointManifest & {
          status: TStatus;
        })
      | undefined;
    let storeLockReleaseFailed = false;
    try {
      const result =
        await this.runStorageExclusive<
          CheckpointManifestDeletionStorageResult<TStatus>
        >(
          async () => {
            const directories =
              await this.ensureStorageDirectories();
            const snapshot =
              await this.readManifestSnapshot(
                directories.checkpoints,
                expected.id,
              );
            if (
              !sameCheckpointManifestDeletionExpectation(
                expected,
                snapshot,
              )
            ) {
              throw new TiledMcpError(
                "CHECKPOINT_CHANGED",
                `Checkpoint ${expected.id} changed after manifest deletion inspection.`,
                {
                  checkpointId: expected.id,
                },
              );
            }
            const manifest = snapshot.manifest;
            if (
              manifest.status !==
              requiredStatus
            ) {
              throw new TiledMcpError(
                "CHECKPOINT_CHANGED",
                `Checkpoint ${expected.id} changed status after manifest deletion inspection.`,
                {
                  checkpointId: expected.id,
                },
              );
            }
            const deletableManifest =
              manifest as CheckpointManifest & {
                status: TStatus;
              };
            await validateBeforeDelete?.(
              deletableManifest,
            );

            await unlink(
              join(
                directories.checkpoints,
                `${expected.id}.json`,
              ),
            );
            deletedManifest = deletableManifest;

            try {
              await afterUnlinkBeforeDirectorySync?.(
                deletableManifest,
              );
              await syncDirectory(
                directories.checkpoints,
              );
              await this.observer
                ?.afterManifestDeletedBeforeGarbageCollection?.(
                  {
                    checkpointId:
                      manifest.id,
                  },
                );
              const inventory =
                await this.inventory(
                  directories,
                );
              const report =
                await this.sweepInventory(
                  directories,
                  inventory,
                );
              return {
                manifest:
                  deletableManifest,
                manifestDeleted: true,
                garbageCollection:
                  checkpointManifestDeletionGarbageCollectionResult(
                    report,
                  ),
              };
            } catch {
              return failedCheckpointManifestDeletionResult(
                deletableManifest,
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
        return failedCheckpointManifestDeletionResult(
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
        return failedCheckpointManifestDeletionResult(
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

  private async reserveNextRetentionOrdinal(
    directories: CheckpointStorageDirectories,
  ): Promise<number> {
    const sequencePath = join(
      dirname(directories.checkpoints),
      CHECKPOINT_RETENTION_SEQUENCE_FILE,
    );
    await removeRetentionSequenceTemporary(
      sequencePath,
    );
    const inventory =
      await this.inventory(directories);
    if (inventory.blockers.length > 0) {
      throw new TiledMcpError(
        "CHECKPOINT_CORRUPT",
        "Automatic checkpoint retention cannot allocate an ordinal from incomplete storage state.",
      );
    }
    const sequence =
      await this.readRetentionSequence(
        directories,
      );
    const analysis =
      analyzeRetentionSequence(
        inventory.manifests,
        sequence,
      );
    if (!analysis.valid) {
      throw new TiledMcpError(
        "CHECKPOINT_CORRUPT",
        "Automatic checkpoint retention sequence state is ambiguous or unsafe.",
      );
    }
    const lastOrdinal =
      sequence?.lastOrdinal ?? 0;
    if (
      lastOrdinal >=
      Number.MAX_SAFE_INTEGER
    ) {
      throw new TiledMcpError(
        "CHECKPOINT_CORRUPT",
        "Automatic checkpoint retention ordinal space is exhausted.",
      );
    }
    const nextOrdinal = lastOrdinal + 1;
    const nextSequence: CheckpointRetentionSequence =
      {
        version: 1,
        lastOrdinal: nextOrdinal,
      };
    if (sequence === undefined) {
      await atomicCreateRetentionSequence(
        sequencePath,
        nextSequence,
      );
    } else {
      await atomicWriteRetentionSequence(
        sequencePath,
        nextSequence,
      );
    }
    return nextOrdinal;
  }

  private async readRetentionSequence(
    directories: CheckpointStorageDirectories,
  ): Promise<
    CheckpointRetentionSequence | undefined
  > {
    const path = join(
      dirname(directories.checkpoints),
      CHECKPOINT_RETENTION_SEQUENCE_FILE,
    );
    let content: Buffer;
    try {
      content = await readBoundedNoFollow(
        path,
        CHECKPOINT_RETENTION_SEQUENCE_MAX_BYTES,
        "checkpoint retention sequence",
      );
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
    const raw = decodeUtf8Strict(
      content,
      "checkpoint retention sequence",
    );
    let value: unknown;
    try {
      value = parseJsonDocument(
        raw,
        `.tiledmcp/${CHECKPOINT_RETENTION_SEQUENCE_FILE}`,
      );
    } catch {
      throw new TiledMcpError(
        "CHECKPOINT_CORRUPT",
        "Checkpoint retention sequence is not valid safe JSON.",
      );
    }
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        "lastOrdinal",
        "version",
      ]) ||
      value.version !== 1 ||
      typeof value.lastOrdinal !==
        "number" ||
      !Number.isSafeInteger(
        value.lastOrdinal,
      ) ||
      value.lastOrdinal < 1
    ) {
      throw new TiledMcpError(
        "CHECKPOINT_CORRUPT",
        "Checkpoint retention sequence has an invalid record.",
      );
    }
    return value as unknown as CheckpointRetentionSequence;
  }

  private async verifyInventoryObjects(
    directories: CheckpointStorageDirectories,
    inventory: CheckpointStorageInventory,
  ): Promise<boolean> {
    const expectedSizes = new Map<
      string,
      number
    >();
    for (const { manifest } of inventory.manifests) {
      if (!manifest.before.existed) {
        continue;
      }
      const prior = expectedSizes.get(
        manifest.before.objectHash,
      );
      if (
        prior !== undefined &&
        prior !== manifest.before.size
      ) {
        return false;
      }
      expectedSizes.set(
        manifest.before.objectHash,
        manifest.before.size,
      );
    }
    try {
      for (const [
        objectHash,
        expectedSize,
      ] of expectedSizes) {
        const content =
          await readBoundedNoFollow(
            join(
              directories.objects,
              objectHash,
            ),
            MAX_CHECKPOINT_OBJECT_BYTES,
            "checkpoint retention root object",
          );
        if (
          content.byteLength !==
            expectedSize ||
          createHash("sha256")
            .update(content)
            .digest("hex") !== objectHash
        ) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private async retentionCandidateMatches(
    directories: CheckpointStorageDirectories,
    candidate: CheckpointInventoryManifest & {
      manifest: RollingCommittedCheckpointManifest;
    },
  ): Promise<boolean> {
    const path = join(
      directories.checkpoints,
      `${candidate.manifest.id}.json`,
    );
    try {
      const before = await lstat(path, {
        bigint: true,
      });
      if (
        !sameFileSnapshot(
          candidate.metadata,
          before,
        )
      ) {
        return false;
      }
      const actual =
        await this.readManifestSnapshot(
          directories.checkpoints,
          candidate.manifest.id,
        );
      const after = await lstat(path, {
        bigint: true,
      });
      return (
        sameFileSnapshot(before, after) &&
        actual.manifestRevision ===
          candidate.manifestRevision &&
        actual.manifestSize ===
          candidate.manifestSize &&
        actual.manifest.status ===
          "committed" &&
        isRollingManifest(
          actual.manifest,
        ) &&
        sameManifestIntent(
          candidate.manifest,
          actual.manifest,
        )
      );
    } catch {
      return false;
    }
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
      manifests: [],
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
      async (
        entry,
        entryPath,
        size,
        metadata,
      ) => {
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
        let snapshot: CheckpointManifestSnapshot;
        try {
          snapshot =
            await this.readManifestSnapshot(
            checkpointsDirectory,
            id,
          );
          const afterReadMetadata =
            await lstat(entryPath, {
              bigint: true,
            });
          if (
            !sameFileSnapshot(
              metadata,
              afterReadMetadata,
            ) ||
            snapshot.manifestSize !== size
          ) {
            throw new TiledMcpError(
              "CHECKPOINT_CORRUPT",
              `Checkpoint ${id} changed while storage inventory was being captured.`,
              { checkpointId: id },
            );
          }
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
        const manifest = snapshot.manifest;
        inventory.manifests.push({
          ...snapshot,
          metadata,
        });
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

interface CheckpointRetentionSequence {
  version: 1;
  lastOrdinal: number;
}

function isRollingManifest(
  manifest: CheckpointManifest,
): manifest is RollingCheckpointManifest {
  return (
    manifest.version === 2 &&
    manifest.retention?.class ===
      "rolling"
  );
}

function rollingCommittedManifestsForPath(
  manifests: readonly CheckpointInventoryManifest[],
  path: string,
): Array<
  CheckpointInventoryManifest & {
    manifest: RollingCommittedCheckpointManifest;
  }
> {
  const rolling = manifests.filter(
    (
      snapshot,
    ): snapshot is CheckpointInventoryManifest & {
      manifest: RollingCommittedCheckpointManifest;
    } =>
      snapshot.manifest.path === path &&
      snapshot.manifest.status ===
        "committed" &&
      isRollingManifest(snapshot.manifest),
  );
  rolling.sort(
    (left, right) =>
      left.manifest.retention.ordinal -
      right.manifest.retention.ordinal,
  );
  return rolling;
}

function analyzeRetentionSequence(
  manifests: readonly CheckpointInventoryManifest[],
  sequence:
    | CheckpointRetentionSequence
    | undefined,
): { valid: boolean } {
  const seen = new Set<number>();
  let maximum = 0;
  for (const { manifest } of manifests) {
    if (!isRollingManifest(manifest)) {
      continue;
    }
    const ordinal =
      manifest.retention.ordinal;
    if (seen.has(ordinal)) {
      return { valid: false };
    }
    seen.add(ordinal);
    maximum = Math.max(maximum, ordinal);
  }
  if (sequence === undefined) {
    return { valid: seen.size === 0 };
  }
  return {
    valid:
      sequence.lastOrdinal <
        Number.MAX_SAFE_INTEGER &&
      maximum <= sequence.lastOrdinal,
  };
}

function isSafeRollingDeletionCandidate(
  manifest: CheckpointManifest,
): manifest is RollingCommittedCheckpointManifest {
  return (
    manifest.status === "committed" &&
    isRollingManifest(manifest) &&
    manifest.before.existed &&
    manifest.before.revision !==
      manifest.afterRevision
  );
}

function hasSafeRollingLineage(
  manifests: ReadonlyArray<
    CheckpointInventoryManifest & {
      manifest: RollingCommittedCheckpointManifest;
    }
  >,
): boolean {
  // Every recovery point is independently rooted by its own before object.
  // A gap can be legitimate after an approved explicit prune, a failed
  // prepare that consumed an ordinal, or a protected/legacy checkpoint while
  // retention was disabled. Never infer adjacency from revisions: an A→B→A
  // byte cycle is valid, and explicit prune intentionally leaves no
  // tombstone. Eligibility therefore requires each live rolling manifest to
  // be an existing-file, non-no-op recovery point, while ordinal uniqueness
  // and the current highest checkpoint are validated separately.
  return manifests.every(({ manifest }) =>
    isSafeRollingDeletionCandidate(
      manifest,
    ),
  );
}

interface CheckpointManifestDeletionStorageExpectation<
  TStatus extends CheckpointManifest["status"],
> {
  id: string;
  createdAt: string;
  label?: string;
  path: string;
  status: TStatus;
  before: CheckpointManifest["before"];
  afterRevision: string;
  manifestRevision: string;
  manifestSize: number;
}

interface CheckpointManifestDeletionStorageResult<
  TStatus extends CheckpointManifest["status"],
> {
  manifest: CheckpointManifest & {
    status: TStatus;
  };
  manifestDeleted: true;
  garbageCollection:
    CheckpointManifestDeletionGarbageCollectionResult;
}

function canonicalCheckpointBatchIds(
  checkpointIds: readonly string[],
): string[] {
  if (
    !Array.isArray(checkpointIds) ||
    checkpointIds.length <
      MIN_CHECKPOINT_BATCH_PRUNE_COUNT ||
    checkpointIds.length >
      MAX_CHECKPOINT_BATCH_PRUNE_COUNT
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `Checkpoint batch prune requires from ${MIN_CHECKPOINT_BATCH_PRUNE_COUNT} through ${MAX_CHECKPOINT_BATCH_PRUNE_COUNT} checkpoint ids.`,
      {
        minimum:
          MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
        maximum:
          MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
      },
    );
  }
  const unique = new Set<string>();
  for (const id of checkpointIds) {
    if (
      typeof id !== "string" ||
      !CHECKPOINT_ID_PATTERN.test(id) ||
      id !== id.toLowerCase()
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "Checkpoint batch prune ids must be canonical lowercase UUIDs.",
      );
    }
    if (unique.has(id)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `Checkpoint batch prune contains duplicate id ${id}.`,
        { checkpointId: id },
      );
    }
    unique.add(id);
  }
  return [...unique].sort(compareCanonicalText);
}

function canonicalCheckpointBatchExpectations(
  expectations: readonly CheckpointBatchPruneStorageExpectation[],
): CheckpointBatchPruneStorageExpectation[] {
  const orderedIds =
    canonicalCheckpointBatchIds(
      expectations.map(({ id }) => id),
    );
  const byId = new Map(
    expectations.map((expected) => [
      expected.id,
      expected,
    ]),
  );
  return orderedIds.map((id) => {
    const expected =
      byId.get(id) as CheckpointBatchPruneStorageExpectation;
    if (
      expected.status !== "committed" ||
      typeof expected.path !==
        "string" ||
      typeof expected.createdAt !==
        "string" ||
      (expected.label !== undefined &&
        typeof expected.label !==
          "string") ||
      !REVISION_PATTERN.test(
        expected.afterRevision,
      ) ||
      !REVISION_PATTERN.test(
        expected.manifestRevision,
      ) ||
      !Number.isSafeInteger(
        expected.manifestSize,
      ) ||
      expected.manifestSize < 1 ||
      !validCheckpointBatchRetention(
        expected,
      )
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `Checkpoint ${id} has an invalid batch prune expectation.`,
        { checkpointId: id },
      );
    }
    const {
      retention,
      ...withoutRetention
    } = expected;
    return {
      ...withoutRetention,
      before: expected.before.existed
        ? { ...expected.before }
        : { existed: false },
      ...(retention === undefined
        ? {}
        : {
            retention: {
              ...retention,
            },
          }),
    };
  });
}

function validCheckpointBatchRetention(
  expected: CheckpointBatchPruneStorageExpectation,
): boolean {
  if (expected.version === 1) {
    return (
      expected.retention === undefined
    );
  }
  if (
    expected.version !== 2 ||
    expected.retention === undefined
  ) {
    return false;
  }
  if (
    expected.retention.class ===
    "protected"
  ) {
    return true;
  }
  return (
    expected.retention.class ===
      "rolling" &&
    Number.isSafeInteger(
      expected.retention.ordinal,
    ) &&
    expected.retention.ordinal > 0
  );
}

function sameCheckpointBatchPruneExpectation(
  expected: CheckpointBatchPruneStorageExpectation,
  actual: CheckpointManifestSnapshot,
): boolean {
  return (
    sameCheckpointManifestDeletionExpectation(
      expected,
      actual,
    ) &&
    expected.version ===
      actual.manifest.version &&
    sameCheckpointBatchRetention(
      expected,
      actual.manifest,
    )
  );
}

function sameCheckpointBatchRetention(
  expected: CheckpointBatchPruneStorageExpectation,
  actual: CheckpointManifest,
): boolean {
  if (expected.version === 1) {
    return (
      actual.version === 1 &&
      actual.retention === undefined
    );
  }
  if (
    actual.version !== 2 ||
    expected.retention === undefined ||
    actual.retention === undefined ||
    expected.retention.class !==
      actual.retention.class
  ) {
    return false;
  }
  return (
    expected.retention.class ===
      "protected" ||
    (actual.retention.class ===
      "rolling" &&
      expected.retention.ordinal ===
        actual.retention.ordinal)
  );
}

function compareCanonicalText(
  left: string,
  right: string,
): number {
  return left < right
    ? -1
    : left > right
      ? 1
      : 0;
}

function addCheckpointBatchPruneWarning(
  result: CheckpointBatchPruneStorageResult,
  warning: string,
): CheckpointBatchPruneStorageResult {
  if (result.warnings?.includes(warning)) {
    return result;
  }
  return {
    ...result,
    warnings: [
      ...(result.warnings ?? []),
      warning,
    ],
  };
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

function sameCheckpointManifestDeletionExpectation<
  TStatus extends CheckpointManifest["status"],
>(
  expected: CheckpointManifestDeletionStorageExpectation<TStatus>,
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

function assertPreparedCheckpointAdjudicationStorageExpectation(
  expected: PreparedCheckpointAdjudicationStorageExpectation,
): void {
  assertCheckpointId(expected.id);
  const validTarget =
    expected.target.existed === false ||
    (expected.target.existed === true &&
      REVISION_PATTERN.test(
        expected.target.revision,
      ) &&
      Number.isSafeInteger(
        expected.target.size,
      ) &&
      expected.target.size >= 0);
  const validBefore =
    expected.before.existed === false ||
    (expected.before.existed === true &&
      REVISION_PATTERN.test(
        expected.before.revision,
      ) &&
      OBJECT_HASH_PATTERN.test(
        expected.before.objectHash,
      ) &&
      expected.before.revision ===
        `sha256:${expected.before.objectHash}` &&
      Number.isSafeInteger(
        expected.before.size,
      ) &&
      expected.before.size >= 0 &&
      expected.before.size <=
        MAX_CHECKPOINT_OBJECT_BYTES);
  if (
    expected.status !== "prepared" ||
    typeof expected.createdAt !== "string" ||
    expected.createdAt.length >
      MAX_CHECKPOINT_TIMESTAMP_LENGTH ||
    !Number.isFinite(
      Date.parse(expected.createdAt),
    ) ||
    (expected.label !== undefined &&
      (typeof expected.label !== "string" ||
        expected.label.length >
          MAX_CHECKPOINT_LABEL_LENGTH)) ||
    typeof expected.path !== "string" ||
    !REVISION_PATTERN.test(
      expected.afterRevision,
    ) ||
    !REVISION_PATTERN.test(
      expected.manifestRevision,
    ) ||
    !Number.isSafeInteger(
      expected.manifestSize,
    ) ||
    expected.manifestSize < 1 ||
    !validBefore ||
    !validTarget ||
    !validPreparedCheckpointAdjudicationRetention(
      expected,
    ) ||
    !validPreparedCheckpointAdjudicationConflict(
      expected,
    )
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "Prepared checkpoint adjudication expectation is invalid.",
      { checkpointId: expected.id },
    );
  }
}

function validPreparedCheckpointAdjudicationRetention(
  expected: PreparedCheckpointAdjudicationStorageExpectation,
): boolean {
  if (expected.version === 1) {
    return expected.retention === undefined;
  }
  if (
    expected.version !== 2 ||
    expected.retention === undefined
  ) {
    return false;
  }
  return (
    expected.retention.class ===
      "protected" ||
    (expected.retention.class ===
      "rolling" &&
      Number.isSafeInteger(
        expected.retention.ordinal,
      ) &&
      expected.retention.ordinal > 0)
  );
}

function validPreparedCheckpointAdjudicationConflict(
  expected: PreparedCheckpointAdjudicationStorageExpectation,
): boolean {
  const { before, target } = expected;
  switch (expected.conflict) {
    case "create-target-matches-after":
      return (
        !before.existed &&
        target.existed &&
        target.revision ===
          expected.afterRevision
      );
    case "create-target-unrelated":
      return (
        !before.existed &&
        target.existed &&
        target.revision !==
          expected.afterRevision
      );
    case "existing-target-missing":
      return before.existed && !target.existed;
    case "existing-target-unrelated":
      return (
        before.existed &&
        target.existed &&
        target.revision !==
          before.revision &&
        target.revision !==
          expected.afterRevision
      );
    default:
      return false;
  }
}

function samePreparedCheckpointAdjudicationExpectation(
  expected: PreparedCheckpointAdjudicationStorageExpectation,
  actual: CheckpointManifestSnapshot,
): boolean {
  return (
    expected.manifestRevision ===
      actual.manifestRevision &&
    expected.manifestSize ===
      actual.manifestSize &&
    samePreparedCheckpointAdjudicationManifest(
      expected,
      actual.manifest,
    )
  );
}

function samePreparedCheckpointAdjudicationManifest(
  expected: PreparedCheckpointAdjudicationStorageExpectation,
  actual: CheckpointManifest,
): boolean {
  const expectedManifest =
    preparedCheckpointAdjudicationExpectedManifest(
      expected,
    );
  return (
    actual.status === "prepared" &&
    sameManifestIntent(
      expectedManifest,
      actual,
    )
  );
}

function preparedCheckpointAdjudicationExpectedManifest(
  expected: PreparedCheckpointAdjudicationStorageExpectation,
): CheckpointManifest {
  const base = {
    id: expected.id,
    createdAt: expected.createdAt,
    label: expected.label ?? "",
    path: expected.path,
    status: "prepared" as const,
    before: expected.before.existed
      ? { ...expected.before }
      : { existed: false as const },
    afterRevision: expected.afterRevision,
  };
  if (expected.version === 1) {
    return {
      version: 1,
      ...base,
    };
  }
  const retention = expected.retention;
  if (retention === undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "Version 2 prepared checkpoint adjudication requires retention metadata.",
      { checkpointId: expected.id },
    );
  }
  return {
    version: 2,
    ...base,
    retention:
      retention.class === "protected"
        ? { class: "protected" }
        : {
            class: "rolling",
            ordinal: retention.ordinal,
          },
  };
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
    metadata: BigIntStats,
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
        entryStat,
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

const CHECKPOINT_MANIFEST_DELETION_BLOCKER_SAMPLE_LIMIT =
  32;

function checkpointManifestDeletionGarbageCollectionResult(
  report: CheckpointGarbageCollectionReport,
): CheckpointManifestDeletionGarbageCollectionResult {
  if (report.blocked) {
    const blockers = report.blockers
      .slice(
        0,
        CHECKPOINT_MANIFEST_DELETION_BLOCKER_SAMPLE_LIMIT,
      )
      .map(
        sanitizeCheckpointManifestDeletionBlocker,
      );
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

function sanitizeCheckpointManifestDeletionBlocker(
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

function failedCheckpointManifestDeletionResult<
  TStatus extends CheckpointManifest["status"],
>(
  manifest: CheckpointManifest & {
    status: TStatus;
  },
): CheckpointManifestDeletionStorageResult<TStatus> {
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

async function atomicWriteJson(
  path: string,
  value: CheckpointManifest,
  afterInstalledBeforeDirectorySync?: () =>
    void | Promise<void>,
): Promise<void> {
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
    await afterInstalledBeforeDirectorySync?.();
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

async function atomicCreateRetentionSequence(
  path: string,
  value: CheckpointRetentionSequence,
): Promise<void> {
  const temporaryPath =
    retentionSequenceTemporaryPath(path);
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
      serializeRetentionSequence(value),
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
          "CHECKPOINT_CORRUPT",
          "Checkpoint retention sequence appeared while its initial state was being published.",
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

async function atomicWriteRetentionSequence(
  path: string,
  value: CheckpointRetentionSequence,
): Promise<void> {
  const temporaryPath =
    retentionSequenceTemporaryPath(path);
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
      serializeRetentionSequence(value),
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

function serializeRetentionSequence(
  value: CheckpointRetentionSequence,
): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function retentionSequenceTemporaryPath(
  path: string,
): string {
  return `${path}.tmp`;
}

async function removeRetentionSequenceTemporary(
  path: string,
): Promise<void> {
  const temporaryPath =
    retentionSequenceTemporaryPath(path);
  let metadata: BigIntStats;
  try {
    metadata = await lstat(temporaryPath, {
      bigint: true,
    });
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (!metadata.isFile()) {
    throw new TiledMcpError(
      "CHECKPOINT_CORRUPT",
      "Checkpoint retention sequence temporary state is not a regular file.",
    );
  }
  await unlink(temporaryPath);
  await syncDirectory(dirname(path));
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
  const commonKeys = [
    "afterRevision",
    "before",
    "createdAt",
    "id",
    "label",
    "path",
    "status",
    "version",
  ];
  const validVersionShape =
    (value.version === 1 &&
      hasExactKeys(value, commonKeys)) ||
    (value.version === 2 &&
      hasExactKeys(value, [
        ...commonKeys,
        "retention",
      ]) &&
      isRecord(value.retention) &&
      ((value.retention.class ===
        "protected" &&
        hasExactKeys(value.retention, [
          "class",
        ])) ||
        (value.retention.class ===
          "rolling" &&
          hasExactKeys(value.retention, [
            "class",
            "ordinal",
          ]) &&
          typeof value.retention.ordinal ===
            "number" &&
          Number.isSafeInteger(
            value.retention.ordinal,
          ) &&
          value.retention.ordinal > 0)));
  if (
    !validVersionShape ||
    value.id !== expectedId ||
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
    expected.before.existed !== actual.before.existed ||
    !sameManifestRetention(
      expected,
      actual,
    )
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

function sameManifestRetention(
  expected: CheckpointManifest,
  actual: CheckpointManifest,
): boolean {
  if (
    expected.version !== actual.version
  ) {
    return false;
  }
  if (
    expected.version === 1 ||
    actual.version === 1
  ) {
    return (
      expected.version === 1 &&
      actual.version === 1
    );
  }
  const expectedRetention =
    expected.retention;
  const actualRetention =
    actual.retention;
  if (
    expectedRetention === undefined ||
    actualRetention === undefined ||
    expectedRetention.class !==
      actualRetention.class
  ) {
    return false;
  }
  return (
    expectedRetention.class ===
      "protected" ||
    (actualRetention.class ===
      "rolling" &&
      expectedRetention.ordinal ===
        actualRetention.ordinal)
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
