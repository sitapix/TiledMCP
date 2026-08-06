import type {
  ChangeSetOperationResult,
  ChangeSetPlan,
} from "./changeSets.js";
import type {
  MapService,
  TiledExportRunner,
} from "./maps/mapService.js";
import { applyCheckpointPruneBatch } from "./storage/checkpointBatchPrune.js";
import { applyCheckpointRestore } from "./storage/checkpointRestore.js";
import { applyPreparedCheckpointDiscard } from "./storage/preparedCheckpointDiscard.js";
import {
  applyPreparedCheckpointAbandon,
  applyPreparedCheckpointCommit,
} from "./storage/preparedCheckpointAdjudication.js";
import type { DocumentStore } from "./storage/documentStore.js";

/**
 * Everything an applier may reach for. Passing one bag rather than threading
 * per-kind arguments keeps the appliers uniform, which is what lets them live
 * in a single lookup instead of a dispatch chain.
 */
export interface PlanApplyDependencies {
  store: DocumentStore;
  maps: MapService;
  /** Injected per-call so the Tiled CLI stays a seam rather than an import. */
  exportAsset: TiledExportRunner;
  /**
   * Transactions need the change-set registry to resolve and complete their
   * members, and the registry is what invokes this dispatch — so the wiring
   * arrives from the server rather than being constructed here.
   */
  applyTransaction: (
    plan: Extract<ChangeSetPlan, { kind: "transaction" }>,
  ) => Promise<ChangeSetOperationResult>;
}

type PlanApplier<K extends ChangeSetPlan["kind"]> = (
  plan: Extract<ChangeSetPlan, { kind: K }>,
  dependencies: PlanApplyDependencies,
) => Promise<ChangeSetOperationResult>;

/**
 * One applier per plan kind. The mapped type is the point: adding a member to
 * {@link ChangeSetPlan} without adding an applier here is a compile error, so
 * a new kind can no longer reach `tiled_apply_change_set` by falling through
 * an unlabelled default.
 */
type PlanKindRegistry = {
  [K in ChangeSetPlan["kind"]]: PlanApplier<K>;
};

const PLAN_KIND_APPLIERS: PlanKindRegistry = {
  mapEdit: (plan, { maps }) => maps.applyEdits(plan),
  tilesetEdit: (plan, { maps }) =>
    maps.applyTilesetEdit(plan),
  tilesetPropertyEdit: (plan, { maps }) =>
    maps.applyTilesetPropertyEdit(plan),
  tilesetCreate: (plan, { maps }) =>
    maps.applyTilesetCreate(plan),
  fileDelete: (plan, { maps }) =>
    maps.applyDeleteFile(plan),
  worldEdit: (plan, { maps }) =>
    maps.applyWorldEdits(plan),
  wangEdit: (plan, { maps }) =>
    maps.applyWangsetEdit(plan),
  fileExport: (plan, { maps, exportAsset }) =>
    maps.applyExportFile(plan, exportAsset),
  embeddedTilesetEdit: (plan, { maps }) =>
    maps.applyEmbeddedTilesetEdit(plan),
  propertyTypeEdit: (plan, { maps }) =>
    maps.applyPropertyTypeEdit(plan),
  tileNameEdit: (plan, { maps }) =>
    maps.applyTileNameEdit(plan),
  transaction: (plan, { applyTransaction }) =>
    applyTransaction(plan),
  checkpointRestore: (plan, { store }) =>
    applyCheckpointRestore(store, plan),
  checkpointPruneBatch: (plan, { store }) =>
    applyCheckpointPruneBatch(store, plan),
  preparedCheckpointCommit: (plan, { store }) =>
    applyPreparedCheckpointCommit(store, plan),
  preparedCheckpointAbandon: (plan, { store }) =>
    applyPreparedCheckpointAbandon(store, plan),
  preparedCheckpointDiscard: (plan, { store }) =>
    applyPreparedCheckpointDiscard(store, plan),
};

/**
 * Route an approved plan to the applier for its kind.
 *
 * `K` is inferred from the plan's own discriminant through the `& { kind: K }`
 * intersection, which keeps the lookup and the call correlated: `PLAN_KIND_
 * APPLIERS[plan.kind]` is `PlanApplier<K>`, and `plan` is exactly the argument
 * that applier accepts. No assertion is involved, so an applier wired to the
 * wrong arm is a compile error rather than a runtime surprise.
 */
function dispatch<K extends ChangeSetPlan["kind"]>(
  plan: Extract<ChangeSetPlan, { kind: K }> & {
    kind: K;
  },
  dependencies: PlanApplyDependencies,
): Promise<ChangeSetOperationResult> {
  return PLAN_KIND_APPLIERS[plan.kind](
    plan,
    dependencies,
  );
}

export function applyChangeSetPlan(
  plan: ChangeSetPlan,
  dependencies: PlanApplyDependencies,
): Promise<ChangeSetOperationResult> {
  return dispatch(plan, dependencies);
}
