import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  generateMcpContractArtifacts,
  MCP_CONTRACT_RELATIVE_PATH,
  MCP_REFERENCE_RELATIVE_PATH,
  type GeneratedMcpContractArtifacts,
} from "../scripts/generate-mcp-contract.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ANNOTATION_KEYS = [
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
  "readOnlyHint",
  "title",
] as const;
const BOOLEAN_ANNOTATION_KEYS = [
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
  "readOnlyHint",
] as const;

describe("generated MCP contract", () => {
  let generated: GeneratedMcpContractArtifacts;
  let generatedAgain: GeneratedMcpContractArtifacts;
  let committedContract: Buffer;
  let committedReference: Buffer;
  let contract: Record<string, unknown>;

  beforeAll(async () => {
    [generated, generatedAgain] = [
      await generateMcpContractArtifacts(),
      await generateMcpContractArtifacts(),
    ];
    [committedContract, committedReference] =
      await Promise.all([
        readFile(
          resolve(
            REPOSITORY_ROOT,
            MCP_CONTRACT_RELATIVE_PATH,
          ),
        ),
        readFile(
          resolve(
            REPOSITORY_ROOT,
            MCP_REFERENCE_RELATIVE_PATH,
          ),
        ),
      ]);
    contract = asRecord(
      JSON.parse(generated.contractJson) as unknown,
      "contract",
    );
  }, 20_000);

  it("matches the committed artifacts and is deterministic", () => {
    expect(
      Buffer.from(generated.contractJson, "utf8"),
    ).toEqual(committedContract);
    expect(
      Buffer.from(generated.referenceMarkdown, "utf8"),
    ).toEqual(committedReference);
    expect(generatedAgain).toEqual(generated);
  });

  it("describes the exact core and rasterizer tool surfaces", () => {
    expect(contract.format).toBe(
      "tiled-mcp-discovery-contract",
    );
    expect(contract.formatVersion).toBe(1);

    const profiles = asRecord(
      contract.profiles,
      "contract.profiles",
    );
    const coreTools = asStringArray(
      asRecord(
        profiles.core,
        "contract.profiles.core",
      ).toolOrder,
      "contract.profiles.core.toolOrder",
    );
    const fullTools = asStringArray(
      asRecord(
        profiles["with-tmxrasterizer"],
        "contract.profiles.with-tmxrasterizer",
      ).toolOrder,
      "contract.profiles.with-tmxrasterizer.toolOrder",
    );

    expect(coreTools).toHaveLength(18);
    expect(fullTools).toHaveLength(19);
    expect(new Set(coreTools).size).toBe(18);
    expect(new Set(fullTools).size).toBe(19);
    expect(
      fullTools.filter(
        (name) => !new Set(coreTools).has(name),
      ),
    ).toEqual(["tiled_render_map"]);
    expect(
      coreTools.filter(
        (name) => !new Set(fullTools).has(name),
      ),
    ).toEqual([]);

    const toolDefinitions = asRecordArray(
      contract.toolDefinitions,
      "contract.toolDefinitions",
    );
    const toolNames = toolDefinitions.map((tool, index) =>
      asString(
        tool.name,
        `contract.toolDefinitions[${index}].name`,
      ),
    );

    expect(toolDefinitions).toHaveLength(19);
    expect(new Set(toolNames).size).toBe(19);
    expect([...toolNames].sort()).toEqual(
      [...fullTools].sort(),
    );

    for (const [index, tool] of toolDefinitions.entries()) {
      const label = `contract.toolDefinitions[${index}]`;
      expectClosedRootObjectSchema(
        tool.inputSchema,
        `${label}.inputSchema`,
      );
      expectClosedRootObjectSchema(
        tool.outputSchema,
        `${label}.outputSchema`,
      );

      const annotations = asRecord(
        tool.annotations,
        `${label}.annotations`,
      );
      expect(Object.keys(annotations).sort()).toEqual(
        [...ANNOTATION_KEYS].sort(),
      );
      expect(
        asString(
          annotations.title,
          `${label}.annotations.title`,
        ).length,
      ).toBeGreaterThan(0);
      for (const key of BOOLEAN_ANNOTATION_KEYS) {
        expect(
          typeof annotations[key],
          `${label}.annotations.${key}`,
        ).toBe("boolean");
      }
    }
  });

  it("publishes only the guide resource without environment leaks", () => {
    const resources = asRecordArray(
      contract.resourceDefinitions,
      "contract.resourceDefinitions",
    );
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      uri: "tiled://guide",
      name: "guide",
      mimeType: "text/markdown",
    });

    const contentContracts = asRecordArray(
      contract.resourceContentContracts,
      "contract.resourceContentContracts",
    );
    expect(contentContracts).toHaveLength(1);
    expect(contentContracts[0]).toMatchObject({
      uri: "tiled://guide",
      mimeType: "text/markdown",
      contentKind: "text",
    });
    expect(contract.resourceTemplateDefinitions).toEqual(
      [],
    );
    expect(contract.prompts).toEqual([]);

    const profiles = asRecord(
      contract.profiles,
      "contract.profiles",
    );
    for (const profileName of [
      "core",
      "with-tmxrasterizer",
    ]) {
      const profile = asRecord(
        profiles[profileName],
        `contract.profiles.${profileName}`,
      );
      expect(profile.resourceOrder).toEqual([
        "tiled://guide",
      ]);
      expect(profile.resourceTemplateOrder).toEqual([]);
    }

    const artifacts =
      generated.contractJson +
      generated.referenceMarkdown;
    for (const forbidden of [
      REPOSITORY_ROOT,
      process.cwd(),
      "contract-tiled",
      "contract-tmxrasterizer",
    ]) {
      expect(artifacts).not.toContain(forbidden);
    }
  });
});

function expectClosedRootObjectSchema(
  value: unknown,
  label: string,
): void {
  const schema = asRecord(value, label);
  expect(schema.type, `${label}.type`).toBe("object");
  expect(
    schema.additionalProperties,
    `${label}.additionalProperties`,
  ).toBe(false);
  expectClosedSchemaTree(schema, label);
}

function expectClosedSchemaTree(
  schema: Record<string, unknown>,
  label: string,
): void {
  const visited = new Set<object>();

  const visit = (value: unknown, path: string): void => {
    expect(value, `${path} must not use a true schema`).not.toBe(
      true,
    );
    if (value === false) {
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) {
        visit(child, `${path}[${index}]`);
      }
      return;
    }
    const node = asRecord(value, path);
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    expect(
      Object.keys(node).length,
      `${path} must constrain its value`,
    ).toBeGreaterThan(0);

    const declaredTypes = Array.isArray(node.type)
      ? node.type
      : [node.type];
    const objectKeywords = [
      "additionalProperties",
      "dependencies",
      "dependentRequired",
      "dependentSchemas",
      "maxProperties",
      "minProperties",
      "patternProperties",
      "properties",
      "propertyNames",
      "required",
      "unevaluatedProperties",
    ];
    if (
      declaredTypes.includes("object") ||
      objectKeywords.some((key) => key in node)
    ) {
      expect(
        "additionalProperties" in node,
        `${path} must close or constrain additional properties`,
      ).toBe(true);
      expect(
        node.additionalProperties,
        `${path}.additionalProperties`,
      ).not.toBe(true);
    }

    for (const key of [
      "additionalProperties",
      "additionalItems",
      "unevaluatedProperties",
      "unevaluatedItems",
      "propertyNames",
      "items",
      "contains",
      "not",
      "if",
      "then",
      "else",
      "contentSchema",
    ]) {
      const child = node[key];
      if (child !== undefined && child !== false) {
        visit(child, `${path}.${key}`);
      }
    }

    for (const key of [
      "allOf",
      "anyOf",
      "oneOf",
      "prefixItems",
    ]) {
      const children = node[key];
      if (children === undefined) {
        continue;
      }
      expect(Array.isArray(children), `${path}.${key}`).toBe(
        true,
      );
      for (const [index, child] of (
        children as unknown[]
      ).entries()) {
        visit(child, `${path}.${key}[${index}]`);
      }
    }

    for (const key of [
      "properties",
      "patternProperties",
      "dependentSchemas",
      "$defs",
      "definitions",
    ]) {
      const children = node[key];
      if (children === undefined) {
        continue;
      }
      for (const [name, child] of Object.entries(
        asRecord(children, `${path}.${key}`),
      )) {
        visit(child, `${path}.${key}.${name}`);
      }
    }

    const dependencies = node.dependencies;
    if (dependencies !== undefined) {
      for (const [name, child] of Object.entries(
        asRecord(
          dependencies,
          `${path}.dependencies`,
        ),
      )) {
        if (!Array.isArray(child)) {
          visit(
            child,
            `${path}.dependencies.${name}`,
          );
        }
      }
    }
  };

  visit(schema, label);
}

function asRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  expect(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value),
    `${label} must be an object`,
  ).toBe(true);
  return value as Record<string, unknown>;
}

function asRecordArray(
  value: unknown,
  label: string,
): Record<string, unknown>[] {
  expect(Array.isArray(value), `${label} must be an array`).toBe(
    true,
  );
  return (value as unknown[]).map((item, index) =>
    asRecord(item, `${label}[${index}]`),
  );
}

function asStringArray(
  value: unknown,
  label: string,
): string[] {
  expect(Array.isArray(value), `${label} must be an array`).toBe(
    true,
  );
  return (value as unknown[]).map((item, index) =>
    asString(item, `${label}[${index}]`),
  );
}

function asString(value: unknown, label: string): string {
  expect(typeof value, `${label} must be a string`).toBe(
    "string",
  );
  return value as string;
}
