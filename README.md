# TiledMCP

一个面向 [Tiled Map Editor](https://www.mapeditor.org) 的安全优先 **Tilemap MCP
服务器**。目标是让支持 MCP 的模型安全地检查、创建、编辑、验证和预览 Tiled
资产，并逐步扩展到格式转换、AutoMapping 与 Wang 地形等官方自动化能力。

## 项目状态

🚧 **MVP 实现中，接口尚未冻结。**

第一条可运行的纵向闭环已经完成：

- 项目根目录沙箱、路径逃逸与 symlink 拒绝；
- 严格安全的 TMJ/TSJ JSON 读取，以及只重写目标子树的 source-preserving patch；
- 原始 bytes 的 SHA-256 revision、CAS、进程内互斥和跨进程文件锁；
- 同目录原子替换、写前内容寻址 checkpoint、只读索引、启动对账，以及经
  preview/批准后按原始 bytes 恢复单个既有 JSON 文档；
- 有限正交 TMJ + 外部 atlas TSJ 的摘要、矩形 region 读取和只读校验；
- 按 map + tileset `assetId` 定位的有界 TSJ 详情，覆盖 atlas geometry、稀疏
  tile class（Tiled 1.12 的 `tiles[].type`）/动画/碰撞计数和 Wang-set 概览；
- 按相同 map + tileset `assetId` 在显式稀疏 `tiles[]` metadata 中精确检索
  class、property 存在性或内建标量 property 值，并返回可直接用于编辑的 `TileRef`；
- 把项目内已有 external atlas TSJ 安全挂载到 map：先生成绑定 map/依赖 revision 的
  change set，经客户端批准后再由统一 apply 边界提交；
- 在有限正交 TMJ 中预览创建空的 tile/object/image/group 图层，支持根级或 Group
  内的显式插入位置，批准后提交并正确维护 `nextlayerid`；
- 通过通用 preview union 修改 4 类已有图层的 11 个公共显示/元数据字段，使用
  member-local source patch；
- 通过同一 union 的独占 destructive operation 删除 leaf/空 Group 或经显式确认递归
  删除非空 Group，保留 ID 高水位并阻止存活对象引用悬空；
- 通过该 generic union 的第 9 种独占 operation 在根级与 Group 间移动已有图层；
  Group 会连同完整 subtree 精确搬移，保持 ID 高水位与未触及 JSON source bytes；
- 无损 4-bit GID 变换编解码；
- `setTiles` / `fillRegion` / `replaceTiles` 封闭编辑集合，以及 preview →
  approved change set → apply 的两阶段提交；replacement 按完整变换后的 encoded GID
  精确匹配，并在一个 operation 内单次扫描、同时求值；
- 基础 rectangle/point 对象的有界列表与 create/update/delete（正确维护
  `nextobjectid`）；
- 带 local ID 标注、自动分页和三重 revision 元数据的 atlas tileset PNG sheet；
- 不依赖 Tiled 进程的有限正交 tile-layer region PNG 预览，支持图层筛选、GID
  H/V/D、opacity、网格和绝对坐标 gutter；
- Tiled CLI 能力探测和可选 `tmxrasterizer` PNG 预览；
- 可由 MCP `resources/list` 发现并通过 `resources/read` 读取的
  `tiled://guide` 安全编辑 playbook；
- stdio MCP server、严格输入 schema、结构化输出 envelope 与四项 tool annotations。

无限地图、压缩 tile data、内嵌/图片集合 tileset、复杂对象/模板和跨文件事务尚未实现；
这些输入会被明确拒绝，不会静默降级。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/01-tiled-research.md](docs/01-tiled-research.md) | Tiled 软件调研：核心数据模型、文件格式、自动化生态、现有同类 MCP 分析 |
| [docs/02-mcp-spec.md](docs/02-mcp-spec.md) | **MCP 功能规格草案**：Tools / Resources / Prompts 清单与分期计划 |
| [docs/03-architecture.md](docs/03-architecture.md) | 技术架构：技术选型、读写策略、关键实现要点与坑 |

## 一句话定位

目标是以 **TMJ/TSJ（JSON）无损读写**为地基，把 **Tiled CLI 与一次性脚本执行**作为格式转换、AutoMapping、Wang 编辑和兼容性验证后端，逐步提供面向结果的高层编辑工具与回滚安全网，并把**视觉闭环做成一等能力**：模型借助带 id 标注的 tileset 索引图选料，改完后渲染自查、对比确认。

首个 MVP 聚焦**有限尺寸的正交 TMJ + 外部图集式 TSJ**：当前已完成安全路径解析、地图摘要与区域读取、显式 tile metadata 语义检索、带 ID 的 tileset sheet、基础 tile/rectangle/point 对象编辑、局部 JSON range patch、校验、预览，以及带 revision 检查、启动对账和两阶段批准的单文件精确快照恢复。无限地图、跨文件事务、复杂属性、World/Template、Wang 与程序化生成将在基础读写闭环稳定后分期加入。

## 快速开始

要求 Node.js 20.19+、pnpm 11。tileset sheet 与有限正交 tile-layer region preview
都是内建核心能力，不依赖 GUI。复杂地图的高保真整图 PNG 预览仍需要本机安装
Tiled / `tmxrasterizer`。

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/index.js --project-dir /absolute/path/to/your/tiled-project
```

服务使用 stdio transport；stdout 只承载 MCP 协议，诊断写入 stderr。项目根目录是必填
的 fail-closed 安全边界，也可以通过 `TILED_PROJECT_DIR` 设置。一个通用的客户端配置为：

```json
{
  "mcpServers": {
    "tiled": {
      "command": "node",
      "args": [
        "/absolute/path/to/TiledMCP/dist/index.js",
        "--project-dir",
        "/absolute/path/to/your/tiled-project"
      ]
    }
  }
}
```

当前注册 18 个不依赖 Tiled CLI 的核心工具；本机探测到 `tmxrasterizer` 时再注册第
19 个可选工具：

| 工具 | 作用 |
|---|---|
| `tiled_get_capabilities` | 查看实现边界、限额和本机 Tiled CLI 能力 |
| `tiled_list_files` | 列出项目内 Tiled 资产 |
| `tiled_list_checkpoints` | 有界列出恢复 checkpoint，并隔离报告损坏 manifest |
| `tiled_preview_checkpoint_restore` | 校验单文件 checkpoint 并生成 destructive 恢复 change set；不直接写盘 |
| `tiled_get_map_summary` | 读取 revision、图层树和 tileset asset id |
| `tiled_analyze_usage` | 只读统计整张地图的 tile 使用、图层密度、变换位和未使用 local ID |
| `tiled_get_tileset` | 按 map + asset id 读取有界 atlas/稀疏 tile metadata/Wang 概览 |
| `tiled_find_tiles` | 按 map + asset id 精确检索显式 class/property metadata，返回分页 `TileRef` |
| `tiled_get_region` | 用 `TileRef` 读取有界矩形区域 |
| `tiled_render_tileset_sheet` | 按 `tilesetAssetId` 返回带 local ID 的分页 PNG sheet |
| `tiled_render_preview` | 内建渲染有限正交 tile layer，可选 region、图层、网格和坐标 |
| `tiled_list_objects` | 有界列出全部或指定 object layer 的对象 |
| `tiled_validate` | 只读结构与 MVP profile 校验 |
| `tiled_create_map` | 新建有限正交 TMJ，已有文件绝不覆盖 |
| `tiled_add_tileset_to_map` | 预览把已有 external atlas TSJ 挂到 map；不直接写盘 |
| `tiled_create_layer` | 预览创建一个空 tile/object/image/group 图层；不直接写盘 |
| `tiled_preview_edits` | 校验 tile/object/layer 编辑并生成有 TTL 的 change set |
| `tiled_apply_change_set` | 以目标 revision CAS 提交已批准的 map edit 或 checkpoint restore |
| `tiled_render_map` | 可选；本机有 `tmxrasterizer` 时返回 PNG |

当前 direct Resource：

| URI | 类型 | 作用 |
|---|---|---|
| `tiled://guide` | `text/markdown` | 串联能力发现、sheet/preview 检查、change set 客户端批准、提交与提交后复核；内容带 SHA-256 revision 和 UTF-8 byte size |

资产、schema 和 render Resource Templates 尚未注册；应以
`resources/list` / `resources/templates/list` 的实际响应为准。

仓库带有可由 Tiled 1.12.2 打开和渲染的
[`fixtures/mvp/basic.tmj`](fixtures/mvp/basic.tmj) 示例；其外部 TSJ 还包含 tile
class（通过 `type` 保存）、property、collision objectgroup 与 Wang-set，用于锁定详情
读取和 tile 检索契约。

安全编辑的调用顺序是：

1. 用 summary/region 读取 `revision`、`dependencyRevisions` 和 tileset `assetId`；
2. 把这两个 revision 前提连同封闭 operations 传给 `tiled_preview_edits`；
3. 客户端把有界摘要展示给用户批准；
4. 用返回的 `changeSetId` 与 `expectedRevision` 调用
   `tiled_apply_change_set`。

`TileRef` 使用
`{"tileset":{"kind":"external","assetId":"…"},"localId":0}`，调用方不接触裸
GID。preview 在 map 或任一已固定的现有/待加入依赖 revision 已变化时都会拒绝签发。

需要盘点地图用料时，调用只读的 `tiled_analyze_usage`，输入为
`{mapPath, topTileLimit?, expectedMapRevision?, expectedDependencyRevisions?}`。它递归
扫描整张有限正交地图的所有 tile layer cell 和 object layer 中的 tile object，忽略
visibility，因此隐藏 layer/Group 也会计入。tile 频率按
`tileset assetId + localId` 的基础 tile 聚合，不会把翻转/对角变换拆成不同 tile；完整
raw flag 组合另在 transform 摘要中计数。

结果只返回有界摘要：按密度从低到高的 layer、未使用优先的 tileset（含未使用 local ID
数量与样本）以及按总引用数从高到低的 top tiles。单次最多扫描 1,000,000 个 tile cell
与 object、聚合 100,000 个 distinct tile；layer/tileset 摘要各最多 64 项，
`topTileLimit` 默认 64、最多 128，序列化结果最多 256 KiB。两个 revision pin 必须同时
省略或同时提供；提供时 `expectedDependencyRevisions` 必须是该 map 的完整精确依赖集合。
返回的 `snapshotConsistency` 仍是 `non-atomic-read-set`，不能把多文件复核宣称为原子
快照。

需要在一个 tile layer 中批量替换时，使用 `tiled_preview_edits` 的
`replaceTiles` operation：
`{type, layerId, mappings: [{from, to}], region?}`。`from` 必须是非空
`TileRef`，`to` 是完整的目标 `TileRef` 或用于清空的 `null`；匹配比较完整 encoded GID，
包括 transform/raw flags，省略 transform 表示 identity，并不是通配符。一个 operation
只扫描一次原始格子，所以 `A→B, B→C` 不会把原始 A 级联成 C，swap/cycle 也可预测。
`region` 是绝对 tile 坐标 `{x,y,width,height}`，省略时使用该 layer 自身的完整 bounds。
每个 operation 最多 128 组映射；一个 change set 的 replacement 最多扫描
1,000,000 个格子，实际发生的替换与其他 tile operation 合计最多写 100,000 个格子。
没有命中是合法 no-op，preview 会报告 0 次替换，apply 不会改写文件。

修改已有图层的通用显示/元数据字段时，在同一个 `tiled_preview_edits` 中使用第 7 种
operation：
`{type:"updateLayer", layerId, patch}`。它支持 `tilelayer`、`objectgroup`、
`imagelayer` 和 `group`，patch 必须非空且只能包含 `name`、`className`、`visible`、
`opacity`、`offsetX`、`offsetY`、`parallaxX`、`parallaxY`、`tintColor`、`locked`
与 `blendMode`。这些 wire 字段分别写入 TMJ 的 `name`、`class`、`visible`、
`opacity`、`offsetx`、`offsety`、`parallaxx`、`parallaxy`、`tintcolor`、`locked`
与 `mode`。

`tintColor:null` 删除 `tintcolor`；删除一个本来就缺失的 tint 或写入完全相同的 JSON
值是 no-op。反之，即使 Tiled 在字段缺失时采用相同默认值，显式插入该字段仍算 change。
`locked` 只是 advisory metadata，不会阻止同批 tile/object 编辑。preview 的每项
layer update 会回显 `requestedFields`、`changedFields`、`wouldChange` 与
`affectsDescendants`；Group 中实际改变的公共渲染属性可能影响后代，因此才会明确标记。

字符串最多 1024 个字符，opacity 限 `0..1`，offset/parallax 必须是
`-1,000,000,000..1,000,000,000` 内的有限数；tint 只接受 `#RRGGBB`、
`#AARRGGBB` 或 `null`。blend mode 是 13 项封闭枚举：`normal`、`add`、
`multiply`、`screen`、`overlay`、`darken`、`lighten`、`color-dodge`、
`color-burn`、`hard-light`、`soft-light`、`difference`、`exclusion`。
它不是新的 standalone MCP tool，所以仍是 18 个 core / 19 个含 rasterizer 的工具。

删除已有图层使用 generic union 的第 8 种 operation：
`{type:"deleteLayer", layerId, deleteDescendants?}`。它必须是 change set 中唯一的
operation，不能与 tile、object 或 layer update 混批。普通 leaf 和空 Group 可直接删除；
非空 Group 必须显式传 `deleteDescendants:true`，随后整个 Group subtree 与其中的 tile
data、image-layer 引用、objects 一起从 TMJ 删除，但不会删除外部图片或 TSJ 文件。
children 不会提升到父级，也不会顺便清空或删除祖先。

删除含对象的 subtree 前，服务端会检查仍然存活的完整 map。直接 `object` property 或
Tiled 1.12 `list` 内的 object reference 指向待删对象时拒绝；存活的 `class` property
可能隐藏 typed object reference，因此 fail closed。被删 subtree 内部的引用会与其目标
一起消失，不构成 dangling reference。`locked` 仍只是 advisory metadata：不会阻止删除，
但 preview 会报告 `lockedLayerCount` 并给出醒目 warning。

destructive preview 回显选中 layer 的类型/名称/父 Group/index，以及完整
`deletedLayerCount`、`descendantLayerCount`、`objectCount`、`lockedLayerCount`；layer
和 object ID 各只采样最多 32 个，并用 omitted count 明示截断。apply 不降低
`nextlayerid` 或 `nextobjectid`，不会复用历史 ID；写回只从直接父层的 `layers` 数组删除
一个 element，保留所有未触及 sibling、祖先和其他 source bytes。它仍通过正常的
revision-pinned preview/批准/apply 流程，不新增 standalone tool，工具数保持
18 core / 19 optional。

移动已有图层使用 generic union 的第 9 种 operation：
`{type:"moveLayer", layerId, parentGroupId?, index}`。它必须独占 change set，不能与
tile、object、`updateLayer`、`deleteLayer` 或其他 move 混批。省略 `parentGroupId`
明确表示 map 根级；`null` 不是 root 的别名，会被严格 schema 拒绝。`index` 是移动完成后
目标 `layers` JSON 数组中的最终 0-based index：同父数组原有 `n` 个 sibling 时范围为
`0..n-1`，跨父移动到原有 `m` 个 child 的目标数组时范围为 `0..m`。调用方无需为向后移动
自行补偿删除造成的偏移；目标就是当前位置时是合法 no-op，apply 保持文件 bytes 完全不变。

选择 Group 会把它的完整 subtree 作为一个 element 搬移，不提升或拆散 children。Group
不能移入自身或任一后代，移动后的最大图层深度不能超过 64。`locked` 仍只是 advisory
metadata，不会阻止移动；preview 会报告直接 source/target parent 的锁状态，以及 subtree
移动前后的 effective-locked layer 数量，并在任一侧存在 effective lock 时给出 warning。

move summary 回显 `sourceParentGroupId` / `targetParentGroupId`（根级为 `null`）、
`sourceIndex` / `targetIndex`、`subtreeLayerCount`、`descendantLayerCount`、最多 32 个
`layerIdSample` 及 `omittedLayerCount`、`objectCount`、`lockedLayerCount`，以及
`sourceParentLocked`、`targetParentLocked`、
`effectivelyLockedLayerCountBefore` / `effectivelyLockedLayerCountAfter`、
`wouldChange`、`renderOrderMayChange`、`renderContextMayChange` 和
`affectsDescendants`。apply 不改变 `nextlayerid` 或 `nextobjectid`。source-preserving
写回使用 `JsonArrayMove`，以修改前 source snapshot 中的 source/target container path
定位数组并搬移原 element 的精确 bytes；即使移除较早的 root layer 让后方目标 Group 的
运行时 path 前移，也不会错取目标。除数组接缝所需文本外，未触及 sibling/ancestor、
BOM、CRLF、缩进、键序、数字/字符串词法与未知字段均保持原 bytes。

move 仍走 revision-pinned preview → 客户端批准 → apply：change set 固定 operation、
map revision 与完整 dependency revisions，apply 重验摘要并用 CAS 提交；实际写入前照常
创建内容寻址 checkpoint。它没有 `tiled_move_layer` standalone tool，所以注册数量仍是
18 个 core / 19 个含 rasterizer 的工具。`moveLayer` 已实现，`duplicateLayer` 尚未实现。

挂载一个尚未被 map 引用的现有 TSJ 时，先从最新 map summary 取得 map revision 与完整
`dependencyRevisions`，再调用 `tiled_add_tileset_to_map`，传入 `mapPath`、
`tilesetPath`、`expectedMapRevision`、`expectedDependencyRevisions`，以及可选的
`expectedTilesetRevision`。这个工具只验证目标 atlas、分配 `firstgid` 并返回
`changeSetId`，不会写文件；客户端批准后仍须调用 `tiled_apply_change_set`。提交成功后
重新调用 `tiled_get_map_summary`，从响应取得新挂载 tileset 的 opaque `assetId`，不要从
路径自行推导。该流程只增加 tileset 引用，不创建图层。

创建图层时，从最新 map summary 取得相同的 map revision 与完整
`dependencyRevisions`，再调用 `tiled_create_layer`。`type` 可取 `tilelayer`、
`objectgroup`、`imagelayer` 或 `group`；省略 `parentGroupId` 表示根级，`index`
是目标同级数组中从 0 开始的插入位置，省略时追加到最上层。工具使用当前
`nextlayerid` 分配全图唯一 ID，只返回待批准 change set；批准后仍由
`tiled_apply_change_set` 写入。有限 tile layer 初始化为空 GID 数组，最多分配
100,000 个 cell。image layer 还必须提供项目内 `imagePath`，可带
`expectedImageRevision`；实际图片 revision、尺寸和 map-relative source 会作为
prospective dependency 固化进 change set，并在 apply 前再次检查。

恢复时先用 `tiled_list_checkpoints` 选择 manifest，并从目标文档的最新读取结果取得精确
revision；再调用 `tiled_preview_checkpoint_restore(checkpointId, expectedRevision)`。
preview 会验证 manifest、内容寻址 blob、原始 JSON bytes 和当前目标 revision，只返回
带 TTL 的 destructive proposal；客户端批准后仍由 `tiled_apply_change_set` 写盘。恢复
只替换该 checkpoint 对应的一个既有 JSON 文档，不会连带恢复其引用的 TSJ、图片或其他
文件，也不会用“创建文件前”的 checkpoint 删除文件。成功恢复前还会为当前版本再建一个
checkpoint，因此恢复本身也可逆。

## 开发与验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` 会先构建 `dist/` 并包含真实 production stdio smoke；
`pnpm test:watch` 为避免使用 stale build 而排除该单项，可随时用
`pnpm test:stdio` 单独重建并复跑。

测试覆盖路径沙箱、JSON 词法保真、revision 冲突、原子提交、checkpoint 启动对账、
全部 GID flag 组合、tile set/fill/精确 replace 与 object 编辑闭环，以及 atlas 几何、
SVG 安全预检、图片预算和
native preview 的图层选择、H/V/D、opacity、region/overlay/工作量预算与 MCP image wire
contract；TSJ 详情另覆盖稀疏分页、Tiled 1.12 tile `type`、动画采样、
collision/Wang 计数、严格 rendering 枚举、聚合扫描/256 KiB 输出预算和非法 atlas；
tile 检索覆盖 class 兼容规则、`all`/`any`、标量 property 精确比较、稀疏分页、
revision pin、扫描/查询/结果预算和 malformed metadata；
usage analysis 覆盖递归 cell/tile-object 统计、隐藏层、base-tile/变换位聚合、
密度/未使用/top 排序截断、exact read-set pin 和扫描/distinct/结果预算；
common layer update 覆盖 4 种 layer、字段映射与边界、默认字段显式插入、tint 删除、
13 种 blend mode、mixed batch、member-local source patch、no-op 与 revision conflict；
layer deletion 覆盖 leaf/nested/recursive Group、独占 plan、存活 object/list/class
reference policy、locked warning、bounded subtree summary、ID 高水位、element-local
source patch、tamper/stale revision 与 Tiled round trip；
layer move 覆盖同父 forward/backward/first/last 的最终 index 语义、根/Group 间跨父与
空目标、同位置 exact-byte no-op、Group subtree/cycle/depth 64、parent/type/index 边界、
locked/effective-locked warning、32-ID 有界摘要与 render flags、ID 高水位、
source-snapshot `JsonArrayMove`（含 BOM/CRLF/未知词法及目标 path 偏移）、
tamper/stale revision 和 Tiled 1.12 round trip；
tileset 挂载覆盖 map/现有依赖/prospective TSJ revision pin、自动 `firstgid`、重复引用、
GID 上限和局部 source patch；图层创建覆盖 4 种类型、根/Group 插入、`nextlayerid`、
tile cell 预算、prospective image pin 与单元素 source insertion；
checkpoint 恢复覆盖 exact-byte round trip、manifest/blob 篡改、prepared 状态机、目标
revision 冲突、preview/apply/replay 和恢复前二次 checkpoint；
文档 fd 读取覆盖并发覆写/增长/截断检测。`tiled://guide` 另有
list/read、空 templates、内容 revision/size 和未知 URI 契约测试；生产入口另通过真实
stdio client 覆盖配置、启动 checkpoint 扫描、tools/list、summary、tile search 和
checkpoint restore。架构与 roadmap
文档中未注册的工具或 Resources 仍是候选设计，不代表已经实现。

## 当前已知边界

- tile 编辑只重写受影响图层的 `data`，对象编辑只重写受影响图层的 `objects`（创建时
  另改 `nextobjectid`）；这些范围之外的 BOM、换行、缩进、键序、数字和字符串词法按
  bytes 保留。被明确替换的数组仍会重新排版；`tiled_create_layer` 是例外，它使用
  单元素 array insertion，只合成一个紧凑 JSON 新元素并替换 `nextlayerid`，原有同级
  元素及其他文本保持原 bytes。当前一次 create-layer change set 只能创建一个空图层，
  尚不支持在同一 preview 中继续给新 Group 添加子层；已有图层的移动与删除分别使用
  独占的 `moveLayer` / `deleteLayer` operation，不能和 create-layer proposal 混批。
- `replaceTiles` 是通用 `tiled_preview_edits` 的 operation，不新增注册工具，因此仍为
  18 个 core / 19 个含 rasterizer 的工具。它只接受非空 `from`，按包含
  transform/raw flags 的完整 encoded GID 精确匹配；
  `to:null` 才表示清空。一个 operation 的多组 mapping 同时、single-pass 求值，可选
  region 使用绝对 tile 坐标，省略时覆盖 layer bounds。每个 operation 最多 128 组映射，
  一个 change set 最多扫描 1,000,000 个 replacement 候选格，实际写入仍与 set/fill
  共用 100,000-cell 上限；零命中不会产生受影响 tile 子树或文件写入。
- `updateLayer` 是通用 edit union 的第 7 种 operation，不是已注册的
  `tiled_update_layer` standalone tool。它只修改按数字 `layerId` 找到的现有
  tile/object/image/group layer 的 11 个公共成员；不移动、不删除、不改变父 Group 或
  sibling 顺序。写回对每个实际改变的 object member 分别做 source patch，因此同一个
  change set 可以同时修改 layer member、tile `data` 和 object `objects`，而不重排整个
  layer object。插入、替换或删除的 member 之外，BOM、CRLF、缩进、键序、数字词法与未知
  字段保持原 bytes。preview 固定 operation、requested/changed fields、Group 后代影响
  标记、map revision 与完整 dependency set；apply 会重新计算摘要并做 revision CAS。
  `locked:true` 不构成写保护，若需要禁止 MCP 编辑必须由更高层策略处理。
- `deleteLayer` 是同一 union 的第 8 种 operation，但因其删除边界和 object-reference
  检查基于原始完整 map，它必须独占 change set。删除目标是直接父 `layers` array 中的
  一个完整 element：选择 Group 时 subtree 作为整体消失，不重挂 children，也不改祖先
  内容。preview 的 ID 数组是最多 32 项的样本，调用方必须使用对应 count/omitted count
  判断完整影响范围。apply 以 array-element-local source deletion 保留所有未触及 bytes，
  同时保持 `nextlayerid`/`nextobjectid` 高水位；这是已实现的删除能力，但
  `tiled_delete_layer` 仍没有作为 standalone tool 注册。
- `moveLayer` 是同一 union 已实现的第 9 种 operation，也没有
  `tiled_move_layer` standalone tool。它必须独占 change set；省略 `parentGroupId`
  才表示 root，显式 `null` 非法。`index` 是完成后的最终 JSON sibling index，同父有效
  范围 `0..n-1`、跨父有效范围 `0..m`，同位置 no-op 不写文件。Group 按完整 subtree
  移动，禁止 self/descendant cycle，结果深度上限为 64；锁只产生 advisory warning，
  preview 会区分移动前后的 effective lock 与 render-order/render-context 影响。
  apply 通过基于原 source container paths 的 `JsonArrayMove` 搬移 element 精确 bytes，
  保持未触及 lexeme 与 `nextlayerid`/`nextobjectid`，并沿用 revision/CAS/checkpoint
  安全边界。`duplicateLayer` 仍未实现。
- 删除对象会拒绝留下直接或 list 中的 `object` 属性悬挂引用；遇到可能隐藏 typed object
  reference 的 class 属性会 fail closed，复杂 class 编辑留到读取项目类型定义后实现。
- 两个 TiledMCP 写者由锁与 CAS 保护；不遵守该锁的 Tiled GUI/其他程序仍可能在最终
  revision 检查与 `rename` 之间发生极小竞态。当前请避免在 MCP 提交瞬间同时保存，
  普通 Linux `renameat2` 也不提供“按内容 hash 条件替换”；要获得严格 external-writer
  CAS，需要 FUSE/写入 broker 或让 Tiled 遵守同一锁协议。
- 现有路径检查会拒绝静态 symlink 和越界引用，但还不是 `openat2`/容器级 OS 沙箱；
  主动在调用过程中替换父目录的本地攻击者不在当前保证内。
- 崩溃遗留的 stale lock 会 fail closed，并要求确认无活跃写者后手动删除；不会冒险
  自动抢锁。启动扫描只会在目标精确等于 `afterRevision` 时把 `prepared` 补记为
  `committed`；其他状态只报告，不会自动回滚或删除。
- checkpoint 目前按内容去重，但还没有总容量配额和 GC；长期高频编辑时需要监控项目内
  `.tiledmcp/objects` 的磁盘占用。恢复当前严格限于一个已存在的安全 JSON 文档；
  checkpoint 的 manifest 意图与 blob hash/revision/size 在 apply 时都会复核，唯一允许
  的 manifest 状态变化是 preview 后由 `prepared` 前进到 `committed`。恢复不包含依赖
  闭包，也不支持通过恢复删除由某次 create 新增的文件。
- `tiled_add_tileset_to_map` 只接受项目内已经存在、通过 M1 root-atlas profile 校验的
  external TSJ。它把目标 TSJ revision 作为 prospective dependency 固定在 change set
  中，只修改 map 的 `tilesets` 数组并从当前最高 GID 区间之后分配 `firstgid`；不会修改
  TSJ、图片或既有引用，也不会创建 tile/object layer。目标 TSJ 或当前 map dependencies
  在 preview 与 apply 之间变化时会拒绝提交。响应区分实际 atlas `tileCount` 与包含
  稀疏 `tiles[].id` / `nexttileid` 高水位的 `gidSpan`；规划前最多检查 1,000,000 个
  现有 tile cell/object，防止新 GID 区间让原本无效的引用意外获得含义。
- `tiled_create_layer` 只接受有限正交 TMJ，并创建一个空的 `tilelayer`、
  `objectgroup`、`imagelayer` 或 `group`。`parentGroupId` 只能定位已有 Group；
  `index` 是目标同级数组的 0-based 插入点，省略时追加。新 ID 精确取当前
  `nextlayerid` 后递增，不会压紧空洞或修复损坏的计数器。新 tile layer 与 map 同尺寸，
  最多初始化 100,000 个空 cell。image layer 只接受项目内安全图片，图片 bytes revision
  作为 prospective dependency 在 preview 和 apply 两端复核；提交只修改 TMJ，不修改
  图片或既有图层内容。无限地图、压缩/chunk tile layer 和多图层批量创建仍不支持。
- `tiled_get_tileset` 返回有界 semantic projection：tile properties 目前只给数量，
  collision 只给对象数，Wang 只给 set 概览，不伪装成完整 TSJ。tile metadata 默认
  64 项、最多 128 项并按 local ID 分页。响应中的依赖 revision 只包含所选 TSJ 的
  `source.assetId` / `source.revision`，不复制地图的完整 `dependencyRevisions`；
  准备编辑前应从 map summary/region 取得完整 revision 前提。外部 TSJ 的 `name`
  必须是字符串，名称与其他显示字段按 Unicode code point 有界截断；`objectalignment`、
  `tilerendersize`、`fillmode` 和 `grid.orientation` 按 Tiled 1.12 枚举严格校验。
  精确 source image bytes/revision 仍由 `tiled_render_tileset_sheet` 返回。
- `tiled_find_tiles` 必须同时提供 `mapPath` 与该 map 引用的 `tilesetAssetId`，只把 TSJ
  中显式存在的稀疏 `tiles[]` 条目作为候选，不为没有 metadata 的 local ID 推导语义。
  带 per-tile image 或 image subrect override 的 hybrid/image-collection 定义不属于
  M1 atlas profile，会以 `UNSUPPORTED_TILESET` 拒绝。
  class 使用 `tiles[].type`，仅在它缺失时兼容回退到 `tiles[].class`；query 可用
  `all` / `any` 组合 `class`、`propertyExists` 和 `propertyEquals`，wire 调用省略 mode
  时默认为 `all`，比较均为大小写敏感的精确比较。`propertyEquals` 只支持显式序列化的
  `string`、`int`、`float`、`bool`、
  `color`、`file` 内建标量，并同时匹配声明类型和值；若同名目标 property 是 custom、
  object、class 或 list，整个查询以 `UNSUPPORTED_PROPERTY_QUERY` 拒绝，不把它当作普通
  未命中。结果按 local ID 分页（默认 64、
  最多 128），返回完整 `TileRef` 和命中的 clause 索引，但不返回 property value；
  不解析继承 property、Wang assignment 或语义 name。若有下一页，响应的 `nextPage`
  会带 `startTileId`、`expectedMapRevision` 与 `expectedTilesetRevision`，调用方应原样
  带回；两个 revision 输入在独立查询上是可选的，但携带它们的续页会在任一 revision
  改变时被拒绝。单次响应仍标记
  `snapshotConsistency: "non-atomic-read-set"`，不把多文件读取宣称为原子快照。
- `tiled_analyze_usage` 是无筛选的 whole-map 只读扫描，不按 visibility 或 layer ID
  裁剪；它递归统计所有 tile cell 和带 `gid` 的 tile object。聚合键只包含 external
  tileset `assetId` 与 `localId`，transform 不拆分 tile 身份，但每种 unsigned raw
  flags 及 identity/transformed 引用数会另行保留。响应中的 density、tileset/未使用
  local ID 和 top-tile 都是带 `total/returned/omitted/truncated` 或等价计数的有界摘要，
  不能把返回样本当成完整列表。扫描上限为 1,000,000 个 cell+object，distinct tile
  上限 100,000，layer/tileset 摘要各 64，top tile 默认 64、最多 128，最终 JSON
  上限 256 KiB。可选 revision guards 必须成对提供 map revision 与完整 dependency
  revision record；服务端在分析前后复核 read set，但仍明确报告非原子多文件快照。
- tileset sheet 当前只接受 PNG、JPEG、WebP 和严格受限的简单自包含 SVG（SVG 另限
  256 KiB）；拒绝动画、image collection、外部 SVG 引用、超过 64 MiB / 4096² 解码像素的输入。每页最多
  256 个 tile，输出不超过 2048 像素长边、150 万像素和 8 MiB。布局会自动减少每页容量，
  但不会偷偷缩放 tile。当前还要求 `tilecount` 精确等于 atlas 可裁出的完整 tile 数，
  因此 Tiled 中人为保留的图集外“空白 local ID”会 fail closed；尚未实现超限图片的
  持久化 Resource，因此编码后仍超限会明确报错。
- native preview v1 只渲染有限正交 TMJ 的静态外部 atlas tile layer，要求 atlas tile
  尺寸与 map grid 相同。它支持整数 scale 1–4、矩形 region、显式 tile-layer 选择、
  H/V/D（非方形 tile 的 D 暂拒绝）、layer opacity、透明色、网格和绝对坐标 gutter。
  隐式选择会把可见 object/image layer 作为 `omittedLayers` 返回并标记 `partial: true`；
  blend/tint、parallax、非零像素 offset、group opacity、动画 tile、tileoffset 和
  image collection 会稳定报 `UNSUPPORTED_RENDER_FEATURE`/`UNSUPPORTED_TILESET`，
  不会静默近似。输出上限同样是 2048 单边、150 万像素和 8 MiB，另有 3000 万次
  pixel-blend 工作量上限。多 atlas 结果中的 image revision 对应各自精确读取的 bytes，
  `snapshotConsistency: "non-atomic-read-set"` 明示这些图片并非同一时刻的原子快照。
