import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChangeSetRegistry } from "../src/changeSets.js";
import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const PROJECT_PATH = "game.tiled-project";

interface Harness {
  root: string;
  service: MapService;
}

describe("project property type definitions", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("lists, upserts, and deletes definitions with Tiled id allocation", async () => {
    const harness = await createHarness(roots);
    const listed =
      await harness.service.listPropertyTypes(
        PROJECT_PATH,
      );
    expect(listed).toMatchObject({
      path: PROJECT_PATH,
      typeCount: 1,
      propertyTypes: [
        expect.objectContaining({
          type: "enum",
          id: 3,
          name: "Biome",
        }),
      ],
    });

    const plan =
      await harness.service.planPropertyTypeEdits(
        {
          projectFilePath: PROJECT_PATH,
          expectedRevision:
            listed.revision as string,
          operations: [
            {
              type: "upsertClass",
              name: "LootTable",
              members: [
                {
                  name: "gold",
                  type: "int",
                  value: 10,
                },
                {
                  name: "biome",
                  type: "string",
                  value: "forest",
                  propertyType: "Biome",
                },
              ],
            },
            {
              type: "upsertEnum",
              name: "Biome",
              storageType: "string",
              values: ["forest", "desert"],
            },
          ],
        },
      );
    expect(plan.summary).toMatchObject({
      upserted: [
        {
          name: "LootTable",
          kind: "class",
          id: 4,
          created: true,
        },
        {
          name: "Biome",
          kind: "enum",
          id: 3,
          created: false,
        },
      ],
      typeCountBefore: 1,
      typeCountAfter: 2,
      wouldChange: true,
    });
    const preview = new ChangeSetRegistry().put(
      plan,
    );
    expect(preview.operations[0]).toMatchObject({
      type: "upsertPropertyType",
      destructive: false,
      typeId: 4,
    });

    await harness.service.applyPropertyTypeEdit(
      plan,
    );
    const document = JSON.parse(
      (
        await readFile(
          join(harness.root, PROJECT_PATH),
        )
      ).toString("utf8"),
    ) as JsonObject;
    expect(
      (document.propertyTypes as JsonObject[]).map(
        (entry) => [entry.name, entry.id],
      ),
    ).toEqual([
      ["Biome", 3],
      ["LootTable", 4],
    ]);
    // Untouched siblings keep their exact members.
    expect(document.automappingRulesFile).toBe("");

    // Deleting a type referenced by another definition fails closed.
    const fresh =
      await harness.service.listPropertyTypes(
        PROJECT_PATH,
      );
    await expect(
      harness.service.planPropertyTypeEdits({
        projectFilePath: PROJECT_PATH,
        expectedRevision:
          fresh.revision as string,
        operations: [
          { type: "deleteType", name: "Biome" },
        ],
      }),
    ).rejects.toMatchObject({
      code: "FILE_IN_USE",
      details: expect.objectContaining({
        referencedBy: "LootTable",
      }),
    });
    const deletion =
      await harness.service.planPropertyTypeEdits(
        {
          projectFilePath: PROJECT_PATH,
          expectedRevision:
            fresh.revision as string,
          operations: [
            {
              type: "deleteType",
              name: "LootTable",
            },
          ],
        },
      );
    expect(
      new ChangeSetRegistry().put(deletion)
        .operations[0],
    ).toMatchObject({
      type: "deletePropertyType",
      destructive: true,
      typeId: 4,
    });
  });

  it("fails closed on invalid operations and stale revisions", async () => {
    const harness = await createHarness(roots);
    const listed =
      await harness.service.listPropertyTypes(
        PROJECT_PATH,
      );
    await expect(
      harness.service.planPropertyTypeEdits({
        projectFilePath: PROJECT_PATH,
        expectedRevision:
          listed.revision as string,
        operations: [
          { type: "deleteType", name: "Nope" },
        ],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      harness.service.planPropertyTypeEdits({
        projectFilePath: PROJECT_PATH,
        expectedRevision: `sha256:${"0".repeat(64)}`,
        operations: [
          {
            type: "upsertEnum",
            name: "X",
            storageType: "string",
            values: ["a"],
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    await expect(
      harness.service.listPropertyTypes(
        "maps/level.tmj",
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
  });
});

async function createHarness(
  roots: Set<string>,
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-property-types-"),
  );
  roots.add(root);
  await writeFile(
    join(root, PROJECT_PATH),
    serializeJsonDocument({
      automappingRulesFile: "",
      commands: [],
      extensionsPath: "extensions",
      folders: ["."],
      propertyTypes: [
        {
          type: "enum",
          id: 3,
          name: "Biome",
          storageType: "string",
          values: ["forest"],
          valuesAsFlags: false,
        },
      ],
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
