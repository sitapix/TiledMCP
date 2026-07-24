import {
  execFile,
  spawnSync,
} from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import { MapService } from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const execFileAsync = promisify(execFile);

const EXPECTED_TILED_BANNER = "Tiled 1.12.2";
const REQUIRED_GATE_ENV =
  "TILEDMCP_REQUIRE_TILED_1_12_2";
const TILED_EXECUTABLE =
  process.env.TILED_CLI_PATH ?? "tiled";
const RASTERIZER_EXECUTABLE =
  process.env.TILED_RASTERIZER_PATH ??
  "tmxrasterizer";
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47,
  0x0d, 0x0a, 0x1a, 0x0a,
]);

const integrationEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  LANG: "C",
  LC_ALL: "C",
  QT_QPA_PLATFORM: "offscreen",
};

type IntegrationPreflight =
  | { ready: true }
  | {
      ready: false;
      reason: string;
      skippable: boolean;
    };

const preflight = probeIntegrationTools();
const gateRequired = readGateRequired();
const skipOptionalGate =
  !gateRequired &&
  !preflight.ready &&
  preflight.skippable;
const suiteName = preflight.ready
  ? "Tiled 1.12.2 integration gate"
  : `Tiled 1.12.2 integration gate (${preflight.reason})`;

describe.skipIf(skipOptionalGate)(
  suiteName,
  () => {
    let temporaryRoot: string | undefined;
    let fixtureDirectory: string;
    let serviceDirectory: string;

    beforeAll(async () => {
      if (!preflight.ready) {
        const policy = gateRequired
          ? "is required"
          : "cannot be safely skipped";
        throw new Error(
          `${EXPECTED_TILED_BANNER} integration gate ${policy}: ${preflight.reason}`,
        );
      }

      temporaryRoot = await mkdtemp(
        join(
          tmpdir(),
          "tiledmcp-tiled-1.12.2-",
        ),
      );
      fixtureDirectory = join(
        temporaryRoot,
        "fixture",
      );
      serviceDirectory = join(
        temporaryRoot,
        "service",
      );
      await Promise.all([
        mkdir(fixtureDirectory),
        mkdir(serviceDirectory),
      ]);

      const checkedInFixture = resolve(
        "fixtures/mvp",
      );
      await Promise.all([
        copyFile(
          join(checkedInFixture, "basic.tmj"),
          join(fixtureDirectory, "basic.tmj"),
        ),
        copyFile(
          join(checkedInFixture, "basic.tsj"),
          join(fixtureDirectory, "basic.tsj"),
        ),
        copyFile(
          join(checkedInFixture, "tiles.svg"),
          join(fixtureDirectory, "tiles.svg"),
        ),
      ]);
    });

    afterAll(async () => {
      if (temporaryRoot !== undefined) {
        await rm(temporaryRoot, {
          recursive: true,
          force: true,
        });
      }
    });

    it("requires the exact Tiled 1.12.2 version", async () => {
      const stdout = await runCleanCommand(
        TILED_EXECUTABLE,
        ["--version"],
      );

      expect(stdout.trim()).toBe(
        EXPECTED_TILED_BANNER,
      );
    });

    it("discovers JSON map and tileset export formats", async () => {
      const stdout = await runCleanCommand(
        TILED_EXECUTABLE,
        ["--export-formats"],
      );
      const formats = parseExportFormats(stdout);

      expect(formats.maps).toContain("json");
      expect(formats.maps).toContain("tmx");
      expect(formats.tilesets).toContain("json");
      expect(formats.tilesets).toContain("tsx");
    });

    it("round-trips the checked-in fixture as JSON in one directory without warnings", async () => {
      const sourcePath = join(
        fixtureDirectory,
        "basic.tmj",
      );
      const outputPath = join(
        fixtureDirectory,
        "basic.roundtrip.tmj",
      );

      await runCleanCommand(
        TILED_EXECUTABLE,
        [
          "--export-map",
          "json",
          sourcePath,
          outputPath,
        ],
        fixtureDirectory,
      );

      expect(await readJson(outputPath)).toEqual(
        await readJson(sourcePath),
      );
    });

    it("renders the checked-in fixture to a 64x48 PNG", async () => {
      const outputPath = join(
        fixtureDirectory,
        "basic.png",
      );

      await runCleanCommand(
        RASTERIZER_EXECUTABLE,
        [
          join(
            fixtureDirectory,
            "basic.tmj",
          ),
          outputPath,
        ],
        fixtureDirectory,
      );

      const outputStats = await stat(outputPath);
      expect(outputStats.isFile()).toBe(true);
      expect(outputStats.size).toBeLessThanOrEqual(
        MAX_COMMAND_OUTPUT_BYTES,
      );
      const png = await readFile(outputPath);
      const metadata = await sharp(png).metadata();
      expect(png.subarray(0, 8)).toEqual(
        PNG_SIGNATURE,
      );
      expect(metadata).toMatchObject({
        format: "png",
        width: 64,
        height: 48,
      });
      expect(metadata.pages ?? 1).toBe(1);
    });

    it("round-trips MapService.createMap output through Tiled 1.12.2", async () => {
      const resolver =
        await ProjectPathResolver.create(
          serviceDirectory,
        );
      const service = new MapService(
        resolver,
        new DocumentStore(resolver),
      );
      await service.createMap({
        mapPath: "created.tmj",
        width: 4,
        height: 3,
        tileWidth: 16,
        tileHeight: 16,
        backgroundColor: "#334455",
      });

      const sourcePath = join(
        serviceDirectory,
        "created.tmj",
      );
      const outputPath = join(
        serviceDirectory,
        "created.roundtrip.tmj",
      );
      await runCleanCommand(
        TILED_EXECUTABLE,
        [
          "--export-map",
          "json",
          sourcePath,
          outputPath,
        ],
        serviceDirectory,
      );

      expect(await readJson(outputPath)).toEqual(
        await readJson(sourcePath),
      );
      await expect(
        service.validate("created.roundtrip.tmj"),
      ).resolves.toMatchObject({
        valid: true,
        diagnostics: [],
      });
    });
  },
);

function probeIntegrationTools(): IntegrationPreflight {
  const tiledProbe = probeBanner(
    TILED_EXECUTABLE,
  );
  if (!tiledProbe.ok) {
    return {
      ready: false,
      reason: `Tiled probe failed (${tiledProbe.reason})`,
      skippable: tiledProbe.skippable,
    };
  }
  if (
    tiledProbe.banner !== EXPECTED_TILED_BANNER
  ) {
    return {
      ready: false,
      reason:
        `expected ${EXPECTED_TILED_BANNER}, found ` +
        summarizeBanner(tiledProbe.banner),
      skippable: true,
    };
  }

  const rasterizerProbe = probeBanner(
    RASTERIZER_EXECUTABLE,
  );
  if (!rasterizerProbe.ok) {
    return {
      ready: false,
      reason:
        `TmxRasterizer probe failed (${rasterizerProbe.reason})`,
      skippable: rasterizerProbe.skippable,
    };
  }
  if (
    !/^TmxRasterizer [^\s]+$/u.test(
      rasterizerProbe.banner,
    )
  ) {
    return {
      ready: false,
      reason:
        "TmxRasterizer returned an unexpected version banner",
      skippable: false,
    };
  }

  return { ready: true };
}

function probeBanner(
  executable: string,
):
  | { ok: true; banner: string }
  | {
      ok: false;
      reason: string;
      skippable: boolean;
    } {
  const result = spawnSync(
    executable,
    ["--version"],
    {
      encoding: "utf8",
      env: integrationEnvironment,
      timeout: 10_000,
      maxBuffer: MAX_PROBE_OUTPUT_BYTES,
      killSignal: "SIGKILL",
      windowsHide: true,
    },
  );
  if (result.error !== undefined) {
    const code = (
      result.error as NodeJS.ErrnoException
    ).code;
    return {
      ok: false,
      reason: code ?? "spawn-error",
      skippable: code === "ENOENT",
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `exit-${String(result.status)}`,
      skippable: false,
    };
  }
  if (result.stderr.trim() !== "") {
    return {
      ok: false,
      reason: "unexpected-stderr",
      skippable: false,
    };
  }
  return {
    ok: true,
    banner: result.stdout.trim(),
  };
}

async function runCleanCommand(
  executable: string,
  args: readonly string[],
  cwd?: string,
): Promise<string> {
  const result = await execFileAsync(
    executable,
    [...args],
    {
      ...(cwd === undefined ? {} : { cwd }),
      encoding: "utf8",
      env: integrationEnvironment,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      killSignal: "SIGKILL",
      windowsHide: true,
    },
  );
  expect(
    result.stderr,
    `${executable} ${args.join(" ")} wrote to stderr`,
  ).toBe("");
  return result.stdout;
}

function parseExportFormats(stdout: string): {
  maps: string[];
  tilesets: string[];
} {
  const lines = stdout.split(/\r?\n/u);
  const mapHeading = lines.indexOf(
    "Map export formats:",
  );
  const tilesetHeading = lines.indexOf(
    "Tileset export formats:",
  );
  if (
    mapHeading !== 0 ||
    tilesetHeading <= mapHeading
  ) {
    throw new Error(
      "Tiled --export-formats did not return the expected C-locale headings.",
    );
  }

  return {
    maps: parseFormatLines(
      lines.slice(
        mapHeading + 1,
        tilesetHeading,
      ),
    ),
    tilesets: parseFormatLines(
      lines.slice(tilesetHeading + 1),
    ),
  };
}

function parseFormatLines(
  lines: readonly string[],
): string[] {
  const formats = lines
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (
    formats.length === 0 ||
    formats.some(
      (format) =>
        !/^[a-z0-9][a-z0-9._+-]*$/iu.test(
          format,
        ),
    )
  ) {
    throw new Error(
      "Tiled --export-formats returned an invalid format list.",
    );
  }
  return formats;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path, "utf8"),
  ) as unknown;
}

function readGateRequired(): boolean {
  const value = process.env[REQUIRED_GATE_ENV];
  if (value === undefined || value === "0") {
    return false;
  }
  if (value === "1") {
    return true;
  }
  throw new Error(
    `${REQUIRED_GATE_ENV} must be unset, "0", or "1".`,
  );
}

function summarizeBanner(value: string): string {
  const singleLine = value
    .replace(
      /[\u0000-\u001f\u007f]/gu,
      " ",
    )
    .replace(/\s+/gu, " ")
    .trim();
  const codePoints = [...singleLine];
  const maximumCodePoints = 120;
  const bounded =
    codePoints.length <= maximumCodePoints
      ? singleLine
      : `${codePoints
          .slice(0, maximumCodePoints)
          .join("")}…`;
  return JSON.stringify(bounded);
}
