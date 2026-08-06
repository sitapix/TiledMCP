import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  TiledCliAdapter,
  type TiledCliCapabilities,
} from "./adapters/tiledCli.js";
import type { ServerConfig } from "./config.js";
import { TiledMcpError } from "./errors.js";
import { GatedTransport } from "./gatedTransport.js";
import { MapService } from "./maps/mapService.js";
import { ProjectPathResolver } from "./project/pathResolver.js";
import {
  createTiledMcpServerShell,
  wireTiledMcpServer,
  wireTiledMcpServerFromCapabilitySnapshot,
  type CreatedTiledMcpServer,
} from "./server.js";
import { DocumentStore } from "./storage/documentStore.js";

export interface BootedTiledMcpServer extends CreatedTiledMcpServer {
  projectDir: string;
}

export interface BootOptions {
  config: ServerConfig;
  transport: Transport;
  /** Test injection; the real boot probes PATH when this is absent. */
  cliCapabilities?: TiledCliCapabilities;
  /** Defaults to stderr; stdout is MCP protocol only. */
  log?: (line: string) => void;
}

/**
 * Start the server over one transport, resolving the project sandbox from
 * `--project-dir` / `TILED_PROJECT_DIR` when configured, and otherwise from
 * the connected client's MCP roots.
 *
 * The roots path has a chicken-and-egg constraint: roots can only be
 * requested after `initialize`, but the project-bound tools cannot register
 * until the sandbox exists. The boot therefore connects a dependency-free
 * shell through a {@link GatedTransport}, answers the handshake, asks for
 * roots, wires the tools, and only then releases the buffered traffic -- so
 * the client's first `tools/list` always sees the full surface. A client
 * that neither supplies roots nor was started with a project dir fails
 * closed.
 */
export async function bootTiledMcpServer(
  options: BootOptions,
): Promise<BootedTiledMcpServer> {
  const log =
    options.log ??
    ((line: string) => process.stderr.write(`${line}\n`));

  if (options.config.projectDir !== undefined) {
    const shell = createTiledMcpServerShell();
    const created = await wireProject(
      shell,
      options,
      options.config.projectDir,
      log,
    );
    await shell.connect(options.transport);
    return created;
  }

  const shell = createTiledMcpServerShell();
  const gate = new GatedTransport(options.transport);
  const initialized = new Promise<void>((resolve, reject) => {
    shell.server.oninitialized = () => {
      resolve();
    };
    shell.server.onclose = () => {
      reject(
        new TiledMcpError(
          "PROJECT_ROOT_REQUIRED",
          "The connection closed before the client completed initialization, so no project root could be resolved from its MCP roots.",
        ),
      );
    };
  });
  try {
    await shell.connect(gate);
    await initialized;
    const projectDir = await projectDirFromClientRoots(shell, log);
    const created = await wireProject(shell, options, projectDir, log);
    gate.release();
    return created;
  } catch (error) {
    await shell.close().catch(() => undefined);
    throw error;
  }
}

async function projectDirFromClientRoots(
  shell: McpServer,
  log: (line: string) => void,
): Promise<string> {
  const capabilities = shell.server.getClientCapabilities();
  if (capabilities?.roots === undefined) {
    throw new TiledMcpError(
      "PROJECT_ROOT_REQUIRED",
      "No project root was configured and the connected client does not advertise MCP roots. Pass --project-dir <path>, set TILED_PROJECT_DIR, or connect with a client that supplies roots.",
    );
  }
  let roots;
  try {
    roots = (await shell.server.listRoots()).roots;
  } catch (error) {
    throw new TiledMcpError(
      "PROJECT_ROOT_REQUIRED",
      `The client advertises MCP roots but its roots/list request failed: ${error instanceof Error ? error.message : String(error)}. Pass --project-dir <path> instead.`,
    );
  }
  const fileRoots = roots.filter((root) =>
    root.uri.startsWith("file://"),
  );
  const first = fileRoots[0];
  if (first === undefined) {
    throw new TiledMcpError(
      "PROJECT_ROOT_REQUIRED",
      "No project root was configured and the client returned no file:// MCP root. Pass --project-dir <path> or open the client inside the Tiled project.",
    );
  }
  if (fileRoots.length > 1) {
    log(
      `tiled-mcp: client offered ${fileRoots.length} roots; sandboxing to the first (${first.uri})`,
    );
  }
  return fileURLToPath(first.uri);
}

async function wireProject(
  shell: McpServer,
  options: BootOptions,
  projectDir: string,
  log: (line: string) => void,
): Promise<BootedTiledMcpServer> {
  const { config } = options;
  const resolver = await ProjectPathResolver.create(projectDir);
  const store = new DocumentStore(
    resolver,
    undefined,
    undefined,
    {
      maxBytes: config.checkpointBytes,
      ...(config.retainCommittedPerTarget === undefined
        ? {}
        : {
            retainCommittedPerTarget:
              config.retainCommittedPerTarget,
          }),
    },
  );
  const transactionReport =
    await store.recoverTransactions();
  log(
    [
      "tiled-mcp: transaction recovery",
      `scanned=${transactionReport.scannedManifests}`,
      `rolledBack=${transactionReport.rolledBack}`,
      `rolledForward=${transactionReport.rolledForwardTargets}`,
      `alreadyComplete=${transactionReport.alreadyCompleteTargets}`,
      `conflicts=${transactionReport.conflicts.length}`,
      `corrupt=${transactionReport.corruptManifests.length}`,
      `sweptStaged=${transactionReport.sweptStagedObjects}`,
    ].join(" "),
  );
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
  log(
    [
      "tiled-mcp: checkpoint scan",
      `scanned=${checkpointReport.scannedEntries}`,
      `reconciled=${reconciliationCounts.reconciled}`,
      `writeDidNotLand=${reconciliationCounts.writeDidNotLand}`,
      `conflicts=${reconciliationCounts.conflicts}`,
      `corrupt=${checkpointReport.corruptEntries.length}`,
      `errors=${reconciliationCounts.errors}`,
      `truncated=${checkpointReport.truncated}`,
    ].join(" "),
  );
  const maps = new MapService(resolver, store);
  const cli = new TiledCliAdapter({
    tiledCliPath: config.tiledCliPath,
    rasterizerPath: config.rasterizerPath,
  });
  const dependencies = { resolver, store, maps, cli };
  const created =
    options.cliCapabilities === undefined
      ? await wireTiledMcpServer(shell, dependencies)
      : await wireTiledMcpServerFromCapabilitySnapshot(
          shell,
          dependencies,
          options.cliCapabilities,
        );
  return { ...created, projectDir: resolver.root };
}
