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
 * Synchronizes one object member with the complete target document.
 *
 * The object itself must exist in both documents. A member present only in
 * the target is inserted, a member present in both is replaced when needed,
 * and a member absent from the target is deleted. When both values are
 * semantically equal (including both being absent), the source is untouched.
 */
export interface JsonObjectMemberPatch {
  path: JsonSourcePath;
  key: string;
}

/**
 * Deletes one element identified by its index in the source array.
 *
 * Multiple deletions for the same array are all interpreted against the
 * original source indices, regardless of the order in which they are passed.
 */
export interface JsonArrayDeletion {
  path: JsonSourcePath;
  index: number;
}

interface SourceReplacement {
  offset: number;
  length: number;
  content: string;
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
  objectMemberPatches: readonly JsonObjectMemberPatch[] = [],
  arrayDeletions: readonly JsonArrayDeletion[] = [],
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
  validateObjectMemberPatches(
    sourceTree,
    targetTree,
    paths,
    objectMemberPatches,
    projectPath,
  );
  validateArrayDeletions(
    sourceTree,
    targetTree,
    paths,
    arrayInsertions,
    objectMemberPatches,
    arrayDeletions,
    projectPath,
  );

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
    for (const memberPatch of objectMemberPatches) {
      const memberPath = [
        ...memberPatch.path,
        memberPatch.key,
      ];
      if (
        pathsOverlap(insertion.path, memberPath)
      ) {
        throw new TiledMcpError(
          "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
          `JSON array insertion path ${formatPath(insertion.path)} overlaps object member patch path ${formatPath(memberPath)} in ${projectPath}.`,
          {
            path: projectPath,
            firstJsonPath: [...insertion.path],
            secondJsonPath: memberPath,
          },
        );
      }
    }

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
  let patchedBody = applySourceReplacements(
    body,
    replacements,
  );
  patchedBody = patchStructuredSource(
    patchedBody,
    targetTree,
    objectMemberPatches,
    arrayDeletions,
    projectPath,
  );
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
        objectMemberPaths: objectMemberPatches.map(
          (patch) => [...patch.path, patch.key],
        ),
        deletedPaths: arrayDeletions.map(
          (deletion) => ({
            path: [...deletion.path],
            sourceIndex: deletion.index,
          }),
        ),
      },
    );
  }

  return Buffer.from(`${hasBom ? "\uFEFF" : ""}${patchedBody}`, "utf8");
}

function validateObjectMemberPatches(
  sourceTree: Node,
  targetTree: Node,
  valuePaths: readonly JsonSourcePath[],
  patches: readonly JsonObjectMemberPatch[],
  projectPath: string,
): void {
  const seenMemberPaths = new Set<string>();
  const memberPaths: JsonSourcePath[] = [];
  for (const patch of patches) {
    if (
      typeof patch !== "object" ||
      patch === null ||
      Array.isArray(patch)
    ) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_INVALID_PATH",
        `An object member patch for ${projectPath} must be an object.`,
        { path: projectPath },
      );
    }
    if (!Array.isArray(patch.path)) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_INVALID_PATH",
        `An object member patch path for ${projectPath} must be an array.`,
        { path: projectPath },
      );
    }
    validateObjectPath(patch.path, projectPath);
    if (typeof patch.key !== "string") {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_INVALID_PATH",
        `An object member patch key for ${projectPath} must be a string.`,
        {
          path: projectPath,
          jsonPath: [...patch.path],
        },
      );
    }
    requireObjectNode(
      sourceTree,
      patch.path,
      projectPath,
      "source",
    );
    requireObjectNode(
      targetTree,
      patch.path,
      projectPath,
      "target",
    );
    const memberPath: JsonSourcePath = [
      ...patch.path,
      patch.key,
    ];
    const serializedPath = JSON.stringify(memberPath);
    if (seenMemberPaths.has(serializedPath)) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_DUPLICATE_PATH",
        `Duplicate JSON object member patch path ${formatPath(memberPath)} for ${projectPath}.`,
        {
          path: projectPath,
          jsonPath: [...memberPath],
        },
      );
    }
    seenMemberPaths.add(serializedPath);
    for (const valuePath of valuePaths) {
      if (pathsOverlap(memberPath, valuePath)) {
        throw new TiledMcpError(
          "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
          `JSON object member patch path ${formatPath(memberPath)} overlaps value patch path ${formatPath(valuePath)} in ${projectPath}.`,
          {
            path: projectPath,
            firstJsonPath: [...valuePath],
            secondJsonPath: [...memberPath],
          },
        );
      }
    }
    for (const previousMemberPath of memberPaths) {
      if (pathsOverlap(memberPath, previousMemberPath)) {
        throw new TiledMcpError(
          "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
          `JSON object member patch paths ${formatPath(previousMemberPath)} and ${formatPath(memberPath)} overlap in ${projectPath}.`,
          {
            path: projectPath,
            firstJsonPath: [...previousMemberPath],
            secondJsonPath: [...memberPath],
          },
        );
      }
    }
    memberPaths.push(memberPath);
  }
}

interface ArrayDeletionGroup {
  path: JsonSourcePath;
  indices: number[];
}

function validateArrayDeletions(
  sourceTree: Node,
  targetTree: Node,
  valuePaths: readonly JsonSourcePath[],
  insertions: readonly JsonArrayInsertion[],
  memberPatches: readonly JsonObjectMemberPatch[],
  deletions: readonly JsonArrayDeletion[],
  projectPath: string,
): void {
  if (deletions.length > 0) {
    for (const insertion of insertions) {
      if (
        typeof insertion !== "object" ||
        insertion === null ||
        Array.isArray(insertion) ||
        !Array.isArray(insertion.path)
      ) {
        throw new TiledMcpError(
          "JSON_SOURCE_PATCH_INVALID_PATH",
          `A JSON array insertion for ${projectPath} must contain an array path.`,
          { path: projectPath },
        );
      }
      validatePath(insertion.path, projectPath);
    }
  }
  const seen = new Set<string>();
  const deletionPaths: JsonSourcePath[] = [];
  for (const deletion of deletions) {
    if (
      typeof deletion !== "object" ||
      deletion === null ||
      Array.isArray(deletion) ||
      !Array.isArray(deletion.path)
    ) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_INVALID_PATH",
        `A JSON array deletion for ${projectPath} must contain an array path.`,
        { path: projectPath },
      );
    }
    validatePath(deletion.path, projectPath);
    if (
      !Number.isSafeInteger(deletion.index) ||
      deletion.index < 0
    ) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_INVALID_PATH",
        `Invalid array deletion index ${String(deletion.index)} for ${projectPath}.`,
        {
          path: projectPath,
          jsonPath: [...deletion.path],
          index: deletion.index,
        },
      );
    }
    const identity = JSON.stringify([
      deletion.path,
      deletion.index,
    ]);
    if (seen.has(identity)) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_DUPLICATE_PATH",
        `Duplicate JSON array deletion at source index ${deletion.index} of ${formatPath(deletion.path)} for ${projectPath}.`,
        {
          path: projectPath,
          jsonPath: [...deletion.path],
          sourceIndex: deletion.index,
        },
      );
    }
    seen.add(identity);

    for (const valuePath of valuePaths) {
      assertDeletionPathDoesNotOverlap(
        deletion.path,
        valuePath,
        projectPath,
      );
    }
    for (const insertion of insertions) {
      assertDeletionPathDoesNotOverlap(
        deletion.path,
        insertion.path,
        projectPath,
      );
    }
    for (const memberPatch of memberPatches) {
      assertDeletionPathDoesNotOverlap(
        deletion.path,
        [...memberPatch.path, memberPatch.key],
        projectPath,
      );
    }
    for (const previousPath of deletionPaths) {
      if (
        sameJsonPath(deletion.path, previousPath)
      ) {
        continue;
      }
      assertDeletionPathDoesNotOverlap(
        deletion.path,
        previousPath,
        projectPath,
      );
    }
    deletionPaths.push(deletion.path);
  }

  for (const group of groupArrayDeletions(deletions).values()) {
    const sourceArray = requireArrayNode(
      sourceTree,
      group.path,
      projectPath,
      "source",
      "JSON_SOURCE_PATCH_DELETION_MISMATCH",
    );
    const targetArray = requireArrayNode(
      targetTree,
      group.path,
      projectPath,
      "target",
      "JSON_SOURCE_PATCH_DELETION_MISMATCH",
    );
    const sourceChildren = sourceArray.children ?? [];
    const targetChildren = targetArray.children ?? [];
    const sortedIndices = [...group.indices].sort(
      (left, right) => left - right,
    );
    const outOfRange = sortedIndices.find(
      (index) => index >= sourceChildren.length,
    );
    if (outOfRange !== undefined) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_DELETION_MISMATCH",
        `Array deletion source index ${outOfRange} is outside ${formatPath(group.path)}.`,
        {
          path: projectPath,
          jsonPath: [...group.path],
          sourceIndex: outOfRange,
          sourceLength: sourceChildren.length,
        },
      );
    }
    if (
      targetChildren.length !==
      sourceChildren.length - sortedIndices.length
    ) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_DELETION_MISMATCH",
        `Array deletions at ${formatPath(group.path)} do not produce the target length.`,
        {
          path: projectPath,
          jsonPath: [...group.path],
          sourceLength: sourceChildren.length,
          targetLength: targetChildren.length,
          deletionCount: sortedIndices.length,
        },
      );
    }
    const deletedIndices = new Set(sortedIndices);
    let targetIndex = 0;
    for (
      let sourceIndex = 0;
      sourceIndex < sourceChildren.length;
      sourceIndex += 1
    ) {
      if (deletedIndices.has(sourceIndex)) {
        continue;
      }
      const sourceChild = sourceChildren[sourceIndex];
      const targetChild = targetChildren[targetIndex];
      if (
        sourceChild === undefined ||
        targetChild === undefined ||
        stableJson(getNodeValue(sourceChild) as JsonValue) !==
          stableJson(getNodeValue(targetChild) as JsonValue)
      ) {
        throw new TiledMcpError(
          "JSON_SOURCE_PATCH_DELETION_MISMATCH",
          `Array deletion at ${formatPath(group.path)} also changes a retained element.`,
          {
            path: projectPath,
            jsonPath: [...group.path],
            sourceIndex,
            targetIndex,
          },
        );
      }
      targetIndex += 1;
    }
  }
}

function assertDeletionPathDoesNotOverlap(
  deletionPath: JsonSourcePath,
  otherPath: JsonSourcePath,
  projectPath: string,
): void {
  if (!pathsOverlap(deletionPath, otherPath)) {
    return;
  }
  throw new TiledMcpError(
    "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
    `JSON array deletion path ${formatPath(deletionPath)} overlaps patch path ${formatPath(otherPath)} in ${projectPath}.`,
    {
      path: projectPath,
      firstJsonPath: [...deletionPath],
      secondJsonPath: [...otherPath],
    },
  );
}

function sameJsonPath(
  left: JsonSourcePath,
  right: JsonSourcePath,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (segment, index) => segment === right[index],
    )
  );
}

function groupArrayDeletions(
  deletions: readonly JsonArrayDeletion[],
): Map<string, ArrayDeletionGroup> {
  const groups = new Map<string, ArrayDeletionGroup>();
  for (const deletion of deletions) {
    const key = JSON.stringify(deletion.path);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        path: deletion.path,
        indices: [deletion.index],
      });
    } else {
      group.indices.push(deletion.index);
    }
  }
  return groups;
}

function patchStructuredSource(
  source: string,
  targetTree: Node,
  memberPatches: readonly JsonObjectMemberPatch[],
  arrayDeletions: readonly JsonArrayDeletion[],
  projectPath: string,
): string {
  if (
    memberPatches.length === 0 &&
    arrayDeletions.length === 0
  ) {
    return source;
  }
  const sourceTree = parseTree(
    source,
    [],
    STRICT_PARSE_OPTIONS,
  );
  if (sourceTree === undefined) {
    throw new TiledMcpError(
      "INVALID_JSON",
      `Could not rebuild the JSON syntax tree for ${projectPath} while patching object members.`,
      { path: projectPath },
    );
  }
  const grouped = new Map<
    string,
    {
      path: JsonSourcePath;
      patches: JsonObjectMemberPatch[];
    }
  >();
  for (const patch of memberPatches) {
    const key = JSON.stringify(patch.path);
    const group = grouped.get(key);
    if (group === undefined) {
      grouped.set(key, {
        path: patch.path,
        patches: [patch],
      });
    } else {
      group.patches.push(patch);
    }
  }

  const replacements: SourceReplacement[] = [];
  for (const group of grouped.values()) {
    const sourceObject = requireObjectNode(
      sourceTree,
      group.path,
      projectPath,
      "source",
    );
    const targetObject = requireObjectNode(
      targetTree,
      group.path,
      projectPath,
      "target",
    );
    const sourceProperties = readObjectProperties(
      sourceObject,
      group.path,
      projectPath,
      "source",
    );
    const targetProperties = readObjectProperties(
      targetObject,
      group.path,
      projectPath,
      "target",
    );
    replacements.push(
      ...objectMemberGroupEdits(
        source,
        sourceObject,
        sourceProperties,
        targetProperties,
        group.patches,
      ),
    );
  }
  const deletionGroups = groupArrayDeletions(
    arrayDeletions,
  );
  for (const group of deletionGroups.values()) {
    const sourceArray = requireArrayNode(
      sourceTree,
      group.path,
      projectPath,
      "source",
      "JSON_SOURCE_PATCH_DELETION_MISMATCH",
    );
    replacements.push(
      ...arrayDeletionGroupEdits(
        sourceArray.children ?? [],
        group.indices,
      ),
    );
  }
  assertNonOverlappingSourceReplacements(
    replacements,
    projectPath,
  );
  return applySourceReplacements(source, replacements);
}

interface ObjectPropertyNode {
  node: Node;
  keyNode: Node;
  valueNode: Node;
  key: string;
}

function requireObjectNode(
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
      `JSON object source patch path ${formatPath(path)} does not exist in the ${document} ${projectPath}.`,
      {
        path: projectPath,
        jsonPath: path,
        document,
      },
    );
  }
  if (node.type !== "object") {
    throw new TiledMcpError(
      "JSON_SOURCE_PATCH_OBJECT_MISMATCH",
      `JSON object source patch path ${formatPath(path)} is not an object in the ${document} ${projectPath}.`,
      {
        path: projectPath,
        jsonPath: path,
        document,
      },
    );
  }
  return node;
}

function readObjectProperties(
  objectNode: Node,
  path: JsonSourcePath,
  projectPath: string,
  document: "source" | "target",
): ObjectPropertyNode[] {
  const properties: ObjectPropertyNode[] = [];
  const seenKeys = new Set<string>();
  for (const propertyNode of objectNode.children ?? []) {
    const [keyNode, valueNode] =
      propertyNode.children ?? [];
    const key =
      keyNode === undefined
        ? undefined
        : getNodeValue(keyNode);
    if (
      propertyNode.type !== "property" ||
      keyNode?.type !== "string" ||
      typeof key !== "string" ||
      valueNode === undefined
    ) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_OBJECT_MISMATCH",
        `JSON object source patch path ${formatPath(path)} has a malformed property in the ${document} ${projectPath}.`,
        {
          path: projectPath,
          jsonPath: [...path],
          document,
        },
      );
    }
    if (seenKeys.has(key)) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_OBJECT_MISMATCH",
        `JSON object source patch path ${formatPath(path)} has an ambiguous duplicate key in the ${document} ${projectPath}.`,
        {
          path: projectPath,
          jsonPath: [...path, key],
          document,
        },
      );
    }
    seenKeys.add(key);
    properties.push({
      node: propertyNode,
      keyNode,
      valueNode,
      key,
    });
  }
  return properties;
}

function objectMemberGroupEdits(
  source: string,
  objectNode: Node,
  sourceProperties: ObjectPropertyNode[],
  targetProperties: ObjectPropertyNode[],
  patches: readonly JsonObjectMemberPatch[],
): SourceReplacement[] {
  const sourceByKey = new Map(
    sourceProperties.map((property) => [
      property.key,
      property,
    ]),
  );
  const targetByKey = new Map(
    targetProperties.map((property) => [
      property.key,
      property,
    ]),
  );
  const deletedKeys = new Set<string>();
  const insertions: Array<{
    key: string;
    valueText: string;
  }> = [];
  const edits: SourceReplacement[] = [];

  for (const patch of patches) {
    const sourceProperty = sourceByKey.get(patch.key);
    const targetProperty = targetByKey.get(patch.key);
    if (
      sourceProperty === undefined &&
      targetProperty === undefined
    ) {
      continue;
    }
    if (
      sourceProperty !== undefined &&
      targetProperty !== undefined
    ) {
      const sourceValue = getNodeValue(
        sourceProperty.valueNode,
      ) as JsonValue;
      const targetValue = getNodeValue(
        targetProperty.valueNode,
      ) as JsonValue;
      if (
        stableJson(sourceValue) !== stableJson(targetValue)
      ) {
        edits.push({
          offset: sourceProperty.valueNode.offset,
          length: sourceProperty.valueNode.length,
          content: JSON.stringify(targetValue),
        });
      }
      continue;
    }
    if (targetProperty === undefined) {
      deletedKeys.add(patch.key);
      continue;
    }
    insertions.push({
      key: patch.key,
      valueText: JSON.stringify(
        getNodeValue(targetProperty.valueNode) as JsonValue,
      ),
    });
  }

  edits.push(
    ...objectMemberStructuralEdits(
      source,
      objectNode,
      sourceProperties,
      deletedKeys,
      insertions,
    ),
  );
  return edits;
}

function objectMemberStructuralEdits(
  source: string,
  objectNode: Node,
  properties: ObjectPropertyNode[],
  deletedKeys: ReadonlySet<string>,
  insertions: ReadonlyArray<{
    key: string;
    valueText: string;
  }>,
): SourceReplacement[] {
  if (
    deletedKeys.size === 0 &&
    insertions.length === 0
  ) {
    return [];
  }
  const keptProperties = properties.filter(
    (property) => !deletedKeys.has(property.key),
  );
  const innerStart = objectNode.offset + 1;
  const innerEnd =
    objectNode.offset + objectNode.length - 1;
  const emptyPrefix =
    properties.length === 0
      ? emptyObjectMemberPrefix(
          source,
          source.slice(innerStart, innerEnd),
        )
      : "";
  const delimiter = objectMemberDelimiter(
    source,
    objectNode,
    properties,
    emptyPrefix,
  );
  const colon = objectMemberColon(
    source,
    keptProperties.length === 0
      ? properties
      : keptProperties,
    emptyPrefix,
  );
  const insertedMembers = insertions
    .map(
      ({ key, valueText }) =>
        `${JSON.stringify(key)}${colon}${valueText}`,
    )
    .join(delimiter);

  if (properties.length === 0) {
    if (insertedMembers.length === 0) {
      return [];
    }
    return [
      {
        offset: innerStart,
        length: 0,
        content: `${emptyPrefix}${insertedMembers}`,
      },
    ];
  }

  const firstProperty = properties[0];
  const lastProperty = properties[properties.length - 1];
  if (
    firstProperty === undefined ||
    lastProperty === undefined
  ) {
    throw new Error(
      "Object member structural patch lost its properties.",
    );
  }
  if (keptProperties.length === 0) {
    return [
      {
        offset: firstProperty.node.offset,
        length:
          lastProperty.node.offset +
          lastProperty.node.length -
          firstProperty.node.offset,
        content: insertedMembers,
      },
    ];
  }

  const insertionSuffix =
    insertedMembers.length === 0
      ? ""
      : `${delimiter}${insertedMembers}`;
  const edits: SourceReplacement[] = [];
  let insertionIncluded = false;
  let index = 0;
  while (index < properties.length) {
    const property = properties[index];
    if (
      property === undefined ||
      !deletedKeys.has(property.key)
    ) {
      index += 1;
      continue;
    }
    const runStart = property;
    let runEnd = property;
    index += 1;
    while (index < properties.length) {
      const candidate = properties[index];
      if (
        candidate === undefined ||
        !deletedKeys.has(candidate.key)
      ) {
        break;
      }
      runEnd = candidate;
      index += 1;
    }
    const nextKept = properties[index];
    if (nextKept !== undefined) {
      edits.push({
        offset: runStart.node.offset,
        length:
          nextKept.node.offset - runStart.node.offset,
        content: "",
      });
      continue;
    }
    const lastKept =
      keptProperties[keptProperties.length - 1];
    if (lastKept === undefined) {
      throw new Error(
        "Object member structural patch lost its final retained property.",
      );
    }
    const offset =
      lastKept.node.offset + lastKept.node.length;
    edits.push({
      offset,
      length:
        runEnd.node.offset +
        runEnd.node.length -
        offset,
      content: insertionSuffix,
    });
    insertionIncluded = true;
  }

  if (
    insertionSuffix.length > 0 &&
    !insertionIncluded
  ) {
    const lastKept =
      keptProperties[keptProperties.length - 1];
    if (lastKept === undefined) {
      throw new Error(
        "Object member insertion lost its final retained property.",
      );
    }
    edits.push({
      offset:
        lastKept.node.offset + lastKept.node.length,
      length: 0,
      content: insertionSuffix,
    });
  }
  return edits;
}

function objectMemberDelimiter(
  source: string,
  objectNode: Node,
  properties: ObjectPropertyNode[],
  emptyPrefix: string,
): string {
  if (properties.length === 0) {
    return `,${emptyPrefix}`;
  }
  const lastProperty =
    properties[properties.length - 1];
  if (lastProperty === undefined) {
    throw new Error(
      "Object member delimiter lost its final property.",
    );
  }
  if (properties.length === 1) {
    return `,${source.slice(
      objectNode.offset + 1,
      lastProperty.node.offset,
    )}`;
  }
  const previousProperty =
    properties[properties.length - 2];
  if (previousProperty === undefined) {
    throw new Error(
      "Object member delimiter lost its previous property.",
    );
  }
  const delimiter = source.slice(
    previousProperty.node.offset +
      previousProperty.node.length,
    lastProperty.node.offset,
  );
  if (!/^\s*,\s*$/u.test(delimiter)) {
    throw new TiledMcpError(
      "JSON_SOURCE_PATCH_OBJECT_MISMATCH",
      "Could not infer an object member delimiter from the source document.",
    );
  }
  return delimiter;
}

function objectMemberColon(
  source: string,
  properties: ObjectPropertyNode[],
  emptyPrefix: string,
): string {
  const lastProperty =
    properties[properties.length - 1];
  if (lastProperty === undefined) {
    return emptyPrefix.length === 0 ? ":" : ": ";
  }
  const colon = source.slice(
    lastProperty.keyNode.offset +
      lastProperty.keyNode.length,
    lastProperty.valueNode.offset,
  );
  if (!/^\s*:\s*$/u.test(colon)) {
    throw new TiledMcpError(
      "JSON_SOURCE_PATCH_OBJECT_MISMATCH",
      "Could not infer an object member value separator from the source document.",
    );
  }
  return colon;
}

function emptyObjectMemberPrefix(
  source: string,
  innerWhitespace: string,
): string {
  const newline = innerWhitespace.includes("\r\n")
    ? "\r\n"
    : innerWhitespace.includes("\n")
      ? "\n"
      : innerWhitespace.includes("\r")
        ? "\r"
        : undefined;
  if (newline === undefined) {
    return innerWhitespace;
  }
  const lastLineBreak = Math.max(
    innerWhitespace.lastIndexOf("\n"),
    innerWhitespace.lastIndexOf("\r"),
  );
  const closingIndent = innerWhitespace.slice(
    lastLineBreak + 1,
  );
  return `${newline}${closingIndent}${detectIndentUnit(source)}`;
}

function detectIndentUnit(source: string): string {
  const indents = source
    .split(/\r\n|\r|\n/u)
    .map((line) => line.match(/^[\t ]+/u)?.[0])
    .filter(
      (indent): indent is string =>
        indent !== undefined && indent.length > 0,
    );
  if (
    indents.some((indent) => indent.includes("\t"))
  ) {
    return "\t";
  }
  const widths = indents
    .map((indent) => indent.length)
    .filter((width) => width > 0);
  return " ".repeat(
    widths.length === 0 ? 2 : Math.min(...widths),
  );
}

function arrayDeletionGroupEdits(
  elements: Node[],
  sourceIndices: readonly number[],
): SourceReplacement[] {
  if (sourceIndices.length === 0) {
    return [];
  }
  const deletedIndices = new Set(sourceIndices);
  const keptElements = elements.filter(
    (_element, index) => !deletedIndices.has(index),
  );
  const firstElement = elements[0];
  const lastElement = elements[elements.length - 1];
  if (
    firstElement === undefined ||
    lastElement === undefined
  ) {
    throw new Error(
      "Array deletion lost its source elements.",
    );
  }
  if (keptElements.length === 0) {
    return [
      {
        offset: firstElement.offset,
        length:
          lastElement.offset +
          lastElement.length -
          firstElement.offset,
        content: "",
      },
    ];
  }

  const edits: SourceReplacement[] = [];
  let index = 0;
  while (index < elements.length) {
    const element = elements[index];
    if (
      element === undefined ||
      !deletedIndices.has(index)
    ) {
      index += 1;
      continue;
    }
    const runStart = element;
    let runEnd = element;
    index += 1;
    while (index < elements.length) {
      const candidate = elements[index];
      if (
        candidate === undefined ||
        !deletedIndices.has(index)
      ) {
        break;
      }
      runEnd = candidate;
      index += 1;
    }
    const nextKept = elements[index];
    if (nextKept !== undefined) {
      edits.push({
        offset: runStart.offset,
        length: nextKept.offset - runStart.offset,
        content: "",
      });
      continue;
    }
    const lastKept =
      keptElements[keptElements.length - 1];
    if (lastKept === undefined) {
      throw new Error(
        "Array deletion lost its final retained element.",
      );
    }
    const offset = lastKept.offset + lastKept.length;
    edits.push({
      offset,
      length:
        runEnd.offset + runEnd.length - offset,
      content: "",
    });
  }
  return edits;
}

function requireArrayNode(
  tree: Node,
  readonlyPath: JsonSourcePath,
  projectPath: string,
  document: "source" | "target",
  mismatchCode:
    | "JSON_SOURCE_PATCH_INSERTION_MISMATCH"
    | "JSON_SOURCE_PATCH_DELETION_MISMATCH" =
    "JSON_SOURCE_PATCH_INSERTION_MISMATCH",
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
      mismatchCode,
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

function validateObjectPath(
  path: JsonSourcePath,
  projectPath: string,
): void {
  for (const segment of path) {
    if (
      typeof segment !== "string" &&
      (!Number.isSafeInteger(segment) || segment < 0)
    ) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_INVALID_PATH",
        `Invalid segment in JSON object source patch path ${formatPath(path)} for ${projectPath}.`,
        {
          path: projectPath,
          jsonPath: [...path],
        },
      );
    }
  }
}

function pathsOverlap(
  left: JsonSourcePath,
  right: JsonSourcePath,
): boolean {
  const shorter = Math.min(left.length, right.length);
  for (let index = 0; index < shorter; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
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

function assertNonOverlappingSourceReplacements(
  replacements: readonly SourceReplacement[],
  projectPath: string,
): void {
  const sorted = [...replacements].sort(
    (left, right) =>
      left.offset - right.offset ||
      right.length - left.length,
  );
  let previousOffset = -1;
  let previousEnd = -1;
  for (const replacement of sorted) {
    if (
      replacement.offset < 0 ||
      replacement.length < 0 ||
      replacement.offset === previousOffset ||
      replacement.offset < previousEnd
    ) {
      throw new TiledMcpError(
        "JSON_SOURCE_PATCH_OVERLAPPING_PATHS",
        `Object member source patches overlap in ${projectPath}.`,
        { path: projectPath },
      );
    }
    previousOffset = replacement.offset;
    previousEnd = Math.max(
      previousEnd,
      replacement.offset + replacement.length,
    );
  }
}

function applySourceReplacements(
  source: string,
  replacements: SourceReplacement[],
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
