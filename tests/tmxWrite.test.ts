import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { ChangeSetRegistry } from "../src/changeSets.js";
import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import {
  formatQtDouble,
  serializeTmxMap,
  serializeTsxTileset,
  serializeTxTemplate,
} from "../src/maps/tmxWrite.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const MAP_PATH = "maps/level.tmj";
const REAL_TILED = "/usr/bin/tiled";

/**
 * Golden bytes produced by `tiled --export-map tmx` from Tiled 1.12.2
 * for exactly the document built by goldenMap(). The serializer must
 * reproduce them byte for byte.
 */
const GOLDEN_TMX = `<?xml version="1.0" encoding="UTF-8"?>
<map version="1.10" tiledversion="1.12.2" orientation="orthogonal" renderorder="right-down" width="2" height="2" tilewidth="16" tileheight="16" infinite="0" nextlayerid="3" nextobjectid="7">
 <tileset firstgid="1" source="../tiles/decor.tsj"/>
 <layer id="1" name="ground" width="2" height="2">
  <data encoding="csv">
1,2,
0,2147483649
</data>
 </layer>
 <objectgroup id="2" name="props">
  <object id="1" name="Chest" type="Loot" x="8" y="8" width="8" height="8"/>
  <object id="2" x="0.5" y="12" width="4" height="4" rotation="45.5" visible="0">
   <ellipse/>
  </object>
  <object id="3" x="3" y="3">
   <point/>
  </object>
  <object id="4" x="1" y="1">
   <polygon points="0,0 4,0 0,4"/>
  </object>
  <object id="5" gid="2" x="16" y="32" width="16" height="16"/>
  <object id="6" x="0" y="16" width="32" height="8">
   <text wrap="1">Hi</text>
  </object>
 </objectgroup>
</map>
`;

function goldenMap(): JsonObject {
  return {
    compressionlevel: -1,
    height: 2,
    infinite: false,
    layers: [
      {
        data: [1, 2, 0, 2147483649],
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
      {
        draworder: "topdown",
        id: 2,
        name: "props",
        objects: [
          {
            height: 8,
            id: 1,
            name: "Chest",
            rotation: 0,
            type: "Loot",
            visible: true,
            width: 8,
            x: 8,
            y: 8,
          },
          {
            ellipse: true,
            height: 4,
            id: 2,
            name: "",
            rotation: 45.5,
            type: "",
            visible: false,
            width: 4,
            x: 0.5,
            y: 12,
          },
          {
            id: 3,
            name: "",
            point: true,
            rotation: 0,
            type: "",
            visible: true,
            width: 0,
            height: 0,
            x: 3,
            y: 3,
          },
          {
            id: 4,
            name: "",
            polygon: [
              { x: 0, y: 0 },
              { x: 4, y: 0 },
              { x: 0, y: 4 },
            ],
            rotation: 0,
            type: "",
            visible: true,
            width: 0,
            height: 0,
            x: 1,
            y: 1,
          },
          {
            gid: 2,
            height: 16,
            id: 5,
            name: "",
            rotation: 0,
            type: "",
            visible: true,
            width: 16,
            x: 16,
            y: 32,
          },
          {
            height: 8,
            id: 6,
            name: "",
            rotation: 0,
            text: { text: "Hi", wrap: true },
            type: "",
            visible: true,
            width: 32,
            x: 0,
            y: 16,
          },
        ],
        opacity: 1,
        type: "objectgroup",
        visible: true,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 3,
    nextobjectid: 7,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [
      {
        firstgid: 1,
        source: "../tiles/decor.tsj",
      },
    ],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 2,
  };
}

describe("native TMX serialization", () => {
  it("matches the official Tiled 1.12.2 writer byte for byte", () => {
    expect(
      serializeTmxMap(goldenMap(), MAP_PATH),
    ).toBe(GOLDEN_TMX);
  });

  it("escapes XML exactly like QXmlStreamWriter", () => {
    const map = goldenMap();
    const layer = map.layers as JsonObject[];
    (layer[1] as JsonObject).objects = [
      {
        height: 8,
        id: 1,
        name: `A<&">'B`,
        rotation: 0,
        type: "",
        visible: true,
        width: 8,
        x: 0.125,
        y: 250000,
      },
      {
        height: 8,
        id: 2,
        name: "",
        rotation: 0,
        text: { text: `X<&>"'Y\nZ` },
        type: "",
        visible: true,
        width: 32,
        x: 0,
        y: 16,
      },
    ];
    map.nextobjectid = 3;
    const rendered = serializeTmxMap(
      map,
      MAP_PATH,
    );
    expect(rendered).toContain(
      `<object id="1" name="A&lt;&amp;&quot;&gt;'B" x="0.125" y="250000" width="8" height="8"/>`,
    );
    expect(rendered).toContain(
      `<text>X&lt;&amp;&gt;&quot;'Y\nZ</text>`,
    );
  });

  it("formats doubles as QString::number %g and refuses precision loss", () => {
    expect(formatQtDouble(0.5, "v")).toBe("0.5");
    expect(formatQtDouble(8, "v")).toBe("8");
    expect(formatQtDouble(-3.5, "v")).toBe(
      "-3.5",
    );
    expect(formatQtDouble(250000, "v")).toBe(
      "250000",
    );
    expect(formatQtDouble(2000000, "v")).toBe(
      "2e+06",
    );
    expect(formatQtDouble(0.125, "v")).toBe(
      "0.125",
    );
    expect(() =>
      formatQtDouble(1234567.5, "v"),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_FORMAT",
      }),
    );
  });

  it("serializes custom properties with the official bytes", () => {
    const map = goldenMap();
    map.properties = [
      { name: "title", type: "string", value: "Hello <W>" },
      { name: "depth", type: "int", value: 7 },
      { name: "rate", type: "float", value: 0.5 },
      { name: "open", type: "bool", value: true },
      { name: "multi", type: "string", value: "a\nb" },
    ];
    const rendered = serializeTmxMap(
      map,
      MAP_PATH,
    );
    // Sorted by name; string type implicit; newline strings become
    // element text — exactly the official writeProperties bytes.
    expect(rendered).toContain(
      ` <properties>
  <property name="depth" type="int" value="7"/>
  <property name="multi">a
b</property>
  <property name="open" type="bool" value="true"/>
  <property name="rate" type="float" value="0.5"/>
  <property name="title" value="Hello &lt;W&gt;"/>
 </properties>`,
    );
    const withObjectProperty = goldenMap();
    (
      (withObjectProperty.layers as JsonObject[])[1] as {
        objects: JsonObject[];
      }
    ).objects = [
      {
        height: 8,
        id: 1,
        name: "P",
        rotation: 0,
        type: "",
        visible: true,
        width: 8,
        x: 8,
        y: 8,
        properties: [
          { name: "hp", type: "int", value: 3 },
        ],
      },
    ];
    withObjectProperty.nextobjectid = 2;
    expect(
      serializeTmxMap(
        withObjectProperty,
        MAP_PATH,
      ),
    ).toContain(
      `  <object id="1" name="P" x="8" y="8" width="8" height="8">
   <properties>
    <property name="hp" type="int" value="3"/>
   </properties>
  </object>`,
    );
    // Object- and class-typed properties stay outside the profile.
    const withClassProperty = goldenMap();
    withClassProperty.properties = [
      {
        name: "x",
        type: "class",
        propertytype: "T",
        value: {},
      },
    ];
    expect(() =>
      serializeTmxMap(
        withClassProperty,
        MAP_PATH,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_FORMAT",
      }),
    );
  });

  it("fails closed on structures outside the profile", () => {
    const withImageLayer = goldenMap();
    (withImageLayer.layers as JsonObject[]).push({
      id: 3,
      image: "bg.png",
      name: "bg",
      opacity: 1,
      type: "imagelayer",
      visible: true,
      x: 0,
      y: 0,
    });
    expect(() =>
      serializeTmxMap(withImageLayer, MAP_PATH),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_FORMAT",
      }),
    );

    const withEncoding = goldenMap();
    const encoded = (
      withEncoding.layers as JsonObject[]
    )[0]!;
    encoded.encoding = "base64";
    encoded.data = "AQAAAAIAAAAAAAAAAQAAgA==";
    expect(() =>
      serializeTmxMap(withEncoding, MAP_PATH),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_FORMAT",
      }),
    );

    const withEmbedded = goldenMap();
    withEmbedded.tilesets = [
      {
        firstgid: 1,
        name: "Embedded",
        tilewidth: 16,
        tileheight: 16,
        tilecount: 1,
        columns: 1,
        image: "x.png",
        imagewidth: 16,
        imageheight: 16,
        margin: 0,
        spacing: 0,
      },
    ];
    expect(() =>
      serializeTmxMap(withEmbedded, MAP_PATH),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_FORMAT",
      }),
    );

    const withTemplate = goldenMap();
    (
      (withTemplate.layers as JsonObject[])[1] as {
        objects: JsonObject[];
      }
    ).objects = [
      {
        id: 1,
        template: "../templates/crate.tj",
        x: 1,
        y: 1,
      },
    ];
    expect(() =>
      serializeTmxMap(withTemplate, MAP_PATH),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_FORMAT",
      }),
    );

    const isometric = goldenMap();
    isometric.orientation = "isometric";
    expect(() =>
      serializeTmxMap(isometric, MAP_PATH),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_FORMAT",
      }),
    );
  });
});

describe("native TMX write via change sets", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("plans, previews, and applies a byte-exact sibling .tmx", async () => {
    const harness = await createHarness(roots);
    const plan = await harness.service.planWriteTmx(
      {
        mapPath: MAP_PATH,
        targetPath: "maps/level.tmx",
        expectedMapRevision: harness.mapRevision,
      },
    );
    expect(plan).toMatchObject({
      kind: "fileExport",
      producer: "native",
      exportKind: "map",
      format: "tmx",
      sourcePath: MAP_PATH,
      targetPath: "maps/level.tmx",
      sourceRevision: harness.mapRevision,
    });
    const preview = new ChangeSetRegistry().put(
      plan,
    );
    expect(preview.operations[0]).toMatchObject({
      type: "exportFile",
      destructive: false,
      producer: "native",
      format: "tmx",
    });

    const failingRunner = (): never => {
      throw new Error(
        "the native producer must not invoke the CLI runner",
      );
    };
    const result =
      await harness.service.applyExportFile(
        plan,
        failingRunner,
      );
    expect(result).toMatchObject({
      path: "maps/level.tmx",
      changed: true,
    });
    const written = await readFile(
      join(harness.root, "maps/level.tmx"),
      "utf8",
    );
    expect(written).toBe(GOLDEN_TMX);

    // The written TMX reads back through the native XML read core.
    const summary =
      (await harness.service.getSummary(
        "maps/level.tmx",
      )) as { width: number; height: number };
    expect(summary).toMatchObject({
      width: 2,
      height: 2,
    });

    // The target now exists: a second preview refuses to overwrite.
    await expect(
      harness.service.planWriteTmx({
        mapPath: MAP_PATH,
        targetPath: "maps/level.tmx",
        expectedMapRevision: harness.mapRevision,
      }),
    ).rejects.toMatchObject({
      code: "FILE_ALREADY_EXISTS",
    });
  });

  it("fails closed on cross-directory targets and stale sources", async () => {
    const harness = await createHarness(roots);
    await expect(
      harness.service.planWriteTmx({
        mapPath: MAP_PATH,
        targetPath: "tiles/level.tmx",
        expectedMapRevision: harness.mapRevision,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      harness.service.planWriteTmx({
        mapPath: MAP_PATH,
        targetPath: "maps/level.xml",
        expectedMapRevision: harness.mapRevision,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });

    const plan = await harness.service.planWriteTmx(
      {
        mapPath: MAP_PATH,
        targetPath: "maps/level.tmx",
        expectedMapRevision: harness.mapRevision,
      },
    );
    const map = goldenMap();
    map.nextobjectid = 99;
    await writeFile(
      join(harness.root, MAP_PATH),
      serializeJsonDocument(map),
    );
    await expect(
      harness.service.applyExportFile(
        plan,
        (): never => {
          throw new Error("unused");
        },
      ),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
    });
  });

  it.runIf(existsSync(REAL_TILED))(
    "matches the real Tiled CLI export byte for byte",
    { timeout: 60_000 },
    async () => {
      const harness = await createHarness(roots);
      const plan =
        await harness.service.planWriteTmx({
          mapPath: MAP_PATH,
          targetPath: "maps/level.tmx",
          expectedMapRevision:
            harness.mapRevision,
        });
      await harness.service.applyExportFile(
        plan,
        (): never => {
          throw new Error("unused");
        },
      );
      const cliTarget = join(
        harness.root,
        "maps/cli.tmx",
      );
      await promisify(execFile)(REAL_TILED, [
        "--export-map",
        "tmx",
        join(harness.root, MAP_PATH),
        cliTarget,
      ]);
      expect(
        await readFile(
          join(harness.root, "maps/level.tmx"),
          "utf8",
        ),
      ).toBe(await readFile(cliTarget, "utf8"));
    },
  );
});

const GOLDEN_TSX = `<?xml version="1.0" encoding="UTF-8"?>
<tileset version="1.10" tiledversion="1.12.2" name="Decor" tilewidth="16" tileheight="16" tilecount="2" columns="2">
 <image source="decor.png" width="32" height="16"/>
</tileset>
`;

function goldenTileset(): JsonObject {
  return {
    columns: 2,
    image: "decor.png",
    imageheight: 16,
    imagewidth: 32,
    margin: 0,
    name: "Decor",
    spacing: 0,
    tilecount: 2,
    tiledversion: "1.12.2",
    tileheight: 16,
    tilewidth: 16,
    type: "tileset",
    version: "1.10",
  };
}

describe("native TSX serialization and write", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("matches the official Tiled 1.12.2 tileset writer byte for byte", () => {
    expect(
      serializeTsxTileset(
        goldenTileset(),
        "tiles/decor.tsj",
      ),
    ).toBe(GOLDEN_TSX);
  });

  it("fails closed on grids the exporter would rewrite and on per-tile data", () => {
    const disagreeing = goldenTileset();
    disagreeing.tilecount = 4;
    expect(() =>
      serializeTsxTileset(
        disagreeing,
        "tiles/decor.tsj",
      ),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_FORMAT",
      }),
    );
    const withTiles = goldenTileset();
    withTiles.tiles = [
      { id: 0, probability: 0.5 },
    ];
    expect(() =>
      serializeTsxTileset(
        withTiles,
        "tiles/decor.tsj",
      ),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_FORMAT",
      }),
    );
  });

  it("plans and applies a byte-exact sibling .tsx", async () => {
    const harness = await createHarness(roots);
    const revision = (
      await harness.service.getSummary(MAP_PATH)
    ) as { dependencyRevisions: Record<string, string> };
    const tilesetRevision = Object.values(
      revision.dependencyRevisions,
    )[0]!;
    const plan = await harness.service.planWriteTsx(
      {
        tilesetPath: "tiles/decor.tsj",
        targetPath: "tiles/decor.tsx",
        expectedTilesetRevision: tilesetRevision,
      },
    );
    expect(plan).toMatchObject({
      kind: "fileExport",
      producer: "native",
      exportKind: "tileset",
      format: "tsx",
    });
    await harness.service.applyExportFile(
      plan,
      (): never => {
        throw new Error("unused");
      },
    );
    expect(
      await readFile(
        join(harness.root, "tiles/decor.tsx"),
        "utf8",
      ),
    ).toBe(GOLDEN_TSX);
  });

  it.runIf(existsSync(REAL_TILED))(
    "matches the real Tiled CLI tileset export byte for byte",
    { timeout: 60_000 },
    async () => {
      const harness = await createHarness(roots);
      const revision = (
        await harness.service.getSummary(
          MAP_PATH,
        )
      ) as {
        dependencyRevisions: Record<
          string,
          string
        >;
      };
      const plan =
        await harness.service.planWriteTsx({
          tilesetPath: "tiles/decor.tsj",
          targetPath: "tiles/decor.tsx",
          expectedTilesetRevision: Object.values(
            revision.dependencyRevisions,
          )[0]!,
        });
      await harness.service.applyExportFile(
        plan,
        (): never => {
          throw new Error("unused");
        },
      );
      const cliTarget = join(
        harness.root,
        "tiles/cli.tsx",
      );
      await promisify(execFile)(REAL_TILED, [
        "--export-tileset",
        "tsx",
        join(harness.root, "tiles/decor.tsj"),
        cliTarget,
      ]);
      expect(
        await readFile(
          join(harness.root, "tiles/decor.tsx"),
          "utf8",
        ),
      ).toBe(await readFile(cliTarget, "utf8"));
    },
  );
});

describe("native TX template serialization and write", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  const template = (): JsonObject => ({
    type: "template",
    object: {
      id: 0,
      name: "Crate",
      type: "Prop",
      width: 12,
      height: 8,
      rotation: 45,
      visible: false,
      ellipse: true,
      x: 0,
      y: 0,
    },
  });
  const goldenTx = `<?xml version="1.0" encoding="UTF-8"?>
<template>
 <object name="Crate" type="Prop" width="12" height="8" rotation="45" visible="0">
  <ellipse/>
 </object>
</template>
`;

  it("serializes template bases without id, x, or y", () => {
    expect(
      serializeTxTemplate(
        template(),
        "templates/crate.tj",
      ),
    ).toBe(goldenTx);
  });

  it("fails closed on tile and nested templates", () => {
    const tileTemplate: JsonObject = {
      type: "template",
      tileset: {
        firstgid: 1,
        source: "../tiles/decor.tsj",
      },
      object: { id: 0, gid: 1, x: 0, y: 0 },
    };
    expect(() =>
      serializeTxTemplate(
        tileTemplate,
        "templates/crate.tj",
      ),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_FORMAT",
      }),
    );
    const nested: JsonObject = {
      type: "template",
      object: {
        id: 0,
        template: "other.tj",
        x: 0,
        y: 0,
      },
    };
    expect(() =>
      serializeTxTemplate(
        nested,
        "templates/crate.tj",
      ),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_FORMAT",
      }),
    );
  });

  it("plans and applies a sibling .tx", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "tiledmcp-tx-write-"),
    );
    roots.add(root);
    await mkdir(join(root, "templates"));
    await writeFile(
      join(root, "templates/crate.tj"),
      serializeJsonDocument(template()),
    );
    const resolver =
      await ProjectPathResolver.create(root);
    const store = new DocumentStore(resolver);
    const service = new MapService(
      resolver,
      store,
    );
    const revision = (
      await store.read("templates/crate.tj")
    ).revision;
    const plan = await service.planWriteTx({
      templatePath: "templates/crate.tj",
      targetPath: "templates/crate.tx",
      expectedTemplateRevision: revision,
    });
    expect(plan).toMatchObject({
      producer: "native",
      exportKind: "template",
      format: "tx",
    });
    await service.applyExportFile(
      plan,
      (): never => {
        throw new Error("unused");
      },
    );
    expect(
      await readFile(
        join(root, "templates/crate.tx"),
        "utf8",
      ),
    ).toBe(goldenTx);
  });
});

interface Harness {
  root: string;
  service: MapService;
  mapRevision: string;
}

async function createHarness(
  roots: Set<string>,
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-tmx-write-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeFile(
    join(root, "tiles/decor.png"),
    // A real 32x16 PNG: the official CLI reloads the image and
    // recomputes the grid, so the golden comparison needs it decodable.
    await sharp({
      create: {
        width: 32,
        height: 16,
        channels: 4,
        background: {
          r: 90,
          g: 90,
          b: 90,
          alpha: 1,
        },
      },
    })
      .png()
      .toBuffer(),
  );
  await writeFile(
    join(root, "tiles/decor.tsj"),
    serializeJsonDocument({
      columns: 2,
      image: "decor.png",
      imageheight: 16,
      imagewidth: 32,
      margin: 0,
      name: "Decor",
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
    serializeJsonDocument(goldenMap()),
  );
  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  const service = new MapService(resolver, store);
  const summary = (await service.getSummary(
    MAP_PATH,
  )) as { revision: string };
  return {
    root,
    service,
    mapRevision: summary.revision,
  };
}
