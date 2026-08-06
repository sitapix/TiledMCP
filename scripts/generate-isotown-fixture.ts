/**
 * Regenerates `fixtures/isotown/`, the fixture behind `evals/iso-town.xml`.
 *
 * `fixtures/floorplan/` is deliberately the simple case: one orthogonal map,
 * one flat tile layer, no nesting. This one exists to give the evaluation
 * suite something with the features that actually make Tiled maps awkward to
 * read -- an isometric orientation, a group layer wrapping two tile layers, a
 * GID carrying flip flags, an animated tile, and an object layer holding one
 * of every shape.
 *
 * Committed rather than built at test time, for the same reason the floor plan
 * is: a fixture you can open in Tiled and look at is a better description of
 * the shape under test than a builder function. This script keeps those bytes
 * reproducible.
 *
 * Run with: pnpm tsx scripts/generate-isotown-fixture.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

interface TileKind {
  id: number;
  name: string;
  className: string;
  walkable: boolean;
  rgb: readonly [number, number, number];
}

/**
 * Six tiles. `walkable` is a boolean custom property rather than a class so a
 * question can require reading properties and classes as separate things.
 */
const TILES: readonly TileKind[] = [
  {
    id: 0,
    name: "grass",
    className: "Ground",
    walkable: true,
    rgb: [106, 152, 79],
  },
  {
    id: 1,
    name: "water",
    className: "Water",
    walkable: false,
    rgb: [58, 104, 168],
  },
  {
    id: 2,
    name: "road",
    className: "Ground",
    walkable: true,
    rgb: [176, 160, 128],
  },
  {
    id: 3,
    name: "roof",
    className: "Building",
    walkable: false,
    rgb: [158, 74, 62],
  },
  {
    id: 4,
    name: "wall",
    className: "Building",
    walkable: false,
    rgb: [132, 118, 102],
  },
  {
    id: 5,
    name: "tree",
    className: "Prop",
    walkable: false,
    rgb: [62, 96, 58],
  },
];

const TILE_WIDTH = 64;
const TILE_HEIGHT = 32;
const MAP_WIDTH = 8;
const MAP_HEIGHT = 6;
const FIRST_GID = 1;

/** Tiled's GID flag for a diagonal flip (the anti-diagonal transpose). */
const FLIPPED_DIAGONALLY = 0x20000000;

/**
 * The two tile layers, one character per cell.
 *
 * `D` is a tree carrying the diagonal flip flag. Exactly one cell uses it, so
 * a question can ask for that cell and have a single stable answer.
 */
const GROUND_ROWS = [
  "ggggrggg",
  "ggwwrggg",
  "ggwwrggg",
  "ggggrggg",
  "ggggrggg",
  "gggggggg",
] as const;

const OVERLAY_ROWS = [
  "........",
  ".RR.....",
  ".WW.....",
  "........",
  "....T..D",
  "........",
] as const;

const BY_CHARACTER: Record<string, number | null> = {
  ".": null,
  g: 0,
  w: 1,
  r: 2,
  R: 3,
  W: 4,
  T: 5,
  D: 5,
};

const OUTPUT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "isotown",
);

function gidFor(character: string): number {
  const localId = BY_CHARACTER[character];
  if (localId === undefined) {
    throw new Error(
      `Unknown fixture character ${character}.`,
    );
  }
  if (localId === null) {
    return 0;
  }
  const gid = FIRST_GID + localId;
  return character === "D"
    ? gid | FLIPPED_DIAGONALLY
    : gid;
}

function dataFor(
  rows: readonly string[],
): number[] {
  const data: number[] = [];
  for (const row of rows) {
    if (row.length !== MAP_WIDTH) {
      throw new Error(
        `Row "${row}" is not ${MAP_WIDTH} cells wide.`,
      );
    }
    for (const character of row) {
      data.push(gidFor(character));
    }
  }
  return data;
}

/** A single-row atlas: one flat cell per tile, with a darker top-left edge. */
async function writeAtlas(): Promise<void> {
  const width = TILE_WIDTH * TILES.length;
  const pixels = Buffer.alloc(
    width * TILE_HEIGHT * 4,
  );
  for (let y = 0; y < TILE_HEIGHT; y++) {
    for (let x = 0; x < width; x++) {
      const tile = TILES[Math.floor(x / TILE_WIDTH)];
      if (tile === undefined) {
        continue;
      }
      const onEdge = x % TILE_WIDTH === 0 || y === 0;
      const shade = onEdge ? 0.75 : 1;
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.round(
        tile.rgb[0] * shade,
      );
      pixels[offset + 1] = Math.round(
        tile.rgb[1] * shade,
      );
      pixels[offset + 2] = Math.round(
        tile.rgb[2] * shade,
      );
      pixels[offset + 3] = 255;
    }
  }
  await sharp(pixels, {
    raw: {
      width,
      height: TILE_HEIGHT,
      channels: 4,
    },
  })
    .png()
    .toFile(join(OUTPUT_DIR, "tiles.png"));
}

async function writeTileset(): Promise<void> {
  const tileset = {
    columns: TILES.length,
    image: "tiles.png",
    imageheight: TILE_HEIGHT,
    imagewidth: TILE_WIDTH * TILES.length,
    margin: 0,
    name: "town",
    spacing: 0,
    tilecount: TILES.length,
    tiledversion: "1.12.2",
    tileheight: TILE_HEIGHT,
    tilewidth: TILE_WIDTH,
    type: "tileset",
    version: "1.10",
    tiles: TILES.map((tile) => ({
      id: tile.id,
      type: tile.className,
      properties: [
        {
          name: "walkable",
          type: "bool",
          value: tile.walkable,
        },
      ],
      // Exactly one animated tile, so "which tile is animated" has one answer.
      ...(tile.name === "tree"
        ? {
            animation: [
              { duration: 400, tileid: 5 },
              { duration: 400, tileid: 0 },
            ],
          }
        : {}),
    })),
  };
  await writeFile(
    join(OUTPUT_DIR, "town.tsj"),
    `${JSON.stringify(tileset, null, 2)}\n`,
    "utf8",
  );
}

/** One object of each shape Tiled distinguishes, each with a distinct class. */
function markerObjects(): unknown[] {
  return [
    {
      id: 1,
      name: "plaza",
      type: "Zone",
      x: 128,
      y: 64,
      width: 96,
      height: 48,
      rotation: 0,
      visible: true,
    },
    {
      id: 2,
      name: "pond",
      type: "Zone",
      x: 64,
      y: 96,
      width: 64,
      height: 32,
      rotation: 0,
      visible: true,
      ellipse: true,
    },
    {
      id: 3,
      name: "start",
      type: "Spawn",
      x: 32,
      y: 32,
      width: 0,
      height: 0,
      rotation: 0,
      visible: true,
      point: true,
    },
    {
      id: 4,
      name: "guard_loop",
      type: "Patrol",
      x: 160,
      y: 128,
      width: 0,
      height: 0,
      rotation: 0,
      visible: true,
      polygon: [
        { x: 0, y: 0 },
        { x: 64, y: 0 },
        { x: 64, y: 32 },
      ],
    },
    {
      id: 5,
      name: "cart_path",
      type: "Route",
      x: 96,
      y: 160,
      width: 0,
      height: 0,
      rotation: 0,
      visible: true,
      polyline: [
        { x: 0, y: 0 },
        { x: 48, y: 16 },
        { x: 96, y: 0 },
      ],
    },
    {
      id: 6,
      name: "signpost",
      type: "Label",
      x: 200,
      y: 40,
      width: 120,
      height: 24,
      rotation: 0,
      visible: true,
      text: {
        text: "Market Square",
        wrap: true,
      },
    },
  ];
}

async function writeMap(): Promise<void> {
  const map = {
    compressionlevel: -1,
    height: MAP_HEIGHT,
    infinite: false,
    nextlayerid: 5,
    nextobjectid: 7,
    orientation: "isometric",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: TILE_HEIGHT,
    tilewidth: TILE_WIDTH,
    type: "map",
    version: "1.10",
    width: MAP_WIDTH,
    tilesets: [
      { firstgid: FIRST_GID, source: "town.tsj" },
    ],
    layers: [
      {
        id: 1,
        name: "Terrain",
        type: "group",
        opacity: 1,
        visible: true,
        x: 0,
        y: 0,
        layers: [
          {
            id: 2,
            name: "Ground",
            type: "tilelayer",
            width: MAP_WIDTH,
            height: MAP_HEIGHT,
            opacity: 1,
            visible: true,
            x: 0,
            y: 0,
            data: dataFor(GROUND_ROWS),
          },
          {
            id: 3,
            name: "Overlay",
            type: "tilelayer",
            width: MAP_WIDTH,
            height: MAP_HEIGHT,
            opacity: 1,
            visible: true,
            x: 0,
            y: 0,
            data: dataFor(OVERLAY_ROWS),
          },
        ],
      },
      {
        id: 4,
        name: "Markers",
        type: "objectgroup",
        draworder: "topdown",
        opacity: 1,
        visible: true,
        x: 0,
        y: 0,
        objects: markerObjects(),
      },
    ],
  };
  await writeFile(
    join(OUTPUT_DIR, "town.tmj"),
    `${JSON.stringify(map, null, 2)}\n`,
    "utf8",
  );
}

await mkdir(OUTPUT_DIR, { recursive: true });
await writeAtlas();
await writeTileset();
await writeMap();
process.stdout.write(
  `wrote ${OUTPUT_DIR}\n`,
);
