import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readImageFileSnapshot } from "../src/images/imageFile.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { revisionOf } from "../src/storage/revision.js";

describe("readImageFileSnapshot", () => {
  let root: string;
  let resolver: ProjectPathResolver;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tiledmcp-image-file-"));
    await mkdir(join(root, "tiles"));
    resolver = await ProjectPathResolver.create(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns exact bytes and a content revision", async () => {
    const bytes = Buffer.from("bounded image bytes", "utf8");
    await writeFile(join(root, "tiles", "atlas.bin"), bytes);

    const snapshot = await readImageFileSnapshot(
      resolver,
      "tiles/atlas.bin",
      bytes.byteLength,
    );
    expect(snapshot).toEqual({
      path: "tiles/atlas.bin",
      bytes,
      revision: revisionOf(bytes),
    });
  });

  it("rejects files that exceed the byte budget before reading them", async () => {
    await writeFile(
      join(root, "tiles", "large.bin"),
      Buffer.from("too large", "utf8"),
    );

    await expect(
      readImageFileSnapshot(resolver, "tiles/large.bin", 2),
    ).rejects.toMatchObject({
      code: "IMAGE_TOO_LARGE",
      details: { path: "tiles/large.bin", limit: 2 },
    });
  });

  it("rejects directories and symbolic links", async () => {
    await mkdir(join(root, "tiles", "directory"));
    await writeFile(join(root, "tiles", "target.bin"), "target");
    await symlink("target.bin", join(root, "tiles", "link.bin"));

    await expect(
      readImageFileSnapshot(resolver, "tiles/directory", 1_024),
    ).rejects.toMatchObject({ code: "INVALID_TILESET_IMAGE" });
    await expect(
      readImageFileSnapshot(resolver, "tiles/link.bin", 1_024),
    ).rejects.toMatchObject({ code: "SYMLINK_NOT_ALLOWED" });
  });
});
