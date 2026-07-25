# TiledMCP 技术架构

> 本文描述实现边界、数据保真策略、事务模型和分期交付范围。功能契约见
> [02-mcp-spec.md](02-mcp-spec.md)。当前状态是**实现架构草案**；已注册工具已有精确
> closed output schema、有界 compact text summary 和可追溯 rasterizer PNG 元数据，但
> 接口与全部磁盘格式仍不整体视为冻结。direct filesystem 的 non-cooperative writer、
> hostile parent swap、锁作用域与运维条件已经由
> [filesystem threat model v1](04-security.md) 冻结为明确 guarantee/unsupported 边界；
> create-map direct no-replace 例外和固定 Tiled 1.12.2 的不可跳过集成门也已落地。
> 当前主要未完成运维项是 checkpoint 总容量配额与 GC。
> 当前 wire 使用的 external TSJ/image-layer identity 已接入持久 registry v1；其可验证
> rename 边界由 capability contract 明示。当前 discovery contract 与 97-code v1 application-error
> registry 已分别由
> [discovery machine artifact](../contracts/mcp-contract.v1.json)、
> [application-error machine artifact](../contracts/application-errors.v1.json) 和
> [生成式参考](generated/mcp-reference.md) 固化，并在测试前做漂移检查。

### 当前落地状态（2026-07-25）

静态存储沙箱、原始 bytes revision/合作写者 CAS、两层锁、单路径原子可见替换、
内容寻址 checkpoint、
启动期 `prepared` 对账、有界 checkpoint 索引、4-bit GID codec、有限正交 TMJ 基础
tile edits、rectangle/point/ellipse/capsule 对象增删改、stdio MCP 和
`tmxrasterizer` adapter 已经落地
并有自动化测试。有全局扫描/结果预算的 atlas TSJ semantic projection、显式稀疏
`tiles[]` semantic search，以及带 ID、分页且有图像预算的 atlas tileset sheet 也已落地。
tile edits 现包括 `setTiles`、`fillRegion` 与通用 preview union 中的
`replaceTiles`、`stampPattern`、`floodFill`、`copyRegion`；replacement 对包含
transform/raw flags
的完整 encoded GID 做精确匹配，一个 operation 内 simultaneous single-pass 求值，并分别
限制 mapping、扫描和实际写入；stamp 在绝对坐标写入有界的稠密矩形
`(TileRef|null)[][]`，flood fill 则从绝对 seed 以固定四向连通性匹配完整 encoded GID。
同一通用 union 的第 7 种 `updateLayer` operation 已支持对 4 类 layer 的公共
display/metadata member 做 strict patch；第 8 种、必须独占 change set 的
`deleteLayer` 删除一个 leaf/空 Group 或经显式确认的完整 Group subtree；第 9 种、同样
独占的 `moveLayer` 调整 sibling 顺序或把完整 subtree 移入/移出 Group；第 10 种
`duplicateLayer` 则以高水位 preorder 新 ID、安全 object-reference 重连和 compact
source insertion 复制 4 类 layer 或完整 Group subtree；第 11 种 `stampPattern` 使用
明确清空语义、no-clipping bounds 检查和 later-wins 顺序写入；第 12 种
`floodFill` 从 operation 执行时的 seed 推导 source，支持 null source/target、observed
GID fail-closed 和有界四向遍历；第 13 种 `updateMap` 以 strict root-member patch
修改 render order、背景色和 class；第 14 种、必须独占 change set 的
`removeTilesetFromMap` 则只移除全图零引用的 external atlas binding，并对隐藏、锁定及
Group 后代中的 tile cells/tile objects 做有界扫描；第 15 种 `copyRegion` 则在同一 map
的有限 numeric tile layers 间按绝对坐标、snapshot-source memmove 语义复制完整 encoded
GID 矩形。这些能力都不注册新工具。
专用 `tiled_add_tileset_to_map` preview 也已落地：它只签发单个外部 tileset 挂载操作的
change set，只有通用 apply 边界才写入目标 TMJ，并且不修改 TSJ。专用
`tiled_create_layer` preview 同样已落地：它在有限正交 TMJ 中规划一个空的
tile/object/image/group 图层，批准后才由通用 apply 写入并推进 `nextlayerid`。当前
`tiled_preview_checkpoint_restore` 也已把单文件 exact-byte restore kernel 接入同一个
anti-ABA change-set registry：恢复先只读固定 manifest/blob/目标 revision，经客户端批准
后才由通用 apply 提交。whole-map `tiled_analyze_usage` 只读投影也已落地，递归统计
tile-layer cells 与 tile objects，并用独立扫描、distinct aggregation 和结果预算约束
工作量。registry 因此包含 18 个 core tools；探测到
`tmxrasterizer` 时为 19 个。Tiled
export/evaluate、项目资产/schema/render Resource Templates、跨文件 WAL 和
任意跨文件系统 asset move/rebind 仍是目标架构，不是当前能力。当前 wire 的 external
TSJ 与 prospective image-layer dependency 已使用 `.tiledmcp/asset-registry.v1.json`
保持同路径身份，并在唯一、稳定且非零的 file identity 证据下尽力保持普通同文件系统
rename 身份；弱 identity、原路径仍存活的 copy/hardlink 与无法匹配 identity 的 move
不合并。
固定
`tiled://guide` 与 `tiled://application-errors` 两个 direct Resources 已落地：SDK
registry 提供 `resources/list` / `resources/templates/list` / `resources/read`，
分别返回有界 Markdown playbook 与当前 application-error registry JSON，并带 SHA-256
revision、UTF-8 byte size 和 server version；当前 templates 列表为空，也不声明
resource subscriptions。

`tiled_create_map` 是唯一不经过 preview/apply 的 additive mutation：客户端在 tool call
前确认目标路径，服务器只创建空的 finite orthogonal TMJ。领域层与 input schema 共用
100,000 map dimension / 16,384 tile-edge 上限；输出固定 map format 1.10 与 Tiled 1.12.2
compatibility baseline。写入使用同目录 temp + hard-link no-replace promotion，目标即使
已有相同 bytes 也返回 `FILE_ALREADY_EXISTS`。工具固定为 `idempotentHint:false`：
pre-install 失败可能留下新的 prepared checkpoint，成功后的重复调用也返回
`FILE_ALREADY_EXISTS`；客户端必须先重新检查目标，不能盲目自动重试。完整 machine
boundary 由 `mapCreationCapabilities` 公布。

18 个核心工具和可选第 19 个 rasterizer 工具现在分别注册完整、固定字段且
`additionalProperties: false` 的 output schema；递归 layer、operation preview 和
summary 的固定对象也保持 closed。统一外层是
`{result: ToolSpecificSuccess | ApplicationErrorResult}`，但成功结果仍按职责分开：
query/render、map-edit preview、checkpoint-restore preview、create-map commit 和
change-set apply 不是同一个 mutation 类型。handler 内的应用错误以 `isError: true` 加
结构化 `{ok:false,error:{code,message,details}}` 返回；SDK 在 handler 前产生的输入校验
错误只有 SDK-owned text content。进入 handler 后的成功与应用错误都使用
`tiled-mcp-summary` v1 compact one-line JSON text block，UTF-8 最多 1024 bytes；摘要不
复制完整成功 result 或错误 `details`，完整机器结果以 `structuredContent.result` 为准。
图片摘要另外回报 `mimeType` 和实际 inline image 的原始 bytes。

application code 的唯一稳定 wire 位置是
`structuredContent.result.error.code`。当前 v1 allowlist 有 97 个 code，单一代码来源
生成 `contracts/application-errors.v1.json`，并把完全相同的 JSON 暴露为
`tiled://application-errors`；`tiled_get_capabilities.applicationErrorContract` 公布
resource URI、revision、size、wire location、`INTERNAL_ERROR` fallback 和兼容策略。
既有 v1 标识符及其含义稳定，未来 server 可以只做增量新增；客户端遇到未知 code 时必须
安全降级为通用应用错误并刷新 discovery。`message` 是有界的人类文本，`details` 是
opaque 有界字典，二者都不是稳定控制流接口。

tool callback 的返回值还要经过模块私有的 trusted-result 边界，并在交给 SDK 前核对
`isError:true` 与 `result.ok:false` error envelope 必须双向一致，再对成功和错误结果一律
重跑该工具 output schema；直接构造或信号不一致的结果不能绕过它。错误归一化、message
截断、details 清洗、序列化或边界校验任一步再次抛错/失败时，边界不读取该异常，而是返回
预构造的通用 `INTERNAL_ERROR` envelope，避免 SDK 退化为可能回显底层异常文本的 text-only
错误。公开 details 只接受普通 object 形状；array、null 与 primitive 归一为空 object。
CLI capability snapshot 在注册工具前先按 13-code 独立 schema 校验、深拷贝并冻结，
`INTERNAL_ERROR` probe message 也固定泛化，调用方后续修改原对象不会让 capability 与已
注册工具集合漂移。

这个 registry 有意不覆盖 MCP SDK input errors、`cli.*.issues[].code`
capability-probe diagnostics、startup fatal errors、`tiled_validate` validation
diagnostics、checkpoint reconciliation diagnostics 或原始 OS error codes。实现层必须
在这些独立表面与 tool application envelope 之间保持类型边界；未预期 handler 异常才
归一化为 application fallback `INTERNAL_ERROR`。

可选 `tiled_render_map` 已以 pre-Frozen clean break 删除旧
`mapPath`/`bytes`/`width`/`height` aliases。它的 exact closed result 必须返回
`mimeType`、`pixelSize`、`byteLength`、`sha256`、`map`、`dependencyRevisions`、
`renderer`、`options`、`snapshotConsistency` 和 `truncated`。尺寸、byte count、hash
与 MCP image block 全部绑定 adapter 一次有界读取后交给 server 的同一个 PNG buffer；
server 会复核 PNG signature/IHDR 及 adapter 报告的一致性。renderer 元数据固定
`kind:"tmxrasterizer"`、启动时探测的非空版本和
`profile:"tmxrasterizer-png-v1"`；options 返回展开默认值后的实际 `size` 与
`ignoreVisibility`。

render 前后会重新加载并比较 map 与全部 external TSJ revisions，
`dependencyRevisions` 仍只覆盖这些 TSJ。root atlas、per-tile image 与 image-layer 引用
按规范化项目路径统一去重，并在渲染前后分别读取一致单文件 snapshot、比较内部的完整
路径/revision 集合；图片集合或任一 revision 变化都会拒绝结果。该内部集合最多 64 张，
原始 bytes 合计最多 64 MiB、解码像素合计最多 16,000,000，任一图片单边最多 8192 px，
但这些图片 revisions 有意不进入公开 result。外部进程仍直接读取 live files，pre/post
相等也不能排除中途变更后恢复的 ABA，逐文件读取也不是原子 read set。因此该结果只承诺
`snapshotConsistency:"non-atomic-read-set"`，不把 map、TSJ 与图片描述成原子或同一时刻
的输入快照。成功结果固定 `truncated:false`。

atlas TSJ projection 以 Tiled 1.12 为语义基线：tile class 的当前磁盘字段是
`tiles[].type`，`tiles[].class` 仅作为 Tiled 1.9 兼容输入。详情响应只携带所选 TSJ 的
`source.assetId` / `source.revision`，不复制 map 的完整 `dependencyRevisions`；
mutation 所需的完整依赖 revision 必须另从 map summary/region 获取。外部 TSJ 的
`name` 必须是字符串；名称、class 名和 Wang 名等显示值按 Unicode code point 有界截断。
已知 rendering 字段使用封闭枚举验证，包括 `objectalignment`、`tilerendersize`、
`fillmode` 和 `grid.orientation`，未知字符串不能冒充已理解的 Tiled rendering 语义。

tile semantic search 使用 `mapPath + tilesetAssetId` 绑定当前 map 引用，只扫描 TSJ 中
显式存在的稀疏 `tiles[]`。class 解析与详情共用 `type` 优先、`class` 兼容回退规则；
per-tile image/subrect override 与详情读取一样在 M1 atlas profile 中 fail closed。
query 用 `all | any` 组合 class、`propertyExists` 与内建标量 `propertyEquals` clause，
wire 省略 mode 时默认为 `all`，所有比较均大小写敏感且精确。它按 local ID 有界分页并
返回完整 external `TileRef`，不回传 property value，也不解析继承 property、Wang
assignment 或语义 name；`propertyEquals` 遇到同名 custom/complex property 时 fail
closed，而不是把不理解的值当作未命中。续页把 map 和所选 TSJ revision 与下一
`startTileId` 一起显式
带回；revision 输入对独立查询可选，客户端续页应带回 pin，服务端会在调用入口及结果返回前
检查。带 pin 的输入先对同一个 raw-byte snapshot 比较 revision，再解析 JSON，因此 stale
页面不会因当前内容已损坏或已变成不支持 profile 而掩盖 conflict。多文件 read set 仍明确
是非原子快照。

native map preview v1 也已落地：它在进程内安全解码实际使用的 atlas，按有限正交
tile-layer 子集做确定性 RGBA 合成，并返回 region、tile→pixel 变换与 map/TSJ/image
快照 revision。复杂 Tiled 绘制语义仍由可选 `tmxrasterizer` 覆盖；后者报告
pre/post 复核的 map/TSJ read set 和同一 PNG buffer 的 hash/尺寸；其有界、去重的输入图片
集合也在前后读取并比较内部 revisions，但公开结果不报告这些 revisions，并明确保持非原子
live-file 边界。

当前写回已经使用 JSON syntax tree 生成局部替换：包括 `stampPattern`、`floodFill` 与
`copyRegion`
在内的 tile 操作只替换目标 `data`，对象操作只替换目标 `objects`，创建对象时另替换
`nextobjectid`。全相同 GID 的 stamp、source=target 的 flood 及 mixed-operation net
no-op 不生成 source patch，保持原始 bytes。
`updateLayer` 对每个实际改变的 object member 分别做插入、替换或删除，不重写完整 layer
object；`updateMap` 同样只 patch 实际改变的根对象 member，不重写完整 TMJ。
`removeTilesetFromMap` 只从根 `tilesets` array 删除已验证的一个 source element，不重排
其他 binding，也不压紧或重写其 `firstgid`。
`deleteLayer` 只从目标
直接父层的 `layers` array 删除一个 element；`moveLayer` 则由 `JsonArrayMove` 按原始
source snapshot 中的 source/target container paths 捕获并原样搬运 element bytes。
创建图层也不替换整个 sibling array，而是
在 JSON syntax tree 确认“只多一个元素”后执行单元素插入，并单独替换 `nextlayerid`；
所有既有同级元素仍保持原 bytes，新元素使用紧凑 JSON。补丁后会严格重新解析，并将完整
语义树与目标文档比较；漏列任何变更、插入/删除之外又改变既有数组元素或路径重叠都会拒绝
提交。普通替换目标范围之外的 BOM、CRLF、缩进、键序、数字和转义词法按 bytes 保持，
替换范围本身允许重新排版。checkpoint 恢复继续按原始 bytes 还原，不经过 JSON 规范化。

当前锁能串行化合作的 TiledMCP 进程，SHA-256 CAS 也能发现最终检查前的外部保存；但
Node 的普通 `rename` 没有 compare-and-swap 条件，非合作写者仍可在最后一次 hash 读取与
替换之间竞态。Linux `renameat2(RENAME_NOREPLACE)` 只能严格解决“目标不存在时创建”，
`RENAME_EXCHANGE` 也不按 revision/hash 比较，因此 descriptor-relative helper 本身不能
提供 external-writer CAS。严格“绝不覆盖”需要让所有写入经过强制中介（例如 FUSE/写入
broker），或让 Tiled 扩展遵守同一锁协议。`filesystemThreatModelContract` v1 已把它
冻结为 unsupported，并把“既有目标提交时不得有非合作写者并发保存”列为运维前提；这不再
是待定的 M0 语义，也不能被普通 stale-revision 测试掩盖。该 contract 的 scope 只覆盖
项目资产 JSON 文档目标；asset registry、checkpoint manifests、locks 等 `.tiledmcp`
server-internal state 由各自契约和实现规则约束。

同理，现有 `lstat`/`realpath`/`O_NOFOLLOW` 能拒绝静态越界和最终组件 symlink，但无法
消除恶意进程在检查后替换中间父目录的 TOCTOU；真正的 hostile-local sandbox 需要
`openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`、容器或等价 OS 机制。checkpoint
启动扫描已经有界实现：existing-file checkpoint 只有在当前目标精确等于
`afterRevision` 时才补记 `committed`；旧版仍在、目标缺失、无关 revision、symlink 与坏
manifest 都隔离报告，不自动回滚或删除。prepared create checkpoint 即使精确命中
`afterRevision` 也无法只凭 hash 证明创建者，固定保留 prepared 并报告
`CHECKPOINT_STATE_CONFLICT`；真正由本进程完成写入却在 committed marker 前崩溃也采取
同一 provenance-ambiguous fail-closed 结果。总容量配额与 GC 仍待实现。

## 0. 架构目标与硬边界

TiledMCP 的第一目标不是“能改 JSON”，而是让自动化编辑同时满足以下约束：

1. **无损**：未知字段、未来版本字段以及未被编辑的 JSON 文本不因一次局部修改而丢失或被规范化。
2. **并发安全**：既有目标写入基于明确 revision；唯一 direct create 使用 missing
   precondition。合作写者或在最终 guard 前已被观察到的外部保存不会被旧请求静默覆盖；
   非合作写者在 guard 后到 rename 前的窗口由 threat-model v1 明示，不作严格保证。
3. **可恢复**：既有目标的单文件提交使用 checkpoint + 原子替换；direct create 使用
   hard-link no-replace，当前不会把 `before.existed:false` 恢复成删除。未来跨文件提交
   必须通过 WAL 恢复，不能把多次 `rename` 宣称为天然原子。
4. **能力可探测**：直接 JSON 能力始终可用；Tiled、导出器、栅格化器和压缩 codec 按运行时探测结果启用。
5. **逐步支持**：可以读取和保留尚未支持编辑的内容，但必须拒绝不安全的语义修改，不能“尽力写出”。

以下内容是明确的 non-goal：

- 不做 WebSocket、插件或其他方式的 Tiled GUI 实时联动。
- 不接受模型提供的 JavaScript、shell 命令或任意 Tiled 命令行参数。
- 不把 TiledMCP 当作游戏运行时或完整的 Tiled 渲染器。
- M0/M1 不承诺跨文件原子提交、无限地图编辑或全部 TMX/TMJ 特性。

## 1. 总体分层

```text
┌──────────────────────────────────────────────────────────────┐
│ MCP 接口层                                                    │
│ contracts / annotations / limits / structured results        │
├──────────────────────────────────────────────────────────────┤
│ 应用层                                                        │
│ queries / commands / change plans / diagnostics               │
├──────────────────────────────┬───────────────────────────────┤
│ 文档引擎                     │ 运行时能力适配器                │
│ raw JSON + typed views       │ Tiled evaluate / export        │
│ GID / tile data / validation │ tmxrasterizer / image codecs   │
├──────────────────────────────┴───────────────────────────────┤
│ 存储与安全层                                                  │
│ roots / revisions / locks / atomic replace / WAL / snapshots  │
└──────────────────────────────────────────────────────────────┘
```

### 1.1 MCP 输出边界

接口层不使用 `{result: unknown}` 之类的兜底 schema。每个 tool 的成功分支独立建模，公共
外层只负责把它和 `ApplicationErrorResult` 组合；固定对象一律 closed，动态 key 只留给
dependency revision record 与错误 `details`。这样 `tools/list` 得到的客户端 validator
能同时验证合法成功结果和 handler 内的合法应用错误。

协议层 input-schema 校验发生在 tool handler 之前，不应包装成领域错误，也不会产生
`structuredContent`。进入 handler 后的失败才经过统一错误归一化、97-code application
allowlist、长度/深度预算和 JSON 安全化。`Diagnostic` 是 validator 成功结果中的问题记录，
不承担 transport/application 错误 envelope 的职责。

text channel 只提供 `tiled-mcp-summary` v1。它由公共确定性 serializer 生成 compact
one-line JSON，并以 UTF-8 1024 bytes 为硬上限；success 只报告 structured JSON byte
count；error 在公共 kind/version/ok/byte-count 字段之外，只报告 code、有界单行 message
与可选截断标志。二者都不通过 `JSON.stringify` 镜像完整 result/details。图片 summary
另外报告 MIME type 与实际 inline buffer bytes；base64 字符长度不作为图片大小。客户端以
`structuredContent.result` 为权威数据源，并且只用已发现的 `error.code` 做错误分支；
不得解析 message 或 details 做控制流。capabilities 的 `textContentContract` 固定公布
名称、版本、编码、上限、完整结果位置、structured byte 计量方式与
`sdk-owned-text-only` input-error 边界。

写操作遵循固定流水线：

```text
resolve paths
  → load raw bytes and revisions
  → build typed views
  → plan edits, diagnostics, and validate the in-memory result
  → acquire locks
  → compare revisions against the pinned source
  → prepare the write-ahead checkpoint
  → write and fsync same-directory filesystem staging
  → perform the final revision guard (cooperative CAS / pre-rename guard)
  → promote, fsync the parent where supported, and finalize checkpoint state
```

工具 handler 不直接写文件，也不直接启动外部进程。它只调用应用层用例；用例生成
`ChangePlan`，再由存储层提交。这样 dry-run、真实提交和恢复流程使用同一套校验。

## 2. 自动化路线与运行时能力

直接读写 TMJ/TSJ 是核心路线，但 Tiled 官方进程不是“以后再接的外挂”，而是一个正式、
可缺省的 adapter 层：

| Adapter | 探测方式 | 用途 | 写入规则 |
|---|---|---|---|
| Direct JSON | 内建，始终可用 | 无损读取、M1 范围内的编辑与校验 | 走本项目事务层 |
| Tiled one-shot evaluate | `tiled --version`，再运行受控探针脚本 | 格式转换、官方 AutoMapping、`TileMap.autoMap()`、官方 Wang 后端 `TileLayer.wangEdit()`、兼容性验证 | 仅允许静态内置脚本写 sibling staging 文件，再由事务层提升为正式文件 |
| Tiled export | `tiled --export-formats` | 导出运行时实际支持的非 PNG 格式 | 格式列表不硬编码；目标先写 staging |
| `tmxrasterizer` | 可执行文件探测和版本/帮助探针 | TMX/TMJ → PNG | 只读源文件，输出受尺寸和字节预算约束 |
| Native preview | 内建 Sharp allowlist codec | tileset sheet、正交地图调试叠加、Tiled 不可用时的有限预览 | 不修改资产 |

`tiled --evaluate <script>` 是**一次性进程**：执行脚本后退出，不要求 GUI 常驻，也不需要
WebSocket 桥。每次调用使用仓库内固定脚本和单独的 JSON request/result 文件；模型不能传入
代码。外部进程一律使用 argv 启动而不是 shell 拼接，并设置超时、输出上限、并发上限和
进程组清理。

PNG 不通过 `tiled --export-map` 冒充普通导出格式；优先使用 `tmxrasterizer`。其他导出格式
以当前机器 `--export-formats` 的结果为准。能力探测结果统一表示为：

```ts
interface RuntimeCapability {
  available: boolean;
  version?: string;
  features: string[];
  reasonUnavailable?: string;
}
```

工具注册可以按 capability 裁剪；已注册工具在能力临时失效时返回稳定诊断，而不是退化为
另一种语义不等价的实现。

## 3. 技术选型

| 组件 | 选择 | 说明 |
|---|---|---|
| 语言/运行时 | TypeScript + Node.js LTS | MCP SDK、文件系统和进程管理生态成熟 |
| MCP | `@modelcontextprotocol/sdk` v1.x + Zod | 固定生产可用主版本；契约由本项目维护 |
| Raw JSON | source-preserving JSON AST（可基于 `jsonc-parser`） | 保存原始文本区间并生成最小 `TextEdit`；额外检测重复 key |
| Typed view | 本项目自有窄类型与 type guards | 只描述已实现字段，未知字段留在 raw document |
| 第三方 Tiled 类型 | `@kayahr/tiled` 仅作开发参考或测试 oracle | 不作为 1.12 schema 真相，不用其严格 schema 决定能否写回 |
| Hash | Node `crypto` 的 SHA-256 | revision、blob 地址和提交校验 |
| 压缩 | Node `zlib`；zstd 为可探测 codec | 缺 codec 时保留原文并拒绝相关编辑 |
| 图像 | `sharp` + 确定性 raw RGBA 绘制 | allowlist 解码、nearest-neighbor atlas sheet 与内建 bitmap ID；复杂地图可交给 `tmxrasterizer` |
| 测试 | Vitest + Tiled 生成 fixtures + fault injection | 覆盖保真、兼容性、崩溃恢复和恶意输入 |

`@kayahr/tiled` 的接口或 JSON Schema 可以帮助发现字段，但其版本覆盖不完整、严格 schema
也可能拒绝未来字段。因此运行时的写回依据必须是 raw document、本项目显式支持矩阵和
官方 Tiled 验证结果。

## 4. 文档引擎：raw document 是唯一真相

### 4.1 Source-preserving raw JSON

每个 JSON 资产加载为：

```ts
interface RawJsonDocument {
  path: ProjectPath;
  source: Uint8Array;
  revision: Revision;       // sha256(source)，不是 mtime
  ast: JsonAst;
  root: JsonObject;
}
```

实现要求：

- UTF-8 解码、语法、最大深度、节点数和重复 key 在进入 typed view 前检查。
- 未发生语义变化时不写盘；no-op 的结果必须保持 byte-for-byte 相同。
- 修改编译成针对 AST 区间的 `TextEdit[]`；未触及的文本切片原样复制，保留 key 顺序、
  空白、数字写法以及未知字段。
- 必须重写数组或对象时，只重写最小目标子树，未知 sibling 仍从原文复制。
- 应用 edits 后重新 parse，构造新 typed view，再跑结构校验和目标版本校验。
- 重复 key 会使普通 `JSON.parse` 发生信息丢失；当前实现 fail closed，读取即返回
  `DUPLICATE_JSON_KEY`。未来若增加只读 recovery parser，也只能用于诊断，不能写回。

“无损”指未触及内容的结构和源文本都保留；它不意味着对被明确替换的数组继续保留原排版。

### 4.2 Typed views 与 edit intents

typed view 是 raw AST 上的只读投影，包含 JSON path/源区间，不拥有第二份可独立序列化的
“规范化地图”：

```ts
interface MapView {
  orientation: Orientation;
  layers: readonly LayerView[];
  tilesets: readonly MapTilesetView[];
  rawPath: JsonPath;
}
```

领域操作生成诸如 `SetTileIntent`、`PatchObjectIntent`、`PatchMapMemberIntent`、
`AddTilesetRefIntent` 的封闭联合，
再由文档引擎把 intent 编译为文本 edits。禁止用通用 `{tool, args}` 在底层递归调用其他
工具；batch 的 operation 必须是显式白名单联合，且禁止嵌套 batch、checkpoint、revert、
delete-file 和外部进程副作用。

tileset 名称不保证唯一。公共模型使用 map-scoped `tilesetRef`（外部 source 的规范化引用，
或内嵌 tileset 的稳定定位符）；`name` 只在唯一时作为便捷解析。外部 TSJ typed view
要求 `name` 字段存在且为字符串，不能用 basename 静默伪造源文档语义；面向输出的显示值
统一按 Unicode code point 截断，避免切断 UTF-16 surrogate pair。

### 4.3 目标版本与特性门控

`tiledversion` 仅表示“最后由哪个 Tiled 版本保存”，**不用于决定允许写什么字段**。门控依据
按优先级为：

1. 工具请求中的显式 compatibility target；
2. 项目配置或 `.tiled-project` 的 Compatibility Version；
3. 服务器配置的默认 target profile。

安装的 Tiled 版本只影响 official adapter 的运行能力，也不等于资产兼容目标。每个已知特性
在 `FeatureMatrix` 中声明最小目标版本、允许的文档类型、读/写状态与验证器；尚未支持写入的
字段可以保留和展示。目标架构计划让相关 patch 返回
`UNSUPPORTED_FEATURE_WRITE`，但它是 **planned / not current** code，不属于当前 97-code
v1 application registry；FeatureMatrix 写门控实现并把该 code 加入后续 registry 前，
客户端不得依赖它。

## 5. 路径、roots 与外部引用策略

路径策略同时用于 MCP 参数、文档中的 `source`/`image`/`template`、checkpoint 和所有外部
进程。

| 区域 | 默认权限 | 说明 |
|---|---|---|
| Primary project root | 读写 | 必须由 `--project-dir` 或 `TILED_PROJECT_DIR` 显式指定；所有新文件和 `.tiledmcp/` 都必须位于其中 |
| 其他路径 | 拒绝 | 包括未授权的绝对路径、网络 URL 和符号链接逃逸 |

具体规则：

- 当前 API 的 path 字段使用 primary root 下规范化的 project-relative POSIX string；
  opaque asset id 另行分配，不暴露宿主绝对路径，也没有 `{rootId, relativePath}` wire。
- 相对引用以**拥有该字段的文档目录**为基准解析，而不是进程 cwd。
- 已存在路径对最终目标执行 `realpath`；新建文件要求直接父目录已存在，并对该父目录执行
  `realpath`，同时逐段拒绝符号链接越界、NUL 和目录穿越。
- 当前只允许 primary root 内的引用，没有 additional read roots。
- 指向 allowlist 外的既有原始字符串应被原样保留且服务器不读取目标，也不能进行依赖该
  目标的编辑。目标架构为此预留 `EXTERNAL_REFERENCE_BLOCKED`，但它是
  **planned / not current** code，不属于当前 97-code v1 application registry。
- 新引用必须落在允许 root 中，并以拥有者为基准写成规范化相对路径；不自动把相对路径改成
  绝对路径。
- 启动 Tiled 或图像工具前先解析完整依赖闭包；外部进程的输入、输出和工作目录都必须通过
  同一策略。内置 evaluate 脚本不提供任意文件 API 参数。

未来若增加共享 tileset/图片 read roots，wire 才会独立设计
`{rootId, relativePath}`，且仍只保留一个 primary write root。当前单 root 让锁、WAL、
恢复扫描和配额有明确边界，不能把这项未来方案视为已实现配置。

### 5.1 Asset registry v1

当前实现只为已经进入 wire 的 `external-tileset` 与 `image-layer` 两个 kind 分配
`asset_[0-9a-f]{24}`。它不提前宣称 map/world/template Resources 已实现，也不改变
`tiled_list_files` 的精确 `{path,kind}` 结果。

持久格式是 `.tiledmcp/asset-registry.v1.json`：

```json
{
  "format": "tiled-mcp-asset-registry",
  "formatVersion": 1,
  "generation": 2,
  "entries": [
    {
      "assetId": "asset_0123456789abcdef01234567",
      "kind": "external-tileset",
      "path": "tiles/terrain.tsj",
      "identity": {
        "device": "2049",
        "inode": "12345",
        "birthtimeNs": "1710000000000000000"
      }
    }
  ]
}
```

root、entry 与 identity 都是拒绝 unknown key 的 closed object；format/version、safe
integer generation、ID、kind、canonical project path、十进制 identity 字段、全局唯一
ID 和同 kind 唯一路径都会复核。文件最多 8 MiB、20,000 entries、单 path 最多 4096
UTF-8 bytes。读取使用 `O_NOFOLLOW | O_NONBLOCK`、strict UTF-8、duplicate-key-aware JSON
解析和 regular-file/size 检查；未知未来版本、截断、symlink、重复或越界一律
`ASSET_REGISTRY_CORRUPT` startup fail closed，绝不按路径静默重建一个“看起来正常”的
registry。

首次观察一个路径时，为升级兼容先尝试旧公式
`asset_<sha256(kind + ":" + canonicalPath)[0..24]>`；候选已被其他 entry 占用时才生成
12 random bytes，并最多重试 32 次。entries 按 ID 排序。每次 mutation 在 project-wide
进程内 mutex 与跨进程 advisory lock 内重新读取最新 generation，写 0600 sibling temp、
`fsync`、原子 rename 并 `fsync` 父目录，因此合作实例不会 lost update；orphan temp 不会
参与恢复或覆盖主文件。registry 自身属于内部安全 metadata，不进入 checkpoint，也不作为
MCP Resource 暴露。v1 不把这扩张为断电 durability 承诺：首次创建 `.tiledmcp` 时没有
额外 `fsync` 项目根目录；掉电导致内部 registry 丢失时按 capability 的
`registryLossPolicy` 处理，ID 可能重新分配。

身份迁移采用保守顺序：

1. 同 kind + 同 canonical path 总是保持原 ID；编辑器 in-place/atomic-save 只刷新记录的
   file identity。
2. new path 尚未注册、old path 已消失，inode 与 birthtime 都非零，并且当前
   `(device,inode,birthtimeNs)` 在同 kind 中唯一命中一个 entry 时，才把该 ID 移到
   new path。这是在文件系统提供稳定 birthtime 时对普通同文件系统 rename 的
   best-effort 连续性；inode 或 birthtime 为零的弱证据不触发迁移。rename 同时原地改
   内容不影响强 identity 匹配。
3. 原路径仍存在的 copy/hardlink 不迁移；content revision、Tiled name 与相同 bytes
   都不是身份。跨文件系统 copy+delete、未观察的 inode-replacing save 后立即 rename
   和多候选歧义为尚未注册的 new path 分配新 ID。两个已注册路径 swap/replace 时按
   path-first 规则各自保留既有 ID，只刷新 identity。若 new hardlink 尚未被 registry
   观察，删除旧路径后与 rename 的最终 `(device,inode,birthtimeNs)` 状态不可区分，因此
   可能按同一 file identity 迁移并继承旧 ID；两个路径都已观察时，各自保留已分配 ID。
   实现不会伪称能够恢复已经消失的 link history。

这个边界是有意可验证而非猜测。若未来要强保证任意 rename+replace 或跨 root move，必须
提供显式 rebind，或者把文件移动、引用更新和 registry 迁移纳入第 8.3 节的跨文件 WAL；
不能用 content hash 启发式冒充身份。

server factory 在注册工具前加载并校验现有 registry。首次发现或 file identity 刷新可能
由 read/preview handler 更新 `.tiledmcp`，但不会修改 TMJ/TSJ/图片；因此 capability 的
`readOnlyToolEffect` 明确写为
`may-update-project-internal-safety-metadata-only`，同时覆盖 identity registry 与短暂的
内部 coordination lock metadata。这里把这些文件当作 server-internal safety/cache
state：`readOnlyHint:true` 描述用户项目资产与外部世界不被修改，不代表内部 metadata
永远无写入。目标项目应忽略 `.tiledmcp`；本仓库
已在自己的 `.gitignore` 中排除它，但服务器不会改任意目标项目的 ignore 规则。复制或提交
registry 会携带已有 ID，却不属于受支持的跨 clone 同步机制；删除/丢失它会丢失 rename
历史并可能重新分配 ID。启动时损坏仍是 fatal；server 运行期观察到
`ASSET_REGISTRY_CORRUPT` 或 `ASSET_REGISTRY_LIMIT_EXCEEDED` 则通过稳定 application error
envelope 报告，不吞成无恢复建议的通用 fallback。capability 还用
`resolutionOrder`、`renameEvidence`、`registeredPathSwap` 固化 path-first 判定顺序，
用 `loadLimitPolicy` / `mutationLimitPolicy` 区分启动加载与运行期增长超限，并用
`crashDurability` 明示首次创建内部目录时不保证断电持久性。

MapService 对一个 map 的 external TSJ 采用 checked batch：先从同一个文件描述符得到 raw
bytes、revision 与 file identity，完成有界候选读取后，在 registry 项目锁内计算 ID，
但只在同步或异步 pre-commit checker 成功后写 registry。checker 先比较所有已捕获
snapshot 的精确 revision guards，再报告延后的 parse/profile/image/GID-range 错误，因此
损坏的 map 或 dependency 不会消耗新 ID、刷新 identity 或推进 generation。若 TSJ 原始
bytes 的 64 MiB 聚合上限在第 k 项终止扫描，checker 仍允许已捕获前缀内的真实 stale
revision conflict 优先；否则固定返回 `RESULT_LIMIT_EXCEEDED`，不继续读取后缀，也不对
必然不完整的 dependency set 做 full-set diff。这样资源上限结果不依赖超限项是否恰好是
最后一项，且所有拒绝路径保持 registry zero-write。

## 6. GID、tileset 区间与变换

### 6.1 无符号 GID

裸 GID 只允许出现在 `documents/codecs/gid.ts` 与 tile-data codec。JavaScript 位运算会产生
有符号 32 位数，所以每一步都必须用 `>>> 0` 归一化：

```ts
const H = 0x80000000 >>> 0;
const V = 0x40000000 >>> 0;
const D_OR_HEX_60 = 0x20000000 >>> 0;
const HEX_120 = 0x10000000 >>> 0;
const FLAGS_MASK = 0xf0000000 >>> 0;
const ID_MASK = 0x0fffffff;

if (!Number.isSafeInteger(input) || input < 0 || input > 0xffffffff) {
  throw new RangeError("GID must be an unsigned 32-bit integer");
}
const u32 = Number(input) >>> 0;
const rawFlags = (u32 & FLAGS_MASK) >>> 0;
const baseGid = (u32 & ID_MASK) >>> 0;
```

读取时无论 orientation 都一次清除四个高位。`baseGid === 0` 表示空 tile；带 flags 的零
base GID 作为异常输入诊断，不能悄悄变成普通空格。

变换必须按 orientation 区分：

```ts
type TileTransform =
  | {
      orientation: "orthogonal" | "isometric" | "staggered" | "oblique";
      flipH: boolean;
      flipV: boolean;
      flipD: boolean;
      rawFlags: number;
    }
  | {
      orientation: "hexagonal";
      flipH: boolean;
      flipV: boolean;
      rotate60: boolean;
      rotate120: boolean;
      rawFlags: number;
    };
```

hexagonal 下 `0x20000000` 是旋转 60°，不是 diagonal flip；`0x10000000` 是旋转 120°。
`rawFlags` 用于无损回显和组合测试，编码时仍要验证结构字段与 raw flags 一致。

### 6.2 `firstgid` 与稀疏 local id

GID 归属先按清除 flags 后的 base GID，选择 `firstgid <= baseGid` 的最大引用，再检查
`localId = baseGid - firstgid` 是否确实属于该 tileset。

不能只用 `tilecount` 推断图片集合 tileset 的范围。计算一个 tileset 的最高潜在 local id 时，
综合：

- atlas 的 `tilecount - 1`；
- `tiles[].id` 的最大值；
- 存在时的 `nexttileid - 1`。

若外部 tileset 无法读取或范围无法证明，自动分配 `firstgid` 必须失败并要求显式处理，不能
猜测。添加 tileset 时使用
`max(firstgid + highestPotentialLocalId) + 1`，即从所有现有区间的最高占用端之后
分配；地图尚无 tileset 引用时结果为 1。结果溢出合法 GID 空间时同样拒绝。删除引用时保留其他引用的
`firstgid` 和中间空洞，**不自动压紧**。未来若提供 compact 工具，它必须显式预览并在一个
可恢复事务中重写所有相关 tile layer 和 tile object GID。

当前挂载入口接收 `mapPath`、`tilesetPath`、`expectedMapRevision`、
`expectedDependencyRevisions` 和可选 `expectedTilesetRevision`。其中
`expectedDependencyRevisions` 只 pin map 已经引用的 read set；尚未被 map 引用的
prospective TSJ 使用独立 revision pin，
其实际 revision 会固化进 change set。preview 对 map、既有依赖和 prospective TSJ 的读取
是 `non-atomic-read-set`：服务端会在返回前复核，并在 apply 时重新检查 map 与所有依赖
revision，但不把顺序读取描述成跨文件原子 snapshot。

该 change set 固定只有一个 add-tileset operation。apply 只对 TMJ 的 `tilesets` 子树执行
一处 source-preserving patch，并复用单 TMJ 的锁、revision CAS、同目录原子替换和
content-addressed checkpoint。因为 TSJ 仅作为只读依赖，当前切片不需要跨文件 WAL，也不
承诺对未遵守锁协议的外部写者提供严格 conditional replace。

plan 分别回显 atlas `tileCount` 与用于分配的 `gidSpan`，后者是
`max(tilecount, max(tiles[].id) + 1, nexttileid?)`；对外的 potential GID 末端和
change-set `gidRange.last` 都按 `gidSpan` 计算。为了避免新增引用把原本无效的 raw GID
重新解释成 tile，签发前会用二分 binding lookup 有界检查最多 1,000,000 个现有 tile
cell 与 tile object；超限或任何当前不可解析 GID 都 fail closed。

### 6.3 图层创建、层级与图片依赖

当前 `tiled_create_layer` 是独立的单操作 planner，只接受 finite orthogonal `.tmj`，
不会把已解析的 `layerId`、父容器 source path 或最终 index 暴露给通用 edits union。
它可以创建 `tilelayer`、`objectgroup`、`imagelayer` 和 `group` 四种空层。各类型共享
Tiled 1.12 的 `id`、`name`、`type`、`x/y = 0`、`visible = true` 与 `opacity = 1`
初值；有限 tile layer 另使用 map 的 width/height 和全 0 numeric data，object/group
分别从空 `objects`/`layers` 开始。

省略 `parentGroupId` 时目标容器是根 `map.layers`；否则按全树唯一 ID 定位一个已存在
Group。`index` 是目标 sibling JSON array 的 0-based 插入点，`0` 位于该组绘制顺序最底，
`length` 位于最顶，省略时追加；越界不会 clamp。planner 递归验证层 ID、层数与深度，
精确分配当前 `nextlayerid` 后递增，保留已有空洞。计数器不大于全树最大 ID、重复 ID 或
有符号 Tiled ID 即将溢出时均拒绝，不能用 `max(id)+1` 顺便修复损坏文档。

为防止对由 `tiled_create_map` 允许的大尺寸地图分配巨型零数组，创建 tile layer 会在分配
前安全计算 `width × height`，当前上限为 100,000 cell；该数量同时计入 change-set cell
write 与 pending 预算。无限地图未来应使用 empty `chunks` 而不是 finite `data`，但这一
语义连同 chunk 边界保持统一留到 M2，当前四种 create 请求在 infinite map 上都返回
`UNSUPPORTED_MAP_PROFILE`。

imagelayer 不接受调用方直接提供 TMJ `image` 字符串，而接收 canonical project-local
`imagePath`。resolver 拒绝绝对路径、逃逸和 symlink，安全图片读取器验证 regular file、
格式、字节/边长/像素预算并取得实际 width/height；服务端再派生 map-relative POSIX
`image`。图片使用与 external TSJ 分离的 opaque asset-ID 哈希域，其 raw bytes revision
作为 prospective dependency 写入 plan；可选 `expectedImageRevision` 在解析图片前先
检查 stale snapshot。preview 返回前和 apply 写盘前都会复核图片，变化或删除均拒绝提交，
且图片自身从不被修改。

preview 还精确 pin map revision 与完整既有 TSJ dependency set，并标记
`snapshotConsistency: "non-atomic-read-set"`。客户端批准后，apply 重新 canonicalize
ID、父 Group、index、图片 source/尺寸/revision 与摘要。提交只对既有 sibling array 做
一次 source-level element insertion，并替换根 `nextlayerid`，继续复用单 TMJ 的锁、CAS、
checkpoint 和同目录原子替换。插入器只接受“目标数组恰好多一个元素且所有旧元素语义不变”
的变更，因此原有 sibling 文本、未知字段和数组外 bytes 全部保留；限制是一次 change set
只能创建一个空层，新 Group 的子层、移动和多层批量创建必须由后续独立能力处理。删除已有
layer 已由独占的 generic `deleteLayer` operation 提供，不属于 create-layer planner。

### 6.4 精确 tile replacement

`replaceTiles` 已作为 `tiled_preview_edits` 的第六种封闭 operation 实现，不注册新的
standalone MCP tool，因此 registry 仍是 18 个 core / 19 个含 rasterizer 的工具。输入为
一个已有 tile layer ID、一到 128 组 `{from: TileRef, to: TileRef|null}` mapping，以及
可选绝对 tile region `{x,y,width,height}`。`from` 不允许为空；`to:null` 才是清空。
region 必须落在 layer 的 `x/y/width/height` bounds 中，省略时扫描完整 layer bounds，
而不是 map bounds。

planner 先把每个 source/target `TileRef` 通过当前 tileset binding 和 orientation 编码为
unsigned raw GID。source 匹配比较完整 encoded GID，包括 orthogonal transform 与
`rawFlags`；省略 transform 精确表示 identity，不构成 wildcard，target 也不会继承 source
flags。编码后重复的 source 和 source=target no-op mapping 会 fail closed。扫描每个 cell
时仍反向解析其 GID，以拒绝 malformed 或没有当前 tileset binding 的值，不能因为它没有
命中 mapping 就跳过合法性检查。

mapping lookup 以扫描开始时该 cell 的 raw GID 为输入，并且每个 operation 只访问一次
cell，因此多组替换是 simultaneous single-pass：`A→B, B→C` 不级联，swap/cycle 保持确定。
不同 operations 仍按 change-set 顺序执行。每个 change set 的 replacement region GID
读取与 flood-fill / copy-region 实际 GID 读取共用 1,000,000-read scan budget；只有 source 命中且
target 不同才计入实际 tile write，并与所有 tile operations 共用 100,000-cell 上限。零命中是合法
no-op，不加入受影响 tile-layer source patch；preview 仍回显规范 region、mapping 数、
扫描数和 `replacedCellCount:0`。

### 6.5 Whole-map tile usage analysis

`tiled_analyze_usage` 是独立的 read-only projection，不进入 change-set registry，也不会
按 layer、region 或 visibility 裁剪范围。它复用有限正交 TMJ + external root-atlas TSJ
binding 校验，递归遍历完整 layer tree；tile layer 必须是 finite numeric `data` array，
object layer 中所有对象消耗 scan budget，带 `gid` 的对象再作为 tile-object 引用解析。
隐藏 layer 和隐藏 Group 不会被跳过。未知 layer type、压缩/string data、chunk、malformed
或未绑定 GID 都 fail closed，不能以部分结果伪装完整 whole-map 分析。

aggregation key 是 `(bindingIndex/assetId, localId)` 对应的 base tile，encoded GID 的
H/V/D/raw flag 位不进入 distinct key；完整 unsigned `rawFlags` 频次、
identity/transformed 总数和每个 tile 的 transformed 引用数另行累计。cell 与 tile
object 引用既分别计数也合并到频率。输出只保留 deterministic bounded projections：
layer density 按密度升序再按 layer ID，tileset 按 unused-first 再按 `firstgid`，top tile
按 cell+object 总引用降序再按 binding/local ID。每个 tileset 还报告 used local ID 数与
`0..tilecount-1` 域内的 unused 数量/有界样本；所有列表携带 returned/omitted/truncated
或等价信息。

输入的 `topTileLimit` 默认 64、最大 128。一个调用最多扫描 1,000,000 个 tile cell +
object、聚合 100,000 个 distinct tile；layer 与 tileset summary 各最多 64 项，单
tileset unused-local-ID sample 最多 16 项，最终 JSON 最多 256 KiB。这些是分析专用预算，
不与 mutation 的 cell-write budget 混用。可选 `expectedMapRevision` 与
`expectedDependencyRevisions` 必须成对出现；dependency record 必须与 pinned map 的
完整 external TSJ read set 精确相等。服务端先从 guarded raw-byte snapshots 构造投影，
完成后重新检查所有 dependency 与 map revision；由于多文件读取无法保证同一时刻原子性，
结果仍明确标记 `snapshotConsistency: "non-atomic-read-set"`。

### 6.6 Common layer member update

`updateLayer` 是 `tiled_preview_edits` 封闭 union 的第 7 种 operation；wire shape 为
`{type:"updateLayer", layerId, patch}`。它不注册 standalone `tiled_update_layer`，
所以 registry 仍为 18 core / 19 with rasterizer。planner 以正整数 `layerId` 递归定位
已有 `tilelayer`、`objectgroup`、`imagelayer` 或 `group`，不接受名称 fallback，也不
改变 layer hierarchy、sibling order 或 ID。

patch 必须非空且 exact-key；公共字段到 raw TMJ member 的映射固定为：
`name→name`、`className→class`、`visible→visible`、`opacity→opacity`、
`offsetX/Y→offsetx/y`、`parallaxX/Y→parallaxx/y`、`tintColor→tintcolor`、
`locked→locked`、`blendMode→mode`。name/class 各最多 1024 characters；opacity
为有限 `0..1`；offset/parallax 为 ±1,000,000,000 内有限数；tint 是
`#RRGGBB`、`#AARRGGBB` 或删除用 `null`。blend mode 使用 Tiled 1.12 的封闭 13 项：
`normal`、`add`、`multiply`、`screen`、`overlay`、`darken`、`lighten`、
`color-dodge`、`color-burn`、`hard-light`、`soft-light`、`difference`、
`exclusion`。`locked` 只是编辑器 advisory metadata；planner 不把它解释为 ACL，同批
tile/object edit 仍按请求执行。

change detection 对 raw JSON object member 的存在性和值负责，而不是对 Tiled 默认值做
归一化。已有 member 与请求值相同、或 `tintColor:null` 删除一个缺失 member 时是 no-op；
缺失 `visible/opacity/offset/parallax/locked/mode` 时显式写入其语义默认值仍算 change。
每个 operation 的 plan summary 与 bounded preview 都携带 `requestedFields`、
`changedFields`、`wouldChange` 和 `affectsDescendants`；只有 Group 中实际改变
visible/opacity/offset/parallax/tint/mode 时后者为 true，用来提醒显示属性可能影响
descendants，而不是宣称递归修改了子层。name/class/locked 与 no-op 不置位。全 no-op
plan，以及顺序 operation 最终回到原始 JSON 的 net no-op，在 apply 时都返回
`changed:false`，不创建无意义文件 diff；逐 operation summary 仍忠实记录中间变化。

source writer 将 `changedFields` 转成 layer object 上的 member-local
insert/replace/delete，并以 layer path + raw member key 去重；它不序列化完整 layer。
因此同一个 change set 可把 layer member patch 与 tile `data` subtree、object
`objects` subtree edits 合并，同时保持未触及成员、相邻 layer、未知字段、BOM、CRLF、
缩进、键序和数字/字符串词法。完整 target semantic tree 校验仍是最后防线。preview
固定 map 与完整现有 dependency read set；apply 重新 canonicalize operation/summary，
验证 change-set digest 和 revision pins，并在锁内做正常 CAS。move、delete、duplicate
不属于 `updateLayer`；三者都由下列独占 operation 实现。

### 6.7 Exclusive layer-subtree deletion

`deleteLayer` 是 `tiled_preview_edits` 封闭 union 的第 8 种 operation，wire shape 为
`{type:"deleteLayer", layerId, deleteDescendants?}`。它没有 standalone tool，因此工具
面保持 18 core / 19 with rasterizer。planner 在任何语义 mutation 之前先统计
`deleteLayer`：只要出现一次，operations 总长度必须恰为 1；出现多次或与
tile/object/updateLayer 混批都拒绝。这个 exclusivity 让 subtree/reference/source
边界始终相对于同一个原始 map snapshot 计算。

正整数 `layerId` 递归定位 `tilelayer`、`objectgroup`、`imagelayer` 或 `group` 的直接
parent array 与 index。非 Group layer 和空 Group 可直接删；非空 Group 只有
`deleteDescendants:true` 才继续，否则返回 `LAYER_HAS_DESCENDANTS` 和 descendant count。
确认并不把 children 提升一级：选中 layer 是父 array 中唯一被删除的 element，完整
subtree 和其中所有 tile data、image-layer JSON references、objects 随之消失；外部
image/TSJ 文件不删除，祖先和其他 siblings 保留。

subtree inspection 递归验证 layer type/ID、深度与计数，收集所有被删 object ID 和
`locked:true` layer。若有对象，dangling-reference scanner 跳过整棵待删 subtree，只分析
存活 map：直接 `object` property 和 Tiled 1.12 `list` 中的 typed object item 命中待删
ID 时返回 `OBJECT_IN_USE`；任何存活 `class` property 都可能封装无法安全解析的 object
reference，因此 fail closed。这样 subtree 内部互引可一起删除，而 surviving document
不会留下已知或可能隐藏的悬挂引用。

preview 固定目标 type/name、`parentGroupId`、原 sibling `index` 并标为 destructive。
摘要返回完整 `deletedLayerCount`、`descendantLayerCount`、`objectCount` 与
`lockedLayerCount`；layer/object ID 分别最多返回 32 个 preorder sample，并给出
`omittedLayerCount` / `omittedObjectCount`。任何 locked layer 都进入 warning，但
`locked` 是 advisory metadata，不是授权或 ACL，不能阻止批准后的删除。

apply 重新检查 operation exclusivity、目标位置、subtree summary、object references、
map/dependency revisions 与 plan digest。删除不修改 `nextlayerid` 或 `nextobjectid`，
高水位不会倒退或复用。source patch 是一次 array-element-local deletion：syntax-tree
writer 验证 target array 恰少一个指定元素且其他元素语义逐项一致，只调整删除所必需的
element/comma/whitespace；未触及 sibling、祖先、未知字段、BOM、CRLF、键序与其他词法
保持原 bytes。锁内 revision CAS、checkpoint 与同目录原子替换仍是唯一提交边界。

### 6.8 Exclusive layer-subtree move

`moveLayer` 是 `tiled_preview_edits` 封闭 union 的第 9 种 operation，wire shape 为
`{type:"moveLayer", layerId, parentGroupId?, index}`。它没有 standalone
`tiled_move_layer`，所以 registry 保持 18 core / 19 with rasterizer。与 deletion
一样，planner 在 mutation 前强制 exclusivity：一个含 move 的 change set 必须且只能有
这一项，多个 move 或与 tile/object/update/delete 混批都拒绝，从而让 source/target
container path 与 subtree summary 始终基于同一个原始 map snapshot。

`layerId` 与显式 `parentGroupId` 是正整数；省略 `parentGroupId` 表示 root
`layers`，输入不接受 `null`，而 preview 输出用 `null` 表示 root parent。显式 parent
必须存在且为 Group。`index` 定义为移动完成后的最终 0-based JSON sibling index，而非
删除前的 insertion boundary：同父原长度 `n` 接受 `0..n-1`，跨父目标原长度 `m` 接受
`0..m`。同父且 source/target index 相同是合法 no-op；apply 返回 `changed:false`，
文件 bytes、revision 与 checkpoint 状态均不发生无意义变化。

Group 作为完整 subtree 移动，children 不提升，旧父 Group 变空时也不会自动删除。
planner 在 splice 前收集 subtree ID 并拒绝把 Group 移入自身或任一 descendant；再以目标
parent 的 child depth 加 subtree 最大相对深度计算最终嵌套，超过统一深度预算 64 时
fail closed。move 保留全部 layer/object ID，不降低或重用 `nextlayerid` /
`nextobjectid`。

summary 的 `movedLayers` 项固定 `sourceParentGroupId`、`sourceIndex`、
`targetParentGroupId` 与最终 `targetIndex`，并返回完整 `subtreeLayerCount`、
`descendantLayerCount`、`objectCount`、`lockedLayerCount`。preorder
`layerIdSample` 最多 32 项并搭配 `omittedLayerCount`。`wouldChange`、
`renderOrderMayChange`、`renderContextMayChange` 与 `affectsDescendants` 分开表达
sibling 绘制顺序、换父后的 Group 继承上下文与后代影响。`affectedLayerIds` 只包含选中
subtree root，不能把它误读为完整影响集合。

`locked` 仍是 Tiled advisory metadata，不是 ACL，显式或继承 locked 都不会阻止移动。
planner 分别报告 source/target 直接 parent 的 lock，以及
`effectivelyLockedLayerCountBefore` / `effectivelyLockedLayerCountAfter`；有效 lock
统计把祖先 Group 的继承与 subtree 内显式锁都计入，preview warning 因而能指出换父导致的
lock context 变化，而不谎称递归改写了 child 的 `locked` member。

source writer 使用专用 `JsonArrayMove`，不能把 ordinary insertion 的
`JSON.stringify` 与 deletion 简单拼接。source/target container path 均按原始 source
document 解析并先保存容器引用，所以移除较早的 root sibling 导致后方目标 Group 在最终
tree 中换位时仍定位正确。同父 move 在一个数组的最小连续跨度内重排；跨父 move 从 source
element syntax node 捕获 exact bytes，再插入目标 array，只重写源/目标 seam 必需的
comma 与 whitespace。被移动 subtree 内的未知字段、排版、数字和转义词法保持逐 byte
不变，未触及 sibling/ancestor 及 BOM、CRLF、键序也保留；补丁后仍严格解析并与完整
target semantic tree 比较。

preview 固定 map revision 与完整 dependency revision set。apply 重新规划 source、
target、cycle/depth、summary 与 source-patch descriptor，验证 change-set digest 和
revision pins，再进入同一进程/文件锁、raw-byte CAS、写前 content-addressed checkpoint
和同目录原子替换边界；tampered 或 stale plan 在任何写盘前拒绝。

### 6.9 Exclusive safe layer-subtree duplication

`duplicateLayer` 是 `tiled_preview_edits` 封闭 union 的第 10 种 operation，wire shape
为 `{type:"duplicateLayer", layerId, destination?, name?}`。它没有 standalone
`tiled_duplicate_layer`，registry 仍为 18 core / 19 with rasterizer。planner 在 clone
前强制 operations 总长度恰为 1，拒绝 multiple duplicate 或与
tile/object/update/delete/move 混批；这样 source location、target container、ID
inventory、reference graph 和 source patch 都来自同一个原始 snapshot。

`destination` 是 strict discriminated union：
`{kind:"sameParent", index?}`、`{kind:"root", index?}` 或
`{kind:"group", parentGroupId, index?}`。整个字段省略与无 index 的 `sameParent`
相同，插在 source 当前 `sourceIndex + 1`；root/group 分支省略 index 时 append。
显式 index 是插入完成后的最终 0-based JSON sibling index。duplicate 不移除 source，
因此统一接受 `0..target.length`。显式 Group ID 必须存在且类型正确；source Group 及其
descendant Group 不能作为目标，结果 child depth 加 subtree 最大相对深度不得超过 64。
可选 `name` 最多 1024 characters（空字符串合法），只替换 copied subtree root 的
`name`，不影响 source 或 copied descendants。

planner 递归复制完整 layer element，而不是把 Group children 提升或拆成多次插入。它先
验证全图 layer/object inventory 和根 counter，再以原 `nextlayerid`、`nextobjectid`
分别为起点，按 subtree preorder 给所有 layer/object 连续分配新 ID。计数器推进到新
high-water mark，不回填 gap；若 subtree 没有 object，`nextobjectid` 不产生 semantic
或 source patch。allocation 必须留在 Tiled signed 32-bit ID 空间内。复制后全图最多
10,000 layers、100,000 objects；单次最多复制 10,000 objects 和 100,000 个 finite
uncompressed tile cells；最终深度最多 64。compact duplicate 序列化结果最多 16 MiB，
原 source bytes 加保守 insertion/counter overhead 后最多 64 MiB。

ID 分配后才扫描 semantic copy 中的 properties。direct `type:"object"` property 与
Tiled 1.12 `type:"list"` 内任意层级的 typed object item 都使用同一 traversal：
reference 命中 copied-object mapping 时改为新 ID；指向副本外仍存在的 object 或 ID 0
时保留；dangling ID 拒绝。普通 `int` property 不是 typed object/layer reference，不
猜测或重写；非标准 `type:"layer"` reference 同样 fail closed。`type:"class"`
可能隐藏 schema-defined object references，而 object `template` 需要独立 revision pin，
当前均拒绝。`type:"file"` property 与 image-layer `image` 仅复制字符串引用，外部文件
继续共享，不读取、复制或修改。

tile-layer data 中每个 GID 与 tile-object `gid` 都经当前 finite-orthogonal external
atlas binding 校验；tile object 的完整 encoded GID（包括 H/V/D/raw flags）保持不变。
这保证 copy 不会把 malformed/unbound tile reference 固化进新 subtree。`locked` 仍是
Tiled advisory metadata：显式锁随 semantic copy 保留，目标祖先 Group 的继承锁通过
`effectivelyLockedLayerCount` 另行反映；锁只触发 warning，不作为授权边界。

plan summary 的 `duplicatedLayers` item 精确包含 `operationIndex`、`sourceLayerId`、
`createdRootLayerId`、`layerType`、`name`、`nameTruncated`、
`sourceParentGroupId`、`targetParentGroupId`、`sourceIndex`、`targetIndex`、
`copiedLayerCount`、`descendantLayerCount`、`copiedObjectCount`、
`allocatedCellCount`、`serializedDuplicateBytes`、`layerIdMappingSample`、
`omittedLayerMappingCount`、`objectIdMappingSample`、`omittedObjectMappingCount`、
`remappedInternalObjectReferenceCount`、`retainedExternalObjectReferenceCount`、
`fileReferenceCount`、`tileObjectCount`、`lockedLayerCount`、
`effectivelyLockedLayerCount`、`renderOrderMayChange`、
`renderContextMayChange` 和 `affectsDescendants`。两类 preorder mapping sample 各限
32 项，omitted count 显式标记截断；summary 的名称也按 display budget 有界。

source writer 将变换后的 semantic copy 用 `JSON.stringify` 生成单个 compact JSON
element，再用 local array insertion 插入目标 container；它不会复用 source subtree 的
raw span，因为新 ID、内部 reference 与可选 root name 已改变。source subtree 本身、所有
既有 sibling/ancestor、未知字段、BOM、CRLF、缩进、键序和未触及数字/字符串 lexeme
仍保持 exact bytes。`nextlayerid` 与必要时的 `nextobjectid` 分别走 numeric-value-local
counter replacement，所以写回边界是一次 element insertion 加一到两个小 counter patch，
不是整图重序列化。

preview 固定 map revision、完整 dependency revision set、operation 与 digest。apply
从 guarded source 重新定位 destination、分配 preorder ID、验证 GID/reference/限制、
重算 bounded summary，并让 source patcher 对完整 target semantic tree 做终检。全部一致
后才进入同一进程/文件锁、raw-byte CAS、写前 content-addressed checkpoint 和同目录原子
替换；stale revision、tampered plan 或被外部改动的 raw bytes 都在写盘前拒绝。

### 6.10 Dense tile-pattern stamp

`stampPattern` 是 `tiled_preview_edits` 封闭 union 的第 11 种 operation，wire shape 为
`{type:"stampPattern", layerId, x, y, pattern:(TileRef|null)[][]}`。它没有 standalone
`tiled_stamp_pattern`，registry 仍为 18 core / 19 with rasterizer。与 `setTiles` /
`fillRegion` / `replaceTiles` 一样，它只接受 finite orthogonal、numeric-array tile
layer；`layerId` 是正整数，`x/y` 是 pattern 左上角的绝对 tile 坐标。

schema 要求 `pattern` 是非空、稠密、矩形、row-major 的二维数组：外层至少一行、每行至少
一项、所有行等宽，wire 中不能出现 sparse hole/`undefined`。宽和高分别不超过 256，
`width × height` 不超过 16,384。planner 用 checked arithmetic 从 origin 和矩阵尺寸
计算半开目标矩形，并要求它完整落在 layer 的 `x/y/width/height` bounds 内；不会把越界
图案裁剪成部分成功。

每个矩阵 entry 都是写入意图。`TileRef` 经当前 tileset binding 和 orientation 编码为完整
unsigned GID，保留显式 transform/raw flags；`null` 编码为 GID 0，明确清空目标格，不是
transparent/skip。当前不存在其他 skip sentinel，因此 pattern 的 `cellCount` 就是其覆盖和
预算计数。清空纯矩形仍可直接用 `fillRegion` + `tile:null`，无须新增 `clearRegion`。

planner 按 change-set operations 的数组顺序修改同一工作副本：后面的 operation 看到前面
的结果，重叠时 later wins。该规则适用于 stamp 与 `setTiles`、`fillRegion`、
`replaceTiles`、`floodFill`、`copyRegion`、其他 stamp 的任意交叠；`replaceTiles` 的
simultaneous single-pass 只描述
它自身对进入该 operation 时快照的 mapping 求值。每个 stamp 的所有 pattern cells，即使
编码后与当前 GID 相同，也计入所有 tile operations 共用的 100,000-cell write budget。

plan 的 `tileStamps` summary 固定 operation/layer、规范化 region、`cellCount`、
`nonEmptyCellCount`、`clearCellCount`、`transformedCellCount`、`changedCellCount` 与
`wouldChange`。面向批准的 bounded operation preview 另按 row-major 返回至多 8 个绝对
`{x,y,tile}` `sample`（包括 `tile:null`），并以
`omittedCellCount = cellCount - sample.length` 明示截断；调用方不能把 sample 当作完整
图案。apply 重算同一 summary 和 bounds/GID/budget 校验后，只为实际变化的目标 tile layer
生成 `data`-member-local source patch。若全部目标 GID 已相同，stamp 的
`changedCellCount` 为 0、`wouldChange:false`；整个 plan 也无其他变化时返回
`changed:false`，不创建 checkpoint、不改变 revision，并保留文件 exact bytes。

### 6.11 Fixed four-way tile flood fill

`floodFill` 是 `tiled_preview_edits` 封闭 union 的第 12 种 operation，wire shape 为
`{type:"floodFill", layerId, x, y, tile:TileRef|null}`。它没有 standalone
`tiled_flood_fill`，registry 仍为 18 core / 19 with rasterizer。与其他 M1 tile edit
相同，它只接受 finite orthogonal、numeric-array tile layer；`layerId` 是正整数，
`x/y` 是 seed 的绝对 tile 坐标，必须落在该 layer 自身的
`x/y/width/height` 半开 bounds 内。pixel offset 与 Group rendering offset 不参与 cell
坐标。

连通性固定为四向，上、下、左、右相邻才能连通；wire 不接受 connectivity 参数，也不会把
纯对角 cell 加入区域。source 不由调用方提供。planner 严格按 change-set operation 顺序
修改同一工作副本，并在执行到 flood 时读取 seed 当前值，因此先前的
set/fill/stamp/replace/flood/copy 可以改变本次 source，后续 operation 又可以覆盖填充结果。
该顺序规则仍是 later wins。

source matching 比较完整 unsigned encoded GID，而不是仅比较 base tile。H/V/D 与
orthogonal 保留 raw flag 都参与数值相等，省略 transform 的 target 表示 identity，绝不
充当 wildcard。target `tile:null` 编码为 GID 0、用于清空连通区；seed 本身也可为 GID 0，
从而把相连空区填成非空 TileRef。target 会经当前 external-atlas bindings 与 orientation
完整验证并 canonicalize。若 source 与 target 编码相同，planner 仍读取并反向验证 seed，
随后立即 short-circuit：`scannedCellCount:1`、`changedCellCount:0`、
`affectedBounds:null`，不会为无修改意图扫描整个连通区。

实现使用有界迭代队列，不递归调用 JS 栈。每找到一个 source cell 就立即把它写成 target，
这同时充当 visited 标记；四向展开期间，同一个已填 cell 或不匹配的边界邻格可能从不同
方向再次被观察。`scannedCellCount` 因而严格表示实际 GID 读取次数，而不是 distinct
coordinate 数。每次读取都在比较 source 之前调用完整 GID reverse resolution：
非整数/数组 hole、超出 unsigned 32-bit、带 flags 的空 base、tileset gap 或未绑定 GID
全部 fail closed；不能以“不匹配 source”为由跳过。未被该局部遍历观察的远端 cell 不在
此次验证范围内。

planner 用 change-set 级 `tileOperationScans` 对 replacement、flood 与 copy 的每次实际读取统一
计数，上限为 1,000,000；超限在继续读取前返回 `RESULT_LIMIT_EXCEEDED`。每个 source cell
在 target 不同时都形成一次实际变化，和其他 tile operations 共用 100,000-cell write
budget；超限拒绝整个 plan，不提交 partial fill。原 TMJ 仍由 plan/apply 工作副本与
revision-pinned commit boundary 保护，规划错误不会写盘。

`tileFloodFills` summary 固定回显 `operationIndex` / `layerId` 关联；operation preview
以数组位置关联 operation，并回显 `layerId`。二者都回显绝对 `seed`、
`connectivity:"four-way"`、canonical `sourceTile` /
`targetTile`、`scannedCellCount`、`changedCellCount`、`wouldChange` 与
`affectedBounds`。bounds 是实际变化 cell 的最小绝对外接矩形，不能解释为实心区域；
preview 不返回 cell list 或 sample，因此输出大小固定有界，无变化时 bounds 为 `null`。

apply 从 pinned source 重算 seed source、GID validation、四向 traversal、共享 scan/write
预算和 summary；只有实际变化的目标 layer 才进入 `affectedTileLayerIds` 并生成
`data`-member-local source patch。source=target 或 mixed operations 最终还原原数据的
net no-op 返回 `changed:false`，不创建无意义 diff，revision 与 source bytes 保持精确
不变。

### 6.12 Map-root member update

`updateMap` 是 `tiled_preview_edits` 封闭 union 的第 13 种 operation，wire shape 为
`{type:"updateMap", patch}`。它不注册 standalone `tiled_update_map`，registry 仍为
18 core / 19 with rasterizer。operation 与 patch 都使用 exact-key schema；patch 必须
非空，并仅允许 `renderOrder`、`backgroundColor` 与 `className`。

字段到 TMJ 根成员的映射固定为 `renderOrder→renderorder`、
`backgroundColor→backgroundcolor`、`className→class`。render order 是 Tiled 正交地图
的封闭四项枚举：`right-down`、`right-up`、`left-down`、`left-up`；背景色只接受
`#RRGGBB`、`#AARRGGBB` 或删除 member 用的 `null`；class 是最长 1024 个 Unicode code points
的字符串。额外 key、空 patch、未知 render order、其他颜色表示和过长 class 均在规划前
拒绝。

map summary 将缺失的 `renderorder` 规范化为 `right-down`，并有界返回存在的
`backgroundColor` / `className`；超长已有 class 按 Unicode code-point 边界截断并标记
`classNameTruncated:true`，不会切出 lone surrogate。无效 root render order、背景色或
非字符串 class 在摘要阶段 fail closed。

planner 按 operations 数组顺序作用于同一 semantic 工作副本，后一个 operation 能观察并
覆盖前一个 `updateMap` 的结果，因此重复字段使用 later-wins 语义。change detection
不把 Tiled 默认值折叠进 raw JSON：已有 member 与请求值相同、或删除一个缺失的
`backgroundcolor` 是 no-op；对缺失 member 显式写入默认等价值仍是 change。

plan summary 的 `mapUpdates` 项按 `operationIndex` 关联，bounded operation preview
则按 operations 数组位置关联；二者都回显 `requestedFields`、`changedFields`、
`wouldChange` 和 `renderingMayChange`。最后一个标记只在 `renderOrder` 或
`backgroundColor` 实际改变时为 true；class-only change 与 no-op 不置位。它提示静态
渲染结果可能改变，不宣称 renderer 已支持所有受影响语义。

source writer 将最终 changed root fields 编译为 object-member-local
insert/replace/delete，并按 raw member key 合并顺序 intents；它不序列化根对象，也不
触碰 `layers`、`tilesets` 或未知 siblings。patch 后仍解析完整 target semantic tree，
preview 固定 map revision 与完整 dependency read set，apply 重算 operation/summary、
验证 digest 与 revision pins 后再走 CAS/checkpoint/原子替换。若中间 operations 有变化
但最终根成员回到 pinned source，文件级结果为 `changed:false`，不生成 source patch，
revision 和原始 bytes 精确不变。

### 6.13 Exclusive unused external-tileset reference removal

`removeTilesetFromMap` 是 `tiled_preview_edits` 封闭 union 的第 14 种 operation，wire
shape 为 `{type:"removeTilesetFromMap", tilesetAssetId}`。它不注册 standalone
`tiled_remove_tileset_from_map`，所以 registry 仍为 18 core / 19 with rasterizer。
operation 使用 exact-key strict schema；`tilesetAssetId` 只能精确定位当前 map 已引用且
通过 M1 external root-atlas profile 的 binding，不接受 path/name fallback、embedded
tileset、未知 ID 或额外 key。

removal 必须是 change set 中唯一的 operation。它不能与 tile/object/layer/map update、
另一个 removal 或会改变 dependency closure 的专用 proposal 混批；否则“仍在使用”检查
可能依赖同批顺序并产生含糊的授权边界。该能力也不接受 clear/remap policy：只要 binding
仍被引用，整个 proposal 就失败，不把引用如何处理的额外 destructive 决策藏在“移除引用”
之内。

planner 首先固定当前完整 external tileset binding 表，然后递归扫描 map 的完整 layer
tree。每个 finite tile-layer cell 和每个 object-layer object 都消耗预算，隐藏 layer、
不可见祖先 Group、`locked:true` 以及任意 Group 深度均不能跳过；带 `gid` 的 tile object
和非零 cell 都用现有 GID codec 按完整 unsigned encoded GID 解析，transform/raw flags
不会改变其 base binding 身份。tile cells 与 objects 合计上限为 1,000,000，超限在继续
读取前返回 `RESULT_LIMIT_EXCEEDED`。任一解析结果命中目标 `assetId` 时返回
`TILESET_IN_USE`；planner 不清空 tile cell、不删除 tile object、不把 local ID 映射到
相邻 `firstgid` 区间，也不留下 unresolved GID。object 只要存在 `template` member 就以
`UNSUPPORTED_TILESET_REMOVAL_TEMPLATE` fail closed；在模板文档及其依赖 revision 尚未
纳入 read set 前，不能从实例缺少内联 `gid` 推断目标 binding 未使用。

成功 plan 的 `summary.removedTilesets[]` 使用扁平字段 `operationIndex`、`assetId`、
`tilesetPath`、`source`、`tilesetRevision`、`name`、`nameTruncated`、原
`tilesets` array `index`、`tileCount`、`gidSpan`、`firstGid`、`lastGid`、
`scannedCellCount` 与 `scannedObjectCount`。bounded operation preview 不含
`operationIndex`，而是按 operations 数组位置关联；其完整 shape 是顶层
`type` / `destructive` / `warning` / `source` / `index`，以及
`tileset:{kind,assetId,path,revision,name,nameTruncated?,tileCount,gidSpan}`、
`gidRange:{first,last}`、`scanned:{tileCells,objects}`，其中
`tileset.nameTruncated` 只在 true 时出现。`destructive` 固定为 true：虽然 TSJ 和 atlas
图片仍保留，map 会永久丢失这条 binding，未来相同 GID 也不会被隐式赋予别的含义。完整
字段和扫描计数进入 plan digest，避免客户端批准一个比 apply 实际删除目标更模糊的摘要。

dependency CAS 使用**移除前的完整 dependency set**。preview 不能提前排除目标 TSJ；
apply 在 map 锁内重新加载所有旧 external dependencies，复核每个 raw-byte revision，
然后重算 binding 解析、扫描预算、零引用结论和完整 summary。source writer 使用单个
array-element-local deletion，只删除 pinned `tilesets[index]`；其余 binding 的
`firstgid`、相对 source、顺序和 exact bytes 都保持不变。提交仍只修改 TMJ，并走正常
checkpoint/CAS/原子替换；不会删除或改写目标 TSJ、atlas image 或其他项目文件。

### 6.14 Snapshot tile-region copy

`copyRegion` 是 `tiled_preview_edits` 封闭 union 的第 15 种 operation，wire shape 为
`{type:"copyRegion",source:{layerId,x,y,width,height},destination:{layerId,x,y}}`。
它不注册 standalone `tiled_copy_region`，所以 registry 仍为 18 core / 19 with
rasterizer。operation、source 与 destination 均使用 exact-key strict schema；source
和 destination 必须属于同一 pinned map，两个 `layerId` 都必须定位 finite orthogonal、
numeric-array tile layer。infinite/chunk、字符串/base64 data、压缩层、未知 key、非正
width/height 或非整数坐标都在 mutation 前拒绝。

坐标统一为各 layer 空间中的绝对 tile 坐标，与 pixel/Group offset 无关。source 的
`width/height` 同时确定 destination 尺寸；checked arithmetic 计算两个半开矩形，并要求
它们完整落在各自 layer 的 `x/y/width/height` bounds 内。没有 clipping、wrap、部分成功
或透明/skip sentinel。source GID 0 是显式数据，会清空对应 destination cell。

planner 执行到该 operation 时先读取并保存完整 source snapshot 和完整 destination
snapshot，完成两侧验证后才写工作副本。这给 same-layer overlap 固定
snapshot-source/memmove 语义：向上下左右任意方向重叠复制都不能把较早写入的新值继续
传播。每个 source raw GID 原样成为对应 target，H/V/D 与保留 raw flags 不重新编码或
丢失。source 和 destination 的每个 observed value 都经统一 GID reverse resolution；
非整数/array hole、uint32 溢出、flag-only empty、tileset gap 或 unbound GID 全部 fail
closed，不能因 source 为 0、destination 即将被覆盖或该格最终 no-op 而跳过。

copy 是可混批 operation。它的 source snapshot 包含所有前序 operation 的结果，后序
set/fill/stamp/replace/flood/copy 可以覆盖 destination；不同 operations 统一执行
sequential change-set order 和 last-write-wins。operation 内 source/destination 则始终
来自同一个 operation-start snapshot，不能受本次写回影响。

`cellCount = width * height`，每格读取 source 与 destination 各一次，所以
`scannedCellCount = 2 * cellCount`，并计入 replace/flood/copy 共用的 change-set 级
1,000,000-read `tileOperationScans`。完整 `cellCount`，包括写入相同值的格子，计入所有
tile operations 共用的 100,000-cell write budget。预算在修改前完整验证，任何超限均拒绝
整个 plan，不产生 partial copy。

plan 的 `summary.tileCopies[]` 精确 shape 为
`{operationIndex,source:{layerId,x,y,width,height},destination:{layerId,x,y,width,height},`
`scannedCellCount,cellCount,sourceNonEmptyCellCount,changedCellCount,`
`overwrittenNonEmptyCellCount,clearedCellCount,overlapsSource,wouldChange}`。
`sourceNonEmptyCellCount` 统计 source 中非零 GID；`overwrittenNonEmptyCellCount` 统计
operation-start destination snapshot 中全部非零 GID，无论对应格最终是否变化；
`changedCellCount` 才统计 source/destination 值不同的格子；`clearedCellCount` 是
source 为 0 且实际把非零 destination 清空的格子；`overlapsSource` 仅表示同 layer
两个矩形相交。

bounded operation preview 使用相同字段但不含 `operationIndex`，另固定
`type:"copyRegion"`、`destructive:true` 与 `warning`。destination preview
规范化补齐 `width/height`，且不返回 cell list/sample；授权界面必须依据完整 region 和
counts 展示影响，不能假设未列出的格子会被跳过。完全相同的 source/destination 值仍消耗
完整 scan/write intent 预算，但回显 `changedCellCount:0`、`wouldChange:false`。

`tiled_get_capabilities.tileCopyCapabilities` 精确固定为：

- `coordinates: "absolute-tile-coordinates"`；
- `clipping: false`；
- `overlap: "snapshot-source-memmove"`；
- `emptySource: "overwrites-and-clears"`；
- `gidCopy: "exact-encoded-gid"`；
- `observedGidValidation: "source-and-destination-fail-closed"`；
- `operationOrdering: "sequential-change-set-order-last-write-wins"`；
- `scanBudget: "shared-with-replaceTiles-and-floodFill-per-change-set"`；
- `sourcePatch: "destination-tile-layer-data-member-local"`。

apply 从 pinned map/dependency read set 重放 operations，重取两个 snapshots 并重算
bounds、GID validation、共享预算与完整 summary；copy 执行时实际变化的 destination
layer 才进入 `affectedTileLayerIds`。source writer 仅把这些 destination tile layer 的
`data` member 作为 patch 候选，跨 layer copy 不触碰 source layer；same-layer copy 也只
patch 一处。mixed operations 最终还原原始 destination 时，source diff 会折叠为
exact-byte net no-op，返回 `changed:false`，不创建无意义 diff。

### 6.15 Strict ellipse/capsule object shapes

对象能力仍属于 `tiled_preview_edits` 的现有 `createObject` / `updateObject` /
`deleteObjects` operations，不注册 standalone object tools，因此 registry 保持
18 core / 19 with rasterizer。create wire 的 `object` 使用以 `shape` 判别的 exact-key
strict union：rectangle 保持可选尺寸，point 不允许尺寸；ellipse/capsule 的 `width`
和 `height` 也可省略，并按 Tiled 语义规范化为 0，显式提供时必须为有限、非负且不超过
1,000,000,000 的数。

planner 为新对象分配现有 `nextobjectid` 高水位，并把 wire-only `shape` 转成 Tiled JSON：
rectangle 不写形状 marker，point 写 `point:true`，ellipse 写 `ellipse:true`，Tiled 1.12
capsule 写 `capsule:true`。形状 marker 必须唯一且值严格为 `true`；混合 marker、错误
boolean 或 polygon/polyline/text/tile/template 等不在当前 editable profile 的对象继续
fail closed。

四类基础对象都可以 update/delete，但 update patch 故意没有 `shape`，因此不能在一次
普通字段更新中改变对象形状。每次 update/delete 前都重新从 marker 推导现有 shape；
存量对象缺失的 width/height 按 Tiled 语义解释为 0，显式存在时必须继续为有限非负数，
即使 patch 只修改 x/name 等其他字段，也不能让已有无效尺寸混入已验证结果。对这两类
对象把 width/height 更新为 0 是合法 Tiled 语义；null、负数、非有限数和超过 1e9 的值
在任何 working-copy mutation 前拒绝。rectangle 延续非负尺寸语义，point 延续零尺寸
语义。

source writer 继续只把实际受影响 object layer 的 `objects` member 作为 patch 候选，
create 时另做 `nextobjectid` value-local patch。marker、尺寸和其他对象字段一起位于同一
最小 objects 子树；其他 layers、tilesets、未知 root siblings、BOM/CRLF 与未触及词法
保持原 bytes。preview/apply 仍重算 shape/profile、summary 与完整 dependency pins，并
通过 revision CAS、checkpoint 和原子替换提交。

`tiled_get_capabilities.objectShapeCapabilities` 精确固定为
`{creatable:["rectangle","point","ellipse","capsule"],shapeMutation:false,`
`ellipseAndCapsuleDimensions:"optional-nonnegative-default-zero",`
`sourcePatch:"object-layer-objects-member-local"}`。`creatable` 只描述 create wire union；
四种 shape 都继续支持基础字段 update 和 safe delete。

## 7. Tile data、chunk 与压缩

tile layer 使用 lazy `TilePlaneView`。读取摘要不解压整层；只有区域查询、编辑或完整校验才
加载对应数据。

### 7.1 有限地图

- 保留原始数组/base64 表示、元素顺序、encoding 和 compression。
- 修改某层时才解码该层；写回默认保持原编码，不做隐式转码。
- 解码后长度必须与 `width × height` 相符，每个值必须是 `0..0xffffffff` 的整数。

### 7.2 无限地图

任意合法 chunk 的 `x/y/width/height`、顺序和边界都要保留，不能统一重切成 16×16：

- 未修改 chunk 的原始文本保持不变。
- 修改已有格子只重写拥有该格子的 chunk。
- 新格子不在任何 chunk 时，按显式 `chunkSize` 或该 layer 的既有主尺寸创建新 chunk；
  不能移动、合并或重切其他 chunk。
- 重叠 chunk、非正尺寸和数据长度不匹配必须报诊断；不能以“最后一个覆盖前一个”掩盖问题。
- `startx/starty` 等派生边界按目标格式规则更新，但不借机改变 chunk 布局。

16×16 只是 Tiled 常见默认值，不是文件格式不变量。

### 7.3 压缩安全

- base64 严格解码；结果长度必须是 4 的倍数，并与预期 cell 数一致。
- gzip/zlib 采用带输出上限的流式解压；zstd codec 不可用时保留源文本并拒绝需要解码的操作。
- 分配内存前用 checked arithmetic 计算 `cells × 4`，拒绝整数溢出和超出配额。
- 同时限制单文档字节数、单层 cell 数、单请求编辑 cell 数和总解压字节数。
- 不因保存其他字段而重新压缩未触及 layer；显式转码工具才允许改变 compression。

## 8. Revision、锁与提交

### 8.1 Revision 与 CAS

公开 `Revision` 是已存在文件原始 bytes 的 SHA-256；mtime 只可用于缓存快速失效提示，
不能作为并发判断。所有既有目标的写请求和 change set 都携带
`expectedRevision`。唯一 direct create-map 例外不接收调用方构造的 missing revision：
服务器在锁内验证目标缺失，并以 hard-link no-replace promotion 把“仍不存在”作为原子
precondition。

每个目标文件使用两层锁：

1. 进程内按 normalized project path 的异步 mutex；
2. `.tiledmcp/locks/<sha256(normalized-project-path)>.lock` 的跨进程 advisory lock。

锁按 normalized project path 排序获取，避免死锁。它不是 inode lock；指向同一 inode 的
不同 hardlink alias 不会自动共享锁，因此 v1 要求一个逻辑目标只使用一个规范化项目路径。
锁文件通过 candidate + hard link 原子抢占，并
写入 pid、nonce 和时间。当前实现对 stale lock **不自动回收**：无法证明原写者已退出时
宁可 fail closed；未来若加入 lease 回收，也必须先证明进程身份而不能仅凭 mtime。获取锁后
重新读取 bytes 并比较 revision。观察到冲突时返回 `REVISION_CONFLICT`，附当前 revision
和重新预览建议，绝不自动 reload 后继续覆盖；这仍不是非合作写者的原子 conditional
replace。

安全敏感的最终组件使用 `O_NOFOLLOW | O_NONBLOCK` 打开，再以 `fstat` 确认普通文件。当前
JSON 文档和图片读取还会在同一 fd 上比较读前/读后的 dev、inode、size、mtime、ctime，
并校验实际读取字节数；普通原地覆写、增长或截断会返回
`DOCUMENT_CHANGED_DURING_READ` / `IMAGE_CHANGED_DURING_READ`，不会为混合 bytes 签发
revision。外部 atomic-save 在 fd 打开后替换 pathname 时，旧 inode 仍是内部一致快照；
当前 final snapshot 后不再验证 pathname→inode binding，因而这是 external-writer blind
window 的一部分。当前绝对路径 API 也不能证明中间父目录在整个操作期间未被替换；未来
native helper 必须从预先打开的 root dirfd 出发，用 `openat2` 与 `*at` 系列操作贯穿
read/stage/link/rename/unlink。

### 8.2 单文件原子提交

M0/M1 的所有 mutation 必须最终只修改一个文档。提交步骤：

1. 在内存应用 edits，重新 parse 和 validate。
2. 创建 content-addressed checkpoint 并持久化 `prepared` manifest。
3. 在目标同一目录创建权限受控的 sibling staging，写入并 `fsync`。
4. 锁内再次比较 revision（对遵守本锁的写者构成 CAS）。
5. 用同文件系统原子 `rename` 替换目标，并在支持的平台 `fsync` 父目录。
6. 返回新 revision、checkpoint id 和变更摘要。

上述 rename 路径用于既有目标。`tiled_create_map` 单独使用 no-replace 分支：锁内确认
父目录/目标安全且初次缺失，先准备 `before.existed:false` checkpoint，再写并 `fsync`
同目录 staging；promotion 前二次检查缺失，随后以 hard link 原子提升 staging。二次检查或
link 的 `EEXIST` 都无条件返回 `FILE_ALREADY_EXISTS`，即使目标与 proposed bytes 相同。
只有本次调用已经成功 link 后的 unlink/目录 `fsync` 失败才允许通过回读相同 bytes 返回
durability warning，不能用内容相等认领外部抢占。创建成功后再尽力标记 checkpoint
committed；失败 warning 会明确自动对账无法证明创建者。

这里的“原子”只描述单次同文件系统替换的可见性，不代表对非合作写者做了 conditional
replace，也不等同于 crash durability。保证只在运维方确认底层文件系统满足 contract
要求时成立；服务器会传播实际 syscall failure，但不会探测或证明底层 atomicity、锁和
`fsync` 语义，也没有验证分布式文件系统。`changed:true` 的成功结果只记录本次 promotion
事件，不是响应时 pathname 仍指向该 revision 的 lease；后续状态相关决策必须重新读取。
已成功的同一 change-set id replay 返回首次缓存结果，也不会重新查询磁盘。

同一 batch 在 M0/M1 只能包含同一文档的白名单 edit intents。未来多目标 planner 检测到
第二个写目标时，计划在 dry-run 阶段返回
`MULTI_FILE_TRANSACTION_NOT_AVAILABLE`；该名称是 **planned / not current** code，
不属于当前 97-code v1 application registry。

### 8.3 跨文件可恢复事务

跨文件事务属于后续阶段，不宣称在普通文件系统上具有严格 all-or-nothing 可见性。实现采用
write-ahead log：

```text
.tiledmcp/transactions/<transactionId>/
├── manifest.json       # 路径、old/new revision、blob、顺序、状态
├── staged/             # 与目标同文件系统的 staging 文件索引
└── progress.log        # 每次 rename 后追加并 fsync
```

流程是：排序加锁 → 全部 CAS → stage/fsync → 写 `PREPARED` manifest → 逐文件替换并记录 →
写 `COMMITTED`。启动时先扫描未完成事务；根据 manifest、当前 hash 和 checkpoint blob
确定继续提交或回滚。恢复操作必须幂等，并有 fault-injection 测试覆盖每个持久化边界。

外部 adapter 不能绕过这套流程。evaluate、export 等先产生 staging 结果，TiledMCP 校验后
再将结果纳入单文件提交或 WAL。

## 9. Content-addressed checkpoints

checkpoint 不借助 git stash 或悬空 commit；那样会漏掉 untracked 资产，也可能被 GC。统一
使用自有内容寻址存储：

```text
.tiledmcp/
├── objects/<sha256-hex>                # immutable raw bytes（当前单文件布局）
├── checkpoints/<checkpointId>.json    # manifest
├── transactions/
└── locks/
```

manifest 至少记录：

- checkpoint id、label、创建时间与发起 operation；
- 当前单文件 manifest 的项目相对路径、“存在/不存在”、SHA-256、原 revision 和 byte size；
- 多文件 checkpoint 阶段再扩展为每个 `{rootId, relativePath}` 一项，并记录文件 mode；
- manifest schema version 和完整性 hash。

blob 写入采用 create-if-absent + fsync，读取和恢复时重新校验 hash。恢复同样获取锁、检查调用者
提供的 expected current revision，并通过正常提交路径完成；它不是直接复制覆盖。当前自动
checkpoint 还没有总字节配额或 GC。命名 checkpoint、保留数量、独立配额配置和“只删除
不再被任一 checkpoint/WAL 引用 blob”的 GC 都是未来设计，不能当作现行配置。

当前单文件实现的 manifest 状态为 `prepared | committed`。`tiled_list_checkpoints` 以
manifest 数量和目录扫描条目双重预算流式枚举；异常文件名、symlink、超限/坏 JSON、非法路径
与内部路径目标会进入独立的 `corruptEntries`，不拖垮其余结果。启动 reconcile 只会把
`before.existed:true` 且目标精确等于 `afterRevision` 的 prepared manifest 补记
committed；prepared create 的 exact match 仍因 provenance ambiguity 保持 prepared 并
报告 `CHECKPOINT_STATE_CONFLICT`。“写入未落地”和其他冲突状态保留给操作者判断。枚举
阶段不逐个读取最大 64 MiB 的 blob，实际 restore 前由 `readBefore()` 再验证 size、
revision 和内容 hash。

当前 MCP 恢复只接受 `{checkpointId, expectedRevision}`，一次只针对一个 checkpoint
对应的既有 JSON 文档。preview 不保存原始 blob，而是把 manifest 的
id/createdAt/label/path/status/afterRevision、before revision/object hash/size，以及目标
当前 revision 固定进带 domain separator 的 plan digest；返回的 operation 明确标为
destructive，并提醒依赖 TSJ、图片和其他文件不会被连带恢复。apply 在 plan 固定的目标路径
上获取同一套进程内与跨进程锁，重新读取 manifest 并只允许 `prepared → committed` 的状态
前进；随后先做目标 revision CAS，再重新校验 blob、安全 JSON 和当前 DocumentStore 大小
上限。若 existing-file `prepared` 写入已精确落盘，必须成功持久化 `committed` 状态后才
覆盖目标；状态含混、manifest/blob 篡改或 revision 过期均 fail closed。实际替换前仍为
当前版本创建新的 checkpoint，再以原始 bytes 原子替换。只有实际改变目标的 restore 才
创建该恢复点；其后续可恢复性还要求 checkpoint 完整且 threat-model operational
requirements 成立。no-op restore 不替换目标，也不创建新 checkpoint。
`before.existed:false` 代表创建文件前状态，prepared exact match 不会被自动认领，当前版本
也拒绝把它解释为删除操作。

## 10. 图像、资源与进程安全

默认限制应集中在 `Limits` 配置中，并出现在工具 schema/诊断里，而不是散落在实现中。建议
初始值：

| 限制 | 默认 |
|---|---:|
| 单 JSON 文档 | 64 MiB |
| 单张地图引用的 TSJ 原始 bytes 合计 | 64 MiB |
| 单 tile layer / 单次总解压 | 16M cells / 256 MiB |
| 单 change set tile 写入 | 100,000 cells |
| 单个 `stampPattern` operation | 单边 256 cells；总计 16,384 cells；preview sample 8 |
| 单个 `replaceTiles` operation | 128 mappings |
| 单个 `copyRegion` operation | 两侧完整 bounds；`2 × cellCount` reads，`cellCount` writes |
| 单 change set `replaceTiles` + `floodFill` + `copyRegion` 实际 GID 读取 | 共用 1,000,000 reads |
| usage analysis 扫描 / distinct aggregation | 1,000,000 cells+objects / 100,000 tiles |
| usage analysis 摘要 / 输出 | 64 layers + 64 tilesets；top tiles 1–128（默认 64）；256 KiB |
| 单 change set 对象 mutation | 10,000 objects |
| layer deletion subtree / preview samples | 10,000 layers、depth 64、100,000 objects；layer/object ID 各 32 |
| 单 change set 重写的 JSON 子树 | 128 |
| 输入图片文件 | 64 MiB |
| 简单 SVG 源码 | 256 KiB |
| tileset 原图解码 | 4096² pixels，单边 8192 px |
| tileset sheet surface | 1.5 megapixels，单边 2048 px |
| native preview region | 20,000 cells / 128 tile layers / 250,000 potential draws / 30M pixel blends |
| native preview atlas aggregate | 64 images / 64 MiB source / 16M decoded pixels |
| native preview surface | 1.5 megapixels，单边 2048 px，scale 1–4 |
| `tmxrasterizer` 输入图片集合 | root atlas / per-tile / image-layer 统一去重；64 images / 64 MiB source / 16M decoded pixels；单边 8192 px |
| 返回 PNG | 8 MiB；地图 rasterizer 默认长边 1400 px、最大 2048 px |
| 外部进程 stdout + stderr | 各 1 MiB |
| 外部进程时限 | 30 s（按工具可收紧） |

其他规则：

- 图片仅接受 allowlisted 本地普通文件；按内容 sniff 格式，不信任扩展名，并在完整解码前
  读取尺寸。sheet 当前支持 PNG/JPEG/WebP 与简单自包含 SVG；SVG 的 DTD/entity、脚本、
  foreignObject、外链、CSS URL 及其 entity/CSS-escape 混淆等主动内容 fail closed。
  专用 MCP 进程在 libvips 层全局阻断通用 loader，只重新放行四种内存 Buffer loader；
  动画/多页输入拒绝。
- tileset sheet 自动分页，页大小、tile 范围、像素尺寸和 map/TSJ/image 三组 revision
  随结果返回。预算不足时减小 page capacity 并显式标记，不降低请求的 tile scale。
- atlas local id `i` 的裁剪原点固定为
  `x = margin + (i % columns) * (tilewidth + spacing)`、
  `y = margin + floor(i / columns) * (tileheight + spacing)`。可容纳列数按 Tiled 的
  单侧 margin 公式 `1 + floor((imagewidth - margin - tilewidth) /
  (tilewidth + spacing))` 计算，不能误用双侧 margin。解码尺寸、声明 columns 和完整
  tile capacity 任一不一致即拒绝，避免用陈旧 TSJ 映射新图片。
- 大地图 native preview 要求 region；若整图或显式 region 仍超限，返回
  `PREVIEW_REGION_REQUIRED`/`PREVIEW_DIMENSIONS_EXCEEDED`，不返回伪完整缩略图。
  当前还没有 render Resource/TTL，不能声称提供 `resource_link`。
- native renderer v1 只保证 finite orthogonal、numeric-array tile layer、静态 external
  atlas、map-grid 等尺寸 tile、透明色、layer opacity 和 orthogonal H/V/D。它明确拒绝
  blend/tint、parallax、非零 pixel/group offset、非默认 group opacity、动画、
  tileoffset、非方形 D、image collection 等尚未精确实现的语义；隐式选择中可见但未绘制的
  object/image layer 会出现在 `omittedLayers` 并设置 `partial: true`，不能静默冒充完整图。
  omission 明细最多返回 128 项，另带总数与截断标志。复杂地图交给 `tmxrasterizer`。
- native preview 结束前复核 map 和全部 TSJ revision；image hash 精确绑定实际解码 bytes，
  但多个 image 是依次读取而非跨文件原子快照，结果用
  `snapshotConsistency: "non-atomic-read-set"` 明示。
- `tmxrasterizer` preview 在外部进程前后复核 map 与 external TSJ read set，并把启动时
  探测的 renderer 版本、实际生效选项及同一有界 PNG buffer 的尺寸、byte count 和 hash 放入
  结果。root atlas、per-tile image 与 image-layer 引用按规范化路径统一去重；前后分别读取
  这个最多 64 张、64 MiB source、16M decoded pixels、单边 8192 px 的集合并比较内部路径与
  revision。公开结果仍不报告图片 revision，`dependencyRevisions` 仍为 TSJ-only；外部进程
  读取 live files 且无法排除 ABA，因此同样固定返回
  `snapshotConsistency: "non-atomic-read-set"` 与 `truncated:false`。
- 调试叠加层与地图像素分开绘制，返回 tile region、像素尺寸、scale 和 tile→pixel 变换。
- 子进程使用最小环境、固定 executable、固定 flag 模板、受控 cwd 和并发 semaphore；超时后
  终止整个进程组并清理 staging。
- 不跟随网络图片、远程 template、设备文件、FIFO 或 socket；资产输入必须是普通文件。

## 11. M0 / M1 实施范围

分期以“安全基础先闭环”为准，不按原 58 个工具一次铺开。

### M0：可信文档与提交底座

范围：

- 配置、primary/read roots、路径与外部引用解析。
- source-preserving raw JSON、窄 typed views、目标版本 `FeatureMatrix`。
- revision hash、既有目标 CAS、create missing precondition、进程内/跨进程锁，以及对应
  的单文件 rename / hard-link no-replace 提交。
- content-addressed checkpoint、restore 和启动恢复扫描。
- `ChangePlan`、dry-run、稳定 diagnostics、结构 validator。
- GID codec 及所有 flags 的 property-based tests。
- Tiled/evaluate/export/tmxrasterizer/codec 的 capability probing；one-shot 兼容性探针。

M0 不追求完整地图 CRUD。验收标准：

- 所有 fixture no-op 均不写文件，未知字段不会在局部 patch 中丢失。
- 对合作写者，revision 过期时 100% 拒绝覆盖；若要把同一承诺扩展到未修改的 Tiled GUI，
  必须启用 mediated backend，默认文件系统 backend 明确报告不具备该能力。
- 在不模拟突然断电、底层文件系统满足 operational requirements 的 process-error 注入中，
  既有目标的单文件提交保持旧版或新版之一，并为发生改变的既有目标保留恢复 checkpoint；
  direct create 保持不存在或完整新版之一，checkpoint 只用于审计，不恢复为删除。
- 路径逃逸、静态 symlink/最终组件替换、重复 key 与当前已实现 codec 的超限输入均被安全
  拒绝。恶意本机进程交换中间父目录不在当前保证内，由
  `filesystemThreatModelContract.unsupported.hostileParentSwapProtection` 明示。

### M1：可用的最小正交编辑闭环

支持矩阵：

- finite orthogonal `.tmj`；
- 外部 atlas `.tsj` 与本地静态图片；
- 未压缩 JSON array tile data；
- 未使用 M1 不支持特性的基础 tile、object、image 和 group layer。

功能：

- 文件列表、地图摘要、tileset 摘要、whole-map tile usage analysis、显式 tile metadata
  精确检索和区域读取。
- 已实现基础 tile set/fill、绝对坐标的稠密矩形 `stampPattern`、同 map snapshot/memmove
  语义的绝对矩形 `copyRegion`、按 encoded GID
  精确且 simultaneous single-pass 的 `replaceTiles`，以及从绝对 seed 推导 source 的
  固定四向 `floodFill`；已实现 rectangle/point/ellipse/capsule 基础对象
  create/update/delete、map 根级 render/background/class `updateMap`，以及 4 类 layer 的公共字段
  `updateLayer`、独占且可确认递归的 `deleteLayer`，以及独占的完整 subtree
  `moveLayer` 与安全 `duplicateLayer`；duplicate 以 preorder high-water IDs 复制完整
  subtree、重连副本内部 typed object/list references，并保留共享 file/image references。
- 专用 `tiled_create_layer` 为 4 种空图层生成单操作 change set，支持根/Group 0-based
  插入、`nextlayerid` 分配、tile cell 预算与 prospective image pin。
- 已存在外部 tileset 引用的解析；专用 `tiled_add_tileset_to_map` 只生成单操作 change set，
  apply 后也只修改 map 文件；generic union 的独占 `removeTilesetFromMap` 只移除全图
  tile cells/tile objects 零引用的 external binding，保留其他 `firstgid` 和外部文件。
- 同一 map 内的 batch/dry-run、validate，以及已接入 preview/apply 的单文件
  checkpoint exact-byte restore。
- 已实现 tileset contact sheet，以及正交 tile-layer region preview、图层筛选、
  H/V/D、opacity、网格和绝对坐标 gutter；对象/碰撞/高亮 overlay 仍待实现。
- 通过 `tmxrasterizer` 或 one-shot Tiled 做可选兼容性/视觉复核。

M1 明确拒绝：

- infinite/chunk 编辑、base64 或压缩 layer 编辑；
- embedded tileset、image-collection tileset、模板、World、复杂 class/list 属性写入；
- isometric/staggered/hexagonal/oblique 语义编辑；
- 一个调用同时修改 map 与 tileset；
- 自研 Wang、AutoMapping 和程序生成。

这些文件仍可被 raw layer 安全列出、摘要或保留；只有语义写入被拒绝。M1 验收标准是：

> 模型能先看 atlas sheet，在有限正交 TMJ 中安全编辑和复制 tile 区域、编辑对象/map 根属性/公共 layer 字段，
> 管理未使用的 external atlas binding，并经 preview 移动、复制或 destructive 删除 layer
> subtree；文件由 Tiled
> 目标版本打开无警告，并能从 checkpoint 恢复。合作写者的 revision 冲突不得覆盖用户内容；
> 未经中介的外部 GUI 保存竞态必须在 capabilities 中如实标为不受严格 CAS 保护。

### M2 及以后

- arbitrary chunk/infinite 编辑和 gzip/zlib/zstd；
- 跨文件 WAL、模板与复杂属性；
- official `wangEdit`/AutoMapping adapter，再评估确定性自研 Wang backend；
- TMX/TSX 转换、更多 orientation 渲染、World、程序生成和图像匹配。

## 12. 风险矩阵与测试策略

| 风险 | 后果 | 主要防线 | 必须测试 |
|---|---|---|---|
| 未知/1.12+ 字段被 schema 丢弃 | 资产不可逆损坏 | raw document 权威、最小文本 edits | unknown-field fixture；局部 patch 前后文本切片对比 |
| JS 有符号位或 hex flag 误解 | tile/朝向错误 | 单一 GID codec、orientation union、`>>> 0` | 4 flags 全组合、边界 GID、hex/non-hex property tests |
| replacement 忽略 transform 或发生 mapping 级联 | 错换朝向、swap/cycle 结果错误 | encoded-GID exact match、single-pass lookup、共享 scan / 独立实际 write 计数 | identity/flags 精确匹配、A→B/B→C、swap、null target、零命中、预算边界 |
| flood fill 忽略 transform、误用对角连通或扫描无界 | 错填区域、CPU/写入过量或坏 GID 隐藏 | 固定四向、seed 完整 encoded-GID match、observed GID reverse validation、与 replacement 共享实际读取预算及 tile write cap | 四向/纯对角、非零 origin、flags 隔离、null source/target、source=target scan-one no-op、重复边界读取、malformed observed GID、shared scan/write 边界、later-wins |
| region copy 发生重叠级联、裁剪/跳过空格、丢 flags，或未验证将被覆盖的坏 GID | tile 图案错位、目标未按授权清空、坏数据被隐藏或局部提交 | strict 完整 bounds、operation-start source/destination snapshots、memmove、0 明确覆盖、两侧 observed-GID fail-closed、`2*cellCount` 共享 scan + 完整 write 预算、destination data-member-local patch | strict/extra keys、跨层/同层非零 origin、四方向 overlap、0 清空、flags、source/destination malformed、bounds/no clipping、scan/write 边界、前序 source 可见/后序 later-wins、bounded destructive preview、no-op、BOM/CRLF、tamper/stale revision、Tiled round trip |
| map-root patch 接受宽松 key、吞掉默认值 intent 或重写完整 TMJ | 错误字段落盘、渲染变化漏报或无关 source diff | strict/nonempty schema、member existence-aware detection、root-member-local patch、完整 target tree 复核 | 4 render orders、颜色写入/删除、class 长度边界、extra/empty rejection、later-wins、rendering flag、BOM/CRLF、net no-op、tamper/stale revision |
| tileset removal 漏扫隐藏/锁定/Group/template 引用、把相邻 `firstgid` 当重映射目标或漏 pin 被移除依赖 | 留下 unresolved/错绑 GID，或批准后删除了不同 binding | exclusive strict operation、完整 cell/object scan、encoded-GID binding identity、template fail-closed、`TILESET_IN_USE`、旧 dependency-set CAS、array-element-local deletion | nested hidden/locked tile layers、tile objects、template、transform flags、malformed/目标/非目标 GID、1,000,000 scan 边界、乱序 binding 原 index、其他 firstgid/source 保持、TSJ 保留、summary tamper/stale map/dependency、Tiled round trip |
| layer patch 吞掉默认值 intent 或重写完整 layer | 字段未落盘或无关 source diff 爆炸 | member existence-aware change detection、object-member local patch、完整 target tree 复核 | 4 类 layer、缺失默认字段插入、tint 删除/no-op、13 modes、BOM/CRLF、mixed batch、stale revision |
| layer subtree 删除提升 children、留下 object 悬挂引用或降低 ID 高水位 | 层级/逻辑损坏、未来 ID 复用 | exclusive plan、显式 descendant confirmation、surviving-document typed-reference scan、array-element local patch | leaf/empty/non-empty Group、direct/list/class refs、locked warning、32-ID samples、high-water marks、BOM/CRLF、tamper/stale revision |
| layer subtree move 发生同父 off-by-one、cycle、深度溢出或 source lexeme 丢失 | 绘制顺序错误、层级损坏或不可逆 diff | final-index contract、exclusive plan、cycle/depth-64 guard、source-snapshot `JsonArrayMove`、完整 target tree 复核 | 同父前后/首尾/no-op、跨父空目标/root omission、self/descendant、effective lock、32-ID sample、BOM/CRLF/unknown lexeme、target path shift、tamper/stale revision |
| 稀疏 local id 被 `tilecount` 截断 | GID 指向错误 tileset | highest-id/nexttileid 区间模型 | atlas、稀疏 image collection、firstgid gap fixtures |
| tile 语义检索误把默认/继承值当显式值 | 选错 `TileRef` | 只扫描显式 `tiles[]`/property，类型和值精确匹配，revision-pinned 分页 | type/class 优先级、all/any、false/0/空串、稀疏乱序分页、revision race |
| chunk 被强制重切 | diff 爆炸或坐标损坏 | 原 chunk 保留、局部 rewrite | 负坐标、非 16×16、混合尺寸、重叠 chunk |
| Tiled 同时保存 | 静默覆盖用户修改 | 最终 raw-byte guard 只能检测此前可见的保存；运维上禁止并发保存，严格保证需 mediated writer | guard 前保存必须 conflict；guard 后窗口作为 threat-model unsupported，不伪造 strict passing test |
| 跨文件中途崩溃 | 半提交 | WAL + content-addressed old/new blobs | 每个 fsync/rename 后 fault injection 和幂等恢复 |
| symlink/外部引用逃逸 | 越权读写 | canonical root、静态组件/父目录验证；hostile parent swap 不在 direct backend 保证内 | `..`、绝对路径、静态 symlink、FIFO；主动 swap 作为 unsupported 对抗边界 |
| 压缩炸弹/巨图 | OOM 或阻塞 | checked size、流式上限、像素配额 | gzip/zlib/zstd 超限、伪造尺寸、截断数据 |
| Tiled 版本/导出插件变化 | adapter 行为漂移 | runtime probe、格式动态发现 | pinned Tiled 集成测试 + capability 缺失测试 |
| native preview 与 Tiled 不同 | 模型视觉误判 | 明确支持子集、rasterizer 对照 | golden image + perceptual diff + unsupported cases |
| checkpoint blob 损坏或 GC 误删 | 无法恢复 | hash verify、引用追踪 | corruption、并发 GC、untracked/new/deleted file restore |

测试分层：

1. **Unit/property**：GID、路径、feature gate、ID 分配、tile data codec、tile semantic
   search 和 edit 合并。
2. **Fixture round-trip**：由目标 Tiled 版本实际生成；no-op 比 bytes，局部编辑比未触及文本与
   语义树。
3. **Contract**：每个 MCP input schema、精确 closed output schema、成功/应用错误
   `structuredContent`、1024-byte compact one-line JSON v1 text summary（含不复制
   result/details、图片 MIME/raw bytes 与 structured byte count）、capabilities
   `textContentContract` 与 `applicationErrorContract`、97-code v1 registry machine
   artifact / `tiled://application-errors` resource 一致性、未知 code 兼容与
   `INTERNAL_ERROR` fallback、各 excluded surface 类型边界、三种图片工具的同-buffer
   artifact metadata、rasterizer
   renderer/options、有界输入图片集合的内部 pre/post revision 校验与 non-atomic 边界、
   SDK-owned text-only 输入校验错误、annotations 和 size/page limit。
4. **Integration**：普通单元/契约套件继续允许可选 CLI 缺失并测试正常降级；独立
   `pnpm run verify:tiled-1.12.2` 门则不可 skip，精确拒绝缺失/错版本，检查真实
   `--export-formats`、fixture JSON round-trip、64×48 `tmxrasterizer` PNG，以及
   `tiled_create_map` 输出被 Tiled 1.12.2 重新导出后的 parsed equivalence。
5. **Fault recovery**：覆盖当前锁、checkpoint 与单文件 replace 的 process-error 注入；
   sudden power loss 不在保证内，未来 WAL 的持久化边界测试随 WAL 实现一并加入。
6. **Security**：恶意 JSON、压缩、图片、路径、symlink race、超时和子进程输出洪泛。

## 13. 配置

当前实现只接受下列配置：

| 配置 | 说明 | 默认 |
|---|---|---|
| `--project-dir` / `TILED_PROJECT_DIR` | 唯一 primary read/write root；缺失时 fail closed | **必填，无默认值** |
| `--tiled-cli` / `TILED_CLI_PATH` | Tiled executable | `tiled` |
| `--rasterizer` / `TILED_RASTERIZER_PATH` | TmxRasterizer executable | `tmxrasterizer` |

`TILED_READ_ROOTS`、`TILED_TARGET_VERSION`、`TILEDMCP_LIMITS_FILE` 与
`TILEDMCP_CHECKPOINT_BYTES` 仍是未来配置提案，当前进程不会读取，不能在部署中假设它们
生效。兼容基线当前由代码与固定 Tiled 1.12.2 集成门锁定；limits 只能使用内建值，
checkpoint 总配额/GC 尚未实现。

启动 capability 会报告实际 CLI probe，但不因可选 Tiled adapter 缺失而阻止 direct JSON
能力启动。

## 14. 仓库结构（拟）

```text
TiledMCP/
├── docs/
├── src/
│   ├── index.ts
│   ├── config/
│   │   ├── config.ts
│   │   └── limits.ts
│   ├── mcp/
│   │   ├── server.ts
│   │   ├── contracts/          # input/output schemas、annotations、error codes
│   │   └── handlers/           # 薄 handler，不直接触盘
│   ├── application/
│   │   ├── queries/
│   │   ├── commands/
│   │   └── change-plan.ts
│   ├── domain/
│   │   ├── diagnostics.ts
│   │   ├── tile-ref.ts
│   │   └── feature-matrix.ts
│   ├── documents/
│   │   ├── raw-json-document.ts
│   │   ├── edits.ts
│   │   ├── views/
│   │   └── codecs/
│   │       ├── gid.ts
│   │       └── tile-data.ts
│   ├── storage/
│   │   ├── path-policy.ts
│   │   ├── revision.ts
│   │   ├── locks.ts
│   │   ├── atomic-file.ts
│   │   ├── checkpoints/
│   │   └── transactions/
│   ├── adapters/
│   │   ├── tiled/
│   │   │   ├── probe.ts
│   │   │   ├── evaluate.ts
│   │   │   ├── export.ts
│   │   │   ├── rasterizer.ts
│   │   │   └── scripts/        # 固定 one-shot 脚本
│   │   └── images/
│   └── validation/
├── tests/
│   ├── unit/
│   ├── contract/
│   ├── integration/
│   ├── fault/
│   └── security/
├── fixtures/
│   ├── tiled-1.11/
│   ├── tiled-1.12/
│   └── malicious/
└── .tiledmcp/                 # 运行时生成；目标项目应忽略，服务器不改其 .gitignore
    ├── asset-registry.v1.json # 当前 external TSJ/image-layer opaque identity
    └── ...                    # objects/checkpoints/WAL/locks
```

领域层不依赖 MCP SDK，文档层不依赖外部 Tiled 进程，adapter 不直接提交正式资产。这个依赖方向
是后续扩展 TMX、Wang、World 和 GUI 之外自动化能力时保持安全边界的基础。
