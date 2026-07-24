import { execFile, type ExecException, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { open, stat } from "node:fs/promises";

import { TiledMcpError, asTiledMcpError } from "../errors.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RENDER_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const ERROR_OUTPUT_EXCERPT_LENGTH = 4_096;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type ToolKind = "tiled" | "rasterizer";

export interface TiledCliAdapterOptions {
  tiledCliPath: string;
  rasterizerPath: string;
  timeoutMs?: number;
  renderTimeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface TiledExportFormats {
  map: string[];
  tileset: string[];
}

export interface CapabilityProbeIssue {
  code: string;
  message: string;
}

export interface TiledCliCapabilities {
  tiled: {
    executable: string;
    available: boolean;
    version: string | null;
    mapExportFormats: string[];
    tilesetExportFormats: string[];
    issues: CapabilityProbeIssue[];
  };
  rasterizer: {
    executable: string;
    available: boolean;
    version: string | null;
    issues: CapabilityProbeIssue[];
  };
}

export interface RenderPngOptions {
  timeoutMs?: number;
  scale?: number;
  tileSize?: number;
  size?: number;
  antiAliasing?: boolean;
  noSmoothing?: boolean;
  ignoreVisibility?: boolean;
}

export interface RenderPngResult {
  outputPath: string;
  bytes: number;
  width: number;
  height: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CommandOptions {
  timeoutMs: number;
}

/**
 * Thin, bounded wrapper around Tiled's command-line programs.
 *
 * It deliberately uses execFile without a shell. Project-path validation belongs
 * to the caller, because this adapter also needs to support absolute paths to
 * server-owned temporary files.
 */
export class TiledCliAdapter {
  readonly tiledCliPath: string;
  readonly rasterizerPath: string;

  private readonly timeoutMs: number;
  private readonly renderTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: TiledCliAdapterOptions) {
    this.tiledCliPath = requireExecutable(options.tiledCliPath, "tiledCliPath");
    this.rasterizerPath = requireExecutable(options.rasterizerPath, "rasterizerPath");
    this.timeoutMs = requirePositiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    this.renderTimeoutMs = requirePositiveInteger(
      options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS,
      "renderTimeoutMs",
    );
    this.maxOutputBytes = requirePositiveInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );

    this.environment = {
      ...process.env,
      ...options.env,
      // Tiled localizes --export-formats headings. Pin the subprocess locale
      // so capability parsing is deterministic across desktop environments.
      LANG: "C",
      LC_ALL: "C",
    };
    if (!this.environment.QT_QPA_PLATFORM) {
      this.environment.QT_QPA_PLATFORM = "offscreen";
    }
  }

  async getTiledVersion(): Promise<string> {
    const result = await this.run(
      "tiled",
      this.tiledCliPath,
      ["--version"],
      { timeoutMs: this.timeoutMs },
    );
    return parseVersion(result, "Tiled", "TILED_CLI");
  }

  async getExportFormats(): Promise<TiledExportFormats> {
    const result = await this.run(
      "tiled",
      this.tiledCliPath,
      ["--export-formats"],
      { timeoutMs: this.timeoutMs },
    );
    return parseExportFormats(result);
  }

  async getRasterizerVersion(): Promise<string> {
    const result = await this.run(
      "rasterizer",
      this.rasterizerPath,
      ["--version"],
      { timeoutMs: this.timeoutMs },
    );
    return parseVersion(result, "TmxRasterizer", "TMXRASTERIZER");
  }

  /**
   * Probes each capability independently so one missing executable does not hide
   * useful information about the other.
   */
  async probeCapabilities(): Promise<TiledCliCapabilities> {
    const [tiledVersion, exportFormats, rasterizerVersion] = await Promise.allSettled([
      this.getTiledVersion(),
      this.getExportFormats(),
      this.getRasterizerVersion(),
    ] as const);

    const tiledIssues: CapabilityProbeIssue[] = [];
    const rasterizerIssues: CapabilityProbeIssue[] = [];

    if (tiledVersion.status === "rejected") {
      tiledIssues.push(toProbeIssue(tiledVersion.reason));
    }
    if (exportFormats.status === "rejected") {
      tiledIssues.push(toProbeIssue(exportFormats.reason));
    }
    if (rasterizerVersion.status === "rejected") {
      rasterizerIssues.push(toProbeIssue(rasterizerVersion.reason));
    }

    const formats =
      exportFormats.status === "fulfilled"
        ? exportFormats.value
        : { map: [], tileset: [] };

    return {
      tiled: {
        executable: this.tiledCliPath,
        available:
          tiledVersion.status === "fulfilled" || exportFormats.status === "fulfilled",
        version: tiledVersion.status === "fulfilled" ? tiledVersion.value : null,
        mapExportFormats: formats.map,
        tilesetExportFormats: formats.tileset,
        issues: uniqueIssues(tiledIssues),
      },
      rasterizer: {
        executable: this.rasterizerPath,
        available: rasterizerVersion.status === "fulfilled",
        version:
          rasterizerVersion.status === "fulfilled" ? rasterizerVersion.value : null,
        issues: rasterizerIssues,
      },
    };
  }

  async renderPng(
    inputMapPath: string,
    outputPngPath: string,
    options: RenderPngOptions = {},
  ): Promise<RenderPngResult> {
    requirePath(inputMapPath, "inputMapPath");
    requirePath(outputPngPath, "outputPngPath");
    if (!outputPngPath.toLocaleLowerCase("en-US").endsWith(".png")) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "TmxRasterizer output must use a .png filename.",
        { outputPngPath },
      );
    }

    const args = renderArguments(inputMapPath, outputPngPath, options);
    await this.run(
      "rasterizer",
      this.rasterizerPath,
      args,
      {
        timeoutMs:
          options.timeoutMs === undefined
            ? this.renderTimeoutMs
            : requirePositiveInteger(options.timeoutMs, "timeoutMs"),
      },
    );

    return inspectPng(outputPngPath);
  }

  private run(
    tool: ToolKind,
    executable: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    const execOptions: ExecFileOptionsWithStringEncoding = {
      encoding: "utf8",
      env: this.environment,
      killSignal: "SIGTERM",
      maxBuffer: this.maxOutputBytes,
      shell: false,
      timeout: options.timeoutMs,
      windowsHide: true,
    };

    return new Promise((resolve, reject) => {
      execFile(executable, args, execOptions, (error, stdout, stderr) => {
        if (error) {
          reject(
            commandError(
              tool,
              executable,
              args,
              options.timeoutMs,
              this.maxOutputBytes,
              error,
              stdout,
              stderr,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}

function renderArguments(
  inputMapPath: string,
  outputPngPath: string,
  options: RenderPngOptions,
): string[] {
  const sizingOptions = [
    options.scale === undefined ? null : "scale",
    options.tileSize === undefined ? null : "tileSize",
    options.size === undefined ? null : "size",
  ].filter((value): value is string => value !== null);

  if (sizingOptions.length > 1) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "Specify only one of scale, tileSize, or size.",
      { conflictingOptions: sizingOptions },
    );
  }

  const args: string[] = [];
  if (options.scale !== undefined) {
    args.push("--scale", String(requirePositiveNumber(options.scale, "scale")));
  }
  if (options.tileSize !== undefined) {
    args.push(
      "--tilesize",
      String(requirePositiveInteger(options.tileSize, "tileSize")),
    );
  }
  if (options.size !== undefined) {
    args.push("--size", String(requirePositiveInteger(options.size, "size")));
  }
  if (options.antiAliasing === true) {
    args.push("--anti-aliasing");
  }
  if (options.noSmoothing === true) {
    args.push("--no-smoothing");
  }
  if (options.ignoreVisibility === true) {
    args.push("--ignore-visibility");
  }

  args.push(inputMapPath, outputPngPath);
  return args;
}

function parseVersion(
  result: CommandResult,
  productName: string,
  errorPrefix: "TILED_CLI" | "TMXRASTERIZER",
): string {
  const output = [result.stdout.trim(), result.stderr.trim()]
    .filter((part) => part.length > 0)
    .join("\n");
  const escapedName = productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escapedName}\\s+([^\\s]+)`, "i").exec(output);

  if (match?.[1]) {
    return match[1];
  }
  if (output.length > 0) {
    return output;
  }
  throw new TiledMcpError(
    `${errorPrefix}_UNEXPECTED_OUTPUT`,
    `${productName} returned no version information.`,
  );
}

function parseExportFormats(result: CommandResult): TiledExportFormats {
  const output = `${result.stdout}\n${result.stderr}`;
  const map: string[] = [];
  const tileset: string[] = [];
  let section: "map" | "tileset" | null = null;

  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (/^map export formats\s*:/iu.test(line)) {
      section = "map";
      continue;
    }
    if (/^tileset export formats\s*:/iu.test(line)) {
      section = "tileset";
      continue;
    }
    if (line.endsWith(":")) {
      section = null;
      continue;
    }
    if (!section || line.length === 0) {
      continue;
    }

    const format = line.split(/\s+/u)[0];
    if (!format) {
      continue;
    }
    const formats = section === "map" ? map : tileset;
    if (!formats.includes(format)) {
      formats.push(format);
    }
  }

  if (map.length === 0 && tileset.length === 0) {
    throw new TiledMcpError(
      "TILED_CLI_UNEXPECTED_OUTPUT",
      "Tiled did not return a recognizable export-format list.",
      { output: excerpt(output) },
    );
  }
  return { map, tileset };
}

function commandError(
  tool: ToolKind,
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
  error: ExecException,
  stdout: string,
  stderr: string,
): TiledMcpError {
  const prefix = tool === "tiled" ? "TILED_CLI" : "TMXRASTERIZER";
  const displayName = tool === "tiled" ? "Tiled CLI" : "TmxRasterizer";
  const details = {
    executable,
    args: [...args],
    exitCode: error.code ?? null,
    signal: error.signal ?? null,
    stdout: excerpt(stdout),
    stderr: excerpt(stderr),
  };

  if (error.code === "ENOENT") {
    return new TiledMcpError(
      `${prefix}_NOT_FOUND`,
      `${displayName} executable was not found at "${executable}".`,
      details,
    );
  }
  if (error.code === "EACCES") {
    return new TiledMcpError(
      `${prefix}_NOT_EXECUTABLE`,
      `${displayName} cannot be executed at "${executable}".`,
      details,
    );
  }
  if (
    error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    /maxBuffer length exceeded/iu.test(error.message)
  ) {
    return new TiledMcpError(
      `${prefix}_OUTPUT_LIMIT`,
      `${displayName} exceeded the ${String(maxOutputBytes)}-byte command-output safety limit.`,
      details,
    );
  }
  if (error.killed === true && error.signal === "SIGTERM") {
    return new TiledMcpError(
      `${prefix}_TIMEOUT`,
      `${displayName} did not finish within ${String(timeoutMs)} ms.`,
      details,
    );
  }
  return new TiledMcpError(
    `${prefix}_FAILED`,
    `${displayName} exited unsuccessfully.`,
    details,
  );
}

async function inspectPng(outputPngPath: string): Promise<RenderPngResult> {
  try {
    const fileStat = await stat(outputPngPath);
    if (!fileStat.isFile()) {
      throw new TiledMcpError(
        "TMXRASTERIZER_OUTPUT_INVALID",
        "TmxRasterizer output is not a regular file.",
        { outputPngPath },
      );
    }

    const header = Buffer.alloc(24);
    const handle = await open(outputPngPath, "r");
    try {
      const readResult = await handle.read(header, 0, header.length, 0);
      if (
        readResult.bytesRead < header.length ||
        !header.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
        header.toString("ascii", 12, 16) !== "IHDR"
      ) {
        throw new TiledMcpError(
          "TMXRASTERIZER_OUTPUT_INVALID",
          "TmxRasterizer did not produce a valid PNG file.",
          { outputPngPath },
        );
      }
    } finally {
      await handle.close();
    }

    return {
      outputPath: outputPngPath,
      bytes: fileStat.size,
      width: header.readUInt32BE(16),
      height: header.readUInt32BE(20),
    };
  } catch (error) {
    if (error instanceof TiledMcpError) {
      throw error;
    }
    const cause = asTiledMcpError(error);
    throw new TiledMcpError(
      "TMXRASTERIZER_OUTPUT_MISSING",
      "TmxRasterizer exited successfully but its PNG output could not be read.",
      { outputPngPath, cause: cause.message },
    );
  }
}

function toProbeIssue(error: unknown): CapabilityProbeIssue {
  const normalized = asTiledMcpError(error);
  return { code: normalized.code, message: normalized.message };
}

function uniqueIssues(issues: readonly CapabilityProbeIssue[]): CapabilityProbeIssue[] {
  return issues.filter(
    (issue, index) =>
      issues.findIndex(
        (candidate) =>
          candidate.code === issue.code && candidate.message === issue.message,
      ) === index,
  );
}

function requireExecutable(value: string, optionName: string): string {
  if (value.trim().length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${optionName} must be a non-empty executable name or path.`,
    );
  }
  return value;
}

function requirePath(value: string, optionName: string): void {
  if (value.trim().length === 0) {
    throw new TiledMcpError("INVALID_ARGUMENT", `${optionName} must not be empty.`);
  }
}

function requirePositiveInteger(value: number, optionName: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${optionName} must be a positive safe integer.`,
      { [optionName]: value },
    );
  }
  return value;
}

function requirePositiveNumber(value: number, optionName: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${optionName} must be a positive finite number.`,
      { [optionName]: value },
    );
  }
  return value;
}

function excerpt(value: string): string {
  if (value.length <= ERROR_OUTPUT_EXCERPT_LENGTH) {
    return value;
  }
  return `${value.slice(0, ERROR_OUTPUT_EXCERPT_LENGTH)}…`;
}
