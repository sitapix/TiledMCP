import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { wireProject } from "./support/project.js";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
}

describe("object template reading", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("expands a template instance with syncWithTemplate merge rules", async () => {
    const harness = await createHarness(roots, {
      template: {
        type: "template",
        object: {
          id: 0,
          name: "Crate",
          type: "Prop",
          width: 12,
          height: 8,
          rotation: 45,
          visible: false,
          ellipse: true,
          x: 0,
          y: 0,
        },
      },
      instances: [
        // Inherits everything except position and the explicit rotation.
        {
          id: 1,
          template: "../templates/crate.tj",
          x: 5,
          y: 6,
          rotation: 90,
        },
        // A nonempty name and a full size override the template; the
        // instance polygon overrides the template's ellipse shape.
        {
          id: 2,
          template: "../templates/crate.tj",
          name: "Custom",
          width: 3,
          height: 4,
          polygon: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 0, y: 4 },
          ],
          x: 9,
          y: 9,
        },
      ],
    });

    const inherited =
      await harness.service.getObject({
        mapPath: MAP_PATH,
        objectId: 1,
      });
    expect(inherited).toMatchObject({
      template: {
        path: TEMPLATE_PATH,
        revision: expect.stringMatching(
          /^sha256:[0-9a-f]{64}$/u,
        ),
        mergeProfile:
          "tiled-sync-with-template-v1",
        propertiesSource: "instance-only",
      },
      object: {
        id: 1,
        shape: "ellipse",
        name: "Crate",
        x: 5,
        y: 6,
        width: 12,
        height: 8,
        rotation: 90,
        visible: false,
      },
    });

    const overridden =
      await harness.service.getObject({
        mapPath: MAP_PATH,
        objectId: 2,
      });
    expect(overridden).toMatchObject({
      object: {
        id: 2,
        shape: "polygon",
        name: "Custom",
        // rotation not serialized on the instance: inherited.
        rotation: 45,
        visible: false,
      },
    });
  });

  it("fails closed on tile templates, XML templates, and nesting", async () => {
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
        instances: [
          {
            id: 1,
            template: "../templates/crate.tj",
            x: 1,
            y: 1,
          },
        ],
      },
    );
    await expect(
      tileTemplate.service.getObject({
        mapPath: MAP_PATH,
        objectId: 1,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OBJECT_PROFILE",
    });

    const xmlTemplate = await createHarness(
      roots,
      {
        template: {
          type: "template",
          object: { id: 0, x: 0, y: 0 },
        },
        instances: [
          {
            id: 1,
            template: "../templates/crate.tx",
            x: 1,
            y: 1,
          },
        ],
      },
    );
    await expect(
      xmlTemplate.service.getObject({
        mapPath: MAP_PATH,
        objectId: 1,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
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
      instances: [
        {
          id: 1,
          template: "../templates/crate.tj",
          x: 1,
          y: 1,
        },
      ],
    });
    await expect(
      nested.service.getObject({
        mapPath: MAP_PATH,
        objectId: 1,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
  });
});

async function createHarness(
  roots: Set<string>,
  options: {
    template: JsonObject;
    instances: JsonObject[];
  },
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-template-read-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "templates"));
  await writeFile(
    join(root, TEMPLATE_PATH),
    serializeJsonDocument(options.template),
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
          objects: options.instances,
          opacity: 1,
          type: "objectgroup",
          visible: true,
        },
      ],
      nextlayerid: 2,
      nextobjectid: 100,
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

  const { service } =
    await wireProject(root);
  return {
    root,
    service: service,
  };
}
