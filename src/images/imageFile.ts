import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { TiledMcpError } from "../errors.js";
import type { ProjectPathResolver } from "../project/pathResolver.js";
import {
  fileIdentityOf,
  sameFileSnapshot,
  type FileIdentity,
} from "../storage/fileIdentity.js";
import { revisionOf } from "../storage/revision.js";

export interface ImageFileSnapshot {
  path: string;
  bytes: Buffer;
  revision: string;
  identity: FileIdentity;
}

/**
 * Reads an image through an already-sandboxed project path without trusting a
 * potentially changing size from stat(2). The before/after identity check
 * catches ordinary in-place writers; the project capability statement still
 * documents that hostile parent swaps are outside the current threat model.
 */
export async function readImageFileSnapshot(
  resolver: ProjectPathResolver,
  projectPath: string,
  maxBytes: number,
): Promise<ImageFileSnapshot> {
  const normalized = resolver.normalize(projectPath);
  const absolutePath = await resolver.resolveExisting(normalized);
  let handle;
  try {
    handle = await open(
      absolutePath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (hasCode(error, "ELOOP")) {
      throw new TiledMcpError(
        "SYMLINK_NOT_ALLOWED",
        `Refusing to follow symbolic link ${normalized}.`,
        { path: normalized },
      );
    }
    throw error;
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new TiledMcpError(
        "INVALID_TILESET_IMAGE",
        `${normalized} is not a regular image file.`,
        { path: normalized },
      );
    }
    if (before.size > BigInt(maxBytes)) {
      throw imageTooLarge(normalized, before.size, maxBytes);
    }

    const chunks: Buffer[] = [];
    const scratch = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        scratch,
        0,
        scratch.byteLength,
        null,
      );
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
      if (total > maxBytes) {
        throw imageTooLarge(normalized, BigInt(total), maxBytes);
      }
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }

    const after = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(before, after) || BigInt(total) !== after.size) {
      throw new TiledMcpError(
        "IMAGE_CHANGED_DURING_READ",
        `${normalized} changed while it was being read. Retry the render.`,
        { path: normalized },
      );
    }

    const bytes = Buffer.concat(chunks, total);
    return {
      path: normalized,
      bytes,
      revision: revisionOf(bytes),
      identity: fileIdentityOf(after),
    };
  } finally {
    await handle.close();
  }
}

function imageTooLarge(
  path: string,
  actual: bigint,
  limit: number,
): TiledMcpError {
  return new TiledMcpError(
    "IMAGE_TOO_LARGE",
    `${path} exceeds the ${limit} byte input limit.`,
    {
      path,
      size:
        actual <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(actual)
          : actual.toString(),
      limit,
    },
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
