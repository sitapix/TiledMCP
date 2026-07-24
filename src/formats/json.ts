import { TiledMcpError } from "../errors.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export function parseJsonDocument(text: string, projectPath: string): JsonObject {
  const source = stripBom(text);
  validateJsonLexemes(source, projectPath);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TiledMcpError("INVALID_JSON", `Could not parse ${projectPath}: ${reason}`, {
      path: projectPath,
    });
  }

  if (!isJsonObject(value)) {
    throw new TiledMcpError(
      "INVALID_DOCUMENT",
      `${projectPath} must contain a JSON object at its root.`,
      { path: projectPath },
    );
  }
  return value;
}

export function serializeJsonDocument(document: JsonObject): Buffer {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

export function stableJson(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectObject(value: JsonValue | undefined, context: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new TiledMcpError("INVALID_DOCUMENT", `${context} must be an object.`);
  }
  return value;
}

export function expectArray(value: JsonValue | undefined, context: string): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new TiledMcpError("INVALID_DOCUMENT", `${context} must be an array.`);
  }
  return value;
}

export function expectInteger(value: JsonValue | undefined, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TiledMcpError("INVALID_DOCUMENT", `${context} must be a safe integer.`);
  }
  return value;
}

export function expectString(value: JsonValue | undefined, context: string): string {
  if (typeof value !== "string") {
    throw new TiledMcpError("INVALID_DOCUMENT", `${context} must be a string.`);
  }
  return value;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isJsonObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key] as JsonValue)]),
  );
}

function validateJsonLexemes(source: string, projectPath: string): void {
  let index = 0;

  function fail(
    message: string,
    code:
      | "DUPLICATE_JSON_KEY"
      | "INVALID_JSON"
      | "JSON_NESTING_LIMIT"
      | "UNSAFE_JSON_NUMBER" =
      "INVALID_JSON",
  ): never {
    throw new TiledMcpError(code, `${projectPath}: ${message} at character offset ${index}.`, {
      path: projectPath,
      offset: index,
    });
  }

  function skipWhitespace(): void {
    while (
      source[index] === " " ||
      source[index] === "\t" ||
      source[index] === "\n" ||
      source[index] === "\r"
    ) {
      index += 1;
    }
  }

  function scanString(decode: boolean): string {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      if (escaped) {
        escaped = false;
        index += 1;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        index += 1;
        continue;
      }
      if (character === "\"") {
        index += 1;
        if (!decode) {
          return "";
        }
        try {
          return JSON.parse(source.slice(start, index)) as string;
        } catch {
          fail("Invalid JSON string");
        }
      }
      if (character !== undefined && character.charCodeAt(0) < 0x20) {
        fail("Unescaped control character in JSON string");
      }
      index += 1;
    }
    fail("Unterminated JSON string");
  }

  function scanValue(depth: number): void {
    if (depth > 512) {
      fail("JSON nesting exceeds the 512-level safety limit", "JSON_NESTING_LIMIT");
    }
    skipWhitespace();
    const character = source[index];
    if (character === "{") {
      scanObject(depth + 1);
      return;
    }
    if (character === "[") {
      scanArray(depth + 1);
      return;
    }
    if (character === "\"") {
      scanString(false);
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }

    NUMBER_TOKEN.lastIndex = index;
    const match = NUMBER_TOKEN.exec(source);
    if (!match) {
      fail("Expected a JSON value");
    }
    const token = match[0];
    const number = Number(token);
    if (!Number.isFinite(number)) {
      fail("Non-finite JSON numbers are not losslessly representable", "UNSAFE_JSON_NUMBER");
    }
    if (Number.isInteger(number) && !Number.isSafeInteger(number)) {
      fail("JSON integer exceeds JavaScript's safe range", "UNSAFE_JSON_NUMBER");
    }
    index = NUMBER_TOKEN.lastIndex;
  }

  function scanObject(depth: number): void {
    index += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (source[index] === "}") {
      index += 1;
      return;
    }
    while (true) {
      skipWhitespace();
      if (source[index] !== "\"") {
        fail("Expected an object key");
      }
      const key = scanString(true);
      if (keys.has(key)) {
        fail(`Duplicate object key ${JSON.stringify(key)}`, "DUPLICATE_JSON_KEY");
      }
      keys.add(key);
      skipWhitespace();
      if (source[index] !== ":") {
        fail("Expected ':' after object key");
      }
      index += 1;
      scanValue(depth);
      skipWhitespace();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      if (source[index] !== ",") {
        fail("Expected ',' or '}' in object");
      }
      index += 1;
    }
  }

  function scanArray(depth: number): void {
    index += 1;
    skipWhitespace();
    if (source[index] === "]") {
      index += 1;
      return;
    }
    while (true) {
      scanValue(depth);
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      if (source[index] !== ",") {
        fail("Expected ',' or ']' in array");
      }
      index += 1;
    }
  }

  scanValue(0);
  skipWhitespace();
  if (index !== source.length) {
    fail("Unexpected trailing data");
  }
}

const NUMBER_TOKEN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/gy;
