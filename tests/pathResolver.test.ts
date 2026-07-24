import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectPathResolver } from "../src/project/pathResolver.js";

describe("ProjectPathResolver", () => {
  let root: string;
  let resolver: ProjectPathResolver;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tiledmcp-path-resolver-"));
    resolver = await ProjectPathResolver.create(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    "../outside.tmj",
    "maps/../../outside.tmj",
    "/absolute/map.tmj",
    "C:/absolute/map.tmj",
    "maps/../level.tmj",
    "maps/./level.tmj",
    "maps//level.tmj",
    String.raw`maps\level.tmj`,
    "",
  ])("rejects unsafe or non-canonical project path %j", (projectPath) => {
    let thrown: unknown;
    try {
      resolver.normalize(projectPath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "TiledMcpError",
      code: "INVALID_PROJECT_PATH",
    });
  });

  it("rejects references that traverse outside the project", async () => {
    await expect(
      resolver.resolveReference("maps/level.tmj", "../../outside.tsj"),
    ).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "EXTERNAL_REFERENCE_NOT_ALLOWED",
    });
  });

  it("reserves the .tiledmcp namespace from asset reads and writes", async () => {
    await expect(
      resolver.resolveForCreate(".tiledmcp/locks/fake.tmj"),
    ).rejects.toMatchObject({ code: "RESERVED_PROJECT_PATH" });
    await expect(
      resolver.resolveExisting(".tiledmcp/checkpoints/fake.tmj"),
    ).rejects.toMatchObject({ code: "RESERVED_PROJECT_PATH" });
  });

  it("rejects an existing file reached through an internal directory symlink", async () => {
    await mkdir(join(root, "actual-maps"));
    await writeFile(join(root, "actual-maps", "level.tmj"), "{}\n", "utf8");
    await symlink("actual-maps", join(root, "maps"), "dir");

    await expect(resolver.resolveExisting("maps/level.tmj")).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "SYMLINK_NOT_ALLOWED",
    });
  });

  it("rejects creating a file below an internal directory symlink", async () => {
    await mkdir(join(root, "actual-maps"));
    await symlink("actual-maps", join(root, "maps"), "dir");

    await expect(resolver.resolveForCreate("maps/new.tmj")).rejects.toMatchObject({
      name: "TiledMcpError",
      code: "SYMLINK_NOT_ALLOWED",
    });
  });

  it("does not create internal state through a pre-existing symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "tiledmcp-outside-"));
    try {
      await symlink(outside, join(root, ".tiledmcp"), "dir");

      await expect(
        resolver.ensureInternalDirectory(".tiledmcp/locks"),
      ).rejects.toMatchObject({
        name: "TiledMcpError",
        code: "SYMLINK_NOT_ALLOWED",
      });
      await expect(stat(join(outside, "locks"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
