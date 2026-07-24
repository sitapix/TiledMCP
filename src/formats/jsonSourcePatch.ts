import {
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  type JSONPath,
  type Node,
} from "jsonc-parser";

import { TiledMcpError } from "../errors.js";
import {
  parseJsonDocument,
  stableJson,
  type JsonObject,
  type JsonValue,
} from "./json.js";

export type JsonSourcePath = readonly (string | number)[];

export interface JsonArrayInsertion {
  path: JsonSourcePath;
  index: number;
}

/**
 * Replaces selected values in a strict JSON document while leaving all
 * characters outside those value ranges untouched.
 *
 * The complete patched document must be semantically identical to
 * targetDocument. This prevents a caller from accidentally omitting a changed
 * path and committing a partially updated document.
 */
export function patchJsonDocumentSource(
  source: Buffer | string,
  targetDocument: JsonObject,
  paths: readonly JsonSourcePath[],
  projectPath: string,
  arrayInsertions: readonly JsonArrayInsertion[] = [],
): Buffer {
  const sourceText = decodeSource(source, projectPath);
  const hasBom = sourceText.charCodeAt(0) === 0xfeff;
  const body = hasBom ? sourceText.slice(1) : sourceText;

  parseJsonDocument(body, projectPath);
  const sourceTree = parseTree(body, [], STRICT_PARSE_OPTIONS);
  if (sourceTree === undefined) {
    throw new TiledMcpError(
      "INVALID_JSON",
      `Could not build a JSON syntax tree for ${projectPath}.`,
      { path: projectPath },
    );
  }
  const target = normalizeTarget(targetDocument, projectPath);
  const targetText = JSON.stringify(target);
  const targetTree = parseTree(targetText, [], STRICT_PARSE_OPTIONS);
  if (targetTree === undefined) {
    throw new TiledMcpError(
      "JSON_SOURCE_PATCH_TARGET_INVALID",
      `Could not build a JSON syntax tree for the target ${projectPath}.`,
      { path: projectPath },
    );
  }

  const seenPaths = new Set<string>();
  for (const path of paths) {
    validatePath(path, projectPath);
    const key = JSON.stringify(path);
    if (seenPaths.has(key)) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_DUPLICATE_PATH",
        `Duplicate JSON source patch path ${formatPath(path)} for ${projectPath}.`,
        { path: projectPath, jsonPath: [...path] },
      );
    }
    seenPaths.add(key);
  }

  const selectedRanges: Array<{
    offset: number;
    length: number;
    path: JSONPath;
  }> = [];
  const replacements: Array<{
    offset: number;
    length: number;
    content: string;
  }> = [];
  for (const readonlyPath of paths) {
    const path: JSONPath = [...readonlyPath];
    const sourceNode = findNodeAtLocation(sourceTree, path);
    if (sourceNode === undefined) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_PATH_NOT_FOUND",
        `JSON source patch path ${formatPath(path)} does not exist in ${projectPath}.`,
        { path: projectPath, jsonPath: path, document: "source" },
      );
    }

    const targetNode = findNodeAtLocation(targetTree, path);
    if (targetNode === undefined) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_PATH_NOT_FOUND",
        `JSON source patch path ${formatPath(path)} does not exist in the target ${projectPath}.`,
        { path: projectPath, jsonPath: path, document: "target" },
      );
    }

    const sourceValue = getNodeValue(sourceNode) as JsonValue;
    const targetValue = getNodeValue(targetNode) as JsonValue;
    selectedRanges.push({
      offset: sourceNode.offset,
      length: sourceNode.length,
      path,
    });
    if (stableJson(sourceValue) === stableJson(targetValue)) {
      continue;
    }
    replacements.push({
      offset: sourceNode.offset,
      length: sourceNode.length,
      content: JSON.stringify(targetValue),
    });
  }

  assertNonOverlappingRanges(selectedRanges, projectPath);
  const insertionPaths = new Set<string>();
  for (const insertion of arrayInsertions) {
    validatePath(insertion.path, projectPath);
    if (!Number.isSafeInteger(insertion.index) || insertion.index < 0) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_INVALID_PATH",
        `Invalid array insertion index ${String(insertion.index)} for ${projectPath}.`,
        {
          path: projectPath,
          jsonPath: [...insertion.path],
          index: insertion.index,
        },
      );
    }
    const key = JSON.stringify(insertion.path);
    if (insertionPaths.has(key)) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_DUPLICATE_PATH",
        `Duplicate JSON array insertion path ${formatPath(insertion.path)} for ${projectPath}.`,
        { path: projectPath, jsonPath: [...insertion.path] },
      );
    }
    insertionPaths.add(key);

    const sourceNode = requireArrayNode(
      sourceTree,
      insertion.path,
      projectPath,
      "source",
    );
    const targetNode = requireArrayNode(
      targetTree,
      insertion.path,
      projectPath,
      "target",
    );
    const sourceChildren = sourceNode.children ?? [];
    const targetChildren = targetNode.children ?? [];
    if (
      insertion.index > sourceChildren.length ||
      targetChildren.length !== sourceChildren.length + 1
    ) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_INSERTION_MISMATCH",
        `Array insertion at ${formatPath(insertion.path)} does not add exactly one target element.`,
        {
          path: projectPath,
          jsonPath: [...insertion.path],
          index: insertion.index,
          sourceLength: sourceChildren.length,
          targetLength: targetChildren.length,
        },
      );
    }
    for (let sourceIndex = 0; sourceIndex < sourceChildren.length; sourceIndex += 1) {
      const targetIndex =
        sourceIndex < insertion.index ? sourceIndex : sourceIndex + 1;
      const sourceChild = sourceChildren[sourceIndex];
      const targetChild = targetChildren[targetIndex];
      if (
        sourceChild === undefined ||
        targetChild === undefined ||
        stableJson(getNodeValue(sourceChild) as JsonValue) !==
          stableJson(getNodeValue(targetChild) as JsonValue)
      ) {
        throw new TiledMcpError(
          "JSON_SOURCE_PATCH_INSERTION_MISMATCH",
          `Array insertion at ${formatPath(insertion.path)} also changes an existing element.`,
          {
            path: projectPath,
            jsonPath: [...insertion.path],
            index: insertion.index,
            sourceIndex,
          },
        );
      }
    }

    const insertedNode = targetChildren[insertion.index];
    if (insertedNode === undefined) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_INSERTION_MISMATCH",
        `The inserted target element is missing at ${formatPath(insertion.path)}.`,
        {
          path: projectPath,
          jsonPath: [...insertion.path],
          index: insertion.index,
        },
      );
    }
    const insertedText = JSON.stringify(
      getNodeValue(insertedNode) as JsonValue,
    );
    const edit = arrayInsertionEdit(
      sourceNode,
      sourceChildren,
      insertion.index,
      insertedText,
    );
    const overlapping = selectedRanges.find(
      (range) =>
        edit.offset >= range.offset &&
        edit.offset <= range.offset + range.length,
    );
    if (overlapping !== undefined) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
        `An array insertion overlaps JSON source patch path ${formatPath(overlapping.path)} in ${projectPath}.`,
        {
          path: projectPath,
          firstJsonPath: overlapping.path,
          secondJsonPath: [...insertion.path],
        },
      );
    }
    replacements.push(edit);
  }
  const patchedBody = applySourceReplacements(body, replacements);
  const patchedDocument = parseJsonDocument(patchedBody, projectPath);
  if (stableJson(patchedDocument) !== stableJson(target)) {
    throw new TiledMcpError(
      "JSON_SOURCE_PATCH_MISMATCH",
      `Patched ${projectPath} does not match the complete target document.`,
      {
        path: projectPath,
        patchedPaths: paths.map((path) => [...path]),
        insertedPaths: arrayInsertions.map((insertion) => ({
          path: [...insertion.path],
          index: insertion.index,
        })),
      },
    );
  }

  return Buffer.from(`${hasBom ? "\uFEFF" : ""}${patchedBody}`, "utf8");
}

function requireArrayNode(
  tree: Node,
  readonlyPath: JsonSourcePath,
  projectPath: string,
  document: "source" | "target",
): Node {
  const path: JSONPath = [...readonlyPath];
  const node = findNodeAtLocation(tree, path);
  if (node === undefined) {
    throw new TiledMcpError(
      "JSON_SOURCE_PATCH_PATH_NOT_FOUND",
      `JSON source patch path ${formatPath(path)} does not exist in the ${document} ${projectPath}.`,
      { path: projectPath, jsonPath: path, document },
    );
  }
  if (node.type !== "array") {
    throw new TiledMcpError(
      "JSON_SOURCE_PATCH_INSERTION_MISMATCH",
      `JSON source patch path ${formatPath(path)} is not an array in the ${document} ${projectPath}.`,
      { path: projectPath, jsonPath: path, document },
    );
  }
  return node;
}

function arrayInsertionEdit(
  sourceNode: Node,
  sourceChildren: Node[],
  index: number,
  insertedText: string,
): { offset: number; length: number; content: string } {
  if (sourceChildren.length === 0) {
    return {
      offset: sourceNode.offset + 1,
      length: 0,
      content: insertedText,
    };
  }
  if (index === sourceChildren.length) {
    const lastChild = sourceChildren[sourceChildren.length - 1];
    if (lastChild === undefined) {
      throw new Error("Array insertion lost its final source child.");
    }
    return {
      offset: lastChild.offset + lastChild.length,
      length: 0,
      content: `,${insertedText}`,
    };
  }
  const nextChild = sourceChildren[index];
  if (nextChild === undefined) {
    throw new Error("Array insertion lost its next source child.");
  }
  return {
    offset: nextChild.offset,
    length: 0,
    content: `${insertedText},`,
  };
}

const STRICT_PARSE_OPTIONS = {
  allowTrailingComma: false,
  disallowComments: true,
  allowEmptyContent: false,
} as const;

function decodeSource(source: Buffer | string, projectPath: string): string {
  if (typeof source === "string") {
    return source;
  }

  const decoded = source.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(source)) {
    throw new TiledMcpError(
      "INVALID_JSON",
      `${projectPath} is not valid UTF-8 and cannot be patched losslessly.`,
      { path: projectPath },
    );
  }
  return decoded;
}

function normalizeTarget(target: JsonObject, projectPath: string): JsonObject {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(target);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TiledMcpError(
      "JSON_SOURCE_PATCH_TARGET_INVALID",
      `Could not serialize the target ${projectPath}: ${reason}`,
      { path: projectPath },
    );
  }

  if (serialized === undefined) {
    throw new TiledMcpError(
      "JSON_SOURCE_PATCH_TARGET_INVALID",
      `The target ${projectPath} is not a JSON object.`,
      { path: projectPath },
    );
  }
  return parseJsonDocument(serialized, `${projectPath} target`);
}

function validatePath(path: JsonSourcePath, projectPath: string): void {
  if (path.length === 0) {
    throw new TiledMcpError(
      "JSON_SOURCE_PATCH_INVALID_PATH",
      `A JSON source patch path for ${projectPath} must not be empty.`,
      { path: projectPath, jsonPath: [] },
    );
  }

  for (const segment of path) {
    if (
      typeof segment !== "string" &&
      (!Number.isSafeInteger(segment) || segment < 0)
    ) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_INVALID_PATH",
        `Invalid segment in JSON source patch path ${formatPath(path)} for ${projectPath}.`,
        { path: projectPath, jsonPath: [...path] },
      );
    }
  }
}

function formatPath(path: JsonSourcePath): string {
  return JSON.stringify(path);
}

function assertNonOverlappingRanges(
  ranges: Array<{ offset: number; length: number; path: JSONPath }>,
  projectPath: string,
): void {
  ranges.sort((left, right) => left.offset - right.offset);
  let previous:
    | { offset: number; length: number; path: JSONPath }
    | undefined;
  for (const range of ranges) {
    if (
      previous !== undefined &&
      range.offset < previous.offset + previous.length
    ) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
        `Overlapping JSON source patch paths are not allowed for ${projectPath}.`,
        {
          path: projectPath,
          firstJsonPath: previous.path,
          secondJsonPath: range.path,
        },
      );
    }
    previous = range;
  }
}

function applySourceReplacements(
  source: string,
  replacements: Array<{ offset: number; length: number; content: string }>,
): string {
  replacements.sort((left, right) => left.offset - right.offset);
  const chunks: string[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    chunks.push(
      source.slice(cursor, replacement.offset),
      replacement.content,
    );
    cursor = replacement.offset + replacement.length;
  }
  chunks.push(source.slice(cursor));
  return chunks.join("");
}
