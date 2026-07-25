export const FILESYSTEM_THREAT_MODEL_CONTRACT_NAME =
  "tiled-mcp-direct-filesystem-threat-model" as const;
export const FILESYSTEM_THREAT_MODEL_CONTRACT_VERSION =
  1 as const;

/**
 * Frozen machine boundary for project-asset JSON document targets committed
 * by the direct filesystem backend. Server-internal .tiledmcp state has its
 * own capability contracts and is deliberately outside this contract.
 *
 * This contract deliberately distinguishes protection against cooperative
 * writers from protection against a same-privilege hostile local process.
 */
export const TILED_MCP_FILESYSTEM_THREAT_MODEL_CONTRACT =
  Object.freeze({
    name:
      FILESYSTEM_THREAT_MODEL_CONTRACT_NAME,
    version:
      FILESYSTEM_THREAT_MODEL_CONTRACT_VERSION,
    compatibility:
      "field-or-value-change-requires-version-bump",
    backend: "direct-filesystem",
    scope: Object.freeze({
      appliesTo:
        "project-asset-json-document-targets",
      excludes:
        "server-internal-dot-tiledmcp-state",
    }),
    guaranteeBasis:
      "only-when-operational-requirements-hold",
    guarantees: Object.freeze({
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
    }),
    unsupported: Object.freeze({
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
    }),
    operationalRequirements: Object.freeze({
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
    }),
  } as const);
