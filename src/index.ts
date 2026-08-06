#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { bootTiledMcpServer } from "./boot.js";
import { helpText, loadConfig } from "./config.js";
import { asTiledMcpError } from "./errors.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  const config = loadConfig(argv, process.env);
  const { registeredTools, projectDir } = await bootTiledMcpServer({
    config,
    transport: new StdioServerTransport(),
  });
  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION} ready for ${projectDir} (${registeredTools.length} tools)\n`,
  );
}

main().catch((error: unknown) => {
  const normalized = asTiledMcpError(error);
  process.stderr.write(
    `tiled-mcp: ${normalized.code}: ${normalized.message}\n`,
  );
  process.exitCode = 1;
});
