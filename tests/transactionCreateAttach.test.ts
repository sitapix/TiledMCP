import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { wireProject } from "./support/project.js";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  ChangeSetRegistry,
  type ChangeSetApplyResult,
} from "../src/changeSets.js";
import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import type { UpdateMapOperation } from "../src/maps/types.js";
import { revisionOf } from "../src/storage/revision.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const MAP_PATH = "maps/level.tmj";
const SECOND_MAP_PATH = "maps/annex.tmj";
const THIRD_MAP_PATH = "maps/outpost.tmj";
const NEW_TILESET_PATH = "tiles/props.tsj";
const TERRAIN_TILESET_PATH = "tiles/terrain.tsj";
const IMAGE_PATH = "images/props-atlas.png";

interface Harness {
  root: string;
  service: MapService;
  store: DocumentStore;
  registry: ChangeSetRegistry;
}

describe("create+attach transaction coupling", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("attaches a prospective tileset atomically with its creation", async () => {
    const harness = await createHarness(roots);
    const createPreview =
      await previewCreate(harness);
    const attachPreview = await previewAttach(
      harness,
      createPreview.changeSetId,
    );
    expect(attachPreview).toMatchObject({
      kind: "mapEdit",
      operations: [
        {
          type: "addTilesetToMap",
          tileset: expect.objectContaining({
            path: NEW_TILESET_PATH,
            revision:
              createPreview.expectedRevision,
          }),
        },
      ],
    });
    const prospectivePins =
      attachPreview.kind === "mapEdit"
        ? attachPreview.prospectiveDependencyRevisions
        : undefined;
    expect(
      Object.values(prospectivePins ?? {}),
    ).toEqual([createPreview.expectedRevision]);
    const prospectiveAssetId = Object.keys(
      prospectivePins ?? {},
    )[0] as string;

    const transaction =
      harness.registry.previewTransaction([
        createPreview.changeSetId,
        attachPreview.changeSetId,
      ]);
    const result = (await applyLikeServer(
      harness,
      transaction.changeSetId,
      transaction.expectedRevision,
    )) as Extract<
      ChangeSetApplyResult,
      { kind: "transaction" }
    >;
    expect(result.results).toMatchObject([
      {
        path: NEW_TILESET_PATH,
        beforeRevision: null,
        revision: createPreview.expectedRevision,
        changed: true,
      },
      { path: MAP_PATH, changed: true },
    ]);

    const tilesetBytes = await readFile(
      join(harness.root, NEW_TILESET_PATH),
    );
    expect(revisionOf(tilesetBytes)).toBe(
      createPreview.expectedRevision,
    );
    const mapAfter = JSON.parse(
      (
        await readFile(
          join(harness.root, MAP_PATH),
        )
      ).toString("utf8"),
    ) as JsonObject;
    expect(mapAfter.tilesets).toEqual([
      {
        firstgid: 1,
        source: "../tiles/props.tsj",
      },
    ]);

    // Binding resolution after the commit reproduces the prospective
    // asset ID, so follow-up edits pin the tileset under the same key.
    const followUp =
      await harness.service.planEdits(
        MAP_PATH,
        (
          await harness.store.readSnapshot(
            MAP_PATH,
          )
        ).revision,
        {
          [prospectiveAssetId]:
            createPreview.expectedRevision,
        },
        [
          {
            type: "updateMap",
            patch: { renderOrder: "left-up" },
          },
        ],
      );
    expect(
      followUp.dependencyRevisions,
    ).toEqual({
      [prospectiveAssetId]:
        createPreview.expectedRevision,
    });
  });

  it("applies the create individually and the prospective attachment still lands", async () => {
    const harness = await createHarness(roots);
    const createPreview =
      await previewCreate(harness);
    const attachPreview = await previewAttach(
      harness,
      createPreview.changeSetId,
    );

    await harness.registry.apply(
      createPreview.changeSetId,
      createPreview.expectedRevision,
      async (plan) => {
        if (plan.kind !== "tilesetCreate") {
          throw new Error("expected create");
        }
        return harness.service.applyTilesetCreate(
          plan,
        );
      },
    );
    const attachResult =
      await harness.registry.apply(
        attachPreview.changeSetId,
        attachPreview.expectedRevision,
        async (plan) => {
          if (plan.kind !== "mapEdit") {
            throw new Error("expected map edit");
          }
          return harness.service.applyEdits(plan);
        },
      );
    expect(attachResult).toMatchObject({
      path: MAP_PATH,
      changed: true,
    });
    const mapAfter = JSON.parse(
      (
        await readFile(
          join(harness.root, MAP_PATH),
        )
      ).toString("utf8"),
    ) as JsonObject;
    expect(mapAfter.tilesets).toEqual([
      {
        firstgid: 1,
        source: "../tiles/props.tsj",
      },
    ]);
  });

  it("fails closed on stale or non-create couplings", async () => {
    const harness = await createHarness(roots);
    const createPreview =
      await previewCreate(harness);

    // The create plan must target the attached path.
    await expect(
      harness.service.planAddTilesetToMap({
        mapPath: MAP_PATH,
        tilesetPath: "tiles/other.tsj",
        expectedMapRevision: (
          await harness.store.readSnapshot(
            MAP_PATH,
          )
        ).revision,
        expectedDependencyRevisions: {},
        createPlan:
          harness.registry.getTilesetCreatePlan(
            createPreview.changeSetId,
          ),
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });

    // A same-path create with different content breaks the coupling pin.
    const attachPreview = await previewAttach(
      harness,
      createPreview.changeSetId,
    );
    const otherCreate = harness.registry.put(
      await harness.service.planCreateTileset({
        tilesetPath: NEW_TILESET_PATH,
        imagePath: IMAGE_PATH,
        tileWidth: 8,
        tileHeight: 8,
      }),
    );
    expect(
      otherCreate.expectedRevision,
    ).not.toBe(createPreview.expectedRevision);
    expect(() =>
      harness.registry.previewTransaction([
        otherCreate.changeSetId,
        attachPreview.changeSetId,
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        details: expect.objectContaining({
          tilesetPath: NEW_TILESET_PATH,
        }),
      }),
    );

    // An unrelated change set kind cannot stand in for the create.
    expect(() =>
      harness.registry.getTilesetCreatePlan(
        attachPreview.changeSetId,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );

    // Without the coupling, a missing tileset still fails closed.
    await expect(
      harness.service.planAddTilesetToMap({
        mapPath: MAP_PATH,
        tilesetPath: "tiles/absent.tsj",
        expectedMapRevision: (
          await harness.store.readSnapshot(
            MAP_PATH,
          )
        ).revision,
        expectedDependencyRevisions: {},
      }),
    ).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
  });

  it("commits pre-state-consistent coupled members atomically and rejects mismatched pins", async () => {
    const harness = await createHarness(roots);

    // Learn the terrain binding from the second map's summary.
    const summary =
      (await harness.service.getSummary(
        SECOND_MAP_PATH,
      )) as {
      tilesets: {
        assetId: string;
        revision: string;
      }[];
    };
    const binding = summary.tilesets[0];
    if (binding === undefined) {
      throw new Error("expected a binding");
    }
    const terrainAssetId = binding.assetId;
    const terrainRevision = binding.revision;
    const terrainPins = {
      [terrainAssetId]: terrainRevision,
    };

    // A map edit and a tileset edit previewed against the same state may
    // commit together even though the map edit pins the edited tileset.
    const mapEditAnnex = harness.registry.put(
      await planMapUpdate(
        harness,
        SECOND_MAP_PATH,
        terrainPins,
      ),
    );
    const tilesetEditViaThird =
      harness.registry.put(
        await harness.service.planUpdateTile({
          mapPath: THIRD_MAP_PATH,
          tilesetAssetId: terrainAssetId,
          expectedMapRevision: (
            await harness.store.readSnapshot(
              THIRD_MAP_PATH,
            )
          ).revision,
          expectedTilesetRevision:
            terrainRevision,
          updates: [
            {
              tileId: 0,
              patch: { probability: 3 },
            },
          ],
        }),
      );
    const transaction =
      harness.registry.previewTransaction([
        mapEditAnnex.changeSetId,
        tilesetEditViaThird.changeSetId,
      ]);
    const result = (await applyLikeServer(
      harness,
      transaction.changeSetId,
      transaction.expectedRevision,
    )) as { kind: string; results: unknown[] };
    expect(result).toMatchObject({
      kind: "transaction",
      results: [
        { path: SECOND_MAP_PATH, changed: true },
        {
          path: TERRAIN_TILESET_PATH,
          changed: true,
        },
      ],
    });
    const terrainAfter = JSON.parse(
      (
        await readFile(
          join(
            harness.root,
            TERRAIN_TILESET_PATH,
          ),
        )
      ).toString("utf8"),
    ) as {
      tiles?: Array<{
        id: number;
        probability?: number;
      }>;
    };
    expect(
      terrainAfter.tiles?.find(
        ({ id }) => id === 0,
      )?.probability,
    ).toBe(3);

    // A pin recorded against an older state is rejected at preview.
    const staleTilesetEdit =
      harness.registry.put(
        await harness.service.planUpdateTile({
          mapPath: SECOND_MAP_PATH,
          tilesetAssetId: terrainAssetId,
          expectedMapRevision: (
            await harness.store.readSnapshot(
              SECOND_MAP_PATH,
            )
          ).revision,
          expectedTilesetRevision: (
            await harness.store.readSnapshot(
              TERRAIN_TILESET_PATH,
            )
          ).revision,
          updates: [
            {
              tileId: 1,
              patch: { probability: 2 },
            },
          ],
        }),
      );
    // Move the map forward so the stale member's map pin diverges.
    await harness.registry.apply(
      harness.registry.put(
        await planMapUpdate(
          harness,
          SECOND_MAP_PATH,
          {
            [terrainAssetId]: (
              await harness.store.readSnapshot(
                TERRAIN_TILESET_PATH,
              )
            ).revision,
          },
          { renderOrder: "left-up" },
        ),
      ).changeSetId,
      (
        await harness.store.readSnapshot(
          SECOND_MAP_PATH,
        )
      ).revision,
      async (plan) => {
        if (plan.kind !== "mapEdit") {
          throw new Error("expected map edit");
        }
        return harness.service.applyEdits(plan);
      },
    );
    const freshMapEdit = harness.registry.put(
      await planMapUpdate(
        harness,
        SECOND_MAP_PATH,
        {
          [terrainAssetId]: (
            await harness.store.readSnapshot(
              TERRAIN_TILESET_PATH,
            )
          ).revision,
        },
      ),
    );
    expect(() =>
      harness.registry.previewTransaction([
        freshMapEdit.changeSetId,
        staleTilesetEdit.changeSetId,
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        details: expect.objectContaining({
          mapPath: SECOND_MAP_PATH,
        }),
      }),
    );
  });
});

async function applyLikeServer(
  harness: Harness,
  changeSetId: string,
  expectedRevision: string,
): Promise<ChangeSetApplyResult> {
  return harness.registry.apply(
    changeSetId,
    expectedRevision,
    async (plan) => {
      if (plan.kind !== "transaction") {
        throw new Error(
          `expected a transaction plan, got ${plan.kind}`,
        );
      }
      const memberPlans =
        harness.registry.resolveTransactionMembers(
          plan,
        );
      const outcome =
        await harness.service.applyTransaction(
          plan,
          memberPlans,
        );
      harness.registry.completeTransactionMembers(
        plan,
        outcome.memberResults,
      );
      return outcome.result;
    },
  );
}

async function previewCreate(harness: Harness) {
  return harness.registry.put(
    await harness.service.planCreateTileset({
      tilesetPath: NEW_TILESET_PATH,
      imagePath: IMAGE_PATH,
      tileWidth: 16,
      tileHeight: 16,
    }),
  );
}

async function previewAttach(
  harness: Harness,
  createChangeSetId: string,
) {
  const snapshot =
    await harness.store.readSnapshot(MAP_PATH);
  return harness.registry.put(
    await harness.service.planAddTilesetToMap({
      mapPath: MAP_PATH,
      tilesetPath: NEW_TILESET_PATH,
      expectedMapRevision: snapshot.revision,
      expectedDependencyRevisions: {},
      createPlan:
        harness.registry.getTilesetCreatePlan(
          createChangeSetId,
        ),
    }),
  );
}

async function planMapUpdate(
  harness: Harness,
  mapPath: string,
  dependencyRevisions: Record<
    string,
    string
  > = {},
  patch: Record<string, string> = {
    backgroundColor: "#11223344",
  },
) {
  const snapshot =
    await harness.store.readSnapshot(mapPath);
  const operations: UpdateMapOperation[] = [
    { type: "updateMap", patch },
  ];
  return harness.service.planEdits(
    mapPath,
    snapshot.revision,
    dependencyRevisions,
    operations,
  );
}

async function createHarness(
  roots: Set<string>,
): Promise<Harness> {
  const root = await mkdtemp(
    join(
      tmpdir(),
      "tiledmcp-transaction-create-attach-",
    ),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await mkdir(join(root, "images"));
  await writeFile(
    join(root, IMAGE_PATH),
    await buildAtlasPng(64, 48),
  );
  await writeFile(
    join(root, TERRAIN_TILESET_PATH),
    serializeJsonDocument(
      baseTileset("terrain"),
    ),
  );
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument(baseMap([])),
  );
  await writeFile(
    join(root, SECOND_MAP_PATH),
    serializeJsonDocument(
      baseMap([
        {
          firstgid: 1,
          source: "../tiles/terrain.tsj",
        },
      ]),
    ),
  );
  await writeFile(
    join(root, THIRD_MAP_PATH),
    serializeJsonDocument(
      baseMap([
        {
          firstgid: 1,
          source: "../tiles/terrain.tsj",
        },
      ]),
    ),
  );

  const { store, service } =
    await wireProject(root);
  return {
    root,
    store,
    service: service,
    registry: new ChangeSetRegistry(),
  };
}

async function buildAtlasPng(
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: {
        r: 90,
        g: 140,
        b: 90,
        alpha: 1,
      },
    },
  })
    .png()
    .toBuffer();
}

function baseMap(
  tilesets: JsonObject[],
): JsonObject {
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
    tilesets,
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 2,
  };
}

function baseTileset(name: string): JsonObject {
  return {
    columns: 4,
    image: "../images/props-atlas.png",
    imageheight: 48,
    imagewidth: 64,
    margin: 0,
    name,
    spacing: 0,
    tilecount: 12,
    tiledversion: "1.12.2",
    tileheight: 16,
    tilewidth: 16,
    type: "tileset",
    version: "1.10",
  };
}
