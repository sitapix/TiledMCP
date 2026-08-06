import { spawnSync } from "node:child_process";

/**
 * Where the Tiled CLI lives for this run. Honours TILED_CLI_PATH so a
 * non-standard install can be pointed at without editing tests.
 */
export const TILED_CLI_PATH =
  process.env.TILED_CLI_PATH ?? "tiled";

/**
 * Whether the Tiled CLI is actually runnable here, probed once per worker.
 *
 * Tests that cross-check our output against real Tiled must gate on this with
 * `it.skipIf(!hasTiledCli)`. The previous idiom -- catching ENOENT from the
 * export and returning -- reported those tests as PASSED on machines with no
 * Tiled installed, so a conformance check that never ran looked identical to
 * one that ran and succeeded.
 */
/**
 * The Qt platform plugin to run Tiled under.
 *
 * `offscreen` is the right default: it is what CI wants and what
 * `TiledCliAdapter` itself falls back to. But not every Tiled build ships the
 * offscreen plugin -- the macOS `Tiled.app` bundle carries only `cocoa`, and
 * asking it for `offscreen` aborts with SIGABRT. That looked exactly like
 * "no Tiled installed", silently skipping every conformance test on a machine
 * that has one. Honouring a caller-supplied value lets those runs opt into a
 * platform their build actually has.
 *
 * Must stay declared above {@link hasTiledCli}'s initialiser: `probe()` is
 * hoisted but this binding is not, so declaring it below leaves it in the
 * temporal dead zone when the probe runs -- and probe's `try/catch` would
 * swallow the ReferenceError as "no Tiled installed".
 */
const QT_QPA_PLATFORM =
  process.env.QT_QPA_PLATFORM ?? "offscreen";

export const hasTiledCli: boolean = probe();

function probe(): boolean {
  try {
    const result = spawnSync(
      TILED_CLI_PATH,
      ["--version"],
      {
        env: {
          ...process.env,
          LANG: "C",
          LC_ALL: "C",
          QT_QPA_PLATFORM,
        },
        timeout: 30_000,
      },
    );
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

/** Environment the CLI needs to run headless and locale-stable. */
export const TILED_CLI_ENV = {
  ...process.env,
  LANG: "C",
  LC_ALL: "C",
  QT_QPA_PLATFORM,
} as const;
