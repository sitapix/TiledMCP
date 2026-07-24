import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
  vi,
} from "vitest";

import {
  ChangeSetRegistry,
  type ChangeSetPlan,
} from "../src/changeSets.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  applyCheckpointRestore,
  checkpointRestoreOperationPreview,
  planCheckpointRestore,
  type CheckpointRestorePlan,
} from "../src/storage/checkpointRestore.js";
import type { CheckpointManifest } from "../src/storage/checkpoints.js";
import { DocumentStore } from "../src/storage/documentStore.js";
import { revisionOf } from "../src/storage/revision.js";

const TARGET_PATH = "maps/level.tmj";
const EXACT_BEFORE = Buffer.from(
  '\uFEFF{\r\n  "type": "map",\r\n  "layers": [],\r\n  "vendor": {"scientific": 1e+3}\r\n}\r\n',
  "utf8",
);
const AFTER = Buffer.from(
  '{"type":"map","layers":[],"vendor":{"scientific":1000},"edited":true}\n',
  "utf8",
);

describe("checkpoint restore planning and application", () => {
  let root: string;
  let store: DocumentStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tiledmcp-checkpoint-restore-"));
    await mkdir(join(root, "maps"));
    const resolver = await ProjectPathResolver.create(root);
    store = new DocumentStore(resolver);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("previews without writing, then restores a committed checkpoint's exact bytes", async () => {
    const fixture = await commitFixture(store, root);
    const checkpointNamesBefore = await checkpointFileNames(root);
    const manifestBytesBefore = await readFile(
      manifestFilePath(root, fixture.checkpoint.id),
    );

    const plan = await planCheckpointRestore(
      store,
      fixture.checkpoint.id,
      fixture.commitRevision,
    );

    expect(plan).toMatchObject({
      kind: "checkpointRestore",
      version: 1,
      checkpoint: {
        id: fixture.checkpoint.id,
        status: "committed",
      },
      targetPath: TARGET_PATH,
      baseRevision: fixture.commitRevision,
      restoreRevision: revisionOf(EXACT_BEFORE),
      restoreSize: EXACT_BEFORE.byteLength,
      wouldChange: true,
      summary: {
        operationCount: 1,
        destructive: true,
        checkpointId: fixture.checkpoint.id,
        currentRevision: fixture.commitRevision,
        restoreRevision: revisionOf(EXACT_BEFORE),
        restoreBytes: EXACT_BEFORE.byteLength,
        wouldChange: true,
      },
    });
    expect(checkpointRestoreOperationPreview(plan)).toMatchObject({
      type: "restoreCheckpoint",
      destructive: true,
      exactBytes: true,
      checkpointId: fixture.checkpoint.id,
      currentRevision: fixture.commitRevision,
      restoreRevision: revisionOf(EXACT_BEFORE),
      restoreBytes: EXACT_BEFORE.byteLength,
      wouldChange: true,
    });
    expect(await readFile(join(root, TARGET_PATH))).toEqual(AFTER);
    expect(await checkpointFileNames(root)).toEqual(checkpointNamesBefore);
    expect(
      await readFile(manifestFilePath(root, fixture.checkpoint.id)),
    ).toEqual(manifestBytesBefore);

    const result = await applyCheckpointRestore(store, plan);

    expect(result).toMatchObject({
      path: TARGET_PATH,
      beforeRevision: fixture.commitRevision,
      revision: revisionOf(EXACT_BEFORE),
      changed: true,
      changeSetId: plan.id,
    });
    expect(result.checkpointId).toEqual(expect.any(String));
    expect(result.checkpointId).not.toBe(fixture.checkpoint.id);
    expect(await readFile(join(root, TARGET_PATH))).toEqual(EXACT_BEFORE);
  });

  it("returns a true no-op when the committed checkpoint bytes are already present", async () => {
    await writeFile(join(root, TARGET_PATH), EXACT_BEFORE);
    const prepared = await store.checkpoints.prepare(
      TARGET_PATH,
      EXACT_BEFORE,
      revisionOf(AFTER),
      "already restored",
    );
    const checkpoint = await store.checkpoints.markCommitted(prepared);
    const checkpointNamesBefore = await checkpointFileNames(root);

    const inspection = await store.inspectRevert(
      checkpoint.id,
      revisionOf(EXACT_BEFORE),
    );
    const plan = await planCheckpointRestore(
      store,
      checkpoint.id,
      revisionOf(EXACT_BEFORE),
    );
    const result = await applyCheckpointRestore(store, plan);

    expect(inspection).toMatchObject({
      currentRevision: revisionOf(EXACT_BEFORE),
      restoreRevision: revisionOf(EXACT_BEFORE),
      restoreSize: EXACT_BEFORE.byteLength,
      changed: false,
    });
    expect(plan.wouldChange).toBe(false);
    expect(plan.summary.wouldChange).toBe(false);
    expect(result).toEqual({
      path: TARGET_PATH,
      beforeRevision: revisionOf(EXACT_BEFORE),
      revision: revisionOf(EXACT_BEFORE),
      checkpointId: null,
      changed: false,
      changeSetId: plan.id,
    });
    expect(await readFile(join(root, TARGET_PATH))).toEqual(EXACT_BEFORE);
    expect(await checkpointFileNames(root)).toEqual(checkpointNamesBefore);
  });

  it("coalesces concurrent apply calls into one restore checkpoint", async () => {
    const fixture = await commitFixture(store, root);
    const plan = await planCheckpointRestore(
      store,
      fixture.checkpoint.id,
      fixture.commitRevision,
    );
    const registry = new ChangeSetRegistry();
    const preview = registry.put(plan);
    const checkpointNamesBefore = await checkpointFileNames(root);
    let applyCount = 0;
    const operation = async (candidate: ChangeSetPlan) => {
      if (candidate.kind !== "checkpointRestore") {
        throw new Error("Expected a checkpoint restore plan.");
      }
      applyCount += 1;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      return applyCheckpointRestore(store, candidate);
    };

    const [first, second] = await Promise.all([
      registry.apply(
        preview.changeSetId,
        preview.expectedRevision,
        operation,
      ),
      registry.apply(
        preview.changeSetId,
        preview.expectedRevision,
        operation,
      ),
    ]);

    expect(applyCount).toBe(1);
    expect(second).toEqual(first);
    expect(first.changeSetId).toBe(preview.changeSetId);
    expect(await readFile(join(root, TARGET_PATH))).toEqual(
      EXACT_BEFORE,
    );
    expect(await checkpointFileNames(root)).toHaveLength(
      checkpointNamesBefore.length + 1,
    );
  });

  it("rejects a stale target at apply time without overwriting external bytes", async () => {
    const fixture = await commitFixture(store, root);
    const plan = await planCheckpointRestore(
      store,
      fixture.checkpoint.id,
      fixture.commitRevision,
    );
    const external = Buffer.from(
      '{"type":"map","external":"must survive","layers":[]}\n',
      "utf8",
    );
    await writeFile(join(root, TARGET_PATH), external);
    const checkpointNamesBefore = await checkpointFileNames(root);

    await expect(
      applyCheckpointRestore(store, plan),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "REVISION_CONFLICT",
      details: {
        path: TARGET_PATH,
        expectedRevision: fixture.commitRevision,
        actualRevision: revisionOf(external),
      },
    });
    expect(await readFile(join(root, TARGET_PATH))).toEqual(external);
    expect(await checkpointFileNames(root)).toEqual(checkpointNamesBefore);
  });

  it.each([
    {
      field: "createdAt",
      mutate: (manifest: CheckpointManifest): CheckpointManifest => ({
        ...manifest,
        createdAt: "2026-07-24T00:00:00.000Z",
      }),
    },
    {
      field: "label",
      mutate: (manifest: CheckpointManifest): CheckpointManifest => ({
        ...manifest,
        label: `${manifest.label} tampered`,
      }),
    },
    {
      field: "path",
      mutate: (manifest: CheckpointManifest): CheckpointManifest => ({
        ...manifest,
        path: "maps/other.tmj",
      }),
    },
    {
      field: "afterRevision",
      mutate: (manifest: CheckpointManifest): CheckpointManifest => ({
        ...manifest,
        afterRevision: revisionOf(Buffer.from("different after", "utf8")),
      }),
    },
    {
      field: "before.size",
      mutate: (manifest: CheckpointManifest): CheckpointManifest => ({
        ...manifest,
        before: manifest.before.existed
          ? { ...manifest.before, size: manifest.before.size + 1 }
          : manifest.before,
      }),
    },
  ])(
    "rejects a validly shaped manifest whose $field changed after inspection",
    async ({ mutate }) => {
      const fixture = await commitFixture(store, root);
      const inspection = await store.inspectRevert(
        fixture.checkpoint.id,
        fixture.commitRevision,
      );
      await writeManifest(root, mutate(fixture.checkpoint));

      await expect(
        store.revertPlanned(
          inspection.checkpoint,
          inspection.currentRevision,
        ),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "CHECKPOINT_CHANGED",
        details: {
          checkpointId: fixture.checkpoint.id,
        },
      });
      expect(await readFile(join(root, TARGET_PATH))).toEqual(AFTER);
    },
  );

  it("allows the one-way prepared-to-committed transition after inspection", async () => {
    await writeFile(join(root, TARGET_PATH), AFTER);
    const prepared = await store.checkpoints.prepare(
      TARGET_PATH,
      EXACT_BEFORE,
      revisionOf(AFTER),
      "landed but status update pending",
    );
    const inspection = await store.inspectRevert(
      prepared.id,
      revisionOf(AFTER),
    );
    expect(inspection.checkpoint.status).toBe("prepared");

    await store.checkpoints.markCommitted(prepared);
    const result = await store.revertPlanned(
      inspection.checkpoint,
      inspection.currentRevision,
    );

    expect(result).toMatchObject({
      beforeRevision: revisionOf(AFTER),
      revision: revisionOf(EXACT_BEFORE),
      changed: true,
    });
    expect(await readFile(join(root, TARGET_PATH))).toEqual(EXACT_BEFORE);
    expect(await store.checkpoints.read(prepared.id)).toMatchObject({
      status: "committed",
    });
  });

  it("does not restore when a landed prepared checkpoint cannot be committed", async () => {
    await writeFile(join(root, TARGET_PATH), AFTER);
    const prepared = await store.checkpoints.prepare(
      TARGET_PATH,
      EXACT_BEFORE,
      revisionOf(AFTER),
      "status update must succeed",
    );
    const plan = await planCheckpointRestore(
      store,
      prepared.id,
      revisionOf(AFTER),
    );
    const checkpointNamesBefore = await checkpointFileNames(root);
    vi.spyOn(
      store.checkpoints,
      "markCommitted",
    ).mockRejectedValueOnce(
      new Error("injected checkpoint status failure"),
    );

    await expect(
      applyCheckpointRestore(store, plan),
    ).rejects.toThrow("injected checkpoint status failure");
    expect(await readFile(join(root, TARGET_PATH))).toEqual(AFTER);
    expect(await checkpointFileNames(root)).toEqual(
      checkpointNamesBefore,
    );
    expect(await store.checkpoints.read(prepared.id)).toMatchObject({
      status: "prepared",
    });
  });

  it("rejects a committed-to-prepared regression after inspection", async () => {
    const fixture = await commitFixture(store, root);
    const inspection = await store.inspectRevert(
      fixture.checkpoint.id,
      fixture.commitRevision,
    );
    await writeManifest(root, {
      ...fixture.checkpoint,
      status: "prepared",
    });

    await expect(
      store.revertPlanned(
        inspection.checkpoint,
        inspection.currentRevision,
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "CHECKPOINT_CHANGED",
    });
    expect(await readFile(join(root, TARGET_PATH))).toEqual(AFTER);
  });

  it.each(["prepared", "committed"] as const)(
    "rejects a %s checkpoint whose before state did not exist",
    async (status) => {
      await writeFile(join(root, TARGET_PATH), AFTER);
      const prepared = await store.checkpoints.prepare(
        TARGET_PATH,
        undefined,
        revisionOf(AFTER),
        "created file",
      );
      const checkpoint =
        status === "committed"
          ? await store.checkpoints.markCommitted(prepared)
          : prepared;

      await expect(
        planCheckpointRestore(store, checkpoint.id, revisionOf(AFTER)),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "REVERT_WOULD_DELETE",
        details: {
          checkpointId: checkpoint.id,
          path: TARGET_PATH,
        },
      });
      expect(await readFile(join(root, TARGET_PATH))).toEqual(AFTER);
    },
  );

  it.each([
    {
      state: "the exact after revision landed",
      current: AFTER,
      expectedCode: undefined,
    },
    {
      state: "the original before revision remains",
      current: EXACT_BEFORE,
      expectedCode: "CHECKPOINT_NOT_COMMITTED",
    },
    {
      state: "an unrelated revision is present",
      current: Buffer.from(
        '{"type":"map","layers":[],"unrelated":true}\n',
        "utf8",
      ),
      expectedCode: "CHECKPOINT_STATE_CONFLICT",
    },
  ])(
    "handles a prepared checkpoint when $state",
    async ({ current, expectedCode }) => {
      await writeFile(join(root, TARGET_PATH), current);
      const checkpoint = await store.checkpoints.prepare(
        TARGET_PATH,
        EXACT_BEFORE,
        revisionOf(AFTER),
        "interrupted commit",
      );

      if (expectedCode === undefined) {
        await expect(
          store.inspectRevert(checkpoint.id, revisionOf(current)),
        ).resolves.toMatchObject({
          checkpoint: { id: checkpoint.id, status: "prepared" },
          currentRevision: revisionOf(current),
          restoreRevision: revisionOf(EXACT_BEFORE),
          changed: true,
        });
      } else {
        await expect(
          store.inspectRevert(checkpoint.id, revisionOf(current)),
        ).rejects.toMatchObject({
          name: "TiledMcpError",
          code: expectedCode,
          details: { checkpointId: checkpoint.id },
        });
      }
      expect(await readFile(join(root, TARGET_PATH))).toEqual(current);
      expect(await store.checkpoints.read(checkpoint.id)).toMatchObject({
        status: "prepared",
      });
    },
  );

  it("rejects a tampered content-addressed checkpoint object", async () => {
    await writeFile(join(root, TARGET_PATH), AFTER);
    const prepared = await store.checkpoints.prepare(
      TARGET_PATH,
      EXACT_BEFORE,
      revisionOf(AFTER),
      "tampered object",
    );
    const checkpoint = await store.checkpoints.markCommitted(prepared);
    if (!checkpoint.before.existed) {
      throw new Error("test fixture unexpectedly lacks before bytes");
    }
    await writeFile(
      join(
        root,
        ".tiledmcp",
        "objects",
        checkpoint.before.objectHash,
      ),
      Buffer.from('{"type":"map","tampered":true}\n', "utf8"),
    );

    await expect(
      store.inspectRevert(checkpoint.id, revisionOf(AFTER)),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "CHECKPOINT_CORRUPT",
      details: { checkpointId: checkpoint.id },
    });
    expect(await readFile(join(root, TARGET_PATH))).toEqual(AFTER);
  });

  it("reports a missing content-addressed object as checkpoint corruption", async () => {
    await writeFile(join(root, TARGET_PATH), AFTER);
    const prepared = await store.checkpoints.prepare(
      TARGET_PATH,
      EXACT_BEFORE,
      revisionOf(AFTER),
      "missing object",
    );
    const checkpoint =
      await store.checkpoints.markCommitted(prepared);
    if (!checkpoint.before.existed) {
      throw new Error("test fixture unexpectedly lacks before bytes");
    }
    await unlink(
      join(
        root,
        ".tiledmcp",
        "objects",
        checkpoint.before.objectHash,
      ),
    );

    await expect(
      store.inspectRevert(checkpoint.id, revisionOf(AFTER)),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "CHECKPOINT_CORRUPT",
      details: { checkpointId: checkpoint.id },
    });
    expect(await readFile(join(root, TARGET_PATH))).toEqual(AFTER);
  });

  it("rejects hash-valid checkpoint bytes that are not valid JSON", async () => {
    const invalidBefore = Buffer.from('{"type":"map","broken":', "utf8");
    await writeFile(join(root, TARGET_PATH), AFTER);
    const prepared = await store.checkpoints.prepare(
      TARGET_PATH,
      invalidBefore,
      revisionOf(AFTER),
      "invalid JSON object",
    );
    const checkpoint = await store.checkpoints.markCommitted(prepared);

    await expect(
      planCheckpointRestore(store, checkpoint.id, revisionOf(AFTER)),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "CHECKPOINT_CORRUPT",
      details: {
        checkpointId: checkpoint.id,
        path: TARGET_PATH,
      },
    });
    expect(await readFile(join(root, TARGET_PATH))).toEqual(AFTER);
  });

  it("enforces the DocumentStore byte limit on otherwise valid restore bytes", async () => {
    const limitedStore = new DocumentStore(
      await ProjectPathResolver.create(root),
      64,
    );
    const oversizedBefore = Buffer.from(
      `${JSON.stringify({ padding: "x".repeat(80) })}\n`,
      "utf8",
    );
    const smallAfter = Buffer.from('{"after":true}\n', "utf8");
    await writeFile(join(root, TARGET_PATH), smallAfter);
    const prepared = await limitedStore.checkpoints.prepare(
      TARGET_PATH,
      oversizedBefore,
      revisionOf(smallAfter),
      "oversized restore object",
    );
    const checkpoint =
      await limitedStore.checkpoints.markCommitted(prepared);

    await expect(
      limitedStore.inspectRevert(
        checkpoint.id,
        revisionOf(smallAfter),
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DOCUMENT_TOO_LARGE",
      details: {
        path: TARGET_PATH,
        size: oversizedBefore.byteLength,
        limit: 64,
      },
    });
    expect(await readFile(join(root, TARGET_PATH))).toEqual(smallAfter);
  });

  it("rejects unknown plan fields before touching the target", async () => {
    const fixture = await commitFixture(store, root);
    const plan = await planCheckpointRestore(
      store,
      fixture.checkpoint.id,
      fixture.commitRevision,
    );
    const malformed = {
      ...plan,
      checkpoint: {
        ...plan.checkpoint,
        before: {
          ...plan.checkpoint.before,
          existed: true,
        },
      },
    } as unknown as CheckpointRestorePlan;

    await expect(
      applyCheckpointRestore(store, malformed),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_CHANGE_SET",
      message: "The checkpoint restore change set is malformed.",
    });
    expect(await readFile(join(root, TARGET_PATH))).toEqual(AFTER);
  });

  it("rejects a plan digest mismatch before touching the target", async () => {
    const fixture = await commitFixture(store, root);
    const plan = await planCheckpointRestore(
      store,
      fixture.checkpoint.id,
      fixture.commitRevision,
    );
    const digestTampered: CheckpointRestorePlan = {
      ...plan,
      id: `changeset:${"0".repeat(64)}`,
    };

    await expect(
      applyCheckpointRestore(store, digestTampered),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_CHANGE_SET",
      message: "The checkpoint restore change set digest is invalid.",
    });
    expect(await readFile(join(root, TARGET_PATH))).toEqual(AFTER);
  });
});

async function commitFixture(
  store: DocumentStore,
  root: string,
): Promise<{
  checkpoint: CheckpointManifest;
  commitRevision: string;
}> {
  await writeFile(join(root, TARGET_PATH), EXACT_BEFORE);
  const commit = await store.commitBytes(
    TARGET_PATH,
    revisionOf(EXACT_BEFORE),
    AFTER,
    "edit before restore",
  );
  if (commit.checkpointId === null) {
    throw new Error("test fixture unexpectedly produced no checkpoint");
  }
  return {
    checkpoint: await store.checkpoints.read(commit.checkpointId),
    commitRevision: commit.revision,
  };
}

async function writeManifest(
  root: string,
  manifest: CheckpointManifest,
): Promise<void> {
  await writeFile(
    manifestFilePath(root, manifest.id),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function manifestFilePath(root: string, checkpointId: string): string {
  return join(
    root,
    ".tiledmcp",
    "checkpoints",
    `${checkpointId}.json`,
  );
}

async function checkpointFileNames(root: string): Promise<string[]> {
  return (
    await readdir(join(root, ".tiledmcp", "checkpoints"))
  ).sort();
}
