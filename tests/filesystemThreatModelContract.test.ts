import {
  describe,
  expect,
  it,
} from "vitest";

import {
  FILESYSTEM_THREAT_MODEL_CONTRACT_NAME,
  FILESYSTEM_THREAT_MODEL_CONTRACT_VERSION,
  TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT,
} from "../src/filesystemThreatModelContract.js";

describe("filesystem threat model contract", () => {
  it("publishes the exact frozen v1 trust and concurrency boundary", () => {
    expect(
      TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT,
    ).toEqual({
      name:
        "tiled-mcp-direct-filesystem-threat-model",
      version: 1,
      compatibility:
        "field-or-value-change-requires-version-bump",
      backend: "direct-filesystem",
      scope: {
        appliesTo:
          "project-asset-json-document-targets",
        excludes:
          "server-internal-dot-tiledmcp-state",
      },
      guaranteeBasis:
        "only-when-operational-requirements-hold",
      guarantees: {
        revisionModel:
          "sha256-exact-raw-bytes-no-generation",
        abaSemantics:
          "identical-bytes-accepted",
        cooperativeExistingTargetCas:
          "raw-byte-sha256-under-same-normalized-path-lock",
        existingTargetFinalCheck:
          "full-byte-sha256-before-promotion",
        existingTargetPromotion:
          "same-directory-unconditional-atomic-rename-replace",
        missingTargetPromotion:
          "same-directory-hard-link-no-replace",
        staticSymlinkRejection:
          "pre-existing-project-relative-components-including-final-target",
        stagingSync:
          "file-fsync-before-promotion",
        postPromotionFailure:
          "success-with-durability-warning-only-after-sha256-readback-match",
        staleLockPolicy:
          "fail-closed-manual-review",
        visibility: "single-path-only",
        promotionResult:
          "successful-promotion-event-not-current-state-lease",
        changeSetReplay:
          "cached-first-result-no-current-state-revalidation",
        dependencySnapshot:
          "non-atomic-read-set",
      },
      unsupported: {
        nonCooperativeExternalWriterCas:
          "final-check-to-rename-race-not-protected",
        existingTargetConditionalReplace:
          "not-provided",
        pathnameBindingAfterFinalSnapshot:
          "not-checked",
        targetMetadataCas:
          "not-provided",
        hostileParentSwapProtection:
          "path-check-to-use-race-not-protected",
        crossFileAtomicity:
          "not-supported",
        powerLossDurability:
          "filesystem-dependent-not-guaranteed",
        mediatedWriterBackend:
          "not-implemented",
      },
      operationalRequirements: {
        projectRoot:
          "single-explicit-canonical-directory",
        toolPathInputs:
          "canonical-project-relative-posix",
        cooperativeWriterScope:
          "same-project-state-same-normalized-target-path-all-writers-honor-lock",
        hardlinkAliasPolicy:
          "one-normalized-project-path-per-logical-target",
        filesystemAtomicity:
          "same-filesystem-atomic-rename-and-hard-link",
        filesystemDurability:
          "file-and-directory-fsync-honored",
        distributedFilesystems:
          "not-validated",
        namespaceTrust:
          "project-root-and-parent-directories-not-hostilely-replaced",
        externalWriterPolicy:
          "no-concurrent-noncooperative-write-during-existing-target-commit",
        strictIsolation:
          "os-sandbox-or-mediated-writer-required",
      },
    });
    expect(
      TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT.name,
    ).toBe(
      FILESYSTEM_THREAT_MODEL_CONTRACT_NAME,
    );
    expect(
      TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT.version,
    ).toBe(
      FILESYSTEM_THREAT_MODEL_CONTRACT_VERSION,
    );
    expect(
      Object.isFrozen(
        TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT,
      ),
    ).toBe(true);
    for (const section of [
      TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT.scope,
      TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT.guarantees,
      TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT.unsupported,
      TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT.operationalRequirements,
    ]) {
      expect(
        Object.isFrozen(section),
      ).toBe(true);
    }
  });
});
