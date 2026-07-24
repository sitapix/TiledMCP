import { resolve } from "node:path";

import { TiledMcpError } from "./errors.js";

export interface ServerConfig {
  projectDir: string;
  tiledCliPath: string;
  rasterizerPath: string;
}

export function loadConfig(argv: readonly string[], env: NodeJS.ProcessEnv): ServerConfig {
  const options = parseOptions(argv);
  const projectArg = options.get("--project-dir");
  const projectDir = projectArg ?? env.TILED_PROJECT_DIR;

  if (!projectDir) {
    throw new TiledMcpError(
      "PROJECT_ROOT_REQUIRED",
      "A project root is required. Pass --project-dir <path> or set TILED_PROJECT_DIR.",
    );
  }

  return {
    projectDir: resolve(projectDir),
    tiledCliPath: options.get("--tiled-cli") ?? env.TILED_CLI_PATH ?? "tiled",
    rasterizerPath:
      options.get("--rasterizer") ?? env.TILED_RASTERIZER_PATH ?? "tmxrasterizer",
  };
}

export function helpText(): string {
  return [
    "Usage: tiled-mcp --project-dir <path> [options]",
    "",
    "Options:",
    "  --project-dir <path>  Required project sandbox root",
    "  --tiled-cli <path>    Tiled executable (default: tiled)",
    "  --rasterizer <path>   TmxRasterizer executable (default: tmxrasterizer)",
    "  --help                Show this help",
  ].join("\n");
}

function parseOptions(argv: readonly string[]): Map<string, string> {
  const allowed = new Set(["--project-dir", "--tiled-cli", "--rasterizer"]);
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
