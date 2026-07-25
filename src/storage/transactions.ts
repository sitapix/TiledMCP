import { TiledMcpError } from "../errors.js";
import {
  parseJsonDocument,
  type JsonObject,
} from "../formats/json.js";

export const MIN_TRANSACTION_TARGETS = 2;
export const MAX_TRANSACTION_TARGETS = 16;
export const MAX_TRANSACTION_STAGED_BYTES =
  64 * 1024 * 1024;
export const TRANSACTIONS_DIRECTORY =
  ".tiledmcp/transactions";
export const TRANSACTION_STAGED_DIRECTORY =
  ".tiledmcp/transactions/staged";

const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const OBJECT_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const CHECKPOINT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3,4}-[0-9a-f]{3,4}-[0-9a-f]{12}$/iu;
export const MAX_TRANSACTION_LABEL_LENGTH = 1_024;

export type TransactionTargetInput =
  | {
      kind: "replace";
      path: string;
      expectedRevision: string;
      content: Buffer;
    }
  | {
      kind: "create";
      path: string;
      content: Buffer;
    }
  | {
      kind: "delete";
      path: string;
      expectedRevision: string;
    };

export type TransactionManifestEntry =
  | {
      kind: "replace";
      path: string;
      expectedRevision: string;
      afterRevision: string;
      contentObjectHash: string;
      checkpointId: string;
    }
  | {
      kind: "create";
      path: string;
      afterRevision: string;
      contentObjectHash: string;
      checkpointId: string;
    }
  | {
      kind: "delete";
      path: string;
      expectedRevision: string;
      checkpointId: string;
    };

export interface TransactionManifest {
  version: 1;
  id: string;
  state: "prepared" | "committed";
  createdAt: string;
  label: string;
  entries: TransactionManifestEntry[];
}

export interface TransactionTargetResult {
  kind: "replace" | "create" | "delete";
  path: string;
  beforeRevision: string | null;
  /**
   * The committed content revision, or `null` for a deletion.
   */
  revision: string | null;
  checkpointId: string;
  changed: true;
}

export interface TransactionCommitResult {
  transactionId: string;
  results: TransactionTargetResult[];
  warnings?: string[];
}

export interface TransactionRecoveryConflict {
  transactionId: string;
  path: string;
  reason:
    | "target-diverged"
    | "staged-object-missing"
    | "staged-object-corrupt";
}

export interface TransactionRecoveryReport {
  scannedManifests: number;
  rolledBack: number;
  rolledForwardTargets: number;
  alreadyCompleteTargets: number;
  conflicts: TransactionRecoveryConflict[];
  corruptManifests: string[];
  sweptStagedObjects: number;
  warnings: string[];
}

export function serializeTransactionManifest(
  manifest: TransactionManifest,
): Buffer {
  return Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function corruptTransactionManifest(
  fileName: string,
): TiledMcpError {
  return new TiledMcpError(
    "INVALID_DOCUMENT",
    `Transaction manifest ${fileName} is malformed.`,
    { fileName },
  );
}

export function parseTransactionManifest(
  raw: string,
  fileName: string,
): TransactionManifest {
  let value: unknown;
  try {
    value = parseJsonDocument(raw, fileName);
  } catch {
    throw corruptTransactionManifest(fileName);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw corruptTransactionManifest(fileName);
  }
  const manifest = value as JsonObject;
  const keys = Object.keys(manifest).sort();
  if (
    keys.join("\0") !==
      [
        "createdAt",
        "entries",
        "id",
        "label",
        "state",
        "version",
      ].join("\0") ||
    manifest.version !== 1 ||
    typeof manifest.id !== "string" ||
    !TRANSACTION_ID_PATTERN.test(manifest.id) ||
    fileName !== `${manifest.id}.json` ||
    (manifest.state !== "prepared" &&
      manifest.state !== "committed") ||
    typeof manifest.createdAt !== "string" ||
    !Number.isFinite(
      Date.parse(manifest.createdAt),
    ) ||
    typeof manifest.label !== "string" ||
    manifest.label.length >
      MAX_TRANSACTION_LABEL_LENGTH ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length <
      MIN_TRANSACTION_TARGETS ||
    manifest.entries.length >
      MAX_TRANSACTION_TARGETS
  ) {
    throw corruptTransactionManifest(fileName);
  }
  const seenPaths = new Set<string>();
  for (const entryValue of manifest.entries) {
    if (
      typeof entryValue !== "object" ||
      entryValue === null ||
      Array.isArray(entryValue)
    ) {
      throw corruptTransactionManifest(fileName);
    }
    const entry = entryValue as JsonObject;
    const kind = entry.kind;
    const expectedKeys =
      kind === "replace"
        ? [
            "afterRevision",
            "checkpointId",
            "contentObjectHash",
            "expectedRevision",
            "kind",
            "path",
          ]
        : kind === "create"
          ? [
              "afterRevision",
              "checkpointId",
              "contentObjectHash",
              "kind",
              "path",
            ]
          : kind === "delete"
            ? [
                "checkpointId",
                "expectedRevision",
                "kind",
                "path",
              ]
            : undefined;
    if (
      expectedKeys === undefined ||
      Object.keys(entry).sort().join("\0") !==
        expectedKeys.join("\0") ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      seenPaths.has(entry.path) ||
      typeof entry.checkpointId !== "string" ||
      !CHECKPOINT_ID_PATTERN.test(
        entry.checkpointId,
      ) ||
      (entry.expectedRevision !== undefined &&
        (typeof entry.expectedRevision !==
          "string" ||
          !REVISION_PATTERN.test(
            entry.expectedRevision,
          ))) ||
      (entry.afterRevision !== undefined &&
        (typeof entry.afterRevision !==
          "string" ||
          !REVISION_PATTERN.test(
            entry.afterRevision,
          ))) ||
      (entry.contentObjectHash !== undefined &&
        (typeof entry.contentObjectHash !==
          "string" ||
          !OBJECT_HASH_PATTERN.test(
            entry.contentObjectHash,
          )))
    ) {
      throw corruptTransactionManifest(fileName);
    }
    seenPaths.add(entry.path);
  }
  return value as unknown as TransactionManifest;
}
