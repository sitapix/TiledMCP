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
import { ChangeSetRegistry } from "../src/changeSets.js";
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

  it("expands patterns with World::allMaps semantics on request", async () => {
    const service = await createService(roots, {
      maps: [
        {
          fileName: "maps/a.tmj",
          x: 0,
          y: 0,
          width: 32,
          height: 32,
        },
      ],
      patterns: [
        {
          regexp: "a-(\\d+)-(\\d+)\\.tmj",
          multiplierX: 32,
          multiplierY: 32,
          offsetX: 100,
        },
      ],
      type: "world",
    });
    // Sibling files matching the pattern (and one that does not).
    const root = [...roots][roots.size - 0 - 1]!;
    await writeFile(
      join(root, "a-2-3.tmj"),
      await readFileText(root, "maps/a.tmj"),
    );
    await writeFile(
      join(root, "unrelated.tmj"),
      await readFileText(root, "maps/a.tmj"),
    );

    const unexpanded = await service.listWorldMaps(
      { worldPath: WORLD_PATH },
    );
    expect(unexpanded).toMatchObject({
      memberCount: 1,
      patternCount: 1,
      patternsUnexpanded: true,
    });

    const expanded = await service.listWorldMaps({
      worldPath: WORLD_PATH,
      expandPatterns: true,
    });
    expect(expanded).toMatchObject({
      memberCount: 2,
      patternsUnexpanded: false,
    });
    expect(
      (expanded.members as Array<
        Record<string, unknown>
      >)[1],
    ).toMatchObject({
      source: "a-2-3.tmj",
      fromPattern: true,
      patternIndex: 0,
      x: 2 * 32 + 100,
      y: 3 * 32,
      declaredSize: { width: 32, height: 32 },
      exists: true,
    });
  });

  it("adds, moves, and removes members through preview and apply", async () => {
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
          fileName: "maps/a.tmj",
          x: 64,
          y: 0,
          width: 32,
          height: 32,
        },
      ],
      onlyShowAdjacentMaps: false,
      type: "world",
    });
    const before = await service.listWorldMaps({
      worldPath: WORLD_PATH,
    });
    const plan = await service.planWorldEdits({
      worldPath: WORLD_PATH,
      expectedRevision:
        before.revision as string,
      operations: [
        { type: "moveMap", index: 0, x: -32, y: 16 },
        { type: "removeMap", index: 1 },
        {
          type: "addMap",
          fileName: "maps/a.tmj",
          x: 96,
          y: 96,
        },
      ],
    });
    expect(plan.summary).toMatchObject({
      memberCountBefore: 2,
      memberCountAfter: 2,
      moved: [
        {
          index: 0,
          from: { x: 0, y: 0 },
          to: { x: -32, y: 16 },
        },
      ],
      removed: [{ index: 1 }],
      added: [{ fileName: "maps/a.tmj" }],
      wouldChange: true,
    });
    const preview = new ChangeSetRegistry().put(
      plan,
    );
    expect(preview.operations).toHaveLength(3);
    expect(preview.operations[1]).toMatchObject({
      type: "removeWorldMap",
      destructive: true,
    });

    await service.applyWorldEdits(plan);
    const after = await service.listWorldMaps({
      worldPath: WORLD_PATH,
    });
    expect(after.members).toEqual([
      expect.objectContaining({
        x: -32,
        y: 16,
        declaredSize: {
          width: 32,
          height: 32,
        },
      }),
      expect.objectContaining({
        x: 96,
        y: 96,
        declaredSize: null,
      }),
    ]);

    // Stale plans and missing member maps fail closed.
    await expect(
      service.applyWorldEdits(plan),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    await expect(
      service.planWorldEdits({
        worldPath: WORLD_PATH,
        expectedRevision:
          after.revision as string,
        operations: [
          {
            type: "addMap",
            fileName: "maps/missing.tmj",
            x: 0,
            y: 0,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
  });
});

async function readFileText(
  root: string,
  relative: string,
): Promise<string> {
  const { readFile } = await import(
    "node:fs/promises"
  );
  return (
    await readFile(join(root, relative))
  ).toString("utf8");
}

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
