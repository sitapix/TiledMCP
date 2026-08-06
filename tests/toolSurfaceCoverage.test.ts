import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GUIDE_RESOURCE_TEXT } from "../src/resources/guide.js";
import {
  TILED_MCP_CORE_TOOL_NAMES,
  TILED_MCP_OPTIONAL_TOOL_NAMES,
} from "../src/server.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const ADVERTISED = [
  ...TILED_MCP_CORE_TOOL_NAMES,
  ...TILED_MCP_OPTIONAL_TOOL_NAMES,
];

/**
 * A tool's call example is coverage-checked by the contract generator, but
 * nothing linked a tool to its guide section -- the guide is one monolithic
 * string, so a new tool could ship fully registered and completely undocumented
 * for the agent that has to drive it. These close that gap.
 */
describe("tool surface coverage", () => {
  it("names every advertised tool in the guide resource", () => {
    const missing = ADVERTISED.filter(
      (name) => !GUIDE_RESOURCE_TEXT.includes(name),
    );
    expect(missing).toEqual([]);
  });

  it("advertises each tool name exactly once", () => {
    expect(new Set(ADVERTISED).size).toBe(
      ADVERTISED.length,
    );
  });

  it.each(["docs/02-mcp-spec.md"])(
    "names every advertised tool in %s",
    async (relativePath) => {
      // Hand-maintained -- the contract generator does not emit it -- so
      // nothing previously noticed when a tool shipped undocumented.
      // README.md is deliberately excluded: it is an orientation document, and
      // requiring it to name all 57 tools forced it to duplicate
      // docs/generated/mcp-reference.md instead of explaining the design.
      const text = await readFile(
        resolve(REPOSITORY_ROOT, relativePath),
        "utf8",
      );
      const missing = ADVERTISED.filter(
        (name) => !text.includes(name),
      );
      expect(missing).toEqual([]);
    },
  );

  it("keeps core and optional tool names disjoint", () => {
    const core = new Set<string>(
      TILED_MCP_CORE_TOOL_NAMES,
    );
    const overlap =
      TILED_MCP_OPTIONAL_TOOL_NAMES.filter((name) =>
        core.has(name),
      );
    expect(overlap).toEqual([]);
  });
});
