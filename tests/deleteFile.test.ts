import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChangeSetRegistry } from "../src/changeSets.js";
import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import {
  fileDeletePlanId,
  type FileDeletePlan,
} from "../src/maps/fileDelete.js";
import { MapService } from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  applyCheckpointRestore,
  planCheckpointRestore,
} from "../src/storage/checkpointRestore.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/terrain.tsj";
const LONER_TILESET_PATH = "tiles/unused.tsj";

interface Harness {
  root: string;
  service: MapService;
  store: DocumentStore;
}

describe("tiled_delete_file planning, apply, and restore", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("deletes an unreferenced tileset and restores it byte-exactly from its checkpoint", async () => {
    const harness = await createHarness(roots);
    const originalBytes = await readFile(
      join(harness.root, LONER_TILESET_PATH),
    );

    const plan =
      await harness.service.planDeleteFile({
        path: LONER_TILESET_PATH,
      });
    expect(plan).toMatchObject({
      kind: "fileDelete",
      version: 1,
      targetPath: LONER_TILESET_PATH,
      targetKind: "tileset",
      size: originalBytes.byteLength,
      summary: {
        checkpointPolicy:
          "committed-before-unlink",
        wouldChange: true,
      },
    });
    expect(plan.scan.scannedMaps).toBe(1);

    const preview =
      new ChangeSetRegistry().put(plan);
    expect(preview).toMatchObject({
      kind: "fileDelete",
      targetPath: LONER_TILESET_PATH,
      expectedRevision: plan.baseRevision,
      operations: [
        {
          type: "deleteFile",
          destructive: true,
          targetKind: "tileset",
          revision: plan.baseRevision,
        },
      ],
    });

    const result =
      await harness.service.applyDeleteFile(plan);
    expect(result).toMatchObject({
      kind: "fileDelete",
      path: LONER_TILESET_PATH,
      beforeRevision: plan.baseRevision,
      deleted: true,
    });
    await expect(
      stat(join(harness.root, LONER_TILESET_PATH)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const restorePlan =
      await planCheckpointRestore(
        harness.store,
        result.checkpointId,
        plan.baseRevision,
      );
    expect(restorePlan).toMatchObject({
      targetMissing: true,
      baseRevision: plan.baseRevision,
      restoreRevision: plan.baseRevision,
      wouldChange: true,
      summary: { currentRevision: null },
    });
    const restored = await applyCheckpointRestore(
      harness.store,
      restorePlan,
    );
    expect(restored).toMatchObject({
      path: LONER_TILESET_PATH,
      beforeRevision: null,
      revision: plan.baseRevision,
      changed: true,
    });
    const restoredBytes = await readFile(
      join(harness.root, LONER_TILESET_PATH),
    );
    expect(
      restoredBytes.equals(originalBytes),
    ).toBe(true);
  });

  it("fails closed when the target is still referenced", async () => {
    const harness = await createHarness(roots);

    await expect(
      harness.service.planDeleteFile({
        path: TILESET_PATH,
      }),
    ).rejects.toMatchObject({
      code: "FILE_IN_USE",
      details: expect.objectContaining({
        path: TILESET_PATH,
        referencedByCount: 1,
        referencedBy: [MAP_PATH],
      }),
    });
  });

  it("fails closed on world references, world patterns, and template references", async () => {
    const harness = await createHarness(roots);
    await writeFile(
      join(harness.root, "overworld.world"),
      JSON.stringify({
        maps: [
          {
            fileName: "maps/level.tmj",
            x: 0,
            y: 0,
          },
        ],
        onlyShowAdjacentMaps: false,
        type: "world",
      }),
      "utf8",
    );
    await expect(
      harness.service.planDeleteFile({
        path: MAP_PATH,
      }),
    ).rejects.toMatchObject({
      code: "FILE_IN_USE",
      details: expect.objectContaining({
        referencedBy: ["overworld.world"],
      }),
    });

    await writeFile(
      join(harness.root, "overworld.world"),
      JSON.stringify({
        maps: [],
        patterns: [
          {
            regexp: "level-\\d+\\.tmj",
            multiplierX: 1,
            multiplierY: 1,
          },
        ],
        type: "world",
      }),
      "utf8",
    );
    await expect(
      harness.service.planDeleteFile({
        path: MAP_PATH,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_REFERENCE_SCAN",
      details: expect.objectContaining({
        reason: "world-patterns",
      }),
    });
    await rm(
      join(harness.root, "overworld.world"),
    );

    await writeFile(
      join(harness.root, "tiles", "prop.tj"),
      JSON.stringify({
        type: "template",
        tileset: {
          firstgid: 1,
          source: "unused.tsj",
        },
        object: { id: 0, name: "prop", gid: 1 },
      }),
      "utf8",
    );
    await expect(
      harness.service.planDeleteFile({
        path: LONER_TILESET_PATH,
      }),
    ).rejects.toMatchObject({
      code: "FILE_IN_USE",
      details: expect.objectContaining({
        referencedBy: ["tiles/prop.tj"],
      }),
    });
  });

  it("scans XML assets for references and fails closed only when they cannot be parsed", async () => {
    const harness = await createHarness(roots);
    // A reference-free TMX map no longer blocks the scan wholesale.
    await writeFile(
      join(harness.root, "maps", "legacy.tmx"),
      "<map/>",
      "utf8",
    );
    const plan =
      await harness.service.planDeleteFile({
        path: LONER_TILESET_PATH,
      });
    expect(plan.scan.scannedMaps).toBeGreaterThan(
      0,
    );
    // A malformed XML referrer cannot prove the target unreferenced.
    await writeFile(
      join(harness.root, "maps", "broken.tmx"),
      "<map><layer></map>",
      "utf8",
    );
    await expect(
      harness.service.planDeleteFile({
        path: LONER_TILESET_PATH,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
  });

  it("re-checks references and revision at apply time", async () => {
    const harness = await createHarness(roots);

    const plan =
      await harness.service.planDeleteFile({
        path: LONER_TILESET_PATH,
      });

    const mapAbsolute = join(
      harness.root,
      MAP_PATH,
    );
    const map = JSON.parse(
      (await readFile(mapAbsolute)).toString(
        "utf8",
      ),
    ) as JsonObject;
    (map.tilesets as JsonObject[]).push({
      firstgid: 100,
      source: "../tiles/unused.tsj",
    });
    await writeFile(
      mapAbsolute,
      serializeJsonDocument(map),
    );
    await expect(
      harness.service.applyDeleteFile(plan),
    ).rejects.toMatchObject({
      code: "FILE_IN_USE",
    });

    const revert = await createHarness(roots);
    const stalePlan =
      await revert.service.planDeleteFile({
        path: LONER_TILESET_PATH,
      });
    await writeFile(
      join(revert.root, LONER_TILESET_PATH),
      serializeJsonDocument({
        ...JSON.parse(
          (
            await readFile(
              join(
                revert.root,
                LONER_TILESET_PATH,
              ),
            )
          ).toString("utf8"),
        ),
        name: "renamed",
      } as JsonObject),
    );
    await expect(
      revert.service.applyDeleteFile(stalePlan),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
  });

  it("rejects tampered plans and unsupported targets", async () => {
    const harness = await createHarness(roots);

    const plan =
      await harness.service.planDeleteFile({
        path: LONER_TILESET_PATH,
      });
    const tampered: FileDeletePlan = {
      ...structuredClone(plan),
      targetPath: MAP_PATH,
      targetKind: "map",
      summary: {
        ...structuredClone(plan.summary),
        targetPath: MAP_PATH,
        targetKind: "map",
      },
    };
    await expect(
      harness.service.applyDeleteFile(tampered),
    ).rejects.toMatchObject({
      code: "CHANGE_SET_TAMPERED",
    });
    const resigned: FileDeletePlan = (() => {
      const { id: _id, ...unsigned } =
        structuredClone(plan);
      const forged = {
        ...unsigned,
        targetPath: MAP_PATH,
        summary: {
          ...unsigned.summary,
          targetPath: MAP_PATH,
          targetKind: "map" as const,
        },
        targetKind: "map" as const,
      };
      return {
        ...forged,
        id: fileDeletePlanId(forged),
      };
    })();
    await expect(
      harness.service.applyDeleteFile(resigned),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });

    await expect(
      harness.service.planDeleteFile({
        path: "tiles/terrain.svg",
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
    await expect(
      harness.service.planDeleteFile({
        path: "maps/missing.tmj",
      }),
    ).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
  });

  it("rejects restoring a missing target with the wrong revision or a reappeared file", async () => {
    const harness = await createHarness(roots);
    const plan =
      await harness.service.planDeleteFile({
        path: LONER_TILESET_PATH,
      });
    const result =
      await harness.service.applyDeleteFile(plan);

    await expect(
      planCheckpointRestore(
        harness.store,
        result.checkpointId,
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      ),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      details: expect.objectContaining({
        actualRevision: null,
        restoreRevision: plan.baseRevision,
      }),
    });

    const restorePlan =
      await planCheckpointRestore(
        harness.store,
        result.checkpointId,
        plan.baseRevision,
      );
    await writeFile(
      join(harness.root, LONER_TILESET_PATH),
      "{}",
      "utf8",
    );
    await expect(
      applyCheckpointRestore(
        harness.store,
        restorePlan,
      ),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_STATE_CONFLICT",
    });
  });
});

async function createHarness(
  roots: Set<string>,
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-delete-file-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeJson(join(root, MAP_PATH), baseMap());
  await writeJson(
    join(root, TILESET_PATH),
    baseTileset("terrain"),
  );
  await writeJson(
    join(root, LONER_TILESET_PATH),
    baseTileset("unused"),
  );
  await writeFile(
    join(root, "tiles", "terrain.svg"),
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">',
      '<rect width="16" height="16" fill="#8899aa"/>',
      "</svg>",
    ].join(""),
    "utf8",
  );

  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  return {
    root,
    store,
    service: new MapService(resolver, store),
  };
}

function baseMap(): JsonObject {
  return {
    compressionlevel: -1,
    height: 2,
    infinite: false,
    layers: [
      {
        data: [0, 0, 0, 0],
        height: 2,
        id: 1,
        name: "Ground",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 2,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 2,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [
      {
        firstgid: 1,
        source: "../tiles/terrain.tsj",
      },
    ],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 2,
  };
}

function baseTileset(name: string): JsonObject {
  return {
    columns: 1,
    image: "terrain.svg",
    imageheight: 16,
    imagewidth: 16,
    margin: 0,
    name,
    spacing: 0,
    tilecount: 1,
    tiledversion: "1.12.2",
    tileheight: 16,
    tilewidth: 16,
    type: "tileset",
    version: "1.10",
  };
}

async function writeJson(
  path: string,
  document: JsonObject,
): Promise<void> {
  await writeFile(
    path,
    serializeJsonDocument(document),
  );
}
