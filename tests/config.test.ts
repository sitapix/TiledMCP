import { describe, expect, it } from "vitest";

import { helpText, loadConfig } from "../src/config.js";
import {
  DEFAULT_CHECKPOINT_STORAGE_BYTES,
  MAX_CHECKPOINT_OBSERVED_ENTRIES,
  MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT,
} from "../src/storage/checkpoints.js";

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
        "--checkpoint-retain-per-target",
        "23",
      ],
      {
        TILED_PROJECT_DIR: "./ignored",
        TILED_CLI_PATH: "ignored-tiled",
        TILED_RASTERIZER_PATH: "ignored-rasterizer",
        TILEDMCP_CHECKPOINT_BYTES: "2048",
        TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET: "17",
      },
    );
    expect(config).toMatchObject({
      projectDir: expect.stringMatching(/\/project$/u),
      tiledCliPath: "/opt/tiled",
      rasterizerPath: "/opt/tmxrasterizer",
      checkpointBytes: 4096,
      retainCommittedPerTarget: 23,
    });
  });

  it("uses the exported checkpoint quota default", () => {
    const config = loadConfig(["--project-dir", "./project"], {});
    expect(config.checkpointBytes).toBe(DEFAULT_CHECKPOINT_STORAGE_BYTES);
    expect(config.retainCommittedPerTarget).toBeUndefined();
  });

  it("loads the checkpoint quota from the environment", () => {
    const config = loadConfig(["--project-dir", "./project"], {
      TILEDMCP_CHECKPOINT_BYTES: "8192",
    });
    expect(config.checkpointBytes).toBe(8192);
  });

  it("loads opt-in checkpoint retention from the environment", () => {
    const config = loadConfig(["--project-dir", "./project"], {
      TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET: "12",
    });
    expect(config.retainCommittedPerTarget).toBe(12);
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

  it.each([
    `${MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT}`,
    `${MAX_CHECKPOINT_OBSERVED_ENTRIES}`,
  ])("accepts automatic checkpoint retention boundary %s", (value) => {
    const config = loadConfig(
      [
        "--project-dir",
        "./project",
        "--checkpoint-retain-per-target",
        value,
      ],
      {},
    );
    expect(config.retainCommittedPerTarget).toBe(Number(value));
  });

  it.each([
    "",
    "0",
    "1",
    "-1",
    "+2",
    "02",
    "2.0",
    "2e0",
    " 2",
    "2 ",
    `${MAX_CHECKPOINT_OBSERVED_ENTRIES + 1}`,
    "9007199254740992",
    "Infinity",
    "NaN",
  ])("rejects invalid automatic checkpoint retention %j", (value) => {
    expect(() =>
      loadConfig(["--project-dir", "./project"], {
        TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET: value,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  it("rejects invalid CLI retention even when the environment is valid", () => {
    expect(() =>
      loadConfig(
        [
          "--project-dir",
          "./project",
          "--checkpoint-retain-per-target",
          "1",
        ],
        { TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET: "12" },
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

  it("documents opt-in post-commit checkpoint retention", () => {
    expect(helpText()).toContain(
      "--checkpoint-retain-per-target <N>",
    );
    expect(helpText()).toContain(
      "TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET",
    );
    expect(helpText()).toContain("Disabled by default");
    expect(helpText()).toContain("rolling post-commit retention");
    expect(helpText()).toContain("standing approval");
    expect(helpText()).toContain("at most one oldest eligible");
    expect(helpText()).toContain("checkpointRetention");
    expect(helpText()).toContain(
      "Existing excess is not reduced",
    );
    expect(helpText()).toContain(
      "explicitly approved prune",
    );
    expect(helpText()).toContain(
      "Legacy, protected, and prepared manifests are always retained",
    );
    expect(helpText()).toContain(
      "startup, periodic, and quota-pressure retention are disabled",
    );
    expect(helpText()).toContain("CLI overrides env");
    expect(helpText()).toContain("[1-9][0-9]*");
    expect(helpText()).toContain(
      `${MIN_AUTOMATIC_CHECKPOINT_RETENTION_COUNT}..${MAX_CHECKPOINT_OBSERVED_ENTRIES}`,
    );
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
