import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeJsonDocument } from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

describe("semantic tile-name registry", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("reads a registry with pinned tileset revisions and sorts names", async () => {
    const harness = await createHarness(roots);
    await mkdir(
      join(harness.root, ".tiledmcp"),
      { recursive: true },
    );
    await writeFile(
      join(
        harness.root,
        ".tiledmcp/tile-names.json",
      ),
      JSON.stringify({
        version: 1,
        names: {
          water: {
            tileset: "tiles/decor.tsj",
            localId: 1,
          },
          grass: {
            tileset: "tiles/decor.tsj",
            localId: 0,
          },
        },
      }),
    );
    const result =
      await harness.service.listTileNames();
    expect(result).toMatchObject({
      registryPresent: true,
      count: 2,
      names: [
        {
          name: "grass",
          localId: 0,
          tileset: {
            path: "tiles/decor.tsj",
            revision: expect.stringMatching(
              /^sha256:/u,
            ),
          },
        },
        { name: "water", localId: 1 },
      ],
    });
  });

  it("reads a missing registry as empty and fails closed on bad shapes", async () => {
    const harness = await createHarness(roots);
    expect(
      await harness.service.listTileNames(),
    ).toMatchObject({
      registryPresent: false,
      count: 0,
      names: [],
    });

    await mkdir(
      join(harness.root, ".tiledmcp"),
      { recursive: true },
    );
    const registryPath = join(
      harness.root,
      ".tiledmcp/tile-names.json",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        names: {
          "Bad Name": {
            tileset: "tiles/decor.tsj",
            localId: 0,
          },
        },
      }),
    );
    await expect(
      harness.service.listTileNames(),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });

    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        names: {
          ghost: {
            tileset: "tiles/missing.tsj",
            localId: 0,
          },
        },
      }),
    );
    await expect(
      harness.service.listTileNames(),
    ).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
  });
});

describe("tile-name registry edits", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("plans against an absent registry, applies, and pins revisions", async () => {
    const harness = await createHarness(roots);
    const plan =
      await harness.service.planTileNameEdits({
        operations: [
          {
            type: "upsertName",
            name: "grass",
            tileset: "tiles/decor.tsj",
            localId: 0,
          },
        ],
        expectedRegistryRevision: null,
      });
    expect(plan).toMatchObject({
      kind: "tileNameEdit",
      registryRevision: null,
      summary: {
        upserts: 1,
        deletes: 0,
        resultingCount: 1,
      },
    });
    const applied =
      await harness.service.applyTileNameEdit(
        plan,
      );
    expect(applied).toMatchObject({
      changed: true,
      nameCount: 1,
    });
    const listed =
      await harness.service.listTileNames();
    expect(listed).toMatchObject({
      registryPresent: true,
      count: 1,
      names: [
        { name: "grass", localId: 0 },
      ],
    });

    // A second plan pins the now-present revision; the stale null pin
    // fails closed at apply.
    await expect(
      harness.service.applyTileNameEdit(plan),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    const second =
      await harness.service.planTileNameEdits({
        operations: [
          { type: "deleteName", name: "grass" },
        ],
      });
    await harness.service.applyTileNameEdit(
      second,
    );
    expect(
      await harness.service.listTileNames(),
    ).toMatchObject({ count: 0 });
  });

  it("fails closed on missing tilesets and unregistered deletes", async () => {
    const harness = await createHarness(roots);
    await expect(
      harness.service.planTileNameEdits({
        operations: [
          {
            type: "upsertName",
            name: "ghost",
            tileset: "tiles/missing.tsj",
            localId: 0,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
    await expect(
      harness.service.planTileNameEdits({
        operations: [
          { type: "deleteName", name: "nope" },
        ],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

async function createHarness(
  roots: Set<string>,
): Promise<{
  root: string;
  service: MapService;
}> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-tile-names-"),
  );
  roots.add(root);
  await mkdir(join(root, "tiles"));
  await writeFile(
    join(root, "tiles/decor.png"),
    Buffer.from("placeholder image bytes", "utf8"),
  );
  await writeFile(
    join(root, "tiles/decor.tsj"),
    serializeJsonDocument({
      columns: 2,
      image: "decor.png",
      imageheight: 16,
      imagewidth: 32,
      margin: 0,
      name: "Decor",
      spacing: 0,
      tilecount: 2,
      tiledversion: "1.12.2",
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.10",
    }),
  );
  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  return {
    root,
    service: new MapService(resolver, store),
  };
}
