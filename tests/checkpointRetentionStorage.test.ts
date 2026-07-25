import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
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

import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  CheckpointStore,
  MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT,
  ROLLING_CHECKPOINT_RETENTION_POLICY,
  type CheckpointManifest,
  type RollingCommittedCheckpointManifest,
} from "../src/storage/checkpoints.js";
import { revisionOf } from "../src/storage/revision.js";

const TARGET = "maps/level.tmj";
const RETENTION_SEQUENCE =
  "checkpoint-retention-sequence.json";

describe("CheckpointStore rolling retention", () => {
  let root: string;
  let resolver: ProjectPathResolver;

  beforeEach(async () => {
    root = await mkdtemp(
      join(tmpdir(), "tiledmcp-retention-"),
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

  it("keeps legacy manifests by default and writes strict v2 protected/rolling manifests only when enabled", async () => {
    const before = state(0);
    const after = state(1);
    const legacy = await new CheckpointStore(
      resolver,
    ).prepare(
      TARGET,
      before,
      revisionOf(after),
      "legacy",
    );
    expect(legacy).toMatchObject({
      version: 1,
    });
    expect(legacy).not.toHaveProperty(
      "retention",
    );

    const store = retentionStore(2);
    const created = await store.prepare(
      "maps/create.tmj",
      undefined,
      revisionOf(after),
      "create",
    );
    const noOp = await store.prepare(
      "maps/no-op.tmj",
      before,
      revisionOf(before),
      "no-op",
    );
    const first = await committedEdit(
      store,
      "maps/first.tmj",
      before,
      after,
    );
    const second = await committedEdit(
      store,
      "maps/second.tmj",
      before,
      after,
    );

    expect(created).toMatchObject({
      version: 2,
      retention: { class: "protected" },
    });
    expect(noOp).toMatchObject({
      version: 2,
      retention: { class: "protected" },
    });
    expect(first.retention.ordinal).toBe(1);
    expect(second.retention.ordinal).toBe(2);
    expect(
      await readSequence(root),
    ).toEqual({
      version: 1,
      lastOrdinal: 2,
    });
  });

  it("validates the opt-in boundary against maxEntries", () => {
    expect(
      MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT,
    ).toBe(2);
    expect(
      () =>
        new CheckpointStore(resolver, {
          retainCommittedPerTarget: 1,
        }),
    ).toThrow(/from 2 through maxEntries/u);
    expect(
      () =>
        new CheckpointStore(resolver, {
          maxEntries: 3,
          retainCommittedPerTarget: 4,
        }),
    ).toThrow(/from 2 through maxEntries/u);
    expect(
      new CheckpointStore(resolver, {
        maxEntries: 3,
        retainCommittedPerTarget: 2,
      }).retainCommittedPerTarget,
    ).toBe(2);
  });

  it("bounds and recovers the fixed private sequence crash temporary", async () => {
    const store = retentionStore(2);
    const temporaryPath =
      `${sequencePath(root)}.tmp`;
    await mkdir(
      join(root, ".tiledmcp"),
      { recursive: true },
    );
    await writeFile(
      temporaryPath,
      '{"version":1',
      "utf8",
    );

    const committed = await committedEdit(
      store,
      TARGET,
      state(0),
      state(1),
    );
    expect(
      committed.retention.ordinal,
    ).toBe(1);
    await expect(
      access(temporaryPath),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readSequence(root)).toEqual({
      version: 1,
      lastOrdinal: 1,
    });
  });

  it("fails closed instead of unlinking an unsafe sequence temporary", async () => {
    const store = retentionStore(2);
    const temporaryPath =
      `${sequencePath(root)}.tmp`;
    await mkdir(
      join(root, ".tiledmcp"),
      { recursive: true },
    );
    await symlink(
      "untrusted-target",
      temporaryPath,
    );

    await expect(
      store.prepare(
        TARGET,
        state(0),
        revisionOf(state(1)),
        "unsafe control temporary",
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CORRUPT",
    });
    expect(
      (await lstat(temporaryPath))
        .isSymbolicLink(),
    ).toBe(true);
    await expect(
      access(sequencePath(root)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses ordinals rather than clocks and deletes at most one oldest rolling checkpoint per call", async () => {
    const store = retentionStore(2);
    const checkpoints =
      await committedChain(store, TARGET, 4);
    const dates = [
      "2099-01-01T00:00:00.000Z",
      "2001-01-01T00:00:00.000Z",
      "2088-01-01T00:00:00.000Z",
      "1999-01-01T00:00:00.000Z",
    ];
    for (
      let index = 0;
      index < checkpoints.length;
      index += 1
    ) {
      const checkpoint = checkpoints[index]!;
      await writeManifest(root, {
        ...checkpoint,
        createdAt: dates[index]!,
      });
    }
    const current =
      asRollingCommitted(
        await store.read(
          checkpoints.at(-1)!.id,
        ),
      );

    const firstResult =
      await store.enforceRollingRetention(
        current,
        async () => undefined,
      );
    expect(firstResult).toEqual({
      policy:
        ROLLING_CHECKPOINT_RETENTION_POLICY,
      retainCommittedPerTarget: 2,
      status: "deleted",
      manifestDeleted: true,
      deletedCheckpointId:
        checkpoints[0]!.id,
      rollingCommittedCountBefore: 4,
      garbageCollection:
        expect.objectContaining({
          status: "completed",
        }),
    });
    expect(
      await manifestExists(
        root,
        checkpoints[0]!.id,
      ),
    ).toBe(false);
    expect(
      await manifestExists(
        root,
        checkpoints[1]!.id,
      ),
    ).toBe(true);

    const secondResult =
      await store.enforceRollingRetention(
        current,
        async () => undefined,
      );
    expect(secondResult).toMatchObject({
      status: "deleted",
      deletedCheckpointId:
        checkpoints[1]!.id,
      rollingCommittedCountBefore: 3,
    });
    const finalResult =
      await store.enforceRollingRetention(
        current,
        async () => undefined,
      );
    expect(finalResult).toEqual({
      policy:
        ROLLING_CHECKPOINT_RETENTION_POLICY,
      retainCommittedPerTarget: 2,
      status: "not-needed",
      manifestDeleted: false,
      rollingCommittedCount: 2,
    });
  });

  it("never counts or deletes legacy and protected manifests", async () => {
    const shared = state(0);
    const legacyStore =
      new CheckpointStore(resolver);
    const legacy =
      await legacyStore.markCommitted(
        await legacyStore.prepare(
          "maps/legacy.tmj",
          shared,
          revisionOf(state(99)),
          "legacy protected root",
        ),
      );
    const store = retentionStore(2);
    const protectedCreate =
      await store.markCommitted(
        await store.prepare(
          TARGET,
          undefined,
          revisionOf(shared),
          "protected create",
        ),
      );
    const rolling =
      await committedChain(
        store,
        TARGET,
        3,
      );
    const sharedObject =
      legacy.before.existed
        ? legacy.before.objectHash
        : "";

    const result =
      await store.enforceRollingRetention(
        rolling.at(-1)!,
        async () => undefined,
      );
    expect(result).toMatchObject({
      status: "deleted",
      deletedCheckpointId:
        rolling[0]!.id,
      rollingCommittedCountBefore: 3,
    });
    expect(
      await manifestExists(root, legacy.id),
    ).toBe(true);
    expect(
      await manifestExists(
        root,
        protectedCreate.id,
      ),
    ).toBe(true);
    await expect(
      access(
        join(
          root,
          ".tiledmcp",
          "objects",
          sharedObject,
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("blocks without deletion when any prepared checkpoint exists for the target", async () => {
    const store = retentionStore(2);
    const rolling =
      await committedChain(
        store,
        TARGET,
        3,
      );
    const prepared = await store.prepare(
      TARGET,
      state(3),
      revisionOf(state(4)),
      "in flight",
    );

    const result =
      await store.enforceRollingRetention(
        rolling.at(-1)!,
        async () => undefined,
      );
    expect(result).toMatchObject({
      status: "blocked",
      manifestDeleted: false,
      reason:
        "prepared-checkpoint-present",
      rollingCommittedCount: 3,
    });
    expect(
      await manifestExists(
        root,
        rolling[0]!.id,
      ),
    ).toBe(true);
    expect(
      await manifestExists(
        root,
        prepared.id,
      ),
    ).toBe(true);
  });

  it("reports incomplete inventory even when the visible rolling count is at the floor", async () => {
    const store = retentionStore(2);
    const rolling =
      await committedChain(
        store,
        TARGET,
        2,
      );
    await writeFile(
      join(
        root,
        ".tiledmcp",
        "checkpoints",
        "unexpected-entry",
      ),
      "unsafe",
      "utf8",
    );

    const result =
      await store.enforceRollingRetention(
        rolling.at(-1)!,
        async () => undefined,
      );
    expect(result).toMatchObject({
      status: "blocked",
      manifestDeleted: false,
      reason: "incomplete-inventory",
      rollingCommittedCount: 2,
    });
    expect(
      await manifestExists(
        root,
        rolling[0]!.id,
      ),
    ).toBe(true);
  });

  it("verifies every referenced object by content before deleting", async () => {
    const store = retentionStore(2);
    const rolling =
      await committedChain(
        store,
        TARGET,
        3,
      );
    const oldest = rolling[0]!;
    if (!oldest.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint.",
      );
    }
    await writeFile(
      join(
        root,
        ".tiledmcp",
        "objects",
        oldest.before.objectHash,
      ),
      Buffer.from("corrupt", "utf8"),
    );

    const result =
      await store.enforceRollingRetention(
        rolling.at(-1)!,
        async () => undefined,
      );
    expect(result).toMatchObject({
      status: "blocked",
      manifestDeleted: false,
      reason:
        "object-verification-failed",
    });
    expect(
      await manifestExists(root, oldest.id),
    ).toBe(true);
  });

  it("blocks when exact target validation rejects the current after revision", async () => {
    const store = retentionStore(2);
    const rolling =
      await committedChain(
        store,
        TARGET,
        3,
      );
    let validatedRevision:
      | string
      | undefined;

    const result =
      await store.enforceRollingRetention(
        rolling.at(-1)!,
        async (current) => {
          validatedRevision =
            current.afterRevision;
          throw new Error(
            "target does not match",
          );
        },
      );
    expect(validatedRevision).toBe(
      rolling.at(-1)!.afterRevision,
    );
    expect(result).toMatchObject({
      status: "blocked",
      manifestDeleted: false,
      reason:
        "target-validation-failed",
    });
    expect(
      await manifestExists(
        root,
        rolling[0]!.id,
      ),
    ).toBe(true);
  });

  it("raw-and-metadata CAS blocks whitespace-only candidate drift after preflight", async () => {
    const store = retentionStore(2);
    const rolling =
      await committedChain(
        store,
        TARGET,
        3,
      );
    const oldest = rolling[0]!;

    const result =
      await store.enforceRollingRetention(
        rolling.at(-1)!,
        async () => {
          await writeFile(
            manifestPath(
              root,
              oldest.id,
            ),
            `${JSON.stringify(oldest)}\n`,
            "utf8",
          );
        },
      );
    expect(result).toMatchObject({
      status: "blocked",
      manifestDeleted: false,
      reason:
        "current-checkpoint-changed",
    });
    expect(
      await manifestExists(
        root,
        oldest.id,
      ),
    ).toBe(true);
  });

  it.each([
    {
      name: "missing",
      mutate: async (
        testRoot: string,
        _rolling: RollingCommittedCheckpointManifest[],
      ) => {
        await unlink(
          sequencePath(testRoot),
        );
      },
    },
    {
      name: "rolled back",
      mutate: async (
        testRoot: string,
        _rolling: RollingCommittedCheckpointManifest[],
      ) => {
        await writeSequence(testRoot, 1);
      },
    },
    {
      name: "overflowed",
      mutate: async (
        testRoot: string,
        _rolling: RollingCommittedCheckpointManifest[],
      ) => {
        await writeSequence(
          testRoot,
          Number.MAX_SAFE_INTEGER,
        );
      },
    },
    {
      name: "duplicate",
      mutate: async (
        testRoot: string,
        rolling: RollingCommittedCheckpointManifest[],
      ) => {
        await writeManifest(testRoot, {
          ...rolling[1]!,
          retention: {
            class: "rolling",
            ordinal:
              rolling[0]!.retention
                .ordinal,
          },
        });
      },
    },
  ])("blocks on $name sequence state", async ({
    mutate,
  }) => {
    const store = retentionStore(2);
    const rolling =
      await committedChain(
        store,
        TARGET,
        3,
      );
    await mutate(root, rolling);

    const result =
      await store.enforceRollingRetention(
        rolling.at(-1)!,
        async () => undefined,
      );
    expect(result).toMatchObject({
      status: "blocked",
      manifestDeleted: false,
      reason: "sequence-state-invalid",
    });
    expect(
      await manifestExists(
        root,
        rolling[0]!.id,
      ),
    ).toBe(true);
  });

  it("fails closed when a sequence disappears before the next rolling prepare", async () => {
    const store = retentionStore(2);
    await committedChain(store, TARGET, 1);
    await unlink(sequencePath(root));

    await expect(
      store.prepare(
        TARGET,
        state(1),
        revisionOf(state(2)),
        "must not reuse ordinal",
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CORRUPT",
    });
  });

  it("allows durable ordinal gaps left by a failed prepare", async () => {
    let failBeforeManifest = true;
    const store = new CheckpointStore(
      resolver,
      {
        retainCommittedPerTarget: 2,
        observer: {
          afterObjectPublishedBeforeManifest() {
            if (failBeforeManifest) {
              throw new Error(
                "injected pre-manifest failure",
              );
            }
          },
        },
      },
    );
    await expect(
      store.prepare(
        TARGET,
        state(0),
        revisionOf(state(1)),
        "consumes ordinal one",
      ),
    ).rejects.toThrow(
      "injected pre-manifest failure",
    );
    failBeforeManifest = false;
    const rolling =
      await committedChain(
        store,
        TARGET,
        3,
      );
    expect(
      rolling.map(
        ({ retention }) =>
          retention.ordinal,
      ),
    ).toEqual([2, 3, 4]);

    const result =
      await store.enforceRollingRetention(
        rolling.at(-1)!,
        async () => undefined,
      );
    expect(result).toMatchObject({
      status: "deleted",
      deletedCheckpointId:
        rolling[0]!.id,
      rollingCommittedCountBefore: 3,
    });
  });

  it("continues safely after an explicitly pruned ordinal leaves a lineage gap", async () => {
    const store = retentionStore(2);
    const rolling =
      await committedChain(
        store,
        TARGET,
        3,
      );
    const removed = rolling.at(-1)!;
    const snapshot =
      await store.inspectPrune(
        removed.id,
      );
    await store.pruneCommitted({
      id: removed.id,
      createdAt: removed.createdAt,
      label: removed.label,
      path: removed.path,
      status: "committed",
      before: removed.before,
      afterRevision:
        removed.afterRevision,
      manifestRevision:
        snapshot.manifestRevision,
      manifestSize:
        snapshot.manifestSize,
    });
    const newest = await committedEdit(
      store,
      TARGET,
      state(3),
      state(4),
    );
    expect(
      newest.retention.ordinal,
    ).toBe(4);

    const result =
      await store.enforceRollingRetention(
        newest,
        async () => undefined,
      );
    expect(result).toMatchObject({
      status: "deleted",
      deletedCheckpointId:
        rolling[0]!.id,
      rollingCommittedCountBefore: 3,
    });
  });

  it("retains an interleaved legacy checkpoint while continuing after retention is re-enabled", async () => {
    const enabled = retentionStore(2);
    const first = await committedEdit(
      enabled,
      TARGET,
      state(0),
      state(1),
    );
    const second = await committedEdit(
      enabled,
      TARGET,
      state(1),
      state(2),
    );
    const disabled =
      new CheckpointStore(resolver);
    const legacy =
      await disabled.markCommitted(
        await disabled.prepare(
          TARGET,
          state(2),
          revisionOf(state(3)),
          "retention disabled",
        ),
      );
    const newest = await committedEdit(
      enabled,
      TARGET,
      state(3),
      state(4),
    );
    expect(
      newest.retention.ordinal,
    ).toBe(3);

    const result =
      await enabled.enforceRollingRetention(
        newest,
        async () => undefined,
      );
    expect(result).toMatchObject({
      status: "deleted",
      deletedCheckpointId: first.id,
      rollingCommittedCountBefore: 3,
    });
    expect(
      await manifestExists(
        root,
        second.id,
      ),
    ).toBe(true);
    expect(
      await manifestExists(
        root,
        legacy.id,
      ),
    ).toBe(true);
  });

  it("blocks unsafe create/no-op rolling candidates", async () => {
    const store = retentionStore(2);
    const rolling =
      await committedChain(
        store,
        TARGET,
        3,
      );
    await writeManifest(root, {
      ...rolling[0]!,
      before: { existed: false },
    });

    const result =
      await store.enforceRollingRetention(
        rolling.at(-1)!,
        async () => undefined,
      );
    expect(result).toMatchObject({
      status: "blocked",
      reason: "unsafe-lineage",
      manifestDeleted: false,
    });
    expect(
      await manifestExists(
        root,
        rolling[0]!.id,
      ),
    ).toBe(true);
  });

  it("returns a committed deletion with failed GC after a post-unlink fault", async () => {
    let fault = false;
    const store = new CheckpointStore(
      resolver,
      {
        retainCommittedPerTarget: 2,
        observer: {
          afterManifestDeletedBeforeGarbageCollection() {
            if (fault) {
              throw new Error(
                "injected post-unlink fault",
              );
            }
          },
        },
      },
    );
    const rolling =
      await committedChain(
        store,
        TARGET,
        3,
      );
    fault = true;

    const result =
      await store.enforceRollingRetention(
        rolling.at(-1)!,
        async () => undefined,
      );
    expect(result).toEqual({
      policy:
        ROLLING_CHECKPOINT_RETENTION_POLICY,
      retainCommittedPerTarget: 2,
      status: "deleted",
      manifestDeleted: true,
      deletedCheckpointId:
        rolling[0]!.id,
      rollingCommittedCountBefore: 3,
      garbageCollection: {
        status: "failed",
        failureCode: "INTERNAL_ERROR",
        deletionOutcome:
          "unknown-partial-or-none",
      },
    });
    expect(
      await manifestExists(
        root,
        rolling[0]!.id,
      ),
    ).toBe(false);
  });

  it("preserves the committed deletion when the checkpoint-store lock release cannot be confirmed", async () => {
    const locksDirectory =
      await resolver.ensureInternalDirectory(
        ".tiledmcp/locks",
      );
    let changedLockCount = 0;
    const store = new CheckpointStore(
      resolver,
      {
        retainCommittedPerTarget: 2,
        observer: {
          async afterManifestDeletedBeforeGarbageCollection() {
            const lockNames = (
              await readdir(
                locksDirectory,
              )
            ).filter((name) =>
              name.endsWith(".lock"),
            );
            for (const name of lockNames) {
              const path = join(
                locksDirectory,
                name,
              );
              const record = JSON.parse(
                await readFile(
                  path,
                  "utf8",
                ),
              ) as Record<string, unknown>;
              await writeFile(
                path,
                `${JSON.stringify({
                  ...record,
                  token:
                    "replacement-owner",
                })}\n`,
                "utf8",
              );
              changedLockCount += 1;
            }
          },
        },
      },
    );
    const rolling =
      await committedChain(
        store,
        TARGET,
        3,
      );
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    let result:
      | Awaited<
          ReturnType<
            typeof store.enforceRollingRetention
          >
        >
      | undefined;
    try {
      result =
        await store.enforceRollingRetention(
          rolling.at(-1)!,
          async () => undefined,
        );
    } finally {
      stderr.mockRestore();
    }

    expect(changedLockCount).toBe(1);
    expect(result).toMatchObject({
      status: "deleted",
      manifestDeleted: true,
      deletedCheckpointId:
        rolling[0]!.id,
      garbageCollection: {
        status: "failed",
        failureCode: "INTERNAL_ERROR",
        deletionOutcome:
          "unknown-partial-or-none",
      },
    });
    expect(
      await manifestExists(
        root,
        rolling[0]!.id,
      ),
    ).toBe(false);
  });

  it("strictly rejects malformed v2 retention shapes", async () => {
    const store = retentionStore(2);
    const id = randomUUID();
    await mkdir(
      join(
        root,
        ".tiledmcp",
        "checkpoints",
      ),
      { recursive: true },
    );
    await writeFile(
      manifestPath(root, id),
      `${JSON.stringify({
        version: 2,
        id,
        createdAt:
          "2026-07-25T00:00:00.000Z",
        label: "malformed",
        path: TARGET,
        status: "committed",
        before: { existed: false },
        afterRevision:
          revisionOf(state(1)),
      })}\n`,
      "utf8",
    );

    await expect(
      store.read(id),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CORRUPT",
    });
  });

  function retentionStore(
    retainCommittedPerTarget: number,
  ): CheckpointStore {
    return new CheckpointStore(resolver, {
      retainCommittedPerTarget,
    });
  }
});

function state(index: number): Buffer {
  return Buffer.from(
    `${JSON.stringify({ state: index })}\n`,
    "utf8",
  );
}

async function committedEdit(
  store: CheckpointStore,
  path: string,
  before: Buffer,
  after: Buffer,
): Promise<RollingCommittedCheckpointManifest> {
  const committed =
    await store.markCommitted(
      await store.prepare(
        path,
        before,
        revisionOf(after),
        `edit ${path}`,
      ),
    );
  return asRollingCommitted(committed);
}

async function committedChain(
  store: CheckpointStore,
  path: string,
  length: number,
): Promise<
  RollingCommittedCheckpointManifest[]
> {
  const manifests: RollingCommittedCheckpointManifest[] =
    [];
  for (
    let index = 0;
    index < length;
    index += 1
  ) {
    manifests.push(
      await committedEdit(
        store,
        path,
        state(index),
        state(index + 1),
      ),
    );
  }
  return manifests;
}

function asRollingCommitted(
  manifest: CheckpointManifest,
): RollingCommittedCheckpointManifest {
  if (
    manifest.version !== 2 ||
    manifest.retention?.class !==
      "rolling" ||
    manifest.status !== "committed"
  ) {
    throw new Error(
      "Expected a committed rolling checkpoint.",
    );
  }
  return manifest as RollingCommittedCheckpointManifest;
}

function sequencePath(root: string): string {
  return join(
    root,
    ".tiledmcp",
    RETENTION_SEQUENCE,
  );
}

async function readSequence(
  root: string,
): Promise<unknown> {
  return JSON.parse(
    await readFile(
      sequencePath(root),
      "utf8",
    ),
  ) as unknown;
}

async function writeSequence(
  root: string,
  lastOrdinal: number,
): Promise<void> {
  await writeFile(
    sequencePath(root),
    `${JSON.stringify({
      version: 1,
      lastOrdinal,
    })}\n`,
    "utf8",
  );
}

function manifestPath(
  root: string,
  id: string,
): string {
  return join(
    root,
    ".tiledmcp",
    "checkpoints",
    `${id}.json`,
  );
}

async function writeManifest(
  root: string,
  manifest: CheckpointManifest,
): Promise<void> {
  await writeFile(
    manifestPath(root, manifest.id),
    `${JSON.stringify(
      manifest,
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function manifestExists(
  root: string,
  id: string,
): Promise<boolean> {
  try {
    await access(manifestPath(root, id));
    return true;
  } catch {
    return false;
  }
}
