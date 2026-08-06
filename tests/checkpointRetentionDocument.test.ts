import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
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
  checkpointRetentionOutputSchema,
  commitResultOutputSchema,
} from "../src/outputSchemas/common.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  ROLLING_CHECKPOINT_RETENTION_POLICY,
} from "../src/storage/checkpoints.js";
import { DocumentStore } from "../src/storage/documentStore.js";
import { revisionOf } from "../src/storage/revision.js";

describe("DocumentStore rolling checkpoint retention", () => {
  let root: string;
  let resolver: ProjectPathResolver;

  beforeEach(async () => {
    root = await mkdtemp(
      join(
        tmpdir(),
        "tiledmcp-document-retention-",
      ),
    );
    await mkdir(join(root, "maps"));
    resolver =
      await ProjectPathResolver.create(root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  it("preserves the existing wire shape when retention is disabled", async () => {
    const store = makeStore(resolver);
    const initial = documentBytes(0);
    const target = join(
      root,
      "maps",
      "level.tmj",
    );
    await writeFile(target, initial);

    const result = await store.commitBytes(
      "maps/level.tmj",
      revisionOf(initial),
      documentBytes(1),
      "retention disabled",
    );

    expect(result).not.toHaveProperty(
      "checkpointRetention",
    );
    expect(
      commitResultOutputSchema.safeParse(
        result,
      ).success,
    ).toBe(true);
    const checkpoint =
      await store.checkpoints.read(
        result.checkpointId as string,
      );
    expect(checkpoint.version).toBe(1);
  });

  it("reports not-needed, then deletes only the oldest rolling checkpoint after the third edit", async () => {
    const store = retentionStore(2);
    const target = join(
      root,
      "maps",
      "level.tmj",
    );
    let current = documentBytes(0);
    await writeFile(target, current);

    const results = [];
    for (let step = 1; step <= 3; step += 1) {
      const next = documentBytes(step);
      const result = await store.commitBytes(
        "maps/level.tmj",
        revisionOf(current),
        next,
        `rolling edit ${step}`,
      );
      results.push(result);
      current = next;
    }

    expect(
      results[0]?.checkpointRetention,
    ).toEqual({
      policy:
        ROLLING_CHECKPOINT_RETENTION_POLICY,
      retainCommittedPerTarget: 2,
      status: "not-needed",
      manifestDeleted: false,
      rollingCommittedCount: 1,
    });
    expect(
      results[1]?.checkpointRetention,
    ).toEqual({
      policy:
        ROLLING_CHECKPOINT_RETENTION_POLICY,
      retainCommittedPerTarget: 2,
      status: "not-needed",
      manifestDeleted: false,
      rollingCommittedCount: 2,
    });
    expect(
      results[2]?.checkpointRetention,
    ).toMatchObject({
      policy:
        ROLLING_CHECKPOINT_RETENTION_POLICY,
      retainCommittedPerTarget: 2,
      status: "deleted",
      manifestDeleted: true,
      deletedCheckpointId:
        results[0]?.checkpointId,
      rollingCommittedCountBefore: 3,
      garbageCollection: {
        status: "completed",
      },
    });
    expect(
      checkpointRetentionOutputSchema.safeParse(
        results[2]?.checkpointRetention,
      ).success,
    ).toBe(true);
    expect(
      commitResultOutputSchema.safeParse(
        results[2],
      ).success,
    ).toBe(true);
    const listing =
      await store.checkpoints.list({
        status: "committed",
      });
    expect(
      listing.manifests.map(({ id }) => id),
    ).toEqual(
      expect.arrayContaining([
        results[1]?.checkpointId,
        results[2]?.checkpointId,
      ]),
    );
    expect(listing.manifests).toHaveLength(2);
    await expect(
      store.checkpoints.read(
        results[0]?.checkpointId as string,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_NOT_FOUND",
    });
    expect(await readFile(target)).toEqual(
      current,
    );
  });

  it("keeps create checkpoints protected and omits retention from their result", async () => {
    const store = retentionStore(2);

    const result = await store.create(
      "maps/created.tmj",
      {
        type: "map",
        version: "1.10",
        step: 0,
      },
      "protected create",
    );

    expect(result).not.toHaveProperty(
      "checkpointRetention",
    );
    const checkpoint =
      await store.checkpoints.read(
        result.checkpointId as string,
      );
    expect(checkpoint).toMatchObject({
      version: 2,
      status: "committed",
      retention: {
        class: "protected",
      },
      before: {
        existed: false,
      },
    });
  });

  it("runs the same rolling retention after a changed restore", async () => {
    const store = retentionStore(2);
    const target = join(
      root,
      "maps",
      "level.tmj",
    );
    const initial = documentBytes(0);
    const firstBytes = documentBytes(1);
    const secondBytes = documentBytes(2);
    await writeFile(target, initial);
    const first = await store.commitBytes(
      "maps/level.tmj",
      revisionOf(initial),
      firstBytes,
      "first edit before restore",
    );
    const second = await store.commitBytes(
      "maps/level.tmj",
      revisionOf(firstBytes),
      secondBytes,
      "second edit before restore",
    );

    const restored = await store.revert(
      second.checkpointId as string,
      revisionOf(secondBytes),
    );

    expect(restored).toMatchObject({
      changed: true,
      revision: revisionOf(firstBytes),
      checkpointRetention: {
        status: "deleted",
        manifestDeleted: true,
        deletedCheckpointId:
          first.checkpointId,
        rollingCommittedCountBefore: 3,
      },
    });
    expect(await readFile(target)).toEqual(
      firstBytes,
    );
  });

  it("keeps a committed document successful and observable when retention throws before unlink", async () => {
    const store = retentionStore(2);
    const initial = documentBytes(0);
    const next = documentBytes(1);
    const target = join(
      root,
      "maps",
      "level.tmj",
    );
    await writeFile(target, initial);
    vi.spyOn(
      store.checkpoints,
      "enforceRollingRetention",
    ).mockRejectedValue(
      new Error("injected retention failure"),
    );

    const result = await store.commitBytes(
      "maps/level.tmj",
      revisionOf(initial),
      next,
      "retention failure",
    );

    expect(result).toMatchObject({
      changed: true,
      revision: revisionOf(next),
      checkpointRetention: {
        policy:
          ROLLING_CHECKPOINT_RETENTION_POLICY,
        retainCommittedPerTarget: 2,
        status: "failed",
        manifestDeleted: false,
        failureCode: "INTERNAL_ERROR",
      },
      warnings: [
        expect.stringContaining(
          "automatic checkpoint retention could not be completed",
        ),
      ],
    });
    expect(await readFile(target)).toEqual(
      next,
    );
    expect(
      commitResultOutputSchema.safeParse(
        result,
      ).success,
    ).toBe(true);
    expect(
      await store.checkpoints.read(
        result.checkpointId as string,
      ),
    ).toMatchObject({
      status: "committed",
    });
  });

  it("keeps the document mutation successful when a prepared checkpoint blocks retention", async () => {
    const store = retentionStore(2);
    const initial = documentBytes(0);
    const next = documentBytes(1);
    const target = join(
      root,
      "maps",
      "level.tmj",
    );
    await writeFile(target, initial);
    await store.checkpoints.prepare(
      "maps/level.tmj",
      initial,
      revisionOf(documentBytes(77)),
      "prepared retention blocker",
    );

    const result = await store.commitBytes(
      "maps/level.tmj",
      revisionOf(initial),
      next,
      "commit despite retention blocker",
    );

    expect(result).toMatchObject({
      changed: true,
      revision: revisionOf(next),
      checkpointRetention: {
        status: "blocked",
        manifestDeleted: false,
        reason:
          "prepared-checkpoint-present",
      },
      warnings: [
        expect.stringContaining(
          "automatic checkpoint retention was blocked",
        ),
      ],
    });
    expect(await readFile(target)).toEqual(
      next,
    );
    expect(
      await store.checkpoints.read(
        result.checkpointId as string,
      ),
    ).toMatchObject({
      status: "committed",
    });
  });

  it("uses a bounded target revision validation callback and surfaces a blocked result", async () => {
    const store = retentionStore(2);
    const initial = documentBytes(0);
    const next = documentBytes(1);
    const external = documentBytes(99);
    const target = join(
      root,
      "maps",
      "level.tmj",
    );
    await writeFile(target, initial);
    vi.spyOn(
      store.checkpoints,
      "enforceRollingRetention",
    ).mockImplementation(
      async (current, validateTarget) => {
        await writeFile(target, external);
        await expect(
          validateTarget(current),
        ).rejects.toMatchObject({
          code: "REVISION_CONFLICT",
          details: {
            expectedRevision:
              current.afterRevision,
            actualRevision:
              revisionOf(external),
          },
        });
        return {
          policy:
            ROLLING_CHECKPOINT_RETENTION_POLICY,
          retainCommittedPerTarget: 2,
          status: "blocked",
          manifestDeleted: false,
          reason:
            "target-validation-failed",
          rollingCommittedCount: 1,
        };
      },
    );

    const result = await store.commitBytes(
      "maps/level.tmj",
      revisionOf(initial),
      next,
      "target validation",
    );

    expect(result).toMatchObject({
      changed: true,
      checkpointRetention: {
        status: "blocked",
        manifestDeleted: false,
        reason:
          "target-validation-failed",
      },
      warnings: [
        expect.stringContaining(
          "automatic checkpoint retention was blocked",
        ),
      ],
    });
    expect(await readFile(target)).toEqual(
      external,
    );
  });

  it("does not run retention when target durability is unconfirmed", async () => {
    const store = retentionStore(2);
    const initial = documentBytes(0);
    const next = documentBytes(1);
    const target = join(
      root,
      "maps",
      "level.tmj",
    );
    await writeFile(target, initial);
    const retention = vi.spyOn(
      store.checkpoints,
      "enforceRollingRetention",
    );
    const internals =
      store as unknown as {
        atomicReplaceConfirmed(
          absolutePath: string,
          content: Buffer,
          expectedRevision: string,
          projectPath: string,
        ): Promise<string[]>;
      };
    vi.spyOn(
      internals,
      "atomicReplaceConfirmed",
    ).mockImplementation(
      async (absolutePath, content) => {
        await writeFile(
          absolutePath,
          content,
        );
        return [
          "The target contains the requested bytes, but a post-replace durability step failed; inspect filesystem health.",
        ];
      },
    );

    const result = await store.commitBytes(
      "maps/level.tmj",
      revisionOf(initial),
      next,
      "durability warning",
    );

    expect(result).not.toHaveProperty(
      "checkpointRetention",
    );
    expect(result.warnings).toEqual([
      expect.stringContaining(
        "post-replace durability step failed",
      ),
    ]);
    expect(retention).not.toHaveBeenCalled();
    expect(await readFile(target)).toEqual(
      next,
    );
    expect(
      await store.checkpoints.read(
        result.checkpointId as string,
      ),
    ).toMatchObject({
      status: "committed",
    });
  });

  it("does not run retention when the new checkpoint remains prepared", async () => {
    const store = retentionStore(2);
    const initial = documentBytes(0);
    const next = documentBytes(1);
    const target = join(
      root,
      "maps",
      "level.tmj",
    );
    await writeFile(target, initial);
    vi.spyOn(
      store.checkpoints,
      "markCommitted",
    ).mockRejectedValue(
      new Error("injected commit-state failure"),
    );
    const retention = vi.spyOn(
      store.checkpoints,
      "enforceRollingRetention",
    );

    const result = await store.commitBytes(
      "maps/level.tmj",
      revisionOf(initial),
      next,
      "prepared retention guard",
    );

    expect(result).toMatchObject({
      changed: true,
      revision: revisionOf(next),
      warnings: [
        expect.stringContaining(
          "remains prepared and needs reconciliation",
        ),
      ],
    });
    expect(result).not.toHaveProperty(
      "checkpointRetention",
    );
    expect(retention).not.toHaveBeenCalled();
    expect(await readFile(target)).toEqual(
      next,
    );
    expect(
      await store.checkpoints.read(
        result.checkpointId as string,
      ),
    ).toMatchObject({
      status: "prepared",
    });
  });

  it("preserves manifestDeleted when post-unlink retention cleanup fails", async () => {
    const store = retentionStore(2);
    const initial = documentBytes(0);
    const next = documentBytes(1);
    const target = join(
      root,
      "maps",
      "level.tmj",
    );
    await writeFile(target, initial);
    const deletedCheckpointId =
      "00000000-0000-4000-8000-000000000001";
    vi.spyOn(
      store.checkpoints,
      "enforceRollingRetention",
    ).mockResolvedValue({
      policy:
        ROLLING_CHECKPOINT_RETENTION_POLICY,
      retainCommittedPerTarget: 2,
      status: "deleted",
      manifestDeleted: true,
      deletedCheckpointId,
      rollingCommittedCountBefore: 3,
      garbageCollection: {
        status: "failed",
        failureCode: "INTERNAL_ERROR",
        deletionOutcome:
          "unknown-partial-or-none",
      },
    });

    const result = await store.commitBytes(
      "maps/level.tmj",
      revisionOf(initial),
      next,
      "post-unlink retention failure",
    );

    expect(result).toMatchObject({
      changed: true,
      checkpointRetention: {
        status: "deleted",
        manifestDeleted: true,
        deletedCheckpointId,
        garbageCollection: {
          status: "failed",
          deletionOutcome:
            "unknown-partial-or-none",
        },
      },
      warnings: [
        expect.stringContaining(
          "unlinked an older recovery checkpoint",
        ),
      ],
    });
    expect(await readFile(target)).toEqual(
      next,
    );
    expect(
      commitResultOutputSchema.safeParse(
        result,
      ).success,
    ).toBe(true);
  });

  it("keeps the retention output schema closed", () => {
    const valid = {
      policy:
        ROLLING_CHECKPOINT_RETENTION_POLICY,
      retainCommittedPerTarget: 2,
      status: "failed",
      manifestDeleted: false,
      failureCode: "INTERNAL_ERROR",
    } as const;

    expect(
      checkpointRetentionOutputSchema.safeParse(
        valid,
      ).success,
    ).toBe(true);
    expect(
      checkpointRetentionOutputSchema.safeParse({
        ...valid,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      checkpointRetentionOutputSchema.safeParse({
        ...valid,
        manifestDeleted: true,
      }).success,
    ).toBe(false);
  });

  function retentionStore(
    retainCommittedPerTarget: number,
  ): DocumentStore {
    return makeStore(resolver, { checkpointOptions: { retainCommittedPerTarget } });
  }
});

function documentBytes(step: number): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      type: "map",
      version: "1.10",
      step,
    })}\n`,
    "utf8",
  );
}
