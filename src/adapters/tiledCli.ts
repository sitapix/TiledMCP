import { execFile, type ExecException, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import {
  constants as fsConstants,
  type BigIntStats,
} from "node:fs";
import { lstat, open } from "node:fs/promises";

import { TiledMcpError, asTiledMcpError } from "../errors.js";
import {
  isTiledMcpCapabilityIssueCode,
  type TiledMcpCapabilityIssueCode,
} from "../errorRegistry.js";
import { decodeSafeImageRgba } from "../images/safeImage.js";
import {
  MAX_RASTER_PNG_BYTES,
  MAX_RASTER_RENDER_EDGE,
  MAX_RENDERER_VERSION_LENGTH,
} from "../rasterContract.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RENDER_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const ERROR_OUTPUT_EXCERPT_LENGTH = 4_096;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SAFE_RASTER_OUTPUT_OPEN_FLAGS =
  fsConstants.O_RDONLY |
  fsConstants.O_NOFOLLOW |
  fsConstants.O_NONBLOCK;
const VERSION_TOKEN_PATTERN =
  "[0-9]+(?:\\.[0-9]+){1,3}(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?";

type ToolKind = "tiled" | "rasterizer";
type CommandErrorCode = Exclude<
  TiledMcpCapabilityIssueCode,
  | "INTERNAL_ERROR"
  | "TILED_CLI_UNEXPECTED_OUTPUT"
  | "TMXRASTERIZER_UNEXPECTED_OUTPUT"
>;

const COMMAND_ERROR_CODES = {
  tiled: {
    failed: "TILED_CLI_FAILED",
    notExecutable: "TILED_CLI_NOT_EXECUTABLE",
    notFound: "TILED_CLI_NOT_FOUND",
    outputLimit: "TILED_CLI_OUTPUT_LIMIT",
    timeout: "TILED_CLI_TIMEOUT",
  },
  rasterizer: {
    failed: "TMXRASTERIZER_FAILED",
    notExecutable: "TMXRASTERIZER_NOT_EXECUTABLE",
    notFound: "TMXRASTERIZER_NOT_FOUND",
    outputLimit: "TMXRASTERIZER_OUTPUT_LIMIT",
    timeout: "TMXRASTERIZER_TIMEOUT",
  },
} as const satisfies Record<
  ToolKind,
  Record<string, CommandErrorCode>
>;

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
  code: TiledMcpCapabilityIssueCode;
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
  maxPngBytes?: number;
  scale?: number;
  tileSize?: number;
  size?: number;
  antiAliasing?: boolean;
  noSmoothing?: boolean;
  ignoreVisibility?: boolean;
}

export interface RenderPngResult {
  outputPath: string;
  png: Buffer;
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
    return parseVersion(
      result,
      "Tiled",
      "TILED_CLI_UNEXPECTED_OUTPUT",
    );
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
    return parseVersion(
      result,
      "TmxRasterizer",
      "TMXRASTERIZER_UNEXPECTED_OUTPUT",
      true,
    );
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
        { option: "outputPngPath" },
      );
    }
    const maxPngBytes = requirePositiveInteger(
      options.maxPngBytes ?? MAX_RASTER_PNG_BYTES,
      "maxPngBytes",
    );

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

    return inspectPng(
      outputPngPath,
      maxPngBytes,
    );
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
  unexpectedOutputCode:
    | "TILED_CLI_UNEXPECTED_OUTPUT"
    | "TMXRASTERIZER_UNEXPECTED_OUTPUT",
  requireProductName = false,
): string {
  const output = [result.stdout.trim(), result.stderr.trim()]
    .filter((part) => part.length > 0)
    .join("\n");
  const escapedName = productName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const productPattern = new RegExp(
    `^${escapedName}\\s+(${VERSION_TOKEN_PATTERN})$`,
    "i",
  );
  const matchedVersion = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .map(
      (line) =>
        productPattern.exec(line)?.[1],
    )
    .find(
      (value): value is string =>
        value !== undefined,
    );

  const version =
    matchedVersion ??
    (!requireProductName && output.length > 0
      ? output
      : undefined);
  if (
    version !== undefined &&
    version.length <=
      MAX_RENDERER_VERSION_LENGTH
  ) {
    return version;
  }
  throw new TiledMcpError(
    unexpectedOutputCode,
    `${productName} returned no bounded recognizable version information.`,
    { output: excerpt(output) },
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
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
  error: ExecException,
  stdout: string,
  stderr: string,
): TiledMcpError {
  const displayName = tool === "tiled" ? "Tiled CLI" : "TmxRasterizer";
  const codes = COMMAND_ERROR_CODES[tool];
  const details = {
    argumentCount: args.length,
    exitCode: error.code ?? null,
    signal: error.signal ?? null,
    stdoutBytes: Buffer.byteLength(
      stdout,
      "utf8",
    ),
    stderrBytes: Buffer.byteLength(
      stderr,
      "utf8",
    ),
  };

  if (error.code === "ENOENT") {
    return new TiledMcpError(
      codes.notFound,
      `${displayName} executable was not found.`,
      details,
    );
  }
  if (error.code === "EACCES") {
    return new TiledMcpError(
      codes.notExecutable,
      `${displayName} cannot be executed.`,
      details,
    );
  }
  if (
    error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    /maxBuffer length exceeded/iu.test(error.message)
  ) {
    return new TiledMcpError(
      codes.outputLimit,
      `${displayName} exceeded the ${String(maxOutputBytes)}-byte command-output safety limit.`,
      details,
    );
  }
  if (error.killed === true && error.signal === "SIGTERM") {
    return new TiledMcpError(
      codes.timeout,
      `${displayName} did not finish within ${String(timeoutMs)} ms.`,
      details,
    );
  }
  return new TiledMcpError(
    codes.failed,
    `${displayName} exited unsuccessfully.`,
    details,
  );
}

async function inspectPng(
  outputPngPath: string,
  maxPngBytes: number,
): Promise<RenderPngResult> {
  try {
    const pathStat = await lstat(
      outputPngPath,
    );
    if (!pathStat.isFile()) {
      throw new TiledMcpError(
        "TMXRASTERIZER_OUTPUT_INVALID",
        "TmxRasterizer output path is not a regular non-symlink file.",
        { reason: "not-regular-file" },
      );
    }
    const handle = await open(
      outputPngPath,
      SAFE_RASTER_OUTPUT_OPEN_FLAGS,
    );
    try {
      const fileStat = await handle.stat({
        bigint: true,
      });
      if (!fileStat.isFile()) {
        throw new TiledMcpError(
          "TMXRASTERIZER_OUTPUT_INVALID",
          "TmxRasterizer output is not a regular file.",
          { reason: "opened-file-not-regular" },
        );
      }
      if (
        fileStat.size >
        BigInt(maxPngBytes)
      ) {
        throw new TiledMcpError(
          "IMAGE_TOO_LARGE",
          `TmxRasterizer output is ${fileStat.size.toString()} bytes; PNG limit is ${maxPngBytes}.`,
          {
            bytes:
              fileStat.size.toString(),
            limit: maxPngBytes,
          },
        );
      }

      const png = Buffer.alloc(
        Number(fileStat.size),
      );
      let offset = 0;
      while (offset < png.byteLength) {
        const readResult = await handle.read(
          png,
          offset,
          png.byteLength - offset,
          offset,
        );
        if (readResult.bytesRead === 0) {
          break;
        }
        offset += readResult.bytesRead;
      }
      const currentStat = await handle.stat({
        bigint: true,
      });
      if (
        offset !== png.byteLength ||
        !sameRasterOutputSnapshot(
          fileStat,
          currentStat,
        ) ||
        png.byteLength < 24 ||
        !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
        png.toString("ascii", 12, 16) !== "IHDR"
      ) {
        throw new TiledMcpError(
          "TMXRASTERIZER_OUTPUT_INVALID",
          "TmxRasterizer did not produce a stable valid PNG file.",
          {
            reason:
              "unstable-or-invalid-png",
          },
        );
      }
      let decoded;
      try {
        decoded = await decodeSafeImageRgba({
          bytes: png,
          path: outputPngPath,
          limits: {
            maxInputBytes:
              maxPngBytes,
            maxInputPixels:
              MAX_RASTER_RENDER_EDGE *
              MAX_RASTER_RENDER_EDGE,
            maxInputEdge:
              MAX_RASTER_RENDER_EDGE,
          },
        });
      } catch {
        throw new TiledMcpError(
          "TMXRASTERIZER_OUTPUT_INVALID",
          "TmxRasterizer produced a corrupt or oversized PNG file.",
          { reason: "decode-failed" },
        );
      }
      if (
        decoded.format !== "png" ||
        decoded.width !==
          png.readUInt32BE(16) ||
        decoded.height !==
          png.readUInt32BE(20)
      ) {
        throw new TiledMcpError(
          "TMXRASTERIZER_OUTPUT_INVALID",
          "TmxRasterizer PNG metadata is missing or inconsistent.",
          { reason: "metadata-mismatch" },
        );
      }

      return {
        outputPath: outputPngPath,
        png,
        bytes: png.byteLength,
        width: decoded.width,
        height: decoded.height,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof TiledMcpError) {
      throw error;
    }
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    if (errorCode !== "ENOENT") {
      throw new TiledMcpError(
        "TMXRASTERIZER_OUTPUT_INVALID",
        "TmxRasterizer output could not be opened and read safely.",
        { reason: "open-or-read-failed" },
      );
    }
    throw new TiledMcpError(
      "TMXRASTERIZER_OUTPUT_MISSING",
      "TmxRasterizer exited successfully but its PNG output could not be read.",
      { reason: "missing-output" },
    );
  }
}

function sameRasterOutputSnapshot(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function toProbeIssue(error: unknown): CapabilityProbeIssue {
  try {
    const normalized = asTiledMcpError(error);
    if (
      isTiledMcpCapabilityIssueCode(
        normalized.code,
      ) &&
      normalized.code !== "INTERNAL_ERROR"
    ) {
      return {
        code: normalized.code,
        message: normalized.message,
      };
    }
  } catch {
    // The fixed fallback below must not inspect the rejected value.
  }
  return {
    code: "INTERNAL_ERROR",
    message: "Tiled capability probe failed internally.",
  };
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
