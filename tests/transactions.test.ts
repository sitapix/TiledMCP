import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { makeStore } from "./support/project.js";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";
import { revisionOf } from "../src/storage/revision.js";
import type { TransactionTargetInput } from "../src/storage/transactions.js";

const MAP_A = "maps/a.tmj";
const MAP_B = "maps/b.tmj";
const NEW_TILESET = "tiles/new.tsj";

interface Harness {
  root: string;
  resolver: ProjectPathResolver;
  store: DocumentStore;
}

class CrashRequested extends Error {}

describe("cross-file transactions", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("commits replace, create, and delete targets atomically", async () => {
    const harness = await createHarness(roots);
    const targets = await defaultTargets(harness);

    const result =
      await harness.store.commitTransaction(
        targets,
        "batch",
      );
    expect(result.results).toHaveLength(3);
    expect(result.results.map(({ kind }) => kind))
      .toEqual(["replace", "delete", "create"]);

    const mapA = JSON.parse(
      await readFile(
        join(harness.root, MAP_A),
        "utf8",
      ),
    ) as JsonObject;
    expect(mapA.renderorder).toBe("right-up");
    await expect(
      stat(join(harness.root, MAP_B)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const created = JSON.parse(
      await readFile(
        join(harness.root, NEW_TILESET),
        "utf8",
      ),
    ) as JsonObject;
    expect(created.name).toBe("fresh");

    // Manifest and staged objects are cleaned up.
    expect(
      await listInternal(harness.root, "transactions"),
    ).toEqual(["staged"]);
    expect(
      await listInternal(
        harness.root,
        "transactions/staged",
      ),
    ).toEqual([]);

    // Every target has a committed checkpoint; the deletion's restores.
    for (const target of result.results) {
      const manifests = await harness.store
        .checkpoints.list({
          limit: 100,
          scanLimit: 100,
        });
      const manifest = manifests.manifests.find(
        (candidate) =>
          candidate.id === target.checkpointId,
      );
      expect(manifest).toMatchObject({
        status: "committed",
        path: target.path,
      });
    }
  });

  it("rejects CAS conflicts before touching anything", async () => {
    const harness = await createHarness(roots);
    const targets = await defaultTargets(harness);
    const before = await readFile(
      join(harness.root, MAP_A),
      "utf8",
    );
    (targets[0] as {
      expectedRevision: string;
    }).expectedRevision = `sha256:${"0".repeat(64)}`;

    await expect(
      harness.store.commitTransaction(
        targets,
        "conflict",
      ),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    expect(
      await readFile(
        join(harness.root, MAP_A),
        "utf8",
      ),
    ).toBe(before);
    await expect(
      stat(join(harness.root, NEW_TILESET)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "cas-verified",
    "checkpoints-prepared",
    "staged",
    "manifest-prepared",
  ] as const)(
    "rolls back a crash before the commit point (at %s)",
    async (crashStep) => {
      const harness = await createHarness(
        roots,
        crashStep,
      );
      const targets =
        await defaultTargets(harness);
      const beforeA = await readFile(
        join(harness.root, MAP_A),
        "utf8",
      );
      const beforeB = await readFile(
        join(harness.root, MAP_B),
        "utf8",
      );

      await expect(
        harness.store.commitTransaction(
          targets,
          "crashy",
        ),
      ).rejects.toBeInstanceOf(CrashRequested);

      const recovered = await createStore(
        harness.root,
      );
      const report =
        await recovered.recoverTransactions();
      expect(report.conflicts).toEqual([]);
      expect(
        report.rolledForwardTargets,
      ).toBe(0);

      expect(
        await readFile(
          join(harness.root, MAP_A),
          "utf8",
        ),
      ).toBe(beforeA);
      expect(
        await readFile(
          join(harness.root, MAP_B),
          "utf8",
        ),
      ).toBe(beforeB);
      await expect(
        stat(join(harness.root, NEW_TILESET)),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        await listInternal(
          harness.root,
          "transactions",
        ),
      ).toEqual(["staged"]);
      expect(
        await listInternal(
          harness.root,
          "transactions/staged",
        ),
      ).toEqual([]);
    },
  );

  it.each([
    "commit-point",
    "checkpoints-committed",
    `promote:${MAP_B}`,
    "promoted",
  ] as const)(
    "rolls forward a crash after the commit point (at %s)",
    async (crashStep) => {
      const harness = await createHarness(
        roots,
        crashStep,
      );
      const targets =
        await defaultTargets(harness);

      await expect(
        harness.store.commitTransaction(
          targets,
          "crashy",
        ),
      ).rejects.toBeInstanceOf(CrashRequested);

      const recovered = await createStore(
        harness.root,
      );
      const report =
        await recovered.recoverTransactions();
      expect(report.conflicts).toEqual([]);
      expect(
        report.rolledForwardTargets +
          report.alreadyCompleteTargets,
      ).toBe(3);

      const mapA = JSON.parse(
        await readFile(
          join(harness.root, MAP_A),
          "utf8",
        ),
      ) as JsonObject;
      expect(mapA.renderorder).toBe("right-up");
      await expect(
        stat(join(harness.root, MAP_B)),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      const created = JSON.parse(
        await readFile(
          join(harness.root, NEW_TILESET),
          "utf8",
        ),
      ) as JsonObject;
      expect(created.name).toBe("fresh");
      expect(
        await listInternal(
          harness.root,
          "transactions",
        ),
      ).toEqual(["staged"]);
    },
  );

  it("reports a diverged target as a conflict and still rolls the rest forward", async () => {
    const harness = await createHarness(
      roots,
      "commit-point",
    );
    const targets = await defaultTargets(harness);
    await expect(
      harness.store.commitTransaction(
        targets,
        "crashy",
      ),
    ).rejects.toBeInstanceOf(CrashRequested);

    // An outside writer replaces MAP_A during the crash window.
    await writeFile(
      join(harness.root, MAP_A),
      serializeJsonDocument({
        ...baseMap("right-down"),
        nextobjectid: 99,
      }),
    );

    const recovered = await createStore(
      harness.root,
    );
    const report =
      await recovered.recoverTransactions();
    expect(report.conflicts).toEqual([
      expect.objectContaining({
        path: MAP_A,
        reason: "target-diverged",
      }),
    ]);
    // The other two targets rolled forward.
    await expect(
      stat(join(harness.root, MAP_B)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const created = JSON.parse(
      await readFile(
        join(harness.root, NEW_TILESET),
        "utf8",
      ),
    ) as JsonObject;
    expect(created.name).toBe("fresh");
    // The manifest stays for the conflicted target and its staged object
    // survives the sweep.
    const manifests = await listInternal(
      harness.root,
      "transactions",
    );
    expect(
      manifests.filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(1);
  });

  it("recovery is idempotent", async () => {
    const harness = await createHarness(
      roots,
      "commit-point",
    );
    const targets = await defaultTargets(harness);
    await expect(
      harness.store.commitTransaction(
        targets,
        "crashy",
      ),
    ).rejects.toBeInstanceOf(CrashRequested);

    const recovered = await createStore(
      harness.root,
    );
    await recovered.recoverTransactions();
    const second =
      await recovered.recoverTransactions();
    expect(second).toMatchObject({
      scannedManifests: 0,
      rolledBack: 0,
      rolledForwardTargets: 0,
      conflicts: [],
    });
  });
});

async function defaultTargets(
  harness: Harness,
): Promise<TransactionTargetInput[]> {
  const mapABytes = await readFile(
    join(harness.root, MAP_A),
  );
  const mapBBytes = await readFile(
    join(harness.root, MAP_B),
  );
  return [
    {
      kind: "replace",
      path: MAP_A,
      expectedRevision: revisionOf(mapABytes),
      content: serializeJsonDocument(
        baseMap("right-up"),
      ),
    },
    {
      kind: "delete",
      path: MAP_B,
      expectedRevision: revisionOf(mapBBytes),
    },
    {
      kind: "create",
      path: NEW_TILESET,
      content: serializeJsonDocument({
        columns: 1,
        image: "fresh.png",
        imageheight: 16,
        imagewidth: 16,
        margin: 0,
        name: "fresh",
        spacing: 0,
        tilecount: 1,
        tiledversion: "1.12.2",
        tileheight: 16,
        tilewidth: 16,
        type: "tileset",
        version: "1.10",
      }),
    },
  ];
}

function baseMap(renderOrder: string): JsonObject {
  return {
    compressionlevel: -1,
    height: 1,
    infinite: false,
    layers: [],
    nextlayerid: 1,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: renderOrder,
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 1,
  };
}

async function listInternal(
  root: string,
  relative: string,
): Promise<string[]> {
  try {
    return (
      await readdir(
        join(root, ".tiledmcp", relative),
      )
    ).sort();
  } catch {
    return [];
  }
}

async function createStore(
  root: string,
): Promise<DocumentStore> {
  const resolver =
    await ProjectPathResolver.create(root);
  return makeStore(resolver);
}

async function createHarness(
  roots: Set<string>,
  crashStep?: string,
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-transactions-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeFile(
    join(root, MAP_A),
    serializeJsonDocument(
      baseMap("right-down"),
    ),
  );
  await writeFile(
    join(root, MAP_B),
    serializeJsonDocument(
      baseMap("right-down"),
    ),
  );

  const resolver =
    await ProjectPathResolver.create(root);
  const store = makeStore(resolver, { checkpointOptions: {}, transactionObserver: crashStep === undefined
      ? undefined
      : {
          beforeStep: (step) => {
            if (step === crashStep) {
              throw new CrashRequested(
                `crash at ${step}`,
              );
            }
          },
        } });
  return { root, resolver, store };
}
