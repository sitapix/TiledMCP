# TiledMCP 安全调用工作流

本页配套 [`examples/mcp-calls.v1.json`](../../examples/mcp-calls.v1.json)，说明客户端如何把
独立的 schema 示例组合成安全工作流。示例文件中的 revision、asset ID、change set ID
和 checkpoint ID 都只是**格式合法的固定占位符**，不可直接用于真实项目；发送请求前
必须替换为当前会话、当前项目快照实际返回的值。只有 schema 明确标为可选的先验条件
可以在没有可信来源时省略，例如尚未挂载 TSJ 的 `expectedTilesetRevision`。

## 先发现能力，再选择工具

连接服务器后先调用 MCP `tools/list` / `resources/list`，再调用
`tiled_get_capabilities`：

1. 以 `tools/list` 返回的工具和 input schema 作为本次连接的实际 wire contract。
2. 读取 capability 中的 `editProfiles`、`serverVersion`、`cli` 探测结果、
   `registeredTools` 和 `applicationErrorContract`，不要从旧会话或文档推断当前能力。
3. 核心 profile 当前包含 18 个工具。`tiled_render_map` 只有在
   `tmxrasterizer` 探测成功后才会注册，不能把它当成必备工具。
4. 确认 `resources/list` 中存在 `tiled://application-errors`，需要完整 code allowlist
   时用 `resources/read` 读取；其内容与仓库的
   [`contracts/application-errors.v1.json`](../../contracts/application-errors.v1.json)
   相同。

能力发现也应在服务器升级、重新连接或运行环境变化后重做。示例清单覆盖 18 个核心工具
各一次，并额外给出一次可选 raster 调用；它不表示可选工具必然存在。

## 把 revision 与依赖当成同一个快照传递

编辑前用 `tiled_get_map_summary` 读取目标地图，并把以下值作为一组保留：

- `revision`：地图原始 bytes 的 SHA-256 revision；
- 完整的 `dependencyRevisions`：当前地图引用的外部依赖 revision 映射；
- 响应中返回的 `assetId`：后续 tileset 读取、搜索和 TileRef 使用的不透明身份。持久化
  registry 会让同路径替换保持 ID，并在唯一、稳定且非零的 file identity 证据下尽力让
  普通同文件系统 rename 保持 ID；弱 identity、原路径仍存活的 copy/hardlink、跨文件系统
  move 或其他无法匹配 file identity 的场景取得新 ID；若
  尚未观察的 hardlink 在旧路径删除后，最终状态无法与 rename 区分，可能继承旧 ID。
  路径变化后仍必须重新读取 map snapshot，不能拿旧 change set 自动跟随重命名。

不要自行拼接 asset ID，也不要只复制其中一部分依赖。需要 pin 的调用必须直接传递这次
读取返回的 map revision 和**完整** dependency map。使用 `tiled_find_tiles` 的可选
`expectedMapRevision` / `expectedTilesetRevision` 时，两者必须来自对应 map summary
及其 dependency map。`tiled_add_tileset_to_map.expectedTilesetRevision` 也是可选的
额外先验：只有调用方已从可信通道持有候选 TSJ 的当前 revision 时才传；否则省略，服务端
仍会在 preview 时读取实际 revision、固化进 change set，并在 apply 前复核。示例 manifest
为展示字段形状而包含了格式合法的占位值，不代表真实调用必须伪造该值。

registry 是 `.tiledmcp` 下的项目内部状态；目标项目应忽略它，本仓库已这样配置，但
服务器不会修改任意目标项目的 `.gitignore`。复制或提交该文件会携带 ID，却不属于受支持
的跨 clone 同步机制；删除它可能重新分配 ID。相同 bytes 不是同一资产的证据，客户端不得
自行用 content hash 把 copy 合并为旧 ID。

这些 pin 会检测从读取到提交之间的变化，但读取 map 与多个依赖并不是一个文件系统原子
快照。遇到 revision 或依赖冲突时，丢弃旧计划，重新读取全部相关状态并重新预览；不要
盲目重试旧的 change set。这也意味着先变更再恢复为相同可见内容的 ABA 情况仍需由外部
写入协调策略处理。

## Preview → 人工批准 → Apply

普通编辑必须走两阶段边界。以下是伪代码，字段值来自响应，不是示例文件里的固定占位符：

```text
summaryWire = tiled_get_map_summary({ mapPath })
assert_not_error(summaryWire)
snapshot = summaryWire.structuredContent.result

proposalWire = tiled_preview_edits({
  mapPath,
  expectedRevision: snapshot.revision,
  expectedDependencyRevisions: snapshot.dependencyRevisions,
  operations
})
assert_not_error(proposalWire)
proposal = proposalWire.structuredContent.result

show_to_human(proposal)
wait_for_explicit_approval()

commitWire = tiled_apply_change_set({
  changeSetId: proposal.changeSetId,
  expectedRevision: proposal.expectedRevision
})
assert_not_error(commitWire)
commit = commitWire.structuredContent.result
```

在批准前应向人展示 bounded proposal：目标路径、operation 摘要、影响范围、警告和预期
revision。只有收到针对该 proposal 的明确批准后，才调用
`tiled_apply_change_set`。在请求里加入自定义 `confirm: true` 既不合法，也不能代替批准；
所有 input schema 都是 strict，额外字段会被 SDK 拒绝。

以下 preview-only 工具同样返回 change set，并复用相同批准与 apply 边界：

- `tiled_add_tileset_to_map`
- `tiled_create_layer`
- `tiled_preview_checkpoint_restore`

checkpoint restore 只恢复 manifest 指向的单个 JSON 文档，不会连带恢复其 tileset、图片
或其他依赖。提交后重新读取 map summary，并按需要调用 `tiled_validate` 和
`tiled_render_preview` 检查结构与视觉结果。change set 会过期；map edit proposal 会绑定
目标 map revision，并在适用时绑定完整 dependency pins，而 checkpoint restore 只绑定
其单个目标文档的 revision。任一种 proposal 过期或冲突后都必须重新预览和批准。

## `tiled_create_map` 是 no-replace 例外

`tiled_create_map` 是直接提交的创建操作，不经过 preview/apply：

- 目标必须是项目内规范化的相对 POSIX 路径，且父目录必须已经存在；
- 目标文件已存在时一定拒绝，不覆盖，也不把“内容相同”视为成功；
- 它固定为 `idempotentHint:false`：目标落盘前失败也可能留下新的 prepared checkpoint，
  而同一请求成功一次后再次调用会因目标已存在而失败；不要自动重试；
- 成功响应中的 revision 才是新地图后续编辑的起点。

这个例外只适用于创建一个此前不存在的 TMJ，不能据此绕过其他 mutation 的预览批准流程。
调用前由用户确认目标路径；如果重试原因不明，先用 `tiled_list_files` 或读取工具确认状态。
其自动 checkpoint 记录 `before.existed:false`，当前恢复工具不会把它解释成删除；进程若在
落盘后、标记 committed 前崩溃，启动对账也不会仅凭相同 hash 猜测文件来源。

## Raster 预览是可选能力

`tiled_render_preview` 与 `tiled_render_tileset_sheet` 是核心内建渲染能力，不依赖 Tiled
GUI 或 `tmxrasterizer`。优先用它们完成有限正交地图的常规视觉闭环。

只有当 `tools/list` 包含 `tiled_render_map`，并且 capability 报告 rasterizer
`available: true` 且带有已探测 version 时，才可调用可选的整图 raster 预览。客户端应按
响应中的实际 `options`、renderer version、PNG hash/尺寸、map revision 和外部 TSJ
dependency revisions 记录结果。公开的 dependency map 只包含外部 TSJ；渲染器读取的
图片 revision 是服务器内部安全检查，不应由客户端伪造或当成公开依赖字段。

所有 PNG 工具都通过 MCP image content 返回图片，并在 structured result 中给出可追踪
元数据；不要从 compact text summary 还原完整结果。渲染前后的多文件检查同样不是原子
事务，外部非协作写入者仍可能造成 race/ABA，生产工作流应避免与 Tiled 或其他写入器并发
修改同一资产集。

## 区分 SDK 输入错误、应用错误与诊断

当前 v1 application-error registry 包含 97 个 code。code 的稳定 wire 位置是
`structuredContent.result.error.code`；完整 allowlist 由
[`contracts/application-errors.v1.json`](../../contracts/application-errors.v1.json)
和 direct Resource `tiled://application-errors` 提供，capability 中的
`applicationErrorContract` 公布其 revision、size、wire location、fallback 与兼容策略。
`INTERNAL_ERROR` 是未预期 handler 失败的安全 fallback。

不同失败/诊断表面不能共用一个枚举：

| 表面 | 客户端处理 | 属于 97-code application registry |
|---|---|---|
| MCP SDK input error | handler 尚未运行；读取 SDK-owned text-only error，不期待 `structuredContent` | 否 |
| Tool application error | 确认 `isError: true`，读取 `structuredContent.result.error.code` | 是 |
| Capability probe issue | 读取 `cli.*.issues[].code`，只用于判断本机可选 CLI 能力 | 否 |
| Startup fatal error | 按进程 stderr / exit 处理，不能伪造 tool envelope | 否 |
| Validation diagnostic | 读取 `tiled_validate` 成功结果中的 diagnostics | 否 |
| Checkpoint reconciliation diagnostic | 按启动对账报告/诊断处理 | 否 |
| 原始 OS error code | 仅视为底层实现信息，不直接进入稳定 application code 控制流 | 否 |

客户端应先按 `tools/list` schema 本地校验输入，再按表中通道处理失败。v1 中已存在的
application code 标识符及含义稳定，但未来 server 可以新增 code；遇到未知 code 时先
按通用应用错误安全处理，再刷新 `tools/list`、capabilities 和 resource discovery。
控制流只能依赖已发现的 code：不要匹配最多 1024 bytes compact summary 中的人类
`message`，也不要依赖 opaque `details` 的字段、措辞或形状。
