import { describe, expect, it } from "vitest";

import type { TilesetBinding } from "../src/maps/mapDomain.js";
import {
  gidToTileRef,
  tileRefToGid,
} from "../src/maps/mapPrimitives.js";
import type { TileRef } from "../src/maps/types.js";

/**
 * GID encoding is the arithmetic every tile edit and every render depends on:
 * a global id resolves to (tileset, localId) by binding span, and the top three
 * bits carry the flip flags. It is pure, subtle, and was previously reachable
 * only through MapService, so it had no direct tests despite being the thing
 * most likely to be wrong by one.
 */

const GROUND: TilesetBinding = {
  assetId: "asset_000000000000000000000001",
  path: "tiles/ground.tsj",
  firstGid: 1,
  tileCount: 8,
  gidSpan: 8,
  name: "ground",
  nameTruncated: false,
  revision: `sha256:${"0".repeat(64)}`,
};

const PROPS: TilesetBinding = {
  ...GROUND,
  assetId: "asset_000000000000000000000002",
  path: "tiles/props.tsj",
  firstGid: 9,
  tileCount: 4,
  gidSpan: 4,
  name: "props",
};

const BINDINGS = [GROUND, PROPS];

function ref(
  binding: TilesetBinding,
  localId: number,
): TileRef {
  return {
    tileset: {
      kind: "external",
      assetId: binding.assetId,
    },
    localId,
  } as TileRef;
}

describe("GID encoding", () => {
  it("maps a local id into its binding's span", () => {
    expect(
      tileRefToGid(
        ref(GROUND, 0),
        "orthogonal",
        BINDINGS,
      ),
    ).toBe(1);
    expect(
      tileRefToGid(
        ref(GROUND, 7),
        "orthogonal",
        BINDINGS,
      ),
    ).toBe(8);
    expect(
      tileRefToGid(
        ref(PROPS, 0),
        "orthogonal",
        BINDINGS,
      ),
    ).toBe(9);
    expect(
      tileRefToGid(
        ref(PROPS, 3),
        "orthogonal",
        BINDINGS,
      ),
    ).toBe(12);
  });

  it("treats a null tile as the empty gid", () => {
    expect(
      tileRefToGid(null, "orthogonal", BINDINGS),
    ).toBe(0);
    expect(
      gidToTileRef(0, "orthogonal", BINDINGS),
    ).toBeNull();
  });

  it("round-trips every id in every binding", () => {
    for (const binding of BINDINGS) {
      for (
        let localId = 0;
        localId < binding.tileCount;
        localId += 1
      ) {
        const gid = tileRefToGid(
          ref(binding, localId),
          "orthogonal",
          BINDINGS,
        );
        const back = gidToTileRef(
          gid,
          "orthogonal",
          BINDINGS,
        );
        expect(back).toMatchObject({ localId });
      }
    }
  });

  it("rejects a local id past the end of its span", () => {
    // The boundary matters: localId 8 would land on the next binding's
    // firstGid, silently retargeting the tile to a different tileset.
    expect(() =>
      tileRefToGid(
        ref(GROUND, GROUND.tileCount),
        "orthogonal",
        BINDINGS,
      ),
    ).toThrow();
  });

  it("resolves a gid to the binding whose span contains it", () => {
    expect(
      gidToTileRef(8, "orthogonal", BINDINGS),
    ).toMatchObject({ localId: 7 });
    expect(
      gidToTileRef(9, "orthogonal", BINDINGS),
    ).toMatchObject({ localId: 0 });
  });

  it("fails closed on a gid beyond every binding", () => {
    // Deliberately a throw, not null: a dangling gid is corruption, and
    // silently reading it as "empty" would let an edit erase a real tile.
    expect(() =>
      gidToTileRef(13, "orthogonal", BINDINGS),
    ).toThrow(/outside tileset/u);
  });
});
