import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  CheckpointStore,
  type CheckpointManifest,
} from "../src/storage/checkpoints.js";
import { revisionOf } from "../src/storage/revision.js";

describe("CheckpointStore listing", () => {
  let root: string;
  let store: CheckpointStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tiledmcp-checkpoints-"));
    const resolver = await ProjectPathResolver.create(root);
    store = new CheckpointStore(resolver);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists prepared and committed manifests and can filter by status", async () => {
    const before = Buffer.from('{"before":true}\n', "utf8");
    const prepared = await store.prepare(
      "maps/prepared.tmj",
      before,
      revisionOf(Buffer.from('{"after":1}\n', "utf8")),
      "prepared edit",
    );
    const committed = await store.markCommitted(
      await store.prepare(
        "maps/committed.tmj",
        undefined,
        revisionOf(Buffer.from('{"after":2}\n', "utf8")),
        "committed create",
      ),
    );

    const all = await store.list();
    const preparedOnly = await store.list({ status: "prepared" });
    const committedOnly = await store.list({ status: "committed" });

    expect(all.manifests.map(({ id }) => id).sort()).toEqual(
      [prepared.id, committed.id].sort(),
    );
    expect(all.corruptEntries).toEqual([]);
    expect(all.truncated).toBe(false);
    expect(preparedOnly.manifests).toEqual([
      expect.objectContaining({ id: prepared.id, status: "prepared" }),
    ]);
    expect(committedOnly.manifests).toEqual([
      expect.objectContaining({ id: committed.id, status: "committed" }),
    ]);
    expect(await store.readBefore(prepared)).toEqual(before);
  });

  it("isolates malformed, inconsistent, unexpected, and symlink entries", async () => {
    const valid = await store.prepare(
      "maps/valid.tmj",
      undefined,
      revisionOf(Buffer.from("valid-after", "utf8")),
      "valid",
    );
    const checkpointsDirectory = join(root, ".tiledmcp", "checkpoints");

    const invalidJsonId = randomUUID();
    await writeFile(
      join(checkpointsDirectory, `${invalidJsonId}.json`),
      '{"version":',
      "utf8",
    );

    const invalidUtf8Id = randomUUID();
    const replacementPathManifest = Buffer.from(
      `${JSON.stringify(
        manifest(invalidUtf8Id, { path: "maps/\uFFFD.tmj" }),
      )}\n`,
      "utf8",
    );
    const replacementBytes = Buffer.from("\uFFFD", "utf8");
    const replacementOffset =
      replacementPathManifest.indexOf(replacementBytes);
    expect(replacementOffset).toBeGreaterThanOrEqual(0);
    await writeFile(
      join(checkpointsDirectory, `${invalidUtf8Id}.json`),
      Buffer.concat([
        replacementPathManifest.subarray(0, replacementOffset),
        Buffer.from([0xff]),
        replacementPathManifest.subarray(
          replacementOffset + replacementBytes.byteLength,
        ),
      ]),
    );

    const oversizedId = randomUUID();
    await writeFile(
      join(checkpointsDirectory, `${oversizedId}.json`),
      "x".repeat(64 * 1024 + 1),
      "utf8",
    );

    const mismatchedHashId = randomUUID();
    const mismatchedHash = manifest(mismatchedHashId, {
      before: {
        existed: true,
        revision: `sha256:${"b".repeat(64)}`,
        objectHash: "a".repeat(64),
        size: 1,
      },
    });
    await writeManifest(checkpointsDirectory, mismatchedHash);

    const reservedPathId = randomUUID();
    await writeManifest(
      checkpointsDirectory,
      manifest(reservedPathId, { path: ".tiledmcp" }),
    );

    const duplicateKeyId = randomUUID();
    const duplicate = manifest(duplicateKeyId);
    await writeFile(
      join(checkpointsDirectory, `${duplicateKeyId}.json`),
      `${JSON.stringify(duplicate).replace(
        '"status":"prepared"',
        '"status":"prepared","status":"committed"',
      )}\n`,
      "utf8",
    );

    const symlinkId = randomUUID();
    await symlink(
      `${valid.id}.json`,
      join(checkpointsDirectory, `${symlinkId}.json`),
    );
    await writeFile(join(checkpointsDirectory, "unexpected-entry"), "noise", "utf8");

    const temporaryName = `${randomUUID()}.json.${randomUUID()}.tmp`;
    await writeFile(join(checkpointsDirectory, temporaryName), "partial", "utf8");

    const uppercaseManifestId =
      randomUUID().toUpperCase();
    await writeManifest(
      checkpointsDirectory,
      manifest(uppercaseManifestId),
    );

    const result = await store.list({ limit: 20 });
    const corruptNames = result.corruptEntries.map(({ fileName }) => fileName);

    expect(result.manifests).toEqual([
      expect.objectContaining({ id: valid.id, status: "prepared" }),
    ]);
    expect(corruptNames).toEqual(
      [
        `${duplicateKeyId}.json`,
        `${invalidJsonId}.json`,
        `${invalidUtf8Id}.json`,
        `${mismatchedHashId}.json`,
        `${oversizedId}.json`,
        `${reservedPathId}.json`,
        `${symlinkId}.json`,
        `${uppercaseManifestId}.json`,
        "unexpected-entry",
      ].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
    expect(corruptNames).not.toContain(temporaryName);
    expect(result.corruptEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkpointId: symlinkId,
          code: "CHECKPOINT_CORRUPT",
        }),
        expect.objectContaining({
          checkpointId: mismatchedHashId,
          code: "CHECKPOINT_CORRUPT",
        }),
        {
          fileName: `${uppercaseManifestId}.json`,
          code: "CHECKPOINT_CORRUPT",
          message:
            "Unexpected entry in the checkpoint manifest directory.",
        },
      ]),
    );
    await expect(store.read(mismatchedHashId)).rejects.toMatchObject({
      code: "CHECKPOINT_CORRUPT",
    });
    await expect(store.read(reservedPathId)).rejects.toMatchObject({
      code: "CHECKPOINT_CORRUPT",
    });
  });

  it("enforces returned-entry and directory-scan budgets", async () => {
    for (const index of [1, 2, 3]) {
      await store.prepare(
        `maps/${index}.tmj`,
        undefined,
        revisionOf(Buffer.from(`after-${index}`, "utf8")),
        `checkpoint ${index}`,
      );
    }

    const limited = await store.list({ limit: 1 });
    expect(limited.manifests).toHaveLength(1);
    expect(limited.corruptEntries).toHaveLength(0);
    expect(limited.truncated).toBe(true);

    const scanLimited = await store.list({ limit: 10, scanLimit: 1 });
    expect(scanLimited.scannedEntries).toBe(1);
    expect(scanLimited.truncated).toBe(true);

    await expect(store.list({ limit: 0 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(store.list({ limit: 1_001 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(store.list({ scanLimit: 10_001 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("pages the whole store deterministically through startAfter", async () => {
    for (const index of [1, 2, 3]) {
      await store.prepare(
        `maps/${index}.tmj`,
        undefined,
        revisionOf(Buffer.from(`after-${index}`, "utf8")),
        `checkpoint ${index}`,
      );
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    while (true) {
      const page = await store.list({
        limit: 1,
        ...(cursor === undefined ? {} : { startAfter: cursor }),
      });
      expect(page.manifests.length + page.corruptEntries.length).toBe(1);
      collected.push(...page.manifests.map((manifest) => manifest.id));
      pages += 1;
      if (!page.hasMore) {
        expect(page.nextStartAfter).toBeUndefined();
        break;
      }
      expect(page.nextStartAfter).toBeDefined();
      cursor = page.nextStartAfter;
    }

    const all = await store.list();
    expect(all.hasMore).toBe(false);
    expect(pages).toBe(3);
    expect([...collected].sort()).toEqual(
      all.manifests.map((manifest) => manifest.id).sort(),
    );
    expect(new Set(collected).size).toBe(3);

    await expect(store.list({ startAfter: "" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("uses an exact UUID-shaped checkpoint id", async () => {
    await expect(
      store.read("aaaaaaaa------------------------------------"),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

function manifest(
  id: string,
  overrides: Partial<CheckpointManifest> = {},
): CheckpointManifest {
  return {
    version: 1,
    id,
    createdAt: "2026-07-24T00:00:00.000Z",
    label: "test checkpoint",
    path: "maps/test.tmj",
    status: "prepared",
    before: { existed: false },
    afterRevision: revisionOf(Buffer.from("after", "utf8")),
    ...overrides,
  };
}

async function writeManifest(
  checkpointsDirectory: string,
  value: CheckpointManifest,
): Promise<void> {
  await writeFile(
    join(checkpointsDirectory, `${value.id}.json`),
    `${JSON.stringify(value)}\n`,
    "utf8",
  );
}
