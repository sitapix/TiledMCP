import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { revisionOf } from "../storage/revision.js";
import { SERVER_VERSION } from "../version.js";

export const GUIDE_RESOURCE_URI = "tiled://guide";
export const GUIDE_RESOURCE_MIME_TYPE = "text/markdown";
export const MAX_GUIDE_RESOURCE_BYTES = 96 * 1024;

export const GUIDE_RESOURCE_TEXT = `# TiledMCP safe editing guide

TiledMCP inspects and edits Tiled project files under one configured project
root. Treat every path as a project-relative POSIX path. Absolute paths and
\`..\` traversal are rejected.

## Discover the active surface

1. Call \`tiled_get_capabilities\` and inspect \`registeredTools\`, the edit
   profile, renderer limits, local CLI availability, and
   \`applicationErrorContract\`. Also inspect \`assetIdentityContract\` before
   persisting asset IDs: it declares path-first resolution, best-effort rename
   evidence, internal metadata effects, registry-loss behavior, and crash
   durability. Inspect \`mapCreationCapabilities\` before creating a map: it
   declares the one direct no-preview exception, exact format/version limits,
   approval boundary, retry semantics, and no-replace behavior. Before any
   write, inspect \`filesystemThreatModelContract\`: its guarantees apply only
   when the declared operational requirements hold. Also inspect
   \`checkpointCapabilities.storagePolicy\` for the active retained-byte quota,
   entry limit, GC roots, and fail-closed deletion policy, and inspect
   \`checkpointCapabilities.preparedDiscard\` and
   \`checkpointCapabilities.preparedAdjudication\` before resolving a
   prepared checkpoint.
2. Use MCP \`resources/list\` and read \`tiled://application-errors\` when the
   complete current application-code allowlist is needed.
3. Call \`tiled_list_files\` to discover project-relative map and tileset paths.
4. Only call optional tools such as \`tiled_render_map\` when they appear in
   \`registeredTools\`. The built-in \`tiled_render_preview\` is the portable
   map preview path.

The M1 edit profile is intentionally narrow: finite orthogonal TMJ maps,
external atlas TSJ tilesets, uncompressed tile-layer arrays, and rectangle,
point, ellipse, Tiled 1.12 capsule, bounded polygon/polyline, and bounded text
objects.
Unsupported Tiled semantics fail closed instead of being approximated.

## Filesystem threat model

The direct filesystem backend protects existing-target commits against
writers that use the same normalized project path and honor the TiledMCP lock.
This contract covers project-asset JSON document targets and explicitly
excludes server-internal \`.tiledmcp\` state.
It detects different external bytes visible before the final SHA-256 check,
but ordinary rename is not conditional: a non-cooperative writer can still
save between that check and promotion. Pause Tiled autosave and other writers
during commits. When \`changed:true\`, the success records a promotion event,
not a lease on the current path; re-read before making another state-dependent
decision.

Static symlinks and path escapes are rejected. A same-privilege hostile local
process that swaps a parent directory during a call is outside this backend's
boundary. Hardlink aliases also do not share a path lock. Strict isolation
requires an OS sandbox or mediated writer, neither of which is implemented.
\`tiled_create_map\` is stronger only for target existence: its hard-link
promotion atomically refuses a destination created by another process.

## Read tool results

For calls that reach a tool handler, treat \`structuredContent.result\` as the
authoritative machine-readable value. The accompanying text block is
\`tiled-mcp-summary\` v1: compact one-line JSON, at most 1024 UTF-8 bytes, and
it intentionally does not copy the full success result or application-error
\`details\`. Do not parse the summary to recover omitted result fields.

A success summary reports the byte size of the complete structured content.
For an image result it also reports the image MIME type and the raw inline
image byte count; this is not the base64 character count. An application-error
summary reports a stable code, a bounded single-line message, and whether that
message was truncated. Read the authoritative bounded application-error
envelope from \`structuredContent.result.error\`.

\`tiled_get_capabilities.textContentContract\` advertises the active summary
version, encoding, byte limit, full-result location, byte measurement, and
input-error boundary. Input-schema errors are rejected by the MCP SDK before a
handler runs, so they remain SDK-owned text-only responses and do not use this
application-level summary envelope.

## Handle application errors

The current v1 application-error registry contains 103 codes. Its committed
machine artifact is \`contracts/application-errors.v1.json\`, and the same JSON
is available at the direct resource \`tiled://application-errors\`.
\`tiled_get_capabilities.applicationErrorContract\` advertises that resource's
URI, revision, size, wire location, fallback, and compatibility policy.

For a tool application error, branch only on
\`structuredContent.result.error.code\`. \`INTERNAL_ERROR\` is the safe fallback
for an unexpected handler failure. Existing v1 identifiers and meanings are
stable, but a newer server may add codes. Treat an unknown code as a generic
application failure, refresh \`tools/list\`, capabilities, and resource
discovery, and do not reinterpret it as success.

The bounded \`message\` is for people. The bounded opaque \`details\` object has
no stable v1 fields. Do not parse either value for control flow. The registry
does not include MCP SDK input errors, \`cli.*.issues[].code\` capability-probe
diagnostics, startup fatal errors, \`tiled_validate\` validation diagnostics,
checkpoint reconciliation diagnostics, or raw operating-system error codes.
Keep those surfaces on their own contracts.

\`ASSET_REGISTRY_CORRUPT\` and \`ASSET_REGISTRY_LIMIT_EXCEEDED\` are stable
application codes when the server encounters those states during a tool call.
Stop identity-dependent work instead of rebuilding silently. Inspect or restore
corrupt metadata; archive or remove a full registry only when invalidating all
saved asset IDs is explicitly acceptable. An invalid registry already present
at startup is a fatal startup error rather than a tool envelope.

When the optional \`tiled_render_map\` is registered, its successful structured
result uses the traceable PNG contract only; there are no legacy
\`mapPath\`/\`bytes\`/\`width\`/\`height\` aliases. Read \`pixelSize\`,
\`byteLength\`, and \`sha256\` as metadata for the same bounded PNG buffer used
by the MCP image block. Also retain \`map\`, \`dependencyRevisions\`,
\`renderer\`, and the effective \`options\`. The dependency revision record
covers external TSJ files only, and a successful inline result reports
\`truncated:false\`.

Root-atlas, per-tile, and image-layer references are normalized and deduplicated
as one input image set: at most 64 images, 64 MiB of source bytes, 16,000,000
decoded pixels, and 8192 pixels on either edge of any image. TiledMCP reads a
coherent single-file snapshot of every image before and after the render, then
compares the complete internal path/revision set. Those image revisions are
deliberately omitted from the public result; \`dependencyRevisions\` remains
external-TSJ-only.

The rasterizer result is deliberately
\`snapshotConsistency:"non-atomic-read-set"\`. TiledMCP also rechecks the map
and external TSJ revisions before and after the external render, but
\`tmxrasterizer\` reads live files. Per-file pre/post equality cannot rule out
an intervening ABA change and does not create an atomic read set. Do not treat
this result as an atomic map/tileset/image snapshot.

## Inspect before planning

For an existing map:

1. Call \`tiled_get_map_summary\`. Keep its map \`revision\`,
   \`dependencyRevisions\`, layer IDs, and tileset \`assetId\` values together.
   It also returns normalized \`renderOrder\` and, when serialized, bounded
   \`backgroundColor\` and \`className\`; inspect \`classNameTruncated\`
   before treating a class as complete.
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
4. When search returns a sparse candidate set, call \`tiled_render_tiles\`
   with 1 to 64 unique local IDs in the desired comparison order. Pass the
   optional map and selected-tileset revision pins from the search response
   unchanged. The result labels static raw atlas cells in that same order;
   it never sorts, deduplicates, lowers scale, or drops selected IDs.
5. Use \`tiled_get_region\` for a bounded tile rectangle and
   \`tiled_list_objects\` for bounded object discovery. Before replacing points
   or deleting a polygon/polyline, or replacing text content/style, call
   \`tiled_get_object\` with the listed object ID to obtain its complete
   bounded semantic projection and current map/dependency revisions.
6. Use \`tiled_render_tileset_sheet\` with that \`mapPath\` and
   \`tilesetAssetId\` to browse consecutive local tile IDs. Pages are zero-based.
7. Use \`tiled_render_preview\` to inspect the current map or a bounded region.
   Grid and coordinate overlays can make tile positions explicit. Use up to 64
   fixed-style absolute tile rectangles in \`overlays.highlights\` to call out
   a bounded selection without editing the map. To inspect supported object
   edits, pass 1 to 64 unique IDs in \`overlays.objectIds\`; this explicit
   geometry selection is independent of tile \`layerIds\`.

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
\`omittedLayers\` and the declared \`renderProfile\`. It does not implicitly
render complete object layers. Unsupported drawing semantics are reported or
rejected rather than silently rendered incorrectly.

Each highlight rectangle is strict \`{x,y,width,height}\` in absolute map tile
coordinates. It must intersect the effective \`tileRegion\`; a partial overlap
is clipped and reported with ordered \`requestedTileRect\`,
\`renderedTileRect\`, and \`clipped\` metadata, while a disjoint or
safe-integer-overflowing rectangle rejects the whole render. The fixed
\`selection-amber-v1\` overlay is a borderless RGBA \`(250,204,21,96)\`
\`source-over\` fill. Repeated and overlapping rectangles are rendered as one
tile union, so their input order cannot change the PNG. The result always
reports the fixed style/color/modes, bounded entries, and exact
\`highlightedTileCount\`; without requested highlights those are an empty list
and zero. Highlight work shares the native preview pixel-blend limit.

\`overlays.objectIds\` is strict, ordered, unique, all-or-error, and limited to
64 positive safe IDs. The fixed
\`explicit-basic-object-geometry-v4\` overlay draws rectangle, point, ellipse,
Tiled 1.12 capsule, polygon, and open polyline geometry in opaque cyan with a
one-pixel stroke and 5-pixel origin crosshair. Text objects render only their
rotated layout box, never glyphs. Ellipses use their bounds. Capsules use
\`min(width,height)/2\` radii, two semicircles, and two straight sides. A single
zero extent becomes a bounds line; a double-zero curve becomes an
anchor-centered 20-map-pixel circle.

Tile objects render as \`tile-frame-only\`: the Tiled 1.12.2 object outline
rectangle plus the anchor crosshair, never the tile image or its collision
shapes. The frame's top-left is the anchor minus the tileset
\`objectalignment\` offset (\`unspecified\` resolves to bottom-left on
orthogonal maps) plus the tileset \`tileoffset\` scaled by object size over
tileset tile size; omitted or zero dimensions default to the tileset tile
size, and rotation turns the frame around the anchor. Flip flags — including
the preserved raw \`0x10000000\` bit — mirror only the image, so the outline
never changes, exactly matching Tiled's own tile object outlines. Dangling or
empty GIDs, a \`gid\` combined with a shape marker, unknown \`objectalignment\`
values, and malformed \`tileoffset\` members fail closed instead of drawing a
placeholder. Frame resolution re-reads the selected tilesets under their
pinned dependency revisions and rejects drift.

Pass \`overlays.tileObjectCollision: true\` together with \`objectIds\` to also
draw each selected tile's collision shapes, following Tiled 1.12.2's
"Show Tile Collision Shapes" exactly: collision shapes reuse the tile image's
fragment transform, so object-over-tile scaling, H/V/D flips, the 90-degree
anti-diagonal rotation, and the scaled tile offset all apply identically,
while each collision object's own x/y and rotation apply first in tile space.
Hidden collision objects are still drawn and the collision group's position,
draw order, and color are ignored, as in Tiled. Point collision objects use
the fixed 5-pixel crosshair instead of Tiled's pin marker. Selected tile
entries then report \`representation:"tile-frame-and-collision"\` with an
exact \`collisionObjectCount\`. Collision ellipses and capsules share the
curve-segment budgets via a conservative affine-scaled radius, polygon and
polyline points share the 8192-point budget, and each tile is limited to 128
collision shapes with 1024 across the selection. Collision objects carrying
\`gid\` or \`template\`, conflicting shape markers, unknown members, negative
extents, and tilesets with a non-default \`fillmode\` fail closed.

Curve tessellation uses uniform angles in continuous output space with at most
0.25 pixels of chord error, at least 12 segments rounded to a multiple of four,
at most 4096 segments per object, and at most 65536 across the selection. A
conservative rotated-bounds check skips fully offscreen curves before
tessellation; any remaining segment-budget overflow rejects the whole preview
without reducing precision. The closed \`curveTessellation\` result and
capability fields report this policy exactly.

Coordinates are map pixels: local path points rotate clockwise around the
object's \`x/y\` anchor before scale and region cropping. Fully offscreen objects
remain in ordered metadata as
\`rendered:false, clipped:true\`; the service never drops them silently.
The debug representation includes both the geometry/text-box stroke and origin
marker: \`rendered\` means at least one pixel from either was written inside the
content rectangle, while \`clipped\` means any segment or marker arm was partly
or wholly clipped. Both flags can therefore be true.
Explicit debug selection ignores object/layer visibility and opacity, as
reported by \`visibilityPolicy\`. It rejects templates and
selected layer/group positioning with non-default x/y, offset, or parallax.
Selected path geometry is capped at 8192 points, and clipped stroke work shares
the native preview pixel-work limit. Use \`tiled_render_map\` or Tiled for full
object-layer, font, tile-image, antialiased curve styling, and collision
rendering.

## Attach an existing tileset safely

\`tiled_add_tileset_to_map\` prepares a proposal for attaching one existing
project-local external atlas TSJ. Despite its name, it is preview-only and
writes nothing: identity resolution on read and preview paths is lock-free
and side-effect-free, as advertised by
\`assetIdentityContract.identityPersistenceBoundary\`. Asset-identity
evidence is persisted only when \`tiled_apply_change_set\` commits a
document edit.

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

Asset IDs are backed by project-internal persistent metadata. Same-path
replacement preserves the ID. A uniquely matched ordinary same-filesystem
rename preserves it on a best-effort basis only when inode and birthtime
evidence are stable and nonzero. A copy or hard link gets a new ID while the
original path remains;
if a new hard-link path was not observed before the old path was removed, its
final file identity is indistinguishable from a rename and may inherit the old
ID. Cross-filesystem moves and other unmatched changes do not preserve it.
Always fetch a fresh map snapshot after a path change; an old change set never
follows a rename automatically.

## Update tile metadata safely

\`tiled_update_tile\` is the dedicated preview tool for per-tile metadata in
one currently referenced external atlas TSJ. It is the first tileset write
surface: address the tileset with \`mapPath\` plus the opaque
\`tilesetAssetId\`, and pin both \`expectedMapRevision\` and
\`expectedTilesetRevision\`. The returned change set's \`expectedRevision\` is
the TSJ revision — pass that value to \`tiled_apply_change_set\`. Applying
commits only the tileset file; maps are never touched, but pending map change
sets pinned to the old tileset revision will conflict afterwards and must be
re-previewed.

One call carries 1–64 unique \`tileId\` updates, each patching any of
\`probability\`, \`className\`, and \`animation\`. Setting \`probability\` to
\`null\` or the Tiled default \`1\` removes the serialized member. \`className\`
updates an existing \`class\` member and otherwise writes the Tiled 1.12.2
canonical \`type\` member; a tile carrying both members fails closed as
ambiguous, and \`null\` removes the class. \`animation\` is a whole-array
replacement of \`{tileId, durationMs}\` frames — at most 256 per tile, every
frame id inside the tileset range, durations positive bounded integers — and
serializes as Tiled \`{tileid, duration}\` members; \`null\` removes it.

\`properties\` applies bounded scalar set/remove operations to the tile's
custom properties: at most 32 sets and 32 removals per tile, writable types
\`string\`, \`int\`, \`float\`, \`bool\`, \`color\`, and \`file\`, always
written with an explicit \`type\` member. New properties insert in Tiled's
name-sorted order (an unsorted existing array fails closed for inserts),
existing entries are updated in place, and removing a missing name is a
no-op. Targeting a \`class\`, enum, \`list\`, or \`object\` property fails
closed with \`UNSUPPORTED_PROPERTY_WRITE\`; untouched complex entries are
preserved. Color values accept \`#RRGGBB\` or \`#AARRGGBB\` and are stored
verbatim — Tiled itself normalizes to \`#aarrggbb\` on its next save.

Edits patch only the targeted \`tiles[]\` entry members and preserve every
other byte, including unknown members and the tileset's version stamps.
A tile whose entry does not exist yet gets a new entry inserted in ascending
id order; an entry reduced to only its \`id\` is removed, matching how Tiled
omits metadata-free tiles. An update that inserts or removes an entry must be
the only update in its change set, and a \`tiles\` array that is not sorted by
ascending id fails closed for insertions. Tile geometry, the atlas image,
GID layout, collision shapes, and per-tile properties are outside this tool.

## Detach an unused tileset safely

Use the generic \`{type:"removeTilesetFromMap", tilesetAssetId}\` operation
to detach one current external atlas binding. This is the fourteenth generic
operation, not a standalone tool, so the registry remains 28 core tools or 29
when the rasterizer is available. The strict operation must be the only item
in its change set. Copy the opaque \`tilesetAssetId\` from a current map
summary; do not substitute a path, tileset name, or derived ID.

The planner recursively scans every finite tile-layer cell and every object
in every object layer, including hidden or locked layers and all Group
descendants. Tile objects with a \`gid\` are references too. Cells and objects
share a 1,000,000-entry scan limit, and every non-zero encoded GID is resolved
with its transform/raw flags. If any cell or tile object uses the target
binding, the proposal fails with \`TILESET_IN_USE\`; this operation never
clears cells, deletes objects, or remaps local IDs to another tileset. Any
object with a \`template\` member fails closed with
\`UNSUPPORTED_TILESET_REMOVAL_TEMPLATE\`, because an unpinned template can
hide a tile-object GID.

A successful plan records flat fields in \`summary.removedTilesets[]\`:
\`operationIndex\`, \`assetId\`, \`tilesetPath\`, \`source\`,
\`tilesetRevision\`, \`name\`, \`nameTruncated\`, \`index\`, \`tileCount\`,
\`gidSpan\`, \`firstGid\`, \`lastGid\`, \`scannedCellCount\`, and
\`scannedObjectCount\`. The operation preview has no \`operationIndex\`; its
position in the operations array is the association. Its full shape has
top-level \`type\`, \`destructive\`, \`warning\`, \`source\`, and \`index\`,
plus
\`tileset:{kind,assetId,path,revision,name,nameTruncated?,tileCount,gidSpan}\`,
\`gidRange:{first,last}\`, and \`scanned:{tileCells,objects}\`.
\`tileset.nameTruncated\` appears only when true, and \`destructive\` is
always true. Present all fields for approval. The proposal pins the complete
dependency record from before removal, including the target TSJ.

Apply reloads and verifies that complete old dependency set, reruns the scan
and summary, and then removes only the selected element from the TMJ
\`tilesets\` array. Other bindings retain their exact \`firstgid\` and source
bytes. The TSJ, atlas image, and every other external file remain on disk.

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
\`fillRegion\`, \`replaceTiles\`, \`stampPattern\`, \`floodFill\`, and
\`copyRegion\`;
supported object operations are \`createObject\`, \`updateObject\`, and
\`deleteObjects\`; supported layer operations are \`updateLayer\`,
\`deleteLayer\`, \`moveLayer\`, and \`duplicateLayer\`; supported map-level
operations are \`updateMap\`, the exclusive \`resizeMap\`, and the exclusive
\`removeTilesetFromMap\`.

For \`createObject\`, the nested \`object\` is a strict shape-discriminated
union. Rectangle keeps optional \`width\` and \`height\`; point accepts no
dimensions. Ellipse and capsule dimensions are also optional and default to
zero. Explicit values must be finite, nonnegative, and at most 1,000,000,000.
They serialize the corresponding \`ellipse:true\` or \`capsule:true\` Tiled
marker. Polygon requires 3–256 points and polyline requires 2–256. Each point
is a strict \`{x,y}\` pair of finite local-pixel coordinates within ±1,000,000,000,
relative to the object's \`x\`/\`y\` anchor; order is preserved. Polygon closure
is implicit and polyline remains open. The server does not alter the supplied
sequence.

Polygon/polyline create wire forbids \`width\` and \`height\`; TMJ output writes
both dimensions as zero and exactly one corresponding path array. Every path
create and every complete points replacement is charged by its full payload:
one change set may contain at most 8,192 path points, and all pending change
sets together retain at most 65,536. No-op values, later replacements, and
later deletes do not refund this intent budget.

Text uses flat wire fields: required \`text\`, optional dimensions, and optional
\`fontFamily\`, \`pixelSize\`, \`color\`, \`bold\`, \`italic\`, \`underline\`,
\`strikeout\`, \`kerning\`, \`wrap\`, \`horizontalAlignment\`, and
\`verticalAlignment\`. The server serializes these as nested TMJ text data and
elides Tiled file-format defaults; omitted wrap means false even though the
Tiled UI commonly creates text with explicit wrap=true. Text is bounded to
4,096 Unicode scalars and 16,384 UTF-8 bytes and permits only TAB/LF/CR control
characters. Font families are non-empty, at most 256 scalars and 1,024 bytes,
and permit no control characters. Both reject unpaired surrogates. Pixel size
is an integer from 1 through 999.

All seven shapes can be updated or safely deleted. \`updateObject.patch\` has no
shape field, so an update cannot change shape. For polygon/polyline targets,
\`points\` replaces the complete ordered array; append, splice, and index
patches are unsupported. It may accompany common fields, while \`width\` and
\`height\` remain invalid and points on a non-path target fail with a shape
mismatch. An object-update preview's \`changedFields\` is the exact sorted list
of patch keys, not a semantic diff; an identical replacement still lists
\`points\`, while apply collapses it to an exact-byte no-op and returns
\`changed:false\` when the change set has no other net change.
Text updates may patch common fields, dimensions, and any
non-empty subset of the flat text fields; text-specific fields reject a
non-text target. Every ellipse or capsule update preserves the marker and
continues to accept zero dimensions while interpreting omitted stored
dimensions as zero and rejecting null, negative, non-finite, or oversized
values.

\`updateObject.patch.properties\` applies the same bounded scalar
custom-property profile as \`tiled_update_tile\`: at most 32 sets and 32
removals per update, writable types \`string\`, \`int\`, \`float\`, \`bool\`,
\`color\`, and \`file\`, values of at most 1,024 code points, and at most 128
resulting properties per object, each written with an explicit \`type\`
member. New names insert at Tiled's name-sorted position and inserting into
an unsorted stored array fails closed. Setting or removing a class, enum
(\`propertytype\`), list, or object property fails closed while untouched
complex entries are preserved verbatim; removing an absent name is a no-op,
and an emptied \`properties\` member is deleted, matching the Tiled writer.
All \`updateObject\` property writes in one change set are additionally
capped at 256 KiB of canonical JSON UTF-8. Inspect
\`objectPropertyUpdateCapabilities\` for the frozen policy strings. Tile
objects and templates stay outside bounded object editing, so their
properties remain unwritable, and \`tiled_get_object\` still omits custom
properties from its read surface.

Object edits remain local to the owning object layer's \`objects\`
member; creation separately advances \`nextobjectid\`. Inspect
\`objectShapeCapabilities\` for the exact create union, shape-mutation policy,
dimension/path rules, and source-patch scope; inspect
\`limits.maxPendingObjectShapePoints\` and
\`limits.maxPendingTextObjectPayloadBytes\` for pending-registry caps. Text
payload is canonical compact JSON UTF-8, capped at 256 KiB per change set and
2 MiB pending. \`tiled_get_object\` is the bounded read-before-update tool; it
returns complete path points or effective text defaults, but not raw JSON,
custom properties, vendor fields, tile objects, or templates. The registry is
28 core tools or 29 with the rasterizer. The native preview still uses tile
layers as its base image and reports visible object layers as omitted, but an
explicit \`overlays.objectIds\` selection can verify supported geometry and
text layout boxes. Use the optional rasterizer or Tiled 1.12.2 to inspect font
substitution, wrapping, glyph layout, tile objects, antialiased curve styling,
and complete layer rendering.

Use \`{type:"updateMap", patch}\` to change existing root map properties.
This is the thirteenth generic operation, not a standalone tool, so the
registry remains 28 core tools or 29 when the rasterizer is available. The
strict, non-empty patch may contain:

- \`renderOrder\`: \`right-down\`, \`right-up\`, \`left-down\`, or
  \`left-up\`;
- \`backgroundColor\`: \`#RRGGBB\`, \`#AARRGGBB\`, or \`null\` to remove
  the serialized \`backgroundcolor\` member;
- \`className\`: a string of at most 1,024 Unicode code points, mapped to root
  \`class\`.

Operations run in array order, so later map updates see earlier values.
Writing an explicit value to a missing member is a change even when it equals
a Tiled runtime default. Preview reports \`requestedFields\`,
\`changedFields\`, \`wouldChange\`, and \`renderingMayChange\`; the last flag
is true only when the render order or background actually changes. Apply uses
root object-member-local patches, preserving unrelated root members and all
layer contents. In mixed batches, \`summary.mapUpdates[*].operationIndex\`
identifies the source operation, while \`preview.operations[*]\` uses its
array position and does not repeat \`operationIndex\`. Repeated updates that
restore the original serialized values produce a file-level exact-byte no-op.

Use \`{type:"updateLayer", layerId, patch}\` to update an existing
\`tilelayer\`, \`objectgroup\`, \`imagelayer\`, or \`group\`. This is the
seventh operation in the generic preview union, not a standalone tool, so the
registry remains 28 core tools or 29 when the rasterizer is available. The
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
so the registry remains 28 core tools or 29 with the rasterizer. A
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
standalone tool, so the registry remains 28 core tools or 29 with the
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
the digest and revisions, and commits only through the normal lock with a
raw-byte revision guard (CAS for cooperative writers), checkpoint, and
atomic-replacement flow.

Use \`{type:"duplicateLayer", layerId, destination?, name?}\` to copy any
supported layer or a complete Group subtree. This is the tenth generic
operation, not a standalone tool, so the registry remains 28 core tools or 29
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
summary, and source patches, verifies the digest and revision pins, then
commits under the normal lock with a raw-byte guard (CAS for cooperative
writers), write-ahead checkpoint, and atomic replacement.

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

Across one change set, replacement, flood-fill, and copy operations share a
limit of 1,000,000 actual GID reads. Only actual replacement matches count
toward the 100,000 total tile-cell write limit shared by all tile edits. Zero
replacement matches are a
valid no-op: inspect the preview's scanned and replaced counts, and expect
apply not to rewrite the map.

Use
\`{type:"stampPattern", layerId, x, y, pattern:(TileRef|null)[][]}\` for a
dense rectangular tile stamp. This is the eleventh generic operation, not a
standalone tool, so the registry remains 28 core tools or 29 with the
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
This applies across stamps, set/fill, replacement, flood fill, and copy;
replacement remains
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

Use \`{type:"floodFill", layerId, x, y, tile:TileRef|null}\` for a bounded
paint-bucket edit. This is the twelfth generic operation, not a standalone
tool, so the registry remains 28 core tools or 29 with the rasterizer.
\`x\` and \`y\` are an absolute seed coordinate inside the finite tile
layer. Connectivity is always four-way; there is no connectivity input and
diagonal-only cells are not connected.

The source is the seed's value at the point this operation executes, after
any earlier operations in the same change set. Matching compares the complete
encoded GID, including transform and raw flag bits, so differently flipped
copies of one base tile remain separate. The target \`tile\` may be
\`null\` to clear the connected region. An empty seed is also a valid source
and can be filled with a non-null TileRef.

Operations still execute in array order: flood fill observes earlier
set/fill/stamp/replace/flood/copy results, and later operations can overwrite its
result. If source and target encode to the same GID, the planner reads and
validates only the seed, reports a no-op, and does not scan the complete
component.

\`scannedCellCount\` reports actual GID reads, not distinct coordinates. The
four-way traversal may read an already filled cell or a nonmatching boundary
neighbor more than once. Every observed value is fully resolved before
comparison; malformed, flag-only empty, or unbound GIDs fail closed. These
reads share the 1,000,000-read change-set limit with replacement and copy,
while actual changed cells share the 100,000-cell write limit with all tile
edits.

The preview returns canonical \`sourceTile\` and \`targetTile\`, absolute
\`seed\`, \`connectivity:"four-way"\`, scan/change counts,
\`wouldChange\`, and \`affectedBounds\`. Bounds are only the absolute
bounding box of changed cells, not a complete cell list; no cell sample is
returned, and a no-op has null bounds. Apply uses only a member-local patch
for the target layer's \`data\`. A net no-op preserves the exact bytes and
revision.

Use
\`{type:"copyRegion",source:{layerId,x,y,width,height},destination:{layerId,x,y}}\`
to copy one complete tile rectangle within the same map. This is the fifteenth
generic operation, not a standalone tool, so the registry remains 28 core
tools or 29 with the rasterizer. The operation, source, and destination are
strict objects and reject extra keys.

Both layer IDs must identify finite orthogonal tile layers with numeric data
arrays. All coordinates are absolute tile coordinates in their respective
layer spaces. The complete source rectangle and the destination rectangle
with the same width and height must fit their layer bounds. Copy never clips,
wraps, partially succeeds, or treats any cell as transparent. A source GID of
zero overwrites and clears its destination cell.

At the start of the operation, the planner snapshots the complete source and
complete destination before writing. Same-layer overlap therefore has
snapshot-source memmove semantics in every direction: a value written early
cannot feed a later source read. Every raw encoded GID is copied exactly,
including H/V/D and raw flag bits. Every observed source and destination GID
is reverse-validated first; malformed, flag-only empty, gap, and unbound GIDs
fail closed even when the destination would be overwritten.

Copy can be mixed with other generic operations. It sees all earlier
operation results at snapshot time, while later operations may overwrite its
destination; the common rule is sequential change-set order and last write
wins. Each copy consumes \`2 * cellCount\` reads from the 1,000,000-read
budget shared with replacement and flood fill. Its full \`cellCount\`,
including entries whose values already match, consumes the shared
100,000-cell tile-write budget.

\`summary.tileCopies[]\` contains \`operationIndex\`,
\`source:{layerId,x,y,width,height}\`,
\`destination:{layerId,x,y,width,height}\`, \`scannedCellCount\`,
\`cellCount\`, \`sourceNonEmptyCellCount\`, \`changedCellCount\`,
\`overwrittenNonEmptyCellCount\`, \`clearedCellCount\`,
\`overlapsSource\`, and \`wouldChange\`. The operation preview has the same
fields without \`operationIndex\`, plus \`type:"copyRegion"\`,
\`destructive:true\`, and a warning. It returns no cell list or sample;
approve it using the complete normalized rectangles and counts.
\`sourceNonEmptyCellCount\` counts nonzero source-snapshot GIDs.
\`overwrittenNonEmptyCellCount\` counts every nonzero GID in the
operation-start destination snapshot, whether or not that cell changes.
\`changedCellCount\` counts unequal source/destination pairs, and
\`clearedCellCount\` counts nonzero destinations actually cleared by source
GID zero.

The advertised \`tiled_get_capabilities.tileCopyCapabilities\` object is exact:
\`coordinates:"absolute-tile-coordinates"\`, \`clipping:false\`,
\`overlap:"snapshot-source-memmove"\`,
\`emptySource:"overwrites-and-clears"\`,
\`gidCopy:"exact-encoded-gid"\`,
\`observedGidValidation:"source-and-destination-fail-closed"\`,
\`operationOrdering:"sequential-change-set-order-last-write-wins"\`,
\`scanBudget:"shared-with-replaceTiles-and-floodFill-per-change-set"\`, and
\`sourcePatch:"destination-tile-layer-data-member-local"\`.
Apply recomputes both snapshots, validation, budgets, and summary from the
pinned map. Only a destination layer changed when copy executes becomes a
candidate for a member-local \`data\` patch. If a later operation restores
the original value, the final source diff still collapses to an exact-byte
no-op. A plan with no net change preserves the exact source bytes and
revision.

Use \`{type:"resizeMap",width,height,offsetX?,offsetY?}\` to resize the whole
map. This is the sixteenth generic operation, not a standalone tool, and it
must be the only operation in its change set. Its semantics follow Tiled
1.12.2 exactly: the offsets are tile units meaning the position of the old
content inside the new map, so destination cell \`(x,y)\` takes source cell
\`(x-offsetX,y-offsetY)\` and negative offsets crop from the top/left. Omitted
offsets default to zero; dimensions are integers from 1 through 100,000 and
offset magnitudes are bounded by 100,000.

Every tile layer must currently match the map bounds with a zero origin;
otherwise the whole operation fails closed with
\`UNSUPPORTED_RESIZE_LAYER_BOUNDS\`, because Tiled itself leaves resize
behavior for mismatched layers undefined. Every scanned source cell — including
cells about to be cropped — is fully GID-validated and fails closed, so
cropping can never hide malformed data. Rewritten destination cells count
against the shared 100,000-cell write budget, and source scans against a
1,000,000-cell scan budget.

Objects are only shifted by the pixel offset
(\`offsetX*tilewidth\`, \`offsetY*tileheight\`) and are never deleted;
polygon/polyline points are anchor-relative and follow automatically.
Out-of-bounds objects are preserved, and \`objectsOutsideNewBounds\` reports a
purely informational shifted-anchor test against the closed new pixel bounds.
Objects carrying a \`template\` member fail closed when a shift is required.
Image layers only shift their changed \`offsetx\`/\`offsety\` members, group
layers themselves are untouched, and \`nextlayerid\`/\`nextobjectid\` never
change. \`summary.mapResizes[]\` and the always-destructive operation preview
echo the old/new bounds, offsets, preserved/cropped nonzero cell counts, a
bounded 16-entry \`croppedCellSample\`, and moved-object counts; present them
before approval. An identity resize with no net change preserves the exact
bytes and revision.

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
map, TSJs, or images. \`tiled_add_tileset_to_map\`, \`tiled_update_tile\`,
and \`tiled_create_layer\` are also preview-only and, like every read tool,
resolve asset identities without touching the project directory; identity
metadata persists only when \`tiled_apply_change_set\` commits a document
edit. \`removeTilesetFromMap\`,
\`copyRegion\`, and \`resizeMap\` stay inside the generic preview tool and do
not add standalone tools.
\`tiled_apply_change_set\` is the write
boundary for all proposal types. A
textual confirmation argument, prompt, or guide instruction is never a
substitute for client-side approval.

## Verify after a commit

After a successful apply:

1. Keep the returned new revision as the current map revision.
2. Call \`tiled_validate\`.
3. Re-read the affected region or objects.
4. Call \`tiled_render_preview\` for the affected area and compare it with the
   intended result. For supported object edits, include their exact IDs in
   \`overlays.objectIds\` and inspect each ordered rendered/clipped entry. If
   \`tiled_render_map\` is registered, it may provide a
   fuller Tiled-rendered check for semantics outside native preview v1. Verify
   that its returned \`map.revision\` is the revision you intended to inspect,
   and retain its PNG \`sha256\`, renderer version, effective options, and
   non-atomic snapshot marker with the observation.

A net-changing apply or restore of an existing JSON document prepares a
recovery checkpoint before replacement. A no-op does not replace the target
or create a checkpoint. \`tiled_create_map\` instead prepares an
\`existed:false\` audit checkpoint; it cannot be restored as deletion.
\`tiled_list_checkpoints\` lists bounded checkpoint metadata and corrupt
entries without reading the stored document bytes.

To permanently remove one committed recovery point, call
\`tiled_preview_checkpoint_prune\` with its checkpoint ID. The preview pins
the SHA-256 revision of the raw manifest bytes without reading the stored
document blob. Present the destructive warning for approval, then pass the
returned change-set ID and expected revision to \`tiled_apply_change_set\`.
The prune tool accepts committed checkpoints only.

To drain an explicit retention backlog, call
\`tiled_preview_checkpoint_prune_batch\` with 2 through 32 distinct committed
checkpoint UUIDs selected from a current listing. The tool never chooses
retention victims from ordinals, timestamps, labels, or storage pressure.
It sorts the selected IDs into canonical UUID order, exposes that execution
order, pins every raw manifest revision, size, metadata record, and target
path, and returns one aggregate expected revision. Present the complete
ordered, non-atomic proposal for approval before applying it.

Batch apply first acquires every distinct canonical target lock in
deterministic path order and then acquires the checkpoint-store lock. Before
the first unlink it authoritatively re-reads and pins every selected committed
manifest. One missing member, including one removed by retention after
preview, or any bytes, size, path, metadata, or status drift makes the whole
batch fail with zero batch deletions. This barrier deliberately does not read
stored-before blobs and does not require an unrelated global inventory or
object set to be healthy; global completeness constrains garbage collection,
not the explicitly approved manifest set.

After the barrier, batch deletion is not atomic. It unlinks manifests in
canonical checkpoint-ID order, syncs the checkpoint directory after every
unlink, and stops on the first fault. A failure before any unlink remains a
zero-deletion application error. Once any unlink succeeds, the call resolves
to a bounded completed or partial result and caches that exact result.
Replay never resumes not-attempted members. Garbage collection runs once only
after every selected manifest has been deleted and synced; a partial result
reports GC as not run. List and preview the remaining IDs again if the
operator wants to continue.

To discard one prepared checkpoint whose current target can be verified equal
to its pre-write state, call \`tiled_preview_prepared_checkpoint_discard\` with
its checkpoint ID. An existing-file checkpoint is eligible only when the
current regular target's exact raw revision and size equal its before state. A
create checkpoint is eligible only while the target is strictly missing. The
preview pins the raw manifest revision and size, complete metadata, and target
observation without reading the stored-before blob. Present its permanent
recovery-point deletion warning for approval, then apply the returned change
set. Exact-after, unrelated, missing existing-file targets, present create
targets, unsafe targets, and equal before/after revisions remain conflicts.
This tool neither changes the project asset nor accepts force-abandon or
operator-forced-commit parameters.

Ambiguous prepared checkpoints use two separate, action-specific previews,
never a generic force flag:

- A missing create target and an existing exact-before target remain on the
  safe-discard path.
- An existing exact-after target is advanced by startup reconciliation after
  a server restart.
- A create exact-after target may be previewed for either operator-confirmed
  commit or abandon.
- A create unrelated target, missing existing target, or unrelated existing
  target may be previewed only for abandon.
- Symlinks, non-regular files, path escapes, internal targets, oversized or
  unreadable files, and read races are rejected by both actions.

Call \`tiled_preview_prepared_checkpoint_commit\` only to confirm the
create/exact-after case. It pins the complete manifest metadata, raw manifest
revision and size, target revision and size, and conflict classification in
an action-domain-separated expected revision. Applying it changes only the
manifest from prepared to committed. It does not modify the project asset or
run garbage collection. The committed manifest is an internal audit record;
because its before state is target absence, the current restore operation
still cannot restore it by deleting the target. Manifest rename is the commit
point. A later sync or lock failure returns \`manifestCommitted:true\` with
\`durability:"unconfirmed"\`; do not treat that as an unexecuted request.

Call \`tiled_preview_prepared_checkpoint_abandon\` only when the operator has
decided to preserve the current project asset and permanently remove the
ambiguous recovery point. It pins the same complete evidence in a different
hash domain. Applying it unlinks the prepared manifest, syncs the checkpoint
directory, and then runs fail-closed garbage collection. It does not read the
stored-before object, so that object's corruption cannot block explicit
abandon. Once unlink succeeds, the result remains
\`manifestDeleted:true\` even if later durability, GC, or lock diagnostics are
unconfirmed.

Both apply paths reacquire the target mutex and file lock before the
checkpoint-store lock and revalidate every manifest and target pin. Any drift
before the commit point fails with no adjudication mutation. Present the
complete action-specific proposal for approval; a commit approval cannot be
reused for abandon. Successful replay returns the first cached result and
never resumes work.

Checkpoint storage is bounded before any project-target promotion. The default
retained quota is 1 GiB with at most 10,000 observed entries, but the byte quota
is configurable, so use the advertised values. Prepared manifests reserve
their committed-state size. Under pressure, GC treats every valid prepared or
committed manifest as a root and removes only unreferenced canonical objects
and private crash temporaries. Any malformed, unexpected, symlink, non-regular,
missing-reference, unsafe-byte-accounting, or incomplete scan blocks the entire
sweep before its first deletion. An incomplete byte or entry inventory also
fails the write-capacity proof. Initial manifest publication is
create-if-absent and never replaces an existing recovery point. Quota pressure
never deletes a valid manifest. Explicit deletion paths are an approved,
raw-manifest-CAS prune of one committed checkpoint, an approved 2-through-32
committed-checkpoint batch prune, and an approved,
raw-manifest-CAS prepared discard with exact-before target proof, plus an
action-specific approved prepared abandon for an ambiguous conflict.

Automatic retention is disabled unless startup explicitly supplies
\`--checkpoint-retain-per-target N\` or
\`TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET=N\`, with N from 2 through 10,000.
That startup configuration is standing approval only for new v2 rolling,
existing-file committed checkpoints. Legacy v1, protected/create, and prepared
manifests are always retained. Rolling order comes from a durable monotonic
ordinal, never timestamps, mtimes, UUIDs, labels, or content revisions.
After a target and its new checkpoint are durably committed without a target
durability warning, retention protects the newest N rolling checkpoints and
deletes at most the oldest one per commit.

Every deletion path locks its checkpoint target before the store; batch prune
locks all distinct targets before the store. It raw-CASes the selected
manifest, unlinks it, and syncs the checkpoint directory. Single-item paths
then run the fail-closed orphan sweep, while batch prune runs it once only
after all manifests are synced. Automatic retention additionally verifies a
complete inventory, every referenced object's hash and size, the sequence,
the absence of a prepared checkpoint for that target, and that the current
target matches the newest rolling after-revision before its first unlink. A
blocked sweep deletes nothing. A failure after manifest unlink is reported as
a committed deletion with bounded diagnostics, not as a retry-safe application
failure. This
internal-state contract assumes trusted local state and writers that follow the
project-wide checkpoint lock; malicious same-privilege mutation of
\`.tiledmcp\` is outside its guarantee.

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

When \`wouldChange:true\`, restore replaces one existing JSON document with
exact checkpoint bytes and creates another checkpoint for the version being
replaced. A no-op restore does neither. Recoverability also requires an intact
checkpoint and the filesystem threat model's operational requirements. Restore
does not include referenced tilesets, images, or other files. A checkpoint
made before creating a new file cannot be used to delete that file.

Prune, batch prune, prepared discard, and prepared abandon do not leave a
tombstone: after a
successful deletion, the checkpoint is indistinguishable from an ID that was
never present. Retention may likewise invalidate an outstanding
restore/prune/batch-prune preview; a preview is not a durable lease. Batch
apply validates every member before its first unlink, so an invalidated member
makes that attempt delete none. A cached partial replay returns the same result
without resuming; after expiry or restart, list and preview again. Broader
provenance claims, project-asset deletion, and generic force adjudication are
not supported.

## Conflict and failure handling

- On \`REVISION_CONFLICT\`, stop. Re-read the map summary and dependencies,
  reconsider the operations against the new state, and issue a fresh preview.
  Never blindly replay a stale plan.
- On \`TILESET_IN_USE\`, keep the binding. Inspect the current usage and
  explicitly edit or remove every reported tile-cell/tile-object reference
  in separately approved changes before proposing removal again; this
  operation will not clear or remap them for you.
- On an unsupported-profile or rendering error, narrow the request or use an
  advertised adapter. Do not assume omitted content was validated visually.
- On a size, region, cell, layer, atlas, or image budget error, split the work
  into smaller bounded requests.
- On \`CHECKPOINT_QUOTA_EXCEEDED\`, stop mutation attempts. Do not blindly
  retry or manually delete content-addressed objects or manifests. Error
  details are opaque diagnostics and must not drive automated remediation.
  Review the advertised capability, internal-state health, and deployment
  capacity. Only after an operator independently confirms that entries remain
  within their limit and bytes alone are exhausted may you raise
  \`--checkpoint-bytes\` / \`TILEDMCP_CHECKPOINT_BYTES\` and restart. Raising
  the byte quota cannot repair an entry-limit or inventory-blocker condition.
  An operator may explicitly preview and approve pruning one committed
  checkpoint, select 2 through 32 committed IDs for one bounded batch prune,
  or discard one prepared checkpoint whose current target still exactly
  matches its pre-write state. For one of the bounded ambiguous prepared
  classifications, an operator may instead approve the dedicated commit or
  abandon preview after reviewing all pinned evidence. Batch prune does not
  select retention victims
  automatically. The optional startup retention
  policy never runs to relieve quota pressure: a new recovery root must fit
  before target promotion. Normal operation maintains N, but lowering N or a
  blocked run leaves an excess that later one-add/one-delete commits cannot
  reduce; an operator must explicitly prune that backlog. A generic force
  path remains unsupported.
- On validation failure, inspect diagnostics before proposing another change.
- Do not mutate files outside TiledMCP while relying on a previously observed
  revision. Revisions are SHA-256 identities of the exact bytes that were read.

## Creating a map

\`tiled_create_map\` creates a new finite orthogonal TMJ and refuses to
overwrite an existing path, even when the existing bytes are identical.
It is the sole direct additive no-preview mutation exception; the client must
confirm the target path before the tool call, and parent directories must
already exist. It is intentionally marked \`idempotentHint:false\`: a failed
attempt can leave a distinct prepared checkpoint, while a retry after a
successful create returns \`FILE_ALREADY_EXISTS\`. Never retry it blindly. If
a response is lost, inspect the target instead of inferring ownership from
equal bytes.

After creation, use the returned revision for subsequent reads and proposals.
The new map starts without tileset references or layers. Its automatic
checkpoint records \`before.existed:false\` and cannot be restored as deletion.
If the file landed but its checkpoint stayed prepared, automatic recovery
reports provenance ambiguity rather than claiming the creator from a hash
match. You may attach an existing atlas with
\`tiled_add_tileset_to_map\`, create an empty layer with
\`tiled_create_layer\`, then re-read the map summary before planning tile or
object edits.

## Creating a tileset

\`tiled_create_tileset\` plans a new external atlas TSJ from one existing
project image and, unlike \`tiled_create_map\`, follows the standard
preview-approve-apply flow — the direct-creation exception clause stays
frozen to \`tiled_create_map\` alone. The preview computes \`columns\`,
rows, and \`tilecount\` with the exact Tiled 1.12.2 grid formula
(integer division with a single margin subtracted:
\`(imageWidth - margin + spacing) / (tileWidth + spacing)\`), reports any
unused right/bottom pixel remainders, and pins the image by path and raw
revision. The change set's \`expectedRevision\` is the SHA-256 of the exact
prospective TSJ bytes — there is no existing file to pin, and the apply
result reports \`beforeRevision:null\`. Apply refuses to overwrite any
existing destination, even byte-identical content, and rejects when the
image changed after preview. The created document carries the frozen
\`version:"1.10"\` / \`tiledversion:"1.12.2"\` stamps with members in
Tiled's own alphabetical order; \`name\` defaults to the tileset file stem,
and optional \`className\` writes the \`class\` member. The new file is not
referenced by any map yet: attach it afterwards with
\`tiled_add_tileset_to_map\`. Inspect \`tilesetCreationCapabilities\` for
the frozen policy strings.

## Deleting a file

\`tiled_delete_file\` plans the permanent deletion of one TMJ map or TSJ
tileset through the standard preview-approve-apply flow. The preview's
bounded reference scan is fail-closed evidence, not advice: it parses every
TMJ map (\`tilesets[].source\`), JSON world (\`maps[].fileName\`), and JSON
template (\`tileset.source\`) that could reference the target, and it
refuses outright — \`UNSUPPORTED_REFERENCE_SCAN\` — when XML assets or
pattern-based worlds make the answer unprovable, or \`FILE_IN_USE\` with a
bounded referencedBy sample when references exist. The scan re-runs on
apply. Apply then CAS-checks the target's revision and commits a checkpoint
of the exact current bytes BEFORE unlinking, so every crash window leaves
either the intact file or a restorable committed checkpoint; the result is
the discriminated \`{kind:"fileDelete", checkpointId, deleted:true}\`
branch. To undo a deletion, call \`tiled_preview_checkpoint_restore\` with
that checkpoint and \`expectedRevision\` set to the checkpoint's restorable
content revision — with no current file to pin, the approved revision is
the content itself — and apply recreates the file byte-exactly with
no-replace semantics. The same missing-target restore works for files
deleted by external tools. Inspect \`fileDeletionCapabilities\` for the
frozen policy strings and budgets.
`;

const guideBytes = Buffer.from(GUIDE_RESOURCE_TEXT, "utf8");

export const GUIDE_RESOURCE_SIZE = guideBytes.byteLength;
export const GUIDE_RESOURCE_REVISION = revisionOf(guideBytes);

if (GUIDE_RESOURCE_SIZE > MAX_GUIDE_RESOURCE_BYTES) {
  throw new Error(
    `The embedded TiledMCP guide is ${GUIDE_RESOURCE_SIZE} bytes; limit is ${MAX_GUIDE_RESOURCE_BYTES}.`,
  );
}

const guideMeta = Object.freeze({
  revision: GUIDE_RESOURCE_REVISION,
  size: GUIDE_RESOURCE_SIZE,
  serverVersion: SERVER_VERSION,
} as const);

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
