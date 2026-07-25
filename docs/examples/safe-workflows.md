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
   `registeredTools`、`applicationErrorContract` 和
   `filesystemThreatModelContract`，以及
   `checkpointCapabilities.storagePolicy` 的实际 quota/GC 边界和
   `checkpointCapabilities.preparedAdjudication` 的权限模型；不要从旧会话或文档
   推断当前能力。
3. 核心 profile 当前包含 25 个工具；`tmxrasterizer` 探测成功后才注册
   `tiled_render_map`，总数为 26，不能把它当成必备工具。
4. 确认 `resources/list` 中存在 `tiled://application-errors`，需要完整 code allowlist
   时用 `resources/read` 读取；其内容与仓库的
   [`contracts/application-errors.v1.json`](../../contracts/application-errors.v1.json)
   相同。

能力发现也应在服务器升级、重新连接或运行环境变化后重做。示例清单覆盖 25 个核心工具
各一次，并额外给出一次可选 raster 调用；它不表示可选工具必然存在。

## 先满足文件系统运维条件

`filesystemThreatModelContract` v1 的保证只在其 `operationalRequirements` 成立时有效：

- 同一逻辑文件必须使用同一个规范化项目路径；hardlink alias 不共享路径锁；
- Tiled GUI、同步器和其他非合作写者不得在既有目标提交窗口并发保存；
- 运维方必须确认本地文件系统具有所需的同文件系统原子 rename/hard-link 与有效 `fsync`
  语义；server 只传播 syscall failure，不会验证这些底层语义；
- 项目根和父目录必须可信，不抵御同权限恶意进程的主动 parent swap。

既有目标最终 SHA-256 检查与无条件 `rename` 之间仍有非合作写者窗口。`changed:true` 的
成功响应只表示 promotion 曾发生，不是当前状态 lease；需要继续决策时重新读取 map
revision。相同
`changeSetId` 的成功 replay 返回首次缓存结果，也不是磁盘查询。需要严格抵御非合作写者或
hostile local process 时，使用 OS sandbox/FUSE/write broker；当前 backend 未实现它们。

## 先确认 checkpoint 容量

每个 net-changing 既有目标写入都必须先成功建立 checkpoint；create-map 也先建立审计
manifest。默认 retained quota 是 1 GiB / 10,000 observed entries，但 byte quota 可配置，
所以客户端必须使用 capability 返回的 `maxBytes` / `maxEntries`。

prepared 与 committed manifest 都是 GC root；prepared 会预留 committed 状态所需 bytes。
只有完整扫描且没有损坏、symlink、未知/非普通 entry、缺失引用或 scan truncation 时，
GC 才删除 orphan content object 和私有 crash temp。无法读取条目大小或无法保持
safe-integer 精确计费时，容量检查本身也会拒绝新写入。quota-pressure GC 从不删除有效
manifest；可选 rolling retention 只在新 checkpoint 成功提交后独立运行。
收到 `CHECKPOINT_QUOTA_EXCEEDED` 后停止 mutation 和自动重试，不要手工删除
content-addressed object 或 manifest；error details 是不透明诊断，不要据此自动选择恢复
动作。检查 capability、内部状态和部署容量后，只有操作者另行确认 entry 维度仍在上限内、
byte 维度单独超限时，才可提高 `--checkpoint-bytes` /
`TILEDMCP_CHECKPOINT_BYTES` 并重启；entry 超限或 inventory blocker 不会因提高 byte quota
消失。可以经 preview/批准显式 prune 一个 committed checkpoint，或显式选择 2..32 个
committed IDs 用 batch prune 清理 retention backlog；batch 不自动选择 victim。对于当前
目标仍能机器验证为 before 状态的 prepared checkpoint，也可经独立 preview/批准显式
discard。长期
编辑可由操作者在启动时设置 `--checkpoint-retain-per-target N` 或
`TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET=N`，显式批准默认关闭的 v2 rolling retention；
`N` 至少为 2。它只在新 checkpoint 成功 committed 后按 durable ordinal 每次至多删除一个
旧 rolling checkpoint；legacy、protected/create 与 prepared 永不自动删除，也不会在
quota failure 前预删恢复点。含混 prepared 状态只允许使用动作分离、证据绑定的
commit/abandon preview；通用 force 仍不受支持。

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
- `tiled_preview_prepared_checkpoint_discard`
- `tiled_preview_prepared_checkpoint_commit`
- `tiled_preview_prepared_checkpoint_abandon`
- `tiled_preview_checkpoint_prune`
- `tiled_preview_checkpoint_prune_batch`
- `tiled_preview_checkpoint_restore`

checkpoint restore 只恢复 manifest 指向的单个 JSON 文档，不会连带恢复其 tileset、图片
或其他依赖。单项 checkpoint prune 只接受一个 committed checkpoint ID；batch prune
接受 2..32 个 committed UUID，lowercase 规范化后拒绝重复项，并按 canonical ID
顺序展示和执行；prepared discard
只接受目标仍精确等于写前状态的 prepared checkpoint：existing-file 目标必须以 raw
revision 和 size 同时匹配 `before`，create 目标必须严格缺失。目标等于 after、无关内容、
existing-file 目标缺失、create 目标存在、symlink/非普通文件和
`before.revision === afterRevision` 都是稳定 conflict，不允许强制跳过。discard preview
不读取 stored-before blob，但会绑定 raw manifest revision/size、完整 metadata 和目标
状态证据。经批准的显式删除路径都只永久删除 manifest，不会修改目标项目资产；
单项 prune/discard 随后运行 fail-closed orphan GC，batch 则仅在全部成员逐项持久删除后
运行一次，partial 明确不运行 GC。

提交项目资产后重新读取 map summary，并按需要调用 `tiled_validate` 和
`tiled_render_preview` 检查结构与视觉结果。change set 会过期；map edit proposal 会绑定
目标 map revision，并在适用时绑定完整 dependency pins，checkpoint restore 绑定其单个
目标文档的 revision，单项 checkpoint prune/discard 绑定 raw manifest revision，batch
prune 则绑定有序 `{id,manifestRevision,manifestSize}` pins 的聚合 revision；discard
另外固定目标状态 CAS，prepared commit/abandon 则使用动作域隔离的完整 manifest + target
evidence digest。任一种
proposal 过期或冲突后都必须重新预览和批准；prune/discard/abandon 成功后均不留
tombstone，不要
把 not-found 当成可重试信号。

### 独占地调整地图尺寸

`resizeMap` 必须独占整个 change set，不能与其他 operations 混批。offset 语义与
Tiled 1.12.2 一致：`offsetX`/`offsetY` 是**旧内容在新地图中的 tile 位置**，缩小或
向左上裁剪用负值；目标格 `(x,y)` 取自源格 `(x−offsetX,y−offsetY)`。

```text
proposalWire = tiled_preview_edits({
  mapPath,
  expectedRevision: snapshot.revision,
  expectedDependencyRevisions: snapshot.dependencyRevisions,
  operations: [
    { type: "resizeMap", width: 40, height: 30, offsetX: 4, offsetY: 0 }
  ]
})
```

批准前必须向人展示 preview 的 destructive summary：新旧 bounds、offset、
`preservedNonEmptyCellCount`、`croppedNonEmptyCellCount` 与最多 16 项
`croppedCellSample`（差额在 `omittedCroppedCellCount`），以及
`movedObjectCount`/`objectsOutsideNewBounds`。对象只会被平移，绝不会被删除；越界
对象原样保留，`objectsOutsideNewBounds` 只是锚点级参考指标。任何 tile layer 与地图
bounds 不对齐时整个操作会以 `UNSUPPORTED_RESIZE_LAYER_BOUNDS` 拒绝；被裁剪区域中
的 malformed/unbound GID 也会 fail closed，而不是被裁剪静默掩盖。apply 后重新读取
map summary，并按需要用 `tiled_render_preview` 目视确认新 bounds。

### 创建或整体替换 polygon / polyline points

`createObject.object` 按 `shape` 使用 strict union。polygon 需要 3–256 点，polyline
需要 2–256 点；每个 point 必须是没有额外字段的 `{x,y}`，两轴都是 ±1e9 内有限数。
这些点是相对对象 `x`/`y` anchor 的本地像素，不是 map 绝对坐标，数组顺序会原样保留。
polygon 由 Tiled 隐式闭合，polyline 保持开放；服务端不会自动追加首点或重排。

```json
{
  "type": "createObject",
  "layerId": 2,
  "object": {
    "shape": "polygon",
    "x": 96,
    "y": 64,
    "points": [
      { "x": 0, "y": 0 },
      { "x": 32, "y": 0 },
      { "x": 16, "y": 24 }
    ],
    "name": "Patrol area"
  }
}
```

path create wire 不能携带 `width` / `height`；落盘 TMJ 会规范化为
`width:0,height:0` 并写入唯一的 `polygon` 或 `polyline` 数组。修改已有 path 时，
先用 `tiled_get_object({mapPath,objectId})` 读取完整 points 与最新 revision/dependencies，
再把完整新数组放进 `updateObject.patch.points`：

```json
{
  "type": "updateObject",
  "objectId": 17,
  "patch": {
    "name": "Adjusted patrol area",
    "points": [
      { "x": 0, "y": 0 },
      { "x": 40.5, "y": -4 },
      { "x": 20, "y": 28 }
    ]
  }
}
```

这不是 append、splice 或 index patch；数组会整体替换并保序，polygon 仍需至少 3 点，
polyline 至少 2 点。`points` 可与 common fields 同批出现，但不能用于非 path 对象，
也不能与 path dimensions 混用。单个 change set 的每次 create/replacement payload
都会独立计费，合计最多 8,192；相同值 no-op、later-wins 或后续 delete 不抵扣。
所有 pending change sets 以相同口径合计最多保留 65,536 点；
客户端应读取 `objectShapeCapabilities.polygonAndPolylinePoints` 和
`limits.maxPendingObjectShapePoints`，不要靠拆批绕过预算。shape 与 path dimensions
仍不可更新；删除仍须使用会执行悬挂 object-reference 检查的 `deleteObjects`。

### 读取并更新 text 对象

`tiled_list_objects` 只返回适合最多 10,000 项列表的精简 geometry，不返回 path points
或 text 正文/样式。需要替换/删除既有 path 对象，或覆盖 text 正文/样式时，
先按列表返回的全图唯一 ID 调用
`tiled_get_object({mapPath,objectId})`。它返回 map `revision`、完整
`dependencyRevisions` 和一个严格 shape-discriminated object；polygon/polyline 带完整
points，text 带解析 TMJ 缺省后的完整样式。tile/template、冲突 marker 或未知 nested
text profile 会 fail closed，客户端不能靠 list summary 猜原值。

创建 text 时，正文和样式与 common 字段同处 flat object；不要自行构造 nested TMJ：

```json
{
  "type": "createObject",
  "layerId": 2,
  "object": {
    "shape": "text",
    "x": 96,
    "y": 64,
    "width": 192,
    "height": 48,
    "text": "Gate opens\\nafter all switches",
    "fontFamily": "sans-serif",
    "pixelSize": 18,
    "color": "#ffd166",
    "bold": true,
    "wrap": true,
    "horizontalAlignment": "center",
    "name": "Gate hint"
  }
}
```

正文允许空串，最多 4,096 Unicode scalars / 16,384 UTF-8 bytes，只允许 TAB/LF/CR
控制字符；fontFamily 为 1–256 scalars / 1,024 bytes 且不允许控制字符，二者都拒绝
未配对 surrogate。pixelSize 是 1..999 的整数。服务端写入 nested TMJ `text` object，
并按文件格式默认 `sans-serif/16/#000000/false styles/kerning:true/left/top/wrap:false`
省略默认项；这里的 wrap 缺省与 Tiled UI 新建文本时常见的显式 `wrap:true` 不同。

更新时只传需要修改的 flat fields，例如
`{type:"updateObject",objectId:7,patch:{text:"Ready",color:"#66ff99"}}`。先前
`tiled_get_object` 返回的 revision/dependencies 应直接成为 `tiled_preview_edits` 的
pins；批准前仍检查 preview。text-specific 字段不能打到其他 shape。一个 change set 的
12 类 text fields 按每 operation 的 canonical compact JSON UTF-8 合计最多 256 KiB，
pending registry 合计 2 MiB；后序覆盖或删除不会抵扣预算。

内建 `tiled_render_preview` 的基础画面仍只渲染 tile layers，并会把可见 object
layers 报告为 omitted；但可用 `overlays.objectIds` 显式叠加受支持对象的几何轮廓。
text 只显示旋转后的 layout box，不能用来确认 glyph、字体、换行或对齐。需要像 Tiled
一样核对完整排版时，使用 discovery 中实际存在的可选 `tiled_render_map`，或在 Tiled
1.12.2 中打开项目；字体未安装导致的替换不属于 MCP 的可移植语义。

需要把待核对区域直接标在图片中时，可在 `tiled_render_preview` 传入：

```json
{
  "mapPath": "maps/example.tmj",
  "region": { "x": 8, "y": 4, "width": 12, "height": 8 },
  "overlays": {
    "grid": true,
    "objectIds": [7],
    "highlights": [
      { "x": 10, "y": 6, "width": 3, "height": 2 },
      { "x": 12, "y": 7, "width": 4, "height": 3 }
    ]
  }
}
```

这些坐标是绝对 map tiles，不是 region-local。每项必须和最终 `tileRegion` 相交；部分
越界会裁剪并在结果中同时报告 requested/rendered rect，完全不相交则拒绝整次 render。
高亮固定为无边框 amber 半透明 fill，重叠格按 tile union 只混合一次。客户端应保留
entries、`highlightedTileCount`、color、blend/overlap mode 与 PNG hash，不能仅凭图片
猜回选区。

`objectIds` 是 1–64 个唯一、全图有效的显式 ID，和 tile `layerIds` 无关。rectangle、
point、ellipse、Tiled 1.12 capsule、polygon、polyline 会绘制固定 cyan 轮廓与原点十字，
text 只绘制 layout box；ellipse/capsule 曲线按连续 output space 最大 0.25px chord
error 自适应细分，单对象最多 4096 段、全选集合计最多 65536 段，超限时整次失败。
单零尺寸曲线显示为 bounds line，双零尺寸显示为以 anchor 为圆心的 20 map-pixel 圆；
tile object 以 `tile-frame-only` 绘制 Tiled 1.12.2 对齐的 outline 矩形与锚点十字
（alignment/tileoffset/缺省尺寸按 tileset 解析，flip 位不改变轮廓，不渲染 tile
图像或 collision）；完全离区的对象仍在结果中返回 `rendered:false, clipped:true`。
显式调试忽略 visibility/opacity，但拒绝 template 和带非默认定位变换的所选
layer/Group。客户端应逐项核对保序 entry、`curveTessellation` 与
`tileObjectFrames`，不能把 geometry-only profile 当成完整 object-layer 渲染。

## 裁决含混的 prepared checkpoint

先让启动对账运行，并重新调用 `tiled_list_checkpoints`。只有仍为 `prepared` 且机器路径
无法收口的条目才需要人判断；不要对每个 prepared checkpoint 都弹出 force 按钮。

| 权威目标观察 | 应调用的 preview |
|---|---|
| create + missing | `tiled_preview_prepared_checkpoint_discard` |
| existing + exact-before | `tiled_preview_prepared_checkpoint_discard` |
| existing + exact-after | 不做人工裁决；重启服务，由启动 reconcile 推进 |
| create + exact-after | 由人选择 `tiled_preview_prepared_checkpoint_commit` 或 `tiled_preview_prepared_checkpoint_abandon` |
| create + unrelated | 只能 `tiled_preview_prepared_checkpoint_abandon` |
| existing + missing/unrelated | 只能 `tiled_preview_prepared_checkpoint_abandon` |
| unsafe / unreadable / racy | 不调用 apply；先排除安全问题并重新 preview |

commit 的含义只是“操作者确认当前 exact-after create 应保留为一条已提交的内部审计
checkpoint 记录”，不会触碰项目文件；由于它的 before 是目标不存在，当前 restore 也不能
把它还原成删除操作。abandon 的含义是“保留当前项目文件，但永久失去这个 prepared
recovery point”。批准 UI 必须展示 checkpoint ID、path、version/retention、before/after、
raw manifest hash/size、目标 missing 或 revision/size、`conflict`、警告与 expiry；不能只
显示动作名称。

伪代码：

```text
proposalWire = tiled_preview_prepared_checkpoint_commit({ checkpointId })
# 或：tiled_preview_prepared_checkpoint_abandon({ checkpointId })
assert_not_error(proposalWire)
proposal = proposalWire.structuredContent.result

show_complete_checkpoint_evidence_to_human(proposal)
wait_for_action_specific_approval()

resultWire = tiled_apply_change_set({
  changeSetId: proposal.changeSetId,
  expectedRevision: proposal.expectedRevision
})
assert_not_error(resultWire)
result = resultWire.structuredContent.result
```

apply 会在 target/store 锁内重新验证全部证据。preview 后的任一 manifest 或目标漂移都
要求重新 list/preview/批准，不能把 commit proposal 的 ID 或 digest 用于 abandon。commit
成功时检查 `manifestCommitted` 与 `durability`；`unconfirmed` 表示 rename 已发生但目录
durability/锁释放无法确认，不能当作未执行重试。abandon 成功时检查
`manifestDeleted:true` 和 GC outcome；unlink 后故障同样不是 retry-safe failure。同一
change set replay 只返回首次缓存结果，不会续跑或重新观察磁盘。

## 用 batch prune 显式清理 retention backlog

batch prune 不是自动 retention 的追赶模式，也不会替操作者推导 victim。安全客户端应：

1. 分页调用 `tiled_list_checkpoints`，保留当前仍为 `committed` 的候选及其目标路径；
2. 由操作者明确选择 2..32 个不同 UUID；不要仅凭 createdAt、label、UUID、mtime 或
   retention ordinal 自动授权删除；
3. 调用 `tiled_preview_checkpoint_prune_batch({checkpointIds})`；
4. 展示 preview 返回的 canonical-ID execution order、每个恢复点、目标、manifest pin、
   非原子 warning、聚合 `expectedRevision` 与 change-set expiry；
5. 获得针对**这份有序 proposal**的批准后，才调用统一的
   `tiled_apply_change_set({changeSetId, expectedRevision})`；
6. 按结构化 batch result 的逐项状态更新 UI，再重新列举 checkpoint，而不是从请求列表
   推断磁盘事实。

apply 会先按 canonical target path 顺序取得全部去重 target locks，再取 checkpoint-store
lock，并在首次 unlink 前权威重读和 pin 全部成员。只要任一成员已被 retention/另一个 prune
删除，或其 raw bytes、size、path、metadata、`committed` status 漂移，本批次就以零删除
错误结束；重新 list 和 preview，不能删掉仍匹配的“其余部分”。该预检不读取 stored-before
blob，也不要求无关 global inventory/object 完整，因此一个已损坏的旧 blob 或其他 storage
blocker 不会替操作者改变已批准的 manifest 集。

通过全成员 barrier 后，删除是非原子的：按 canonical ID 顺序逐项 unlink，每项立即 fsync
checkpoint 目录，遇到首个故障就停止。客户端必须这样解释结果：

- `completed`：全部选中 manifests 已观察为删除；逐项 durability 与最终
  `garbageCollection` 仍须分别检查，正常路径只运行一次 fail-closed GC，末项 fsync/hook
  故障则可能直接报告 GC failed；
- `partial`：至少一个 manifest 已删除，剩余项明确为 failed/not-attempted；GC 不运行；
- application error：首次 unlink 前失败，本次 batch 自身零删除，但仍应重新读取事实；
- 响应丢失且进程仍在：用同一 change set replay，取得 exact cached result；
- partial replay：**只返回缓存，绝不继续**；若仍要删除 not-attempted IDs，必须建立新的
  preview 并再次批准；
- TTL 到期或服务重启：旧 change set 不是 durable resume token，重新列举并重新 preview。

不要写“重试直到全部删除”的循环，也不要在 partial 后把 missing ID 当作该 batch 已删除的
证据。真正的 all-or-nothing 多 manifest 事务不在当前契约中。

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
落盘后、标记 committed 前崩溃，启动对账也不会仅凭相同 hash 猜测文件来源，prepared
discard 同样会因 create 目标已存在而拒绝。只有目标当前严格缺失、与
`before.existed:false` 一致时才可走 prepared discard；目标精确等于 after 时，必须由
操作者在独立 commit/abandon proposal 的完整证据上作出决定。

## Raster 预览是可选能力

`tiled_render_preview`、`tiled_render_tileset_sheet` 与 `tiled_render_tiles` 是核心
内建渲染能力，不依赖 Tiled GUI 或 `tmxrasterizer`。先用
`tiled_find_tiles` 找到语义候选，再把返回的非连续 local IDs 和 revision pins 原样交给
`tiled_render_tiles`；它按输入顺序返回带标签的 static raw atlas cells，便于在不翻阅
连续 atlas 页面的情况下比较候选。选集必须有 1–64 个唯一 ID，放不下时整体失败，不会
漏项或降低 scale。需要浏览连续 local IDs 时仍用 sheet。随后用 native preview
完成有限正交地图的常规视觉闭环；native preview
还能以最多 64 个固定样式的绝对 tile 矩形标出核对区域，其 union fill 与底图共享
pixel-blend 工作预算；`overlays.objectIds` 还能以最多 64 个显式 ID 核对 basic object
几何、text box 与 tile object 的 Tiled 对齐 frame 轮廓，选中 path points 合计最多
8192，曲线另有每对象 4096/合计 65536
segment 上限，裁剪后的 stroke 同样计入共享预算。

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

当前 v1 application-error registry 包含 100 个 code。code 的稳定 wire 位置是
`structuredContent.result.error.code`；完整 allowlist 由
[`contracts/application-errors.v1.json`](../../contracts/application-errors.v1.json)
和 direct Resource `tiled://application-errors` 提供，capability 中的
`applicationErrorContract` 公布其 revision、size、wire location、fallback 与兼容策略。
`INTERNAL_ERROR` 是未预期 handler 失败的安全 fallback。

不同失败/诊断表面不能共用一个枚举：

| 表面 | 客户端处理 | 属于 100-code application registry |
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
