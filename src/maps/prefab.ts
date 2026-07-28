import { TiledMcpError } from "../errors.js";
import { type JsonObject } from "../formats/json.js";
import {
  parseTiledTextObjectData,
  TextObjectValidationError,
} from "./textObjects.js";
import type {
  ObjectDraft,
  ObjectPathPoint,
  TileRef,
} from "./types.js";

export const MAX_PREFAB_OBJECTS = 64;

const KNOWN_OBJECT_MEMBERS = new Set([
  "id",
  "name",
  "type",
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "visible",
  "ellipse",
  "point",
  "capsule",
  "polygon",
  "polyline",
  "text",
  "gid",
]);

const SHAPE_MARKERS = [
  "ellipse",
  "point",
  "capsule",
  "polygon",
  "polyline",
  "text",
  "gid",
] as const;

function expectFiniteNumber(
  value: unknown,
  context: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must be a finite number.`,
    );
  }
  return value;
}

function readPathPoints(
  value: unknown,
  context: string,
): ObjectPathPoint[] {
  if (!Array.isArray(value)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} must be an array of points.`,
    );
  }
  return value.map((point, index) => {
    if (
      typeof point !== "object" ||
      point === null
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}[${index}] must be a point object.`,
      );
    }
    const record = point as JsonObject;
    return {
      x: expectFiniteNumber(
        record.x,
        `${context}[${index}].x`,
      ),
      y: expectFiniteNumber(
        record.y,
        `${context}[${index}].y`,
      ),
    };
  });
}

/**
 * Converts one raw serialized map object into a createObject draft for
 * stamping into another map. The supported profile is exactly what the
 * draft union can express: unknown members, custom properties, and
 * template instances all fail closed rather than being silently
 * dropped, so a stamp never loses data it did not understand. The
 * returned draft keeps the source pixel position; callers offset it.
 */
export function convertPrefabObject(
  raw: JsonObject,
  context: string,
  decodeTile: (gid: number) => TileRef,
): ObjectDraft {
  if (raw.template !== undefined) {
    throw new TiledMcpError(
      "UNSUPPORTED_OBJECT_PROFILE",
      `${context} is a template instance; stamp expanded objects or place the template with tiled_preview_template instead.`,
    );
  }
  if (raw.properties !== undefined) {
    throw new TiledMcpError(
      "UNSUPPORTED_OBJECT_PROFILE",
      `${context} carries custom properties, which a stamped draft cannot express; remove them or copy the object with tiled_preview_edits.`,
    );
  }
  const unknownMember = Object.keys(raw).find(
    (member) => !KNOWN_OBJECT_MEMBERS.has(member),
  );
  if (unknownMember !== undefined) {
    throw new TiledMcpError(
      "UNSUPPORTED_OBJECT_PROFILE",
      `${context}.${unknownMember} is outside the supported stamping profile.`,
      { member: unknownMember },
    );
  }
  const markers = SHAPE_MARKERS.filter(
    (marker) => raw[marker] !== undefined,
  );
  if (markers.length > 1) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} carries conflicting shape markers: ${markers.join(", ")}.`,
    );
  }
  for (const marker of [
    "ellipse",
    "point",
    "capsule",
  ] as const) {
    if (
      raw[marker] !== undefined &&
      raw[marker] !== true
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.${marker} must be true when present.`,
      );
    }
  }

  const x = expectFiniteNumber(raw.x, `${context}.x`);
  const y = expectFiniteNumber(raw.y, `${context}.y`);
  const common: {
    x: number;
    y: number;
    name?: string;
    className?: string;
    rotation?: number;
    visible?: boolean;
  } = { x, y };
  if (
    typeof raw.name === "string" &&
    raw.name.length > 0
  ) {
    common.name = raw.name;
  }
  if (
    typeof raw.type === "string" &&
    raw.type.length > 0
  ) {
    common.className = raw.type;
  }
  if (raw.rotation !== undefined) {
    const rotation = expectFiniteNumber(
      raw.rotation,
      `${context}.rotation`,
    );
    if (rotation !== 0) {
      common.rotation = rotation;
    }
  }
  if (raw.visible === false) {
    common.visible = false;
  }

  const width =
    raw.width === undefined
      ? 0
      : expectFiniteNumber(
          raw.width,
          `${context}.width`,
        );
  const height =
    raw.height === undefined
      ? 0
      : expectFiniteNumber(
          raw.height,
          `${context}.height`,
        );
  const marker = markers[0];
  if (
    (marker === "point" ||
      marker === "polygon" ||
      marker === "polyline") &&
    (width !== 0 || height !== 0)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${context} is a ${marker} object but carries a nonzero size.`,
    );
  }

  if (marker === "gid") {
    const gid = raw.gid;
    if (
      typeof gid !== "number" ||
      !Number.isSafeInteger(gid) ||
      gid <= 0
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${context}.gid must be a positive integer.`,
      );
    }
    return {
      ...common,
      shape: "tile",
      tile: decodeTile(gid),
      width,
      height,
    };
  }
  if (marker === "text") {
    let fields;
    try {
      fields = parseTiledTextObjectData(raw.text);
    } catch (error) {
      if (
        error instanceof TextObjectValidationError
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${context}.text: ${error.message}`,
        );
      }
      throw error;
    }
    return {
      ...common,
      shape: "text",
      ...fields,
      width,
      height,
    };
  }
  if (
    marker === "polygon" ||
    marker === "polyline"
  ) {
    return {
      ...common,
      shape: marker,
      points: readPathPoints(
        raw[marker],
        `${context}.${marker}`,
      ),
    };
  }
  if (marker === "point") {
    return { ...common, shape: "point" };
  }
  if (
    marker === "ellipse" ||
    marker === "capsule"
  ) {
    return {
      ...common,
      shape: marker,
      width,
      height,
    };
  }
  return {
    ...common,
    shape: "rectangle",
    width,
    height,
  };
}
