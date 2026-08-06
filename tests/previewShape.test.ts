import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { TiledCliAdapter } from "../src/adapters/tiledCli.js";
import { createTiledMcpServer } from "../src/server.js";
import {
  createProject,
  disposeProject,
  type TestProject,
} from "./support/project.js";

const MAP_PATH = "maps/level.tmj";
const TILESET_PATH = "tiles/decor.tsj";
const LAYER_ID = 1;

describe("tiled_preview_shape over the MCP tool surface", () => {
  const open = new Set<TestProject>();

  afterEach(async () => {
    await Promise.all([...open].map(disposeProject));
    open.clear();
  });

  it("returns a mapEdit plan carrying exactly one setTiles operation", async () => {
    const { client } = await harness(open);

    const summary = resultOf<{
      revision: string;
      dependencyRevisions: Record<string, string>;
    }>(
      await client.callTool({
        name: "tiled_get_map_summary",
        arguments: { mapPath: MAP_PATH },
      }),
    );

    const response = (await client.callTool({
      name: "tiled_preview_shape",
      arguments: {
        mapPath: MAP_PATH,
        layerId: LAYER_ID,
        draw: {
          shape: "rectangle",
          x: 0,
          y: 0,
          width: 3,
          height: 3,
          fill: false,
        },
        tile: null,
        expectedMapRevision: summary.revision,
        expectedDependencyRevisions:
          summary.dependencyRevisions,
      },
    })) as {
      isError?: boolean;
      structuredContent?: { result: unknown };
    };

    // Surfaced deliberately: an output-schema mismatch is swallowed into
    // INTERNAL_ERROR by the register() wrapper, so a bare isError check would
    // report "failed" without saying why.
    if (response.isError === true) {
      throw new Error(
        `tiled_preview_shape failed: ${JSON.stringify(
          response,
        )}`,
      );
    }

    const plan = response.structuredContent
      ?.result as {
      kind: string;
      operations: Array<{ type: string }>;
      summary: Record<string, unknown>;
    };

    expect(plan.kind).toBe("mapEdit");
    // planDrawShape hands planEdits a hardcoded single-element array, and
    // planEdits echoes it through structuredClone, so this is the entire
    // operation surface the tool can produce. previewShapeToolOutputSchema
    // narrows `operations` to exactly this on the strength of it.
    expect(
      plan.operations.map(({ type }) => type),
    ).toEqual(["setTiles"]);
    expect(plan.summary).toEqual({
      operationCount: 1,
      cellWrites: 8,
      affectedLayerIds: [LAYER_ID],
      affectedTileLayerIds: [LAYER_ID],
      affectedObjectLayerIds: [],
      createdObjectIds: [],
      updatedObjectIds: [],
      deletedObjectIds: [],
    });
  });
});

async function harness(
  open: Set<TestProject>,
): Promise<{ client: Client }> {
  const project = await createProject({
    prefix: "tiledmcp-preview-shape",
    files: {
      "tiles/decor.png": Buffer.from(
        "placeholder image bytes",
        "utf8",
      ),
      [TILESET_PATH]: {
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
      },
      [MAP_PATH]: {
        compressionlevel: -1,
        height: 3,
        infinite: false,
        layers: [
          {
            data: [1, 0, 0, 0, 0, 0, 0, 0, 0],
            height: 3,
            id: LAYER_ID,
            name: "ground",
            opacity: 1,
            type: "tilelayer",
            visible: true,
            width: 3,
            x: 0,
            y: 0,
          },
        ],
        nextlayerid: 2,
        nextobjectid: 1,
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
        width: 3,
      },
    },
  });
  open.add(project);

  const missing = `${project.root}/does-not-exist`;
  const created = await createTiledMcpServer({
    resolver: project.resolver,
    store: project.store,
    maps: project.service,
    cli: new TiledCliAdapter({
      tiledCliPath: `${missing}-tiled`,
      rasterizerPath: `${missing}-tmxrasterizer`,
    }),
  });
  const client = new Client(
    { name: "preview-shape-test", version: "0.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await created.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client };
}

function resultOf<T>(response: unknown): T {
  const structured = (
    response as {
      structuredContent?: { result: unknown };
    }
  ).structuredContent;
  if (structured === undefined) {
    throw new Error(
      `Expected structuredContent: ${JSON.stringify(response)}`,
    );
  }
  return structured.result as T;
}
