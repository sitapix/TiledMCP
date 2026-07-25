import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ChangeSetRegistry,
  MAX_PENDING_TRANSACTIONS,
  type ChangeSetApplyResult,
  type TransactionPlan,
} from "../src/changeSets.js";
import {
  serializeJsonDocument,
  type JsonObject,
} from "../src/formats/json.js";
import { MapService } from "../src/maps/mapService.js";
import type { UpdateMapOperation } from "../src/maps/types.js";
import { ProjectPathResolver } from "../src/project/pathResolver.js";
import { DocumentStore } from "../src/storage/documentStore.js";

const MAP_PATH = "maps/level.tmj";
const LONER_TILESET_PATH = "tiles/unused.tsj";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface Harness {
  root: string;
  service: MapService;
  store: DocumentStore;
  registry: ChangeSetRegistry;
}

describe("tiled_preview_transaction wire flow", () => {
  const roots = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...roots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    roots.clear();
  });

  it("composes members, locks them, applies atomically, and replays results", async () => {
    const harness = await createHarness(roots);
    const memberA = await previewMapEdit(harness);
    const memberB =
      await previewDeleteFile(
        harness,
        LONER_TILESET_PATH,
      );

    const transaction =
      harness.registry.previewTransaction([
        memberA.changeSetId,
        memberB.changeSetId,
      ]);
    expect(transaction).toMatchObject({
      kind: "transaction",
      snapshotConsistency: "non-atomic-read-set",
      summary: {
        memberCount: 2,
        wouldChange: true,
      },
      operations: [
        {
          type: "transactionMember",
          destructive: false,
          memberChangeSetId: memberA.changeSetId,
          planKind: "mapEdit",
          targetKind: "replace",
          path: MAP_PATH,
          expectedRevision:
            memberA.expectedRevision,
        },
        {
          type: "transactionMember",
          destructive: true,
          memberChangeSetId: memberB.changeSetId,
          planKind: "fileDelete",
          targetKind: "delete",
          path: LONER_TILESET_PATH,
          expectedRevision:
            memberB.expectedRevision,
        },
      ],
    });
    expect(transaction.expectedRevision).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );

    // Preview locks every member against individual apply.
    await expect(
      harness.registry.apply(
        memberA.changeSetId,
        memberA.expectedRevision,
        neverRuns,
      ),
    ).rejects.toMatchObject({
      code: "CHANGE_SET_OWNED",
      details: expect.objectContaining({
        ownedBy: transaction.changeSetId,
      }),
    });

    const result = (await applyLikeServer(
      harness,
      transaction.changeSetId,
      transaction.expectedRevision,
    )) as Extract<
      ChangeSetApplyResult,
      { kind: "transaction" }
    >;
    expect(result).toMatchObject({
      kind: "transaction",
      changeSetId: transaction.changeSetId,
      results: [
        {
          path: MAP_PATH,
          beforeRevision:
            memberA.expectedRevision,
          changed: true,
          changeSetId: memberA.changeSetId,
        },
        {
          kind: "fileDelete",
          path: LONER_TILESET_PATH,
          beforeRevision:
            memberB.expectedRevision,
          deleted: true,
          changeSetId: memberB.changeSetId,
        },
      ],
    });
    expect(result.transactionId).toMatch(
      UUID_PATTERN,
    );

    const mapAfter = JSON.parse(
      (
        await readFile(
          join(harness.root, MAP_PATH),
        )
      ).toString("utf8"),
    ) as JsonObject;
    expect(mapAfter.renderorder).toBe("left-up");
    await expect(
      stat(
        join(harness.root, LONER_TILESET_PATH),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Members replay the transaction's per-member results instead of
    // double-committing; the transaction itself replays from cache.
    await expect(
      harness.registry.apply(
        memberA.changeSetId,
        memberA.expectedRevision,
        neverRuns,
      ),
    ).resolves.toEqual(result.results[0]);
    await expect(
      harness.registry.apply(
        memberB.changeSetId,
        memberB.expectedRevision,
        neverRuns,
      ),
    ).resolves.toEqual(result.results[1]);
    await expect(
      harness.registry.apply(
        transaction.changeSetId,
        transaction.expectedRevision,
        neverRuns,
      ),
    ).resolves.toEqual(result);
  });

  it("rejects invalid member sets", async () => {
    const harness = await createHarness(roots);
    const memberA = await previewMapEdit(harness);
    const memberB =
      await previewDeleteFile(
        harness,
        LONER_TILESET_PATH,
      );

    expect(() =>
      harness.registry.previewTransaction([
        memberA.changeSetId,
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
    expect(() =>
      harness.registry.previewTransaction([
        memberA.changeSetId,
        memberA.changeSetId,
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
    expect(() =>
      harness.registry.previewTransaction([
        memberA.changeSetId,
        `changeset:${"0".repeat(64)}`,
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "CHANGE_SET_NOT_FOUND",
      }),
    );

    // Two members over the same target path are rejected.
    const memberA2 =
      await previewMapEdit(harness, {
        backgroundColor: "#11223344",
      });
    expect(() =>
      harness.registry.previewTransaction([
        memberA.changeSetId,
        memberA2.changeSetId,
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        details: expect.objectContaining({
          path: MAP_PATH,
        }),
      }),
    );

    // A member already locked by a pending transaction cannot join another.
    harness.registry.previewTransaction([
      memberA.changeSetId,
      memberB.changeSetId,
    ]);
    expect(() =>
      harness.registry.previewTransaction([
        memberA.changeSetId,
        memberA2.changeSetId,
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "CHANGE_SET_OWNED",
      }),
    );
  });

  it("fails closed on a diverged target and leaves every file untouched", async () => {
    const harness = await createHarness(roots);
    const memberA = await previewMapEdit(harness);
    const memberB =
      await previewDeleteFile(
        harness,
        LONER_TILESET_PATH,
      );
    const transaction =
      harness.registry.previewTransaction([
        memberA.changeSetId,
        memberB.changeSetId,
      ]);

    const mapBefore = await readFile(
      join(harness.root, MAP_PATH),
    );
    const divergedTileset =
      serializeJsonDocument({
        ...baseTileset("unused"),
        name: "renamed",
      });
    await writeFile(
      join(harness.root, LONER_TILESET_PATH),
      divergedTileset,
    );

    await expect(
      applyLikeServer(
        harness,
        transaction.changeSetId,
        transaction.expectedRevision,
      ),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    expect(
      (
        await readFile(
          join(harness.root, MAP_PATH),
        )
      ).equals(mapBefore),
    ).toBe(true);
    expect(
      (
        await readFile(
          join(
            harness.root,
            LONER_TILESET_PATH,
          ),
        )
      ).equals(divergedTileset),
    ).toBe(true);

    // The failed transaction stays pending and its member locks hold.
    await expect(
      harness.registry.apply(
        memberA.changeSetId,
        memberA.expectedRevision,
        neverRuns,
      ),
    ).rejects.toMatchObject({
      code: "CHANGE_SET_OWNED",
    });
  });

  it("rejects tampered transaction plans", async () => {
    const harness = await createHarness(roots);
    const memberA = await previewMapEdit(harness);
    const memberB =
      await previewDeleteFile(
        harness,
        LONER_TILESET_PATH,
      );
    const transaction =
      harness.registry.previewTransaction([
        memberA.changeSetId,
        memberB.changeSetId,
      ]);

    let captured: TransactionPlan | undefined;
    await harness.registry
      .apply(
        transaction.changeSetId,
        transaction.expectedRevision,
        async (plan) => {
          captured = plan as TransactionPlan;
          throw new Error("capture only");
        },
      )
      .catch(() => undefined);
    if (captured === undefined) {
      throw new Error(
        "expected the executor to observe the plan",
      );
    }
    const tampered: TransactionPlan =
      structuredClone(captured);
    const firstTarget = tampered.targets[0];
    if (firstTarget === undefined) {
      throw new Error("expected targets");
    }
    firstTarget.path = "maps/other.tmj";

    await expect(
      harness.service.applyTransaction(
        tampered,
        harness.registry.resolveTransactionMembers(
          captured,
        ),
      ),
    ).rejects.toMatchObject({
      code: "CHANGE_SET_TAMPERED",
    });
  });

  it("caps pending transactions", async () => {
    const harness = await createHarness(roots);
    const lonerPaths: string[] = [];
    for (
      let index = 0;
      index < (MAX_PENDING_TRANSACTIONS + 1) * 2;
      index += 1
    ) {
      const path = `tiles/loner-${index}.tsj`;
      await writeFile(
        join(harness.root, path),
        serializeJsonDocument(
          baseTileset(`loner-${index}`),
        ),
      );
      lonerPaths.push(path);
    }
    for (
      let index = 0;
      index < MAX_PENDING_TRANSACTIONS;
      index += 1
    ) {
      const first = await previewDeleteFile(
        harness,
        lonerPaths[index * 2] as string,
      );
      const second = await previewDeleteFile(
        harness,
        lonerPaths[index * 2 + 1] as string,
      );
      harness.registry.previewTransaction([
        first.changeSetId,
        second.changeSetId,
      ]);
    }
    const extraFirst = await previewDeleteFile(
      harness,
      lonerPaths[
        MAX_PENDING_TRANSACTIONS * 2
      ] as string,
    );
    const extraSecond = await previewDeleteFile(
      harness,
      lonerPaths[
        MAX_PENDING_TRANSACTIONS * 2 + 1
      ] as string,
    );
    expect(() =>
      harness.registry.previewTransaction([
        extraFirst.changeSetId,
        extraSecond.changeSetId,
      ]),
    ).toThrow(
      expect.objectContaining({
        code: "CHANGE_SET_LIMIT_EXCEEDED",
        details: expect.objectContaining({
          limit: MAX_PENDING_TRANSACTIONS,
        }),
      }),
    );
  });
});

async function neverRuns(): Promise<never> {
  throw new Error(
    "the change set executor must not run",
  );
}

async function applyLikeServer(
  harness: Harness,
  changeSetId: string,
  expectedRevision: string,
): Promise<ChangeSetApplyResult> {
  return harness.registry.apply(
    changeSetId,
    expectedRevision,
    async (plan) => {
      if (plan.kind !== "transaction") {
        throw new Error(
          `expected a transaction plan, got ${plan.kind}`,
        );
      }
      const memberPlans =
        harness.registry.resolveTransactionMembers(
          plan,
        );
      const outcome =
        await harness.service.applyTransaction(
          plan,
          memberPlans,
        );
      harness.registry.completeTransactionMembers(
        plan,
        outcome.memberResults,
      );
      return outcome.result;
    },
  );
}

async function previewMapEdit(
  harness: Harness,
  patch: Record<string, string> = {
    renderOrder: "left-up",
  },
) {
  const snapshot =
    await harness.store.readSnapshot(MAP_PATH);
  const operations: UpdateMapOperation[] = [
    { type: "updateMap", patch },
  ];
  const plan = await harness.service.planEdits(
    MAP_PATH,
    snapshot.revision,
    {},
    operations,
  );
  return harness.registry.put(plan);
}

async function previewDeleteFile(
  harness: Harness,
  path: string,
) {
  const plan =
    await harness.service.planDeleteFile({
      path,
    });
  return harness.registry.put(plan);
}

async function createHarness(
  roots: Set<string>,
): Promise<Harness> {
  const root = await mkdtemp(
    join(tmpdir(), "tiledmcp-transaction-wire-"),
  );
  roots.add(root);
  await mkdir(join(root, "maps"));
  await mkdir(join(root, "tiles"));
  await writeFile(
    join(root, MAP_PATH),
    serializeJsonDocument(baseMap()),
  );
  await writeFile(
    join(root, LONER_TILESET_PATH),
    serializeJsonDocument(
      baseTileset("unused"),
    ),
  );

  const resolver =
    await ProjectPathResolver.create(root);
  const store = new DocumentStore(resolver);
  return {
    root,
    store,
    service: new MapService(resolver, store),
    registry: new ChangeSetRegistry(),
  };
}

function baseMap(): JsonObject {
  return {
    compressionlevel: -1,
    height: 2,
    infinite: false,
    layers: [
      {
        data: [0, 0, 0, 0],
        height: 2,
        id: 1,
        name: "Ground",
        opacity: 1,
        type: "tilelayer",
        visible: true,
        width: 2,
        x: 0,
        y: 0,
      },
    ],
    nextlayerid: 2,
    nextobjectid: 1,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.12.2",
    tileheight: 16,
    tilesets: [],
    tilewidth: 16,
    type: "map",
    version: "1.10",
    width: 2,
  };
}

function baseTileset(name: string): JsonObject {
  return {
    columns: 1,
    image: `${name}.png`,
    imageheight: 16,
    imagewidth: 16,
    margin: 0,
    name,
    spacing: 0,
    tilecount: 1,
    tiledversion: "1.12.2",
    tileheight: 16,
    tilewidth: 16,
    type: "tileset",
    version: "1.10",
  };
}
