import { TiledMcpError } from "../errors.js";
import {
  expectArray,
  expectObject,
  type JsonObject,
} from "../formats/json.js";
import {
  parseTiledTextObjectData,
  TEXT_OBJECT_DEFAULTS,
  TextObjectValidationError,
} from "./textObjects.js";

/**
 * Native TMX serialization for the restricted profile: finite
 * orthogonal maps, external tileset references, CSV tile layers, and
 * top-level tile/object layers whose members the serializer fully
 * understands. Everything else — embedded tilesets, image and group
 * layers, custom properties, template instances, unknown members —
 * fails closed rather than being silently dropped, so the TMX output
 * never loses data the source carried.
 *
 * The byte format matches Tiled 1.12.2's own MapWriter (QXmlStreamWriter
 * with auto-formatting indent 1, QString::number %g float formatting,
 * attribute order per mapwriter.cpp) and is verified against a golden
 * export from the official CLI. Floats whose %g rendering would lose
 * precision fail closed instead of drifting.
 */

const KNOWN_MAP_MEMBERS = new Set([
  "backgroundcolor",
  "class",
  "compressionlevel",
  "height",
  "infinite",
  "layers",
  "nextlayerid",
  "nextobjectid",
  "orientation",
  "renderorder",
  "tiledversion",
  "tileheight",
  "tilesets",
  "tilewidth",
  "type",
  "version",
  "width",
]);

const KNOWN_LAYER_COMMON_MEMBERS = [
  "class",
  "id",
  "locked",
  "name",
  "offsetx",
  "offsety",
  "opacity",
  "parallaxx",
  "parallaxy",
  "tintcolor",
  "type",
  "visible",
  "x",
  "y",
] as const;

const KNOWN_TILE_LAYER_MEMBERS = new Set([
  ...KNOWN_LAYER_COMMON_MEMBERS,
  "data",
  "height",
  "width",
]);

const KNOWN_OBJECT_LAYER_MEMBERS = new Set([
  ...KNOWN_LAYER_COMMON_MEMBERS,
  "color",
  "draworder",
  "objects",
]);

const KNOWN_OBJECT_MEMBERS = new Set([
  "capsule",
  "ellipse",
  "gid",
  "height",
  "id",
  "name",
  "point",
  "polygon",
  "polyline",
  "rotation",
  "text",
  "type",
  "visible",
  "width",
  "x",
  "y",
]);

const RENDER_ORDERS = new Set([
  "right-down",
  "right-up",
  "left-down",
  "left-up",
]);

function fail(message: string): never {
  throw new TiledMcpError(
    "UNSUPPORTED_FORMAT",
    message,
  );
}

function assertKnownMembers(
  record: JsonObject,
  known: ReadonlySet<string>,
  context: string,
): void {
  if (record.properties !== undefined) {
    fail(
      `${context} carries custom properties, which the TMX writer profile does not cover.`,
    );
  }
  const unknown = Object.keys(record).find(
    (member) => !known.has(member),
  );
  if (unknown !== undefined) {
    fail(
      `${context}.${unknown} is outside the supported TMX writer profile.`,
    );
  }
}

function requireInt(
  value: unknown,
  context: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value)
  ) {
    fail(`${context} must be a safe integer.`);
  }
  return value;
}

function requireString(
  value: unknown,
  context: string,
): string {
  if (typeof value !== "string") {
    fail(`${context} must be a string.`);
  }
  return value;
}

/**
 * QString::number(double) semantics: %g with six significant digits
 * and a two-digit exponent. A value whose rendering does not parse
 * back to the exact input fails closed instead of drifting.
 */
export function formatQtDouble(
  value: number,
  context: string,
): string {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    fail(`${context} must be a finite number.`);
  }
  let text: string;
  if (value === 0) {
    text = "0";
  } else {
    text = value.toPrecision(6);
    const exponentIndex = text.indexOf("e");
    if (exponentIndex >= 0) {
      let mantissa = text.slice(0, exponentIndex);
      let exponent = text.slice(
        exponentIndex + 1,
      );
      if (mantissa.includes(".")) {
        mantissa = mantissa
          .replace(/0+$/u, "")
          .replace(/\.$/u, "");
      }
      const sign = exponent.startsWith("-")
        ? "-"
        : "+";
      const digits = exponent.replace(
        /^[+-]/u,
        "",
      );
      exponent =
        sign +
        (digits.length < 2
          ? `0${digits}`
          : digits);
      text = `${mantissa}e${exponent}`;
    } else if (text.includes(".")) {
      text = text
        .replace(/0+$/u, "")
        .replace(/\.$/u, "");
    }
  }
  if (Number(text) !== value) {
    fail(
      `${context} cannot be serialized to TMX without precision loss (Tiled renders doubles with six significant digits).`,
    );
  }
  return text;
}

function requireDouble(
  value: unknown,
  context: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    fail(`${context} must be a finite number.`);
  }
  return value;
}

function assertSerializableText(
  value: string,
  context: string,
): void {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      code < 0x20 &&
      code !== 0x09 &&
      code !== 0x0a &&
      code !== 0x0d
    ) {
      fail(
        `${context} contains a control character that XML cannot carry.`,
      );
    }
  }
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function escapeText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

class Attributes {
  private readonly parts: string[] = [];

  add(name: string, value: string): void {
    assertSerializableText(value, name);
    // Attribute values cannot carry literal newlines byte-exactly.
    if (/[\n\r\t]/u.test(value)) {
      fail(
        `${name} contains whitespace control characters outside the TMX writer profile.`,
      );
    }
    this.parts.push(
      ` ${name}="${escapeAttribute(value)}"`,
    );
  }

  toString(): string {
    return this.parts.join("");
  }
}

function serializeLayerCommonAttributes(
  layer: JsonObject,
  context: string,
  attributes: Attributes,
  tileSize?: { width: number; height: number },
): void {
  const id = requireInt(layer.id, `${context}.id`);
  if (id <= 0) {
    fail(`${context}.id must be positive.`);
  }
  attributes.add("id", String(id));
  const name = requireString(
    layer.name ?? "",
    `${context}.name`,
  );
  if (name.length > 0) {
    attributes.add("name", name);
  }
  if (layer.class !== undefined) {
    const className = requireString(
      layer.class,
      `${context}.class`,
    );
    if (className.length > 0) {
      attributes.add("class", className);
    }
  }
  const x =
    layer.x === undefined
      ? 0
      : requireInt(layer.x, `${context}.x`);
  const y =
    layer.y === undefined
      ? 0
      : requireInt(layer.y, `${context}.y`);
  if (x !== 0) {
    attributes.add("x", String(x));
  }
  if (y !== 0) {
    attributes.add("y", String(y));
  }
  if (tileSize !== undefined) {
    attributes.add(
      "width",
      String(tileSize.width),
    );
    attributes.add(
      "height",
      String(tileSize.height),
    );
  }
  if (layer.visible === false) {
    attributes.add("visible", "0");
  } else if (
    layer.visible !== undefined &&
    layer.visible !== true
  ) {
    fail(`${context}.visible must be a boolean.`);
  }
  if (layer.locked === true) {
    attributes.add("locked", "1");
  } else if (
    layer.locked !== undefined &&
    layer.locked !== false
  ) {
    fail(`${context}.locked must be a boolean.`);
  }
  const opacity =
    layer.opacity === undefined
      ? 1
      : requireDouble(
          layer.opacity,
          `${context}.opacity`,
        );
  if (opacity !== 1) {
    attributes.add(
      "opacity",
      formatQtDouble(
        opacity,
        `${context}.opacity`,
      ),
    );
  }
  if (layer.tintcolor !== undefined) {
    attributes.add(
      "tintcolor",
      requireString(
        layer.tintcolor,
        `${context}.tintcolor`,
      ),
    );
  }
  const offsetX =
    layer.offsetx === undefined
      ? 0
      : requireDouble(
          layer.offsetx,
          `${context}.offsetx`,
        );
  const offsetY =
    layer.offsety === undefined
      ? 0
      : requireDouble(
          layer.offsety,
          `${context}.offsety`,
        );
  if (offsetX !== 0 || offsetY !== 0) {
    attributes.add(
      "offsetx",
      formatQtDouble(
        offsetX,
        `${context}.offsetx`,
      ),
    );
    attributes.add(
      "offsety",
      formatQtDouble(
        offsetY,
        `${context}.offsety`,
      ),
    );
  }
  const parallaxX =
    layer.parallaxx === undefined
      ? 1
      : requireDouble(
          layer.parallaxx,
          `${context}.parallaxx`,
        );
  if (parallaxX !== 1) {
    attributes.add(
      "parallaxx",
      formatQtDouble(
        parallaxX,
        `${context}.parallaxx`,
      ),
    );
  }
  const parallaxY =
    layer.parallaxy === undefined
      ? 1
      : requireDouble(
          layer.parallaxy,
          `${context}.parallaxy`,
        );
  if (parallaxY !== 1) {
    attributes.add(
      "parallaxy",
      formatQtDouble(
        parallaxY,
        `${context}.parallaxy`,
      ),
    );
  }
}

function serializeTileLayer(
  layer: JsonObject,
  context: string,
  lines: string[],
): void {
  assertKnownMembers(
    layer,
    KNOWN_TILE_LAYER_MEMBERS,
    context,
  );
  const width = requireInt(
    layer.width,
    `${context}.width`,
  );
  const height = requireInt(
    layer.height,
    `${context}.height`,
  );
  if (width < 1 || height < 1) {
    fail(
      `${context} must have positive dimensions.`,
    );
  }
  const data = expectArray(
    layer.data,
    `${context}.data`,
  );
  if (data.length !== width * height) {
    fail(
      `${context}.data must contain exactly width*height plain CSV cells.`,
    );
  }
  const attributes = new Attributes();
  serializeLayerCommonAttributes(
    layer,
    context,
    attributes,
    { width, height },
  );
  lines.push(` <layer${attributes.toString()}>`);
  lines.push('  <data encoding="csv">');
  for (let y = 0; y < height; y += 1) {
    const cells: string[] = [];
    for (let x = 0; x < width; x += 1) {
      const gid = data[y * width + x];
      if (
        typeof gid !== "number" ||
        !Number.isSafeInteger(gid) ||
        gid < 0
      ) {
        fail(
          `${context}.data[${y * width + x}] must be a non-negative integer GID.`,
        );
      }
      cells.push(String(gid));
    }
    const row = cells.join(",");
    lines.push(
      y === height - 1 ? row : `${row},`,
    );
  }
  lines.push("</data>");
  lines.push(" </layer>");
}

function serializeObject(
  raw: JsonObject,
  context: string,
  lines: string[],
): void {
  assertKnownMembers(
    raw,
    KNOWN_OBJECT_MEMBERS,
    context,
  );
  const markers = (
    [
      "ellipse",
      "point",
      "capsule",
      "polygon",
      "polyline",
      "text",
      "gid",
    ] as const
  ).filter((marker) => raw[marker] !== undefined);
  if (markers.length > 1) {
    fail(
      `${context} carries conflicting shape markers: ${markers.join(", ")}.`,
    );
  }
  const marker = markers[0];
  for (const flag of [
    "ellipse",
    "point",
    "capsule",
  ] as const) {
    if (
      raw[flag] !== undefined &&
      raw[flag] !== true
    ) {
      fail(
        `${context}.${flag} must be true when present.`,
      );
    }
  }

  const attributes = new Attributes();
  const id = requireInt(raw.id, `${context}.id`);
  attributes.add("id", String(id));
  const name = requireString(
    raw.name ?? "",
    `${context}.name`,
  );
  if (name.length > 0) {
    attributes.add("name", name);
  }
  const className = requireString(
    raw.type ?? "",
    `${context}.type`,
  );
  if (className.length > 0) {
    attributes.add("type", className);
  }
  if (marker === "gid") {
    const gid = requireInt(
      raw.gid,
      `${context}.gid`,
    );
    if (gid <= 0) {
      fail(`${context}.gid must be positive.`);
    }
    attributes.add("gid", String(gid));
  }
  attributes.add(
    "x",
    formatQtDouble(
      requireDouble(raw.x, `${context}.x`),
      `${context}.x`,
    ),
  );
  attributes.add(
    "y",
    formatQtDouble(
      requireDouble(raw.y, `${context}.y`),
      `${context}.y`,
    ),
  );
  const width =
    raw.width === undefined
      ? 0
      : requireDouble(
          raw.width,
          `${context}.width`,
        );
  const height =
    raw.height === undefined
      ? 0
      : requireDouble(
          raw.height,
          `${context}.height`,
        );
  if (width !== 0) {
    attributes.add(
      "width",
      formatQtDouble(width, `${context}.width`),
    );
  }
  if (height !== 0) {
    attributes.add(
      "height",
      formatQtDouble(
        height,
        `${context}.height`,
      ),
    );
  }
  const rotation =
    raw.rotation === undefined
      ? 0
      : requireDouble(
          raw.rotation,
          `${context}.rotation`,
        );
  if (rotation !== 0) {
    attributes.add(
      "rotation",
      formatQtDouble(
        rotation,
        `${context}.rotation`,
      ),
    );
  }
  if (raw.visible === false) {
    attributes.add("visible", "0");
  } else if (
    raw.visible !== undefined &&
    raw.visible !== true
  ) {
    fail(`${context}.visible must be a boolean.`);
  }

  if (
    marker === undefined ||
    marker === "gid"
  ) {
    lines.push(
      `  <object${attributes.toString()}/>`,
    );
    return;
  }
  if (marker === "text") {
    let fields;
    try {
      fields = parseTiledTextObjectData(raw.text);
    } catch (error) {
      if (
        error instanceof TextObjectValidationError
      ) {
        fail(
          `${context}.text: ${error.message}`,
        );
      }
      throw error;
    }
    const textAttributes = new Attributes();
    if (
      fields.fontFamily !==
      TEXT_OBJECT_DEFAULTS.fontFamily
    ) {
      textAttributes.add(
        "fontfamily",
        fields.fontFamily,
      );
    }
    if (
      fields.pixelSize !==
      TEXT_OBJECT_DEFAULTS.pixelSize
    ) {
      textAttributes.add(
        "pixelsize",
        String(
          requireInt(
            fields.pixelSize,
            `${context}.text.pixelsize`,
          ),
        ),
      );
    }
    if (fields.wrap) {
      textAttributes.add("wrap", "1");
    }
    if (
      fields.color !== TEXT_OBJECT_DEFAULTS.color
    ) {
      textAttributes.add("color", fields.color);
    }
    if (fields.bold) {
      textAttributes.add("bold", "1");
    }
    if (fields.italic) {
      textAttributes.add("italic", "1");
    }
    if (fields.underline) {
      textAttributes.add("underline", "1");
    }
    if (fields.strikeout) {
      textAttributes.add("strikeout", "1");
    }
    if (!fields.kerning) {
      textAttributes.add("kerning", "0");
    }
    if (fields.horizontalAlignment !== "left") {
      textAttributes.add(
        "halign",
        fields.horizontalAlignment,
      );
    }
    if (fields.verticalAlignment !== "top") {
      textAttributes.add(
        "valign",
        fields.verticalAlignment,
      );
    }
    assertSerializableText(
      fields.text,
      `${context}.text.text`,
    );
    lines.push(
      `  <object${attributes.toString()}>`,
    );
    lines.push(
      `   <text${textAttributes.toString()}>${escapeText(fields.text)}</text>`,
    );
    lines.push("  </object>");
    return;
  }
  if (
    marker === "polygon" ||
    marker === "polyline"
  ) {
    const points = expectArray(
      raw[marker],
      `${context}.${marker}`,
    );
    if (points.length === 0) {
      fail(
        `${context}.${marker} must contain at least one point.`,
      );
    }
    const rendered = points
      .map((point, index) => {
        const record = expectObject(
          point,
          `${context}.${marker}[${index}]`,
        );
        const pointContext = `${context}.${marker}[${index}]`;
        return `${formatQtDouble(
          requireDouble(
            record.x,
            `${pointContext}.x`,
          ),
          `${pointContext}.x`,
        )},${formatQtDouble(
          requireDouble(
            record.y,
            `${pointContext}.y`,
          ),
          `${pointContext}.y`,
        )}`;
      })
      .join(" ");
    lines.push(
      `  <object${attributes.toString()}>`,
    );
    lines.push(
      `   <${marker} points="${rendered}"/>`,
    );
    lines.push("  </object>");
    return;
  }
  lines.push(
    `  <object${attributes.toString()}>`,
  );
  lines.push(`   <${marker}/>`);
  lines.push("  </object>");
}

function serializeObjectLayer(
  layer: JsonObject,
  context: string,
  lines: string[],
): void {
  assertKnownMembers(
    layer,
    KNOWN_OBJECT_LAYER_MEMBERS,
    context,
  );
  const attributes = new Attributes();
  if (layer.color !== undefined) {
    attributes.add(
      "color",
      requireString(
        layer.color,
        `${context}.color`,
      ),
    );
  }
  const drawOrder =
    layer.draworder === undefined
      ? "topdown"
      : requireString(
          layer.draworder,
          `${context}.draworder`,
        );
  if (
    drawOrder !== "topdown" &&
    drawOrder !== "index"
  ) {
    fail(
      `${context}.draworder must be topdown or index.`,
    );
  }
  if (drawOrder !== "topdown") {
    attributes.add("draworder", drawOrder);
  }
  serializeLayerCommonAttributes(
    layer,
    context,
    attributes,
  );
  const objects = expectArray(
    layer.objects ?? [],
    `${context}.objects`,
  );
  if (objects.length === 0) {
    lines.push(
      ` <objectgroup${attributes.toString()}/>`,
    );
    return;
  }
  lines.push(
    ` <objectgroup${attributes.toString()}>`,
  );
  for (const [index, entry] of objects.entries()) {
    serializeObject(
      expectObject(
        entry,
        `${context}.objects[${index}]`,
      ),
      `${context}.objects[${index}]`,
      lines,
    );
  }
  lines.push(" </objectgroup>");
}

const KNOWN_TILESET_MEMBERS = new Set([
  "class",
  "columns",
  "image",
  "imageheight",
  "imagewidth",
  "margin",
  "name",
  "objectalignment",
  "spacing",
  "tilecount",
  "tiledversion",
  "tileheight",
  "tilewidth",
  "type",
  "version",
]);

const OBJECT_ALIGNMENTS = new Set([
  "unspecified",
  "topleft",
  "top",
  "topright",
  "left",
  "center",
  "right",
  "bottomleft",
  "bottom",
  "bottomright",
]);

/**
 * Serializes one restricted-profile TSJ atlas tileset to TSX bytes
 * matching Tiled 1.12.2's own writer byte for byte. The official
 * exporter reloads the image and recomputes the grid, so the profile
 * requires the declared geometry to be self-consistent (columns and
 * tilecount derivable from the image size, margin, and spacing) and
 * fails closed otherwise; per-tile metadata, wang sets, custom
 * properties, tile offsets, and unknown members also fail closed.
 */
export function serializeTsxTileset(
  document: JsonObject,
  tilesetPath: string,
): string {
  assertKnownMembers(
    document,
    KNOWN_TILESET_MEMBERS,
    tilesetPath,
  );
  if (document.type !== "tileset") {
    fail(`${tilesetPath} is not a Tiled tileset.`);
  }
  const version = requireString(
    document.version,
    `${tilesetPath}.version`,
  );
  const tiledVersion = requireString(
    document.tiledversion,
    `${tilesetPath}.tiledversion`,
  );
  const name = requireString(
    document.name,
    `${tilesetPath}.name`,
  );
  const tileWidth = requireInt(
    document.tilewidth,
    `${tilesetPath}.tilewidth`,
  );
  const tileHeight = requireInt(
    document.tileheight,
    `${tilesetPath}.tileheight`,
  );
  const spacing =
    document.spacing === undefined
      ? 0
      : requireInt(
          document.spacing,
          `${tilesetPath}.spacing`,
        );
  const margin =
    document.margin === undefined
      ? 0
      : requireInt(
          document.margin,
          `${tilesetPath}.margin`,
        );
  const tileCount = requireInt(
    document.tilecount,
    `${tilesetPath}.tilecount`,
  );
  const columns = requireInt(
    document.columns,
    `${tilesetPath}.columns`,
  );
  const image = requireString(
    document.image,
    `${tilesetPath}.image`,
  );
  const imageWidth = requireInt(
    document.imagewidth,
    `${tilesetPath}.imagewidth`,
  );
  const imageHeight = requireInt(
    document.imageheight,
    `${tilesetPath}.imageheight`,
  );
  if (
    tileWidth < 1 ||
    tileHeight < 1 ||
    spacing < 0 ||
    margin < 0 ||
    columns < 1 ||
    tileCount < 1
  ) {
    fail(
      `${tilesetPath} must declare a positive tile grid.`,
    );
  }
  // The official exporter recomputes the grid from the image; the
  // native writer instead requires the declaration to already agree.
  const derivedColumns = Math.floor(
    (imageWidth - margin * 2 + spacing) /
      (tileWidth + spacing),
  );
  const derivedRows = Math.floor(
    (imageHeight - margin * 2 + spacing) /
      (tileHeight + spacing),
  );
  if (
    derivedColumns !== columns ||
    derivedRows < 1 ||
    columns * derivedRows !== tileCount
  ) {
    fail(
      `${tilesetPath} declares a grid that does not match its image size; Tiled's exporter would rewrite it.`,
    );
  }

  const attributes = new Attributes();
  attributes.add("version", version);
  attributes.add("tiledversion", tiledVersion);
  attributes.add("name", name);
  if (document.class !== undefined) {
    const className = requireString(
      document.class,
      `${tilesetPath}.class`,
    );
    if (className.length > 0) {
      attributes.add("class", className);
    }
  }
  attributes.add(
    "tilewidth",
    String(tileWidth),
  );
  attributes.add(
    "tileheight",
    String(tileHeight),
  );
  if (spacing !== 0) {
    attributes.add("spacing", String(spacing));
  }
  if (margin !== 0) {
    attributes.add("margin", String(margin));
  }
  attributes.add(
    "tilecount",
    String(tileCount),
  );
  attributes.add("columns", String(columns));
  if (document.objectalignment !== undefined) {
    const alignment = requireString(
      document.objectalignment,
      `${tilesetPath}.objectalignment`,
    );
    if (!OBJECT_ALIGNMENTS.has(alignment)) {
      fail(
        `${tilesetPath}.objectalignment is not a Tiled object alignment.`,
      );
    }
    if (alignment !== "unspecified") {
      attributes.add(
        "objectalignment",
        alignment,
      );
    }
  }
  const imageAttributes = new Attributes();
  imageAttributes.add("source", image);
  imageAttributes.add(
    "width",
    String(imageWidth),
  );
  imageAttributes.add(
    "height",
    String(imageHeight),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<tileset${attributes.toString()}>`,
    ` <image${imageAttributes.toString()}/>`,
    "</tileset>",
    "",
  ].join("\n");
}

/**
 * Serializes one restricted-profile TMJ map document to TMX bytes that
 * match Tiled 1.12.2's own writer byte for byte. Tileset references and
 * GIDs (including flip bits) carry verbatim, so the target must live in
 * the source map's directory for relative references to keep resolving.
 */
export function serializeTmxMap(
  document: JsonObject,
  mapPath: string,
): string {
  assertKnownMembers(
    document,
    KNOWN_MAP_MEMBERS,
    mapPath,
  );
  if (document.type !== "map") {
    fail(`${mapPath} is not a Tiled map.`);
  }
  if (document.orientation !== "orthogonal") {
    fail(
      `${mapPath} must be orthogonal; other orientations are outside the TMX writer profile.`,
    );
  }
  if (document.infinite === true) {
    fail(
      `${mapPath} is infinite, which is outside the TMX writer profile.`,
    );
  }
  const renderOrder = requireString(
    document.renderorder ?? "right-down",
    `${mapPath}.renderorder`,
  );
  if (!RENDER_ORDERS.has(renderOrder)) {
    fail(
      `${mapPath}.renderorder must be one of the four Tiled render orders.`,
    );
  }
  const version = requireString(
    document.version,
    `${mapPath}.version`,
  );
  const tiledVersion = requireString(
    document.tiledversion,
    `${mapPath}.tiledversion`,
  );

  const attributes = new Attributes();
  attributes.add("version", version);
  attributes.add("tiledversion", tiledVersion);
  if (document.class !== undefined) {
    const className = requireString(
      document.class,
      `${mapPath}.class`,
    );
    if (className.length > 0) {
      attributes.add("class", className);
    }
  }
  attributes.add("orientation", "orthogonal");
  attributes.add("renderorder", renderOrder);
  if (document.compressionlevel !== undefined) {
    const level = requireInt(
      document.compressionlevel,
      `${mapPath}.compressionlevel`,
    );
    if (level >= 0) {
      attributes.add(
        "compressionlevel",
        String(level),
      );
    }
  }
  const width = requireInt(
    document.width,
    `${mapPath}.width`,
  );
  const height = requireInt(
    document.height,
    `${mapPath}.height`,
  );
  attributes.add("width", String(width));
  attributes.add("height", String(height));
  attributes.add(
    "tilewidth",
    String(
      requireInt(
        document.tilewidth,
        `${mapPath}.tilewidth`,
      ),
    ),
  );
  attributes.add(
    "tileheight",
    String(
      requireInt(
        document.tileheight,
        `${mapPath}.tileheight`,
      ),
    ),
  );
  attributes.add("infinite", "0");
  if (document.backgroundcolor !== undefined) {
    attributes.add(
      "backgroundcolor",
      requireString(
        document.backgroundcolor,
        `${mapPath}.backgroundcolor`,
      ),
    );
  }
  attributes.add(
    "nextlayerid",
    String(
      requireInt(
        document.nextlayerid,
        `${mapPath}.nextlayerid`,
      ),
    ),
  );
  attributes.add(
    "nextobjectid",
    String(
      requireInt(
        document.nextobjectid,
        `${mapPath}.nextobjectid`,
      ),
    ),
  );

  const lines: string[] = [];
  lines.push(
    '<?xml version="1.0" encoding="UTF-8"?>',
  );
  lines.push(`<map${attributes.toString()}>`);

  const tilesets = expectArray(
    document.tilesets,
    `${mapPath}.tilesets`,
  );
  for (const [
    index,
    entry,
  ] of tilesets.entries()) {
    const tileset = expectObject(
      entry,
      `${mapPath}.tilesets[${index}]`,
    );
    const context = `${mapPath}.tilesets[${index}]`;
    const unknown = Object.keys(tileset).find(
      (member) =>
        member !== "firstgid" &&
        member !== "source",
    );
    if (unknown !== undefined) {
      fail(
        `${context}.${unknown} is outside the TMX writer profile; only external tileset references are supported.`,
      );
    }
    const firstGid = requireInt(
      tileset.firstgid,
      `${context}.firstgid`,
    );
    if (firstGid < 1) {
      fail(
        `${context}.firstgid must be positive.`,
      );
    }
    const source = requireString(
      tileset.source,
      `${context}.source`,
    );
    const tilesetAttributes = new Attributes();
    tilesetAttributes.add(
      "firstgid",
      String(firstGid),
    );
    tilesetAttributes.add("source", source);
    lines.push(
      ` <tileset${tilesetAttributes.toString()}/>`,
    );
  }

  const layers = expectArray(
    document.layers,
    `${mapPath}.layers`,
  );
  for (const [index, entry] of layers.entries()) {
    const layer = expectObject(
      entry,
      `${mapPath}.layers[${index}]`,
    );
    const context = `${mapPath}.layers[${index}]`;
    if (layer.type === "tilelayer") {
      serializeTileLayer(layer, context, lines);
    } else if (layer.type === "objectgroup") {
      serializeObjectLayer(
        layer,
        context,
        lines,
      );
    } else {
      fail(
        `${context}.type must be tilelayer or objectgroup; other layer types are outside the TMX writer profile.`,
      );
    }
  }

  lines.push("</map>");
  return `${lines.join("\n")}\n`;
}
