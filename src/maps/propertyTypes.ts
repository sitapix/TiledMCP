import { createHash } from "node:crypto";

import { TiledMcpError } from "../errors.js";
import {
  stableJson,
  type JsonObject,
  type JsonValue,
} from "../formats/json.js";

export const MAX_PROPERTY_TYPES = 1_000;
export const MAX_PROPERTY_TYPE_OPERATIONS = 16;
export const MAX_CLASS_MEMBERS = 256;
export const MAX_ENUM_VALUES = 256;
export const MAX_PROPERTY_TYPE_NAME_CODE_POINTS = 256;

const PROPERTY_TYPE_EDIT_PLAN_HASH_DOMAIN =
  "tiledmcp/property-type-edit-plan/v1\0";
const COLOR_PATTERN =
  /^#[0-9a-fA-F]{8}$/u;
const CLASS_USE_AS = [
  "property",
  "map",
  "layer",
  "object",
  "tile",
  "tileset",
  "wangcolor",
  "wangset",
  "project",
] as const;
const MEMBER_TYPES = [
  "string",
  "int",
  "float",
  "bool",
  "color",
  "file",
  "object",
] as const;

export interface ClassMemberDefinition {
  name: string;
  type: (typeof MEMBER_TYPES)[number];
  value: JsonValue;
  /** Reference to another defined enum/class type by name. */
  propertyType?: string | undefined;
}

export type PropertyTypeOperation =
  | {
      type: "upsertClass";
      name: string;
      /** #aarrggbb; Tiled's class default is #ffa0a0a4. */
      color?: string | undefined;
      drawFill?: boolean | undefined;
      useAs?:
        | Array<(typeof CLASS_USE_AS)[number]>
        | undefined;
      members: ClassMemberDefinition[];
    }
  | {
      type: "upsertEnum";
      name: string;
      storageType: "string" | "int";
      values: string[];
      valuesAsFlags?: boolean | undefined;
    }
  | {
      type: "deleteType";
      name: string;
    };

export interface PropertyTypeEditSummary {
  operationCount: number;
  upserted: Array<{
    name: string;
    kind: "class" | "enum";
    id: number;
    created: boolean;
  }>;
  deleted: Array<{ name: string; id: number }>;
  typeCountBefore: number;
  typeCountAfter: number;
  wouldChange: boolean;
}

export interface PropertyTypeEditPlan {
  kind: "propertyTypeEdit";
  version: 1;
  id: string;
  projectFilePath: string;
  /** Raw SHA-256 revision of the .tiled-project file (CAS). */
  baseRevision: string;
  operations: PropertyTypeOperation[];
  summary: PropertyTypeEditSummary;
}

export function propertyTypeEditPlanId(
  value: Omit<PropertyTypeEditPlan, "id">,
): string {
  return `changeset:${createHash("sha256")
    .update(
      PROPERTY_TYPE_EDIT_PLAN_HASH_DOMAIN,
    )
    .update(stableJson(value))
    .digest("hex")}`;
}

export function assertPropertyTypeEditPlan(
  plan: PropertyTypeEditPlan,
): void {
  if (
    typeof plan !== "object" ||
    plan === null ||
    plan.kind !== "propertyTypeEdit" ||
    plan.version !== 1 ||
    typeof plan.id !== "string" ||
    typeof plan.projectFilePath !== "string" ||
    typeof plan.baseRevision !== "string" ||
    !Array.isArray(plan.operations) ||
    typeof plan.summary !== "object" ||
    plan.summary === null
  ) {
    throw new TiledMcpError(
      "INVALID_CHANGE_SET",
      "The property type edit plan is malformed.",
    );
  }
  const { id, ...unsigned } = plan;
  if (id !== propertyTypeEditPlanId(unsigned)) {
    throw new TiledMcpError(
      "CHANGE_SET_TAMPERED",
      "The property type edit plan contents do not match its digest. Preview the operations again.",
    );
  }
}

/**
 * Bounded projection of a .tiled-project's propertyTypes array. Entries
 * are returned verbatim minus unknown-shape rejection: every entry must
 * be a class or enum object with an integer id and a non-empty name.
 */
export function projectPropertyTypes(
  document: JsonObject,
  projectFilePath: string,
): Array<Record<string, unknown>> {
  const raw = document.propertyTypes ?? [];
  if (!Array.isArray(raw)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${projectFilePath}.propertyTypes must be an array.`,
      { path: projectFilePath },
    );
  }
  if (raw.length > MAX_PROPERTY_TYPES) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${projectFilePath} defines more than ${MAX_PROPERTY_TYPES} property types.`,
      {
        path: projectFilePath,
        limit: MAX_PROPERTY_TYPES,
      },
    );
  }
  return raw.map((value, index) => {
    const entry = requireTypeEntry(
      value,
      index,
      projectFilePath,
    );
    return { ...entry };
  });
}

/**
 * Applies upsert/delete operations sequentially. Upserts replace an
 * existing same-name definition in place (keeping its id) or append with
 * id = max(existing) + 1, mirroring Tiled's ++mNextId allocation seeded
 * from the loaded maximum. Deleting a type that another definition still
 * references through a member's propertyType fails closed; references
 * from maps and tilesets are not scanned, which the caller must surface.
 */
export function applyPropertyTypeOperations(
  document: JsonObject,
  projectFilePath: string,
  operations: readonly PropertyTypeOperation[],
): {
  summary: PropertyTypeEditSummary;
} {
  if (
    !Array.isArray(operations) ||
    operations.length === 0 ||
    operations.length >
      MAX_PROPERTY_TYPE_OPERATIONS
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `operations must contain between 1 and ${MAX_PROPERTY_TYPE_OPERATIONS} property type edits.`,
      {
        limit: MAX_PROPERTY_TYPE_OPERATIONS,
      },
    );
  }
  const rawTypes = document.propertyTypes ?? [];
  if (!Array.isArray(rawTypes)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${projectFilePath}.propertyTypes must be an array.`,
      { path: projectFilePath },
    );
  }
  const types = rawTypes as JsonValue[];
  const typeCountBefore = types.length;
  for (const [
    index,
    value,
  ] of types.entries()) {
    requireTypeEntry(
      value,
      index,
      projectFilePath,
    );
  }

  const upserted: PropertyTypeEditSummary["upserted"] =
    [];
  const deleted: PropertyTypeEditSummary["deleted"] =
    [];
  const seenNames = new Set<string>();
  let wouldChange = false;

  for (const [
    operationIndex,
    operation,
  ] of operations.entries()) {
    const context = `operations[${operationIndex}]`;
    if (
      typeof operation !== "object" ||
      operation === null
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} must be an object.`,
      );
    }
    const name = requireName(
      operation.name,
      `${context}.name`,
    );
    if (seenNames.has(name)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${context} repeats type name ${JSON.stringify(name)}.`,
      );
    }
    seenNames.add(name);
    const existingIndex = types.findIndex(
      (value) =>
        (value as JsonObject).name === name,
    );

    if (operation.type === "deleteType") {
      if (existingIndex < 0) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${context} deletes unknown type ${JSON.stringify(name)}.`,
        );
      }
      const referrer = types.find(
        (value, index) =>
          index !== existingIndex &&
          classReferencesType(
            value as JsonObject,
            name,
          ),
      );
      if (referrer !== undefined) {
        throw new TiledMcpError(
          "FILE_IN_USE",
          `Type ${JSON.stringify(name)} is still referenced by ${JSON.stringify((referrer as JsonObject).name)}; remove that member first.`,
          {
            name,
            referencedBy: (
              referrer as JsonObject
            ).name,
          },
        );
      }
      const removed = types.splice(
        existingIndex,
        1,
      )[0] as JsonObject;
      deleted.push({
        name,
        id: removed.id as number,
      });
      wouldChange = true;
      continue;
    }

    const entry =
      operation.type === "upsertClass"
        ? buildClassEntry(operation, context)
        : buildEnumEntry(operation, context);
    if (existingIndex >= 0) {
      const existing = types[
        existingIndex
      ] as JsonObject;
      entry.id = existing.id as number;
      const changed =
        stableJson(entry as JsonValue) !==
        stableJson(existing as JsonValue);
      types[existingIndex] = entry;
      upserted.push({
        name,
        kind:
          operation.type === "upsertClass"
            ? "class"
            : "enum",
        id: entry.id as number,
        created: false,
      });
      wouldChange = wouldChange || changed;
    } else {
      if (types.length >= MAX_PROPERTY_TYPES) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `${projectFilePath} would exceed ${MAX_PROPERTY_TYPES} property types.`,
          { limit: MAX_PROPERTY_TYPES },
        );
      }
      // Tiled allocates ++mNextId with mNextId seeded from the maximum
      // loaded id.
      let nextId = 1;
      for (const value of types) {
        const existingId = (
          value as JsonObject
        ).id;
        if (
          typeof existingId === "number" &&
          existingId >= nextId
        ) {
          nextId = existingId + 1;
        }
      }
      entry.id = nextId;
      types.push(entry);
      upserted.push({
        name,
        kind:
          operation.type === "upsertClass"
            ? "class"
            : "enum",
        id: nextId,
        created: true,
      });
      wouldChange = true;
    }
  }

  if (document.propertyTypes === undefined) {
    document.propertyTypes = types;
  }

  return {
    summary: {
      operationCount: operations.length,
      upserted,
      deleted,
      typeCountBefore,
      typeCountAfter: types.length,
      wouldChange,
    },
  };
}

function classReferencesType(
  entry: JsonObject,
  name: string,
): boolean {
  if (
    entry.type !== "class" ||
    !Array.isArray(entry.members)
  ) {
    return false;
  }
  return entry.members.some(
    (member) =>
      typeof member === "object" &&
      member !== null &&
      (member as JsonObject).propertyType ===
        name,
  );
}

function buildClassEntry(
  operation: Extract<
    PropertyTypeOperation,
    { type: "upsertClass" }
  >,
  context: string,
): JsonObject {
  const color = operation.color ?? "#ffa0a0a4";
  if (!COLOR_PATTERN.test(color)) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.color must be #aarrggbb.`,
    );
  }
  const useAs = operation.useAs ?? [
    ...CLASS_USE_AS,
  ];
  if (
    !Array.isArray(useAs) ||
    useAs.length === 0 ||
    useAs.some(
      (entry) =>
        !(
          CLASS_USE_AS as readonly string[]
        ).includes(entry),
    ) ||
    new Set(useAs).size !== useAs.length
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.useAs must list distinct values from: ${CLASS_USE_AS.join(", ")}.`,
    );
  }
  if (
    !Array.isArray(operation.members) ||
    operation.members.length > MAX_CLASS_MEMBERS
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.members must be an array of at most ${MAX_CLASS_MEMBERS} members.`,
      { limit: MAX_CLASS_MEMBERS },
    );
  }
  const memberNames = new Set<string>();
  const members = operation.members.map(
    (member, memberIndex) => {
      const memberContext = `${context}.members[${memberIndex}]`;
      const memberName = requireName(
        member.name,
        `${memberContext}.name`,
      );
      if (memberNames.has(memberName)) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${memberContext} repeats member name ${JSON.stringify(memberName)}.`,
        );
      }
      memberNames.add(memberName);
      if (
        !(
          MEMBER_TYPES as readonly string[]
        ).includes(member.type)
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${memberContext}.type must be one of: ${MEMBER_TYPES.join(", ")}.`,
        );
      }
      validateMemberValue(
        member.type,
        member.value,
        memberContext,
      );
      return {
        name: memberName,
        type: member.type,
        value: member.value,
        ...(member.propertyType === undefined
          ? {}
          : {
              propertyType: requireName(
                member.propertyType,
                `${memberContext}.propertyType`,
              ),
            }),
      };
    },
  );
  // Member order mirrors ClassPropertyType::toJson.
  return {
    type: "class",
    id: 0,
    name: operation.name,
    members,
    color,
    drawFill: operation.drawFill ?? true,
    useAs,
  };
}

function buildEnumEntry(
  operation: Extract<
    PropertyTypeOperation,
    { type: "upsertEnum" }
  >,
  context: string,
): JsonObject {
  if (
    operation.storageType !== "string" &&
    operation.storageType !== "int"
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.storageType must be string or int.`,
    );
  }
  if (
    !Array.isArray(operation.values) ||
    operation.values.length === 0 ||
    operation.values.length > MAX_ENUM_VALUES ||
    operation.values.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0,
    ) ||
    new Set(operation.values).size !==
      operation.values.length
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.values must list 1 to ${MAX_ENUM_VALUES} distinct non-empty strings.`,
      { limit: MAX_ENUM_VALUES },
    );
  }
  return {
    type: "enum",
    id: 0,
    name: operation.name,
    storageType: operation.storageType,
    values: [...operation.values],
    valuesAsFlags:
      operation.valuesAsFlags ?? false,
  };
}

function validateMemberValue(
  type: (typeof MEMBER_TYPES)[number],
  value: JsonValue,
  context: string,
): void {
  const ok =
    type === "string" || type === "file"
      ? typeof value === "string"
      : type === "int"
        ? Number.isSafeInteger(value)
        : type === "float"
          ? typeof value === "number" &&
            Number.isFinite(value)
          : type === "bool"
            ? typeof value === "boolean"
            : type === "color"
              ? typeof value === "string" &&
                (value === "" ||
                  /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u.test(
                    value,
                  ))
              : Number.isSafeInteger(value) &&
                (value as number) >= 0;
  if (!ok) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context}.value does not satisfy member type ${type}.`,
      { type },
    );
  }
}

function requireName(
  value: unknown,
  context: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length >
      MAX_PROPERTY_TYPE_NAME_CODE_POINTS
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be a non-empty string of at most ${MAX_PROPERTY_TYPE_NAME_CODE_POINTS} code points.`,
    );
  }
  return value;
}

function requireTypeEntry(
  value: JsonValue,
  index: number,
  projectFilePath: string,
): JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ((value as JsonObject).type !== "class" &&
      (value as JsonObject).type !== "enum") ||
    !Number.isSafeInteger(
      (value as JsonObject).id,
    ) ||
    typeof (value as JsonObject).name !==
      "string"
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${projectFilePath}.propertyTypes[${index}] is not a recognizable class or enum definition.`,
      { path: projectFilePath, index },
    );
  }
  return value as JsonObject;
}
