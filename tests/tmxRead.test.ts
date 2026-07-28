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

const TMX_PATH = "maps/level.tmx";

const TMX_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<map version="1.10" tiledversion="1.12.2" orientation="orthogonal" renderorder="right-down" width="2" height="2" tilewidth="16" tileheight="16" infinite="0" nextlayerid="5" nextobjectid="2" class="Overworld">
 <tileset firstgid="1" source="../tiles/terrain.tsx"/>
 <tileset firstgid="9">
  <image source="../tiles/inline.png" width="32" height="16"/>
 </tileset>
 <layer id="1" name="ground" width="2" height="2">
  <data encoding="csv">
1,0,
0,2
</data>
 </layer>
 <group id="2" name="stuff">
  <objectgroup id="3" name="objects">
   <object id="1" name="spawn" x="8" y="8"/>
  </objectgroup>
  <layer id="4" name="deco" width="2" height="2" visible="0" opacity="0.5">
   <data encoding="base64" compression="zlib">eJxjYGBgAAAABAAB</data>
  </layer>
 </group>
</map>
`;

interface Harness {
  root: string;
  service: MapService;
}

describe("TMX read-only core", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("summarizes a TMX map with pinned external tileset references", async () => {
    const harness = await createHarness(roots);
    const summary = await harness.service.getSummary(
      TMX_PATH,
    );
    expect(summary).toMatchObject({
      path: TMX_PATH,
      format: "tmx",
      profile: "tmx-read-only-summary-v1",
      orientation: "orthogonal",
      infinite: false,
      renderOrder: "right-down",
      className: "Overworld",
      width: 2,
      height: 2,
      tileWidth: 16,
      tileHeight: 16,
      editable: false,
      revision: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/u,
      ),
      snapshotConsistency:
        "non-atomic-read-set",
      tilesets: [
        {
          firstGid: 1,
          source: "../tiles/terrain.tsx",
          path: "tiles/terrain.tsx",
          exists: true,
          revision: expect.stringMatching(
            /^sha256:/u,
          ),
        },
        {
          firstGid: 9,
          embedded: true,
        },
      ],
      layers: [
        {
          id: 1,
          name: "ground",
          type: "tilelayer",
          visible: true,
          opacity: 1,
          width: 2,
          height: 2,
          encoding: "csv",
          chunked: false,
        },
        {
          id: 2,
          name: "stuff",
          type: "group",
          layers: [
            {
              id: 3,
              type: "objectgroup",
              objectCount: 1,
            },
            {
              id: 4,
              name: "deco",
              type: "tilelayer",
              visible: false,
              opacity: 0.5,
              encoding: "base64",
              compression: "zlib",
            },
          ],
        },
      ],
    });
  });

  it("keeps missing references and edit paths fail closed", async () => {
    const harness = await createHarness(roots, {
      includeTsx: false,
    });
    const summary = await harness.service.getSummary(
      TMX_PATH,
    );
    expect(
      (summary.tilesets as Array<{ exists?: boolean }>)[0],
    ).toMatchObject({ exists: false });
    // TMX maps never reach the edit planner.
    await expect(
      harness.service.planEdits(
        TMX_PATH,
        summary.revision as string,
        {},
        [
          {
            type: "updateMap",
            patch: { renderOrder: "left-up" },
          },
        ],
      ),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
    });
  });

  it("scans XML referrers during delete instead of refusing wholesale", async () => {
    const harness = await createHarness(roots);
    // A TMX referrer alone must block the JSON tileset's deletion.
    await writeFile(
      join(harness.root, "maps/blocker.tmx"),
      `<?xml version="1.0"?>\n<map version="1.10" orientation="orthogonal" renderorder="right-down" width="1" height="1" tilewidth="16" tileheight="16" infinite="0"><tileset firstgid="1" source="../tiles/loner.tsj"/><layer id="1" name="g" width="1" height="1"><data encoding="csv">0</data></layer></map>\n`,
      "utf8",
    );
    await expect(
      harness.service.planDeleteFile({
        path: "tiles/loner.tsj",
      }),
    ).rejects.toMatchObject({
      code: "FILE_IN_USE",
      details: expect.objectContaining({
        referencedBy: ["maps/blocker.tmx"],
      }),
    });

    await rm(
      join(harness.root, "maps/blocker.tmx"),
    );
    const plan =
      await harness.service.planDeleteFile({
        path: "tiles/loner.tsj",
      });
    expect(plan).toMatchObject({
      kind: "fileDelete",
      targetPath: "tiles/loner.tsj",
    });
    expect(plan.scan.scannedMaps).toBeGreaterThan(
      0,
    );
  });
});

async function createHarness(
  roots: Set<string>,
  options: { includeTsx?: boolean } = {},
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-tmx-read-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeFile(
    join(root, TMX_PATH),
    TMX_SOURCE,
    "utf8",
  );
  if (options.includeTsx !== false) {
    await writeFile(
      join(root, "tiles/terrain.tsx"),
      `<?xml version="1.0"?>\n<tileset version="1.10" name="t" tilewidth="16" tileheight="16" tilecount="2" columns="2"><image source="terrain.png" width="32" height="16"/></tileset>\n`,
      "utf8",
    );
  }
  await writeFile(
    join(root, "tiles/loner.tsj"),
    serializeJsonDocument({
      columns: 2,
      image: "terrain.png",
      imageheight: 16,
      imagewidth: 32,
      margin: 0,
      name: "Loner",
      spacing: 0,
      tilecount: 2,
      tiledversion: "1.12.2",
      tileheight: 16,
      tilewidth: 16,
      type: "tileset",
      version: "1.10",
    }),
  );
  await writeFile(
    join(root, "tiles/terrain.png"),
    Buffer.from("placeholder image bytes", "utf8"),
  );

  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  return {
    root,
    service: new MapService(resolver, store),
  };
}
