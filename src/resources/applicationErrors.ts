import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  TILED_MCP_APPLICATION_ERROR_REGISTRY,
  TILED_MCP_APPLICATION_ERROR_REGISTRY_JSON,
} from "../errorRegistry.js";
import { revisionOf } from "../storage/revision.js";
import { SERVER_VERSION } from "../version.js";

export const APPLICATION_ERROR_RESOURCE_URI =
  "tiled://application-errors";
export const APPLICATION_ERROR_RESOURCE_MIME_TYPE =
  "application/json";

const applicationErrorRegistryBytes = Buffer.from(
  TILED_MCP_APPLICATION_ERROR_REGISTRY_JSON,
  "utf8",
);

export const APPLICATION_ERROR_RESOURCE_SIZE =
  applicationErrorRegistryBytes.byteLength;
export const APPLICATION_ERROR_RESOURCE_REVISION =
  revisionOf(applicationErrorRegistryBytes);

export const APPLICATION_ERROR_RESOURCE_META =
  Object.freeze({
    revision:
      APPLICATION_ERROR_RESOURCE_REVISION,
    size: APPLICATION_ERROR_RESOURCE_SIZE,
    serverVersion: SERVER_VERSION,
    registryVersion:
      TILED_MCP_APPLICATION_ERROR_REGISTRY.registryVersion,
  } as const);

export function registerApplicationErrorResource(
  server: McpServer,
): void {
  server.registerResource(
    "application-errors",
    APPLICATION_ERROR_RESOURCE_URI,
    {
      title:
        "TiledMCP stable application error registry",
      description:
        "The versioned identifiers that may appear at structuredContent.result.error.code, plus compatibility and excluded-surface rules.",
      mimeType:
        APPLICATION_ERROR_RESOURCE_MIME_TYPE,
      size: APPLICATION_ERROR_RESOURCE_SIZE,
      annotations: {
        audience: ["assistant", "user"],
        priority: 1,
      },
      _meta: APPLICATION_ERROR_RESOURCE_META,
    },
    (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType:
            APPLICATION_ERROR_RESOURCE_MIME_TYPE,
          text: TILED_MCP_APPLICATION_ERROR_REGISTRY_JSON,
          _meta:
            APPLICATION_ERROR_RESOURCE_META,
        },
      ],
    }),
  );
}
