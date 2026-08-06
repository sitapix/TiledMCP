# TiledMCP Architecture

Why the implementation is shaped the way it is: the fidelity, concurrency, and recovery
constraints it commits to, and the places it refuses to guess.

This document does not restate the wire contract. Schemas, limits, and error codes live in
`contracts/mcp-contract.v1.json`, `contracts/application-errors.v1.json`, and
`docs/generated/mcp-reference.md`, all regenerated from real MCP discovery and drift-gated by
`pnpm contract:check`. Runtime values come from `tiled_get_capabilities`. When this document
and a generated artifact disagree, the artifact is right.

## 1. Goals and non-goals

Automated editing has to satisfy five constraints at once:

1. **Lossless.** Unknown fields, future-version fields, and untouched JSON text survive a
   local edit unchanged.
2. **Concurrency-safe.** Writes to existing targets carry an explicit revision. The one direct
   create uses a missing-file precondition. A cooperating writer, or an external save observed
   before the final guard, cannot be silently overwritten by a stale request. The window
   between the guard and the rename for non-cooperating writers is disclosed in
   [04-security.md](04-security.md), not defended against.
3. **Recoverable.** Single-file commits to existing targets go checkpoint-then-atomic-replace.
   Direct create uses hard-link no-replace. Multi-file commits recover through a WAL rather
   than claiming several renames are naturally atomic.
4. **Capability-probed.** Direct JSON always works. Tiled, its exporters, the rasterizer, and
   compression codecs turn on from runtime probes.
5. **Incremental.** Content that cannot yet be edited can still be read and preserved. Unsafe
   semantic modification is rejected rather than best-effort written.

Explicit non-goals: no live GUI bridge over WebSocket or plugins; no model-supplied
JavaScript, shell commands, or arbitrary Tiled CLI arguments; not a game runtime or a complete
Tiled renderer.

## 2. Layering and the write pipeline

```text
┌──────────────────────────────────────────────────────────────┐
│ MCP interface                                                │
│ contracts / annotations / limits / structured results        │
├──────────────────────────────────────────────────────────────┤
│ application                                                  │
│ queries / commands / change plans / diagnostics              │
├──────────────────────────────┬───────────────────────────────┤
│ document engine              │ runtime capability adapters   │
│ raw JSON + typed views       │ Tiled evaluate / export       │
│ GID / tile data / validation │ tmxrasterizer / image codecs  │
├──────────────────────────────┴───────────────────────────────┤
│ storage and safety                                           │
│ roots / revisions / locks / atomic replace / WAL / snapshots │
└──────────────────────────────────────────────────────────────┘
```

Every write follows one pipeline:

```text
resolve paths
  → load raw bytes and revisions
  → build typed views
  → plan edits, produce diagnostics, validate the in-memory result
  → acquire locks
  → compare revisions against the pinned source
  → prepare the write-ahead checkpoint
  → write and fsync same-directory staging
  → final revision guard (cooperative CAS before rename)
  → promote, fsync the parent where supported, finalize checkpoint state
```

Tool handlers never touch the filesystem or spawn processes directly. They call application
use cases, which produce a change plan that the storage layer commits. Dry-run, real commit,
and recovery therefore run the same validation.

## 3. Output boundary

No `{result: unknown}` escape hatch. Each tool models its success branch independently; the
shared outer envelope only unions that with the application-error result. Fixed objects are
closed; dynamic keys exist only for dependency-revision records and error `details`. A client
validator built from `tools/list` can then check both a legal success and a legal in-handler
application error.

Protocol-level input-schema validation happens before the handler and produces no
`structuredContent`. Only post-handler failures go through error normalization, the application
code allowlist, and length/depth budgets. `Diagnostic` records problems inside a *successful*
validator result and does not double as an error envelope.

The text channel carries one compact single-line JSON summary, hard-capped at 1024 UTF-8 bytes.
Success reports only the structured JSON byte count; errors add a stable code, a bounded
single-line message, and a truncation flag. Neither mirrors the full result through
`JSON.stringify`. Clients treat `structuredContent.result` as the data and branch only on
discovered `error.code` values, never on message text or `details` shape.

## 4. Runtime capability adapters

Direct TMJ/TSJ read/write is the core path, but the official Tiled process is a first-class
optional adapter rather than a later bolt-on:

| Adapter | Probe | Use | Write rule |
|---|---|---|---|
| Direct JSON | built in, always available | lossless reads, all supported edits, validation | this project's transaction layer |
| Tiled one-shot evaluate | `tiled --version`, then a controlled probe script | format conversion, official Wang backend `TileLayer.wangEdit()`, compatibility checks | fixed built-in scripts write sibling staging only; the change-set layer promotes |
| Tiled export | `tiled --export-formats` | non-PNG formats the runtime actually supports | format list never hardcoded; target written to staging first |
| `tmxrasterizer` | executable probe plus version/help | TMX/TMJ → PNG | reads source only; output bounded by size and byte budgets |
| Native preview | built-in sharp allowlist codec | tileset sheets, sparse tile selections, orthogonal debug overlays | never modifies assets |

`tiled --evaluate <script>` is a one-shot process: run, exit. No resident GUI, no WebSocket
bridge. Each call uses a fixed in-repo script plus separate JSON request/result files, so the
model cannot supply code. External processes launch through argv rather than shell
concatenation, with timeouts, output caps, concurrency limits, and process-group cleanup.

PNG does not masquerade as an ordinary export format through `tiled --export-map`;
`tmxrasterizer` handles it. A registered tool whose capability drops out returns a stable
diagnostic rather than degrading to a semantically different implementation.

## 5. Technology choices

| Component | Choice | Why |
|---|---|---|
| Runtime | TypeScript on Node.js LTS | mature MCP SDK, filesystem, and process ecosystem |
| MCP | `@modelcontextprotocol/sdk` v1.x with Zod | pinned production major; the contract is ours |
| Raw JSON | source-preserving AST over `jsonc-parser` | keeps original text spans, emits minimal edits, detects duplicate keys |
| Typed view | project-owned narrow types and guards | describes only implemented fields; unknown fields stay in the raw document |
| Third-party Tiled types | `@kayahr/tiled` as a dev reference or test oracle only | incomplete version coverage; its strict schema would reject legitimate future fields |
| Hash | Node `crypto` SHA-256 | revisions, blob addresses, commit verification |
| Compression | Node `zlib`; zstd as a probed codec | missing codec preserves source text and rejects the edit |
| Images | `sharp` plus deterministic raw RGBA drawing | allowlist decode, nearest-neighbor sheets, built-in bitmap IDs |
| Tests | Vitest, Tiled-generated fixtures, fault injection | fidelity, compatibility, crash recovery, hostile input |

Runtime write decisions come from the raw document, this project's explicit support matrix, and
verification against real Tiled — never from a third-party schema.

## 6. Document engine: raw bytes are the truth

### 6.1 Source-preserving JSON

Each asset loads as raw bytes, a `sha256(source)` revision (never mtime), and an AST.

- UTF-8 decoding, syntax, max depth, node count, and duplicate keys are checked before a typed
  view exists.
- Nothing is written when nothing changed semantically. A no-op stays byte-for-byte identical.
- Edits compile to `TextEdit[]` against AST spans. Untouched slices copy verbatim, preserving
  key order, whitespace, number spelling, and unknown fields.
- When an array or object must be rewritten, only the minimal target subtree is rewritten;
  unknown siblings still copy from the original.
- After applying edits the result is re-parsed, re-viewed, and re-validated.
- Duplicate keys make ordinary `JSON.parse` lossy, so reads fail closed with
  `DUPLICATE_JSON_KEY`. A future recovery parser could only ever serve diagnostics, never
  write-back.

"Lossless" means untouched content keeps its structure and source text. It does not promise
that an array you explicitly replaced keeps its old formatting.

### 6.2 Typed views and edit intents

A typed view is a read-only projection over the raw AST carrying JSON paths and source spans.
There is no second, independently serializable "canonical map". Domain operations emit a closed
union of intents that the document engine compiles into text edits. Batches take an explicit
allowlist union of operations; nested batches, checkpoints, reverts, file deletion, and external
process side effects are excluded by construction, so no generic `{tool, args}` can recurse.

Tileset names are not unique. The public model uses a map-scoped reference — a normalized
external source, or a stable locator for an embedded tileset — and resolves by `name` only when
it happens to be unique. Display strings truncate on Unicode code-point boundaries so a UTF-16
surrogate pair is never split.

### 6.3 Version gating

`tiledversion` records which Tiled last saved a file. It does **not** decide what may be
written. Gating comes from, in priority order: an explicit compatibility target in the request,
the project's Compatibility Version, then the server default profile. The locally installed
Tiled affects only adapter availability.

Each known feature declares its minimum target version, allowed document types, read/write
status, and validator. Fields that cannot yet be written are still preserved and displayed.

## 7. Paths, roots, and asset identity

One path policy covers MCP arguments, in-document `source`/`image`/`template` references,
checkpoints, and every external process.

| Area | Default | Notes |
|---|---|---|
| Primary project root | read/write | must be given explicitly; all new files and `.tiledmcp/` live inside it |
| Everything else | rejected | unauthorized absolute paths, network URLs, symlink escapes |

- Wire paths are normalized project-relative POSIX strings under the primary root. Opaque asset
  ids are allocated separately and never expose host absolute paths.
- Relative references resolve against **the directory of the document that owns the field**,
  not the process cwd.
- Existing paths get `realpath` on the final target. New files require an existing direct
  parent, `realpath` that parent, and reject symlink escape, NUL, and traversal segment by
  segment.
- Existing reference strings pointing outside the allowlist are preserved verbatim; the server
  neither reads the target nor permits edits that depend on it.
- New references must land inside an allowed root and are written as normalized relative paths
  from their owner. Relative never silently becomes absolute.
- The full dependency closure resolves before any image tool or Tiled process starts, and that
  process's input, output, and working directory go through the same policy.

There is exactly one root. That is what gives locks, the WAL, recovery scans, and quotas a
definite boundary. Shared read roots would require a genuinely different wire shape and are not
a configuration that exists today.

### 7.1 Asset identity

Opaque `asset_[0-9a-f]{24}` ids are assigned for the two kinds that reach the wire: external
tilesets and image layers. They persist in `.tiledmcp/asset-registry.v1.json`, a closed
document (unknown keys rejected) holding a generation counter and `{assetId, kind, path,
identity}` entries, where identity is `{device, inode, birthtimeNs}` as decimal strings.

Reads use `O_NOFOLLOW | O_NONBLOCK`, strict UTF-8, duplicate-key-aware parsing, and
regular-file checks. An unknown future version, truncation, a symlink, a duplicate, or an
out-of-bounds value is a startup fail-closed `ASSET_REGISTRY_CORRUPT`. The server never
silently rebuilds a plausible-looking registry from paths.

Identity migration is deliberately conservative, in this order:

1. Same kind and same canonical path always keeps its id. An in-place or atomic save just
   refreshes the recorded file identity.
2. An id moves to a new path only when the new path is unregistered, the old one is gone, inode
   and birthtime are both nonzero, and the current `(device, inode, birthtimeNs)` uniquely
   matches one entry of that kind. This is best-effort continuity for an ordinary same-filesystem
   rename where the filesystem supplies a stable birthtime. Zero inode or birthtime is weak
   evidence and does not trigger migration.
3. A copy or hardlink whose original path still exists does not migrate. Content revision, Tiled
   `name`, and identical bytes are not identity. Cross-filesystem copy-then-delete, an unobserved
   inode-replacing save followed by a rename, and ambiguous multi-candidate matches all allocate
   a fresh id.

The boundary is verifiable rather than guessed. Strong guarantees for arbitrary rename+replace
would need an explicit rebind operation, or would have to fold file movement, reference updates,
and registry migration into the cross-file WAL. Content-hash heuristics will not be used to fake
identity.

Since asset identity contract v2, read and preview handlers resolve **lock-free and without
side effects**: they read from disk and allocate in memory by deterministic path hash, or adopt
a rename by existing file identity, without writing the registry or creating lock files. That
is what makes `readOnlyHint: true` literally true. Persistence happens only on the
`tiled_apply_change_set` path, under the lock. Deterministic first allocation guarantees the id
a preview reported matches the one later persisted, and the prospective asset id pinned in a
plan is re-checked at apply. A purely read-only session therefore leaves no rename evidence,
which narrows best-effort continuity to sessions that included a write.

For a map's external tilesets, `MapService` uses a checked batch: raw bytes, revision, and file
identity all come from the same file descriptor; ids are computed under the registry lock but
written only after a pre-commit checker succeeds. The checker compares every captured
snapshot's revision guard first, then reports deferred parse, profile, image, and GID-range
errors. A corrupt map or dependency therefore never consumes an id, refreshes an identity, or
advances the generation. When the aggregate dependency byte cap stops the scan at item *k*, a
genuine stale-revision conflict within the captured prefix still takes priority; otherwise the
result is a fixed limit error with no full-set diff over a necessarily incomplete dependency
set. Resource-limit outcomes therefore do not depend on whether the oversized item happened to
be last, and every rejection path leaves the registry untouched.

## 8. GID and tileset ranges

### 8.1 Unsigned GIDs

Raw GIDs are confined to the GID codec and the tile-data codec. JavaScript bitwise operators
produce *signed* 32-bit results, so every step normalizes with `>>> 0`:

```ts
const H           = 0x80000000 >>> 0;
const V           = 0x40000000 >>> 0;
const D_OR_HEX_60 = 0x20000000 >>> 0;
const HEX_120     = 0x10000000 >>> 0;
const FLAGS_MASK  = 0xf0000000 >>> 0;
const ID_MASK     = 0x0fffffff;
```

All four high bits clear on read regardless of orientation. `baseGid === 0` is an empty tile; a
zero base GID *carrying flags* is a diagnostic, never a quietly normal blank.

Transform meaning is orientation-dependent. Under hexagonal, `0x20000000` is rotate-60 and
`0x10000000` is rotate-120, not a diagonal flip. Complete `rawFlags` are retained for lossless
echo and combination testing, and encoding re-verifies that structured fields agree with them.

### 8.2 `firstgid` and sparse local ids

Ownership resolves on the flag-cleared base GID: take the largest reference with
`firstgid <= baseGid`, then confirm `localId = baseGid - firstgid` really belongs to that
tileset.

`tilecount` alone cannot bound an image-collection tileset. The highest potential local id
combines the atlas `tilecount - 1`, the maximum `tiles[].id`, and `nexttileid - 1` where
present. If an external tileset cannot be read or its range cannot be proven, automatic
`firstgid` allocation fails rather than guessing.

New bindings allocate after the highest occupied end of all existing ranges, so the first
tileset on a map gets 1. Overflow of the legal GID space is rejected. Removing a binding leaves
other `firstgid` values and the resulting holes **untouched**; nothing is compacted
automatically. A future compaction tool would have to preview explicitly and rewrite every
affected tile layer and tile object inside one recoverable transaction.

Because adding a binding can reinterpret a previously invalid raw GID as a real tile, issuance
runs a bounded binary-search binding check over existing tile cells and tile objects first.
Anything currently unresolvable fails closed.

## 9. Edit planner invariants

Individual operation contracts belong in the generated reference. These are the rules every
planner shares, and the reasoning behind them.

**Every observed GID is fully validated, even where it is about to be overwritten.** A cell that
misses its mapping, sits outside a copy source, or is being cropped away still gets reverse
resolved. Skipping validation on a doomed cell would let corruption hide behind an edit that
happened to cover it.

**Matching is on the complete encoded GID.** Transform and raw flags are part of identity.
Omitting a transform means identity, not a wildcard, and a target never inherits the source's
flags. Different flips of the same base tile do not collide.

**Within one operation, evaluation is single-pass and simultaneous.** Mapping lookups read the
cell's value as of the start of the operation, and each cell is visited once, so `A→B, B→C`
does not cascade and swaps and cycles stay predictable.

**Across operations, order is change-set order and last write wins.** An operation sees every
prior operation's result. Overlap between a stamp, a fill, a copy, and a replace resolves by
position in the array.

**Region copies snapshot both rectangles before writing.** That makes same-layer overlap
memmove semantics rather than row-major smearing.

**No clipping, ever.** A target rectangle that leaves the layer bounds is an error, not a
partial write. Silent cropping would make an approved summary describe something other than
what landed.

**Empty means empty.** GID 0 and `tile: null` explicitly clear a cell. There is no
transparent-skip sentinel, because a client cannot approve a write whose blank cells mean two
different things.

**Structural operations take the whole change set.** Layer delete, move, resize, and tileset
removal cannot batch with anything else. Each invalidates positional assumptions that other
operations in the same batch would have already resolved.

**Budgets are shared and counted on intent, not effect.** Scan budgets are shared across
replace, flood fill, and copy; write budgets across every tile operation. A cell that gets
rewritten with the value it already had still spends budget. Counting effects instead would make
cost depend on file contents, so a plan could pass preview and blow the budget at apply.

**A semantic no-op writes nothing.** When a plan nets out to no change, apply leaves bytes and
revision identical and reports `changed: false`. Sequences that undo themselves collapse to an
exact-byte no-op.

**Source patches stay local.** Tile edits patch one layer's `data` member; object edits patch one
`objects` array; map-root edits patch individual root members; layer moves relocate a single
array element through a source-snapshot `JsonArrayMove` so a shifted runtime path cannot select
the wrong array.

**Id counters only move up.** Deleting layers or objects never lowers `nextlayerid` or
`nextobjectid`, and duplication allocates from the existing high-water mark in subtree preorder
rather than filling historical gaps.

**`locked` is advisory.** It never blocks an edit. Previews report locked and effectively-locked
counts and warn, because Tiled treats it as a UI affordance and pretending otherwise would
invent a write-protection guarantee that no writer honors.

## 10. Tile data, chunks, and compression

Tile layers use a lazy plane view. A summary read does not decompress a layer; only region
queries, edits, or full validation load data.

**Finite maps.** The original array or base64 representation, element order, encoding, and
compression are preserved. A layer decodes only when modified, and write-back keeps its original
encoding with no implicit transcoding. Decoded length must equal `width × height`, and every
value must be an integer in `0..0xffffffff`.

**Infinite maps.** Any legal chunk geometry, order, and boundary is preserved, never re-cut to
16×16 — that is a common Tiled default, not a format invariant. Unmodified chunks keep their
original text. Editing an existing cell rewrites only its owning chunk. A new cell outside every
chunk creates a new chunk without moving, merging, or re-cutting others. Overlapping chunks,
non-positive sizes, and length mismatches are diagnostics, because "last one wins" would hide
the problem behind a read-order dependency.

**Compression safety.** Base64 decoding is strict canonical — stricter than Qt's permissive
reader, deliberately failing closed rather than approximating. Decompression is streaming with
`maxOutputLength` pinned to exactly `width × height × 4`, and the decoded byte count must match
exactly. Allocation sizes use checked arithmetic against integer overflow. A missing zstd codec
preserves source text and rejects operations that would need decoding. Untouched layers are
never recompressed as a side effect of saving something else.

Encoded read support serves the read-side consumers; mutation planners continue to fail closed
on anything that is not a plain array, so the write surface stayed unchanged when decoding
landed. Encoded write-back reuses the same rule as finite maps: decode on modification, keep the
original encoding. The mechanism leans on an existing detail — the view-to-document sync turns
`data` from a string into an array exactly on the first real write, which is a natural dirty
flag. Before re-encoding, the result is compared against the original decode; identical cells
restore the original string, preserving exact-byte no-op collapse. Compressed bytes come from
this process's zlib and need not match Tiled's byte for byte; they are semantically equal.

Chunked layers reject in edit mode. Read-only chunk support validates structure without
decoding (bounded chunk count, positive bounded rectangles, exact array lengths, **overlap fails
closed**) and decodes only chunks intersecting the requested region. Native preview treats
"region as layer": it synthesizes a preview layer whose bounds are exactly the requested region,
so the renderer's existing intersection sampling handles negative coordinates for free. An
infinite map must state its region explicitly.

## 11. Revisions, locks, and single-file commit

A public revision is the SHA-256 of an existing file's raw bytes. mtime is a cache invalidation
hint only, never a concurrency decision. Every write to an existing target carries
`expectedRevision`. The direct create exception does not accept a caller-constructed "missing"
revision: the server verifies absence under the lock and uses hard-link no-replace promotion to
make "still absent" an atomic precondition.

Each target takes two locks: an in-process async mutex keyed by normalized project path, and a
cross-process advisory lock at `.tiledmcp/locks/<sha256(path)>.lock`. Locks are acquired in
sorted path order to avoid deadlock. This is a **path** lock, not an inode lock, so different
hardlink aliases of one inode do not share it — v1 requires that a logical target be reached
through exactly one normalized path. Lock files are claimed atomically by candidate-plus-hardlink
and record pid, nonce, and time. Stale locks are **not** reclaimed automatically: without proof
the original writer exited, failing closed is preferable. Any future lease reclamation must prove
process identity rather than trust mtime.

Security-sensitive final components open with `O_NOFOLLOW | O_NONBLOCK` and confirm a regular
file by `fstat`. Document and image reads compare dev, inode, size, mtime, and ctime before and
after on the same descriptor and verify the byte count read, so in-place overwrite, growth, or
truncation returns a changed-during-read error rather than issuing a revision for mixed bytes.
An external atomic save that swaps the pathname after the descriptor opened leaves the old inode
as a self-consistent snapshot; the pathname-to-inode binding is not re-verified after the final
snapshot, which is part of the disclosed external-writer blind window. Absolute-path APIs also
cannot prove intermediate parents were not replaced mid-operation; closing that would require a
native helper working from a pre-opened root dirfd through `openat2` and the `*at` family.

Commit steps for an existing target:

1. Apply edits in memory, re-parse, re-validate.
2. Create the content-addressed checkpoint and persist a `prepared` manifest.
3. Write and `fsync` permission-controlled staging in the target's own directory.
4. Re-compare revisions under the lock (a CAS against writers honoring this lock).
5. Replace by same-filesystem atomic `rename`, `fsync` the parent where supported.
6. Return the new revision, checkpoint id, and change summary.

Create uses a separate no-replace branch: confirm parent and target safety and initial absence
under the lock, prepare a `before.existed: false` checkpoint, write and `fsync` staging, re-check
absence, then promote by hard link. Either the re-check or an `EEXIST` from the link returns
"already exists" unconditionally — even when the target's bytes are identical to the proposal,
because content equality cannot be used to claim an external creation.

"Atomic" here describes the visibility of one same-filesystem replacement. It is not a
conditional replace against non-cooperating writers and not a crash-durability claim. The
guarantee holds when the operator confirms the underlying filesystem meets the contract; the
server propagates real syscall failures but does not probe or prove atomicity, locking, or
`fsync` semantics, and has not been validated on distributed filesystems. A `changed: true`
result records that one promotion happened; it is not a lease that the pathname still resolves
to that revision when the response arrives.

## 12. Cross-file transactions

Multi-file commit is a redo journal layered on the single-file path (alternatives considered in
[05-cross-file-wal-design.md](05-cross-file-wal-design.md)):

```text
.tiledmcp/transactions/
├── <uuid>.json          # manifest: version/id/state/createdAt/label/entries
└── staged/<sha256hex>   # content-addressed staged new content
```

Commit runs in fixed steps, with crash-injection points between each: take both lock layers on
all targets in canonical path order → CAS every target (replace and delete verify the current
revision, create verifies absence) → build a before-state checkpoint per target → write and
fsync staged content → **commit point**: atomically rewrite the manifest to `state: "committed"`
→ mark checkpoints committed → promote each target → delete the manifest and staged objects.

Startup reconciliation runs before prepared-checkpoint reconciliation. A `prepared` manifest
means the commit point was not reached and no target moved, so it rolls back. A `committed`
manifest rolls forward: targets already at `afterRevision` are skipped, targets still at
`expectedRevision` replay their promotion (content-addressed, therefore idempotent), and a target
that is neither — changed by an external writer inside the crash window — is reported as a
conflict with its manifest and staged object preserved for adjudication while the remaining
targets still roll forward. That is the point where the atomicity promise degrades to disclosure
under the threat model rather than silently doing something arbitrary. Recovery is idempotent.

The wire layer introduces no nested operation language. `tiled_preview_transaction` takes
already-issued, un-applied, distinct-target document change sets and pins each member's plan
digest and target; the aggregate expected revision is the SHA-256 of the ordered target pin set.
Members are marked owned by the transaction, so applying one individually is refused until the
transaction expires or completes.

Each member's apply method splits into prepare (replay the plan to exact target bytes without
touching disk) and commit. Transaction apply prepares every member, hands them to the
transaction commit, then backfills per-target results in each member's own wire shape so a
member replay returns the transaction's result instead of committing twice. Tampering with or
expiring a member plan after approval fails the transaction closed.

Pin coupling between members is rejected at preview — a tileset edit whose pinned map another
member rewrites, or a map edit whose pinned tileset another member edits. The single permitted
coupling is create-plus-attach: attaching a tileset can consume a pending create plan's replayed
content in place of a file that does not exist yet, because the prospective asset id comes from
the registry's deterministic path hash and matches the id allocated after the file lands. Digest
verification is never relaxed for it.

External adapters cannot bypass any of this. Evaluate and export produce staging results that
TiledMCP validates before they enter a single-file commit or the WAL.

## 13. Content-addressed checkpoints

Checkpoints do not use git stashes or dangling commits: those miss untracked assets and can be
garbage collected. The store is content-addressed and owned:

```text
.tiledmcp/
├── objects/<sha256-hex>                # immutable raw bytes
├── checkpoints/<checkpointId>.json     # manifest
├── checkpoint-retention-sequence.json  # durable rolling ordinal high-water mark
├── transactions/
└── locks/
```

A manifest records the checkpoint id, label, creation time, originating operation, the target's
project-relative path, whether it existed, its SHA-256, original revision, byte size, a schema
version, and an integrity hash. Blobs write create-if-absent plus fsync and re-verify their hash
on read and restore. Restore takes the same locks, checks the caller's expected current revision,
and goes through the normal commit path rather than copying over the target.

**Quota and GC.** Accounting charges the logical bytes of every observed entry under
`objects/` and `checkpoints/`, reserving the committed serialization delta for prepared
manifests; crash temporaries and unknown entries consume quota too. Prepare, mark-committed, and
GC share a per-root in-process mutex and one cross-process store lock. Over quota, a full
mark/sweep runs first: every valid prepared or committed manifest is a root, and only unreferenced
canonical objects and strictly named private crash temporaries are deleted. A malformed,
unexpected, symlinked, or non-regular entry, a missing reference, anything that cannot be safely
charged, or a scan overrun blocks the **entire** sweep before the first unlink. Under quota
pressure GC never deletes a valid manifest; if the write still does not fit, it fails closed
before the target is promoted.

**Deletion is always explicit.** The only ways a valid manifest goes away are an approved
raw-manifest-CAS prune of one committed checkpoint, an approved batch prune of explicitly listed
committed checkpoints, an approved discard of a prepared checkpoint that is *machine-provably*
still at its before state, an evidence-bound abandon of an ambiguous prepared checkpoint, or
rolling post-commit retention that the operator turned on at startup. There is no general force
switch.

**Prepared state.** Startup reconciliation takes each manifest's target mutex and file lock,
then re-reads manifest and target in `target → store` order. It promotes to committed only a
prepared manifest whose `before.existed` is true and whose target is exactly at `afterRevision`.
A prepared *create* at exact-after stays prepared and reports a state conflict, because provenance
is ambiguous: the server cannot prove it wrote those bytes. Lock contention and other per-entry
anomalies isolate to that entry rather than bypassing a lock or stopping the scan.

Ambiguity is resolved by two separate actions rather than a boolean on discard, because they have
different consequences. Both share one read-only classifier and one complete expectation covering
manifest metadata, raw revision and size, the target's strict absence or bounded no-follow
snapshot, and a stable conflict classification:

| Target state | Resolution |
|---|---|
| create-missing, existing exact-before | machine-provable write-did-not-land; safe discard only |
| existing exact-after | startup reconciliation handles it; automatic path only |
| create exact-after | commit or abandon, each independently previewed |
| create-unrelated, existing-missing, existing-unrelated | abandon only |
| symlink, non-regular, out-of-bounds, oversized, unreadable, read race | both fail closed |

The first manifest read only routes locks; authoritative evidence is established inside
`target mutex → target file lock → checkpoint-store lock`. Commit and abandon use different
digest domains. Apply re-runs the identical raw and semantic manifest CAS, target CAS, and
classification, and fails closed before any mutation on any drift. Approval is single-use
action-specific evidence inside the change-set TTL, not standing authorization.

Discard and prune deliberately **do not read their own blob**, so a corrupt or missing object
cannot prevent an operator from removing a recovery point they no longer want. The irreversible
commit point is the manifest unlink followed by an fsync of the checkpoint directory. After that
point, a failure in the directory sync, an observer, GC, or lock release must still return the
"deleted" success branch with a fixed warning — reporting a retryable error would invite a client
to repeat an operation that already happened.

Batch prune is its own plan kind rather than an overloaded single-item schema. Callers list ids
explicitly; the planner never derives victims from retention policy, ordinals, timestamps, labels,
or capacity pressure. Apply deduplicates target paths, takes every target lock in one deterministic
order, and only then enters the store lock, holding `all targets → store` throughout — no store
kernel ever acquires a target lock in the reverse direction. Before the first destructive unlink
it re-reads **every** member and validates file type, raw revision and size, canonical path, and
committed status: a full-batch pin barrier, so a single drifted member means zero deletions. That
barrier deliberately does not require global object integrity, since an unrelated corrupt entry
should not block backlog repair.

There is no atomic rollback across manifests. Unlinks proceed in canonical id order, each followed
immediately by a directory fsync, and any failure stops at the first one. Once at least one unlink
has succeeded the operation must resolve to a bounded partial result rather than throw, so the
registry cannot discard the record that deletions happened. Results distinguish deleted, failed,
and not-attempted per entry. A replay returns the exact cached result and never auto-resumes from
the remaining index; continuing means listing, previewing, and approving again.

**Rolling retention** is off unless configured. Once on, create checkpoints are marked protected
and net-changing existing-file checkpoints become rolling with a durable global ordinal. The
sequence file updates and the manifest publishes under the same store lock, sequence first, so a
crash can leave an ordinal gap but cannot reuse one. Retention runs only after a promotion with no
durability warning and a successfully committed new checkpoint, while still holding the same target
locks, and deletes at most one victim per commit — no startup catch-up, no timer. Lowering the
count or recovering from a blocker does not self-correct; the operator prunes explicitly.
Wall-clock time, mtime, UUIDs, labels, and content revisions carry no ordering semantics, so a
clock adjustment or an A→B→A byte cycle cannot reorder deletion. Live ordinals need not be
contiguous and adjacent revisions need not chain: each checkpoint's own before-object is an
independent recovery anchor, so gaps do not make deleting the oldest anchor less safe.

## 14. Images and process safety

Limits are named constants in `src/maps/mapDomain.ts` and published through
`tiled_get_capabilities`, not scattered through the implementation. The load-bearing ones:

| Limit | Default |
|---|---:|
| Single JSON document | 64 MiB |
| Aggregate external TSJ bytes per map | 64 MiB |
| Decoded tile data per layer | 64 MiB |
| Tile writes per change set | 100,000 cells |
| Shared GID reads per change set (replace + flood + copy) | 1,000,000 |
| Object mutations per change set | 10,000 |
| Input image file | 64 MiB |
| Tileset source decode | 4096² pixels, 8192 px per side |
| Rendered surface | 1.5 megapixels, 2048 px per side |
| Returned PNG | 8 MiB |
| External process stdout / stderr | 1 MiB each |
| External process timeout | 15 s; 60 s for rendering |

Other rules:

- Images must be allowlisted local regular files. Format comes from content sniffing, not the
  extension, and dimensions are read before a full decode. Active content in SVG — DTD and
  entities, scripts, `foreignObject`, external links, CSS URLs, and entity or CSS-escape
  obfuscation of any of those — fails closed. The MCP process blocks libvips' generic loaders
  globally and re-enables only the specific in-memory buffer loaders it needs. Animated and
  multi-page inputs are rejected.
- Atlas crop origin for local id `i` is fixed at
  `x = margin + (i % columns) * (tilewidth + spacing)`,
  `y = margin + floor(i / columns) * (tileheight + spacing)`, with column capacity from Tiled's
  **single**-sided margin formula. Misreading it as two-sided is the classic bug here. Any
  disagreement between decoded size, declared columns, and full tile capacity is rejected rather
  than mapping a stale TSJ onto a new image.
- Native rendering guarantees a deliberately small subset: finite orthogonal maps, numeric-array
  tile layers, static external atlases, map-grid-sized tiles, transparent color, layer opacity,
  and orthogonal H/V/D. It explicitly refuses blend and tint modes, parallax, nonzero pixel or
  group offsets, non-default group opacity, animation, tile offsets, non-square diagonal flips,
  and image collections. Visible-but-undrawn layers appear in an omission list with a partial
  flag rather than silently posing as a complete image.
- Overlays are an explicit-selection projection, never a whole object layer posing as rendered.
  Highlight rectangles merge into a tile union before filling, so duplicates, overlap, and input
  order cannot change a pixel. Curves subdivide to a bounded output-space sagitta error before
  nearest-pixel quantization, and exceeding the curve budget rejects the whole preview rather than
  degrading precision or silently dropping a selection. Tile objects render frame-only, matching
  Tiled's own outline behavior where flips do not change the outline. Dangling GIDs, marker
  conflicts, illegal alignment enums, and malformed tile offsets fail closed rather than drawing a
  placeholder.
- Multi-image reads are sequential, not an atomic cross-file snapshot, and every such result is
  labeled `snapshotConsistency: "non-atomic-read-set"`. `tmxrasterizer` reads live files and
  cannot rule out an ABA within its run, so it carries the same label.
- Subprocesses get a minimal environment, a fixed executable, a fixed flag template, a controlled
  cwd, and a concurrency semaphore. A timeout kills the whole process group and cleans staging.
- Network images, remote templates, device files, FIFOs, and sockets are never followed. Asset
  inputs must be regular files.

## 15. Risks and test strategy

| Risk | Consequence | Defense |
|---|---|---|
| Unknown or newer fields dropped by a schema | irreversible asset damage | raw document authority, minimal text edits |
| Signed-bit or hex-flag confusion | wrong tile or orientation | one GID codec, orientation union, `>>> 0` everywhere |
| Mapping cascade or ignored transform | wrong swaps and cycles | encoded-GID exact match, single-pass lookup |
| Unbounded or diagonal flood fill | wrong region, runaway cost | fixed four-way, shared read budget, observed-GID validation |
| Overlapping copy smears | misplaced patterns | operation-start snapshots, memmove semantics |
| Chunks forcibly re-cut | diff explosion, coordinate damage | preserve original chunks, local rewrite only |
| Sparse local ids truncated by `tilecount` | GID resolves to the wrong tileset | highest-id and `nexttileid` range model |
| Tiled saving concurrently | silent overwrite of user work | raw-byte guard catches saves visible before it; the rest is a disclosed threat-model boundary |
| Crash mid multi-file commit | half-applied state | WAL with content-addressed blobs, idempotent recovery |
| Symlink or reference escape | out-of-bounds read/write | canonical root, per-segment validation; hostile parent swap disclosed as unsupported |
| Decompression bomb or huge image | OOM, stall | checked sizes, streaming caps, pixel quotas |
| Tiled version or exporter drift | adapter behavior changes | runtime probe, dynamic format discovery, pinned integration gate |
| Native preview diverging from Tiled | model misreads the image | explicitly narrow supported subset, golden images, rasterizer cross-check |
| Checkpoint corruption, misjudged prepared state, GC over-delete | unrecoverable or wrongly deleted recovery point | hash verification, full root tracking, `target → store` lock order, fail-closed inventory |

Test layers:

1. **Unit and property** — GIDs, paths, feature gates, id allocation, tile-data codecs, semantic
   search, edit merging.
2. **Fixture round-trip** — fixtures generated by the target Tiled version; no-ops compare bytes,
   local edits compare untouched text plus the semantic tree.
3. **Contract** — every input schema, every closed output schema, success and application-error
   `structuredContent`, the text summary contract, capability contracts, the machine artifacts
   and their matching resources, unknown-code compatibility, the `INTERNAL_ERROR` fallback, and
   the excluded-surface boundaries.
4. **Integration** — the ordinary suite tolerates a missing optional CLI and tests graceful
   degradation; `pnpm run verify:tiled-1.12.2` cannot skip and rejects a missing or wrong version,
   checking real export formats, fixture JSON round-trip, rasterized PNG, and re-export
   equivalence of `tiled_create_map` output.
5. **Fault recovery** — process-error injection across locks, checkpoints, and single-file
   replacement. Sudden power loss is out of scope.
6. **Security** — hostile JSON, compression, images, paths, symlink races, timeouts, subprocess
   output floods.

### Preview output-schema breadth is deliberate

Nine preview tools share `previewEditsToolOutputSchema`, the generic `mapEdit` union, at roughly
74 KB apiece — about half of all output-schema bytes in `tools/list`. That repetition is a
considered trade, not an oversight, and it should stay unless someone brings evidence.

Narrowing a tool means proving two things: which operation kinds it can emit, and which optional
summary members it can populate. The first is usually easy to read off a planner. The second is
not — `transcodes` and `chunkedTileLayerIds` depend on the target layer's encoding and on whether
the map is infinite, so the reachable set is a property of the caller's project, not of the tool.

The asymmetry that matters is how a wrong guess fails. `register()` validates the handler's
`structuredContent` against the declared output schema and turns a mismatch into `INTERNAL_ERROR`
with empty details. An over-tight output schema therefore does not fail loudly at review time; it
fails in production, on someone's map, as an opaque error with no indication that a schema is
responsible. Breadth is the safe direction.

The payoff for getting it right is also smaller than it looks. `outputSchema` is not part of the
Anthropic Messages API tool definition — that carries `name`, `description`, and `input_schema` —
so this breadth costs transport bytes on one `tools/list` per session, not model context. The
number worth watching is the ~90 KB of *input* schemas, where `tiled_preview_edits` alone is
about a quarter of the total.

`tiled_preview_shape` is the one narrowed case, at 7,765 bytes against the generic 73,837. It is
worth reading as the template for what "enough evidence" means, because the bar is unreachability
proven from source, not a summary observed on a fixture:

- `operations` — `MapService.planDrawShape` calls `planEdits` with a hardcoded single-element
  `[{ type: "setTiles" }]`, and `planEdits` deep-copies that array straight into the plan. No
  second element and no other kind is constructible.
- `summary.transcodes` — pushed at exactly one site in `mapOperations.ts`, inside the
  `operation.type === "transcodeTileLayer"` branch. Note that a zlib layer does *not* reach it:
  writes are source-preserving, so the layer keeps its encoding and nothing re-encodes.
- `summary.chunkedTileLayerIds` — requires a chunked layer, which exists only on an infinite map,
  and the planner rejects those with `UNSUPPORTED_MAP_PROFILE`.
- the remaining optional members each require their own operation kind.

Narrow another tool only behind end-to-end coverage through the MCP surface.
`tests/previewShape.test.ts` is the pattern, including the negative case — a test that calls
`MapService` directly does not exercise output validation at all and will not catch the failure.

## 16. Configuration

| Setting | Purpose | Default |
|---|---|---|
| `--project-dir` / `TILED_PROJECT_DIR` | the single primary read/write root; fail closed if absent | **required** |
| `--tiled-cli` / `TILED_CLI_PATH` | Tiled executable | `tiled` |
| `--rasterizer` / `TILED_RASTERIZER_PATH` | TmxRasterizer executable | `tmxrasterizer` |
| `--checkpoint-bytes` / `TILEDMCP_CHECKPOINT_BYTES` | checkpoint retained-storage byte quota | 1 GiB |
| `--checkpoint-retain-per-target` / `TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET` | enable rolling post-commit retention | disabled |

CLI takes precedence over environment. Apart from the checkpoint byte quota and the retention
floor, limits are built in. Startup reports the actual CLI probe result and never blocks
direct-JSON capability because an optional adapter is missing.

## 17. Module layout

```text
src/
├── index.ts            # wiring: resolver → store → map service → CLI adapter → server
├── server.ts           # all tool registration, input schemas, result envelopes
├── changeSets.ts       # the pending change-set registry and plan union
├── planKinds.ts        # plan-kind → applier mapped type (missing applier = compile error)
├── errorRegistry.ts    # the public application-error allowlist
├── formats/            # JSON parse, source-preserving patch, restricted XML
├── maps/               # domain limits, GID codec, planners, read projections, tileset writes
├── images/             # native rendering, atlas geometry, safe image decode
├── outputSchemas/      # closed Zod output schemas
├── project/            # path sandbox, asset registry
├── storage/            # document store, checkpoints, transactions, locks
├── resources/          # guide and application-error resource text
└── adapters/           # Tiled CLI and tmxrasterizer probing and invocation
```

The domain layer does not depend on the MCP SDK, the document layer does not depend on any
external Tiled process, and adapters never commit project assets directly. That dependency
direction is what keeps the safety boundary intact as TMX, Wang, world, and further automation
surfaces grow.
