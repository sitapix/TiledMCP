import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  DocumentStore,
  type CheckpointReconciliationReport,
} from "../src/storage/documentStore.js";
import { revisionOf } from "../src/storage/revision.js";

describe("prepared checkpoint reconciliation", () => {
  let root: string;
  let store: DocumentStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tiledmcp-recovery-"));
    await mkdir(join(root, "maps"));
    const resolver = await ProjectPathResolver.create(root);
    store = new DocumentStore(resolver);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("marks a prepared manifest committed only when the exact after revision landed", async () => {
    const before = Buffer.from("before bytes", "utf8");
    const after = Buffer.from("after bytes", "utf8");
    await writeFile(join(root, "maps", "landed.tmj"), after);
    const manifest = await store.checkpoints.prepare(
      "maps/landed.tmj",
      before,
      revisionOf(after),
      "interrupted status update",
    );

    const report = await store.reconcilePreparedCheckpoints();

    expect(outcomeFor(report, manifest.id)).toMatchObject({
      outcome: "reconciled",
      currentRevision: revisionOf(after),
    });
    expect(await store.checkpoints.read(manifest.id)).toMatchObject({
      status: "committed",
    });
    expect(await readFile(join(root, "maps", "landed.tmj"))).toEqual(after);
  });

  it("reports writes that did not land without changing targets or manifests", async () => {
    const before = Buffer.from("unchanged before", "utf8");
    const after = Buffer.from("proposed after", "utf8");
    await writeFile(join(root, "maps", "unchanged.tmj"), before);
    const edit = await store.checkpoints.prepare(
      "maps/unchanged.tmj",
      before,
      revisionOf(after),
      "edit did not land",
    );
    const create = await store.checkpoints.prepare(
      "maps/not-created.tmj",
      undefined,
      revisionOf(after),
      "create did not land",
    );

    const report = await store.reconcilePreparedCheckpoints();

    expect(outcomeFor(report, edit.id)).toMatchObject({
      outcome: "writeDidNotLand",
      currentRevision: revisionOf(before),
    });
    expect(outcomeFor(report, create.id)).toMatchObject({
      outcome: "writeDidNotLand",
      currentRevision: null,
    });
    expect(await store.checkpoints.read(edit.id)).toMatchObject({
      status: "prepared",
    });
    expect(await store.checkpoints.read(create.id)).toMatchObject({
      status: "prepared",
    });
    expect(await readFile(join(root, "maps", "unchanged.tmj"))).toEqual(before);
    await expect(stat(join(root, "maps", "not-created.tmj"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not claim an externally created identical file as a successful no-replace create", async () => {
    const document: JsonObject = {
      type: "map",
      version: "1.10",
      tiledversion: "1.12.2",
      orientation: "orthogonal",
      renderorder: "right-down",
      infinite: false,
      width: 2,
      height: 2,
      tilewidth: 16,
      tileheight: 16,
      layers: [],
      tilesets: [],
      nextlayerid: 1,
      nextobjectid: 1,
    };
    const exactExternalBytes =
      serializeJsonDocument(document);
    const targetPath =
      join(root, "maps", "raced-create.tmj");
    const originalPrepare =
      store.checkpoints.prepare.bind(
        store.checkpoints,
      );
    let preparedId: string | undefined;
    vi.spyOn(
      store.checkpoints,
      "prepare",
    ).mockImplementation(
      async (
        projectPath,
        before,
        afterRevision,
        label,
      ) => {
        const manifest =
          await originalPrepare(
            projectPath,
            before,
            afterRevision,
            label,
          );
        preparedId = manifest.id;
        await writeFile(
          targetPath,
          exactExternalBytes,
        );
        return manifest;
      },
    );

    await expect(
      store.create(
        "maps/raced-create.tmj",
        document,
      ),
    ).rejects.toMatchObject({
      code: "FILE_ALREADY_EXISTS",
      details: {
        path: "maps/raced-create.tmj",
      },
    });
    expect(
      await readFile(targetPath),
    ).toEqual(exactExternalBytes);
    expect(preparedId).toEqual(
      expect.any(String),
    );

    const report =
      await store.reconcilePreparedCheckpoints();
    expect(
      outcomeFor(report, preparedId!),
    ).toMatchObject({
      outcome: "conflict",
      currentRevision: revisionOf(
        exactExternalBytes,
      ),
      errorCode:
        "CHECKPOINT_STATE_CONFLICT",
    });
    expect(
      await store.checkpoints.read(
        preparedId!,
      ),
    ).toMatchObject({
      status: "prepared",
      before: {
        existed: false,
      },
    });
  });

  it("leaves distinct prepared checkpoints when identical create attempts fail before installation", async () => {
    const preInstallFailure = Object.assign(
      new Error(
        "synthetic no-replace promotion failure",
      ),
      {
        code: "ENOTSUP",
      },
    );
    const faultingStore = new DocumentStore(
      await ProjectPathResolver.create(root),
      undefined,
      {
        afterTemporaryFileOpened() {
          throw preInstallFailure;
        },
      },
    );
    const document: JsonObject = {
      type: "map",
      version: "1.10",
      width: 1,
      height: 1,
    };

    await expect(
      faultingStore.create(
        "maps/non-idempotent-create.tmj",
        document,
      ),
    ).rejects.toBe(preInstallFailure);
    await expect(
      faultingStore.create(
        "maps/non-idempotent-create.tmj",
        document,
      ),
    ).rejects.toBe(preInstallFailure);

    const prepared =
      await faultingStore.checkpoints.list({
        status: "prepared",
      });
    expect(prepared.manifests).toHaveLength(
      2,
    );
    expect(
      new Set(
        prepared.manifests.map(
          (manifest) => manifest.id,
        ),
      ).size,
    ).toBe(2);
    expect(
      prepared.manifests.every(
        (manifest) =>
          !manifest.before.existed,
      ),
    ).toBe(true);
    await expect(
      readFile(
        join(
          root,
          "maps",
          "non-idempotent-create.tmj",
        ),
      ),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await readdir(join(root, "maps")),
    ).toEqual([]);
  });

  it("keeps an installed create checkpoint provenance-ambiguous when marking committed fails", async () => {
    const document: JsonObject = {
      type: "map",
      version: "1.10",
      tiledversion: "1.12.2",
      orientation: "orthogonal",
      renderorder: "right-down",
      infinite: false,
      width: 2,
      height: 2,
      tilewidth: 16,
      tileheight: 16,
      layers: [],
      tilesets: [],
      nextlayerid: 1,
      nextobjectid: 1,
    };
    vi.spyOn(
      process.stderr,
      "write",
    ).mockImplementation(() => true);
    vi.spyOn(
      store.checkpoints,
      "markCommitted",
    ).mockRejectedValue(
      new Error(
        "synthetic committed-marker failure",
      ),
    );

    const created = await store.create(
      "maps/installed-uncommitted.tmj",
      document,
    );
    expect(created.changed).toBe(true);
    expect(created.checkpointId).toEqual(
      expect.any(String),
    );
    expect(created.warnings).toEqual([
      expect.stringContaining(
        "automatic reconciliation cannot prove who created the target",
      ),
    ]);
    expect(
      await store.checkpoints.read(
        created.checkpointId!,
      ),
    ).toMatchObject({
      status: "prepared",
      before: {
        existed: false,
      },
    });

    const report =
      await store.reconcilePreparedCheckpoints();
    expect(
      outcomeFor(
        report,
        created.checkpointId!,
      ),
    ).toMatchObject({
      outcome: "conflict",
      currentRevision: created.revision,
      errorCode:
        "CHECKPOINT_STATE_CONFLICT",
    });
    expect(
      await store.checkpoints.read(
        created.checkpointId!,
      ),
    ).toMatchObject({
      status: "prepared",
    });
  });

  it("returns a durability warning only after this call installed the exact target bytes", async () => {
    const internals =
      store as unknown as AtomicReplaceTestSurface;
    const targetPath = join(
      root,
      "maps",
      "installed-with-warning.tmj",
    );
    const proposed = Buffer.from(
      '{"type":"map","installed":true}\n',
      "utf8",
    );
    const postInstallFailure =
      new Error(
        "synthetic directory sync failure",
      );
    vi.spyOn(
      internals,
      "atomicReplace",
    ).mockImplementation(
      async (
        absolutePath,
        content,
        _expectedRevision,
        _projectPath,
        progress,
      ) => {
        await writeFile(
          absolutePath,
          content,
        );
        progress.destinationInstalled =
          true;
        throw postInstallFailure;
      },
    );

    await expect(
      internals.atomicReplaceConfirmed(
        targetPath,
        proposed,
        undefined,
        "maps/installed-with-warning.tmj",
      ),
    ).resolves.toEqual([
      expect.stringContaining(
        "post-replace durability step failed",
      ),
    ]);
    expect(
      await readFile(targetPath),
    ).toEqual(proposed);
  });

  it("preserves a post-install failure when the target no longer has the installed bytes", async () => {
    const internals =
      store as unknown as AtomicReplaceTestSurface;
    const targetPath = join(
      root,
      "maps",
      "changed-after-install.tmj",
    );
    const proposed = Buffer.from(
      '{"type":"map","installed":true}\n',
      "utf8",
    );
    const external = Buffer.from(
      '{"type":"map","external":true}\n',
      "utf8",
    );
    const postInstallFailure =
      new Error(
        "synthetic directory sync failure",
      );
    vi.spyOn(
      internals,
      "atomicReplace",
    ).mockImplementation(
      async (
        absolutePath,
        _content,
        _expectedRevision,
        _projectPath,
        progress,
      ) => {
        progress.destinationInstalled =
          true;
        await writeFile(
          absolutePath,
          external,
        );
        throw postInstallFailure;
      },
    );

    await expect(
      internals.atomicReplaceConfirmed(
        targetPath,
        proposed,
        undefined,
        "maps/changed-after-install.tmj",
      ),
    ).rejects.toBe(postInstallFailure);
    expect(
      await readFile(targetPath),
    ).toEqual(external);
  });

  it("isolates missing, unrelated, symlink, and corrupt states while continuing", async () => {
    const before = Buffer.from("known before", "utf8");
    const after = Buffer.from("known after", "utf8");
    const unrelated = Buffer.from("external unrelated bytes", "utf8");

    const missing = await store.checkpoints.prepare(
      "maps/missing.tmj",
      before,
      revisionOf(after),
      "missing existing target",
    );

    await writeFile(join(root, "maps", "unrelated.tmj"), unrelated);
    const changed = await store.checkpoints.prepare(
      "maps/unrelated.tmj",
      before,
      revisionOf(after),
      "external conflict",
    );

    await symlink("unrelated.tmj", join(root, "maps", "linked.tmj"));
    const linked = await store.checkpoints.prepare(
      "maps/linked.tmj",
      before,
      revisionOf(after),
      "symlink conflict",
    );

    await writeFile(join(root, "maps", "landed.tmj"), after);
    const landed = await store.checkpoints.prepare(
      "maps/landed.tmj",
      before,
      revisionOf(after),
      "valid entry after failures",
    );

    const corruptId = randomUUID();
    const corruptPath = join(
      root,
      ".tiledmcp",
      "checkpoints",
      `${corruptId}.json`,
    );
    await writeFile(corruptPath, '{"not":"a manifest"}\n', "utf8");
    const listedBefore = await store.checkpoints.list({
      status: "prepared",
      limit: 20,
    });

    const report = await store.reconcilePreparedCheckpoints({ limit: 20 });

    expect(outcomeFor(report, missing.id)).toMatchObject({
      outcome: "conflict",
      currentRevision: null,
      errorCode: "CHECKPOINT_STATE_CONFLICT",
    });
    expect(outcomeFor(report, changed.id)).toMatchObject({
      outcome: "conflict",
      currentRevision: revisionOf(unrelated),
    });
    expect(outcomeFor(report, linked.id)).toMatchObject({
      outcome: "conflict",
      currentRevision: null,
      errorCode: "SYMLINK_NOT_ALLOWED",
    });
    expect(outcomeFor(report, landed.id)).toMatchObject({
      outcome: "reconciled",
    });
    expect(report.corruptEntries).toEqual(listedBefore.corruptEntries);
    expect(report.corruptEntries).toEqual([
      expect.objectContaining({
        fileName: `${corruptId}.json`,
        checkpointId: corruptId,
        code: "CHECKPOINT_CORRUPT",
      }),
    ]);
    expect(await store.checkpoints.read(landed.id)).toMatchObject({
      status: "committed",
    });
    expect(await store.checkpoints.read(missing.id)).toMatchObject({
      status: "prepared",
    });
    expect(await store.checkpoints.read(changed.id)).toMatchObject({
      status: "prepared",
    });
    expect(await store.checkpoints.read(linked.id)).toMatchObject({
      status: "prepared",
    });
    expect((await lstat(join(root, "maps", "linked.tmj"))).isSymbolicLink()).toBe(
      true,
    );
    expect(await readFile(join(root, "maps", "unrelated.tmj"))).toEqual(unrelated);
    expect(await readFile(corruptPath, "utf8")).toBe('{"not":"a manifest"}\n');
  });

  it("contains a manifest update failure and reconciles later entries", async () => {
    const before = Buffer.from("before", "utf8");
    const after = Buffer.from("after", "utf8");
    const manifests = [];
    for (const name of ["one", "two"]) {
      await writeFile(join(root, "maps", `${name}.tmj`), after);
      manifests.push(
        await store.checkpoints.prepare(
          `maps/${name}.tmj`,
          before,
          revisionOf(after),
          name,
        ),
      );
    }

    const originalMarkCommitted = store.checkpoints.markCommitted.bind(
      store.checkpoints,
    );
    let callCount = 0;
    vi.spyOn(store.checkpoints, "markCommitted").mockImplementation(
      async (manifest) => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("injected manifest write failure");
        }
        return originalMarkCommitted(manifest);
      },
    );

    const report = await store.reconcilePreparedCheckpoints();

    expect(report.outcomes.filter(({ outcome }) => outcome === "error")).toHaveLength(
      1,
    );
    expect(
      report.outcomes.filter(({ outcome }) => outcome === "reconciled"),
    ).toHaveLength(1);
    const statuses = await Promise.all(
      manifests.map(async ({ id }) => (await store.checkpoints.read(id)).status),
    );
    expect(statuses.sort()).toEqual(["committed", "prepared"]);
    expect(await readFile(join(root, "maps", "one.tmj"))).toEqual(after);
    expect(await readFile(join(root, "maps", "two.tmj"))).toEqual(after);
  });

  it("reports a truncated bounded scan", async () => {
    const before = Buffer.from("before", "utf8");
    const after = Buffer.from("after", "utf8");
    for (const name of ["one", "two", "three"]) {
      await writeFile(join(root, "maps", `${name}.tmj`), before);
      await store.checkpoints.prepare(
        `maps/${name}.tmj`,
        before,
        revisionOf(after),
        name,
      );
    }

    const report = await store.reconcilePreparedCheckpoints({ limit: 1 });

    expect(report.outcomes).toHaveLength(1);
    expect(report.truncated).toBe(true);
  });
});

interface AtomicReplaceTestSurface {
  atomicReplace(
    absolutePath: string,
    content: Buffer,
    expectedRevision: string | undefined,
    projectPath: string,
    progress: {
      destinationInstalled: boolean;
    },
  ): Promise<void>;
  atomicReplaceConfirmed(
    absolutePath: string,
    content: Buffer,
    expectedRevision: string | undefined,
    projectPath: string,
  ): Promise<string[]>;
}

function outcomeFor(
  report: CheckpointReconciliationReport,
  checkpointId: string,
) {
  const outcome = report.outcomes.find(
    (candidate) => candidate.checkpointId === checkpointId,
  );
  expect(outcome).toBeDefined();
  return outcome;
}
