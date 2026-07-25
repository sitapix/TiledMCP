import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
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
} from "vitest";

import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  CHECKPOINT_BATCH_PRUNE_DURABILITY_WARNING,
  CHECKPOINT_BATCH_PRUNE_GC_BLOCKED_WARNING,
  CHECKPOINT_BATCH_PRUNE_STORE_LOCK_WARNING,
  CHECKPOINT_STORAGE_LOCK_TARGET,
  type CheckpointManifest,
} from "../src/storage/checkpoints.js";
import {
  CHECKPOINT_BATCH_PRUNE_TARGET_LOCK_WARNING,
  DocumentStore,
} from "../src/storage/documentStore.js";
import { withProjectFileLock } from "../src/storage/fileLock.js";
import {
  revisionOf,
  shortHash,
} from "../src/storage/revision.js";

const TARGET_A = "maps/a.tmj";
const TARGET_B = "maps/b.tmj";
const TARGET_C = "maps/c.tmj";

describe("checkpoint committed batch prune storage", () => {
  let root: string;
  let resolver: ProjectPathResolver;

  beforeEach(async () => {
    root = await mkdtemp(
      join(
        tmpdir(),
        "tiledmcp-checkpoint-batch-prune-",
      ),
    );
    await mkdir(join(root, "maps"));
    resolver =
      await ProjectPathResolver.create(root);
  });

  afterEach(async () => {
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  it("requires 2..32 unique canonical lowercase UUIDs and all committed manifests", async () => {
    const store = documentStore();
    const committed =
      await committedCheckpoint(
        store,
        TARGET_A,
        state(0),
        state(1),
      );
    const prepared =
      await store.checkpoints.prepare(
        TARGET_B,
        state(1),
        revisionOf(state(2)),
        "prepared",
      );

    await expect(
      store.inspectCheckpointBatchPrune([
        committed.id,
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      store.inspectCheckpointBatchPrune([
        committed.id,
        committed.id,
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      store.inspectCheckpointBatchPrune([
        committed.id.toUpperCase(),
        prepared.id,
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      store.inspectCheckpointBatchPrune(
        Array.from(
          { length: 33 },
          () => randomUUID(),
        ),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      store.inspectCheckpointBatchPrune([
        committed.id,
        prepared.id,
      ]),
    ).rejects.toMatchObject({
      code:
        "CHECKPOINT_NOT_COMMITTED",
    });
  });

  it("pins once, executes in canonical checkpoint-id order, and garbage collects shared content once", async () => {
    const store = documentStore();
    const shared = state(0);
    const checkpoints = [
      await committedCheckpoint(
        store,
        TARGET_A,
        shared,
        state(1),
      ),
      await committedCheckpoint(
        store,
        TARGET_B,
        shared,
        state(2),
      ),
      await committedCheckpoint(
        store,
        TARGET_C,
        state(3),
        state(4),
      ),
    ];
    const sharedHash =
      checkpoints[0]!.before.existed
        ? checkpoints[0]!.before
            .objectHash
        : "";
    const inspection =
      await store.inspectCheckpointBatchPrune(
        checkpoints
          .map(({ id }) => id)
          .reverse(),
      );
    const orderedIds = checkpoints
      .map(({ id }) => id)
      .sort(compareCanonicalText);

    expect(inspection).toMatchObject({
      kind: "checkpointPruneBatch",
    });
    expect(
      inspection.checkpoints.map(
        ({ id }) => id,
      ),
    ).toEqual(orderedIds);

    const result =
      await store.pruneCheckpointBatchPlanned(
        [...inspection.checkpoints].reverse(),
      );
    expect(result).toMatchObject({
      kind: "checkpointPruneBatch",
      status: "completed",
      replayDisposition:
        "cached-final-no-resume",
      requestedCheckpointCount: 3,
      manifestDeletedCount: 3,
      unresolvedCheckpointCount: 0,
      garbageCollection: {
        status: "completed",
      },
    });
    expect(
      result.outcomes.map(
        ({ checkpointId }) =>
          checkpointId,
      ),
    ).toEqual(orderedIds);
    expect(result.outcomes).toEqual(
      orderedIds.map((checkpointId) =>
        expect.objectContaining({
          checkpointId,
          outcome: "deleted",
          manifestDeleted: true,
          durability: "confirmed",
        }),
      ),
    );
    await expect(
      access(
        join(
          root,
          ".tiledmcp",
          "objects",
          sharedHash,
        ),
      ),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("includes v2 retention metadata in the all-pin CAS and deletes nothing on drift", async () => {
    const store = documentStore({
      retainCommittedPerTarget: 2,
    });
    const first =
      await committedCheckpoint(
        store,
        TARGET_A,
        state(0),
        state(1),
      );
    const second =
      await committedCheckpoint(
        store,
        TARGET_B,
        state(2),
        state(3),
      );
    const inspection =
      await store.inspectCheckpointBatchPrune(
        [first.id, second.id],
      );
    const tampered =
      inspection.checkpoints.map(
        (expected, index) => {
          if (
            index !== 1 ||
            expected.retention?.class !==
              "rolling"
          ) {
            return expected;
          }
          return {
            ...expected,
            retention: {
              class: "rolling" as const,
              ordinal:
                expected.retention
                  .ordinal + 100,
            },
          };
        },
      );

    await expect(
      store.pruneCheckpointBatchPlanned(
        tampered,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CHANGED",
    });
    expect(
      await manifestExists(root, first.id),
    ).toBe(true);
    expect(
      await manifestExists(root, second.id),
    ).toBe(true);
  });

  it("deletes nothing when a later manifest has raw-only byte drift after preview", async () => {
    const store = documentStore();
    const checkpoints = [
      await committedCheckpoint(
        store,
        TARGET_A,
        state(0),
        state(1),
      ),
      await committedCheckpoint(
        store,
        TARGET_B,
        state(2),
        state(3),
      ),
    ];
    const inspection =
      await store.inspectCheckpointBatchPrune(
        checkpoints.map(({ id }) => id),
      );
    const later =
      inspection.checkpoints[1]!;
    const laterPath = manifestPath(
      root,
      later.id,
    );
    const raw = await readFile(
      laterPath,
      "utf8",
    );
    expect(raw.endsWith("\n")).toBe(true);
    const rawOnlyDrift =
      `${raw.slice(0, -1)} `;
    expect(
      Buffer.byteLength(rawOnlyDrift),
    ).toBe(Buffer.byteLength(raw));
    await writeFile(
      laterPath,
      rawOnlyDrift,
      "utf8",
    );
    expect(
      await store.checkpoints.read(later.id),
    ).toMatchObject({
      id: later.id,
      status: "committed",
    });

    await expect(
      store.pruneCheckpointBatchPlanned(
        inspection.checkpoints,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CHANGED",
    });
    expect(
      await manifestExists(
        root,
        inspection.checkpoints[0]!.id,
      ),
    ).toBe(true);
    expect(
      await manifestExists(root, later.id),
    ).toBe(true);
  });

  it("deletes nothing when a later manifest disappears after preview", async () => {
    const store = documentStore();
    const checkpoints = [
      await committedCheckpoint(
        store,
        TARGET_A,
        state(0),
        state(1),
      ),
      await committedCheckpoint(
        store,
        TARGET_B,
        state(2),
        state(3),
      ),
    ];
    const inspection =
      await store.inspectCheckpointBatchPrune(
        checkpoints.map(({ id }) => id),
      );
    const first =
      inspection.checkpoints[0]!;
    const later =
      inspection.checkpoints[1]!;
    await unlink(
      manifestPath(root, later.id),
    );

    await expect(
      store.pruneCheckpointBatchPlanned(
        inspection.checkpoints,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_NOT_FOUND",
    });
    expect(
      await manifestExists(root, first.id),
    ).toBe(true);
    expect(
      await manifestExists(root, later.id),
    ).toBe(false);
  });

  it("stops after the first unconfirmed unlink and retains later manifests without running GC", async () => {
    let faultCount = 0;
    const store = documentStore(
      undefined,
      {
        afterBatchManifestUnlinkedBeforeDirectorySync() {
          faultCount += 1;
          throw new Error(
            "injected pre-directory-sync fault",
          );
        },
      },
    );
    const checkpoints = [
      await committedCheckpoint(
        store,
        TARGET_A,
        state(0),
        state(1),
      ),
      await committedCheckpoint(
        store,
        TARGET_B,
        state(2),
        state(3),
      ),
    ];
    const inspection =
      await store.inspectCheckpointBatchPrune(
        checkpoints.map(({ id }) => id),
      );
    const first =
      inspection.checkpoints[0]!;
    if (!first.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint.",
      );
    }

    const result =
      await store.pruneCheckpointBatchPlanned(
        inspection.checkpoints,
      );
    expect(faultCount).toBe(1);
    expect(result).toMatchObject({
      status: "partial",
      requestedCheckpointCount: 2,
      manifestDeletedCount: 1,
      unresolvedCheckpointCount: 1,
      outcomes: [
        {
          checkpointId: first.id,
          path: first.path,
          outcome: "deleted",
          manifestDeleted: true,
          durability: "unconfirmed",
        },
        {
          checkpointId:
            inspection.checkpoints[1]!.id,
          path:
            inspection.checkpoints[1]!.path,
          outcome: "not-attempted",
          reason:
            "batch-stopped-before-checkpoint",
        },
      ],
      garbageCollection: {
        status: "not-run",
        reason:
          "batch-stopped-before-garbage-collection",
      },
      warnings: expect.arrayContaining([
        CHECKPOINT_BATCH_PRUNE_DURABILITY_WARNING,
      ]),
    });
    expect(
      await manifestExists(root, first.id),
    ).toBe(false);
    expect(
      await manifestExists(
        root,
        inspection.checkpoints[1]!.id,
      ),
    ).toBe(true);
    await expect(
      access(
        join(
          root,
          ".tiledmcp",
          "objects",
          first.before.objectHash,
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("stops at the first pre-unlink failure after a deleted prefix and never runs GC", async () => {
    let firstDeletedId:
      | string
      | undefined;
    let nextManifestPath:
      | string
      | undefined;
    const store = documentStore(
      undefined,
      {
        async afterManifestDeletedBeforeGarbageCollection(
          { checkpointId },
        ) {
          if (
            checkpointId ===
              firstDeletedId &&
            nextManifestPath !==
              undefined
          ) {
            await unlink(nextManifestPath);
          }
        },
      },
    );
    const checkpoints = [
      await committedCheckpoint(
        store,
        TARGET_A,
        state(0),
        state(1),
      ),
      await committedCheckpoint(
        store,
        TARGET_B,
        state(1),
        state(2),
      ),
      await committedCheckpoint(
        store,
        TARGET_C,
        state(2),
        state(3),
      ),
    ];
    const inspection =
      await store.inspectCheckpointBatchPrune(
        checkpoints.map(({ id }) => id),
      );
    firstDeletedId =
      inspection.checkpoints[0]!.id;
    nextManifestPath = manifestPath(
      root,
      inspection.checkpoints[1]!.id,
    );

    const result =
      await store.pruneCheckpointBatchPlanned(
        inspection.checkpoints,
      );
    expect(result).toMatchObject({
      status: "partial",
      requestedCheckpointCount: 3,
      manifestDeletedCount: 1,
      unresolvedCheckpointCount: 2,
      garbageCollection: {
        status: "not-run",
        reason:
          "batch-stopped-before-garbage-collection",
      },
    });
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        checkpointId:
          inspection.checkpoints[0]!
            .id,
        outcome: "deleted",
        manifestDeleted: true,
        durability: "confirmed",
      }),
      expect.objectContaining({
        checkpointId:
          inspection.checkpoints[1]!
            .id,
        outcome: "failed",
        failureCode:
          "INTERNAL_ERROR",
      }),
      expect.objectContaining({
        checkpointId:
          inspection.checkpoints[2]!
            .id,
        outcome: "not-attempted",
      }),
    ]);
    expect(
      await manifestExists(
        root,
        inspection.checkpoints[2]!.id,
      ),
    ).toBe(true);
  });

  it("keeps completed status and reports failed GC when the last post-unlink observer faults", async () => {
    let callbackCount = 0;
    const store = documentStore(
      undefined,
      {
        afterManifestDeletedBeforeGarbageCollection() {
          callbackCount += 1;
          if (callbackCount === 2) {
            throw new Error(
              "injected final post-unlink fault",
            );
          }
        },
      },
    );
    const checkpoints = [
      await committedCheckpoint(
        store,
        TARGET_A,
        state(0),
        state(1),
      ),
      await committedCheckpoint(
        store,
        TARGET_B,
        state(1),
        state(2),
      ),
    ];
    const inspection =
      await store.inspectCheckpointBatchPrune(
        checkpoints.map(({ id }) => id),
      );

    const result =
      await store.pruneCheckpointBatchPlanned(
        inspection.checkpoints,
      );
    expect(result).toMatchObject({
      status: "completed",
      manifestDeletedCount: 2,
      unresolvedCheckpointCount: 0,
      garbageCollection: {
        status: "failed",
        failureCode: "INTERNAL_ERROR",
      },
    });
    expect(
      result.outcomes.every(
        (outcome) =>
          outcome.outcome ===
            "deleted" &&
          outcome.durability ===
            "confirmed",
      ),
    ).toBe(true);
  });

  it("does not require selected checkpoint blobs to exist before explicit deletion", async () => {
    const store = documentStore();
    const checkpoints = [
      await committedCheckpoint(
        store,
        TARGET_A,
        state(0),
        state(1),
      ),
      await committedCheckpoint(
        store,
        TARGET_B,
        state(2),
        state(3),
      ),
    ];
    const missingHash =
      checkpoints[0]!.before.existed
        ? checkpoints[0]!.before
            .objectHash
        : "";
    await unlink(
      join(
        root,
        ".tiledmcp",
        "objects",
        missingHash,
      ),
    );
    const inspection =
      await store.inspectCheckpointBatchPrune(
        checkpoints.map(({ id }) => id),
      );

    const result =
      await store.pruneCheckpointBatchPlanned(
        inspection.checkpoints,
      );
    expect(result).toMatchObject({
      status: "completed",
      manifestDeletedCount: 2,
      garbageCollection: {
        status: "completed",
      },
    });
  });

  it("preserves completed deletion facts when final GC is blocked by an unselected missing root", async () => {
    const store = documentStore();
    const selected = [
      await committedCheckpoint(
        store,
        TARGET_A,
        state(0),
        state(1),
      ),
      await committedCheckpoint(
        store,
        TARGET_B,
        state(2),
        state(3),
      ),
    ];
    const retained =
      await committedCheckpoint(
        store,
        TARGET_C,
        state(4),
        state(5),
      );
    if (!retained.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint.",
      );
    }
    await unlink(
      join(
        root,
        ".tiledmcp",
        "objects",
        retained.before.objectHash,
      ),
    );
    const inspection =
      await store.inspectCheckpointBatchPrune(
        selected.map(({ id }) => id),
      );

    const result =
      await store.pruneCheckpointBatchPlanned(
        inspection.checkpoints,
      );
    expect(result).toMatchObject({
      status: "completed",
      manifestDeletedCount: 2,
      unresolvedCheckpointCount: 0,
      garbageCollection: {
        status: "blocked",
      },
      warnings: expect.arrayContaining([
        CHECKPOINT_BATCH_PRUNE_GC_BLOCKED_WARNING,
      ]),
    });
    expect(
      await manifestExists(root, retained.id),
    ).toBe(true);
  });

  it("acquires every sorted target lock before entering the store and deletes nothing when a later lock is unavailable", async () => {
    const store = documentStore();
    const checkpoints = [
      await committedCheckpoint(
        store,
        TARGET_A,
        state(0),
        state(1),
      ),
      await committedCheckpoint(
        store,
        TARGET_B,
        state(1),
        state(2),
      ),
    ];
    const inspection =
      await store.inspectCheckpointBatchPrune(
        checkpoints.map(({ id }) => id),
      );

    await withProjectFileLock(
      resolver,
      TARGET_B,
      async () => {
        await expect(
          store.pruneCheckpointBatchPlanned(
            inspection.checkpoints,
          ),
        ).rejects.toMatchObject({
          code: "FILE_LOCKED",
        });
      },
    );
    expect(
      await manifestExists(
        root,
        checkpoints[0]!.id,
      ),
    ).toBe(true);
    expect(
      await manifestExists(
        root,
        checkpoints[1]!.id,
      ),
    ).toBe(true);
  });

  it("serializes concurrent reversed multi-target batches without a lock cycle", async () => {
    const store = documentStore();
    const checkpoints = [
      await committedCheckpoint(
        store,
        TARGET_A,
        state(0),
        state(1),
      ),
      await committedCheckpoint(
        store,
        TARGET_B,
        state(2),
        state(3),
      ),
    ];
    const inspection =
      await store.inspectCheckpointBatchPrune(
        checkpoints.map(({ id }) => id),
      );

    const settled = await Promise.allSettled([
      store.pruneCheckpointBatchPlanned(
        inspection.checkpoints,
      ),
      store.pruneCheckpointBatchPlanned(
        [...inspection.checkpoints].reverse(),
      ),
    ]);
    const fulfilled = settled.filter(
      (
        outcome,
      ): outcome is PromiseFulfilledResult<
        Awaited<
          ReturnType<
            DocumentStore["pruneCheckpointBatchPlanned"]
          >
        >
      > => outcome.status === "fulfilled",
    );
    const rejected = settled.filter(
      (
        outcome,
      ): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value).toMatchObject({
      status: "completed",
      manifestDeletedCount: 2,
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({
      code: "CHECKPOINT_NOT_FOUND",
    });
    for (const checkpoint of checkpoints) {
      expect(
        await manifestExists(
          root,
          checkpoint.id,
        ),
      ).toBe(false);
    }
  });

  it("folds checkpoint-store lock release failure after deletion into a fixed warning", async () => {
    let corrupted = false;
    const store = documentStore(
      undefined,
      {
        async afterManifestDeletedBeforeGarbageCollection() {
          if (!corrupted) {
            corrupted = true;
            await writeFile(
              lockPath(
                root,
                CHECKPOINT_STORAGE_LOCK_TARGET,
              ),
              "corrupt\n",
              "utf8",
            );
          }
        },
      },
    );
    const checkpoints = [
      await committedCheckpoint(
        store,
        TARGET_A,
        state(0),
        state(1),
      ),
      await committedCheckpoint(
        store,
        TARGET_B,
        state(1),
        state(2),
      ),
    ];
    const inspection =
      await store.inspectCheckpointBatchPrune(
        checkpoints.map(({ id }) => id),
      );

    const result =
      await store.pruneCheckpointBatchPlanned(
        inspection.checkpoints,
      );
    expect(result).toMatchObject({
      status: "completed",
      manifestDeletedCount: 2,
      warnings: expect.arrayContaining([
        CHECKPOINT_BATCH_PRUNE_STORE_LOCK_WARNING,
      ]),
    });
  });

  it("folds target lock release failure after deletion without changing completed status", async () => {
    let corrupted = false;
    const store = documentStore(
      undefined,
      {
        async afterManifestDeletedBeforeGarbageCollection() {
          if (!corrupted) {
            corrupted = true;
            await writeFile(
              lockPath(root, TARGET_A),
              "corrupt\n",
              "utf8",
            );
          }
        },
      },
    );
    const checkpoints = [
      await committedCheckpoint(
        store,
        TARGET_A,
        state(0),
        state(1),
      ),
      await committedCheckpoint(
        store,
        TARGET_B,
        state(1),
        state(2),
      ),
    ];
    const inspection =
      await store.inspectCheckpointBatchPrune(
        checkpoints.map(({ id }) => id),
      );

    const result =
      await store.pruneCheckpointBatchPlanned(
        inspection.checkpoints,
      );
    expect(result).toMatchObject({
      status: "completed",
      manifestDeletedCount: 2,
      warnings: expect.arrayContaining([
        CHECKPOINT_BATCH_PRUNE_TARGET_LOCK_WARNING,
      ]),
    });
  });

  function documentStore(
    checkpointOptions?: {
      retainCommittedPerTarget?: number;
    },
    observer?: {
      afterBatchManifestUnlinkedBeforeDirectorySync?(
        context: {
          checkpointId: string;
        },
      ): void | Promise<void>;
      afterManifestDeletedBeforeGarbageCollection?(
        context: {
          checkpointId: string;
        },
      ): void | Promise<void>;
    },
  ): DocumentStore {
    return new DocumentStore(
      resolver,
      undefined,
      undefined,
      {
        ...checkpointOptions,
        ...(observer === undefined
          ? {}
          : { observer }),
      },
    );
  }
});

function state(index: number): Buffer {
  return Buffer.from(
    `${JSON.stringify({ state: index })}\n`,
    "utf8",
  );
}

async function committedCheckpoint(
  store: DocumentStore,
  path: string,
  before: Buffer,
  after: Buffer,
): Promise<
  CheckpointManifest & {
    status: "committed";
  }
> {
  return (await store.checkpoints.markCommitted(
    await store.checkpoints.prepare(
      path,
      before,
      revisionOf(after),
      `checkpoint ${path}`,
    ),
  )) as CheckpointManifest & {
    status: "committed";
  };
}

function manifestPath(
  root: string,
  checkpointId: string,
): string {
  return join(
    root,
    ".tiledmcp",
    "checkpoints",
    `${checkpointId}.json`,
  );
}

async function manifestExists(
  root: string,
  checkpointId: string,
): Promise<boolean> {
  try {
    await access(
      manifestPath(root, checkpointId),
    );
    return true;
  } catch {
    return false;
  }
}

function lockPath(
  root: string,
  target: string,
): string {
  return join(
    root,
    ".tiledmcp",
    "locks",
    `${shortHash(target)}.lock`,
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
