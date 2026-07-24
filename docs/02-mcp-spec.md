# TiledMCP 功能规格（冻结前草案）

> **状态：Draft。** 本文定义协议基线、共享语义和能力 roadmap；下文的工具表是候选能力清单，不是首版一次性注册全部工具的承诺。完整、可执行的 `inputSchema` / `outputSchema` 将以代码中的 schema 为单一事实来源并自动生成文档，完成后本文才进入 Frozen。
>
> 设计依据见 [01-tiled-research.md](01-tiled-research.md)。

## 0. 协议基线与冻结条件

- **MCP 版本**：锁定 `2025-11-25`。
- **SDK**：使用 `@modelcontextprotocol/sdk` **v1.x**；锁定具体版本和 lockfile，在 v2 稳定且完成兼容测试前不迁移。
- **首个 transport**：`stdio`。服务器不向 stdout 输出日志；日志只写 stderr。HTTP/远程 transport 不属于 M1。
- **能力声明**：仅声明当前实现且通过契约测试的 Tools、Resources、Prompts；未实现的 roadmap 项不得注册空壳。
- **Schema 单一来源**：共享类型和每个工具的输入、输出、错误结构在代码中定义，由它们生成 MCP JSON Schema、本文的参数表和契约测试 fixture。本文表格中的“关键参数”只用于解释意图，不是完整 wire contract。
- **冻结门槛**：所有已注册工具都必须有完整 `inputSchema`、`outputSchema`、示例、稳定错误码、尺寸/分页限制、四项 annotations 和 Tiled 1.12.2 往返测试。

### 0.1 当前实现切片（2026-07-24）

当前代码注册 18 个不依赖 Tiled CLI 的核心工具：capabilities、文件列表、checkpoint
索引与单文件恢复预览、地图摘要、whole-map tile usage analysis、有界外部 atlas TSJ
详情、显式 tile metadata 精确检索、矩形 region、
带 local ID 的分页 tileset sheet、native tile-layer region preview、对象列表、只读
校验、增量创建地图、空图层创建预览、map edits 预览、外部 tileset 挂载预览与 change
set 提交；探测到 `tmxrasterizer` 时再注册第 19 个高保真地图 PNG 工具。另注册一个不依赖项目内容
的 direct Resource：`tiled://guide`，通过 `resources/list` 发现并由 `resources/read`
返回带内容 revision/size 的 Markdown；当前 Resource Templates 列表为空。已实现的编辑
union 为 `setTiles`、`fillRegion`、`replaceTiles`、`createObject`、
`updateObject`、`deleteObjects`、`updateLayer`、`deleteLayer` 和 `moveLayer`。
`tiled_create_layer` 使用独立的单操作 planner，不向这个通用 union 暴露可伪造的
`layerId`、父容器路径或最终插入位置。
对象写入暂限基础 rectangle/point；模板、tile object、文本、多边形等复杂对象会明确拒绝。
其余仍是 roadmap，不得从下文候选表推断为可调用能力。

这一切片已有严格输入 schema、结构化输出 envelope、四项 annotations 和 MCP 客户端契约
测试；tile/object/layer 写入使用目标子树或 object-member local patch，完整语义复核
通过后才提交。完整字段级
output schema/codegen 尚未完成。当前外部 tileset `assetId` 是由项目路径确定性派生的
临时实现：重启后稳定，但资产重命名后会改变；持久化 rename-stable registry 是接口冻结
前的待办。因此本文仍是 Draft，共享契约描述的是冻结目标；运行时应以
`tiled_get_capabilities`、`tools/list`、`resources/list` 与
`resources/templates/list` 为准。

当前 `tiled_create_map` 是一个明确的临时例外：它只做 no-replace 新建，已有路径必然拒绝，
但还没有纳入 change set。冻结前要么把创建也改为 preview/apply，要么在本规范中正式保留
“纯增量、不可覆盖创建”的例外；目前不能把该行为外推到其他 create/update/delete 工具。

## 1. 共享契约

以下 TypeScript 风格定义用于固定语义；字段的必填性、范围、互斥关系和 `additionalProperties: false` 最终由代码生成的 JSON Schema 精确定义。

```ts
type ProjectPath = string
// 使用 "/" 的 UTF-8 项目相对路径；禁止绝对路径、".."、NUL 和解析后逃逸项目根目录。

type AssetId = string
// 服务器分配的不透明、项目内稳定标识。客户端不得从路径猜测或自行构造。

type Revision = `sha256:${string}`
// 对原始文件 bytes（含“文件不存在”状态）的内容 revision；写入前以 expectedRevision 做 CAS。

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
  code: string;                         // 稳定、可机器判断
  severity: "info" | "warning" | "error";
  message: string;                      // 面向模型的人类可读说明
  path?: ProjectPath;
  jsonPointer?: string;
  tilePosition?: { x: number; y: number; layerId?: number };
  help?: string;
  candidates?: Array<{ id: string | number; label: string }>;
  fixId?: string;
};

type MutationResult =
  | {
      state: "preview";
      changeSetId: string;
      expectedRevision: Revision;
      expiresAt: string;
      destructive: boolean;
      summary: string;
      changedLocations: number;
      diagnostics: Diagnostic[];
    }
  | {
      state: "committed";
      changeSetId: string;
      previousRevision: Revision;
      revision: Revision;
      summary: string;
      changedLocations: number;
      diagnostics: Diagnostic[];
    };
```

补充 wire 规则：

1. 读工具在 `structuredContent` 返回符合 `outputSchema` 的对象，`content` 只给简短摘要；不得把超大数组退化成文本。项目资产的 mutation 预览/提交统一返回 `MutationResult`；checkpoint 索引等管理数据使用各自的 typed result。
2. 错误使用稳定 `code` 和 `Diagnostic[]`；工具调用失败时设置 `isError: true`，并仍尽可能返回符合错误 output schema 的 `structuredContent`。
3. `Revision` 基于原始 bytes，而不是解析后对象或 mtime。所有项目资产写入必须携带 `expectedRevision`；提交前不匹配则返回 `REVISION_CONFLICT`，绝不静默覆盖。
4. `selectionId`、`changeSetId` 等句柄必须显式传递，绑定项目、客户端连接、地图 revision 和 TTL；它们不是“当前选区/上一步操作”之类的隐式会话状态。
5. M1 只接受 `Region.kind = "rect"`；其余分支保留在共享契约中，直到对应阶段实现后才加入工具 schema。

### 1.1 用户授权、预览与提交

`confirm: true` **不代表用户授权**：模型本身可以填写该字段，服务器不能据此证明用户看过风险。写操作采用两阶段协议：

1. 写工具或 `tiled_preview_edits` 只计算变更，返回绑定 `expectedRevision` 的 `changeSetId`、摘要、诊断和 `destructive` 标记。
2. MCP 客户端通过自己的批准 UI（可用时使用 elicitation）把摘要呈现给用户。
3. 只有通过客户端“重要操作”批准门的 `tiled_apply_change_set(changeSetId, expectedRevision)` 才提交；服务器再次执行 revision CAS。change set 过期、连接不匹配或 revision 改变均拒绝提交。

因此工具 schema 中不使用 `confirm` 字段。服务端 annotations 是风险提示和客户端策略输入，不是授权证明。

### 1.2 Tool annotations 规则

每个工具都显式提供可读 `title`，并填写全部四项 hints，不依赖协议默认值：

| 工具类型 | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
|---|---:|---:|---:|---:|
| 本地读取、摘要、渲染、纯校验 | `true` | `false` | `true` | `false` |
| 预览 change set（每次签发新的 anti-ABA id） | `true` | `false` | `false` | `false` |
| 设置为指定最终状态 | `false` | 依能力静态标注 | `true` | `false` |
| 创建、追加、随机生成或依赖当前状态的编辑 | `false` | 依能力静态标注 | `false` | `false` |
| 删除、裁剪、覆盖导出、自动修复、快照恢复 | `false` | `true` | 按重复调用语义填写 | `false` |

- annotations 是**工具级静态值**；若同一名字同时承担读/写、预览/提交或安全/破坏性分支，必须拆成独立工具。
- `tiled_preview_edits` 每次调用都会分配新的随机 `changeSetId` 并占用有界 registry，
  因而不是幂等调用；相同 plan 也不复用旧句柄，以避免 revision ABA 后误认历史批准。
- `tiled_apply_change_set` 固定为 `{readOnlyHint:false, destructiveHint:true, idempotentHint:true, openWorldHint:false}`：即使某个 change set 实际无破坏性，也采取保守静态标注；重复提交同一 id 只返回第一次提交结果，不重复应用。
- `tiled_create_checkpoint` 固定为 `{false,false,false,false}`；checkpoint 列表为 `{true,false,true,false}`。恢复预览每次签发新的 anti-ABA change set，固定为 `{true,false,false,false}`。写目标文件的转换、导出和 rasterize 保守标为 destructive。
- 本地 Tiled CLI 子进程仍为 `openWorldHint: false`；未来任何访问网络的工具必须设为 `true`。
- `destructiveHint: false` 不免除 revision CAS；`destructiveHint: true` 必须走客户端批准门。

## 2. 设计原则

1. **面向结果，不面向裸 API**：提供"填充一个区域""用地形笔刷画一条路"这类高层动作，而不是逼模型逐格 set tile。
2. **命名惯例**：`tiled_{动词}_{名词}` 蛇形命名（与现有生态惯例一致，便于用户迁移）。
3. **GID 变换位对模型透明且无损**：工具使用 `TileRef`；服务器区分正交翻转与六边形 60°/120° 旋转，并保留 raw flags。模型不需要手工编码 GID。
4. **大数据走摘要**：任何工具都不整块返回完整地图 JSON；读取用区域/摘要视图，完整数据走 Resource。
5. **单文档原子化 + 路径沙箱**：所有路径限制在项目根目录（`TILED_PROJECT_DIR`）内；M0/M1 写盘使用锁、revision CAS、同目录 temp + rename。跨文件只承诺“可恢复事务”且延后到 M2。
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
| `tiled_get_map_summary` | 地图摘要：尺寸、方向、图层树（含 id/类型/可见性）、tileset 引用表（含 firstgid 区间）、对象统计。**模型动手前必读** | `mapPath` |
| `tiled_create_map` | 新建地图 | `mapPath`, `orientation`, `width`, `height`, `tileWidth`, `tileHeight`, `infinite?`, `staggerAxis?`, `staggerIndex?`, `hexSideLength?`, `backgroundColor?` |
| `tiled_update_map` | 修改地图级属性（renderorder、背景色、class 等） | `mapPath`, `patch` |
| `tiled_resize_map` | 调整地图尺寸；只要可能裁剪内容，该工具就静态标为 destructive 并走 change set 批准 | `mapPath`, `width`, `height`, `offsetX?`, `offsetY?` |
| `tiled_delete_file` | 删除资产文件（**destructive**，只生成待批准 change set） | `path` |

### 3.2 编辑事务与安全网

安全网先于业务写工具落地。M0/M1 的原子性边界严格限定为**单个文档**；跨文档提交延后到 M2，并且只有实现锁、staging、journal/WAL 与崩溃恢复后才能称为“可恢复事务”。

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_preview_edits` | 预览同一 map 上的一组编辑，返回 change set；`operations` 是封闭的 discriminated union，不接受任意 `{tool,args}` | `mapPath`, `expectedRevision`, `expectedDependencyRevisions`, `operations` |
| `tiled_apply_change_set` | 提交已经由客户端批准的 map edit 或 checkpoint restore change set；提交前重新做锁与 revision CAS | `changeSetId`, `expectedRevision` |
| `tiled_create_checkpoint` | 为显式文档集合建立自有内容寻址快照；破坏性提交前也自动创建匿名快照 | `paths`, `label?` |
| `tiled_list_checkpoints` | **已实现**；有界列出 manifest，并把损坏条目隔离到 `corruptEntries`，不读取或恢复目标 | `status?`, `limit?`, `scanLimit?` |
| `tiled_preview_checkpoint_restore` | **已实现单文件版**；只读校验 checkpoint 与目标，返回带 destructive 摘要的 change set；实际恢复仍由 `tiled_apply_change_set` 提交 | `checkpointId`, `expectedRevision` |

当前恢复契约严格限于一个 checkpoint 对应的一个**已存在安全 JSON 文档**。preview 输入
只接受 UUID `checkpointId` 和目标最新 raw bytes 的 SHA-256 `expectedRevision`，不接受
未来多文件设计中的 `paths` 或 revision map。服务端验证 manifest、内容寻址 blob 的
hash/revision/size、安全 JSON 与 DocumentStore 大小上限，并把 checkpoint 的
id/创建时间/label/path/status/afterRevision/before object identity 和目标当前 revision
全部固定进 domain-separated plan digest；最大 64 MiB 的原始 blob 不驻留 change-set
registry。

preview 本身不写盘，但 operation 摘要明确 `destructive:true`，并报告目标路径、当前与
恢复 revision、精确 byte count、`wouldChange` 和“不会恢复 TSJ/图片/其他文件”的警告。
apply 在目标锁内重新读取并逐字段验证 manifest，先做目标 revision CAS，再验证 blob；
唯一允许的 manifest 漂移是 `prepared → committed`。若 source checkpoint 仍是
`prepared`，只有目标精确等于其 `afterRevision` 才允许先持久化为 `committed` 后恢复。
恢复通过正常 checkpoint + 原子替换路径写回原始 bytes，因此恢复本身可再次恢复。
`before.existed:false` 会稳定报 `REVERT_WOULD_DELETE`：当前工具不会以恢复之名删除后来
创建的文件，也不会隐式恢复任何依赖闭包。

`operations` 只允许当前版本列出的 tile/layer/object 纯文档编辑，不允许嵌套 operations、
删除文件、恢复快照、转换、导出、AutoMapping、任意工具调用或 CLI 副作用。不得退回接受
任意工具名与参数的通用 batch。

除 `tiled_apply_change_set` 外，roadmap 中表达“创建/更新/删除”的项目资产工具都只构造 preview，不直接写盘；因此其 annotations 按 preview 填写。若未来提供直接提交入口，必须使用不同工具名并单独标注，不能用 `dryRun` 或 `commit` 布尔分支混合两种语义。

### 3.3 图层管理

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_create_layer` | **已实现**；预览创建一个空图层（4 种类型），可指定父 Group 与插入位置，不直接写盘 | `mapPath`, `type`(tilelayer/objectgroup/imagelayer/group), `name`, `parentGroupId?`, `index?`, `imagePath?`, `expectedMapRevision`, `expectedDependencyRevisions`, `expectedImageRevision?` |
| `tiled_update_layer` | 候选独立入口；当前等价能力已通过 `tiled_preview_edits` 的第 7 种 `updateLayer` operation 实现，修改 4 类 layer 的公共显示/元数据字段 | `mapPath`, `layerId`, `patch` |
| `tiled_move_layer` | 候选独立入口；当前等价能力已通过 `tiled_preview_edits` 的第 9 种、必须独占 change set 的 `moveLayer` operation 实现 | `mapPath`, `layerId`, `parentGroupId?`, `index` |
| `tiled_delete_layer` | 候选独立入口；当前等价 destructive 能力已通过 `tiled_preview_edits` 的第 8 种、必须独占 change set 的 `deleteLayer` operation 实现 | `mapPath`, `layerId`, `deleteDescendants?` |
| `tiled_duplicate_layer` | 复制图层（后续候选） | `mapPath`, `layerId`, `newName?` |

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
registry 仍为 18 个 core / 19 个含 rasterizer。`layerId` 必须是正整数，并递归定位一个
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
仍是 18 个 core / 19 个含 rasterizer。

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
它不额外注册 `tiled_move_layer`，所以 registry 仍是 18 个 core / 19 个含
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

其他图层工具统一用 `layerId`（数字 id）定位；`moveLayer` 已由 generic operation
实现，只有 duplicate 仍是 roadmap。

### 3.4 图块编辑 — Tile Layer（核心价值）

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_get_region` | 读取矩形区域的 tile。`format: "json"` 返回 `TileRef \| null` 二维数组；`format: "ascii"`（默认）返回单字符网格 + 图例，图例中的每项仍映射到完整 `TileRef`。图像看外观、ASCII 看结构、JSON 看精确值 | `mapPath`, `layerId`, `region`, `format?` |
| `tiled_set_tiles` | 批量设置稀疏 tile 列表（一次调用可跨多个不相邻位置） | `mapPath`, `layerId`, `tiles: [{x, y, tile|null}]` |
| `tiled_fill_region` | 矩形区域填充（单一 tile 或按 pattern 平铺一个小图案） | `mapPath`, `layerId`, `x`, `y`, `width`, `height`, `tile|pattern` |
| `tiled_flood_fill` | 油漆桶：从某点开始填充相连的同值区域 | `mapPath`, `layerId`, `x`, `y`, `tile` |
| `tiled_replace_tiles` | 候选独立入口；当前等价能力已通过 `tiled_preview_edits` 的 `replaceTiles` operation 实现：在全 layer/区域内同时应用多组精确替换 | `mapPath`, `layerId`, `mappings: [{from, to}]`, `region?` |
| `tiled_clear_region` | 清空矩形区域（后续候选，可由 fill null 实现，独立工具更直观） | `mapPath`, `layerId`, `region` |
| `tiled_stamp_pattern` | 盖章：把一个内联的二维 tile 图案整体戳到指定位置（后续候选）。成型的多图层复用结构走预制件（3.5） | `mapPath`, `layerId`, `x`, `y`, `pattern: TileRef[][]` |
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
最多 128 组 mapping，一个 change set 的所有 replacement operation 合计最多扫描
1,000,000 个 cell；只有实际替换才计入所有 tile operations 共用的 100,000-cell 写入
上限。零命中是合法 no-op，preview 报告 `replacedCellCount:0`，apply 不改写文档。

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
| `tiled_create_object` | 候选独立入口；当前等价能力通过 `tiled_preview_edits` 的 `createObject` operation 提供，限 rectangle/point | `mapPath`, `layerId`, `shape`, `x`, `y`, `width?`, `height?`, `name?`, `class?`, `rotation?` |
| `tiled_update_object` | 候选独立入口；当前通过 `updateObject` operation 修改基础对象字段 | `mapPath`, `objectId`, `patch` |
| `tiled_delete_object` | 候选独立入口；当前通过带醒目 destructive 摘要的 `deleteObjects` operation 提供；拒绝留下 object/list 引用，class 属性存在时 fail closed | `mapPath`, `objectIds` |
| `tiled_instantiate_template` | 从 `.tx`/`.tj` 模板实例化对象（后续候选） | `mapPath`, `layerId`, `templatePath`, `x`, `y`, `overrides?` |

### 3.7 Tileset 管理

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `tiled_get_tileset` | **已实现有界基础版。** 以 map + opaque asset id 验证当前引用，返回 atlas 声明、按 local ID 分页的稀疏 tile class（Tiled 1.12 使用 `tiles[].type`）、动画采样、碰撞/属性计数和 Wang-set 概览；不把 `tiles.length` 冒充 `tilecount`，不读取 property values/碰撞 geometry/完整 wang assignments | `mapPath`, `tilesetAssetId`, `startTileId?`, `limit?` |
| `tiled_create_tileset` | 从图集图片创建 `.tsj`（自动读取图片尺寸算 tilecount/columns） | `tilesetPath`, `image`, `tileWidth`, `tileHeight`, `margin?`, `spacing?`, `name?` |
| `tiled_add_tileset_to_map` | **已实现/本轮契约。** 只预览把一个外部 tileset 挂到地图的单操作 change set；自动分配 `firstgid`，本工具不写盘 | `mapPath`, `tilesetPath`, `expectedMapRevision`, `expectedDependencyRevisions`, `expectedTilesetRevision?` |
| `tiled_remove_tileset_from_map` | 从地图移除 tileset 引用；仍在使用或会改变解析结果时标为 destructive | `mapPath`, `tileset` |
| `tiled_update_tile` | 设置单 tile 元数据：动画帧、碰撞形状、probability、class（后续候选） | `tileset`, `tileId`, `animation?`, `collisionShapes?`, `probability?`, `class?` |
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
| `tiled_validate` | **只读格式校验**：GID 越界、tileset/图片路径失效、id 一致性、重复对象 id、chunk 完整性；返回 `Diagnostic[]` 和可选 `fixId`，绝不写盘 | `path` |
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
| `tiled_render_preview` | **已实现 native v1**。渲染有限正交地图的静态 external-atlas tile layer，可指定矩形 region/图层并叠加网格与绝对坐标；不支持的视觉语义 fail closed。对象、碰撞和高亮仍是后续候选 | `mapPath`, `region?`, `layerIds?`, `scale?`, `overlays?` |
| `tiled_render_tileset_sheet` | **已实现基础版**。按地图摘要给出的 opaque asset id 渲染连续 local id 的分页 atlas sheet；安全预算不足时自动减小每页容量，不静默缩放 tile。语义名与任意 `tileIds` 选择留待注册表实现 | `mapPath`, `tilesetAssetId`, `page?`, `pageSize?`, `columns?`, `scale?` |
| `tiled_render_tiles` | 后续候选。放大少量 tile、动画胶片条或 wang set 分组 | `tileset`, `tileIds?`, `animation?`, `wangset?`, `scale?` |
| `tiled_render_diff` | 后续候选。按显式 changeSetId、revision 或比较资产渲染差异，不读取“上一步操作” | `mapPath`, `changeSetId?\|compareWithRevision?\|compareWith?`, `region?` |
| `tiled_import_from_image` | 远期候选。把网格对齐参考图按 tile 匹配到目标图层，未匹配格子返回坐标与裁剪图 | `imagePath`, `mapPath`, `layerId`, `tileset`, `threshold?` |

#### 3.11.1 图片 wire contract 与限制

每个图片结果的 `structuredContent.result` 至少包含输出摘要；sheet 使用单数
`source`/`image`，地图预览则使用实际影响本次像素的 `sources[]`：

```ts
{
  mimeType: "image/png";
  pixelSize: { width: number; height: number };
  byteLength: number;
  sha256: string;
  map: { path: ProjectPath; revision: Revision };
  source?: { assetId: AssetId; revision: Revision }; // sheet TSJ
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
  truncated: boolean;
  resourceUri?: string;
}
```

- 当前 tileset sheet 的输入上限为 `64 MiB`、`4096²` 解码像素和 `8192` 单边；输出上限为
  `2048` 单边、`1,500,000` 像素和编码后 `8 MiB`。每页请求最多 256 个 tile，
  `scale` 为 1–4；简单 SVG 另有 `256 KiB` 源码上限。精确限制由
  `tiled_get_capabilities` 公布并由测试覆盖。
- tileset sheet 必须分页，并在元数据中返回页码、总页数、本页 tile id 范围和实际
  page capacity。`page.index` 与输入 `page` 均从 0 开始；像素预算不足时允许减小
  capacity，并以 `adjusted: true` 明示，不得静默减小 `scale`。输入 `columns` 是
  每页的最大列数；最后一页或 tile 数较少时，结果中的实际 `page.columns` 可以更小。
- 当前实现尚无 render Resource/TTL 存储。tileset sheet 编码后超过 8 MiB 时 fail closed，
  不返回被冒充为完整结果的缩略图；成功结果固定 `truncated: false`。未来实现
  `tiled://renders/...` 后，才可返回标有 `truncated: true` 的缩略 `image`、诊断和
  `resource_link`。图片二进制始终不重复塞入 `structuredContent`。
- 地图预览必须返回 tile 区域和 tile→pixel 变换，确保模型看到的坐标能无歧义地用于后续编辑。
- native preview 的 `region` 使用 map 绝对 tile 坐标；省略时尝试整图，超出预算返回
  `PREVIEW_REGION_REQUIRED`，不自动裁剪或降 scale。`layerIds` 省略时按文档顺序渲染
  有效可见 tile layer，并把可见但未支持的 object/image layer 放入 `omittedLayers`、
  标记 `partial: true`；显式 ID 只接受 tile layer，隐藏状态不阻止显式渲染。
- native v1 支持静态 external atlas、透明色、layer opacity、orthogonal H/V/D 与 bit 29
  忽略；D 总是先于 H/V，非方形 tile 的 D 暂时 fail closed。atlas tile 尺寸必须与 map
  grid 相同。blend/tint、parallax、非零 pixel offset、非默认 group opacity、动画、
  per-tile image subrect、tileoffset、`tilerendersize:grid`、image collection 和
  非有限/非正交地图不做近似。
- native preview 上限为 region 20,000 cells、128 个 tile layer、250,000 次潜在 tile
  draw、30,000,000 次 pixel blend、64 个实际 atlas；`omittedLayers` 最多内联 128 项，
  超出时返回总数和 `omittedLayersTruncated`。atlas 源文件累计 64 MiB、声明解码像素累计 16,000,000。
  输出为 scale 1–4、2048 单边、1,500,000 像素、编码后 8 MiB。精确值由
  `tiled_get_capabilities` 返回。
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

Resources 是可发现的只读上下文。固定 URI 使用 direct resource；按资产展开的 URI 使用 Resource Template。任何 URI 都不得直接嵌入未转义文件路径，必须先通过 `tiled_list_files` 或项目索引取得不透明 `assetId`。

当前仅注册下表中的 `tiled://guide`；其他 direct resources 与全部 templates 仍是 roadmap，
不得从本表推断为可读。运行时以 `resources/list` 和 `resources/templates/list` 为准。

### 4.1 Direct resources

| URI | `mimeType` | 内容 |
|---|---|---|
| `tiled://guide` | `text/markdown` | **已实现。** 使用 playbook：能力发现 → 摘要 → tileset sheet/map preview → 预览 edits → 客户端批准 → 提交 → 校验与渲染自查 |
| `tiled://project/index` | `application/json` | 有界项目资产索引；大项目只给首页和 next cursor，完整翻页走 `tiled_list_files` |
| `tiled://schema/tool-contracts` | `application/schema+json` | 从代码生成的已注册工具 input/output schemas |
| `tiled://schema/tmj` | `application/schema+json` | 当前实现支持的 TMJ 子集 schema，不伪装成完整 Tiled schema |
| `tiled://schema/tsj` | `application/schema+json` | 当前实现支持的 TSJ 子集 schema |

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
- JSON/text direct read 默认上限 `2 MiB`，当前嵌入式 guide 使用更严格的 `64 KiB` 上限；图片沿用第 3.11.1 节的 `8 MiB` 上限。超限返回稳定错误 `RESOURCE_TOO_LARGE`，并建议读取 summary、region 或分页资源；不得截断后伪装成完整内容。
- `assetId` 项目内稳定、跨服务器重启可复用，重命名资产时由服务器保持映射；客户端只能把它当不透明字符串。
- 当前 direct resource registry 支持 list-changed capability，但 guide 在一个 server 实例内是静态内容；resource subscriptions 未实现且显式声明为 false。未来若实现资产订阅，资产提交后对已订阅 URI 发送 `notifications/resources/updated`；新增/删除资产发送 list changed。未实现的通知不得声明对应 capability。

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
| **M0：内核** | 项目路径解析与沙箱；宽松 raw JSON 无损加载/目标子树 patch；原始 bytes revision、文件锁与 CAS；单文档 temp+rename；内容寻址快照与恢复；只读 validate；schema/codegen/契约测试基础 | 未知字段往返不丢失；并发修改必报冲突；模拟写入中断后原文件完整；任一已提交修改可从快照恢复 |
| **M1：首个可用 MVP** | **仅有限、正交 TMJ + 外部 atlas TSJ**；项目文件列表、地图/tileset 摘要、whole-map tile usage analysis、显式 tile metadata 精确检索、矩形 region 读取、已实现 set/fill/精确 simultaneous replace、基础 object 编辑、4 类 layer 公共属性 update，以及独占递归 delete / subtree move、4 类空图层创建、外部 tileset 挂载的专用 preview、change set 预览/提交、单文件 checkpoint 精确恢复、只读校验、tileset sheet、地图预览、guide。暂不支持 layer duplicate、无限 chunk、压缩 layer data、内嵌/collection tileset、等距/六边形 | 模型能按 class/property 找到精确 `TileRef`、盘点全图 tile 使用、先看 sheet，再安全创建/更新/移动/删除图层并修改一张有限正交 TMJ；move/delete 有有界影响摘要，提交前能预览且 revision 冲突不覆盖；修改后 Tiled 1.12.2 打开无警告、预览正确，并能经批准恢复原始 bytes |
| **M2：格式与事务扩展** | 无限地图与原 chunk 边界保持、压缩数据、内嵌/collection tileset、跨文件可恢复事务、对象模板、复杂属性（含嵌套 class/list）、选择句柄和更多渲染方向 | 覆盖新增 fixture 的字节/语义往返；跨文件故障注入后可自动恢复到提交前或提交后的一致状态 |
| **后续 roadmap** | Wang/官方 `wangEdit` 后端、程序生成与预制件、World、游戏性分析、one-shot Tiled AutoMapping/转换/导出、TMX 独立写出、参考图导入、实时 GUI 扩展（若确有需求） | 每项独立设计、实现和验收；不以“58 个工具全部完成”作为单一里程碑 |

M1 只注册完成上述验收的最小工具集。第 3 节任何候选进入实现前，都要先分配到阶段、生成完整 schemas 并补齐 annotations/限制/测试。

## 7. 不做什么（Non-goals）

- **不做实时联动 Tiled GUI**（WebSocket 桥接方案）：复杂度高、需 Tiled 常驻，收益仅限"编辑器实时预览"；`tiled_render_preview` 已覆盖大部分需求。若未来有需求，作为独立扩展项目。
- **不做游戏运行时渲染/逻辑**：只管地图资产，不管游戏引擎内如何使用。
- **不重新实现 AutoMapping 规则引擎**：规则语义复杂且随版本演进，借 Tiled 本体执行。
- **不做 DSL 式邻接约束规则系统**（"悬崖边必须接悬崖顶"之类的自定义约束语言）：AutoMapping + Wang 地形已覆盖绝大部分场景，自研约束引擎是无底洞。
- **不做会话级隐式状态**（“当前地图/当前图层/当前选区/上一步操作”）：每次调用显式携带路径、id、revision 或有 TTL 的服务端句柄；参数复用由客户端或封闭 edits 完成。
- **Prompt 不代替批准**：Prompt 只能生成工作流消息，任何 destructive change set 仍须经过客户端批准门。
