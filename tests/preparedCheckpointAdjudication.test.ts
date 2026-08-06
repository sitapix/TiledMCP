import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { makeStore } from "./support/project.js";
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
  ChangeSetRegistry,
  type ChangeSetPlan,
} from "../src/changeSets.js";
import { TiledMcpError } from "../src/errors.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  applyPreparedCheckpointAbandon,
  applyPreparedCheckpointCommit,
  planPreparedCheckpointAbandon,
  planPreparedCheckpointCommit,
  preparedCheckpointAbandonOperationPreview,
  preparedCheckpointCommitEvidenceRevision,
  preparedCheckpointCommitOperationPreview,
} from "../src/storage/preparedCheckpointAdjudication.js";
import { DocumentStore } from "../src/storage/documentStore.js";
import { revisionOf } from "../src/storage/revision.js";

describe("prepared checkpoint adjudication protocol", () => {
  let root: string;
  let store: DocumentStore;

  beforeEach(async () => {
    root = await mkdtemp(
      join(
        tmpdir(),
        "tiledmcp-prepared-adjudication-",
      ),
    );
    await mkdir(join(root, "maps"));
    const resolver =
      await ProjectPathResolver.create(root);
    store = makeStore(resolver, { checkpointOptions: {
        retainCommittedPerTarget: 2,
      } });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  it("binds full v2 manifest and target evidence to separate commit and abandon approvals", async () => {
    const projectPath =
      "maps/ambiguous-create.tmj";
    const absolutePath = join(
      root,
      projectPath,
    );
    const after = jsonBytes({
      type: "map",
      width: 3,
    });
    const prepared =
      await store.checkpoints.prepare(
        projectPath,
        undefined,
        revisionOf(after),
        "ambiguous create",
      );
    await writeFile(absolutePath, after);

    const commit =
      await planPreparedCheckpointCommit(
        store,
        prepared.id,
      );
    const abandon =
      await planPreparedCheckpointAbandon(
        store,
        prepared.id,
      );

    expect(commit.checkpoint).toMatchObject({
      id: prepared.id,
      version: 2,
      retention: {
        class: "protected",
      },
      status: "prepared",
      before: { existed: false },
      afterRevision: revisionOf(after),
      target: {
        existed: true,
        revision: revisionOf(after),
        size: after.byteLength,
      },
      conflict:
        "create-target-matches-after",
      manifestRevision:
        expect.stringMatching(
          /^sha256:[0-9a-f]{64}$/u,
        ),
      manifestSize: expect.any(Number),
    });
    expect(commit.baseRevision).toBe(
      preparedCheckpointCommitEvidenceRevision(
        commit.checkpoint,
      ),
    );
    expect(commit.baseRevision).not.toBe(
      commit.checkpoint.manifestRevision,
    );
    expect(abandon.baseRevision).not.toBe(
      commit.baseRevision,
    );
    expect(
      preparedCheckpointCommitOperationPreview(
        commit,
      ),
    ).toMatchObject({
      type: "commitPreparedCheckpoint",
      destructive: false,
      operatorDecisionRequired: true,
      commitsCheckpointRecord: true,
      projectAssetModified: false,
      garbageCollection: "not-run",
    });

    const applied =
      await applyPreparedCheckpointCommit(
        store,
        commit,
      );
    expect(applied).toMatchObject({
      kind: "preparedCheckpointCommit",
      checkpoint: {
        id: prepared.id,
        version: 2,
        retention: {
          class: "protected",
        },
        status: "committed",
      },
      previousStatus: "prepared",
      target: {
        existed: true,
        revision: revisionOf(after),
        size: after.byteLength,
      },
      conflict:
        "create-target-matches-after",
      manifestCommitted: true,
      projectAssetModified: false,
      durability: "confirmed",
    });
    expect(await readFile(absolutePath)).toEqual(
      after,
    );
    expect(
      await store.checkpoints.read(prepared.id),
    ).toMatchObject({
      status: "committed",
      before: { existed: false },
      afterRevision: revisionOf(after),
    });
  });

  it.each([
    {
      name: "create exact-after",
      conflict:
        "create-target-matches-after",
      before: undefined,
      target: "after" as const,
    },
    {
      name: "create unrelated",
      conflict: "create-target-unrelated",
      before: undefined,
      target: "unrelated" as const,
    },
    {
      name: "existing target missing",
      conflict: "existing-target-missing",
      before: "before" as const,
      target: "missing" as const,
    },
    {
      name: "existing target unrelated",
      conflict: "existing-target-unrelated",
      before: "before" as const,
      target: "unrelated" as const,
    },
  ])(
    "abandons $name evidence without modifying the project asset",
    async ({
      name,
      conflict,
      before: beforeKind,
      target,
    }) => {
      const slug = name.replaceAll(" ", "-");
      const projectPath = `maps/${slug}.tmj`;
      const absolutePath = join(
        root,
        projectPath,
      );
      const before = jsonBytes({
        type: "map",
        state: "before",
        slug,
      });
      const after = jsonBytes({
        type: "map",
        state: "after",
        slug,
      });
      const unrelated = jsonBytes({
        type: "map",
        state: "unrelated",
        slug,
      });
      if (beforeKind === "before") {
        await writeFile(absolutePath, before);
      }
      const prepared =
        await store.checkpoints.prepare(
          projectPath,
          beforeKind === "before"
            ? before
            : undefined,
          revisionOf(after),
          name,
        );
      if (target === "missing") {
        await unlink(absolutePath);
      } else {
        await writeFile(
          absolutePath,
          target === "after"
            ? after
            : unrelated,
        );
      }

      const plan =
        await planPreparedCheckpointAbandon(
          store,
          prepared.id,
        );
      expect(plan.checkpoint.conflict).toBe(
        conflict,
      );
      expect(
        preparedCheckpointAbandonOperationPreview(
          plan,
        ),
      ).toMatchObject({
        type: "abandonPreparedCheckpoint",
        destructive: true,
        operatorDecisionRequired: true,
        removesRecoveryPoint: true,
        projectAssetModified: false,
        garbageCollection:
          "fail-closed-after-prepared-manifest-abandon",
        warning: expect.stringContaining(
          "permanently deletes",
        ),
      });

      const result =
        await applyPreparedCheckpointAbandon(
          store,
          plan,
        );
      expect(result).toMatchObject({
        kind: "preparedCheckpointAbandon",
        checkpoint: {
          id: prepared.id,
          status: "prepared",
        },
        conflict,
        manifestDeleted: true,
        projectAssetModified: false,
        garbageCollection: {
          status: "completed",
        },
      });
      await expect(
        store.checkpoints.read(prepared.id),
      ).rejects.toMatchObject({
        code: "CHECKPOINT_NOT_FOUND",
      });
      if (target === "missing") {
        await expect(
          readFile(absolutePath),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(
          await readFile(absolutePath),
        ).toEqual(
          target === "after"
            ? after
            : unrelated,
        );
      }
    },
  );

  it("rejects machine-reconcilable states and malformed plan fields", async () => {
    const createPath =
      "maps/safe-create.tmj";
    const createAfter = jsonBytes({
      type: "map",
      safe: "missing",
    });
    const safeCreate =
      await store.checkpoints.prepare(
        createPath,
        undefined,
        revisionOf(createAfter),
        "safe create",
      );
    await expect(
      planPreparedCheckpointAbandon(
        store,
        safeCreate.id,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_STATE_CONFLICT",
    });

    const existingPath =
      "maps/existing-before.tmj";
    const existingAbsolute = join(
      root,
      existingPath,
    );
    const before = jsonBytes({
      type: "map",
      safe: "before",
    });
    const after = jsonBytes({
      type: "map",
      safe: "after",
    });
    await writeFile(existingAbsolute, before);
    const safeExisting =
      await store.checkpoints.prepare(
        existingPath,
        before,
        revisionOf(after),
        "safe existing",
      );
    await expect(
      planPreparedCheckpointAbandon(
        store,
        safeExisting.id,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_STATE_CONFLICT",
    });
    await expect(
      planPreparedCheckpointCommit(
        store,
        safeExisting.id,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_STATE_CONFLICT",
    });

    const ambiguousPath =
      "maps/malformed-plan.tmj";
    const ambiguousAbsolute = join(
      root,
      ambiguousPath,
    );
    const ambiguousAfter = jsonBytes({
      type: "map",
      ambiguous: true,
    });
    const ambiguous =
      await store.checkpoints.prepare(
        ambiguousPath,
        undefined,
        revisionOf(ambiguousAfter),
        "malformed plan",
      );
    await writeFile(
      ambiguousAbsolute,
      ambiguousAfter,
    );
    const plan =
      await planPreparedCheckpointCommit(
        store,
        ambiguous.id,
      );
    const malformed = structuredClone(
      plan,
    ) as typeof plan & {
      unexpected?: boolean;
    };
    malformed.unexpected = true;
    expect(() =>
      preparedCheckpointCommitOperationPreview(
        malformed,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CHANGE_SET",
      }),
    );
  });

  it("does not cache drift failures but caches the first successful adjudication result", async () => {
    const projectPath =
      "maps/retry-abandon.tmj";
    const absolutePath = join(
      root,
      projectPath,
    );
    const after = jsonBytes({
      type: "map",
      intended: true,
    });
    const unrelated = jsonBytes({
      type: "map",
      external: true,
    });
    const prepared =
      await store.checkpoints.prepare(
        projectPath,
        undefined,
        revisionOf(after),
        "retry abandon",
      );
    await writeFile(absolutePath, unrelated);
    const plan =
      await planPreparedCheckpointAbandon(
        store,
        prepared.id,
      );
    const registry = new ChangeSetRegistry();
    const preview = registry.put(plan);
    let calls = 0;
    const operation = async (
      candidate: ChangeSetPlan,
    ) => {
      calls += 1;
      if (calls === 1) {
        throw new TiledMcpError(
          "CHECKPOINT_CHANGED",
          "simulated evidence drift",
        );
      }
      if (
        candidate.kind !==
        "preparedCheckpointAbandon"
      ) {
        throw new Error(
          "Expected an abandon plan.",
        );
      }
      return applyPreparedCheckpointAbandon(
        store,
        candidate,
      );
    };

    await expect(
      registry.apply(
        preview.changeSetId,
        preview.expectedRevision,
        operation,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CHANGED",
    });
    const applied = await registry.apply(
      preview.changeSetId,
      preview.expectedRevision,
      operation,
    );
    const replayed = await registry.apply(
      preview.changeSetId,
      preview.expectedRevision,
      operation,
    );
    expect(replayed).toEqual(applied);
    expect(calls).toBe(2);
  });

  it("caches a bounded unconfirmed commit result exactly and invokes storage only once", async () => {
    const resolver =
      await ProjectPathResolver.create(root);
    const committedIds: string[] = [];
    const faultingStore = makeStore(resolver, { maxDocumentBytes: 64 * 1024 * 1024, checkpointOptions: {
        observer: {
          afterPreparedCheckpointCommitInstalledBeforeDirectorySync({
            checkpointId,
          }) {
            committedIds.push(checkpointId);
            throw new Error(
              "injected post-rename fault",
            );
          },
        },
      } });
    const projectPath =
      "maps/cached-unconfirmed-commit.tmj";
    const absolutePath = join(
      root,
      projectPath,
    );
    const after = jsonBytes({
      type: "map",
      committed: "unconfirmed",
    });
    const prepared =
      await faultingStore.checkpoints.prepare(
        projectPath,
        undefined,
        revisionOf(after),
        "cached unconfirmed commit",
      );
    await writeFile(absolutePath, after);
    const plan =
      await planPreparedCheckpointCommit(
        faultingStore,
        prepared.id,
      );
    const registry = new ChangeSetRegistry();
    const preview = registry.put(plan);
    const storageApply = vi.spyOn(
      faultingStore,
      "commitPreparedCheckpointPlanned",
    );
    const operation = async (
      candidate: ChangeSetPlan,
    ) => {
      if (
        candidate.kind !==
        "preparedCheckpointCommit"
      ) {
        throw new Error(
          "Expected a commit plan.",
        );
      }
      return applyPreparedCheckpointCommit(
        faultingStore,
        candidate,
      );
    };

    const applied = await registry.apply(
      preview.changeSetId,
      preview.expectedRevision,
      operation,
    );
    const replayed = await registry.apply(
      preview.changeSetId,
      preview.expectedRevision,
      operation,
    );

    expect(applied).toMatchObject({
      changeSetId: preview.changeSetId,
      kind: "preparedCheckpointCommit",
      manifestCommitted: true,
      durability: "unconfirmed",
      warnings: [
        expect.stringContaining(
          "post-rename durability could not be confirmed",
        ),
      ],
    });
    expect(replayed).toBe(applied);
    expect(replayed).toStrictEqual(applied);
    expect(storageApply).toHaveBeenCalledTimes(1);
    expect(committedIds).toEqual([prepared.id]);
    expect(await readFile(absolutePath)).toEqual(
      after,
    );
  });

  it.each([
    {
      mode: "failed" as const,
      expectedStatus: "failed" as const,
    },
    {
      mode: "blocked" as const,
      expectedStatus: "blocked" as const,
    },
  ])(
    "caches a bounded $mode abandon result exactly and invokes storage only once",
    async ({ mode, expectedStatus }) => {
      const resolver =
        await ProjectPathResolver.create(root);
      const deletedIds: string[] = [];
      const faultingStore = makeStore(resolver, { maxDocumentBytes: 64 * 1024 * 1024, checkpointOptions: {
          ...(mode === "failed"
            ? {
                observer: {
                  afterManifestDeletedBeforeGarbageCollection({
                    checkpointId,
                  }: {
                    checkpointId: string;
                  }) {
                    deletedIds.push(
                      checkpointId,
                    );
                    throw new Error(
                      "injected post-unlink fault",
                    );
                  },
                },
              }
            : {}),
        } });
      const projectPath =
        `maps/cached-${mode}-abandon.tmj`;
      const absolutePath = join(
        root,
        projectPath,
      );
      const after = jsonBytes({
        type: "map",
        intended: true,
      });
      const unrelated = jsonBytes({
        type: "map",
        external: mode,
      });
      const prepared =
        await faultingStore.checkpoints.prepare(
          projectPath,
          undefined,
          revisionOf(after),
          `cached ${mode} abandon`,
        );
      await writeFile(absolutePath, unrelated);
      const plan =
        await planPreparedCheckpointAbandon(
          faultingStore,
          prepared.id,
        );
      if (mode === "blocked") {
        await writeFile(
          join(
            root,
            ".tiledmcp",
            "objects",
            "future-object-index.v2",
          ),
          "unknown storage entry",
        );
      }
      const registry = new ChangeSetRegistry();
      const preview = registry.put(plan);
      const storageApply = vi.spyOn(
        faultingStore,
        "abandonPreparedCheckpointPlanned",
      );
      const operation = async (
        candidate: ChangeSetPlan,
      ) => {
        if (
          candidate.kind !==
          "preparedCheckpointAbandon"
        ) {
          throw new Error(
            "Expected an abandon plan.",
          );
        }
        return applyPreparedCheckpointAbandon(
          faultingStore,
          candidate,
        );
      };

      const applied = await registry.apply(
        preview.changeSetId,
        preview.expectedRevision,
        operation,
      );
      const replayed = await registry.apply(
        preview.changeSetId,
        preview.expectedRevision,
        operation,
      );

      expect(applied).toMatchObject({
        changeSetId: preview.changeSetId,
        kind: "preparedCheckpointAbandon",
        manifestDeleted: true,
        projectAssetModified: false,
        garbageCollection: {
          status: expectedStatus,
        },
        warnings: [
          expect.stringContaining(
            mode === "failed"
              ? "could not be confirmed"
              : "garbage collection was blocked",
          ),
        ],
      });
      expect(replayed).toBe(applied);
      expect(replayed).toStrictEqual(applied);
      expect(storageApply).toHaveBeenCalledTimes(
        1,
      );
      expect(deletedIds).toEqual(
        mode === "failed"
          ? [prepared.id]
          : [],
      );
      await expect(
        faultingStore.checkpoints.read(
          prepared.id,
        ),
      ).rejects.toMatchObject({
        code: "CHECKPOINT_NOT_FOUND",
      });
      expect(await readFile(absolutePath)).toEqual(
        unrelated,
      );
    },
  );

  it("serializes concurrent commit and abandon applies so exactly one commit point wins", async () => {
    const resolver =
      await ProjectPathResolver.create(root);
    const committedIds: string[] = [];
    const abandonedIds: string[] = [];
    const racingStore = makeStore(resolver, { maxDocumentBytes: 64 * 1024 * 1024, checkpointOptions: {
        observer: {
          afterPreparedCheckpointCommitInstalledBeforeDirectorySync({
            checkpointId,
          }) {
            committedIds.push(checkpointId);
          },
          afterPreparedCheckpointAbandonManifestUnlinkedBeforeDirectorySync({
            checkpointId,
          }) {
            abandonedIds.push(checkpointId);
          },
        },
      } });
    const projectPath =
      "maps/concurrent-adjudication.tmj";
    const absolutePath = join(
      root,
      projectPath,
    );
    const after = jsonBytes({
      type: "map",
      concurrent: true,
    });
    const prepared =
      await racingStore.checkpoints.prepare(
        projectPath,
        undefined,
        revisionOf(after),
        "concurrent adjudication",
      );
    await writeFile(absolutePath, after);
    const commitPlan =
      await planPreparedCheckpointCommit(
        racingStore,
        prepared.id,
      );
    const abandonPlan =
      await planPreparedCheckpointAbandon(
        racingStore,
        prepared.id,
      );
    const registry = new ChangeSetRegistry();
    const commitPreview =
      registry.put(commitPlan);
    const abandonPreview =
      registry.put(abandonPlan);
    const operation = async (
      candidate: ChangeSetPlan,
    ) => {
      if (
        candidate.kind ===
        "preparedCheckpointCommit"
      ) {
        return applyPreparedCheckpointCommit(
          racingStore,
          candidate,
        );
      }
      if (
        candidate.kind ===
        "preparedCheckpointAbandon"
      ) {
        return applyPreparedCheckpointAbandon(
          racingStore,
          candidate,
        );
      }
      throw new Error(
        "Expected a prepared checkpoint adjudication plan.",
      );
    };

    const outcomes = await Promise.allSettled([
      registry.apply(
        commitPreview.changeSetId,
        commitPreview.expectedRevision,
        operation,
      ),
      registry.apply(
        abandonPreview.changeSetId,
        abandonPreview.expectedRevision,
        operation,
      ),
    ]);
    const successes = outcomes.filter(
      (outcome) =>
        outcome.status === "fulfilled",
    );
    const failures = outcomes.filter(
      (outcome) =>
        outcome.status === "rejected",
    );

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    const success = successes[0];
    const failure = failures[0];
    if (
      success?.status !== "fulfilled" ||
      failure?.status !== "rejected"
    ) {
      throw new Error(
        "Expected exactly one fulfilled and one rejected adjudication.",
      );
    }
    expect(failure.reason).toBeInstanceOf(
      TiledMcpError,
    );
    expect([
      "CHECKPOINT_CHANGED",
      "CHECKPOINT_NOT_FOUND",
    ]).toContain(
      (failure.reason as TiledMcpError).code,
    );
    expect(
      committedIds.length +
        abandonedIds.length,
    ).toBe(1);
    expect(await readFile(absolutePath)).toEqual(
      after,
    );

    if (
      success.value.changeSetId ===
      commitPreview.changeSetId
    ) {
      expect(success.value).toMatchObject({
        kind: "preparedCheckpointCommit",
        manifestCommitted: true,
      });
      expect(committedIds).toEqual([
        prepared.id,
      ]);
      expect(abandonedIds).toEqual([]);
      expect(
        await racingStore.checkpoints.read(
          prepared.id,
        ),
      ).toMatchObject({
        status: "committed",
      });
    } else {
      expect(success.value).toMatchObject({
        changeSetId:
          abandonPreview.changeSetId,
        kind: "preparedCheckpointAbandon",
        manifestDeleted: true,
      });
      expect(committedIds).toEqual([]);
      expect(abandonedIds).toEqual([
        prepared.id,
      ]);
      await expect(
        racingStore.checkpoints.read(
          prepared.id,
        ),
      ).rejects.toMatchObject({
        code: "CHECKPOINT_NOT_FOUND",
      });
    }
  });
});

function jsonBytes(
  value: Record<string, unknown>,
): Buffer {
  return Buffer.from(
    `${JSON.stringify(value)}\n`,
    "utf8",
  );
}
