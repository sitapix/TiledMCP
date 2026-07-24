import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

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
      ],
      {
        TILED_PROJECT_DIR: "./ignored",
        TILED_CLI_PATH: "ignored-tiled",
        TILED_RASTERIZER_PATH: "ignored-rasterizer",
      },
    );
    expect(config).toMatchObject({
      projectDir: expect.stringMatching(/\/project$/u),
      tiledCliPath: "/opt/tiled",
      rasterizerPath: "/opt/tmxrasterizer",
    });
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
