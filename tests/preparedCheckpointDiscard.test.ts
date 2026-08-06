import { createHash } from "node:crypto";
import { makeStore, wireProject } from "./support/project.js";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
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

import {
  ChangeSetRegistry,
  type ChangeSetPlan,
} from "../src/changeSets.js";
import {
  stableJson,
  type JsonValue,
} from "../src/formats/json.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import type { CheckpointManifest } from "../src/storage/checkpoints.js";
import { DocumentStore } from "../src/storage/documentStore.js";
import { withProjectFileLock } from "../src/storage/fileLock.js";
import {
  applyPreparedCheckpointDiscard,
  PREPARED_CHECKPOINT_DISCARD_ELIGIBILITY,
  PREPARED_CHECKPOINT_DISCARD_GARBAGE_COLLECTION,
  PREPARED_CHECKPOINT_DISCARD_WARNING,
  planPreparedCheckpointDiscard,
  preparedCheckpointDiscardOperationPreview,
  type PreparedCheckpointDiscardPlan,
} from "../src/storage/preparedCheckpointDiscard.js";
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
const UNRELATED = Buffer.from(
  '{"type":"map","version":"1.10","width":9,"state":"unrelated"}\n',
  "utf8",
);
const PREPARED_DISCARD_PLAN_HASH_DOMAIN =
  "tiledmcp/prepared-checkpoint-discard-plan/v1\0";

describe("prepared checkpoint discard planning and application", () => {
  let root: string;
  let resolver: ProjectPathResolver;
  let store: DocumentStore;

  beforeEach(async () => {
    root = await mkdtemp(
      join(
        tmpdir(),
        "tiledmcp-prepared-checkpoint-discard-",
      ),
    );
    await mkdir(join(root, "maps"));
    ({ resolver, store } = await wireProject(root));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  it("previews without mutation, then discards an existing-file checkpoint only while the exact before bytes remain", async () => {
    const prepared =
      await prepareExistingCheckpoint(
        store,
        root,
        TARGET_PATH,
        BEFORE,
        AFTER,
        "existing write did not land",
      );
    if (!prepared.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const manifestBytes = await readFile(
      manifestPath(root, prepared.id),
    );
    const objectBytes = await readFile(
      objectPath(
        root,
        prepared.before.objectHash,
      ),
    );
    const targetBytes = await readFile(
      join(root, TARGET_PATH),
    );
    const checkpointEntriesBefore =
      await checkpointEntryNames(root);
    const objectEntriesBefore =
      await objectEntryNames(root);

    const plan =
      await planPreparedCheckpointDiscard(
        store,
        prepared.id,
      );

    expect(plan).toMatchObject({
      kind: "preparedCheckpointDiscard",
      version: 1,
      checkpoint: {
        id: prepared.id,
        path: TARGET_PATH,
        status: "prepared",
        before: {
          existed: true,
          revision: revisionOf(BEFORE),
          objectHash:
            prepared.before.objectHash,
          size: BEFORE.byteLength,
        },
        afterRevision: revisionOf(AFTER),
        manifestRevision:
          revisionOf(manifestBytes),
        manifestSize:
          manifestBytes.byteLength,
        target: {
          existed: true,
          revision: revisionOf(BEFORE),
          size: BEFORE.byteLength,
        },
      },
      baseRevision:
        revisionOf(manifestBytes),
      summary: {
        operationCount: 1,
        destructive: true,
        checkpointId: prepared.id,
        targetPath: TARGET_PATH,
        status: "prepared",
        manifestRevision:
          revisionOf(manifestBytes),
        manifestBytes:
          manifestBytes.byteLength,
        removesRecoveryPoint: true,
        removesProjectAsset: false,
        targetBeforeStateVerified: true,
        garbageCollection:
          PREPARED_CHECKPOINT_DISCARD_GARBAGE_COLLECTION,
        warning:
          PREPARED_CHECKPOINT_DISCARD_WARNING,
      },
    });
    expect(plan.id).toMatch(
      /^changeset:[0-9a-f]{64}$/u,
    );
    expect(
      preparedCheckpointDiscardOperationPreview(
        plan,
      ),
    ).toEqual({
      type: "discardPreparedCheckpoint",
      destructive: true,
      warning:
        PREPARED_CHECKPOINT_DISCARD_WARNING,
      checkpointId: prepared.id,
      targetPath: TARGET_PATH,
      status: "prepared",
      manifestRevision:
        revisionOf(manifestBytes),
      manifestBytes:
        manifestBytes.byteLength,
      removesRecoveryPoint: true,
      removesProjectAsset: false,
      targetBeforeStateVerified: true,
      garbageCollection:
        PREPARED_CHECKPOINT_DISCARD_GARBAGE_COLLECTION,
    });
    expect(
      await checkpointEntryNames(root),
    ).toEqual(checkpointEntriesBefore);
    expect(
      await objectEntryNames(root),
    ).toEqual(objectEntriesBefore);
    expect(
      await readFile(
        manifestPath(root, prepared.id),
      ),
    ).toEqual(manifestBytes);
    expect(
      await readFile(
        objectPath(
          root,
          prepared.before.objectHash,
        ),
      ),
    ).toEqual(objectBytes);
    expect(
      await readFile(join(root, TARGET_PATH)),
    ).toEqual(targetBytes);

    const result =
      await applyPreparedCheckpointDiscard(
        store,
        plan,
      );

    expect(result).toMatchObject({
      kind: "preparedCheckpointDiscard",
      checkpoint: {
        id: prepared.id,
        path: TARGET_PATH,
        status: "prepared",
        before: {
          existed: true,
          revision: revisionOf(BEFORE),
          size: BEFORE.byteLength,
        },
      },
      target: {
        existed: true,
        revision: revisionOf(BEFORE),
        size: BEFORE.byteLength,
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
      manifestPath(root, prepared.id),
    );
    await expectMissing(
      objectPath(
        root,
        prepared.before.objectHash,
      ),
    );
    expect(
      await readFile(join(root, TARGET_PATH)),
    ).toEqual(BEFORE);
  });

  it("discards a prepared create checkpoint only while its target is provably absent", async () => {
    const prepared =
      await store.checkpoints.prepare(
        TARGET_PATH,
        undefined,
        revisionOf(AFTER),
        "create did not land",
      );
    const manifestBytes = await readFile(
      manifestPath(root, prepared.id),
    );
    expect(
      await objectEntryNames(root),
    ).toEqual([]);

    const plan =
      await planPreparedCheckpointDiscard(
        store,
        prepared.id,
      );

    expect(plan).toMatchObject({
      checkpoint: {
        id: prepared.id,
        before: { existed: false },
        target: { existed: false },
        manifestRevision:
          revisionOf(manifestBytes),
      },
      baseRevision:
        revisionOf(manifestBytes),
    });
    await expectMissing(join(root, TARGET_PATH));
    expect(
      await readFile(
        manifestPath(root, prepared.id),
      ),
    ).toEqual(manifestBytes);

    const result =
      await applyPreparedCheckpointDiscard(
        store,
        plan,
      );

    expect(result).toMatchObject({
      kind: "preparedCheckpointDiscard",
      checkpoint: {
        id: prepared.id,
        before: { existed: false },
      },
      target: { existed: false },
      manifestDeleted: true,
      garbageCollection: {
        status: "completed",
        deletedBytes: 0,
        deletedEntries: 0,
        deletedObjects: 0,
        deletedTemporaryFiles: 0,
        blockerCount: 0,
      },
    });
    await expectMissing(
      manifestPath(root, prepared.id),
    );
    await expectMissing(join(root, TARGET_PATH));
    expect(
      await objectEntryNames(root),
    ).toEqual([]);
  });

  it("retains a shared before object until the last prepared manifest is discarded", async () => {
    const first =
      await prepareExistingCheckpoint(
        store,
        root,
        "maps/first.tmj",
        BEFORE,
        AFTER,
        "first shared prepared root",
      );
    const second =
      await prepareExistingCheckpoint(
        store,
        root,
        "maps/second.tmj",
        BEFORE,
        AFTER,
        "second shared prepared root",
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
    const sharedObject = objectPath(
      root,
      first.before.objectHash,
    );
    const firstPlan =
      await planPreparedCheckpointDiscard(
        store,
        first.id,
      );
    const secondPlan =
      await planPreparedCheckpointDiscard(
        store,
        second.id,
      );

    const firstResult =
      await applyPreparedCheckpointDiscard(
        store,
        firstPlan,
      );

    expect(
      firstResult.garbageCollection,
    ).toMatchObject({
      status: "completed",
      deletedEntries: 0,
      deletedObjects: 0,
    });
    expect(await readFile(sharedObject)).toEqual(
      BEFORE,
    );
    expect(
      await readFile(
        manifestPath(root, second.id),
      ),
    ).not.toHaveLength(0);

    const secondResult =
      await applyPreparedCheckpointDiscard(
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
    });
    await expectMissing(sharedObject);
    expect(
      await checkpointEntryNames(root),
    ).toEqual([]);
    expect(await objectEntryNames(root)).toEqual(
      [],
    );
  });

  it.each([
    {
      state: "the exact after revision landed",
      setTarget: async (
        currentRoot: string,
      ): Promise<void> => {
        await writeFile(
          join(currentRoot, TARGET_PATH),
          AFTER,
        );
      },
    },
    {
      state: "an unrelated revision is present",
      setTarget: async (
        currentRoot: string,
      ): Promise<void> => {
        await writeFile(
          join(currentRoot, TARGET_PATH),
          UNRELATED,
        );
      },
    },
    {
      state: "the existing target is missing",
      setTarget: async (
        currentRoot: string,
      ): Promise<void> => {
        await unlink(
          join(currentRoot, TARGET_PATH),
        );
      },
    },
    {
      state: "the target is a symbolic link",
      setTarget: async (
        currentRoot: string,
      ): Promise<void> => {
        await unlink(
          join(currentRoot, TARGET_PATH),
        );
        await symlink(
          "elsewhere.tmj",
          join(currentRoot, TARGET_PATH),
        );
      },
    },
    {
      state: "the target is not a regular file",
      setTarget: async (
        currentRoot: string,
      ): Promise<void> => {
        await unlink(
          join(currentRoot, TARGET_PATH),
        );
        await mkdir(
          join(currentRoot, TARGET_PATH),
        );
      },
    },
  ])(
    "rejects an existing-file prepared checkpoint when $state",
    async ({ setTarget }) => {
      const prepared =
        await prepareExistingCheckpoint(
          store,
          root,
          TARGET_PATH,
          BEFORE,
          AFTER,
          "unsafe existing discard",
        );
      const manifestBytes = await readFile(
        manifestPath(root, prepared.id),
      );
      await setTarget(root);

      await expect(
        planPreparedCheckpointDiscard(
          store,
          prepared.id,
        ),
      ).rejects.toMatchObject({
        code: "CHECKPOINT_STATE_CONFLICT",
        details: {
          checkpointId: prepared.id,
          path: TARGET_PATH,
        },
      });

      expect(
        await readFile(
          manifestPath(root, prepared.id),
        ),
      ).toEqual(manifestBytes);
    },
  );

  it("rejects a prepared create checkpoint when any target exists", async () => {
    const prepared =
      await store.checkpoints.prepare(
        TARGET_PATH,
        undefined,
        revisionOf(AFTER),
        "ambiguous create",
      );
    const manifestBytes = await readFile(
      manifestPath(root, prepared.id),
    );
    await writeFile(
      join(root, TARGET_PATH),
      AFTER,
    );

    await expect(
      planPreparedCheckpointDiscard(
        store,
        prepared.id,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_STATE_CONFLICT",
      details: {
        checkpointId: prepared.id,
      },
    });
    expect(
      await readFile(
        manifestPath(root, prepared.id),
      ),
    ).toEqual(manifestBytes);
    expect(
      await readFile(join(root, TARGET_PATH)),
    ).toEqual(AFTER);
  });

  it("rejects an existing checkpoint whose before and after revisions are indistinguishable", async () => {
    await writeFile(
      join(root, TARGET_PATH),
      BEFORE,
    );
    const prepared =
      await store.checkpoints.prepare(
        TARGET_PATH,
        BEFORE,
        revisionOf(BEFORE),
        "ambiguous no-op checkpoint",
      );

    await expect(
      planPreparedCheckpointDiscard(
        store,
        prepared.id,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_STATE_CONFLICT",
      details: {
        checkpointId: prepared.id,
      },
    });
    expect(
      await store.checkpoints.read(
        prepared.id,
      ),
    ).toMatchObject({
      status: "prepared",
    });
  });

  it("rejects a committed checkpoint instead of treating discard as committed prune", async () => {
    const prepared =
      await prepareExistingCheckpoint(
        store,
        root,
        TARGET_PATH,
        BEFORE,
        AFTER,
        "committed status conflict",
      );
    const committed =
      await store.checkpoints.markCommitted(
        prepared,
      );

    await expect(
      planPreparedCheckpointDiscard(
        store,
        committed.id,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_STATE_CONFLICT",
      details: {
        checkpointId: committed.id,
      },
    });
    expect(
      await store.checkpoints.read(
        committed.id,
      ),
    ).toMatchObject({
      status: "committed",
    });
  });

  it("re-proves the target at apply and preserves the checkpoint when it changed after preview", async () => {
    const prepared =
      await prepareExistingCheckpoint(
        store,
        root,
        TARGET_PATH,
        BEFORE,
        AFTER,
        "target CAS",
      );
    if (!prepared.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const plan =
      await planPreparedCheckpointDiscard(
        store,
        prepared.id,
      );
    const manifestBytes = await readFile(
      manifestPath(root, prepared.id),
    );
    await writeFile(
      join(root, TARGET_PATH),
      UNRELATED,
    );

    await expect(
      applyPreparedCheckpointDiscard(
        store,
        plan,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_STATE_CONFLICT",
      details: {
        checkpointId: prepared.id,
      },
    });

    expect(
      await readFile(
        manifestPath(root, prepared.id),
      ),
    ).toEqual(manifestBytes);
    expect(
      await readFile(
        objectPath(
          root,
          prepared.before.objectHash,
        ),
      ),
    ).toEqual(BEFORE);
    expect(
      await readFile(join(root, TARGET_PATH)),
    ).toEqual(UNRELATED);
  });

  it("rejects a prepared create discard when its missing target appears after preview", async () => {
    const prepared =
      await store.checkpoints.prepare(
        TARGET_PATH,
        undefined,
        revisionOf(AFTER),
        "create target appeared after preview",
      );
    const plan =
      await planPreparedCheckpointDiscard(
        store,
        prepared.id,
      );
    const manifestBytes = await readFile(
      manifestPath(root, prepared.id),
    );
    await writeFile(
      join(root, TARGET_PATH),
      AFTER,
    );

    await expect(
      applyPreparedCheckpointDiscard(
        store,
        plan,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_STATE_CONFLICT",
      details: {
        checkpointId: prepared.id,
      },
    });
    expect(
      await readFile(
        manifestPath(root, prepared.id),
      ),
    ).toEqual(manifestBytes);
    expect(
      await readFile(join(root, TARGET_PATH)),
    ).toEqual(AFTER);
  });

  it("rejects a raw manifest byte change after preview before deleting anything", async () => {
    const prepared =
      await prepareExistingCheckpoint(
        store,
        root,
        TARGET_PATH,
        BEFORE,
        AFTER,
        "raw manifest CAS",
      );
    if (!prepared.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const plan =
      await planPreparedCheckpointDiscard(
        store,
        prepared.id,
      );
    const originalBytes = await readFile(
      manifestPath(root, prepared.id),
    );
    const changedBytes = Buffer.from(
      `${JSON.stringify(
        JSON.parse(
          originalBytes.toString("utf8"),
        ),
      )}\n`,
      "utf8",
    );
    expect(changedBytes).not.toEqual(
      originalBytes,
    );
    await writeFile(
      manifestPath(root, prepared.id),
      changedBytes,
    );

    await expect(
      applyPreparedCheckpointDiscard(
        store,
        plan,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CHANGED",
      details: {
        checkpointId: prepared.id,
      },
    });

    expect(
      await readFile(
        manifestPath(root, prepared.id),
      ),
    ).toEqual(changedBytes);
    expect(
      await readFile(
        objectPath(
          root,
          prepared.before.objectHash,
        ),
      ),
    ).toEqual(BEFORE);
    expect(
      await readFile(join(root, TARGET_PATH)),
    ).toEqual(BEFORE);
  });

  it("rejects a prepared-to-committed status race after preview", async () => {
    const prepared =
      await prepareExistingCheckpoint(
        store,
        root,
        TARGET_PATH,
        BEFORE,
        AFTER,
        "status CAS",
      );
    const plan =
      await planPreparedCheckpointDiscard(
        store,
        prepared.id,
      );
    await store.checkpoints.markCommitted(
      prepared,
    );

    await expect(
      applyPreparedCheckpointDiscard(
        store,
        plan,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CHANGED",
      details: {
        checkpointId: prepared.id,
      },
    });
    expect(
      await store.checkpoints.read(
        prepared.id,
      ),
    ).toMatchObject({
      status: "committed",
    });
    expect(
      await readFile(join(root, TARGET_PATH)),
    ).toEqual(BEFORE);
  });

  it("does not require an existing checkpoint's own blob to be intact before safe discard", async () => {
    const missingBefore = Buffer.from(
      '{"type":"map","state":"missing-object-before"}\n',
      "utf8",
    );
    const missingAfter = Buffer.from(
      '{"type":"map","state":"missing-object-after"}\n',
      "utf8",
    );
    const missing =
      await prepareExistingCheckpoint(
        store,
        root,
        "maps/missing-object.tmj",
        missingBefore,
        missingAfter,
        "missing own object",
      );
    if (!missing.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    await unlink(
      objectPath(
        root,
        missing.before.objectHash,
      ),
    );

    const missingResult =
      await applyPreparedCheckpointDiscard(
        store,
        await planPreparedCheckpointDiscard(
          store,
          missing.id,
        ),
      );

    expect(
      missingResult.garbageCollection,
    ).toMatchObject({
      status: "completed",
      deletedEntries: 0,
      deletedObjects: 0,
    });
    await expectMissing(
      manifestPath(root, missing.id),
    );
    expect(
      await readFile(
        join(root, "maps/missing-object.tmj"),
      ),
    ).toEqual(missingBefore);

    const corruptBefore = Buffer.from(
      '{"type":"map","state":"corrupt-object-before"}\n',
      "utf8",
    );
    const corruptAfter = Buffer.from(
      '{"type":"map","state":"corrupt-object-after"}\n',
      "utf8",
    );
    const corrupt =
      await prepareExistingCheckpoint(
        store,
        root,
        "maps/corrupt-object.tmj",
        corruptBefore,
        corruptAfter,
        "corrupt own object",
      );
    if (!corrupt.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const corruptObjectPath = objectPath(
      root,
      corrupt.before.objectHash,
    );
    await writeFile(
      corruptObjectPath,
      Buffer.from("corrupt object bytes", "utf8"),
    );

    const corruptResult =
      await applyPreparedCheckpointDiscard(
        store,
        await planPreparedCheckpointDiscard(
          store,
          corrupt.id,
        ),
      );

    expect(
      corruptResult.garbageCollection,
    ).toMatchObject({
      status: "completed",
      deletedEntries: 1,
      deletedObjects: 1,
    });
    await expectMissing(
      manifestPath(root, corrupt.id),
    );
    await expectMissing(corruptObjectPath);
    expect(
      await readFile(
        join(root, "maps/corrupt-object.tmj"),
      ),
    ).toEqual(corruptBefore);
  });

  it("deletes the prepared manifest while unknown inventory blocks every GC deletion", async () => {
    const prepared =
      await prepareExistingCheckpoint(
        store,
        root,
        TARGET_PATH,
        BEFORE,
        AFTER,
        "blocked prepared cleanup",
      );
    if (!prepared.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const plan =
      await planPreparedCheckpointDiscard(
        store,
        prepared.id,
      );
    const unknownName =
      "future-checkpoint-object-index.v2";
    const unknownBytes = Buffer.from(
      "unknown checkpoint storage entry",
      "utf8",
    );
    await writeFile(
      join(
        objectsDirectory(root),
        unknownName,
      ),
      unknownBytes,
    );

    const result =
      await applyPreparedCheckpointDiscard(
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
        blockers: [
          {
            directory: "objects",
            fileName: unknownName,
            reason: "unexpected-entry",
          },
        ],
        blockersTruncated: false,
      },
      warnings: [
        expect.stringContaining(
          "garbage collection was blocked",
        ),
      ],
    });
    await expectMissing(
      manifestPath(root, prepared.id),
    );
    expect(
      await readFile(
        objectPath(
          root,
          prepared.before.objectHash,
        ),
      ),
    ).toEqual(BEFORE);
    expect(
      await readFile(
        join(
          objectsDirectory(root),
          unknownName,
        ),
      ),
    ).toEqual(unknownBytes);
    expect(
      await readFile(join(root, TARGET_PATH)),
    ).toEqual(BEFORE);
  });

  it("deletes the prepared manifest but performs zero GC deletion when the entry scan is incomplete", async () => {
    const prepared =
      await prepareExistingCheckpoint(
        store,
        root,
        TARGET_PATH,
        BEFORE,
        AFTER,
        "scan-limited prepared cleanup",
      );
    if (!prepared.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const orphan = Buffer.from(
      "second canonical object forces incomplete scan",
      "utf8",
    );
    const orphanHash = createHash("sha256")
      .update(orphan)
      .digest("hex");
    await writeFile(
      objectPath(root, orphanHash),
      orphan,
    );
    const constrained = makeStore(resolver, { maxDocumentBytes: 64 * 1024 * 1024, checkpointOptions: { maxEntries: 1 } });
    const plan =
      await planPreparedCheckpointDiscard(
        constrained,
        prepared.id,
      );

    const result =
      await applyPreparedCheckpointDiscard(
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
    await expectMissing(
      manifestPath(root, prepared.id),
    );
    expect(
      await readFile(
        objectPath(
          root,
          prepared.before.objectHash,
        ),
      ),
    ).toEqual(BEFORE);
    expect(
      await readFile(
        objectPath(root, orphanHash),
      ),
    ).toEqual(orphan);
  });

  it("returns a successful discard with a fixed warning when the post-unlink observer fails", async () => {
    const observedIds: string[] = [];
    const faultingStore = makeStore(resolver, { maxDocumentBytes: 64 * 1024 * 1024, checkpointOptions: {
        observer: {
          afterManifestDeletedBeforeGarbageCollection({
            checkpointId,
          }) {
            observedIds.push(checkpointId);
            throw new Error(
              "injected post-unlink failure",
            );
          },
        },
      } });
    const prepared =
      await prepareExistingCheckpoint(
        faultingStore,
        root,
        TARGET_PATH,
        BEFORE,
        AFTER,
        "failed post-unlink cleanup",
      );
    if (!prepared.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }

    const result =
      await applyPreparedCheckpointDiscard(
        faultingStore,
        await planPreparedCheckpointDiscard(
          faultingStore,
          prepared.id,
        ),
      );

    expect(observedIds).toEqual([prepared.id]);
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
    await expectMissing(
      manifestPath(root, prepared.id),
    );
    expect(
      await readFile(
        objectPath(
          root,
          prepared.before.objectHash,
        ),
      ),
    ).toEqual(BEFORE);
    expect(
      await faultingStore.checkpoints.collectGarbage(),
    ).toMatchObject({
      deletedEntries: 1,
      deletedObjects: 1,
      blocked: false,
    });
  });

  it("keeps a successful result when both checkpoint-store and target lock release become unconfirmable", async () => {
    const locksDirectory =
      await resolver.ensureInternalDirectory(
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
    const prepared =
      await prepareExistingCheckpoint(
        releaseFaultStore,
        root,
        TARGET_PATH,
        BEFORE,
        AFTER,
        "failed lock release",
      );
    const plan =
      await planPreparedCheckpointDiscard(
        releaseFaultStore,
        prepared.id,
      );
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    let result:
      | Awaited<
          ReturnType<
            typeof applyPreparedCheckpointDiscard
          >
        >
      | undefined;
    try {
      result =
        await applyPreparedCheckpointDiscard(
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
    await expectMissing(
      manifestPath(root, prepared.id),
    );
    expect(
      (await readdir(locksDirectory)).filter(
        (name) => name.endsWith(".lock"),
      ),
    ).toHaveLength(2);
  });

  it("uses the target lock to block prepared discard before manifest deletion", async () => {
    const prepared =
      await prepareExistingCheckpoint(
        store,
        root,
        TARGET_PATH,
        BEFORE,
        AFTER,
        "target lock coordination",
      );
    if (!prepared.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const plan =
      await planPreparedCheckpointDiscard(
        store,
        prepared.id,
      );
    const manifestBytes = await readFile(
      manifestPath(root, prepared.id),
    );

    await withProjectFileLock(
      resolver,
      TARGET_PATH,
      async () => {
        await expect(
          applyPreparedCheckpointDiscard(
            store,
            plan,
          ),
        ).rejects.toMatchObject({
          code: "FILE_LOCKED",
          details: {
            path: TARGET_PATH,
          },
        });
      },
    );

    expect(
      await readFile(
        manifestPath(root, prepared.id),
      ),
    ).toEqual(manifestBytes);
    expect(
      await readFile(
        objectPath(
          root,
          prepared.before.objectHash,
        ),
      ),
    ).toEqual(BEFORE);
    expect(
      await readFile(join(root, TARGET_PATH)),
    ).toEqual(BEFORE);
  });

  it("reconciliation respects the target lock and cannot mark a landed prepared checkpoint while another writer owns it", async () => {
    const prepared =
      await prepareExistingCheckpoint(
        store,
        root,
        TARGET_PATH,
        BEFORE,
        AFTER,
        "landed while target locked",
      );
    await writeFile(
      join(root, TARGET_PATH),
      AFTER,
    );

    await withProjectFileLock(
      resolver,
      TARGET_PATH,
      async () => {
        const report =
          await store.reconcilePreparedCheckpoints();
        expect(report.outcomes).toEqual([
          expect.objectContaining({
            checkpointId: prepared.id,
            outcome: "error",
            errorCode: "FILE_LOCKED",
          }),
        ]);
        expect(
          await store.checkpoints.read(
            prepared.id,
          ),
        ).toMatchObject({
          status: "prepared",
        });
      },
    );

    const reconciled =
      await store.reconcilePreparedCheckpoints();
    expect(reconciled.outcomes).toEqual([
      expect.objectContaining({
        checkpointId: prepared.id,
        outcome: "reconciled",
        currentRevision: revisionOf(AFTER),
      }),
    ]);
    expect(
      await store.checkpoints.read(
        prepared.id,
      ),
    ).toMatchObject({
      status: "committed",
    });
  });

  it("authoritatively re-reads a routed manifest under the target lock before reporting reconciliation state", async () => {
    const prepared =
      await prepareExistingCheckpoint(
        store,
        root,
        TARGET_PATH,
        BEFORE,
        AFTER,
        "manifest removed after reconciliation listing",
      );
    const originalList =
      store.checkpoints.list.bind(
        store.checkpoints,
      );
    vi.spyOn(
      store.checkpoints,
      "list",
    ).mockImplementationOnce(async (options) => {
      const listing =
        await originalList(options);
      await unlink(
        manifestPath(root, prepared.id),
      );
      return listing;
    });

    const report =
      await store.reconcilePreparedCheckpoints();

    expect(report.outcomes).toEqual([
      expect.objectContaining({
        checkpointId: prepared.id,
        outcome: "error",
        currentRevision: null,
        errorCode: "CHECKPOINT_NOT_FOUND",
      }),
    ]);
    expect(
      await readFile(join(root, TARGET_PATH)),
    ).toEqual(BEFORE);
    if (!prepared.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    expect(
      await readFile(
        objectPath(
          root,
          prepared.before.objectHash,
        ),
      ),
    ).toEqual(BEFORE);
  });

  it("rejects digest and independently re-digested summary tampering without deleting recovery state", async () => {
    const prepared =
      await prepareExistingCheckpoint(
        store,
        root,
        TARGET_PATH,
        BEFORE,
        AFTER,
        "plan tamper checks",
      );
    if (!prepared.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    const plan =
      await planPreparedCheckpointDiscard(
        store,
        prepared.id,
      );
    const manifestBytes = await readFile(
      manifestPath(root, prepared.id),
    );
    const digestTampered:
      PreparedCheckpointDiscardPlan = {
      ...plan,
      id: `changeset:${"0".repeat(64)}`,
    };

    await expect(
      applyPreparedCheckpointDiscard(
        store,
        digestTampered,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_CHANGE_SET",
      message:
        "The prepared checkpoint discard change set digest is invalid.",
    });

    const summaryTampered:
      PreparedCheckpointDiscardPlan = {
      ...plan,
      summary: {
        ...plan.summary,
        warning: `${plan.summary.warning} tampered`,
      },
    };
    summaryTampered.id =
      preparedCheckpointDiscardPlanDigest(
        summaryTampered,
      );
    await expect(
      applyPreparedCheckpointDiscard(
        store,
        summaryTampered,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_CHANGE_SET",
      message:
        "The prepared checkpoint discard summary does not match its approved operation.",
    });

    expect(
      await readFile(
        manifestPath(root, prepared.id),
      ),
    ).toEqual(manifestBytes);
    expect(
      await readFile(
        objectPath(
          root,
          prepared.before.objectHash,
        ),
      ),
    ).toEqual(BEFORE);
  });

  it("caches the first successful change-set application for exact replay", async () => {
    const prepared =
      await prepareExistingCheckpoint(
        store,
        root,
        TARGET_PATH,
        BEFORE,
        AFTER,
        "change-set replay",
      );
    const plan =
      await planPreparedCheckpointDiscard(
        store,
        prepared.id,
      );
    const registry = new ChangeSetRegistry();
    const preview = registry.put(plan);
    if (
      preview.kind !==
      "preparedCheckpointDiscard"
    ) {
      throw new Error(
        "Expected a prepared checkpoint discard preview.",
      );
    }
    expect(preview).toMatchObject({
      kind: "preparedCheckpointDiscard",
      expectedRevision:
        plan.checkpoint.manifestRevision,
      eligibility:
        PREPARED_CHECKPOINT_DISCARD_ELIGIBILITY,
      target: {
        existed: true,
        revision: revisionOf(BEFORE),
        size: BEFORE.byteLength,
      },
    });
    let applicationCount = 0;
    const operation = async (
      candidate: ChangeSetPlan,
    ) => {
      if (
        candidate.kind !==
        "preparedCheckpointDiscard"
      ) {
        throw new Error(
          "Expected a prepared checkpoint discard plan.",
        );
      }
      applicationCount += 1;
      return applyPreparedCheckpointDiscard(
        store,
        candidate,
      );
    };
    await expect(
      registry.apply(
        preview.changeSetId,
        revisionOf(UNRELATED),
        operation,
      ),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    expect(applicationCount).toBe(0);
    expect(
      (
        await readFile(
          manifestPath(root, prepared.id),
        )
      ).byteLength,
    ).toBeGreaterThan(0);

    const first = await registry.apply(
      preview.changeSetId,
      preview.expectedRevision,
      operation,
    );
    const replay = await registry.apply(
      preview.changeSetId,
      preview.expectedRevision,
      operation,
    );

    expect(applicationCount).toBe(1);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      changeSetId: preview.changeSetId,
      kind: "preparedCheckpointDiscard",
      manifestDeleted: true,
    });
    await expectMissing(
      manifestPath(root, prepared.id),
    );
    expect(
      await readFile(join(root, TARGET_PATH)),
    ).toEqual(BEFORE);
  });
});

async function prepareExistingCheckpoint(
  store: DocumentStore,
  root: string,
  projectPath: string,
  before: Buffer,
  after: Buffer,
  label: string,
): Promise<CheckpointManifest> {
  await writeFile(join(root, projectPath), before);
  return store.checkpoints.prepare(
    projectPath,
    before,
    revisionOf(after),
    label,
  );
}

function checkpointsDirectory(root: string): string {
  return join(
    root,
    ".tiledmcp",
    "checkpoints",
  );
}

function objectsDirectory(root: string): string {
  return join(root, ".tiledmcp", "objects");
}

function manifestPath(
  root: string,
  checkpointId: string,
): string {
  return join(
    checkpointsDirectory(root),
    `${checkpointId}.json`,
  );
}

function objectPath(
  root: string,
  objectHash: string,
): string {
  return join(objectsDirectory(root), objectHash);
}

async function checkpointEntryNames(
  root: string,
): Promise<string[]> {
  return (
    await readdir(checkpointsDirectory(root))
  ).sort();
}

async function objectEntryNames(
  root: string,
): Promise<string[]> {
  return (
    await readdir(objectsDirectory(root))
  ).sort();
}

async function expectMissing(
  path: string,
): Promise<void> {
  await expect(stat(path)).rejects.toMatchObject({
    code: "ENOENT",
  });
}

function preparedCheckpointDiscardPlanDigest(
  plan: PreparedCheckpointDiscardPlan,
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
    .update(
      PREPARED_DISCARD_PLAN_HASH_DOMAIN,
    )
    .update(canonical)
    .digest("hex")}`;
}
