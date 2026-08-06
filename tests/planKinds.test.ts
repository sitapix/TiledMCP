import { describe, expect, it } from "vitest";

import type { ChangeSetPlan } from "../src/changeSets.js";
import {
  applyChangeSetPlan,
  type PlanApplyDependencies,
} from "../src/planKinds.js";
import type {
  DocumentStore,
  InternalDirectory,
} from "../src/storage/documentStore.js";

/**
 * The guarantees below are enforced by `pnpm typecheck`, not by the runtime
 * assertions -- an `@ts-expect-error` that stops erroring fails the build. They
 * pin the two properties the apply path depends on: a plan kind cannot reach
 * `tiled_apply_change_set` without an applier, and the un-checkpointed internal
 * write path cannot be aimed at a project document.
 */

type Kind = ChangeSetPlan["kind"];

// A registry missing any arm must not satisfy the mapped type.
type Registry = {
  [K in Kind]: (
    plan: Extract<ChangeSetPlan, { kind: K }>,
  ) => void;
};
// @ts-expect-error every plan kind must have an applier
const incomplete: Registry = {
  mapEdit: () => undefined,
};
void incomplete;

// An applier must receive its own arm, not the whole union. Both halves matter:
// without the positive case the negative one could pass simply because the
// field does not exist on any arm.
type MapEditApplier = Registry["mapEdit"];
const arms: MapEditApplier = (plan) => {
  void plan.operations;
  void plan.mapPath;
  // @ts-expect-error `targets` belongs to TransactionPlan, not MapEditPlan
  void plan.targets;
};
void arms;

// Internal writes are constrained to `.tiledmcp` by a template literal type.
const okDirectories: InternalDirectory[] = [
  ".tiledmcp",
  ".tiledmcp/checkpoints",
  ".tiledmcp/locks",
];
void okDirectories;
// @ts-expect-error a project-relative path is not an internal directory
const notInternal: InternalDirectory = "maps";
void notInternal;
// @ts-expect-error a lookalike prefix is not an internal directory either
const lookalike: InternalDirectory = ".tiledmcp-backup";
void lookalike;

describe("applyChangeSetPlan", () => {
  it("routes a plan to the applier registered for its kind", async () => {
    const calls: string[] = [];
    const dependencies = {
      store: {} as DocumentStore,
      maps: {} as PlanApplyDependencies["maps"],
      exportAsset:
        (() =>
          undefined) as unknown as PlanApplyDependencies["exportAsset"],
      applyTransaction: async (plan) => {
        calls.push(plan.kind);
        return {
          kind: "transaction",
        } as unknown as Awaited<
          ReturnType<
            PlanApplyDependencies["applyTransaction"]
          >
        >;
      },
    } satisfies PlanApplyDependencies;

    const plan = {
      kind: "transaction",
    } as unknown as Extract<
      ChangeSetPlan,
      { kind: "transaction" }
    >;

    await applyChangeSetPlan(plan, dependencies);

    expect(calls).toEqual(["transaction"]);
  });
});
