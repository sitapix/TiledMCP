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

  it("overwrites existing nested class members and fails closed on new ones", async () => {
    const service = await createService(roots, [
      {
        name: "loot",
        type: "class",
        propertytype: "LootTable",
        value: {
          gold: 25,
          nested: { rare: true },
        },
      },
    ]);
    const summary = (await service.getSummary(
      MAP_PATH,
    )) as { revision: string };
    const plan = await service.planEdits(
      MAP_PATH,
      summary.revision,
      {},
      [
        {
          type: "updateObject",
          objectId: 1,
          patch: {
            properties: {
              setClassMembers: [
                {
                  property: "loot",
                  path: ["gold"],
                  value: 40,
                },
                {
                  property: "loot",
                  path: ["nested", "rare"],
                  value: false,
                },
              ],
            },
          },
        },
      ] as never,
    );
    await service.applyEdits(plan);
    const detail = await service.getObject({
      mapPath: MAP_PATH,
      objectId: 1,
    });
    expect(detail.object).toMatchObject({
      properties: [
        {
          name: "loot",
          type: "class",
          value: {
            gold: 40,
            nested: { rare: false },
          },
        },
      ],
    });

    const fresh = (await service.getSummary(
      MAP_PATH,
    )) as { revision: string };
    await expect(
      service.planEdits(
        MAP_PATH,
        fresh.revision,
        {},
        [
          {
            type: "updateObject",
            objectId: 1,
            patch: {
              properties: {
                setClassMembers: [
                  {
                    property: "loot",
                    path: ["silver"],
                    value: 1,
                  },
                ],
              },
            },
          },
        ] as never,
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_PROPERTY_WRITE",
    });
    await expect(
      service.planEdits(
        MAP_PATH,
        fresh.revision,
        {},
        [
          {
            type: "updateObject",
            objectId: 1,
            patch: {
              properties: {
                setClassMembers: [
                  {
                    property: "loot",
                    path: ["gold"],
                    value: "rich",
                  },
                ],
              },
            },
          },
        ] as never,
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_PROPERTY_WRITE",
    });
  });

  it("overwrites typed list elements in place and fails closed on misuse", async () => {
    const service = await createService(roots, [
      {
        name: "waypoints",
        type: "list",
        value: [
          { type: "string", value: "spawn" },
          { type: "int", value: 3 },
          {
            type: "string",
            propertytype: "Biome",
            value: "forest",
          },
          {
            type: "list",
            value: [
              { type: "int", value: 1 },
            ],
          },
        ],
      },
    ]);
    const summary = (await service.getSummary(
      MAP_PATH,
    )) as { revision: string };
    const plan = await service.planEdits(
      MAP_PATH,
      summary.revision,
      {},
      [
        {
          type: "updateObject",
          objectId: 1,
          patch: {
            properties: {
              setListElements: [
                {
                  property: "waypoints",
                  index: 0,
                  value: "castle",
                },
                {
                  property: "waypoints",
                  index: 1,
                  value: 7,
                },
              ],
            },
          },
        },
      ] as never,
    );
    await service.applyEdits(plan);
    const detail = await service.getObject({
      mapPath: MAP_PATH,
      objectId: 1,
    });
    expect(detail.object).toMatchObject({
      properties: [
        {
          name: "waypoints",
          type: "list",
          valueSemantics: "typed-elements",
          value: [
            { type: "string", value: "castle" },
            { type: "int", value: 7 },
            {
              type: "string",
              propertytype: "Biome",
              value: "forest",
            },
            {
              type: "list",
              value: [
                { type: "int", value: 1 },
              ],
            },
          ],
        },
      ],
    });

    const fresh = (await service.getSummary(
      MAP_PATH,
    )) as { revision: string };
    const attempt = (
      writes: Array<{
        property: string;
        index: number;
        value: string | number | boolean;
      }>,
    ) =>
      service.planEdits(MAP_PATH, fresh.revision, {}, [
        {
          type: "updateObject",
          objectId: 1,
          patch: {
            properties: {
              setListElements: writes,
            },
          },
        },
      ] as never);

    // Out of bounds: appending needs the element's Tiled type annotation.
    await expect(
      attempt([
        {
          property: "waypoints",
          index: 9,
          value: "x",
        },
      ]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_PROPERTY_WRITE",
    });
    // Enum-wrapped and nested elements stay untouchable.
    await expect(
      attempt([
        {
          property: "waypoints",
          index: 2,
          value: "desert",
        },
      ]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_PROPERTY_WRITE",
    });
    await expect(
      attempt([
        {
          property: "waypoints",
          index: 3,
          value: "x",
        },
      ]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_PROPERTY_WRITE",
    });
    // JSON type and the element's Tiled type must both hold.
    await expect(
      attempt([
        {
          property: "waypoints",
          index: 1,
          value: "seven",
        },
      ]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_PROPERTY_WRITE",
    });
    await expect(
      attempt([
        {
          property: "waypoints",
          index: 1,
          value: 7.5,
        },
      ]),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_PROPERTY_WRITE",
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

  const { service } =
    await wireProject(root);
  return service;
}
