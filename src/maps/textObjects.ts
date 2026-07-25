import { Buffer } from "node:buffer";

import type { JsonObject } from "../formats/json.js";

export const MAX_TEXT_OBJECT_CONTENT_CODE_POINTS = 4_096;
export const MAX_TEXT_OBJECT_CONTENT_UTF8_BYTES = 16_384;
export const MAX_TEXT_OBJECT_FONT_FAMILY_CODE_POINTS = 256;
export const MAX_TEXT_OBJECT_FONT_FAMILY_UTF8_BYTES = 1_024;
export const MIN_TEXT_OBJECT_PIXEL_SIZE = 1;
export const MAX_TEXT_OBJECT_PIXEL_SIZE = 999;
export const MAX_TEXT_OBJECT_FIELDS_BYTES_PER_CHANGE_SET =
  262_144;
export const DEFAULT_MAX_PENDING_TEXT_OBJECT_PAYLOAD_BYTES =
  2_097_152;

export const TEXT_OBJECT_HORIZONTAL_ALIGNMENTS = [
  "left",
  "center",
  "right",
  "justify",
] as const;
export const TEXT_OBJECT_VERTICAL_ALIGNMENTS = [
  "top",
  "center",
  "bottom",
] as const;

/**
 * Stable lexicographic order used by text-object payload accounting.
 */
export const TEXT_OBJECT_FIELDS = [
  "bold",
  "color",
  "fontFamily",
  "horizontalAlignment",
  "italic",
  "kerning",
  "pixelSize",
  "strikeout",
  "text",
  "underline",
  "verticalAlignment",
  "wrap",
] as const;

export type TextObjectField =
  (typeof TEXT_OBJECT_FIELDS)[number];
export type TextObjectHorizontalAlignment =
  (typeof TEXT_OBJECT_HORIZONTAL_ALIGNMENTS)[number];
export type TextObjectVerticalAlignment =
  (typeof TEXT_OBJECT_VERTICAL_ALIGNMENTS)[number];

export interface EffectiveTextObjectFields {
  text: string;
  fontFamily: string;
  pixelSize: number;
  wrap: boolean;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
  kerning: boolean;
  horizontalAlignment: TextObjectHorizontalAlignment;
  verticalAlignment: TextObjectVerticalAlignment;
}

export const TEXT_OBJECT_DEFAULTS: Readonly<EffectiveTextObjectFields> =
  Object.freeze({
    text: "",
    fontFamily: "sans-serif",
    pixelSize: 16,
    wrap: false,
    color: "#000000",
    bold: false,
    italic: false,
    underline: false,
    strikeout: false,
    kerning: true,
    horizontalAlignment: "left",
    verticalAlignment: "top",
  });

const TILED_TEXT_OBJECT_FIELDS = [
  "bold",
  "color",
  "fontfamily",
  "halign",
  "italic",
  "kerning",
  "pixelsize",
  "strikeout",
  "text",
  "underline",
  "valign",
  "wrap",
] as const;
const TILED_TEXT_OBJECT_FIELD_SET = new Set<string>(
  TILED_TEXT_OBJECT_FIELDS,
);
const TILED_COLOR_PATTERN =
  /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const HORIZONTAL_ALIGNMENT_SET = new Set<string>(
  TEXT_OBJECT_HORIZONTAL_ALIGNMENTS,
);
const VERTICAL_ALIGNMENT_SET = new Set<string>(
  TEXT_OBJECT_VERTICAL_ALIGNMENTS,
);

export class TextObjectValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "TextObjectValidationError";
  }
}

export function hasTextObjectFields(
  value: Readonly<Record<string, unknown>>,
): boolean {
  return TEXT_OBJECT_FIELDS.some((field) =>
    Object.prototype.hasOwnProperty.call(value, field),
  );
}

/**
 * Measures only own, present text-specific flat fields. The canonical object
 * uses TEXT_OBJECT_FIELDS order and compact JSON, making the result independent
 * of request key order. An object with no text fields costs zero bytes.
 *
 * Every projected value is fully validated before JSON serialization.
 */
export function measureTextObjectPayloadBytes(
  value: Readonly<Record<string, unknown>>,
): number {
  const projected = projectAndValidateTextObjectFields(value);
  if (Object.keys(projected).length === 0) {
    return 0;
  }
  return Buffer.byteLength(JSON.stringify(projected), "utf8");
}

export function assertTextObjectFields(
  value: Readonly<Record<string, unknown>>,
  options: { requireText?: boolean } = {},
): void {
  if (
    options.requireText === true &&
    !Object.prototype.hasOwnProperty.call(value, "text")
  ) {
    throw new TextObjectValidationError(
      "text",
      "text must be present.",
    );
  }
  projectAndValidateTextObjectFields(value);
}

export function parseTiledTextObjectData(
  value: unknown,
): EffectiveTextObjectFields {
  if (!isRecord(value)) {
    throw new TextObjectValidationError(
      "text",
      "Tiled text data must be an object.",
    );
  }
  const unknownField = Object.keys(value).find(
    (field) => !TILED_TEXT_OBJECT_FIELD_SET.has(field),
  );
  if (unknownField !== undefined) {
    throw new TextObjectValidationError(
      unknownField,
      `Tiled text data contains unsupported field ${unknownField}.`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, "text")) {
    throw new TextObjectValidationError(
      "text",
      "Tiled text data must contain text.",
    );
  }

  const flat: Record<string, unknown> = {
    text: value.text,
  };
  copyMappedField(value, flat, "fontfamily", "fontFamily");
  copyMappedField(value, flat, "pixelsize", "pixelSize");
  copyMappedField(value, flat, "wrap", "wrap");
  copyMappedField(value, flat, "color", "color");
  copyMappedField(value, flat, "bold", "bold");
  copyMappedField(value, flat, "italic", "italic");
  copyMappedField(value, flat, "underline", "underline");
  copyMappedField(value, flat, "strikeout", "strikeout");
  copyMappedField(value, flat, "kerning", "kerning");
  copyMappedField(
    value,
    flat,
    "halign",
    "horizontalAlignment",
  );
  copyMappedField(
    value,
    flat,
    "valign",
    "verticalAlignment",
  );
  assertTextObjectFields(flat, { requireText: true });
  return {
    ...TEXT_OBJECT_DEFAULTS,
    ...flat,
  } as EffectiveTextObjectFields;
}

export function serializeTiledTextObjectData(
  value: Readonly<EffectiveTextObjectFields>,
): JsonObject {
  assertTextObjectFields(
    value as unknown as Readonly<Record<string, unknown>>,
    { requireText: true },
  );
  const serialized: JsonObject = {
    text: value.text,
  };
  if (value.fontFamily !== TEXT_OBJECT_DEFAULTS.fontFamily) {
    serialized.fontfamily = value.fontFamily;
  }
  if (value.pixelSize !== TEXT_OBJECT_DEFAULTS.pixelSize) {
    serialized.pixelsize = value.pixelSize;
  }
  if (value.wrap !== TEXT_OBJECT_DEFAULTS.wrap) {
    serialized.wrap = value.wrap;
  }
  if (!isDefaultBlack(value.color)) {
    serialized.color = value.color;
  }
  if (value.bold !== TEXT_OBJECT_DEFAULTS.bold) {
    serialized.bold = value.bold;
  }
  if (value.italic !== TEXT_OBJECT_DEFAULTS.italic) {
    serialized.italic = value.italic;
  }
  if (value.underline !== TEXT_OBJECT_DEFAULTS.underline) {
    serialized.underline = value.underline;
  }
  if (value.strikeout !== TEXT_OBJECT_DEFAULTS.strikeout) {
    serialized.strikeout = value.strikeout;
  }
  if (value.kerning !== TEXT_OBJECT_DEFAULTS.kerning) {
    serialized.kerning = value.kerning;
  }
  if (
    value.horizontalAlignment !==
    TEXT_OBJECT_DEFAULTS.horizontalAlignment
  ) {
    serialized.halign = value.horizontalAlignment;
  }
  if (
    value.verticalAlignment !==
    TEXT_OBJECT_DEFAULTS.verticalAlignment
  ) {
    serialized.valign = value.verticalAlignment;
  }
  return serialized;
}

export function applyTextObjectFieldsPatch(
  current: unknown,
  patch: Readonly<Record<string, unknown>>,
): JsonObject {
  const effective = parseTiledTextObjectData(current);
  const projected = projectAndValidateTextObjectFields(patch);
  return serializeTiledTextObjectData({
    ...effective,
    ...projected,
  } as EffectiveTextObjectFields);
}

export function textObjectFieldsFromFlatInput(
  value: Readonly<Record<string, unknown>>,
): EffectiveTextObjectFields {
  assertTextObjectFields(value, { requireText: true });
  const projected = projectAndValidateTextObjectFields(value);
  return {
    ...TEXT_OBJECT_DEFAULTS,
    ...projected,
  } as EffectiveTextObjectFields;
}

function projectAndValidateTextObjectFields(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of TEXT_OBJECT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      continue;
    }
    const fieldValue = value[field];
    assertTextObjectField(field, fieldValue);
    projected[field] = fieldValue;
  }
  return projected;
}

function assertTextObjectField(
  field: TextObjectField,
  value: unknown,
): void {
  switch (field) {
    case "text":
      assertTextContent(value);
      return;
    case "fontFamily":
      assertFontFamily(value);
      return;
    case "pixelSize":
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < MIN_TEXT_OBJECT_PIXEL_SIZE ||
        value > MAX_TEXT_OBJECT_PIXEL_SIZE
      ) {
        throw new TextObjectValidationError(
          field,
          `pixelSize must be an integer between ${MIN_TEXT_OBJECT_PIXEL_SIZE} and ${MAX_TEXT_OBJECT_PIXEL_SIZE}.`,
        );
      }
      return;
    case "color":
      if (
        typeof value !== "string" ||
        !TILED_COLOR_PATTERN.test(value)
      ) {
        throw new TextObjectValidationError(
          field,
          "color must be #RRGGBB or #AARRGGBB.",
        );
      }
      return;
    case "horizontalAlignment":
      if (
        typeof value !== "string" ||
        !HORIZONTAL_ALIGNMENT_SET.has(value)
      ) {
        throw new TextObjectValidationError(
          field,
          "horizontalAlignment must be left, center, right or justify.",
        );
      }
      return;
    case "verticalAlignment":
      if (
        typeof value !== "string" ||
        !VERTICAL_ALIGNMENT_SET.has(value)
      ) {
        throw new TextObjectValidationError(
          field,
          "verticalAlignment must be top, center or bottom.",
        );
      }
      return;
    case "bold":
    case "italic":
    case "underline":
    case "strikeout":
    case "kerning":
    case "wrap":
      if (typeof value !== "boolean") {
        throw new TextObjectValidationError(
          field,
          `${field} must be a boolean.`,
        );
      }
  }
}

function assertTextContent(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new TextObjectValidationError(
      "text",
      "text must be a string.",
    );
  }
  const metrics = inspectUnicodeString(value, {
    field: "text",
    allowTextWhitespaceControls: true,
  });
  if (metrics.codePoints > MAX_TEXT_OBJECT_CONTENT_CODE_POINTS) {
    throw new TextObjectValidationError(
      "text",
      `text must contain at most ${MAX_TEXT_OBJECT_CONTENT_CODE_POINTS} Unicode scalar values.`,
    );
  }
  if (metrics.utf8Bytes > MAX_TEXT_OBJECT_CONTENT_UTF8_BYTES) {
    throw new TextObjectValidationError(
      "text",
      `text must encode to at most ${MAX_TEXT_OBJECT_CONTENT_UTF8_BYTES} UTF-8 bytes.`,
    );
  }
}

function assertFontFamily(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new TextObjectValidationError(
      "fontFamily",
      "fontFamily must be a string.",
    );
  }
  const metrics = inspectUnicodeString(value, {
    field: "fontFamily",
    allowTextWhitespaceControls: false,
  });
  if (
    metrics.codePoints < 1 ||
    metrics.codePoints >
      MAX_TEXT_OBJECT_FONT_FAMILY_CODE_POINTS
  ) {
    throw new TextObjectValidationError(
      "fontFamily",
      `fontFamily must contain between 1 and ${MAX_TEXT_OBJECT_FONT_FAMILY_CODE_POINTS} Unicode scalar values.`,
    );
  }
  if (
    metrics.utf8Bytes >
    MAX_TEXT_OBJECT_FONT_FAMILY_UTF8_BYTES
  ) {
    throw new TextObjectValidationError(
      "fontFamily",
      `fontFamily must encode to at most ${MAX_TEXT_OBJECT_FONT_FAMILY_UTF8_BYTES} UTF-8 bytes.`,
    );
  }
}

function inspectUnicodeString(
  value: string,
  options: {
    field: "text" | "fontFamily";
    allowTextWhitespaceControls: boolean;
  },
): { codePoints: number; utf8Bytes: number } {
  let codePoints = 0;
  let utf8Bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let scalar = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        second < 0xdc00 ||
        second > 0xdfff
      ) {
        throw new TextObjectValidationError(
          options.field,
          `${options.field} must be well-formed Unicode without unpaired surrogates.`,
        );
      }
      scalar =
        0x10000 +
        ((first - 0xd800) << 10) +
        (second - 0xdc00);
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new TextObjectValidationError(
        options.field,
        `${options.field} must be well-formed Unicode without unpaired surrogates.`,
      );
    }

    if (
      isControlCodePoint(scalar) &&
      !(
        options.allowTextWhitespaceControls &&
        (scalar === 0x09 ||
          scalar === 0x0a ||
          scalar === 0x0d)
      )
    ) {
      throw new TextObjectValidationError(
        options.field,
        options.allowTextWhitespaceControls
          ? "text may contain TAB, LF and CR controls only."
          : "fontFamily must not contain control characters.",
      );
    }

    codePoints += 1;
    utf8Bytes += utf8Length(scalar);
  }
  return { codePoints, utf8Bytes };
}

function utf8Length(scalar: number): number {
  if (scalar <= 0x7f) {
    return 1;
  }
  if (scalar <= 0x7ff) {
    return 2;
  }
  if (scalar <= 0xffff) {
    return 3;
  }
  return 4;
}

function isControlCodePoint(scalar: number): boolean {
  return (
    (scalar >= 0x00 && scalar <= 0x1f) ||
    (scalar >= 0x7f && scalar <= 0x9f)
  );
}

function isDefaultBlack(color: string): boolean {
  const normalized = color.toLowerCase();
  return (
    normalized === "#000000" ||
    normalized === "#ff000000"
  );
}

function copyMappedField(
  source: Readonly<Record<string, unknown>>,
  target: Record<string, unknown>,
  sourceField: string,
  targetField: TextObjectField,
): void {
  if (Object.prototype.hasOwnProperty.call(source, sourceField)) {
    target[targetField] = source[sourceField];
  }
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
