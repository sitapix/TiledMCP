import { createHash } from "node:crypto";
import { makeStore, wireProject } from "./support/project.js";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  stableJson,
  type JsonValue,
} from "../src/formats/json.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  applyCheckpointPrune,
  CHECKPOINT_PRUNE_GARBAGE_COLLECTION,
  CHECKPOINT_PRUNE_WARNING,
  checkpointPruneOperationPreview,
  planCheckpointPrune,
  type CheckpointPrunePlan,
} from "../src/storage/checkpointPrune.js";
import {
  applyCheckpointRestore,
  planCheckpointRestore,
} from "../src/storage/checkpointRestore.js";
import type { CheckpointManifest } from "../src/storage/checkpoints.js";
import { DocumentStore } from "../src/storage/documentStore.js";
import { withProjectFileLock } from "../src/storage/fileLock.js";
import { revisionOf } from "../src/storage/revision.js";

const TARGET_PATH = "maps/level.tmj";
const BEFORE = Buffer.from(
  '{"type":"map","version":"1.10","width":1,"state":"before"}\n',
  "utf8",
);
const AFTER = Buffer.from(
  '{"type":"map","version":"1.10","width":2,"state":"after"}\n',
  "utf8",
);
const NEXT = Buffer.from(
  '{"type":"map","version":"1.10","width":3,"state":"next"}\n',
  "utf8",
);
const PRUNE_PLAN_HASH_DOMAIN =
  "tiledmcp/checkpoint-prune-plan/v1\0";

describe("checkpoint prune planning and application", () => {
  let root: string;
  let resolver: ProjectPathResolver;
  let store: DocumentStore;

  beforeEach(async () => {
    root = await mkdtemp(
      join(tmpdir(), "tiledmcp-checkpoint-prune-"),
    );
    await mkdir(join(root, "maps"));
    ({ resolver, store } = await wireProject(root));
  });

  afterEach(async () => {
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  it("previews without mutation, then prunes a committed unique manifest and object", async () => {
    const checkpoint =
      await createCommittedCheckpoint(
        store,
        TARGET_PATH,
        BEFORE,
        "unique recovery point",
      );
    if (!checkpoint.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const manifestBytes = await readFile(
      manifestPath(checkpoint.id),
    );
    const objectHash =
      checkpoint.before.objectHash;
    const plan = await planCheckpointPrune(
      store,
      checkpoint.id,
    );

    expect(plan).toMatchObject({
      kind: "checkpointPrune",
      version: 1,
      checkpoint: {
        id: checkpoint.id,
        path: TARGET_PATH,
        status: "committed",
        manifestRevision:
          revisionOf(manifestBytes),
        manifestSize:
          manifestBytes.byteLength,
      },
      baseRevision:
        revisionOf(manifestBytes),
      summary: {
        operationCount: 1,
        destructive: true,
        checkpointId: checkpoint.id,
        targetPath: TARGET_PATH,
        status: "committed",
        manifestRevision:
          revisionOf(manifestBytes),
        manifestBytes:
          manifestBytes.byteLength,
        removesRecoveryPoint: true,
        removesProjectAsset: false,
        garbageCollection:
          CHECKPOINT_PRUNE_GARBAGE_COLLECTION,
        warning: CHECKPOINT_PRUNE_WARNING,
      },
    });
    expect(plan.id).toMatch(
      /^changeset:[0-9a-f]{64}$/u,
    );
    expect(
      checkpointPruneOperationPreview(plan),
    ).toEqual({
      type: "pruneCheckpoint",
      destructive: true,
      warning: CHECKPOINT_PRUNE_WARNING,
      checkpointId: checkpoint.id,
      targetPath: TARGET_PATH,
      status: "committed",
      manifestRevision:
        revisionOf(manifestBytes),
      manifestBytes:
        manifestBytes.byteLength,
      removesRecoveryPoint: true,
      removesProjectAsset: false,
      garbageCollection:
        CHECKPOINT_PRUNE_GARBAGE_COLLECTION,
    });
    expect(
      await readFile(manifestPath(checkpoint.id)),
    ).toEqual(manifestBytes);
    expect(await readFile(objectPath(objectHash))).toEqual(
      BEFORE,
    );

    const result = await applyCheckpointPrune(
      store,
      plan,
    );

    expect(result).toMatchObject({
      kind: "checkpointPrune",
      checkpoint: {
        id: checkpoint.id,
        path: TARGET_PATH,
        status: "committed",
      },
      manifestDeleted: true,
      garbageCollection: {
        status: "completed",
        deletedBytes: BEFORE.byteLength,
        deletedEntries: 1,
        deletedObjects: 1,
        deletedTemporaryFiles: 0,
        blockerCount: 0,
        blockers: [],
        blockersTruncated: false,
      },
    });
    expect(result.warnings).toBeUndefined();
    await expectMissing(
      manifestPath(checkpoint.id),
    );
    await expectMissing(objectPath(objectHash));
    await expectMissing(join(root, TARGET_PATH));
  });

  it("retains a shared object until the last committed manifest is pruned", async () => {
    const first = await createCommittedCheckpoint(
      store,
      "maps/first.tmj",
      BEFORE,
      "first shared root",
    );
    const second = await createCommittedCheckpoint(
      store,
      "maps/second.tmj",
      BEFORE,
      "second shared root",
    );
    if (
      !first.before.existed ||
      !second.before.existed
    ) {
      throw new Error(
        "Expected existing-file checkpoint fixtures.",
      );
    }
    expect(first.before.objectHash).toBe(
      second.before.objectHash,
    );
    const objectHash = first.before.objectHash;
    const firstPlan = await planCheckpointPrune(
      store,
      first.id,
    );
    const secondPlan = await planCheckpointPrune(
      store,
      second.id,
    );

    const firstResult =
      await applyCheckpointPrune(
        store,
        firstPlan,
      );

    expect(firstResult.garbageCollection).toEqual({
      status: "completed",
      deletedBytes: 0,
      deletedEntries: 0,
      deletedObjects: 0,
      deletedTemporaryFiles: 0,
      blockerCount: 0,
      blockers: [],
      blockersTruncated: false,
    });
    await expectMissing(manifestPath(first.id));
    expect(
      await readFile(manifestPath(second.id)),
    ).not.toHaveLength(0);
    expect(await readFile(objectPath(objectHash))).toEqual(
      BEFORE,
    );

    const secondResult =
      await applyCheckpointPrune(
        store,
        secondPlan,
      );

    expect(
      secondResult.garbageCollection,
    ).toMatchObject({
      status: "completed",
      deletedBytes: BEFORE.byteLength,
      deletedEntries: 1,
      deletedObjects: 1,
      deletedTemporaryFiles: 0,
      blockerCount: 0,
    });
    await expectMissing(manifestPath(second.id));
    await expectMissing(objectPath(objectHash));
    expect(await checkpointEntryNames()).toEqual([]);
    expect(await objectEntryNames()).toEqual([]);
  });

  it("prunes a committed create checkpoint without inventing an object blob or changing the asset", async () => {
    const created = await store.create(
      TARGET_PATH,
      {
        type: "map",
        version: "1.10",
        width: 1,
        height: 1,
      },
      "created map",
    );
    if (created.checkpointId === null) {
      throw new Error(
        "Expected create to publish a checkpoint.",
      );
    }
    const checkpoint = await store.checkpoints.read(
      created.checkpointId,
    );
    expect(checkpoint).toMatchObject({
      status: "committed",
      before: { existed: false },
    });
    expect(await objectEntryNames()).toEqual([]);
    const assetBytes = await readFile(
      join(root, TARGET_PATH),
    );
    const plan = await planCheckpointPrune(
      store,
      checkpoint.id,
    );

    const result = await applyCheckpointPrune(
      store,
      plan,
    );

    expect(result).toMatchObject({
      manifestDeleted: true,
      checkpoint: {
        id: checkpoint.id,
        before: { existed: false },
      },
      garbageCollection: {
        status: "completed",
        deletedBytes: 0,
        deletedEntries: 0,
        deletedObjects: 0,
        deletedTemporaryFiles: 0,
      },
    });
    await expectMissing(manifestPath(checkpoint.id));
    expect(await objectEntryNames()).toEqual([]);
    expect(
      await readFile(join(root, TARGET_PATH)),
    ).toEqual(assetBytes);
  });

  it("refuses to plan pruning a prepared checkpoint and preserves its recovery state", async () => {
    const prepared = await store.checkpoints.prepare(
      TARGET_PATH,
      BEFORE,
      revisionOf(AFTER),
      "prepared recovery point",
    );
    if (!prepared.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const manifestBytes = await readFile(
      manifestPath(prepared.id),
    );

    await expect(
      planCheckpointPrune(store, prepared.id),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_NOT_COMMITTED",
      details: {
        checkpointId: prepared.id,
      },
    });

    expect(
      await readFile(manifestPath(prepared.id)),
    ).toEqual(manifestBytes);
    expect(
      await readFile(
        objectPath(prepared.before.objectHash),
      ),
    ).toEqual(BEFORE);
  });

  it("prunes a committed manifest even when its referenced object is already missing", async () => {
    const checkpoint =
      await createCommittedCheckpoint(
        store,
        TARGET_PATH,
        BEFORE,
        "missing legacy object",
      );
    if (!checkpoint.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    await unlink(
      objectPath(checkpoint.before.objectHash),
    );

    const plan = await planCheckpointPrune(
      store,
      checkpoint.id,
    );
    const result = await applyCheckpointPrune(
      store,
      plan,
    );

    expect(result).toMatchObject({
      manifestDeleted: true,
      checkpoint: {
        id: checkpoint.id,
        before: {
          existed: true,
          objectHash:
            checkpoint.before.objectHash,
        },
      },
      garbageCollection: {
        status: "completed",
        deletedBytes: 0,
        deletedEntries: 0,
        deletedObjects: 0,
        deletedTemporaryFiles: 0,
        blockerCount: 0,
      },
    });
    await expectMissing(manifestPath(checkpoint.id));
  });

  it("rejects a raw manifest byte change before the first deletion", async () => {
    const checkpoint =
      await createCommittedCheckpoint(
        store,
        TARGET_PATH,
        BEFORE,
        "raw manifest CAS",
      );
    if (!checkpoint.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const plan = await planCheckpointPrune(
      store,
      checkpoint.id,
    );
    const originalBytes = await readFile(
      manifestPath(checkpoint.id),
    );
    const changedBytes = Buffer.from(
      `${JSON.stringify(
        JSON.parse(
          originalBytes.toString("utf8"),
        ),
      )}\n`,
      "utf8",
    );
    expect(changedBytes).not.toEqual(originalBytes);
    await writeFile(
      manifestPath(checkpoint.id),
      changedBytes,
    );

    await expect(
      applyCheckpointPrune(store, plan),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CHANGED",
      details: {
        checkpointId: checkpoint.id,
      },
    });

    expect(
      await readFile(manifestPath(checkpoint.id)),
    ).toEqual(changedBytes);
    expect(
      await readFile(
        objectPath(checkpoint.before.objectHash),
      ),
    ).toEqual(BEFORE);
  });

  it("uses the target lock shared by prune, restore, and document writes", async () => {
    await writeFile(
      join(root, TARGET_PATH),
      BEFORE,
    );
    const commit = await store.commitBytes(
      TARGET_PATH,
      revisionOf(BEFORE),
      AFTER,
      "fixture edit",
    );
    if (commit.checkpointId === null) {
      throw new Error(
        "Expected edit to publish a checkpoint.",
      );
    }
    const checkpoint = await store.checkpoints.read(
      commit.checkpointId,
    );
    if (!checkpoint.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const prunePlan = await planCheckpointPrune(
      store,
      checkpoint.id,
    );
    const restorePlan =
      await planCheckpointRestore(
        store,
        checkpoint.id,
        commit.revision,
      );
    const manifestBytes = await readFile(
      manifestPath(checkpoint.id),
    );

    await withProjectFileLock(
      resolver,
      TARGET_PATH,
      async () => {
        await expect(
          applyCheckpointPrune(
            store,
            prunePlan,
          ),
        ).rejects.toMatchObject({
          code: "FILE_LOCKED",
          details: { path: TARGET_PATH },
        });
        await expect(
          applyCheckpointRestore(
            store,
            restorePlan,
          ),
        ).rejects.toMatchObject({
          code: "FILE_LOCKED",
          details: { path: TARGET_PATH },
        });
        await expect(
          store.commitBytes(
            TARGET_PATH,
            commit.revision,
            NEXT,
            "concurrent write",
          ),
        ).rejects.toMatchObject({
          code: "FILE_LOCKED",
          details: { path: TARGET_PATH },
        });
      },
    );

    expect(
      await readFile(join(root, TARGET_PATH)),
    ).toEqual(AFTER);
    expect(
      await readFile(manifestPath(checkpoint.id)),
    ).toEqual(manifestBytes);
    expect(
      await readFile(
        objectPath(checkpoint.before.objectHash),
      ),
    ).toEqual(BEFORE);
  });

  it("commits the manifest deletion while incomplete inventory blocks all garbage collection", async () => {
    const checkpoint =
      await createCommittedCheckpoint(
        store,
        TARGET_PATH,
        BEFORE,
        "blocked cleanup",
      );
    if (!checkpoint.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const plan = await planCheckpointPrune(
      store,
      checkpoint.id,
    );
    const unknownName = "future-object-index.v2";
    const unknownBytes = Buffer.from(
      "unknown storage entry",
      "utf8",
    );
    await writeFile(
      join(objectsDirectory(), unknownName),
      unknownBytes,
    );

    const result = await applyCheckpointPrune(
      store,
      plan,
    );

    expect(result).toMatchObject({
      manifestDeleted: true,
      garbageCollection: {
        status: "blocked",
        deletedBytes: 0,
        deletedEntries: 0,
        deletedObjects: 0,
        deletedTemporaryFiles: 0,
        blockerCount: 1,
        blockersTruncated: false,
        blockers: [
          {
            directory: "objects",
            fileName: unknownName,
            reason: "unexpected-entry",
          },
        ],
      },
      warnings: [
        expect.stringContaining(
          "garbage collection was blocked",
        ),
      ],
    });
    await expectMissing(manifestPath(checkpoint.id));
    expect(
      await readFile(
        objectPath(checkpoint.before.objectHash),
      ),
    ).toEqual(BEFORE);
    expect(
      await readFile(
        join(objectsDirectory(), unknownName),
      ),
    ).toEqual(unknownBytes);
  });

  it("commits the manifest deletion but performs zero GC deletion when the scan limit makes inventory incomplete", async () => {
    const checkpoint =
      await createCommittedCheckpoint(
        store,
        TARGET_PATH,
        BEFORE,
        "scan-limited cleanup",
      );
    if (!checkpoint.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const orphan = Buffer.from(
      "second canonical object forces an incomplete scan",
      "utf8",
    );
    const orphanHash = createHash("sha256")
      .update(orphan)
      .digest("hex");
    await writeFile(objectPath(orphanHash), orphan);
    const constrained = makeStore(resolver, { maxDocumentBytes: 64 * 1024 * 1024, checkpointOptions: {
        maxEntries: 1,
      } });
    const plan = await planCheckpointPrune(
      constrained,
      checkpoint.id,
    );

    const result = await applyCheckpointPrune(
      constrained,
      plan,
    );

    expect(result).toMatchObject({
      manifestDeleted: true,
      garbageCollection: {
        status: "blocked",
        deletedBytes: 0,
        deletedEntries: 0,
        deletedObjects: 0,
        deletedTemporaryFiles: 0,
        blockerCount: 1,
        blockers: [
          {
            directory: "objects",
            reason: "scan-limit-exceeded",
          },
        ],
        blockersTruncated: false,
      },
    });
    await expectMissing(manifestPath(checkpoint.id));
    expect(
      await readFile(
        objectPath(checkpoint.before.objectHash),
      ),
    ).toEqual(BEFORE);
    expect(await readFile(objectPath(orphanHash))).toEqual(
      orphan,
    );
  });

  it("reports post-commit garbage collection failure without disguising the manifest deletion", async () => {
    const observedIds: string[] = [];
    const injected = new Error(
      "injected failure after manifest deletion",
    );
    const faultingStore = makeStore(resolver, { maxDocumentBytes: 64 * 1024 * 1024, checkpointOptions: {
        observer: {
          afterManifestDeletedBeforeGarbageCollection({
            checkpointId,
          }) {
            observedIds.push(checkpointId);
            throw injected;
          },
        },
      } });
    const checkpoint =
      await createCommittedCheckpoint(
        faultingStore,
        TARGET_PATH,
        BEFORE,
        "failed cleanup",
      );
    if (!checkpoint.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const plan = await planCheckpointPrune(
      faultingStore,
      checkpoint.id,
    );

    const result = await applyCheckpointPrune(
      faultingStore,
      plan,
    );

    expect(observedIds).toEqual([checkpoint.id]);
    expect(result).toMatchObject({
      manifestDeleted: true,
      garbageCollection: {
        status: "failed",
        failureCode: "INTERNAL_ERROR",
        deletionOutcome:
          "unknown-partial-or-none",
      },
      warnings: [
        expect.stringContaining(
          "post-delete durability or garbage collection could not be confirmed",
        ),
      ],
    });
    await expectMissing(manifestPath(checkpoint.id));
    expect(
      await readFile(
        objectPath(checkpoint.before.objectHash),
      ),
    ).toEqual(BEFORE);

    expect(
      await faultingStore.checkpoints.collectGarbage(),
    ).toMatchObject({
      deletedEntries: 1,
      deletedObjects: 1,
      blocked: false,
    });
    await expectMissing(
      objectPath(checkpoint.before.objectHash),
    );
  });

  it("reports failed store and target lock release after a committed prune", async () => {
    const locksDirectory = await resolver
      .ensureInternalDirectory(
        ".tiledmcp/locks",
      );
    let changedLockCount = 0;
    const releaseFaultStore = makeStore(resolver, { maxDocumentBytes: 64 * 1024 * 1024, checkpointOptions: {
        observer: {
          async afterManifestDeletedBeforeGarbageCollection() {
            const lockNames = (
              await readdir(locksDirectory)
            ).filter((name) =>
              name.endsWith(".lock"),
            );
            for (const [
              index,
              name,
            ] of lockNames.entries()) {
              const path = join(
                locksDirectory,
                name,
              );
              const record = JSON.parse(
                await readFile(path, "utf8"),
              ) as Record<string, unknown>;
              await writeFile(
                path,
                `${JSON.stringify({
                  ...record,
                  token: `replacement-owner-${index}`,
                })}\n`,
                "utf8",
              );
              changedLockCount += 1;
            }
          },
        },
      } });
    const checkpoint =
      await createCommittedCheckpoint(
        releaseFaultStore,
        TARGET_PATH,
        BEFORE,
        "failed lock release",
      );
    const plan = await planCheckpointPrune(
      releaseFaultStore,
      checkpoint.id,
    );
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    let result:
      | Awaited<
          ReturnType<
            typeof applyCheckpointPrune
          >
        >
      | undefined;
    try {
      result = await applyCheckpointPrune(
        releaseFaultStore,
        plan,
      );
    } finally {
      stderr.mockRestore();
    }

    expect(changedLockCount).toBe(2);
    expect(result).toMatchObject({
      manifestDeleted: true,
      garbageCollection: {
        status: "failed",
        failureCode: "INTERNAL_ERROR",
        deletionOutcome:
          "unknown-partial-or-none",
      },
      warnings: [
        expect.stringContaining(
          "post-delete durability or garbage collection could not be confirmed",
        ),
        expect.stringContaining(
          "release of its target lock could not be confirmed",
        ),
      ],
    });
    await expectMissing(manifestPath(checkpoint.id));
    expect(
      (await readdir(locksDirectory)).filter(
        (name) => name.endsWith(".lock"),
      ),
    ).toHaveLength(2);
  });

  it("rejects digest and independently re-digested summary tampering with zero deletion", async () => {
    const checkpoint =
      await createCommittedCheckpoint(
        store,
        TARGET_PATH,
        BEFORE,
        "tamper checks",
      );
    if (!checkpoint.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const plan = await planCheckpointPrune(
      store,
      checkpoint.id,
    );
    const manifestBytes = await readFile(
      manifestPath(checkpoint.id),
    );
    const digestTampered: CheckpointPrunePlan = {
      ...plan,
      id: `changeset:${"0".repeat(64)}`,
    };

    await expect(
      applyCheckpointPrune(
        store,
        digestTampered,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_CHANGE_SET",
      message:
        "The checkpoint prune change set digest is invalid.",
    });

    const summaryTampered: CheckpointPrunePlan = {
      ...plan,
      summary: {
        ...plan.summary,
        warning: `${plan.summary.warning} tampered`,
      },
    };
    summaryTampered.id =
      checkpointPrunePlanDigest(
        summaryTampered,
      );
    await expect(
      applyCheckpointPrune(
        store,
        summaryTampered,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_CHANGE_SET",
      message:
        "The checkpoint prune summary does not match its approved operation.",
    });

    expect(
      await readFile(manifestPath(checkpoint.id)),
    ).toEqual(manifestBytes);
    expect(
      await readFile(
        objectPath(checkpoint.before.objectHash),
      ),
    ).toEqual(BEFORE);
  });

  function checkpointsDirectory(): string {
    return join(
      root,
      ".tiledmcp",
      "checkpoints",
    );
  }

  function objectsDirectory(): string {
    return join(root, ".tiledmcp", "objects");
  }

  function manifestPath(
    checkpointId: string,
  ): string {
    return join(
      checkpointsDirectory(),
      `${checkpointId}.json`,
    );
  }

  function objectPath(objectHash: string): string {
    return join(objectsDirectory(), objectHash);
  }

  async function checkpointEntryNames(): Promise<string[]> {
    return (
      await readdir(checkpointsDirectory())
    ).sort();
  }

  async function objectEntryNames(): Promise<string[]> {
    return (
      await readdir(objectsDirectory())
    ).sort();
  }
});

async function createCommittedCheckpoint(
  store: DocumentStore,
  projectPath: string,
  before: Buffer,
  label: string,
): Promise<CheckpointManifest> {
  return store.checkpoints.markCommitted(
    await store.checkpoints.prepare(
      projectPath,
      before,
      revisionOf(AFTER),
      label,
    ),
  );
}

async function expectMissing(
  path: string,
): Promise<void> {
  await expect(stat(path)).rejects.toMatchObject({
    code: "ENOENT",
  });
}

function checkpointPrunePlanDigest(
  plan: CheckpointPrunePlan,
): string {
  const {
    id: originalId,
    ...unsignedPlan
  } = plan;
  void originalId;
  const canonical = stableJson(
    unsignedPlan as unknown as JsonValue,
  );
  return `changeset:${createHash("sha256")
    .update(PRUNE_PLAN_HASH_DOMAIN)
    .update(canonical)
    .digest("hex")}`;
}
