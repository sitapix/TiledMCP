import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Keeps `evals/floor-plan.xml` honest.
 *
 * An evaluation suite whose answers have drifted from the fixture is worse
 * than none: it reports a correct model as wrong, and nobody notices until
 * they distrust the model instead of the file. These recompute every answer
 * from the committed fixture bytes and compare, so regenerating the fixture
 * without updating the answers fails here rather than silently.
 */

const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const FIXTURE = join(
  ROOT,
  "fixtures",
  "floorplan",
);

interface Role {
  id: number;
  className: string;
  role: string;
}

async function readTileset(): Promise<{
  roles: Role[];
  wangSetType: string;
  wangTiles: Array<{
    tileid: number;
    wangid: number[];
  }>;
}> {
  const parsed = JSON.parse(
    await readFile(
      join(FIXTURE, "interior.tsj"),
      "utf8",
    ),
  ) as {
    tiles: Array<{
      id: number;
      type: string;
      properties: Array<{
        name: string;
        value: string;
      }>;
    }>;
    wangsets: Array<{
      type: string;
      wangtiles: Array<{
        tileid: number;
        wangid: number[];
      }>;
    }>;
  };
  return {
    roles: parsed.tiles.map((tile) => ({
      id: tile.id,
      className: tile.type,
      role:
        tile.properties.find(
          (property) =>
            property.name === "role",
        )?.value ?? "",
    })),
    wangSetType: parsed.wangsets[0]!.type,
    wangTiles: parsed.wangsets[0]!.wangtiles,
  };
}

/**
 * Counts cells per role by reading the plan image directly.
 *
 * The plan is one pixel per cell and its colours are the atlas colours, so
 * this reproduces what an import produces without needing the whole service
 * stack -- `tests/floorPlanWorkflow.test.ts` already proves the import agrees
 * with this reading, cell for cell.
 */
async function countByRole(): Promise<
  Map<string, number>
> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(
    join(FIXTURE, "plan.png"),
  )
    .raw()
    .toBuffer({ resolveWithObject: true });
  const colours: Record<string, string> = {
    "207,196,168": "floor_wood",
    "143,143,150": "floor_stone",
    "107,74,47": "wall_brick",
    "111,168,200": "wall_window",
    "63,107,163": "door_closed",
    "184,67,58": "floor_rug",
    "47,107,74": "prop_barrel",
    "163,63,91": "prop_table",
  };
  const counts = new Map<string, number>();
  for (
    let index = 0;
    index < info.width * info.height;
    index++
  ) {
    const offset = index * info.channels;
    const key = `${data[offset]},${data[offset + 1]},${data[offset + 2]}`;
    const role = colours[key];
    expect(
      role,
      `plan.png holds an unmapped colour ${key}`,
    ).toBeDefined();
    counts.set(
      role!,
      (counts.get(role!) ?? 0) + 1,
    );
  }
  return counts;
}

async function answers(): Promise<
  Map<string, string>
> {
  const xml = await readFile(
    join(ROOT, "evals", "floor-plan.xml"),
    "utf8",
  );
  const pairs = new Map<string, string>();
  for (const match of xml.matchAll(
    /<question>([\s\S]*?)<\/question>\s*<answer>([\s\S]*?)<\/answer>/gu,
  )) {
    pairs.set(match[1]!.trim(), match[2]!.trim());
  }
  return pairs;
}

/** The answer to the one question containing every given fragment. */
function answerFor(
  pairs: Map<string, string>,
  ...fragments: string[]
): string {
  const hits = [...pairs.entries()].filter(
    ([question]) =>
      fragments.every((fragment) =>
        question.includes(fragment),
      ),
  );
  expect(
    hits,
    `expected exactly one question matching ${JSON.stringify(fragments)}`,
  ).toHaveLength(1);
  return hits[0]![1];
}

describe("floor-plan evaluation answers", () => {
  it("declares ten questions with non-empty answers", async () => {
    const pairs = await answers();
    expect(pairs.size).toBe(10);
    for (const [
      question,
      answer,
    ] of pairs) {
      expect(
        answer,
        `empty answer for ${question}`,
      ).not.toBe("");
    }
  });

  it("matches the fixture on per-class cell counts", async () => {
    const pairs = await answers();
    const { roles } = await readTileset();
    const counts = await countByRole();
    const perClass = (className: string) =>
      roles
        .filter(
          (role) => role.className === className,
        )
        .reduce(
          (total, role) =>
            total + (counts.get(role.role) ?? 0),
          0,
        );

    expect(
      answerFor(pairs, '"Wall"'),
    ).toBe(String(perClass("Wall")));
    expect(
      answerFor(pairs, '"Door"'),
    ).toBe(String(perClass("Door")));
    expect(
      answerFor(pairs, '"Floor"'),
    ).toBe(String(perClass("Floor")));
    expect(
      answerFor(pairs, '"Prop"'),
    ).toBe(String(perClass("Prop")));
  });

  it("matches the fixture on per-role cell counts", async () => {
    const pairs = await answers();
    const counts = await countByRole();
    for (const role of [
      "floor_rug",
      "wall_window",
      "floor_wood",
    ]) {
      expect(
        answerFor(pairs, role),
        `answer for ${role}`,
      ).toBe(String(counts.get(role)));
    }
  });

  it("matches the fixture on Wang set facts", async () => {
    const pairs = await answers();
    const { wangSetType, wangTiles } =
      await readTileset();
    expect(
      answerFor(pairs, "What is its type"),
    ).toBe(wangSetType);

    // The tile carrying colour 1 in all four corner slots (1, 3, 5, 7).
    const allOnes = wangTiles.filter((tile) =>
      [1, 3, 5, 7].every(
        (slot) => tile.wangid[slot] === 1,
      ),
    );
    expect(allOnes).toHaveLength(1);
    expect(
      answerFor(
        pairs,
        "all four of its corner slots",
      ),
    ).toBe(String(allOnes[0]!.tileid));
  });

  it("matches the fixture on the perimeter ring", async () => {
    const pairs = await answers();
    const counts = await countByRole();
    // The ring is exactly the wall, window and door cells.
    const ring =
      (counts.get("wall_brick") ?? 0) +
      (counts.get("wall_window") ?? 0) +
      (counts.get("door_closed") ?? 0);
    expect(
      answerFor(pairs, "outermost ring"),
    ).toBe(String(ring));
    // ...and it must equal the geometric perimeter of a 16x12 map.
    expect(ring).toBe(2 * 16 + 2 * (12 - 2));
  });
});
