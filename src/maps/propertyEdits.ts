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

export const MAX_CLASS_MEMBER_WRITES_PER_TARGET = 16;
export const MAX_CLASS_MEMBER_PATH_DEPTH = 8;

/**
 * Overwrites one existing scalar member inside an existing class
 * property value, keeping its JSON type. Introducing missing members is
 * impossible without the project's class definitions (they carry the
 * Tiled type annotations), so absent members fail closed.
 */
export interface ClassMemberWrite {
  property: string;
  path: string[];
  value: string | number | boolean;
}

export interface PropertiesPatch {
  set?: PropertyWrite[] | undefined;
  remove?: string[] | undefined;
  setClassMembers?:
    | ClassMemberWrite[]
    | undefined;
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
    ["remove", "set", "setClassMembers"],
    context,
    true,
  );
  const sets = patch.set ?? [];
  const removes = patch.remove ?? [];
  const classWrites =
    patch.setClassMembers ?? [];
  if (
    !Array.isArray(sets) ||
    !Array.isArray(removes) ||
    !Array.isArray(classWrites) ||
    sets.length +
      removes.length +
      classWrites.length ===
      0 ||
    sets.length > MAX_PROPERTY_SETS_PER_TARGET ||
    removes.length >
      MAX_PROPERTY_REMOVES_PER_TARGET ||
    classWrites.length >
      MAX_CLASS_MEMBER_WRITES_PER_TARGET
  ) {
    throw new TiledMcpError(
      "INVALID_ARGUMENT",
      `${context} must contain at least one entry, at most ${MAX_PROPERTY_SETS_PER_TARGET} set entries, at most ${MAX_PROPERTY_REMOVES_PER_TARGET} removals, and at most ${MAX_CLASS_MEMBER_WRITES_PER_TARGET} class member writes.`,
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
  const seenMemberPaths = new Set<string>();
  for (const [
    index,
    write,
  ] of classWrites.entries()) {
    const writeContext = `${context}.setClassMembers[${index}]`;
    assertExactKeys(
      write as unknown as Record<
        string,
        unknown
      >,
      ["path", "property", "value"],
      writeContext,
    );
    if (
      typeof write.property !== "string" ||
      write.property.length === 0 ||
      !hasAtMostCodePoints(
        write.property,
        MAX_PROPERTY_NAME_CODE_POINTS,
      )
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${writeContext}.property must be a non-empty string of at most ${MAX_PROPERTY_NAME_CODE_POINTS} Unicode code points.`,
      );
    }
    if (seenNames.has(write.property)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${writeContext}.property targets ${JSON.stringify(write.property)}, which the same patch already sets or removes.`,
      );
    }
    if (
      !Array.isArray(write.path) ||
      write.path.length < 1 ||
      write.path.length >
        MAX_CLASS_MEMBER_PATH_DEPTH
    ) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${writeContext}.path must contain between 1 and ${MAX_CLASS_MEMBER_PATH_DEPTH} member names.`,
      );
    }
    for (const [
      segmentIndex,
      segment,
    ] of write.path.entries()) {
      if (
        typeof segment !== "string" ||
        segment.length === 0 ||
        !hasAtMostCodePoints(
          segment,
          MAX_PROPERTY_NAME_CODE_POINTS,
        )
      ) {
        throw new TiledMcpError(
          "INVALID_ARGUMENT",
          `${writeContext}.path[${segmentIndex}] must be a non-empty string of at most ${MAX_PROPERTY_NAME_CODE_POINTS} Unicode code points.`,
        );
      }
    }
    const value = write.value;
    const scalarOk =
      typeof value === "boolean" ||
      (typeof value === "number" &&
        Number.isFinite(value)) ||
      (typeof value === "string" &&
        hasAtMostCodePoints(
          value,
          MAX_PROPERTY_VALUE_CODE_POINTS,
        ));
    if (!scalarOk) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${writeContext}.value must be a bounded scalar.`,
      );
    }
    const memberKey = JSON.stringify([
      write.property,
      ...write.path,
    ]);
    if (seenMemberPaths.has(memberKey)) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${writeContext} repeats member path ${write.property}.${write.path.join(".")}.`,
      );
    }
    seenMemberPaths.add(memberKey);
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

export type ProjectedProperty =
  | {
      name: string;
      type: PropertyWriteType | "object";
      propertytype?: string;
      value: string | number | boolean;
    }
  | {
      name: string;
      type: "class" | "list";
      propertytype?: string;
      /**
       * Bounded raw JSON. Class members carry no per-member type
       * annotations in TMJ (their semantics live in the project's class
       * definitions); list elements are Tiled's typed
       * `{type, value[, propertytype]}` wrappers, passed through as-is.
       */
      value: JsonValue;
      valueSemantics:
        | "raw-untyped-members"
        | "typed-elements";
    }
  | {
      name: string;
      type: string;
      propertytype?: string;
      valueOmitted: true;
      reason: "oversized-value";
      valueCodePoints?: number;
      valueBytes?: number;
    };

export interface ProjectedProperties {
  entries: ProjectedProperty[];
  total: number;
  truncated: boolean;
}

/**
 * Read-only projection of a target's custom properties. Built-in scalar
 * values within the write-profile bounds are returned verbatim in document
 * order; class, enum (`propertytype`), list, and object entries — and
 * scalar strings beyond the value bound — are reported by name and type
 * with an explicit omission marker instead of an approximated value.
 * Malformed entries fail closed exactly like the write path.
 */
const MAX_COMPLEX_PROPERTY_VALUE_BYTES = 16_384;
const MAX_COMPLEX_PROPERTY_VALUE_DEPTH = 8;
const MAX_COMPLEX_PROPERTY_VALUE_NODES = 256;

/**
 * Bounds one nested class/list property value: canonical JSON bytes,
 * nesting depth, and total node count. Exceeding any budget reports the
 * whole entry as omitted rather than truncating inner members.
 */
function boundComplexPropertyValue(
  value: JsonValue,
  label: string,
  name: string,
  details: PropertyTargetDetails,
  typeName: "class" | "list",
): { omitted: boolean; valueBytes: number } {
  if (
    typeName === "class"
      ? typeof value !== "object" ||
        value === null ||
        Array.isArray(value)
      : !Array.isArray(value)
  ) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${label} property ${JSON.stringify(name)} has a value inconsistent with its declared type.`,
      { ...details, name, type: typeName },
    );
  }
  const valueBytes = Buffer.byteLength(
    JSON.stringify(value),
    "utf8",
  );
  if (
    valueBytes > MAX_COMPLEX_PROPERTY_VALUE_BYTES
  ) {
    return { omitted: true, valueBytes };
  }
  let nodes = 0;
  const walk = (
    current: JsonValue,
    depth: number,
  ): boolean => {
    nodes += 1;
    if (
      depth > MAX_COMPLEX_PROPERTY_VALUE_DEPTH ||
      nodes > MAX_COMPLEX_PROPERTY_VALUE_NODES
    ) {
      return false;
    }
    if (
      typeof current === "object" &&
      current !== null
    ) {
      const children = Array.isArray(current)
        ? current
        : Object.values(current);
      for (const child of children) {
        if (!walk(child, depth + 1)) {
          return false;
        }
      }
    }
    return true;
  };
  if (!walk(value, 1)) {
    return { omitted: true, valueBytes };
  }
  return { omitted: false, valueBytes };
}

export function projectScalarProperties(
  target: JsonObject,
  label: string,
  details: PropertyTargetDetails,
): ProjectedProperties {
  const before = target.properties;
  if (before === undefined) {
    return {
      entries: [],
      total: 0,
      truncated: false,
    };
  }
  if (!Array.isArray(before)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${label} must be an array.`,
      { ...details },
    );
  }
  const seenNames = new Set<string>();
  const entries: ProjectedProperty[] = [];
  for (const [index, value] of before.entries()) {
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
    if (seenNames.has(name)) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${label} contains duplicate property name ${JSON.stringify(name)}.`,
        { ...details },
      );
    }
    seenNames.add(name);
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
      entries.length >= MAX_PROPERTIES_PER_TARGET
    ) {
      return {
        entries,
        total: before.length,
        truncated: true,
      };
    }
    if (
      entry.propertytype !== undefined &&
      typeof entry.propertytype !== "string"
    ) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${label} property ${JSON.stringify(name)} has a malformed propertytype.`,
        { ...details, name },
      );
    }
    const propertyType = entry.propertytype as
      | string
      | undefined;
    if (
      typeName === "class" ||
      typeName === "list"
    ) {
      const rawValue =
        entry.value === undefined
          ? typeName === "class"
            ? ({} as JsonValue)
            : ([] as JsonValue)
          : entry.value;
      const bounded = boundComplexPropertyValue(
        rawValue,
        label,
        name,
        details,
        typeName,
      );
      if (bounded.omitted) {
        entries.push({
          name,
          type: typeName,
          ...(propertyType === undefined
            ? {}
            : { propertytype: propertyType }),
          valueOmitted: true,
          reason: "oversized-value",
          valueBytes: bounded.valueBytes,
        });
      } else {
        entries.push({
          name,
          type: typeName,
          ...(propertyType === undefined
            ? {}
            : { propertytype: propertyType }),
          value: rawValue,
          valueSemantics:
            typeName === "class"
              ? "raw-untyped-members"
              : "typed-elements",
        });
      }
      continue;
    }
    if (typeName === "object") {
      const reference = entry.value ?? 0;
      if (
        typeof reference !== "number" ||
        !Number.isSafeInteger(reference) ||
        reference < 0
      ) {
        throw new TiledMcpError(
          "INVALID_DOCUMENT",
          `${label} property ${JSON.stringify(name)} has a malformed object reference.`,
          { ...details, name },
        );
      }
      entries.push({
        name,
        type: "object",
        ...(propertyType === undefined
          ? {}
          : { propertytype: propertyType }),
        value: reference,
      });
      continue;
    }
    const scalarType =
      typeName as PropertyWriteType;
    const entryValue = entry.value;
    if (
      (scalarType === "string" ||
        scalarType === "file") &&
      typeof entryValue === "string" &&
      !hasAtMostCodePoints(
        entryValue,
        MAX_PROPERTY_VALUE_CODE_POINTS,
      )
    ) {
      entries.push({
        name,
        type: scalarType,
        valueOmitted: true,
        reason: "oversized-value",
        valueCodePoints: [...entryValue].length,
      });
      continue;
    }
    const validScalar =
      scalarType === "bool"
        ? typeof entryValue === "boolean"
        : scalarType === "int" ||
            scalarType === "float"
          ? typeof entryValue === "number" &&
            Number.isFinite(entryValue)
          : typeof entryValue === "string";
    if (!validScalar) {
      throw new TiledMcpError(
        "INVALID_DOCUMENT",
        `${label} property ${JSON.stringify(name)} has a value inconsistent with its declared type.`,
        { ...details, name, type: scalarType },
      );
    }
    entries.push({
      name,
      type: scalarType,
      ...(propertyType === undefined
        ? {}
        : { propertytype: propertyType }),
      value: entryValue as
        | string
        | number
        | boolean,
    });
  }
  return {
    entries,
    total: before.length,
    truncated: false,
  };
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

  let classMembersSet = 0;
  for (const write of patch.setClassMembers ??
    []) {
    const index = byName.get(write.property);
    if (index === undefined) {
      throw new TiledMcpError(
        "UNSUPPORTED_PROPERTY_WRITE",
        `${label} has no property ${JSON.stringify(write.property)} to write class members into.`,
        { ...details, name: write.property },
      );
    }
    const entry = entries[index] as JsonObject;
    if (entry.type !== "class") {
      throw new TiledMcpError(
        "UNSUPPORTED_PROPERTY_WRITE",
        `${label} property ${JSON.stringify(write.property)} is not a class property.`,
        { ...details, name: write.property },
      );
    }
    let cursor: JsonValue | undefined =
      entry.value;
    for (
      let level = 0;
      level < write.path.length;
      level += 1
    ) {
      const key = write.path[level] as string;
      if (
        typeof cursor !== "object" ||
        cursor === null ||
        Array.isArray(cursor) ||
        !Object.prototype.hasOwnProperty.call(
          cursor,
          key,
        )
      ) {
        throw new TiledMcpError(
          "UNSUPPORTED_PROPERTY_WRITE",
          `${label} property ${JSON.stringify(write.property)} has no serialized member at ${write.path.slice(0, level + 1).join(".")}; introducing members requires the project's class definitions.`,
          {
            ...details,
            name: write.property,
            memberPath: write.path,
          },
        );
      }
      const container = cursor as JsonObject;
      if (level === write.path.length - 1) {
        const current = container[key];
        if (
          typeof current !== typeof write.value ||
          typeof current === "object"
        ) {
          throw new TiledMcpError(
            "UNSUPPORTED_PROPERTY_WRITE",
            `${label} property ${JSON.stringify(write.property)} member ${write.path.join(".")} holds a ${typeof current}; the overwrite must keep the serialized JSON type.`,
            {
              ...details,
              name: write.property,
              memberPath: write.path,
            },
          );
        }
        if (current !== write.value) {
          container[key] = write.value;
          classMembersSet += 1;
        }
      } else {
        cursor = container[key];
      }
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
  let propertiesSet = classMembersSet;
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
