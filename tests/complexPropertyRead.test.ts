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

const MAP_PATH = "maps/level.tmj";

describe("complex custom-property reading", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("projects nested class and list values verbatim within budgets", async () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let level = 0; level < 12; level += 1) {
      const next: Record<string, unknown> = {};
      cursor.child = next;
      cursor = next;
    }
    const service = await createService(roots, [
      {
        name: "loot",
        type: "class",
        propertytype: "LootTable",
        value: {
          gold: 25,
          nested: { rare: true, name: "gem" },
        },
      },
      {
        name: "defaulted",
        type: "class",
        propertytype: "LootTable",
      },
      {
        name: "tags",
        type: "list",
        value: [
          { type: "string", value: "spooky" },
          {
            type: "class",
            propertytype: "LootTable",
            value: { gold: 1 },
          },
        ],
      },
      {
        name: "bottomless",
        type: "class",
        propertytype: "Deep",
        value: deep,
      },
    ]);

    const detail = await service.getObject({
      mapPath: MAP_PATH,
      objectId: 1,
    });
    expect(detail.object).toMatchObject({
      properties: [
        {
          name: "loot",
          type: "class",
          propertytype: "LootTable",
          value: {
            gold: 25,
            nested: { rare: true, name: "gem" },
          },
          valueSemantics: "raw-untyped-members",
        },
        {
          name: "defaulted",
          type: "class",
          propertytype: "LootTable",
          value: {},
          valueSemantics: "raw-untyped-members",
        },
        {
          name: "tags",
          type: "list",
          value: [
            { type: "string", value: "spooky" },
            {
              type: "class",
              propertytype: "LootTable",
              value: { gold: 1 },
            },
          ],
          valueSemantics: "typed-elements",
        },
        {
          name: "bottomless",
          type: "class",
          propertytype: "Deep",
          valueOmitted: true,
          reason: "oversized-value",
        },
      ],
      propertyCount: 4,
    });
  });

  it("fails closed on values inconsistent with their declared complex type", async () => {
    const service = await createService(roots, [
      {
        name: "broken",
        type: "class",
        value: [1, 2, 3],
      },
    ]);
    await expect(
      service.getObject({
        mapPath: MAP_PATH,
        objectId: 1,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
  });
});

async function createService(
  roots: Set<string>,
  properties: Record<string, unknown>[],
): Promise<MapService> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-complex-props-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument({
      compressionlevel: -1,
      height: 2,
      infinite: false,
      layers: [
        {
          draworder: "topdown",
          id: 1,
          name: "Objects",
          objects: [
            {
              height: 4,
              id: 1,
              name: "Chest",
              properties,
              rotation: 0,
              type: "",
              visible: true,
              width: 4,
              x: 1,
              y: 1,
            },
          ],
          opacity: 1,
          type: "objectgroup",
          visible: true,
        },
      ],
      nextlayerid: 2,
      nextobjectid: 2,
      orientation: "orthogonal",
      renderorder: "right-down",
      tiledversion: "1.12.2",
      tileheight: 16,
      tilesets: [],
      tilewidth: 16,
      type: "map",
      version: "1.10",
      width: 2,
    } as never),
  );

  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  return new MapService(resolver, store);
}
