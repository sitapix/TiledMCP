/**
 * The MCP `instructions` field, returned once during initialization.
 *
 * This is the only text every client sees before it starts calling tools, so
 * it carries the rules that make the difference between a safe first call and
 * a rejected one: the path model, the two-phase write protocol, revision
 * pinning, and where the authoritative result lives. Everything that is
 * per-workflow rather than server-wide belongs in the `tiled://guide`
 * resource instead -- this text is deliberately short enough to keep in
 * context for a whole session.
 */
export const TILED_MCP_SERVER_INSTRUCTIONS = `TiledMCP inspects and edits Tiled map assets (TMJ/TSJ/TMX/TSX/TX) under one
configured project root.

## Paths and discovery

Every path input is a project-relative POSIX path. Absolute paths and \`..\`
traversal are rejected. Call \`tiled_get_capabilities\` first: the registered
tool set varies with the local Tiled CLI, and it also declares renderer limits,
edit profiles, and the application-error contract.

## Reading results

\`structuredContent.result\` is the authoritative machine-readable value. The
text block beside it is a bounded one-line summary (at most 1024 bytes) that
deliberately omits fields; never parse it to recover them.

On failure, branch only on \`structuredContent.result.error.code\`. The
\`message\` and \`details\` values are for people and have no stable shape.
Treat an unknown code as a generic failure rather than as success.

## Writing: preview, approve, apply

No project asset changes until you call \`tiled_apply_change_set\`. Planning
tools validate the whole edit and return an expiring \`changeSetId\`; the
human-visible plan they return is the approval boundary. Every planning
tool's title begins with "Preview", including ones whose name does not
(\`tiled_create_tileset\`, \`tiled_create_layer\`, \`tiled_update_tile\`,
\`tiled_delete_file\`, ...). Exactly two tools
write directly without this cycle: \`tiled_create_map\` and
\`tiled_create_checkpoint\`.

A change set expires 10 minutes after preview; the exact deadline is the
plan's \`expiresAt\`. If approval takes longer, re-run the preview — an
expired id fails with \`CHANGE_SET_NOT_FOUND\`.

Every write is a compare-and-set. Read the target first (for example with
\`tiled_get_map_summary\`), then pass its \`revision\` as
\`expectedMapRevision\` and its complete \`dependencyRevisions\` record as
\`expectedDependencyRevisions\`. Pass them unchanged and together, from the
same read. A stale or partial pin fails closed rather than merging.

On \`REVISION_CONFLICT\` or \`DEPENDENCY_REVISION_CONFLICT\`, the state moved
under you: re-read, re-plan against what the read now says, and preview
again. Never resubmit the old \`changeSetId\` -- it is bound to the pins it
was built from. Applying a change set advances its documents' revisions, so
other pending previews pinned to the same documents go stale; re-read
between preview-apply pairs that touch the same files.

Never construct or edit raw global IDs. A tile value is a \`TileRef\`
(\`{"tileset": {"kind": "external", "assetId": "asset_..."}, "localId": 0}\`),
and \`null\` clears a cell. Preserve transform fields returned by a read unless
the edit is meant to change them.

## Working effectively

Undefined or unsupported semantics fail closed with a specific code instead of
being approximated -- an error usually means the input was underspecified, not
that the operation is impossible.

Use \`tiled_convert_coordinates\` rather than deriving isometric, staggered, or
hexagonal placement by hand; the projection math is the most common source of
silently wrong edits.

Render to check your work: \`tiled_render_preview\` for the current state and
\`tiled_render_diff\` to confirm an applied change did what you intended.

## Start from a prompt, not from the tool list

This server registers MCP prompts that carry the exact call sequence for a
whole task, which is faster and safer than assembling one from the tool list:

- \`create_map_from_tilesheet\` -- start here when all you have is a tilesheet
  image and no map yet: cut the sheet into a tileset, create the map, attach
  the tileset, add a layer, identify tiles by rendering the sheet with its
  local IDs, then paint and verify. The other three assume a map already
  exists.
- \`build_from_floor_plan\` -- turn a floor-plan image into a finished map:
  inspect the tiles, build a colour-to-tile palette, import the plan as floors,
  run the walls, place the sprites, verify by rendering.
- \`set_up_tile_roles\` -- record which tiles are floors, walls, doors and props
  so later edits address tiles by meaning rather than by local id.
- \`review_map\` -- read-only inspection of one map.

For per-workflow detail, read one section of the guide at
\`tiled://guide/{section}\` (its Contents block lists the slugs) rather than
the whole ~115 KB \`tiled://guide\` resource.`;
