import { TiledMcpError } from "../errors.js";
import type { XmlElement } from "../formats/xml.js";

export const MAX_TMX_LAYER_SUMMARIES = 10_000;
export const MAX_TMX_TILESET_ENTRIES = 4_096;
export const TMX_READ_PROFILE =
  "tmx-read-only-summary-v1";

const LAYER_ELEMENT_TYPES: Record<
  string,
  "tilelayer" | "objectgroup" | "imagelayer" | "group"
> = {
  layer: "tilelayer",
  objectgroup: "objectgroup",
  imagelayer: "imagelayer",
  group: "group",
};

/**
 * Bounded read-only summary of a TMX map document, mirroring
 * MapReaderPrivate::readMap (Tiled 1.12.2): layer ids/opacity/visibility
 * fall back exactly like readLayerAttributes, renderorder defaults to
 * right-down, and layer elements map to their canonical JSON type names.
 * Tileset entries project their firstgid plus either the external source
 * reference or an embedded marker; nothing here is editable.
 */
export function projectTmxMapSummary(
  root: XmlElement,
  path: string,
): Record<string, unknown> {
  if (root.name !== "map") {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${path} is not a TMX map document.`,
      { path, rootElement: root.name },
    );
  }
  const orientation = requiredAttribute(
    root,
    "orientation",
    path,
  );
  const width = requiredIntAttribute(
    root,
    "width",
    path,
  );
  const height = requiredIntAttribute(
    root,
    "height",
    path,
  );
  const tileWidth = requiredIntAttribute(
    root,
    "tilewidth",
    path,
  );
  const tileHeight = requiredIntAttribute(
    root,
    "tileheight",
    path,
  );
  const infinite =
    intAttribute(root, "infinite", path, 0) !== 0;
  const renderOrder =
    root.attributes.renderorder ?? "right-down";
  const backgroundColor =
    root.attributes.backgroundcolor;
  const className = root.attributes.class;

  const tilesets: Array<Record<string, unknown>> =
    [];
  const layers: Array<Record<string, unknown>> =
    [];
  const budget = { count: 0 };
  for (const child of root.children) {
    if (child.name === "tileset") {
      if (
        tilesets.length >=
        MAX_TMX_TILESET_ENTRIES
      ) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `${path} references more than ${MAX_TMX_TILESET_ENTRIES} tilesets.`,
          {
            path,
            limit: MAX_TMX_TILESET_ENTRIES,
          },
        );
      }
      tilesets.push(
        projectTilesetEntry(child, path),
      );
      continue;
    }
    const layerType =
      LAYER_ELEMENT_TYPES[child.name];
    if (layerType !== undefined) {
      layers.push(
        projectLayer(child, path, budget, 0),
      );
    }
    // Other children (properties, editorsettings) are counted nowhere
    // and altered never — this is a bounded summary, not a round trip.
  }

  return {
    path,
    format: "tmx",
    profile: TMX_READ_PROFILE,
    orientation,
    infinite,
    renderOrder,
    ...(backgroundColor === undefined
      ? {}
      : { backgroundColor }),
    ...(className === undefined ||
    className.length === 0
      ? {}
      : { className }),
    width,
    height,
    tileWidth,
    tileHeight,
    layers,
    tilesets,
    editable: false,
  };
}

function projectTilesetEntry(
  element: XmlElement,
  path: string,
): Record<string, unknown> {
  const firstGid = requiredIntAttribute(
    element,
    "firstgid",
    path,
  );
  const source = element.attributes.source;
  if (source !== undefined) {
    return { firstGid, source };
  }
  return {
    firstGid,
    embedded: true,
    ...(element.attributes.name === undefined
      ? {}
      : { name: element.attributes.name }),
    ...(element.attributes.tilecount ===
    undefined
      ? {}
      : {
          tileCount: parsedInt(
            element.attributes.tilecount,
            "tilecount",
            path,
          ),
        }),
  };
}

function projectLayer(
  element: XmlElement,
  path: string,
  budget: { count: number },
  depth: number,
): Record<string, unknown> {
  budget.count += 1;
  if (
    budget.count > MAX_TMX_LAYER_SUMMARIES ||
    depth > 64
  ) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${path} exceeds the ${MAX_TMX_LAYER_SUMMARIES} layer summary limit.`,
      { path, limit: MAX_TMX_LAYER_SUMMARIES },
    );
  }
  const layerType =
    LAYER_ELEMENT_TYPES[element.name]!;
  const common = {
    // readLayerAttributes: missing id stays 0, opacity defaults to 1,
    // visible defaults to true.
    id: intAttribute(element, "id", path, 0),
    name: element.attributes.name ?? "",
    type: layerType,
    visible:
      intAttribute(element, "visible", path, 1) !==
      0,
    opacity: floatAttribute(
      element,
      "opacity",
      path,
      1,
    ),
  };
  if (layerType === "group") {
    return {
      ...common,
      layers: element.children
        .filter(
          (child) =>
            LAYER_ELEMENT_TYPES[child.name] !==
            undefined,
        )
        .map((child) =>
          projectLayer(
            child,
            path,
            budget,
            depth + 1,
          ),
        ),
    };
  }
  if (layerType === "tilelayer") {
    const data = element.children.find(
      (child) => child.name === "data",
    );
    return {
      ...common,
      width: intAttribute(
        element,
        "width",
        path,
        0,
      ),
      height: intAttribute(
        element,
        "height",
        path,
        0,
      ),
      ...(data === undefined
        ? {}
        : {
            encoding:
              data.attributes.encoding ?? "xml",
            ...(data.attributes.compression ===
            undefined
              ? {}
              : {
                  compression:
                    data.attributes.compression,
                }),
            chunked: data.children.some(
              (child) => child.name === "chunk",
            ),
          }),
    };
  }
  if (layerType === "objectgroup") {
    return {
      ...common,
      objectCount: element.children.filter(
        (child) => child.name === "object",
      ).length,
    };
  }
  return common;
}

export function collectXmlTilesetReferences(
  root: XmlElement,
): string[] {
  const sources: string[] = [];
  const visit = (element: XmlElement): void => {
    if (
      element.name === "tileset" &&
      element.attributes.source !== undefined
    ) {
      sources.push(element.attributes.source);
    }
    for (const child of element.children) {
      visit(child);
    }
  };
  visit(root);
  return sources;
}

function requiredAttribute(
  element: XmlElement,
  name: string,
  path: string,
): string {
  const value = element.attributes[name];
  if (value === undefined || value.length === 0) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${path} <${element.name}> is missing the ${name} attribute.`,
      { path, attribute: name },
    );
  }
  return value;
}

function requiredIntAttribute(
  element: XmlElement,
  name: string,
  path: string,
): number {
  return parsedInt(
    requiredAttribute(element, name, path),
    name,
    path,
  );
}

function intAttribute(
  element: XmlElement,
  name: string,
  path: string,
  fallback: number,
): number {
  const value = element.attributes[name];
  if (value === undefined) {
    return fallback;
  }
  return parsedInt(value, name, path);
}

function floatAttribute(
  element: XmlElement,
  name: string,
  path: string,
  fallback: number,
): number {
  const value = element.attributes[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${path} attribute ${name} is not a finite number.`,
      { path, attribute: name },
    );
  }
  return parsed;
}

function parsedInt(
  value: string,
  name: string,
  path: string,
): number {
  const parsed = Number.parseInt(value, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    String(parsed) !== value.trim()
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${path} attribute ${name} is not a plain integer.`,
      { path, attribute: name, value },
    );
  }
  return parsed;
}
