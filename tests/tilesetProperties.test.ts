import { readFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  parseJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import {
  applyTilesetPropertyPatch,
  tilesetPropertyEditPlanId,
  type TilesetPropertyEditPlan,
} from "../src/maps/tilesetProperties.js";
import {
  createProject,
  disposeProject,
  type TestProject,
} from "./support/project.js";

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/atlas.tsj";

function tilesetDocument(
  overrides: JsonObject = {},
): JsonObject {
  return {
    columns: 4,
    image: "atlas.png",
    imageheight: 64,
    imagewidth: 64,
    margin: 0,
    name: "Atlas",
    spacing: 0,
    tilecount: 16,
    tiledversion: "1.12.2",
    tileheight: 16,
    tilewidth: 16,
    type: "tileset",
    version: "1.10",
    ...overrides,
  };
}

function mapDocument(): JsonObject {
  return {
    compressionlevel: -1,
    height: 1,
    infinite: false,
    layers: [
      {
        data: [1],
        height: 1,
        id: 1,
        name: "ground",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 1,
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
      { firstgid: 1, source: "../tiles/atlas.tsj" },
    ],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 1,
  };
}

interface Pins {
  project: TestProject;
  assetId: string;
  mapRevision: string;
  tilesetRevision: string;
}

describe("applyTilesetPropertyPatch", () => {
  it("rewrites only the members the patch changes", () => {
    const document = tilesetDocument({
      class: "Terrain",
    });
    const applied = applyTilesetPropertyPatch(
      document,
      {
        // Already "Terrain": re-setting it must not count as a change.
        className: "Terrain",
        objectAlignment: "bottomleft",
      },
      TILESET_PATH,
    );
    expect(applied.summary).toEqual({
      requestedFields: [
        "className",
        "objectAlignment",
      ],
      changedFields: ["objectAlignment"],
      wouldChange: true,
    });
    expect(applied.memberPatches).toEqual([
      { path: [], key: "objectalignment" },
    ]);
    expect(document.objectalignment).toBe(
      "bottomleft",
    );
  });

  it("removes a member for null rather than writing a default", () => {
    const document = tilesetDocument({
      fillmode: "preserve-aspect-fit",
    });
    const applied = applyTilesetPropertyPatch(
      document,
      { fillMode: null },
      TILESET_PATH,
    );
    expect(applied.summary.changedFields).toEqual(
      ["fillMode"],
    );
    expect("fillmode" in document).toBe(false);
  });

  it("reports no change when a null removes an absent member", () => {
    const applied = applyTilesetPropertyPatch(
      tilesetDocument(),
      { fillMode: null },
      TILESET_PATH,
    );
    expect(applied.summary).toEqual({
      requestedFields: ["fillMode"],
      changedFields: [],
      wouldChange: false,
    });
    expect(applied.memberPatches).toEqual([]);
  });

  it("maps camelCase transformation flags onto Tiled's lowercase members", () => {
    const document = tilesetDocument();
    applyTilesetPropertyPatch(
      document,
      {
        transformations: {
          hFlip: true,
          vFlip: false,
          rotate: true,
          preferUntransformed: false,
        },
      },
      TILESET_PATH,
    );
    expect(document.transformations).toEqual({
      hflip: true,
      vflip: false,
      rotate: true,
      preferuntransformed: false,
    });
  });

  it("rejects an empty patch", () => {
    expect(() =>
      applyTilesetPropertyPatch(
        tilesetDocument(),
        {},
        TILESET_PATH,
      ),
    ).toThrow(/at least one of/);
  });

  it("rejects an unknown patch field", () => {
    expect(() =>
      applyTilesetPropertyPatch(
        tilesetDocument(),
        {
          tileWidth: 32,
        } as never,
        TILESET_PATH,
      ),
    ).toThrow();
  });

  it("rejects an out-of-range tile offset", () => {
    expect(() =>
      applyTilesetPropertyPatch(
        tilesetDocument(),
        {
          tileOffset: { x: 0, y: 1e18 },
        },
        TILESET_PATH,
      ),
    ).toThrow(/tileOffset\.y/);
  });
});

describe("tiled_update_tileset service", () => {
  let project: TestProject | undefined;

  afterEach(async () => {
    if (project !== undefined) {
      await disposeProject(project);
      project = undefined;
    }
  });

  async function open(
    tilesetOverrides: JsonObject = {},
  ): Promise<Pins> {
    const created = await createProject({
      prefix: "tiledmcp-tileset-properties",
      files: {
        [MAP_PATH]: mapDocument(),
        [TILESET_PATH]:
          tilesetDocument(tilesetOverrides),
        // The binding loader verifies the atlas image exists.
        "tiles/atlas.png": await sharp({
          create: {
            width: 64,
            height: 64,
            channels: 4,
            background: {
              r: 0,
              g: 0,
              b: 0,
              alpha: 0,
            },
          },
        })
          .png()
          .toBuffer(),
      },
    });
    project = created;
    const summary =
      (await created.service.getSummary(
        MAP_PATH,
      )) as {
        revision: string;
        tilesets: Array<{ assetId: string }>;
        dependencyRevisions: Record<
          string,
          string
        >;
      };
    const assetId = summary.tilesets[0]
      ?.assetId as string;
    return {
      project: created,
      assetId,
      mapRevision: summary.revision,
      tilesetRevision: summary
        .dependencyRevisions[assetId] as string,
    };
  }

  async function readTileset(
    pins: Pins,
  ): Promise<JsonObject> {
    return parseJsonDocument(
      await readFile(
        join(pins.project.root, TILESET_PATH),
        "utf8",
      ),
      TILESET_PATH,
    );
  }

  it("plans and applies a tileset-level patch", async () => {
    const pins = await open();
    const plan =
      await pins.project.service.planTilesetPropertyEdit(
        {
          mapPath: MAP_PATH,
          tilesetAssetId: pins.assetId,
          expectedMapRevision: pins.mapRevision,
          expectedTilesetRevision:
            pins.tilesetRevision,
          patch: {
            className: "Terrain",
            tileOffset: { x: 0, y: -8 },
          },
        },
      );

    expect(plan).toMatchObject({
      kind: "tilesetPropertyEdit",
      version: 1,
      mapPath: MAP_PATH,
      tilesetPath: TILESET_PATH,
      assetId: pins.assetId,
      summary: {
        requestedFields: [
          "className",
          "tileOffset",
        ],
        changedFields: [
          "className",
          "tileOffset",
        ],
        wouldChange: true,
      },
    });

    await pins.project.service.applyTilesetPropertyEdit(
      plan,
    );
    const document = await readTileset(pins);
    expect(document.class).toBe("Terrain");
    expect(document.tileoffset).toEqual({
      x: 0,
      y: -8,
    });
    // Geometry is untouched.
    expect(document.tilewidth).toBe(16);
    expect(document.tilecount).toBe(16);
  });

  it("preserves untouched source bytes", async () => {
    const pins = await open();
    const before = await readFile(
      join(pins.project.root, TILESET_PATH),
      "utf8",
    );
    const plan =
      await pins.project.service.planTilesetPropertyEdit(
        {
          mapPath: MAP_PATH,
          tilesetAssetId: pins.assetId,
          expectedMapRevision: pins.mapRevision,
          expectedTilesetRevision:
            pins.tilesetRevision,
          patch: { name: "Renamed" },
        },
      );
    await pins.project.service.applyTilesetPropertyEdit(
      plan,
    );
    const after = await readFile(
      join(pins.project.root, TILESET_PATH),
      "utf8",
    );
    // A source-preserving patch rewrites the one member and nothing else.
    expect(after).toBe(
      before.replace(
        '"name": "Atlas"',
        '"name": "Renamed"',
      ),
    );
  });

  it("fails closed when the patch matches current values", async () => {
    const pins = await open({
      class: "Terrain",
    });
    await expect(
      pins.project.service.planTilesetPropertyEdit(
        {
          mapPath: MAP_PATH,
          tilesetAssetId: pins.assetId,
          expectedMapRevision: pins.mapRevision,
          expectedTilesetRevision:
            pins.tilesetRevision,
          patch: { className: "Terrain" },
        },
      ),
    ).rejects.toThrow(/nothing to apply/);
  });

  it("rejects a stale tileset revision", async () => {
    const pins = await open();
    await expect(
      pins.project.service.planTilesetPropertyEdit(
        {
          mapPath: MAP_PATH,
          tilesetAssetId: pins.assetId,
          expectedMapRevision: pins.mapRevision,
          expectedTilesetRevision: `sha256:${"0".repeat(64)}`,
          patch: { name: "Renamed" },
        },
      ),
    ).rejects.toThrow(/changed since it was read/);
  });

  it("rejects a tampered plan", async () => {
    const pins = await open();
    const plan =
      await pins.project.service.planTilesetPropertyEdit(
        {
          mapPath: MAP_PATH,
          tilesetAssetId: pins.assetId,
          expectedMapRevision: pins.mapRevision,
          expectedTilesetRevision:
            pins.tilesetRevision,
          patch: { name: "Renamed" },
        },
      );
    const tampered: TilesetPropertyEditPlan = {
      ...plan,
      patch: { name: "Something else" },
    };
    await expect(
      pins.project.service.applyTilesetPropertyEdit(
        tampered,
      ),
    ).rejects.toThrow(/do not match its digest/);
  });

  it("signs the plan over its patch", async () => {
    const pins = await open();
    const plan =
      await pins.project.service.planTilesetPropertyEdit(
        {
          mapPath: MAP_PATH,
          tilesetAssetId: pins.assetId,
          expectedMapRevision: pins.mapRevision,
          expectedTilesetRevision:
            pins.tilesetRevision,
          patch: { name: "Renamed" },
        },
      );
    const { id, ...unsigned } = plan;
    expect(id).toBe(
      tilesetPropertyEditPlanId(unsigned),
    );
  });

  it("refuses a second apply against the consumed revision", async () => {
    const pins = await open();
    const plan =
      await pins.project.service.planTilesetPropertyEdit(
        {
          mapPath: MAP_PATH,
          tilesetAssetId: pins.assetId,
          expectedMapRevision: pins.mapRevision,
          expectedTilesetRevision:
            pins.tilesetRevision,
          patch: { name: "Renamed" },
        },
      );
    await pins.project.service.applyTilesetPropertyEdit(
      plan,
    );
    await expect(
      pins.project.service.applyTilesetPropertyEdit(
        plan,
      ),
    ).rejects.toThrow();
  });
});
