import {
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

import { ChangeSetRegistry } from "../src/changeSets.js";
import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";

const MAP_PATH = "maps/level.tmj";
const TEMPLATE_PATH = "templates/crate.tj";

interface Harness {
  root: string;
  service: MapService;
  mapRevision: string;
  templateRevision: string;
}

describe("template instantiation via map edits", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("plans, previews, and applies the minimal instance form", async () => {
    const harness = await createHarness(roots);
    const plan =
      await harness.service.planInstantiateTemplate(
        {
          mapPath: MAP_PATH,
          layerId: 1,
          templatePath: TEMPLATE_PATH,
          x: 48,
          y: 32,
          expectedMapRevision:
            harness.mapRevision,
          expectedDependencyRevisions: {},
        },
      );
    expect(plan).toMatchObject({
      kind: "mapEdit",
      mapPath: MAP_PATH,
      operations: [
        {
          type: "instantiateTemplate",
          layerId: 1,
          templatePath: TEMPLATE_PATH,
          source: "../templates/crate.tj",
          x: 48,
          y: 32,
          expectedTemplateRevision:
            harness.templateRevision,
        },
      ],
    });

    const preview = new ChangeSetRegistry().put(
      plan,
    );
    expect(preview.operations[0]).toMatchObject({
      type: "instantiateTemplate",
      destructive: false,
      layerId: 1,
      templatePath: TEMPLATE_PATH,
      source: "../templates/crate.tj",
      x: 48,
      y: 32,
      expectedTemplateRevision:
        harness.templateRevision,
    });

    const result =
      await harness.service.applyEdits(plan);
    expect(result).toMatchObject({
      path: MAP_PATH,
      beforeRevision: harness.mapRevision,
      changed: true,
    });
    const saved = JSON.parse(
      await readFile(
        join(harness.root, MAP_PATH),
        "utf8",
      ),
    ) as {
      nextobjectid: number;
      layers: Array<{ objects?: JsonObject[] }>;
    };
    // Tiled's minimal serialized instance: every other member is
    // inherited from the template at load time.
    expect(saved.layers[0]!.objects).toEqual([
      {
        id: 7,
        template: "../templates/crate.tj",
        x: 48,
        y: 32,
      },
    ]);
    expect(saved.nextobjectid).toBe(8);

    // The placed instance reads back expanded through the template.
    const expanded =
      await harness.service.getObject({
        mapPath: MAP_PATH,
        objectId: 7,
      });
    expect(expanded).toMatchObject({
      template: { path: TEMPLATE_PATH },
      object: {
        id: 7,
        name: "Crate",
        x: 48,
        y: 32,
        width: 12,
        height: 8,
      },
    });
  });

  it("pins the template revision at planning time", async () => {
    const harness = await createHarness(roots);
    await expect(
      harness.service.planInstantiateTemplate({
        mapPath: MAP_PATH,
        layerId: 1,
        templatePath: TEMPLATE_PATH,
        x: 0,
        y: 0,
        expectedMapRevision: harness.mapRevision,
        expectedDependencyRevisions: {},
        expectedTemplateRevision:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
    });
  });

  it("re-verifies the template pin at apply time", async () => {
    const harness = await createHarness(roots);
    const plan =
      await harness.service.planInstantiateTemplate(
        {
          mapPath: MAP_PATH,
          layerId: 1,
          templatePath: TEMPLATE_PATH,
          x: 0,
          y: 0,
          expectedMapRevision:
            harness.mapRevision,
          expectedDependencyRevisions: {},
        },
      );
    await writeFile(
      join(harness.root, TEMPLATE_PATH),
      serializeJsonDocument(
        baseTemplate({ name: "Renamed" }),
      ),
    );
    await expect(
      harness.service.applyEdits(plan),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_REVISION_CONFLICT",
    });
  });

  it("fails closed on tile templates, nested templates, and non-.tj paths", async () => {
    const tileTemplate = await createHarness(
      roots,
      {
        template: {
          type: "template",
          tileset: {
            firstgid: 1,
            source: "../tiles/props.tsj",
          },
          object: { id: 0, gid: 1, x: 0, y: 0 },
        },
      },
    );
    await expect(
      tileTemplate.service.planInstantiateTemplate(
        {
          mapPath: MAP_PATH,
          layerId: 1,
          templatePath: TEMPLATE_PATH,
          x: 0,
          y: 0,
          expectedMapRevision:
            tileTemplate.mapRevision,
          expectedDependencyRevisions: {},
        },
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OBJECT_PROFILE",
    });

    const nested = await createHarness(roots, {
      template: {
        type: "template",
        object: {
          id: 0,
          template: "other.tj",
          x: 0,
          y: 0,
        },
      },
    });
    await expect(
      nested.service.planInstantiateTemplate({
        mapPath: MAP_PATH,
        layerId: 1,
        templatePath: TEMPLATE_PATH,
        x: 0,
        y: 0,
        expectedMapRevision: nested.mapRevision,
        expectedDependencyRevisions: {},
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });

    const plain = await createHarness(roots);
    await expect(
      plain.service.planInstantiateTemplate({
        mapPath: MAP_PATH,
        layerId: 1,
        templatePath: "templates/crate.tx",
        x: 0,
        y: 0,
        expectedMapRevision: plain.mapRevision,
        expectedDependencyRevisions: {},
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });

  it("rejects a target layer that is not an object layer", async () => {
    const harness = await createHarness(roots);
    await expect(
      harness.service.planInstantiateTemplate({
        mapPath: MAP_PATH,
        layerId: 2,
        templatePath: TEMPLATE_PATH,
        x: 0,
        y: 0,
        expectedMapRevision: harness.mapRevision,
        expectedDependencyRevisions: {},
      }),
    ).rejects.toMatchObject({
      code: "LAYER_NOT_FOUND",
    });
  });
});

function baseTemplate(
  overrides: JsonObject = {},
): JsonObject {
  return {
    type: "template",
    object: {
      id: 0,
      name: "Crate",
      width: 12,
      height: 8,
      x: 0,
      y: 0,
      ...overrides,
    },
  };
}

async function createHarness(
  roots: Set<string>,
  options: { template?: JsonObject } = {},
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-template-write-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "templates"));
  await writeFile(
    join(root, TEMPLATE_PATH),
    serializeJsonDocument(
      options.template ?? baseTemplate(),
    ),
  );
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument({
      compressionlevel: -1,
      height: 2,
      infinite: false,
      layers: [
        {
          draworder: "topdown",
          id: 1,
          name: "Objects",
          objects: [],
          opacity: 1,
          type: "objectgroup",
          visible: true,
        },
      ],
      nextlayerid: 2,
      nextobjectid: 7,
      orientation: "orthogonal",
      renderorder: "right-down",
      tiledversion: "1.12.2",
      tileheight: 16,
      tilesets: [],
      tilewidth: 16,
      type: "map",
      version: "1.10",
      width: 2,
    }),
  );

  const { store, service } =
    await wireProject(root);
  const summary = (await service.getSummary(
    MAP_PATH,
  )) as { revision: string };
  const template = await store.read(
    TEMPLATE_PATH,
  );
  return {
    root,
    service,
    mapRevision: summary.revision,
    templateRevision: template.revision,
  };
}
