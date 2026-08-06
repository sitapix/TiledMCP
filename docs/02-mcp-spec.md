# TiledMCP Specification

The protocol baseline, shared semantics, and approval model. It is a draft; the interface is
not frozen.

Exact wire schemas live in [`contracts/mcp-contract.v1.json`](../contracts/mcp-contract.v1.json),
[`contracts/application-errors.v1.json`](../contracts/application-errors.v1.json), and
[the generated reference](generated/mcp-reference.md), all rebuilt from real MCP discovery and
drift-gated by `pnpm contract:check`. Where this document and a generated artifact disagree, the
artifact is right. Design background is in [01-tiled-research.md](01-tiled-research.md),
implementation reasoning in [03-architecture.md](03-architecture.md), and the frozen trust
boundary in [04-security.md](04-security.md). Safe call sequences live in the `tiled://guide`
resource, which ships with the server.

## 1. Protocol baseline

- **MCP version** pinned to `2025-11-25`.
- **SDK**: `@modelcontextprotocol/sdk` v1.x, version-pinned with a lockfile. No v2 migration
  before it is stable and compatibility-tested.
- **Transport**: `stdio`. Nothing but MCP protocol on stdout; logs go to stderr. HTTP and remote
  transports are out of scope.
- **Capability honesty**: only Tools, Resources, and Prompts that are implemented and pass
  contract tests get declared. Roadmap items never register as empty shells.
- **Single schema source**: shared types and every tool's input, output, and error shape are
  defined in code. The generator freezes wire JSON Schema, both capability profiles, the
  application-error registry, and the reference from live discovery responses; tests byte-compare
  the committed artifacts.

### Freeze criteria

Every registered tool needs a complete, fixed-field `inputSchema` and `outputSchema` with
`additionalProperties: false`, a bounded text-content policy that does not duplicate large
structured payloads, an example, stable error codes, size and pagination limits, all four
annotations, and a Tiled 1.12.2 round-trip test. `pnpm run verify:tiled-1.12.2` is a separate
mandatory gate: a missing CLI or an inexact version fails rather than skips.

Asset identity rules are specified in [03-architecture.md §7.1](03-architecture.md); the
filesystem trust boundary in [04-security.md](04-security.md). Both are authoritative there and
deliberately not restated here.

## 2. Shared contract

These TypeScript-style definitions fix semantics. Field requiredness, ranges, exclusivity, and
`additionalProperties: false` are defined precisely by the code-generated JSON Schema.

```ts
type ProjectPath = string
// UTF-8 project-relative path using "/". Absolute paths, "..", NUL, and anything
// resolving outside the project root are rejected.

type AssetId = string
// Server-allocated opaque identifier, stable within a project. Clients never guess
// it from a path or construct one.

type Revision = `sha256:${string}`
// Content revision over an existing file's raw bytes. Writes to existing targets
// CAS on expectedRevision.

type TilesetRef =
  | { kind: "external"; assetId: AssetId }
  | { kind: "embedded"; mapAssetId: AssetId; embeddedId: string }
// A tileset's name is for display and convenience lookup when unique. It is never identity.

type TileTransform =
  | { kind: "orthogonal"; flipH?: boolean; flipV?: boolean; flipD?: boolean; rawFlags?: number }
  | { kind: "hexagonal";  flipH?: boolean; flipV?: boolean; rotate60?: boolean;
      rotate120?: boolean; rawFlags?: number };

type TileRef = {
  tileset: TilesetRef;
  localId: number;
  transform?: TileTransform;
};
// rawFlags round-trips unknown and reserved bits losslessly. The server validates against
// the map's orientation and encodes the GID. Under hexagonal, 0x20000000 and 0x10000000
// are 60° and 120° rotation, not an ordinary diagonal flip.

type Diagnostic = {
  severity: "info" | "warning" | "error";
  code: string;          // stable, machine-checkable
  message: string;       // human-readable, aimed at the model
  path?: string;
  jsonPointer?: string;
};

type ApplicationErrorResult = {
  ok: false;
  error: { code: string; message: string; details: Record<string, JsonValue> };
};

type ToolStructuredContent<Success> = {
  result: Success | ApplicationErrorResult;
};

type CommitResult = {
  path: ProjectPath;
  beforeRevision: Revision | null;
  revision: Revision;
  checkpointId: string | null;
  changed: boolean;
  warnings?: string[];
};

type ApplyResult = CommitResult & { changeSetId: string };
```

Preview results are per-plan-kind types (map edit, tileset edit, checkpoint restore, and so on),
each carrying a `changeSetId`, a `planDigest`, the pinned `expectedRevision` and
`dependencyRevisions`, bounded `operations` and `summary`, `snapshotConsistency`, and a TTL.
The generated reference has their exact shapes.

## 3. Wire rules

1. Every registered tool's `structuredContent` is a closed
   `{result: Success | ApplicationErrorResult}`. Each tool publishes its own precise `Success`
   branch in `tools/list`; fixed objects, including recursive layer trees, operation previews,
   and summaries, reject extra keys. Only genuinely dynamic dictionaries — dependency revision
   records and error `details` — allow dynamic keys.
2. Query, render, preview, create, and apply results are **different types**. They cannot be
   treated as one shared `MutationResult`.
3. A domain error after the handler received valid input uses a stable `code`, sets
   `isError: true`, and returns `{result:{ok:false,error:{code,message,details}}}`. The code's
   exact wire location is `structuredContent.result.error.code`. Tool callback returns pass
   through a private trusted-result boundary that checks `isError: true` and `result.ok: false`
   agree in both directions and re-runs the tool's output schema. If sanitization,
   serialization, or that boundary check itself fails, the response is a fixed `INTERNAL_ERROR`
   envelope carrying no original message or details rather than an SDK text error that might
   echo an underlying exception.
4. v1 identifiers and their meanings are stable, but new codes can appear. A client meeting an
   unknown code handles it as a generic application error and refreshes discovery. It must never
   read "my local enum doesn't have this" as success. Control flow depends only on discovered
   `error.code` values, never on human-readable `message` text, and never assumes `details` has
   stable fields.
5. The registry covers the tool application envelope only. MCP SDK input errors,
   `cli.*.issues[].code` probe diagnostics, startup fatals, `tiled_validate` diagnostics,
   checkpoint reconciliation diagnostics, and raw OS error codes each follow separate contracts.
6. Input the SDK rejects before the handler is a protocol-layer failure: `isError: true` with
   text content and no `structuredContent`. Do not fabricate an `ApplicationErrorResult` for it.
7. Successes and application errors both return a `tiled-mcp-summary` v1 text content: compact
   single-line JSON, at most 1024 UTF-8 bytes, reporting the byte count of the full
   `structuredContent`. Success carries `kind`, `version`, `ok`, and `structuredContentBytes`;
   image tools add `image:{mimeType,bytes}` for the actual inline image. Error summaries add
   only a stable `code`, a bounded single-line `message`, and `messageTruncated` where needed —
   never `details`. Clients must not treat the summary as the result schema.
8. `Revision` is over raw bytes, not a parsed object and not mtime. Every write to an **existing**
   project asset carries `expectedRevision`; a mismatch at the final guard returns
   `REVISION_CONFLICT`. For writers honoring the same path lock this is a lost-update CAS; for
   non-cooperating writers a disclosed window remains between the guard and the rename. The one
   exception, `tiled_create_map`, implements the absent-state CAS through an internal missing
   precondition plus atomic no-replace link, and never accepts a caller-supplied "missing"
   revision.
9. Handles like `changeSetId` are passed explicitly and bound to a project, connection, map
   revision, and TTL. There is no implicit session state — no "current map", "current layer", or
   "last operation".

## 4. Approval and the two-phase write

`confirm: true` **is not user authorization**: the model can set that field itself, so the server
cannot use it as proof a human saw the risk. No tool schema has a `confirm` field.

Apart from the frozen additive missing-only `tiled_create_map`, writes are two-phase:

1. A preview tool computes the change and returns a `changeSetId` bound to `expectedRevision`,
   with bounded `operations` and `summary`, risk fields, and an expiry. It commits nothing.
2. The MCP client presents that bounded summary and its risk fields to the user through its own
   approval UI, using elicitation where available.
3. Only `tiled_apply_change_set(changeSetId, expectedRevision)`, behind the client's
   consequential-action gate, commits. The server re-runs the revision CAS. An expired change
   set, a connection mismatch, or a moved revision is refused.

Server annotations are a risk signal and an input to client policy. They are not proof of
authorization.

## 5. Annotation rules

Every tool sets an explicit human-readable `title` and all four hints rather than relying on
protocol defaults.

| Tool kind | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
|---|---:|---:|---:|---:|
| Local read, summary, render, pure validation | `true` | `false` | `true` | `false` |
| Change-set preview (new anti-ABA id per call) | `true` | `false` | `false` | `false` |
| Set to a specified final state | `false` | per capability | `true` | `false` |
| Missing-only no-replace create | `false` | `false` | `false` | `false` |
| Create, append, or state-dependent edit | `false` | per capability | `false` | `false` |
| Delete, crop, overwrite-export, autofix, restore | `false` | `true` | per repeat semantics | `false` |

- Annotations are **static per tool**. A name that would carry both read and write, or both
  preview and commit, or both safe and destructive branches, must be split into separate tools.
- Since asset identity contract v2, `readOnlyHint: true` tools strictly do not write the project
  directory: asset resolution runs lock-free and read-only, and the registry and lock files are
  created only on the `tiled_apply_change_set` path.
- Preview tools allocate a fresh random `changeSetId` per call and occupy a bounded registry, so
  they are **not** idempotent. An identical plan does not reuse an old handle, which is what
  prevents a stale approval from being honored after a revision ABA.
- `tiled_apply_change_set` is fixed at `{false, true, true, false}`. Even a non-destructive
  change set gets the conservative static marking; re-submitting an id returns the first result
  rather than applying twice.
- `tiled_create_map` is fixed at `{false, false, false, false}`. Even though no-replace bounds
  the destination effect, a failure before commit can leave a differing prepared checkpoint, so
  the tool as a whole is not MCP-idempotent, and a repeat after success returns
  `FILE_ALREADY_EXISTS`. Clients must not auto-retry.
- Local Tiled subprocesses stay `openWorldHint: false`. Any future network-touching tool must
  set it true.
- `destructiveHint: false` does not waive the revision CAS. `destructiveHint: true` must pass the
  client approval gate.

## 6. Design principles

1. **Outcome-shaped, not raw API.** Offer "fill this region" and "paint a path with a terrain
   brush" rather than forcing the model to set tiles one at a time.
2. **Naming.** `tiled_{verb}_{noun}`, snake case, matching the surrounding ecosystem.
3. **GID transforms stay transparent and lossless.** Tools speak `TileRef`. The server separates
   orthogonal flips from hexagonal 60°/120° rotation and preserves raw flags, so the model never
   hand-encodes a GID.
4. **Large data goes through summaries.** No tool returns a whole map's JSON. Reads use region
   and summary views.
5. **Single-document atomicity inside a path sandbox.** Every path stays under the project root.
   Existing targets use locks, revision CAS, and same-directory temp plus rename. Cross-file work
   promises recoverable transactions, not naive multi-rename atomicity.
6. **Tiled 1.12.2 is the compatibility baseline** — correct `nextlayerid` and `nextobjectid`
   maintenance, version fields, external tileset references. Other versions get promised only
   after the matrix expands.
7. **Coordinate conventions match Tiled**: tile coordinates in tiles with the origin top-left,
   object coordinates in pixels. Tool descriptions state this explicitly.
8. **The visual loop is a first-class capability.** Multimodal models can look at images, so
   render tools return PNG as MCP `image` content. Look at a tileset before choosing a tile;
   look at the render after editing. A raw GID array is nearly unreadable to a model, and
   render-observe-correct is what separates this from a plain data editor.
9. **Error messages are teaching.** Each one answers "why not, and what can I do now", listing
   the alternatives: *"Layer 'Ground' is an objectgroup; tile operations need a tilelayer. This
   map's tilelayers are: Ground2 (id=3), Decor (id=5)."* The quality of the model's next step
   depends on the quality of the last error.
10. **The model directs, algorithms do the labor.** Anything with a deterministic algorithm —
    bulk generation, scatter, shape drawing, reachability — gets a procedural tool the model
    parameterizes. The model's value is aesthetic judgment across generate-render-observe-tune,
    not producing cells by hand.

## 7. Registered tools

Authoritative list, availability, and schemas: `contracts/mcp-contract.v1.json` and
`docs/generated/mcp-reference.md`. Three tools register only when a local Tiled or
`tmxrasterizer` is detected; the rest need no external binary.

**Discovery and inspection**

| Tool | Purpose |
|---|---|
| `tiled_get_capabilities` | implementation boundaries, limits, detected CLI capabilities |
| `tiled_list_files` | list Tiled assets in the project |
| `tiled_get_map_summary` | revision, root metadata, layer tree, tileset asset ids |
| `tiled_get_region` | bounded rectangular tile region |
| `tiled_get_tileset` | atlas or collection tileset details, Wang expansion |
| `tiled_find_tiles` | search explicit class and property metadata |
| `tiled_list_objects` | bounded object listing |
| `tiled_get_object` | one object's full bounded projection |
| `tiled_validate` | read-only structural and profile validation |
| `tiled_analyze_usage` | whole-map tile usage, layer density, unused local ids |
| `tiled_check_connectivity` | four-way connectivity analysis |
| `tiled_convert_coordinates` | tile / screen / pixel conversion across all four projections |
| `tiled_select` | stateless predicate selection, including magic wand and polygon |
| `tiled_list_world_maps` | read a JSON world's explicit map members |
| `tiled_list_property_types` | project class and enum definitions |
| `tiled_list_tile_names` | the semantic tile-name registry |

**Rendering**

| Tool | Purpose |
|---|---|
| `tiled_render_preview` | native orthogonal tile-layer preview with overlays |
| `tiled_render_isometric` | native isometric render |
| `tiled_render_hexagonal` | native staggered and hexagonal render |
| `tiled_render_tileset_sheet` | paginated tileset sheet labeled with local ids |
| `tiled_render_tiles` | enlarge and label an explicit sparse tile selection |
| `tiled_render_diff` | pixel-level diff of two renders of the same region |
| `tiled_render_map` | *optional*: full-fidelity PNG through `tmxrasterizer` |

**Editing previews**

| Tool | Purpose |
|---|---|
| `tiled_preview_edits` | the generic operation union over tiles, objects, layers, map root, tileset bindings |
| `tiled_create_layer` | create one empty tile/object/image/group layer |
| `tiled_create_tileset` | build a new external atlas TSJ from a project image |
| `tiled_add_tileset_to_map` | bind an existing external TSJ to a map |
| `tiled_replace_tileset_in_map` | repoint a bound tileset at a different TSJ, keeping every GID |
| `tiled_preview_merge_map` | stamp another map's tile layers in, translating GIDs |
| `tiled_update_tile` | per-tile probability, class, animation, properties, collision |
| `tiled_update_tileset` | tileset-level name, offset, alignment, render size, properties |
| `tiled_update_wangsets` | Wang set creation, colors, tile assignment |
| `tiled_preview_property_types` | project class and enum definition upsert/delete |
| `tiled_preview_tile_names` | semantic tile-name registry upsert/delete |
| `tiled_preview_world_edits` | world member add/move/remove |
| `tiled_preview_validation_fixes` | mechanical dangling-GID repair |
| `tiled_delete_file` | recoverable TMJ/TSJ deletion |

**Procedural generation**

| Tool | Purpose |
|---|---|
| `tiled_preview_shape` | deterministic lines, rectangles, ellipses |
| `tiled_preview_generate` | seeded noise, cellular caves, rooms-and-corridors dungeons |
| `tiled_preview_scatter` | seeded weighted density scatter |
| `tiled_preview_import_image` | reference-image resample and palette map |
| `tiled_preview_prefab` | stamp a source region, multi-layer, with objects |
| `tiled_preview_template` | place a JSON `.tj` template instance |
| `tiled_preview_terrain` | *optional*: Tiled's own `TileLayer.wangEdit()` matcher |

**Native XML writing**

| Tool | Purpose |
|---|---|
| `tiled_preview_write_tmx` | byte-exact `.tmx` from a restricted-profile `.tmj` |
| `tiled_preview_write_tsx` | byte-exact `.tsx` from a `.tsj` atlas |
| `tiled_preview_write_tx` | byte-exact `.tx` from a `.tj` template |
| `tiled_preview_export` | *optional*: conversion through the official Tiled CLI |

**Checkpoints, transactions, commit**

| Tool | Purpose |
|---|---|
| `tiled_list_checkpoints` | bounded checkpoint listing, corrupt manifests isolated |
| `tiled_create_checkpoint` | explicit committed snapshot of current bytes |
| `tiled_preview_checkpoint_restore` | restore one document to checkpoint bytes |
| `tiled_preview_checkpoint_prune_batch` | delete 1 to 32 explicit committed checkpoints |
| `tiled_preview_prepared_checkpoint_discard` | discard a provably-not-landed prepared checkpoint |
| `tiled_preview_prepared_checkpoint_commit` | adjudicate an ambiguous prepared create |
| `tiled_preview_prepared_checkpoint_abandon` | abandon an unresolvable prepared checkpoint |
| `tiled_preview_transaction` | compose approved change sets into one atomic transaction |
| `tiled_apply_change_set` | commit any approved change set under its revision guard |

Operations inside `tiled_preview_edits` deliberately do **not** get standalone tools. Splitting
`moveLayer` or `floodFill` into `tiled_move_layer` and `tiled_flood_fill` would multiply the
surface without adding capability, and would break the shared ordering and budget semantics that
only exist because they share one change set.

## 8. Resources

Resources are discoverable read-only context. Fixed URIs use direct resources; per-asset URIs
would use templates. No URI embeds an unescaped file path; asset templates would take an opaque
`assetId` from a project index or a tool result.

| URI | `mimeType` | Contents |
|---|---|---|
| `tiled://guide` | `text/markdown` | the calling playbook: discovery → summary → inspection → preview → approval → commit → verify |
| `tiled://application-errors` | `application/json` | the v1 application-code registry with wire location, fallback, compatibility, and excluded surfaces |

No resource templates are registered. Runtime truth is `resources/list` and
`resources/templates/list`.

Wire rules:

- Each `resources/read` content item carries `uri`, an accurate `mimeType`, and exactly one of
  `text` or `blob`. `_meta` includes at least the content `revision` and raw `size`.
- Both current resources are static within a server instance. The registry advertises
  list-changed; subscriptions are unimplemented and explicitly declared false. An unimplemented
  notification never gets its capability declared.
- `assetId` values are reusable across restarts within one project's internal state. Clients
  treat them as opaque strings and re-read the map snapshot after a path change.

## 9. Prompts

Prompts are message templates expanded by `prompts/get`. They are not server-side macros, a
workflow engine, or an authorization mechanism. A template may suggest an order of tool calls; it
cannot call tools itself and cannot approve a change set on the user's behalf.

None are registered yet. Candidates: guided level creation, collision-layer construction, terrain
transitions, validate-then-fix, map description, visual review, and building from a reference
image.

## 10. Non-goals

- **No live GUI bridge.** A WebSocket link to a resident Tiled is high-complexity for a narrow
  gain that `tiled_render_preview` mostly covers.
- **No game runtime.** This manages map assets, not how an engine consumes them.
- **No reimplementation of AutoMapping.** Rule semantics are intricate and version-dependent.
- **No DSL for adjacency constraints.** AutoMapping and Wang terrain cover nearly all of it, and
  a bespoke constraint engine has no floor.
- **No implicit session state.** Every call carries its paths, ids, revisions, or a TTL-bound
  server handle explicitly.
- **Prompts never substitute for approval.** Any destructive change set still passes the client
  approval gate.
