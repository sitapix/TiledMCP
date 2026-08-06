/**
 * Regenerates `fixtures/floorplan/`, the worked example behind the
 * `build_from_floor_plan` prompt and `tests/floorPlanWorkflow.test.ts`.
 *
 * The fixture is committed rather than built at test time so that the plan
 * image can be opened and looked at -- the whole workflow is about turning a
 * picture into a map, and a fixture nobody can see is a poor way to describe
 * it. This script exists so those committed bytes stay reproducible.
 *
 * Run with: pnpm tsx scripts/generate-floorplan-fixture.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

interface Role {
  id: number;
  name: string;
  className: string;
  rgb: readonly [number, number, number];
}

/**
 * Eight roles, each a flat and well-separated colour.
 *
 * Separation is the point: `tiled_preview_import_image` resolves every cell to
 * the *nearest* palette colour by squared RGB distance, so a fixture whose
 * colours sit close together would make a correct import look like a bug.
 */
const ROLES: readonly Role[] = [
  {
    id: 0,
    name: "floor.wood",
    className: "Floor",
    rgb: [207, 196, 168],
  },
  {
    id: 1,
    name: "floor.stone",
    className: "Floor",
    rgb: [143, 143, 150],
  },
  {
    id: 2,
    name: "wall.brick",
    className: "Wall",
    rgb: [107, 74, 47],
  },
  {
    id: 3,
    name: "wall.window",
    className: "Wall",
    rgb: [111, 168, 200],
  },
  {
    id: 4,
    name: "door.closed",
    className: "Door",
    rgb: [63, 107, 163],
  },
  {
    id: 5,
    name: "floor.rug",
    className: "Floor",
    rgb: [184, 67, 58],
  },
  {
    id: 6,
    name: "prop.barrel",
    className: "Prop",
    rgb: [47, 107, 74],
  },
  {
    id: 7,
    name: "prop.table",
    className: "Prop",
    rgb: [163, 63, 91],
  },
];

const TILE = 16;
const MAP_WIDTH = 16;
const MAP_HEIGHT = 12;

const OUTPUT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "floorplan",
);

function roleByName(name: string): Role {
  const role = ROLES.find(
    (candidate) => candidate.name === name,
  );
  if (role === undefined) {
    throw new Error(`Unknown role ${name}.`);
  }
  return role;
}

/** A single-row atlas: one flat cell per role, with a darker top-left edge. */
async function writeAtlas(): Promise<void> {
  const width = TILE * ROLES.length;
  const pixels = Buffer.alloc(width * TILE * 4);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < width; x++) {
      const role = ROLES[Math.floor(x / TILE)];
      if (role === undefined) {
        continue;
      }
      const onEdge = x % TILE === 0 || y === 0;
      const shade = onEdge ? 0.75 : 1;
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.round(
        role.rgb[0] * shade,
      );
      pixels[offset + 1] = Math.round(
        role.rgb[1] * shade,
      );
      pixels[offset + 2] = Math.round(
        role.rgb[2] * shade,
      );
      pixels[offset + 3] = 255;
    }
  }
  await sharp(pixels, {
    raw: { width, height: TILE, channels: 4 },
  })
    .png()
    .toFile(join(OUTPUT_DIR, "tiles.png"));
}

async function writeTileset(): Promise<void> {
  const tileset = {
    columns: ROLES.length,
    image: "tiles.png",
    imageheight: TILE,
    imagewidth: TILE * ROLES.length,
    margin: 0,
    name: "interior",
    spacing: 0,
    tilecount: ROLES.length,
    tiledversion: "1.12.2",
    tileheight: TILE,
    tilewidth: TILE,
    type: "tileset",
    version: "1.10",
    tiles: ROLES.map((role) => ({
      id: role.id,
      type: role.className,
      properties: [
        {
          name: "role",
          type: "string",
          value: role.name,
        },
      ],
    })),
    wangsets: [
      {
        name: "Walls",
        tile: -1,
        type: "corner",
        colors: [
          {
            color: "#6b4a2f",
            name: "Wall",
            probability: 1,
            tile: 2,
          },
          {
            color: "#cfc4a8",
            name: "Floor",
            probability: 1,
            tile: 0,
          },
        ],
        wangtiles: [
          {
            tileid: 2,
            wangid: [0, 1, 0, 1, 0, 1, 0, 1],
          },
          {
            tileid: 0,
            wangid: [0, 2, 0, 2, 0, 2, 0, 2],
          },
        ],
      },
    ],
  };
  await writeFile(
    join(OUTPUT_DIR, "interior.tsj"),
    `${JSON.stringify(tileset, null, 2)}\n`,
  );
}

/**
 * The plan image: exactly one pixel per map cell.
 *
 * One-to-one keeps the fixture's expected output derivable by hand. The tool
 * itself resamples arbitrary image sizes onto the grid by averaging each
 * cell's alpha-weighted pixel block; that path has its own coverage in
 * `tests/imageImport.test.ts`.
 */
async function writePlan(): Promise<void> {
  const pixels = Buffer.alloc(
    MAP_WIDTH * MAP_HEIGHT * 4,
  );
  const put = (
    x: number,
    y: number,
    name: string,
  ): void => {
    const role = roleByName(name);
    const offset = (y * MAP_WIDTH + x) * 4;
    pixels[offset] = role.rgb[0];
    pixels[offset + 1] = role.rgb[1];
    pixels[offset + 2] = role.rgb[2];
    pixels[offset + 3] = 255;
  };

  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      const onBorder =
        x === 0 ||
        y === 0 ||
        x === MAP_WIDTH - 1 ||
        y === MAP_HEIGHT - 1;
      put(
        x,
        y,
        onBorder ? "wall.brick" : "floor.wood",
      );
    }
  }
  for (const x of [4, 5, 10, 11]) {
    put(x, 0, "wall.window");
  }
  for (const x of [7, 8]) {
    put(x, MAP_HEIGHT - 1, "door.closed");
    put(x, MAP_HEIGHT - 2, "floor.stone");
    put(x, 7, "prop.table");
  }
  for (let y = 4; y <= 6; y++) {
    for (let x = 6; x <= 9; x++) {
      put(x, y, "floor.rug");
    }
  }
  put(2, 2, "prop.barrel");
  put(13, 2, "prop.barrel");

  await sharp(pixels, {
    raw: {
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      channels: 4,
    },
  })
    .png()
    .toFile(join(OUTPUT_DIR, "plan.png"));
}

/** An empty room to build into: one tile layer, one object layer. */
async function writeMap(): Promise<void> {
  const map = {
    compressionlevel: -1,
    height: MAP_HEIGHT,
    infinite: false,
    layers: [
      {
        data: new Array(
          MAP_WIDTH * MAP_HEIGHT,
        ).fill(0),
        height: MAP_HEIGHT,
        id: 1,
        name: "Floor",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: MAP_WIDTH,
        x: 0,
        y: 0,
      },
      {
        draworder: "topdown",
        id: 2,
        name: "Objects",
        objects: [],
        opacity: 1,
        type: "objectgroup",
        visible: true,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 3,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: TILE,
    tilesets: [
      { firstgid: 1, source: "interior.tsj" },
    ],
    tilewidth: TILE,
    type: "map",
    version: "1.10",
    width: MAP_WIDTH,
  };
  await writeFile(
    join(OUTPUT_DIR, "tavern.tmj"),
    `${JSON.stringify(map, null, 2)}\n`,
  );
}

await mkdir(OUTPUT_DIR, { recursive: true });
await writeAtlas();
await writeTileset();
await writePlan();
await writeMap();
process.stdout.write(
  `wrote ${OUTPUT_DIR}\n`,
);
