import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeJsonDocument } from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const WORLD_PATH = "overworld.world";

describe("world member reading", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("lists explicit members with existence, pins, and declared sizes", async () => {
    const service = await createService(roots, {
      maps: [
        {
          fileName: "maps/a.tmj",
          x: 0,
          y: 0,
          width: 32,
          height: 32,
        },
        {
          fileName: "maps/missing.tmj",
          x: 32,
          y: -16,
        },
      ],
      onlyShowAdjacentMaps: true,
      properties: [
        {
          name: "biome",
          type: "string",
          value: "forest",
        },
      ],
      type: "world",
    });
    const result = await service.listWorldMaps({
      worldPath: WORLD_PATH,
    });
    expect(result).toMatchObject({
      path: WORLD_PATH,
      revision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
      onlyShowAdjacentMaps: true,
      memberCount: 2,
      patternCount: 0,
      patternsUnexpanded: false,
      members: [
        {
          source: "maps/a.tmj",
          exists: true,
          path: "maps/a.tmj",
          revision: expect.stringMatching(
            /^sha256:[0-9a-f]{64}$/u,
          ),
          x: 0,
          y: 0,
          declaredSize: {
            width: 32,
            height: 32,
          },
        },
        {
          source: "maps/missing.tmj",
          exists: false,
          x: 32,
          y: -16,
          declaredSize: null,
        },
      ],
      properties: [
        {
          name: "biome",
          type: "string",
          value: "forest",
        },
      ],
      propertyCount: 1,
      snapshotConsistency:
        "non-atomic-read-set",
    });
  });

  it("counts patterns without matching them and fails closed on bad input", async () => {
    const service = await createService(roots, {
      maps: [],
      patterns: [
        {
          regexp: "level-(\\d+)-(\\d+)\\.tmj",
          multiplierX: 32,
          multiplierY: 32,
        },
      ],
      type: "world",
    });
    const result = await service.listWorldMaps({
      worldPath: WORLD_PATH,
    });
    expect(result).toMatchObject({
      memberCount: 0,
      patternCount: 1,
      patternsUnexpanded: true,
    });

    await expect(
      service.listWorldMaps({
        worldPath: "maps/a.tmj",
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });
});

async function createService(
  roots: Set<string>,
  world: Record<string, unknown>,
): Promise<MapService> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-world-read-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await writeFile(
    join(root, WORLD_PATH),
    serializeJsonDocument(world as never),
  );
  await writeFile(
    join(root, "maps/a.tmj"),
    serializeJsonDocument({
      compressionlevel: -1,
      height: 1,
      infinite: false,
      layers: [],
      nextlayerid: 1,
      nextobjectid: 1,
      orientation: "orthogonal",
      renderorder: "right-down",
      tiledversion: "1.12.2",
      tileheight: 16,
      tilesets: [],
      tilewidth: 16,
      type: "map",
      version: "1.10",
      width: 1,
    }),
  );

  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  return new MapService(resolver, store);
}
