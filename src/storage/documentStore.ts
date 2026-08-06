import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { TiledMcpError, asTiledMcpError } from "../errors.js";
import {
  parseJsonDocument,
  serializeJsonDocument,
  type JsonObject,
} from "../formats/json.js";
import type { ProjectPathResolver } from "../project/pathResolver.js";
import {
  CHECKPOINT_ID_PATTERN,
  CheckpointStore,
  MAX_CHECKPOINT_BATCH_PRUNE_COUNT,
  MIN_CHECKPOINT_BATCH_PRUNE_COUNT,
  ROLLING_CHECKPOINT_RETENTION_POLICY,
  type CheckpointBatchPruneStorageExpectation,
  type CheckpointBatchPruneStorageResult,
  type CheckpointManifest,
  type CheckpointManifestSnapshot,
  type CheckpointPruneGarbageCollectionResult,
  type CheckpointPruneStorageExpectation,
  type CheckpointPruneStorageResult,
  type CheckpointStoreOptions,
  type CorruptCheckpointEntry,
  type PreparedCheckpointAbandonStorageResult,
  type PreparedCheckpointAdjudicationConflict as PreparedCheckpointAdjudicationStorageConflict,
  type PreparedCheckpointAdjudicationStorageExpectation,
  type PreparedCheckpointAdjudicationTarget as PreparedCheckpointAdjudicationStorageTarget,
  type PreparedCheckpointCommitStorageResult,
  type PreparedCheckpointDiscardStorageExpectation,
  type PreparedCheckpointDiscardStorageResult,
  type RollingCheckpointRetentionResult,
  type RollingCommittedCheckpointManifest,
} from "./checkpoints.js";
import { withProjectFileLock } from "./fileLock.js";
import {
  fileIdentityOf,
  sameFileSnapshot,
  type FileIdentity,
} from "./fileIdentity.js";
import { KeyedMutex } from "./keyedMutex.js";
import { revisionOf, type Revision } from "./revision.js";
import {
  MAX_TRANSACTION_LABEL_LENGTH,
  MAX_TRANSACTION_STAGED_BYTES,
  MAX_TRANSACTION_TARGETS,
  MIN_TRANSACTION_TARGETS,
  parseTransactionManifest,
  serializeTransactionManifest,
  TRANSACTION_STAGED_DIRECTORY,
  TRANSACTIONS_DIRECTORY,
  type TransactionCommitResult,
  type TransactionManifest,
  type TransactionManifestEntry,
  type TransactionTargetInput,
  type TransactionTargetResult,
  type TransactionRecoveryReport,
} from "./transactions.js";

const DEFAULT_MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const CHECKPOINT_MANIFEST_REVISION_PATTERN =
  /^sha256:[0-9a-f]{64}$/u;
const CHECKPOINT_PRUNE_GC_BLOCKED_WARNING =
  "The checkpoint manifest was deleted, but garbage collection was blocked; unreferenced checkpoint storage was retained.";
const CHECKPOINT_PRUNE_GC_FAILED_WARNING =
  "The checkpoint manifest was unlinked, but post-delete durability or garbage collection could not be confirmed; unreferenced checkpoint storage may remain.";
const CHECKPOINT_PRUNE_TARGET_LOCK_WARNING =
  "Checkpoint pruning completed, but release of its target lock could not be confirmed; inspect the project lock before retrying mutations.";
export const CHECKPOINT_BATCH_PRUNE_TARGET_LOCK_WARNING =
  "Checkpoint batch pruning deleted one or more manifests, but release of one or more target locks could not be confirmed; inspect project locks before retrying mutations.";
const PREPARED_CHECKPOINT_DISCARD_GC_BLOCKED_WARNING =
  "The prepared checkpoint manifest was deleted, but garbage collection was blocked; unreferenced checkpoint storage was retained.";
const PREPARED_CHECKPOINT_DISCARD_GC_FAILED_WARNING =
  "The prepared checkpoint manifest was unlinked, but post-delete durability or garbage collection could not be confirmed; unreferenced checkpoint storage may remain.";
const PREPARED_CHECKPOINT_DISCARD_TARGET_LOCK_WARNING =
  "Prepared checkpoint discard completed, but release of its target lock could not be confirmed; inspect the project lock before retrying mutations.";
const PREPARED_CHECKPOINT_COMMIT_DURABILITY_WARNING =
  "The prepared checkpoint manifest was committed, but post-rename durability could not be confirmed; inspect checkpoint state before further recovery operations.";
const PREPARED_CHECKPOINT_COMMIT_TARGET_LOCK_WARNING =
  "Prepared checkpoint commit completed, but release of its target lock could not be confirmed; inspect the project lock before retrying mutations.";
const PREPARED_CHECKPOINT_ABANDON_GC_BLOCKED_WARNING =
  "The ambiguous prepared checkpoint manifest was deleted, but garbage collection was blocked; unreferenced checkpoint storage was retained.";
const PREPARED_CHECKPOINT_ABANDON_GC_FAILED_WARNING =
  "The ambiguous prepared checkpoint manifest was unlinked, but post-delete durability or garbage collection could not be confirmed; unreferenced checkpoint storage may remain.";
const PREPARED_CHECKPOINT_ABANDON_TARGET_LOCK_WARNING =
  "Prepared checkpoint abandon completed, but release of its target lock could not be confirmed; inspect the project lock before retrying mutations.";
const CHECKPOINT_RETENTION_BLOCKED_WARNING =
  "The document was committed, but automatic checkpoint retention was blocked; older rolling recovery checkpoints were retained.";
const CHECKPOINT_RETENTION_FAILED_WARNING =
  "The document was committed, but automatic checkpoint retention could not be completed; older rolling recovery checkpoints may remain.";
const CHECKPOINT_RETENTION_GC_BLOCKED_WARNING =
  "Automatic checkpoint retention removed an older recovery checkpoint, but garbage collection was blocked; unreferenced checkpoint storage was retained.";
const CHECKPOINT_RETENTION_GC_FAILED_WARNING =
  "Automatic checkpoint retention unlinked an older recovery checkpoint, but post-delete durability or garbage collection could not be confirmed; unreferenced checkpoint storage may remain.";

export interface DocumentSnapshot {
  path: string;
  revision: string;
  source: Buffer;
  size: number;
  identity: FileIdentity;
}

export interface LoadedDocument extends DocumentSnapshot {
  document: JsonObject;
}

export interface DocumentReadObserver {
  afterChunk?(progress: {
    projectPath: string;
    chunkCount: number;
    totalBytes: number;
  }): void | Promise<void>;
}

/**
 * Optional deterministic fault-injection seam for storage tests.
 */
export interface DocumentWriteObserver {
  afterTemporaryFileOpened?(progress: {
    projectPath: string;
  }): void | Promise<void>;
}

export interface CommitResult {
  path: string;
  beforeRevision: string | null;
  revision: string;
  checkpointId: string | null;
  changed: boolean;
  checkpointRetention?: CheckpointRetentionResult;
  warnings?: string[];
}

/**
 * A server-owned directory under `.tiledmcp`.
 *
 * The template literal is the guard: it makes passing a project-relative path
 * such as `"maps"` a compile error, so the un-checkpointed write path cannot
 * be aimed at a user's document by a typo or a refactor.
 */
export type InternalDirectory =
  | ".tiledmcp"
  | `.tiledmcp/${string}`;

/**
 * Result of replacing a server-owned `.tiledmcp` file. Deliberately narrower
 * than {@link CommitResult}: internal files are never checkpointed, so there
 * is no `checkpointId` to report.
 */
export interface InternalFileCommitResult {
  path: string;
  beforeRevision: string | null;
  revision: string;
}

export interface FileDeleteStoreResult {
  kind: "fileDelete";
  path: string;
  beforeRevision: string;
  /**
   * The committed pre-delete checkpoint; restoring it recreates the deleted
   * file with its exact former bytes.
   */
  checkpointId: string;
  deleted: true;
  warnings?: string[];
}

export type CheckpointRetentionResult =
  | RollingCheckpointRetentionResult
  | {
      policy:
        typeof ROLLING_CHECKPOINT_RETENTION_POLICY;
      retainCommittedPerTarget: number;
      status: "failed";
      manifestDeleted: false;
      failureCode: "INTERNAL_ERROR";
    };

interface CheckpointFinalizationResult {
  committed?: CheckpointManifest & {
    status: "committed";
  };
  warnings: string[];
}

export interface CheckpointRestoreExpectation {
  id: string;
  createdAt: string;
  label: string;
  path: string;
  status: "prepared" | "committed";
  afterRevision: string;
  before: {
    revision: string;
    objectHash: string;
    size: number;
  };
}

export interface CheckpointRestoreInspection {
  checkpoint: CheckpointRestoreExpectation;
  /**
   * `null` when the target file is missing: the restore recreates it and
   * `expectedRevision` pins the restored content itself.
   */
  currentRevision: string | null;
  restoreRevision: string;
  restoreSize: number;
  changed: boolean;
}

export interface CheckpointPruneExpectation {
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

export interface CheckpointPruneInspection {
  checkpoint: CheckpointPruneExpectation;
}

export type CheckpointPruneGarbageCollection =
  CheckpointPruneGarbageCollectionResult;

export interface CheckpointPruneResult {
  kind: "checkpointPrune";
  checkpoint: {
    id: string;
    createdAt: string;
    label?: string;
    path: string;
    status: "committed";
    before: CheckpointManifest["before"];
    afterRevision: string;
  };
  manifestDeleted: true;
  garbageCollection:
    CheckpointPruneGarbageCollection;
  warnings?: string[];
}

export interface CheckpointBatchPruneExpectation
  extends CheckpointBatchPruneStorageExpectation {}

export interface CheckpointBatchPruneInspection {
  kind: "checkpointPruneBatch";
  checkpoints:
    CheckpointBatchPruneExpectation[];
}

export type CheckpointBatchPruneResult =
  CheckpointBatchPruneStorageResult;

export type PreparedCheckpointDiscardTarget =
  | { existed: false }
  | {
      existed: true;
      revision: string;
      size: number;
    };

export interface PreparedCheckpointDiscardExpectation {
  id: string;
  createdAt: string;
  label?: string;
  path: string;
  status: "prepared";
  before: CheckpointManifest["before"];
  afterRevision: string;
  manifestRevision: string;
  manifestSize: number;
  target: PreparedCheckpointDiscardTarget;
}

export interface PreparedCheckpointDiscardInspection {
  checkpoint: PreparedCheckpointDiscardExpectation;
}

export interface PreparedCheckpointDiscardResult {
  kind: "preparedCheckpointDiscard";
  checkpoint: {
    id: string;
    createdAt: string;
    label?: string;
    path: string;
    status: "prepared";
    before: CheckpointManifest["before"];
    afterRevision: string;
  };
  target: PreparedCheckpointDiscardTarget;
  manifestDeleted: true;
  garbageCollection:
    CheckpointPruneGarbageCollection;
  warnings?: string[];
}

export type PreparedCheckpointAdjudicationTarget =
  PreparedCheckpointAdjudicationStorageTarget;

export type PreparedCheckpointAdjudicationConflict =
  PreparedCheckpointAdjudicationStorageConflict;

export type PreparedCheckpointAdjudicationExpectation =
  PreparedCheckpointAdjudicationStorageExpectation;

export interface PreparedCheckpointCommitInspection {
  checkpoint:
    PreparedCheckpointAdjudicationExpectation;
}

export interface PreparedCheckpointAbandonInspection {
  checkpoint:
    PreparedCheckpointAdjudicationExpectation;
}

interface PreparedCheckpointAdjudicationResultCheckpoint {
  version: CheckpointManifest["version"];
  retention?: CheckpointManifest["retention"];
  id: string;
  createdAt: string;
  label?: string;
  path: string;
  status: "prepared" | "committed";
  before: CheckpointManifest["before"];
  afterRevision: string;
}

export interface PreparedCheckpointCommitResult {
  kind: "preparedCheckpointCommit";
  checkpoint:
    PreparedCheckpointAdjudicationResultCheckpoint & {
      status: "committed";
    };
  previousStatus: "prepared";
  target: PreparedCheckpointAdjudicationTarget;
  conflict: "create-target-matches-after";
  manifestCommitted: true;
  projectAssetModified: false;
  durability: "confirmed" | "unconfirmed";
  warnings?: string[];
}

export interface PreparedCheckpointAbandonResult {
  kind: "preparedCheckpointAbandon";
  checkpoint:
    PreparedCheckpointAdjudicationResultCheckpoint & {
      status: "prepared";
    };
  target: PreparedCheckpointAdjudicationTarget;
  conflict: PreparedCheckpointAdjudicationConflict;
  manifestDeleted: true;
  projectAssetModified: false;
  garbageCollection:
    CheckpointPruneGarbageCollection;
  warnings?: string[];
}

export interface ReconcilePreparedCheckpointsOptions {
  limit?: number;
  scanLimit?: number;
}

export type CheckpointReconciliationOutcomeKind =
  | "reconciled"
  | "writeDidNotLand"
  | "conflict"
  | "error";

export interface CheckpointReconciliationOutcome {
  checkpointId: string;
  path: string;
  outcome: CheckpointReconciliationOutcomeKind;
  currentRevision: string | null;
  reason: string;
  errorCode?: string;
}

export interface CheckpointReconciliationReport {
  outcomes: CheckpointReconciliationOutcome[];
  corruptEntries: CorruptCheckpointEntry[];
  scannedEntries: number;
  truncated: boolean;
}

export class DocumentStore {
  private readonly mutex = new KeyedMutex();
  readonly checkpoints: CheckpointStore;

  constructor(
    private readonly resolver: ProjectPathResolver,
    private readonly maxDocumentBytes = DEFAULT_MAX_DOCUMENT_BYTES,
    private readonly writeObserver?: DocumentWriteObserver,
    checkpointOptions: CheckpointStoreOptions = {},
    private readonly transactionObserver?: {
      beforeStep?: (
        step: string,
      ) => Promise<void> | void;
    },
  ) {
    this.checkpoints = new CheckpointStore(
      resolver,
      checkpointOptions,
    );
  }

  async read(projectPath: string): Promise<LoadedDocument> {
    return this.parseSnapshot(await this.readSnapshot(projectPath));
  }

  async readSnapshot(projectPath: string): Promise<DocumentSnapshot> {
    const normalized = this.resolver.normalize(projectPath);
    const absolutePath = await this.resolver.resolveExisting(normalized);
    const snapshot =
      await readDocumentFileSnapshotWithIdentity(
        absolutePath,
        normalized,
        this.maxDocumentBytes,
      );
    const content = snapshot.bytes;
    return {
      path: normalized,
      revision: revisionOf(content),
      source: content,
      size: content.byteLength,
      identity: snapshot.identity,
    };
  }

  parseSnapshot(snapshot: DocumentSnapshot): LoadedDocument {
    return {
      ...snapshot,
      document: parseJsonDocument(
        decodeUtf8Strict(snapshot.source, snapshot.path),
        snapshot.path,
      ),
    };
  }

  /**
   * Creates committed checkpoints of the exact current bytes of the
   * given files, without modifying any project asset. Restoring such a
   * checkpoint reproduces the snapshotted state byte for byte.
   */
  async createExplicitCheckpoints(
    projectPaths: readonly string[],
    label: string,
  ): Promise<
    Array<{
      checkpointId: string;
      path: string;
      revision: string;
      size: number;
    }>
  > {
    const results: Array<{
      checkpointId: string;
      path: string;
      revision: string;
      size: number;
    }> = [];
    for (const projectPath of projectPaths) {
      const normalized =
        this.resolver.normalize(projectPath);
      await this.mutex.runExclusive(
        normalized,
        () =>
          withProjectFileLock(
            this.resolver,
            normalized,
            async () => {
              const snapshot =
                await this.readSnapshot(
                  normalized,
                );
              const manifest =
                await this.checkpoints.prepare(
                  normalized,
                  snapshot.source,
                  snapshot.revision,
                  label,
                );
              await this.checkpoints.markCommitted(
                manifest,
              );
              results.push({
                checkpointId: manifest.id,
                path: normalized,
                revision: snapshot.revision,
                size: snapshot.size,
              });
            },
          ),
      );
    }
    return results;
  }

  async create(
    projectPath: string,
    document: JsonObject,
    label = "create document",
  ): Promise<CommitResult> {
    return this.createBytes(
      projectPath,
      serializeJsonDocument(document),
      label,
    );
  }

  /**
   * No-replace creation of arbitrary file content (e.g. Tiled CLI export
   * products that are not JSON documents). Shares the exact checkpoint,
   * lock, and atomic-replace discipline of document creation.
   */
  async createBytes(
    projectPath: string,
    rawContent: string | Buffer,
    label = "create file",
  ): Promise<CommitResult> {
    const content = Buffer.isBuffer(rawContent)
      ? rawContent
      : Buffer.from(rawContent, "utf8");
    const normalized = this.resolver.normalize(projectPath);
    return this.mutex.runExclusive(normalized, () =>
      withProjectFileLock(this.resolver, normalized, async () => {
        const absolutePath = await this.resolver.resolveForCreate(normalized);
        try {
          await stat(absolutePath);
          throw new TiledMcpError(
            "FILE_ALREADY_EXISTS",
            `Refusing to overwrite existing file ${normalized}.`,
            { path: normalized },
          );
        } catch (error) {
          if (!hasCode(error, "ENOENT")) {
            throw error;
          }
        }

        this.assertSize(content, normalized);
        const afterRevision = revisionOf(content);
        const checkpoint = await this.checkpoints.prepare(
          normalized,
          undefined,
          afterRevision,
          label,
        );
        const warnings = await this.atomicReplaceConfirmed(
          absolutePath,
          content,
          undefined,
          normalized,
        );
        const finalization =
          await this.markCheckpointBestEffort(
            checkpoint,
          );
        warnings.push(
          ...finalization.warnings,
        );
        return {
          path: normalized,
          beforeRevision: null,
          revision: afterRevision,
          checkpointId: checkpoint.id,
          changed: true,
          ...(warnings.length === 0 ? {} : { warnings }),
        };
      }),
    );
  }

  async commit(
    projectPath: string,
    expectedRevision: string,
    document: JsonObject,
    label = "edit document",
  ): Promise<CommitResult> {
    const normalized = this.resolver.normalize(projectPath);
    const content = serializeJsonDocument(document);
    return this.commitContent(normalized, expectedRevision, content, label);
  }

  async commitBytes(
    projectPath: string,
    expectedRevision: string,
    proposedContent: Buffer,
    label = "edit document",
  ): Promise<CommitResult> {
    const normalized = this.resolver.normalize(projectPath);
    // Copy at the API boundary so a caller cannot mutate the bytes between
    // validation, revision calculation and the eventual write.
    const content = Buffer.from(proposedContent);
    this.assertSize(content, normalized);
    parseJsonDocument(decodeUtf8Strict(content, normalized), normalized);
    return this.commitContent(normalized, expectedRevision, content, label);
  }

  /**
   * Durably replace a server-owned file under `.tiledmcp`, holding the same
   * in-process mutex and cross-process lock that guard project documents.
   *
   * Internal files are bookkeeping rather than project assets, so they stay
   * outside the checkpoint system — there is no user document to restore, and
   * a checkpoint of the registry would be restored independently of the maps
   * it names. They still need the lock, the atomic rename and the fsync: a
   * torn write loses the whole registry, and a concurrent write loses an edit.
   */
  async commitInternalFile(
    internalDirectory: InternalDirectory,
    fileName: string,
    expectedRevision: Revision | null,
    proposedContent: Buffer,
  ): Promise<InternalFileCommitResult> {
    const content = Buffer.from(proposedContent);
    const target = `${internalDirectory}/${fileName}`;
    return this.mutex.runExclusive(target, () =>
      withProjectFileLock(
        this.resolver,
        target,
        async () => {
          const directory =
            await this.resolver.ensureInternalDirectory(
              internalDirectory,
            );
          const absolutePath = join(
            directory,
            fileName,
          );
          const actualRevision =
            await readInternalFileRevision(
              absolutePath,
            );
          if (actualRevision !== expectedRevision) {
            throw new TiledMcpError(
              "REVISION_CONFLICT",
              `${target} changed since the edit was planned.`,
              {
                path: target,
                expectedRevision,
                actualRevision,
              },
            );
          }
          await writeFileDurably(
            absolutePath,
            content,
          );
          return {
            path: target,
            beforeRevision: actualRevision,
            revision: revisionOf(content),
          };
        },
      ),
    );
  }

  async reconcilePreparedCheckpoints(
    options: ReconcilePreparedCheckpointsOptions = {},
  ): Promise<CheckpointReconciliationReport> {
    const listing = await this.checkpoints.list({
      ...options,
      status: "prepared",
    });
    const outcomes: CheckpointReconciliationOutcome[] = [];

    for (const manifest of listing.manifests) {
      try {
        const normalized =
          this.resolver.normalize(manifest.path);
        outcomes.push(
          await this.mutex.runExclusive(
            normalized,
            () =>
              withProjectFileLock(
                this.resolver,
                normalized,
                () =>
                  this.reconcilePreparedCheckpointLocked(
                    manifest,
                  ),
              ),
          ),
        );
      } catch (error) {
        const code = errorCode(error);
        outcomes.push(
          reconciliationOutcome(
            manifest,
            "error",
            null,
            `Checkpoint reconciliation failed in isolation (${code}).`,
            code,
          ),
        );
      }
    }

    return {
      outcomes,
      corruptEntries: listing.corruptEntries,
      scannedEntries: listing.scannedEntries,
      truncated: listing.truncated,
    };
  }

  private async reconcilePreparedCheckpointLocked(
    listedManifest: CheckpointManifest,
  ): Promise<CheckpointReconciliationOutcome> {
    let manifest: CheckpointManifest;
    try {
      manifest = (
        await this.checkpoints.inspectManifest(
          listedManifest.id,
        )
      ).manifest;
    } catch (error) {
      const code = errorCode(error);
      return reconciliationOutcome(
        listedManifest,
        "error",
        null,
        `The checkpoint manifest could not be authoritatively re-read while it was being reconciled (${code}).`,
        code,
      );
    }
    if (
      !sameCheckpointIntent(
        listedManifest,
        manifest,
      ) ||
      listedManifest.createdAt !==
        manifest.createdAt ||
      listedManifest.label !== manifest.label
    ) {
      return reconciliationOutcome(
        listedManifest,
        "error",
        null,
        "The checkpoint manifest changed while it was being reconciled.",
        "CHECKPOINT_CHANGED",
      );
    }
    if (manifest.status === "committed") {
      return reconciliationOutcome(
        manifest,
        "reconciled",
        null,
        "The checkpoint was committed by another reconciler.",
      );
    }

    let currentRevision: string;
    try {
      currentRevision = await this.readRevision(
        manifest.path,
      );
    } catch (error) {
      const code = errorCode(error);
      if (isMissingCode(code)) {
        return manifest.before.existed
          ? reconciliationOutcome(
              manifest,
              "conflict",
              null,
              "The target for an existing-file checkpoint is missing.",
              "CHECKPOINT_STATE_CONFLICT",
            )
          : reconciliationOutcome(
              manifest,
              "writeDidNotLand",
              null,
              "The create operation did not land; the target is still absent.",
            );
      }
      if (
        code === "SYMLINK_NOT_ALLOWED" ||
        code === "ELOOP"
      ) {
        return reconciliationOutcome(
          manifest,
          "conflict",
          null,
          "The target is now a symbolic link and was not followed.",
          "SYMLINK_NOT_ALLOWED",
        );
      }
      return reconciliationOutcome(
        manifest,
        "error",
        null,
        `The target could not be inspected safely (${code}).`,
        code,
      );
    }

    if (
      currentRevision ===
      manifest.afterRevision
    ) {
      if (!manifest.before.existed) {
        return reconciliationOutcome(
          manifest,
          "conflict",
          currentRevision,
          "The target matches a prepared create checkpoint, but hash equality cannot prove which writer created it.",
          "CHECKPOINT_STATE_CONFLICT",
        );
      }
      try {
        // The target lock remains held while markCommitted takes the
        // checkpoint-store lock and performs its own authoritative intent
        // check.
        await this.checkpoints.markCommitted(
          manifest,
        );
        return reconciliationOutcome(
          manifest,
          "reconciled",
          currentRevision,
          "The requested target bytes had landed; the manifest is now committed.",
        );
      } catch (error) {
        const code = errorCode(error);
        return reconciliationOutcome(
          manifest,
          "error",
          currentRevision,
          `The landed checkpoint could not be marked committed (${code}).`,
          code,
        );
      }
    }

    if (
      manifest.before.existed &&
      currentRevision ===
        manifest.before.revision
    ) {
      return reconciliationOutcome(
        manifest,
        "writeDidNotLand",
        currentRevision,
        "The target still has the exact pre-write revision.",
      );
    }

    return reconciliationOutcome(
      manifest,
      "conflict",
      currentRevision,
      "The target has a revision unrelated to this prepared checkpoint.",
      "CHECKPOINT_STATE_CONFLICT",
    );
  }

  async inspectCheckpointPrune(
    checkpointId: string,
  ): Promise<CheckpointPruneInspection> {
    const snapshot =
      await this.checkpoints.inspectPrune(
        checkpointId,
      );
    if (
      snapshot.manifest.status !==
      "committed"
    ) {
      throw new TiledMcpError(
        "CHECKPOINT_NOT_COMMITTED",
        `Checkpoint ${checkpointId} is still prepared and cannot be pruned.`,
        { checkpointId },
      );
    }
    return {
      checkpoint:
        checkpointPruneExpectation(snapshot),
    };
  }

  async pruneCheckpointPlanned(
    expectedCheckpoint: CheckpointPruneExpectation,
  ): Promise<CheckpointPruneResult> {
    const expected = copyCheckpointPruneExpectation(
      expectedCheckpoint,
    );
    assertCheckpointPruneExpectation(expected);
    const normalized = this.resolver.normalize(
      expected.path,
    );
    let committedResult:
      | CheckpointPruneResult
      | undefined;
    let targetLockReleaseFailed = false;
    try {
      const result =
        await this.mutex.runExclusive(
          normalized,
          () =>
            withProjectFileLock(
              this.resolver,
              normalized,
              async () => {
                const storageResult =
                  await this.checkpoints.pruneCommitted(
                    expected,
                  );
                committedResult =
                  checkpointPruneResult(
                    storageResult,
                  );
                return committedResult;
              },
              {
                onReleaseFailure: () => {
                  targetLockReleaseFailed =
                    true;
                },
              },
            ),
        );
      if (
        targetLockReleaseFailed &&
        committedResult !== undefined
      ) {
        return addCheckpointPruneWarning(
          committedResult,
          CHECKPOINT_PRUNE_TARGET_LOCK_WARNING,
        );
      }
      return result;
    } catch (error) {
      // The target lock is deliberately outside the checkpoint-store lock.
      // If releasing it fails after the manifest was deleted, preserve the
      // destructive success result and surface only a fixed warning.
      if (committedResult !== undefined) {
        return addCheckpointPruneWarning(
          committedResult,
          CHECKPOINT_PRUNE_TARGET_LOCK_WARNING,
        );
      }
      throw error;
    }
  }

  async inspectCheckpointBatchPrune(
    checkpointIds: readonly string[],
  ): Promise<CheckpointBatchPruneInspection> {
    const snapshots =
      await this.checkpoints.inspectBatchPrune(
        checkpointIds,
      );
    return {
      kind: "checkpointPruneBatch",
      checkpoints: snapshots.map(
        checkpointBatchPruneExpectation,
      ),
    };
  }

  async pruneCheckpointBatchPlanned(
    expectedCheckpoints: readonly CheckpointBatchPruneExpectation[],
  ): Promise<CheckpointBatchPruneResult> {
    const expected =
      copyCheckpointBatchPruneExpectations(
        expectedCheckpoints,
      );
    assertCheckpointBatchPruneExpectations(
      expected,
    );
    expected.sort((left, right) =>
      compareCanonicalText(
        left.id,
        right.id,
      ),
    );
    const targetPaths = [
      ...new Set(
        expected.map(({ path }) =>
          this.resolver.normalize(path),
        ),
      ),
    ].sort(compareCanonicalText);
    let committedResult:
      | CheckpointBatchPruneResult
      | undefined;
    let targetLockReleaseFailed = false;

    const withAllFileLocks = async (
      index: number,
    ): Promise<CheckpointBatchPruneResult> => {
      const targetPath =
        targetPaths[index];
      if (targetPath === undefined) {
        committedResult =
          await this.checkpoints.pruneCommittedBatch(
            expected,
          );
        return committedResult;
      }
      return withProjectFileLock(
        this.resolver,
        targetPath,
        () =>
          withAllFileLocks(index + 1),
        {
          onReleaseFailure: () => {
            targetLockReleaseFailed =
              true;
          },
        },
      );
    };
    const withAllMutexes = async (
      index: number,
    ): Promise<CheckpointBatchPruneResult> => {
      const targetPath =
        targetPaths[index];
      if (targetPath === undefined) {
        return withAllFileLocks(0);
      }
      return this.mutex.runExclusive(
        targetPath,
        () => withAllMutexes(index + 1),
      );
    };

    try {
      const result =
        await withAllMutexes(0);
      if (
        targetLockReleaseFailed &&
        result.manifestDeletedCount > 0
      ) {
        return addCheckpointBatchPruneWarning(
          result,
          CHECKPOINT_BATCH_PRUNE_TARGET_LOCK_WARNING,
        );
      }
      return result;
    } catch (error) {
      // Once any manifest has been observed unlinked, target lock release
      // failures cannot turn the bounded destructive result into a retryable
      // exception.
      if (
        committedResult !== undefined &&
        committedResult.manifestDeletedCount >
          0
      ) {
        return addCheckpointBatchPruneWarning(
          committedResult,
          CHECKPOINT_BATCH_PRUNE_TARGET_LOCK_WARNING,
        );
      }
      throw error;
    }
  }

  async inspectPreparedCheckpointDiscard(
    checkpointId: string,
  ): Promise<PreparedCheckpointDiscardInspection> {
    // The first manifest read is only a lock-routing hint and acquires no
    // checkpoint-store lock. The authoritative snapshot is read again after
    // the target lock is held, preserving target -> store lock order.
    const routedManifest =
      await this.checkpoints.read(
        checkpointId,
      );
    const normalized = this.resolver.normalize(
      routedManifest.path,
    );
    return this.mutex.runExclusive(
      normalized,
      () =>
        withProjectFileLock(
          this.resolver,
          normalized,
          async () => {
            const snapshot =
              await this.checkpoints.inspectManifest(
                checkpointId,
              );
            if (
              snapshot.manifest.path !==
              routedManifest.path
            ) {
              throw new TiledMcpError(
                "CHECKPOINT_CHANGED",
                `Checkpoint ${checkpointId} changed its target while prepared discard was being inspected.`,
                { checkpointId },
              );
            }
            const target =
              await this.preparedCheckpointDiscardTarget(
                snapshot.manifest,
              );
            return {
              checkpoint:
                preparedCheckpointDiscardExpectation(
                  snapshot,
                  target,
                ),
            };
          },
        ),
    );
  }

  async discardPreparedCheckpointPlanned(
    expectedCheckpoint: PreparedCheckpointDiscardExpectation,
  ): Promise<PreparedCheckpointDiscardResult> {
    const expected =
      copyPreparedCheckpointDiscardExpectation(
        expectedCheckpoint,
      );
    assertPreparedCheckpointDiscardExpectation(
      expected,
    );
    const normalized = this.resolver.normalize(
      expected.path,
    );
    let committedResult:
      | PreparedCheckpointDiscardResult
      | undefined;
    let targetLockReleaseFailed = false;
    try {
      const result =
        await this.mutex.runExclusive(
          normalized,
          () =>
            withProjectFileLock(
              this.resolver,
              normalized,
              async () => {
                const storageResult =
                  await this.checkpoints.discardPrepared(
                    expected,
                    async (manifest) => {
                      const currentTarget =
                        await this.preparedCheckpointDiscardTarget(
                          manifest,
                        );
                      if (
                        !samePreparedCheckpointDiscardTarget(
                          expected.target,
                          currentTarget,
                        )
                      ) {
                        throw preparedCheckpointDiscardConflict(
                          manifest,
                          "The target no longer matches the state verified by the discard preview.",
                        );
                      }
                    },
                  );
                committedResult =
                  preparedCheckpointDiscardResult(
                    storageResult,
                    expected.target,
                  );
                return committedResult;
              },
              {
                onReleaseFailure: () => {
                  targetLockReleaseFailed =
                    true;
                },
              },
            ),
        );
      if (
        targetLockReleaseFailed &&
        committedResult !== undefined
      ) {
        return addPreparedCheckpointDiscardWarning(
          committedResult,
          PREPARED_CHECKPOINT_DISCARD_TARGET_LOCK_WARNING,
        );
      }
      return result;
    } catch (error) {
      // Manifest unlink is the destructive commit point. A target lock
      // release failure after it must remain a successful discard outcome.
      if (committedResult !== undefined) {
        return addPreparedCheckpointDiscardWarning(
          committedResult,
          PREPARED_CHECKPOINT_DISCARD_TARGET_LOCK_WARNING,
        );
      }
      throw error;
    }
  }

  async inspectPreparedCheckpointCommit(
    checkpointId: string,
  ): Promise<PreparedCheckpointCommitInspection> {
    const checkpoint =
      await this.inspectPreparedCheckpointAdjudication(
        checkpointId,
      );
    if (
      checkpoint.conflict !==
      "create-target-matches-after"
    ) {
      throw preparedCheckpointAdjudicationConflict(
        checkpoint,
        "Commit confirmation is limited to an ambiguous create whose safe target matches the checkpoint after revision.",
      );
    }
    return { checkpoint };
  }

  async inspectPreparedCheckpointAbandon(
    checkpointId: string,
  ): Promise<PreparedCheckpointAbandonInspection> {
    return {
      checkpoint:
        await this.inspectPreparedCheckpointAdjudication(
          checkpointId,
        ),
    };
  }

  async commitPreparedCheckpointPlanned(
    expectedCheckpoint: PreparedCheckpointAdjudicationExpectation,
  ): Promise<PreparedCheckpointCommitResult> {
    const expected =
      copyPreparedCheckpointAdjudicationExpectation(
        expectedCheckpoint,
      );
    assertPreparedCheckpointAdjudicationExpectation(
      expected,
      "commit",
    );
    const normalized = this.resolver.normalize(
      expected.path,
    );
    let committedResult:
      | PreparedCheckpointCommitResult
      | undefined;
    let targetLockReleaseFailed = false;
    try {
      const result =
        await this.mutex.runExclusive(
          normalized,
          () =>
            withProjectFileLock(
              this.resolver,
              normalized,
              async () => {
                const storageResult =
                  await this.checkpoints.commitPreparedCheckpoint(
                    expected,
                    async (manifest) => {
                      const current =
                        await this.preparedCheckpointAdjudicationState(
                          manifest,
                        );
                      if (
                        !samePreparedCheckpointAdjudicationEvidence(
                          expected,
                          current,
                        )
                      ) {
                        throw preparedCheckpointAdjudicationChanged(
                          manifest,
                          "The target no longer matches the safe evidence fixed by the commit preview.",
                        );
                      }
                    },
                  );
                committedResult =
                  preparedCheckpointCommitResult(
                    storageResult,
                    expected,
                  );
                return committedResult;
              },
              {
                onReleaseFailure: () => {
                  targetLockReleaseFailed =
                    true;
                },
              },
            ),
        );
      if (
        targetLockReleaseFailed &&
        committedResult !== undefined
      ) {
        return addPreparedCheckpointCommitWarning(
          committedResult,
          PREPARED_CHECKPOINT_COMMIT_TARGET_LOCK_WARNING,
        );
      }
      return result;
    } catch (error) {
      // The manifest rename is the commit point. Preserve the bounded success
      // if releasing the outer target lock becomes unconfirmable afterward.
      if (committedResult !== undefined) {
        return addPreparedCheckpointCommitWarning(
          committedResult,
          PREPARED_CHECKPOINT_COMMIT_TARGET_LOCK_WARNING,
        );
      }
      throw error;
    }
  }

  async abandonPreparedCheckpointPlanned(
    expectedCheckpoint: PreparedCheckpointAdjudicationExpectation,
  ): Promise<PreparedCheckpointAbandonResult> {
    const expected =
      copyPreparedCheckpointAdjudicationExpectation(
        expectedCheckpoint,
      );
    assertPreparedCheckpointAdjudicationExpectation(
      expected,
      "abandon",
    );
    const normalized = this.resolver.normalize(
      expected.path,
    );
    let committedResult:
      | PreparedCheckpointAbandonResult
      | undefined;
    let targetLockReleaseFailed = false;
    try {
      const result =
        await this.mutex.runExclusive(
          normalized,
          () =>
            withProjectFileLock(
              this.resolver,
              normalized,
              async () => {
                const storageResult =
                  await this.checkpoints.abandonPreparedCheckpoint(
                    expected,
                    async (manifest) => {
                      const current =
                        await this.preparedCheckpointAdjudicationState(
                          manifest,
                        );
                      if (
                        !samePreparedCheckpointAdjudicationEvidence(
                          expected,
                          current,
                        )
                      ) {
                        throw preparedCheckpointAdjudicationChanged(
                          manifest,
                          "The target no longer matches the safe evidence fixed by the abandon preview.",
                        );
                      }
                    },
                  );
                committedResult =
                  preparedCheckpointAbandonResult(
                    storageResult,
                    expected,
                  );
                return committedResult;
              },
              {
                onReleaseFailure: () => {
                  targetLockReleaseFailed =
                    true;
                },
              },
            ),
        );
      if (
        targetLockReleaseFailed &&
        committedResult !== undefined
      ) {
        return addPreparedCheckpointAbandonWarning(
          committedResult,
          PREPARED_CHECKPOINT_ABANDON_TARGET_LOCK_WARNING,
        );
      }
      return result;
    } catch (error) {
      // Manifest unlink is the destructive commit point. Once the storage
      // layer returns it, target-lock release cannot turn it into a retryable
      // exception.
      if (committedResult !== undefined) {
        return addPreparedCheckpointAbandonWarning(
          committedResult,
          PREPARED_CHECKPOINT_ABANDON_TARGET_LOCK_WARNING,
        );
      }
      throw error;
    }
  }

  private async inspectPreparedCheckpointAdjudication(
    checkpointId: string,
  ): Promise<PreparedCheckpointAdjudicationExpectation> {
    // This first read is only a routing hint. The authoritative raw and
    // semantic manifest snapshot is taken under target -> store lock order.
    const routedManifest =
      await this.checkpoints.read(
        checkpointId,
      );
    const normalized = this.resolver.normalize(
      routedManifest.path,
    );
    return this.mutex.runExclusive(
      normalized,
      () =>
        withProjectFileLock(
          this.resolver,
          normalized,
          async () => {
            const snapshot =
              await this.checkpoints.inspectManifest(
                checkpointId,
              );
            if (
              snapshot.manifest.path !==
              routedManifest.path
            ) {
              throw new TiledMcpError(
                "CHECKPOINT_CHANGED",
                `Checkpoint ${checkpointId} changed its target while prepared adjudication was being inspected.`,
                { checkpointId },
              );
            }
            const evidence =
              await this.preparedCheckpointAdjudicationState(
                snapshot.manifest,
              );
            return preparedCheckpointAdjudicationExpectation(
              snapshot,
              evidence,
            );
          },
        ),
    );
  }

  private async preparedCheckpointAdjudicationState(
    manifest: CheckpointManifest,
  ): Promise<{
    target: PreparedCheckpointAdjudicationTarget;
    conflict: PreparedCheckpointAdjudicationConflict;
  }> {
    if (manifest.status !== "prepared") {
      throw preparedCheckpointAdjudicationConflict(
        manifest,
        "Only prepared checkpoints can be adjudicated.",
      );
    }

    let absolutePath: string;
    try {
      absolutePath =
        await this.resolver.resolveExisting(
          manifest.path,
        );
    } catch (error) {
      if (isMissingCode(errorCode(error))) {
        if (!manifest.before.existed) {
          throw preparedCheckpointAdjudicationConflict(
            manifest,
            "The create target is still missing and remains eligible for the existing safe discard workflow.",
          );
        }
        return {
          target: { existed: false },
          conflict:
            "existing-target-missing",
        };
      }
      throw preparedCheckpointAdjudicationConflict(
        manifest,
        "The target could not be resolved as a safe in-project path.",
      );
    }

    let current: DocumentFileSnapshot;
    try {
      current =
        await readDocumentFileSnapshotWithIdentity(
          absolutePath,
          manifest.path,
          this.maxDocumentBytes,
        );
    } catch {
      throw preparedCheckpointAdjudicationConflict(
        manifest,
        "The target could not be proven to be a bounded no-follow regular file.",
      );
    }
    const target = {
      existed: true as const,
      revision: revisionOf(current.bytes),
      size: current.bytes.byteLength,
    };

    if (!manifest.before.existed) {
      return {
        target,
        conflict:
          target.revision ===
          manifest.afterRevision
            ? "create-target-matches-after"
            : "create-target-unrelated",
      };
    }
    if (
      target.revision ===
      manifest.afterRevision
    ) {
      throw preparedCheckpointAdjudicationConflict(
        manifest,
        "The existing-file target matches the after revision and remains eligible for automatic reconciliation.",
      );
    }
    if (
      target.revision ===
        manifest.before.revision &&
      target.size === manifest.before.size
    ) {
      throw preparedCheckpointAdjudicationConflict(
        manifest,
        "The existing-file target matches the before revision and remains eligible for the existing safe discard workflow.",
      );
    }
    if (
      target.revision ===
      manifest.before.revision
    ) {
      throw preparedCheckpointAdjudicationConflict(
        manifest,
        "The target revision matches the checkpoint before revision, but its size does not; the state cannot be classified safely.",
      );
    }
    return {
      target,
      conflict: "existing-target-unrelated",
    };
  }

  private async preparedCheckpointDiscardTarget(
    manifest: CheckpointManifest,
  ): Promise<PreparedCheckpointDiscardTarget> {
    if (manifest.status !== "prepared") {
      throw preparedCheckpointDiscardConflict(
        manifest,
        "Only prepared checkpoints can be safely discarded.",
      );
    }
    if (!manifest.before.existed) {
      try {
        await this.resolver.resolveExisting(
          manifest.path,
        );
      } catch (error) {
        if (isMissingCode(errorCode(error))) {
          return { existed: false };
        }
        throw preparedCheckpointDiscardConflict(
          manifest,
          "The target could not be proven strictly missing.",
        );
      }
      throw preparedCheckpointDiscardConflict(
        manifest,
        "The target exists, so it no longer matches the pre-create state.",
      );
    }

    if (
      manifest.before.revision ===
      manifest.afterRevision
    ) {
      throw preparedCheckpointDiscardConflict(
        manifest,
        "The prepared checkpoint does not distinguish its before and after revisions.",
      );
    }

    let current: DocumentFileSnapshot;
    try {
      const absolutePath =
        await this.resolver.resolveExisting(
          manifest.path,
        );
      current =
        await readDocumentFileSnapshotWithIdentity(
          absolutePath,
          manifest.path,
          manifest.before.size,
        );
    } catch {
      throw preparedCheckpointDiscardConflict(
        manifest,
        "The target could not be proven to be the safe regular pre-write file.",
      );
    }
    const revision = revisionOf(current.bytes);
    if (
      revision !== manifest.before.revision ||
      current.bytes.byteLength !==
        manifest.before.size
    ) {
      throw preparedCheckpointDiscardConflict(
        manifest,
        "The target does not exactly match the checkpoint's pre-write bytes.",
      );
    }
    return {
      existed: true,
      revision,
      size: current.bytes.byteLength,
    };
  }

  private async commitContent(
    normalized: string,
    expectedRevision: string,
    content: Buffer,
    label: string,
  ): Promise<CommitResult> {
    this.assertSize(content, normalized);
    return this.mutex.runExclusive(normalized, () =>
      withProjectFileLock(this.resolver, normalized, async () => {
        const absolutePath = await this.resolver.resolveExisting(normalized);
        const before = await this.readBounded(absolutePath, normalized);
        const actualRevision = revisionOf(before);
        assertExpectedRevision(normalized, expectedRevision, actualRevision);

        const afterRevision = revisionOf(content);
        if (afterRevision === actualRevision) {
          return {
            path: normalized,
            beforeRevision: actualRevision,
            revision: actualRevision,
            checkpointId: null,
            changed: false,
          };
        }

        const checkpoint = await this.checkpoints.prepare(
          normalized,
          before,
          afterRevision,
          label,
        );
        const warnings = await this.atomicReplaceConfirmed(
          absolutePath,
          content,
          actualRevision,
          normalized,
        );
        const targetDurabilityConfirmed =
          warnings.length === 0;
        const finalization =
          await this.markCheckpointBestEffort(
            checkpoint,
          );
        warnings.push(
          ...finalization.warnings,
        );
        const retention =
          targetDurabilityConfirmed &&
          finalization.committed !==
            undefined &&
          isRollingCommittedCheckpoint(
            finalization.committed,
          )
            ? await this.enforcePostCommitRetention(
                finalization.committed,
                absolutePath,
                normalized,
              )
            : undefined;
        if (retention !== undefined) {
          warnings.push(
            ...retention.warnings,
          );
        }
        return {
          path: normalized,
          beforeRevision: actualRevision,
          revision: afterRevision,
          checkpointId: checkpoint.id,
          changed: true,
          ...(retention === undefined
            ? {}
            : {
                checkpointRetention:
                  retention.result,
              }),
          ...(warnings.length === 0 ? {} : { warnings }),
        };
      }),
    );
  }

  async inspectRevert(
    checkpointId: string,
    expectedRevision: string,
  ): Promise<CheckpointRestoreInspection> {
    const manifest = await this.checkpoints.read(checkpointId);
    const before = await this.checkpoints.readBefore(manifest);
    if (!before) {
      throw new TiledMcpError(
        "REVERT_WOULD_DELETE",
        "This checkpoint represents creation of a new file; deletion is not supported by the MVP.",
        { checkpointId, path: manifest.path },
      );
    }
    // Validate the snapshot as a JSON document, but restore its exact original
    // bytes rather than normalizing whitespace or key order.
    validateCheckpointRestoreDocument(
      before,
      manifest.path,
      checkpointId,
    );
    const normalized = this.resolver.normalize(manifest.path);
    this.assertSize(before, normalized);
    let current: DocumentSnapshot | null;
    try {
      current = await this.readSnapshot(normalized);
    } catch (error) {
      if (
        error instanceof TiledMcpError &&
        error.code === "FILE_NOT_FOUND"
      ) {
        current = null;
      } else {
        throw error;
      }
    }
    const checkpoint = checkpointRestoreExpectation(manifest);
    if (current === null) {
      // The target is gone (deleted through tiled_delete_file or externally).
      // With no current bytes to pin, the approved revision is the restored
      // content itself.
      if (manifest.status === "prepared") {
        throw new TiledMcpError(
          "CHECKPOINT_STATE_CONFLICT",
          `Checkpoint ${checkpointId} is prepared and its target is missing; adjudicate it before restoring.`,
          {
            checkpointId,
            currentRevision: null,
            afterRevision: manifest.afterRevision,
          },
        );
      }
      if (
        expectedRevision !==
        checkpoint.before.revision
      ) {
        throw new TiledMcpError(
          "REVISION_CONFLICT",
          `${normalized} is missing; expectedRevision must equal the checkpoint's restorable content revision.`,
          {
            path: normalized,
            expectedRevision,
            actualRevision: null,
            restoreRevision:
              checkpoint.before.revision,
          },
        );
      }
      return {
        checkpoint,
        currentRevision: null,
        restoreRevision:
          checkpoint.before.revision,
        restoreSize: before.byteLength,
        changed: true,
      };
    }
    assertExpectedRevision(
      normalized,
      expectedRevision,
      current.revision,
    );
    assertPreparedCheckpointRestoreState(
      manifest,
      current.revision,
    );
    return {
      checkpoint,
      currentRevision: current.revision,
      restoreRevision: checkpoint.before.revision,
      restoreSize: before.byteLength,
      changed: checkpoint.before.revision !== current.revision,
    };
  }

  async revert(
    checkpointId: string,
    expectedRevision: string,
  ): Promise<CommitResult> {
    const inspection = await this.inspectRevert(
      checkpointId,
      expectedRevision,
    );
    return this.revertPlanned(
      inspection.checkpoint,
      expectedRevision,
    );
  }

  async revertPlanned(
    expectedCheckpoint: CheckpointRestoreExpectation,
    expectedRevision: string,
    options: { expectMissingTarget?: boolean } = {},
  ): Promise<CommitResult> {
    const normalized = this.resolver.normalize(
      expectedCheckpoint.path,
    );
    return this.mutex.runExclusive(normalized, () =>
      withProjectFileLock(this.resolver, normalized, async () => {
        const manifest = await this.checkpoints.read(
          expectedCheckpoint.id,
        );
        if (
          !sameCheckpointRestoreExpectation(
            expectedCheckpoint,
            manifest,
          )
        ) {
          throw new TiledMcpError(
            "CHECKPOINT_CHANGED",
            `Checkpoint ${expectedCheckpoint.id} changed after the restore preview. Preview it again.`,
            {
              checkpointId: expectedCheckpoint.id,
              path: manifest.path,
            },
          );
        }
        if (options.expectMissingTarget === true) {
          return this.revertIntoMissingTarget(
            expectedCheckpoint,
            manifest,
            expectedRevision,
            normalized,
          );
        }
        const absolutePath =
          await this.resolver.resolveExisting(normalized);
        const current = await this.readBounded(
          absolutePath,
          normalized,
        );
        const currentRevision = revisionOf(current);
        assertExpectedRevision(
          normalized,
          expectedRevision,
          currentRevision,
        );
        assertPreparedCheckpointRestoreState(
          manifest,
          currentRevision,
        );
        const before = await this.checkpoints.readBefore(manifest);
        if (!before) {
          throw new TiledMcpError(
            "REVERT_WOULD_DELETE",
            "This checkpoint represents creation of a new file; deletion is not supported by the MVP.",
            {
              checkpointId: expectedCheckpoint.id,
              path: manifest.path,
            },
          );
        }
        validateCheckpointRestoreDocument(
          before,
          manifest.path,
          manifest.id,
        );
        this.assertSize(before, normalized);
        if (manifest.status === "prepared") {
          // Do not restore from an ambiguous prepared manifest. Committing the
          // landed source checkpoint must succeed before target bytes change.
          await this.checkpoints.markCommitted(manifest);
        }
        const restoredRevision = revisionOf(before);
        if (restoredRevision === currentRevision) {
          return {
            path: normalized,
            beforeRevision: currentRevision,
            revision: currentRevision,
            checkpointId: null,
            changed: false,
          };
        }
        const restoreCheckpoint = await this.checkpoints.prepare(
          normalized,
          current,
          restoredRevision,
          `revert checkpoint ${expectedCheckpoint.id}`,
        );
        const warnings = await this.atomicReplaceConfirmed(
          absolutePath,
          before,
          currentRevision,
          normalized,
        );
        const targetDurabilityConfirmed =
          warnings.length === 0;
        const finalization =
          await this.markCheckpointBestEffort(
            restoreCheckpoint,
          );
        warnings.push(
          ...finalization.warnings,
        );
        const retention =
          targetDurabilityConfirmed &&
          finalization.committed !==
            undefined &&
          isRollingCommittedCheckpoint(
            finalization.committed,
          )
            ? await this.enforcePostCommitRetention(
                finalization.committed,
                absolutePath,
                normalized,
              )
            : undefined;
        if (retention !== undefined) {
          warnings.push(
            ...retention.warnings,
          );
        }
        return {
          path: normalized,
          beforeRevision: currentRevision,
          revision: restoredRevision,
          checkpointId: restoreCheckpoint.id,
          changed: true,
          ...(retention === undefined
            ? {}
            : {
                checkpointRetention:
                  retention.result,
              }),
          ...(warnings.length === 0 ? {} : { warnings }),
        };
      }),
    );
  }

  /**
   * Recreates a missing target from a committed checkpoint's exact before
   * bytes. `expectedRevision` pins the restored content itself; a target
   * that reappeared since the preview fails closed.
   */
  private async revertIntoMissingTarget(
    expectedCheckpoint: CheckpointRestoreExpectation,
    manifest: CheckpointManifest,
    expectedRevision: string,
    normalized: string,
  ): Promise<CommitResult> {
    if (manifest.status !== "committed") {
      throw new TiledMcpError(
        "CHECKPOINT_STATE_CONFLICT",
        `Checkpoint ${manifest.id} is prepared and its target is missing; adjudicate it before restoring.`,
        {
          checkpointId: manifest.id,
          currentRevision: null,
          afterRevision: manifest.afterRevision,
        },
      );
    }
    const absolutePath =
      await this.resolver.resolveForCreate(
        normalized,
      );
    try {
      await stat(absolutePath);
      throw new TiledMcpError(
        "CHECKPOINT_STATE_CONFLICT",
        `${normalized} reappeared after the restore preview. Preview the restore again.`,
        {
          checkpointId: manifest.id,
          path: normalized,
        },
      );
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    }
    const before = await this.checkpoints.readBefore(manifest);
    if (!before) {
      throw new TiledMcpError(
        "REVERT_WOULD_DELETE",
        "This checkpoint represents creation of a new file; deletion is not supported by the MVP.",
        {
          checkpointId: expectedCheckpoint.id,
          path: manifest.path,
        },
      );
    }
    validateCheckpointRestoreDocument(
      before,
      manifest.path,
      manifest.id,
    );
    this.assertSize(before, normalized);
    const restoredRevision = revisionOf(before);
    if (restoredRevision !== expectedRevision) {
      throw new TiledMcpError(
        "REVISION_CONFLICT",
        `${normalized} is missing; expectedRevision must equal the checkpoint's restorable content revision.`,
        {
          path: normalized,
          expectedRevision,
          actualRevision: null,
          restoreRevision: restoredRevision,
        },
      );
    }
    const restoreCheckpoint = await this.checkpoints.prepare(
      normalized,
      undefined,
      restoredRevision,
      `revert checkpoint ${expectedCheckpoint.id}`,
    );
    const warnings = await this.atomicReplaceConfirmed(
      absolutePath,
      before,
      undefined,
      normalized,
    );
    const finalization =
      await this.markCheckpointBestEffort(
        restoreCheckpoint,
      );
    warnings.push(...finalization.warnings);
    return {
      path: normalized,
      beforeRevision: null,
      revision: restoredRevision,
      checkpointId: restoreCheckpoint.id,
      changed: true,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  }

  /**
   * Deletes one project document after committing a checkpoint of its exact
   * current bytes, so the deletion stays restorable through the standard
   * checkpoint-restore flow. The checkpoint is committed before the unlink:
   * every crash window leaves either the intact file or a restorable
   * committed checkpoint.
   */
  async deleteDocument(
    projectPath: string,
    expectedRevision: string,
    label = "delete document",
  ): Promise<FileDeleteStoreResult> {
    const normalized = this.resolver.normalize(projectPath);
    return this.mutex.runExclusive(normalized, () =>
      withProjectFileLock(this.resolver, normalized, async () => {
        const absolutePath =
          await this.resolver.resolveExisting(normalized);
        const current = await this.readBounded(
          absolutePath,
          normalized,
        );
        const currentRevision = revisionOf(current);
        assertExpectedRevision(
          normalized,
          expectedRevision,
          currentRevision,
        );
        const checkpoint = await this.checkpoints.prepare(
          normalized,
          current,
          currentRevision,
          label,
        );
        const committed =
          await this.checkpoints.markCommitted(
            checkpoint,
          );
        await unlink(absolutePath);
        const warnings: string[] = [];
        try {
          await syncDirectoryBestEffort(
            dirname(absolutePath),
          );
        } catch {
          warnings.push(
            `Could not durably sync the parent directory of ${normalized} after deletion.`,
          );
        }
        return {
          kind: "fileDelete",
          path: normalized,
          beforeRevision: currentRevision,
          checkpointId: committed.id,
          deleted: true,
          ...(warnings.length === 0
            ? {}
            : { warnings }),
        };
      }),
    );
  }

  /**
   * Atomically commits 2..16 disjoint document targets: per-target CAS,
   * per-target before-state checkpoints, content-addressed staging, one
   * single-file commit point, ordered promotions, then cleanup. Crash
   * recovery (`recoverTransactions`) rolls back before the commit point and
   * rolls forward after it.
   */
  async commitTransaction(
    targets: readonly TransactionTargetInput[],
    label = "transaction",
  ): Promise<TransactionCommitResult> {
    if (
      !Array.isArray(targets) ||
      targets.length < MIN_TRANSACTION_TARGETS ||
      targets.length > MAX_TRANSACTION_TARGETS
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `A transaction must contain between ${MIN_TRANSACTION_TARGETS} and ${MAX_TRANSACTION_TARGETS} targets.`,
        {
          min: MIN_TRANSACTION_TARGETS,
          max: MAX_TRANSACTION_TARGETS,
          actual: Array.isArray(targets)
            ? targets.length
            : null,
        },
      );
    }
    if (
      label.length > MAX_TRANSACTION_LABEL_LENGTH
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `Transaction labels may contain at most ${MAX_TRANSACTION_LABEL_LENGTH} characters.`,
      );
    }
    const normalized = targets.map((target) => ({
      ...target,
      path: this.resolver.normalize(target.path),
    }));
    const paths = normalized.map(
      ({ path }) => path,
    );
    if (new Set(paths).size !== paths.length) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "Transaction targets must be pairwise-distinct project paths.",
        { paths },
      );
    }
    let stagedBytes = 0;
    for (const target of normalized) {
      if (target.kind === "delete") {
        continue;
      }
      this.assertSize(
        target.content,
        target.path,
      );
      parseJsonDocument(
        decodeUtf8Strict(
          target.content,
          target.path,
        ),
        target.path,
      );
      stagedBytes += target.content.byteLength;
      if (
        stagedBytes >
        MAX_TRANSACTION_STAGED_BYTES
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `A transaction may stage at most ${MAX_TRANSACTION_STAGED_BYTES} bytes.`,
          {
            limit: MAX_TRANSACTION_STAGED_BYTES,
          },
        );
      }
    }
    const ordered = [...normalized].sort(
      (left, right) =>
        left.path < right.path ? -1 : 1,
    );
    const transactionId = randomUUID();
    const step = async (
      name: string,
    ): Promise<void> => {
      await this.transactionObserver?.beforeStep?.(
        name,
      );
    };
    const runLocked = async <T>(
      index: number,
      operation: () => Promise<T>,
    ): Promise<T> => {
      if (index >= ordered.length) {
        return operation();
      }
      const path = ordered[index]!.path;
      return this.mutex.runExclusive(path, () =>
        withProjectFileLock(
          this.resolver,
          path,
          () => runLocked(index + 1, operation),
        ),
      );
    };
    return runLocked(0, async () => {
      await step("locked");
      const currentByPath = new Map<
        string,
        Buffer | undefined
      >();
      for (const target of ordered) {
        if (target.kind === "create") {
          const absolutePath =
            await this.resolver.resolveForCreate(
              target.path,
            );
          try {
            await stat(absolutePath);
            throw new TiledMcpError(
              "FILE_ALREADY_EXISTS",
              `Refusing to overwrite existing file ${target.path}.`,
              { path: target.path },
            );
          } catch (error) {
            if (!hasCode(error, "ENOENT")) {
              throw error;
            }
          }
          currentByPath.set(
            target.path,
            undefined,
          );
          continue;
        }
        const absolutePath =
          await this.resolver.resolveExisting(
            target.path,
          );
        const current = await this.readBounded(
          absolutePath,
          target.path,
        );
        assertExpectedRevision(
          target.path,
          target.expectedRevision,
          revisionOf(current),
        );
        currentByPath.set(target.path, current);
      }
      await step("cas-verified");
      const entries: TransactionManifestEntry[] =
        [];
      for (const target of ordered) {
        const before = currentByPath.get(
          target.path,
        );
        const afterRevision =
          target.kind === "delete"
            ? target.expectedRevision
            : revisionOf(target.content);
        const checkpoint =
          await this.checkpoints.prepare(
            target.path,
            before,
            afterRevision,
            `transaction ${transactionId}: ${label}`,
          );
        if (target.kind === "replace") {
          entries.push({
            kind: "replace",
            path: target.path,
            expectedRevision:
              target.expectedRevision,
            afterRevision,
            contentObjectHash:
              afterRevision.slice(7),
            checkpointId: checkpoint.id,
          });
        } else if (target.kind === "create") {
          entries.push({
            kind: "create",
            path: target.path,
            afterRevision,
            contentObjectHash:
              afterRevision.slice(7),
            checkpointId: checkpoint.id,
          });
        } else {
          entries.push({
            kind: "delete",
            path: target.path,
            expectedRevision:
              target.expectedRevision,
            checkpointId: checkpoint.id,
          });
        }
      }
      await step("checkpoints-prepared");
      const stagedDirectory =
        await this.resolver.ensureInternalDirectory(
          TRANSACTION_STAGED_DIRECTORY,
        );
      for (const target of ordered) {
        if (target.kind === "delete") {
          continue;
        }
        const hash = revisionOf(
          target.content,
        ).slice(7);
        await writeFileDurably(
          join(stagedDirectory, hash),
          target.content,
        );
      }
      await step("staged");
      const manifestDirectory =
        await this.resolver.ensureInternalDirectory(
          TRANSACTIONS_DIRECTORY,
        );
      const manifestPath = join(
        manifestDirectory,
        `${transactionId}.json`,
      );
      const manifest: TransactionManifest = {
        version: 1,
        id: transactionId,
        state: "prepared",
        createdAt: new Date().toISOString(),
        label,
        entries,
      };
      await writeFileDurably(
        manifestPath,
        serializeTransactionManifest(manifest),
      );
      await step("manifest-prepared");
      manifest.state = "committed";
      await writeFileDurably(
        manifestPath,
        serializeTransactionManifest(manifest),
      );
      await step("commit-point");
      const warnings: string[] = [];
      for (const entry of entries) {
        try {
          const checkpointManifest =
            await this.checkpoints.read(
              entry.checkpointId,
            );
          if (
            checkpointManifest.status ===
            "prepared"
          ) {
            await this.checkpoints.markCommitted(
              checkpointManifest,
            );
          }
        } catch {
          warnings.push(
            `Transaction checkpoint ${entry.checkpointId} could not be marked committed.`,
          );
        }
      }
      await step("checkpoints-committed");
      const results: TransactionTargetResult[] =
        [];
      for (const [
        index,
        target,
      ] of ordered.entries()) {
        const entry = entries[index]!;
        await step(`promote:${target.path}`);
        if (target.kind === "delete") {
          const absolutePath =
            await this.resolver.resolveExisting(
              target.path,
            );
          await unlink(absolutePath);
          try {
            await syncDirectoryBestEffort(
              dirname(absolutePath),
            );
          } catch {
            warnings.push(
              `Could not durably sync the parent directory of ${target.path} after deletion.`,
            );
          }
          results.push({
            kind: "delete",
            path: target.path,
            beforeRevision:
              target.expectedRevision,
            revision: null,
            checkpointId: entry.checkpointId,
            changed: true,
          });
          continue;
        }
        const absolutePath =
          target.kind === "create"
            ? await this.resolver.resolveForCreate(
                target.path,
              )
            : await this.resolver.resolveExisting(
                target.path,
              );
        const promotionWarnings =
          await this.atomicReplaceConfirmed(
            absolutePath,
            target.content,
            target.kind === "replace"
              ? target.expectedRevision
              : undefined,
            target.path,
          );
        warnings.push(...promotionWarnings);
        results.push({
          kind: target.kind,
          path: target.path,
          beforeRevision:
            target.kind === "replace"
              ? target.expectedRevision
              : null,
          revision:
            entry.kind === "delete"
              ? null
              : entry.afterRevision,
          checkpointId: entry.checkpointId,
          changed: true,
        });
      }
      await step("promoted");
      await unlink(manifestPath).catch(() => {
        warnings.push(
          `Transaction manifest ${transactionId} could not be removed after completion.`,
        );
      });
      for (const entry of entries) {
        if (entry.kind === "delete") {
          continue;
        }
        await unlink(
          join(
            stagedDirectory,
            entry.contentObjectHash,
          ),
        ).catch(() => {});
      }
      await step("cleaned");
      return {
        transactionId,
        results,
        ...(warnings.length === 0
          ? {}
          : { warnings }),
      };
    });
  }

  /**
   * Startup recovery for interrupted transactions: prepared manifests roll
   * back (targets were never promoted), committed manifests roll forward
   * target by target, and a target diverged by an outside writer becomes a
   * reported conflict while the rest still roll forward. Unreferenced
   * staged objects are swept afterwards.
   */
  async recoverTransactions(): Promise<TransactionRecoveryReport> {
    const report: TransactionRecoveryReport = {
      scannedManifests: 0,
      rolledBack: 0,
      rolledForwardTargets: 0,
      alreadyCompleteTargets: 0,
      conflicts: [],
      corruptManifests: [],
      sweptStagedObjects: 0,
      warnings: [],
    };
    const manifestDirectory =
      await this.resolver.ensureInternalDirectory(
        TRANSACTIONS_DIRECTORY,
      );
    const stagedDirectory =
      await this.resolver.ensureInternalDirectory(
        TRANSACTION_STAGED_DIRECTORY,
      );
    let fileNames: string[];
    try {
      fileNames = (
        await readdir(manifestDirectory)
      ).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return report;
      }
      throw error;
    }
    fileNames.sort();
    const liveHashes = new Set<string>();
    for (const fileName of fileNames) {
      report.scannedManifests += 1;
      const manifestPath = join(
        manifestDirectory,
        fileName,
      );
      let manifest: TransactionManifest;
      try {
        manifest = parseTransactionManifest(
          await readFile(manifestPath, "utf8"),
          fileName,
        );
      } catch {
        report.corruptManifests.push(fileName);
        continue;
      }
      if (manifest.state === "prepared") {
        // The commit point was never reached, so no target was promoted;
        // dropping the manifest rolls the transaction back. Its prepared
        // checkpoints surface through the normal checkpoint reconciler.
        await unlink(manifestPath).catch(() => {
          report.warnings.push(
            `Could not remove rolled-back transaction manifest ${fileName}.`,
          );
        });
        report.rolledBack += 1;
        continue;
      }
      let unresolvedConflicts = 0;
      for (const entry of manifest.entries) {
        const outcome =
          await this.rollForwardTransactionEntry(
            manifest,
            entry,
            stagedDirectory,
            report,
          );
        if (outcome === "conflict") {
          unresolvedConflicts += 1;
        }
      }
      if (unresolvedConflicts === 0) {
        await unlink(manifestPath).catch(() => {
          report.warnings.push(
            `Could not remove completed transaction manifest ${fileName}.`,
          );
        });
      } else {
        for (const entry of manifest.entries) {
          if (entry.kind !== "delete") {
            liveHashes.add(
              entry.contentObjectHash,
            );
          }
        }
      }
    }
    let stagedNames: string[] = [];
    try {
      stagedNames = await readdir(
        stagedDirectory,
      );
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    }
    for (const name of stagedNames) {
      if (liveHashes.has(name)) {
        continue;
      }
      await unlink(
        join(stagedDirectory, name),
      ).catch(() => {
        report.warnings.push(
          `Could not sweep staged transaction object ${name}.`,
        );
      });
      report.sweptStagedObjects += 1;
    }
    return report;
  }

  private async rollForwardTransactionEntry(
    manifest: TransactionManifest,
    entry: TransactionManifestEntry,
    stagedDirectory: string,
    report: TransactionRecoveryReport,
  ): Promise<"done" | "conflict"> {
    return this.mutex.runExclusive(
      entry.path,
      () =>
        withProjectFileLock(
          this.resolver,
          entry.path,
          async () => {
            try {
              const checkpointManifest =
                await this.checkpoints.read(
                  entry.checkpointId,
                );
              if (
                checkpointManifest.status ===
                "prepared"
              ) {
                await this.checkpoints.markCommitted(
                  checkpointManifest,
                );
              }
            } catch {
              report.warnings.push(
                `Transaction checkpoint ${entry.checkpointId} could not be marked committed during recovery.`,
              );
            }
            let currentRevision:
              | string
              | undefined;
            try {
              const absolutePath =
                await this.resolver.resolveExisting(
                  entry.path,
                );
              currentRevision = revisionOf(
                await this.readBounded(
                  absolutePath,
                  entry.path,
                ),
              );
            } catch (error) {
              if (
                error instanceof TiledMcpError &&
                error.code === "FILE_NOT_FOUND"
              ) {
                currentRevision = undefined;
              } else {
                throw error;
              }
            }
            if (entry.kind === "delete") {
              if (
                currentRevision === undefined
              ) {
                report.alreadyCompleteTargets += 1;
                return "done";
              }
              if (
                currentRevision ===
                entry.expectedRevision
              ) {
                const absolutePath =
                  await this.resolver.resolveExisting(
                    entry.path,
                  );
                await unlink(absolutePath);
                report.rolledForwardTargets += 1;
                return "done";
              }
              report.conflicts.push({
                transactionId: manifest.id,
                path: entry.path,
                reason: "target-diverged",
              });
              return "conflict";
            }
            if (
              currentRevision ===
              entry.afterRevision
            ) {
              report.alreadyCompleteTargets += 1;
              return "done";
            }
            const expectedBefore =
              entry.kind === "replace"
                ? entry.expectedRevision
                : undefined;
            if (
              currentRevision !== expectedBefore
            ) {
              report.conflicts.push({
                transactionId: manifest.id,
                path: entry.path,
                reason: "target-diverged",
              });
              return "conflict";
            }
            let staged: Buffer;
            try {
              staged = await readFile(
                join(
                  stagedDirectory,
                  entry.contentObjectHash,
                ),
              );
            } catch {
              report.conflicts.push({
                transactionId: manifest.id,
                path: entry.path,
                reason: "staged-object-missing",
              });
              return "conflict";
            }
            if (
              revisionOf(staged) !==
              entry.afterRevision
            ) {
              report.conflicts.push({
                transactionId: manifest.id,
                path: entry.path,
                reason: "staged-object-corrupt",
              });
              return "conflict";
            }
            const absolutePath =
              entry.kind === "create"
                ? await this.resolver.resolveForCreate(
                    entry.path,
                  )
                : await this.resolver.resolveExisting(
                    entry.path,
                  );
            const warnings =
              await this.atomicReplaceConfirmed(
                absolutePath,
                staged,
                expectedBefore,
                entry.path,
              );
            report.warnings.push(...warnings);
            report.rolledForwardTargets += 1;
            return "done";
          },
        ),
    );
  }

  private async atomicReplace(
    absolutePath: string,
    content: Buffer,
    expectedRevision: string | undefined,
    projectPath: string,
    progress: {
      destinationInstalled: boolean;
    },
  ): Promise<void> {
    const directory = dirname(absolutePath);
    const temporaryPath = join(
      directory,
      `.${basename(absolutePath)}.tiledmcp-${randomUUID()}.tmp`,
    );
    let mode = 0o600;
    try {
      mode = (await stat(absolutePath)).mode & 0o777;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    }

    let temporaryHandle: FileHandle | undefined;
    let temporaryCreated = false;
    try {
      temporaryHandle = await open(
        temporaryPath,
        "wx",
        mode,
      );
      temporaryCreated = true;
      await this.writeObserver
        ?.afterTemporaryFileOpened?.({
          projectPath,
        });
      await temporaryHandle.writeFile(content);
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;

      if (expectedRevision) {
        const current = await this.readBounded(absolutePath, projectPath);
        assertExpectedRevision(projectPath, expectedRevision, revisionOf(current));
      } else {
        try {
          await stat(absolutePath);
          throw new TiledMcpError(
            "FILE_ALREADY_EXISTS",
            `Refusing to overwrite existing file ${projectPath}.`,
            { path: projectPath },
          );
        } catch (error) {
          if (!hasCode(error, "ENOENT")) {
            throw error;
          }
        }
      }

      if (expectedRevision) {
        await rename(temporaryPath, absolutePath);
        progress.destinationInstalled = true;
      } else {
        try {
          // A hard link in the same directory gives creation no-replace
          // semantics. Unlike rename(), it fails if another process created the
          // destination after our final existence check.
          await link(temporaryPath, absolutePath);
        } catch (error) {
          if (hasCode(error, "EEXIST")) {
            throw new TiledMcpError(
              "FILE_ALREADY_EXISTS",
              `Refusing to overwrite existing file ${projectPath}.`,
              { path: projectPath },
            );
          }
          throw error;
        }
        progress.destinationInstalled = true;
        await unlink(temporaryPath);
      }
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await temporaryHandle
        ?.close()
        .catch(() => undefined);
      if (temporaryCreated) {
        await unlink(temporaryPath).catch(
          () => undefined,
        );
      }
      throw error;
    }
  }

  private async atomicReplaceConfirmed(
    absolutePath: string,
    content: Buffer,
    expectedRevision: string | undefined,
    projectPath: string,
  ): Promise<string[]> {
    const progress = {
      destinationInstalled: false,
    };
    try {
      await this.atomicReplace(
        absolutePath,
        content,
        expectedRevision,
        projectPath,
        progress,
      );
      return [];
    } catch (error) {
      if (!progress.destinationInstalled) {
        throw error;
      }
      try {
        const observed = await this.readBounded(absolutePath, projectPath);
        if (revisionOf(observed) === revisionOf(content)) {
          return [
            "The target contains the requested bytes, but a post-replace durability step failed; inspect filesystem health.",
          ];
        }
      } catch {
        // Preserve the original, more relevant error below.
      }
      throw error;
    }
  }

  private async markCheckpointBestEffort(
    checkpoint: CheckpointManifest,
  ): Promise<CheckpointFinalizationResult> {
    try {
      const committed =
        await this.checkpoints.markCommitted(
          checkpoint,
        );
      if (committed.status !== "committed") {
        throw new TiledMcpError(
          "CHECKPOINT_CHANGED",
          `Checkpoint ${checkpoint.id} did not reach its committed state.`,
          { checkpointId: checkpoint.id },
        );
      }
      return {
        committed:
          committed as CheckpointManifest & {
            status: "committed";
          },
        warnings: [],
      };
    } catch (error) {
      const normalized = asTiledMcpError(error);
      process.stderr.write(
        `tiled-mcp: checkpoint ${checkpoint.id} remains prepared: ${normalized.message}\n`,
      );
      if (!checkpoint.before.existed) {
        return {
          warnings: [
            `Checkpoint ${checkpoint.id} remains prepared; automatic reconciliation cannot prove who created the target, so inspect it manually: ${normalized.message}`,
          ],
        };
      }
      return {
        warnings: [
          `Checkpoint ${checkpoint.id} remains prepared and needs reconciliation: ${normalized.message}`,
        ],
      };
    }
  }

  private async enforcePostCommitRetention(
    committed: RollingCommittedCheckpointManifest,
    absolutePath: string,
    projectPath: string,
  ): Promise<{
    result: CheckpointRetentionResult;
    warnings: string[];
  }> {
    const retainCommittedPerTarget =
      this.checkpoints
        .retainCommittedPerTarget;
    if (
      retainCommittedPerTarget ===
      undefined
    ) {
      throw new Error(
        "Rolling retention cannot run while its policy is disabled.",
      );
    }
    try {
      const result =
        await this.checkpoints.enforceRollingRetention(
          committed,
          async () => {
            const current =
              await this.readBounded(
                absolutePath,
                projectPath,
              );
            assertExpectedRevision(
              projectPath,
              committed.afterRevision,
              revisionOf(current),
            );
          },
        );
      return {
        result,
        warnings:
          checkpointRetentionWarnings(
            result,
          ),
      };
    } catch {
      return {
        result: {
          policy:
            ROLLING_CHECKPOINT_RETENTION_POLICY,
          retainCommittedPerTarget,
          status: "failed",
          manifestDeleted: false,
          failureCode: "INTERNAL_ERROR",
        },
        warnings: [
          CHECKPOINT_RETENTION_FAILED_WARNING,
        ],
      };
    }
  }

  private async readBounded(absolutePath: string, projectPath: string): Promise<Buffer> {
    return readDocumentFileSnapshot(
      absolutePath,
      projectPath,
      this.maxDocumentBytes,
    );
  }

  private assertSize(content: Buffer, projectPath: string): void {
    if (content.byteLength > this.maxDocumentBytes) {
      throw new TiledMcpError(
        "DOCUMENT_TOO_LARGE",
        `${projectPath} exceeds the ${this.maxDocumentBytes} byte limit.`,
        { path: projectPath, size: content.byteLength, limit: this.maxDocumentBytes },
      );
    }
  }

  async readRevision(projectPath: string): Promise<string> {
    return (await this.readSnapshot(projectPath)).revision;
  }
}

/**
 * Reads a regular document from one file descriptor and rejects ordinary
 * in-place writers that change its identity or metadata during the read.
 * The optional observer exists for deterministic fault-injection tests.
 */
export async function readDocumentFileSnapshot(
  absolutePath: string,
  projectPath: string,
  maxBytes: number,
  observer?: DocumentReadObserver,
): Promise<Buffer> {
  return (
    await readDocumentFileSnapshotWithIdentity(
      absolutePath,
      projectPath,
      maxBytes,
      observer,
    )
  ).bytes;
}

function isRollingCommittedCheckpoint(
  manifest: CheckpointManifest & {
    status: "committed";
  },
): manifest is RollingCommittedCheckpointManifest {
  return (
    manifest.version === 2 &&
    manifest.retention?.class === "rolling"
  );
}

function checkpointRetentionWarnings(
  result: RollingCheckpointRetentionResult,
): string[] {
  if (result.status === "blocked") {
    return [
      CHECKPOINT_RETENTION_BLOCKED_WARNING,
    ];
  }
  if (
    result.status !== "deleted" ||
    result.garbageCollection.status ===
      "completed"
  ) {
    return [];
  }
  return [
    result.garbageCollection.status ===
    "blocked"
      ? CHECKPOINT_RETENTION_GC_BLOCKED_WARNING
      : CHECKPOINT_RETENTION_GC_FAILED_WARNING,
  ];
}

interface DocumentFileSnapshot {
  bytes: Buffer;
  identity: FileIdentity;
}

async function readDocumentFileSnapshotWithIdentity(
  absolutePath: string,
  projectPath: string,
  maxBytes: number,
  observer?: DocumentReadObserver,
): Promise<DocumentFileSnapshot> {
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
        `Refusing to follow symbolic link ${projectPath}.`,
        { path: projectPath },
      );
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${projectPath} is not a regular file.`,
        { path: projectPath },
      );
    }
    if (before.size > BigInt(maxBytes)) {
      throw new TiledMcpError(
        "DOCUMENT_TOO_LARGE",
        `${projectPath} exceeds the ${maxBytes} byte limit.`,
        {
          path: projectPath,
          size: boundedBigInt(before.size),
          limit: maxBytes,
        },
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
      if (total > maxBytes) {
        throw new TiledMcpError(
          "DOCUMENT_TOO_LARGE",
          `${projectPath} grew beyond the ${maxBytes} byte limit while being read.`,
          { path: projectPath, size: total, limit: maxBytes },
        );
      }
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
      await observer?.afterChunk?.({
        projectPath,
        chunkCount: chunks.length,
        totalBytes: total,
      });
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(before, after) || BigInt(total) !== after.size) {
      throw new TiledMcpError(
        "DOCUMENT_CHANGED_DURING_READ",
        `${projectPath} changed while it was being read. Retry the operation.`,
        { path: projectPath },
      );
    }
    return {
      bytes: Buffer.concat(chunks, total),
      identity: fileIdentityOf(after),
    };
  } finally {
    await handle.close();
  }
}

function boundedBigInt(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

function assertExpectedRevision(
  projectPath: string,
  expectedRevision: string,
  actualRevision: string,
): void {
  if (expectedRevision !== actualRevision) {
    throw new TiledMcpError(
      "REVISION_CONFLICT",
      `${projectPath} changed since it was read. Fetch it again before editing.`,
      { path: projectPath, expectedRevision, actualRevision },
    );
  }
}

function checkpointPruneExpectation(
  snapshot: CheckpointManifestSnapshot,
): CheckpointPruneExpectation {
  const manifest = snapshot.manifest;
  if (manifest.status !== "committed") {
    throw new TiledMcpError(
      "CHECKPOINT_NOT_COMMITTED",
      `Checkpoint ${manifest.id} is still prepared and cannot be pruned.`,
      { checkpointId: manifest.id },
    );
  }
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    ...(manifest.label.length === 0
      ? {}
      : { label: manifest.label }),
    path: manifest.path,
    status: "committed",
    before: copyCheckpointBefore(
      manifest.before,
    ),
    afterRevision: manifest.afterRevision,
    manifestRevision:
      snapshot.manifestRevision,
    manifestSize: snapshot.manifestSize,
  };
}

function checkpointBatchPruneExpectation(
  snapshot: CheckpointManifestSnapshot,
): CheckpointBatchPruneExpectation {
  const manifest = snapshot.manifest;
  if (manifest.status !== "committed") {
    throw new TiledMcpError(
      "CHECKPOINT_NOT_COMMITTED",
      `Checkpoint ${manifest.id} is still prepared and cannot be batch pruned.`,
      { checkpointId: manifest.id },
    );
  }
  return {
    id: manifest.id,
    version: manifest.version,
    createdAt: manifest.createdAt,
    ...(manifest.label.length === 0
      ? {}
      : { label: manifest.label }),
    path: manifest.path,
    status: "committed",
    before: copyCheckpointBefore(
      manifest.before,
    ),
    afterRevision: manifest.afterRevision,
    ...(manifest.retention === undefined
      ? {}
      : {
          retention: {
            ...manifest.retention,
          },
        }),
    manifestRevision:
      snapshot.manifestRevision,
    manifestSize: snapshot.manifestSize,
  };
}

function copyCheckpointBatchPruneExpectations(
  expectations: readonly CheckpointBatchPruneExpectation[],
): CheckpointBatchPruneExpectation[] {
  if (!Array.isArray(expectations)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "Checkpoint batch prune expectations must be an array.",
    );
  }
  return expectations.map((expected) => ({
    id: expected.id,
    version: expected.version,
    createdAt: expected.createdAt,
    ...(expected.label === undefined
      ? {}
      : { label: expected.label }),
    path: expected.path,
    status: expected.status,
    before: copyCheckpointBefore(
      expected.before,
    ),
    afterRevision: expected.afterRevision,
    ...(expected.retention === undefined
      ? {}
      : {
          retention: {
            ...expected.retention,
          },
        }),
    manifestRevision:
      expected.manifestRevision,
    manifestSize: expected.manifestSize,
  }));
}

function assertCheckpointBatchPruneExpectations(
  expectations: readonly CheckpointBatchPruneExpectation[],
): asserts expectations is CheckpointBatchPruneStorageExpectation[] {
  if (
    expectations.length <
      MIN_CHECKPOINT_BATCH_PRUNE_COUNT ||
    expectations.length >
      MAX_CHECKPOINT_BATCH_PRUNE_COUNT
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `Checkpoint batch prune requires from ${MIN_CHECKPOINT_BATCH_PRUNE_COUNT} through ${MAX_CHECKPOINT_BATCH_PRUNE_COUNT} checkpoints.`,
    );
  }
  const ids = new Set<string>();
  for (const expected of expectations) {
    const validRetention =
      (expected.version === 1 &&
        expected.retention ===
          undefined) ||
      (expected.version === 2 &&
        expected.retention !==
          undefined &&
        (expected.retention.class ===
          "protected" ||
          (expected.retention.class ===
            "rolling" &&
            Number.isSafeInteger(
              expected.retention.ordinal,
            ) &&
            expected.retention.ordinal >
              0)));
    if (
      !CHECKPOINT_ID_PATTERN.test(
        expected.id,
      ) ||
      expected.id !==
        expected.id.toLowerCase() ||
      ids.has(expected.id) ||
      expected.status !== "committed" ||
      !CHECKPOINT_MANIFEST_REVISION_PATTERN.test(
        expected.manifestRevision,
      ) ||
      !Number.isSafeInteger(
        expected.manifestSize,
      ) ||
      expected.manifestSize < 1 ||
      !validRetention
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "Checkpoint batch prune expectations are invalid.",
        { checkpointId: expected.id },
      );
    }
    ids.add(expected.id);
  }
}

function copyCheckpointPruneExpectation(
  expected: CheckpointPruneExpectation,
): CheckpointPruneExpectation {
  return {
    id: expected.id,
    createdAt: expected.createdAt,
    ...(expected.label === undefined
      ? {}
      : { label: expected.label }),
    path: expected.path,
    status: expected.status,
    before: copyCheckpointBefore(
      expected.before,
    ),
    afterRevision: expected.afterRevision,
    manifestRevision:
      expected.manifestRevision,
    manifestSize: expected.manifestSize,
  };
}

function copyCheckpointBefore(
  before: CheckpointManifest["before"],
): CheckpointManifest["before"] {
  if (!before.existed) {
    return { existed: false };
  }
  return {
    existed: true,
    revision: before.revision,
    objectHash: before.objectHash,
    size: before.size,
  };
}

function assertCheckpointPruneExpectation(
  expected: CheckpointPruneExpectation,
): asserts expected is CheckpointPruneStorageExpectation {
  if (
    expected.status !== "committed" ||
    !CHECKPOINT_MANIFEST_REVISION_PATTERN.test(
      expected.manifestRevision,
    ) ||
    !Number.isSafeInteger(
      expected.manifestSize,
    ) ||
    expected.manifestSize < 1
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "Checkpoint prune expectation is invalid.",
      { checkpointId: expected.id },
    );
  }
}

function checkpointPruneResult(
  storageResult: CheckpointPruneStorageResult,
): CheckpointPruneResult {
  const { manifest } = storageResult;
  const warnings: string[] = [];
  if (
    storageResult.garbageCollection.status ===
    "blocked"
  ) {
    warnings.push(
      CHECKPOINT_PRUNE_GC_BLOCKED_WARNING,
    );
  } else if (
    storageResult.garbageCollection.status ===
    "failed"
  ) {
    warnings.push(
      CHECKPOINT_PRUNE_GC_FAILED_WARNING,
    );
  }
  return {
    kind: "checkpointPrune",
    checkpoint: {
      id: manifest.id,
      createdAt: manifest.createdAt,
      ...(manifest.label.length === 0
        ? {}
        : { label: manifest.label }),
      path: manifest.path,
      status: "committed",
      before: copyCheckpointBefore(
        manifest.before,
      ),
      afterRevision:
        manifest.afterRevision,
    },
    manifestDeleted: true,
    garbageCollection:
      storageResult.garbageCollection,
    ...(warnings.length === 0
      ? {}
      : { warnings }),
  };
}

function addCheckpointPruneWarning(
  result: CheckpointPruneResult,
  warning: string,
): CheckpointPruneResult {
  return {
    ...result,
    warnings: [
      ...(result.warnings ?? []),
      warning,
    ],
  };
}

function addCheckpointBatchPruneWarning(
  result: CheckpointBatchPruneResult,
  warning: string,
): CheckpointBatchPruneResult {
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

function preparedCheckpointDiscardExpectation(
  snapshot: CheckpointManifestSnapshot,
  target: PreparedCheckpointDiscardTarget,
): PreparedCheckpointDiscardExpectation {
  const manifest = snapshot.manifest;
  if (manifest.status !== "prepared") {
    throw preparedCheckpointDiscardConflict(
      manifest,
      "Only prepared checkpoints can be safely discarded.",
    );
  }
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    ...(manifest.label.length === 0
      ? {}
      : { label: manifest.label }),
    path: manifest.path,
    status: "prepared",
    before: copyCheckpointBefore(
      manifest.before,
    ),
    afterRevision: manifest.afterRevision,
    manifestRevision:
      snapshot.manifestRevision,
    manifestSize: snapshot.manifestSize,
    target: copyPreparedCheckpointDiscardTarget(
      target,
    ),
  };
}

function copyPreparedCheckpointDiscardExpectation(
  expected: PreparedCheckpointDiscardExpectation,
): PreparedCheckpointDiscardExpectation {
  return {
    id: expected.id,
    createdAt: expected.createdAt,
    ...(expected.label === undefined
      ? {}
      : { label: expected.label }),
    path: expected.path,
    status: expected.status,
    before: copyCheckpointBefore(
      expected.before,
    ),
    afterRevision: expected.afterRevision,
    manifestRevision:
      expected.manifestRevision,
    manifestSize: expected.manifestSize,
    target:
      copyPreparedCheckpointDiscardTarget(
        expected.target,
      ),
  };
}

function copyPreparedCheckpointDiscardTarget(
  target: PreparedCheckpointDiscardTarget,
): PreparedCheckpointDiscardTarget {
  if (!target.existed) {
    return { existed: false };
  }
  return {
    existed: true,
    revision: target.revision,
    size: target.size,
  };
}

function assertPreparedCheckpointDiscardExpectation(
  expected: PreparedCheckpointDiscardExpectation,
): asserts expected is PreparedCheckpointDiscardExpectation &
  PreparedCheckpointDiscardStorageExpectation {
  const targetMatchesBefore =
    expected.before.existed ===
      expected.target.existed &&
    (!expected.before.existed ||
      (expected.target.existed &&
        expected.before.revision ===
          expected.target.revision &&
        expected.before.size ===
          expected.target.size &&
        expected.before.revision !==
          expected.afterRevision));
  const validTarget =
    !expected.target.existed ||
    (CHECKPOINT_MANIFEST_REVISION_PATTERN.test(
      expected.target.revision,
    ) &&
      Number.isSafeInteger(
        expected.target.size,
      ) &&
      expected.target.size >= 0);
  if (
    expected.status !== "prepared" ||
    !CHECKPOINT_MANIFEST_REVISION_PATTERN.test(
      expected.manifestRevision,
    ) ||
    !Number.isSafeInteger(
      expected.manifestSize,
    ) ||
    expected.manifestSize < 1 ||
    !validTarget ||
    !targetMatchesBefore
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "Prepared checkpoint discard expectation is invalid.",
      { checkpointId: expected.id },
    );
  }
}

function samePreparedCheckpointDiscardTarget(
  expected: PreparedCheckpointDiscardTarget,
  actual: PreparedCheckpointDiscardTarget,
): boolean {
  if (expected.existed !== actual.existed) {
    return false;
  }
  if (!expected.existed || !actual.existed) {
    return true;
  }
  return (
    expected.revision === actual.revision &&
    expected.size === actual.size
  );
}

function preparedCheckpointDiscardResult(
  storageResult: PreparedCheckpointDiscardStorageResult,
  target: PreparedCheckpointDiscardTarget,
): PreparedCheckpointDiscardResult {
  const { manifest } = storageResult;
  const warnings: string[] = [];
  if (
    storageResult.garbageCollection.status ===
    "blocked"
  ) {
    warnings.push(
      PREPARED_CHECKPOINT_DISCARD_GC_BLOCKED_WARNING,
    );
  } else if (
    storageResult.garbageCollection.status ===
    "failed"
  ) {
    warnings.push(
      PREPARED_CHECKPOINT_DISCARD_GC_FAILED_WARNING,
    );
  }
  return {
    kind: "preparedCheckpointDiscard",
    checkpoint: {
      id: manifest.id,
      createdAt: manifest.createdAt,
      ...(manifest.label.length === 0
        ? {}
        : { label: manifest.label }),
      path: manifest.path,
      status: "prepared",
      before: copyCheckpointBefore(
        manifest.before,
      ),
      afterRevision:
        manifest.afterRevision,
    },
    target:
      copyPreparedCheckpointDiscardTarget(
        target,
      ),
    manifestDeleted: true,
    garbageCollection:
      storageResult.garbageCollection,
    ...(warnings.length === 0
      ? {}
      : { warnings }),
  };
}

function addPreparedCheckpointDiscardWarning(
  result: PreparedCheckpointDiscardResult,
  warning: string,
): PreparedCheckpointDiscardResult {
  return {
    ...result,
    warnings: [
      ...(result.warnings ?? []),
      warning,
    ],
  };
}

function preparedCheckpointAdjudicationExpectation(
  snapshot: CheckpointManifestSnapshot,
  evidence: {
    target: PreparedCheckpointAdjudicationTarget;
    conflict: PreparedCheckpointAdjudicationConflict;
  },
): PreparedCheckpointAdjudicationExpectation {
  const manifest = snapshot.manifest;
  if (manifest.status !== "prepared") {
    throw preparedCheckpointAdjudicationConflict(
      manifest,
      "Only prepared checkpoints can be adjudicated.",
    );
  }
  return {
    version: manifest.version,
    ...(manifest.retention === undefined
      ? {}
      : {
          retention: copyCheckpointRetention(
            manifest.retention,
          ),
        }),
    id: manifest.id,
    createdAt: manifest.createdAt,
    ...(manifest.label.length === 0
      ? {}
      : { label: manifest.label }),
    path: manifest.path,
    status: "prepared",
    before: copyCheckpointBefore(
      manifest.before,
    ),
    afterRevision: manifest.afterRevision,
    manifestRevision:
      snapshot.manifestRevision,
    manifestSize: snapshot.manifestSize,
    target:
      copyPreparedCheckpointAdjudicationTarget(
        evidence.target,
      ),
    conflict: evidence.conflict,
  };
}

function copyPreparedCheckpointAdjudicationExpectation(
  expected: PreparedCheckpointAdjudicationExpectation,
): PreparedCheckpointAdjudicationExpectation {
  return {
    version: expected.version,
    ...(expected.retention === undefined
      ? {}
      : {
          retention: copyCheckpointRetention(
            expected.retention,
          ),
        }),
    id: expected.id,
    createdAt: expected.createdAt,
    ...(expected.label === undefined
      ? {}
      : { label: expected.label }),
    path: expected.path,
    status: expected.status,
    before: copyCheckpointBefore(
      expected.before,
    ),
    afterRevision: expected.afterRevision,
    manifestRevision:
      expected.manifestRevision,
    manifestSize: expected.manifestSize,
    target:
      copyPreparedCheckpointAdjudicationTarget(
        expected.target,
      ),
    conflict: expected.conflict,
  };
}

function copyCheckpointRetention(
  retention: NonNullable<
    CheckpointManifest["retention"]
  >,
): NonNullable<
  CheckpointManifest["retention"]
> {
  return retention.class === "protected"
    ? { class: "protected" }
    : {
        class: "rolling",
        ordinal: retention.ordinal,
      };
}

function copyPreparedCheckpointAdjudicationTarget(
  target: PreparedCheckpointAdjudicationTarget,
): PreparedCheckpointAdjudicationTarget {
  if (!target.existed) {
    return { existed: false };
  }
  return {
    existed: true,
    revision: target.revision,
    size: target.size,
  };
}

function assertPreparedCheckpointAdjudicationExpectation(
  expected: PreparedCheckpointAdjudicationExpectation,
  action: "commit" | "abandon",
): void {
  const validBefore =
    !expected.before.existed ||
    (CHECKPOINT_MANIFEST_REVISION_PATTERN.test(
      expected.before.revision,
    ) &&
      expected.before.revision ===
        `sha256:${expected.before.objectHash}` &&
      Number.isSafeInteger(
        expected.before.size,
      ) &&
      expected.before.size >= 0);
  const validTarget =
    !expected.target.existed ||
    (CHECKPOINT_MANIFEST_REVISION_PATTERN.test(
      expected.target.revision,
    ) &&
      Number.isSafeInteger(
        expected.target.size,
      ) &&
      expected.target.size >= 0);
  const validRetention =
    expected.version === 1
      ? expected.retention === undefined
      : expected.version === 2 &&
        expected.retention !== undefined &&
        (expected.retention.class ===
          "protected" ||
          (expected.retention.class ===
            "rolling" &&
            Number.isSafeInteger(
              expected.retention.ordinal,
            ) &&
            expected.retention.ordinal > 0));
  const validConflict =
    validPreparedCheckpointAdjudicationConflict(
      expected,
    );
  if (
    !CHECKPOINT_ID_PATTERN.test(
      expected.id,
    ) ||
    typeof expected.createdAt !== "string" ||
    (expected.label !== undefined &&
      typeof expected.label !== "string") ||
    typeof expected.path !== "string" ||
    expected.status !== "prepared" ||
    !validBefore ||
    !CHECKPOINT_MANIFEST_REVISION_PATTERN.test(
      expected.afterRevision,
    ) ||
    !CHECKPOINT_MANIFEST_REVISION_PATTERN.test(
      expected.manifestRevision,
    ) ||
    !Number.isSafeInteger(
      expected.manifestSize,
    ) ||
    expected.manifestSize < 1 ||
    !validTarget ||
    !validRetention ||
    !validConflict ||
    (action === "commit" &&
      expected.conflict !==
        "create-target-matches-after")
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `Prepared checkpoint ${action} expectation is invalid.`,
      { checkpointId: expected.id },
    );
  }
}

function validPreparedCheckpointAdjudicationConflict(
  expected: PreparedCheckpointAdjudicationExpectation,
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

function samePreparedCheckpointAdjudicationEvidence(
  expected: PreparedCheckpointAdjudicationExpectation,
  actual: {
    target: PreparedCheckpointAdjudicationTarget;
    conflict: PreparedCheckpointAdjudicationConflict;
  },
): boolean {
  return (
    expected.conflict === actual.conflict &&
    samePreparedCheckpointAdjudicationTarget(
      expected.target,
      actual.target,
    )
  );
}

function samePreparedCheckpointAdjudicationTarget(
  expected: PreparedCheckpointAdjudicationTarget,
  actual: PreparedCheckpointAdjudicationTarget,
): boolean {
  if (expected.existed !== actual.existed) {
    return false;
  }
  if (!expected.existed || !actual.existed) {
    return true;
  }
  return (
    expected.revision === actual.revision &&
    expected.size === actual.size
  );
}

function preparedCheckpointCommitResult(
  storageResult: PreparedCheckpointCommitStorageResult,
  expected: PreparedCheckpointAdjudicationExpectation,
): PreparedCheckpointCommitResult {
  const result: PreparedCheckpointCommitResult = {
    kind: "preparedCheckpointCommit",
    checkpoint:
      preparedCheckpointAdjudicationResultCheckpoint(
        storageResult.manifest,
      ),
    previousStatus:
      storageResult.previousStatus,
    target:
      copyPreparedCheckpointAdjudicationTarget(
        expected.target,
      ),
    conflict: "create-target-matches-after",
    manifestCommitted: true,
    projectAssetModified: false,
    durability: storageResult.durability,
  };
  return storageResult.durability ===
    "unconfirmed"
    ? addPreparedCheckpointCommitWarning(
        result,
        PREPARED_CHECKPOINT_COMMIT_DURABILITY_WARNING,
      )
    : result;
}

function preparedCheckpointAbandonResult(
  storageResult: PreparedCheckpointAbandonStorageResult,
  expected: PreparedCheckpointAdjudicationExpectation,
): PreparedCheckpointAbandonResult {
  const warnings: string[] = [];
  if (
    storageResult.garbageCollection.status ===
    "blocked"
  ) {
    warnings.push(
      PREPARED_CHECKPOINT_ABANDON_GC_BLOCKED_WARNING,
    );
  } else if (
    storageResult.garbageCollection.status ===
    "failed"
  ) {
    warnings.push(
      PREPARED_CHECKPOINT_ABANDON_GC_FAILED_WARNING,
    );
  }
  return {
    kind: "preparedCheckpointAbandon",
    checkpoint:
      preparedCheckpointAdjudicationResultCheckpoint(
        storageResult.manifest,
      ),
    target:
      copyPreparedCheckpointAdjudicationTarget(
        expected.target,
      ),
    conflict: expected.conflict,
    manifestDeleted: true,
    projectAssetModified: false,
    garbageCollection:
      storageResult.garbageCollection,
    ...(warnings.length === 0
      ? {}
      : { warnings }),
  };
}

function preparedCheckpointAdjudicationResultCheckpoint<
  TStatus extends "prepared" | "committed",
>(
  manifest: CheckpointManifest & {
    status: TStatus;
  },
): PreparedCheckpointAdjudicationResultCheckpoint & {
  status: TStatus;
} {
  return {
    version: manifest.version,
    ...(manifest.retention === undefined
      ? {}
      : {
          retention: copyCheckpointRetention(
            manifest.retention,
          ),
        }),
    id: manifest.id,
    createdAt: manifest.createdAt,
    ...(manifest.label.length === 0
      ? {}
      : { label: manifest.label }),
    path: manifest.path,
    status: manifest.status,
    before: copyCheckpointBefore(
      manifest.before,
    ),
    afterRevision: manifest.afterRevision,
  };
}

function addPreparedCheckpointCommitWarning(
  result: PreparedCheckpointCommitResult,
  warning: string,
): PreparedCheckpointCommitResult {
  if (result.warnings?.includes(warning)) {
    return {
      ...result,
      durability: "unconfirmed",
    };
  }
  return {
    ...result,
    durability: "unconfirmed",
    warnings: [
      ...(result.warnings ?? []),
      warning,
    ],
  };
}

function addPreparedCheckpointAbandonWarning(
  result: PreparedCheckpointAbandonResult,
  warning: string,
): PreparedCheckpointAbandonResult {
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

function preparedCheckpointDiscardConflict(
  manifest: CheckpointManifest,
  reason: string,
): TiledMcpError {
  return new TiledMcpError(
    "CHECKPOINT_STATE_CONFLICT",
    `Checkpoint ${manifest.id} is not eligible for safe prepared discard. ${reason}`,
    {
      checkpointId: manifest.id,
      path: manifest.path,
    },
  );
}

function preparedCheckpointAdjudicationConflict(
  checkpoint: {
    id: string;
    path: string;
  },
  reason: string,
): TiledMcpError {
  return new TiledMcpError(
    "CHECKPOINT_STATE_CONFLICT",
    `Checkpoint ${checkpoint.id} requires no supported prepared adjudication. ${reason}`,
    {
      checkpointId: checkpoint.id,
      path: checkpoint.path,
    },
  );
}

function preparedCheckpointAdjudicationChanged(
  manifest: CheckpointManifest,
  reason: string,
): TiledMcpError {
  return new TiledMcpError(
    "CHECKPOINT_CHANGED",
    `Checkpoint ${manifest.id} changed after prepared adjudication inspection. ${reason}`,
    {
      checkpointId: manifest.id,
      path: manifest.path,
    },
  );
}

function reconciliationOutcome(
  manifest: CheckpointManifest,
  outcome: CheckpointReconciliationOutcomeKind,
  currentRevision: string | null,
  reason: string,
  errorCode?: string,
): CheckpointReconciliationOutcome {
  return {
    checkpointId: manifest.id,
    path: manifest.path,
    outcome,
    currentRevision,
    reason,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function sameCheckpointIntent(
  expected: CheckpointManifest,
  actual: CheckpointManifest,
): boolean {
  if (
    expected.id !== actual.id ||
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

function sameCheckpointRestoreExpectation(
  expected: CheckpointRestoreExpectation,
  actual: CheckpointManifest,
): boolean {
  return (
    actual.before.existed &&
    (actual.status === expected.status ||
      (expected.status === "prepared" &&
        actual.status === "committed")) &&
    expected.id === actual.id &&
    expected.createdAt === actual.createdAt &&
    expected.label === actual.label &&
    expected.path === actual.path &&
    expected.afterRevision === actual.afterRevision &&
    expected.before.revision === actual.before.revision &&
    expected.before.objectHash === actual.before.objectHash &&
    expected.before.size === actual.before.size
  );
}

function checkpointRestoreExpectation(
  manifest: CheckpointManifest,
): CheckpointRestoreExpectation {
  if (!manifest.before.existed) {
    throw new TiledMcpError(
      "REVERT_WOULD_DELETE",
      "This checkpoint represents creation of a new file; deletion is not supported by the MVP.",
      { checkpointId: manifest.id, path: manifest.path },
    );
  }
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    label: manifest.label,
    path: manifest.path,
    status: manifest.status,
    afterRevision: manifest.afterRevision,
    before: {
      revision: manifest.before.revision,
      objectHash: manifest.before.objectHash,
      size: manifest.before.size,
    },
  };
}

function assertPreparedCheckpointRestoreState(
  manifest: CheckpointManifest,
  currentRevision: string,
): void {
  if (manifest.status !== "prepared") {
    return;
  }
  if (currentRevision === manifest.afterRevision) {
    return;
  }
  if (
    manifest.before.existed &&
    currentRevision === manifest.before.revision
  ) {
    throw new TiledMcpError(
      "CHECKPOINT_NOT_COMMITTED",
      `Checkpoint ${manifest.id} was prepared, but its write did not land.`,
      { checkpointId: manifest.id },
    );
  }
  throw new TiledMcpError(
    "CHECKPOINT_STATE_CONFLICT",
    `Checkpoint ${manifest.id} is prepared and the target has an unrelated revision.`,
    {
      checkpointId: manifest.id,
      currentRevision,
      afterRevision: manifest.afterRevision,
    },
  );
}

function errorCode(error: unknown): string {
  if (error instanceof TiledMcpError) {
    return error.code;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  ) {
    return (error as NodeJS.ErrnoException).code as string;
  }
  return asTiledMcpError(error).code;
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

function isMissingCode(code: string): boolean {
  return code === "FILE_NOT_FOUND" || code === "ENOENT";
}

async function writeFileDurably(
  path: string,
  content: Buffer,
): Promise<void> {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  const handle = await open(
    temporaryPath,
    "wx",
    0o600,
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  await syncDirectoryBestEffort(
    dirname(path),
  ).catch(() => {});
}

/**
 * Revision of a server-owned internal file, or `null` when it does not exist
 * yet. A missing file is the legitimate initial state for the tile-name
 * registry, so absence is a revision value rather than an error.
 */
async function readInternalFileRevision(
  path: string,
): Promise<string | null> {
  try {
    return revisionOf(await readFile(path));
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function syncDirectoryBestEffort(
  path: string,
): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function decodeUtf8Strict(content: Buffer, projectPath: string): string {
  const decoded = content.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(content)) {
    throw new TiledMcpError(
      "INVALID_JSON",
      `${projectPath} is not valid UTF-8.`,
      { path: projectPath },
    );
  }
  return decoded;
}

function validateCheckpointRestoreDocument(
  content: Buffer,
  projectPath: string,
  checkpointId: string,
): void {
  try {
    parseJsonDocument(
      decodeUtf8Strict(content, projectPath),
      projectPath,
    );
  } catch {
    throw new TiledMcpError(
      "CHECKPOINT_CORRUPT",
      `Checkpoint ${checkpointId} does not contain a valid safe JSON document.`,
      { checkpointId, path: projectPath },
    );
  }
}
