import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * MCP prompts: the task-shaped entry points into a tool-shaped surface.
 *
 * The tool list answers "what can this server do"; it cannot answer "which
 * eight of these fifty-seven calls, in what order, do I make to get a room
 * built". The guide answers that, but only for a reader willing to work
 * through it. A prompt hands the caller the sequence directly.
 *
 * Each prompt below therefore names exact tools in exact order and repeats the
 * few invariants that make a first call succeed rather than fail closed --
 * revision pinning, `TileRef` instead of raw GIDs, preview before apply. They
 * are deliberately concrete: a procedure that mentions no tool names is worth
 * less than no procedure at all.
 */

const PIN_RULES = `Pinning rules that apply to every write below:
- Read the target first (\`tiled_get_map_summary\`) and keep its \`revision\`,
  its complete \`dependencyRevisions\` record, its layer ids and its tileset
  \`assetId\` values together, from that one read.
- Pass \`expectedMapRevision\` and \`expectedDependencyRevisions\` unchanged and
  together. A stale or partial pin fails closed rather than merging.
- Never build or edit a raw global ID. A tile is a \`TileRef\`
  (\`{"tileset": {"kind": "external", "assetId": "asset_..."}, "localId": 0}\`),
  or \`{"name": "floor_wood"}\` once roles are named, and \`null\` clears a cell.
- Nothing touches the project until \`tiled_apply_change_set\`. Every planning
  tool returns an expiring \`changeSetId\`; read the plan it returns, then apply
  that id.
- Re-read the map summary after each apply. The revision has changed.`;

const BUILD_FROM_FLOOR_PLAN_TEMPLATE = (
  planImagePath: string,
  mapPath: string,
  tilesetPath: string | undefined,
): string => `Build a finished Tiled map from the floor plan at \`${planImagePath}\` into \`${mapPath}\`${
  tilesetPath === undefined
    ? ""
    : `, using the tiles in \`${tilesetPath}\``
}.

Work in this order. Do not skip the inspection steps -- the palette in step 4
is only correct if you have actually looked at both the plan and the tiles.

## 1. Orient
- \`tiled_get_capabilities\` -- confirm which tools are registered (some are
  gated on a local Tiled CLI), plus renderer limits and the edit profile.
- \`tiled_list_files\` -- confirm the project-relative paths of the map, the
  tileset and the plan image.

## 2. Read the target map
- \`tiled_get_map_summary\` on \`${mapPath}\`. Keep everything it returns.
- Note which tile layer you will paint into. If the map has no suitable layer,
  create one with \`tiled_create_layer\` and apply that change set first.

## 3. Learn what tiles you have
- \`tiled_list_tile_names\` -- if the tileset already has a semantic name
  registry, this is the fastest way to address tiles by meaning.
- \`tiled_find_tiles\` -- find tiles by exact class or serialized property.
- \`tiled_render_tileset_sheet\` -- actually look at the tiles. Do this before
  assigning roles; do not guess which local id is a wall from its number.
- If roles are not yet recorded, run the \`set_up_tile_roles\` prompt first.
  Naming tiles once makes every later step readable and reviewable.

## 4. Look at the plan image and build the palette
- Read \`${planImagePath}\` and identify the distinct colours it uses and what
  each one means (floor, wall, doorway, prop, void).
- Build the palette for \`tiled_preview_import_image\`: each entry maps one RGB
  colour to a tile, addressed by \`{"name": "..."}\` where you have named roles.
  A \`null\` tile erases where its colour wins. Fully transparent blocks are
  skipped. Every cell resolves to the nearest palette colour by squared RGB
  distance, so include a colour for every region you care about -- an omitted
  colour does not become empty, it becomes whichever palette entry is nearest.

## 5. Lay the floors
- \`tiled_preview_import_image\` with the plan image, the target layer, the
  bounded region and that palette. It resamples the image onto the cell grid
  (each cell averages its alpha-weighted pixel block) and returns an ordinary
  \`mapEdit\` change set.
- Read the returned plan and \`summary\`, then \`tiled_apply_change_set\`.
- \`tiled_render_preview\` the result and compare it against the plan image
  before going further. Fix the palette now if the shapes are wrong.

## 6. Run the walls
- Preferred, if \`tiled_preview_terrain\` is registered: paint Wang corners so
  junctions and corners pick the right tile automatically. Corners address the
  corner grid -- \`x\` in \`[0, width]\`, \`y\` in \`[0, height]\` -- with 1-based
  wang colour indexes, and the set must be corner or mixed type.
- Otherwise place walls explicitly with \`tiled_preview_shape\` (a rectangle
  outline traces a room; a Bresenham line traces a run) or with a
  \`fillRegion\` / \`setTiles\` operation through \`tiled_preview_edits\`.

## 7. Place the sprites
- \`tiled_preview_edits\` with \`createObject\` operations for props positioned
  in pixel coordinates on an object layer.
- \`tiled_preview_template\` for a saved template instance, or
  \`tiled_preview_prefab\` to stamp a whole region (tiles plus objects) that
  already exists in another map.
- For anything non-orthogonal, use \`tiled_convert_coordinates\` rather than
  deriving placement by hand. Isometric, staggered and hexagonal pixel maths is
  the most common source of silently wrong edits.

## 8. Verify
- \`tiled_render_preview\` for the finished state, with \`overlays.grid\` or
  \`overlays.coordinates\` when you need to check exact placement.
- \`tiled_render_diff\` to confirm an applied change did what you intended.
- \`tiled_validate\` to catch structural problems.

${PIN_RULES}

If a call fails, branch on \`structuredContent.result.error.code\`. This server
fails closed on anything undefined rather than approximating, so an error
usually means the input was underspecified -- not that the operation is
impossible. Read \`tiled://guide\` for the detail behind any single step.`;

const SET_UP_TILE_ROLES_TEMPLATE = (
  tilesetPath: string,
): string => `Record what the tiles in \`${tilesetPath}\` are for, so that later
edits can address them by meaning instead of by local id.

1. \`tiled_get_tileset\` -- read the current classes, properties and any Wang
   terrain sets.
2. \`tiled_render_tileset_sheet\` -- page through and actually look at the
   tiles. Assign roles from what you see, not from id order.
3. \`tiled_preview_tile_names\` -- name them on a consistent scheme, for example
   \`floor_wood\`, \`floor_stone\`, \`wall_brick\`, \`wall_brick_corner\`,
   \`door_closed\`, \`prop_barrel\`. A flat, predictable prefix scheme is what
   makes a later palette or terrain call reviewable. Names must match
   \`^[a-z0-9][a-z0-9_-]{0,63}$\` -- lowercase, digits, underscore and hyphen
   only. Dots are rejected, so use \`wall_brick\`, not \`wall.brick\`.
4. \`tiled_apply_change_set\` to commit the registry.
5. \`tiled_list_tile_names\` to confirm what was recorded.

Prefer names for anything a human will review. Use \`tiled_update_tile\` to set
a tile \`class\` when the role should live in the tileset itself, and
\`tiled_update_wangsets\` when walls need corner-aware terrain rather than flat
naming.

${PIN_RULES}`;

const REVIEW_MAP_TEMPLATE = (
  mapPath: string,
): string => `Inspect \`${mapPath}\` and report on it. This is a read-only
review: plan nothing and apply nothing.

1. \`tiled_get_map_summary\` -- orientation, size, layer tree, tilesets.
2. \`tiled_analyze_usage\` -- whole-map tile frequency, layer density, unused
   local ids and which tilesets are actually referenced.
3. \`tiled_render_preview\` -- look at it. Use \`overlays.grid\` when placement
   matters.
4. \`tiled_validate\` -- structural problems, with
   \`tiled_preview_validation_fixes\` if any are mechanically fixable.
5. \`tiled_check_connectivity\` -- if the map is meant to be walkable, confirm
   the reachable area is what you expect.
6. \`tiled_list_objects\` -- object layers, with \`tiled_get_object\` for the
   complete projection of anything that looks wrong.

Report what the map contains, anything structurally broken, and anything that
looks unintentional (unused tilesets, empty layers, unreachable regions,
objects outside the map bounds). Recommend fixes; do not make them.`;

export function registerTiledMcpPrompts(
  server: McpServer,
): void {
  server.registerPrompt(
    "build_from_floor_plan",
    {
      title:
        "Build a map from a floor-plan image",
      description:
        "End-to-end procedure for turning a floor-plan image into a finished map: inspect the tiles, build a colour-to-tile palette, import the plan as floors, run the walls, place the sprites, and verify by rendering.",
      argsSchema: {
        planImagePath: z
          .string()
          .describe(
            "Project-relative path to the floor-plan image, for example floorplans/tavern.png",
          ),
        mapPath: z
          .string()
          .describe(
            "Project-relative path to the map to build into, for example maps/tavern.tmj",
          ),
        tilesetPath: z
          .string()
          .optional()
          .describe(
            "Optional project-relative path to the tileset carrying the floor, wall and sprite tiles.",
          ),
      },
    },
    ({
      planImagePath,
      mapPath,
      tilesetPath,
    }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: BUILD_FROM_FLOOR_PLAN_TEMPLATE(
              planImagePath,
              mapPath,
              tilesetPath,
            ),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "set_up_tile_roles",
    {
      title: "Name tiles by their role",
      description:
        "Record which tiles are floors, walls, doors and props, so later edits address tiles by meaning rather than by local id.",
      argsSchema: {
        tilesetPath: z
          .string()
          .describe(
            "Project-relative path to the tileset to annotate, for example tilesets/interior.tsj",
          ),
      },
    },
    ({ tilesetPath }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: SET_UP_TILE_ROLES_TEMPLATE(
              tilesetPath,
            ),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "review_map",
    {
      title: "Review a map, read-only",
      description:
        "Read-only inspection of one map: structure, tile usage, validation, connectivity and objects, reported without changing anything.",
      argsSchema: {
        mapPath: z
          .string()
          .describe(
            "Project-relative path to the map to review, for example maps/tavern.tmj",
          ),
      },
    },
    ({ mapPath }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: REVIEW_MAP_TEMPLATE(mapPath),
          },
        },
      ],
    }),
  );
}
