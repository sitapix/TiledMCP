import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { revisionOf } from "../storage/revision.js";
import { SERVER_VERSION } from "../version.js";

export const GUIDE_RESOURCE_URI = "tiled://guide";
export const GUIDE_RESOURCE_MIME_TYPE = "text/markdown";
export const MAX_GUIDE_RESOURCE_BYTES = 64 * 1024;

export const GUIDE_RESOURCE_TEXT = `# TiledMCP safe editing guide

TiledMCP inspects and edits Tiled project files under one configured project
root. Treat every path as a project-relative POSIX path. Absolute paths and
\`..\` traversal are rejected.

## Discover the active surface

1. Call \`tiled_get_capabilities\` and inspect \`registeredTools\`, the edit
   profile, renderer limits, and local CLI availability.
2. Call \`tiled_list_files\` to discover project-relative map and tileset paths.
3. Only call optional tools such as \`tiled_render_map\` when they appear in
   \`registeredTools\`. The built-in \`tiled_render_preview\` is the portable
   map preview path.

The M1 edit profile is intentionally narrow: finite orthogonal TMJ maps,
external atlas TSJ tilesets, uncompressed tile-layer arrays, and rectangle or
point objects. Unsupported Tiled semantics fail closed instead of being
approximated.

## Inspect before planning

For an existing map:

1. Call \`tiled_get_map_summary\`. Keep its map \`revision\`,
   \`dependencyRevisions\`, layer IDs, and tileset \`assetId\` values together.
2. Call \`tiled_get_tileset\` with that \`mapPath\` and the selected
   \`tilesetAssetId\` when class names, animation summaries, collision counts,
   or Wang-set overviews matter. Its tile metadata page is sparse and ordered
   by local ID. Tile classes use the current Tiled \`tiles[].type\` field, with
   \`class\` accepted only as a Tiled 1.9 compatibility fallback. This response
   identifies the selected source revision; keep the complete
   \`dependencyRevisions\` from the map summary for later edits.
3. Call \`tiled_find_tiles\` with that \`mapPath\`, the selected
   \`tilesetAssetId\`, and an exact class or explicitly serialized property
   \`query\` to get bounded \`TileRef\` results. Matching is case-sensitive.
   The first page may return a revision-pinned \`nextPage\`; pass its
   \`startTileId\`, \`expectedMapRevision\`, and
   \`expectedTilesetRevision\` fields unchanged with the same query and
   limit. Search does not return property values or resolve inherited
   properties, Wang assignments, or image-derived semantics.
4. Use \`tiled_get_region\` for a bounded tile rectangle and
   \`tiled_list_objects\` for bounded object inspection.
5. Use \`tiled_render_tileset_sheet\` with that \`mapPath\` and
   \`tilesetAssetId\` to see local tile IDs. Pages are zero-based.
6. Use \`tiled_render_preview\` to inspect the current map or a bounded region.
   Grid and coordinate overlays can make tile positions explicit.

Never construct or edit raw global IDs. A tile value is a \`TileRef\`:

\`\`\`json
{
  "tileset": {
    "kind": "external",
    "assetId": "asset_..."
  },
  "localId": 0
}
\`\`\`

Use \`null\` to clear a cell. Preserve any transform fields returned by a read
unless the intended edit changes them.

Native preview v1 renders static atlas tile layers. A result with
\`partial: true\` is not a complete visual representation; inspect
\`omittedLayers\` and the declared \`renderProfile\`. Object layers and
unsupported drawing semantics are reported or rejected rather than silently
rendered incorrectly.

## Attach an existing tileset safely

\`tiled_add_tileset_to_map\` prepares a proposal for attaching one existing
project-local external atlas TSJ. Despite its name, it is preview-only and
does not write the map, TSJ, or source image.

1. Call \`tiled_get_map_summary\` immediately before planning. Keep its exact
   map \`revision\` and complete \`dependencyRevisions\`.
2. Call \`tiled_add_tileset_to_map\` with:
   - \`mapPath\` and the project-relative \`tilesetPath\`;
   - \`expectedMapRevision\` from that summary;
   - the complete \`expectedDependencyRevisions\` from the same summary;
   - optional \`expectedTilesetRevision\` when the caller already has a trusted
     revision for the target TSJ.
3. Inspect the returned proposal, including the canonical tileset path,
   map-relative source, TSJ revision, atlas tile count, reserved \`gidSpan\`,
   assigned \`firstGid\`, complete \`gidRange\`, and opaque
   \`changeSetId\`. Present it for client-side approval.
4. After explicit approval, call \`tiled_apply_change_set\` with that
   \`changeSetId\` and the proposal's \`expectedRevision\`.
5. Call \`tiled_get_map_summary\` again after apply. Use the newly returned
   tileset \`assetId\` in sheets, searches, \`TileRef\` values, and later
   edits. Never derive an asset ID from a path.

The proposal pins the current map, every existing map dependency, and the
prospective TSJ revision. A conflict requires a fresh summary and proposal.
This operation only adds a tileset reference; it does not create a layer.

## Create an empty layer safely

\`tiled_create_layer\` prepares one preview-only proposal for a finite
orthogonal TMJ. It supports \`tilelayer\`, \`objectgroup\`,
\`imagelayer\`, and \`group\`.

1. Read \`tiled_get_map_summary\` and pass its exact \`revision\` as
   \`expectedMapRevision\` plus its complete \`dependencyRevisions\`.
2. Supply a non-empty \`name\`; omit \`parentGroupId\` for the root or use
   an existing Group layer ID. Optional \`index\` is zero-based within that
   sibling array; omission appends the layer at the top.
3. For \`imagelayer\`, pass a canonical project-relative \`imagePath\` and
   optionally \`expectedImageRevision\`. The proposal reports the pinned
   image revision, derived map-relative source, and inspected dimensions.
   Other layer types reject both image fields.
4. Inspect the assigned layer ID, placement, allocated cell count, and image
   pin, then obtain client approval and call \`tiled_apply_change_set\`.
5. Re-read the map summary before using the new numeric layer ID.

Tile layers inherit the finite map dimensions and start filled with GID zero.
The server advances the existing \`nextlayerid\`; it never fills an ID gap
or silently repairs a stale counter.

## Preview, approve, then apply

All edits are explicit operations. Supported tile operations are \`setTiles\`,
\`fillRegion\`, and \`replaceTiles\`; supported object operations are
\`createObject\`, \`updateObject\`, and \`deleteObjects\`.

A \`replaceTiles\` operation has a numeric \`layerId\`, one to 128
\`mappings\` shaped as \`{from: TileRef, to: TileRef|null}\`, and an optional
absolute tile \`region\` shaped as \`{x,y,width,height}\`. \`from\` cannot be
\`null\`; use \`to:null\` to clear matched cells. Omitting \`region\` scans the
tile layer's own complete bounds.

Replacement matching is exact over the complete encoded GID, including
transform and raw flag bits. An omitted transform means identity, not a
wildcard, and the target describes the complete final transform. Mappings in
one operation are evaluated simultaneously in a single pass: with \`A->B\`
and \`B->C\`, cells that originally held A become B rather than C. Swaps and
cycles follow the same rule.

Across one change set, replacement operations may scan at most 1,000,000
cells. Only actual matches count toward the 100,000 total tile-cell write
limit shared with set/fill. Zero matches are a valid no-op: inspect the
preview's scanned and replaced counts, and expect apply not to rewrite the
map.

1. Call \`tiled_preview_edits\` with:
   - the project-relative \`mapPath\`;
   - the exact map \`expectedRevision\` from the latest summary/read;
   - the complete \`expectedDependencyRevisions\` record from that same
     snapshot;
   - a bounded, closed list of operations.
2. Treat the returned operation summary as a proposal, not authorization.
   Present the affected layers, cell/object counts, destructive warnings, and
   important samples to the user. The MCP client owns the approval step.
3. After explicit approval, call \`tiled_apply_change_set\` with the opaque
   \`changeSetId\` and the proposal's exact \`expectedRevision\`.

A change set is bound to its map and every pinned existing or prospective
dependency revision, and expires after its reported \`expiresAt\`. Do not
derive, edit, persist as a durable job, or reuse a \`changeSetId\` for different
operations. If it is missing or expired, re-read the map and preview a new
proposal.

\`tiled_preview_edits\` validates and stores a proposal but does not write the
map. \`tiled_add_tileset_to_map\` and \`tiled_create_layer\` are also
preview-only. \`tiled_apply_change_set\` is the write boundary for all
proposal types. A
textual confirmation argument, prompt, or guide instruction is never a
substitute for client-side approval.

## Verify after a commit

After a successful apply:

1. Keep the returned new revision as the current map revision.
2. Call \`tiled_validate\`.
3. Re-read the affected region or objects.
4. Call \`tiled_render_preview\` for the affected area and compare it with the
   intended result. If \`tiled_render_map\` is registered, it may provide a
   fuller Tiled-rendered check for semantics outside native preview v1.

Every write creates a recovery checkpoint before replacement.
\`tiled_list_checkpoints\` lists bounded checkpoint metadata and corrupt
entries without reading the stored document bytes.

To restore one checkpoint safely:

1. Select a checkpoint from \`tiled_list_checkpoints\`, then read the target
   document again and retain its exact current SHA-256 revision.
2. Call \`tiled_preview_checkpoint_restore\` with only that \`checkpointId\`
   and \`expectedRevision\`. It validates the manifest, exact pre-write JSON
   bytes and current target without writing.
3. Present the destructive warning, target path, current/restore revisions,
   restore byte count, and \`wouldChange\` result for client approval.
4. Apply the returned opaque change set through
   \`tiled_apply_change_set\`, then re-read and validate the target.

Restore replaces one existing JSON document with exact checkpoint bytes and
creates another checkpoint for the version being replaced. It does not restore
referenced tilesets, images, or other files. A checkpoint made before creating
a new file cannot be used to delete that file.

## Conflict and failure handling

- On \`REVISION_CONFLICT\`, stop. Re-read the map summary and dependencies,
  reconsider the operations against the new state, and issue a fresh preview.
  Never blindly replay a stale plan.
- On an unsupported-profile or rendering error, narrow the request or use an
  advertised adapter. Do not assume omitted content was validated visually.
- On a size, region, cell, layer, atlas, or image budget error, split the work
  into smaller bounded requests.
- On validation failure, inspect diagnostics before proposing another change.
- Do not mutate files outside TiledMCP while relying on a previously observed
  revision. Revisions are SHA-256 identities of the exact bytes that were read.

## Creating a map

\`tiled_create_map\` creates a new finite orthogonal TMJ and refuses to
overwrite an existing path. Parent directories must already exist. After
creation, use its returned revision for subsequent reads and proposals. The
new map starts without tileset references or layers. You may attach an
existing atlas with \`tiled_add_tileset_to_map\`, create an empty layer with
\`tiled_create_layer\`, then re-read the map summary before planning tile or
object edits.
`;

const guideBytes = Buffer.from(GUIDE_RESOURCE_TEXT, "utf8");

export const GUIDE_RESOURCE_SIZE = guideBytes.byteLength;
export const GUIDE_RESOURCE_REVISION = revisionOf(guideBytes);

if (GUIDE_RESOURCE_SIZE > MAX_GUIDE_RESOURCE_BYTES) {
  throw new Error(
    `The embedded TiledMCP guide is ${GUIDE_RESOURCE_SIZE} bytes; limit is ${MAX_GUIDE_RESOURCE_BYTES}.`,
  );
}

const guideMeta = {
  revision: GUIDE_RESOURCE_REVISION,
  size: GUIDE_RESOURCE_SIZE,
  serverVersion: SERVER_VERSION,
} as const;

export function registerGuideResource(server: McpServer): void {
  server.registerResource(
    "guide",
    GUIDE_RESOURCE_URI,
    {
      title: "TiledMCP safe editing guide",
      description:
        "A concise workflow for inspecting, previewing, approving, applying, and verifying safe Tiled map edits.",
      mimeType: GUIDE_RESOURCE_MIME_TYPE,
      size: GUIDE_RESOURCE_SIZE,
      annotations: {
        audience: ["assistant", "user"],
        priority: 1,
      },
      _meta: guideMeta,
    },
    (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: GUIDE_RESOURCE_MIME_TYPE,
          text: GUIDE_RESOURCE_TEXT,
          _meta: guideMeta,
        },
      ],
    }),
  );
}
