import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

import {
  TiledCliAdapter,
  type TiledCliCapabilities,
} from "../src/adapters/tiledCli.js";
import { parseJsonDocument } from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  TILED_MCP_CORE_TOOL_NAMES,
  TILED_MCP_OPTIONAL_TOOL_NAMES,
  TILED_MCP_PROTOCOL_BASELINE,
  createTiledMcpServerFromCapabilitySnapshot,
} from "../src/server.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const FIXTURE_ROOT = resolve(REPOSITORY_ROOT, "fixtures/mvp");
const EXAMPLES_RELATIVE_PATH =
  "examples/mcp-calls.v1.json";

export const MCP_CONTRACT_RELATIVE_PATH =
  "contracts/mcp-contract.v1.json";
export const MCP_REFERENCE_RELATIVE_PATH =
  "docs/generated/mcp-reference.md";

type ProfileId = "core" | "with-tmxrasterizer";
type ListedTool = Awaited<
  ReturnType<Client["listTools"]>
>["tools"][number];
type ListedResource = Awaited<
  ReturnType<Client["listResources"]>
>["resources"][number];
type ListedResourceTemplate = Awaited<
  ReturnType<Client["listResourceTemplates"]>
>["resourceTemplates"][number];

interface CallExample {
  name: string;
  profile: ProfileId;
  arguments: Record<string, unknown>;
  purpose: string;
}

interface CallExampleDocument {
  format: "tiled-mcp-call-examples";
  formatVersion: 1;
  examples: CallExample[];
}

interface ResourceContentContract {
  uri: string;
  mimeType: string | null;
  contentKind: "text";
  byteLength: number;
  sha256: string;
  _meta: Record<string, unknown> | null;
}

interface ProfileSnapshot {
  id: ProfileId;
  serverInfo: Record<string, unknown>;
  serverCapabilities: Record<string, unknown>;
  serverInstructions: string | null;
  tools: ListedTool[];
  resources: ListedResource[];
  resourceTemplates: ListedResourceTemplate[];
  resourceContents: ResourceContentContract[];
  registeredTools: string[];
}

export interface GeneratedMcpContractArtifacts {
  contractJson: string;
  referenceMarkdown: string;
}

export async function generateMcpContractArtifacts(): Promise<GeneratedMcpContractArtifacts> {
  if (
    TILED_MCP_PROTOCOL_BASELINE !==
    LATEST_PROTOCOL_VERSION
  ) {
    throw new Error(
      `Declared protocol baseline ${TILED_MCP_PROTOCOL_BASELINE} does not match the pinned SDK negotiation version ${LATEST_PROTOCOL_VERSION}.`,
    );
  }
  const examples = await readExamples();
  const [core, withRasterizer] = await Promise.all([
    collectProfile("core"),
    collectProfile("with-tmxrasterizer"),
  ]);
  assertProfileInvariants(core, withRasterizer);
  validateExamples(examples, core, withRasterizer);

  const toolDefinitions = [...withRasterizer.tools].sort(
    (left, right) => compareText(left.name, right.name),
  );
  const resourceDefinitions = [...withRasterizer.resources].sort(
    (left, right) => compareText(left.uri, right.uri),
  );
  const resourceTemplateDefinitions = [
    ...withRasterizer.resourceTemplates,
  ].sort(
    (left, right) =>
      compareText(left.uriTemplate, right.uriTemplate) ||
      compareText(left.name, right.name),
  );
  const toolAvailability = Object.fromEntries([
    ...TILED_MCP_CORE_TOOL_NAMES.map(
      (name) => [name, "core"] as const,
    ),
    ...TILED_MCP_OPTIONAL_TOOL_NAMES.map(
      (name) =>
        [
          name,
          "tmxrasterizer-version-probe",
        ] as const,
    ),
  ]);
  const contract = {
    format: "tiled-mcp-discovery-contract",
    formatVersion: 1,
    protocolBaseline: TILED_MCP_PROTOCOL_BASELINE,
    serverInfo: core.serverInfo,
    serverCapabilities: core.serverCapabilities,
    serverInstructions: core.serverInstructions,
    profiles: {
      core: profileDescriptor(core),
      "with-tmxrasterizer":
        profileDescriptor(withRasterizer),
    },
    toolAvailability,
    toolDefinitions,
    resourceDefinitions,
    resourceTemplateDefinitions,
    resourceContentContracts:
      withRasterizer.resourceContents,
    prompts: [],
    examples: {
      path: EXAMPLES_RELATIVE_PATH,
      count: examples.examples.length,
    },
  };
  const contractJson = stableJson(contract);
  const referenceMarkdown = renderReference(
    contract,
    examples,
  );
  assertNoEnvironmentLeak(contractJson);
  assertNoEnvironmentLeak(referenceMarkdown);

  return {
    contractJson,
    referenceMarkdown,
  };
}

async function collectProfile(
  id: ProfileId,
): Promise<ProfileSnapshot> {
  const resolver =
    await ProjectPathResolver.create(FIXTURE_ROOT);
  const store = new DocumentStore(resolver);
  const maps = new MapService(resolver, store);
  const cli = new TiledCliAdapter({
    tiledCliPath: "contract-tiled",
    rasterizerPath: "contract-tmxrasterizer",
  });
  const cliCapabilities = fixedCapabilities(
    id === "with-tmxrasterizer",
  );
  const created =
    createTiledMcpServerFromCapabilitySnapshot(
      { resolver, store, maps, cli },
      cliCapabilities,
    );
  const client = new Client(
    {
      name: "tiled-mcp-contract-client",
      version: "1",
    },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await created.server.connect(serverTransport);
    await client.connect(clientTransport);
    const [
      toolsResponse,
      resourcesResponse,
      templatesResponse,
      guideResponse,
      capabilitiesResponse,
    ] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
      client.readResource({ uri: "tiled://guide" }),
      client.callTool({
        name: "tiled_get_capabilities",
        arguments: {},
      }),
    ]);
    assertNoPagination(
      toolsResponse.nextCursor,
      `${id} tools`,
    );
    assertNoPagination(
      resourcesResponse.nextCursor,
      `${id} resources`,
    );
    assertNoPagination(
      templatesResponse.nextCursor,
      `${id} resource templates`,
    );
    const serverInfo = client.getServerVersion();
    const serverCapabilities =
      client.getServerCapabilities();
    if (
      serverInfo === undefined ||
      serverCapabilities === undefined
    ) {
      throw new Error(
        `Profile ${id} did not complete MCP initialization.`,
      );
    }

    const registeredTools =
      extractRegisteredTools(capabilitiesResponse);
    assertStringArraysEqual(
      registeredTools,
      created.registeredTools,
      `${id} capabilities registeredTools`,
    );

    return wireClone({
      id,
      serverInfo,
      serverCapabilities,
      serverInstructions:
        client.getInstructions() ?? null,
      tools: toolsResponse.tools,
      resources: resourcesResponse.resources,
      resourceTemplates:
        templatesResponse.resourceTemplates,
      resourceContents: [
        describeGuideContent(guideResponse),
      ],
      registeredTools,
    });
  } finally {
    await client.close().catch(() => undefined);
    await created.server.close().catch(() => undefined);
  }
}

function fixedCapabilities(
  rasterizerAvailable: boolean,
): TiledCliCapabilities {
  return {
    tiled: {
      executable: "contract-tiled",
      available: true,
      version: "1.12.2",
      mapExportFormats: ["json", "tmx"],
      tilesetExportFormats: ["json", "tsx"],
      issues: [],
    },
    rasterizer: {
      executable: "contract-tmxrasterizer",
      available: rasterizerAvailable,
      version: rasterizerAvailable ? "1.0" : null,
      issues: [],
    },
  };
}

function describeGuideContent(
  response: Awaited<
    ReturnType<Client["readResource"]>
  >,
): ResourceContentContract {
  if (response.contents.length !== 1) {
    throw new Error(
      `Expected one tiled://guide content block; received ${response.contents.length}.`,
    );
  }
  const content = response.contents[0];
  if (
    content === undefined ||
    !("text" in content) ||
    typeof content.text !== "string"
  ) {
    throw new Error(
      "Expected tiled://guide to return one text content block.",
    );
  }
  const source = Buffer.from(content.text, "utf8");
  const descriptor: ResourceContentContract = {
    uri: content.uri,
    mimeType: content.mimeType ?? null,
    contentKind: "text",
    byteLength: source.byteLength,
    sha256: `sha256:${createHash("sha256")
      .update(source)
      .digest("hex")}`,
    _meta:
      content._meta === undefined
        ? null
        : wireClone(content._meta),
  };
  if (
    descriptor._meta !== null &&
    (descriptor._meta.revision !==
      descriptor.sha256 ||
      descriptor._meta.size !==
        descriptor.byteLength)
  ) {
    throw new Error(
      "tiled://guide metadata does not match its UTF-8 content.",
    );
  }
  return descriptor;
}

function extractRegisteredTools(
  response: Awaited<
    ReturnType<Client["callTool"]>
  >,
): string[] {
  if (response.isError === true) {
    throw new Error(
      "tiled_get_capabilities failed while generating the MCP contract.",
    );
  }
  const structuredContent =
    response.structuredContent;
  if (!isRecord(structuredContent)) {
    throw new Error(
      "tiled_get_capabilities omitted structuredContent.",
    );
  }
  const result = structuredContent.result;
  if (
    !isRecord(result) ||
    !Array.isArray(result.registeredTools) ||
    !result.registeredTools.every(
      (value) => typeof value === "string",
    )
  ) {
    throw new Error(
      "tiled_get_capabilities returned an invalid registeredTools value.",
    );
  }
  return [...result.registeredTools];
}

function assertProfileInvariants(
  core: ProfileSnapshot,
  withRasterizer: ProfileSnapshot,
): void {
  const expectedCore = [...TILED_MCP_CORE_TOOL_NAMES];
  const expectedFull = [
    ...expectedCore,
    ...TILED_MCP_OPTIONAL_TOOL_NAMES,
  ];
  assertStringArraysEqual(
    core.registeredTools,
    expectedCore,
    "core tool order",
  );
  assertStringArraysEqual(
    withRasterizer.registeredTools,
    expectedFull,
    "with-tmxrasterizer tool order",
  );
  assertStringArraysEqual(
    core.tools.map(({ name }) => name),
    expectedCore,
    "core tools/list order",
  );
  assertStringArraysEqual(
    withRasterizer.tools.map(({ name }) => name),
    expectedFull,
    "with-tmxrasterizer tools/list order",
  );
  assertUnique(
    withRasterizer.tools.map(({ name }) => name),
    "tool names",
  );
  assertUnique(
    withRasterizer.resources.map(({ uri }) => uri),
    "resource URIs",
  );

  assertStableEqual(
    core.serverInfo,
    withRasterizer.serverInfo,
    "server info",
  );
  assertStableEqual(
    core.serverCapabilities,
    withRasterizer.serverCapabilities,
    "server capabilities",
  );
  assertStableEqual(
    core.serverInstructions,
    withRasterizer.serverInstructions,
    "server instructions",
  );
  assertStableEqual(
    core.resources,
    withRasterizer.resources,
    "resource definitions",
  );
  assertStableEqual(
    core.resourceTemplates,
    withRasterizer.resourceTemplates,
    "resource template definitions",
  );
  assertStableEqual(
    core.resourceContents,
    withRasterizer.resourceContents,
    "resource content contracts",
  );

  if (
    core.resources.length !== 1 ||
    core.resources[0]?.uri !==
      "tiled://guide" ||
    core.resourceTemplates.length !== 0
  ) {
    throw new Error(
      "Expected one tiled://guide resource and no resource templates.",
    );
  }
  if ("prompts" in core.serverCapabilities) {
    throw new Error(
      "Prompt discovery is now advertised; extend the generated MCP contract before proceeding.",
    );
  }

  const fullByName = new Map(
    withRasterizer.tools.map(
      (tool) => [tool.name, tool] as const,
    ),
  );
  for (const tool of core.tools) {
    assertStableEqual(
      tool,
      fullByName.get(tool.name),
      `shared tool ${tool.name}`,
    );
  }
  for (const tool of withRasterizer.tools) {
    assertToolDefinition(tool);
  }
}

function assertToolDefinition(tool: ListedTool): void {
  if (
    tool.inputSchema.type !== "object" ||
    tool.inputSchema.additionalProperties !== false
  ) {
    throw new Error(
      `${tool.name} must expose a closed object input schema.`,
    );
  }
  if (
    tool.outputSchema === undefined ||
    tool.outputSchema.type !== "object" ||
    tool.outputSchema.additionalProperties !== false
  ) {
    throw new Error(
      `${tool.name} must expose a closed object output schema.`,
    );
  }
  const annotations = tool.annotations;
  if (
    annotations === undefined ||
    typeof annotations.title !== "string" ||
    annotations.title.length === 0 ||
    typeof annotations.readOnlyHint !== "boolean" ||
    typeof annotations.destructiveHint !== "boolean" ||
    typeof annotations.idempotentHint !== "boolean" ||
    typeof annotations.openWorldHint !== "boolean"
  ) {
    throw new Error(
      `${tool.name} must expose a title and all four boolean annotation hints.`,
    );
  }
}

async function readExamples(): Promise<CallExampleDocument> {
  const examplesPath = resolve(
    REPOSITORY_ROOT,
    EXAMPLES_RELATIVE_PATH,
  );
  const parsed: unknown = parseJsonDocument(
    await readFile(examplesPath, "utf8"),
    EXAMPLES_RELATIVE_PATH,
  );
  if (
    !isRecord(parsed) ||
    parsed.format !==
      "tiled-mcp-call-examples" ||
    parsed.formatVersion !== 1 ||
    !Array.isArray(parsed.examples)
  ) {
    throw new Error(
      `${EXAMPLES_RELATIVE_PATH} has an invalid document envelope.`,
    );
  }
  assertExactKeys(
    parsed,
    ["examples", "format", "formatVersion"],
    `${EXAMPLES_RELATIVE_PATH} document`,
  );
  const examples = parsed.examples.map(
    (value, index): CallExample => {
      if (
        !isRecord(value) ||
        typeof value.name !== "string" ||
        (value.profile !== "core" &&
          value.profile !==
            "with-tmxrasterizer") ||
        !isRecord(value.arguments) ||
        typeof value.purpose !== "string" ||
        value.purpose.length === 0
      ) {
        throw new Error(
          `${EXAMPLES_RELATIVE_PATH} example ${index} is invalid.`,
        );
      }
      assertExactKeys(
        value,
        [
          "arguments",
          "name",
          "profile",
          "purpose",
        ],
        `${EXAMPLES_RELATIVE_PATH} example ${index}`,
      );
      return {
        name: value.name,
        profile: value.profile,
        arguments: value.arguments,
        purpose: value.purpose,
      };
    },
  );
  return {
    format: "tiled-mcp-call-examples",
    formatVersion: 1,
    examples,
  };
}

function validateExamples(
  document: CallExampleDocument,
  core: ProfileSnapshot,
  withRasterizer: ProfileSnapshot,
): void {
  const allTools = new Map(
    withRasterizer.tools.map(
      (tool) => [tool.name, tool] as const,
    ),
  );
  const coreNames = new Set(
    core.tools.map(({ name }) => name),
  );
  const seen = new Set<string>();
  for (const example of document.examples) {
    if (seen.has(example.name)) {
      throw new Error(
        `Duplicate MCP call example for ${example.name}.`,
      );
    }
    seen.add(example.name);
    const tool = allTools.get(example.name);
    if (tool === undefined) {
      throw new Error(
        `MCP call example names unknown tool ${example.name}.`,
      );
    }
    if (
      example.profile === "core" &&
      !coreNames.has(example.name)
    ) {
      throw new Error(
        `${example.name} is not available in the core profile.`,
      );
    }
    if (
      example.profile ===
        "with-tmxrasterizer" &&
      coreNames.has(example.name)
    ) {
      throw new Error(
        `${example.name} should use the core profile in the examples manifest.`,
      );
    }
    const validate =
      new AjvJsonSchemaValidator().getValidator(
        tool.inputSchema as JsonSchemaType,
      );
    const result = validate(example.arguments);
    if (!result.valid) {
      throw new Error(
        `Invalid MCP call example for ${example.name}: ${result.errorMessage}`,
      );
    }
  }
  const missing = [...allTools.keys()].filter(
    (name) => !seen.has(name),
  );
  if (
    missing.length !== 0 ||
    seen.size !== allTools.size
  ) {
    throw new Error(
      `MCP call examples must cover every tool exactly once; missing: ${missing.join(
        ", ",
      )}.`,
    );
  }
}

function profileDescriptor(
  snapshot: ProfileSnapshot,
): Record<string, unknown> {
  return {
    toolOrder: snapshot.tools.map(
      ({ name }) => name,
    ),
    resourceOrder: snapshot.resources.map(
      ({ uri }) => uri,
    ),
    resourceTemplateOrder:
      snapshot.resourceTemplates.map(
        ({ uriTemplate }) => uriTemplate,
      ),
  };
}

function renderReference(
  contract: {
    protocolBaseline: string;
    serverInfo: Record<string, unknown>;
    serverInstructions: string | null;
    profiles: Record<
      ProfileId,
      Record<string, unknown>
    >;
    toolAvailability: Record<string, string>;
    toolDefinitions: ListedTool[];
    resourceDefinitions: ListedResource[];
    resourceTemplateDefinitions: ListedResourceTemplate[];
    resourceContentContracts: ResourceContentContract[];
  },
  examples: CallExampleDocument,
): string {
  const serverName =
    stringProperty(contract.serverInfo, "name");
  const serverVersion =
    stringProperty(contract.serverInfo, "version");
  const exampleByName = new Map(
    examples.examples.map(
      (example) => [example.name, example] as const,
    ),
  );
  const lines = [
    "<!-- Generated by scripts/generate-mcp-contract.ts. Do not edit by hand. -->",
    "",
    "# TiledMCP generated MCP reference",
    "",
    `Server: \`${serverName}\` \`${serverVersion}\``,
    "",
    `Protocol baseline: \`${contract.protocolBaseline}\``,
    "",
    contract.serverInstructions === null
      ? "Server instructions: none."
      : `Server instructions: ${contract.serverInstructions}`,
    "",
    "The machine-readable source of truth is `contracts/mcp-contract.v1.json`. Regenerate both files with `pnpm contract:generate`.",
    "",
    "Schema-valid calls below use fixed placeholders and must never be sent as-is. Replace opaque IDs and required revision pins with current trusted tool results; omit optional preconditions when no trusted prior value exists.",
    "",
    "## Surface profiles",
    "",
    `- \`core\`: ${arrayProperty(contract.profiles.core, "toolOrder").length} tools`,
    `- \`with-tmxrasterizer\`: ${arrayProperty(contract.profiles["with-tmxrasterizer"], "toolOrder").length} tools; adds \`tiled_render_map\` only after a successful TmxRasterizer version probe`,
    "",
    "## Resources",
    "",
  ];
  for (const resource of contract.resourceDefinitions) {
    lines.push(
      `### \`${resource.uri}\``,
      "",
      resource.description ?? "",
      "",
      "```json",
      stableJson(resource).trimEnd(),
      "```",
      "",
    );
  }
  for (const content of contract.resourceContentContracts) {
    lines.push(
      `Content contract: \`${content.contentKind}\`, ${content.byteLength} UTF-8 bytes, revision \`${content.sha256}\`.`,
      "",
    );
  }
  if (
    contract.resourceTemplateDefinitions.length === 0
  ) {
    lines.push(
      "Resource templates: none.",
      "",
    );
  }
  lines.push(
    "Prompts: none.",
    "",
    "## Tools",
    "",
  );
  for (const tool of contract.toolDefinitions) {
    const example = exampleByName.get(tool.name);
    if (example === undefined) {
      throw new Error(
        `Missing reference example for ${tool.name}.`,
      );
    }
    const availability =
      contract.toolAvailability[tool.name];
    if (availability === undefined) {
      throw new Error(
        `Missing availability for ${tool.name}.`,
      );
    }
    lines.push(
      `### \`${tool.name}\``,
      "",
      `Availability: \`${availability}\``,
      "",
      tool.description ?? "",
      "",
      "Annotations:",
      "",
      "```json",
      stableJson(tool.annotations).trimEnd(),
      "```",
      "",
      `Example purpose: ${example.purpose}`,
      "",
      "```json",
      stableJson({
        name: example.name,
        arguments: example.arguments,
      }).trimEnd(),
      "```",
      "",
      "Input schema:",
      "",
      "```json",
      stableJson(tool.inputSchema).trimEnd(),
      "```",
      "",
      "Output schema:",
      "",
      "```json",
      stableJson(tool.outputSchema).trimEnd(),
      "```",
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(
    canonicalize(wireClone(value)),
    null,
    2,
  )}\n`;
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareText)) {
      output[key] = canonicalize(value[key]);
    }
    return output;
  }
  throw new Error(
    `Contract contains a non-JSON value of type ${typeof value}.`,
  );
}

function wireClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertNoEnvironmentLeak(
  artifact: string,
): void {
  const forbidden = [
    REPOSITORY_ROOT,
    FIXTURE_ROOT,
    "contract-tiled",
    "contract-tmxrasterizer",
  ];
  for (const value of forbidden) {
    if (artifact.includes(value)) {
      throw new Error(
        `Generated MCP contract leaked environment sentinel ${JSON.stringify(
          value,
        )}.`,
      );
    }
  }
}

function assertStableEqual(
  left: unknown,
  right: unknown,
  label: string,
): void {
  if (stableJson(left) !== stableJson(right)) {
    throw new Error(
      `MCP contract profiles disagree on ${label}.`,
    );
  }
}

function assertStringArraysEqual(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some(
      (value, index) => value !== expected[index],
    )
  ) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(
        expected,
      )}, received ${JSON.stringify(actual)}.`,
    );
  }
}

function assertUnique(
  values: readonly string[],
  label: string,
): void {
  if (new Set(values).size !== values.length) {
    throw new Error(
      `Generated MCP contract has duplicate ${label}.`,
    );
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(compareText);
  const sortedExpected = [...expected].sort(compareText);
  assertStringArraysEqual(
    actual,
    sortedExpected,
    `${label} keys`,
  );
}

function assertNoPagination(
  cursor: string | undefined,
  label: string,
): void {
  if (cursor !== undefined) {
    throw new Error(
      `Contract generator does not yet support paginated ${label}.`,
    );
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function stringProperty(
  value: Record<string, unknown>,
  key: string,
): string {
  const property = value[key];
  if (typeof property !== "string") {
    throw new Error(
      `Expected ${key} to be a string.`,
    );
  }
  return property;
}

function arrayProperty(
  value: Record<string, unknown>,
  key: string,
): unknown[] {
  const property = value[key];
  if (!Array.isArray(property)) {
    throw new Error(
      `Expected ${key} to be an array.`,
    );
  }
  return property;
}

async function writeArtifacts(
  artifacts: GeneratedMcpContractArtifacts,
): Promise<void> {
  const files = [
    {
      relativePath:
        MCP_CONTRACT_RELATIVE_PATH,
      content: artifacts.contractJson,
    },
    {
      relativePath:
        MCP_REFERENCE_RELATIVE_PATH,
      content: artifacts.referenceMarkdown,
    },
  ];
  for (const file of files) {
    const path = resolve(
      REPOSITORY_ROOT,
      file.relativePath,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, "utf8");
    process.stdout.write(
      `wrote ${relative(REPOSITORY_ROOT, path)}\n`,
    );
  }
}

async function checkArtifacts(
  artifacts: GeneratedMcpContractArtifacts,
): Promise<void> {
  const files = [
    {
      relativePath:
        MCP_CONTRACT_RELATIVE_PATH,
      expected: artifacts.contractJson,
    },
    {
      relativePath:
        MCP_REFERENCE_RELATIVE_PATH,
      expected: artifacts.referenceMarkdown,
    },
  ];
  for (const file of files) {
    const path = resolve(
      REPOSITORY_ROOT,
      file.relativePath,
    );
    let actual: Buffer;
    try {
      actual = await readFile(path);
    } catch {
      throw new Error(
        `${file.relativePath} is missing; run pnpm contract:generate.`,
      );
    }
    const expected = Buffer.from(
      file.expected,
      "utf8",
    );
    if (!actual.equals(expected)) {
      throw new Error(
        `${file.relativePath} is stale at ${firstByteDifference(
          actual,
          expected,
        )}; run pnpm contract:generate and review the diff.`,
      );
    }
  }
  process.stdout.write(
    "MCP contract and generated reference are current.\n",
  );
}

function firstByteDifference(
  actual: Buffer,
  expected: Buffer,
): string {
  const limit = Math.min(
    actual.byteLength,
    expected.byteLength,
  );
  let offset = 0;
  while (
    offset < limit &&
    actual[offset] === expected[offset]
  ) {
    offset += 1;
  }
  let line = 1;
  let lastNewline = -1;
  for (let index = 0; index < offset; index += 1) {
    if (expected[index] === 0x0a) {
      line += 1;
      lastNewline = index;
    }
  }
  const column = offset - lastNewline;
  return `byte ${offset} (line ${line}, UTF-8 byte column ${column})`;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "--write" && mode !== "--check") {
    throw new Error(
      "Usage: tsx scripts/generate-mcp-contract.ts --write|--check",
    );
  }
  const artifacts =
    await generateMcpContractArtifacts();
  if (mode === "--write") {
    await writeArtifacts(artifacts);
  } else {
    await checkArtifacts(artifacts);
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  fileURLToPath(import.meta.url) ===
    resolve(invokedPath)
) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : String(error);
    process.stderr.write(
      `MCP contract generation failed: ${message}\n`,
    );
    process.exitCode = 1;
  });
}
