import { TiledMcpError } from "../errors.js";
import {
  stableJson,
  type JsonObject,
  type JsonValue,
} from "../formats/json.js";

export const MAX_PROPERTY_SETS_PER_TARGET = 32;
export const MAX_PROPERTY_REMOVES_PER_TARGET = 32;
export const MAX_PROPERTIES_PER_TARGET = 128;
export const MAX_PROPERTY_NAME_CODE_POINTS = 256;
export const MAX_PROPERTY_VALUE_CODE_POINTS = 1_024;
export const PROPERTY_WRITE_TYPES = [
  "string",
  "int",
  "float",
  "bool",
  "color",
  "file",
] as const;

const PROPERTY_COLOR_PATTERN =
  /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const KNOWN_PROPERTY_TYPES = new Set([
  ...PROPERTY_WRITE_TYPES,
  "object",
  "class",
  "list",
]);

export type PropertyWriteType =
  (typeof PROPERTY_WRITE_TYPES)[number];

export interface PropertyWrite {
  name: string;
  type: PropertyWriteType;
  value: string | number | boolean;
}

export interface PropertiesPatch {
  set?: PropertyWrite[] | undefined;
  remove?: string[] | undefined;
}

/**
 * Structured error details identifying the property owner, e.g.
 * `{ path, tileId }` for tileset tiles or `{ path, objectId }` for map
 * objects. Spread into every error raised by `applyPropertiesPatch`.
 */
export type PropertyTargetDetails = Record<
  string,
  JsonValue
>;

export function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
  subsetOnly = false,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be an object.`,
    );
  }
  const keys = Object.keys(value).sort();
  const allowed = new Set(expected);
  const unknown = keys.find(
    (key) => !allowed.has(key),
  );
  if (unknown !== undefined) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} contains unsupported field ${unknown}.`,
    );
  }
  if (
    !subsetOnly &&
    keys.join("\0") !==
      [...expected].sort().join("\0")
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must contain exactly ${expected.join(", ")}.`,
    );
  }
}

export function hasAtMostCodePoints(
  value: string,
  limit: number,
): boolean {
  let count = 0;
  for (const _ of value) {
    count += 1;
    if (count > limit) {
      return false;
    }
  }
  return true;
}

export function validatePropertiesPatch(
  patch: PropertiesPatch,
  context: string,
): void {
  if (
    typeof patch !== "object" ||
    patch === null ||
    Array.isArray(patch)
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must be an object.`,
    );
  }
  assertExactKeys(
    patch as unknown as Record<string, unknown>,
    ["remove", "set"],
    context,
    true,
  );
  const sets = patch.set ?? [];
  const removes = patch.remove ?? [];
  if (
    !Array.isArray(sets) ||
    !Array.isArray(removes) ||
    sets.length + removes.length === 0 ||
    sets.length > MAX_PROPERTY_SETS_PER_TARGET ||
    removes.length >
      MAX_PROPERTY_REMOVES_PER_TARGET
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must contain at least one entry, at most ${MAX_PROPERTY_SETS_PER_TARGET} set entries, and at most ${MAX_PROPERTY_REMOVES_PER_TARGET} removals.`,
    );
  }
  const seenNames = new Set<string>();
  const validateName = (
    name: unknown,
    nameContext: string,
  ): string => {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      !hasAtMostCodePoints(
        name,
        MAX_PROPERTY_NAME_CODE_POINTS,
      )
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${nameContext} must be a non-empty string of at most ${MAX_PROPERTY_NAME_CODE_POINTS} Unicode code points.`,
      );
    }
    if (seenNames.has(name)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${nameContext} repeats property name ${JSON.stringify(name)}.`,
      );
    }
    seenNames.add(name);
    return name;
  };
  for (const [index, write] of sets.entries()) {
    const writeContext = `${context}.set[${index}]`;
    assertExactKeys(
      write as unknown as Record<string, unknown>,
      ["name", "type", "value"],
      writeContext,
    );
    validateName(write.name, `${writeContext}.name`);
    if (
      !(
        PROPERTY_WRITE_TYPES as readonly string[]
      ).includes(write.type)
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${writeContext}.type must be one of ${PROPERTY_WRITE_TYPES.join(", ")}.`,
      );
    }
    validatePropertyValue(
      write.type,
      write.value,
      `${writeContext}.value`,
    );
  }
  for (const [index, name] of removes.entries()) {
    validateName(
      name,
      `${context}.remove[${index}]`,
    );
  }
}

function validatePropertyValue(
  type: PropertyWriteType,
  value: unknown,
  context: string,
): void {
  switch (type) {
    case "string":
    case "file":
      if (
        typeof value === "string" &&
        hasAtMostCodePoints(
          value,
          MAX_PROPERTY_VALUE_CODE_POINTS,
        )
      ) {
        return;
      }
      break;
    case "color":
      if (
        typeof value === "string" &&
        PROPERTY_COLOR_PATTERN.test(value)
      ) {
        return;
      }
      break;
    case "int":
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value)
      ) {
        return;
      }
      break;
    case "float":
      if (
        typeof value === "number" &&
        Number.isFinite(value)
      ) {
        return;
      }
      break;
    case "bool":
      if (typeof value === "boolean") {
        return;
      }
      break;
  }
  throw new TiledMcpError(
    "INVALID_ARGUMENT",
    `${context} is inconsistent with the declared property type ${type}.`,
    { type },
  );
}

/**
 * Canonical UTF-8 byte size of a validated patch, used for change-set-wide
 * payload budgets. Counts the stable serialization of every set entry plus
 * every removed name.
 */
export function measurePropertiesPatchBytes(
  patch: PropertiesPatch,
): number {
  let bytes = 0;
  for (const write of patch.set ?? []) {
    bytes += Buffer.byteLength(
      stableJson({
        name: write.name,
        type: write.type,
        value: write.value,
      } as JsonValue),
      "utf8",
    );
  }
  for (const name of patch.remove ?? []) {
    bytes += Buffer.byteLength(
      JSON.stringify(name),
      "utf8",
    );
  }
  return bytes;
}

export function applyPropertiesPatch(
  target: JsonObject,
  patch: PropertiesPatch,
  label: string,
  details: PropertyTargetDetails,
): {
  changed: boolean;
  memberKeys: string[];
  propertiesSet: number;
  propertiesRemoved: number;
} {
  const before = target.properties;
  if (
    before !== undefined &&
    !Array.isArray(before)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${label} must be an array.`,
      { ...details },
    );
  }
  const entries = (before ?? []) as JsonValue[];
  // Serialize the before-state up front: existing entries are later mutated
  // in place, so a deferred comparison would observe its own writes.
  const beforeSnapshot = stableJson(
    (before ?? null) as JsonValue,
  );
  const byName = new Map<string, number>();
  let sortedByName = true;
  let previousName: string | undefined;
  for (const [index, value] of entries.entries()) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${label}[${index}] must be an object.`,
        { ...details, index },
      );
    }
    const entry = value as JsonObject;
    const name = entry.name;
    if (typeof name !== "string") {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${label}[${index}].name must be a string.`,
        { ...details, index },
      );
    }
    if (byName.has(name)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${label} contains duplicate property name ${JSON.stringify(name)}.`,
        { ...details },
      );
    }
    byName.set(name, index);
    if (
      previousName !== undefined &&
      !(previousName < name)
    ) {
      sortedByName = false;
    }
    previousName = name;
  }

  const targetedNames = [
    ...(patch.set ?? []).map((write) => write.name),
    ...(patch.remove ?? []),
  ];
  for (const name of targetedNames) {
    const index = byName.get(name);
    if (index === undefined) {
      continue;
    }
    const entry = entries[index] as JsonObject;
    const typeName =
      entry.type === undefined
        ? "string"
        : entry.type;
    if (
      typeof typeName !== "string" ||
      !KNOWN_PROPERTY_TYPES.has(typeName)
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${label} property ${JSON.stringify(name)} has an unrecognized type.`,
        { ...details, name },
      );
    }
    if (
      entry.propertytype !== undefined ||
      !(
        PROPERTY_WRITE_TYPES as readonly string[]
      ).includes(typeName)
    ) {
      throw new TiledMcpError(
        "UNSUPPORTED_PROPERTY_WRITE",
        `${label} property ${JSON.stringify(name)} uses a custom or complex type; only built-in scalar properties can be edited.`,
        {
          ...details,
          name,
          type: typeName,
          supportedTypes: [
            ...PROPERTY_WRITE_TYPES,
          ],
        },
      );
    }
  }

  const removeNames = new Set(patch.remove ?? []);
  let propertiesRemoved = 0;
  const working: JsonValue[] = [];
  for (const value of entries) {
    const entry = value as JsonObject;
    if (removeNames.has(entry.name as string)) {
      propertiesRemoved += 1;
      continue;
    }
    working.push(value);
  }
  let propertiesSet = 0;
  for (const write of patch.set ?? []) {
    const existingIndex = working.findIndex(
      (value) =>
        (value as JsonObject).name === write.name,
    );
    if (existingIndex >= 0) {
      const entry = working[
        existingIndex
      ] as JsonObject;
      const changedEntry =
        stableJson(
          (entry.type ?? "string") as JsonValue,
        ) !== stableJson(write.type) ||
        stableJson(
          (entry.value ?? null) as JsonValue,
        ) !== stableJson(write.value);
      if (changedEntry) {
        entry.type = write.type;
        entry.value = write.value;
        propertiesSet += 1;
      }
      continue;
    }
    if (!sortedByName) {
      throw new TiledMcpError(
        "UNSUPPORTED_PROPERTY_WRITE",
        `${label} is not sorted by property name, so a deterministic insertion position for ${JSON.stringify(write.name)} cannot be chosen.`,
        {
          ...details,
          name: write.name,
        },
      );
    }
    let insertAt = working.length;
    for (const [
      index,
      value,
    ] of working.entries()) {
      if (
        write.name <
        ((value as JsonObject).name as string)
      ) {
        insertAt = index;
        break;
      }
    }
    working.splice(insertAt, 0, {
      name: write.name,
      type: write.type,
      value: write.value,
    });
    propertiesSet += 1;
  }
  if (working.length > MAX_PROPERTIES_PER_TARGET) {
    throw new TiledMcpError(
      "RESULT_LIMIT_EXCEEDED",
      `${label} may contain at most ${MAX_PROPERTIES_PER_TARGET} properties.`,
      {
        limit: MAX_PROPERTIES_PER_TARGET,
        actual: working.length,
      },
    );
  }
  const changed =
    beforeSnapshot !==
    stableJson(
      (working.length === 0
        ? null
        : working) as JsonValue,
    );
  if (working.length === 0) {
    delete target.properties;
  } else {
    target.properties = working;
  }
  return {
    changed,
    memberKeys: ["properties"],
    propertiesSet,
    propertiesRemoved,
  };
}
