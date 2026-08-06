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

/**
 * Shared subschemas carrying `.meta({ id })` -- TileRef, TileTransform,
 * NamedTileRef, TilePropertiesPatch -- are emitted once into `definitions` and
 * referenced by `$ref` at each use site. Nothing else checks that those two
 * halves stay together.
 *
 * That has already broken: commit 50fecd0 ("restore the definitions two
 * refactor commits left dangling") repaired it by hand. A dangling `$ref` is a
 * schema a client cannot resolve, so it fails at the client rather than here,
 * which is the same failure shape that makes output-schema mistakes expensive.
 *
 * This drives a live server rather than reading contracts/, so it fails on the
 * code that produced the schema, not only on the committed artifact.
 */
describe("tool schema $ref integrity", () => {
  const open = new Set<TestProject>();

  afterEach(async () => {
    await Promise.all(
      [...open].map(disposeProject),
    );
    open.clear();
  });

  it("resolves every $ref, in both input and output schemas", async () => {
    const client = await harness(open);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);

    const dangling: string[] = [];
    let checked = 0;
    for (const [label, schema] of halves(tools)) {
      checked += refsOf(schema).length;
      dangling.push(
        ...danglingRefs(schema).map(
          (ref) => `${label} -> ${ref}`,
        ),
      );
    }

    expect(dangling).toEqual([]);
    // If the .meta({ id }) mechanism ever stopped emitting refs, the loop
    // above would pass vacuously with nothing to check.
    expect(checked).toBeGreaterThan(0);
  });

  it("declares no definition it never references", async () => {
    // An orphan definition is dead weight on every tools/list, and usually
    // means a use site was inlined or removed without dropping the id.
    const client = await harness(open);
    const { tools } = await client.listTools();

    const orphans: string[] = [];
    for (const [label, schema] of halves(tools)) {
      orphans.push(
        ...orphanDefinitions(schema).map(
          (name) => `${label} declares unused ${name}`,
        ),
      );
    }

    expect(orphans).toEqual([]);
  });

  it("detects a dangling ref and an orphan definition", () => {
    // Guards the guard. Both checks above are all-clear assertions, so a
    // detector that silently found nothing would look identical to a healthy
    // surface. This pins the detectors against a schema known to be broken in
    // exactly the way 50fecd0 had to repair.
    const broken = {
      type: "object",
      properties: {
        a: { $ref: "#/definitions/Gone" },
        b: { $ref: "#/definitions/Present" },
      },
      definitions: {
        Present: { type: "string" },
        Unused: { type: "number" },
      },
    };
    expect(danglingRefs(broken)).toEqual([
      "#/definitions/Gone",
    ]);
    expect(orphanDefinitions(broken)).toEqual([
      "Unused",
    ]);
  });
});

/** Tool schemas paired with a label, skipping tools that declare none. */
function halves(
  tools: Array<{
    name: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
  }>,
): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const tool of tools) {
    for (const half of [
      "inputSchema",
      "outputSchema",
    ] as const) {
      const schema = tool[half];
      if (schema !== undefined) {
        out.push([`${tool.name}.${half}`, schema]);
      }
    }
  }
  return out;
}

function declarationsOf(
  schema: unknown,
): string[] {
  const definitions = (
    schema as Record<string, unknown>
  ).definitions;
  return definitions === null ||
    typeof definitions !== "object"
    ? []
    : Object.keys(definitions);
}

/** Refs that point outside `#/definitions` or at a name nothing declares. */
function danglingRefs(schema: unknown): string[] {
  const declared = new Set(
    declarationsOf(schema),
  );
  return refsOf(schema).filter(
    (ref) =>
      !ref.startsWith("#/definitions/") ||
      !declared.has(
        ref.replace("#/definitions/", ""),
      ),
  );
}

/** Declared definitions that no ref in the same schema points at. */
function orphanDefinitions(
  schema: unknown,
): string[] {
  const used = new Set(
    refsOf(schema).map((ref) =>
      ref.replace("#/definitions/", ""),
    ),
  );
  return declarationsOf(schema).filter(
    (name) => !used.has(name),
  );
}

/** Every `$ref` string anywhere in a schema, including inside definitions. */
function refsOf(node: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry);
      }
      return;
    }
    if (
      value === null ||
      typeof value !== "object"
    ) {
      return;
    }
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (
        key === "$ref" &&
        typeof child === "string"
      ) {
        found.push(child);
        continue;
      }
      walk(child);
    }
  };
  walk(node);
  return found;
}

async function harness(
  open: Set<TestProject>,
): Promise<Client> {
  const project = await createProject({
    prefix: "tiledmcp-schema-refs",
    files: {
      "maps/level.tmj": {
        compressionlevel: -1,
        height: 1,
        infinite: false,
        layers: [
          {
            data: [0],
            height: 1,
            id: 1,
            name: "ground",
            opacity: 1,
            type: "tilelayer",
            visible: true,
            width: 1,
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
        tilesets: [],
        tilewidth: 16,
        type: "map",
        version: "1.10",
        width: 1,
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
    {
      name: "schema-ref-test",
      version: "0.0.0",
    },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await created.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
