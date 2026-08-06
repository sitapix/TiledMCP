import { resolve } from "node:path";

import { TiledMcpError } from "./errors.js";
import {
  DEFAULT_CHECKPOINT_STORAGE_BYTES,
  MAX_CHECKPOINT_OBSERVED_ENTRIES,
  MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT,
} from "./storage/checkpoints.js";

export interface ServerConfig {
  /**
   * Absent exactly when neither --project-dir nor TILED_PROJECT_DIR was
   * given; startup then defers to the client's MCP roots and fails closed
   * if the client cannot supply one.
   */
  projectDir: string | undefined;
  tiledCliPath: string;
  rasterizerPath: string;
  checkpointBytes: number;
  retainCommittedPerTarget: number | undefined;
}

export function loadConfig(argv: readonly string[], env: NodeJS.ProcessEnv): ServerConfig {
  const options = parseOptions(argv);
  const projectArg = options.get("--project-dir");
  const projectDir = projectArg ?? env.TILED_PROJECT_DIR;

  return {
    projectDir: projectDir ? resolve(projectDir) : undefined,
    tiledCliPath: options.get("--tiled-cli") ?? env.TILED_CLI_PATH ?? "tiled",
    rasterizerPath:
      options.get("--rasterizer") ?? env.TILED_RASTERIZER_PATH ?? "tmxrasterizer",
    checkpointBytes: parseCheckpointBytes(
      options.get("--checkpoint-bytes") ?? env.TILEDMCP_CHECKPOINT_BYTES,
    ),
    retainCommittedPerTarget: parseCheckpointRetentionCount(
      options.get("--checkpoint-retain-per-target") ??
        env.TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET,
    ),
  };
}

export function helpText(): string {
  return [
    "Usage: tiled-mcp-server [--project-dir <path>] [options]",
    "",
    "Options:",
    "  --project-dir <path>  Project sandbox root (env: TILED_PROJECT_DIR).",
    "                        When omitted, the client's first MCP root is used;",
    "                        startup fails closed if the client offers none.",
    "  --tiled-cli <path>    Tiled executable (default: tiled)",
    "  --rasterizer <path>   TmxRasterizer executable (default: tmxrasterizer)",
    `  --checkpoint-bytes <bytes>  Checkpoint storage quota ` +
      `(default: ${DEFAULT_CHECKPOINT_STORAGE_BYTES}; env: TILEDMCP_CHECKPOINT_BYTES; ` +
      "CLI overrides env)",
    `                              Canonical [1-9][0-9]*, range ` +
      `1..${Number.MAX_SAFE_INTEGER}`,
    `  --checkpoint-retain-per-target <N>  Enable rolling post-commit retention ` +
      "for committed existing-file checkpoints per target",
    `                              Disabled by default; env: ` +
      "TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET; CLI overrides env",
    `                              Canonical [1-9][0-9]*, range ` +
      `${MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT}..${MAX_CHECKPOINT_OBSERVED_ENTRIES}`,
    "                              This process-startup option is standing approval to delete",
    "                              at most one oldest eligible rolling checkpoint after each",
    "                              successful checkpoint commit; results appear in checkpointRetention",
    "                              Existing excess is not reduced by one-add/one-delete commits;",
    "                              use explicitly approved prune to clear a retention backlog",
    "                              Legacy, protected, and prepared manifests are always retained;",
    "                              startup, periodic, and quota-pressure retention are disabled",
    "  --help                Show this help",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Map<string, string> {
  const allowed = new Set([
    "--project-dir",
    "--tiled-cli",
    "--rasterizer",
    "--checkpoint-bytes",
    "--checkpoint-retain-per-target",
  ]);
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option || !allowed.has(option)) {
      throw new TiledMcpError("INVALID_ARGUMENT", `Unknown option: ${option ?? ""}`);
    }
    if (options.has(option)) {
      throw new TiledMcpError("INVALID_ARGUMENT", `Duplicate option: ${option}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new TiledMcpError("INVALID_ARGUMENT", `${option} requires a value.`);
    }
    options.set(option, value);
    index += 1;
  }
  return options;
}

function parseCheckpointBytes(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_CHECKPOINT_STORAGE_BYTES;
  }
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `Checkpoint storage quota must use canonical decimal [1-9][0-9]* ` +
        `in the range 1..${Number.MAX_SAFE_INTEGER}.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `Checkpoint storage quota must use canonical decimal [1-9][0-9]* ` +
        `in the range 1..${Number.MAX_SAFE_INTEGER}.`,
    );
  }
  return parsed;
}

function parseCheckpointRetentionCount(
  value: string | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const message =
    `Automatic checkpoint retention must use canonical decimal [1-9][0-9]* ` +
    `in the range ${MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT}..` +
    `${MAX_CHECKPOINT_OBSERVED_ENTRIES}.`;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new TiledMcpError("INVALID_ARGUMENT", message);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT ||
    parsed > MAX_CHECKPOINT_OBSERVED_ENTRIES
  ) {
    throw new TiledMcpError("INVALID_ARGUMENT", message);
  }
  return parsed;
}
