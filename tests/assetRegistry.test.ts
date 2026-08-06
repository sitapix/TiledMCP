import { spawn } from "node:child_process";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { TiledMcpError } from "../src/errors.js";
import {
  ASSET_REGISTRY_FORMAT,
  ASSET_REGISTRY_RELATIVE_PATH,
  AssetRegistry,
  MAX_ASSET_REGISTRY_BYTES,
  MAX_ASSET_REGISTRY_ENTRIES,
  supportsAssetRenameContinuity,
  type AssetIdentityObservation,
  type AssetIdentityKind,
} from "../src/project/assetRegistry.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import {
  fileIdentityOf,
  type FileIdentity,
} from "../src/storage/fileIdentity.js";
import { shortHash } from "../src/storage/revision.js";

const FIRST_PATH = "tiles/terrain.tsj";
const SECOND_PATH = "tiles/objects.tsj";
const FALLBACK_ASSET_ID =
  "asset_ffffffffffffffffffffffff";

interface RegistryEntryFixture {
  assetId: string;
  kind: AssetIdentityKind;
  path: string;
  identity: FileIdentity;
}

interface RegistryFixture {
  format: typeof ASSET_REGISTRY_FORMAT;
  formatVersion: number;
  generation: number;
  entries: RegistryEntryFixture[];
}

describe("AssetRegistry", () => {
  let root: string;
  let resolver: ProjectPathResolver;

  beforeEach(async () => {
    root = await mkdtemp(
      join(tmpdir(), "tiledmcp-asset-registry-"),
    );
    resolver =
      await ProjectPathResolver.create(root);
  });

  afterEach(async () => {
    await rm(root, {
      recursive: true,
      force: true,
    });
  });

  it.each([
    {
      kind: "external-tileset" as const,
      path: FIRST_PATH,
    },
    {
      kind: "image-layer" as const,
      path: "images/background.png",
    },
  ])(
    "uses the legacy path-derived ID for the first $kind observation",
    async ({ kind, path }) => {
      await writeAsset(root, path, "first");

      const registry = new AssetRegistry(resolver);
      const assetId =
        await registry.resolvePath(kind, path);

      expect(assetId).toBe(
        legacyAssetId(kind, path),
      );
      expect(await readRegistry(root)).toEqual({
        format: ASSET_REGISTRY_FORMAT,
        formatVersion: 1,
        generation: 1,
        entries: [
          expect.objectContaining({
            assetId,
            kind,
            path,
          }),
        ],
      });
    },
  );

  it("resolves a batch in input order with one registry read and one commit", async () => {
    await writeAsset(root, FIRST_PATH, "first");
    await writeAsset(root, SECOND_PATH, "second");
    const firstObservation =
      await observationAt(
        root,
        "external-tileset",
        FIRST_PATH,
      );
    const secondObservation =
      await observationAt(
        root,
        "external-tileset",
        SECOND_PATH,
      );
    const registry = new AssetRegistry(resolver);
    const io = registry as unknown as {
      readFromDisk: () => Promise<unknown>;
      writeToDisk: (
        document: unknown,
      ) => Promise<void>;
    };
    const originalRead =
      io.readFromDisk.bind(registry);
    const originalWrite =
      io.writeToDisk.bind(registry);
    let reads = 0;
    let writes = 0;
    io.readFromDisk = async () => {
      reads += 1;
      return await originalRead();
    };
    io.writeToDisk = async (document) => {
      writes += 1;
      await originalWrite(document);
    };

    const assetIds = await registry.resolveMany([
      secondObservation,
      firstObservation,
      secondObservation,
    ]);

    expect(assetIds).toEqual([
      legacyAssetId(
        "external-tileset",
        SECOND_PATH,
      ),
      legacyAssetId(
        "external-tileset",
        FIRST_PATH,
      ),
      legacyAssetId(
        "external-tileset",
        SECOND_PATH,
      ),
    ]);
    expect({ reads, writes }).toEqual({
      reads: 1,
      writes: 1,
    });
    expect(await readRegistry(root)).toEqual(
      expect.objectContaining({
        generation: 1,
        entries: [
          expect.any(Object),
          expect.any(Object),
        ],
      }),
    );
  });

  it("resolves without persisting, locking or creating internal state in read-only mode", async () => {
    await writeAsset(root, FIRST_PATH, "first");
    const observation = await observationAt(
      root,
      "external-tileset",
      FIRST_PATH,
    );
    const registry = new AssetRegistry(resolver);
    const io = registry as unknown as {
      writeToDisk: (
        document: unknown,
      ) => Promise<void>;
    };
    const originalWrite =
      io.writeToDisk.bind(registry);
    let writes = 0;
    io.writeToDisk = async (document) => {
      writes += 1;
      await originalWrite(document);
    };

    const readOnlyId = await registry.resolve(
      observation,
      { persistIdentity: false },
    );
    expect(readOnlyId).toBe(
      legacyAssetId("external-tileset", FIRST_PATH),
    );
    expect(writes).toBe(0);
    await expect(
      readFile(
        join(
          root,
          ".tiledmcp",
          "asset-registry.v1.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readdir(join(root, ".tiledmcp", "locks")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // A later persisting resolution reproduces the same deterministic ID
    // and records it durably.
    const persistedId = await registry.resolve(
      observation,
    );
    expect(persistedId).toBe(readOnlyId);
    expect(writes).toBe(1);
    expect(await readRegistry(root)).toEqual(
      expect.objectContaining({
        generation: 1,
        entries: [
          expect.objectContaining({
            assetId: readOnlyId,
          }),
        ],
      }),
    );
  });

  it("adopts a registered rename in read-only mode without rewriting the entry", async () => {
    await writeAsset(root, FIRST_PATH, "first");
    const registry = new AssetRegistry(resolver);
    const persistedId = await registry.resolve(
      await observationAt(
        root,
        "external-tileset",
        FIRST_PATH,
      ),
    );
    const registryBefore = await readFile(
      join(
        root,
        ".tiledmcp",
        "asset-registry.v1.json",
      ),
    );
    await rename(
      join(root, FIRST_PATH),
      join(root, SECOND_PATH),
    );

    const adoptedId = await registry.resolve(
      await observationAt(
        root,
        "external-tileset",
        SECOND_PATH,
      ),
      { persistIdentity: false },
    );
    expect(adoptedId).toBe(persistedId);
    expect(
      await readFile(
        join(
          root,
          ".tiledmcp",
          "asset-registry.v1.json",
        ),
      ),
    ).toEqual(registryBefore);
  });

  it("does not commit a prepared batch when its synchronous check rejects", async () => {
    await writeAsset(root, FIRST_PATH, "first");
    await writeAsset(root, SECOND_PATH, "second");
    const observations = [
      await observationAt(
        root,
        "external-tileset",
        SECOND_PATH,
      ),
      await observationAt(
        root,
        "external-tileset",
        FIRST_PATH,
      ),
    ] as const;
    let checkedIds:
      readonly string[] | undefined;

    await expect(
      new AssetRegistry(
        resolver,
      ).resolveManyChecked(
        observations,
        (assetIds) => {
          checkedIds = assetIds;
          throw new TiledMcpError(
            "INVALID_DOCUMENT",
            "synthetic batch validation failure",
          );
        },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
    expect(checkedIds).toEqual([
      legacyAssetId(
        "external-tileset",
        SECOND_PATH,
      ),
      legacyAssetId(
        "external-tileset",
        FIRST_PATH,
      ),
    ]);
    expect(
      Object.isFrozen(checkedIds),
    ).toBe(true);
    await expect(
      readFile(registryPath(root)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not commit a prepared batch when its asynchronous check rejects", async () => {
    await writeAsset(root, FIRST_PATH, "first");
    const observation = await observationAt(
      root,
      "external-tileset",
      FIRST_PATH,
    );

    await expect(
      new AssetRegistry(
        resolver,
      ).resolveManyChecked(
        [observation],
        async (assetIds) => {
          await Promise.resolve();
          expect(assetIds).toEqual([
            legacyAssetId(
              "external-tileset",
              FIRST_PATH,
            ),
          ]);
          throw new TiledMcpError(
            "INVALID_DOCUMENT",
            "synthetic asynchronous batch validation failure",
          );
        },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
    await expect(
      readFile(registryPath(root)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not guess a rename when a batch reveals two live destinations for one identity", async () => {
    const thirdPath = "tiles/decor.tsj";
    await writeAsset(root, FIRST_PATH, "same inode");
    const originalId =
      await new AssetRegistry(
        resolver,
      ).resolvePath(
        "external-tileset",
        FIRST_PATH,
      );

    await link(
      join(root, FIRST_PATH),
      join(root, SECOND_PATH),
    );
    await link(
      join(root, FIRST_PATH),
      join(root, thirdPath),
    );
    await rm(join(root, FIRST_PATH));
    const registry = new AssetRegistry(
      await ProjectPathResolver.create(root),
    );
    const assetIds = await registry.resolveMany([
      await observationAt(
        root,
        "external-tileset",
        SECOND_PATH,
      ),
      await observationAt(
        root,
        "external-tileset",
        thirdPath,
      ),
    ]);

    expect(assetIds[0]).not.toBe(originalId);
    expect(assetIds[1]).not.toBe(originalId);
    expect(assetIds[1]).not.toBe(assetIds[0]);
    const document = await readRegistry(root);
    expect(document.generation).toBe(2);
    expect(document.entries).toHaveLength(3);
    expect(
      document.entries.map(({ path }) => path),
    ).toEqual(
      expect.arrayContaining([
        FIRST_PATH,
        SECOND_PATH,
        thirdPath,
      ]),
    );
  });

  it.each([
    {
      name: "zero inode",
      identity: {
        device: "1",
        inode: "0",
        birthtimeNs: "3",
      },
    },
    {
      name: "zero birthtime",
      identity: {
        device: "1",
        inode: "2",
        birthtimeNs: "0",
      },
    },
  ])(
    "does not migrate an ID using a weak identity with $name",
    async ({ identity }) => {
      const oldId =
        "asset_111111111111111111111111";
      await writeAsset(
        root,
        SECOND_PATH,
        "new path",
      );
      await writeRegistry(root, {
        format: ASSET_REGISTRY_FORMAT,
        formatVersion: 1,
        generation: 4,
        entries: [
          {
            assetId: oldId,
            kind: "external-tileset",
            path: FIRST_PATH,
            identity,
          },
        ],
      });
      const registry =
        new AssetRegistry(resolver);
      const identityObserver =
        registry as unknown as {
          observePathIdentity: (
            path: string,
          ) => Promise<FileIdentity>;
        };
      identityObserver.observePathIdentity =
        async () => identity;

      expect(
        supportsAssetRenameContinuity(identity),
      ).toBe(false);
      const newId = await registry.resolve({
        kind: "external-tileset",
        path: SECOND_PATH,
        identity,
      });

      expect(newId).toBe(
        legacyAssetId(
          "external-tileset",
          SECOND_PATH,
        ),
      );
      expect(newId).not.toBe(oldId);
      const document = await readRegistry(root);
      expect(document.generation).toBe(5);
      expect(document.entries).toHaveLength(2);
    },
  );

  it("keeps same-path continuity even when rename identity evidence is weak", async () => {
    const weakIdentity: FileIdentity = {
      device: "1",
      inode: "0",
      birthtimeNs: "0",
    };
    const oldId =
      "asset_111111111111111111111111";
    await writeAsset(root, FIRST_PATH, "same path");
    await writeRegistry(root, {
      format: ASSET_REGISTRY_FORMAT,
      formatVersion: 1,
      generation: 4,
      entries: [
        {
          assetId: oldId,
          kind: "external-tileset",
          path: FIRST_PATH,
          identity: weakIdentity,
        },
      ],
    });
    const registry = new AssetRegistry(resolver);
    const identityObserver =
      registry as unknown as {
        observePathIdentity: (
          path: string,
        ) => Promise<FileIdentity>;
      };
    identityObserver.observePathIdentity =
      async () => weakIdentity;

    await expect(
      registry.resolve({
        kind: "external-tileset",
        path: FIRST_PATH,
        identity: weakIdentity,
      }),
    ).resolves.toBe(oldId);
    expect(
      (await readRegistry(root)).generation,
    ).toBe(4);
  });

  it("keeps each registered path ID when two files swap paths", async () => {
    await writeAsset(root, FIRST_PATH, "first");
    await writeAsset(root, SECOND_PATH, "second");
    const registry = new AssetRegistry(resolver);
    const [firstId, secondId] =
      await registry.resolveMany([
        await observationAt(
          root,
          "external-tileset",
          FIRST_PATH,
        ),
        await observationAt(
          root,
          "external-tileset",
          SECOND_PATH,
        ),
      ]);
    const temporaryPath =
      join(root, "tiles", ".swap.tmp");
    await rename(
      join(root, FIRST_PATH),
      temporaryPath,
    );
    await rename(
      join(root, SECOND_PATH),
      join(root, FIRST_PATH),
    );
    await rename(
      temporaryPath,
      join(root, SECOND_PATH),
    );

    const restarted = new AssetRegistry(
      await ProjectPathResolver.create(root),
    );
    const afterSwap = await restarted.resolveMany([
      await observationAt(
        root,
        "external-tileset",
        FIRST_PATH,
      ),
      await observationAt(
        root,
        "external-tileset",
        SECOND_PATH,
      ),
    ]);

    expect(afterSwap).toEqual([
      firstId,
      secondId,
    ]);
    expect(
      await readFile(
        join(root, FIRST_PATH),
        "utf8",
      ),
    ).toBe("second");
    expect(
      await readFile(
        join(root, SECOND_PATH),
        "utf8",
      ),
    ).toBe("first");
    expect(
      (await readRegistry(root)).generation,
    ).toBe(2);
  });

  it("keeps the ID when an editor atomically saves new bytes at the same path", async () => {
    await writeAsset(root, FIRST_PATH, "before");
    const firstRegistry =
      new AssetRegistry(resolver);
    const firstId =
      await firstRegistry.resolvePath(
        "external-tileset",
        FIRST_PATH,
      );

    const replacementPath =
      join(root, "tiles", ".replacement.tmp");
    await writeFile(
      replacementPath,
      "after",
      "utf8",
    );
    await rename(
      replacementPath,
      join(root, FIRST_PATH),
    );

    const secondRegistry =
      new AssetRegistry(resolver);
    await expect(
      secondRegistry.resolvePath(
        "external-tileset",
        FIRST_PATH,
      ),
    ).resolves.toBe(firstId);

    const document = await readRegistry(root);
    expect(document.entries).toHaveLength(1);
    expect(document.entries[0]).toMatchObject({
      assetId: firstId,
      path: FIRST_PATH,
    });
  });

  it.each([
    {
      kind: "external-tileset" as const,
      code: "DOCUMENT_CHANGED_DURING_READ",
    },
    {
      kind: "image-layer" as const,
      code: "IMAGE_CHANGED_DURING_READ",
    },
  ])(
    "rejects a stale $kind observation inside the registry lock",
    async ({ kind, code }) => {
      await writeAsset(root, FIRST_PATH, "before");
      await writeAsset(root, SECOND_PATH, "seed");
      const registry =
        new AssetRegistry(resolver);
      await registry.resolvePath(
        kind,
        SECOND_PATH,
      );
      const beforeRegistry = await readFile(
        registryPath(root),
        "utf8",
      );
      const staleIdentity =
        await identityAt(root, FIRST_PATH);
      const replacementPath = join(
        root,
        "tiles",
        ".identity-replacement.tmp",
      );
      await writeFile(
        replacementPath,
        "after",
        "utf8",
      );
      await rename(
        replacementPath,
        join(root, FIRST_PATH),
      );

      await expect(
        registry.resolve({
          kind,
          path: FIRST_PATH,
          identity: staleIdentity,
        }),
      ).rejects.toMatchObject({ code });
      expect(
        await readFile(
          registryPath(root),
          "utf8",
        ),
      ).toBe(beforeRegistry);
    },
  );

  it("rolls back the whole batch when a later observation is stale", async () => {
    await writeAsset(root, FIRST_PATH, "first");
    await writeAsset(root, SECOND_PATH, "before");
    const firstObservation =
      await observationAt(
        root,
        "external-tileset",
        FIRST_PATH,
      );
    const staleObservation =
      await observationAt(
        root,
        "external-tileset",
        SECOND_PATH,
      );
    const replacementPath = join(
      root,
      "tiles",
      ".batch-replacement.tmp",
    );
    await writeFile(
      replacementPath,
      "after",
      "utf8",
    );
    await rename(
      replacementPath,
      join(root, SECOND_PATH),
    );

    await expect(
      new AssetRegistry(resolver).resolveMany([
        firstObservation,
        staleObservation,
      ]),
    ).rejects.toMatchObject({
      code: "DOCUMENT_CHANGED_DURING_READ",
    });
    await expect(
      readFile(registryPath(root), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the ID across a same-filesystem rename and a fresh registry instance", async () => {
    await writeAsset(root, FIRST_PATH, "tileset");
    const firstRegistry =
      new AssetRegistry(resolver);
    const firstId =
      await firstRegistry.resolvePath(
        "external-tileset",
        FIRST_PATH,
      );

    const renamedPath =
      "renamed/terrain.tsj";
    await mkdir(
      join(root, dirname(renamedPath)),
      { recursive: true },
    );
    await rename(
      join(root, FIRST_PATH),
      join(root, renamedPath),
    );

    const secondResolver =
      await ProjectPathResolver.create(root);
    const secondRegistry =
      new AssetRegistry(secondResolver);
    await expect(
      secondRegistry.resolvePath(
        "external-tileset",
        renamedPath,
      ),
    ).resolves.toBe(firstId);

    const document = await readRegistry(root);
    expect(document.generation).toBe(2);
    expect(document.entries).toEqual([
      expect.objectContaining({
        assetId: firstId,
        kind: "external-tileset",
        path: renamedPath,
      }),
    ]);
  });

  it.each([
    {
      name: "byte-for-byte copy",
      duplicate: async (
        source: string,
        destination: string,
      ) => copyFile(source, destination),
    },
    {
      name: "hard link",
      duplicate: async (
        source: string,
        destination: string,
      ) => link(source, destination),
    },
  ])(
    "does not merge a $name while the original path still exists",
    async ({ duplicate }) => {
      await writeAsset(
        root,
        FIRST_PATH,
        "identical bytes",
      );
      const registry = new AssetRegistry(resolver);
      const originalId =
        await registry.resolvePath(
          "external-tileset",
          FIRST_PATH,
        );

      await duplicate(
        join(root, FIRST_PATH),
        join(root, SECOND_PATH),
      );
      const duplicateId =
        await new AssetRegistry(
          await ProjectPathResolver.create(root),
        ).resolvePath(
          "external-tileset",
          SECOND_PATH,
        );

      expect(duplicateId).not.toBe(originalId);
      const document = await readRegistry(root);
      expect(document.entries).toHaveLength(2);
      expect(
        new Set(
          document.entries.map(
            ({ assetId }) => assetId,
          ),
        ).size,
      ).toBe(2);
      expect(
        document.entries.map(({ path }) => path),
      ).toEqual(
        expect.arrayContaining([
          FIRST_PATH,
          SECOND_PATH,
        ]),
      );
    },
  );

  it("may inherit the old ID when an unobserved hardlink remains after unlink because it is indistinguishable from rename", async () => {
    await writeAsset(root, FIRST_PATH, "same inode");
    const originalId =
      await new AssetRegistry(
        resolver,
      ).resolvePath(
        "external-tileset",
        FIRST_PATH,
      );

    await link(
      join(root, FIRST_PATH),
      join(root, SECOND_PATH),
    );
    await rm(join(root, FIRST_PATH));

    const movedId =
      await new AssetRegistry(
        await ProjectPathResolver.create(root),
      ).resolvePath(
        "external-tileset",
        SECOND_PATH,
      );

    expect(movedId).toBe(originalId);
    expect(
      (await readRegistry(root)).entries,
    ).toEqual([
      expect.objectContaining({
        assetId: originalId,
        path: SECOND_PATH,
      }),
    ]);
  });

  it("serializes two registry instances resolving the same path", async () => {
    await writeAsset(root, FIRST_PATH, "same");
    const firstRegistry =
      new AssetRegistry(resolver);
    const secondRegistry =
      new AssetRegistry(
        await ProjectPathResolver.create(root),
      );

    const [firstId, secondId] =
      await Promise.all([
        firstRegistry.resolvePath(
          "external-tileset",
          FIRST_PATH,
        ),
        secondRegistry.resolvePath(
          "external-tileset",
          FIRST_PATH,
        ),
      ]);

    expect(secondId).toBe(firstId);
    const document = await readRegistry(root);
    expect(document.generation).toBe(1);
    expect(document.entries).toHaveLength(1);
    expect(document.entries[0]?.assetId).toBe(
      firstId,
    );
  });

  it("does not lose updates when two registry instances resolve different paths", async () => {
    await writeAsset(root, FIRST_PATH, "first");
    await writeAsset(root, SECOND_PATH, "second");
    const firstRegistry =
      new AssetRegistry(resolver);
    const secondRegistry =
      new AssetRegistry(
        await ProjectPathResolver.create(root),
      );

    const [firstId, secondId] =
      await Promise.all([
        firstRegistry.resolvePath(
          "external-tileset",
          FIRST_PATH,
        ),
        secondRegistry.resolvePath(
          "external-tileset",
          SECOND_PATH,
        ),
      ]);

    expect(firstId).not.toBe(secondId);
    const document = await readRegistry(root);
    expect(document.generation).toBe(2);
    expect(document.entries).toHaveLength(2);
    expect(
      document.entries.map(
        ({ assetId }) => assetId,
      ),
    ).toEqual(
      expect.arrayContaining([
        firstId,
        secondId,
      ]),
    );
  });

  it("serializes repeated resolution across real Node processes without lock-release corruption", async () => {
    await writeAsset(root, FIRST_PATH, "shared");
    const registryModule = pathToFileURL(
      resolve(
        "src/project/assetRegistry.ts",
      ),
    ).href;
    const resolverModule = pathToFileURL(
      resolve(
        "src/project/pathResolver.ts",
      ),
    ).href;
    const source = [
      `import { AssetRegistry } from ${JSON.stringify(registryModule)};`,
      `import { ProjectPathResolver } from ${JSON.stringify(resolverModule)};`,
      `const resolver = await ProjectPathResolver.create(${JSON.stringify(root)});`,
      "const registry = new AssetRegistry(resolver);",
      "let assetId = '';",
      "for (let index = 0; index < 60; index += 1) {",
      `  assetId = await registry.resolvePath("external-tileset", ${JSON.stringify(FIRST_PATH)});`,
      "}",
      "process.stdout.write(assetId);",
    ].join("\n");

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        runNodeModule(source),
      ),
    );

    for (const result of results) {
      expect(result).toMatchObject({
        code: 0,
        stderr: "",
        stdout: legacyAssetId(
          "external-tileset",
          FIRST_PATH,
        ),
      });
    }
    const document = await readRegistry(root);
    expect(document.entries).toHaveLength(1);
  }, 30_000);

  it("merges different asset resolutions from concurrent Node processes without losing updates", async () => {
    const paths = [
      "tiles/process-a.tsj",
      "tiles/process-b.tsj",
      "tiles/process-c.tsj",
      "tiles/process-d.tsj",
    ];
    await Promise.all(
      paths.map(async (path) =>
        writeAsset(root, path, path),
      ),
    );
    const registryModule = pathToFileURL(
      resolve(
        "src/project/assetRegistry.ts",
      ),
    ).href;
    const resolverModule = pathToFileURL(
      resolve(
        "src/project/pathResolver.ts",
      ),
    ).href;

    const results = await Promise.all(
      paths.map((path) =>
        runNodeModule(
          [
            `import { AssetRegistry } from ${JSON.stringify(registryModule)};`,
            `import { ProjectPathResolver } from ${JSON.stringify(resolverModule)};`,
            `const resolver = await ProjectPathResolver.create(${JSON.stringify(root)});`,
            "const registry = new AssetRegistry(resolver);",
            `const assetId = await registry.resolvePath("external-tileset", ${JSON.stringify(path)});`,
            "process.stdout.write(assetId);",
          ].join("\n"),
        ),
      ),
    );

    for (
      let index = 0;
      index < results.length;
      index += 1
    ) {
      expect(results[index]).toMatchObject({
        code: 0,
        stderr: "",
        stdout: legacyAssetId(
          "external-tileset",
          paths[index]!,
        ),
      });
    }
    const document = await readRegistry(root);
    expect(document.generation).toBe(
      paths.length,
    );
    expect(document.entries).toHaveLength(
      paths.length,
    );
    expect(
      document.entries.map(({ path }) => path),
    ).toEqual(expect.arrayContaining(paths));
  });

  it("reloads the locked registry instead of reusing a stale path cache", async () => {
    await writeAsset(root, FIRST_PATH, "same inode");
    const staleRegistry =
      new AssetRegistry(resolver);
    const originalId =
      await staleRegistry.resolvePath(
        "external-tileset",
        FIRST_PATH,
      );

    await rename(
      join(root, FIRST_PATH),
      join(root, SECOND_PATH),
    );
    const freshRegistry =
      new AssetRegistry(
        await ProjectPathResolver.create(root),
      );
    await expect(
      freshRegistry.resolvePath(
        "external-tileset",
        SECOND_PATH,
      ),
    ).resolves.toBe(originalId);

    await link(
      join(root, SECOND_PATH),
      join(root, FIRST_PATH),
    );
    const recreatedPathId =
      await staleRegistry.resolvePath(
        "external-tileset",
        FIRST_PATH,
      );

    expect(recreatedPathId).not.toBe(originalId);
    const document = await readRegistry(root);
    expect(document.entries).toHaveLength(2);
    expect(
      new Set(
        document.entries.map(
          ({ assetId }) => assetId,
        ),
      ).size,
    ).toBe(2);
  });

  it("falls back to an injected opaque ID when the legacy candidate is already used", async () => {
    await writeAsset(
      root,
      FIRST_PATH,
      "existing",
    );
    await writeAsset(
      root,
      SECOND_PATH,
      "target",
    );
    const targetLegacyId = legacyAssetId(
      "external-tileset",
      SECOND_PATH,
    );
    expect(FALLBACK_ASSET_ID).not.toBe(
      targetLegacyId,
    );
    await writeRegistry(root, {
      format: ASSET_REGISTRY_FORMAT,
      formatVersion: 1,
      generation: 4,
      entries: [
        {
          assetId: targetLegacyId,
          kind: "external-tileset",
          path: FIRST_PATH,
          identity:
            await identityAt(root, FIRST_PATH),
        },
      ],
    });
    let generated = 0;
    const registry = new AssetRegistry(
      resolver,
      {
        generateAssetId: () => {
          generated += 1;
          return FALLBACK_ASSET_ID;
        },
      },
    );

    await expect(
      registry.resolvePath(
        "external-tileset",
        SECOND_PATH,
      ),
    ).resolves.toBe(FALLBACK_ASSET_ID);
    expect(generated).toBe(1);

    const document = await readRegistry(root);
    expect(document.generation).toBe(5);
    expect(
      document.entries.map(
        ({ assetId }) => assetId,
      ),
    ).toEqual(
      expect.arrayContaining([
        targetLegacyId,
        FALLBACK_ASSET_ID,
      ]),
    );
  });

  it("fails closed after exhausting collision fallback candidates", async () => {
    await writeAsset(
      root,
      FIRST_PATH,
      "existing",
    );
    await writeAsset(
      root,
      SECOND_PATH,
      "target",
    );
    const targetLegacyId = legacyAssetId(
      "external-tileset",
      SECOND_PATH,
    );
    const original: RegistryFixture = {
      format: ASSET_REGISTRY_FORMAT,
      formatVersion: 1,
      generation: 9,
      entries: [
        {
          assetId: targetLegacyId,
          kind: "external-tileset",
          path: FIRST_PATH,
          identity:
            await identityAt(root, FIRST_PATH),
        },
      ],
    };
    await writeRegistry(root, original);
    let generated = 0;
    const registry = new AssetRegistry(
      resolver,
      {
        generateAssetId: () => {
          generated += 1;
          return targetLegacyId;
        },
      },
    );

    await expect(
      registry.resolvePath(
        "external-tileset",
        SECOND_PATH,
      ),
    ).rejects.toMatchObject({
      code: "ASSET_ID_COLLISION",
    });
    expect(generated).toBe(32);
    expect(await readRegistry(root)).toEqual(
      original,
    );
  });

  it("fails closed without a partial write when the generation is exhausted", async () => {
    await writeAsset(root, FIRST_PATH, "current");
    const original: RegistryFixture = {
      format: ASSET_REGISTRY_FORMAT,
      formatVersion: 1,
      generation: Number.MAX_SAFE_INTEGER,
      entries: [
        {
          assetId:
            "asset_111111111111111111111111",
          kind: "external-tileset",
          path: FIRST_PATH,
          identity: {
            device: "0",
            inode: "0",
            birthtimeNs: "0",
          },
        },
      ],
    };
    await writeRegistry(root, original);

    await expect(
      new AssetRegistry(
        resolver,
      ).resolvePath(
        "external-tileset",
        FIRST_PATH,
      ),
    ).rejects.toMatchObject({
      code: "ASSET_REGISTRY_LIMIT_EXCEEDED",
    });
    expect(await readRegistry(root)).toEqual(
      original,
    );
  });

  it("fails closed without a partial write when the entry limit is reached", async () => {
    await writeAsset(root, FIRST_PATH, "new asset");
    const entries = Array.from(
      {
        length:
          MAX_ASSET_REGISTRY_ENTRIES,
      },
      (_, index): RegistryEntryFixture => {
        const decimal = `${index + 1}`;
        return {
          assetId:
            `asset_${index.toString(16).padStart(24, "0")}`,
          kind: "external-tileset",
          path: `archive/${index}.tsj`,
          identity: {
            device: "1",
            inode: decimal,
            birthtimeNs: decimal,
          },
        };
      },
    );
    await writeRegistry(root, {
      format: ASSET_REGISTRY_FORMAT,
      formatVersion: 1,
      generation: 4,
      entries,
    });
    const before = await readFile(
      registryPath(root),
    );

    await expect(
      new AssetRegistry(
        resolver,
      ).resolvePath(
        "external-tileset",
        FIRST_PATH,
      ),
    ).rejects.toMatchObject({
      code: "ASSET_REGISTRY_LIMIT_EXCEEDED",
      details: {
        limit:
          MAX_ASSET_REGISTRY_ENTRIES,
      },
    });
    expect(
      await readFile(registryPath(root)),
    ).toEqual(before);
  }, 20_000);

  it.each([
    {
      name: "invalid JSON",
      contents: "{",
      reason: "invalid-registry-json",
    },
    {
      name: "a duplicate JSON key",
      contents:
        '{"format":"tiled-mcp-asset-registry","format":"tiled-mcp-asset-registry","formatVersion":1,"generation":0,"entries":[]}',
      reason: "invalid-registry-json",
    },
    {
      name: "a future format version",
      contents: registryText({
        format: ASSET_REGISTRY_FORMAT,
        formatVersion: 2,
        generation: 0,
        entries: [],
      }),
      reason: "invalid-registry-schema",
    },
    {
      name: "duplicate asset IDs",
      contents: registryText({
        format: ASSET_REGISTRY_FORMAT,
        formatVersion: 1,
        generation: 0,
        entries: [
          entryFixture({
            assetId:
              "asset_111111111111111111111111",
            path: FIRST_PATH,
          }),
          entryFixture({
            assetId:
              "asset_111111111111111111111111",
            path: SECOND_PATH,
          }),
        ],
      }),
      reason: "invalid-registry-schema",
    },
    {
      name: "duplicate live paths",
      contents: registryText({
        format: ASSET_REGISTRY_FORMAT,
        formatVersion: 1,
        generation: 0,
        entries: [
          entryFixture({
            assetId:
              "asset_111111111111111111111111",
            path: FIRST_PATH,
          }),
          entryFixture({
            assetId:
              "asset_222222222222222222222222",
            path: FIRST_PATH,
          }),
        ],
      }),
      reason: "invalid-registry-schema",
    },
    {
      name: "an escaping path",
      contents: registryText({
        format: ASSET_REGISTRY_FORMAT,
        formatVersion: 1,
        generation: 0,
        entries: [
          entryFixture({
            path: "../outside.tsj",
          }),
        ],
      }),
      reason: "invalid-registry-schema",
    },
    {
      name: "a reserved internal path",
      contents: registryText({
        format: ASSET_REGISTRY_FORMAT,
        formatVersion: 1,
        generation: 0,
        entries: [
          entryFixture({
            path: ".tiledmcp/asset.tsj",
          }),
        ],
      }),
      reason: "invalid-registry-schema",
    },
    {
      name: "an unknown root field",
      contents: JSON.stringify({
        format: ASSET_REGISTRY_FORMAT,
        formatVersion: 1,
        generation: 0,
        entries: [],
        ignored: true,
      }),
      reason: "invalid-registry-schema",
    },
  ])(
    "fails closed on $name",
    async ({ contents, reason }) => {
      await mkdir(
        join(root, ".tiledmcp"),
        { mode: 0o700 },
      );
      await writeFile(
        registryPath(root),
        contents,
        "utf8",
      );

      await expect(
        new AssetRegistry(
          resolver,
        ).initialize(),
      ).rejects.toMatchObject({
        code: "ASSET_REGISTRY_CORRUPT",
        details: { reason },
      });
    },
  );

  it("fails closed when the registry exceeds its byte limit", async () => {
    await mkdir(
      join(root, ".tiledmcp"),
      { mode: 0o700 },
    );
    await writeFile(
      registryPath(root),
      Buffer.alloc(
        MAX_ASSET_REGISTRY_BYTES + 1,
        0x20,
      ),
    );

    await expect(
      new AssetRegistry(
        resolver,
      ).initialize(),
    ).rejects.toMatchObject({
      code: "ASSET_REGISTRY_CORRUPT",
      details: {
        reason: "invalid-registry-file",
      },
    });
  });

  it("refuses to read a registry through a symbolic link", async () => {
    const internalDirectory = join(
      root,
      ".tiledmcp",
    );
    await mkdir(internalDirectory, {
      mode: 0o700,
    });
    await writeFile(
      join(internalDirectory, "real.json"),
      registryText(emptyRegistry()),
      "utf8",
    );
    await symlink(
      "real.json",
      registryPath(root),
    );

    await expect(
      new AssetRegistry(
        resolver,
      ).initialize(),
    ).rejects.toMatchObject({
      code: "ASSET_REGISTRY_CORRUPT",
      details: {
        reason:
          "unsafe-or-unreadable-registry",
      },
    });
  });

  it("writes mode 0600 atomically and ignores an orphaned temporary file", async () => {
    await writeAsset(root, FIRST_PATH, "first");
    const firstRegistry =
      new AssetRegistry(resolver);
    const firstId =
      await firstRegistry.resolvePath(
        "external-tileset",
        FIRST_PATH,
      );
    const registryStat = await stat(
      registryPath(root),
    );
    expect(registryStat.mode & 0o777).toBe(
      0o600,
    );

    const orphanPath = join(
      root,
      ".tiledmcp",
      ".asset-registry.v1.00000000-0000-4000-8000-000000000000.tmp",
    );
    await writeFile(
      orphanPath,
      '{"partial":',
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );

    const secondRegistry =
      new AssetRegistry(
        await ProjectPathResolver.create(root),
      );
    await expect(
      secondRegistry.resolvePath(
        "external-tileset",
        FIRST_PATH,
      ),
    ).resolves.toBe(firstId);
    expect(
      await readFile(orphanPath, "utf8"),
    ).toBe('{"partial":');
    expect(await readRegistry(root)).toEqual(
      expect.objectContaining({
        generation: 1,
        entries: [
          expect.objectContaining({
            assetId: firstId,
            path: FIRST_PATH,
          }),
        ],
      }),
    );
  });
});

function legacyAssetId(
  kind: AssetIdentityKind,
  path: string,
): string {
  return `asset_${shortHash(`${kind}:${path}`)}`;
}

async function writeAsset(
  root: string,
  projectPath: string,
  contents: string,
): Promise<void> {
  const absolutePath = join(root, projectPath);
  await mkdir(dirname(absolutePath), {
    recursive: true,
  });
  await writeFile(
    absolutePath,
    contents,
    "utf8",
  );
}

async function runNodeModule(
  source: string,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolveProcess, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        source,
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolveProcess({
        code,
        stdout: Buffer.concat(stdout).toString(
          "utf8",
        ),
        stderr: Buffer.concat(stderr).toString(
          "utf8",
        ),
      });
    });
  });
}

async function identityAt(
  root: string,
  projectPath: string,
): Promise<FileIdentity> {
  return fileIdentityOf(
    await lstat(join(root, projectPath), {
      bigint: true,
    }),
  );
}

async function observationAt(
  root: string,
  kind: AssetIdentityKind,
  projectPath: string,
): Promise<AssetIdentityObservation> {
  return {
    kind,
    path: projectPath,
    identity:
      await identityAt(root, projectPath),
  };
}

async function writeRegistry(
  root: string,
  document: RegistryFixture,
): Promise<void> {
  await mkdir(join(root, ".tiledmcp"), {
    mode: 0o700,
  });
  await writeFile(
    registryPath(root),
    registryText(document),
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

async function readRegistry(
  root: string,
): Promise<RegistryFixture> {
  return JSON.parse(
    await readFile(
      registryPath(root),
      "utf8",
    ),
  ) as RegistryFixture;
}

function registryPath(root: string): string {
  return join(
    root,
    ASSET_REGISTRY_RELATIVE_PATH,
  );
}

function emptyRegistry(): RegistryFixture {
  return {
    format: ASSET_REGISTRY_FORMAT,
    formatVersion: 1,
    generation: 0,
    entries: [],
  };
}

function registryText(
  document: RegistryFixture,
): string {
  return `${JSON.stringify(document)}\n`;
}

function entryFixture(
  overrides: Partial<RegistryEntryFixture> = {},
): RegistryEntryFixture {
  return {
    assetId:
      "asset_000000000000000000000000",
    kind: "external-tileset",
    path: FIRST_PATH,
    identity: {
      device: "1",
      inode: "2",
      birthtimeNs: "3",
    },
    ...overrides,
  };
}
