import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  APPLICATION_ERRORS_RELATIVE_PATH,
  generateMcpContractArtifacts,
  MCP_CONTRACT_RELATIVE_PATH,
  MCP_REFERENCE_RELATIVE_PATH,
  type GeneratedMcpContractArtifacts,
} from "../scripts/generate-mcp-contract.js";
import {
  TILED_MCP_APPLICATION_ERROR_CODES,
  TILED_MCP_APPLICATION_ERROR_REGISTRY,
  TILED_MCP_CAPABILITY_ISSUE_CODES,
} from "../src/errorRegistry.js";
import {
  TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT,
} from "../src/filesystemThreatModelContract.js";
import {
  APPLICATION_ERROR_RESOURCE_META,
  APPLICATION_ERROR_RESOURCE_MIME_TYPE,
  APPLICATION_ERROR_RESOURCE_REVISION,
  APPLICATION_ERROR_RESOURCE_SIZE,
  APPLICATION_ERROR_RESOURCE_URI,
} from "../src/resources/applicationErrors.js";

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
  let committedApplicationErrors: Buffer;
  let committedContract: Buffer;
  let committedReference: Buffer;
  let contract: Record<string, unknown>;

  beforeAll(async () => {
    [generated, generatedAgain] = [
      await generateMcpContractArtifacts(),
      await generateMcpContractArtifacts(),
    ];
    [
      committedApplicationErrors,
      committedContract,
      committedReference,
    ] =
      await Promise.all([
        readFile(
          resolve(
            REPOSITORY_ROOT,
            APPLICATION_ERRORS_RELATIVE_PATH,
          ),
        ),
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
      Buffer.from(
        generated.applicationErrorsJson,
        "utf8",
      ),
    ).toEqual(committedApplicationErrors);
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
      expect(
        countExactEnums(
          tool.outputSchema,
          TILED_MCP_APPLICATION_ERROR_CODES,
        ),
        `${label}.outputSchema application error enum`,
      ).toBe(1);

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

    const capabilitiesIndex =
      toolNames.indexOf("tiled_get_capabilities");
    expect(capabilitiesIndex).toBeGreaterThanOrEqual(0);
    const capabilitiesTool =
      toolDefinitions[capabilitiesIndex];
    if (capabilitiesTool === undefined) {
      throw new Error(
        "Missing tiled_get_capabilities definition",
      );
    }
    const capabilitiesLabel =
      `contract.toolDefinitions[${capabilitiesIndex}]`;
    const capabilitySuccessSchema =
      findCapabilitySuccessSchema(
        capabilitiesTool.outputSchema,
        `${capabilitiesLabel}.outputSchema`,
      );
    const cliSchema = schemaProperty(
      capabilitySuccessSchema,
      "cli",
      `${capabilitiesLabel} capability result`,
    );
    for (const toolKind of [
      "tiled",
      "rasterizer",
    ] as const) {
      const toolSchema = schemaProperty(
        cliSchema,
        toolKind,
        `${capabilitiesLabel} cli`,
      );
      const issuesSchema = schemaProperty(
        toolSchema,
        "issues",
        `${capabilitiesLabel} cli.${toolKind}`,
      );
      const issueSchema = asRecord(
        issuesSchema.items,
        `${capabilitiesLabel} cli.${toolKind}.issues.items`,
      );
      const codeSchema = schemaProperty(
        issueSchema,
        "code",
        `${capabilitiesLabel} cli.${toolKind}.issues item`,
      );
      expect(
        asStringArray(
          codeSchema.enum,
          `${capabilitiesLabel} cli.${toolKind}.issues code enum`,
        ),
      ).toEqual(TILED_MCP_CAPABILITY_ISSUE_CODES);
    }
    expect(
      countExactEnums(
        capabilitiesTool.outputSchema,
        TILED_MCP_CAPABILITY_ISSUE_CODES,
      ),
    ).toBe(2);

    const applicationErrorContractSchema =
      schemaProperty(
        capabilitySuccessSchema,
        "applicationErrorContract",
        `${capabilitiesLabel} capability result`,
      );
    expectLiteralObjectSchema(
      applicationErrorContractSchema,
      {
        name:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.name,
        registryVersion:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.registryVersion,
        resourceUri:
          APPLICATION_ERROR_RESOURCE_URI,
        revision:
          APPLICATION_ERROR_RESOURCE_REVISION,
        size: APPLICATION_ERROR_RESOURCE_SIZE,
        wireLocation:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.wireLocation,
        fallbackCode:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.fallbackCode,
        codeSetPolicy:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.compatibility.additions,
        clientUnknownCodePolicy:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.compatibility.clientUnknownCodePolicy,
        messages:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.messages,
        details:
          TILED_MCP_APPLICATION_ERROR_REGISTRY.details,
        sdkInputErrors:
          "excluded-sdk-owned-text-only",
      },
      `${capabilitiesLabel} applicationErrorContract`,
    );
    const filesystemThreatModelSchema =
      schemaProperty(
        capabilitySuccessSchema,
        "filesystemThreatModelContract",
        `${capabilitiesLabel} capability result`,
      );
    expectExactLiteralSchema(
      filesystemThreatModelSchema,
      TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT,
      `${capabilitiesLabel} filesystemThreatModelContract`,
    );
    const safetyStatusSchema = schemaProperty(
      capabilitySuccessSchema,
      "safetyStatus",
      `${capabilitiesLabel} capability result`,
    );
    expect(
      Object.keys(
        asRecord(
          safetyStatusSchema.properties,
          `${capabilitiesLabel} safetyStatus.properties`,
        ),
      ),
    ).toEqual([
      "jsonLexicalPreservation",
    ]);
  });

  it("publishes exact direct resources and application error metadata without environment leaks", () => {
    expect(
      JSON.parse(
        generated.applicationErrorsJson,
      ),
    ).toEqual(
      TILED_MCP_APPLICATION_ERROR_REGISTRY,
    );
    const applicationErrorBytes = Buffer.from(
      generated.applicationErrorsJson,
      "utf8",
    );
    const applicationErrorRevision =
      `sha256:${createHash("sha256")
        .update(applicationErrorBytes)
        .digest("hex")}`;
    expect(applicationErrorBytes.byteLength).toBe(
      APPLICATION_ERROR_RESOURCE_SIZE,
    );
    expect(applicationErrorRevision).toBe(
      APPLICATION_ERROR_RESOURCE_REVISION,
    );
    expect(contract.applicationErrorRegistry).toEqual({
      path: APPLICATION_ERRORS_RELATIVE_PATH,
      resourceUri:
        APPLICATION_ERROR_RESOURCE_URI,
      registryVersion: 1,
      revision:
        APPLICATION_ERROR_RESOURCE_REVISION,
      size: APPLICATION_ERROR_RESOURCE_SIZE,
    });
    const resources = asRecordArray(
      contract.resourceDefinitions,
      "contract.resourceDefinitions",
    );
    expect(resources).toHaveLength(2);
    expect(
      resources.map(({ uri }) => uri),
    ).toEqual([
      APPLICATION_ERROR_RESOURCE_URI,
      "tiled://guide",
    ]);
    expect(resources[0]).toMatchObject({
      uri: APPLICATION_ERROR_RESOURCE_URI,
      name: "application-errors",
      mimeType:
        APPLICATION_ERROR_RESOURCE_MIME_TYPE,
      size: APPLICATION_ERROR_RESOURCE_SIZE,
      _meta: APPLICATION_ERROR_RESOURCE_META,
    });
    expect(resources[1]).toMatchObject({
      uri: "tiled://guide",
      name: "guide",
      mimeType: "text/markdown",
    });

    const contentContracts = asRecordArray(
      contract.resourceContentContracts,
      "contract.resourceContentContracts",
    );
    expect(contentContracts).toHaveLength(2);
    expect(contentContracts[0]).toEqual({
      uri: APPLICATION_ERROR_RESOURCE_URI,
      mimeType:
        APPLICATION_ERROR_RESOURCE_MIME_TYPE,
      contentKind: "text",
      byteLength:
        APPLICATION_ERROR_RESOURCE_SIZE,
      sha256:
        APPLICATION_ERROR_RESOURCE_REVISION,
      _meta: APPLICATION_ERROR_RESOURCE_META,
    });
    expect(contentContracts[1]).toEqual(
      expect.objectContaining({
        uri: "tiled://guide",
        mimeType: "text/markdown",
        contentKind: "text",
        _meta: expect.objectContaining({
          revision: expect.stringMatching(
            /^sha256:[0-9a-f]{64}$/u,
          ),
          size: expect.any(Number),
        }),
      }),
    );
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
        APPLICATION_ERROR_RESOURCE_URI,
      ]);
      expect(profile.resourceTemplateOrder).toEqual([]);
    }

    const artifacts =
      generated.applicationErrorsJson +
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

function countExactEnums(
  value: unknown,
  expected: readonly string[],
): number {
  if (Array.isArray(value)) {
    return value.reduce(
      (count, child) =>
        count +
        countExactEnums(child, expected),
      0,
    );
  }
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return 0;
  }
  const record = value as Record<
    string,
    unknown
  >;
  const ownMatch =
    Array.isArray(record.enum) &&
    record.enum.length === expected.length &&
    record.enum.every(
      (item, index) =>
        item === expected[index],
    )
      ? 1
      : 0;
  return Object.values(record).reduce<number>(
    (count, child) =>
      count +
      countExactEnums(child, expected),
    ownMatch,
  );
}

function findCapabilitySuccessSchema(
  outputSchema: unknown,
  label: string,
): Record<string, unknown> {
  const output = asRecord(outputSchema, label);
  const resultSchema = schemaProperty(
    output,
    "result",
    label,
  );
  const branches = asRecordArray(
    resultSchema.anyOf,
    `${label}.properties.result.anyOf`,
  );
  const matches = branches.filter((branch) => {
    const properties = branch.properties;
    return (
      properties !== null &&
      typeof properties === "object" &&
      !Array.isArray(properties) &&
      "cli" in properties
    );
  });
  expect(
    matches,
    `${label} capability-success branches`,
  ).toHaveLength(1);
  const match = matches[0];
  if (match === undefined) {
    throw new Error(
      `${label} is missing its capability-success branch`,
    );
  }
  return match;
}

function schemaProperty(
  schema: Record<string, unknown>,
  propertyName: string,
  label: string,
): Record<string, unknown> {
  const properties = asRecord(
    schema.properties,
    `${label}.properties`,
  );
  return asRecord(
    properties[propertyName],
    `${label}.properties.${propertyName}`,
  );
}

function expectLiteralObjectSchema(
  schema: Record<string, unknown>,
  expected: Record<
    string,
    string | number | boolean | null
  >,
  label: string,
): void {
  expect(schema.type, `${label}.type`).toBe("object");
  expect(
    schema.additionalProperties,
    `${label}.additionalProperties`,
  ).toBe(false);
  const expectedKeys = Object.keys(expected).sort();
  const properties = asRecord(
    schema.properties,
    `${label}.properties`,
  );
  expect(Object.keys(properties).sort()).toEqual(
    expectedKeys,
  );
  expect(
    asStringArray(
      schema.required,
      `${label}.required`,
    ).sort(),
  ).toEqual(expectedKeys);
  for (const [key, value] of Object.entries(
    expected,
  )) {
    expect(
      asRecord(
        properties[key],
        `${label}.properties.${key}`,
      ).const,
      `${label}.properties.${key}.const`,
    ).toEqual(value);
  }
}

function expectExactLiteralSchema(
  schema: Record<string, unknown>,
  expected: unknown,
  label: string,
): void {
  if (
    expected === null ||
    typeof expected !== "object"
  ) {
    expect(
      schema.const,
      `${label}.const`,
    ).toEqual(expected);
    return;
  }
  if (Array.isArray(expected)) {
    throw new Error(
      `${label} does not support array literals`,
    );
  }

  expect(schema.type, `${label}.type`).toBe(
    "object",
  );
  expect(
    schema.additionalProperties,
    `${label}.additionalProperties`,
  ).toBe(false);
  const properties = asRecord(
    schema.properties,
    `${label}.properties`,
  );
  const expectedEntries = Object.entries(
    expected,
  );
  const expectedKeys = expectedEntries
    .map(([key]) => key)
    .sort();
  expect(
    Object.keys(properties).sort(),
  ).toEqual(expectedKeys);
  expect(
    asStringArray(
      schema.required,
      `${label}.required`,
    ).sort(),
  ).toEqual(expectedKeys);
  for (const [key, value] of expectedEntries) {
    expectExactLiteralSchema(
      asRecord(
        properties[key],
        `${label}.properties.${key}`,
      ),
      value,
      `${label}.${key}`,
    );
  }
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
