import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { TiledCliAdapter } from "../src/adapters/tiledCli.js";
import { TiledMcpError } from "../src/errors.js";

describe("TiledCliAdapter.renderPng", () => {
  let root: string;
  let fakeRasterizerPath: string;
  let inputMapPath: string;

  beforeEach(async () => {
    root = await mkdtemp(
      join(tmpdir(), "tiledmcp-cli-"),
    );
    fakeRasterizerPath = join(
      root,
      "fake-rasterizer.mjs",
    );
    inputMapPath = join(root, "map.tmj");
    await writeFile(inputMapPath, "{}\n", "utf8");
    await writeFile(
      fakeRasterizerPath,
      [
        "#!/usr/bin/env node",
        'import { copyFileSync, symlinkSync, writeFileSync } from "node:fs";',
        'import { execFileSync } from "node:child_process";',
        "const args = process.argv.slice(2);",
        "const sourcePath = process.env.FAKE_RASTER_SOURCE_PATH;",
        "const argumentsPath = process.env.FAKE_RASTER_ARGUMENTS_PATH;",
        "const outputMode = process.env.FAKE_RASTER_OUTPUT_MODE;",
        "const versionOutput = process.env.FAKE_RASTER_VERSION_OUTPUT;",
        'if (args[0] === "--version") {',
        '  process.stdout.write(versionOutput || "TmxRasterizer 1.0");',
        "  process.exit(0);",
        "}",
        "const outputPath = args.at(-1);",
        "if (!sourcePath || !outputPath) {",
        '  process.stderr.write("missing fake rasterizer path\\n");',
        "  process.exit(2);",
        "}",
        'if (outputMode === "symlink") {',
        "  symlinkSync(sourcePath, outputPath);",
        '} else if (outputMode === "fifo") {',
        '  execFileSync("mkfifo", [outputPath]);',
        "} else {",
        "  copyFileSync(sourcePath, outputPath);",
        "}",
        "if (argumentsPath) {",
        '  writeFileSync(argumentsPath, JSON.stringify(args), "utf8");',
        "}",
      ].join("\n"),
      { encoding: "utf8", mode: 0o700 },
    );
    await chmod(fakeRasterizerPath, 0o700);
  });

  afterEach(async () => {
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  it("returns one coherent bounded PNG snapshot and forwards only rasterizer arguments", async () => {
    const sourcePng = await pngFixture(
      3,
      2,
      "#336699",
    );
    const sourcePngPath = join(root, "source.png");
    const outputPngPath = join(root, "output.png");
    const argumentsPath = join(
      root,
      "arguments.json",
    );
    await writeFile(sourcePngPath, sourcePng);
    const adapter = createAdapter({
      FAKE_RASTER_SOURCE_PATH: sourcePngPath,
      FAKE_RASTER_ARGUMENTS_PATH: argumentsPath,
    });

    const rendered = await adapter.renderPng(
      inputMapPath,
      outputPngPath,
      {
        size: 128,
        antiAliasing: true,
        noSmoothing: true,
        ignoreVisibility: true,
        maxPngBytes: sourcePng.byteLength,
      },
    );

    expect(rendered).toEqual({
      outputPath: outputPngPath,
      png: sourcePng,
      bytes: sourcePng.byteLength,
      width: 3,
      height: 2,
    });
    expect(rendered.bytes).toBe(
      rendered.png.byteLength,
    );
    expect(
      await sharp(rendered.png).metadata(),
    ).toMatchObject({
      format: "png",
      width: rendered.width,
      height: rendered.height,
    });
    expect(
      JSON.parse(
        await readFile(argumentsPath, "utf8"),
      ),
    ).toEqual([
      "--size",
      "128",
      "--anti-aliasing",
      "--no-smoothing",
      "--ignore-visibility",
      inputMapPath,
      outputPngPath,
    ]);

    await writeFile(
      outputPngPath,
      Buffer.from("changed after snapshot", "utf8"),
    );
    expect(rendered.png).toEqual(sourcePng);
  });

  it("rejects the actual rasterizer file when it exceeds maxPngBytes", async () => {
    const sourcePng = await pngFixture(
      4,
      3,
      "#884422",
    );
    const sourcePngPath = join(
      root,
      "oversized.png",
    );
    const outputPngPath = join(
      root,
      "oversized-output.png",
    );
    await writeFile(sourcePngPath, sourcePng);
    const adapter = createAdapter({
      FAKE_RASTER_SOURCE_PATH: sourcePngPath,
    });

    let caught: unknown;
    try {
      await adapter.renderPng(
        inputMapPath,
        outputPngPath,
        {
          maxPngBytes:
            sourcePng.byteLength - 1,
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: "TiledMcpError",
      code: "IMAGE_TOO_LARGE",
      details: {
        bytes:
          String(sourcePng.byteLength),
        limit: sourcePng.byteLength - 1,
      },
    });
    expect(
      JSON.stringify(caught),
    ).not.toContain(root);
  });

  it.each([
    [
      "short",
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47,
      ]),
    ],
    [
      "bad-signature",
      Buffer.alloc(32, 0xa5),
    ],
    [
      "truncated-IHDR",
      (() => {
        const value = Buffer.alloc(24);
        Buffer.from([
          0x89, 0x50, 0x4e, 0x47,
          0x0d, 0x0a, 0x1a, 0x0a,
        ]).copy(value);
        value.write("IHDR", 12, "ascii");
        value.writeUInt32BE(1, 16);
        value.writeUInt32BE(1, 20);
        return value;
      })(),
    ],
  ])(
    "rejects %s rasterizer output as an invalid PNG",
    async (_label, invalidPng) => {
      const sourcePngPath = join(
        root,
        "invalid-source.png",
      );
      const outputPngPath = join(
        root,
        "invalid-output.png",
      );
      await writeFile(
        sourcePngPath,
        invalidPng,
      );
      const adapter = createAdapter({
        FAKE_RASTER_SOURCE_PATH:
          sourcePngPath,
      });

      await expect(
        adapter.renderPng(
          inputMapPath,
          outputPngPath,
          {
            maxPngBytes: 1_024,
          },
        ),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code:
          "TMXRASTERIZER_OUTPUT_INVALID",
      });
    },
  );

  it("rejects PNG output whose compressed image data cannot be decoded", async () => {
    const corruptedPng = Buffer.from(
      await pngFixture(
        3,
        2,
        "#557799",
      ),
    );
    const idatTypeOffset =
      corruptedPng.indexOf(
        Buffer.from("IDAT", "ascii"),
      );
    expect(idatTypeOffset).toBeGreaterThan(0);
    const idatDataOffset =
      idatTypeOffset + 4;
    corruptedPng.writeUInt8(
      corruptedPng.readUInt8(
        idatDataOffset,
      ) ^ 0x01,
      idatDataOffset,
    );
    const sourcePngPath = join(
      root,
      "corrupt-idat.png",
    );
    const outputPngPath = join(
      root,
      "corrupt-idat-output.png",
    );
    await writeFile(
      sourcePngPath,
      corruptedPng,
    );

    await expect(
      createAdapter({
        FAKE_RASTER_SOURCE_PATH:
          sourcePngPath,
      }).renderPng(
        inputMapPath,
        outputPngPath,
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code:
        "TMXRASTERIZER_OUTPUT_INVALID",
    });
  });

  it("does not accept an unrelated executable as TmxRasterizer", async () => {
    const adapter = new TiledCliAdapter({
      tiledCliPath: process.execPath,
      rasterizerPath: process.execPath,
    });

    await expect(
      adapter.getRasterizerVersion(),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code:
        "TMXRASTERIZER_UNEXPECTED_OUTPUT",
    });
  });

  it("accepts only a full product-and-version rasterizer banner", async () => {
    await expect(
      createAdapter({
        FAKE_RASTER_VERSION_OUTPUT:
          "TmxRasterizer 1.12.2-rc.1",
      }).getRasterizerVersion(),
    ).resolves.toBe("1.12.2-rc.1");

    await expect(
      createAdapter({
        FAKE_RASTER_VERSION_OUTPUT:
          "not TmxRasterizer definitely-not-a-version",
      }).getRasterizerVersion(),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code:
        "TMXRASTERIZER_UNEXPECTED_OUTPUT",
    });
  });

  it("redacts internal capability-probe messages while preserving public issues", async () => {
    const adapter = createAdapter({});
    adapter.getTiledVersion = async () => {
      throw new Error("raw internal secret");
    };
    adapter.getExportFormats = async () => {
      throw new TiledMcpError(
        "INTERNAL_ERROR",
        "explicit internal secret",
      );
    };
    adapter.getRasterizerVersion = async () => {
      throw new TiledMcpError(
        "TMXRASTERIZER_NOT_FOUND",
        "public executable status",
      );
    };

    const capabilities =
      await adapter.probeCapabilities();
    expect(capabilities.tiled.issues).toEqual([
      {
        code: "INTERNAL_ERROR",
        message:
          "Tiled capability probe failed internally.",
      },
    ]);
    expect(
      capabilities.rasterizer.issues,
    ).toEqual([
      {
        code: "TMXRASTERIZER_NOT_FOUND",
        message: "public executable status",
      },
    ]);
    expect(
      JSON.stringify(capabilities),
    ).not.toContain("internal secret");

    const hostileIssue =
      new TiledMcpError(
        "TILED_CLI_FAILED",
        "placeholder",
      );
    Object.defineProperty(
      hostileIssue,
      "message",
      {
        configurable: true,
        get() {
          throw new Error(
            "probe getter leaked secret",
          );
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    adapter.getTiledVersion = async () => {
      throw hostileIssue;
    };
    adapter.getExportFormats = async () => {
      throw revoked.proxy;
    };
    adapter.getRasterizerVersion =
      async () => "1.0";

    const hostileCapabilities =
      await adapter.probeCapabilities();
    expect(
      hostileCapabilities.tiled.issues,
    ).toEqual([
      {
        code: "INTERNAL_ERROR",
        message:
          "Tiled capability probe failed internally.",
      },
    ]);
    expect(
      JSON.stringify(hostileCapabilities),
    ).not.toContain("leaked secret");
  });

  it("does not expose executable paths, arguments, or subprocess output in command errors", async () => {
    const outputPngPath = join(
      root,
      "private-output.png",
    );
    let caught: unknown;
    try {
      await createAdapter({}).renderPng(
        inputMapPath,
        outputPngPath,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(
      TiledMcpError,
    );
    if (!(caught instanceof TiledMcpError)) {
      throw new Error(
        "Expected a TiledMcpError",
      );
    }
    expect(caught).toMatchObject({
      code: "TMXRASTERIZER_FAILED",
      message:
        "TmxRasterizer exited unsuccessfully.",
      details: {
        argumentCount: 2,
        exitCode: 2,
        signal: null,
        stdoutBytes: 0,
        stderrBytes: expect.any(Number),
      },
    });
    const publicError = JSON.stringify({
      message: caught.message,
      details: caught.details,
    });
    expect(publicError).not.toContain(root);
    expect(publicError).not.toContain(
      "missing fake rasterizer path",
    );
  });

  it("rejects a rasterizer symlink output without following it", async () => {
    await expectUnsafeOutput("symlink");
  });

  if (process.platform !== "win32") {
    it("rejects a rasterizer FIFO output without blocking", async () => {
      await expectUnsafeOutput("fifo");
    });
  }

  async function expectUnsafeOutput(
    outputMode: "symlink" | "fifo",
  ): Promise<void> {
    const sourcePng = await pngFixture(
      2,
      2,
      "#112233",
    );
    const sourcePngPath = join(
      root,
      `${outputMode}-source.png`,
    );
    const outputPngPath = join(
      root,
      `${outputMode}-output.png`,
    );
    await writeFile(
      sourcePngPath,
      sourcePng,
    );
    const adapter = createAdapter({
      FAKE_RASTER_SOURCE_PATH:
        sourcePngPath,
      FAKE_RASTER_OUTPUT_MODE:
        outputMode,
    });

    let caught: unknown;
    try {
      await adapter.renderPng(
        inputMapPath,
        outputPngPath,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: "TiledMcpError",
      code:
        "TMXRASTERIZER_OUTPUT_INVALID",
      details: {
        reason: "not-regular-file",
      },
    });
    expect(
      JSON.stringify(caught),
    ).not.toContain(root);
  }

  function createAdapter(
    environment: NodeJS.ProcessEnv,
  ): TiledCliAdapter {
    return new TiledCliAdapter({
      tiledCliPath: fakeRasterizerPath,
      rasterizerPath: fakeRasterizerPath,
      env: environment,
    });
  }
});

async function pngFixture(
  width: number,
  height: number,
  background: string,
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background,
    },
  })
    .png()
    .toBuffer();
}
