import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { withProjectFileLock } from "../src/storage/fileLock.js";
import { shortHash } from "../src/storage/revision.js";

describe("withProjectFileLock", () => {
  let root: string;
  let resolver: ProjectPathResolver;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tiledmcp-lock-"));
    resolver = await ProjectPathResolver.create(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("allows only one live owner for a target", async () => {
    let releaseOwner = (): void => undefined;
    let ownerAcquired = (): void => undefined;
    const acquired = new Promise<void>((resolve) => {
      ownerAcquired = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const owner = withProjectFileLock(resolver, "map.tmj", async () => {
      ownerAcquired();
      await hold;
    });
    await acquired;

    await expect(
      withProjectFileLock(resolver, "map.tmj", async () => undefined),
    ).rejects.toMatchObject({ code: "FILE_LOCKED" });

    releaseOwner();
    await owner;
    await expect(
      withProjectFileLock(resolver, "map.tmj", async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("reports but never races to delete a stale lock", async () => {
    const locks = await resolver.ensureInternalDirectory(".tiledmcp/locks");
    const lockPath = join(locks, `${shortHash("map.tmj")}.lock`);
    const stale = {
      token: "stale-token",
      pid: 2_000_000_000,
      createdAt: new Date(0).toISOString(),
      target: "map.tmj",
    };
    await writeFile(lockPath, `${JSON.stringify(stale)}\n`, "utf8");

    await expect(
      withProjectFileLock(resolver, "map.tmj", async () => undefined),
    ).rejects.toMatchObject({
      code: "STALE_FILE_LOCK",
      details: {
        path: "map.tmj",
        stalePid: stale.pid,
        lockFile: `.tiledmcp/locks/${shortHash("map.tmj")}.lock`,
      },
    });
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(stale);
  });

  it("fails closed on an empty lock left by older implementations", async () => {
    const locks = join(root, ".tiledmcp", "locks");
    await mkdir(locks, { recursive: true });
    await writeFile(join(locks, `${shortHash("map.tmj")}.lock`), "");

    await expect(
      withProjectFileLock(resolver, "map.tmj", async () => undefined),
    ).rejects.toMatchObject({ code: "FILE_LOCK_CORRUPT" });
  });

  it("does not expose the absolute lock path when the lock entry is unsafe", async () => {
    const locks = join(
      root,
      ".tiledmcp",
      "locks",
    );
    await mkdir(locks, { recursive: true });
    await mkdir(
      join(
        locks,
        `${shortHash("map.tmj")}.lock`,
      ),
    );

    let caught: unknown;
    try {
      await withProjectFileLock(
        resolver,
        "map.tmj",
        async () => undefined,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "FILE_LOCK_CORRUPT",
      message:
        "The project lock file is malformed or unsafe; inspect it before removing it.",
      details: {
        reason:
          "unsafe-or-unreadable-lock",
      },
    });
    expect(JSON.stringify(caught)).not.toContain(
      root,
    );
  });
});
