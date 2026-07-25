import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  TiledCliAdapter,
  type TiledCliCapabilities,
} from "../src/adapters/tiledCli.js";
import {
  TILED_MCP_APPLICATION_ERROR_CODES,
  TILED_MCP_APPLICATION_ERROR_REGISTRY,
  TILED_MCP_APPLICATION_ERROR_REGISTRY_JSON,
  TILED_MCP_CAPABILITY_ISSUE_CODES,
  TILED_MCP_ERROR_CODES,
  isTiledMcpApplicationErrorCode,
  isTiledMcpCapabilityIssueCode,
  isTiledMcpErrorCode,
  type TiledMcpErrorCode,
} from "../src/errorRegistry.js";
import {
  TiledMcpError,
  asTiledMcpError,
} from "../src/errors.js";
import { MapService } from "../src/maps/mapService.js";
import { applicationErrorResultOutputSchema } from "../src/outputSchemas/common.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  APPLICATION_ERROR_RESOURCE_META,
  APPLICATION_ERROR_RESOURCE_REVISION,
  APPLICATION_ERROR_RESOURCE_SIZE,
} from "../src/resources/applicationErrors.js";
import {
  TILED_MCP_CORE_TOOL_NAMES,
  TILED_MCP_OPTIONAL_TOOL_NAMES,
  createTiledMcpServerFromCapabilitySnapshot,
} from "../src/server.js";
import { DocumentStore } from "../src/storage/documentStore.js";
import { revisionOf } from "../src/storage/revision.js";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

interface Harness {
  root: string;
  maps: MapService;
  client: Client;
  server: McpServer;
  capabilityInput: TiledCliCapabilities;
  cliCapabilities: TiledCliCapabilities;
}

interface ToolResponse {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

describe("stable application error registry", () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    await Promise.all(
      harnesses.splice(0).map(
        async ({ root, client, server }) => {
          await client.close().catch(
            () => undefined,
          );
          await server.close().catch(
            () => undefined,
          );
          await rm(root, {
            recursive: true,
            force: true,
          });
        },
      ),
    );
  });

  it("is sorted, unique, scoped, and self-consistent", () => {
    expect(TILED_MCP_ERROR_CODES).toHaveLength(121);
    expect(
      TILED_MCP_APPLICATION_ERROR_CODES,
    ).toHaveLength(98);
    expect(
      TILED_MCP_CAPABILITY_ISSUE_CODES,
    ).toHaveLength(13);

    for (const codes of [
      TILED_MCP_ERROR_CODES,
      TILED_MCP_APPLICATION_ERROR_CODES,
      TILED_MCP_CAPABILITY_ISSUE_CODES,
    ]) {
      expect([...codes].sort()).toEqual(codes);
      expect(new Set(codes).size).toBe(codes.length);
      for (const code of codes) {
        expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/u);
        expect(code.length).toBeLessThanOrEqual(128);
        expect(isTiledMcpErrorCode(code)).toBe(true);
      }
    }

    expect(
      TILED_MCP_APPLICATION_ERROR_REGISTRY.codes,
    ).toBe(TILED_MCP_APPLICATION_ERROR_CODES);
    expect(
      TILED_MCP_APPLICATION_ERROR_REGISTRY.fallbackCode,
    ).toBe("INTERNAL_ERROR");
    for (const value of [
      TILED_MCP_ERROR_CODES,
      TILED_MCP_APPLICATION_ERROR_CODES,
      TILED_MCP_CAPABILITY_ISSUE_CODES,
      TILED_MCP_APPLICATION_ERROR_REGISTRY,
      TILED_MCP_APPLICATION_ERROR_REGISTRY.compatibility,
      TILED_MCP_APPLICATION_ERROR_REGISTRY.excludedSurfaces,
      APPLICATION_ERROR_RESOURCE_META,
      TILED_MCP_CORE_TOOL_NAMES,
      TILED_MCP_OPTIONAL_TOOL_NAMES,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(
      isTiledMcpApplicationErrorCode(
        "REVISION_CONFLICT",
      ),
    ).toBe(true);
    expect(
      isTiledMcpApplicationErrorCode(
        "ASSET_REGISTRY_CORRUPT",
      ),
    ).toBe(true);
    expect(
      isTiledMcpApplicationErrorCode(
        "ASSET_REGISTRY_LIMIT_EXCEEDED",
      ),
    ).toBe(true);
    expect(
      isTiledMcpApplicationErrorCode(
        "CHANGE_SET_TAMPERED",
      ),
    ).toBe(false);
    expect(
      isTiledMcpCapabilityIssueCode(
        "TILED_CLI_TIMEOUT",
      ),
    ).toBe(true);
    expect(
      isTiledMcpCapabilityIssueCode(
        "REVISION_CONFLICT",
      ),
    ).toBe(false);
    expect(isTiledMcpErrorCode("UNKNOWN")).toBe(false);
  });

  it("keeps the serialized resource and application schema exact", () => {
    const bytes = Buffer.from(
      TILED_MCP_APPLICATION_ERROR_REGISTRY_JSON,
      "utf8",
    );
    expect(bytes.byteLength).toBe(
      APPLICATION_ERROR_RESOURCE_SIZE,
    );
    expect(revisionOf(bytes)).toBe(
      APPLICATION_ERROR_RESOURCE_REVISION,
    );
    expect(
      JSON.parse(
        TILED_MCP_APPLICATION_ERROR_REGISTRY_JSON,
      ),
    ).toEqual(
      TILED_MCP_APPLICATION_ERROR_REGISTRY,
    );

    for (const code of TILED_MCP_APPLICATION_ERROR_CODES) {
      expect(
        applicationErrorResultOutputSchema.safeParse(
          applicationError(code),
        ).success,
      ).toBe(true);
    }
    for (const code of [
      "CHANGE_SET_TAMPERED",
      "UNKNOWN_ERROR_CODE",
      "",
    ]) {
      expect(
        applicationErrorResultOutputSchema.safeParse(
          applicationError(code),
        ).success,
      ).toBe(false);
    }
  });

  it("keeps every classified code anchored in production source", async () => {
    const sourceFiles = await listTypeScriptFiles(
      resolve(REPOSITORY_ROOT, "src"),
    );
    const source = (
      await Promise.all(
        sourceFiles
          .filter(
            (path) => {
              const sourcePath = relative(
                REPOSITORY_ROOT,
                path,
              ).replaceAll("\\", "/");
              return (
                sourcePath !==
                  "src/errorRegistry.ts" &&
                !sourcePath.startsWith(
                  "src/resources/",
                ) &&
                !sourcePath.startsWith(
                  "src/outputSchemas/",
                )
              );
            },
          )
          .map((path) =>
            readFile(path, "utf8"),
          ),
      )
    ).join("\n");

    const unreferenced =
      TILED_MCP_ERROR_CODES.filter(
        (code) =>
          !source.includes(
            JSON.stringify(code),
          ),
      );
    expect(unreferenced).toEqual([]);
  });

  it("normalizes forged and internal-only codes before MCP output validation", async () => {
    const harness = await createHarness();
    harnesses.push(harness);

    const forged = new TiledMcpError(
      "INVALID_ARGUMENT",
      "must not escape",
      { secret: "must not escape" },
    );
    Object.defineProperty(forged, "code", {
      configurable: true,
      value: "FORGED_APPLICATION_CODE",
    });
    harness.maps.getSummary = async () => {
      throw forged;
    };

    const forgedResponse =
      (await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: {
          mapPath: "map.tmj",
        },
      })) as ToolResponse;
    expect(forgedResponse.isError).toBe(true);
    expect(forgedResponse.structuredContent).toEqual({
      result: {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal TiledMCP error.",
          details: {},
        },
      },
    });

    harness.maps.getSummary = async () => {
      throw new TiledMcpError(
        "INVALID_CHANGE_SET",
        "internal plan detail",
        { secret: "must not escape" },
      );
    };
    const internalResponse =
      (await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: {
          mapPath: "map.tmj",
        },
      })) as ToolResponse;
    expect(
      internalResponse.structuredContent,
    ).toEqual(forgedResponse.structuredContent);

    harness.maps.getSummary = async () => {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "public explanation",
        { field: "mapPath" },
      );
    };
    const publicResponse =
      (await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: {
          mapPath: "map.tmj",
        },
      })) as ToolResponse;
    expect(publicResponse.structuredContent).toEqual({
      result: {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "public explanation",
          details: {
            field: "mapPath",
          },
        },
      },
    });

    for (const code of [
      "ASSET_REGISTRY_CORRUPT",
      "ASSET_REGISTRY_LIMIT_EXCEEDED",
    ] as const) {
      harness.maps.getSummary = async () => {
        throw new TiledMcpError(
          code,
          `${code} recovery guidance`,
          { registry: ".tiledmcp/asset-registry.v1.json" },
        );
      };
      const registryResponse =
        (await harness.client.callTool({
          name: "tiled_get_map_summary",
          arguments: {
            mapPath: "map.tmj",
          },
        })) as ToolResponse;
      expect(
        registryResponse.structuredContent,
      ).toEqual({
        result: {
          ok: false,
          error: {
            code,
            message:
              `${code} recovery guidance`,
            details: {
              registry:
                ".tiledmcp/asset-registry.v1.json",
            },
          },
        },
      });
    }

    const genericInternalError = {
      result: {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal TiledMCP error.",
          details: {},
        },
      },
    };
    harness.maps.getSummary = async () => {
      throw new TiledMcpError(
        "INTERNAL_ERROR",
        "explicit internal secret",
        { secret: "must not escape" },
      );
    };
    const explicitInternalResponse =
      (await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: {
          mapPath: "map.tmj",
        },
      })) as ToolResponse;
    expect(
      explicitInternalResponse.structuredContent,
    ).toEqual(genericInternalError);
    expect(
      JSON.stringify(explicitInternalResponse),
    ).not.toContain("internal secret");

    for (const malformedDetails of [
      [],
      null,
      "not-an-object",
    ]) {
      harness.maps.getSummary = async () => {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "public explanation",
          malformedDetails as unknown as Record<
            string,
            unknown
          >,
        );
      };
      const malformedResponse =
        (await harness.client.callTool({
          name: "tiled_get_map_summary",
          arguments: {
            mapPath: "map.tmj",
          },
        })) as ToolResponse;
      expect(
        malformedResponse.structuredContent,
      ).toEqual({
        result: {
          ok: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: "public explanation",
            details: {},
          },
        },
      });
    }

    const hostileDetails: Record<
      string,
      unknown
    > = {};
    Object.defineProperty(
      hostileDetails,
      "secret",
      {
        enumerable: true,
        get() {
          throw new Error(
            "getter leaked secret",
          );
        },
      },
    );
    harness.maps.getSummary = async () => {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "public explanation",
        hostileDetails,
      );
    };
    const hostileDetailsResponse =
      (await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: {
          mapPath: "map.tmj",
        },
      })) as ToolResponse;
    expect(
      hostileDetailsResponse.structuredContent,
    ).toEqual(genericInternalError);
    expect(
      JSON.stringify(hostileDetailsResponse),
    ).not.toContain("getter leaked secret");

    const hostileMessage = new TiledMcpError(
      "INVALID_ARGUMENT",
      "placeholder",
    );
    Object.defineProperty(
      hostileMessage,
      "message",
      {
        configurable: true,
        get() {
          throw new Error(
            "message getter leaked secret",
          );
        },
      },
    );
    harness.maps.getSummary = async () => {
      throw hostileMessage;
    };
    const hostileMessageResponse =
      (await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: {
          mapPath: "map.tmj",
        },
      })) as ToolResponse;
    expect(
      hostileMessageResponse.structuredContent,
    ).toEqual(genericInternalError);
    expect(
      JSON.stringify(hostileMessageResponse),
    ).not.toContain("leaked secret");

    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    harness.maps.getSummary = async () => {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        "public explanation",
        revocable.proxy as Record<
          string,
          unknown
        >,
      );
    };
    const revokedProxyResponse =
      (await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: {
          mapPath: "map.tmj",
        },
      })) as ToolResponse;
    expect(
      revokedProxyResponse.structuredContent,
    ).toEqual(genericInternalError);

    harness.maps.getSummary =
      (async () => ({
        unexpected: "schema-invalid-success",
      })) as unknown as typeof harness.maps.getSummary;
    const invalidSuccessResponse =
      (await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: {
          mapPath: "map.tmj",
        },
      })) as ToolResponse;
    expect(invalidSuccessResponse.isError).toBe(
      true,
    );
    expect(
      invalidSuccessResponse.structuredContent,
    ).toEqual(genericInternalError);
    expect(
      JSON.stringify(invalidSuccessResponse),
    ).not.toContain("schema-invalid-success");

    harness.maps.getSummary =
      (async () => ({
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "forged success error",
          details: {
            sentinel:
              "error-envelope-signal-leak",
          },
        },
      })) as unknown as typeof harness.maps.getSummary;
    const mismatchedSignalResponse =
      (await harness.client.callTool({
        name: "tiled_get_map_summary",
        arguments: {
          mapPath: "map.tmj",
        },
      })) as ToolResponse;
    expect(
      mismatchedSignalResponse.isError,
    ).toBe(true);
    expect(
      mismatchedSignalResponse.structuredContent,
    ).toEqual(genericInternalError);
    expect(
      JSON.stringify(
        mismatchedSignalResponse,
      ),
    ).not.toContain(
      "error-envelope-signal-leak",
    );
  });

  it("normalizes invalid runtime constructor input and unknown failures", () => {
    const invalid = new TiledMcpError(
      "FORGED" as TiledMcpErrorCode,
      "must not escape",
      { secret: true },
    );
    expect(invalid).toMatchObject({
      code: "INTERNAL_ERROR",
      details: {},
    });
    expect(
      asTiledMcpError(
        new Error("raw internal failure"),
      ),
    ).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "raw internal failure",
    });
  });

  it("validates, redacts, and freezes the capability snapshot", async () => {
    const capabilityInput =
      defaultCapabilitySnapshot();
    capabilityInput.tiled.issues.push({
      code: "INTERNAL_ERROR",
      message: "capability secret",
    });
    const harness =
      await createHarness(capabilityInput);
    harnesses.push(harness);

    capabilityInput.rasterizer.available =
      true;
    capabilityInput.rasterizer.version =
      "mutated-after-registration";
    capabilityInput.rasterizer.issues.push({
      code: "TMXRASTERIZER_FAILED",
      message: "mutated issue",
    });

    const response =
      (await harness.client.callTool({
        name: "tiled_get_capabilities",
        arguments: {},
      })) as ToolResponse;
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      result: {
        registeredTools: expect.not.arrayContaining([
          "tiled_render_map",
        ]),
        cli: {
          tiled: {
            issues: [
              {
                code: "INTERNAL_ERROR",
                message:
                  "Tiled capability probe failed internally.",
              },
            ],
          },
          rasterizer: {
            available: false,
            version: null,
            issues: [],
          },
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain(
      "capability secret",
    );
    expect(JSON.stringify(response)).not.toContain(
      "mutated-after-registration",
    );

    for (const value of [
      harness.cliCapabilities,
      harness.cliCapabilities.tiled,
      harness.cliCapabilities.tiled.mapExportFormats,
      harness.cliCapabilities.tiled.tilesetExportFormats,
      harness.cliCapabilities.tiled.issues,
      harness.cliCapabilities.tiled.issues[0],
      harness.cliCapabilities.rasterizer,
      harness.cliCapabilities.rasterizer.issues,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => {
      harness.cliCapabilities.rasterizer.available =
        true;
    }).toThrow(TypeError);
  });
});

function applicationError(code: string): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code,
      message: "message",
      details: {},
    },
  };
}

async function listTypeScriptFiles(
  directory: string,
): Promise<string[]> {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const paths = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? listTypeScriptFiles(path)
        : Promise.resolve(
            path.endsWith(".ts") ? [path] : [],
          );
    }),
  );
  return paths.flat();
}

async function createHarness(
  capabilityInput:
    TiledCliCapabilities =
      defaultCapabilitySnapshot(),
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-errors-"),
  );
  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  const maps = new MapService(resolver, store);
  const cli = new TiledCliAdapter({
    tiledCliPath: "contract-tiled",
    rasterizerPath: "contract-tmxrasterizer",
  });
  const created =
    await createTiledMcpServerFromCapabilitySnapshot(
      { resolver, store, maps, cli },
      capabilityInput,
    );
  const client = new Client(
    {
      name: "tiled-mcp-error-test-client",
      version: "1",
    },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await created.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    root,
    maps,
    client,
    server: created.server,
    capabilityInput,
    cliCapabilities: created.cliCapabilities,
  };
}

function defaultCapabilitySnapshot(): TiledCliCapabilities {
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
      executable:
        "contract-tmxrasterizer",
      available: false,
      version: null,
      issues: [],
    },
  };
}
