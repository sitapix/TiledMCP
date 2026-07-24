import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import { TiledMcpError } from "../errors.js";
import { parseJsonDocument } from "../formats/json.js";
import type { ProjectPathResolver } from "../project/pathResolver.js";
import { shortHash } from "./revision.js";

interface LockRecord {
  token: string;
  pid: number;
  createdAt: string;
  target: string;
}

const LOCK_RELEASE_RACE_RETRIES = 64;

export async function withProjectFileLock<T>(
  resolver: ProjectPathResolver,
  target: string,
  operation: () => Promise<T>,
): Promise<T> {
  const locksDirectory = await resolver.ensureInternalDirectory(".tiledmcp/locks");
  const lockPath = join(locksDirectory, `${shortHash(target)}.lock`);
  const token = randomUUID();

  await acquire(lockPath, { token, pid: process.pid, createdAt: new Date().toISOString(), target });
  try {
    return await operation();
  } finally {
    await release(lockPath, token);
  }
}

async function acquire(lockPath: string, record: LockRecord): Promise<void> {
  const candidatePath = `${lockPath}.${record.token}.candidate`;
  let candidateHandle: FileHandle | undefined;
  let candidateCreated = false;
  try {
    candidateHandle = await open(
      candidatePath,
      "wx",
      0o600,
    );
    candidateCreated = true;
    await candidateHandle.writeFile(
      `${JSON.stringify(record)}\n`,
      "utf8",
    );
    await candidateHandle.sync();
    await candidateHandle.close();
    candidateHandle = undefined;

    for (
      let attempt = 0;
      attempt < LOCK_RELEASE_RACE_RETRIES;
      attempt += 1
    ) {
      try {
        await link(candidatePath, lockPath);
        return;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
        let existing: LockRecord;
        try {
          existing = await readLockRecord(lockPath);
        } catch (readError) {
          if (
            isVanishedLockRace(readError) &&
            attempt <
              LOCK_RELEASE_RACE_RETRIES - 1
          ) {
            await yieldEventLoop();
            continue;
          }
          throw readError;
        }
        if (!isProcessAlive(existing.pid)) {
          throw new TiledMcpError(
            "STALE_FILE_LOCK",
            `A previous TiledMCP process left a stale lock for ${record.target}. Remove the lock after verifying no editor is active.`,
            {
              path: record.target,
              stalePid: existing.pid,
              lockFile: `.tiledmcp/locks/${shortHash(record.target)}.lock`,
            },
          );
        }
        throw new TiledMcpError(
          "FILE_LOCKED",
          `Another TiledMCP process is editing ${record.target}. Retry after it finishes.`,
          {
            path: record.target,
            ownerPid: existing.pid,
          },
        );
      }
    }
    throw new TiledMcpError(
      "FILE_LOCK_CORRUPT",
      "The project lock changed too quickly to inspect safely; retry the operation.",
      { reason: "lock-release-race-exhausted" },
    );
  } finally {
    await candidateHandle
      ?.close()
      .catch(() => undefined);
    if (candidateCreated) {
      await unlink(candidatePath).catch(
        () => undefined,
      );
    }
  }
}

async function readLockRecord(lockPath: string): Promise<LockRecord> {
  let raw: string;
  try {
    const handle = await open(
      lockPath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile() || fileStat.size > 4096) {
        throw new Error("lock is not a bounded regular file");
      }
      const buffer = Buffer.allocUnsafe(4097);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
      if (bytesRead > 4096) {
        throw new Error("lock grew beyond its size limit while being read");
      }
      raw = buffer.toString("utf8", 0, bytesRead);
      if (
        !Buffer.from(raw, "utf8").equals(buffer.subarray(0, bytesRead))
      ) {
        throw new Error("lock is not valid UTF-8");
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new TiledMcpError(
      "FILE_LOCK_CORRUPT",
      "The project lock file is malformed or unsafe; inspect it before removing it.",
      {
        reason:
          "unsafe-or-unreadable-lock",
        ...(typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? { causeCode: error.code }
          : {}),
      },
    );
  }

  let value: unknown;
  try {
    value = parseJsonDocument(raw, "project lock");
  } catch {
    throw new TiledMcpError(
      "FILE_LOCK_CORRUPT",
      "The project lock file is not valid JSON; inspect it before removing it.",
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string" ||
    !("target" in value) ||
    typeof value.target !== "string"
  ) {
    throw new TiledMcpError(
      "FILE_LOCK_CORRUPT",
      "The project lock file has an invalid record; inspect it before removing it.",
    );
  }
  return value as LockRecord;
}

async function release(lockPath: string, token: string): Promise<void> {
  try {
    const record = await readLockRecord(lockPath);
    if (record.token === token) {
      await unlink(lockPath);
    }
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      process.stderr.write(`tiled-mcp: could not release lock ${lockPath}: ${String(error)}\n`);
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

function isVanishedLockRace(
  error: unknown,
): boolean {
  return (
    error instanceof TiledMcpError &&
    error.code === "FILE_LOCK_CORRUPT" &&
    error.details.causeCode === "ENOENT"
  );
}

async function yieldEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
