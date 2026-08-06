import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  assertUsableProjection,
  convertCoordinates,
  type Projection,
  type ProjectionOrientation,
} from "../src/maps/coordinates.js";
import type { JsonObject } from "../src/formats/json.js";
import {
  createProject,
  disposeProject,
  type TestProject,
} from "./support/project.js";

function projection(
  overrides: Partial<Projection> & {
    orientation: ProjectionOrientation;
  },
): Projection {
  return {
    tileWidth: 64,
    tileHeight: 32,
    mapHeight: 10,
    staggerAxis: "y",
    staggerIndex: "odd",
    hexSideLength: 0,
    ...overrides,
  };
}

function convertOne(
  target: Projection,
  from: "tile" | "screen" | "pixel",
  to: "tile" | "screen" | "pixel",
  x: number,
  y: number,
): { x: number; y: number } {
  const [result] = convertCoordinates(target, [
    { from, to, point: { x, y } },
  ]);
  if (result === undefined) {
    throw new Error("no conversion returned");
  }
  return result.output;
}

/**
 * The hexagonal inverse snaps to the nearest of four candidate centers, so a
 * cell's own center is the one probe point guaranteed to resolve back to it.
 * Deriving the center the same way RenderParams does keeps the probe honest
 * for odd tile sizes, where the derived tile size differs from the declared
 * one.
 */
function hexCellCenter(
  target: Projection,
  cellX: number,
  cellY: number,
): { x: number; y: number } {
  const staggerX = target.staggerAxis === "x";
  const hexagonal =
    target.orientation === "hexagonal";
  const sideLengthX =
    hexagonal && staggerX
      ? target.hexSideLength
      : 0;
  const sideLengthY =
    hexagonal && !staggerX
      ? target.hexSideLength
      : 0;
  const sideOffsetX = Math.trunc(
    (target.tileWidth - sideLengthX) / 2,
  );
  const sideOffsetY = Math.trunc(
    (target.tileHeight - sideLengthY) / 2,
  );
  const derivedWidth =
    sideOffsetX + sideLengthX + sideOffsetX;
  const derivedHeight =
    sideOffsetY + sideLengthY + sideOffsetY;
  const topLeft = convertOne(
    target,
    "tile",
    "screen",
    cellX,
    cellY,
  );
  return {
    x: topLeft.x + derivedWidth / 2,
    y: topLeft.y + derivedHeight / 2,
  };
}

describe("coordinate conversion", () => {
  describe("orthogonal", () => {
    const target = projection({
      orientation: "orthogonal",
    });

    it("scales tile coordinates by the tile size", () => {
      expect(
        convertOne(target, "tile", "screen", 3, 4),
      ).toEqual({ x: 192, y: 128 });
    });

    it("treats pixel and screen space as identical", () => {
      expect(
        convertOne(
          target,
          "screen",
          "pixel",
          123,
          -45,
        ),
      ).toEqual({ x: 123, y: -45 });
      expect(
        convertOne(
          target,
          "pixel",
          "screen",
          123,
          -45,
        ),
      ).toEqual({ x: 123, y: -45 });
    });

    it("returns fractional tile coordinates plus the containing cell", () => {
      const [result] = convertCoordinates(target, [
        {
          from: "screen",
          to: "tile",
          point: { x: 200, y: 140 },
        },
      ]);
      expect(result?.output).toEqual({
        x: 200 / 64,
        y: 140 / 32,
      });
      expect(result?.cell).toEqual({ x: 3, y: 4 });
    });

    it("floors the containing cell toward negative infinity", () => {
      const [result] = convertCoordinates(target, [
        {
          from: "screen",
          to: "tile",
          point: { x: -1, y: -1 },
        },
      ]);
      expect(result?.cell).toEqual({
        x: -1,
        y: -1,
      });
    });
  });

  describe("isometric", () => {
    const target = projection({
      orientation: "isometric",
    });

    it("places the origin half a map width to the right", () => {
      // originX = mapHeight * tileWidth / 2 = 10 * 64 / 2
      expect(
        convertOne(target, "tile", "screen", 0, 0),
      ).toEqual({ x: 320, y: 0 });
    });

    it("moves one tile step diagonally on screen", () => {
      expect(
        convertOne(target, "tile", "screen", 1, 0),
      ).toEqual({ x: 352, y: 16 });
      expect(
        convertOne(target, "tile", "screen", 0, 1),
      ).toEqual({ x: 288, y: 16 });
    });

    it("round-trips tile -> screen -> tile", () => {
      for (let x = -4; x <= 8; x += 1) {
        for (let y = -4; y <= 8; y += 1) {
          const screen = convertOne(
            target,
            "tile",
            "screen",
            x,
            y,
          );
          const back = convertOne(
            target,
            "screen",
            "tile",
            screen.x,
            screen.y,
          );
          expect(back.x).toBeCloseTo(x, 10);
          expect(back.y).toBeCloseTo(y, 10);
        }
      }
    });

    it("round-trips tile -> pixel -> tile in tile-height units", () => {
      // Isometric pixel space divides both axes by tileHeight, which is why
      // object coordinates do not scale with tileWidth.
      expect(
        convertOne(target, "tile", "pixel", 2, 3),
      ).toEqual({ x: 64, y: 96 });
      expect(
        convertOne(target, "pixel", "tile", 64, 96),
      ).toEqual({ x: 2, y: 3 });
    });

    it("round-trips screen -> pixel -> screen", () => {
      for (const point of [
        { x: 320, y: 0 },
        { x: 352, y: 16 },
        { x: 100, y: 250 },
      ]) {
        const pixel = convertOne(
          target,
          "screen",
          "pixel",
          point.x,
          point.y,
        );
        const back = convertOne(
          target,
          "pixel",
          "screen",
          pixel.x,
          pixel.y,
        );
        expect(back.x).toBeCloseTo(point.x, 8);
        expect(back.y).toBeCloseTo(point.y, 8);
      }
    });

    it("keeps pixel space distinct from screen space", () => {
      expect(
        convertOne(
          target,
          "screen",
          "pixel",
          320,
          0,
        ),
      ).not.toEqual({ x: 320, y: 0 });
    });
  });

  describe("hexagonal and staggered", () => {
    const targets: ReadonlyArray<
      [string, Projection]
    > = [
      [
        "staggered y/odd",
        projection({
          orientation: "staggered",
          staggerAxis: "y",
          staggerIndex: "odd",
        }),
      ],
      [
        "staggered y/even",
        projection({
          orientation: "staggered",
          staggerAxis: "y",
          staggerIndex: "even",
        }),
      ],
      [
        "staggered x/odd",
        projection({
          orientation: "staggered",
          staggerAxis: "x",
          staggerIndex: "odd",
        }),
      ],
      [
        "staggered x/even",
        projection({
          orientation: "staggered",
          staggerAxis: "x",
          staggerIndex: "even",
        }),
      ],
      [
        "hexagonal y/odd",
        projection({
          orientation: "hexagonal",
          staggerAxis: "y",
          staggerIndex: "odd",
          tileWidth: 32,
          tileHeight: 32,
          hexSideLength: 16,
        }),
      ],
      [
        "hexagonal y/even",
        projection({
          orientation: "hexagonal",
          staggerAxis: "y",
          staggerIndex: "even",
          tileWidth: 32,
          tileHeight: 32,
          hexSideLength: 16,
        }),
      ],
      [
        "hexagonal x/odd",
        projection({
          orientation: "hexagonal",
          staggerAxis: "x",
          staggerIndex: "odd",
          tileWidth: 32,
          tileHeight: 32,
          hexSideLength: 16,
        }),
      ],
      [
        "hexagonal x/even",
        projection({
          orientation: "hexagonal",
          staggerAxis: "x",
          staggerIndex: "even",
          tileWidth: 32,
          tileHeight: 32,
          hexSideLength: 16,
        }),
      ],
    ];

    it.each(targets)(
      "round-trips every cell centre through %s",
      (_label, target) => {
        for (let x = 0; x < 8; x += 1) {
          for (let y = 0; y < 8; y += 1) {
            const centre = hexCellCenter(
              target,
              x,
              y,
            );
            const cell = convertOne(
              target,
              "screen",
              "tile",
              centre.x,
              centre.y,
            );
            expect({
              label: _label,
              x: cell.x,
              y: cell.y,
            }).toEqual({
              label: _label,
              x,
              y,
            });
          }
        }
      },
    );

    it.each(targets)(
      "reports a discrete cell equal to the tile output for %s",
      (_label, target) => {
        const [result] = convertCoordinates(
          target,
          [
            {
              from: "screen",
              to: "tile",
              point: hexCellCenter(target, 3, 5),
            },
          ],
        );
        expect(result?.cell).toEqual(
          result?.output,
        );
      },
    );

    it("treats pixel and screen space as identical", () => {
      const target = projection({
        orientation: "hexagonal",
        tileWidth: 32,
        tileHeight: 32,
        hexSideLength: 16,
      });
      expect(
        convertOne(
          target,
          "pixel",
          "screen",
          77,
          88,
        ),
      ).toEqual({ x: 77, y: 88 });
    });

    it("staggers alternating rows on the y axis", () => {
      const target = projection({
        orientation: "staggered",
        staggerAxis: "y",
        staggerIndex: "odd",
        tileWidth: 64,
        tileHeight: 32,
      });
      // Odd rows shift right by one column width (half a tile).
      expect(
        convertOne(target, "tile", "screen", 0, 0),
      ).toEqual({ x: 0, y: 0 });
      expect(
        convertOne(target, "tile", "screen", 0, 1),
      ).toEqual({ x: 32, y: 16 });
    });
  });

  describe("projection validation", () => {
    it("rejects a non-positive tile size", () => {
      expect(() =>
        assertUsableProjection(
          projection({
            orientation: "orthogonal",
            tileWidth: 0,
          }),
          "maps/a.tmj",
        ),
      ).toThrow(/positive integer tilewidth/);
    });

    it("rejects a hexagonal geometry with no column width", () => {
      expect(() =>
        assertUsableProjection(
          projection({
            orientation: "hexagonal",
            staggerAxis: "x",
            tileWidth: 1,
            tileHeight: 32,
            hexSideLength: 0,
          }),
          "maps/a.tmj",
        ),
      ).toThrow(/non-positive column width/);
    });

    it("accepts an ordinary hexagonal geometry", () => {
      expect(() =>
        assertUsableProjection(
          projection({
            orientation: "hexagonal",
            tileWidth: 32,
            tileHeight: 32,
            hexSideLength: 16,
          }),
          "maps/a.tmj",
        ),
      ).not.toThrow();
    });
  });
});

const MAP_PATH = "maps/coords.tmj";

function mapDocument(
  overrides: JsonObject = {},
): JsonObject {
  return {
    type: "map",
    version: "1.10",
    tiledversion: "1.12.2",
    orientation: "orthogonal",
    renderorder: "right-down",
    infinite: false,
    width: 8,
    height: 10,
    tilewidth: 64,
    tileheight: 32,
    nextlayerid: 2,
    nextobjectid: 1,
    layers: [],
    tilesets: [],
    ...overrides,
  };
}

describe("tiled_convert_coordinates service", () => {
  let project: TestProject | undefined;

  afterEach(async () => {
    if (project !== undefined) {
      await disposeProject(project);
      project = undefined;
    }
  });

  async function open(
    overrides: JsonObject = {},
  ): Promise<TestProject> {
    const created = await createProject({
      prefix: "tiledmcp-coordinates",
      files: {
        [MAP_PATH]: mapDocument(overrides),
      },
    });
    project = created;
    return created;
  }

  it("reports the projection and converts a batch", async () => {
    const harness = await open();
    const result =
      await harness.service.convertCoordinates({
        mapPath: MAP_PATH,
        conversions: [
          {
            from: "tile",
            to: "screen",
            point: { x: 2, y: 3 },
          },
          {
            from: "screen",
            to: "tile",
            point: { x: 200, y: 140 },
          },
        ],
      });

    expect(result).toMatchObject({
      mapPath: MAP_PATH,
      revision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
      profile:
        "tiled-1.12.2-renderer-transforms-v1",
      projection: {
        orientation: "orthogonal",
        tileWidth: 64,
        tileHeight: 32,
        mapHeight: 10,
        tileSpace: "continuous",
        pixelSpace: "same-as-screen",
      },
      snapshotConsistency:
        "non-atomic-read-set",
    });
    expect(result.conversions).toEqual([
      {
        from: "tile",
        to: "screen",
        input: { x: 2, y: 3 },
        output: { x: 128, y: 96 },
      },
      {
        from: "screen",
        to: "tile",
        input: { x: 200, y: 140 },
        output: { x: 200 / 64, y: 140 / 32 },
        cell: { x: 3, y: 4 },
      },
    ]);
  });

  it("omits stagger fields for a non-staggered map", async () => {
    const harness = await open();
    const result =
      await harness.service.convertCoordinates({
        mapPath: MAP_PATH,
        conversions: [
          {
            from: "tile",
            to: "tile",
            point: { x: 0, y: 0 },
          },
        ],
      });
    const projectionResult =
      result.projection as Record<
        string,
        unknown
      >;
    expect(
      "staggerAxis" in projectionResult,
    ).toBe(false);
    expect(
      "hexSideLength" in projectionResult,
    ).toBe(false);
  });

  it("declares isometric pixel space as distinct from screen space", async () => {
    const harness = await open({
      orientation: "isometric",
    });
    const result =
      await harness.service.convertCoordinates({
        mapPath: MAP_PATH,
        conversions: [
          {
            from: "tile",
            to: "screen",
            point: { x: 0, y: 0 },
          },
        ],
      });
    expect(result.projection).toMatchObject({
      orientation: "isometric",
      pixelSpace: "distinct-from-screen",
      tileSpace: "continuous",
    });
    // originX = mapHeight * tileWidth / 2 = 10 * 64 / 2
    expect(result.conversions).toEqual([
      {
        from: "tile",
        to: "screen",
        input: { x: 0, y: 0 },
        output: { x: 320, y: 0 },
      },
    ]);
  });

  it("declares hexagonal tile space as discrete", async () => {
    const harness = await open({
      orientation: "hexagonal",
      staggeraxis: "y",
      staggerindex: "odd",
      tilewidth: 32,
      tileheight: 32,
      hexsidelength: 16,
    });
    const result =
      await harness.service.convertCoordinates({
        mapPath: MAP_PATH,
        conversions: [
          {
            from: "screen",
            to: "tile",
            point: { x: 16, y: 12 },
          },
        ],
      });
    expect(result.projection).toMatchObject({
      orientation: "hexagonal",
      staggerAxis: "y",
      staggerIndex: "odd",
      hexSideLength: 16,
      tileSpace: "discrete",
      pixelSpace: "same-as-screen",
    });
    const [conversion] = result.conversions as Array<
      Record<string, unknown>
    >;
    expect(conversion?.cell).toEqual(
      conversion?.output,
    );
  });

  it("answers even when the map's tilesets are unresolvable", async () => {
    // The header is all the transforms need, and a broken tileset reference is
    // exactly when working a cell position out by hand is hardest.
    const harness = await open({
      tilesets: [
        { firstgid: 1, source: "missing.tsj" },
      ],
    });
    await expect(
      harness.service.convertCoordinates({
        mapPath: MAP_PATH,
        conversions: [
          {
            from: "tile",
            to: "screen",
            point: { x: 1, y: 1 },
          },
        ],
      }),
    ).resolves.toMatchObject({
      conversions: [
        { output: { x: 64, y: 32 } },
      ],
    });
  });

  it("rejects a staggered map with no stagger axis", async () => {
    const harness = await open({
      orientation: "staggered",
    });
    await expect(
      harness.service.convertCoordinates({
        mapPath: MAP_PATH,
        conversions: [
          {
            from: "tile",
            to: "screen",
            point: { x: 0, y: 0 },
          },
        ],
      }),
    ).rejects.toThrow(/staggeraxis/);
  });

  it("rejects a non-TMJ map", async () => {
    const created = await createProject({
      prefix: "tiledmcp-coordinates",
      files: { "maps/a.tmx": "<map/>" },
    });
    project = created;
    await expect(
      created.service.convertCoordinates({
        mapPath: "maps/a.tmx",
        conversions: [
          {
            from: "tile",
            to: "screen",
            point: { x: 0, y: 0 },
          },
        ],
      }),
    ).rejects.toThrow(/TMJ/);
  });
});
