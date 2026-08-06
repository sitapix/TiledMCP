import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withProject } from "./support/project.js";

/**
 * An image layer must report the image it points at.
 *
 * The layer is the reference someone drops in to trace over, so which image it
 * is *is* the content. The summary once reported the layer without it, and no
 * other read exposed it either, which left a caller able to see that a
 * "Reference" layer existed but not what it referenced -- and the native
 * preview does not draw image layers, so there was no way to find out short of
 * rasterizing through the optional Tiled CLI.
 */

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "isotown",
);

const MAP_PATH = "m.tmj";
const IMAGE_PATH = "plan.png";

interface Service {
  createMap(input: unknown): Promise<unknown>;
  getSummary(mapPath: string): Promise<unknown>;
  planCreateLayer(input: unknown): Promise<unknown>;
  applyEdits(plan: unknown): Promise<unknown>;
  renderPreview(input: unknown): Promise<unknown>;
}

interface LayerSummary {
  id: number;
  name: string;
  type: string;
  image?: { path: string };
}

describe("image layer reads", () => {
  it("reports the referenced image path in the map summary", async () => {
    await withProject(
      {
        files: {
          [IMAGE_PATH]: await readFile(
            join(FIXTURE_DIR, "tiles.png"),
          ),
        },
        prefix: "tiledmcp-imagelayer",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        await service.createMap({
          mapPath: MAP_PATH,
          width: 8,
          height: 6,
          tileWidth: 64,
          tileHeight: 32,
        });
        const created =
          (await service.getSummary(
            MAP_PATH,
          )) as { revision: string };

        const plan =
          await service.planCreateLayer({
            mapPath: MAP_PATH,
            layerType: "imagelayer",
            name: "Reference",
            imagePath: IMAGE_PATH,
            expectedMapRevision: created.revision,
            expectedDependencyRevisions: {},
          });
        await service.applyEdits(plan);

        const summary =
          (await service.getSummary(
            MAP_PATH,
          )) as { layers: LayerSummary[] };
        const layer = summary.layers.find(
          (candidate) =>
            candidate.type === "imagelayer",
        );
        expect(layer).toBeDefined();
        expect(layer!.name).toBe("Reference");
        expect(layer!.image?.path).toBe(
          IMAGE_PATH,
        );
      },
    );
  });

  /**
   * The native preview cannot draw image layers. That is a documented limit,
   * not a defect -- but it must stay *reported*, because a render that
   * silently omitted the reference would look like an empty map rather than an
   * incomplete one.
   */
  it("reports the image layer as omitted from a native preview", async () => {
    await withProject(
      {
        files: {
          [IMAGE_PATH]: await readFile(
            join(FIXTURE_DIR, "tiles.png"),
          ),
        },
        prefix: "tiledmcp-imagelayer",
      },
      async (harness) => {
        const service =
          harness.service as unknown as Service;
        await service.createMap({
          mapPath: MAP_PATH,
          width: 8,
          height: 6,
          tileWidth: 64,
          tileHeight: 32,
        });
        const created =
          (await service.getSummary(
            MAP_PATH,
          )) as { revision: string };
        await service.applyEdits(
          await service.planCreateLayer({
            mapPath: MAP_PATH,
            layerType: "imagelayer",
            name: "Reference",
            imagePath: IMAGE_PATH,
            expectedMapRevision: created.revision,
            expectedDependencyRevisions: {},
          }),
        );

        const rendered =
          (await service.renderPreview({
            mapPath: MAP_PATH,
          })) as {
            result: {
              partial: boolean;
              layerIds: number[];
              omittedLayers: Array<{
                type: string;
                reason: string;
              }>;
            };
          };
        expect(rendered.result.partial).toBe(true);
        expect(rendered.result.layerIds).toEqual(
          [],
        );
        expect(
          rendered.result.omittedLayers,
        ).toEqual([
          expect.objectContaining({
            type: "imagelayer",
            reason: "unsupported-layer-type",
          }),
        ]);
      },
    );
  });
});
