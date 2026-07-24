#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { TiledCliAdapter } from "./adapters/tiledCli.js";
import { helpText, loadConfig } from "./config.js";
import { asTiledMcpError } from "./errors.js";
import { MapService } from "./maps/mapService.js";
import { ProjectPathResolver } from "./project/pathResolver.js";
import { createTiledMcpServer } from "./server.js";
import { DocumentStore } from "./storage/documentStore.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  const config = loadConfig(argv, process.env);
  const resolver = await ProjectPathResolver.create(config.projectDir);
  const store = new DocumentStore(resolver);
  const checkpointReport = await store.reconcilePreparedCheckpoints();
  const reconciliationCounts = {
    reconciled: checkpointReport.outcomes.filter(
      ({ outcome }) => outcome === "reconciled",
    ).length,
    writeDidNotLand: checkpointReport.outcomes.filter(
      ({ outcome }) => outcome === "writeDidNotLand",
    ).length,
    conflicts: checkpointReport.outcomes.filter(
      ({ outcome }) => outcome === "conflict",
    ).length,
    errors: checkpointReport.outcomes.filter(
      ({ outcome }) => outcome === "error",
    ).length,
  };
  process.stderr.write(
    [
      "tiled-mcp: checkpoint scan",
      `scanned=${checkpointReport.scannedEntries}`,
      `reconciled=${reconciliationCounts.reconciled}`,
      `writeDidNotLand=${reconciliationCounts.writeDidNotLand}`,
      `conflicts=${reconciliationCounts.conflicts}`,
      `corrupt=${checkpointReport.corruptEntries.length}`,
      `errors=${reconciliationCounts.errors}`,
      `truncated=${checkpointReport.truncated}`,
    ].join(" ") + "\n",
  );
  const maps = new MapService(resolver, store);
  const cli = new TiledCliAdapter({
    tiledCliPath: config.tiledCliPath,
    rasterizerPath: config.rasterizerPath,
  });
  const { server, registeredTools } = await createTiledMcpServer({
    resolver,
    store,
    maps,
    cli,
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION} ready for ${resolver.root} (${registeredTools.length} tools)\n`,
  );
}

main().catch((error: unknown) => {
  const normalized = asTiledMcpError(error);
  process.stderr.write(
    `tiled-mcp: ${normalized.code}: ${normalized.message}\n`,
  );
  process.exitCode = 1;
});
