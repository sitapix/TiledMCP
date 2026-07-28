# TiledMCP 开发日志（逐刀能力演进与行为叙述）

本文档保存 README 历史上逐刀累积的能力清单、定位陈述与行为边界叙述，作为
设计决策与演进过程的原始记录。**其中的工具计数（如"仍为 29 core"）与"当前/
尚未"表述是各刀提交时的历史快照，不代表现状**；现状以 README 主体、
`contracts/mcp-contract.v1.json` 与 `tiled_get_capabilities` 为准。

## 逐刀能力演进（原 README "项目状态"清单）


🚧 **MVP 实现中，接口尚未冻结。**

第一条可运行的纵向闭环已经完成：

- 项目根目录沙箱、静态路径逃逸与 symlink 拒绝；
- 严格安全的 TMJ/TSJ JSON 读取，以及只重写目标子树的 source-preserving patch；
- 原始 bytes 的 SHA-256 revision、合作写者 CAS、进程内互斥和跨进程文件锁；
- 同目录单路径原子可见替换、写前内容寻址 checkpoint、只读索引、启动对账，以及经
  preview/批准后按原始 bytes 恢复单个既有 JSON 文档、显式删除一个或有界批次的已提交恢复点，
  在当前目标仍精确等于写前状态时安全丢弃一个 prepared 恢复点，或对机器无法判定的
  prepared 冲突做显式、证据绑定的 commit/abandon 人工裁决；
- 有限正交 TMJ + 外部 atlas TSJ 的摘要、矩形 region 读取和只读校验；
- 按 map + tileset `assetId` 定位的有界 TSJ 详情，覆盖 atlas geometry、稀疏
  tile class（Tiled 1.12 的 `tiles[].type`）/动画/碰撞计数和 Wang set 语义展开
  （完整颜色表 + 有界 wangtile 采样，wangid 8 槽自上边缘顺时针编码）；
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
- 通过该 generic union 的第 10 种独占 operation 复制 4 类已有图层或完整 Group
  subtree，以高水位 preorder 分配新 layer/object ID，并安全重连副本内部对象引用；
- 无损 4-bit GID 变换编解码；
- `setTiles` / `fillRegion` / `replaceTiles` / `stampPattern` / `floodFill` /
  `copyRegion`
  封闭编辑集合，以及
  preview → approved change set → apply 的两阶段提交；replacement 按完整变换后的
  encoded GID 精确匹配并在一个 operation 内单次扫描、同时求值，stamp 则按绝对坐标
  写入有界的稠密矩形图案，flood fill 则从绝对 seed 以固定四向连通性填充完整 encoded
  GID 相同的区域，copy 则在同一 map 的两个有限 numeric tile layer 间按绝对坐标复制
  完整 encoded GID；
- 通过该 generic union 的第 13 种 `updateMap` operation 严格修改 map 根级
  `renderorder`、`backgroundcolor` 与 `class`，以 member-local source patch 保留其他
  原始 bytes；
- 通过同一 union 的第 14 种、必须独占 change set 的
  `removeTilesetFromMap` operation 移除全图零引用的 external atlas binding；隐藏、
  锁定和 Group 内的 tile cells/tile objects 都会纳入有界扫描，绝不清空或重映射 GID；
- 通过同一 union 的第 15 种、可混批 `copyRegion` operation 在同一 map 内复制一个完整
  tile 矩形；source/destination 先快照、同层重叠采用 memmove 语义，空 source 会明确
  清空 destination，且不会 clipping 或跳格；
- 通过同一 union 的第 16 种、必须独占 change set 的 `resizeMap` operation 按
  Tiled 1.12.2 核实语义调整地图尺寸：offset 表示旧内容在新地图中的 tile 位置，
  tile layer 全量重映射并对每个被扫描源格做 GID fail-closed 校验，对象只平移从不
  删除，image layer 仅平移发生变化的 offset members，裁剪计数与有界样本回显给
  批准者；
- rectangle/point/ellipse/capsule、有界 polygon/polyline path 与有界 text 对象的
  create、约束内 update 与 safe delete（正确维护 `nextobjectid`），并提供单对象
  详情读取以在整体替换/删除 path 对象或覆盖 text 内容前取得完整语义投影；
- 带 local ID 标注、自动分页和三重 revision 元数据的 atlas tileset PNG sheet；
- 不依赖 Tiled 进程的有限正交 tile-layer region PNG 预览，支持图层筛选、GID
  H/V/D、opacity、网格、绝对坐标 gutter，以及最多 64 个固定 amber 样式的绝对
  tile 矩形高亮；还可按 1–64 个显式 object ID 叠加 rectangle、point、
  ellipse、Tiled 1.12 capsule、polygon、polyline 几何轮廓或 text layout box；
- Tiled CLI 能力探测和可选 `tmxrasterizer` PNG 预览，后者返回 map/外部 TSJ
  revision、PNG hash/尺寸、renderer 版本与实际生效选项；
- 可由 MCP `resources/list` 发现并通过 `resources/read` 读取的
  `tiled://guide` 安全编辑 playbook 和 `tiled://application-errors` 稳定应用错误码
  注册表；
- `.tiledmcp/asset-registry.v1.json` 中严格校验、原子更新的持久 opaque asset identity：
  external TSJ 与 image-layer dependency 在同一项目状态内跨重启稳定，已观察文件的
  唯一、稳定且非零的同文件系统 file-identity move 尽力保持 ID；弱 identity、原路径仍
  存活的 copy/hardlink、跨文件系统 move 和其他无法匹配 file identity 的场景不自动合并；
- stdio MCP server、严格输入 schema、每工具精确 closed output schema、统一应用错误
  envelope、最大 1024-byte 的 compact one-line JSON text summary 与四项 tool
  annotations。

内嵌（inline）tileset 获得**只读语义核心与 tile layer 渲染**：map summary 单独
列出内嵌 atlas 条目（`tilesets[]` index + GID 范围），region 读取对其返回只读
`{kind:"embedded", sourceIndex}` tile 引用，`tiled_get_tileset` 以
`embeddedIndex` 寻址返回与外部 atlas 相同的有界详情投影（内容由 map revision
本身 pin，无独立 assetId/revision），`tiled_render_preview` 绘制内嵌 atlas 的
tile layer（图片相对 map 文件解析，source 条目以 `{embedded:{sourceIndex}}`
标识并由 map revision pin）。内嵌条目的 **per-tile metadata 编辑**同样可用：
`tiled_update_tile` 以 `embeddedIndex` 寻址（与 `tilesetAssetId` 互斥、省略
`expectedTilesetRevision`——map revision 是唯一 pin），复用外部 tileset 的全部
校验与应用逻辑后把 source patch 重定位到 `tilesets[i]` 之下，产出以 map 为目标
的 `embeddedTilesetEdit` change set（可入事务）；collection 结构编辑对内嵌天然
不可达（内嵌仅 atlas）。内嵌 image-collection、pre-1.5 `terrains` 字段与引用内
嵌 tileset 的 tile object 渲染 fail closed，检索等其余路径对内嵌条目继续明确拒
绝，不会静默降级。
tile object（`gid` 引用对象）获得**创建与语义编辑**支持：`createObject` 的
`shape:"tile"` 草稿以 TileRef（external binding + local id + 翻转位）经与 tile
layer cell 完全一致的 `cellToGid` 编码写入 `gid`，`width`/`height` 必须显式给出
（编辑器的"默认取 tile 尺寸"是 GUI 便利，本服务不近似——先读 tileset 详情）；
`updateObject` 可整体替换既有 tile object 的 `tile` 引用并 patch 位置/尺寸/公共
字段，shape 对象绝不会变身 tile object；`tiled_get_object` 对 tile object 返回
解码后的 tile 引用与显式翻转位；删除同样放行。锚点语义对照
`MapObject::alignment`（`unspecified` 正交回落 bottom-left）。JSON（.tj）对象模板获得**读取展开**支持：
`tiled_get_object` 按 Tiled 1.12.2 `syncWithTemplate` 精确合并规则展开模板实例
（非空 name、全正 size、显式 rotation/opacity/visible、任一 shape 成员覆盖模
板，text 成员只覆盖文本不覆盖形状），结果携带 pin 了 revision 的 template 块；
模板自定义属性不合并（`propertiesSource: "instance-only"`），tile 模板、XML 模
板与嵌套模板 fail closed，`tiled_list_objects` 仍报未展开的 `template` 形状标
记。
跨文件原子事务已实现：`tiled_preview_transaction` 把 2..16 个已批准的 map
edit/tileset edit/tileset create/file delete change set（目标路径两两不同）组合
为一个事务 change set，preview 即锁定成员禁止单独 apply；事务 apply 经
`.tiledmcp/transactions/` 下的崩溃可恢复 redo journal 提交，全部目标落盘或全不
落盘，启动对账自动回滚（提交点前）或前滚（提交点后），被外部写者改坏的单目标降
级为披露 conflict。
image-collection tileset（逐 tile 独立图片、无根图集）获得**语义读取**支持：
`tiled_get_map_summary`（binding 报 `collection:true`，`gidSpan` 覆盖稀疏最大
id）、`tiled_get_region`、`tiled_list_objects`、`tiled_get_object`、
`tiled_get_tileset`、`tiled_find_tiles`、`tiled_render_tiles` 与
`tiled_update_tile` 可用（选中 tile 逐个从各自图片渲染进按选集最大尺寸组格的
标注单元；元数据编辑针对既有稀疏条目、per-tile image 成员绝不触碰；条目结构
编辑经独占 update 支持：`createCollectionTile` 从项目图片新增稀疏条目（planner
读图验证并 pin 实际像素尺寸，`tilecount` 与最大 tile 尺寸联动），
`removeCollectionTile`（destructive）仅在当前 map 无该 id 引用、无其他项目资产
引用该 TSJ 且非最后一个条目时删除；sheet 按稀疏
id 升序分页、每页至多 64 tile；native preview 按 tile 自身尺寸绘制 collection tile——cell 左下角锚点、向上溢出、画布裁剪，与 Tiled 的 `tilerendersize:"tile"` 语义一致；动画 tile 绘制自身基础图块图像，与 TmxRasterizer 静态输出精确一致）。collection 详情以 `collection`
块（`maxLocalId`、最大 tile 尺寸语义）取代 atlas 几何，返回页内每个 tile 的图
片经安全检查验证并 pin revision（声明尺寸与实际不符即 fail closed）；分页与检
索按稀疏 local id 升序。指向已删除 collection id 的 GID、per-tile 图片
subrect、collection 上的 Wang set 均 fail closed；编辑与渲染路径继续拒绝。
压缩/base64 tile data 已获得**只读**支持（M2 第一步）：`tiled_get_region`、
`tiled_render_preview`、`tiled_analyze_usage` 与 `tiled_render_map` 按 Tiled
1.12.2 读取器语义解码 `encoding:"base64"` + gzip/zlib/zstd 的有限 tile layer
（严格 canonical base64、解压钉死在 width×height×4 精确字节、LE uint32、单层解
码上限 64 MiB 防解压炸弹）。encoded 有限 layer 也**可编辑**（M2 第三步）：cell
类操作解码编辑，apply 时只把**实际被写**的 layer 按其自身 encoding/compression
重新编码（绝不转码），未触碰 layer 与净 no-op 写入保持原始 bytes；resize 对
encoded 地图仍 fail closed。`tileDataReadCapabilities` 公布策略。
无限地图也获得**只读**支持（M2 第二步）：`tiled_get_map_summary`/
`tiled_get_region`/`tiled_analyze_usage` 可读 chunked 存储——region 用绝对 tile
坐标（允许负值），chunk 外的格子为空；chunk data 沿用 layer 级 encoding/
compression 解码；重叠 chunk 使读取顺序相关，直接 fail closed；单层最多 4,096
个 chunk；summary 报告 `infinite:true`、只读 profile 标记与每层内容 bounds +
`startX`/`startY`。`tiled_render_preview` 同样支持 chunked layer：无限地图必须
显式给出绝对坐标 region（允许负坐标，坐标标注含负号字形），render profile 报告
`infinite-orthogonal-static-atlas-chunked-tilelayers-v1`；所有编辑与
preview-edit 路径对无限地图继续 fail closed。
已存在的 tile object 仍会在受支持工作流中被校验、引用扫描并原样保留，并可在
native preview 中显式选择其 Tiled 对齐的 frame 轮廓调试，或再以 opt-in 方式叠加
该 tile 的碰撞形状轮廓（均不渲染 tile 图像）。

等距（isometric）地图现已**可读可编辑可渲染**：tile data 与 GID 存储语义、
对象像素坐标均与正交完全一致，仅渲染投影不同——summary/region/usage 只读
之外，标准 mapEdit 主链路（`tiled_preview_edits`→apply，含所有经 planEdits
的专用入口产物）同样放行 isometric（summary 的 editableProfile 报
`isometric-tmj-editable-core`），渲染走 `tiled_render_isometric`；
shape/generate/scatter/prefab/terrain 五个程序化 planner 全部放行
isometric（网格坐标语义方向无关；terrain 经真 CLI 实测 wangEdit 对等距
staging 地图行为与正交完全一致——wang 邻接语义方向无关）；staggered/hexagonal 降级为 **summary/region/usage 只读**（summary 披露 `staggeraxis`/`staggerindex`/`hexsidelength`，profile 报 `staggered-hexagonal-tmj-read-only`，一切编辑与渲染维持 fail closed）；oblique 全面继续拒绝。
TMX/XML 获得**只读核心第一步**：`tiled_get_map_summary` 接受 `.tmx` 地图，经
自研有界 fail closed XML 子集解析器（拒绝 DOCTYPE/实体/PI/CDATA——零 XXE 面、
零新依赖）返回只读摘要（图层树含 data 编码、外部 tileset 引用逐个解析并 pin
revision、`editable:false` 标记），TMX 绝不进入任何编辑 planner；
`tiled_delete_file` 的引用扫描同时解除 XML 阻断——TMX 地图与 XML 模板的
tileset 引用经同一解析器纳入有界扫描（可证明其干净才放行删除），损坏 XML
fail closed，pattern world 维持拒绝。

tool text content 已收敛为 `tiled-mcp-summary` v1：单行 compact JSON，UTF-8 最多
1024 bytes，不复制完整成功结果或应用错误 `details`；完整机器结果以
`structuredContent.result` 为准。可选 `tiled_render_map` 也已改用可追溯、精确封闭的
PNG 元数据，不保留冻结前的 legacy aliases。实际 MCP discovery 现在会生成并提交
双 profile discovery contract、101-code v1 application-error contract 和人类参考文档，
并校验手写维护的每工具 schema-valid 调用示例；测试前会做 byte-level drift check。
asset identity contract v2 已经落地并通过
`tiled_get_capabilities.assetIdentityContract` 公布精确边界：read/preview 工具的
身份解析零副作用（`readOnlyToolEffect:"none"`），registry 与锁只由 apply 写路径
创建/更新，纯只读会话不留 rename 证据；它不把内容相同视为身份，也不承诺跨文件系统 move。尚未被 registry 观察的
hardlink 在旧路径删除后与 rename 的最终状态不可区分，可能继承旧 ID。
`tiled_create_map` 已正式冻结为唯一 direct additive no-preview 例外：只创建此前不存在的
有限正交 TMJ，已有目标即使 bytes 相同也返回 `FILE_ALREADY_EXISTS`；精确边界由
`mapCreationCapabilities` 公布。仓库另提供不可静默跳过、精确要求 Tiled 1.12.2 的
`pnpm run verify:tiled-1.12.2` 集成门。direct filesystem backend 的威胁模型已经由
`filesystemThreatModelContract` v1 冻结：非合作既有目标 conditional replace 与 hostile
parent swap 明确属于 unsupported，并附带可机读运维条件；其 scope 只覆盖项目资产 JSON
文档目标，明确排除 `.tiledmcp` server-internal state，不再是含糊的 M0 决策项。
checkpoint store 现有 1 GiB 默认总量配额、10,000 observed-entry quota、项目级协调锁和
fail-closed orphan GC；已支持经 preview/批准显式 prune 单个 committed manifest，或按
canonical checkpoint ID 顺序批量 prune 2..32 个显式选择的 committed manifests，也能
在机器验证当前目标仍等于写前状态时显式 discard 单个 prepared manifest；对于其余含混
状态，还提供职责分离的 commit/abandon preview，不接受通用 `force:true`。自动 retention
是默认关闭的进程启动 opt-in：只对启用后产生、带持久单调 ordinal 的 v2
`rolling` existing-file committed checkpoint 生效；每次成功提交至多删除该目标最老的
一个 rolling manifest，并至少保留两个。legacy v1、`protected`、create 与 `prepared`
manifest 永远不由该策略删除。整体接口仍以 0.0.x Draft 发布；更宽的来源证明、
修改/删除项目资产的“强制恢复”以及通用 force 入口仍明确不受支持。
当前运行能力仍应以
`tiled_get_capabilities`、`tools/list` 和 resource discovery 为准。


## 历史定位陈述（原 README "一句话定位"）


目标是以 **TMJ/TSJ（JSON）无损读写**为地基，把 **Tiled CLI 与一次性脚本执行**作为格式转换、AutoMapping、Wang 编辑和兼容性验证后端，逐步提供面向结果的高层编辑工具与回滚安全网，并把**视觉闭环做成一等能力**：模型借助带 id 标注的 tileset 索引图选料，改完后渲染自查、对比确认。

首个 MVP 聚焦**有限尺寸的正交 TMJ + 外部图集式 TSJ**：当前已完成安全路径解析、地图摘要与区域读取、显式 tile metadata 语义检索、带 ID 的分页 tileset sheet 与稀疏 tile 选集渲染、基础 tile/rectangle/point/ellipse/capsule、有界 polygon/polyline 与 text 对象编辑、单对象详情读取、map/layer 局部成员更新、局部 JSON range patch、校验、预览，以及带 revision 检查、启动对账和两阶段批准的单文件精确快照恢复，和把已批准 change set 组合原子提交的跨文件可恢复事务；无限地图的 chunked tile layer 已支持除 resize 外的全部 tile 操作（按 Tiled 规范化保存形态写回；floodFill 以已用 chunk 并集为界），有限 tile layer 可经独占 `transcodeTileLayer` operation 在 csv 与 base64+gzip/zlib/zstd 间显式转码。复杂属性读取已落地：嵌套 class/list 值以有界 raw JSON 投影（class 成员类型注解存于项目 class 定义而非 TMJ，披露为 `valueSemantics`），enum 与对象引用逐字投影，仅超限条目保留 `valueOmitted`；属性写入支持标量、`setClassMembers`（覆写既有 class 值内既有标量成员、保持 JSON 类型；缺失成员与改型 fail closed——引入新成员需要项目 class 定义）与 `setListElements`（就地覆写既有 list 属性内既有元素的标量值，同时保持 JSON 类型与元素的 Tiled `type` 注解——int 元素要求整数、color 元素要求 #rrggbb/#aarrggbb、object 元素要求非负 id；追加/删除元素与 enum 包装、嵌套 class/list 元素 fail closed）。JSON world 的显式成员列表读取与成员编辑已可用（`tiled_list_world_maps` / `tiled_preview_world_edits`），pattern 成员可经 `expandPatterns` 按官方 `World::allMaps` 语义展开（同目录部分匹配、双捕获组×乘数+偏移、不与显式成员去重、`fromPattern` 标记）。Wang 地形数据面已闭环：atlas Wang set 完整语义读取展开 + `tiled_update_wangsets` 写入（新建 set、追加颜色、按官方 `setWangId` 语义分配 wangtile——全 0 wangid 移除条目、写回按 tileId 升序规范化；collection 与 pre-1.5 旧格式 fail closed）；官方地形笔刷已落地：可选 `tiled_preview_terrain` 经受控 one-shot `tiled --evaluate` 调用官方 `TileLayer.wangEdit()` 匹配器（服务端静态脚本、参数 JSON 字面量内嵌、CLI 只写 staging），diff 后产出普通 `mapEdit` change set——apply 不重跑 CLI、未触碰片段逐字保留；官方 AutoMapping 经实测在 1.12.2 无头 evaluate 下不可行（detached map 限制），程序化生成将分期加入。


## 各刀行为叙述与边界记录（原 README "当前已知边界"）


- tile 编辑只重写受影响图层的 `data`，对象编辑只重写受影响图层的 `objects`（创建时
  另改 `nextobjectid`）；这些范围之外的 BOM、换行、缩进、键序、数字和字符串词法按
  bytes 保留。被明确替换的数组仍会重新排版；`tiled_create_layer` 是例外，它使用
  单元素 array insertion，只合成一个紧凑 JSON 新元素并替换 `nextlayerid`，原有同级
  元素及其他文本保持原 bytes。当前一次 create-layer change set 只能创建一个空图层，
  尚不支持在同一 preview 中继续给新 Group 添加子层；已有图层的移动与删除分别使用
  独占的 `moveLayer` / `deleteLayer` operation，不能和 create-layer proposal 混批。
- `replaceTiles` 是通用 `tiled_preview_edits` 的 operation，不新增注册工具，因此仍为
  29 个 core / 30 个含 rasterizer 的工具。它只接受非空 `from`，按包含
  transform/raw flags 的完整 encoded GID 精确匹配；
  `to:null` 才表示清空。一个 operation 的多组 mapping 同时、single-pass 求值，可选
  region 使用绝对 tile 坐标，省略时覆盖 layer bounds。每个 operation 最多 128 组映射，
  replacement、flood fill 与 copy region 在一个 change set 中共用 1,000,000 次实际
  GID 读取预算，
  实际写入仍与所有 tile operations 共用 100,000-cell 上限；零命中不会产生受影响 tile 子树或文件
  写入。
- `updateLayer` 是通用 edit union 的第 7 种 operation，不是已注册的
  `tiled_update_layer` standalone tool。它只修改按数字 `layerId` 找到的现有
  tile/object/image/group layer 的 11 个公共成员；不移动、不删除、不改变父 Group 或
  sibling 顺序。写回对每个实际改变的 object member 分别做 source patch，因此同一个
  change set 可以同时修改 layer member、tile `data` 和 object `objects`，而不重排整个
  layer object。插入、替换或删除的 member 之外，BOM、CRLF、缩进、键序、数字词法与未知
  字段保持原 bytes。preview 固定 operation、requested/changed fields、Group 后代影响
  标记、map revision 与完整 dependency set；apply 会重新计算摘要并在锁内执行 revision
  guard（对合作写者构成 CAS）。
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
  保持未触及 lexeme 与 `nextlayerid`/`nextobjectid`，并沿用 revision guard（对合作写者
  构成 CAS）/checkpoint 安全边界。
- `duplicateLayer` 是同一 union 已实现的第 10 种 operation，也没有 standalone tool。
  它必须独占 change set，以三分支 `destination` 选择同父/root/Group 和最终 insertion
  index，复制完整 subtree，并从 layer/object 高水位按 preorder 分配 ID。typed
  object/list 引用只在副本内部重连，外部/零引用与外部 image/file 仍共享，class/template
  等无法证明安全的语义 fail closed。新副本用紧凑 JSON 插入，原 subtree 与 siblings 的
  source bytes 不重排；计数器使用 value-local patch，并沿用 revision guard（对合作写者
  构成 CAS）/checkpoint 安全边界。
- `stampPattern` 是同一 union 已实现的第 11 种 operation，不新增 standalone tool。
  它在绝对坐标一次写入非空、稠密、等宽的 row-major `(TileRef|null)[][]`；`null` 是清空
  而非透明跳过，目标矩形必须完整位于 layer bounds 内且不做 clipping。单边最多 256、
  总格数最多 16,384，全部 pattern cells 都计入共享 100,000-cell 写预算。operations
  依序执行且重叠时 later wins；preview 最多采样 8 格。仅目标 `data` 会局部重写，全相同
  GID 的 net no-op 保持精确 bytes。清空矩形可继续使用 `fillRegion` + `tile:null`。
- `floodFill` 是同一 union 已实现的第 12 种 operation，也不新增 standalone tool。
  它以绝对 seed 和固定四向连通性，从 operation 执行时的 seed 完整 encoded GID 推导
  source；transform/raw flags 参与精确匹配，`null` 同时支持空 source 和清空 target。
  source=target 时只验证 seed 后 no-op。每次实际 GID 读取（包括可能重复观察的已填 cell
  与边界邻格）和 `replaceTiles` / `copyRegion` 共用 1,000,000-read 预算，observed
  malformed GID
  fail closed；实际变化计入 100,000-cell 写预算。preview 不返回 cell 列表，只报告
  canonical source/target、counts 和绝对外接 bounds；no-op/data-local patch 保持精确
  bytes。
- `updateMap` 是同一 union 已实现的第 13 种 operation，也没有 standalone tool。它以
  strict、非空 patch 修改根对象的 `renderorder`、`backgroundcolor` 与 `class`；
  render order 是 4 项封闭枚举，背景色仅接受 `#RRGGBB` / `#AARRGGBB` 或删除用
  `null`，class 最多 1024 个 Unicode code points。operations 顺序执行且 later wins；preview 的
  `mapUpdates` 会区分 requested/changed fields、no-op 与 rendering impact。apply 只做
  root-object-member-local patch，最终还原原值的 net no-op 保持 exact bytes。
- `removeTilesetFromMap` 是同一 union 已实现的第 14 种、必须独占 change set 的
  operation，也没有 standalone tool。它只接受当前 map summary 中 external atlas
  binding 的 opaque `tilesetAssetId`，并在隐藏、锁定和 Group 后代中扫描全部 tile
  cells 与 objects；合计上限为 1,000,000。任何 tile cell/tile object 引用目标 binding
  都返回 `TILESET_IN_USE`，不会清空或重映射；任一 template object 也会因模板依赖尚未
  revision-pin 而 fail closed。preview 固定目标身份、数组位置、GID 区间、旧完整
  dependency set 与扫描 counts，并标为 destructive；apply 重算后只删除对应
  `tilesets` array element，保留其他 `firstgid`，也不删除 TSJ/图片。
- `copyRegion` 是同一 union 已实现的第 15 种、可混批 operation，也没有 standalone
  tool。它只接受同一 map 内 finite numeric tile layers 的完整绝对矩形，operation 开始时
  同时快照 source/destination；同层重叠按 memmove，0 明确清空且不提供 clipping/skip。
  source/destination 全部 observed GID 都 fail closed；每格消耗 2 次与 replace/flood
  共用的 scan 和 1 次共享 tile-write 预算。preview 标为 destructive，只返回完整 counts/
  regions 而不返回 cell list；apply 仅把 copy 执行时改变的 destination layer `data`
  纳入局部 patch 候选，后序恢复原值时仍折叠为 exact-byte no-op。
- `resizeMap` 是同一 union 已实现的第 16 种、必须独占 change set 的 operation，也没有
  standalone tool。offset 语义与 Tiled 1.12.2 完全一致（旧内容在新地图中的 tile
  位置）；所有 tile layer 必须与地图 bounds 对齐，否则整体 fail closed，不套用 Tiled
  自己都标注 TODO 的未定义行为。对象只平移从不删除，越界对象保留并按锚点判据计数；
  需要平移的 template 对象 fail closed；`objectsOutsideNewBounds` 是锚点级参考指标，
  不复刻 Tiled GUI 的 renderer 包围盒删除判据，本项目也不提供删除越界对象的选项。
  重写目标格计入 100,000-cell write budget——总目标格超限的大图 resize（包括
  identity resize）会被拒绝；受影响子树仍受 128-subtree 上限约束，层数很多的地图
  需要先精简结构。
  capsule、polygon、polyline 与 text；ellipse/capsule 的 width/height 可省略并默认 0，也接受
  显式 0。polygon 为 3–256 点、polyline 为 2–256 点，points 使用相对 object x/y 的
  本地像素坐标、保序且每轴限制在 ±1e9；path wire 禁止 width/height，分别写成唯一
  polygon/polyline 数组并把 TMJ dimensions 规范化为 0。单 change set 合计最多
  8,192 点，pending registry 合计最多保留 65,536 点；预算同时累计每一次 path create
  与完整 points replacement，后续覆盖、no-op 或 delete 不抵扣。七类都能 common-field
  update/delete；update 不允许改变 shape，polygon/polyline 允许整体替换 points，
  但不支持局部数组 patch，也不允许改尺寸。
  text 使用 flat wire、nested TMJ `text`，允许按字段更新内容、样式和尺寸；内容与字体族
  必须是 well-formed Unicode，分别受 scalar/UTF-8/control 限制，pixel size 为 1..999。
  单 change set 的 canonical text payload 最多 256 KiB，pending 合计 2 MiB。
  替换/删除 path 对象或覆盖 text 前可先用 `tiled_get_object` 读取完整 points 或解析
  默认值后的 text 样式；
  tile/template/未知 text profile 会 fail closed。
  对象写回保持 object-layer `objects` member-local。
- 删除对象会拒绝留下直接或 list 中的 `object` 属性悬挂引用；遇到可能隐藏 typed object
  reference 的 class 属性会 fail closed，复杂 class 编辑留到读取项目类型定义后实现。
- 使用同一规范化路径并遵守锁协议的 TiledMCP 写者由锁与 raw-byte CAS 保护；不遵守该锁
  的 Tiled GUI/其他程序仍可能在最终
  revision 检查与 `rename` 之间发生极小竞态。当前请避免在 MCP 提交瞬间同时保存，
  普通 Linux `renameat2` 也不提供“按内容 hash 条件替换”；要获得严格 external-writer
  CAS，需要 FUSE/写入 broker 或让 Tiled 遵守同一锁协议。
- 现有路径检查会拒绝静态 symlink 和越界引用，但还不是 `openat2`/容器级 OS 沙箱；
  主动在调用过程中替换父目录的本地攻击者不在当前保证内。
- 上述边界与 hardlink alias、本地文件系统/`fsync` 前提已经固定在
  `filesystemThreatModelContract` v1；需要抵御同权限本地攻击者时必须使用 OS 沙箱或
  强制写入中介。
- 崩溃遗留的 stale lock 会 fail closed，并要求确认无活跃写者后手动删除；不会冒险
  自动抢锁。启动扫描只会把目标精确等于 `afterRevision` 的 existing-file `prepared`
  checkpoint 补记为 `committed`；prepared create 即使 hash 相同也因来源不明报告
  conflict。其他状态只报告，不会自动回滚或删除。
- checkpoint store 对 manifests、content objects、崩溃 temp 与未知 entry 的 observed
  logical bytes/entry 总量做写前配额检查；prepared manifest 预留 committed 状态增量。
  manifest 首次发布使用 create-if-absent，不会覆盖同名恢复点；任何条目的 byte/entry
  清点无法证明完整时，新写入也会 fail closed。该内部存储边界假设本地状态可信且所有
  写者遵守全局锁；同权限进程恶意篡改 `.tiledmcp` 不在当前保证内。
  超限时只在完整、无损坏、无截断地建立全部 prepared/committed 引用集后回收 orphan
  objects 和私有 temp，否则首次 unlink 前整体阻断；quota-pressure GC 不会删除有效 manifest。
  `CHECKPOINT_QUOTA_EXCEEDED` 会在项目目标 promotion 前拒绝写入。客户端应把 error details
  当成不透明诊断；只有操作者另行确认 byte 维度单独超限时，提高
  `--checkpoint-bytes` / `TILEDMCP_CHECKPOINT_BYTES` 才可能恢复写入，entry 维度超限或
  inventory blocker 不会因提高 byte quota 消失。可以经 preview/批准显式 prune 单个
  committed checkpoint，或显式选择 2..32 个 committed IDs 用 batch prune 清理 backlog；
  batch 不替操作者选择 retention victim，也不把部分提交后的重放解释为继续执行。目标仍
  精确等于 before 状态的 prepared checkpoint 可走独立 discard；默认关闭的 rolling
  retention 可由上述启动配置显式启用。含混 prepared 状态只允许通过动作分离、
  证据绑定的 commit/abandon preview 裁决；通用 force、缺少目标证据的来源认领，以及
  任何项目资产删除都仍不受支持。
  恢复当前严格限于一个已存在的安全 JSON 文档；
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
- `tiled_get_tileset` 返回有界 semantic projection：per-tile 标量自定义属性逐字
  回读（仅超限条目以 `valueOmitted` 标记，每 tile ≤128 条；tileset 级属性仍只给
  数量），collision 回读有界形状几何（六类基础形状精确坐标，
  gid/template 与超长路径以省略标记披露，另附 objectCount），atlas Wang set 完整
  展开：颜色表全量投影（1-based index、name/color/probability/image tile/
  properties，Tiled 上限 254 色），wangtiles 每 set 最多采样 64 条（`wangId`
  8 槽自上边缘顺时针、边角交替；0 表示未设色，其余为 1-based 颜色索引；越界
  颜色引用、非 8 槽数组、重复 tileid 与越界 tileid 均 fail closed），pre-1.5
  `edgecolors`/`cornercolors` 不支持，不伪装成完整 TSJ。tile metadata 默认
  64 项、最多 128 项并按 local ID 分页。响应中的依赖 revision 只包含所选 TSJ 的
  `source.assetId` / `source.revision`，不复制地图的完整 `dependencyRevisions`；
  准备编辑前应从 map summary/region 取得完整 revision 前提。外部 TSJ 的 `name`
  必须是字符串，名称与其他显示字段按 Unicode code point 有界截断；`objectalignment`、
  `tilerendersize`、`fillmode` 和 `grid.orientation` 按 Tiled 1.12 枚举严格校验。
  精确 source image bytes/revision 由 `tiled_render_tileset_sheet` 与
  `tiled_render_tiles` 返回。
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
- tileset sheet 与显式 tile 选集当前只接受 PNG、JPEG、WebP 和严格受限的简单自包含 SVG（SVG 另限
  256 KiB）；拒绝动画/多页图片、image collection、外部 SVG 引用、超过 64 MiB / 4096² 解码像素的输入。每页最多
  256 个 tile，输出不超过 2048 像素长边、150 万像素和 8 MiB。布局会自动减少每页容量，
  但不会偷偷缩放 tile。当前还要求 `tilecount` 精确等于 atlas 可裁出的完整 tile 数，
  因此 Tiled 中人为保留的图集外“空白 local ID”会 fail closed；尚未实现超限图片的
  持久化 Resource，因此编码后仍超限会明确报错。
- `tiled_render_tiles` 接受 1–64 个唯一 local ID，严格保留输入顺序并按 row-major
  标注静态 raw atlas cells；`columns` 只控制每行最多项数。map 与所选 TSJ revision
  pin 可独立提供。它不分页、不排序、不去重，也不会在预算不足时丢弃 ID 或降低 scale；
  选集放不下时整个调用失败。v1 不展开 tile animation，不按 Wang set 分组，也不解析
  semantic name；per-tile image/subrect override 会 fail closed。结果固定报告
  `snapshotConsistency:"non-atomic-read-set"` 及 map/TSJ/image 三组精确 revision。
- native preview 的基础画面渲染有限/无限正交 TMJ 的静态外部 atlas tile layer
  （要求 atlas tile 尺寸与 map grid 相同）以及可见 object layer（profile
  `base-object-layers-v1`：基础几何按组色否则灰 + alpha-50 填充 + 1px 黑影绘制，
  topdown/index 绘制序、层×对象透明度、旋转、point 图钉标记；text 只画 layout
  box，tile object 以最近邻仿射采样绘制真实图块，template 对象按层计数披露
  omitted，class 色属 documented divergence）。它支持整数 scale 1–4、矩形 region、显式 tile/object layer 选择、
  H/V/D（非方形 tile 的 D 暂拒绝）、layer opacity、透明色、网格、绝对坐标 gutter，
  以及最多 64 个绝对 map tile 矩形高亮。每个高亮必须与最终 `tileRegion` 相交；部分
  越界会裁剪，完全不相交或坐标加法溢出会拒绝。固定
  `selection-amber-v1` 使用 RGBA `(250,204,21,96)` 的 `source-over` fill、无边框；
  重叠或重复矩形按 tile union 每格只混合一次，使输入顺序不影响 PNG。
  结果总是返回保序的 requested/rendered/clipped entries、union 后
  `highlightedTileCount`、固定颜色与 blend/overlap mode；未请求时 entries 为空且计数为 0。
  `overlays.objectIds` 另接受 1–64 个唯一 positive safe object ID，并严格保留输入顺序；
  `layerIds` 仍只选择 tile layer，两种选择互不隐含。对象使用 map pixel 坐标，local path
  point 先围绕 `(x,y)` 按 Tiled 正角顺时针旋转，再映射到输出并裁到
  `contentPixelRect`。固定 `explicit-basic-object-geometry-v4` 画 rectangle/point/
  ellipse/capsule/polygon/polyline 的几何轮廓、text layout box 与 tile object 的
  Tiled 对齐 frame 轮廓，并总是画 5px 原点十字；
  ellipse 取对象 bounds，capsule 半径为 `min(width,height)/2` 并由两个半圆和两条直边
  构成。单零尺寸按线段处理，双零尺寸按以 anchor 为圆心的 20 map-pixel 圆处理。
  tile frame 按 tileset `objectalignment`/缩放 `tileoffset` 定位，缺省尺寸默认为
  tile 尺寸，flip 位不改变轮廓，dangling GID fail closed。opt-in 的
  `tileObjectCollision` 以 tile 图像的同一 fragment 仿射叠加碰撞形状轮廓
  （per-tile 128/全选集 1024 上限，曲线与点数计入共享预算）。
  曲线在连续 output space 以最大 0.25px chord error 均匀角度细分，至少 12 段、四的倍数，
  单对象最多 4096 个曲线段、全选集最多 65536 个；完全离区的旋转 bounds 会先跳过细分，
  相交的超长直边仍先裁线再 raster。任何预算溢出都拒绝整次预览，不会降低精度。
  完全位于 region 外的对象仍保留 entry，以 `rendered:false, clipped:true` 明示。输出固定
  返回完整保序 entries、selected/rendered count、样式、量化、visibility policy、
  draw order 和 closed `curveTessellation`；未请求时返回相同 envelope 的空 entries。
  所选 path point 合计最多 8192，像素写入计入同一个 3000 万 work budget；不会缩减选择
  或降低 scale。tile object、template，以及所选 object layer/ancestor 的非默认 x/y、
  offset 或 parallax 均明确拒绝。
  这是 pre-Frozen wire clean break：profile 从 v1 升为 v2，entry 的 closed shape union
  增加 ellipse/capsule，成功结果现在总是带必填的 closed `curveTessellation`；缓存旧
  discovery/output schema 的客户端升级后必须重新 discovery，不能继续用旧响应 schema
  校验。selection/style/representation 保持不变。
  隐式选择会把可见 object/image layer 作为 `omittedLayers` 返回并标记 `partial: true`；
  blend/tint、parallax、非零像素 offset、group opacity、动画 tile、tileoffset 和
  image collection 会稳定报 `UNSUPPORTED_RENDER_FEATURE`/`UNSUPPORTED_TILESET`，
  不会静默近似。输出上限同样是 2048 单边、150 万像素和 8 MiB，另有 3000 万次
  pixel-blend 工作量上限；高亮 union fill 也计入该上限。多 atlas 结果中的 image revision 对应各自精确读取的 bytes，
  `snapshotConsistency: "non-atomic-read-set"` 明示这些图片并非同一时刻的原子快照。
