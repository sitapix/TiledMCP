import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

import { TiledMcpError } from "../errors.js";

const ASSET_EXTENSIONS = new Set([
  ".tmj",
  ".tmx",
  ".tsj",
  ".tsx",
  ".tj",
  ".tx",
  ".world",
  ".tiled-project",
]);

const SKIPPED_DIRECTORIES = new Set([".git", ".tiledmcp", "dist", "node_modules"]);

export interface ProjectAsset {
  path: string;
  kind: "map" | "project" | "template" | "tileset" | "world";
}

export class ProjectPathResolver {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(rootInput: string): Promise<ProjectPathResolver> {
    const root = await realpath(resolve(rootInput));
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      throw new TiledMcpError("INVALID_PROJECT_ROOT", `${root} is not a directory.`);
    }
    return new ProjectPathResolver(root);
  }

  normalize(projectPath: string): string {
    if (
      projectPath.length === 0 ||
      projectPath.includes("\0") ||
      projectPath.includes("\\") ||
      posix.isAbsolute(projectPath) ||
      /^[A-Za-z]:/.test(projectPath)
    ) {
      throw new TiledMcpError(
        "INVALID_PROJECT_PATH",
        `Project paths must be non-empty relative POSIX paths: ${projectPath}`,
        { path: projectPath },
      );
    }

    const normalized = posix.normalize(projectPath);
    if (
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized !== projectPath
    ) {
      throw new TiledMcpError(
        "INVALID_PROJECT_PATH",
        `Project path is not canonical or escapes the root: ${projectPath}`,
        { path: projectPath },
      );
    }
    return normalized;
  }

  async resolveExisting(projectPath: string): Promise<string> {
    const normalized = this.normalize(projectPath);
    this.assertPublicProjectPath(normalized);
    const candidate = this.lexicalPath(normalized);
    try {
      await this.assertNoSymlink(candidate, false);
      const canonical = await realpath(candidate);
      this.assertInside(canonical, projectPath);
      return canonical;
    } catch (error) {
      if (isMissing(error)) {
        throw new TiledMcpError(
          "FILE_NOT_FOUND",
          `Project file does not exist: ${normalized}`,
          { path: normalized },
        );
      }
      throw error;
    }
  }

  async resolveForCreate(projectPath: string): Promise<string> {
    const normalized = this.normalize(projectPath);
    this.assertPublicProjectPath(normalized);
    const candidate = this.lexicalPath(normalized);
    const parent = dirname(candidate);
    try {
      await this.assertNoSymlink(parent, false);
      this.assertInside(await realpath(parent), projectPath);
    } catch (error) {
      if (isMissing(error)) {
        throw new TiledMcpError(
          "PARENT_DIRECTORY_NOT_FOUND",
          `Parent directory does not exist for ${normalized}.`,
          { path: normalized },
        );
      }
      throw error;
    }

    try {
      const targetStat = await lstat(candidate);
      if (targetStat.isSymbolicLink()) {
        throw new TiledMcpError(
          "SYMLINK_NOT_ALLOWED",
          `Refusing to access symbolic link ${projectPath}.`,
          { path: projectPath },
        );
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    return candidate;
  }

  async resolveReference(fromProjectPath: string, referencePath: string): Promise<string> {
    if (
      referencePath.length === 0 ||
      referencePath.includes("\0") ||
      referencePath.includes("\\") ||
      posix.isAbsolute(referencePath) ||
      /^[A-Za-z]:/.test(referencePath)
    ) {
      throw new TiledMcpError(
        "EXTERNAL_REFERENCE_NOT_ALLOWED",
        `Reference must be a relative POSIX path inside the project: ${referencePath}`,
        { from: fromProjectPath, reference: referencePath },
      );
    }

    const joined = posix.normalize(posix.join(posix.dirname(this.normalize(fromProjectPath)), referencePath));
    if (joined === ".." || joined.startsWith("../")) {
      throw new TiledMcpError(
        "EXTERNAL_REFERENCE_NOT_ALLOWED",
        `Reference escapes the project root: ${referencePath}`,
        { from: fromProjectPath, reference: referencePath },
      );
    }
    await this.resolveExisting(joined);
    return joined;
  }

  toProjectPath(absolutePath: string): string {
    this.assertInside(absolutePath, absolutePath);
    return relative(this.root, absolutePath).split(sep).join("/");
  }

  async ensureInternalDirectory(relativePath: string): Promise<string> {
    if (!relativePath.startsWith(".tiledmcp/") && relativePath !== ".tiledmcp") {
      throw new TiledMcpError(
        "INVALID_INTERNAL_PATH",
        `Internal directories must live under .tiledmcp: ${relativePath}`,
      );
    }
    const normalized = this.normalize(relativePath);
    const target = this.lexicalPath(normalized);
    let current = this.root;
    for (const segment of normalized.split("/")) {
      current = join(current, segment);
      let currentStat: Stats;
      try {
        currentStat = await lstat(current);
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (!hasCode(mkdirError, "EEXIST")) {
            throw mkdirError;
          }
        }
        currentStat = await lstat(current);
      }
      if (currentStat.isSymbolicLink()) {
        throw new TiledMcpError(
          "SYMLINK_NOT_ALLOWED",
          `Symbolic links are not allowed inside the project sandbox: ${this.toProjectPath(current)}`,
        );
      }
      if (!currentStat.isDirectory()) {
        throw new TiledMcpError(
          "INVALID_INTERNAL_PATH",
          `Internal path component is not a directory: ${this.toProjectPath(current)}`,
        );
      }
    }
    this.assertInside(await realpath(target), relativePath);
    return target;
  }

  async listAssets(limit = 10_000): Promise<ProjectAsset[]> {
    const assets: ProjectAsset[] = [];
    await this.walk(this.root, assets, limit, {
      visited: 0,
      maxVisited: Math.max(100_000, Math.min(1_000_000, limit * 100)),
    });
    assets.sort((left, right) => left.path.localeCompare(right.path));
    return assets;
  }

  private lexicalPath(projectPath: string): string {
    const candidate = resolve(this.root, ...projectPath.split("/"));
    this.assertInside(candidate, projectPath);
    return candidate;
  }

  private assertPublicProjectPath(projectPath: string): void {
    if (projectPath === ".tiledmcp" || projectPath.startsWith(".tiledmcp/")) {
      throw new TiledMcpError(
        "RESERVED_PROJECT_PATH",
        `${projectPath} is inside .tiledmcp, which is reserved for server safety state and not addressable by tools. Pick a project asset path outside .tiledmcp (tiled_list_files shows them).`,
        { path: projectPath },
      );
    }
  }

  private assertInside(candidate: string, source: string): void {
    const fromRoot = relative(this.root, candidate);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new TiledMcpError(
        "PATH_OUTSIDE_ROOT",
        `Path escapes the project sandbox: ${source}. Use a project-relative POSIX path with no leading slash and no ".." segments; tiled_list_files shows addressable paths.`,
        {
          path: source,
        },
      );
    }
  }

  private async assertNoSymlink(target: string, allowMissingLast: boolean): Promise<void> {
    const fromRoot = relative(this.root, target);
    this.assertInside(target, target);
    if (fromRoot.length === 0) {
      return;
    }

    const segments = fromRoot.split(sep);
    let current = this.root;
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      try {
        const currentStat = await lstat(current);
        if (currentStat.isSymbolicLink()) {
          throw new TiledMcpError(
            "SYMLINK_NOT_ALLOWED",
            `Symbolic links are not allowed inside the project sandbox: ${this.toProjectPath(current)}`,
          );
        }
      } catch (error) {
        if (allowMissingLast && index === segments.length - 1 && isMissing(error)) {
          return;
        }
        throw error;
      }
    }
  }

  private async walk(
    directory: string,
    assets: ProjectAsset[],
    limit: number,
    budget: { visited: number; maxVisited: number },
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      budget.visited += 1;
      if (budget.visited > budget.maxVisited) {
        throw new TiledMcpError(
          "RESULT_LIMIT_EXCEEDED",
          `Project traversal exceeded ${budget.maxVisited} filesystem entries.`,
          { limit: budget.maxVisited },
        );
      }
      if (entry.isSymbolicLink()) {
        continue;
      }

      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          await this.walk(absolute, assets, limit, budget);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const extension = posix.extname(entry.name).toLowerCase();
      if (!ASSET_EXTENSIONS.has(extension)) {
        continue;
      }
      if (assets.length >= limit) {
        throw new TiledMcpError("RESULT_LIMIT_EXCEEDED", `Project has more than ${limit} assets.`, {
          limit,
        });
      }
      assets.push({ path: this.toProjectPath(absolute), kind: assetKind(extension) });
    }
  }
}

function assetKind(extension: string): ProjectAsset["kind"] {
  switch (extension) {
    case ".tmj":
    case ".tmx":
      return "map";
    case ".tsj":
    case ".tsx":
      return "tileset";
    case ".tj":
    case ".tx":
      return "template";
    case ".world":
      return "world";
    case ".tiled-project":
      return "project";
    default:
      throw new TiledMcpError("UNSUPPORTED_FORMAT", `Unsupported extension ${extension}.`);
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
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
