import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  lstat,
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
import { makeStore } from "./support/project.js";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  CHECKPOINT_STORAGE_LOCK_TARGET,
  CheckpointStore,
  type CheckpointManifest,
} from "../src/storage/checkpoints.js";
import {
  revisionOf,
  shortHash,
} from "../src/storage/revision.js";

const AFTER_REVISION = revisionOf(
  Buffer.from("after checkpoint bytes", "utf8"),
);

describe("checkpoint retained-storage quota and garbage collection", () => {
  let root: string;
  let resolver: ProjectPathResolver;

  beforeEach(async () => {
    root = await mkdtemp(
      join(tmpdir(), "tiledmcp-checkpoint-quota-"),
    );
    await mkdir(join(root, "maps"));
    resolver = await ProjectPathResolver.create(root);
  });

  afterEach(async () => {
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  it("reserves the exact byte and entry boundary while charging a shared object only once", async () => {
    const before = Buffer.from(
      '{"shared":"exact checkpoint bytes"}\n',
      "utf8",
    );
    const projectPath = "maps/shared.tmj";
    const label = "same-size manifest";
    const bootstrap = new CheckpointStore(resolver);
    const first = await bootstrap.prepare(
      projectPath,
      before,
      AFTER_REVISION,
      label,
    );
    const baseline =
      await bootstrap.collectGarbage();
    const firstManifestBytes = await readFile(
      manifestPath(first.id),
    );
    const firstManifest = JSON.parse(
      firstManifestBytes.toString("utf8"),
    ) as CheckpointManifest;
    const committedManifestBytes =
      Buffer.byteLength(
        `${JSON.stringify(
          {
            ...firstManifest,
            status: "committed",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    const nextManifestCharge = Math.max(
      firstManifestBytes.byteLength,
      committedManifestBytes,
    );
    const maxBytes =
      baseline.chargedBytes +
      nextManifestCharge;
    const maxEntries =
      baseline.observedEntries + 1;
    const constrained = new CheckpointStore(
      resolver,
      {
        maxBytes,
        maxEntries,
      },
    );

    const second = await constrained.prepare(
      projectPath,
      before,
      AFTER_REVISION,
      label,
    );
    await expect(
      constrained.markCommitted(second),
    ).resolves.toMatchObject({
      id: second.id,
      status: "committed",
    });
    const atBoundary =
      await constrained.collectGarbage();

    expect(atBoundary).toMatchObject({
      chargedBytes: maxBytes,
      observedEntries: maxEntries,
      retainedChargedBytes: maxBytes,
      retainedEntries: maxEntries,
      deletedEntries: 0,
      blocked: false,
    });
    expect(
      await canonicalObjectNames(),
    ).toEqual([
      createHash("sha256")
        .update(before)
        .digest("hex"),
    ]);

    const manifestsBeforeRejection =
      await checkpointEntryNames();
    const objectsBeforeRejection =
      await objectEntryNames();
    await expect(
      constrained.prepare(
        projectPath,
        before,
        AFTER_REVISION,
        label,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_QUOTA_EXCEEDED",
    });
    expect(
      await checkpointEntryNames(),
    ).toEqual(manifestsBeforeRejection);
    expect(
      await objectEntryNames(),
    ).toEqual(objectsBeforeRejection);
    expect(
      manifestsBeforeRejection.filter(
        (name) => name.endsWith(".json"),
      ),
    ).toHaveLength(2);
    expect(
      allStorageEntries(
        manifestsBeforeRejection,
        objectsBeforeRejection,
      ).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  });

  it("enforces isolated exact byte and entry boundaries for a fresh unique object", async () => {
    const before = Buffer.from(
      '{"fresh":"unique checkpoint object"}\n',
      "utf8",
    );
    const projectPath = "maps/fresh.tmj";
    const label = "fresh exact boundary";
    const probe = new CheckpointStore(resolver);
    const exactCharge =
      await measureAndResetCheckpointCharge(
        probe,
        projectPath,
        before,
        label,
      );

    const exact = new CheckpointStore(resolver, {
      maxBytes: exactCharge,
      maxEntries: 2,
    });
    const manifest = await exact.prepare(
      projectPath,
      before,
      AFTER_REVISION,
      label,
    );
    await expect(
      exact.markCommitted(manifest),
    ).resolves.toMatchObject({
      id: manifest.id,
      status: "committed",
    });
    expect(
      await exact.collectGarbage(),
    ).toMatchObject({
      chargedBytes: exactCharge,
      observedEntries: 2,
      retainedChargedBytes: exactCharge,
      retainedEntries: 2,
      blocked: false,
    });

    await unlink(manifestPath(manifest.id));
    await exact.collectGarbage();
    expect(await checkpointEntryNames()).toEqual([]);
    expect(await objectEntryNames()).toEqual([]);

    await expect(
      new CheckpointStore(resolver, {
        maxBytes: exactCharge - 1,
        maxEntries: 2,
      }).prepare(
        projectPath,
        before,
        AFTER_REVISION,
        label,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_QUOTA_EXCEEDED",
    });
    expect(await checkpointEntryNames()).toEqual([]);
    expect(await objectEntryNames()).toEqual([]);

    await expect(
      new CheckpointStore(resolver, {
        maxBytes: exactCharge,
        maxEntries: 1,
      }).prepare(
        projectPath,
        before,
        AFTER_REVISION,
        label,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_QUOTA_EXCEEDED",
    });
    expect(await checkpointEntryNames()).toEqual([]);
    expect(await objectEntryNames()).toEqual([]);
  });

  it("keeps prepared and committed shared roots until the last manifest disappears", async () => {
    const store = new CheckpointStore(resolver);
    const shared = Buffer.from(
      '{"shared":"before state"}\n',
      "utf8",
    );
    const sharedHash = createHash("sha256")
      .update(shared)
      .digest("hex");
    const prepared = await store.prepare(
      "maps/prepared.tmj",
      shared,
      AFTER_REVISION,
      "prepared root",
    );
    const committed = await store.markCommitted(
      await store.prepare(
        "maps/committed.tmj",
        shared,
        AFTER_REVISION,
        "committed root",
      ),
    );
    const orphan = Buffer.from(
      '{"orphan":true}\n',
      "utf8",
    );
    const orphanHash = createHash("sha256")
      .update(orphan)
      .digest("hex");
    await writeFile(
      join(objectsDirectory(), orphanHash),
      orphan,
    );
    const objectTemporaryName =
      `${orphanHash}.${randomUUID()}.tmp`;
    const manifestTemporaryName =
      `${randomUUID()}.json.${randomUUID()}.tmp`;
    await writeFile(
      join(objectsDirectory(), objectTemporaryName),
      "stale object temporary",
      "utf8",
    );
    await writeFile(
      join(
        checkpointsDirectory(),
        manifestTemporaryName,
      ),
      "stale manifest temporary",
      "utf8",
    );

    const firstSweep =
      await store.collectGarbage();

    expect(firstSweep).toMatchObject({
      deletedObjects: 1,
      deletedTemporaryFiles: 2,
      deletedEntries: 3,
      blocked: false,
    });
    expect(await readFile(objectPath(sharedHash))).toEqual(
      shared,
    );
    await expect(
      stat(objectPath(orphanHash)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await unlink(manifestPath(prepared.id));
    const withCommittedRoot =
      await store.collectGarbage();
    expect(withCommittedRoot.deletedObjects).toBe(0);
    expect(await readFile(objectPath(sharedHash))).toEqual(
      shared,
    );

    await unlink(manifestPath(committed.id));
    const withoutRoots =
      await store.collectGarbage();
    expect(withoutRoots.deletedObjects).toBe(1);
    await expect(
      stat(objectPath(sharedHash)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a published orphan for recovery after manifest publication fails, then collects it safely", async () => {
    const before = Buffer.from(
      '{"failure":"after object publication"}\n',
      "utf8",
    );
    const objectHash = createHash("sha256")
      .update(before)
      .digest("hex");
    const injected = new Error(
      "injected failure before manifest publication",
    );
    const faulting = new CheckpointStore(
      resolver,
      {
        observer: {
          afterObjectPublishedBeforeManifest() {
            throw injected;
          },
        },
      },
    );

    await expect(
      faulting.prepare(
        "maps/fault.tmj",
        before,
        AFTER_REVISION,
        "fault injection",
      ),
    ).rejects.toBe(injected);
    expect(await readFile(objectPath(objectHash))).toEqual(
      before,
    );
    expect(await checkpointEntryNames()).toEqual([]);
    expect(
      (await objectEntryNames()).some((name) =>
        name.endsWith(".tmp"),
      ),
    ).toBe(false);

    const report =
      await new CheckpointStore(
        resolver,
      ).collectGarbage();
    expect(report).toMatchObject({
      deletedObjects: 1,
      deletedTemporaryFiles: 0,
      blocked: false,
    });
    await expect(
      stat(objectPath(objectHash)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never replaces a manifest that appears after object publication", async () => {
    const before = Buffer.from(
      '{"collision":"manifest publication"}\n',
      "utf8",
    );
    const objectHash = createHash("sha256")
      .update(before)
      .digest("hex");
    let sentinel:
      | {
          manifest: CheckpointManifest;
          bytes: Buffer;
          path: string;
        }
      | undefined;
    const store = new CheckpointStore(resolver, {
      observer: {
        async afterObjectPublishedBeforeManifest(
          context,
        ) {
          const manifest: CheckpointManifest = {
            ...context.manifest,
            label: "sentinel manifest wins",
            path: "maps/sentinel-owner.tmj",
            before: { existed: false },
          };
          const bytes = Buffer.from(
            `${JSON.stringify(manifest, null, 2)}\n`,
            "utf8",
          );
          const path = manifestPath(manifest.id);
          await writeFile(path, bytes, {
            flag: "wx",
            mode: 0o600,
          });
          sentinel = { manifest, bytes, path };
        },
      },
    });

    await expect(
      store.prepare(
        "maps/colliding-writer.tmj",
        before,
        AFTER_REVISION,
        "must not replace sentinel",
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_CHANGED",
    });

    const publishedSentinel = sentinel;
    if (publishedSentinel === undefined) {
      throw new Error(
        "Expected the observer to publish its sentinel manifest.",
      );
    }
    expect(
      await readFile(publishedSentinel.path),
    ).toEqual(publishedSentinel.bytes);
    await expect(
      store.read(publishedSentinel.manifest.id),
    ).resolves.toEqual(
      publishedSentinel.manifest,
    );
    expect(await readFile(objectPath(objectHash))).toEqual(
      before,
    );
    expect(
      allStorageEntries(
        await checkpointEntryNames(),
        await objectEntryNames(),
      ).some((name) => name.endsWith(".tmp")),
    ).toBe(false);

    expect(await store.collectGarbage()).toMatchObject({
      deletedEntries: 1,
      deletedObjects: 1,
      blocked: false,
    });
    await expect(
      stat(objectPath(objectHash)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(publishedSentinel.path),
    ).toEqual(publishedSentinel.bytes);
  });

  it("blocks the whole sweep for corrupt, symlink, and missing-reference states", async () => {
    const store = new CheckpointStore(resolver);
    const referenced = Buffer.from(
      '{"referenced":true}\n',
      "utf8",
    );
    const checkpoint = await store.prepare(
      "maps/referenced.tmj",
      referenced,
      AFTER_REVISION,
      "missing referenced object",
    );
    if (!checkpoint.before.existed) {
      throw new Error(
        "Expected an existing-file checkpoint fixture.",
      );
    }
    await unlink(
      objectPath(checkpoint.before.objectHash),
    );

    const orphan = Buffer.from(
      '{"must":"survive blocked sweep"}\n',
      "utf8",
    );
    const orphanHash = createHash("sha256")
      .update(orphan)
      .digest("hex");
    await writeFile(objectPath(orphanHash), orphan);

    const corruptId = randomUUID();
    await writeFile(
      manifestPath(corruptId),
      '{"version":',
      "utf8",
    );
    const symlinkId = randomUUID();
    const symlinkTarget = join(
      root,
      "outside-checkpoint.json",
    );
    const symlinkTargetBytes = Buffer.from(
      "outside bytes must not be followed or removed",
      "utf8",
    );
    await writeFile(
      symlinkTarget,
      symlinkTargetBytes,
    );
    await symlink(
      symlinkTarget,
      manifestPath(symlinkId),
    );

    const report = await store.collectGarbage();

    expect(report).toMatchObject({
      blocked: true,
      deletedBytes: 0,
      deletedEntries: 0,
      deletedObjects: 0,
      deletedTemporaryFiles: 0,
    });
    expect(
      report.blockers.map(({ reason }) => reason),
    ).toEqual(
      expect.arrayContaining([
        "malformed-manifest",
        "missing-referenced-object",
        "symbolic-link",
      ]),
    );
    expect(await readFile(objectPath(orphanHash))).toEqual(
      orphan,
    );
    expect(await readFile(symlinkTarget)).toEqual(
      symlinkTargetBytes,
    );
  });

  it.each(
    ["checkpoints", "objects"] as const,
  )(
    "blocks explicit GC without deleting anything when %s contains an unknown entry",
    async (directory) => {
      const store = new CheckpointStore(resolver);
      await store.collectGarbage();
      const orphan = Buffer.from(
        `orphan beside unknown ${directory} entry`,
        "utf8",
      );
      const orphanHash = createHash("sha256")
        .update(orphan)
        .digest("hex");
      await writeFile(objectPath(orphanHash), orphan);
      const unknownName =
        directory === "checkpoints"
          ? "future-manifest.v2"
          : "future-object.v2";
      const unknownBytes = Buffer.from(
        "unknown entry must survive",
        "utf8",
      );
      const unknownPath = join(
        directory === "checkpoints"
          ? checkpointsDirectory()
          : objectsDirectory(),
        unknownName,
      );
      await writeFile(unknownPath, unknownBytes);
      const checkpointsBefore =
        await checkpointEntryNames();
      const objectsBefore = await objectEntryNames();

      const report = await store.collectGarbage();

      expect(report).toMatchObject({
        blocked: true,
        deletedBytes: 0,
        deletedEntries: 0,
        deletedObjects: 0,
        deletedTemporaryFiles: 0,
      });
      expect(report.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            directory,
            fileName: unknownName,
            reason: "unexpected-entry",
          }),
        ]),
      );
      expect(await checkpointEntryNames()).toEqual(
        checkpointsBefore,
      );
      expect(await objectEntryNames()).toEqual(
        objectsBefore,
      );
      expect(await readFile(unknownPath)).toEqual(
        unknownBytes,
      );
      expect(
        await readFile(objectPath(orphanHash)),
      ).toEqual(orphan);
    },
  );

  it("blocks quota-pressure GC without deleting an orphan when an unknown entry is present", async () => {
    const before = Buffer.from(
      '{"quota":"blocked by unknown entry"}\n',
      "utf8",
    );
    const projectPath = "maps/blocked-quota.tmj";
    const label = "blocked quota recovery";
    const exactCharge =
      await measureAndResetCheckpointCharge(
        new CheckpointStore(resolver),
        projectPath,
        before,
        label,
      );
    const unknownName = "future-checkpoint-index.v2";
    const unknownBytes = Buffer.from("u", "utf8");
    await writeFile(
      join(checkpointsDirectory(), unknownName),
      unknownBytes,
    );
    const orphan = Buffer.from(
      "orphan that would make room",
      "utf8",
    );
    const orphanHash = createHash("sha256")
      .update(orphan)
      .digest("hex");
    await writeFile(objectPath(orphanHash), orphan);
    const checkpointsBefore =
      await checkpointEntryNames();
    const objectsBefore = await objectEntryNames();
    const constrained = new CheckpointStore(resolver, {
      maxBytes:
        exactCharge + unknownBytes.byteLength,
      maxEntries: 3,
    });

    await expect(
      constrained.prepare(
        projectPath,
        before,
        AFTER_REVISION,
        label,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_QUOTA_EXCEEDED",
    });

    expect(await checkpointEntryNames()).toEqual(
      checkpointsBefore,
    );
    expect(await objectEntryNames()).toEqual(
      objectsBefore,
    );
    expect(
      await readFile(objectPath(orphanHash)),
    ).toEqual(orphan);
    const report =
      await constrained.collectGarbage();
    expect(report).toMatchObject({
      blocked: true,
      deletedBytes: 0,
      deletedEntries: 0,
      deletedObjects: 0,
      deletedTemporaryFiles: 0,
    });
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          directory: "checkpoints",
          fileName: unknownName,
          reason: "unexpected-entry",
        }),
      ]),
    );
  });

  it("recovers quota by collecting an orphan before publishing a new checkpoint", async () => {
    const before = Buffer.from(
      '{"quota":"recover by collecting orphan"}\n',
      "utf8",
    );
    const projectPath = "maps/recovered-quota.tmj";
    const label = "orphan quota recovery";
    const exactCharge =
      await measureAndResetCheckpointCharge(
        new CheckpointStore(resolver),
        projectPath,
        before,
        label,
      );
    const orphan = Buffer.alloc(256, 0x6f);
    const orphanHash = createHash("sha256")
      .update(orphan)
      .digest("hex");
    await writeFile(objectPath(orphanHash), orphan);
    const constrained = new CheckpointStore(resolver, {
      maxBytes: exactCharge,
      maxEntries: 2,
    });

    const manifest = await constrained.prepare(
      projectPath,
      before,
      AFTER_REVISION,
      label,
    );

    await expect(
      stat(objectPath(orphanHash)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await checkpointEntryNames()).toEqual([
      `${manifest.id}.json`,
    ]);
    expect(await canonicalObjectNames()).toEqual([
      createHash("sha256")
        .update(before)
        .digest("hex"),
    ]);
    expect(
      await constrained.collectGarbage(),
    ).toMatchObject({
      chargedBytes: exactCharge,
      observedEntries: 2,
      retainedChargedBytes: exactCharge,
      retainedEntries: 2,
      deletedEntries: 0,
      blocked: false,
    });
  });

  it("treats an object-side symlink as a blocker and preserves every entry", async () => {
    const store = new CheckpointStore(resolver);
    await store.collectGarbage();
    const externalPath = join(
      root,
      "outside-checkpoint-object",
    );
    const externalBytes = Buffer.from(
      "external target must not be followed",
      "utf8",
    );
    await writeFile(externalPath, externalBytes);
    const symlinkHash = createHash("sha256")
      .update("object symlink slot")
      .digest("hex");
    await symlink(
      externalPath,
      objectPath(symlinkHash),
    );
    const orphan = Buffer.from(
      "regular orphan must survive",
      "utf8",
    );
    const orphanHash = createHash("sha256")
      .update(orphan)
      .digest("hex");
    await writeFile(objectPath(orphanHash), orphan);
    const objectsBefore = await objectEntryNames();

    const report = await store.collectGarbage();

    expect(report).toMatchObject({
      blocked: true,
      deletedBytes: 0,
      deletedEntries: 0,
      deletedObjects: 0,
      deletedTemporaryFiles: 0,
    });
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          directory: "objects",
          fileName: symlinkHash,
          reason: "symbolic-link",
        }),
      ]),
    );
    expect(await objectEntryNames()).toEqual(
      objectsBefore,
    );
    expect(
      (await lstat(objectPath(symlinkHash))).isSymbolicLink(),
    ).toBe(true);
    expect(await readFile(externalPath)).toEqual(
      externalBytes,
    );
    expect(
      await readFile(objectPath(orphanHash)),
    ).toEqual(orphan);
  });

  it("performs zero deletion when the inventory entry budget is exhausted", async () => {
    const bootstrap = new CheckpointStore(resolver);
    await bootstrap.collectGarbage();
    const orphan = Buffer.from("orphan", "utf8");
    const orphanHash = createHash("sha256")
      .update(orphan)
      .digest("hex");
    const temporaryName =
      `${orphanHash}.${randomUUID()}.tmp`;
    await writeFile(objectPath(orphanHash), orphan);
    await writeFile(
      join(objectsDirectory(), temporaryName),
      "temporary",
      "utf8",
    );
    const namesBefore = await objectEntryNames();
    const constrained = new CheckpointStore(
      resolver,
      {
        maxEntries: 1,
      },
    );

    const report =
      await constrained.collectGarbage();

    expect(report).toMatchObject({
      blocked: true,
      deletedBytes: 0,
      deletedEntries: 0,
      deletedObjects: 0,
      deletedTemporaryFiles: 0,
    });
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          directory: "objects",
          reason: "scan-limit-exceeded",
        }),
      ]),
    );
    expect(await objectEntryNames()).toEqual(
      namesBefore,
    );
  });

  it("serializes GC behind the object-publication to manifest-publication writer window", async () => {
    const reachedWindow = deferred();
    const releaseWriter = deferred();
    const before = Buffer.from(
      '{"concurrency":"writer versus gc"}\n',
      "utf8",
    );
    const objectHash = createHash("sha256")
      .update(before)
      .digest("hex");
    const writer = new CheckpointStore(resolver, {
      observer: {
        async afterObjectPublishedBeforeManifest() {
          reachedWindow.resolve();
          await releaseWriter.promise;
        },
      },
    });
    const preparePromise = writer.prepare(
      "maps/concurrent.tmj",
      before,
      AFTER_REVISION,
      "concurrent writer",
    );
    await reachedWindow.promise;

    let garbageCollectionSettled = false;
    const garbageCollectionPromise =
      new CheckpointStore(
        resolver,
      ).collectGarbage();
    void garbageCollectionPromise.then(
      () => {
        garbageCollectionSettled = true;
      },
      () => {
        garbageCollectionSettled = true;
      },
    );
    await yieldEventLoop();

    expect(garbageCollectionSettled).toBe(false);
    expect(await readFile(objectPath(objectHash))).toEqual(
      before,
    );
    expect(await checkpointEntryNames()).toEqual([]);

    releaseWriter.resolve();
    const manifest = await preparePromise;
    const report = await garbageCollectionPromise;

    expect(report).toMatchObject({
      deletedObjects: 0,
      blocked: false,
    });
    expect(
      await new CheckpointStore(
        resolver,
      ).readBefore(manifest),
    ).toEqual(before);
  });

  it("returns FILE_LOCKED while a real child process holds the object-published writer window", async () => {
    const before = Buffer.from(
      '{"process":"live writer owns orphan-looking object"}\n',
      "utf8",
    );
    const objectHash = createHash("sha256")
      .update(before)
      .digest("hex");
    const writer = spawnCheckpointWriter({
      root,
      projectPath: "maps/live-process.tmj",
      before,
      afterRevision: AFTER_REVISION,
      label: "live child process writer",
    });

    try {
      await waitForWriterReady(writer);
      expect(
        await readFile(objectPath(objectHash)),
      ).toEqual(before);
      expect(await checkpointEntryNames()).toEqual([]);

      await expect(
        new CheckpointStore(
          resolver,
        ).collectGarbage(),
      ).rejects.toMatchObject({
        code: "FILE_LOCKED",
        details: {
          path: CHECKPOINT_STORAGE_LOCK_TARGET,
        },
      });
      expect(
        await readFile(objectPath(objectHash)),
      ).toEqual(before);
      expect(await checkpointEntryNames()).toEqual([]);

      await writeFile(
        writer.releasePath,
        "release",
        "utf8",
      );
      const outcome = await writer.completion;
      expect({
        ...outcome,
        stderr: writer.stderr(),
      }).toEqual({
        code: 0,
        signal: null,
        stderr: "",
      });
      const manifest = JSON.parse(
        await readFile(writer.donePath, "utf8"),
      ) as CheckpointManifest;
      expect(await checkpointEntryNames()).toEqual([
        `${manifest.id}.json`,
      ]);
      expect(
        await new CheckpointStore(
          resolver,
        ).readBefore(manifest),
      ).toEqual(before);
      expect(
        await new CheckpointStore(
          resolver,
        ).collectGarbage(),
      ).toMatchObject({
        deletedObjects: 0,
        blocked: false,
      });
    } finally {
      await terminateCheckpointWriter(writer);
    }
  }, 20_000);

  it.skipIf(process.platform === "win32")(
    "reports a SIGKILL-stale writer lock until manual removal, then collects the orphan",
    async () => {
      const before = Buffer.from(
        '{"process":"killed writer leaves orphan"}\n',
        "utf8",
      );
      const objectHash = createHash("sha256")
        .update(before)
        .digest("hex");
      const writer = spawnCheckpointWriter({
        root,
        projectPath: "maps/killed-process.tmj",
        before,
        afterRevision: AFTER_REVISION,
        label: "killed child process writer",
      });

      try {
        await waitForWriterReady(writer);
        expect(
          await readFile(objectPath(objectHash)),
        ).toEqual(before);
        expect(await checkpointEntryNames()).toEqual([]);
        expect(writer.child.kill("SIGKILL")).toBe(true);
        const outcome = await writer.completion;
        expect(outcome).toEqual({
          code: null,
          signal: "SIGKILL",
        });

        await expect(
          new CheckpointStore(
            resolver,
          ).collectGarbage(),
        ).rejects.toMatchObject({
          code: "STALE_FILE_LOCK",
          details: {
            path: CHECKPOINT_STORAGE_LOCK_TARGET,
          },
        });
        expect(
          await readFile(objectPath(objectHash)),
        ).toEqual(before);
        expect(await checkpointEntryNames()).toEqual([]);

        const lockPath = join(
          root,
          ".tiledmcp",
          "locks",
          `${shortHash(
            CHECKPOINT_STORAGE_LOCK_TARGET,
          )}.lock`,
        );
        expect((await lstat(lockPath)).isFile()).toBe(true);
        await unlink(lockPath);

        expect(
          await new CheckpointStore(
            resolver,
          ).collectGarbage(),
        ).toMatchObject({
          deletedEntries: 1,
          deletedObjects: 1,
          blocked: false,
        });
        await expect(
          stat(objectPath(objectHash)),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await terminateCheckpointWriter(writer);
      }
    },
    20_000,
  );

  it("allows only one of two concurrent unique writers when the entry quota fits one checkpoint", async () => {
    const store = new CheckpointStore(resolver, {
      maxEntries: 2,
    });
    const writes = [
      {
        path: "maps/first.tmj",
        before: Buffer.from('{"writer":1}\n', "utf8"),
      },
      {
        path: "maps/second.tmj",
        before: Buffer.from('{"writer":2}\n', "utf8"),
      },
    ];

    const outcomes = await Promise.allSettled(
      writes.map(({ path, before }) =>
        store.prepare(
          path,
          before,
          AFTER_REVISION,
          "entry quota race",
        ),
      ),
    );

    expect(
      outcomes.filter(
        ({ status }) => status === "fulfilled",
      ),
    ).toHaveLength(1);
    const rejected = outcomes.filter(
      ({ status }) => status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: {
        code: "CHECKPOINT_QUOTA_EXCEEDED",
      },
    });
    expect(await canonicalObjectNames()).toHaveLength(1);
    expect(
      (await checkpointEntryNames()).filter(
        (name) => name.endsWith(".json"),
      ),
    ).toHaveLength(1);
    const report = await store.collectGarbage();
    expect(report).toMatchObject({
      observedEntries: 2,
      retainedEntries: 2,
      deletedEntries: 0,
      blocked: false,
    });
  });

  it("rejects a quota-full document mutation before target promotion and leaves no checkpoint debris", async () => {
    const before = Buffer.from(
      '{"type":"map","version":"1.10","width":1}\n',
      "utf8",
    );
    const after = Buffer.from(
      '{"type":"map","version":"1.10","width":2}\n',
      "utf8",
    );
    const target = join(root, "maps", "quota.tmj");
    await writeFile(target, before);
    const documents = makeStore(resolver, { maxDocumentBytes: 64 * 1024 * 1024, checkpointOptions: {
        maxBytes: 1,
      } });
    const loaded = await documents.read(
      "maps/quota.tmj",
    );

    await expect(
      documents.commitBytes(
        "maps/quota.tmj",
        loaded.revision,
        after,
        "must not promote",
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_QUOTA_EXCEEDED",
    });
    expect(await readFile(target)).toEqual(before);
    expect(await checkpointEntryNames()).toEqual([]);
    expect(await objectEntryNames()).toEqual([]);

    await expect(
      documents.commitBytes(
        "maps/quota.tmj",
        loaded.revision,
        before,
        "quota-independent no-op",
      ),
    ).resolves.toMatchObject({
      changed: false,
      checkpointId: null,
      revision: loaded.revision,
    });
  });

  it("rejects a quota-full document create without publishing the new target", async () => {
    const projectPath = "maps/quota-create.tmj";
    const target = join(root, projectPath);
    const documents = makeStore(resolver, { maxDocumentBytes: 64 * 1024 * 1024, checkpointOptions: {
        maxBytes: 1,
      } });

    await expect(
      documents.create(projectPath, {
        type: "map",
        version: "1.10",
        width: 1,
        height: 1,
      }),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_QUOTA_EXCEEDED",
    });

    await expect(stat(target)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await checkpointEntryNames()).toEqual([]);
    expect(await objectEntryNames()).toEqual([]);
    expect(
      allStorageEntries(
        await checkpointEntryNames(),
        await objectEntryNames(),
      ).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  });

  async function measureAndResetCheckpointCharge(
    store: CheckpointStore,
    projectPath: string,
    before: Buffer,
    label: string,
  ): Promise<number> {
    const manifest = await store.prepare(
      projectPath,
      before,
      AFTER_REVISION,
      label,
    );
    const report = await store.collectGarbage();
    const exactCharge = report.chargedBytes;

    await unlink(manifestPath(manifest.id));
    expect(
      await store.collectGarbage(),
    ).toMatchObject({
      deletedObjects: 1,
      blocked: false,
    });
    expect(await checkpointEntryNames()).toEqual([]);
    expect(await objectEntryNames()).toEqual([]);
    return exactCharge;
  }

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

  function manifestPath(id: string): string {
    return join(
      checkpointsDirectory(),
      `${id}.json`,
    );
  }

  function objectPath(hash: string): string {
    return join(objectsDirectory(), hash);
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

  async function canonicalObjectNames(): Promise<string[]> {
    return (await objectEntryNames()).filter((name) =>
      /^[0-9a-f]{64}$/u.test(name),
    );
  }
});

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>(
    (resolvePromise) => {
      resolve = resolvePromise;
    },
  );
  return { promise, resolve };
}

async function yieldEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function allStorageEntries(
  checkpointEntries: readonly string[],
  objectEntries: readonly string[],
): string[] {
  return [
    ...checkpointEntries,
    ...objectEntries,
  ];
}

interface SpawnedCheckpointWriter {
  child: ChildProcessWithoutNullStreams;
  readyPath: string;
  releasePath: string;
  donePath: string;
  completion: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  stderr: () => string;
}

function spawnCheckpointWriter(options: {
  root: string;
  projectPath: string;
  before: Buffer;
  afterRevision: string;
  label: string;
}): SpawnedCheckpointWriter {
  const controlId = randomUUID();
  const readyPath = join(
    options.root,
    `.checkpoint-writer-${controlId}.ready`,
  );
  const releasePath = join(
    options.root,
    `.checkpoint-writer-${controlId}.release`,
  );
  const donePath = join(
    options.root,
    `.checkpoint-writer-${controlId}.done`,
  );
  const resolverModule = pathToFileURL(
    join(
      process.cwd(),
      "src/project/pathResolver.ts",
    ),
  ).href;
  const checkpointsModule = pathToFileURL(
    join(
      process.cwd(),
      "src/storage/checkpoints.ts",
    ),
  ).href;
  const source = [
    'import { stat, writeFile } from "node:fs/promises";',
    'import { setTimeout as delay } from "node:timers/promises";',
    `import { ProjectPathResolver } from ${JSON.stringify(
      resolverModule,
    )};`,
    `import { CheckpointStore } from ${JSON.stringify(
      checkpointsModule,
    )};`,
    `const resolver = await ProjectPathResolver.create(${JSON.stringify(
      options.root,
    )});`,
    "const store = new CheckpointStore(resolver, {",
    "  observer: {",
    "    async afterObjectPublishedBeforeManifest() {",
    `      await writeFile(${JSON.stringify(
      readyPath,
    )}, "ready", "utf8");`,
    "      while (true) {",
    "        try {",
    `          await stat(${JSON.stringify(
      releasePath,
    )});`,
    "          break;",
    "        } catch (error) {",
    '          if (error?.code !== "ENOENT") throw error;',
    "        }",
    "        await delay(10);",
    "      }",
    "    },",
    "  },",
    "});",
    `const manifest = await store.prepare(${JSON.stringify(
      options.projectPath,
    )}, Buffer.from(${JSON.stringify(
      options.before.toString("base64"),
    )}, "base64"), ${JSON.stringify(
      options.afterRevision,
    )}, ${JSON.stringify(options.label)});`,
    `await writeFile(${JSON.stringify(
      donePath,
    )}, JSON.stringify(manifest), "utf8");`,
  ].join("\n");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      source,
    ],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end();
  child.stdout.resume();
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  void completion.catch(() => undefined);
  return {
    child,
    readyPath,
    releasePath,
    donePath,
    completion,
    stderr: () =>
      Buffer.concat(stderrChunks).toString("utf8"),
  };
}

async function waitForWriterReady(
  writer: SpawnedCheckpointWriter,
): Promise<void> {
  for (
    let attempt = 0;
    attempt < 1_000;
    attempt += 1
  ) {
    try {
      await stat(writer.readyPath);
      return;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
    if (
      writer.child.exitCode !== null ||
      writer.child.signalCode !== null
    ) {
      throw new Error(
        `Checkpoint writer exited before reaching the observer window: ${writer.stderr()}`,
      );
    }
    await delayMilliseconds(10);
  }
  throw new Error(
    `Timed out waiting for checkpoint writer: ${writer.stderr()}`,
  );
}

async function terminateCheckpointWriter(
  writer: SpawnedCheckpointWriter,
): Promise<void> {
  if (
    writer.child.exitCode === null &&
    writer.child.signalCode === null
  ) {
    writer.child.kill("SIGKILL");
  }
  await writer.completion.catch(() => undefined);
}

async function delayMilliseconds(
  milliseconds: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function hasErrorCode(
  error: unknown,
  code: string,
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
