# TiledMCP

一个面向 [Tiled Map Editor](https://www.mapeditor.org) 的安全优先 **Tilemap MCP
服务器**。目标是让支持 MCP 的模型安全地检查、创建、编辑、验证和预览 Tiled
资产，并逐步扩展到格式转换、AutoMapping 与 Wang 地形等官方自动化能力。

## 项目状态

**核心里程碑：初期设计已实质全部落地，接口以 0.0.x Draft 发布、尚未冻结。**

当前注册 52 个不依赖 Tiled CLI 的核心工具，另有最多 3 个按本机探测注册的可选
工具（`tiled_render_map` / `tiled_preview_export` / `tiled_preview_terrain`），
合计 55 个；1400+ 测试在 `pnpm run verify` 与 `pnpm run verify:tiled-1.12.2`
双门禁下全绿。能力域概览：

- **安全地基**：项目根沙箱与 symlink 拒绝、raw bytes 权威 + SHA-256 revision
  CAS、source-preserving JSON patch、原子替换、内容寻址 checkpoint 与启动对账、
  跨文件崩溃可恢复事务。除 `tiled_create_map` 与 `tiled_create_checkpoint`
  两个明确例外，一切写入都走 preview → 批准 → apply。
- **读取与分析**：四种投影（正交/等距/staggered/hexagonal）的摘要、region、
  usage 分析；atlas 与 image-collection tileset 详情、Wang 语义展开、复杂属性
  投影、对象与模板展开读取、TMX/XML 只读核心（自研零依赖受限解析器）、JSON
  world 读取与 pattern 展开、连通性分析、无状态选区（含魔棒/多边形/组合）。
- **编辑**：18 种 mapEdit operation（tile/对象/图层/地图/引用结构），等距地图
  全线放行；Wang 写入与官方地形笔刷、项目 class/enum 定义 CRUD、语义 tile 命名
  注册表、悬空 gid 机械修复。
- **程序化生成**：确定性 shape/noise/cellular/dungeon/scatter/prefab（多层+
  翻转）/参考图导入，全部产出普通 mapEdit change set，绝不使用 Math.random。
- **视觉闭环**：native tile-layer preview（含高亮/对象调试 overlay）、四投影
  原生渲染、tileset sheet 与稀疏选集渲染、像素级 render diff；可选
  `tmxrasterizer` 整图渲染。
- **格式与导出**：TMX/TSX/TX 原生字节级写出（对照官方 writer 金标准，含
  class 属性经 `.tiled-project` 定义的无损序列化）；可选官方 CLI 导出面。

逐刀演进记录与历史行为叙述见 [docs/07-devlog.md](docs/07-devlog.md)。当前运行
能力以 `tiled_get_capabilities`、`tools/list` 与 resource discovery 为准。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/01-tiled-research.md](docs/01-tiled-research.md) | Tiled 软件调研：核心数据模型、文件格式、自动化生态、现有同类 MCP 分析 |
| [docs/02-mcp-spec.md](docs/02-mcp-spec.md) | **MCP 功能规格草案**：Tools / Resources / Prompts 清单与分期计划 |
| [docs/03-architecture.md](docs/03-architecture.md) | 技术架构：技术选型、读写策略、关键实现要点与坑 |
| [docs/04-security.md](docs/04-security.md) | **Frozen v1** direct filesystem 威胁模型与部署要求 |
| [docs/05-cross-file-wal-design.md](docs/05-cross-file-wal-design.md) | 跨文件 WAL 事务设计与决策记录（S1–S3 已实施） |
| [docs/06-infinite-edit-design.md](docs/06-infinite-edit-design.md) | 无限地图编辑设计定稿：Tiled 1.12.2 chunk 语义考证、规范化写回决策与实施切片 |
| [docs/07-devlog.md](docs/07-devlog.md) | 逐刀能力演进记录与历史行为叙述（各刀提交时的快照，计数不代表现状） |
| [contracts/mcp-contract.v1.json](contracts/mcp-contract.v1.json) | 从真实 MCP discovery 生成的双 profile 完整机器契约 |
| [contracts/application-errors.v1.json](contracts/application-errors.v1.json) | 当前 104 个 v1 application code 及其兼容性、fallback 和排除边界 |
| [docs/generated/mcp-reference.md](docs/generated/mcp-reference.md) | 自动生成的全部工具 schema、annotations 与调用参考 |
| [docs/examples/safe-workflows.md](docs/examples/safe-workflows.md) | revision 传递、批准边界、创建例外与错误处理工作流 |
| [examples/mcp-calls.v1.json](examples/mcp-calls.v1.json) | 每个已注册工具恰好一个、由公开 input schema 校验的调用示例 |

## 一句话定位

以 **TMJ/TSJ（JSON）无损读写**为地基、**官方 Tiled 1.12.2 源码语义**为对照标准
的安全优先 Tilemap MCP 服务器：一切有界、未定义语义 fail closed 不近似、写入经
preview/批准/apply 两阶段提交并全程可恢复；在此之上提供四投影读写渲染、确定性
程序化生成与字节级 XML 写出，把视觉闭环（选料 → 编辑 → 渲染自查 → 对比确认）
做成一等能力。

## 快速开始

要求 Node.js 20.19+、pnpm 11。tileset sheet、显式 tile 选集与有限正交 tile-layer region preview
都是内建核心能力，不依赖 GUI。复杂地图的高保真整图 PNG 预览仍需要本机安装
Tiled / `tmxrasterizer`。

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/index.js --project-dir /absolute/path/to/your/tiled-project
```

本机安装精确的 Tiled 1.12.2 与随附 `tmxrasterizer` 后，可运行不可跳过的真实集成门：

```bash
pnpm run verify:tiled-1.12.2
```

该门校验版本、运行时导出格式、checked-in fixture 的 JSON round-trip 与 PNG
rasterization，并确认 `tiled_create_map` 产物可由目标版本重新导出。普通
`pnpm test` 仍不把可选 Tiled CLI 变成核心 direct-JSON 能力的运行依赖。

服务使用 stdio transport；stdout 只承载 MCP 协议，诊断写入 stderr。项目根目录是必填
的 fail-closed 安全边界，也可以通过 `TILED_PROJECT_DIR` 设置。checkpoint retained
storage 默认配额为 1 GiB，可用 `--checkpoint-bytes` 或
`TILEDMCP_CHECKPOINT_BYTES` 设置规范十进制 `[1-9][0-9]*` bytes，范围
`1..9007199254740991`；运行时精确值以
`checkpointCapabilities.storagePolicy` 为准。可选
`--checkpoint-retain-per-target N` /
`TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET=N` 显式启用每目标 rolling retention，范围
`2..10000`，默认关闭；运行策略以 `checkpointCapabilities.retention` 为准。两类配置同时
提供时都由 CLI 优先于环境变量。一个通用的客户端配置为：

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

当前注册 52 个不依赖 Tiled CLI 的核心工具；本机探测到 `tmxrasterizer` 时再注册
可选的 `tiled_render_map`，探测到 Tiled CLI 时再注册可选的 `tiled_preview_export`
与 `tiled_preview_terrain`（合计最多 55 个）。下文各刀叙事段落中的"仍为 N core"
计数为当刀历史快照，以本段与契约（`contracts/mcp-contract.v1.json`）为准：

| 工具 | 作用 |
|---|---|
| `tiled_get_capabilities` | 查看实现边界、限额和本机 Tiled CLI 能力 |
| `tiled_list_files` | 列出项目内 Tiled 资产 |
| `tiled_list_world_maps` | 只读列出一个 JSON world 的显式地图成员（坐标、声明尺寸、逐成员存在性与 revision pin）；pattern 成员只计数 |
| `tiled_preview_world_edits` | 预览 world 成员的 add/move/remove（按当前数组 index 定位、world revision pin）；被引用地图文件绝不改动 |
| `tiled_list_checkpoints` | 有界列出恢复 checkpoint，并隔离报告损坏 manifest |
| `tiled_create_checkpoint` | 对 1..32 个项目文件的当前 bytes 建显式 committed 快照（不改任何资产），配合 restore 逐字节回滚 |
| `tiled_preview_prepared_checkpoint_discard` | 仅在目标仍精确等于写前状态时，固定 prepared manifest 与目标证据并生成 destructive discard change set |
| `tiled_preview_prepared_checkpoint_commit` | 仅对 prepared create 的 exact-after 来源含混状态，固定完整 manifest/目标证据并生成内部状态 commit change set |
| `tiled_preview_prepared_checkpoint_abandon` | 对机器无法自动处理的 prepared 冲突固定完整证据并生成永久删除恢复点、但不修改项目资产的 abandon change set |
| `tiled_preview_checkpoint_prune` | 固定 committed manifest revision 并生成 destructive prune change set；不直接删除 |
| `tiled_preview_checkpoint_prune_batch` | 固定 2..32 个显式 committed checkpoint 的完整 manifest pins，按 canonical ID 顺序生成可部分提交的 destructive batch prune change set；不直接删除 |
| `tiled_preview_checkpoint_restore` | 校验单文件 checkpoint 并生成 destructive 恢复 change set；不直接写盘 |
| `tiled_get_map_summary` | 读取 revision、根显示/元数据、图层树和 tileset asset id |
| `tiled_analyze_usage` | 只读统计整张地图的 tile 使用、图层密度、变换位和未使用 local ID |
| `tiled_check_connectivity` | 只读四向连通性分析：显式可通行定义（空 cell 或列举 tile 集）、连通分量统计与 from/to 可达判定 |
| `tiled_render_diff` | 只读像素级地图 diff：同 region 两次 native 渲染逐像素对比（差异红色高亮、cell 粒度聚合），双侧可各选图层 |
| `tiled_get_tileset` | 按 map + asset id（或内嵌条目的 `embeddedIndex`）读取有界 atlas/稀疏 tile metadata（含 per-tile 标量属性值）/Wang 语义展开 |
| `tiled_find_tiles` | 按 map + asset id 精确检索显式 class/property metadata，返回分页 `TileRef` |
| `tiled_get_region` | 用 `TileRef` 读取有界矩形区域 |
| `tiled_render_tileset_sheet` | 按 `tilesetAssetId` 返回带 local ID 的分页 PNG sheet |
| `tiled_render_tiles` | 按输入顺序放大并标注 1–64 个显式、稀疏的 atlas local IDs |
| `tiled_render_preview` | 内建渲染有限正交 tile layer，可选 region、图层、网格、坐标、有界矩形高亮和显式对象几何调试叠层 |
| `tiled_list_objects` | 有界列出全部或指定 object layer 的对象 |
| `tiled_get_object` | 按全图唯一 object ID 读取一个有界、严格判别的可编辑对象详情，并按文档序回读标量自定义属性（复杂/超长条目以 `valueOmitted` 标记） |
| `tiled_validate` | 只读结构与 MVP profile 校验 |
| `tiled_create_map` | 新建有限正交 TMJ，已有文件绝不覆盖 |
| `tiled_create_tileset` | 预览从项目图片新建 external atlas TSJ；不直接写盘，apply 绝不覆盖已有文件 |
| `tiled_delete_file` | 预览删除一个 TMJ/TSJ；引用扫描 fail closed，apply 先提交 checkpoint 再删除（可恢复） |
| `tiled_add_tileset_to_map` | 预览把已有 external atlas TSJ 挂到 map；不直接写盘 |
| `tiled_update_tile` | 预览单个已引用 TSJ 的 per-tile probability/class/动画/标量属性/碰撞形状元数据更新与 collection 条目创建/删除；不直接写盘 |
| `tiled_update_wangsets` | 预览单个已引用 atlas TSJ 的 Wang 编辑：新建 wang set/追加颜色/按 `setWangId` 语义批量分配 wangtile；不直接写盘 |
| `tiled_create_layer` | 预览创建一个空 tile/object/image/group 图层；不直接写盘 |
| `tiled_preview_edits` | 校验 map/tile/object/layer/tileset-reference 编辑并生成有 TTL 的 change set |
| `tiled_preview_shape` | 确定性几何画笔：Bresenham 线段/矩形描边与填充/中点椭圆，产出普通 `setTiles` change set；出界与超 10,000 cell fail closed |
| `tiled_preview_generate` | 确定性 seed 程序化生成：value noise/细胞自动机洞穴/rooms-and-corridors 地牢（地板全连通）+ 区间映射 tile，产出普通 `setTiles` change set；同 seed 同输出、绝不用 Math.random |
| `tiled_preview_scatter` | 确定性密度散布：坐标 hash 逐格判定 + 加权 tile 选择（可跳过已占用格、null 选择为擦除），产出普通 `setTiles` change set；同 seed 同输出、平移稳定 |
| `tiled_preview_import_image` | 参考图导入：图片重采样到格网（alpha 加权块平均）+ 最近 palette 色映射 tile，产出普通 `setTiles` change set；全透明块跳过、null 色为擦除、纯整数确定性 |
| `tiled_preview_prefab` | 预制件盖章：把源地图一块区域（tile 连区域内锚定的 object）在规划期物化为普通 `setTiles`+`createObject` 操作盖到目标位置；`extraTileLayers` 一次盖多层对、`flipHorizontal` 按官方 TileLayer::flip 位语义水平镜像（仅 tile 层，与 objects 同用 fail closed）；apply 不回读源 |
| `tiled_preview_template` | 以 Tiled 最小序列化形态（`{id, template, x, y}`）放置一个 JSON `.tj` 模板实例；模板经与读取相同的 fail-closed profile 校验并 pin revision，apply 复核 pin 与相对引用解析 |
| `tiled_list_property_types` | 读取 `.tiled-project` 的 class/enum 定义——复杂属性类型注解的权威来源 |
| `tiled_preview_property_types` | 预览项目 class/enum 定义的 upsert/delete（id 分配对照官方 `++mNextId`；被定义间引用的类型删除 fail closed） |
| `tiled_render_isometric` | 等距地图原生渲染：按官方 IsometricRenderer 坐标变换把区域画成菱形 PNG（对角线扫描序、tile 底左锚定）；collection/透明色/反对角翻转/image/group 层 fail closed，object 层跳过并披露 |
| `tiled_render_hexagonal` | staggered/hexagonal 原生渲染：官方 HexagonalRenderer 变换（staggered 为 hexSideLength=0 退化情形），行序合成；hex 旋转位 fail closed |
| `tiled_preview_write_tmx` | 原生受限 TMX 写出：把 `.tmj` 序列化为与 Tiled 1.12.2 官方 writer 字节级一致的 `.tmx` 新文件（同目录、no-replace、无需 CLI）；自定义属性支持 string/int/float/bool/color/file/object（官方 writeProperties 字节序；TSX 的 tileset 级属性同样放行），class 型属性经可选 `projectFilePath` 无损写出（propertytype+嵌套成员按 project 定义定型、revision pin 至 apply、`--project` 金标准对拍），缺 project 时与 enum 注解、其余 profile 外结构、丢精度浮点 fail closed |
| `tiled_preview_write_tsx` | 原生受限 TSX 写出：把 `.tsj` atlas 序列化为与官方 writer 字节级一致的 `.tsx` 新文件；声明网格必须与图片尺寸自洽（官方会重算），per-tile 元数据/wang/属性 fail closed |
| `tiled_select` | 无状态选区：按 tile 集合/空/非空/魔棒（种子四向泛洪同 baseGid 连通区）/像素多边形（cell 中心偶奇规则）/compose（≤8 步并/交/差组合）谓词扫描有界区域，`sampleLimit` 可升到 10,000（对齐 setTiles cell 预算，选区全量直喂编辑），返回精确计数+紧包围盒+有界坐标采样；无 selectionId 无服务端状态 |
| `tiled_list_tile_names` | 读服务端自有 `.tiledmcp/tile-names.json` 语义命名注册表：name → {tileset, localId}，逐 tileset pin revision，缺文件读作空 |
| `tiled_preview_tile_names` | 预览语义命名注册表的 upsert/delete（专用 `tileNameEdit` change set）：pin 注册表 revision（或其缺失）、upsert 校验 tileset 存在、apply 按批准内容 hash 重放；绝不碰 Tiled 资产。注册名可在 shape/generate/scatter/select 的 tile 位直接以 `{"name": ...}` 引用，服务端经 map binding 解析并 fail closed |
| `tiled_preview_validation_fixes` | 机械校验修复：把所有悬空 gid cell 汇成可审批的 `setTiles` 擦除 change set；零问题或 >10,000 cell fail closed，悬空 tile object 只报告不代删 |
| `tiled_preview_write_tx` | 原生受限 TX 写出：把 `.tj` 模板序列化为对照 writeObjectTemplate 的 `.tx` 新文件（基对象不写 id/x/y）；tile/嵌套模板 fail closed |
| `tiled_preview_transaction` | 把 2..16 个已批准、目标路径两两不同的文档提交类 change set 组合成一个原子事务 change set，并锁定成员禁止单独 apply |
| `tiled_apply_change_set` | 以对应 revision guard 提交已批准的 map edit、跨文件事务、checkpoint restore、prepared-checkpoint discard/commit/abandon、单项或 batch committed-checkpoint prune |
| `tiled_render_map` | 可选；本机有 `tmxrasterizer` 时返回带 map/TSJ/output/renderer 可追溯元数据的 PNG |
| `tiled_preview_export` | 可选；本机有 Tiled CLI 时经官方 `--export-map`/`--export-tileset` 在服务端 staging 转换项目 `.tmj`/`.tsj`，返回携带输出内容 hash 的 `fileExport` change set，apply 重放导出并逐字节验证后以 no-replace 创建落盘 |
| `tiled_preview_terrain` | 可选；经受控 `tiled --evaluate` 调用官方 `TileLayer.wangEdit()` 地形笔刷匹配器于 staging 副本，diff 后返回普通 `mapEdit` change set（精确 `setTiles`），apply 不重跑 CLI |

`tiled_render_map` 的成功结果使用 pre-Frozen clean break，不再返回 `mapPath`、`bytes`、
`width` 或 `height` aliases。必填字段是 `mimeType`、`pixelSize`、`byteLength`、
`sha256`、`map`、`dependencyRevisions`、`renderer`、`options`、
`snapshotConsistency` 和 `truncated`。`pixelSize`、`byteLength`、`sha256` 与 MCP
`image` content 都来自同一个不超过 8 MiB 的 PNG buffer；`renderer` 固定报告
`tmxrasterizer`、启动时探测的版本与 `tmxrasterizer-png-v1` profile，`options` 返回实际
生效的 `size` 和 `ignoreVisibility`。

渲染前后会复核 map 与全部 external TSJ revisions，`dependencyRevisions` 仍只覆盖这些
TSJ。root atlas、per-tile image 和 image-layer 引用按规范化项目路径统一去重：最多 64 张，
原始 bytes 合计最多 64 MiB、解码像素合计最多 16,000,000，任一图片单边最多 8192 px。
服务端在渲染前后分别读取这些图片的一致单文件 snapshot，并比较内部的完整路径/revision
集合；这些图片 revision 有意不出现在公开结果中。`tmxrasterizer` 仍直接读取 live files，
而且 pre/post 相等不能排除渲染期间发生又恢复的 ABA。因此结果固定标记
`snapshotConsistency: "non-atomic-read-set"`，不能把它解释为 map、TSJ 与图片的原子快照。

所有已注册工具都公布自己的精确、封闭 output schema。正常 handler 结果的统一外层是
`{"result": <该工具的成功结果>}`；合法输入触发的领域/应用错误设置 `isError: true`，并
返回
`{"result":{"ok":false,"error":{"code":"…","message":"…","details":{}}}}`。
应用错误码的精确 wire 位置是 `structuredContent.result.error.code`。当前 v1 注册表包含
104 个 application code；机器 artifact 是
[`contracts/application-errors.v1.json`](contracts/application-errors.v1.json)，运行时
同一内容可从 direct Resource `tiled://application-errors` 读取，并由
`tiled_get_capabilities.applicationErrorContract` 公布 URI、revision、size、fallback 和
兼容策略。`INTERNAL_ERROR` 是未预期 handler 失败的安全 fallback。v1 中既有标识符及其
含义保持稳定，但未来 server 可以新增 code；客户端遇到未知 code 时应按通用应用错误安全
处理并刷新 discovery，不得把它误判为成功。

控制流只能依赖已发现的 `error.code`，不能匹配人类可读的 `message`，也不能假设
`details` 存在任何稳定字段。该 application registry 不包括 MCP SDK input error、
`cli.*.issues[].code` capability-probe 诊断、startup fatal error、`tiled_validate`
diagnostics、checkpoint reconciliation diagnostics 或原始 OS error code；这些表面各自
遵循独立契约。

查询/渲染结果、map-edit preview、checkpoint-restore preview、`tiled_create_map` 的
commit 结果以及 `tiled_apply_change_set` 的 apply 结果是不同的类型，不能把它们当成同一
`MutationResult`。输入在进入 handler 前被 MCP SDK schema 拒绝时只有 text error，不带
`structuredContent`。

进入 handler 后的成功与应用错误还会返回一个最大 1024-byte 的 compact one-line JSON
text summary。v1 success summary 只给 `kind`、`version`、`ok` 和完整
`structuredContent` 的 UTF-8 JSON byte count；图片工具另给图片的 `mimeType` 与实际
inline image bytes。error summary 给稳定 `code`、有界单行 `message`、可选
`messageTruncated` 和 structured byte count，不复制错误 `details`。客户端不得从摘要
恢复字段；`tiled_get_capabilities.textContentContract` 公布当前版本、编码、限额和完整
结果位置。SDK 在 handler 前产生的 input-schema error 仍是 SDK-owned text-only 响应，
不使用这套应用层摘要 envelope。

当前 direct Resource：

| URI | 类型 | 作用 |
|---|---|---|
| `tiled://guide` | `text/markdown` | 串联能力发现、sheet/preview 检查、change set 客户端批准、提交与提交后复核；内容带 SHA-256 revision 和 UTF-8 byte size |
| `tiled://application-errors` | `application/json` | 当前 104 个 v1 application code，以及 wire location、`INTERNAL_ERROR` fallback、兼容策略和排除边界 |

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
每个 operation 最多 128 组映射；一个 change set 的 replacement、flood fill 与
`copyRegion` 合计最多执行 1,000,000 次实际 GID 读取，实际发生的替换与其他 tile
operation 合计最多写
100,000 个格子。
没有命中是合法 no-op，preview 会报告 0 次替换，apply 不会改写文件。

对象编辑继续通过通用 `tiled_preview_edits` 的 `createObject`、`updateObject` 和
`deleteObjects` operations 提供；另有只读 `tiled_get_object` 用于在替换/删除 path
对象或覆盖 text 内容前取得完整、有界的语义投影，所以 registry 为
不新增注册工具。`createObject.object` 是按 `shape` 判别且拒绝额外 key
的 strict union：

- `rectangle` 保持现有可选 `width` / `height` 契约；
- `point` 不接受尺寸；
- `ellipse` 与 Tiled 1.12 `capsule` 的 `width` / `height` 都可省略，省略时按 Tiled
  语义写为 0；显式值必须有限、非负且不超过 `1,000,000,000`；
- `polygon` 要求 3–256 个、`polyline` 要求 2–256 个 strict `{x,y}` points。
  点是相对 object `x/y` anchor 的本地像素坐标，每轴必须为
  `[-1,000,000,000,1,000,000,000]` 内有限数，并原序保存；polygon 隐式闭合，
  polyline 保持开放。这两类 wire 禁止 `width` / `height`，TMJ 中规范化写为 0。
- `text` 要求扁平 `text` 字符串，允许空串；可选 `fontFamily`、`pixelSize`、`color`、
  `bold`、`italic`、`underline`、`strikeout`、`kerning`、`wrap`、
  `horizontalAlignment`、`verticalAlignment` 与尺寸。内容最多 4,096 个 Unicode
  scalar / 16,384 UTF-8 bytes，只允许 TAB/LF/CR 三种控制字符；字体族为 1–256
  scalars / 1,024 bytes 且不允许控制字符，二者都拒绝未配对 surrogate。

创建后，ellipse/capsule 分别在 TMJ object 中序列化唯一的
`ellipse:true` / `capsule:true` marker，path 则只写对应的 `polygon` 或 `polyline`
数组；text wire 则映射为唯一的 nested `text:{text,...}`，并按 TMJ 默认值稀疏省略
样式字段。七类对象都能继续使用现有
`updateObject` 与 `deleteObjects`；update 不提供 shape 字段，不能把一种形状变成另一种。
polygon/polyline 的 `patch.points` 会整体替换当前路径数组，并允许与 common fields
同批出现；它不支持 append、splice 或按 index 修改，仍拒绝 width/height update。
object-update preview 的 `changedFields` 是 patch key 的去重字典序精确列表，表示请求
字段而非语义 diff；即使 points 与现值相同，仍会列出 `points`，最终 apply 才折叠为
exact-byte no-op；若同一 change set 没有其他实际变化，则返回 `changed:false`。
text 可局部更新内容、样式和尺寸，text-specific patch 命中其他形状会拒绝。ellipse/capsule
的尺寸更新继续接受 0，但拒绝负数、非有限数和超限值。
`updateObject.patch.properties` 对对象自定义属性做有界标量 set/remove，与
`tiled_update_tile` 共享同一写入 profile：每次最多 32 set + 32 remove、可写
string/int/float/bool/color/file、编辑后单对象最多 128 条、按 name 字典序插入
（存量非升序则插入 fail closed）；class/enum/list/object 目标 fail closed，
未触碰的复杂条目逐字保留，清空后的 `properties` 成员整体删除；单 change set
的属性写入合计 ≤256 KiB canonical JSON UTF-8（`objectPropertyUpdateCapabilities`
公布全部策略）。preview/apply
继续固定 map 与完整 dependency revisions，只重写目标 object layer 的 `objects`
member；创建时另推进 `nextobjectid`。
`tiled_get_capabilities.objectShapeCapabilities` 明确公布可创建形状、path 点数/
坐标/闭合与完整数组替换语义、禁止 shape mutation、text 字段/默认值/Unicode 与 payload
预算，以及局部 patch 范围。每个 path create 或 points replacement 都按完整 payload
逐项计入共享预算：单 change set 最多 8,192 点，pending registry 合计最多 65,536 点；
相同值 no-op、later-wins 或后续 delete 均不抵扣。单 change set 的所有
text-specific flat fields 以 canonical compact JSON UTF-8 计费，最多 256 KiB；
pending registry 合计最多 2 MiB。

内建 `tiled_render_preview` 的基础画面仍只绘制 tile layers；它会报告但不完整绘制
object layers。需要核对受支持对象的锚点与几何时，可在 `overlays.objectIds` 显式传入
1–64 个全图唯一 object ID；这不会受 object/layer visibility 或 opacity 影响。
rectangle、point、polygon 与 polyline 使用固定 cyan 单像素轮廓和 5px 原点十字，
text 只画旋转后的 layout box，不渲染 glyph，因此不能用于确认字体、换行或对齐。
ellipse 与 Tiled 1.12 capsule 也使用同一轮廓样式，并按 output-space chord error
自适应细分。tile object 以 `tile-frame-only` 画 Tiled 1.12.2 的 object outline
矩形与锚点十字：alignment 取 tileset `objectalignment`（缺省在正交地图解析为
bottom-left）、tileoffset 按 objectSize/tileSize 缩放、缺省尺寸默认为 tile 尺寸，
flip 位不改变轮廓（与 Tiled 自己的 outline 一致）；不渲染 tile 图像，
dangling GID 与非法 alignment/tileoffset fail closed。再传
`overlays.tileObjectCollision:true`（必须与 `objectIds` 同用）可按 Tiled
"Show Tile Collision Shapes" 的同一 fragment 变换叠加所选 tile 的碰撞形状轮廓：
缩放、H/V/D flip、90° 旋转与缩放后 tileoffset 与图像完全一致，碰撞对象自身
x/y/rotation 先于 tile 变换应用，`visible:false` 也照画；entry 变为
`tile-frame-and-collision` 并回显 `collisionObjectCount`。碰撞对象含
gid/template、marker 冲突或 tileset 非默认 `fillmode` 一律 fail closed。
template 对象继续 fail closed。需要完整 object-layer、字体、tile 图像视觉语义时，
仍应使用实际 discovery 到的可选 `tiled_render_map` 或 Tiled 1.12.2。

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
它不是新的 standalone MCP tool，不改变注册工具数。

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
注册工具数不变。

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
map revision 与完整 dependency revisions，apply 重验摘要并在锁内执行 revision guard
（对合作写者构成 CAS）；实际写入前照常创建内容寻址 checkpoint。它没有
`tiled_move_layer` standalone tool，不改变注册工具数。


复制已有图层使用 generic union 的第 10 种 operation：
`{type:"duplicateLayer", layerId, destination?, name?}`。它也必须独占 change set，且
没有 `tiled_duplicate_layer` standalone tool，不改变注册工具数。
`destination` 是以下三个 strict 分支之一：

- `{kind:"sameParent", index?}`：目标为原直接父；省略 `index` 时插在原
  `sourceIndex + 1`；
- `{kind:"root", index?}`：目标为 map 根 `layers`；省略 `index` 时 append；
- `{kind:"group", parentGroupId, index?}`：目标为指定 Group；省略 `index` 时 append。

整个 `destination` 省略时等价于无 index 的 `sameParent`。显式 `index` 是插入完成后的
最终 0-based JSON sibling index，范围为 `0..目标数组原长度`，不做 clamp。Group 会复制
完整 subtree；不能复制到自身或任一 descendant 内，结果深度不能超过 64。可选 `name`
最多 1024 characters（允许空字符串），只覆盖**副本 subtree root** 的名称，不改后代或
source。

新 layer ID 从原 `nextlayerid` 起、新 object ID 从原 `nextobjectid` 起，均按 subtree
preorder 连续分配；计数器推进到新的高水位，不填历史 gap。副本没有 object 时
`nextobjectid` 保持原 bytes 不变。typed `object` property 以及 Tiled 1.12 可嵌套
`list` 中的 object item：指向副本内部对象时重连到新 ID，指向 source subtree 外仍存在的
对象或 `0` 时原值保留，dangling ID 则拒绝。普通 integer property 不会被猜成 layer/object
reference；非标准 typed layer reference、class property 与 object template 均 fail
closed。image-layer `image` 和 `file` property 继续共享原外部文件，不复制文件；tile
object 的 GID 会按现有 tileset binding 校验，包含 transform flags 的原值保留。

`locked` 仍只是 advisory metadata，不阻止复制。preview 会按目标祖先 Group 计算
`effectivelyLockedLayerCount`，并给出 warning。`duplicatedLayers` 的每项精确回显
`operationIndex`、`sourceLayerId`、`createdRootLayerId`、`layerType`、`name`、
`nameTruncated`、`sourceParentGroupId`、`targetParentGroupId`、`sourceIndex`、
`targetIndex`、`copiedLayerCount`、`descendantLayerCount`、`copiedObjectCount`、
`allocatedCellCount`、`serializedDuplicateBytes`、`layerIdMappingSample`、
`omittedLayerMappingCount`、`objectIdMappingSample`、`omittedObjectMappingCount`、
`remappedInternalObjectReferenceCount`、`retainedExternalObjectReferenceCount`、
`fileReferenceCount`、`tileObjectCount`、`lockedLayerCount`、
`effectivelyLockedLayerCount`、`renderOrderMayChange`、`renderContextMayChange` 与
`affectsDescendants`。两种 ID mapping sample 各最多 32 项，必须结合 omitted count
理解。

复制后全图最多 10,000 layers、100,000 objects；单次最多复制 10,000 objects 和
100,000 个有限未压缩 tile cells，最终深度最多 64。新副本的紧凑 JSON 最多 16 MiB，
预估写回后的 TMJ 仍须不超过 64 MiB。source writer 只插入一个紧凑的新 JSON element，
并对实际变化的 `nextlayerid` / `nextobjectid` 做 value-local counter patch；原 source
subtree、既有 siblings、未知字段、BOM、CRLF、键序与数字/字符串词法保持原 bytes。
apply 会重算目标、分配、引用和摘要，校验 change-set digest 与 map/dependency revision，
随后在正常锁内执行 raw-byte revision guard（对合作写者构成 CAS）、创建 checkpoint 并
原子替换。

盖章写入使用 generic union 的第 11 种 operation：
`{type:"stampPattern", layerId, x, y, pattern:(TileRef|null)[][]}`。它没有
`tiled_stamp_pattern` standalone tool，不改变注册工具数。
`pattern` 必须是非空、稠密、矩形、row-major 的二维数组：每行非空且等宽，
不能有 sparse hole/`undefined`。每条边最多 256 格，总格数最多 16,384。

`x/y` 是图案左上角的绝对 tile 坐标。完整目标矩形必须落在目标有限 tile layer 的 bounds
内；服务端不会裁剪。矩阵中的每一项都是一次明确写入：`TileRef` 写入完整 encoded GID，
`null` 写入 GID 0、明确清空该格，不表示透明或跳过；当前没有 transparent/skip sentinel。
一个 change set 按 operation 顺序执行，后面的 operation 看到前面的结果；重叠时后写者
获胜，包括 stamp 与 `setTiles`、`fillRegion`、`replaceTiles` 或其他 stamp 的组合。

每个 pattern cell 都计入所有 tile operations 共用的 100,000-cell change-set 写入预算，
即使目标当前已经是相同值。preview 的 `sample` 只按 row-major 返回前 8 格的绝对
`{x,y,tile}`（包括 `tile:null`），并以 `omittedCellCount` 表示其余格数；完整影响范围应以
规范化 `region`、`cellCount` 和各项 count 为准。写回只局部替换目标 layer 的 `data`；
若所有编码后的 GID 都与原数据相同，则是语义 no-op，apply 返回 `changed:false`，revision
与文件 bytes 完全不变。整块清空仍直接使用 `fillRegion` 的 `tile:null`，不需要独立
`clearRegion` operation。

油漆桶填充使用 generic union 的第 12 种 operation：
`{type:"floodFill", layerId, x, y, tile:TileRef|null}`。它没有
`tiled_flood_fill` standalone tool，不改变注册工具数。
`x/y` 是目标有限 tile layer 中的绝对 seed 坐标；连通性固定为四向，不接受对角连接或
connectivity 参数。

source 在执行到该 operation 时从 seed cell 推导，并按完整 unsigned encoded GID 精确
匹配，包含 transform/raw flags；同一 base tile 的不同翻转不会混入。`tile:null` 可清空
相连区域，空 seed 也能用非空 `TileRef` 填充。若 source 与 target 编码相同，planner
只读取并验证 seed 后立即报告 no-op，不扫描整个区域。

flood fill 与同一 change set 中的其他 operation 按顺序执行：它会看到前序
set/fill/stamp/replace/flood/copy 的结果，后序 operation 则可覆盖本次填充。扫描中的
每次实际 GID 读取都计入 replace + flood + copy 共用的 1,000,000-read 上限；同一个已填
cell 或边界邻格
可能因四向遍历被重复观察，所以 `scannedCellCount` 是实际读取次数，不是 distinct cell
数。所有被观察 GID 都会完整反向解析，malformed、带 flags 的空 GID 或未绑定值会
fail closed。实际改变的 cell 计入共享 100,000-cell 写预算。

preview 只回显 canonical `sourceTile` / `targetTile`、`scannedCellCount`、
`changedCellCount`、固定的 `connectivity:"four-way"`、绝对 seed 和
`affectedBounds`；bounds 是变化区域的外接矩形，不是完整 cell 列表，无变化时为
`null`。写回只局部替换目标 layer 的 `data`；若整个 plan 最终没有净变化，apply 保持
revision 与文件 bytes 完全不变。

修改 map 根级显示/元数据字段时，使用 generic union 的第 13 种 operation：
`{type:"updateMap", patch}`。它不注册 `tiled_update_map` standalone tool，所以 registry
不改变注册工具数。operation 与 patch 都拒绝额外 key，patch 必须非空，
且只能包含：

- `renderOrder`：`right-down`、`right-up`、`left-down`、`left-up` 之一，写入
  `renderorder`；
- `backgroundColor`：`#RRGGBB`、`#AARRGGBB` 或 `null`；`null` 删除
  `backgroundcolor`；
- `className`：最多 1024 个 Unicode code points 的字符串，写入 `class`。

`tiled_get_map_summary` 始终返回规范化 `renderOrder`（缺失时为 Tiled 默认
`right-down`），并在序列化成员存在时返回 `backgroundColor` 与 `className`。
已有 class 超过 1024 个 Unicode code points 时安全截断并设置
`classNameTruncated:true`；无效的 render order、背景色或非字符串 class 会 fail
closed，不产生伪摘要。

operations 严格依序作用于同一工作副本，后面的 `updateMap` 会看到并覆盖前面的结果；
与其他可混批 operation 重叠时同样 later wins。summary 的 `mapUpdates` 项以
`operationIndex` 关联；operation preview 以数组位置关联。二者都回显
`requestedFields`、`changedFields`、`wouldChange` 与 `renderingMayChange`；
只有实际改变 `renderOrder` 或 `backgroundColor` 才提示可能改变渲染，class-only
update 不置位。

change detection 以根对象 member 的实际存在性和值为准：写入相同值、删除原本缺失的
`backgroundcolor` 都是 no-op；缺失字段即使等于 Tiled 默认值，显式插入仍算 change。
apply 只对实际变化的根对象 member 做 insertion/replacement/deletion，不重排完整 TMJ；
顺序 operation 最终还原原始根对象时是 exact-byte net no-op，不改变 revision。

移除 map 中一个当前 external atlas binding 时，使用 generic union 的第 14 种 operation：
`{type:"removeTilesetFromMap", tilesetAssetId}`。operation 是拒绝额外 key 的 strict
object，并且必须独占 change set；它不注册 standalone tool，所以 registry 仍为
不改变注册工具数。`tilesetAssetId` 必须精确匹配当前 map summary 返回的
opaque asset ID，不能用路径、名称或自行推导的 ID 代替。

planner 会递归扫描全图每个有限 tile layer cell 和每个 object layer object，包括隐藏、
锁定及任意 Group 后代；带 `gid` 的 tile object 与 tile cell 都按完整 encoded GID
反向解析。tile cells 与 objects 合计最多扫描 1,000,000 项。目标 binding 只要有一次
引用就以 `TILESET_IN_USE` 拒绝整个 proposal，不清空 cell、不删除 tile object，也不把
引用重映射到其他 tileset。对象只要带 `template` member 就会以
`UNSUPPORTED_TILESET_REMOVAL_TEMPLATE` fail closed，因为未固定的外部模板可能隐藏 tile
object/GID。

成功 plan 的 `summary.removedTilesets[]` 以扁平字段固定 `operationIndex`、`assetId`、
`tilesetPath`、`source`、`tilesetRevision`、`name`、`nameTruncated`、原 `tilesets`
array `index`、`tileCount`、`gidSpan`、`firstGid`、`lastGid`、
`scannedCellCount` 与 `scannedObjectCount`。对应 operation preview 不含
`operationIndex`，而是按 operations 数组位置关联；其完整 shape 是顶层
`type` / `destructive` / `warning` / `source` / `index`，以及
`tileset:{kind,assetId,path,revision,name,nameTruncated?,tileCount,gidSpan}`、
`gidRange:{first,last}`、`scanned:{tileCells,objects}`。其中
`tileset.nameTruncated` 只在值为 true 时出现。apply 从 pinned map 重新加载并复核
**移除前的完整**
`dependencyRevisions`，重做解析、零引用检查、扫描预算和摘要；提交只从 TMJ 的
`tilesets` array 删除目标 element，其他 binding 的 `firstgid` 与 source bytes 不变。
它不会删除 TSJ、atlas 图片或其他文件。

在同一 map 的有限 numeric tile layers 之间复制矩形时，使用 generic union 的第 15 种
operation：
`{type:"copyRegion",source:{layerId,x,y,width,height},destination:{layerId,x,y}}`。
operation、`source` 与 `destination` 都是拒绝额外 key 的 strict object；source 和
destination layer 必须是 finite、orthogonal、未压缩 numeric-array tile layer。
坐标均为 layer 空间中的绝对 tile 坐标，完整 source 与由相同 width/height 推导出的
destination 矩形都必须落在各自 bounds 内。服务端不会 clipping、wrap、透明跳过或
部分复制。

planner 在 operation 开始时先快照完整 source 与 destination，再执行任何写入。因此同一
layer 内的重叠复制固定为 snapshot-source memmove 语义，不会因 row-major 写回把已覆盖值
继续传播。source 中每个 GID（包括 0）都会原样覆盖对应 destination：GID 0 会明确清空
目标格，不是 skip sentinel；非零值连同 H/V/D 和 raw flags 的完整 unsigned encoded GID
精确复制。source 和 destination 的每个 observed GID 都先按当前 binding 完整反向解析，
malformed、flag-only empty、gap 或未绑定值均 fail closed。

`copyRegion` 可与其他 generic operations 混批。它在开始时看到所有前序 operation 的
结果，后序 operation 可覆盖 copy 的 destination，统一采用 sequential
change-set-order/later-wins。每个 copy 的 `scannedCellCount = 2 * cellCount`，source 和
destination 两次读取都计入 replace/flood/copy 共用的 1,000,000-read scan budget；
完整 `cellCount`（包括写入相同 GID 的位置）计入所有 tile operations 共用的
100,000-cell write budget。

plan 的 `summary.tileCopies[]` 固定字段为 `operationIndex`、
`source:{layerId,x,y,width,height}`、`destination:{layerId,x,y,width,height}`、
`scannedCellCount`、`cellCount`、`sourceNonEmptyCellCount`、`changedCellCount`、
`overwrittenNonEmptyCellCount`、`clearedCellCount`、`overlapsSource` 与
`wouldChange`。operation preview 使用同样字段但不重复 `operationIndex`，另含
`type:"copyRegion"`、`destructive:true` 和 `warning`，且不返回 cell list/sample。
`sourceNonEmptyCellCount` 是 source snapshot 的非零 GID 数；
`overwrittenNonEmptyCellCount` 是 operation-start destination snapshot 的全部非零 GID
数，无论对应格最终是否变化；`changedCellCount` 只统计 source/destination 值不同的格子，
`clearedCellCount` 则统计其中由 source GID 0 实际清空的非零 destination。
`destination.width/height` 是由 source 规范化补齐的尺寸。即使最终所有 GID 已相同，完整
copy intent 仍计入 scan/write budget，但 `changedCellCount:0`、
`wouldChange:false`；整个 plan 无其他净变化时保持 exact bytes。

`tiled_get_capabilities.tileCopyCapabilities` 将该契约固定为
`coordinates:"absolute-tile-coordinates"`、`clipping:false`、
`overlap:"snapshot-source-memmove"`、`emptySource:"overwrites-and-clears"`、
`gidCopy:"exact-encoded-gid"`、
`observedGidValidation:"source-and-destination-fail-closed"`、
`operationOrdering:"sequential-change-set-order-last-write-wins"`、
`scanBudget:"shared-with-replaceTiles-and-floodFill-per-change-set"` 与
`sourcePatch:"destination-tile-layer-data-member-local"`。apply 从 pinned map 重算
快照、GID 校验、预算和摘要；copy 执行时实际发生变化的 destination tile layer 才进入
`data`-member-local source patch 候选。若后序 operation 恢复原值，最终 source diff
仍折叠为 exact-byte no-op。该 operation 不注册 standalone tool，不改变注册工具数。

更新单个已引用 TSJ 的 per-tile 元数据时，使用专用 preview 工具
`tiled_update_tile`（首个 TSJ 写入面）：以 `mapPath + tilesetAssetId` 定位、同时
pin `expectedMapRevision` 与 `expectedTilesetRevision`，传入 1..64 个唯一 `tileId`
的 `updates`。字段语义与 Tiled 1.12.2 逐条对齐：`probability` 设为 `null`/`1` 即
移除成员；`className` 更新已有 `class` 成员、否则写 canonical `type`（两者并存
fail closed），`null` 移除；`animation` 以 `{tileId, durationMs}` 帧数组全量替换
（每 tile ≤256 帧、帧 id 必须在 tilecount 内），序列化为 Tiled 的
`[{tileid, duration}]`。无条目的 tile 按升序插入新条目、仅剩 `{id}` 的条目删除、
`tiles` 根成员按需插入/移除——与 Tiled 的省略语义一致；**创建或删除条目的更新必须
独占整个 change set**。`properties` 另支持有界标量 set/remove（string/int/float/
bool/color/file，与搜索侧可比较类型对称；class/enum/list/object 目标 fail
closed，未触碰的复杂条目保留；新属性按名字典序插入）。`collision` 以 1..128 个
有界基础形状（六类几何，polygon/polyline 每形状 ≤256 点、单 change set 合计
≤8,192 点）整体替换 tile 的 `objectgroup.objects`，`null` 整体移除该成员——语义
对齐 Tiled 1.12.2 碰撞编辑器：新对象 id 从既有最大 id 之后连续分配、既有容器其余
成员逐字保留、新容器写 canonical `draworder:"index"`；整体替换会丢弃旧对象携带的
自定义属性。返回的 `tilesetEdit` change set 以 **TSJ revision** 作为
`expectedRevision`，apply 只提交 TSJ；map 不被改写，但 pin 旧 tileset revision 的
待批 map change set 会随之冲突。未触及的条目、未知成员与 version 戳保持原 bytes。

新建 tileset 用 `tiled_create_tileset`（preview→apply，direct 创建特例条款保持仅
`tiled_create_map`）：从项目内已有图集图片规划一个新 external `.tsj`，按 Tiled
1.12.2 的单边 margin 整除公式算 columns/rows/tilecount（不足一个 tile fail
closed，右/下余量在 summary 回显），成员按 Tiled QJson 字母序落盘并带冻结的
`version:"1.10"`/`tiledversion:"1.12.2"` 戳。返回的 `tilesetCreate` change set
以域分隔 digest 签名并 pin 图片 path+revision；`expectedRevision` 是**批准的
prospective TSJ bytes 的 SHA-256**（无既有文件可 pin）。apply 重读图片、重放构建、
要求内容与 summary 完全一致后，走与 create_map 相同的 hard-link no-replace 创建：
已有目标（含字节相同）一律 `FILE_ALREADY_EXISTS`，结果 `beforeRevision:null` 并附
`before.existed:false` 的 checkpoint。新文件随后用 `tiled_add_tileset_to_map`
挂载；`tilesetCreationCapabilities` 公布全部策略。

删除 TMJ/TSJ 用 `tiled_delete_file`（preview→apply，destructive）：有界 fail-closed
引用扫描覆盖 TMJ maps（`tilesets[].source`）、JSON worlds（`maps[].fileName`）与
JSON templates（`tileset.source`），候选 ≤2,000 个 / 64 MiB；存在 XML 资产或
pattern-based world 时以 `UNSUPPORTED_REFERENCE_SCAN` 拒绝，命中引用返回
`FILE_IN_USE`（含样本）。apply 重放扫描并 CAS 当前 revision，**先提交当前字节的
committed checkpoint 再 unlink**——任何崩溃窗口要么留下完整文件、要么留下可恢复
的 checkpoint。恢复走 `tiled_preview_checkpoint_restore` 的缺失目标扩展：
`expectedRevision` 即恢复内容的 SHA-256，批准后以 no-replace 方式字节精确重建；
该扩展同样适用于被外部工具误删的文件。`fileDeletionCapabilities` 公布全部策略。

调整地图尺寸时，使用 generic union 的第 16 种、必须独占 change set 的 operation：
`{type:"resizeMap",width,height,offsetX?,offsetY?}`。语义按 Tiled 1.12.2 官方源码
核实：`offsetX`/`offsetY` 单位为 tile，表示**旧内容在新地图中的位置**（缩小/向左上
裁剪用负值，省略视为 0，幅值上限 100,000）；目标格 `(x,y)` 取自源格
`(x−offsetX,y−offsetY)`，新增格子填空 tile。所有 tile layer 必须与当前地图 bounds
完全对齐（零 origin、同尺寸），否则整个操作以 `UNSUPPORTED_RESIZE_LAYER_BOUNDS`
fail closed——Tiled 对非对齐 layer 的 resize 行为本身留有未定义 TODO，本项目不做
近似。每个被扫描的源格（包括将被裁剪的）都按完整 encoded GID fail-closed 校验，
裁剪不能掩盖坏数据。

对象固定采用 Tiled "remove objects" 关闭时的语义：像素偏移
`(offsetX×tilewidth,offsetY×tileheight)` 非零时所有对象仅平移锚点，polygon/polyline
points 相对锚点自动跟随，**从不删除**；越界对象原样保留，摘要按"平移后锚点是否落在
闭区间像素边界外"回显 `objectsOutsideNewBounds`。含 `template` 的对象在需要平移时以
`UNSUPPORTED_RESIZE_TEMPLATE` fail closed。image layer 只平移发生变化的
`offsetx`/`offsety` member；group layer 自身不动；`nextlayerid`/`nextobjectid`
不变。重写目标格计入 100,000-cell write budget，源格扫描上限 1,000,000，平移对象
计入 10,000 object-mutation budget。plan 的 `summary.mapResizes[]` 与恒为
`destructive:true` 的 operation preview 回显新旧 bounds、offset、preserved/cropped
非零格计数、最多 16 项 `croppedCellSample` 与受影响 layer 计数。同尺寸零偏移且无
实际变化时是 exact-byte no-op。该 operation 不注册 standalone tool，不改变注册工具数。

挂载一个尚未被 map 引用的现有 TSJ 时，先从最新 map summary 取得 map revision 与完整
`dependencyRevisions`，再调用 `tiled_add_tileset_to_map`，传入 `mapPath`、
`tilesetPath`、`expectedMapRevision`、`expectedDependencyRevisions`，以及可选的
`expectedTilesetRevision`。这个工具只验证目标 atlas、分配 `firstgid` 并返回
`changeSetId`，不会修改 TMJ/TSJ/图片等项目资产，也不写任何 `.tiledmcp` 内部状态
（asset identity contract v2 起，read/preview 路径的身份解析无锁且零副作用，
持久化只发生在 apply）。客户端批准后仍须调用 `tiled_apply_change_set`。提交成功后
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
文件，也不会用“创建文件前”的 checkpoint 删除文件。只有 `wouldChange:true` 的恢复才会
在替换前为当前版本再建 checkpoint；它的后续可恢复性还要求 checkpoint 完整且
`filesystemThreatModelContract.operationalRequirements` 成立。no-op 恢复不替换文件，
也不创建新 checkpoint。

清理一个当前目标仍可验证为**写前状态**的 prepared checkpoint 时，调用
`tiled_preview_prepared_checkpoint_discard(checkpointId)`。existing-file checkpoint
只有在当前普通文件的 raw revision 与 size 都精确等于 manifest 的 `before` 状态时才
符合条件；create checkpoint 只有在目标仍严格缺失时才符合条件。existing-file 的
`before.revision === afterRevision` 无法区分 no-op 与已落地，目标等于 after、目标缺失、
无关内容、create 目标已存在、symlink/非普通文件以及其他不安全状态也全部返回
`CHECKPOINT_STATE_CONFLICT`，不会删除 manifest。preview 不读取 stored-before blob，
只固定 raw manifest SHA-256/size、完整 metadata 与目标状态证据；因此该 checkpoint
自己的 blob 已缺失或损坏不会阻止安全 discard。批准后仍通过
`tiled_apply_change_set` 提交；apply 按 `target → checkpoint-store` 锁序重验目标证据和
raw manifest CAS，再以 manifest unlink 为不可逆提交点，随后 fsync checkpoint 目录确认
耐久性并运行同一套 fail-closed orphan GC。它永久删除恢复点但不修改项目资产，不提供 operator-forced
commit、force-abandon 参数或自动删除；含混状态必须改走下面两个职责分离的裁决工具。

含混 `prepared` checkpoint 的人工裁决没有通用 `force` 开关。客户端必须先按当前
`conflict` 选择一个独立 preview，再展示完整证据并取得针对该 proposal 的批准：

| 当前 prepared 状态 | 允许的路径 |
|---|---|
| create 目标缺失 | 机器可证明写入未落地；使用现有 `tiled_preview_prepared_checkpoint_discard` |
| existing 目标精确等于 before | 机器可证明写入未落地；使用现有 discard |
| existing 目标精确等于 after | 重启服务触发启动对账并自动推进为 committed |
| create 目标精确等于 after | `tiled_preview_prepared_checkpoint_commit` 或 `tiled_preview_prepared_checkpoint_abandon`，由操作者判断来源 |
| create 目标存在但内容无关 | 仅 `tiled_preview_prepared_checkpoint_abandon` |
| existing 目标缺失或内容无关 | 仅 `tiled_preview_prepared_checkpoint_abandon` |
| symlink、非普通文件、越界/内部路径、超限、不可读或读取竞态 | 全部拒绝，先修复不安全状态 |

两个裁决 preview 都固定 manifest 的 version/retention 等完整 metadata、raw SHA-256/size、
目标的严格缺失证据或 raw revision/size，以及冲突分类；各自动作域隔离的
`expectedRevision` 防止把 commit 批准重用于 abandon。apply 按
`target mutex → target file lock → checkpoint-store lock` 重验全部 pins，任一漂移都在
内部状态 mutation 前返回冲突。commit 只接受 `before.existed:false` 且当前安全普通目标
精确等于 `afterRevision`，提交点是 prepared manifest 原子替换为 committed；它不修改
项目资产、不运行 GC。该 committed manifest 只是保留内部审计记录；由于 before 表示目标
原本不存在，现有 restore 工具不能把它恢复成“删除目标”。rename 后的目录 fsync 或锁释放故障返回
`manifestCommitted:true`、`durability:"unconfirmed"` 的有界成功，不能盲目重试。
abandon 永久 unlink prepared manifest、保留当前项目文件，并在目录 fsync 后运行
fail-closed GC；unlink 后的故障同样仍返回 `manifestDeleted:true`。成功结果只在原
change set 内精确缓存重放，不会续跑，也不是长期授权。

显式删除恢复点时，调用
`tiled_preview_checkpoint_prune(checkpointId)`；它只接受 `committed` checkpoint，
不读取或校验对应 blob，而是把原始 manifest bytes 的 SHA-256 revision 固定进 change
set。客户端展示永久删除恢复点的 destructive 警告并批准后，用预览返回的
`changeSetId` 与 `expectedRevision` 调用 `tiled_apply_change_set`。apply 先按
`target → checkpoint-store` 的固定锁序重新检查 raw manifest CAS，再以“unlink
manifest + fsync checkpoint 目录”为提交点。提交后运行 fail-closed 全局 orphan GC：
完整 inventory 时只清理无引用 checkpoint objects 和私有 crash temp；存在 blocker
时零删除并在成功 prune 结果中报告。提交点后的 GC/fsync 诊断不会把已经删除 manifest
伪装成可重试失败。`prepared` checkpoint 必须先对账；满足 exact-before 条件时走
独立 discard，只有上述含混分类才能走明确的 commit/abandon 裁决。

显式清理 retention backlog 时，可调用
`tiled_preview_checkpoint_prune_batch({checkpointIds})`。调用方必须先从当前 checkpoint
列表中明确选择 2..32 个互不重复的 committed UUID；工具不会按 retention ordinal、时间、
label 或容量压力自动挑选 victim。计划按 canonical checkpoint ID 排序并公开执行顺序，
把每项 raw manifest revision/size/metadata 固定进 change set；聚合 `expectedRevision`
覆盖有序 `{id,manifestRevision,manifestSize}` pins。
apply 先按 canonical target path 顺序取得全部去重后的 target locks，再取唯一
checkpoint-store lock；在首次 unlink 前权威重读并完整 pin 全部成员，任一 missing、
status/path/bytes 漂移都使该批次零删除。该预检不读取 stored-before blobs，也不要求全局
inventory/object 完整，因为操作者批准的是精确 manifest 集；全局完整性只约束后续 GC。

batch prune 不是跨 manifest 原子事务：它按 canonical ID 顺序逐项 unlink，并在每项后立即
fsync checkpoint 目录，遇到首个故障即停止。首次 unlink 前失败可作为零删除错误重新预览；
一旦任一 manifest 已删除，结果就是有界 `partial` 或 `completed` success，并缓存为该
change set 的最终结果；重放只返回同一结果，绝不继续删除 `not-attempted` 成员。只有全部
manifest 都删除且逐项目录 durability 已确认后才运行一次 fail-closed GC；若中途停止则不
运行 GC，留下的孤儿对象可由
后续安全 GC 回收。要继续清理剩余项必须重新列举、重新 preview 并再次批准。
prune/discard/abandon 都不留 tombstone，之后查询与从未存在的 ID 一样返回 not found。

长期编辑可在启动时显式设置
`--checkpoint-retain-per-target N` 或
`TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET=N`；CLI 覆盖环境变量，`N` 的范围是
`2..10000`，未设置即完全关闭。这份启动配置是自动删除 v2 rolling checkpoint 的 standing
approval，不会追溯改造 legacy manifest，也不会把 label 当作 pin 或顺序依据。启用后，
existing-file 的新 checkpoint 会从 checkpoint-store lock 串行保护的 durable sequence
取得唯一正整数 ordinal；create checkpoint 明确标记为 `protected`。成功写入目标且新
checkpoint 已 durable 标记为 committed 后，仍在同一 target lock 内按
`target → checkpoint-store` 锁序执行一次有界 retention：完整重扫、校验所有 recovery
root 的 content object、确认当前目标等于最新 rolling checkpoint 的 `afterRevision`，
然后按 ordinal 保留最新 N 个并至多删除最老一个。`createdAt`、mtime、UUID 与 label
只用于展示，绝不参与删除排序。

任一 prepared、损坏/未知/symlink/非普通 entry、缺失或 hash/size 不匹配的 object、
sequence 重复、低于 live ordinal 的可观测回退、目标漂移或 inventory 截断都会在首次 manifest unlink 前令本次
retention 零删除。manifest unlink 是删除提交点，随后 checkpoint 目录 fsync 确认
耐久性；之后的 GC 或
checkpoint-store lock-release 故障通过成功 mutation 的 `checkpointRetention` 结果和固定 warning 报告，
不会把已经完成的项目写入伪装成可安全重试的失败。retention 不在 `ensureCapacity` 中
运行，也不会在 quota pressure 下先删恢复点：系统必须先容纳新 checkpoint，容量不足仍在
目标 promotion 前返回 `CHECKPOINT_QUOTA_EXCEEDED`。一次 retention 最多删一个，因此降低
N 或一次 blocker 形成的超额 rolling 历史不会被后续“一次新增、一次删除”追平；正常稳态
会维持 N；既有超额必须由操作者显式选择 victim，并使用单项或 2..32 项 batch prune
有界追赶，自动 retention 不会代替操作者挑选 backlog 成员。

`tiled_preview_transaction` 提供跨文件原子提交，wire 形态是组合而不是新语言：
先用既有 preview 工具分别取得 2..16 个 map edit / tileset edit / tileset
create / file delete change set（目标路径两两不同），再把它们的 id 交给事务
preview。返回的 `kind:"transaction"` change set 逐成员列出
`transactionMember` operation（计划类型、replace/create/delete 目标、路径与
revision pin；删除成员标记 destructive），`expectedRevision` 是有序目标 pin 集
的聚合 SHA-256。preview 即锁定所有成员：在事务 pending 期间单独 apply 任何成员
返回 `CHANGE_SET_OWNED`，事务过期自动释放；pending 事务同时最多 4 个。apply 仍
走 `tiled_apply_change_set`：每个成员计划按当前项目状态重放为精确字节，全部
pin 在 canonical 路径全序加锁下复核，然后经 `.tiledmcp/transactions/` 的
redo journal 提交——manifest 原子改写为 committed 是唯一提交点，之前崩溃启动
对账整体回滚、之后前滚（内容寻址 staged 对象使重放幂等）；崩溃窗口内被外部写者
改动的单个目标降级为披露 conflict，其余照常前滚，与威胁模型的非合作写者边界一
致。每个目标仍建立各自的 before-state checkpoint，成员变更保持可单独恢复；结果
的 `results` 数组逐成员采用其单独 apply 的完全相同 wire 形状，成员 change set
重放返回事务内结果而非二次提交。staged 总量 ≤ 64 MiB；12 项存储层崩溃注入测试
与 wire 层端到端测试覆盖每个协议步骤。策略字符串冻结于
`transactionCapabilities`。

成员对另一成员目标的 pin 与该成员 base revision 不一致的组合在事务 preview
即被拒绝；一致（全体成员共享同一 pre-state）则放行——"编辑 tileset + 同步更
新依赖它的地图"可以原子提交。attach 尚不存在的 tileset 走 **create+attach**：`tiled_add_tileset_to_map` 接受可
选 `createChangeSetId`，用 pending `tiled_create_tileset` 计划重放出的
prospective TSJ 内容顶替尚不存在的文件——挂载计划 pin 的正是 create 计划的
prospective 内容 revision，prospective assetId 也是确定性路径哈希、与文件落盘
后的首次真实分配一致。这对组合既可以顺序单独 apply（先 create 后 attach），也
可以放进同一个事务原子提交：事务 prepare 时 create 成员先重放，其内容直接充当
attach 成员的依赖来源，绕开磁盘读取而不放松任何 digest 校验。

## 开发与验证

```bash
pnpm typecheck
pnpm contract:check
pnpm test
pnpm build
```

`pnpm contract:generate` 从两个固定 capability profile 的真实 MCP `tools/list`、
`resources/list`、`resources/templates/list` 和 `resources/read` 响应重建两份 machine
contracts（discovery 与 application errors）和 reference；它不会探测 PATH 或启动本机
Tiled。`pnpm contract:check` 比较这两份 contract 与 reference 的生成结果和已提交
artifact，并重新用公开 input schema 校验全部 30 个示例。`pnpm test` 会先执行该 drift
gate、构建 `dist/`，并包含真实 production stdio smoke；
`pnpm test:watch` 为避免使用 stale build 而排除该单项，可随时用
`pnpm test:stdio` 单独重建并复跑；`pnpm verify` 串联 typecheck、build、契约检查和完整
测试。

测试覆盖路径沙箱、JSON 词法保真、revision 冲突、原子提交、checkpoint 启动对账、
全部 GID flag 组合、tile set/fill/精确 replace、稠密矩形 stamp、四向 flood fill、
矩形 tile copy、独占 map resize（offset 方向、裁剪计数与样本、layer bounds/模板/坏
GID fail-closed、image offset 局部平移、identity no-op、预算边界与 Tiled 往返）与
rectangle/point/ellipse/capsule/polygon/polyline/text object 编辑闭环
（含单对象详情读取、path/text 单项、change-set aggregate、pending registry 与 closed
output 预算），
以及 atlas 几何、SVG 安全预检、图片预算和
native preview 的图层选择、H/V/D、opacity、region/grid/coordinate/highlight overlay、
tile-union、ellipse/capsule 曲线与退化边界、对象裁线/细分预算，以及 MCP image wire
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
tile stamp 覆盖非零 layer origin、null 清空、变换 GID、稠密矩形/边长/格数边界、
mixed-operation later-wins、8 格有界 preview、exact-byte no-op、局部 source patch、
tamper/stale dependency 与 Tiled 1.12 round trip；
tile flood fill 覆盖绝对/非零 layer origin、四向边界、完整 encoded GID 与 transform
隔离、null source/target、source=target 单 seed no-op、mixed-operation later-wins、
replace/flood/copy 共享实际读取预算、100,000-cell 写预算、observed malformed GID
fail-closed、无 cell list 的有界 preview、data-local source patch、tamper/stale
dependency 与 Tiled 1.12 round trip；
tile copy 覆盖 strict source/destination shape、跨层与同层非零 origin、完整 bounds
拒绝/no clipping、0 清空、完整 transform/raw flags、source/destination malformed GID
fail-closed、同层四方向重叠 memmove、operation-start 双矩形 snapshot、mixed batch
前序可见与后序 later-wins、`2*cellCount` 共享 scan 和完整 `cellCount` 写预算、
无 cell list 的 destructive bounded preview、destination data-member-local patch、
exact-byte no-op、tamper/stale dependency 与 Tiled 1.12 round trip；
map update 覆盖 strict/nonempty patch、4 种 render order、背景色写入/删除、
1024-code-point class 边界与安全摘要截断、顺序 later-wins、`mapUpdates` 摘要与渲染影响标记、
root-member-local source patch、exact-byte net no-op、tamper/stale revision 与
Tiled 1.12 round trip；
tileset reference removal 覆盖 strict/exclusive operation、opaque asset-id 定位、
隐藏/锁定/嵌套 layer 的 cell/tile-object 全图扫描、`TILESET_IN_USE`、1,000,000-entry
预算、非目标 malformed/flagged GID fail-closed、template object 拒绝、乱序 binding
原 index、destructive bounded preview、旧 dependency-set pin、plan/summary tamper、
array-element-local 删除、firstgid 保持、外部 TSJ 不删除、stale revision 与 Tiled 1.12
round trip；
layer duplicate 的 37+1 项专项/集成 cases 覆盖 destination 三分支、默认/最终 insertion
index、root-only name override、完整 subtree 的 preorder layer/object ID、direct 与
nested-list object reference 重连、外部/零/dangling reference、class/template fail
closed、GID/lock、layer/object/cell/depth/size 限制、compact source insertion、
value-local counters、BOM/CRLF/未知词法、tamper/stale revision 与 Tiled 1.12 round trip；
tileset 挂载覆盖 map/现有依赖/prospective TSJ revision pin、自动 `firstgid`、重复引用、
GID 上限和局部 source patch；图层创建覆盖 4 种类型、根/Group 插入、`nextlayerid`、
tile cell 预算、prospective image pin 与单元素 source insertion；
checkpoint 覆盖 exact-byte round trip、manifest/blob 篡改、prepared 状态机、目标
revision 冲突、restore/prune/batch-prune/safe-discard preview/apply/replay、恢复前二次
checkpoint、batch 全成员零删除预检、逐项 fsync、stop-on-first/cached-partial/no-resume、
raw manifest CAS、exact-before 目标证据、共享 blob 引用保留、精确 byte/entry
配额边界、共享 blob 去重、writer/GC 串行化、并发 writer 防超卖，以及 inventory
不完整时零删除的 fail-closed GC；
文档 fd 读取覆盖并发覆写/增长/截断检测。`tiled://guide` 和
`tiled://application-errors` 另有 list/read、空 templates、内容 revision/size 和未知
URI 契约测试；生产入口另通过真实
stdio client 覆盖配置、启动 checkpoint 扫描、tools/list、summary、tile search 和
checkpoint restore。架构与 roadmap
文档中未注册的工具或 Resources 仍是候选设计，不代表已经实现。

## 当前已知边界

- **写回范围**：tile 编辑只重写受影响图层的 `data`，对象编辑只重写 `objects`
  （创建时另改 `nextobjectid`）；范围之外的 BOM、换行、缩进、键序与词法按 bytes
  保留。被明确替换的数组会重新排版。
- **投影**：oblique 全面拒绝；staggered/hexagonal 为 summary/region/usage/
  select/渲染只读，编辑 fail closed；等距已全线放行（编辑与全部程序化 planner）。
- **TMX/XML**：读取为只读核心（TMX 绝不进入编辑 planner）；写出为受限 profile
  的新文件创建（同目录、no-replace），enum 注解成员与 profile 外结构 fail
  closed，class 属性需显式 `projectFilePath`。
- **模板**：JSON `.tj` 模板支持读取展开与实例化写入；tile 模板、XML 模板与嵌套
  模板 fail closed。
- **选区**：无状态纯数据（无 selectionId、无服务端选区状态）；`sampleLimit` 上限
  10,000 对齐 setTiles cell 预算。
- **语义命名**：`.tiledmcp/tile-names.json` 是弱元数据——读取逐 tileset pin
  revision，但 `localId` 逐字披露不复核 tileset 内容。
- **一致性披露**：一切多文件读取结果固定标记
  `snapshotConsistency: "non-atomic-read-set"`，不构成原子快照声明；
  `locked:true` 不构成写保护。
- **明确不支持**：官方 AutoMapping（1.12.2 无头 evaluate 实测不可行，铁证见
  spec）、修改/删除项目资产的"强制恢复"与通用 force 入口、prefab 持久化库与
  按名匹配（spec 记录为后续）。

各刀的详细行为契约与历史边界叙述见 [docs/07-devlog.md](docs/07-devlog.md)；
精确 schema 与限额以 [docs/generated/mcp-reference.md](docs/generated/mcp-reference.md)
与 capabilities 为准。
