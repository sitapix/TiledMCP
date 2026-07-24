import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  DocumentStore,
  readDocumentFileSnapshot,
} from "../src/storage/documentStore.js";
import { revisionOf } from "../src/storage/revision.js";

const INITIAL_DOCUMENT: JsonObject = {
  type: "map",
  version: "1.10",
  width: 1,
  height: 1,
  layers: [],
  vendorExtension: {
    enabled: true,
    nested: ["keep-me", { futureField: 42 }],
  },
};

describe("DocumentStore", () => {
  let root: string;
  let store: DocumentStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tiledmcp-document-store-"));
    await mkdir(join(root, "maps"));
    const resolver = await ProjectPathResolver.create(root);
    store = new DocumentStore(resolver);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads a revision derived from the exact file bytes", async () => {
    const content = Buffer.from(
      `\uFEFF${JSON.stringify(INITIAL_DOCUMENT, null, 4)}\n`,
      "utf8",
    );
    await writeFile(join(root, "maps", "level.tmj"), content);

    const loaded = await store.read("maps/level.tmj");

    expect(loaded).toMatchObject({
      path: "maps/level.tmj",
      revision: revisionOf(content),
      size: content.byteLength,
    });
    expect(loaded.source).toEqual(content);
    expect(loaded.document.vendorExtension).toEqual(
      INITIAL_DOCUMENT.vendorExtension,
    );
  });

  it.each([
    {
      name: "same-size overwrite",
      replacement: Buffer.alloc(70 * 1024, 0x62),
    },
    {
      name: "growth",
      replacement: Buffer.alloc(80 * 1024, 0x63),
    },
    {
      name: "truncation",
      replacement: Buffer.alloc(1_024, 0x64),
    },
  ])("rejects a document $name during one fd read", async ({ replacement }) => {
    const absolutePath = join(root, "maps", "changing.tmj");
    await writeFile(absolutePath, Buffer.alloc(70 * 1024, 0x61));
    let mutated = false;

    await expect(
      readDocumentFileSnapshot(
        absolutePath,
        "maps/changing.tmj",
        128 * 1024,
        {
          afterChunk: async () => {
            if (!mutated) {
              mutated = true;
              await writeFile(absolutePath, replacement);
            }
          },
        },
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DOCUMENT_CHANGED_DURING_READ",
      details: { path: "maps/changing.tmj" },
    });
    expect(mutated).toBe(true);
  });

  it("commits caller-provided validated JSON bytes without normalizing them", async () => {
    const initial = serializeJsonDocument(INITIAL_DOCUMENT);
    await writeFile(join(root, "maps", "level.tmj"), initial);
    const loaded = await store.read("maps/level.tmj");
    const proposed = Buffer.from(
      '\uFEFF{"type":"map", "version":"1.10", "width":2, "height":1, "layers":[]}\r\n',
      "utf8",
    );

    const result = await store.commitBytes(
      "maps/level.tmj",
      loaded.revision,
      proposed,
      "source-preserving edit",
    );

    expect(await readFile(join(root, "maps", "level.tmj"))).toEqual(proposed);
    expect(result.revision).toBe(revisionOf(proposed));
  });

  it("rejects invalid proposed bytes before replacing the current document", async () => {
    const initial = serializeJsonDocument(INITIAL_DOCUMENT);
    await writeFile(join(root, "maps", "level.tmj"), initial);
    const loaded = await store.read("maps/level.tmj");

    await expect(
      store.commitBytes(
        "maps/level.tmj",
        loaded.revision,
        Buffer.from('{"type":"map","type":"duplicate"}\n', "utf8"),
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "DUPLICATE_JSON_KEY",
    });
    expect(await readFile(join(root, "maps", "level.tmj"))).toEqual(initial);
  });

  it("rejects non-UTF-8 source and proposed bytes", async () => {
    const invalidUtf8 = Buffer.from([
      ...Buffer.from('{"type":"map","name":"', "utf8"),
      0xc3,
      0x28,
      ...Buffer.from('"}\n', "utf8"),
    ]);
    await writeFile(join(root, "maps", "level.tmj"), invalidUtf8);
    await expect(store.read("maps/level.tmj")).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_JSON",
    });

    const initial = serializeJsonDocument(INITIAL_DOCUMENT);
    await writeFile(join(root, "maps", "level.tmj"), initial);
    const loaded = await store.read("maps/level.tmj");
    await expect(
      store.commitBytes("maps/level.tmj", loaded.revision, invalidUtf8),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_JSON",
    });
    expect(await readFile(join(root, "maps", "level.tmj"))).toEqual(initial);
  });

  it("rejects a stale expectedRevision without overwriting external changes", async () => {
    const initial = serializeJsonDocument(INITIAL_DOCUMENT);
    await writeFile(join(root, "maps", "level.tmj"), initial);
    const loaded = await store.read("maps/level.tmj");

    const externallyChanged = Buffer.from(
      '{"type":"map","width":99,"external":"must survive"}\n',
      "utf8",
    );
    await writeFile(join(root, "maps", "level.tmj"), externallyChanged);

    const proposed: JsonObject = { ...loaded.document, width: 2 };
    await expect(
      store.commit("maps/level.tmj", loaded.revision, proposed),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "REVISION_CONFLICT",
      details: {
        path: "maps/level.tmj",
        expectedRevision: loaded.revision,
        actualRevision: revisionOf(externallyChanged),
      },
    });

    expect(await readFile(join(root, "maps", "level.tmj"))).toEqual(
      externallyChanged,
    );
  });

  it("atomically commits a complete document and preserves unknown JSON fields", async () => {
    const initial = serializeJsonDocument(INITIAL_DOCUMENT);
    await writeFile(join(root, "maps", "level.tmj"), initial);
    const loaded = await store.read("maps/level.tmj");
    const proposed: JsonObject = { ...loaded.document, width: 2 };

    const result = await store.commit(
      "maps/level.tmj",
      loaded.revision,
      proposed,
      "resize map",
    );
    const finalContent = await readFile(join(root, "maps", "level.tmj"));
    const finalDocument = JSON.parse(finalContent.toString("utf8")) as JsonObject;

    expect(result).toMatchObject({
      path: "maps/level.tmj",
      beforeRevision: loaded.revision,
      revision: revisionOf(finalContent),
      changed: true,
    });
    expect(result.checkpointId).toEqual(expect.any(String));
    expect(finalDocument.width).toBe(2);
    expect(finalDocument.vendorExtension).toEqual(
      INITIAL_DOCUMENT.vendorExtension,
    );
    expect(await readdir(join(root, "maps"))).toEqual(["level.tmj"]);
  });

  it("stores the exact prior bytes in a content-addressed object and committed manifest", async () => {
    const initial = Buffer.from(
      `${JSON.stringify(INITIAL_DOCUMENT, null, 4)}\n`,
      "utf8",
    );
    await writeFile(join(root, "maps", "level.tmj"), initial);
    const loaded = await store.read("maps/level.tmj");
    const proposed: JsonObject = { ...loaded.document, height: 2 };

    const result = await store.commit(
      "maps/level.tmj",
      loaded.revision,
      proposed,
      "grow map",
    );
    expect(result.checkpointId).not.toBeNull();
    const checkpointId = result.checkpointId as string;
    const manifestPath = join(
      root,
      ".tiledmcp",
      "checkpoints",
      `${checkpointId}.json`,
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      id: string;
      label: string;
      path: string;
      status: string;
      before: {
        existed: boolean;
        revision: string;
        objectHash: string;
        size: number;
      };
      afterRevision: string;
    };
    const expectedObjectHash = createHash("sha256")
      .update(initial)
      .digest("hex");
    const storedObject = await readFile(
      join(root, ".tiledmcp", "objects", expectedObjectHash),
    );

    expect(manifest).toMatchObject({
      id: checkpointId,
      label: "grow map",
      path: "maps/level.tmj",
      status: "committed",
      before: {
        existed: true,
        revision: loaded.revision,
        objectHash: expectedObjectHash,
        size: initial.byteLength,
      },
      afterRevision: result.revision,
    });
    expect(storedObject).toEqual(initial);
  });

  it("refuses to create over an existing document and leaves it byte-for-byte intact", async () => {
    const existing = Buffer.from('{"owner":"user","spacing":"unchanged"}\n', "utf8");
    await writeFile(join(root, "maps", "level.tmj"), existing);

    await expect(
      store.create("maps/level.tmj", { type: "map", width: 10 }),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "FILE_ALREADY_EXISTS",
    });
    expect(await readFile(join(root, "maps", "level.tmj"))).toEqual(existing);
  });

  it("reverts a committed checkpoint under CAS and records the revert", async () => {
    const initial = serializeJsonDocument(INITIAL_DOCUMENT);
    await writeFile(join(root, "maps", "level.tmj"), initial);
    const loaded = await store.read("maps/level.tmj");
    const edited: JsonObject = {
      ...loaded.document,
      width: 7,
      vendorExtension: {
        enabled: false,
        nested: ["edited"],
      },
    };
    const editResult = await store.commit(
      "maps/level.tmj",
      loaded.revision,
      edited,
      "edit before revert",
    );
    expect(editResult.checkpointId).not.toBeNull();
    const interruptedManifest = await store.checkpoints.read(
      editResult.checkpointId as string,
    );
    interruptedManifest.status = "prepared";
    await writeFile(
      join(
        root,
        ".tiledmcp",
        "checkpoints",
        `${editResult.checkpointId as string}.json`,
      ),
      `${JSON.stringify(interruptedManifest, null, 2)}\n`,
      "utf8",
    );

    const revertResult = await store.revert(
      editResult.checkpointId as string,
      editResult.revision,
    );
    const finalContent = await readFile(join(root, "maps", "level.tmj"));
    const revertManifest = await store.checkpoints.read(
      revertResult.checkpointId as string,
    );

    expect(revertResult).toMatchObject({
      path: "maps/level.tmj",
      beforeRevision: editResult.revision,
      revision: loaded.revision,
      changed: true,
    });
    expect(revertResult.checkpointId).not.toBe(editResult.checkpointId);
    expect(finalContent).toEqual(initial);
    expect(revertManifest).toMatchObject({
      path: "maps/level.tmj",
      status: "committed",
      afterRevision: loaded.revision,
    });
    expect(revertManifest.label).toContain(
      `revert checkpoint ${editResult.checkpointId}`,
    );
  });
});
