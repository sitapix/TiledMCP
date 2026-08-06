# TiledMCP

An MCP server for [Tiled](https://www.mapeditor.org) map projects. A model can read,
edit, generate, render, and validate `.tmj` / `.tsj` assets on disk without opening the
editor.

Two rules shape everything else:

- **Writes go preview → approval → apply.** A tool returns a change set, your client
  shows the bounded summary to a human, and a second call commits it under a revision
  guard. `tiled_create_map` and `tiled_create_checkpoint` are the only exceptions.
- **Undefined semantics fail closed.** Where Tiled 1.12.2's own behavior is ambiguous or
  unimplemented, the server errors instead of approximating.

## Status

Version 0.0.1. The interface is a draft and is not frozen.

52 tools register: 50 core, plus 2 that appear only when the server detects Tiled or
`tmxrasterizer` on PATH (`tiled_render_map`, `tiled_preview_export`). Everything else,
including `tiled_preview_terrain`, runs on the built-in JSON and PNG path with no
external binary. The suite is 1,524 passing tests across 123 files.

## Install

Requires Node.js 20.19+ and pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/index.js --project-dir /absolute/path/to/your/tiled-project
```

```json
{
  "mcpServers": {
    "tiled": {
      "command": "node",
      "args": [
        "/absolute/path/to/TiledMCP/dist/index.js",
        "--project-dir",
        "/absolute/path/to/your/tiled-project"
      ]
    }
  }
}
```

Transport is stdio. stdout carries MCP protocol only; diagnostics go to stderr.
`--project-dir` (or `TILED_PROJECT_DIR`) is required and defines a hard sandbox: paths
outside it and symlinks get rejected.

| Flag | Environment variable | Default |
|---|---|---|
| `--checkpoint-bytes N` | `TILEDMCP_CHECKPOINT_BYTES` | 1 GiB of retained checkpoint storage |
| `--checkpoint-retain-per-target N` | `TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET` | off; `2..10000` turns on rolling retention |

CLI wins over environment. Read the values in force from
`tiled_get_capabilities.checkpointCapabilities`.

## What it does

**Read.** Map summaries, bounded regions, atlas and image-collection tileset details,
Wang set expansion, object and template reads, usage analysis, four-way connectivity
analysis, and coordinate conversion across all four projections. TMX/TSX/TX parse through
a zero-dependency restricted parser, read-only. JSON worlds list read-only.

**Edit.** `tiled_preview_edits` carries 17 operations: `setTiles`, `fillRegion`,
`stampPattern`, `floodFill`, `copyRegion`, `replaceTiles`, `createObject`,
`updateObject`, `deleteObjects`, `updateLayer`, `deleteLayer`, `moveLayer`,
`duplicateLayer`, `updateMap`, `resizeMap`, `transcodeTileLayer`, and
`removeTilesetFromMap`. Separate preview tools handle tileset writes
(`tiled_update_tile`, `tiled_update_tileset`, `tiled_update_wangsets`), layer and tileset
creation, file deletion, project class/enum definitions, and a semantic tile-name
registry.

**Generate.** Deterministic shape brushes, value noise, cellular caves,
rooms-and-corridors dungeons, weighted scatter, reference-image import, and multi-layer
prefab stamping. Same seed, same bytes. No `Math.random` in the codebase.

**Render.** Native PNG output for orthogonal, isometric, staggered, and hexagonal maps;
tileset sheets; sparse tile selections; tile-layer previews with grid, coordinate,
highlight, and object-debug overlays; pixel-level render diff. `tmxrasterizer` handles
full-fidelity whole-map PNGs when it is installed.

**Write XML.** Byte-exact TMX/TSX/TX output checked against Tiled 1.12.2's own writer,
including class properties serialized through `.tiled-project` definitions.

**Recover.** Content-addressed checkpoints with startup reconciliation, cross-file
transactions that survive a crash mid-write, and restore that rebuilds a deleted file
byte for byte.

## The editing loop

1. Read `revision`, `dependencyRevisions`, and tileset `assetId` from
   `tiled_get_map_summary` or a region read.
2. Pass both revision pins and your operations to `tiled_preview_edits`.
3. Show the returned bounded summary to the user for approval.
4. Call `tiled_apply_change_set` with the `changeSetId` and `expectedRevision`.

Tiles are addressed as `{"tileset":{"kind":"external","assetId":"…"},"localId":0}`;
callers never touch raw GIDs. A preview refuses to issue if the map or any pinned
dependency has moved.

The `tiled://guide` resource walks the same loop with worked call sequences.

## Errors

A handler result wraps as `{"result": <success payload>}`. Domain errors set
`isError: true` and return
`{"result":{"ok":false,"error":{"code":"…","message":"…","details":{}}}}`. Branch on
`structuredContent.result.error.code` alone. Messages and `details` fields carry no
stability guarantee.

106 application codes ship in
[`contracts/application-errors.v1.json`](contracts/application-errors.v1.json) and at the
`tiled://application-errors` resource. `INTERNAL_ERROR` is the fallback for unexpected
handler failures. v1 identifiers keep their meaning, but new codes can appear: treat an
unknown code as a generic application error and refresh discovery.

The registry excludes MCP SDK input errors, `cli.*.issues[].code` probe diagnostics,
startup fatals, `tiled_validate` diagnostics, checkpoint reconciliation diagnostics, and
raw OS error codes. Those surfaces each follow their own contract. Input that the SDK
schema rejects before it reaches a handler returns text only, with no
`structuredContent`.

## Resources

| URI | Type | Contents |
|---|---|---|
| `tiled://guide` | `text/markdown` | capability discovery, sheet and preview inspection, change-set approval, commit, post-commit re-check |
| `tiled://application-errors` | `application/json` | the 106-code v1 registry with wire location and compatibility rules |

One resource template registers: `tiled://guide/{section}` serves a single guide
section by the slug listed in the guide's Contents block. Trust `resources/list` and
`resources/templates/list` over this table.

## Prompts

The tool list answers "what can this server do". It cannot answer "which eight of these
fifty-two calls, in what order". These carry the sequence:

| Prompt | Start here when |
|---|---|
| `create_map_from_tilesheet` | you have a tilesheet image and no map yet |
| `build_from_floor_plan` | you have a map, a tileset, and a floor-plan image to turn into a room |
| `set_up_tile_roles` | you want later edits to say `{"name": "wall_brick"}` instead of a local id |
| `review_map` | you want a read-only report and no changes |

Each names exact tools in exact order and restates the invariants that decide whether a
first call succeeds — revision pinning, `TileRef` rather than raw GIDs, preview before
apply. `create_map_from_tilesheet` additionally calls out the three things that fail a
cold start: parent directories are never created by any tool, a newly created map has no
layer to paint into, and the dependency pin stops being empty the moment a tileset is
attached.

## Documentation

| File | Contents |
|---|---|
| [docs/01-tiled-research.md](docs/01-tiled-research.md) | Tiled data model, file formats, automation ecosystem, prior MCP servers |
| [docs/02-mcp-spec.md](docs/02-mcp-spec.md) | tool, resource, and prompt specification |
| [docs/03-architecture.md](docs/03-architecture.md) | technology choices, read/write strategy, implementation traps |
| [docs/04-security.md](docs/04-security.md) | frozen v1 filesystem threat model and deployment requirements |
| [docs/05-cross-file-wal-design.md](docs/05-cross-file-wal-design.md) | cross-file WAL transaction design and decisions |
| [docs/06-infinite-edit-design.md](docs/06-infinite-edit-design.md) | infinite-map chunk semantics and normalization decisions |
| [docs/generated/mcp-reference.md](docs/generated/mcp-reference.md) | generated schemas, annotations, and call reference for every tool |
| [contracts/mcp-contract.v1.json](contracts/mcp-contract.v1.json) | machine contract for both capability profiles, generated from real discovery |
| [examples/mcp-calls.v1.json](examples/mcp-calls.v1.json) | one schema-validated call example per registered tool |

[`fixtures/mvp/basic.tmj`](fixtures/mvp/basic.tmj) opens and renders in Tiled 1.12.2. Its
external TSJ carries tile classes, properties, a collision object group, and a Wang set,
which pins the detail-read and tile-search contracts.

## Development

```bash
pnpm verify   # typecheck, build, contract check, full test suite
```

`pnpm contract:generate` rebuilds both machine contracts and the generated reference from
real `tools/list`, `resources/list`, `resources/templates/list`, and `resources/read`
responses across the two capability profiles. It never probes PATH or launches Tiled.
`pnpm contract:check` diffs the regenerated artifacts against what is committed and
re-validates all 52 examples against their public input schemas. `pnpm test` runs that
drift gate, builds `dist/`, then runs the suite including a real production stdio smoke
test. `pnpm test:watch` skips the stdio test to avoid a stale build; run
`pnpm test:stdio` to rebuild and re-run it alone.

With Tiled 1.12.2 and its bundled `tmxrasterizer` installed:

```bash
pnpm run verify:tiled-1.12.2
```

That gate checks the version, runtime export formats, JSON round-trip and PNG
rasterization of checked-in fixtures, and confirms Tiled re-exports what
`tiled_create_map` produced. Plain `pnpm test` never makes the optional Tiled CLI a
runtime dependency of the core direct-JSON path.

### Evaluations

`evals/` holds question-and-answer suites for measuring whether a model can actually
drive this server, each answered against a committed fixture:

| Suite | Fixture | Covers |
|---|---|---|
| `evals/floor-plan.xml` | `fixtures/floorplan/` | orthogonal map, image import, tile classes and roles, one Wang set |
| `evals/iso-town.xml` | `fixtures/isotown/` | isometric map, group-nested tile layers, GID flip flags, animated tile, every object shape |

Answers are ground truth computed from the fixture bytes, not estimates. Each suite has
a test that recomputes every answer and fails if the two disagree — an evaluation whose
answers have drifted reports a correct model as wrong, which is worse than having none.
`tests/isoTownEval.test.ts` additionally reads its fixture back through the real service,
so the questions cannot outlive the reads they depend on.

Regenerate a fixture with `pnpm tsx scripts/generate-floorplan-fixture.ts` or
`pnpm tsx scripts/generate-isotown-fixture.ts`.

## Limits

- **Byte preservation.** Tile edits rewrite only the affected layer's `data`; object
  edits rewrite only `objects`, plus `nextobjectid` on create. BOM, line endings,
  indentation, key order, and number lexemes survive outside that scope. An array that
  gets replaced does get reformatted.
- **Projections.** Oblique is rejected everywhere. Staggered and hexagonal support
  summary, region, usage, select, and render; edits fail closed. Isometric is open for
  edits and for every procedural planner.
- **TMX and XML.** Reads never reach an edit planner. Writes create a new file in the
  same directory, no-replace, restricted profile. Enum-annotated members and
  out-of-profile structure fail closed, and class properties need an explicit
  `projectFilePath`.
- **Templates.** JSON `.tj` templates read, expand, and instantiate. Tile templates, XML
  templates, and nested templates fail closed.
- **Selections.** Pure data with no `selectionId` and no server-side state. `sampleLimit`
  reaches 10,000 to match the `setTiles` cell budget, so a whole selection feeds straight
  into an edit.
- **Tile names.** `.tiledmcp/tile-names.json` is weak metadata. Reads pin each tileset's
  revision but report `localId` verbatim without re-checking tileset contents.
- **Consistency.** Every multi-file read reports
  `snapshotConsistency: "non-atomic-read-set"`. Read that as a disclosure, not an
  atomicity claim. `locked: true` is advisory metadata and blocks nothing.
- **Out of scope.** Official AutoMapping (headless `--evaluate` in 1.12.2 proved
  unworkable; evidence in the spec), any force path that modifies or deletes project
  assets, and a persistent prefab library with name matching.

Exact schemas and limits come from
[docs/generated/mcp-reference.md](docs/generated/mcp-reference.md) and
`tiled_get_capabilities`, not from this file.
