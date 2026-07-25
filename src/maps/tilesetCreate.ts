import { createHash } from "node:crypto";

import { TiledMcpError } from "../errors.js";
import {
  stableJson,
  type JsonObject,
  type JsonValue,
} from "../formats/json.js";
import { hasAtMostCodePoints } from "./propertyEdits.js";

export const MAX_CREATE_TILESET_TILE_EDGE = 16_384;
export const MAX_CREATE_TILESET_MARGIN = 4_096;
export const MAX_CREATE_TILESET_SPACING = 4_096;
export const MAX_CREATE_TILESET_NAME_CODE_POINTS = 1_024;

const TILESET_CREATE_PLAN_HASH_DOMAIN =
  "tiledmcp/tileset-create-plan/v1\0";
export const CREATE_TILESET_WARNING =
  "This creates one new external TSJ atlas tileset file with Tiled 1.12.2 canonical members. It never overwrites an existing file and does not modify any map; attach it afterwards with tiled_add_tileset_to_map.";

export interface TilesetCreateImagePin {
  path: string;
  /**
   * Canonical POSIX reference relative to the created tileset's directory,
   * exactly as serialized into the TSJ `image` member.
   */
  source: string;
  revision: string;
  width: number;
  height: number;
}

export interface AtlasGrid {
  columns: number;
  rows: number;
  tileCount: number;
  unusedRightPixels: number;
  unusedBottomPixels: number;
}

export interface TilesetCreateSummary {
  tilesetPath: string;
  name: string;
  className: string | null;
  tileWidth: number;
  tileHeight: number;
  margin: number;
  spacing: number;
  columns: number;
  rows: number;
  tileCount: number;
  imageWidth: number;
  imageHeight: number;
  unusedRightPixels: number;
  unusedBottomPixels: number;
  contentBytes: number;
  wouldChange: true;
}

export interface TilesetCreatePlan {
  kind: "tilesetCreate";
  version: 1;
  id: string;
  tilesetPath: string;
  /**
   * Raw SHA-256 of the exact prospective TSJ bytes. There is no existing
   * file, so the apply CAS pins the approved content itself; the commit
   * result reports `beforeRevision: null` and this value as `revision`.
   */
  baseRevision: string;
  name: string;
  className: string | null;
  tileWidth: number;
  tileHeight: number;
  margin: number;
  spacing: number;
  image: TilesetCreateImagePin;
  summary: TilesetCreateSummary;
}

export interface CreateTilesetScalars {
  name: string;
  className: string | null;
  tileWidth: number;
  tileHeight: number;
  margin: number;
  spacing: number;
}

export function validateCreateTilesetScalars(
  scalars: CreateTilesetScalars,
): void {
  const assertEdge = (
    value: number,
    field: string,
  ): void => {
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > MAX_CREATE_TILESET_TILE_EDGE
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${field} must be an integer between 1 and ${MAX_CREATE_TILESET_TILE_EDGE}.`,
      );
    }
  };
  assertEdge(scalars.tileWidth, "tileWidth");
  assertEdge(scalars.tileHeight, "tileHeight");
  const assertGap = (
    value: number,
    field: string,
    maximum: number,
  ): void => {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > maximum
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${field} must be an integer between 0 and ${maximum}.`,
      );
    }
  };
  assertGap(
    scalars.margin,
    "margin",
    MAX_CREATE_TILESET_MARGIN,
  );
  assertGap(
    scalars.spacing,
    "spacing",
    MAX_CREATE_TILESET_SPACING,
  );
  const assertName = (
    value: string,
    field: string,
  ): void => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      !hasAtMostCodePoints(
        value,
        MAX_CREATE_TILESET_NAME_CODE_POINTS,
      )
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${field} must be a non-empty string of at most ${MAX_CREATE_TILESET_NAME_CODE_POINTS} Unicode code points.`,
      );
    }
  };
  assertName(scalars.name, "name");
  if (scalars.className !== null) {
    assertName(scalars.className, "className");
  }
}

/**
 * Tiled 1.12.2 `Tileset::columnCountForWidth`/`rowCountForHeight`
 * (`tileset.cpp`): integer division with a single margin subtracted. The
 * per-rect initialization loop yields exactly the same counts.
 */
export function computeAtlasGrid(input: {
  imageWidth: number;
  imageHeight: number;
  tileWidth: number;
  tileHeight: number;
  margin: number;
  spacing: number;
}): AtlasGrid {
  const columns = Math.floor(
    (input.imageWidth -
      input.margin +
      input.spacing) /
      (input.tileWidth + input.spacing),
  );
  const rows = Math.floor(
    (input.imageHeight -
      input.margin +
      input.spacing) /
      (input.tileHeight + input.spacing),
  );
  if (columns < 1 || rows < 1) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "The image is too small for even one tile with the requested tile size, margin, and spacing.",
      {
        imageWidth: input.imageWidth,
        imageHeight: input.imageHeight,
        tileWidth: input.tileWidth,
        tileHeight: input.tileHeight,
        margin: input.margin,
        spacing: input.spacing,
        columns: Math.max(columns, 0),
        rows: Math.max(rows, 0),
      },
    );
  }
  const usedWidth =
    input.margin +
    columns * input.tileWidth +
    (columns - 1) * input.spacing;
  const usedHeight =
    input.margin +
    rows * input.tileHeight +
    (rows - 1) * input.spacing;
  return {
    columns,
    rows,
    tileCount: columns * rows,
    unusedRightPixels:
      input.imageWidth - usedWidth,
    unusedBottomPixels:
      input.imageHeight - usedHeight,
  };
}

/**
 * Constructs the complete prospective TSJ document with members in the
 * alphabetical order Tiled's own QJson writer produces, using the frozen
 * 1.12.2 version stamps shared with tiled_create_map.
 */
export function buildTilesetDocument(input: {
  name: string;
  className: string | null;
  tileWidth: number;
  tileHeight: number;
  margin: number;
  spacing: number;
  imageSource: string;
  imageWidth: number;
  imageHeight: number;
  columns: number;
  tileCount: number;
}): JsonObject {
  return {
    ...(input.className === null
      ? {}
      : { class: input.className }),
    columns: input.columns,
    image: input.imageSource,
    imageheight: input.imageHeight,
    imagewidth: input.imageWidth,
    margin: input.margin,
    name: input.name,
    spacing: input.spacing,
    tilecount: input.tileCount,
    tiledversion: "1.12.2",
    tileheight: input.tileHeight,
    tilewidth: input.tileWidth,
    type: "tileset",
    version: "1.10",
  };
}

export function tilesetCreatePlanId(
  value: Omit<TilesetCreatePlan, "id">,
): string {
  const canonical = stableJson(
    value as unknown as JsonValue,
  );
  return `changeset:${createHash("sha256")
    .update(TILESET_CREATE_PLAN_HASH_DOMAIN)
    .update(canonical)
    .digest("hex")}`;
}

export function assertTilesetCreatePlan(
  plan: TilesetCreatePlan,
): void {
  if (
    typeof plan !== "object" ||
    plan === null ||
    Array.isArray(plan)
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The tileset create plan is malformed.",
    );
  }
  const keys = Object.keys(plan).sort();
  const expected = [
    "baseRevision",
    "className",
    "id",
    "image",
    "kind",
    "margin",
    "name",
    "spacing",
    "summary",
    "tileHeight",
    "tileWidth",
    "tilesetPath",
    "version",
  ];
  if (
    keys.length !== expected.length ||
    keys.some(
      (key, index) => key !== expected[index],
    ) ||
    plan.kind !== "tilesetCreate" ||
    plan.version !== 1 ||
    typeof plan.id !== "string" ||
    typeof plan.tilesetPath !== "string" ||
    typeof plan.baseRevision !== "string" ||
    typeof plan.name !== "string" ||
    (plan.className !== null &&
      typeof plan.className !== "string") ||
    typeof plan.image !== "object" ||
    plan.image === null ||
    typeof plan.summary !== "object" ||
    plan.summary === null
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The tileset create plan is malformed.",
    );
  }
  validateCreateTilesetScalars({
    name: plan.name,
    className: plan.className,
    tileWidth: plan.tileWidth,
    tileHeight: plan.tileHeight,
    margin: plan.margin,
    spacing: plan.spacing,
  });
  const { id, ...unsigned } = plan;
  if (id !== tilesetCreatePlanId(unsigned)) {
    throw new TiledMcpError(
      "CHANGE_SET_TAMPERED",
      "The tileset create plan contents do not match its digest. Preview the creation again.",
    );
  }
}
