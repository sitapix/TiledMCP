import { createHash } from "node:crypto";

import { TiledMcpError } from "../errors.js";
import type {
  JsonObject,
  JsonValue,
} from "../formats/json.js";
import { stableJson } from "../formats/json.js";
import type { JsonObjectMemberPatch } from "../formats/jsonSourcePatch.js";
import {
  type PropertiesPatch,
  applyPropertiesPatch,
  assertExactKeys,
} from "./propertyEdits.js";

const TILESET_PROPERTY_EDIT_PLAN_HASH_DOMAIN =
  "tiledmcp/tileset-property-edit-plan/v1\0";

export const UPDATE_TILESET_WARNING =
  "This rewrites tileset-level members inside one external tileset. It never changes the atlas image or referencing maps, but pending map change sets pinned to the old tileset revision will conflict after apply. Without an `atlas` field it also leaves tile geometry, tile count and GID layout untouched; with one it re-cuts the grid over the same image, which changes tilecount and therefore the GID span every referencing map reads -- allowed only once the service has proven the pinned map still resolves and no other project asset references this tileset.";

export const MAX_TILESET_NAME_CODE_POINTS = 1_024;
export const MAX_TILESET_CLASS_NAME_CODE_POINTS = 1_024;
export const MAX_TILESET_OFFSET = 1_000_000_000;
export const MAX_TILESET_GRID_EDGE = 1_000_000_000;

export const TILESET_OBJECT_ALIGNMENTS = [
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
] as const;
export const TILESET_RENDER_SIZES = [
  "tile",
  "grid",
] as const;
export const TILESET_FILL_MODES = [
  "stretch",
  "preserve-aspect-fit",
] as const;
export const TILESET_GRID_ORIENTATIONS = [
  "orthogonal",
  "isometric",
] as const;

export type TilesetObjectAlignment =
  (typeof TILESET_OBJECT_ALIGNMENTS)[number];
export type TilesetRenderSize =
  (typeof TILESET_RENDER_SIZES)[number];
export type TilesetFillMode =
  (typeof TILESET_FILL_MODES)[number];
export type TilesetGridOrientation =
  (typeof TILESET_GRID_ORIENTATIONS)[number];

export interface TilesetOffsetInput {
  x: number;
  y: number;
}

export interface TilesetTransformationsInput {
  hFlip: boolean;
  vFlip: boolean;
  rotate: boolean;
  preferUntransformed: boolean;
}

export interface TilesetGridInput {
  orientation: TilesetGridOrientation;
  width: number;
  height: number;
}

/**
 * Tileset-level members this tool may rewrite.
 *
 * Every optional member except `name` and `properties` accepts `null`, which
 * removes the member and so restores Tiled's own default rather than writing a
 * default value explicitly -- the distinction is visible in the file and the
 * editor, so it has to be expressible.
 *
 * `image` is deliberately absent: pointing a tileset at different art is
 * `tiled_replace_tileset_in_map`'s job, one map at a time and with that map's
 * GIDs surveyed.
 *
 * `atlas` is the one geometry field, and it is guarded rather than free.
 * Re-cutting the grid changes `tilecount`, which moves the GID span every
 * referencing map depends on -- so the service proves the pinned map survives
 * the new tile count and that no other project asset references the tileset
 * before it will write one.
 */
export interface TilesetPropertyPatch {
  name?: string | undefined;
  className?: string | null | undefined;
  tileOffset?:
    | TilesetOffsetInput
    | null
    | undefined;
  objectAlignment?:
    | TilesetObjectAlignment
    | null
    | undefined;
  tileRenderSize?:
    | TilesetRenderSize
    | null
    | undefined;
  fillMode?: TilesetFillMode | null | undefined;
  transformations?:
    | TilesetTransformationsInput
    | null
    | undefined;
  grid?: TilesetGridInput | null | undefined;
  /**
   * Re-cuts an atlas tileset's grid over its existing image.
   *
   * `columns` and `tileCount` are not caller input: the service reads the
   * image, computes them with Tiled's own formula and injects them before this
   * runs, the same way `createCollectionTile` has its pixel size injected.
   * Declared image dimensions are never trusted.
   */
  atlas?: AtlasResliceInput | undefined;
  properties?: PropertiesPatch | undefined;
}

export interface AtlasResliceInput {
  tileWidth: number;
  tileHeight: number;
  margin?: number;
  spacing?: number;
  /** Injected by the service from the real image. */
  columns?: number;
  /** Injected by the service from the real image. */
  tileCount?: number;
}

export const TILESET_PROPERTY_PATCH_FIELDS = [
  "name",
  "className",
  "tileOffset",
  "objectAlignment",
  "tileRenderSize",
  "fillMode",
  "transformations",
  "grid",
  "atlas",
  "properties",
] as const;
type TilesetPropertyPatchField =
  (typeof TILESET_PROPERTY_PATCH_FIELDS)[number];

/** Patch field -> the TSJ member it rewrites. */
const MEMBER_KEY_BY_FIELD: Record<
  Exclude<
    TilesetPropertyPatchField,
    "properties" | "atlas"
  >,
  string
> = {
  name: "name",
  className: "class",
  tileOffset: "tileoffset",
  objectAlignment: "objectalignment",
  tileRenderSize: "tilerendersize",
  fillMode: "fillmode",
  transformations: "transformations",
  grid: "grid",
};

export interface TilesetPropertyEditSummary {
  requestedFields: string[];
  changedFields: string[];
  propertiesSet?: number;
  propertiesRemoved?: number;
  wouldChange: boolean;
}

export interface TilesetPropertyEditPlan {
  kind: "tilesetPropertyEdit";
  version: 1;
  id: string;
  mapPath: string;
  tilesetPath: string;
  assetId: string;
  /**
   * Raw SHA-256 revision of the edited TSJ; the apply registry and the
   * document commit CAS both check this value.
   */
  baseRevision: string;
  mapRevision: string;
  patch: TilesetPropertyPatch;
  summary: TilesetPropertyEditSummary;
}

export interface UpdateTilesetOperationPreview {
  type: "updateTileset";
  destructive: false;
  warning: string;
  requestedFields: string[];
  changedFields: string[];
  propertiesSet?: number;
  propertiesRemoved?: number;
  wouldChange: boolean;
}

function assertBoundedString(
  value: unknown,
  limit: number,
  label: string,
): string {
  if (typeof value !== "string") {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${label} must be a string.`,
    );
  }
  if ([...value].length > limit) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${label} must be at most ${limit} code points.`,
      { limit },
    );
  }
  return value;
}

function assertBoundedInteger(
  value: unknown,
  limit: number,
  label: string,
  minimum = -limit,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > limit
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${label} must be an integer between ${minimum} and ${limit}.`,
      { minimum, maximum: limit },
    );
  }
  return value;
}

function assertMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${label} must be one of ${allowed.join(", ")}.`,
      { allowed: [...allowed] },
    );
  }
  return value as T;
}

/** Builds the TSJ value a patch field writes, or null to remove the member. */
function memberValueFor(
  field: Exclude<
    TilesetPropertyPatchField,
    "properties" | "atlas"
  >,
  patch: TilesetPropertyPatch,
): JsonValue | null {
  switch (field) {
    case "name":
      return assertBoundedString(
        patch.name,
        MAX_TILESET_NAME_CODE_POINTS,
        "patch.name",
      );
    case "className": {
      if (patch.className === null) {
        return null;
      }
      return assertBoundedString(
        patch.className,
        MAX_TILESET_CLASS_NAME_CODE_POINTS,
        "patch.className",
      );
    }
    case "tileOffset": {
      if (patch.tileOffset === null) {
        return null;
      }
      const offset = patch.tileOffset;
      if (
        typeof offset !== "object" ||
        offset === null ||
        Array.isArray(offset)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "patch.tileOffset must be an object or null.",
        );
      }
      assertExactKeys(
        offset,
        ["x", "y"],
        "patch.tileOffset",
      );
      return {
        x: assertBoundedInteger(
          offset.x,
          MAX_TILESET_OFFSET,
          "patch.tileOffset.x",
        ),
        y: assertBoundedInteger(
          offset.y,
          MAX_TILESET_OFFSET,
          "patch.tileOffset.y",
        ),
      };
    }
    case "objectAlignment":
      return patch.objectAlignment === null
        ? null
        : assertMember(
            patch.objectAlignment,
            TILESET_OBJECT_ALIGNMENTS,
            "patch.objectAlignment",
          );
    case "tileRenderSize":
      return patch.tileRenderSize === null
        ? null
        : assertMember(
            patch.tileRenderSize,
            TILESET_RENDER_SIZES,
            "patch.tileRenderSize",
          );
    case "fillMode":
      return patch.fillMode === null
        ? null
        : assertMember(
            patch.fillMode,
            TILESET_FILL_MODES,
            "patch.fillMode",
          );
    case "transformations": {
      if (patch.transformations === null) {
        return null;
      }
      const input = patch.transformations;
      if (
        typeof input !== "object" ||
        input === null ||
        Array.isArray(input)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "patch.transformations must be an object or null.",
        );
      }
      assertExactKeys(
        input,
        [
          "hFlip",
          "preferUntransformed",
          "rotate",
          "vFlip",
        ],
        "patch.transformations",
      );
      for (const key of [
        "hFlip",
        "vFlip",
        "rotate",
        "preferUntransformed",
      ] as const) {
        if (typeof input[key] !== "boolean") {
          throw new TiledMcpError(
            "INVALID_ARGUMENT",
            `patch.transformations.${key} must be a boolean.`,
          );
        }
      }
      // Tiled writes all four flags together; the TSJ member names are
      // lowercase and differ from the input's camelCase.
      return {
        hflip: input.hFlip,
        vflip: input.vFlip,
        rotate: input.rotate,
        preferuntransformed:
          input.preferUntransformed,
      };
    }
    case "grid": {
      if (patch.grid === null) {
        return null;
      }
      const grid = patch.grid;
      if (
        typeof grid !== "object" ||
        grid === null ||
        Array.isArray(grid)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          "patch.grid must be an object or null.",
        );
      }
      assertExactKeys(
        grid,
        ["height", "orientation", "width"],
        "patch.grid",
      );
      return {
        orientation: assertMember(
          grid.orientation,
          TILESET_GRID_ORIENTATIONS,
          "patch.grid.orientation",
        ),
        width: assertBoundedInteger(
          grid.width,
          MAX_TILESET_GRID_EDGE,
          "patch.grid.width",
          1,
        ),
        height: assertBoundedInteger(
          grid.height,
          MAX_TILESET_GRID_EDGE,
          "patch.grid.height",
          1,
        ),
      };
    }
  }
}

/**
 * Validates the patch against a cloned TSJ document, mutates the clone into
 * the prospective state, and reports both the bounded summary and the minimal
 * source member patches.
 *
 * Only members the patch actually changes are reported: re-setting a member to
 * the value it already holds is a no-op, so an unchanged patch produces
 * `wouldChange: false` and the caller fails closed rather than committing a
 * byte-identical rewrite.
 */
export function applyTilesetPropertyPatch(
  document: JsonObject,
  patch: TilesetPropertyPatch,
  tilesetPath: string,
): {
  summary: TilesetPropertyEditSummary;
  memberPatches: JsonObjectMemberPatch[];
} {
  if (
    typeof patch !== "object" ||
    patch === null ||
    Array.isArray(patch)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      "patch must be an object.",
    );
  }
  assertExactKeys(
    patch,
    [...TILESET_PROPERTY_PATCH_FIELDS],
    "patch",
    // Every field is optional; only unknown keys are rejected here, and the
    // at-least-one requirement is enforced below with a clearer message.
    true,
  );

  const requestedFields =
    TILESET_PROPERTY_PATCH_FIELDS.filter(
      (field) => patch[field] !== undefined,
    );
  if (requestedFields.length === 0) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `patch must request at least one of ${TILESET_PROPERTY_PATCH_FIELDS.join(", ")}.`,
    );
  }

  const changedFields: string[] = [];
  const memberPatches: JsonObjectMemberPatch[] =
    [];
  let propertiesSet: number | undefined;
  let propertiesRemoved: number | undefined;

  for (const field of requestedFields) {
    if (field === "properties") {
      const propertiesPatch =
        patch.properties as PropertiesPatch;
      const change = applyPropertiesPatch(
        document,
        propertiesPatch,
        `${tilesetPath}.properties`,
        { path: tilesetPath },
      );
      propertiesSet = change.propertiesSet;
      propertiesRemoved =
        change.propertiesRemoved;
      if (change.changed) {
        changedFields.push("properties");
        for (const key of change.memberKeys) {
          memberPatches.push({
            path: [],
            key,
          });
        }
      }
      continue;
    }
    if (field === "atlas") {
      // One field, six members: re-cutting the grid rewrites the tile size,
      // margin and spacing the caller asked for, plus the `columns` and
      // `tilecount` those imply. Tiled derives the latter two from the image,
      // so writing them independently would let the file disagree with itself.
      const atlas = patch.atlas as AtlasResliceInput;
      if (
        atlas.columns === undefined ||
        atlas.tileCount === undefined
      ) {
        throw new TiledMcpError(
          "INVALID_CHANGE_SET",
          "The atlas re-slice reached the writer without its resolved grid; columns and tileCount are computed from the image, never supplied.",
        );
      }
      const margin = atlas.margin ?? 0;
      const spacing = atlas.spacing ?? 0;
      const members: Array<[string, JsonValue]> = [
        ["tilewidth", atlas.tileWidth],
        ["tileheight", atlas.tileHeight],
        ["margin", margin],
        ["spacing", spacing],
        ["columns", atlas.columns],
        ["tilecount", atlas.tileCount],
      ];
      let changed = false;
      for (const [key, value] of members) {
        if (document[key] === value) {
          continue;
        }
        document[key] = value;
        memberPatches.push({ path: [], key });
        changed = true;
      }
      if (changed) {
        changedFields.push("atlas");
      }
      continue;
    }
    const memberKey =
      MEMBER_KEY_BY_FIELD[
        field as Exclude<
          TilesetPropertyPatchField,
          "properties" | "atlas"
        >
      ];
    const nextValue = memberValueFor(
      field,
      patch,
    );
    const previous = document[memberKey];
    if (nextValue === null) {
      if (previous === undefined) {
        continue;
      }
      delete document[memberKey];
      changedFields.push(field);
      memberPatches.push({
        path: [],
        key: memberKey,
      });
      continue;
    }
    if (
      previous !== undefined &&
      stableJson(previous) ===
        stableJson(nextValue)
    ) {
      continue;
    }
    document[memberKey] = nextValue;
    changedFields.push(field);
    memberPatches.push({
      path: [],
      key: memberKey,
    });
  }

  return {
    summary: {
      requestedFields: [...requestedFields],
      changedFields,
      ...(propertiesSet === undefined
        ? {}
        : { propertiesSet }),
      ...(propertiesRemoved === undefined
        ? {}
        : { propertiesRemoved }),
      wouldChange: changedFields.length > 0,
    },
    memberPatches,
  };
}

export function updateTilesetOperationPreview(
  summary: TilesetPropertyEditSummary,
): UpdateTilesetOperationPreview {
  return {
    type: "updateTileset",
    destructive: false,
    warning: UPDATE_TILESET_WARNING,
    requestedFields: [
      ...summary.requestedFields,
    ],
    changedFields: [...summary.changedFields],
    ...(summary.propertiesSet === undefined
      ? {}
      : { propertiesSet: summary.propertiesSet }),
    ...(summary.propertiesRemoved === undefined
      ? {}
      : {
          propertiesRemoved:
            summary.propertiesRemoved,
        }),
    wouldChange: summary.wouldChange,
  };
}

export function tilesetPropertyEditPlanId(
  value: Omit<TilesetPropertyEditPlan, "id">,
): string {
  const canonical = stableJson(
    value,
  );
  return `changeset:${createHash("sha256")
    .update(
      TILESET_PROPERTY_EDIT_PLAN_HASH_DOMAIN,
    )
    .update(canonical)
    .digest("hex")}`;
}

export function assertTilesetPropertyEditPlan(
  plan: TilesetPropertyEditPlan,
): void {
  assertExactKeys(
    plan,
    [
      "assetId",
      "baseRevision",
      "id",
      "kind",
      "mapPath",
      "mapRevision",
      "patch",
      "summary",
      "tilesetPath",
      "version",
    ],
    "tileset property edit plan",
  );
  if (
    plan.kind !== "tilesetPropertyEdit" ||
    plan.version !== 1 ||
    typeof plan.id !== "string" ||
    typeof plan.mapPath !== "string" ||
    typeof plan.tilesetPath !== "string" ||
    typeof plan.assetId !== "string" ||
    typeof plan.baseRevision !== "string" ||
    typeof plan.mapRevision !== "string" ||
    typeof plan.patch !== "object" ||
    plan.patch === null ||
    Array.isArray(plan.patch) ||
    typeof plan.summary !== "object" ||
    plan.summary === null
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The tileset property edit plan is malformed.",
    );
  }
  const { id, ...unsigned } = plan;
  if (id !== tilesetPropertyEditPlanId(unsigned)) {
    throw new TiledMcpError(
      "CHANGE_SET_TAMPERED",
      "The tileset property edit plan contents do not match its digest. Preview the patch again.",
    );
  }
}
