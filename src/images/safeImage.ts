import sharp, { type Metadata, type SharpOptions } from "sharp";

import { TiledMcpError } from "../errors.js";

export const MAX_SIMPLE_SVG_BYTES = 256 * 1024;

const DECODE_TIMEOUT_SECONDS = 5;
const ENCODE_TIMEOUT_SECONDS = 5;
const ALLOWED_FORMATS = new Set(["jpeg", "png", "svg", "webp"]);
const ALLOWED_SVG_ELEMENTS = new Set([
  "circle",
  "ellipse",
  "g",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "svg",
]);

// The server only decodes in-memory buffers. Blocking the generic loader class
// prevents a future accidental path-based call from enabling additional codecs.
// This is process-wide libvips policy and must be configured in one module only.
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({
  operation: [
    "VipsForeignLoadJpegBuffer",
    "VipsForeignLoadPngBuffer",
    "VipsForeignLoadSvgBuffer",
    "VipsForeignLoadWebpBuffer",
  ],
});

export type SafeImageFormat = "jpeg" | "png" | "svg" | "webp";

export interface SafeImageLimits {
  maxInputBytes: number;
  maxInputPixels: number;
  maxInputEdge: number;
  maxSimpleSvgBytes?: number;
}

export const DEFAULT_SAFE_IMAGE_LIMITS: Readonly<SafeImageLimits> = {
  maxInputBytes: 64 * 1024 * 1024,
  maxInputPixels: 4_096 * 4_096,
  maxInputEdge: 8_192,
  maxSimpleSvgBytes: MAX_SIMPLE_SVG_BYTES,
};

export interface SafeImageInput {
  bytes: Buffer;
  path: string;
  limits: SafeImageLimits;
}

export interface SafeImageMetadata {
  format: SafeImageFormat;
  width: number;
  height: number;
}

export interface SafeDecodedImage extends SafeImageMetadata {
  rgba: Buffer;
}

export interface EncodeRgbaPngInput {
  rgba: Buffer;
  width: number;
  height: number;
}

export interface DecodeSafeImageInput {
  bytes: Buffer;
  path: string;
  declaredWidth: number;
  declaredHeight: number;
  limits?: SafeImageLimits;
}

export interface DecodedSafeImage {
  rgba: Buffer;
  format: SafeImageFormat;
  pixelSize: {
    width: number;
    height: number;
  };
}

/**
 * Performs content sniffing, the restricted SVG preflight and a bounded
 * metadata read. Extensions are used only to make SVG fail closed when its
 * content cannot be recognized from the bounded prefix.
 */
export async function inspectSafeImage(
  input: SafeImageInput,
): Promise<SafeImageMetadata> {
  validateLimits(input.limits);
  if (input.bytes.byteLength > input.limits.maxInputBytes) {
    throw new TiledMcpError(
      "IMAGE_TOO_LARGE",
      `${input.path} exceeds the ${input.limits.maxInputBytes} byte input limit.`,
      {
        path: input.path,
        size: input.bytes.byteLength,
        limit: input.limits.maxInputBytes,
      },
    );
  }

  const svgChecked = validatePotentialSvg(
    input.bytes,
    input.path,
    input.limits.maxSimpleSvgBytes ?? MAX_SIMPLE_SVG_BYTES,
  );
  const metadata = await readMetadata(input);
  const format = assertSupportedFormat(metadata, input.path, svgChecked);
  const width = requireImageDimension(
    metadata.width,
    "width",
    input.path,
    input.limits.maxInputEdge,
  );
  const height = requireImageDimension(
    metadata.height,
    "height",
    input.path,
    input.limits.maxInputEdge,
  );
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > input.limits.maxInputPixels) {
    throw new TiledMcpError(
      "IMAGE_DIMENSIONS_EXCEEDED",
      `${input.path} exceeds the ${input.limits.maxInputPixels} decoded-pixel limit.`,
      {
        path: input.path,
        width,
        height,
        maxPixels: input.limits.maxInputPixels,
      },
    );
  }
  return { format, width, height };
}

/**
 * Safely inspects and decodes an allowlisted image to unpremultiplied sRGB
 * RGBA. The repeated geometry check catches decoder/metadata disagreement.
 */
export async function decodeSafeImageRgba(
  input: SafeImageInput,
): Promise<SafeDecodedImage> {
  const inspected = await inspectSafeImage(input);
  try {
    const { data, info } = await sharp(
      input.bytes,
      inputOptions(input.limits),
    )
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .timeout({ seconds: DECODE_TIMEOUT_SECONDS })
      .toBuffer({ resolveWithObject: true });
    const expectedBytes = inspected.width * inspected.height * 4;
    if (
      info.width !== inspected.width ||
      info.height !== inspected.height ||
      info.channels !== 4 ||
      data.byteLength !== expectedBytes
    ) {
      throw new Error("decoded image geometry changed");
    }
    return { ...inspected, rgba: data };
  } catch {
    throw new TiledMcpError(
      "INVALID_TILESET_IMAGE",
      `${input.path} could not be decoded within the image limits.`,
      { path: input.path },
    );
  }
}

/**
 * Convenience entry point for Tiled atlas consumers. It binds decoded pixels
 * to the dimensions declared by the TSJ so stale metadata cannot silently
 * select different tile crops.
 */
export async function decodeSafeImage(
  input: DecodeSafeImageInput,
): Promise<DecodedSafeImage> {
  const decoded = await decodeSafeImageRgba({
    bytes: input.bytes,
    path: input.path,
    limits: input.limits ?? { ...DEFAULT_SAFE_IMAGE_LIMITS },
  });
  if (
    decoded.width !== input.declaredWidth ||
    decoded.height !== input.declaredHeight
  ) {
    throw new TiledMcpError(
      "TILESET_IMAGE_DIMENSION_MISMATCH",
      `${input.path} is ${decoded.width}x${decoded.height}, but the TSJ declares ${input.declaredWidth}x${input.declaredHeight}.`,
      {
        path: input.path,
        actual: { width: decoded.width, height: decoded.height },
        declared: {
          width: input.declaredWidth,
          height: input.declaredHeight,
        },
      },
    );
  }
  return {
    rgba: decoded.rgba,
    format: decoded.format,
    pixelSize: { width: decoded.width, height: decoded.height },
  };
}

/** Encodes an exact RGBA surface using the deterministic project PNG profile. */
export function encodeRgbaPng(input: EncodeRgbaPngInput): Promise<Buffer>;
export function encodeRgbaPng(
  rgba: Buffer,
  width: number,
  height: number,
  context?: string,
): Promise<Buffer>;
export async function encodeRgbaPng(
  inputOrRgba: EncodeRgbaPngInput | Buffer,
  positionalWidth?: number,
  positionalHeight?: number,
  context?: string,
): Promise<Buffer> {
  const input =
    Buffer.isBuffer(inputOrRgba)
      ? {
          rgba: inputOrRgba,
          width: positionalWidth ?? Number.NaN,
          height: positionalHeight ?? Number.NaN,
        }
      : inputOrRgba;
  const expectedBytes = input.width * input.height * 4;
  if (
    !Number.isSafeInteger(input.width) ||
    input.width <= 0 ||
    !Number.isSafeInteger(input.height) ||
    input.height <= 0 ||
    !Number.isSafeInteger(expectedBytes) ||
    input.rgba.byteLength !== expectedBytes
  ) {
    throw new TiledMcpError(
      "IMAGE_ENCODING_FAILED",
      "The RGBA surface does not match its declared PNG dimensions.",
      {
        width: input.width,
        height: input.height,
        actualBytes: input.rgba.byteLength,
        expectedBytes: Number.isSafeInteger(expectedBytes)
          ? expectedBytes
          : null,
      },
    );
  }

  try {
    const { data, info } = await sharp(input.rgba, {
      raw: { width: input.width, height: input.height, channels: 4 },
    })
      .png({
        adaptiveFiltering: true,
        compressionLevel: 9,
        palette: false,
      })
      .timeout({ seconds: ENCODE_TIMEOUT_SECONDS })
      .toBuffer({ resolveWithObject: true });
    if (
      info.format !== "png" ||
      info.width !== input.width ||
      info.height !== input.height
    ) {
      throw new Error("encoded PNG geometry changed");
    }
    return data;
  } catch {
    throw new TiledMcpError(
      "IMAGE_ENCODING_FAILED",
      `${context ?? "The image"} could not be encoded as PNG within the render timeout.`,
      { width: input.width, height: input.height },
    );
  }
}

function inputOptions(limits: SafeImageLimits): SharpOptions {
  return {
    animated: false,
    autoOrient: false,
    density: 72,
    failOn: "warning",
    limitInputChannels: 4,
    limitInputPixels: limits.maxInputPixels,
    pages: 1,
    sequentialRead: true,
    unlimited: false,
  };
}

function validateLimits(limits: SafeImageLimits): void {
  for (const [field, value] of [
    ["maxInputBytes", limits.maxInputBytes],
    ["maxInputPixels", limits.maxInputPixels],
    ["maxInputEdge", limits.maxInputEdge],
    [
      "maxSimpleSvgBytes",
      limits.maxSimpleSvgBytes ?? MAX_SIMPLE_SVG_BYTES,
    ],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TiledMcpError(
        "INVALID_ARGUMENT",
        `${field} must be a positive safe integer.`,
      );
    }
  }
}

function validatePotentialSvg(
  bytes: Buffer,
  path: string,
  maxSimpleSvgBytes: number,
): boolean {
  if (
    hasPngSignature(bytes) ||
    hasJpegSignature(bytes) ||
    hasWebpSignature(bytes)
  ) {
    return false;
  }
  const extensionIsSvg = path.toLowerCase().endsWith(".svg");
  const prefix = bytes.subarray(0, Math.min(bytes.byteLength, 4_096));
  const prefixText = prefix
    .toString("utf8")
    .replace(/^\uFEFF/u, "")
    .trimStart();
  const looksLikeSvg =
    /^(?:<\?xml\b[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/iu.test(
      prefixText,
    );
  if (extensionIsSvg || looksLikeSvg) {
    assertSafeSimpleSvg(bytes, path, maxSimpleSvgBytes);
    return true;
  }
  throw unsupportedImageFormat(path);
}

function assertSafeSimpleSvg(
  bytes: Buffer,
  path: string,
  maxSimpleSvgBytes: number,
): void {
  if (bytes.byteLength > maxSimpleSvgBytes) {
    throw new TiledMcpError(
      "UNSAFE_SVG",
      `${path} exceeds the ${maxSimpleSvgBytes} byte limit for simple SVG images.`,
      { path, size: bytes.byteLength, limit: maxSimpleSvgBytes },
    );
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TiledMcpError(
      "UNSAFE_SVG",
      `${path} is not valid UTF-8 SVG.`,
      { path },
    );
  }
  if (!/<svg\b/iu.test(source)) {
    throw new TiledMcpError(
      "UNSAFE_SVG",
      `${path} does not contain an SVG root element.`,
      { path },
    );
  }
  const unsafePattern =
    /[&\\]|\/\*|\*\/|<!doctype|<!entity|<\?xml-stylesheet|\b(?:href|src|style|on[a-z][\w:.-]*)\s*=|\b(?:data|xlink|xi)\s*:|url\s*\(|@import/iu;
  if (unsafePattern.test(source)) {
    throw new TiledMcpError(
      "UNSAFE_SVG",
      `${path} uses an SVG feature that is not allowed by the simple-image profile.`,
      { path },
    );
  }
  for (const match of source.matchAll(/<\s*\/?\s*([A-Za-z][\w:.-]*)/gu)) {
    const element = match[1]?.toLowerCase();
    if (
      element === undefined ||
      element.includes(":") ||
      !ALLOWED_SVG_ELEMENTS.has(element)
    ) {
      throw new TiledMcpError(
        "UNSAFE_SVG",
        `${path} uses an unsupported SVG element.`,
        { path, element: element ?? null },
      );
    }
  }
}

function hasPngSignature(bytes: Buffer): boolean {
  return (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function hasJpegSignature(bytes: Buffer): boolean {
  return (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

function hasWebpSignature(bytes: Buffer): boolean {
  return (
    bytes.byteLength >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  );
}

async function readMetadata(input: SafeImageInput): Promise<Metadata> {
  try {
    return await sharp(input.bytes, inputOptions(input.limits))
      .timeout({ seconds: DECODE_TIMEOUT_SECONDS })
      .metadata();
  } catch {
    throw new TiledMcpError(
      "INVALID_TILESET_IMAGE",
      `${input.path} could not be read as a bounded image.`,
      { path: input.path },
    );
  }
}

function assertSupportedFormat(
  metadata: Metadata,
  path: string,
  svgChecked: boolean,
): SafeImageFormat {
  const format = metadata.format;
  if (format === undefined || !ALLOWED_FORMATS.has(format)) {
    throw unsupportedImageFormat(path, format ?? null);
  }
  if (format === "svg" && !svgChecked) {
    throw new TiledMcpError(
      "UNSAFE_SVG",
      `${path} was detected as SVG but did not pass the simple-image preflight.`,
      { path },
    );
  }
  const pages = metadata.pages ?? 1;
  if (pages !== 1) {
    throw new TiledMcpError(
      "UNSUPPORTED_IMAGE_FORMAT",
      `${path} contains ${pages} frames or pages; images must be static.`,
      { path, pages },
    );
  }
  return format as SafeImageFormat;
}

function requireImageDimension(
  value: number | undefined,
  field: string,
  path: string,
  maxInputEdge: number,
): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maxInputEdge
  ) {
    throw new TiledMcpError(
      "INVALID_TILESET_IMAGE",
      `${path} has an invalid or oversized ${field}.`,
      {
        path,
        field,
        value: value ?? null,
        maxEdge: maxInputEdge,
      },
    );
  }
  return value;
}

function unsupportedImageFormat(
  path: string,
  format: string | null = null,
): TiledMcpError {
  return new TiledMcpError(
    "UNSUPPORTED_IMAGE_FORMAT",
    `${path} must be PNG, JPEG, WebP or a simple self-contained SVG.`,
    { path, ...(format === null ? {} : { format }) },
  );
}
