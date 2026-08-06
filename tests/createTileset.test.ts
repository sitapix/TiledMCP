import { execFile } from "node:child_process";
import { wireProject } from "./support/project.js";
import {
  TILED_CLI_ENV,
  hasTiledCli,
  TILED_CLI_PATH,
} from "./support/tiledCli.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { ChangeSetRegistry } from "../src/changeSets.js";
import type { JsonObject } from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import {
  computeAtlasGrid,
  tilesetCreatePlanId,
  type TilesetCreatePlan,
} from "../src/maps/tilesetCreate.js";
import { revisionOf } from "../src/storage/revision.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const execFileAsync = promisify(execFile);

const TILESET_PATH = "tiles/props.tsj";
const IMAGE_PATH = "images/props-atlas.png";
const IMAGE_WIDTH = 66;
const IMAGE_HEIGHT = 48;

interface Harness {
  root: string;
  service: MapService;
  store: DocumentStore;
}

describe("tiled_create_tileset planning and apply", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("matches the Tiled 1.12.2 grid formula including margin and spacing", () => {
    // 66x48 image, 16x16 tiles, margin 1, spacing 2:
    // columns = (66 - 1 + 2) / 18 = 3, rows = (48 - 1 + 2) / 18 = 2.
    expect(
      computeAtlasGrid({
        imageWidth: IMAGE_WIDTH,
        imageHeight: IMAGE_HEIGHT,
        tileWidth: 16,
        tileHeight: 16,
        margin: 1,
        spacing: 2,
      }),
    ).toEqual({
      columns: 3,
      rows: 2,
      tileCount: 6,
      unusedRightPixels: 66 - (1 + 3 * 16 + 2 * 2),
      unusedBottomPixels: 48 - (1 + 2 * 16 + 2),
    });
    expect(() =>
      computeAtlasGrid({
        imageWidth: 15,
        imageHeight: 48,
        tileWidth: 16,
        tileHeight: 16,
        margin: 0,
        spacing: 0,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  });

  it("plans, previews, and applies a canonical no-replace TSJ creation", async () => {
    const harness = await createHarness(roots);

    const plan =
      await harness.service.planCreateTileset({
        tilesetPath: TILESET_PATH,
        imagePath: IMAGE_PATH,
        tileWidth: 16,
        tileHeight: 16,
        margin: 1,
        spacing: 2,
      });
    expect(plan).toMatchObject({
      kind: "tilesetCreate",
      version: 1,
      tilesetPath: TILESET_PATH,
      name: "props",
      className: null,
      summary: {
        columns: 3,
        rows: 2,
        tileCount: 6,
        imageWidth: IMAGE_WIDTH,
        imageHeight: IMAGE_HEIGHT,
        unusedRightPixels: 13,
        unusedBottomPixels: 13,
        wouldChange: true,
      },
      image: {
        path: IMAGE_PATH,
        source: "../images/props-atlas.png",
        width: IMAGE_WIDTH,
        height: IMAGE_HEIGHT,
      },
    });

    const preview =
      new ChangeSetRegistry().put(plan);
    expect(preview).toMatchObject({
      kind: "tilesetCreate",
      tilesetPath: TILESET_PATH,
      expectedRevision: plan.baseRevision,
      snapshotConsistency: "non-atomic-read-set",
      operations: [
        {
          type: "createTileset",
          destructive: false,
          name: "props",
          columns: 3,
          rows: 2,
          tileCount: 6,
          contentRevision: plan.baseRevision,
        },
      ],
    });

    const result =
      await harness.service.applyTilesetCreate(
        plan,
      );
    expect(result).toMatchObject({
      path: TILESET_PATH,
      beforeRevision: null,
      revision: plan.baseRevision,
      changed: true,
    });

    const raw = await readFile(
      join(harness.root, TILESET_PATH),
    );
    expect(revisionOf(raw)).toBe(
      plan.baseRevision,
    );
    const document = JSON.parse(
      raw.toString("utf8"),
    ) as JsonObject;
    expect(Object.keys(document)).toEqual([
      "columns",
      "image",
      "imageheight",
      "imagewidth",
      "margin",
      "name",
      "spacing",
      "tilecount",
      "tiledversion",
      "tileheight",
      "tilewidth",
      "type",
      "version",
    ]);
    expect(document).toEqual({
      columns: 3,
      image: "../images/props-atlas.png",
      imageheight: IMAGE_HEIGHT,
      imagewidth: IMAGE_WIDTH,
      margin: 1,
      name: "props",
      spacing: 2,
      tilecount: 6,
      tiledversion: "1.12.2",
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.10",
    });
  });

  it("writes an alphabetical class member for an explicit className", async () => {
    const harness = await createHarness(roots);

    const plan =
      await harness.service.planCreateTileset({
        tilesetPath: TILESET_PATH,
        imagePath: IMAGE_PATH,
        tileWidth: 16,
        tileHeight: 16,
        name: "Props Atlas",
        className: "Scenery",
      });
    await harness.service.applyTilesetCreate(
      plan,
    );

    const document = JSON.parse(
      (
        await readFile(
          join(harness.root, TILESET_PATH),
        )
      ).toString("utf8"),
    ) as JsonObject;
    expect(
      Object.keys(document).slice(0, 2),
    ).toEqual(["class", "columns"]);
    expect(document.class).toBe("Scenery");
    expect(document.name).toBe("Props Atlas");
  });

  it("fails closed on existing targets at preview and at apply", async () => {
    const harness = await createHarness(roots);

    const plan =
      await harness.service.planCreateTileset({
        tilesetPath: TILESET_PATH,
        imagePath: IMAGE_PATH,
        tileWidth: 16,
        tileHeight: 16,
      });
    await writeFile(
      join(harness.root, TILESET_PATH),
      "{}",
      "utf8",
    );

    await expect(
      harness.service.planCreateTileset({
        tilesetPath: TILESET_PATH,
        imagePath: IMAGE_PATH,
        tileWidth: 16,
        tileHeight: 16,
      }),
    ).rejects.toMatchObject({
      code: "FILE_ALREADY_EXISTS",
    });
    await expect(
      harness.service.applyTilesetCreate(plan),
    ).rejects.toMatchObject({
      code: "FILE_ALREADY_EXISTS",
    });
  });

  it("rejects apply when the image changed after preview", async () => {
    const harness = await createHarness(roots);

    const plan =
      await harness.service.planCreateTileset({
        tilesetPath: TILESET_PATH,
        imagePath: IMAGE_PATH,
        tileWidth: 16,
        tileHeight: 16,
      });
    await writeFile(
      join(harness.root, IMAGE_PATH),
      await buildAtlasPng(32, 32),
    );

    await expect(
      harness.service.applyTilesetCreate(plan),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
      details: expect.objectContaining({
        path: IMAGE_PATH,
        expectedRevision: plan.image.revision,
      }),
    });
  });

  it("rejects tampered plans, non-tsj targets, and undersized images", async () => {
    const harness = await createHarness(roots);

    const plan =
      await harness.service.planCreateTileset({
        tilesetPath: TILESET_PATH,
        imagePath: IMAGE_PATH,
        tileWidth: 16,
        tileHeight: 16,
      });
    const tampered: TilesetCreatePlan = {
      ...structuredClone(plan),
      name: "sneaky",
    };
    await expect(
      harness.service.applyTilesetCreate(
        tampered,
      ),
    ).rejects.toMatchObject({
      code: "CHANGE_SET_TAMPERED",
    });
    const resigned: TilesetCreatePlan = (() => {
      const { id: _id, ...unsigned } = {
        ...structuredClone(plan),
        summary: {
          ...structuredClone(plan.summary),
          tileCount: 999,
        },
      };
      return {
        ...unsigned,
        id: tilesetCreatePlanId(unsigned),
      };
    })();
    await expect(
      harness.service.applyTilesetCreate(
        resigned,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_CHANGE_SET",
    });

    await expect(
      harness.service.planCreateTileset({
        tilesetPath: "tiles/props.tsx",
        imagePath: IMAGE_PATH,
        tileWidth: 16,
        tileHeight: 16,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
    await expect(
      harness.service.planCreateTileset({
        tilesetPath: TILESET_PATH,
        imagePath: IMAGE_PATH,
        tileWidth: 128,
        tileHeight: 16,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it.skipIf(!hasTiledCli)("round-trips the created tileset through the Tiled CLI", async () => {
    const harness = await createHarness(roots);

    const plan =
      await harness.service.planCreateTileset({
        tilesetPath: TILESET_PATH,
        imagePath: IMAGE_PATH,
        tileWidth: 16,
        tileHeight: 16,
        margin: 1,
        spacing: 2,
      });
    await harness.service.applyTilesetCreate(
      plan,
    );

    const outputPath = join(
      harness.root,
      "tiles",
      "roundtrip.tsj",
    );
    await execFileAsync(
      TILED_CLI_PATH,
      [
        "--export-tileset",
        "json",
        join(harness.root, TILESET_PATH),
        outputPath,
      ],
      {
        env: { ...TILED_CLI_ENV },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );

    const exported = JSON.parse(
      await readFile(outputPath, "utf8"),
    ) as JsonObject;
    expect(exported).toMatchObject({
      columns: 3,
      tilecount: 6,
      tilewidth: 16,
      tileheight: 16,
      margin: 1,
      spacing: 2,
      imagewidth: IMAGE_WIDTH,
      imageheight: IMAGE_HEIGHT,
      name: "props",
      type: "tileset",
    });
  });
});

async function createHarness(
  roots: Set<string>,
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-create-tileset-"),
  );
  roots.add(root);
  await mkdir(join(root, "tiles"));
  await mkdir(join(root, "images"));
  await writeFile(
    join(root, IMAGE_PATH),
    await buildAtlasPng(
      IMAGE_WIDTH,
      IMAGE_HEIGHT,
    ),
  );

  const { store, service } =
    await wireProject(root);
  return {
    root,
    store,
    service: service,
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
