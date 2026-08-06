import { describe, expect, it } from "vitest";

import { GUIDE_RESOURCE_TEXT } from "../src/resources/guide.js";
import { TILED_MCP_SERVER_INSTRUCTIONS } from "../src/resources/instructions.js";
import {
  TILED_MCP_CORE_TOOL_NAMES,
  TILED_MCP_OPTIONAL_TOOL_NAMES,
} from "../src/server.js";

/**
 * Prompts are the task-shaped entry point into a tool-shaped surface, so a
 * prompt that names a tool which does not exist is worse than no prompt: it
 * sends the caller confidently at a tool the server will never register.
 *
 * The contract generator already gates prompt identity, ordering and
 * descriptions. What it cannot see is whether the *procedure text* still
 * refers to real tools, or whether the prompts are discoverable at all. These
 * cover both.
 */

const ADVERTISED = new Set<string>([
  ...TILED_MCP_CORE_TOOL_NAMES,
  ...TILED_MCP_OPTIONAL_TOOL_NAMES,
]);

const PROMPT_NAMES = [
  "build_from_floor_plan",
  "set_up_tile_roles",
  "review_map",
] as const;

/**
 * Renders every prompt body once. The templates are not exported
 * individually, so this drives the registered prompts through a stub server
 * that captures each callback and its rendered text.
 */
async function renderPrompts(): Promise<
  Map<string, string>
> {
  const { registerTiledMcpPrompts } = await import(
    "../src/resources/prompts.js"
  );
  const rendered = new Map<string, string>();
  const callbacks = new Map<
    string,
    (args: Record<string, string>) => {
      messages: Array<{
        content: { text?: string };
      }>;
    }
  >();
  registerTiledMcpPrompts({
    registerPrompt: (
      name: string,
      _config: unknown,
      callback: (args: Record<string, string>) => {
        messages: Array<{
          content: { text?: string };
        }>;
      },
    ) => {
      callbacks.set(name, callback);
    },
  } as never);
  for (const [name, callback] of callbacks) {
    const result = callback({
      planImagePath: "floorplans/tavern.png",
      mapPath: "maps/tavern.tmj",
      tilesetPath: "tilesets/interior.tsj",
    });
    rendered.set(
      name,
      result.messages
        .map(
          (message) =>
            message.content.text ?? "",
        )
        .join("\n"),
    );
  }
  return rendered;
}

describe("prompt surface", () => {
  it("registers exactly the advertised prompts", async () => {
    const rendered = await renderPrompts();
    expect([...rendered.keys()]).toEqual([
      ...PROMPT_NAMES,
    ]);
  });

  it("only references tools the server actually advertises", async () => {
    const rendered = await renderPrompts();
    const unknown: string[] = [];
    for (const [
      name,
      text,
    ] of rendered) {
      for (const match of text.matchAll(
        /\btiled_[a-z0-9_]+\b/g,
      )) {
        if (!ADVERTISED.has(match[0])) {
          unknown.push(`${name}: ${match[0]}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("interpolates its arguments into the procedure", async () => {
    const rendered = await renderPrompts();
    expect(
      rendered.get("build_from_floor_plan"),
    ).toContain("floorplans/tavern.png");
    expect(
      rendered.get("build_from_floor_plan"),
    ).toContain("maps/tavern.tmj");
    expect(
      rendered.get("set_up_tile_roles"),
    ).toContain("tilesets/interior.tsj");
    expect(rendered.get("review_map")).toContain(
      "maps/tavern.tmj",
    );
  });

  it("keeps the read-only review free of planning and applying tools", async () => {
    const rendered = await renderPrompts();
    const review =
      rendered.get("review_map") ?? "";
    expect(review).not.toContain(
      "tiled_apply_change_set",
    );
    for (const match of review.matchAll(
      /\btiled_preview_[a-z0-9_]+\b/g,
    )) {
      // The one preview named here is offered explicitly as a recommendation
      // to report, not to run.
      expect(match[0]).toBe(
        "tiled_preview_validation_fixes",
      );
    }
  });

  it("is discoverable from the instructions every client receives", () => {
    for (const name of PROMPT_NAMES) {
      expect(
        TILED_MCP_SERVER_INSTRUCTIONS,
      ).toContain(name);
    }
  });

  it("points at the flagship recipe from the guide", () => {
    expect(GUIDE_RESOURCE_TEXT).toContain(
      "build_from_floor_plan",
    );
    expect(GUIDE_RESOURCE_TEXT).toContain(
      "Recipe: build a map from a floor-plan image",
    );
  });
});
