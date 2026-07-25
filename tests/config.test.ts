import { describe, expect, it } from "vitest";

import { helpText, loadConfig } from "../src/config.js";
import { DEFAULT_CHECKPOINT_STORAGE_BYTES } from "../src/storage/checkpoints.js";

describe("loadConfig", () => {
  it("fails closed without a project root", () => {
    expect(() => loadConfig([], {})).toThrow(
      expect.objectContaining({ code: "PROJECT_ROOT_REQUIRED" }),
    );
  });

  it("loads explicit options over environment defaults", () => {
    const config = loadConfig(
      [
        "--project-dir",
        "./project",
        "--tiled-cli",
        "/opt/tiled",
        "--rasterizer",
        "/opt/tmxrasterizer",
        "--checkpoint-bytes",
        "4096",
      ],
      {
        TILED_PROJECT_DIR: "./ignored",
        TILED_CLI_PATH: "ignored-tiled",
        TILED_RASTERIZER_PATH: "ignored-rasterizer",
        TILEDMCP_CHECKPOINT_BYTES: "2048",
      },
    );
    expect(config).toMatchObject({
      projectDir: expect.stringMatching(/\/project$/u),
      tiledCliPath: "/opt/tiled",
      rasterizerPath: "/opt/tmxrasterizer",
      checkpointBytes: 4096,
    });
  });

  it("uses the exported checkpoint quota default", () => {
    const config = loadConfig(["--project-dir", "./project"], {});
    expect(config.checkpointBytes).toBe(DEFAULT_CHECKPOINT_STORAGE_BYTES);
  });

  it("loads the checkpoint quota from the environment", () => {
    const config = loadConfig(["--project-dir", "./project"], {
      TILEDMCP_CHECKPOINT_BYTES: "8192",
    });
    expect(config.checkpointBytes).toBe(8192);
  });

  it.each(["1", `${Number.MAX_SAFE_INTEGER}`])(
    "accepts checkpoint quota boundary %s",
    (value) => {
      const config = loadConfig(
        ["--project-dir", "./project", "--checkpoint-bytes", value],
        {},
      );
      expect(config.checkpointBytes).toBe(Number(value));
    },
  );

  it.each([
    "",
    "0",
    "-1",
    "+1",
    "01",
    "1.5",
    "1e3",
    " 1",
    "1 ",
    "9007199254740992",
    "Infinity",
    "NaN",
  ])("rejects invalid checkpoint quota %j", (value) => {
    expect(() =>
      loadConfig(["--project-dir", "./project"], {
        TILEDMCP_CHECKPOINT_BYTES: value,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("rejects an invalid checkpoint quota from the CLI", () => {
    expect(() =>
      loadConfig(
        ["--project-dir", "./project", "--checkpoint-bytes", "0"],
        { TILEDMCP_CHECKPOINT_BYTES: "4096" },
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("documents the checkpoint quota option and environment override", () => {
    expect(helpText()).toContain("--checkpoint-bytes <bytes>");
    expect(helpText()).toContain("TILEDMCP_CHECKPOINT_BYTES");
    expect(helpText()).toContain(`${DEFAULT_CHECKPOINT_STORAGE_BYTES}`);
    expect(helpText()).toContain("CLI overrides env");
    expect(helpText()).toContain("[1-9][0-9]*");
    expect(helpText()).toContain(`${Number.MAX_SAFE_INTEGER}`);
  });

  it.each([
    ["--unknown"],
    ["--project-dir"],
    ["--project-dir", "one", "--project-dir", "two"],
  ])("rejects malformed options %j", (...argv) => {
    expect(() => loadConfig(argv, {})).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });
});
