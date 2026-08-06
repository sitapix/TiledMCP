import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { wireProject } from "./support/project.js";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeJsonDocument } from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";

const MAP_PATH = "maps/iso.tmj";

interface Harness {
  root: string;
  service: MapService;
}

describe("isometric map read-only access", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("summarizes, reads regions, and analyzes usage on isometric maps", async () => {
    const harness = await createHarness(
      roots,
      "isometric",
    );
    const summary = await harness.service.getSummary(
      MAP_PATH,
    );
    expect(summary).toMatchObject({
      orientation: "isometric",
      editableProfile: "isometric-tmj-editable-core",
      width: 2,
      height: 2,
    });

    const region = await harness.service.getRegion({
      mapPath: MAP_PATH,
      layerId: 1,
      x: 0,
      y: 0,
      width: 2,
      height: 2,
    });
    const rows = region.rows as Array<
      Array<{ localId: number } | null>
    >;
    expect(rows[0]?.[0]).toMatchObject({
      localId: 0,
    });
    expect(rows[1]?.[1]).toBeNull();

    const usage = await harness.service.analyzeUsage(
      { mapPath: MAP_PATH },
    );
    expect(usage).toMatchObject({
      profile: "isometric-tmj-read-only",
    });

    // Every edit path keeps the fail-closed gate.
    // Cell storage and object pixel coordinates are
    // orientation-independent, so the ordinary map-edit path now
    // covers isometric maps end to end.
    const plan = await harness.service.planEdits(
      MAP_PATH,
      summary.revision as string,
      summary.dependencyRevisions as Record<
        string,
        string
      >,
      [
        {
          type: "updateMap",
          patch: { renderOrder: "left-up" },
        },
        {
          type: "setTiles",
          layerId: 1,
          cells: [
            {
              x: 1,
              y: 1,
              tile: {
                tileset: {
                  kind: "external",
                  assetId: (
                    summary.tilesets as Array<{
                      assetId: string;
                    }>
                  )[0]!.assetId,
                },
                localId: 0,
              },
            },
          ],
        },
      ],
    );
    await harness.service.applyEdits(plan);
    const edited =
      await harness.service.getSummary(MAP_PATH);
    expect(edited).toMatchObject({
      orientation: "isometric",
      renderOrder: "left-up",
    });
    const editedRegion =
      (await harness.service.getRegion({
        mapPath: MAP_PATH,
        layerId: 1,
        x: 1,
        y: 1,
        width: 1,
        height: 1,
      })) as {
        rows: Array<
          Array<{ localId: number } | null>
        >;
      };
    expect(editedRegion.rows[0]![0]).toMatchObject(
      { localId: 0 },
    );
  });

  it("reads staggered and hexagonal maps but keeps edits rejected", async () => {
    for (const orientation of [
      "staggered",
      "hexagonal",
    ] as const) {
      const harness = await createHarness(
        roots,
        orientation,
      );
      const summary =
        (await harness.service.getSummary(
          MAP_PATH,
        )) as Record<string, unknown>;
      expect(summary).toMatchObject({
        orientation,
        staggerAxis: "y",
        staggerIndex: "odd",
        editableProfile:
          "staggered-hexagonal-tmj-read-only",
      });
      if (orientation === "hexagonal") {
        expect(summary.hexSideLength).toBe(8);
      }
      const region =
        (await harness.service.getRegion({
          mapPath: MAP_PATH,
          layerId: 1,
          x: 0,
          y: 0,
          width: 2,
          height: 1,
        })) as {
          rows: Array<
            Array<{ localId: number } | null>
          >;
        };
      expect(region.rows[0]![0]).toMatchObject({
        localId: 0,
      });
      await expect(
        harness.service.planEdits(
          MAP_PATH,
          summary.revision as string,
          summary.dependencyRevisions as Record<
            string,
            string
          >,
          [
            {
              type: "updateMap",
              patch: { renderOrder: "left-up" },
            },
          ],
        ),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_MAP_PROFILE",
      });
    }
  });
});

async function createHarness(
  roots: Set<string>,
  orientation: string,
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-iso-read-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeFile(
    join(root, "tiles/terrain.png"),
    Buffer.from("placeholder image bytes", "utf8"),
  );
  await writeFile(
    join(root, "tiles/terrain.tsj"),
    serializeJsonDocument({
      columns: 2,
      image: "terrain.png",
      imageheight: 16,
      imagewidth: 32,
      margin: 0,
      name: "Terrain",
      spacing: 0,
      tilecount: 2,
      tiledversion: "1.12.2",
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.10",
    }),
  );
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument({
      compressionlevel: -1,
      height: 2,
      infinite: false,
      layers: [
        {
          data: [1, 2, 2, 0],
          height: 2,
          id: 1,
          name: "ground",
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
      orientation,
      ...(orientation === "staggered" ||
      orientation === "hexagonal"
        ? {
            staggeraxis: "y",
            staggerindex: "odd",
          }
        : {}),
      ...(orientation === "hexagonal"
        ? { hexsidelength: 8 }
        : {}),
      renderorder: "right-down",
      tiledversion: "1.12.2",
      tileheight: 8,
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
    }),
  );

  const { service } =
    await wireProject(root);
  return {
    root,
    service: service,
  };
}
