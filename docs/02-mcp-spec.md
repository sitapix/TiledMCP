# TiledMCP 功能规格（冻结前草案）

> **状态：Draft。** 本文定义协议基线、共享语义和能力 roadmap；下文的工具表是候选能力清单，不是首版一次性注册全部工具的承诺。当前已注册工具已有代码定义的完整、封闭 `inputSchema` / `outputSchema`，并已从真实 MCP discovery 生成 discovery 与 application-error 两份机器契约和参考文档；手写的每工具示例也由这些公开 schema 校验。其余冻结门槛尚未全部完成，因此本文和接口仍未进入 Frozen。
>
> 设计依据见 [01-tiled-research.md](01-tiled-research.md)；精确 wire schema 见
> [discovery 机器契约](../contracts/mcp-contract.v1.json)、
> [application-error 机器契约](../contracts/application-errors.v1.json) 和
> [生成式参考](generated/mcp-reference.md)，安全组合方式见
> [调用工作流](examples/safe-workflows.md)，direct filesystem 的冻结信任边界见
> [文件系统威胁模型](04-security.md)。

## 0. 协议基线与冻结条件

- **MCP 版本**：锁定 `2025-11-25`。
- **SDK**：使用 `@modelcontextprotocol/sdk` **v1.x**；锁定具体版本和 lockfile，在 v2 稳定且完成兼容测试前不迁移。
- **首个 transport**：`stdio`。服务器不向 stdout 输出日志；日志只写 stderr。HTTP/远程 transport 不属于 M1。
- **能力声明**：仅声明当前实现且通过契约测试的 Tools、Resources、Prompts；未实现的 roadmap 项不得注册空壳。
- **Schema 单一来源**：共享类型和每个工具的输入、输出、错误结构在代码中定义；生成器通过真实 MCP `tools/list` / resource discovery 固化 wire JSON Schema、双 profile discovery contract、application-error registry 和参考文档，测试对已提交 artifact 做 byte-level drift check。本文表格中的“关键参数”只用于解释意图，不是完整 wire contract。
- **冻结门槛**：所有已注册工具都必须有完整、固定字段且 `additionalProperties: false` 的 `inputSchema` / `outputSchema`、稳定且有界并且不复制大型 structured payload 的 text-content 策略、示例、稳定错误码、尺寸/分页限制、四项 annotations 和 Tiled 1.12.2 往返测试。仓库的 `pnpm run verify:tiled-1.12.2` 是独立强制门：CLI 缺失或版本不精确匹配都失败，不允许以 skip 代替验收。

### 0.1 当前实现切片（2026-07-25）

当前代码注册 26 个不依赖 Tiled CLI 的核心工具：capabilities、文件列表、checkpoint
索引、单文件恢复预览、prepared-checkpoint discard/commit/abandon 预览，以及 committed-checkpoint
单项与 2..32 项 batch prune 预览、地图摘要、whole-map tile
usage analysis、有界外部 atlas TSJ
详情、显式 tile metadata 精确检索、矩形 region、
带 local ID 的分页 tileset sheet、显式稀疏 tile 选集渲染、native tile-layer region preview、对象列表、单对象
详情、只读
校验、增量创建地图、空图层创建预览、map edits 预览、外部 tileset 挂载预览、
per-tile 元数据更新预览与 change
set 提交；探测到 `tmxrasterizer` 时再注册第 29 个高保真地图 PNG 工具。另注册两个不依赖
项目内容的 direct Resources：Markdown playbook `tiled://guide` 和 JSON registry
`tiled://application-errors`；二者通过 `resources/list` 发现并由 `resources/read`
返回带内容 revision/size 的固定内容。当前 Resource Templates 列表为空。已实现的编辑
union 为 `setTiles`、`fillRegion`、`replaceTiles`、`createObject`、
`updateObject`、`deleteObjects`、`updateLayer`、`deleteLayer`、`moveLayer`、
`duplicateLayer`、`stampPattern`、`floodFill`、`updateMap` 和必须独占 change set 的
`removeTilesetFromMap`，第 15 种、可混批的 `copyRegion`，以及第 16 种、必须独占
change set 的 `resizeMap`。
`tiled_create_layer` 使用独立的单操作 planner，不向这个通用 union 暴露可伪造的
`layerId`、父容器路径或最终插入位置。
对象写入支持 rectangle/point/ellipse/capsule、有界 polygon/polyline path 与有界
text；模板与 tile object 仍会明确拒绝。
其余仍是 roadmap，不得从下文候选表推断为可调用能力。

这一切片已有严格输入 schema、每个工具各自的完整字段级 closed output schema、四项
annotations 和 MCP 客户端契约测试；固定结构的嵌套对象同样拒绝额外字段。每个工具的
`structuredContent` 都使用 `{result: Success | ApplicationErrorResult}` 外层，其中
`Success` 是该工具自己的精确结果类型，而不是共享的宽泛对象。tile/object/layer/map-root/
tileset-reference 写入使用目标子树、object-member 或 array-element local patch，完整
语义复核通过后才提交。

tool text content 已收敛为 `tiled-mcp-summary` v1 compact one-line JSON，UTF-8 最多
1024 bytes；成功摘要不复制完整 result，应用错误摘要不复制 `details`，完整机器结果以
`structuredContent.result` 为准。可选 `tiled_render_map` 也已使用精确封闭的可追溯 PNG
元数据，并以 pre-Frozen clean break 删除旧 `mapPath`/`bytes`/`width`/`height`
aliases。双 profile 的完整 discovery artifact、包含当前 103 个 v1 application code 的
稳定错误 registry、生成式参考和每工具调用示例现已落地并纳入 drift gate；schema 无法
表达的 revision/批准语义由手写安全工作流维护。当前 wire 实际使用的 external TSJ 与
image-layer dependency `assetId` 已接入版本化持久 registry：首次分配兼容旧路径哈希，
同路径替换保持 ID，已观察文件仅在唯一、稳定且非零的同文件系统 file identity 证据下
尽力迁移；弱 identity、原路径仍存活的 copy/hardlink、跨文件系统 move 与其他无法匹配
file identity 的场景分配新 ID，不按内容猜身份。`tiled_create_map` 已正式定案为唯一
direct additive no-preview 例外，固定 Tiled 1.12.2 的不可跳过集成门也已落地。
direct filesystem 的 non-cooperative external-writer CAS、hostile parent swap、锁作用域
和部署前提已经由 `filesystemThreatModelContract` v1 冻结为明确 guarantee/unsupported/
operational requirements。checkpoint store 已接入版本化 storage policy、可配置总量配额、
生产 CLI 默认 10,000 的 entry 上限、项目级锁和 fail-closed orphan GC；已支持经批准显式
prune 单个 committed manifest，或按 canonical checkpoint ID 顺序 batch prune 2..32 个
显式选择的 committed manifests，也能在机器验证当前目标仍等于写前状态时显式 discard
单个 prepared manifest，并能对剩余含混状态做证据绑定、动作分离的 commit/abandon 人工
裁决。默认关闭的 v2 rolling retention 可由启动配置显式启用；legacy、
protected 与 prepared checkpoint 永久排除。嵌入式实例的 entry 上限可能不同，运行值以
capability 为准。本文仍是 Draft；通用 force、缺少持久来源证明的更宽 commit、项目资产
删除式恢复和其他高风险运维能力仍未冻结。运行时应以
`tiled_get_capabilities`、`tools/list`、`resources/list` 与
`resources/templates/list` 为准。

`tiled_create_map` 正式保留为唯一直接提交例外。它只生成空的有限正交 TMJ，目标父目录
必须已存在；目标采用 missing-only 的同目录 hard-link no-replace promotion，已有路径
即使 bytes 完全相同也必然返回 `FILE_ALREADY_EXISTS`，绝不覆盖或把外部写者的文件认作
本次成功。调用前由客户端确认目标路径。工具固定为 `idempotentHint:false`：目标提交前
失败也可能留下一个新的 prepared checkpoint；首次成功后的第二次调用则返回
`FILE_ALREADY_EXISTS`。客户端不得自动重试，响应丢失时必须先重新检查目标。
创建前 checkpoint 的 `before.existed:false` 不支持恢复为删除；若进程在写入后、标记
checkpoint committed 前崩溃，启动时也不会仅凭相同 hash 认领来源，而是保持 prepared 并
报告 provenance-ambiguous conflict。该例外不能外推到其他 create/update/delete 工具。
`mapCreationCapabilities` 把 `mapFormatVersion:"1.10"`、
`tiledCompatibilityBaseline:"1.12.2"`、`approvalBoundary:"client-tool-call"`、同目录
hard-link promotion、checkpoint/重试边界固化为 machine-readable const；map width/height
各最多 100,000，tile width/height 各最多 16,384，schema 与领域层使用同一组常量。

### 0.2 Asset identity v1

- 当前覆盖范围只有已经进入 wire 的 external TSJ 与 prospective image-layer dependency；
  map/world/template 的通用 asset resource identity 仍属 roadmap。
- registry 位于项目根下 `.tiledmcp/asset-registry.v1.json`，使用 closed v1 JSON、
  20,000-entry / 8 MiB 硬上限、项目级合作锁、0600 sibling temp、`fsync`、原子 rename
  和父目录 `fsync`。启动注册工具前会严格校验；损坏、未来版本、symlink、超限或重复 ID/
  路径一律 fail closed，不会退回路径哈希重建。
- 新 registry 中的首次 ID 沿用既有 `external-tileset:<path>` /
  `image-layer:<path>` 96-bit 候选，避免升级无故换 ID；候选已占用时才分配随机 96-bit
  ID，ID 永不复用于另一个 registry entry。
- 同一 canonical path 即使内容或 inode 因编辑器 atomic-save 改变也保留 ID，并刷新记录的
  文件身份。new path 尚未注册、old path 已消失、inode 与 birthtime 都非零且
  `device + inode + birthtime` 在同 kind 中唯一匹配时，new path 才继承 ID；这是对支持
  稳定 birthtime 的文件系统上普通同文件系统 rename 的 best-effort 连续性。弱/零 identity
  证据不触发 rebind。
- 内容相同不是身份。原路径仍存在的 byte copy/hardlink、跨文件系统 move、未观察的
  inode-replacing save 后立即 rename，以及其他无法唯一匹配的 new path 会分配新 ID。
  两个已经注册的路径发生 swap/replace 时仍按 canonical-path-first 规则各自保留原 ID，
  只刷新 identity。若 new hardlink 尚未被 registry 观察，删除旧路径后的最终状态与
  rename 在 `(device,inode,birthtime)` 上不可区分，因此可能作为同一 file identity
  迁移并继承旧 ID；两个路径都已观察时则各自保留已经分配的 ID。任意外部
  move/rename+replace 的强保证需要未来显式 rebind 或跨文件 WAL，不属于 v1。
- `.tiledmcp` 是运行时安全状态，目标项目应忽略它；本仓库的 `.gitignore` 已这样配置，
  服务器不会修改任意目标项目的 ignore 规则。复制或提交 registry 会携带既有 ID，但不
  属于受支持的跨 clone 同步机制；删除或丢失它会丢失 rename 历史并可能重新分配 ID。
  只读/preview 工具不会修改 TMJ/TSJ/图片，但首次发现、刷新身份或协调锁时可能更新这份
  内部 safety metadata；该边界也由 capability contract 明示。
- capability 把损坏策略固定为启动期 fatal、运行期稳定 application error 的 fail-closed，
  把加载已有超限文件固定为启动期 fatal-as-corrupt，并把 mutation 时的
  entry/byte/generation 超限固定为运行期稳定 application error；两者都不会静默重建或
  部分提交 registry。`resolutionOrder`、`renameEvidence` 与 `registeredPathSwap` 另外把
  path-first、old-path-absent 和 swap 边界固化为 machine-readable const。
- map 读取会先完成有界候选检查，再把 asset ID 与身份更新一起提交。带 dependency guard
  时，已捕获 raw snapshot 的精确 revision conflict 优先于延后的解析/profile/图片错误；
  若 64 MiB TSJ 聚合上限终止扫描，则先检查已捕获前缀的精确 guard，随后固定返回
  `RESULT_LIMIT_EXCEEDED`，不会继续读取后缀，也不会用不完整集合伪报 dependency-set
  conflict。任一 pre-commit 检查失败都不增长或刷新 registry。
- v1 保证合作进程的原子可见性与 lost-update 防护，不承诺首次创建 `.tiledmcp` 目录时的
  断电 durability；`crashDurability` 明示该边界，异常掉电后 registry 丢失按
  `registryLossPolicy` 处理，ID 可能重分配。

### 0.3 Direct filesystem threat model v1

`tiled_get_capabilities.filesystemThreatModelContract` 是当前 direct backend 对
**项目资产 JSON 文档目标**的权威机器边界，固定
`name:"tiled-mcp-direct-filesystem-threat-model"`、`version:1`。其 `scope` 明确排除
`.tiledmcp` server-internal state；同版本任一字段或值的语义变化都必须提升版本。

- guarantee 只在 `operationalRequirements` 全部成立时有效：单一显式项目根、本地
  same-filesystem rename/hard-link/`fsync` 语义、同一逻辑目标只使用一个规范化项目路径、
  合作写者遵守锁，且外部编辑器不在既有目标提交窗口并发保存；
- 既有目标使用 raw-byte SHA-256 最终 guard + 无条件原子 rename。它对合作写者构成 CAS，
  也能拒绝最终检查前已观察到的外部变化，但**不是**非合作写者的 conditional replace；
- create-map 的 hard-link no-replace 对目标存在性提供独立的原子保证；
- 静态 symlink/越界会拒绝；同权限恶意进程的 parent path check-to-use swap 明确
  unsupported，严格隔离需要 OS sandbox 或 mediated writer；
- `changed:true` 的成功 promotion 是一次事件，不是当前路径 lease；成功 change-set
  replay 返回首次缓存结果，也不是重新读取。需要当前状态时必须再次读取 revision；
- 跨文件原子性、target metadata CAS、distributed filesystem 语义与异常断电 durability
  均不在 v1 保证内。

完整部署与事故处理要求见 [04-security.md](04-security.md)。旧 `safetyStatus` 只保留 JSON
词法保真摘要，不再用无前提布尔值表达文件系统安全。

## 1. 共享契约

以下 TypeScript 风格定义用于固定语义；字段的必填性、范围、互斥关系和 `additionalProperties: false` 最终由代码生成的 JSON Schema 精确定义。

```ts
type ProjectPath = string
// 使用 "/" 的 UTF-8 项目相对路径；禁止绝对路径、".."、NUL 和解析后逃逸项目根目录。

type AssetId = string
// 服务器分配的不透明、项目内稳定标识。客户端不得从路径猜测或自行构造。

type Revision = `sha256:${string}`
// 对已存在文件原始 bytes 的内容 revision；既有目标写入前以 expectedRevision 做 CAS。

type TilesetRef =
  | { kind: "external"; assetId: AssetId }
  | { kind: "embedded"; mapAssetId: AssetId; embeddedId: string }
// 外部引用以 TSJ/TSX assetId 定位；内嵌引用以 map-scoped 稳定 id 定位。
// tileset 名称只用于显示和唯一时的便捷查询，永远不是身份。

type TileTransform =
  | {
      kind: "orthogonal";
      flipH?: boolean;
      flipV?: boolean;
      flipD?: boolean;
      rawFlags?: number;
    }
  | {
      kind: "hexagonal";
      flipH?: boolean;
      flipV?: boolean;
      rotate60?: boolean;
      rotate120?: boolean;
      rawFlags?: number;
    };

type TileRef = {
  tileset: TilesetRef;
  localId: number;
  transform?: TileTransform;
};
// rawFlags 用于无损往返未知/保留位；服务器按地图 orientation 校验并编码 GID。
// hex 的 0x20000000/0x10000000 分别表达 60°/120° 旋转，不能误解释为普通 flipD。

type Region =
  | { kind: "rect"; x: number; y: number; width: number; height: number; unit: "tile" }
  | { kind: "polygon"; points: Array<{ x: number; y: number }>; unit: "tile" }
  | {
      kind: "selection";
      selectionId: string;
      mapRevision: Revision;
    };

type Target =
  | { kind: "map"; mapPath: ProjectPath }
  | { kind: "layer"; mapPath: ProjectPath; layerId: number }
  | { kind: "object"; mapPath: ProjectPath; objectId: number }
  | { kind: "tileset"; tileset: TilesetRef }
  | { kind: "tile"; tileset: TilesetRef; localId: number }
  | { kind: "wangset"; tileset: TilesetRef; wangSetId: string }
  | { kind: "wangcolor"; tileset: TilesetRef; wangSetId: string; colorId: string };

type Diagnostic = {
  severity: "info" | "warning" | "error";
  code: string;                         // 稳定、可机器判断
  message: string;                      // 面向模型的人类可读说明
  path?: string;
  jsonPointer?: string;
};

type ApplicationErrorResult = {
  ok: false;
  error: {
    code: string;
    message: string;
    details: Record<string, JsonValue>;
  };
};

type ToolStructuredContent<Success> = {
  result: Success | ApplicationErrorResult;
};

// 查询成功结果由各工具独立定义，例如 MapSummaryResult、
// RegionResult、ValidationResult 或 TilesetSheetResult。

type MapEditPreviewResult = {
  kind: "mapEdit";
  changeSetId: string;
  planDigest: string;
  mapPath: ProjectPath;
  expectedRevision: Revision;
  dependencyRevisions: Record<AssetId, Revision>;
  prospectiveDependencyRevisions?: Record<AssetId, Revision>;
  operations: OperationPreview[];
  summary: MapEditSummary;
  snapshotConsistency: "non-atomic-read-set";
  createdAt: string;
  expiresAt: string;
};

type CheckpointRestorePreviewResult = {
  kind: "checkpointRestore";
  changeSetId: string;
  planDigest: string;
  targetPath: ProjectPath;
  expectedRevision: Revision;
  checkpoint: CheckpointPreview;
  restore: RestorePreview;
  operations: [RestoreCheckpointOperationPreview];
  summary: CheckpointRestoreSummary;
  snapshotConsistency: "non-atomic-read-set";
  createdAt: string;
  expiresAt: string;
};

type CommitResult = {
  path: ProjectPath;
  beforeRevision: Revision | null;
  revision: Revision;
  checkpointId: string | null;
  changed: boolean;
  warnings?: string[];
};

type ApplyResult = CommitResult & {
  changeSetId: string;
};
```

补充 wire 规则：

1. 所有已注册工具的 `structuredContent` 都是 closed
   `{result: Success | ApplicationErrorResult}`；每个工具在 `tools/list` 中公布自己的精确
   `Success` 分支，固定对象（包括递归 layer、operation preview 和 summary）都拒绝额外
   key。只有 dependency revision 字典和错误 `details` 这类语义上确实动态的字典允许动态
   key。
2. 查询/渲染工具返回各自的 typed result；两个专用 map-edit preview 工具与
   `tiled_preview_edits` 通用 preview 返回 `MapEditPreviewResult` 的受限变体，
   checkpoint 恢复 preview 返回独立的
   `CheckpointRestorePreviewResult`。`tiled_create_map` 成功时返回 `CommitResult`；
   `tiled_apply_change_set` 返回带 `changeSetId` 的 `ApplyResult`。这些结果不能统称为一个
   `MutationResult`。
3. handler 已接收到合法输入后发生的领域/应用错误使用稳定 `code`，设置 `isError: true`，
   并返回符合该工具 error 分支的 `{result:{ok:false,error:{code,message,details}}}`
   `structuredContent`；code 的精确 wire 位置是
   `structuredContent.result.error.code`。当前 v1 application registry 有 103 个 code，
   机器 artifact 为
   [`contracts/application-errors.v1.json`](../contracts/application-errors.v1.json)，
   相同 JSON 由 `tiled://application-errors` 提供；
   `tiled_get_capabilities.applicationErrorContract` 公布其 URI、revision、size、wire
   location、fallback 和兼容策略。`INTERNAL_ERROR` 是未预期 handler 失败的 fallback。
   tool callback 返回值必须通过 server 私有的 trusted-result 边界；交给 SDK 前必须先
   核对 `isError:true` 与 `result.ok:false` error envelope 双向一致，再对成功/错误重跑
   该工具 output schema。错误清洗、序列化或该边界校验自身失败时必须直接返回固定、无
   原始 message/details 的 `INTERNAL_ERROR` envelope，不能退化为可能回显底层异常的 SDK
   text-only error。
4. v1 中既有 application code 标识符及其含义稳定；未来 server 版本可以新增 code。客户端
   遇到未知 code 时必须先按通用应用错误安全处理，再刷新 `tools/list`、capabilities 和
   resource discovery，不能把“本地枚举不认识”解释为成功。控制流只能依赖已发现的
   `error.code`，不得匹配面向人的 `message`，也不得假设 opaque `details` 在 v1 有稳定
   字段。
5. application registry 只覆盖上述 tool application envelope，不包括 MCP SDK input
   error、`cli.*.issues[].code` capability-probe 诊断、startup fatal error、
   `tiled_validate` 的 `Diagnostic[]`、checkpoint reconciliation diagnostics 或原始 OS
   error code。这些表面各自遵循独立契约，不能与 101-code allowlist 混用。
6. MCP SDK 在进入 handler 前拒绝的 input-schema 错误是协议层失败：当前 SDK 返回
   `isError: true` 的 text content，不携带 `structuredContent`，因此不应伪造
   `ApplicationErrorResult`。
7. 进入 handler 后的成功与应用错误都返回 `tiled-mcp-summary` v1 text content：使用
   compact one-line JSON 编码，UTF-8 最多 1024 bytes，并给出完整
   `structuredContent` 经 `JSON.stringify` 后的 UTF-8 byte count。success summary 只含
   `kind`、`version`、`ok`、`structuredContentBytes`；图片工具另含
   `image:{mimeType,bytes}`，其中 `bytes` 是实际 inline image 的原始 byte count。
   application-error summary 共用 `kind`、`version`、`ok:false` 与
   `structuredContentBytes`，其 `error` 只含稳定 `code`、有界且规范为单行的 `message`
   以及必要时的 `messageTruncated`，不复制 `details`。完整机器结果与错误 details 只以
   `structuredContent.result` 为准，客户端不得把 text summary 当作工具结果 schema。
   `tiled_get_capabilities.textContentContract` 公布 summary 名称、版本、编码、最大 bytes、
   完整结果位置、structured byte 计算方式及 SDK input-error 策略。图片工具另外返回 MCP
   `image` content，二进制不进入 `structuredContent`。
8. `Revision` 基于原始 bytes，而不是解析后对象或 mtime。所有**既有目标**的项目资产
   写入必须携带 `expectedRevision`；最终 guard 观察到不匹配时返回
   `REVISION_CONFLICT`。对遵守同一路径锁的写者，这构成 lost-update CAS；对非合作写者，
   guard 与无条件 rename 之间仍有 contract 明示的窗口。唯一例外 `tiled_create_map`
   以服务器内部 missing precondition + 原子 no-replace link 实现不存在状态的 CAS，
   不接受调用方伪造 missing revision。
9. `selectionId`、`changeSetId` 等句柄必须显式传递，绑定项目、客户端连接、地图 revision
   和 TTL；它们不是“当前选区/上一步操作”之类的隐式会话状态。
10. M1 只接受 `Region.kind = "rect"`；其余分支保留在共享契约中，直到对应阶段实现后才加入
   工具 schema。

### 1.1 用户授权、预览与提交

`confirm: true` **不代表用户授权**：模型本身可以填写该字段，服务器不能据此证明用户看过风险。除正式冻结的 additive missing-only `tiled_create_map` 外，写操作采用两阶段协议：

1. 三个 map-edit preview 入口或 checkpoint restore preview 只计算变更，返回绑定
   `expectedRevision` 的 `changeSetId`、有界 `operations`/`summary`、风险字段和过期时间；
   不返回 commit/apply 结果。
2. MCP 客户端通过自己的批准 UI（可用时使用 elicitation）把 preview 的有界摘要与风险
   字段呈现给用户。
3. 只有通过客户端“重要操作”批准门的 `tiled_apply_change_set(changeSetId, expectedRevision)` 才提交；服务器再次执行 revision CAS。change set 过期、连接不匹配或 revision 改变均拒绝提交。

因此工具 schema 中不使用 `confirm` 字段。服务端 annotations 是风险提示和客户端策略输入，不是授权证明。

### 1.2 Tool annotations 规则

每个工具都显式提供可读 `title`，并填写全部四项 hints，不依赖协议默认值：

| 工具类型 | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
|---|---:|---:|---:|---:|
| 本地读取、摘要、渲染、纯校验 | `true` | `false` | `true` | `false` |
| 预览 change set（每次签发新的 anti-ABA id） | `true` | `false` | `false` | `false` |
| 设置为指定最终状态 | `false` | 依能力静态标注 | `true` | `false` |
| missing-only no-replace 创建 | `false` | `false` | `false` | `false` |
| 创建、追加、随机生成或依赖当前状态的编辑 | `false` | 依能力静态标注 | `false` | `false` |
| 删除、裁剪、覆盖导出、自动修复、快照恢复 | `false` | `true` | 按重复调用语义填写 | `false` |

- annotations 是**工具级静态值**；若同一名字同时承担读/写、预览/提交或安全/破坏性分支，必须拆成独立工具。
- asset identity contract v2 起，`readOnlyHint:true` 的 read/preview 工具严格不写
  项目目录：asset 解析走无锁、只读模式（确定性路径哈希分配 + 内存内 rename 采认），
  registry 与 lock 文件只由 `tiled_apply_change_set` 的写路径创建/更新。
  `assetIdentityContract.readOnlyToolEffect` 为 `"none"`，
  `identityPersistenceBoundary` 声明该持久化边界；纯只读会话不留 rename 证据是
  best-effort continuity 的显式收窄。
- `tiled_preview_edits` 每次调用都会分配新的随机 `changeSetId` 并占用有界 registry，
  因而不是幂等调用；相同 plan 也不复用旧句柄，以避免 revision ABA 后误认历史批准。
- `tiled_apply_change_set` 固定为 `{readOnlyHint:false, destructiveHint:true, idempotentHint:true, openWorldHint:false}`：即使某个 change set 实际无破坏性，也采取保守静态标注；重复提交同一 id 只返回第一次提交结果，不重复应用。
- `tiled_create_map` 固定为 `{false,false,false,false}`。即使 destination 的 no-replace
  效果天然有界，目标提交前的失败也可能留下不同的 prepared checkpoint，因此整个工具
  不能标成 MCP 幂等调用；首次成功后的重复调用还会返回 `FILE_ALREADY_EXISTS`。客户端
  不得自动重试，必须先检查目标与 checkpoint 状态。其
  `mapCreationCapabilities.approvalBoundary` 明示授权由客户端在 tool call 前确认，
  服务器不把任意输入布尔值当作授权证明。
- `tiled_create_checkpoint` 是尚未注册的候选工具；若未来以当前“创建新 checkpoint”
  语义加入，计划 annotations 为 `{false,false,false,false}`，但这不是现行 discovery
  contract。已注册的 checkpoint 列表为 `{true,false,true,false}`；恢复预览每次签发新的
  anti-ABA change set，固定为 `{true,false,false,false}`。写目标文件的转换、导出和
  rasterize 保守标为 destructive。
- 本地 Tiled CLI 子进程仍为 `openWorldHint: false`；未来任何访问网络的工具必须设为 `true`。
- `destructiveHint: false` 不免除 revision CAS；`destructiveHint: true` 必须走客户端批准门。

## 2. 设计原则

1. **面向结果，不面向裸 API**：提供"填充一个区域""用地形笔刷画一条路"这类高层动作，而不是逼模型逐格 set tile。
2. **命名惯例**：`tiled_{动词}_{名词}` 蛇形命名（与现有生态惯例一致，便于用户迁移）。
3. **GID 变换位对模型透明且无损**：工具使用 `TileRef`；服务器区分正交翻转与六边形 60°/120° 旋转，并保留 raw flags。模型不需要手工编码 GID。
4. **大数据走摘要**：任何工具都不整块返回完整地图 JSON；读取用区域/摘要视图，完整数据走 Resource。
5. **单文档原子化 + 路径沙箱**：所有路径限制在项目根目录（`TILED_PROJECT_DIR`）内；
   M0/M1 对既有目标使用锁、revision CAS、同目录 temp + rename；唯一 create-map 例外使用
   内部 missing precondition、同目录 temp + hard-link no-replace promotion。跨文件只承诺
   “可恢复事务”且延后到 M2。
6. **保持 Tiled 兼容**：首版以 Tiled 1.12.2 为兼容基线（正确维护 `nextlayerid`/`nextobjectid`、版本字段、外部 tileset 引用）；兼容矩阵扩展后再承诺其他版本。
7. **坐标约定**：tile 坐标以 tile 为单位（左上角为原点），对象坐标以像素为单位 —— 与 Tiled 本身一致；工具描述中显式注明。
8. **视觉闭环是一等能力**：多模态模型能直接看图。所有渲染类工具以 MCP `image` content（PNG）返回结果，让模型**先看 tileset 长什么样再选 tile、改完地图后看渲染结果自查**。地图数据是视觉资产，纯文本的 GID 数组对模型几乎不可读，"渲染→观察→修正"的循环是本 MCP 区别于纯数据编辑器的核心体验。
9. **错误信息即教学**：报错文案是写给模型的 prompt。每个错误都要回答"为什么不行 + 现在能怎么做"，并列出可用的替代项（如："图层 'Ground' 是 objectgroup，tile 操作需要 tilelayer；本图的 tilelayer 有：Ground2(id=3), Decor(id=5)"）。模型的下一步质量取决于上一步报错的质量。
10. **模型当导演，算法当工人**：凡是有确定性算法的体力活（大面积生成、随机撒布、画形状、可达性分析），提供程序化工具让模型调参编排，而不是让模型逐格产出数据。模型的价值在审美判断与迭代（生成→渲染→观察→调参），不在搬砖。

---

## 3. Tools roadmap

以下保留原始设计中“约 58 项能力”的产品愿景，并因读写职责拆分增加了若干候选名字；工具数量不是目标，名称和分组也可在 schema 冻结前调整。它们不会在首版一次性注册。实际实施顺序和 M1 的最小工具面以第 6 节为准。

> 工具只在实现、契约测试和 annotations 全部完成后注册；可选 Tiled adapter 不可用时不注册对应工具，不能注册后再用运行时报错代替 capability negotiation。下表“关键参数”不是完整 schema。

### 3.1 项目与地图管理

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_list_files` | 列出项目内的 Tiled 资产（地图/图块集/模板/世界），返回路径+类型+基本信息 | `pattern?` |
| `tiled_get_map_summary` | 地图摘要：尺寸、方向、规范化 render order、可选背景色/class、图层树（含 id/类型/可见性）、tileset 引用表（含 firstgid 区间）、对象统计。**模型动手前必读** | `mapPath` |
| `tiled_create_map` | **已实现并正式保留 direct no-replace 例外**；新建空的有限正交 TMJ，目标已存在时绝不覆盖 | `mapPath`, `width`, `height`, `tileWidth`, `tileHeight`, `backgroundColor?` |
| `tiled_update_map` | 候选独立入口；当前等价能力已通过 `tiled_preview_edits` 的第 13 种 `updateMap` operation 实现，修改根级 render order、背景色与 class | `mapPath`, `patch` |
| `tiled_resize_map` | **已实现等价 generic operation**：当前不注册 standalone tool，通过 `tiled_preview_edits` 的第 16 种、必须独占 change set 的 `resizeMap` operation 实现；operation preview 恒为 destructive 并走 change set 批准 | `mapPath`, `width`, `height`, `offsetX?`, `offsetY?` |
| `tiled_delete_file` | **已实现（preview→apply，destructive）。** 预览删除一个 `.tmj`/`.tsj`：有界 fail-closed 引用扫描（TMJ maps + JSON worlds + JSON templates；XML 资产或 pattern worlds 存在即拒绝），apply 复扫引用、CAS 当前 revision，**先提交当前字节的 committed checkpoint 再 unlink**，恢复该 checkpoint 即字节精确重建文件 | `path` |

当前已实现的 `tiled_delete_file` wire contract：输入仅 `{path}`。preview 读取目标
（`FILE_NOT_FOUND`/`UNSUPPORTED_FORMAT` fail closed）、执行有界引用扫描后返回
`fileDelete` change set（域分隔 digest `tiledmcp/file-delete-plan/v1`），其
`expectedRevision` 是目标当前字节的 SHA-256。引用扫描规则：候选 referrer 为
TSJ 目标的所有 `.tmj`（`tilesets[].source`）与 `.tj` JSON 模板（`tileset.source`）、
TMJ 目标的所有 `.world`（`maps[].fileName`）；候选数 ≤2,000、合计字节 ≤64 MiB，
超限 `RESULT_LIMIT_EXCEEDED`；存在任何 `.tmx`/`.tsx`/`.tx` XML 资产或 pattern-based
world 时以 `UNSUPPORTED_REFERENCE_SCAN` 拒绝（无法证明未被引用）；referrer 解析失败
以 `INVALID_DOCUMENT` 拒绝；命中引用返回 `FILE_IN_USE`（含 ≤32 条 referencedBy 样
本与总数）。apply 重放 digest 校验与引用扫描，随后在文件锁内 CAS 当前 revision、
用现有 checkpoint 机制**先提交** before=after=当前字节的 checkpoint、再 unlink 并
best-effort 同步父目录；任何崩溃窗口要么留下完整文件、要么留下可恢复的 committed
checkpoint。apply 结果是新的判别分支
`{kind:"fileDelete", changeSetId, path, beforeRevision, checkpointId, deleted:true}`。
恢复走 `tiled_preview_checkpoint_restore` 的缺失目标扩展（见 3.4）；
`tiled_get_capabilities.fileDeletionCapabilities` 公布全部策略与预算。

当前已实现的 map-root update wire contract 是
`{type:"updateMap", patch}`，并属于通用 `tiled_preview_edits.operations` union 的
第 13 种 operation。它不额外注册 `tiled_update_map` standalone tool，因此 registry
保持 28 core / 29 with rasterizer。operation 与 patch 都是 strict object；patch 至少
包含一个字段且只允许：

| operation patch | TMJ root member | 输入约束 |
|---|---|---|
| `renderOrder` | `renderorder` | `right-down`、`right-up`、`left-down`、`left-up` |
| `backgroundColor` | `backgroundcolor` | `#RRGGBB`、`#AARRGGBB` 或删除用 `null` |
| `className` | `class` | 字符串，最多 1024 个 Unicode code points |

`tiled_get_map_summary` 的 `renderOrder` 总是存在；源文件省略 `renderorder` 时返回 Tiled
默认 `right-down`。只有根成员存在时才返回 `backgroundColor` / `className`；已有 class
超过 1024 个 Unicode code points 时按 code-point 边界截断并返回
`classNameTruncated:true`。无效 render order、无效背景色或非字符串 class 会以
`INVALID_DOCUMENT` fail closed。

planner 按 operations 数组顺序修改同一工作副本；后面的 `updateMap` 读取前序结果，同一
字段重复请求时 later wins。change detection 以 raw 根对象 member 是否存在及其 JSON 值
为准：已有相同值与 `backgroundColor:null` 删除缺失 member 是 no-op；缺失 member 即使
等于 Tiled 的运行时默认值，显式插入仍是 change。

plan summary 的 `mapUpdates` 项以 `operationIndex` 关联；bounded operation preview
以 operations 数组位置关联。二者都回显 `requestedFields`、`changedFields`、
`wouldChange` 与 `renderingMayChange`。只有实际改变 `renderOrder` 或 `backgroundColor` 时
`renderingMayChange` 才为 true；仅改变 class 或 no-op 不会误报渲染影响。apply 从
pinned source 重算 operation、summary 与 dependency revisions，只对实际变化的 TMJ
root member 做 insertion/replacement/deletion。未触及的根成员、layers/tilesets 子树、
未知字段、BOM、CRLF、缩进、键序和其他词法保持原 bytes；若顺序 operations 最终把根对象
还原为原值，文件级结果为 `changed:false`，revision 与 exact bytes 不变。

当前已实现的 map-resize wire contract 是
`{type:"resizeMap", width, height, offsetX?, offsetY?}`，属于同一 union 的第 16 种、
必须独占 change set 的 operation，同样不注册 `tiled_resize_map` standalone tool，
registry 保持 28 core / 29 with rasterizer。语义按 Tiled 1.12.2 官方源码逐条核实：

- `offsetX`/`offsetY` 单位为 tile，含义是**旧内容在新地图中的位置**；目标格
  `(x,y)` 取自源格 `(x−offsetX, y−offsetY)`，缩小/向左上裁剪用负值。省略视为 0，
  幅值上限 100,000；`width`/`height` 为 1..100,000 的整数。
- 每个 tile layer 的尺寸被改写为新地图尺寸，落到新边界外的源格被裁剪；任何 tile
  layer 若有非零 `x`/`y` 或尺寸不等于当前地图尺寸，整个操作以
  `UNSUPPORTED_RESIZE_LAYER_BOUNDS` fail closed（Tiled 源码对这类 layer 的 resize
  行为本身留有未定义 TODO）。
- 每个被扫描的源格（包括将被裁剪的）都按完整 encoded GID fail-closed 校验；裁剪
  不能掩盖坏数据。摘要回显 preserved/cropped 非零格计数与最多 16 项的
  `croppedCellSample`。
- 像素偏移为 `(offsetX×tilewidth, offsetY×tileheight)`。所有对象仅平移锚点
  `x`/`y`（polygon/polyline points 相对锚点、自动跟随），**从不删除**；越界对象原样
  保留，摘要按"平移后锚点是否落在闭区间像素边界外"回显
  `objectsOutsideNewBounds`。像素偏移非零时含 `template` 的对象以
  `UNSUPPORTED_RESIZE_TEMPLATE` fail closed。
- image layer 只平移发生变化的 `offsetx`/`offsety` member；group layer 自身不动，
  仅递归处理子层；`nextlayerid`/`nextobjectid` 不变。
- 预算：重写目标格计入 change set 的 100,000 cell-write 上限；源格扫描上限
  1,000,000；平移对象计入 10,000 object-mutation 上限；受影响 JSON 子树仍受
  128-subtree 上限约束。同尺寸零偏移且无实际变化时为 exact-byte no-op。
- source patch 只改写根 `width`/`height`、受影响 tile layer 的
  `width`/`height`/`data`、发生对象平移的 layer 的 `objects` 数组和发生偏移的
  image layer 的 offset members；其余 bytes 保持不变。

### 3.2 编辑事务与安全网

安全网先于业务写工具落地。M0/M1 的原子性边界严格限定为**单个文档**；跨文档提交延后到 M2，并且只有实现锁、staging、journal/WAL 与崩溃恢复后才能称为“可恢复事务”。

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_preview_edits` | 预览同一 map 上的一组编辑，返回 change set；`operations` 是封闭的 discriminated union，不接受任意 `{tool,args}` | `mapPath`, `expectedRevision`, `expectedDependencyRevisions`, `operations` |
| `tiled_apply_change_set` | 提交已经由客户端批准的 map edit、checkpoint restore、prepared-checkpoint discard/commit/abandon、单项或 batch committed-checkpoint prune change set；提交前重新做对应 revision guard | `changeSetId`, `expectedRevision` |
| `tiled_create_checkpoint` | **候选 / 未注册**；未来为显式文档集合建立自有内容寻址快照；当前只有 net-changing 既有目标提交前的自动 checkpoint | `paths`, `label?` |
| `tiled_list_checkpoints` | **已实现**；有界列出 manifest，并把损坏条目隔离到 `corruptEntries`，不读取或恢复目标 | `status?`, `limit?`, `scanLimit?` |
| `tiled_preview_prepared_checkpoint_discard` | **已实现安全单项版**；只有目标仍精确等于 checkpoint 的 before 状态时才固定 manifest/目标证据并返回 destructive discard change set；不读取 blob、不直接删除 | `checkpointId` |
| `tiled_preview_prepared_checkpoint_commit` | **已实现窄权限人工裁决**；仅接受 prepared create 且安全普通目标 raw revision 精确等于 after，同时固定当前 size 作为 apply CAS，返回只推进内部 manifest 状态的 change set | `checkpointId` |
| `tiled_preview_prepared_checkpoint_abandon` | **已实现窄权限人工裁决**；仅接受自动对账与 exact-before discard 都无法处理的四类含混状态，返回永久删除恢复点但保留项目资产的 change set | `checkpointId` |
| `tiled_preview_checkpoint_prune` | **已实现 committed 单项版**；固定 raw manifest revision，返回 destructive prune change set；不读取 blob、不直接删除 | `checkpointId` |
| `tiled_preview_checkpoint_prune_batch` | **已实现 committed 有界 batch 版**；调用方显式给出 2..32 个不同 UUID，按 canonical ID 顺序固定全成员 pins，返回非原子、可部分提交的 destructive prune change set；不读取 blob、不直接删除 | `checkpointIds` |
| `tiled_preview_checkpoint_restore` | **已实现单文件版（含缺失目标扩展）**；只读校验 checkpoint 与目标，返回带 destructive 摘要的 change set；目标缺失（被 `tiled_delete_file` 或外部删除）时 `expectedRevision` 改为恢复内容本身的 SHA-256，批准后以 no-replace 方式重建文件；实际恢复仍由 `tiled_apply_change_set` 提交 | `checkpointId`, `expectedRevision` |

当前恢复契约严格限于一个 checkpoint 对应的一个安全 JSON 文档。preview 输入
只接受 UUID `checkpointId` 和 `expectedRevision`，不接受
未来多文件设计中的 `paths` 或 revision map。目标存在时 `expectedRevision` 是其最新
raw bytes 的 SHA-256；目标缺失时没有当前字节可 pin，`expectedRevision` 必须等于
checkpoint 可恢复内容的 revision（即批准的就是将要重建的内容本身），plan 带
digest 保护的 `targetMissing:true` 标记、summary `currentRevision:null`，且只接受
committed checkpoint——prepared + 目标缺失属于含混状态，须先走裁决。apply 复核目标
仍缺失（期间重建的文件以 `CHECKPOINT_STATE_CONFLICT` 拒绝）后按 create 的
hard-link no-replace 路径写回原字节，结果 `beforeRevision:null`，其自动 checkpoint
记录 `before.existed:false`。服务端验证 manifest、内容寻址 blob 的
hash/revision/size、安全 JSON 与 DocumentStore 大小上限，并把 checkpoint 的
id/创建时间/label/path/status/afterRevision/before object identity 和目标当前 revision
全部固定进 domain-separated plan digest；最大 64 MiB 的原始 blob 不驻留 change-set
registry。

preview 本身不写盘，但 operation 摘要明确 `destructive:true`，并报告目标路径、当前与
恢复 revision、精确 byte count、`wouldChange` 和“不会恢复 TSJ/图片/其他文件”的警告。
apply 在目标锁内重新读取并逐字段验证 manifest，先做目标 revision CAS，再验证 blob；
唯一允许的 manifest 漂移是 `prepared → committed`。若 source checkpoint 仍是
`prepared` 且 `before.existed:true`，只有目标精确等于其 `afterRevision` 才允许先持久化
为 `committed` 后恢复。实际发生替换前会为当前版本创建 checkpoint，再以原始 bytes
原子替换；因此只有 `wouldChange:true` 的 restore 才建立新的恢复点，并且其可恢复性还
要求 checkpoint 完整且 `filesystemThreatModelContract.operationalRequirements` 成立。
no-op restore 不替换目标，也不创建新 checkpoint。
`before.existed:false` 会稳定报 `REVERT_WOULD_DELETE`：当前工具不会以恢复之名删除后来
创建的文件，也不会隐式恢复任何依赖闭包。对于仍为 `prepared` 的 create checkpoint，
目标即使精确等于 `afterRevision` 也不能证明创建者；启动对账固定报告
`CHECKPOINT_STATE_CONFLICT` 并保留 manifest，不会仅凭 hash 自动标记 committed。

`checkpointCapabilities.storagePolicy` v6 固定 checkpoint-store 边界：默认
`maxBytes:1073741824`，`maxEntries:10000`，其中 bytes 是 `.tiledmcp/objects` 与
`.tiledmcp/checkpoints` 下 observed logical file bytes 加 prepared→committed reservation，
entries 包含 canonical objects/manifests、崩溃 temp 和未知项。每次 prepare 在项目级
进程内 mutex 与跨进程 checkpoint-store lock 下完成 inventory、必要 GC、object/manifest
发布；manifest 首次发布是 no-replace。任何 `lstat`/扫描失败或超出 safe-integer 精确计费
范围都会使容量证明失败；配额仍不足或无法证明时，在项目目标 promotion 前返回
`CHECKPOINT_QUOTA_EXCEEDED`。v6 假设 `.tiledmcp` 是可信本地状态且所有内部写者遵守同一
checkpoint-store lock；不承诺抵御同权限非合作进程对内部目录的主动替换。

GC 的 root set 同时包含全部有效 `prepared` 与 `committed` manifest。只有完整扫描且没有
malformed/unexpected/symlink/非普通 entry、缺失引用、无法精确计费或 entry-limit
truncation 时，才删除无引用 canonical object 和严格识别的私有 crash temp；任一 blocker
都在首次 unlink 前阻断整个 sweep。配额保证有界存储，不保证无限期持续写入；quota
pressure 只触发 orphan GC，绝不删除有效 manifest。有效 manifest 删除路径只有明确授权的
以下几类：经
preview/apply 批准并执行 raw-manifest CAS 的单个 `committed` checkpoint prune；同样获批
或以独立 batch preview 批准的 2..32 项 `committed` checkpoint prune；机器证明当前目标
仍等于 checkpoint before 状态的单个 `prepared` checkpoint discard；针对含混状态单独
预览并批准的 `prepared` abandon；以及下述由启动配置
授予 standing approval 的 v2 rolling post-commit retention。

prepared-discard preview 只接受 UUID `checkpointId`，且不读取 stored-before blob。它先
以无 store lock 的有界读取取得 manifest 路径作为 routing hint，再按
`target → checkpoint-store` 固定锁序取得权威 raw manifest snapshot；释放 store lock 后
仍在 target lock 内观察目标。proposal 的 `expectedRevision` 是 raw manifest bytes 的
SHA-256。现有目标只有在
安全普通文件的 raw revision 和 size 都精确等于 `before` 时才符合条件；create checkpoint
只有在目标严格缺失时才符合条件。preview 把完整 checkpoint metadata、raw manifest
revision/size、目标 `{existed:false}` 或 `{existed:true,revision,size}` 证据及固定
`current-target-matches-before-state` eligibility 纳入独立 domain-separated plan digest。

以下状态全部以 `CHECKPOINT_STATE_CONFLICT` 拒绝且零删除：现有目标等于 after、缺失或
含无关内容，create 目标已存在，目标为 symlink/非普通文件/无法安全观察，以及
`before.revision === afterRevision` 的来源歧义。已 committed 的输入同样不允许借此删除，
应改用 prune。apply 在同一锁序内重新检查目标证据与 raw manifest CAS；manifest bytes、
metadata 或 prepared→committed 状态在 preview 后发生任何漂移都返回
`CHECKPOINT_CHANGED`。commit point 是 unlink manifest 后 fsync checkpoint 目录，随后
运行完整 fail-closed orphan GC。由于 eligibility 不依赖 blob，checkpoint 自己的 object
缺失或损坏不阻止 discard；共享 object 只有在最后一个 root 消失且完整 inventory 允许时
才会删除。提交点后的 sync、observer、GC 或 lock-release 故障返回
`manifestDeleted:true` 的成功结果和固定 warning/failed GC，而不是暗示可安全重试的整体
application error。此能力不修改项目资产、不留 tombstone，也不接受 operator-forced
commit、force-abandon 参数或自动删除；含混状态只能进入下面独立的裁决协议。

prepared 人工裁决由两个独立 preview 工具组成，绝不以 `force:true` 扩宽 discard：

| 当前权威状态 | commit preview | abandon preview | 规定路径 |
|---|---:|---:|---|
| create target missing | 拒绝 | 拒绝 | 机器可证明未落地，走 exact-before discard |
| existing target exact-before | 拒绝 | 拒绝 | 机器可证明未落地，走 exact-before discard |
| existing target exact-after（含 before=after） | 拒绝 | 拒绝 | 重启服务后由启动期 prepared reconciliation 自动推进 |
| create target exact-after | 允许 | 允许 | 操作者判断同 bytes 文件的来源 |
| create target unrelated | 拒绝 | 允许 | 只允许放弃内部恢复点 |
| existing target missing | 拒绝 | 允许 | 只允许放弃内部恢复点 |
| existing target unrelated | 拒绝 | 允许 | 只允许放弃内部恢复点 |
| symlink、非普通、越界/内部、超限、不可读、读取竞态 | 拒绝 | 拒绝 | 先修复不安全状态 |

两种 preview 都先把 manifest path 当成无锁 routing hint，再在 target mutex/file lock
之内取得 checkpoint-store lock，权威读取 manifest 与目标。计划完整固定
`version`、`retention`、id/createdAt/label/path/status/before/afterRevision、raw manifest
revision/size、目标严格缺失或 raw revision/size 证据，以及
`create-target-matches-after`、`create-target-unrelated`、
`existing-target-missing`、`existing-target-unrelated` 之一。commit 与 abandon 分别使用
独立 domain 的 evidence `expectedRevision` 和 plan digest，因此一项批准不能转换为另一项。
preview 只读；批准只绑定这一份有 TTL 的 proposal，不形成 durable lease 或 standing
approval。

apply 以相同 `target mutex → target file lock → checkpoint-store lock` 顺序重验完整
manifest raw/semantic CAS、status、path、目标证据与 conflict 分类。raw/semantic pin
或 status 漂移（包括被其他 reconciler 改为 committed）返回 `CHECKPOINT_CHANGED`；
manifest 已消失返回 `CHECKPOINT_NOT_FOUND`；目标已重新分类为机器可处理或不安全状态时
返回 `CHECKPOINT_STATE_CONFLICT`。三者都发生在首次内部 mutation 前，并要求重新
list/preview。commit
只允许 `before.existed:false` 且当前安全普通目标 revision 精确等于
`afterRevision`，同时固定当前 size 作为 apply CAS；它把 prepared manifest 原子替换为 committed，rename 是提交点，随后
fsync checkpoint 目录，不读取 stored-before blob、不运行 GC，也不修改项目资产。rename
后的 observer/fsync/store-lock/target-lock 故障返回
`manifestCommitted:true,durability:"unconfirmed"` 和固定 warning，不能变成暗示旧
change set 可重试的 application error。

这里的 commit 只保留内部审计 checkpoint 记录，不承诺可把 create 的写前“不存在”状态
恢复出来；当前 restore 明确不会以恢复之名删除目标文件。

abandon 接受上表四种 conflict，保留当前项目资产并永久 unlink prepared manifest；
unlink 是不可逆提交点，随后 fsync checkpoint 目录确认耐久性，再按剩余全部 roots 运行
fail-closed orphan GC。它不读取 stored-before blob，因此坏或缺失的自身 object 不阻止显式 abandon，但全局
inventory blocker 仍使 GC 零删除。提交点后的 sync/observer/GC/锁故障继续返回
`manifestDeleted:true` 的有界成功。两类成功都由 ChangeSetRegistry 精确缓存；同一
changeSet replay 只返回首个结果，不续跑。abandon 不留 tombstone；更宽来源认领、删除
项目资产或通用 force 仍不受支持。

prune preview 只接受 UUID `checkpointId`。它在 checkpoint-store lock 下读取并严格解析
raw manifest，但不读取或校验 blob；`prepared` 稳定返回
`CHECKPOINT_NOT_COMMITTED`。proposal 的 `expectedRevision` 是原始 manifest bytes 的
SHA-256，并连同 manifest size、目标路径和 checkpoint metadata 固定进
domain-separated plan digest。apply 先获取该 checkpoint 目标的文档 mutex/file lock，
再获取 checkpoint-store lock，并重新执行 raw manifest CAS。commit point 是 unlink
manifest 后 fsync checkpoint 目录；此后该 recovery point 已永久删除，不留 tombstone。
随后运行与配额压力相同的完整 fail-closed mark/sweep：inventory 有 blocker 时零删除并
报告 blocked，完整时只删除无引用 canonical object 与私有 crash temp。commit point
后的 fsync/GC 异常以净化 warning 和 failed/unknown deletion outcome 返回在成功 prune
结果中，不能变成暗示可安全重试的整体 apply error。

batch prune 使用独立的
`tiled_preview_checkpoint_prune_batch({checkpointIds})`，不扩宽上述单项工具。输入是
2..32 个 UUID；planner 先 lowercase 规范化并拒绝规范化后的重复项。调用方必须先列举并
明确选择这些 committed
checkpoints，服务端不会根据 retention ordinal、createdAt、label、容量压力或其他启发式
自动选择 victim。planner 按 canonical checkpoint ID 排序，这一顺序同时是 preview
公开顺序和 apply execution order。proposal 的 `expectedRevision` 是覆盖有序
`{id,manifestRevision,manifestSize}` pins 的 domain-separated 聚合 SHA-256；每项完整
metadata、canonical target path 与 execution order 另进入 plan digest。

apply 先从计划取得并校验全部 canonical target paths，去重后按确定性路径顺序获取所有
文档 mutex/file locks，全部 target locks 到手后才获取唯一 checkpoint-store lock；不允许
持 store lock 再反向获取 target lock。持有这些锁时，内核在首次 unlink 前权威重读全部
成员，并逐项复核 regular/no-follow manifest、raw revision/size、完整 metadata、path 与
`committed` status。任一 missing、retention 抢先删除、状态或 bytes 漂移都会使整个 batch
在首次删除前以零删除错误结束。这个 pin preflight 刻意不读取 stored-before blobs，也不把
global inventory/object 完整性当作显式 manifest 删除的前置条件；无关坏条目不能阻止
操作者清理精确批准的恢复点，global inventory 只约束后续 GC。

batch 只有“全量预检”，没有跨 manifest 原子提交：按 canonical ID 顺序逐项 unlink，每项
随后立即 fsync checkpoint 目录，并在首个故障停止。首次 unlink 前失败仍是零删除
application error；一旦任一 unlink 成功，后续 CAS/unlink/fsync/hook/锁故障都必须解析成
有界 `partial` 或 `completed` success；`outcomes` 逐项列出 `deleted`、`failed` 与
`not-attempted`，不能抛出会让旧计划再次执行的整体错误。ChangeSetRegistry 缓存这个
首个最终结果；相同 `changeSetId` replay 只返回缓存，绝不从剩余成员继续。只有全部
manifests 都删除后才运行一次 fail-closed GC；中途停止时 GC 明确为 not-run，孤儿对象由
以后安全 sweep 回收。继续 backlog drain 必须重新 list、preview、批准剩余 IDs。batch
同样不留 tombstone；含混 `prepared` 状态必须使用上述动作分离的人工裁决，不能混入
batch prune。

自动 retention 默认关闭。只有显式启动参数
`--checkpoint-retain-per-target N` 或环境变量
`TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET=N` 才授予本进程 standing approval；CLI 优先，
`N` 必须是 `2..10000` 的 canonical decimal。启用时，existing-file 的新 checkpoint
写为 v2 `rolling` manifest，并在 checkpoint-store lock 下从 durable global sequence
取得唯一正安全整数 ordinal；create checkpoint 写为 v2 `protected`。禁用时继续写 v1
manifest。legacy v1、`protected`、create 和任何 `prepared` manifest 都不计入 rolling
窗口且永不自动删除，label 也不是 pin。旧 manifest 不迁移，重新启用时只继续已有 durable
sequence。

retention 只在一次 net-changing 项目写入已完成 target promotion、目录 durability 且新
checkpoint 已成功 durable 标记为 committed 后触发；此时调用方仍持该目标锁，再取
checkpoint-store lock，固定顺序是 `target → store`。不做 startup sweep、后台 timer、
TTL、全局 LRU 或 quota emergency replacement，也不从 `ensureCapacity` 进入 retention。
因此新 recovery root 必须先容纳，空间不足仍在 target promotion 前返回
`CHECKPOINT_QUOTA_EXCEEDED`，不会为了让一次可能失败的新写入成功而先牺牲旧恢复点。

每轮在首次有效 manifest unlink 前完成全量 inventory，并按每个 referenced object
至多一次读取验证实际 hash；所有引用同一 object 的 manifest size 必须一致。malformed、
unknown、symlink、非普通 entry、missing/corrupt object、scan/byte-accounting
不完整、同目标存在 prepared、ordinal 重复、sequence 低于 live ordinal 的可观测回退或
溢出、不安全 rolling manifest，或当前普通目标不精确等于该目标最高 rolling ordinal 的
`afterRevision`，都使本轮零删除。通过后只按 ordinal 降序保留最新 N 个 rolling committed
checkpoint；`createdAt`、mtime、UUID、revision cycle 与 label 不参与顺序。每次 commit
最多删除 ordinal 最小的一个，因此 N 是无 blocker 正常运行时的 steady-state floor，不是
同步 hard cap。降低 N 或某轮 blocker 留下的超额数量不会被后续“一次新增、一次删除”降低；
操作者必须从当前列表中显式选择 victim，再用单项 prune 或每批 2..32 项的 batch prune
有界追赶；batch 工具不会替操作者重算或自动选择 retention victims。

删除前重读 candidate raw manifest 并复核 revision、size 和全部 metadata。unlink
manifest 后 fsync checkpoint 目录是 destructive commit point，随后才按剩余全部
prepared/committed roots运行 fail-closed orphan GC。commit point 前失败不删除 manifest；
之后的 fsync、observer、GC 或锁释放失败必须保留 document mutation 成功，并在
`CommitResult.checkpointRetention` 中报告 `manifestDeleted:true`、有界 GC outcome 与固定
warning，不能伪装为可安全重试的工具错误。显式 restore/prune preview 不是 durable lease：
如果获批计划中的 rolling checkpoint 先被 retention 删除，apply 稳定返回
not-found/changed，客户端必须重新检查而不能盲重试。

ordinal gap 本身合法：sequence 可以在 manifest 发布前的失败中先 durable 前进；显式 prune
不留 tombstone；retention 关闭期间也可能插入 protected legacy recovery point。每个 rolling
checkpoint 由自己的 before object 独立形成恢复锚，因而不要求相邻 live rolling
manifest 的 `before.revision` 与 `afterRevision` 连成无缺口链，只要求每项都是
existing-file、非 no-op、object 已验证的 committed recovery point。支持部署中的 durable
sequence 不复用 gap；若同权限进程在没有更高 live ordinal 证据时主动回滚 control file，
实现无法从剩余 manifests 证明历史 high-water mark，这属于可信 `.tiledmcp` 边界之外的
直接内部状态篡改。sequence control file 位于 retained quota 的 objects/checkpoints
范围之外；原子更新只使用一个固定命名的 private temp，下一次 ordinal allocation 在
store lock 下只清理该安全普通 crash temp，避免随机 control temp 无界积累。

`operations` 只允许当前版本列出的 tile/layer/object/map/tileset-reference 纯文档编辑，不允许嵌套 operations、
删除文件、恢复快照、转换、导出、AutoMapping、任意工具调用或 CLI 副作用。不得退回接受
任意工具名与参数的通用 batch。

除 `tiled_apply_change_set` 与正式冻结的 missing-only `tiled_create_map` 外，roadmap 中
表达“创建/更新/删除”的项目资产工具都只构造 preview，不直接写盘；因此其 annotations
按 preview 填写。未来不得从这个唯一例外推导新的直接提交入口；若确有新增，必须使用不同
工具名、独立安全设计与 annotations，不能用 `dryRun` 或 `commit` 布尔分支混合语义。

### 3.3 图层管理

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_create_layer` | **已实现**；预览创建一个空图层（4 种类型），可指定父 Group 与插入位置，不直接写盘 | `mapPath`, `type`(tilelayer/objectgroup/imagelayer/group), `name`, `parentGroupId?`, `index?`, `imagePath?`, `expectedMapRevision`, `expectedDependencyRevisions`, `expectedImageRevision?` |
| `tiled_update_layer` | 候选独立入口；当前等价能力已通过 `tiled_preview_edits` 的第 7 种 `updateLayer` operation 实现，修改 4 类 layer 的公共显示/元数据字段 | `mapPath`, `layerId`, `patch` |
| `tiled_move_layer` | 候选独立入口；当前等价能力已通过 `tiled_preview_edits` 的第 9 种、必须独占 change set 的 `moveLayer` operation 实现 | `mapPath`, `layerId`, `parentGroupId?`, `index` |
| `tiled_delete_layer` | 候选独立入口；当前等价 destructive 能力已通过 `tiled_preview_edits` 的第 8 种、必须独占 change set 的 `deleteLayer` operation 实现 | `mapPath`, `layerId`, `deleteDescendants?` |
| `tiled_duplicate_layer` | 候选独立入口；当前等价能力已通过 `tiled_preview_edits` 的第 10 种、必须独占 change set 的 `duplicateLayer` operation 实现 | `mapPath`, `layerId`, `destination?`, `name?` |

当前实现只接受有限正交 TMJ。省略 `parentGroupId` 表示根 `layers`；否则它必须是一个已存在
Group 的全图唯一数字 ID。`index` 是目标同级 JSON 数组的 0-based 插入点，合法范围为
`0..length`；省略时等于 `length`，即追加到绘制顺序最上方。服务端不会接受名称 fallback
来定位父层，也不会 clamp 越界 index。

新层 ID 精确取当前 `nextlayerid`，随后把计数器加一；现有 ID 会递归扫描 Group，损坏、
重复、落后于最高 ID 或即将溢出的计数器都 fail closed，不以 `max(id)+1` 静默修复。
`tilelayer` 与 map 同尺寸并初始化为 0，单层最多 100,000 个 cell；`objectgroup`、
`group` 分别从空 `objects`、空 `layers` 开始。`imagelayer` 必须提供 canonical
project-local `imagePath`，服务端派生 map-relative `image`，安全读取真实尺寸，并将图片
revision 作为 prospective dependency 固化；可选 `expectedImageRevision` 用于调用入口
pin。

该工具只签发一个有 TTL 的非 destructive preview；客户端批准后用
`tiled_apply_change_set(changeSetId, expectedRevision)` 提交。apply 会重新检查 map、完整
既有 TSJ dependency set 与 prospective image revision，重新解析父 Group/index/ID 后仅
写目标 TMJ。写回对目标 sibling array 使用单元素 source insertion，并另替换
`nextlayerid`：原有同级元素、未知字段、BOM、换行、缩进、键序和转义保持原 bytes，新元素
本身使用紧凑 JSON。当前一个 create-layer change set 只能创建一个空层，不能同批创建
Group 后再向它添加子层，也不支持 infinite/chunk；移动和删除已有层分别使用下述独占
`moveLayer` / `deleteLayer` operation。

当前已实现的 common-layer update wire contract 是
`{type:"updateLayer", layerId, patch}`，并属于通用
`tiled_preview_edits.operations` union；它不额外注册 `tiled_update_layer` 工具，因此
registry 仍为 28 个 core / 29 个含 rasterizer。`layerId` 必须是正整数，并递归定位一个
现有 `tilelayer`、`objectgroup`、`imagelayer` 或 `group`；不按名称 fallback。patch
必须至少包含一个字段，禁止额外 key。允许字段与 TMJ key 的映射为：

| operation patch | TMJ member |
|---|---|
| `name` | `name` |
| `className` | `class` |
| `visible` | `visible` |
| `opacity` | `opacity` |
| `offsetX` / `offsetY` | `offsetx` / `offsety` |
| `parallaxX` / `parallaxY` | `parallaxx` / `parallaxy` |
| `tintColor` | `tintcolor` |
| `locked` | `locked` |
| `blendMode` | `mode` |

`name`/`className` 各最多 1024 个 JS characters；`visible`/`locked` 是 boolean；
`opacity` 为有限数且限 `0..1`；offset/parallax 必须是
`-1,000,000,000..1,000,000,000` 内的有限数。`tintColor` 接受
`#RRGGBB`、`#AARRGGBB` 或 `null`，其中 `null` 精确表示删除 `tintcolor`。
`blendMode` 是 13 项封闭 enum：`normal`、`add`、`multiply`、`screen`、`overlay`、
`darken`、`lighten`、`color-dodge`、`color-burn`、`hard-light`、`soft-light`、
`difference`、`exclusion`；未知 Tiled/Canvas 名称不会透传。

no-op 以 JSON member 的实际存在性和值判断：已存在且值相同不改；删除缺失的 tint 不改。
如果字段缺失，即使 Tiled 的运行时默认值与请求相同，显式插入仍是 change，不能用语义
默认值吞掉用户 intent。同一字段在一个 batch 内多次出现时按 operation 顺序报告逐步
change；若最终值回到原始 JSON，apply 的文件级结果仍为 `changed:false`。`locked` 只写
Tiled advisory metadata，不阻止同一 batch 或之后
的 tile/object/layer edit。preview 的 operation 与 summary 都回显
`requestedFields`、`changedFields`、`wouldChange` 与 `affectsDescendants`；后者为 Group
中实际改变的公共渲染属性标出可能的后代影响；name/class/locked 或 no-op 不置位，也不
代表递归重写后代。

apply 只为实际 changed field 生成 layer-object member-local insertion/replacement/
deletion，不序列化整个 layer；未知成员、相邻数组、BOM、换行、缩进、键序和未触及词法
保持原 bytes。它可与 tile `data` 和 object `objects` edits 同批；preview 固定 map
revision 与完整 dependency revision set，apply 重新规划、比较摘要并做正常 revision
CAS。

当前已实现的 layer deletion wire contract 是
`{type:"deleteLayer", layerId, deleteDescendants?}`，它是 generic
`tiled_preview_edits.operations` union 的第 8 种 operation。由于删除检查必须针对同一个
原始完整 map 计算，含 `deleteLayer` 的 change set 必须且只能有这一项 operation；不能
同批 set tile、改 object 或 update layer。它不额外注册 `tiled_delete_layer`，registry
仍是 28 个 core / 29 个含 rasterizer。

正整数 `layerId` 可递归定位 4 类已有 layer。tile/object/image leaf 与空 Group 不需要
额外确认；非空 Group 若没有 `deleteDescendants:true` 会以 `LAYER_HAS_DESCENDANTS`
拒绝。确认后删除的是选中 Group 的整棵 subtree 及所有 layer-owned tile data、image 与
objects；这里的 image 只是 TMJ 中的 image-layer reference，不删除外部图片或 TSJ 文件。
children 不提升到原 Group 的父级，也不会清空、删除或重写更高层祖先。显式
`deleteDescendants:false` 与省略等价；对 leaf 传 true 不扩展删除边界。

若 subtree 含 objects，planner 会收集其 ID，并仅在将继续存活的 map 中做 typed reference
分析。直接 `type:"object"` property 或 Tiled 1.12 `type:"list"` 中的 object item 指向
待删 ID 时返回 `OBJECT_IN_USE`。存活的 `type:"class"` property 可能隐藏 typed object
reference，当前无法安全展开，因此返回 `UNSUPPORTED_OBJECT_REFERENCE_ANALYSIS`，不会
猜测为未引用。被删 subtree 内部互相引用会随 subtree 一起消失，不阻止删除。

preview 固定目标 `layerId`、类型、有界名称、直接父 Group ID 与 sibling index，并明确
`destructive:true`。摘要给出完整 `deletedLayerCount`、`descendantLayerCount`、
`objectCount` 与 `lockedLayerCount`；`layerIdSample` / `objectIdSample` 各最多 32 项，
分别配套 `omittedLayerCount` / `omittedObjectCount`，调用方不得把样本当作完整集合。
被删除 layer 中的 `locked:true` 只作为 advisory warning 与计数，不构成 ACL，也不阻止
apply。

删除不会降低或重用根 `nextlayerid` / `nextobjectid` 高水位。source writer 只对选中
layer 的直接父 `layers` array 做一次 array-element-local deletion；完整 subtree 随该
单一 element 消失，未触及 sibling/祖先、未知字段、BOM、CRLF、缩进、键序与词法保持原
bytes。preview 固定 map revision 与完整 dependency set，apply 重算 operation/摘要、
验证 digest 与 revision pins，并在锁内 CAS 后才提交。delete 已通过 generic operation
实现，不应再列为未实现。

当前已实现的 layer move wire contract 是
`{type:"moveLayer", layerId, parentGroupId?, index}`，它是 generic
`tiled_preview_edits.operations` union 的第 9 种 operation。它必须独占 change set：
多次 move，或与 tile/object/update/delete 混批，都会在任何语义 mutation 前拒绝。
它不额外注册 `tiled_move_layer`，所以 registry 仍是 28 个 core / 29 个含
rasterizer。

`layerId` 与显式 `parentGroupId` 必须是正整数；省略 `parentGroupId` 表示根
`layers`，wire 上不接受 `null`。显式目标必须是已有 Group。`index` 是移动完成后的
**最终 JSON sibling index**，不是删除前 insertion boundary：同父原长度为 `n` 时合法
范围是 `0..n-1`，跨父且目标原长度为 `m` 时是 `0..m`。例如
`[A,B,C,D]` 中把 B 移到 index 3 得到 `[A,C,D,B]`。同父且 source index 与目标 index
相同是合法 no-op，preview 仍描述请求，apply 返回 `changed:false` 且不产生文件 diff。

Group 总是连同完整 subtree 移动；children 不提升，旧父 Group 即使变空也保留。Group
不能移入自身或任一后代，目标层级还必须满足统一的最大深度 64，越界时在 splice 前拒绝。
移动不重新分配任何 layer/object ID，也不改变 `nextlayerid` 或 `nextobjectid` 高水位。
`locked` 是 advisory metadata，不阻止移动；preview 会分别统计显式
`lockedLayerCount`，以及移动前后的 `effectivelyLockedLayerCountBefore` /
`effectivelyLockedLayerCountAfter`，从而表达目标 Group 祖先继承锁带来的变化。

preview 的 `movedLayers` 项固定 `sourceParentGroupId` / `sourceIndex` 与
`targetParentGroupId` / `targetIndex`，其中根父级以 `null` **只出现在输出**；同时返回
完整 `subtreeLayerCount`、`descendantLayerCount`、`objectCount`、
`lockedLayerCount`，最多 32 项 preorder `layerIdSample` 与对应
`omittedLayerCount`。`wouldChange`、`renderOrderMayChange`、
`renderContextMayChange` 和 `affectsDescendants` 明示同级绘制顺序、换父后的 Group
渲染上下文与 subtree 影响；调用方不得从一个 root layer ID 推断完整影响集合。

apply 重新规划并核对 digest、map/dependency revision pins，随后在正常锁内 CAS、
checkpoint 和同目录原子替换边界提交。source writer 使用专用 `JsonArrayMove`：source
与 destination container path 都按原始 source snapshot 解释，因此即使先移除一个 root
sibling 让后面的目标 Group path 偏移，也能定位正确。writer 捕获 source element 的
exact bytes 并搬入目标，只改源/目标数组接缝所需的逗号与 whitespace；被移动 subtree
内部以及未触及 sibling/祖先的未知字段、BOM、CRLF、键序、数字和字符串转义词法均保留，
最后仍以完整 target semantic tree 复核。

当前已实现的 layer duplication wire contract 是
`{type:"duplicateLayer", layerId, destination?, name?}`，它是 generic
`tiled_preview_edits.operations` union 的第 10 种 operation。它必须独占 change set，
不能与 tile/object/update/delete/move 或第二次 duplicate 混批，也不注册
`tiled_duplicate_layer` standalone tool；registry 因此仍是 28 core / 29 with
rasterizer。

`destination` 省略时复制到 source 的直接父数组并插在 `sourceIndex + 1`。显式值必须严格
匹配以下三个 discriminated 分支之一：

- `{kind:"sameParent", index?}`：目标仍是直接父；省略 index 时同样使用
  `sourceIndex + 1`；
- `{kind:"root", index?}`：目标是 map 根 `layers`；省略 index 时 append；
- `{kind:"group", parentGroupId, index?}`：正整数 ID 必须指向已有 Group；省略 index
  时 append。

显式 `index` 是插入完成后的最终 0-based JSON sibling index。复制不移除 source，因此
所有目标数组的合法范围统一为 `0..length`；越界拒绝而不 clamp。Group 被复制为完整
subtree，不能把副本放入 source Group 自身或任一 descendant；目标 child depth 加
subtree 最大相对深度不得超过 64。可选 `name` 最多 1024 个 JS characters，允许空字符串，
且只覆盖 copied subtree root 的 `name`；source 和后代名称保持不变。

planner 先验证全图 ID inventory 和根计数器：layer ID 从原 `nextlayerid` 起、object ID
从原 `nextobjectid` 起，均按完整 subtree preorder 连续分配，然后分别推进到新高水位，
不搜索或填补历史 gap。没有 copied object 时 `nextobjectid` 不修改。复制后全图不得超过
10,000 layers / 100,000 objects；一次 operation 最多复制 10,000 objects、累计
100,000 个有限未压缩 tile cells，最终嵌套深度最多 64。单个 compact duplicate 的 UTF-8
JSON 最多 16 MiB，按保守 insertion/counter overhead 估算后的整个 TMJ 最多 64 MiB；
signed 32-bit ID 空间或 checked arithmetic 溢出同样 fail closed。

副本中 direct `type:"object"` property 和 Tiled 1.12 `type:"list"` 内任意嵌套的 typed
object item 会被分析：目标在 copied subtree 内时改写为对应新 object ID；目标是 source
subtree 外仍存在的对象或 `0` 时保留原值；目标不存在则返回
`OBJECT_REFERENCE_NOT_FOUND`。普通 integer property 不会被猜成 object/layer reference；
非标准 `type:"layer"` reference 不猜测也不重写。任何 `type:"class"` property 都可能
隐藏 typed reference，object 上的 `template` 也没有独立 revision pin，因此两者均 fail
closed。image-layer `image` 与 `type:"file"` property 只是共享原 external reference，
不会复制、重命名或修改目标文件。

所有 copied tile-layer GID 和 tile-object `gid` 都按当前 external-atlas binding 验证；
tile object 的 H/V/D/raw transform flags 随完整原值保留。`locked` 仍是 advisory
metadata，不阻止复制。`lockedLayerCount` 统计 subtree 内显式锁，
`effectivelyLockedLayerCount` 再叠加目标 Group 及其祖先的继承锁，preview warning 不会把
它误写成 ACL 或宣称 child `locked` member 被改写。

`duplicatedLayers` summary 每项字段固定为 `operationIndex`、`sourceLayerId`、
`createdRootLayerId`、`layerType`、`name`、`nameTruncated`、
`sourceParentGroupId`、`targetParentGroupId`、`sourceIndex`、`targetIndex`、
`copiedLayerCount`、`descendantLayerCount`、`copiedObjectCount`、
`allocatedCellCount`、`serializedDuplicateBytes`、`layerIdMappingSample`、
`omittedLayerMappingCount`、`objectIdMappingSample`、`omittedObjectMappingCount`、
`remappedInternalObjectReferenceCount`、`retainedExternalObjectReferenceCount`、
`fileReferenceCount`、`tileObjectCount`、`lockedLayerCount`、
`effectivelyLockedLayerCount`、`renderOrderMayChange`、
`renderContextMayChange` 与 `affectsDescendants`。layer/object preorder mapping sample
各最多 32 项；完整数量来自 copied count 和 omitted count，不能把样本当成全集。

source writer 不复制 source element 的词法文本：它把已经分配 ID、重连引用和可选改名的
semantic copy 序列化为一个 compact JSON element，再在目标 `layers` array 做一次局部
insertion；原 source subtree、既有 siblings、未知字段、BOM、CRLF、键序、缩进和其他
数字/字符串词法保持原 bytes。`nextlayerid` 以及仅在 copied object 非空时的
`nextobjectid` 使用 numeric-value-local counter patch。preview 固定 map revision 与完整
dependency revision set；apply 重新规划 destination、ID、引用、限制、摘要和 source
patch，验证 digest/revision pins/raw-byte CAS，并在锁内完成写前 checkpoint 与同目录
原子替换。其他图层工具仍统一用数字 `layerId` 定位。

### 3.4 图块编辑 — Tile Layer（核心价值）

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_get_region` | 读取矩形区域的 tile。`format: "json"` 返回 `TileRef \| null` 二维数组；`format: "ascii"`（默认）返回单字符网格 + 图例，图例中的每项仍映射到完整 `TileRef`。图像看外观、ASCII 看结构、JSON 看精确值 | `mapPath`, `layerId`, `region`, `format?` |
| `tiled_set_tiles` | 批量设置稀疏 tile 列表（一次调用可跨多个不相邻位置） | `mapPath`, `layerId`, `tiles: [{x, y, tile|null}]` |
| `tiled_fill_region` | 矩形区域填充单一 tile；当前等价能力通过 `fillRegion` operation 实现，`tile:null` 可清空整块 | `mapPath`, `layerId`, `x`, `y`, `width`, `height`, `tile` |
| `tiled_flood_fill` | **已实现等价 generic operation**：当前不注册 standalone tool，通过 `tiled_preview_edits` 的第 12 种、固定四向的 `floodFill` 从绝对 seed 填充完整 encoded GID 相同的连通区域 | `mapPath`, `layerId`, `x`, `y`, `tile` |
| `tiled_replace_tiles` | 候选独立入口；当前等价能力已通过 `tiled_preview_edits` 的 `replaceTiles` operation 实现：在全 layer/区域内同时应用多组精确替换 | `mapPath`, `layerId`, `mappings: [{from, to}]`, `region?` |
| `tiled_copy_region` | **已实现等价 generic operation**：当前不注册 standalone tool，通过 `tiled_preview_edits` 的第 15 种 `copyRegion` 在同一 map 的 finite numeric tile layers 间按绝对坐标复制完整矩形 | `mapPath`, `source:{layerId,x,y,width,height}`, `destination:{layerId,x,y}` |
| `tiled_clear_region` | 候选独立入口；当前直接使用 `fillRegion` + `tile:null` 清空矩形，不新增 operation/tool | `mapPath`, `layerId`, `region` |
| `tiled_stamp_pattern` | **已实现等价 generic operation**：当前不注册 standalone tool，通过 `tiled_preview_edits` 的第 11 种 `stampPattern` 盖章。成型的多图层复用结构走预制件（3.5） | `mapPath`, `layerId`, `x`, `y`, `pattern: (TileRef|null)[][]` |
| `tiled_select` | 创建显式选区：按 tile 值、魔棒、多边形或已有 selectionId 组合；返回绑定 map revision、客户端连接和 TTL 的 `selectionId`，后续通过 `Region.kind = "selection"` 显式引用 | `mapPath`, `layerId`, `mode`, `args` |

其中 `tile` 参数统一为 `TileRef` 或持久化注册过的语义名（见 3.10）；语义名解析结果必须在预览中回显为完整 `TileRef`，有歧义时拒绝执行。

当前已实现的 replacement wire contract 是
`{type:"replaceTiles", layerId, mappings:[{from: TileRef, to: TileRef|null}], region?:{x,y,width,height}}`，
并属于通用 `tiled_preview_edits.operations` union，不额外注册
`tiled_replace_tiles` 工具。`from` 不能为 `null`；`to:null` 表示清空。source 与当前
cell 按完整 unsigned encoded GID 精确比较，包括 transform/raw flags；省略 transform
表示 identity，不是“任意朝向”。target 则描述最终完整 `TileRef`，不会从 source
继承变换位。

一个 `replaceTiles` operation 对其输入快照只做一次扫描并同时应用 mappings：
`A→B, B→C` 的结果是原始 A 变 B、原始 B 变 C，不发生级联；swap 和 cycle 同样按原始
cell 值求值。相同 encoded source 的重复 mapping，以及 source/target encoded GID 完全
相同的 mapping 会被拒绝。可选 `region` 使用 layer 空间中的绝对 tile 坐标，必须完全落在
layer bounds 内；省略时精确采用该 layer 的 `x/y/width/height` bounds。每个 operation
最多 128 组 mapping。一个 change set 的 replacement、flood-fill 与 copy operation 共用
1,000,000 次实际 GID 读取预算；只有实际替换才计入所有 tile operations 共用的
100,000-cell 写入上限。零命中是合法 no-op，preview 报告
`replacedCellCount:0`，apply 不改写文档。

当前已实现的 stamp wire contract 是
`{type:"stampPattern", layerId, x, y, pattern:(TileRef|null)[][]}`。它是通用
`tiled_preview_edits.operations` union 的第 11 种 operation，不额外注册
`tiled_stamp_pattern` 工具，因此 registry 保持 28 core / 29 with rasterizer。
`pattern` 必须是非空、稠密、矩形、row-major 的二维数组：外层和每行均非空、所有行等宽，
不接受 sparse hole/`undefined`。宽和高各最多 256，总格数最多 16,384。

`x/y` 是 pattern 左上角在 layer 空间中的绝对 tile 坐标。由它和矩阵宽高得到的目标矩形
必须完整落在目标有限 tile layer 的 `x/y/width/height` bounds 内；服务端不做 clipping。
矩阵的每一项都是一次显式写入：`TileRef` 编码并写入完整 GID，`null` 写入 GID 0、明确
清空目标格；`null` 不是 transparent/skip，当前也没有其他 skip sentinel。需要清空整个
矩形时仍可使用 `fillRegion` + `tile:null`。

一个 change set 严格按 operations 顺序执行，后面的 operation 读取前面 operation 的结果；
重叠位置由 later operation 决定最终值。该规则同时覆盖 stamp、`setTiles`、
`fillRegion`、`replaceTiles`、`floodFill`、`copyRegion` 与其他 stamp；
`replaceTiles` 仅在自己的 operation 内保持 simultaneous single-pass。每个 stamp 的全部
`cellCount`（包括写入
相同值的格子）都计入所有 tile operations 共用的 100,000-cell change-set 写入上限。

preview 回显规范化 `region`、`cellCount`、非空/清空/变换/实际变化 count 与
`wouldChange`。其 `sample` 只按 pattern 的 row-major 顺序返回前 8 个绝对
`{x,y,tile}`，其中保留 `tile:null`，并以 `omittedCellCount = cellCount - sample.length`
明确截断。source writer 只局部替换目标 tile layer 的 `data`。若每个 pattern entry
编码后的 GID 都已等于目标值，则该 operation 是 no-op；最终全 plan 也无其他变化时 apply
返回 `changed:false`，revision 与原文件 bytes 完全不变。

当前已实现的 flood-fill wire contract 是
`{type:"floodFill", layerId, x, y, tile:TileRef|null}`。它是通用
`tiled_preview_edits.operations` union 的第 12 种 operation，不额外注册
`tiled_flood_fill` 工具，因此 registry 仍为 28 core / 29 with rasterizer。它只接受
finite orthogonal、numeric-array tile layer；`layerId` 是正整数，`x/y` 是 layer 空间
中的绝对 seed tile 坐标且必须位于 layer 自身的 `x/y/width/height` bounds 内。

连通性固定为四向，不接受对角连接或可选 connectivity 参数。source 不是 wire 输入，而是
planner 执行到该 operation 时从 seed cell 读取；因此前序 operation 可以改变本次 source。
匹配使用完整 unsigned encoded GID 的数值相等，H/V/D transform 与 raw flags 全部参与，
同一 base tile 的不同朝向不会混为一个区域。target `tile:null` 表示写入 GID 0；反过来，
source 也可以是空 GID 0，因此能把相连空区填成非空 tile。source 与 target 的完整编码
相同时，planner 在读取并验证 seed 后立即报告 no-op，不扫描整个连通区域。

flood fill 的 `scannedCellCount` 是实际 GID 读取次数，不是 distinct cell 数。固定四向遍历
可能重复观察已经改成 target 的 cell 或不匹配的边界邻格；每次读取都与
`replaceTiles` / `copyRegion` 共用单 change set 1,000,000-read scan budget。任何被观察到的
cell 都先
按当前 orientation 与 tileset bindings 完整反向解析；非 unsigned GID、带 transform flags
的空 GID 或未绑定/越界 base GID 都 fail closed，不能因其不匹配 source 就跳过验证。未被
该局部遍历观察的远端 cell 不属于此次操作的扫描承诺。

实际改变的连通 cell 才计入所有 tile operations 共用的 100,000-cell 写入预算。一个 change
set 仍按 operations 顺序修改同一工作副本：flood 会看到之前的
set/fill/stamp/replace/flood/copy
结果，后面的 operation 又可以覆盖它，重叠时 later wins。plan 的
`tileFloodFills` summary 与 bounded preview 回显绝对 `seed`、固定
`connectivity:"four-way"`、canonical `sourceTile` / `targetTile`、
`scannedCellCount`、`changedCellCount`、`wouldChange` 与
`affectedBounds`。`affectedBounds` 是实际变化 cell 的绝对外接矩形，不是完整 cell
列表；preview 不返回任何 cell sample/list，无变化时 bounds 为 `null`。

apply 会重算 source、遍历、预算、summary 与 dependency pins，只为实际变化的目标 tile
layer 生成 `data`-member-local source patch。source=target 或 mixed operations 最终回到
原始数据的 net no-op 返回 `changed:false`，不改变 revision 与原文件 exact bytes。

当前已实现的矩形复制 wire contract 是
`{type:"copyRegion",source:{layerId,x,y,width,height},destination:{layerId,x,y}}`。
它是通用 `tiled_preview_edits.operations` union 的第 15 种 operation，不注册
`tiled_copy_region` standalone tool，因此 registry 仍为 28 core / 29 with rasterizer。
operation、`source` 与 `destination` 均为 exact-key strict object。source 和
destination 必须位于同一 map，且两侧 layer 都必须是 finite orthogonal、
numeric-array tile layer；不支持 infinite chunks、字符串/base64 data 或压缩编码。

所有坐标都是 layer 空间中的绝对 tile 坐标。source 的正整数 `width/height` 固定 copy
尺寸，destination 使用同样宽高；两个完整半开矩形必须分别位于对应 layer 的
`x/y/width/height` bounds 内。超出任一边界时整个 operation 拒绝，不做 clipping、wrap、
partial copy 或 transparent/skip。source 中的 GID 0 也是待复制值，会把对应 destination
清空。

operation 开始时，planner 先快照完整 source 和完整 destination，再产生任何写入。因此
同层重叠矩形具有 snapshot-source memmove 语义，不能把刚写入的 destination 值继续作为
后续 source。非零值按完整 unsigned encoded GID 原样复制，H/V/D 与保留 raw flags 不会
丢失或重新 canonicalize。source 与 destination 的每个 observed GID 都先经当前
orientation/bindings 完整反向解析；非整数、数组 hole、超出 uint32、flag-only empty、
tileset gap 或未绑定 GID 均 fail closed。

copy 可以与其他 generic operations 混批。它在执行时看到所有前序 operation 的结果；
后序 operation 可以覆盖 destination，统一采用 sequential change-set order 和
last-write-wins。每个 operation 的 `cellCount = width * height`，
`scannedCellCount = 2 * cellCount`：source 与 destination snapshot 的全部读取都计入
replace/flood/copy 共用的单 change set 1,000,000-read scan budget。完整 `cellCount`
（包括 source 与 destination 已相同的格子）计入所有 tile operations 共用的
100,000-cell write budget；超限拒绝整个 plan。

plan 的 `summary.tileCopies[]` shape 固定为
`{operationIndex,source:{layerId,x,y,width,height},destination:{layerId,x,y,width,height},`
`scannedCellCount,cellCount,sourceNonEmptyCellCount,changedCellCount,`
`overwrittenNonEmptyCellCount,clearedCellCount,overlapsSource,wouldChange}`。
bounded operation preview 使用相同字段但不含 `operationIndex`，另含
`type:"copyRegion"`、`destructive:true` 和 `warning`；destination 的
`width/height` 由 source 尺寸规范化补齐。preview 不返回 cell list/sample，调用方必须
根据完整 regions 和 counts 审批。`overlapsSource` 只在同 layer 且两个矩形相交时为 true；
`sourceNonEmptyCellCount` 统计 source snapshot 的非零 GID；
`overwrittenNonEmptyCellCount` 统计 operation-start destination snapshot 中全部非零
GID，无论对应格最终是否变化；`changedCellCount` 统计两侧值不同的格子；
`clearedCellCount` 统计 source GID 0 实际清空的非零 destination。所有 GID 已相同时
`changedCellCount:0`、`wouldChange:false`。

`tiled_get_capabilities.tileCopyCapabilities` 精确公布：
`coordinates:"absolute-tile-coordinates"`、`clipping:false`、
`overlap:"snapshot-source-memmove"`、`emptySource:"overwrites-and-clears"`、
`gidCopy:"exact-encoded-gid"`、
`observedGidValidation:"source-and-destination-fail-closed"`、
`operationOrdering:"sequential-change-set-order-last-write-wins"`、
`scanBudget:"shared-with-replaceTiles-and-floodFill-per-change-set"` 与
`sourcePatch:"destination-tile-layer-data-member-local"`。
apply 从 pinned source 重算两个快照、GID validation、预算、summary 与 dependency pins；
copy 执行时实际变化的 destination layer 才进入 `affectedTileLayerIds`，并成为
`data`-member-local source patch 候选。跨 layer copy 不重写 source layer；同 layer copy
也只 patch 该层一次。若后序 operation 恢复原值，最终 net no-op 仍返回
`changed:false` 并保持 revision/source exact bytes。

### 3.5 程序化生成与预制件（后续重点）

模型当导演，算法当工人（原则 10）：手写 100×100 的森林是在浪费模型，它该做的是调参、看渲染结果、再调参。所有生成工具接受 `seed` 保证可复现（同参数同结果，便于微调迭代）。

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_generate` | 程序化填充：`noise`、`cellular`、`dungeon`；`mapping` 定义数值区间→tile/wang 颜色，seed 保证可复现 | `mapPath`, `layerId`, `algorithm`, `region: Region`, `mapping`, `seed`, `options?` |
| `tiled_scatter` | 在显式 Region 内按密度撒装饰 tile 或模板对象，带避让、最小间距和边缘留白规则 | `mapPath`, `layerId`, `items`, `density`, `region: Region`, `seed`, `minSpacing?`, `avoid?` |
| `tiled_draw_shape` | 画几何形状：线段/折线路径（可指定宽度——道路、河流）、矩形描边或填充、圆/椭圆。`tile` 处可给 wang 颜色，让路径自动用地形过渡 tile 收边 | `mapPath`, `layerId`, `shape`, `points`, `tile\|wangColor`, `width?` |
| `tiled_save_prefab` | 从地图截取一个区域的**多图层结构**（tile + 对象，按图层名组织）存为预制件（`.tiledmcp/prefabs/*.json`）。工作流：模型先精雕一间房 → 存 prefab →"这种房子来五间" | `mapPath`, `region`, `layerIds?`, `name` |
| `tiled_place_prefab` | 放置预制件：多图层内容对齐落到目标地图（图层按名匹配，缺失可自动创建），对象 id 重新分配，支持翻转 | `mapPath`, `prefabName`, `x`, `y`, `flipH?` |

### 3.6 对象编辑 — Object Layer

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_list_objects` | **已实现基础版**；有界列出全部或指定 object layer，返回精简视图 | `mapPath`, `layerId?`, `limit?` |
| `tiled_get_object` | **已实现**；按全图唯一 ID 返回一个有界、严格 shape 判别的 editable semantic projection；path 返回完整 points，text 返回解析缺省后的完整样式，自定义属性按文档序回读（标量逐字、复杂/超长条目 `valueOmitted` 标记、≤128 条）；tile/template 拒绝 | `mapPath`, `objectId` |
| `tiled_create_object` | 候选独立入口；当前等价能力通过 `tiled_preview_edits` 的 `createObject` operation 提供，支持 rectangle/point/ellipse/capsule/polygon/polyline/text | `mapPath`, `layerId`, `shape`, `x`, `y`, `width?\|height?\|points?\|text?`, `name?`, `class?`, `rotation?` |
| `tiled_update_object` | 候选独立入口；当前通过 `updateObject` operation 修改基础对象字段 | `mapPath`, `objectId`, `patch` |
| `tiled_delete_object` | 候选独立入口；当前通过带醒目 destructive 摘要的 `deleteObjects` operation 提供；拒绝留下 object/list 引用，class 属性存在时 fail closed | `mapPath`, `objectIds` |
| `tiled_instantiate_template` | 从 `.tx`/`.tj` 模板实例化对象（后续候选） | `mapPath`, `layerId`, `templatePath`, `x`, `y`, `overrides?` |

当前 `createObject.object` 是以 `shape` 判别的 exact-key strict union。rectangle 延续
可选 `width` / `height`，point 禁止尺寸；ellipse 与 Tiled 1.12 capsule 的
`width` / `height` 同样可省略，省略时按 Tiled 语义序列化为 0。显式尺寸必须有限、
非负且不超过 1,000,000,000。polygon 必须有 3–256 点，polyline 必须有 2–256 点；
每个 point 是 strict `{x,y}`，坐标为相对 object `x/y` anchor 的本地像素，每轴必须是
±1,000,000,000 内有限数并保持输入顺序。polygon 由 Tiled 隐式闭合，服务端不会自动
重复或追加首点；polyline 保持开放。一个 change set 内，每一次 path create 与每一次
`updateObject.patch.points` 完整替换都按 payload 原始点数逐项累计，合计最多 8,192 点；
相同值 no-op、later-wins 或后续 delete 都不抵扣。pending change-set registry 以相同
口径合计最多保留 65,536 点，并通过 capability
`limits.maxPendingObjectShapePoints` 公布。

polygon/polyline create wire 禁止 `width` / `height`，写入 TMJ 时统一保存
`width:0,height:0`，并只增加对应的 `polygon` / `polyline` points 数组。其他 shape
严格禁止 `points`。
写入 TMJ 时分别只增加 `ellipse:true` 或 `capsule:true` marker，不能同时携带另一种
shape marker。

text create wire 与其他分支一样是 flat strict object：`text` 必填且允许空，样式字段为
`fontFamily`、`pixelSize`、`color`、`bold`、`italic`、`underline`、`strikeout`、
`kerning`、`wrap`、`horizontalAlignment` 和 `verticalAlignment`；`width` / `height`
可省略并默认 0。正文最多 4,096 个 Unicode scalar 且 UTF-8 最多 16,384 bytes，只允许
TAB/LF/CR 三种 Cc；fontFamily 为 1–256 scalars、最多 1,024 bytes、拒绝全部 Cc；二者
都拒绝未配对 surrogate。pixelSize 是 1..999 的整数；颜色为 `#RRGGBB` 或
`#AARRGGBB`。wire 写入 nested TMJ `text:{text,...}`，按文件格式默认值
`sans-serif/16/#000000/false styles/kerning:true/left/top/wrap:false` 稀疏省略。

这七类对象都能使用现有 `updateObject` / `deleteObjects`。update patch 没有
`shape` 字段，因此不能改变对象形状。对 polygon/polyline，`points` 是完整数组替换：
wire 公共边界为 2–256 个 strict `{x,y}`，planner 按目标形状进一步要求 polygon 至少
3 点、polyline 至少 2 点；不支持 append、splice 或 index patch。它可与
x/y/name/className/rotation/visible/opacity 等 common fields 同批出现，但仍拒绝
`width` / `height`。非 path 目标携带 `points` 返回 `OBJECT_SHAPE_MISMATCH`。text
对象允许局部更新 common、dimensions 和上述 12 个 flat text fields；
object-update preview 的 `changedFields` 必须精确等于 patch keys 的去重字典序列表；
它表达请求字段而非语义 diff，所以相同 points no-op 仍列出 `points`，apply 最终返回
exact-byte no-op；若同一 change set 没有其他实际变化，则返回 `changed:false` 并保持
原始 bytes/revision。
text-specific patch 命中非 text 对象时返回 `OBJECT_SHAPE_MISMATCH`。

`updateObject.patch.properties` 对 map object 的自定义属性做有界标量
set/remove，与 `tiled_update_tile` 的 per-tile `properties` 共享同一实现与
写入 profile：每次 update 最多 32 set + 32 remove，可写类型
`string/int/float/bool/color/file`，name ≤256 code points、字符串值 ≤1,024
code points，编辑后单对象最多 128 条属性，每条都携带显式 `type` member。
新名字按 Tiled 的 name 排序位置插入，存量数组非升序时插入 fail closed
（`UNSUPPORTED_PROPERTY_WRITE`）；set/remove 命中 class、enum
（`propertytype`）、list 或 object 属性同样 fail closed，未触及的复杂条目
逐字保留（含未知成员）；remove 不存在的名字是 no-op；清空后的
`properties` member 整体删除，与 Tiled writer 的空省略一致。一个 change set
内全部 `updateObject` 属性写入合计不超过 262,144 canonical JSON UTF-8 字节
（zod 层与 planner 双重执行）。tile object（`gid`）与 template 实例仍在
bounded object editing 之外，属性不可写。

对 ellipse/capsule 更新任意基础字段时，
planner 继续验证最终 width/height 为有限非负数；存量对象缺失的尺寸按 Tiled 语义解释
为 0，显式 0 合法，null、负数或超限值会拒绝整个 proposal。对象 patch 继续只替换目标
object layer 的 `objects` member，create 另以
value-local patch 推进 `nextobjectid`，未触及 source bytes 保持不变。只读
`tiled_get_object` 返回 map revision、完整 dependency revisions 和 bounded object
projection，并按文档序回读对象自定义属性：内建标量（string/int/float/bool/color/
file，字符串值 ≤1,024 code points）逐字返回 `{name,type,value}`；class、enum
（`propertytype`）、list、object 与超长字符串条目以显式
`{name,type,valueOmitted:true,reason}` 标记（绝不近似值，enum 附 `propertytype`，
超长附 `valueCodePoints`）；最多投影 128 条并以 `propertiesTruncated` 披露截断，
`propertyCount` 总是给出总数。畸形条目（非对象、重名、未知 type、值与声明类型不符）
与写路径同样 fail closed。仍不返回 raw JSON/vendor/template 数据。存量 text 的未知
nested key、错误类型/enum、超限 Unicode 或冲突 shape marker 都 fail closed。
registry 为 28 core / 29 with rasterizer。

`tiled_get_capabilities.objectShapeCapabilities` 精确为：

```json
{
  "creatable": ["rectangle", "point", "ellipse", "capsule", "polygon", "polyline", "text"],
  "shapeMutation": false,
  "ellipseAndCapsuleDimensions": "optional-nonnegative-default-zero",
  "polygonAndPolylinePoints": {
    "coordinateSpace": "object-local-pixels-relative-to-x-y",
    "polygonMinimum": 3,
    "polylineMinimum": 2,
    "maximum": 256,
    "maximumPerChangeSet": 8192,
    "replacement": "whole-array",
    "budgetScope": "create-and-update-points-per-operation-summed",
    "order": "preserved",
    "polygonClosure": "implicit",
    "polylineClosure": "open"
  },
  "polygonAndPolylineUpdates": "common-fields-and-complete-points-replacement-no-dimensions",
  "textObject": {
    "wireLayout": "flat-on-create-object-and-update-patch",
    "fields": ["text", "fontFamily", "pixelSize", "wrap", "color", "bold", "italic", "underline", "strikeout", "kerning", "horizontalAlignment", "verticalAlignment"],
    "dimensions": "optional-nonnegative-default-zero",
    "content": {
      "field": "text",
      "required": true,
      "emptyAllowed": true,
      "lengthUnit": "unicode-code-points",
      "maximum": 4096,
      "maximumUtf8Bytes": 16384,
      "unicode": "well-formed-no-unpaired-surrogates",
      "allowedControlCodePoints": ["U+0009", "U+000A", "U+000D"]
    },
    "fontFamily": {
      "minimum": 1,
      "maximum": 256,
      "maximumUtf8Bytes": 1024,
      "lengthUnit": "unicode-code-points",
      "default": "sans-serif",
      "unicode": "well-formed-no-unpaired-surrogates",
      "allowedControlCodePoints": []
    },
    "pixelSize": {
      "integer": true,
      "minimum": 1,
      "maximum": 999,
      "default": 16
    },
    "color": {
      "formats": ["#RRGGBB", "#AARRGGBB"],
      "default": "#000000"
    },
    "horizontalAlignment": {
      "values": ["left", "center", "right", "justify"],
      "default": "left"
    },
    "verticalAlignment": {
      "values": ["top", "center", "bottom"],
      "default": "top"
    },
    "booleanDefaults": {
      "wrap": false,
      "bold": false,
      "italic": false,
      "underline": false,
      "strikeout": false,
      "kerning": true
    },
    "payloadBudget": {
      "measure": "canonical-json-utf8-bytes",
      "scope": "all-present-flat-text-fields-per-operation-summed",
      "maximumPerChangeSet": 262144
    },
    "updates": "common-fields-dimensions-and-partial-flat-text-fields",
    "serialization": "nested-tmj-text-with-tiled-default-elision"
  },
  "sourcePatch": "object-layer-objects-member-local"
}
```

`tiled_get_capabilities.objectPropertyUpdateCapabilities` 精确为：

```json
{
  "operation": "updateObject-patch-properties",
  "writeTypes": ["string", "int", "float", "bool", "color", "file"],
  "sharedProfile": "identical-to-tileMetadataUpdateCapabilities-property-semantics",
  "propertyOrdering": "tiled-name-sorted-insert-fail-closed-on-unsorted",
  "complexPropertyTargets": "fail-closed",
  "untouchedComplexProperties": "preserved",
  "propertyTypeMember": "always-written",
  "propertyColorInput": "rrggbb-or-aarrggbb-stored-verbatim",
  "emptiedPropertiesMember": "removed",
  "templateAndTileObjects": "fail-closed",
  "maxSetsPerUpdate": 32,
  "maxRemovesPerUpdate": 32,
  "maxPropertiesPerObject": 128,
  "payloadBudget": {
    "measure": "canonical-json-utf8-bytes",
    "scope": "all-updateObject-property-writes-per-change-set-summed",
    "maximumPerChangeSet": 262144
  }
}
```

pending canonical payload 总量通过
`limits.maxPendingTextObjectPayloadBytes:2097152` 公布。计费按每个 create/update
operation 实际出现的 text-specific 字段分别计算，不因后序覆盖或删除而折叠。

### 3.7 Tileset 管理

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_get_tileset` | **已实现有界基础版。** 以 map + opaque asset id 验证当前引用，返回 atlas 声明、按 local ID 分页的稀疏 tile class（Tiled 1.12 使用 `tiles[].type`）、动画采样、碰撞计数、Wang-set 概览，以及 per-tile 标量自定义属性值（与 `tiled_get_object` 同一投影：标量逐字、class/enum/list/object 与超长条目 `valueOmitted` 标记、每 tile ≤128 条；tileset 级与 wang-set 属性仍只给数量）；不把 `tiles.length` 冒充 `tilecount`，不读取碰撞 geometry/完整 wang assignments；整页受 256 KiB 结果预算约束，超限要求降低分页 | `mapPath`, `tilesetAssetId`, `startTileId?`, `limit?` |
| `tiled_create_tileset` | **已实现（preview→apply）。** 从项目内图集图片规划一个新 external `.tsj`：按 Tiled 1.12.2 网格公式算 columns/rows/tilecount，返回 `tilesetCreate` change set；`expectedRevision` 是**批准内容本身的 SHA-256**（无既有文件），apply 走 no-replace 创建、`beforeRevision:null`。direct 创建特例条款保持仅 `tiled_create_map` | `tilesetPath`, `imagePath`, `tileWidth`, `tileHeight`, `margin?`, `spacing?`, `name?`, `className?` |
| `tiled_add_tileset_to_map` | **已实现/本轮契约。** 只预览把一个外部 tileset 挂到地图的单操作 change set；自动分配 `firstgid`，完全不写盘（asset identity contract v2：读/预览路径无锁且零副作用） | `mapPath`, `tilesetPath`, `expectedMapRevision`, `expectedDependencyRevisions`, `expectedTilesetRevision?` |
| `tiled_remove_tileset_from_map` | 候选独立入口；当前等价能力已通过 `tiled_preview_edits` 的第 14 种、必须独占 change set 的 `removeTilesetFromMap` operation 实现，仅移除全图零引用的 external atlas binding | `mapPath`, `tilesetAssetId` |
| `tiled_update_tile` | **已实现专用 preview 工具**：批量更新单个已引用 external atlas TSJ 的 per-tile probability/class/动画/标量自定义属性/碰撞形状元数据，走独立 `tilesetEdit` change set | `mapPath`, `tilesetAssetId`, `expectedMapRevision`, `expectedTilesetRevision`, `updates: [{tileId, patch}]` |
| `tiled_find_tiles` | **已实现有界基础版。** 以 map + opaque asset id 选择一个当前引用的 external atlas TSJ，只搜索显式稀疏 `tiles[]` metadata；按 class、property 存在性或内建标量 property 值做大小写敏感精确匹配，返回按 local ID 分页的完整 `TileRef` | `mapPath`, `tilesetAssetId`, `query`, `startTileId?`, `limit?`, `expectedMapRevision?`, `expectedTilesetRevision?` |

`tiled_add_tileset_to_map` 是专用 preview 入口，不把 `addTileset` 扩进通用
`tiled_preview_edits.operations` union。每次成功调用只签发一个挂载操作的 change set；
只有客户端批准后调用 `tiled_apply_change_set` 才修改文件。它要求
`expectedMapRevision` 与当前 map raw bytes 一致，并要求
`expectedDependencyRevisions` 精确覆盖 map **已经引用**的依赖。待挂载 TSJ 是
prospective dependency，不得提前混入该记录；调用方可用独立的
`expectedTilesetRevision` pin 它，服务端无论该参数是否提供都会把实际 TSJ revision
固化进 change set，并在 apply 时复核。

自动分配值为所有现有引用可证明的占用区间中
`firstgid + highestPotentialLocalId` 的最大值再加一；没有引用时从 1 开始。任何现有
tileset 范围无法证明、结果溢出合法 GID 空间或目标已被引用时都 fail closed，不猜测、
不压紧已有 gap。preview 把实际 atlas `tileCount` 与保留 local-ID 区间 `gidSpan`
分开回显；`gidRange.last = firstgid + gidSpan - 1`，其中 `gidSpan` 同时考虑
`tilecount`、稀疏 `tiles[].id` 与存在时的 `nexttileid`。为防止新范围让原本无效的
raw GID 获得含义，规划前最多扫描 1,000,000 个现有 tile cell 与 object，任一 GID
当前无法解析或超过扫描预算都会拒绝。提交只对目标 TMJ 的 `tilesets` 子树生成一处
syntax-range patch，并沿用
单文件 revision CAS、原子替换和 checkpoint；不会改写 TSJ 或其他 map。

preview 需要依次读取 map、当前依赖和 prospective TSJ，这个 read set 不是跨文件原子
快照。响应明确声明 `snapshotConsistency: "non-atomic-read-set"`；revision pin、返回前
复核与 apply 时再次复核能检测已观察到的变化，但不能把普通文件系统读取宣称为原子
snapshot。

当前已实现的 per-tile metadata wire contract 是专用 preview 工具
`tiled_update_tile`（首个 TSJ 写入面）。它以
`mapPath + tilesetAssetId` 定位一个当前已引用的 external atlas TSJ，必须同时 pin
`expectedMapRevision` 与 `expectedTilesetRevision`，接受 1..64 个唯一 `tileId` 的
strict `updates`，返回独立的 `tilesetEdit` change set——其 `expectedRevision` 是
**TSJ 的 revision**，apply 也只提交该 TSJ 文件；map 永不被改写，但 pin 了旧 tileset
revision 的待批 map change set 会在 apply 后冲突。字段语义按 Tiled 1.12.2 源码逐条
核实：

- `probability`：设为 `null` 或 Tiled 默认值 `1` 即移除序列化成员；其余取
  0..1e9 的有限数。
- `className`：条目已有 `class` 成员则更新 `class`，否则写 1.12.2 canonical 的
  `type` 成员；`class` 与 `type` 并存的条目 fail closed（读取语义含混）；`null`
  移除该成员，长度限 1..1024 个 Unicode code points。
- `animation`：`{tileId, durationMs}` 帧数组全量替换，序列化为 Tiled 的
  `[{tileid, duration}]`；每 tile 最多 256 帧，帧 id 必须落在 tilecount 内
  （`TILE_ID_OUT_OF_RANGE`），duration 为 1..1e9 的整数；`null` 移除成员。
- `collision`：以 1..128 个有界基础形状（rectangle/point/ellipse/capsule/
  polygon/polyline，均可带 rotation/name/className；polygon ≥3、polyline ≥2、
  每形状 ≤256 点，单 change set 合计 ≤8,192 点）**整体替换** tile 碰撞
  `objectgroup.objects` 数组；`null` 整体移除该成员，等价 Tiled 碰撞编辑器清空。
  语义对齐 1.12.2 collision dock：新对象 id 从既有最大 id 之后连续分配（dock 以
  `highestObjectId()+1` 播种 dummy map），既有容器的其余成员逐字保留，新容器写
  canonical `draworder:"index"` 成员集，对象成员集与 `createObject` 的冻结形态一致
  （`{height,id,name,rotation,type,visible,width,x,y}` + 形状标记）。整体替换会丢弃
  旧对象携带的自定义属性；summary 回显 `previousCollisionShapeCount` 与
  `collisionShapeCount`。
- `properties`：对 tile 自定义属性做有界标量 set/remove（每 tile 最多 32 set +
  32 remove，结果最多 128 条）。可写类型为 string/int/float/bool/color/file——与
  `tiled_find_tiles` 的可比较标量集合完全对称；写入总是带显式 `type` 成员（Tiled
  1.12.2 写入器行为）。新属性按 Tiled 的名字典序插入（现有数组乱序时新增 fail
  closed），既有条目原位更新并保留未知成员，移除缺失名是 no-op。以 `class`、
  enum（任何 `propertytype`）、`list` 或 `object` 属性为目标一律
  `UNSUPPORTED_PROPERTY_WRITE` fail closed；未被触碰的复杂条目语义保留。color 值
  接受 `#RRGGBB`/`#AARRGGBB` 并按原样存储（Tiled 自己保存时会规范化为
  `#aarrggbb`）。
- 条目生命周期与 Tiled 的省略语义一致：无条目的 tile 按升序插入新条目（`tiles[]`
  非升序时插入 fail closed），编辑后仅剩 `{id}` 的条目删除（清空的 `properties`
  成员同样移除），`tiles` 根成员按需
  插入/移除；**创建或删除条目的更新必须独占整个 change set**（source patch 原语不
  允许同一数组的结构性修改与条目内 member patch 混用）。
- source patch 只触及目标 `tiles[]` 条目的相关成员；未触及的条目、未知成员与
  version/tiledversion 戳保持原 bytes——与 Tiled 保存时的整文件重写不同。写入前后
  都经有界 tileset write-profile gate（atlas-only、重复/越界 id、畸形元数据全部
  fail closed）。

当前已实现的 `tiled_create_tileset` wire contract：输入
`{tilesetPath, imagePath, tileWidth, tileHeight, margin?, spacing?, name?,
className?}`（margin/spacing 默认 0，上限 4,096；tile 边长 1..16,384；name 默认
tileset 文件名去掉 `.tsj`，可选 `className` 写 `class` 成员）。preview 读取图片
（复用 tileset 图片的安全解码上限）、按 Tiled 1.12.2 的
`columnCountForWidth`/`rowCountForHeight` 公式（**单边 margin 整除**：
`(imageWidth - margin + spacing) / (tileWidth + spacing)`）计算网格，不足一个
tile 时 fail closed，并在 summary 中报告右/下未用像素余量。生成的 TSJ 成员按
Tiled QJson 的字母序写出，带冻结的 `version:"1.10"` / `tiledversion:"1.12.2"`
戳；`image` 是相对 TSJ 目录的 canonical POSIX 引用。返回的 `tilesetCreate`
change set 以域分隔 digest（`tiledmcp/tileset-create-plan/v1`）签名，pin 图片的
path + raw revision；其 `expectedRevision` 是 **prospective TSJ bytes 的
SHA-256**——不存在既有文件可 pin，批准的就是内容本身。apply 复核计划 digest、
重读图片 revision（变化即 `DEPENDENCY_REVISION_CONFLICT`）、重放构建并要求内容
revision 与 summary stableJson 相等，然后走与 `tiled_create_map` 相同的
hard-link no-replace 创建路径：目标已存在（含字节相同）一律
`FILE_ALREADY_EXISTS`，成功结果 `beforeRevision:null`、`changed:true` 并附
checkpoint（`before.existed:false`，不可作为删除恢复）。新文件不被任何 map 引用；
随后用 `tiled_add_tileset_to_map` 挂载。direct additive no-preview 特例条款保持
不变：仍仅 `tiled_create_map`。`tiled_get_capabilities.tilesetCreationCapabilities`
公布全部策略串与数值界。

当前已实现的 tileset-reference removal wire contract 是
`{type:"removeTilesetFromMap", tilesetAssetId}`。它属于
`tiled_preview_edits.operations` 封闭 union 的第 14 种 operation，不额外注册
`tiled_remove_tileset_from_map`，因此 registry 保持 28 core / 29 with rasterizer。
operation 是 exact-key strict object，`tilesetAssetId` 必须是非空 opaque ID，并精确
定位当前 map 已引用、已通过 M1 external root-atlas profile 校验的 binding。路径、名称、
embedded tileset、未引用 asset ID 和额外 key 都不能作为 fallback。

该 operation 必须且只能独占一个 change set，不能与 tile/object/layer/map update 或另一个
removal 混批。planner 递归访问完整 layer tree：所有 finite tile-layer cells 和所有
object-layer objects 都计入扫描，visibility、`locked` 与 Group 嵌套不构成过滤条件；
带 `gid` 的 tile object 与非零 tile cell 都按完整 unsigned encoded GID（含 transform/raw
flags）解析到当前 binding。tile cells 与 objects 合计最多扫描 1,000,000 项，超限在签发
proposal 前以 `RESULT_LIMIT_EXCEEDED` 拒绝。目标 binding 只要被任一 cell 或 tile object
引用，就返回稳定错误 `TILESET_IN_USE`；当前能力不会清空 cell、删除 object、重映射
local ID 或留下无法解析的 GID。任一 object 带 `template` member 时返回
`UNSUPPORTED_TILESET_REMOVAL_TEMPLATE`；在模板依赖尚未独立固定 revision 并解析前，不能
把“实例未内联 gid”当作未使用证明。

成功 plan 的 `summary.removedTilesets[]` 使用扁平字段 `operationIndex`、`assetId`、
`tilesetPath`、`source`、`tilesetRevision`、`name`、`nameTruncated`、原
`tilesets` array `index`、`tileCount`、`gidSpan`、`firstGid`、`lastGid`、
`scannedCellCount` 与 `scannedObjectCount`。bounded operation preview 不含
`operationIndex`，而是按 operations 数组位置关联；其完整 shape 是顶层
`type` / `destructive` / `warning` / `source` / `index`，以及
`tileset:{kind,assetId,path,revision,name,nameTruncated?,tileCount,gidSpan}`、
`gidRange:{first,last}`、`scanned:{tileCells,objects}`。`tileset.nameTruncated` 只在
true 时出现，且 `destructive` 固定为 true。这些字段、map revision 和**移除前的完整**
`dependencyRevisions` 都参与 plan digest，不能把目标 TSJ 提前从 expected dependency
set 省略。

apply 在锁内从 pinned source 重新加载 map 与完整旧 dependency set，重算 binding 选择、
全图 GID 解析、零引用结论、扫描预算和摘要，并复核 change-set digest/revision pins 后才
提交。source writer 只从 TMJ 根 `tilesets` array 删除原 index 的一个 element；其他
binding 的 `firstgid`、数组元素及所有 layer/source bytes 保持不变。该 operation 只解除
map 引用，不删除或改写 TSJ、atlas 图片及其他文件。

`tiled_get_tileset` 的 revision 元数据只描述本次选择的外部 TSJ：
`source = { assetId, revision }`。它不返回或承诺地图的完整
`dependencyRevisions`；需要为后续 mutation 收集完整依赖前提时，客户端必须调用 map
summary/region。Tiled 1.12 的 tile class 从 `tiles[].type` 读取；`tiles[].class` 只作为
Tiled 1.9 资产的兼容输入。外部 TSJ 的 `name` 是必需字符串，名称、class 名和 Wang 名等
显示字段按 `tiled_get_capabilities` 公布的 Unicode code-point 上限截断，不按 UTF-16
code unit 截断。

详情投影对已知 rendering 枚举严格校验：`objectalignment` 只接受 `unspecified`、
`topleft`、`top`、`topright`、`left`、`center`、`right`、`bottomleft`、`bottom`、
`bottomright`；`tilerendersize` 只接受 `tile | grid`；`fillmode` 只接受
`stretch | preserve-aspect-fit`；`grid.orientation` 只接受
`orthogonal | isometric`。未知扩展字段仍由 raw document 保留，但不能作为已知 rendering
语义原样回显。

`tiled_find_tiles.query = { mode?, clauses }`，其中 `mode` 为 `all | any`，wire
调用省略时默认为 `all`，clauses 最多 8 项。class clause 使用 Tiled 1.12 的
`tiles[].type`，仅在该字段缺失时读取
Tiled 1.9 兼容字段 `tiles[].class`。`propertyExists` 只判断同名显式 property 条目是否
存在；`propertyEquals` 仅比较未使用 `propertytype` 的内建标量
`string | int | float | bool | color | file`，并要求 property 的声明类型和值都精确相等。
同名目标若是 custom、object、class 或 list property，会返回
`UNSUPPORTED_PROPERTY_QUERY`，即使 `any` 的其他 clause 已命中也不降级为普通未命中。
所有名称和值比较均大小写敏感，不做模糊、正则、locale case-fold 或类型强制转换。

候选集合只是 TSJ 中显式存在的稀疏 `tiles[]`，没有 metadata 的 local ID 不会因默认值、
tileset class 或 Project 类型定义而产生匹配。带 per-tile image 或 image subrect
override 的定义不属于 M1 root-atlas profile，会返回 `UNSUPPORTED_TILESET`。结果给出完整 external `TileRef`、
`matchedClauseIndexes` 和可选 class 显示值，但不返回 property value；当前也不解析继承
property、Wang assignment 或持久化语义 name。分页按 local ID 排序，默认 64 项、最多
128 项；有下一页时 `nextPage` 返回
`{ startTileId, expectedMapRevision, expectedTilesetRevision }`。revision 输入对独立
查询是可选的；客户端续页应原样携带 `nextPage` 的两个 revision pin，此时 map 或所选
TSJ 变化会分别返回 revision conflict。服务端会先比较同一 raw-byte snapshot 的 revision
再解析 JSON，所以 stale 内容即使已经损坏或变成不支持 profile，也不会覆盖 conflict。
服务端还会在返回前复核 read set，但响应继续声明
`snapshotConsistency: "non-atomic-read-set"`，不承诺跨文件原子快照。单次结果上限为
256 KiB。

### 3.8 Wang 地形（后续差异化重点）

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_get_wangsets` | 列出 tileset 内的 wang set（类型、颜色、已分配 tile 数） | `tilesetPath` |
| `tiled_create_wangset` | 创建 wang set 与 wang color | `tilesetPath`, `name`, `type`(corner/edge/mixed), `colors: [{name, color, probability?}]` |
| `tiled_assign_wangtiles` | 批量给 tile 分配 wangid（8 元素数组，顺时针 top 起） | `tilesetPath`, `wangsetName`, `assignments: [{tileId, wangId}]` |
| `tiled_paint_terrain` | **地形笔刷**：优先通过 one-shot Tiled adapter 调用官方 `TileLayer.wangEdit()` 完成匹配和邻格修补；可选自研后端用于无 Tiled 或固定 seed 场景，二者必须在结果中标明 backend | `mapPath`, `layerId`, `wangset`, `color`, `region\|path`, `seed?`, `backend?` |

地形笔刷的产品价值是把 Tiled Terrain Brush 暴露为安全、可预览的高层操作；自研 Wang 匹配器不是 M1 的前置条件。

### 3.9 属性系统

已实现子集：per-tile 标量属性经 `tiled_update_tile` 的 `patch.properties`，
map object 标量属性经 `updateObject.patch.properties`（见 3.6/3.7），二者共享
同一 fail-closed 写入 profile。下表为尚未实现的通用属性系统候选：

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_get_properties` | 读取任意实体的自定义属性 | `target`（统一定位符，见下） |
| `tiled_set_properties` | 设置/删除自定义属性；覆盖 Tiled 1.12 的全部 9 种属性类型，包含 `list`，并支持 class/list 递归嵌套 | `target`, `set?`, `remove?` |
| `tiled_list_property_types` | 只读列出项目级自定义 class/enum 定义 | `kind?`, `cursor?` |
| `tiled_upsert_property_type` | 新增或更新一项 property type，返回 change set | `definition` |
| `tiled_delete_property_type` | 删除一项 property type（**destructive**），返回 change set | `propertyTypeId` |

所有属性工具使用第 1 节的 `Target` discriminated union，禁止依赖可重名的字符串名称定位实体。

### 3.10 校验与分析

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_validate` | **项目资产只读格式校验**：GID 越界、tileset/图片路径失效、id 一致性、重复对象 id、chunk 完整性；成功结果为 `{path, revision, valid, diagnostics: Diagnostic[]}`；不修改项目资产，但可能更新项目内部 safety metadata | `path` |
| `tiled_preview_validation_fixes` | 把明确选择的 `fixId` 计算为待批准 change set；不与只读 validate 共用工具名 | `path`, `expectedRevision`, `fixIds` |
| `tiled_check_connectivity` | **游戏性校验**（后续候选）：基于碰撞图层或属性规则分析可达性、封闭区域和对象穿墙 | `mapPath`, `collisionLayerId\|collisionRule`, `from?`, `to?` |
| `tiled_register_tile_names` | 语义 tile 注册表：把 `grass`、`water_corner_tl` 等名字映射到具体 tile，之后所有工具的 `tile` 参数可直接用名字（借鉴 hoberobin 思路；配合 `auto-name-tiles` Prompt 可由模型看图自动完成） | `tilesetPath`, `names: {name: tileId}` |
| `tiled_analyze_usage` | **已实现/只读。** 递归统计整张地图的 tile cell/tile object 使用、raw flags、图层密度、tileset/未使用 local ID 与 top tiles，返回有界摘要 | `mapPath`, `topTileLimit?`, `expectedMapRevision?`, `expectedDependencyRevisions?` |

`tiled_analyze_usage` 只接受当前有限正交 TMJ + external root-atlas TSJ profile。扫描范围
固定为整张 map 的完整递归 layer tree：每个 finite numeric-array tile layer 的全部
cell，以及每个 object layer 中带 `gid` 的 tile object；Group/layer 的 visibility 不
参与筛选，隐藏内容仍计入。所有 object（包括非 tile object）都会计入扫描工作量，只有带
合法非零 GID 的对象才计入 tile 引用。

tile 身份按 external tileset `assetId + localId` 的 base tile 聚合，因此同一 tile 的
identity/H/V/D 等变换不会被误算成多个 distinct tile；响应同时给出 identity/transformed
总数、每种完整 unsigned `rawFlags` 的引用数，以及 top tile 中的 transformed 引用数。
输出包括总量、按 density 升序且以 layer ID 打破平局的 layer 摘要、unused-first 且以
`firstgid` 排序的 tileset 摘要（含未使用 local ID 总数与有界样本），以及按总引用降序、
再按 tileset binding/local ID 排序的 top tiles。上述都是显式带截断信息的摘要，不能将
样本解释为完整集合。

单次分析最多扫描 1,000,000 个 tile cell + object、聚合 100,000 个 distinct base tile；
layer density 和 tileset 摘要各最多 64 项，每个 tileset 的未使用 local ID 样本最多
16 项。`topTileLimit` 默认 64、合法范围 `1..128`；完整序列化结果最多 256 KiB。
`expectedMapRevision` 与 `expectedDependencyRevisions` 要么同时省略，要么同时提供；
后者必须精确覆盖 pinned map 的完整 external TSJ dependency set。服务端在投影完成后
再次检查 map 与全部依赖没有变化，但多文件 read set 仍标记
`snapshotConsistency:"non-atomic-read-set"`。

### 3.11 视觉能力 ★ 差异化重点

多模态模型能直接看图，这组工具构成“渲染→观察→修正”的视觉闭环。所有渲染工具返回 MCP `image` content（PNG）以及可机器读取的 `structuredContent` 元数据。

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_render_preview` | **已实现 native v1 + object debug v4**。渲染有限正交地图的静态 external-atlas tile layer，可指定矩形 region/图层并叠加网格、绝对坐标、最多 64 个固定样式的绝对 tile 矩形高亮，以及 1–64 个显式对象（basic geometry、ellipse/Tiled 1.12 capsule、text box 与 tile object 的 Tiled 对齐 frame 轮廓）的固定调试轮廓；不支持的视觉语义 fail closed。完整 object-layer 与碰撞渲染仍是后续候选 | `mapPath`, `region?`, `layerIds?`, `scale?`, `overlays?` |
| `tiled_render_tileset_sheet` | **已实现基础版**。按地图摘要给出的 opaque asset id 渲染连续 local id 的分页 atlas sheet；安全预算不足时自动减小每页容量，不静默缩放 tile。语义名仍是后续能力 | `mapPath`, `tilesetAssetId`, `page?`, `pageSize?`, `columns?`, `scale?` |
| `tiled_render_tiles` | **已实现 static root-atlas v1**。按输入顺序放大并标注 1–64 个唯一、显式且可稀疏的 local IDs；不分页、不缩减选集，预算不足时整次失败。动画胶片条、Wang 分组和语义名不在 v1 内 | `mapPath`, `tilesetAssetId`, `localIds`, `columns?`, `scale?`, `expectedMapRevision?`, `expectedTilesetRevision?` |
| `tiled_render_diff` | 后续候选。按显式 changeSetId、revision 或比较资产渲染差异，不读取“上一步操作” | `mapPath`, `changeSetId?\|compareWithRevision?\|compareWith?`, `region?` |
| `tiled_import_from_image` | 远期候选。把网格对齐参考图按 tile 匹配到目标图层，未匹配格子返回坐标与裁剪图 | `imagePath`, `mapPath`, `layerId`, `tileset`, `threshold?` |

#### 3.11.1 图片 wire contract 与限制

四种图片工具的成功 `structuredContent.result` 都使用各自的 exact closed schema，并共享
`mimeType`、`pixelSize`、`byteLength`、`sha256`、`map` 与 `truncated` 核心。下列
代码块仅是三种内建工具字段的合并说明，不是可接受任意字段组合的共享 schema。sheet 与
显式 tile 选集使用单数 `source`/`image`，native 地图预览使用实际影响本次像素的 `sources[]`：

```ts
{
  mimeType: "image/png";
  pixelSize: { width: number; height: number };
  byteLength: number;
  sha256: string;
  map: { path: ProjectPath; revision: Revision };
  source?: { assetId: AssetId; revision: Revision }; // sheet/selection TSJ
  image?: {
    path: ProjectPath;
    revision: Revision;
    format: string;
    pixelSize: { width: number; height: number };
  };
  sources?: Array<{ // native map preview，仅实际解码的 atlas
    assetId: AssetId;
    tileset: { path: ProjectPath; revision: Revision };
    image: {
      path: ProjectPath;
      revision: Revision;
      format: string;
      pixelSize: { width: number; height: number };
    };
  }>;
  tileRegion?: { x: number; y: number; width: number; height: number };
  coordinateTransform?: {
    tileOrigin: { x: number; y: number };
    pixelOrigin: { x: number; y: number };
    pixelsPerTile: { x: number; y: number };
  };
  overlays?: {
    grid: boolean;
    coordinates: boolean;
    highlights: {
      style: "selection-amber-v1";
      entries: Array<{
        sourceIndex: number;
        requestedTileRect: { x: number; y: number; width: number; height: number };
        renderedTileRect: { x: number; y: number; width: number; height: number };
        clipped: boolean;
      }>; // <= 64，和输入顺序一一对应
      highlightedTileCount: number; // tile union 后的精确格数，<= tileRegion cells
      color: { r: 250; g: 204; b: 21; a: 96 };
      blendMode: "source-over";
      overlapMode: "tile-union";
    };
    objectDebug: {
      profile: "explicit-basic-object-geometry-v4";
      style: "geometry-cyan-v1";
      color: { r: 34; g: 211; b: 238; a: 255 };
      strokeWidth: 1;
      originMarker: "crosshair-5px";
      idLabels: false;
      visibilityPolicy: "explicit-ignore-object-and-layer-visibility-opacity";
      drawOrder: "after-highlights-and-grid-before-coordinates";
      quantization: "round-nearest-output-pixel";
      curveTessellation: {
        algorithm: "uniform-angle-output-sagitta-v1";
        maximumChordErrorPixels: 0.25;
        minimumSegments: 12;
        maximumSegmentsPerObject: 4096;
        maximumAggregateSegments: 65536;
        segmentMultiple: 4;
        errorSpace: "continuous-output-before-quantization";
        overflowPolicy: "reject-whole-preview";
        offscreenPolicy: "conservative-rotated-bounds-skip-before-tessellation";
        capsuleConstruction: "two-semicircles-plus-two-straight-segments";
        degenerateExtent:
          "tiled-1.12-single-zero-line-double-zero-anchor-centered-20-map-pixel-circle";
      };
      tileObjectFrames: {
        source: "tiled-1.12-object-outline-rect";
        alignmentResolution: "tileset-objectalignment-unspecified-bottom-left";
        tileOffsetScaling: "scaled-by-object-over-tile-size";
        missingDimensionDefault: "tileset-tile-size";
        flipFlags: "image-only-outline-unchanged";
        rotationCenter: "object-anchor";
        danglingGidPolicy: "fail-closed";
        imageRendering: false;
        collisionShapes: "explicit-opt-in";
      };
      tileObjectCollision: {
        source: "tiled-1.12-show-tile-collision-shapes";
        selection: "explicit-tile-object-selection-opt-in";
        transform: "tile-image-fragment-affine-with-inner-shape-rotation";
        flipFlags: "applied-like-tile-image";
        groupMetadata: "position-draworder-color-visibility-ignored";
        hiddenCollisionObjects: "drawn";
        markerPrecedence: "single-shape-marker-only-fail-closed-on-conflict";
        pointObjects: "fixed-5px-output-crosshair";
        curveSegmentPlanning: "affine-spectral-norm-output-radius";
        offscreenPolicy: "clip-after-tessellation";
        nestedTileOrTemplateObjects: "fail-closed";
        fillMode: "stretch-only-fail-closed";
        styling: "shared-geometry-cyan-outline-no-fill";
      };
      selectedObjectCount: number;
      renderedObjectCount: number;
      entries: Array<{
        sourceIndex: number;
        objectId: number;
        layerId: number;
        shape:
          | "rectangle"
          | "point"
          | "ellipse"
          | "capsule"
          | "polygon"
          | "polyline"
          | "text"
          | "tile";
        representation:
          | "geometry-outline"
          | "text-box-only"
          | "tile-frame-only"
          | "tile-frame-and-collision";
        rendered: boolean;
        clipped: boolean;
        collisionObjectCount?: number; // 仅 tile-frame-and-collision，0..128
      }>; // <= 64，和显式 objectIds 输入顺序一一对应
    };
  };
  layerIds?: number[];
  page?: {
    index: number;
    count: number;
    requestedSize: number;
    size: number;
    adjusted: boolean;
    tileCount: number;
    localIdRange: { first: number; last: number };
    columns: number;
    rows: number;
  };
  renderProfile?: "explicit-local-id-atlas-selection-v1";
  selection?: {
    localIds: number[];
    count: number;
    order: "input";
    labels: "local-id";
    layout: {
      kind: "row-major";
      requestedColumns: number;
      columns: number;
      rows: number;
      adjusted: boolean;
    };
  };
  snapshotConsistency?: "non-atomic-read-set";
  truncated: boolean;
  resourceUri?: string;
}
```

四种图片工具（三种内建工具与可选 `tiled_render_map`）的
`tiled-mcp-summary` v1 text block 还包含
`image:{mimeType:"image/png",bytes}`；`bytes` 来自实际 inline PNG buffer，而不是
base64 字符数。完整图片元数据仍以各工具自己的 `structuredContent.result` 为准。

可选 `tmxrasterizer` 工具 `tiled_render_map` 使用独立的 exact closed result：

```ts
{
  mimeType: "image/png";
  pixelSize: { width: number; height: number };
  byteLength: number;
  sha256: Revision;
  map: { path: ProjectPath; revision: Revision };
  dependencyRevisions: Record<AssetId, Revision>; // 仅 map 引用的 external TSJ
  renderer: {
    kind: "tmxrasterizer";
    version: string; // 启动时 capability probe 的非空版本
    profile: "tmxrasterizer-png-v1";
  };
  options: {
    size: number;             // 实际生效值，省略输入时为 1400
    ignoreVisibility: boolean; // 实际生效值，省略输入时为 false
  };
  snapshotConsistency: "non-atomic-read-set";
  truncated: false;
}
```

这是 pre-Frozen clean break，不保留 `mapPath`、`bytes`、`width` 或 `height` aliases。
adapter 通过同一个有界 PNG buffer 校验 IHDR 和 adapter metadata；`pixelSize` 来自该
buffer，`byteLength` 是其 base64 编码之前的原始 byte count，`sha256` 对同一 buffer
计算，MCP `image` content 也由它编码。`renderer.version` 来自启动时使该工具可注册的版本
探测，`options` 返回默认值展开后的实际调用参数。

渲染前后服务端分别复核 map 与全部 external TSJ revisions；`map` 和
`dependencyRevisions` 报告这个 pre/post 相等的 read set，后者仍只含 TSJ。root atlas、
per-tile image 与 image-layer 引用按规范化项目路径统一去重，最多允许 64 张；原始 bytes
合计最多 64 MiB、解码像素合计最多 16,000,000，任一图片单边最多 8192 px。服务端在渲染
前后分别读取每个图片的一致单文件 snapshot，并比较内部的完整路径/revision 集合；集合或
任一 revision 变化都拒绝结果。这些内部图片 revisions 有意不出现在公开 result 中，也不
进入 TSJ-only 的 `dependencyRevisions`。

`tmxrasterizer` 仍直接读取 live files，且相同的 pre/post revision 不能排除中途修改后又
恢复的 ABA；这些逐文件读取也不构成原子 read set。因此结果固定为
`snapshotConsistency: "non-atomic-read-set"`，客户端不得把这些字段解释成 map、TSJ 与
图片来自一个原子快照。成功结果固定 `truncated: false`。上述能力由
`rasterMapCapabilities.inputImageRevisionCoverage` 的
`"validated-before-and-after-not-reported"` 公布，四项输入预算由
`limits.maxRasterInputImages`、`maxRasterInputAggregateBytes`、
`maxRasterInputAggregatePixels` 与 `maxRasterInputEdge` 公布。

- 当前 tileset sheet 的输入上限为 `64 MiB`、`4096²` 解码像素和 `8192` 单边；输出上限为
  `2048` 单边、`1,500,000` 像素和编码后 `8 MiB`。每页请求最多 256 个 tile，
  `scale` 为 1–4；简单 SVG 另有 `256 KiB` 源码上限。精确限制由
  `tiled_get_capabilities` 公布并由测试覆盖。
- tileset sheet 必须分页，并在元数据中返回页码、总页数、本页 tile id 范围和实际
  page capacity。`page.index` 与输入 `page` 均从 0 开始；像素预算不足时允许减小
  capacity，并以 `adjusted: true` 明示，不得静默减小 `scale`。输入 `columns` 是
  每页的最大列数；最后一页或 tile 数较少时，结果中的实际 `page.columns` 可以更小。
- `tiled_render_tiles` 的 `localIds` 必须有 1–64 个唯一非负整数，成功结果严格保留
  输入顺序并以 local ID 标注 row-major static raw atlas cells。`columns` 是每行最大
  项数，`scale` 为 1–4；map 与所选 TSJ revision pin 可独立提供。该工具没有
  page/pageSize，不排序、去重、降 scale 或缩减选集；完整布局超过 2048 单边、150 万
  像素或编码后 8 MiB 时整体失败。v1 不展开 tile animation，不按 Wang/semantic name
  选择，并拒绝 per-tile image/subrect override。成功输出包含
  `renderProfile:"explicit-local-id-atlas-selection-v1"`、精确 map/TSJ/image revisions
  和 `snapshotConsistency:"non-atomic-read-set"`。
- 当前实现尚无 render Resource/TTL 存储。tileset sheet 或显式 tile 选集编码后超过 8 MiB 时 fail closed，
  不返回被冒充为完整结果的缩略图；成功结果固定 `truncated: false`。未来实现
  `tiled://renders/...` 后，才可返回标有 `truncated: true` 的缩略 `image`、诊断和
  `resource_link`。图片二进制始终不重复塞入 `structuredContent`。
- 地图预览必须返回 tile 区域和 tile→pixel 变换，确保模型看到的坐标能无歧义地用于后续编辑。
- native preview 的 `region` 使用 map 绝对 tile 坐标；省略时尝试整图，超出预算返回
  `PREVIEW_REGION_REQUIRED`，不自动裁剪或降 scale。`layerIds` 省略时按文档顺序渲染
  有效可见 tile layer，并把可见但未支持的 object/image layer 放入 `omittedLayers`、
  标记 `partial: true`；显式 ID 只接受 tile layer，隐藏状态不阻止显式渲染。
- `overlays.highlights` 若出现则必须包含 1–64 个 strict
  `{x,y,width,height}` 矩形，使用绝对 map tile 坐标；`x/y` 非负、`width/height`
  为正，四项与右/下边界都必须是安全整数。每一项必须和最终生效的 `tileRegion`
  非空相交，否则整个调用以 `INVALID_ARGUMENT` 失败且不返回图片；允许部分越过
  `tileRegion`，但只绘制交集，并在公开 metadata 中同时保留 requested 与 rendered
  矩形及 `clipped` 标记。高亮位于 tile layer 之后、grid 和 coordinate gutter
  之前；固定 `selection-amber-v1` 为 RGBA `(250,204,21,96)`、`source-over`、
  fill-only/no-border。重叠或重复矩形按 tile union 每格只混合一次，因此输入顺序不影响
  PNG；公开 entries 仍按输入保序，`highlightedTileCount` 是 union 后的精确格数。
  即使未请求高亮，结果也固定返回相同对象、空 entries 和 0 count。
- `overlays.objectIds` 若出现则必须包含 1–64 个唯一 positive safe object ID；不排序、
  去重、缩减或根据 `layerIds` 推导。服务端在读取 atlas image 前解析完整选择；任一 ID
  不存在、对象畸形或使用未支持 profile 时整次失败。显式对象选择忽略 object、object
  layer 与 ancestor Group 的 visibility/opacity，但该 policy 会固定回显；所选
  object layer/ancestor 的 `x/y` 必须为 0、`offsetx/y` 必须为 0、`parallaxx/y`
  必须为 1，否则 fail closed，不能把未知定位语义近似为 map origin。
- object debug v4 的 profile 固定为
  `explicit-basic-object-geometry-v4`：rectangle 画闭合矩形，point 画原点十字，
  polygon 闭合、polyline 保持开放，text 只画旋转后的 layout box 且
  `representation:"text-box-only"`，不画 glyph、不宣称 font/wrap/alignment 保真。
  ellipse 使用对象 bounds；Tiled 1.12 capsule 使用
  `min(width,height)/2` 的圆角半径，由两个半圆和两条直边组成，正方形 capsule 与同
  bounds ellipse 等价。任一单独为零的尺寸按 bounds line 处理；双零尺寸按以 object
  anchor 为圆心的 20 map-pixel 圆处理。template 仍缺继承解析，明确拒绝，不降级成
  矩形。
- tile object 以 `representation:"tile-frame-only"` 绘制 Tiled 1.12.2 的 object
  outline 矩形加锚点十字，不渲染 tile 图像。frame 几何按官方源码
  逐条对齐：alignment 取 tileset `objectalignment`，缺省/`unspecified` 在正交地图上
  解析为 bottom-left；frame 左上角为
  `anchor − alignmentOffset(size) + tileoffset × (objectSize / tilesetTileSize)`；
  缺省或为 0 的 width/height 默认为 tileset tile 尺寸；旋转绕对象锚点。H/V/D 与保留的
  raw `0x10000000` flag 位只翻转图像不改变 outline——与 Tiled 自己的
  ShowTileObjectOutlines 完全一致，因此 frame 不随 flip 变化并按此写入契约。
  dangling/越界 GID、空 GID、`gid` 与 shape marker 并存、非法 `objectalignment` 枚举
  或畸形 `tileoffset` 一律 fail closed，不画 Tiled 的红叉占位符。frame 解析读取所选
  tileset 的 TSJ 并对 pinned dependency revision 做 CAS，漂移时以
  `DEPENDENCY_REVISION_CONFLICT` 拒绝。
- ellipse/capsule 使用 `uniform-angle-output-sagitta-v1`：在量化前的连续 output space
  以最大 0.25px chord error 计算均匀角度段数，至少 12 段并向上取四的倍数；每对象最多
  4096 个曲线段，全选集合计最多 65536 个。capsule 的两条直边不计入曲线段预算，但仍
  计入 pixel work。完全位于 content 外的 conservative rotated bounds 会在细分前跳过；
  其他对象超过任一曲线预算时以 `RESULT_LIMIT_EXCEEDED` 拒绝整次预览，不降低精度、
  不部分返回。
- 对象 `x/y` 与 path points 使用 map pixel 坐标，points 相对 `(x,y)`；先按 Tiled
  正角顺时针围绕 `(x,y)` 旋转，再通过
  `contentPixelOrigin + (mapPixel - tileRegionOrigin * mapTileSize) * scale`
  映射，并以 nearest output pixel 量化。线段先裁到 `contentPixelRect` 再 raster，
  防止巨大离屏坐标制造无界循环；完全离区的对象仍保留 entry，并明确返回
  `rendered:false, clipped:true`。这里的 representation 同时包含 shape/text-box stroke
  与 5px origin marker：至少一个二者的像素写入 content 才令 `rendered:true`；任一
  segment 被部分/完全裁掉，或 marker 任一臂越过 content，都会令 `clipped:true`。
  因此主体离区但 anchor marker 入区时可为 `rendered:true, clipped:true`，geometry
  完整但 marker 触边时也会报告 clipped。固定不透明 cyan 单像素 stroke 与 5px origin
  crosshair 在 highlight 和 grid 之后、coordinate labels 之前绘制；不显示 ID label，
  同色覆盖使对象输入顺序不会改变重叠像素颜色。
- object debug 结果无论是否请求都固定返回 closed envelope：固定 profile/style/color/
  stroke/originMarker/visibilityPolicy/drawOrder/quantization/curveTessellation、保序 entries、
  `selectedObjectCount` 与 `renderedObjectCount`。每项回显 sourceIndex/objectId/layerId/
  shape/representation/rendered/clipped，不返回未绑定 revision 的对象 payload。
  所选 polygon/polyline 合计最多 8192 points；裁剪后的实际 object pixel writes 与
  tile/highlight 一起计入 30,000,000 work budget。
- object debug v2 是 pre-Frozen wire clean break：profile 从 v1 升为 v2，entry 的 closed
  shape union 从五类增加 ellipse/capsule，并且 native preview 成功 output 现在总是要求
  closed `curveTessellation`（未请求 objectIds 时也存在）。capabilities 同步增加相同
  policy，`supportedShapes` 增加 ellipse/capsule，limitations 将
  `ellipse-capsule-and-tile-objects-unsupported` 替换为 `tile-objects-unsupported`，
  limits 增加两个 required curve-segment key。缓存旧 discovery/exact output schema 的
  客户端升级后必须重新执行 discovery/刷新 schema；selection/style/representation
  语义不变。
- object debug v3 是同类 pre-Frozen clean break：profile 升为 v3，entry shape union
  增加 `tile`、representation union 增加 `tile-frame-only`，成功 output 与
  capabilities 都固定新增 closed `tileObjectFrames` 契约块，limitations 将
  `tile-objects-unsupported` 替换为
  `tile-frame-only-no-image-or-collision-rendering`。其余
  selection/style/budget 语义不变；旧客户端同样必须刷新 discovery。
- object debug v4 继续该 clean-break 链：新增 opt-in `overlays.tileObjectCollision`
  布尔输入（必须与 `objectIds` 同用），开启时所选 tile object 的 entry 变为
  `representation:"tile-frame-and-collision"` 并回显精确 `collisionObjectCount`
  （含 0）；成功 output 与 capabilities 固定新增 closed `tileObjectCollision` 契约
  块，`tileObjectFrames.collisionShapes` 从 `false` 变为 `"explicit-opt-in"`，
  limits 新增 per-tile 128/全选集 1024 的 collision shape 上限。
- tile collision shape 按 Tiled 1.12.2 "Show Tile Collision Shapes" 的
  fragment 变换逐条对齐：碰撞形状与 tile 图像共用同一仿射——对象/tile 尺寸缩放、
  H/V/D flip、90° 旋转与缩放后的 tileoffset 全部同样作用；碰撞对象自身的
  `(x,y)`+rotation 先在 tile 空间内绕自身锚点应用。rect/ellipse/capsule/
  polygon/polyline 用共享 cyan 轮廓绘制；point 碰撞对象画本项目固定 5px 十字，
  不复刻 Tiled 的 pin 图形；双零 rect/ellipse 分别退化为以位置为中心的 20×20 框
  与 20px 圆，双零 capsule 不绘制。`visible:false` 的碰撞对象照画、collision
  group 的 x/y/draworder/color 忽略——均与 Tiled 渲染一致。碰撞 ellipse/capsule
  以仿射谱范数换算 output 半径后按同一 0.25px chord error 细分，计入共享的
  4096/65536 曲线段与 8192 点预算。碰撞对象含 `gid`/`template`、marker 冲突、
  未知成员、负尺寸或 tileset 非默认 `fillmode` 一律 fail closed。
- native v1 支持静态 external atlas、透明色、layer opacity、orthogonal H/V/D 与 bit 29
  忽略；D 总是先于 H/V，非方形 tile 的 D 暂时 fail closed。atlas tile 尺寸必须与 map
  grid 相同。blend/tint、parallax、非零 pixel offset、非默认 group opacity、动画、
  per-tile image subrect、tileoffset、`tilerendersize:grid`、image collection 和
  非有限/非正交地图不做近似。
- native preview 上限为 region 20,000 cells、128 个 tile layer、64 个 highlight
  rectangle、64 个 object debug selection、8192 个选中 path points、每对象 4096/
  全选集 65536 个 curve segments、250,000 次潜在 tile draw、30,000,000 次 pixel blend、
  64 个实际 atlas；`omittedLayers` 最多内联 128 项，
  超出时返回总数和 `omittedLayersTruncated`。atlas 源文件累计 64 MiB、声明解码像素累计 16,000,000。
  输出为 scale 1–4、2048 单边、1,500,000 像素、编码后 8 MiB。精确值由
  `tiled_get_capabilities` 返回。union 后的高亮 fill 与裁剪后的 object stroke 写入都
  计入同一个 pixel-blend 上限，不能通过大量重叠矩形或离屏几何绕过预算。
- map 与 TSJ 会在响应前复核 revision；每个 image revision 精确绑定本次读取并渲染的
  bytes，但多图片读取集合不是跨文件原子快照。结果以
  `snapshotConsistency: "non-atomic-read-set"` 明示这一点。

### 3.12 转换、导出与世界（后续）

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_convert` | 通过 one-shot Tiled adapter（`tiled --evaluate`/CLI）转换 TMX↔TMJ、TSX↔TSJ；独立 TMX writer 延后 | `sourcePath`, `targetPath` |
| `tiled_export` | 使用 Tiled CLI 导出运行时报告的 `--export-formats`；不硬编码引擎格式。数据/引擎格式走 `--export-map`，PNG 地图渲染单独走 `tmxrasterizer` | `sourcePath`, `targetPath`, `format?` |
| `tiled_rasterize` | 使用 `tmxrasterizer` 把地图渲染为 PNG，与 `tiled_export` 分开声明和标注 | `sourcePath`, `targetPath`, `options?` |
| `tiled_run_automapping` | 通过 one-shot `tiled --evaluate` 调用官方 `TileMap.autoMap()`，不要求常驻 GUI 或 xvfb | `mapPath`, `rulesPath` |
| `tiled_list_world_maps` | 只读列出 world 条目 | `worldPath`, `cursor?` |
| `tiled_add_world_map` | 添加 world 条目，返回 change set | `worldPath`, `entry` |
| `tiled_move_world_map` | 移动 world 条目，返回 change set | `worldPath`, `entryId`, `position` |
| `tiled_remove_world_map` | 删除 world 条目（**destructive**），返回 change set | `worldPath`, `entryId` |

---

## 4. Resources

Resources 是可发现的只读上下文。固定 URI 使用 direct resource；按资产展开的 URI 使用
Resource Template。任何 URI 都不得直接嵌入未转义文件路径；未来 asset templates 必须从
项目索引或已经返回 asset identity 的 map/tileset 工具结果取得不透明 `assetId`。
当前 `tiled_list_files` 仍只返回 `{path,kind}`，不能从它推导 ID。

当前仅注册下表中的 `tiled://guide` 与 `tiled://application-errors`；其他 direct
resources 与全部 templates 仍是 roadmap，不得从本表推断为可读。运行时以
`resources/list` 和 `resources/templates/list` 为准。

### 4.1 Direct resources

| URI | `mimeType` | 内容 |
|---|---|---|
| `tiled://guide` | `text/markdown` | **已实现。** 使用 playbook：能力发现 → 摘要 → tile search/sparse render/sheet/map preview → 预览 edits → 客户端批准 → 提交 → 校验与渲染自查 |
| `tiled://application-errors` | `application/json` | **已实现。** 当前 103 个 v1 application code，以及 wire location、`INTERNAL_ERROR` fallback、兼容策略和排除边界；内容与提交的 machine artifact 相同 |
| `tiled://project/index` | `application/json` | **Roadmap，未实现。** 有界项目资产索引；大项目只给首页和 next cursor，完整翻页走 `tiled_list_files` |
| `tiled://schema/tool-contracts` | `application/schema+json` | **Roadmap，未实现。** 从代码生成的已注册工具 input/output schemas |
| `tiled://schema/tmj` | `application/schema+json` | **Roadmap，未实现。** 当前实现支持的 TMJ 子集 schema，不伪装成完整 Tiled schema |
| `tiled://schema/tsj` | `application/schema+json` | **Roadmap，未实现。** 当前实现支持的 TSJ 子集 schema |

### 4.2 Resource Templates

| `uriTemplate` | 内容 |
|---|---|
| `tiled://assets/{assetId}` | 资产原始 bytes；JSON 用 `text`，图片/二进制用 base64 `blob`，不返回会丢未知字段的“规范化 JSON” |
| `tiled://assets/{assetId}/summary` | 地图或 tileset 的有界结构摘要 |
| `tiled://assets/{assetId}/preview` | 默认参数的地图缩略图 |
| `tiled://assets/{assetId}/source-image` | tileset 原始图集图片 |
| `tiled://assets/{assetId}/sheet/{page}` | 带 local id/语义名的 tileset sheet 指定页 |
| `tiled://renders/{assetId}` | 工具生成并有 TTL 的完整或分片图片，供超限结果的 `resource_link` 使用 |

### 4.3 Resource wire contract

- `resources/list` 和 `resources/templates/list` 分别公布 direct resources 与 templates；列表支持 MCP cursor，顺序稳定。只有实现读取逻辑的条目才公布。
- `resources/read` 的每个 content item 都包含 `uri`、准确 `mimeType`，并且 `text`/`blob` 二选一。`_meta` 至少包含内容 `revision` 与原始 `size` bytes；项目资产还包含 `assetId`，文件支持可靠时间戳时才包含 ISO 8601 `lastModified`，嵌入式/生成内容不得伪造。图片还包含 width/height。
- JSON/text direct read 的目标默认上限是 `2 MiB`，当前嵌入式 guide 使用更严格的
  `64 KiB` 上限；图片沿用第 3.11.1 节的 `8 MiB` 上限。`RESOURCE_TOO_LARGE` 是配合未来
  asset/template Resource reads 规划的 resource-layer code，**尚未实现，也不属于当前
  101-code v1 application registry**；实现后应建议读取 summary、region 或分页资源，且不得
  截断后伪装成完整内容。
- 当前 v1 registry 覆盖的 `assetId` 在同一项目内部状态中跨服务器重启可复用；同路径
  替换与可唯一验证的普通同文件系统 file-identity move 保持映射；原路径仍存活的 copy/
  hardlink 和跨文件系统 move 分配新 ID。尚未观察的 hardlink 在旧路径删除后无法与
  rename 区分，可能继承旧 ID。客户端只能把它当不透明字符串，并应在路径变化后重新读取
  当前 map snapshot。
- 当前 direct resource registry 支持 list-changed capability，但 guide 和
  application-error registry 在一个 server 实例内都是静态内容；resource subscriptions
  未实现且显式声明为 false。未来若实现资产订阅，资产提交后对已订阅 URI 发送
  `notifications/resources/updated`；新增/删除资产发送 list changed。未实现的通知不得
  声明对应 capability。

## 5. Prompts

Prompts 是由 `prompts/get` 展开的**消息模板**，不是服务端宏、工作流引擎或授权机制。模板可以建议模型按顺序调用工具，但不能自行调用工具，也不能替用户批准 change set。每个 Prompt 都应声明清晰参数及 required 标记，并只引用当前实际注册的能力。

| Prompt | 流程 |
|---|---|
| `new-level` | 引导式建关卡：问尺寸/方向/tileset → 建地图 → 建标准图层组（背景/地面/装饰/碰撞/对象）→ 生成边界 → 渲染预览确认 |
| `add-collision` | 分析现有地面层 → 创建碰撞层或给 tile 加碰撞形状 → 用 `showCollision` 预览核对 |
| `terrain-transition` | 检查 wang set 配置 → 用地形笔刷在两种地形间生成自然过渡 → 渲染自查接缝 |
| `validate-and-fix` | 跑只读 `tiled_validate` → 解释诊断 → 预览选定 fixIds → 客户端向用户展示并批准 → 提交 change set |
| `describe-map` | 读摘要+渲染预览 → 输出人类可读的地图内容描述（用于接手别人的地图） |
| `auto-name-tiles` | **看图命名**：渲染带 id 标注的 tileset 索引图 → 模型逐页观察 → 预览持久化语义名映射 → 用户批准后提交 |
| `visual-review` | **看图审稿**：渲染整图+网格 → 模型以关卡美术视角挑问题（生硬的地形接缝、过度重复的图案、悬空的装饰、图层遮挡错误）→ 列出问题清单及坐标 → 征求同意后修复并渲染对比 |
| `build-from-reference` | **照图施工**：用户提供概念图/手绘草图/别的游戏截图 → 模型观察参考图的布局结构 → 对照 tileset 索引图规划用料 → 分区域搭建，每步渲染与参考图对照修正（网格对齐的像素图可先走 `tiled_import_from_image` 粗排） |

## 6. 实施阶段

| 阶段 | 范围 | 交付判据 |
|---|---|---|
| **M0：内核** | 项目路径解析与静态沙箱；宽松 raw JSON 无损加载/目标子树 patch；原始 bytes revision、合作写者文件锁与 CAS；单文档 temp+rename、create hard-link no-replace；内容寻址快照与既有目标恢复；只读 validate；schema/codegen/契约测试基础 | 未知字段往返不丢失；合作写者或最终 guard 前已观察到的修改必报冲突；模拟写入中断后目标保持旧版/新版之一；既有目标的已提交修改可从快照恢复，create checkpoint 不解释为删除；非合作写者与 hostile parent 的剩余窗口由 threat-model v1 明示 |
| **M1：首个可用 MVP** | **仅有限、正交 TMJ + 外部 atlas TSJ**；项目文件列表、地图/tileset 摘要、whole-map tile usage analysis、显式 tile metadata 精确检索、矩形 region 与单对象详情读取、已实现 set/fill/绝对坐标稠密矩形 stamp/精确 simultaneous replace/固定四向 encoded-GID flood fill/同 map 绝对矩形 copy、rectangle/point/ellipse/capsule、有界 polygon/polyline 与有界 text object 编辑、map 根级 render/background/class update、4 类 layer 公共属性 update，以及独占递归 delete / subtree move / safe subtree duplicate、4 类空图层创建、外部 tileset 挂载的专用 preview、独占且仅限零引用的 external tileset binding removal、change set 预览/提交、单文件 checkpoint 精确恢复、单项及 2..32 项 committed prune、current-before-verified prepared discard 与含混 prepared commit/abandon 人工裁决、只读校验、tileset sheet、显式稀疏 tile 选集、地图预览、guide。暂不支持无限 chunk、压缩 layer data、内嵌/collection tileset、等距/六边形 | 模型能按 class/property 找到精确 `TileRef`、盘点全图 tile 使用、先看 sheet 或稀疏候选选集，并在整体替换/删除 path 对象或覆盖 text 内容前读取完整有界详情，再安全修改 map 根属性、管理未使用的 external tileset binding，并创建/更新/移动/复制/删除图层及编辑、复制有限正交 TMJ tile 区域；move/delete/duplicate/tileset removal/copy 有有界影响摘要，提交前能预览且 revision 冲突不覆盖；修改后 Tiled 1.12.2 打开无警告、预览正确，并能经批准恢复原始 bytes |
| **M2：格式与事务扩展** | **已实现第一步：压缩/base64 tile data 只读支持**——`tiled_get_region`/`tiled_render_preview`/`tiled_analyze_usage`/`tiled_render_map` 按 Tiled 1.12.2 读取器语义解码 base64 + gzip/zlib/zstd（严格 canonical base64、解压输出钉死 width×height×4、LE uint32、单层 64 MiB 上限），全部编辑路径继续 fail closed，`tileDataReadCapabilities` 公布策略。其余仍待实现：无限地图与原 chunk 边界保持、压缩数据写入/转码、内嵌/collection tileset、跨文件可恢复事务、对象模板、复杂属性（含嵌套 class/list）、选择句柄和更多渲染方向 | 覆盖新增 fixture 的字节/语义往返；跨文件故障注入后可自动恢复到提交前或提交后的一致状态 |
| **后续 roadmap** | Wang/官方 `wangEdit` 后端、程序生成与预制件、World、游戏性分析、one-shot Tiled AutoMapping/转换/导出、TMX 独立写出、参考图导入、实时 GUI 扩展（若确有需求） | 每项独立设计、实现和验收；不以“58 个工具全部完成”作为单一里程碑 |

M1 只注册完成上述验收的最小工具集。第 3 节任何候选进入实现前，都要先分配到阶段、生成完整 schemas 并补齐 annotations/限制/测试。

## 7. 不做什么（Non-goals）

- **不做实时联动 Tiled GUI**（WebSocket 桥接方案）：复杂度高、需 Tiled 常驻，收益仅限"编辑器实时预览"；`tiled_render_preview` 已覆盖大部分需求。若未来有需求，作为独立扩展项目。
- **不做游戏运行时渲染/逻辑**：只管地图资产，不管游戏引擎内如何使用。
- **不重新实现 AutoMapping 规则引擎**：规则语义复杂且随版本演进，借 Tiled 本体执行。
- **不做 DSL 式邻接约束规则系统**（"悬崖边必须接悬崖顶"之类的自定义约束语言）：AutoMapping + Wang 地形已覆盖绝大部分场景，自研约束引擎是无底洞。
- **不做会话级隐式状态**（“当前地图/当前图层/当前选区/上一步操作”）：每次调用显式携带路径、id、revision 或有 TTL 的服务端句柄；参数复用由客户端或封闭 edits 完成。
- **Prompt 不代替批准**：Prompt 只能生成工作流消息，任何 destructive change set 仍须经过客户端批准门。
