import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
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
  CHECKPOINT_STORAGE_POLICY,
  type CheckpointManifest,
} from "../src/storage/checkpoints.js";
import {
  DocumentStore,
} from "../src/storage/documentStore.js";
import { withProjectFileLock } from "../src/storage/fileLock.js";
import { revisionOf } from "../src/storage/revision.js";

const TARGET = "maps/level.tmj";
const BEFORE = Buffer.from(
  '{"type":"map","state":"before"}\n',
  "utf8",
);
const AFTER = Buffer.from(
  '{"type":"map","state":"after"}\n',
  "utf8",
);
const UNRELATED = Buffer.from(
  '{"type":"map","state":"unrelated"}\n',
  "utf8",
);

describe("prepared checkpoint adjudication storage", () => {
  let root: string;
  let resolver: ProjectPathResolver;
  let store: DocumentStore;

  beforeEach(async () => {
    root = await mkdtemp(
      join(
        tmpdir(),
        "tiledmcp-prepared-adjudication-",
      ),
    );
    await mkdir(join(root, "maps"));
    resolver =
      await ProjectPathResolver.create(root);
    store = new DocumentStore(resolver);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  it("commits only an ambiguous landed create while preserving the target and recovery point", async () => {
    const prepared =
      await prepareCreate(store);
    await writeFile(
      join(root, TARGET),
      AFTER,
    );
    const targetBefore = await readFile(
      join(root, TARGET),
    );

    const inspection =
      await store.inspectPreparedCheckpointCommit(
        prepared.id,
      );

    expect(inspection.checkpoint).toMatchObject({
      version: 1,
      id: prepared.id,
      status: "prepared",
      before: { existed: false },
      target: {
        existed: true,
        revision: revisionOf(AFTER),
        size: AFTER.byteLength,
      },
      conflict:
        "create-target-matches-after",
    });
    expect(
      inspection.checkpoint.retention,
    ).toBeUndefined();

    const result =
      await store.commitPreparedCheckpointPlanned(
        inspection.checkpoint,
      );

    expect(result).toMatchObject({
      kind: "preparedCheckpointCommit",
      checkpoint: {
        version: 1,
        id: prepared.id,
        status: "committed",
      },
      previousStatus: "prepared",
      conflict:
        "create-target-matches-after",
      manifestCommitted: true,
      projectAssetModified: false,
      durability: "confirmed",
    });
    expect(result.warnings).toBeUndefined();
    expect(
      (await store.checkpoints.read(prepared.id))
        .status,
    ).toBe("committed");
    expect(
      await readFile(join(root, TARGET)),
    ).toEqual(targetBefore);
  });

  it("preserves and pins v2 protected retention metadata across prepared commit", async () => {
    const retained = new DocumentStore(
      resolver,
      64 * 1024 * 1024,
      undefined,
      {
        retainCommittedPerTarget: 2,
      },
    );
    const prepared =
      await prepareCreate(retained);
    await writeFile(
      join(root, TARGET),
      AFTER,
    );

    const inspection =
      await retained.inspectPreparedCheckpointCommit(
        prepared.id,
      );
    expect(inspection.checkpoint).toMatchObject({
      version: 2,
      retention: {
        class: "protected",
      },
    });

    const result =
      await retained.commitPreparedCheckpointPlanned(
        inspection.checkpoint,
      );

    expect(result.checkpoint).toMatchObject({
      version: 2,
      retention: {
        class: "protected",
      },
      status: "committed",
    });
    expect(
      await retained.checkpoints.read(
        prepared.id,
      ),
    ).toMatchObject({
      version: 2,
      retention: {
        class: "protected",
      },
      status: "committed",
    });
  });

  it.each([
    {
      name: "a matching create target",
      fixture: async (
        current: DocumentStore,
        projectRoot: string,
      ) => {
        const prepared =
          await prepareCreate(current);
        await writeFile(
          join(projectRoot, TARGET),
          AFTER,
        );
        return {
          prepared,
          conflict:
            "create-target-matches-after" as const,
          target: {
            existed: true,
            revision: revisionOf(AFTER),
            size: AFTER.byteLength,
          },
        };
      },
    },
    {
      name: "an unrelated create target",
      fixture: async (
        current: DocumentStore,
        projectRoot: string,
      ) => {
        const prepared =
          await prepareCreate(current);
        await writeFile(
          join(projectRoot, TARGET),
          UNRELATED,
        );
        return {
          prepared,
          conflict:
            "create-target-unrelated" as const,
          target: {
            existed: true,
            revision: revisionOf(UNRELATED),
            size: UNRELATED.byteLength,
          },
        };
      },
    },
    {
      name: "a missing existing-file target",
      fixture: async (
        current: DocumentStore,
        projectRoot: string,
      ) => {
        const prepared =
          await prepareExisting(
            current,
            projectRoot,
          );
        await unlink(join(projectRoot, TARGET));
        return {
          prepared,
          conflict:
            "existing-target-missing" as const,
          target: { existed: false as const },
        };
      },
    },
    {
      name: "an unrelated existing-file target",
      fixture: async (
        current: DocumentStore,
        projectRoot: string,
      ) => {
        const prepared =
          await prepareExisting(
            current,
            projectRoot,
          );
        await writeFile(
          join(projectRoot, TARGET),
          UNRELATED,
        );
        return {
          prepared,
          conflict:
            "existing-target-unrelated" as const,
          target: {
            existed: true,
            revision: revisionOf(UNRELATED),
            size: UNRELATED.byteLength,
          },
        };
      },
    },
  ])(
    "abandons $name without modifying the project asset",
    async ({ fixture }) => {
      const {
        prepared,
        conflict: expectedConflict,
        target: expectedTarget,
      } = await fixture(store, root);
      const targetBefore =
        await readTargetIfPresent();

      const inspection =
        await store.inspectPreparedCheckpointAbandon(
          prepared.id,
        );
      expect(inspection.checkpoint).toMatchObject({
        id: prepared.id,
        conflict: expectedConflict,
        target: expectedTarget,
      });

      const result =
        await store.abandonPreparedCheckpointPlanned(
          inspection.checkpoint,
        );

      expect(result).toMatchObject({
        kind: "preparedCheckpointAbandon",
        checkpoint: {
          id: prepared.id,
          status: "prepared",
        },
        conflict: expectedConflict,
        target: expectedTarget,
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
      expect(
        await readTargetIfPresent(),
      ).toEqual(targetBefore);
    },
  );

  it.each([
    "corrupt",
    "missing",
  ] as const)(
    "allows abandon when the existing-file before object is $state and never reads it as a prerequisite",
    async (state) => {
      const prepared =
        await prepareExisting(store, root);
      if (!prepared.before.existed) {
        throw new Error(
          "Expected an existing-file checkpoint.",
        );
      }
      await writeFile(
        join(root, TARGET),
        UNRELATED,
      );
      const inspection =
        await store.inspectPreparedCheckpointAbandon(
          prepared.id,
        );
      const objectPath = join(
        root,
        ".tiledmcp",
        "objects",
        prepared.before.objectHash,
      );
      if (state === "corrupt") {
        await writeFile(
          objectPath,
          Buffer.from("corrupt object"),
        );
      } else {
        await unlink(objectPath);
      }

      const result =
        await store.abandonPreparedCheckpointPlanned(
          inspection.checkpoint,
        );

      expect(result).toMatchObject({
        manifestDeleted: true,
        garbageCollection: {
          status: "completed",
          deletedObjects:
            state === "corrupt" ? 1 : 0,
        },
      });
      await expect(
        readFile(objectPath),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        await readFile(join(root, TARGET)),
      ).toEqual(UNRELATED);
    },
  );

  it("returns bounded unconfirmed success after the commit rename hook fails and does not run garbage collection", async () => {
    const observed: string[] = [];
    const faulting = new DocumentStore(
      resolver,
      64 * 1024 * 1024,
      undefined,
      {
        observer: {
          afterPreparedCheckpointCommitInstalledBeforeDirectorySync({
            checkpointId,
          }) {
            observed.push(checkpointId);
            throw new Error(
              "injected post-rename fault",
            );
          },
        },
      },
    );
    const prepared =
      await prepareCreate(faulting);
    await writeFile(
      join(root, TARGET),
      AFTER,
    );
    const orphanHash = "f".repeat(64);
    const orphanPath = join(
      root,
      ".tiledmcp",
      "objects",
      orphanHash,
    );
    await writeFile(
      orphanPath,
      Buffer.from("unreferenced"),
    );

    const result =
      await faulting.commitPreparedCheckpointPlanned(
        (
          await faulting.inspectPreparedCheckpointCommit(
            prepared.id,
          )
        ).checkpoint,
      );

    expect(observed).toEqual([prepared.id]);
    expect(result).toMatchObject({
      manifestCommitted: true,
      durability: "unconfirmed",
      warnings: [
        expect.stringContaining(
          "post-rename durability could not be confirmed",
        ),
      ],
    });
    expect(
      await faulting.checkpoints.read(
        prepared.id,
      ),
    ).toMatchObject({
      status: "committed",
    });
    expect(await readFile(orphanPath)).toEqual(
      Buffer.from("unreferenced"),
    );
    expect(
      await readFile(join(root, TARGET)),
    ).toEqual(AFTER);
  });

  it("keeps committed success bounded when both store and target lock release become unconfirmable after rename", async () => {
    const locksDirectory =
      await resolver.ensureInternalDirectory(
        ".tiledmcp/locks",
      );
    let changedLockCount = 0;
    const releaseFaulting =
      new DocumentStore(
        resolver,
        64 * 1024 * 1024,
        undefined,
        {
          observer: {
            async afterPreparedCheckpointCommitInstalledBeforeDirectorySync() {
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
        },
      );
    const prepared =
      await prepareCreate(releaseFaulting);
    await writeFile(
      join(root, TARGET),
      AFTER,
    );
    const expectation = (
      await releaseFaulting.inspectPreparedCheckpointCommit(
        prepared.id,
      )
    ).checkpoint;
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    let result;
    try {
      result =
        await releaseFaulting.commitPreparedCheckpointPlanned(
          expectation,
        );
    } finally {
      stderr.mockRestore();
    }

    expect(changedLockCount).toBe(2);
    expect(result).toMatchObject({
      manifestCommitted: true,
      durability: "unconfirmed",
      warnings: [
        expect.stringContaining(
          "post-rename durability could not be confirmed",
        ),
        expect.stringContaining(
          "release of its target lock could not be confirmed",
        ),
      ],
    });
    expect(
      await releaseFaulting.checkpoints.read(
        prepared.id,
      ),
    ).toMatchObject({
      status: "committed",
    });
    expect(
      (await readdir(locksDirectory)).filter(
        (name) => name.endsWith(".lock"),
      ),
    ).toHaveLength(2);
  });

  it("keeps abandon success bounded when post-unlink durability or garbage collection cannot be confirmed", async () => {
    const observed: string[] = [];
    const faulting = new DocumentStore(
      resolver,
      64 * 1024 * 1024,
      undefined,
      {
        observer: {
          afterManifestDeletedBeforeGarbageCollection({
            checkpointId,
          }) {
            observed.push(checkpointId);
            throw new Error(
              "injected post-unlink fault",
            );
          },
        },
      },
    );
    const prepared =
      await prepareCreate(faulting);
    await writeFile(
      join(root, TARGET),
      UNRELATED,
    );

    const result =
      await faulting.abandonPreparedCheckpointPlanned(
        (
          await faulting.inspectPreparedCheckpointAbandon(
            prepared.id,
          )
        ).checkpoint,
      );

    expect(observed).toEqual([prepared.id]);
    expect(result).toMatchObject({
      manifestDeleted: true,
      projectAssetModified: false,
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
    await expect(
      faulting.checkpoints.read(prepared.id),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_NOT_FOUND",
    });
    expect(
      await readFile(join(root, TARGET)),
    ).toEqual(UNRELATED);
  });

  it("returns bounded abandon success when failure occurs after unlink but before checkpoint-directory fsync", async () => {
    const observed: string[] = [];
    const faulting = new DocumentStore(
      resolver,
      64 * 1024 * 1024,
      undefined,
      {
        observer: {
          afterPreparedCheckpointAbandonManifestUnlinkedBeforeDirectorySync({
            checkpointId,
          }) {
            observed.push(checkpointId);
            throw new Error(
              "injected pre-directory-sync fault",
            );
          },
        },
      },
    );
    const prepared =
      await prepareCreate(faulting);
    await writeFile(
      join(root, TARGET),
      UNRELATED,
    );

    const result =
      await faulting.abandonPreparedCheckpointPlanned(
        (
          await faulting.inspectPreparedCheckpointAbandon(
            prepared.id,
          )
        ).checkpoint,
      );

    expect(observed).toEqual([prepared.id]);
    expect(result).toMatchObject({
      manifestDeleted: true,
      projectAssetModified: false,
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
    await expect(
      faulting.checkpoints.read(prepared.id),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_NOT_FOUND",
    });
    expect(
      await readFile(join(root, TARGET)),
    ).toEqual(UNRELATED);
  });

  it("rejects raw manifest, semantic retention, status, and target drift before any adjudication mutation", async () => {
    const rawPrepared =
      await prepareCreate(store);
    await writeFile(
      join(root, TARGET),
      AFTER,
    );
    const rawExpectation = (
      await store.inspectPreparedCheckpointCommit(
        rawPrepared.id,
      )
    ).checkpoint;
    const rawPath = manifestPath(rawPrepared.id);
    const parsed = JSON.parse(
      await readFile(rawPath, "utf8"),
    ) as CheckpointManifest;
    await writeFile(
      rawPath,
      ` ${JSON.stringify(parsed, null, 2)}\n`,
      "utf8",
    );
    await expect(
      store.commitPreparedCheckpointPlanned(
        rawExpectation,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CHANGED",
    });
    expect(
      (await store.checkpoints.read(rawPrepared.id))
        .status,
    ).toBe("prepared");

    const statusPrepared =
      await store.checkpoints.prepare(
        "maps/status.tmj",
        undefined,
        revisionOf(AFTER),
        "status drift",
      );
    await writeFile(
      join(root, "maps/status.tmj"),
      AFTER,
    );
    const statusExpectation = (
      await store.inspectPreparedCheckpointCommit(
        statusPrepared.id,
      )
    ).checkpoint;
    await store.checkpoints.markCommitted(
      statusPrepared,
    );
    await expect(
      store.commitPreparedCheckpointPlanned(
        statusExpectation,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CHANGED",
    });

    const targetPrepared =
      await store.checkpoints.prepare(
        "maps/target.tmj",
        undefined,
        revisionOf(AFTER),
        "target drift",
      );
    const targetPath = join(
      root,
      "maps/target.tmj",
    );
    await writeFile(targetPath, AFTER);
    const targetExpectation = (
      await store.inspectPreparedCheckpointCommit(
        targetPrepared.id,
      )
    ).checkpoint;
    await writeFile(targetPath, UNRELATED);
    await expect(
      store.commitPreparedCheckpointPlanned(
        targetExpectation,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CHANGED",
    });
    expect(
      (await store.checkpoints.read(
        targetPrepared.id,
      )).status,
    ).toBe("prepared");

    const retained = new DocumentStore(
      resolver,
      64 * 1024 * 1024,
      undefined,
      {
        retainCommittedPerTarget: 2,
      },
    );
    const retentionPrepared =
      await retained.checkpoints.prepare(
        "maps/retention.tmj",
        undefined,
        revisionOf(AFTER),
        "retention drift",
      );
    await writeFile(
      join(root, "maps/retention.tmj"),
      AFTER,
    );
    const retentionExpectation = (
      await retained.inspectPreparedCheckpointCommit(
        retentionPrepared.id,
      )
    ).checkpoint;
    const retentionPath = manifestPath(
      retentionPrepared.id,
    );
    const retentionManifest = JSON.parse(
      await readFile(retentionPath, "utf8"),
    ) as Record<string, unknown>;
    const {
      retention: _retention,
      ...legacyManifest
    } = retentionManifest;
    await writeFile(
      retentionPath,
      `${JSON.stringify({
        ...legacyManifest,
        version: 1,
      }, null, 2)}\n`,
      "utf8",
    );
    await expect(
      retained.commitPreparedCheckpointPlanned(
        retentionExpectation,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CHANGED",
    });
  });

  it("rejects abandon target, raw-manifest, and status drift before deletion or garbage collection", async () => {
    const unrelatedA = Buffer.from(
      '{"type":"map","state":"unrelated-a"}\n',
      "utf8",
    );
    const unrelatedB = Buffer.from(
      '{"type":"map","state":"unrelated-b"}\n',
      "utf8",
    );
    const orphanPath = join(
      root,
      ".tiledmcp",
      "objects",
      "e".repeat(64),
    );

    const targetPath =
      "maps/abandon-target-drift.tmj";
    const targetPrepared =
      await store.checkpoints.prepare(
        targetPath,
        undefined,
        revisionOf(AFTER),
        "abandon target drift",
      );
    await writeFile(
      join(root, targetPath),
      unrelatedA,
    );
    const targetExpectation = (
      await store.inspectPreparedCheckpointAbandon(
        targetPrepared.id,
      )
    ).checkpoint;
    await writeFile(orphanPath, "orphan");
    await writeFile(
      join(root, targetPath),
      unrelatedB,
    );
    await expect(
      store.abandonPreparedCheckpointPlanned(
        targetExpectation,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CHANGED",
    });
    expect(
      (
        await store.checkpoints.read(
          targetPrepared.id,
        )
      ).status,
    ).toBe("prepared");

    const rawPath =
      "maps/abandon-raw-drift.tmj";
    const rawPrepared =
      await store.checkpoints.prepare(
        rawPath,
        undefined,
        revisionOf(AFTER),
        "abandon raw drift",
      );
    await writeFile(
      join(root, rawPath),
      unrelatedA,
    );
    const rawExpectation = (
      await store.inspectPreparedCheckpointAbandon(
        rawPrepared.id,
      )
    ).checkpoint;
    const rawManifestPath =
      manifestPath(rawPrepared.id);
    const rawManifest = JSON.parse(
      await readFile(rawManifestPath, "utf8"),
    ) as CheckpointManifest;
    await writeFile(
      rawManifestPath,
      ` ${JSON.stringify(rawManifest, null, 2)}\n`,
      "utf8",
    );
    await expect(
      store.abandonPreparedCheckpointPlanned(
        rawExpectation,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CHANGED",
    });
    expect(
      (
        await store.checkpoints.read(
          rawPrepared.id,
        )
      ).status,
    ).toBe("prepared");

    const statusPath =
      "maps/abandon-status-drift.tmj";
    const statusPrepared =
      await store.checkpoints.prepare(
        statusPath,
        undefined,
        revisionOf(AFTER),
        "abandon status drift",
      );
    await writeFile(
      join(root, statusPath),
      unrelatedA,
    );
    const statusExpectation = (
      await store.inspectPreparedCheckpointAbandon(
        statusPrepared.id,
      )
    ).checkpoint;
    await store.checkpoints.markCommitted(
      statusPrepared,
    );
    await expect(
      store.abandonPreparedCheckpointPlanned(
        statusExpectation,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CHANGED",
    });
    expect(
      (
        await store.checkpoints.read(
          statusPrepared.id,
        )
      ).status,
    ).toBe("committed");

    expect(await readFile(orphanPath, "utf8")).toBe(
      "orphan",
    );
    expect(
      await readFile(join(root, targetPath)),
    ).toEqual(unrelatedB);
    expect(
      await readFile(join(root, rawPath)),
    ).toEqual(unrelatedA);
    expect(
      await readFile(join(root, statusPath)),
    ).toEqual(unrelatedA);
  });

  it.each([
    {
      name: "missing create target",
      fixture: async (
        current: DocumentStore,
        _root: string,
      ) => prepareCreate(current),
    },
    {
      name: "exact existing before target",
      fixture: async (
        current: DocumentStore,
        projectRoot: string,
      ) =>
        prepareExisting(
          current,
          projectRoot,
        ),
    },
    {
      name: "exact existing after target",
      fixture: async (
        current: DocumentStore,
        projectRoot: string,
      ) => {
        const prepared =
          await prepareExisting(
            current,
            projectRoot,
          );
        await writeFile(
          join(projectRoot, TARGET),
          AFTER,
        );
        return prepared;
      },
    },
    {
      name: "indistinguishable existing before/after target",
      fixture: async (
        current: DocumentStore,
        projectRoot: string,
      ) => {
        await writeFile(
          join(projectRoot, TARGET),
          BEFORE,
        );
        return current.checkpoints.prepare(
          TARGET,
          BEFORE,
          revisionOf(BEFORE),
          "indistinguishable no-op",
        );
      },
    },
  ])(
    "rejects the machine-processable $name",
    async ({ fixture }) => {
      const prepared = await fixture(
        store,
        root,
      );

      await expect(
        store.inspectPreparedCheckpointAbandon(
          prepared.id,
        ),
      ).rejects.toMatchObject({
        code: "CHECKPOINT_STATE_CONFLICT",
      });
      expect(
        (await store.checkpoints.read(prepared.id))
          .status,
      ).toBe("prepared");
    },
  );

  it("fails closed when a target matches the before revision but not its pinned size", async () => {
    const prepared =
      await prepareExisting(store, root);
    const path = manifestPath(prepared.id);
    const manifest = JSON.parse(
      await readFile(path, "utf8"),
    ) as CheckpointManifest;
    if (!manifest.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint.",
      );
    }
    manifest.before.size += 1;
    await writeFile(
      path,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    const manifestBefore = await readFile(path);

    await expect(
      store.inspectPreparedCheckpointAbandon(
        prepared.id,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_STATE_CONFLICT",
    });
    expect(await readFile(path)).toEqual(
      manifestBefore,
    );
    expect(
      await readFile(join(root, TARGET)),
    ).toEqual(BEFORE);
  });

  it.each([
    {
      name: "symbolic link",
      makeTarget: async (
        projectRoot: string,
      ) => {
        await writeFile(
          join(projectRoot, "maps/real.tmj"),
          AFTER,
        );
        await symlink(
          "real.tmj",
          join(projectRoot, TARGET),
        );
      },
      maxBytes: 64 * 1024 * 1024,
    },
    {
      name: "directory",
      makeTarget: async (
        projectRoot: string,
      ) => {
        await mkdir(join(projectRoot, TARGET));
      },
      maxBytes: 64 * 1024 * 1024,
    },
    {
      name: "oversized regular file",
      makeTarget: async (
        projectRoot: string,
      ) => {
        await writeFile(
          join(projectRoot, TARGET),
          AFTER,
        );
      },
      maxBytes: AFTER.byteLength - 1,
    },
  ])(
    "rejects an unsafe $name target without changing the manifest",
    async ({ makeTarget, maxBytes }) => {
      const constrained = new DocumentStore(
        resolver,
        maxBytes,
      );
      const prepared =
        await prepareCreate(constrained);
      await makeTarget(root);
      const manifestBefore = await readFile(
        manifestPath(prepared.id),
      );

      await expect(
        constrained.inspectPreparedCheckpointAbandon(
          prepared.id,
        ),
      ).rejects.toMatchObject({
        code: "CHECKPOINT_STATE_CONFLICT",
      });
      expect(
        await readFile(
          manifestPath(prepared.id),
        ),
      ).toEqual(manifestBefore);
    },
  );

  it("respects the target file lock before commit or abandon can mutate internal state", async () => {
    const prepared =
      await prepareCreate(store);
    await writeFile(
      join(root, TARGET),
      AFTER,
    );
    const expectation = (
      await store.inspectPreparedCheckpointCommit(
        prepared.id,
      )
    ).checkpoint;
    const abandonExpectation = (
      await store.inspectPreparedCheckpointAbandon(
        prepared.id,
      )
    ).checkpoint;
    const manifestBefore = await readFile(
      manifestPath(prepared.id),
    );

    await withProjectFileLock(
      resolver,
      TARGET,
      async () => {
        await expect(
          store.commitPreparedCheckpointPlanned(
            expectation,
          ),
        ).rejects.toMatchObject({
          code: "FILE_LOCKED",
        });
        await expect(
          store.abandonPreparedCheckpointPlanned(
            abandonExpectation,
          ),
        ).rejects.toMatchObject({
          code: "FILE_LOCKED",
        });
      },
    );

    expect(
      await readFile(manifestPath(prepared.id)),
    ).toEqual(manifestBefore);
    expect(
      await readFile(join(root, TARGET)),
    ).toEqual(AFTER);
  });

  it("publishes storage policy v6 adjudication pins, lock order, commit points, and GC behavior", () => {
    expect(CHECKPOINT_STORAGE_POLICY).toMatchObject({
      version: 6,
      explicitPreparedAdjudicationPins:
        expect.stringContaining(
          "raw-revision-and-size",
        ),
      explicitPreparedAdjudicationCoordination:
        "target-mutex-then-target-file-lock-then-checkpoint-store-lock",
      explicitPreparedCommitOrder:
        expect.stringContaining(
          "prepared-to-committed-rename",
        ),
      explicitPreparedCommitFailure:
        expect.stringContaining(
          "without-garbage-collection",
        ),
      explicitPreparedAbandonOrder:
        expect.stringContaining(
          "fail-closed-orphan-sweep",
        ),
      explicitPreparedAbandonFailure:
        expect.stringContaining(
          "post-unlink-failures",
        ),
    });
  });

  async function readTargetIfPresent(): Promise<
    Buffer | undefined
  > {
    try {
      return await readFile(join(root, TARGET));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  function manifestPath(
    checkpointId: string,
  ): string {
    return join(
      root,
      ".tiledmcp",
      "checkpoints",
      `${checkpointId}.json`,
    );
  }
});

async function prepareCreate(
  store: DocumentStore,
): Promise<CheckpointManifest> {
  return store.checkpoints.prepare(
    TARGET,
    undefined,
    revisionOf(AFTER),
    "ambiguous create",
  );
}

async function prepareExisting(
  store: DocumentStore,
  root: string,
): Promise<CheckpointManifest> {
  await writeFile(join(root, TARGET), BEFORE);
  return store.checkpoints.prepare(
    TARGET,
    BEFORE,
    revisionOf(AFTER),
    "ambiguous existing edit",
  );
}
