import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { bootTiledMcpServer } from "../src/boot.js";
import type { ServerConfig } from "../src/config.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup().catch(() => undefined);
  }
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tiledmcp-roots-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function configFor(
  root: string,
  projectDir: string | undefined,
): ServerConfig {
  return {
    projectDir,
    tiledCliPath: join(root, "missing-tiled"),
    rasterizerPath: join(root, "missing-tmxrasterizer"),
    checkpointBytes: 1024 * 1024 * 1024,
    retainCommittedPerTarget: undefined,
  };
}

describe("roots-deferred boot", () => {
  it("sandboxes to the client's first file:// root and serves the full tool list", async () => {
    const root = await makeRoot();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "roots-test-client", version: "0.0.0" },
      { capabilities: { roots: { listChanged: true } } },
    );
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [
        { uri: pathToFileURL(root).href, name: "project" },
        { uri: pathToFileURL(tmpdir()).href, name: "second" },
      ],
    }));

    const logs: string[] = [];
    const bootPromise = bootTiledMcpServer({
      config: configFor(root, undefined),
      transport: serverTransport,
      log: (line) => logs.push(line),
    });
    cleanups.push(async () => {
      await client.close();
      await (await bootPromise).server.close();
    });

    // Fire tools/list the moment the handshake completes, while the server
    // is still resolving roots and wiring tools: the gate must buffer it so
    // the client never observes an empty tool list.
    const earlyToolsPromise = (async () => {
      await client.connect(clientTransport);
      return client.listTools();
    })();

    const booted = await bootPromise;
    expect(booted.projectDir).toBe(await realpath(root));
    expect(
      logs.some((line) => line.includes("sandboxing to the first")),
    ).toBe(true);

    const earlyTools = await earlyToolsPromise;
    expect(earlyTools.tools.length).toBe(50);
    expect(
      earlyTools.tools.some(
        (tool) => tool.name === "__tiled_mcp_boot__",
      ),
    ).toBe(false);

    const listed = await client.callTool({
      name: "tiled_list_files",
      arguments: {},
    });
    expect(listed.structuredContent).toEqual({ result: [] });
  });

  it("fails closed when the client does not advertise roots", async () => {
    const root = await makeRoot();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "rootless-client", version: "0.0.0" },
      { capabilities: {} },
    );
    cleanups.push(async () => {
      await client.close();
    });

    const bootPromise = bootTiledMcpServer({
      config: configFor(root, undefined),
      transport: serverTransport,
      log: () => undefined,
    });
    await client.connect(clientTransport);
    await expect(bootPromise).rejects.toMatchObject({
      code: "PROJECT_ROOT_REQUIRED",
    });
  });

  it("fails closed when the client advertises roots but returns no file:// root", async () => {
    const root = await makeRoot();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "empty-roots-client", version: "0.0.0" },
      { capabilities: { roots: {} } },
    );
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [],
    }));
    cleanups.push(async () => {
      await client.close();
    });

    const bootPromise = bootTiledMcpServer({
      config: configFor(root, undefined),
      transport: serverTransport,
      log: () => undefined,
    });
    await client.connect(clientTransport);
    await expect(bootPromise).rejects.toMatchObject({
      code: "PROJECT_ROOT_REQUIRED",
    });
  });

  it("keeps the explicit --project-dir path unchanged", async () => {
    const root = await makeRoot();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "explicit-client", version: "0.0.0" },
      { capabilities: {} },
    );

    const bootPromise = bootTiledMcpServer({
      config: configFor(root, root),
      transport: serverTransport,
      log: () => undefined,
    });
    cleanups.push(async () => {
      await client.close();
      await (await bootPromise).server.close();
    });
    const booted = await bootPromise;
    await client.connect(clientTransport);

    expect(booted.projectDir).toBe(await realpath(root));
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(50);
  });
});
