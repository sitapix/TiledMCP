import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { wireProject } from "./support/project.js";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TiledCliAdapter } from "../src/adapters/tiledCli.js";
import { ChangeSetRegistry } from "../src/changeSets.js";
import { serializeJsonDocument } from "../src/formats/json.js";
import {
  MapService,
  type TiledExportRunner,
} from "../src/maps/mapService.js";
import { revisionOf } from "../src/storage/revision.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const MAP_PATH = "maps/level.tmj";
const ALLOWED = {
  map: ["tmx", "json", "csv"],
  tileset: ["tsx", "json"],
};

interface Harness {
  root: string;
  service: MapService;
  store: DocumentStore;
}

describe("tiled CLI file export", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("plans, previews, and applies a deterministic export", async () => {
    const harness = await createHarness(roots);
    const output = Buffer.from(
      "<map exported/>\n",
      "utf8",
    );
    const calls: Array<Record<string, unknown>> =
      [];
    const runner: TiledExportRunner = async (
      options,
    ) => {
      calls.push({ ...options });
      return output;
    };

    const plan = await harness.service.planExportFile(
      {
        sourcePath: MAP_PATH,
        targetPath: "exports/level.tmx",
      },
      runner,
      ALLOWED,
    );
    expect(plan).toMatchObject({
      kind: "fileExport",
      sourcePath: MAP_PATH,
      targetPath: "exports/level.tmx",
      exportKind: "map",
      format: "tmx",
      baseRevision: revisionOf(output),
      summary: {
        contentBytes: output.byteLength,
        wouldChange: true,
      },
    });
    expect(calls[0]).toMatchObject({
      kind: "map",
      format: "tmx",
    });
    expect(
      String(calls[0]?.outputPath).endsWith(
        "out.tmx",
      ),
    ).toBe(true);

    const preview = new ChangeSetRegistry().put(
      plan,
    );
    expect(preview.operations[0]).toMatchObject({
      type: "exportFile",
      destructive: false,
      targetPath: "exports/level.tmx",
      format: "tmx",
      contentBytes: output.byteLength,
    });

    const result =
      await harness.service.applyExportFile(
        plan,
        runner,
      );
    expect(result).toMatchObject({
      path: "exports/level.tmx",
      beforeRevision: null,
      revision: revisionOf(output),
      changed: true,
    });
    const written = await readFile(
      join(harness.root, "exports/level.tmx"),
    );
    expect(written.equals(output)).toBe(true);

    // The target now exists, so re-applying fails closed.
    await expect(
      harness.service.applyExportFile(
        plan,
        runner,
      ),
    ).rejects.toMatchObject({
      code: "FILE_ALREADY_EXISTS",
    });
  });

  it("fails closed on drift, bad formats, and stale sources", async () => {
    const harness = await createHarness(roots);
    const runner: TiledExportRunner = async () =>
      Buffer.from("stable", "utf8");

    await expect(
      harness.service.planExportFile(
        {
          sourcePath: MAP_PATH,
          targetPath: "exports/level.gmx",
        },
        runner,
        ALLOWED,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: expect.objectContaining({
        allowed: ["tmx", "json", "csv"],
      }),
    });
    await expect(
      harness.service.planExportFile(
        {
          sourcePath: "exports/readme.txt",
          targetPath: "exports/out.tmx",
        },
        runner,
        ALLOWED,
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
    await expect(
      harness.service.planExportFile(
        {
          sourcePath: MAP_PATH,
          targetPath: MAP_PATH,
        },
        runner,
        ALLOWED,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });

    const plan = await harness.service.planExportFile(
      {
        sourcePath: MAP_PATH,
        targetPath: "exports/level.tmx",
      },
      runner,
      ALLOWED,
    );
    // A drifting re-export refuses to apply.
    await expect(
      harness.service.applyExportFile(
        plan,
        async () => Buffer.from("drift", "utf8"),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_CHANGE_SET",
    });
    // A changed source fails closed before any CLI work.
    await writeFile(
      join(harness.root, MAP_PATH),
      serializeJsonDocument({
        ...baseMap(),
        renderorder: "left-up",
      }),
    );
    await expect(
      harness.service.applyExportFile(
        plan,
        runner,
      ),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
    });
  });

  it("runs a fake tiled executable with exact export arguments", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "tiledmcp-fake-tiled-"),
    );
    roots.add(root);
    const fakeTiled = join(root, "fake-tiled.mjs");
    await writeFile(
      fakeTiled,
      [
        "#!/usr/bin/env node",
        "import { writeFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        "if (args[0] !== '--export-map' || args.length !== 4) {",
        "  process.stderr.write('unexpected args\\n');",
        "  process.exit(2);",
        "}",
        "writeFileSync(args[3], `exported:${args[1]}\\n`);",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeTiled, 0o700);
    const adapter = new TiledCliAdapter({
      tiledCliPath: fakeTiled,
      rasterizerPath: process.execPath,
    });
    const outputPath = join(root, "out.tmx");
    const sourcePath = join(root, "in.tmj");
    await writeFile(sourcePath, "{}", "utf8");
    const bytes = await adapter.exportAsset({
      kind: "map",
      format: "tmx",
      sourcePath,
      outputPath,
      maxOutputBytes: 1024,
    });
    expect(bytes.toString("utf8")).toBe(
      "exported:tmx\n",
    );
    await expect(
      adapter.exportAsset({
        kind: "map",
        format: "tmx",
        sourcePath,
        outputPath: join(root, "big.tmx"),
        maxOutputBytes: 4,
      }),
    ).rejects.toMatchObject({
      code: "RESULT_LIMIT_EXCEEDED",
    });
  });
});

function baseMap() {
  return {
    compressionlevel: -1,
    height: 1,
    infinite: false,
    layers: [
      {
        data: [0],
        height: 1,
        id: 1,
        name: "g",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 1,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 2,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 1,
  };
}

async function createHarness(
  roots: Set<string>,
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-file-export-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "exports"));
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument(baseMap()),
  );
  await writeFile(
    join(root, "exports/readme.txt"),
    "not a map",
    "utf8",
  );

  const { store, service } =
    await wireProject(root);
  return {
    root,
    store,
    service: service,
  };
}
