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

Use \`tiled_analyze_usage\` when you need a read-only inventory of the whole
map rather than a selected region. It recursively scans every finite tile-layer
cell and every object layer, including hidden layers and Groups; objects with a
\`gid\` contribute tile-object references. Tile frequency is aggregated by base
\`tileset assetId + localId\`, while identity/transformed totals and complete
raw flag combinations remain available separately.

The response contains bounded layer-density, tileset/unused-local-ID, and
top-tile summaries. Treat their returned items and unused-ID samples as
potentially truncated. One call may scan 1,000,000 cells plus objects and
aggregate 100,000 distinct tiles. Layer and tileset summaries are capped at 64
each; \`topTileLimit\` defaults to 64 and is capped at 128; the complete result
is capped at 256 KiB.

The optional \`expectedMapRevision\` and \`expectedDependencyRevisions\` inputs
must be supplied together. When used, pass the map revision and complete
dependency record from the same summary unchanged. The server checks that
exact read set before and after analysis, but the result still correctly says
\`snapshotConsistency: "non-atomic-read-set"\` because several files are not
read as one atomic snapshot.

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
\`fillRegion\`, \`replaceTiles\`, and \`stampPattern\`; supported object
operations are \`createObject\`, \`updateObject\`, and \`deleteObjects\`;
supported layer operations are \`updateLayer\`, \`deleteLayer\`,
\`moveLayer\`, and \`duplicateLayer\`.

Use \`{type:"updateLayer", layerId, patch}\` to update an existing
\`tilelayer\`, \`objectgroup\`, \`imagelayer\`, or \`group\`. This is the
seventh operation in the generic preview union, not a standalone tool, so the
registry remains 18 core tools or 19 when the rasterizer is available. The
patch must contain at least one field and may contain only:

- \`name\`, \`className\`, \`visible\`, and \`opacity\`;
- \`offsetX\`, \`offsetY\`, \`parallaxX\`, and \`parallaxY\`;
- \`tintColor\`, \`locked\`, and \`blendMode\`.

They map respectively to the Tiled JSON members \`name\`, \`class\`,
\`visible\`, \`opacity\`, \`offsetx\`, \`offsety\`, \`parallaxx\`,
\`parallaxy\`, \`tintcolor\`, \`locked\`, and \`mode\`. Names and classes are
capped at 1,024 characters; opacity is 0 through 1; offset and parallax values
must be finite numbers from -1,000,000,000 through 1,000,000,000. A tint is
\`#RRGGBB\`, \`#AARRGGBB\`, or \`null\`; null deletes the member.

Blend mode is one of \`normal\`, \`add\`, \`multiply\`, \`screen\`,
\`overlay\`, \`darken\`, \`lighten\`, \`color-dodge\`, \`color-burn\`,
\`hard-light\`, \`soft-light\`, \`difference\`, or \`exclusion\`.
\`locked\` is advisory Tiled metadata, not an MCP write lock; tile and object
edits in the same batch still run.

Writing the same value, or deleting a tint member that is already absent, is a
no-op. Writing an explicit default to an absent member is a change because the
JSON representation changed. Inspect \`requestedFields\`, \`changedFields\`,
\`wouldChange\`, and \`affectsDescendants\` in the preview; Group properties
are flagged only when a changed rendering field can affect descendants. Apply
changes only through the normal revision-pinned approval flow. Changed layer
fields use member-local source patches and may safely share a batch with
tile-data and object edits. \`updateLayer\` itself does not move or delete
layers; deletion and moving use the exclusive operations below.

Use \`{type:"deleteLayer", layerId, deleteDescendants?}\` to permanently remove
an existing layer. It is the eighth generic operation, not a standalone tool,
so the registry remains 18 core tools or 19 with the rasterizer. A
\`deleteLayer\` change set must contain exactly this one operation; do not mix
it with tile, object, or layer updates.

A leaf layer or empty Group can be deleted directly. A non-empty Group requires
\`deleteDescendants:true\`; approval then removes the selected Group, every
descendant layer, and all owned tile data, image-layer references, and objects.
It does not delete referenced image or TSJ files. Children are not promoted and
ancestors are neither emptied nor removed.

When objects would be removed, surviving direct object properties and typed
object items inside Tiled 1.12 lists are checked for dangling references and
block deletion. Surviving class properties fail closed because they may hide
typed object references. References wholly inside the deleted subtree leave
with it. A locked layer is still deletable because \`locked\` is advisory, but
the preview includes \`lockedLayerCount\` and a warning.

Treat this preview as destructive. It reports complete deleted-layer,
descendant, object, and locked-layer counts, but returns at most 32 layer IDs
and 32 object IDs; use the omitted counts rather than treating samples as
complete. Apply preserves the \`nextlayerid\` and \`nextobjectid\` high-water
marks. Its array-element-local source patch removes one element from the direct
parent's \`layers\` array while preserving untouched source bytes. The normal
revision-pinned approval, checkpoint, and apply flow remains mandatory.

Use \`{type:"moveLayer", layerId, parentGroupId?, index}\` to reorder a layer
or move it into or out of a Group. This is the ninth generic operation, not a
standalone tool, so the registry remains 18 core tools or 19 with the
rasterizer. A move change set must contain exactly one operation and cannot be
mixed with tile, object, update, delete, or another move.

Omit \`parentGroupId\` for the root \`layers\` array; input \`null\` is not
accepted. An explicit parent must be an existing Group. \`index\` is the
zero-based final JSON sibling index after removal and insertion: for a
same-parent array of original length n the range is 0 through n-1, while a
cross-parent destination of original length m accepts 0 through m. A
same-parent request whose source and target indexes match is a no-op and leaves
the file bytes unchanged.

A Group always moves with its complete subtree. It cannot move into itself or
one of its descendants, and the resulting tree must stay within the depth-64
limit. Moving never reallocates IDs or changes the \`nextlayerid\` and
\`nextobjectid\` high-water marks. \`locked\` is advisory and does not block
the move. Inspect \`effectivelyLockedLayerCountBefore\` and
\`effectivelyLockedLayerCountAfter\` because changing parent can change an
inherited lock without rewriting any child member.

The preview reports source and target parent/index, complete subtree,
descendant, object, and locked-layer counts, plus at most 32 preorder layer IDs
and an omitted count. It separately flags \`wouldChange\`,
\`renderOrderMayChange\`, \`renderContextMayChange\`, and
\`affectsDescendants\`; changing parent can alter inherited Group rendering
context as well as draw order.

Apply uses a dedicated \`JsonArrayMove\`. Both container paths are resolved
against the original source snapshot, so removing an earlier root sibling
cannot misaddress a later target Group. The exact source element bytes are
moved, preserving subtree formatting, unknown fields, number/string lexemes,
BOM, and CRLF outside the necessary array seams. Apply still replans, verifies
the digest and revisions, and commits only through the normal lock, raw-byte
CAS, checkpoint, and atomic-replacement flow.

Use \`{type:"duplicateLayer", layerId, destination?, name?}\` to copy any
supported layer or a complete Group subtree. This is the tenth generic
operation, not a standalone tool, so the registry remains 18 core tools or 19
with the rasterizer. A duplicate change set must contain exactly one operation.

\`destination\` has exactly three branches:

- \`{kind:"sameParent", index?}\`;
- \`{kind:"root", index?}\`;
- \`{kind:"group", parentGroupId, index?}\`.

Omitting \`destination\`, or omitting \`index\` in \`sameParent\`, inserts at
the source's current \`sourceIndex + 1\`. Omitting the index for \`root\` or
\`group\` appends to that target array. An explicit index is the zero-based
final insertion index and must be in \`0..targetLength\`; duplication does not
remove the source. A Group cannot be copied into itself or a descendant. The
optional \`name\` is at most 1,024 characters, may be empty, and overrides only
the copied subtree root.

Every layer and object in the complete copy receives a new ID in preorder,
starting at the map's existing \`nextlayerid\` and \`nextobjectid\` high-water
marks. Gaps are not reused. If there are no copied objects,
\`nextobjectid\` is unchanged. Direct typed object properties and object items
inside nested Tiled 1.12 lists are rewired when they point within the copy.
References to existing objects outside the copy and ID zero are retained;
dangling references are rejected. Ordinary integer properties are not guessed
to be layer or object references. Typed layer references, class properties,
and object templates fail closed because their reference semantics cannot yet
be proven safe.

Image-layer image paths and file properties remain shared external references;
no referenced file is copied or modified. Tile-layer cells and tile-object
GIDs are validated against current tileset bindings, while a valid tile
object's complete encoded GID, including transform flags, is preserved.
\`locked\` remains advisory. The preview reports the copied subtree's explicit
locked count and its \`effectivelyLockedLayerCount\` under the target's
inherited Group locks.

A resulting map may contain at most 10,000 layers and 100,000 objects. One
duplicate may copy at most 10,000 objects and 100,000 finite uncompressed tile
cells, and the resulting layer depth is capped at 64. The compact serialized
copy is capped at 16 MiB and the projected edited TMJ at 64 MiB.

Each \`duplicatedLayers\` summary item contains exactly:
\`operationIndex\`, \`sourceLayerId\`, \`createdRootLayerId\`, \`layerType\`,
\`name\`, \`nameTruncated\`, \`sourceParentGroupId\`,
\`targetParentGroupId\`, \`sourceIndex\`, \`targetIndex\`,
\`copiedLayerCount\`, \`descendantLayerCount\`, \`copiedObjectCount\`,
\`allocatedCellCount\`, \`serializedDuplicateBytes\`,
\`layerIdMappingSample\`, \`omittedLayerMappingCount\`,
\`objectIdMappingSample\`, \`omittedObjectMappingCount\`,
\`remappedInternalObjectReferenceCount\`,
\`retainedExternalObjectReferenceCount\`, \`fileReferenceCount\`,
\`tileObjectCount\`, \`lockedLayerCount\`,
\`effectivelyLockedLayerCount\`, \`renderOrderMayChange\`,
\`renderContextMayChange\`, and \`affectsDescendants\`. Each preorder ID
mapping sample is capped at 32 entries; use its omitted count.

The new element is compact JSON, but the original subtree, existing siblings,
unknown fields, BOM, CRLF, key order, and untouched numeric/string lexemes keep
their exact source bytes. Only the insertion and value-local high-water
counter patches are synthesized. Preview pins the map and complete dependency
revision set. Apply replans destination, allocation, references, limits,
summary, and source patches, verifies the digest and raw-byte CAS, then uses
the normal lock, write-ahead checkpoint, and atomic replacement.

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

Use
\`{type:"stampPattern", layerId, x, y, pattern:(TileRef|null)[][]}\` for a
dense rectangular tile stamp. This is the eleventh generic operation, not a
standalone tool, so the registry remains 18 core tools or 19 with the
rasterizer. The row-major pattern must be non-empty and rectangular: every
row is non-empty and has the same width, with no sparse holes or
\`undefined\`. Width and height are each capped at 256 and the complete
pattern at 16,384 cells.

\`x\` and \`y\` are the absolute tile coordinates of the pattern's top-left
cell. The complete rectangle must fit the target tile layer; no clipping is
performed. Every entry writes its target: a \`TileRef\` writes its complete
encoded GID, while \`null\` explicitly clears the cell to GID zero. Null is
not transparent and does not skip a cell; there is no skip sentinel. To clear
a plain rectangle, \`fillRegion\` with \`tile:null\` remains available.

Operations execute in change-set order and later overlapping operations win.
This applies across stamps, set/fill, and replacement; replacement remains
simultaneous only within its own single-pass mapping operation. Every pattern
cell counts toward the shared 100,000-cell write budget, even when the target
already has the same GID.

The preview includes normalized region and cell/change counts. Its
\`sample\` contains only the first eight row-major cells as absolute
\`{x,y,tile}\` entries, including null entries; use \`omittedCellCount\` and
the complete counts rather than treating that sample as the whole pattern.
Apply uses a member-local patch for only the target layer's \`data\`. If all
encoded GIDs already match, the stamp is a no-op; when the whole plan is also
a no-op, apply returns \`changed:false\` and preserves the exact file bytes
and revision.

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
