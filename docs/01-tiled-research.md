# Tiled 软件调研报告

> 调研时间：2026-07-23。当前最新稳定版为 **Tiled 1.12.2**（2026-05-27 发布）。
> 目的：为设计 Tilemap MCP 服务器提供数据模型、文件格式与生态依据。

## 1. Tiled 是什么

[Tiled](https://www.mapeditor.org) 是广泛使用的开源通用 Tilemap 编辑器（Qt/C++ 实现），用于制作 2D 游戏关卡：正交、等距（isometric）、六边形地图均支持。其文件格式（TMX/TMJ）拥有成熟的跨引擎生态；Godot、Unity、Phaser、Bevy、Defold、GameMaker 等可通过官方功能、社区 importer 或 Tiled 导出格式接入，但具体格式与功能覆盖需要按引擎和插件版本确认。

## 2. 核心数据模型

```
Project (.tiled-project)               可选的项目级配置：资产目录、自定义类型、兼容性等
    ├── 可关联 World (.world)          多张地图按全局像素坐标组织
    └── 可关联 Map / Tileset / Template 资产

World (.world) ──引用──> Map (.tmx / .tmj)
Map                                      地图：orientation、尺寸、tile 尺寸
├── Tileset 引用 (firstgid + source) → 外部 .tsx/.tsj（或内嵌）
└── Layer 树（可嵌套 Group）
    ├── Tile Layer                     GID 数组（无限地图为 chunk 列表）
    ├── Object Layer                   自由摆放的对象
    ├── Image Layer                    单张背景/前景图
    └── Group Layer                    图层文件夹（属性向子层传播）
```

Project、World 与 Map 不是严格的所有权树：地图可以脱离 Project 或 World 独立存在；World 通过文件名引用地图，Project 则主要提供项目级发现与配置。

### 2.1 Map（地图）

关键字段如下。TMX XML 属性与 TMJ JSON 字段多数同名且全小写，但具体层级和编码仍应分别按格式参考处理：

- `orientation`：`orthogonal` / `isometric` / `staggered`（等距错行）/ `hexagonal`（六边形错行）/ `oblique`（1.12 新增）
- `width`、`height`（以 tile 计）、`tilewidth`、`tileheight`（像素）
- `renderorder`：`right-down`（默认）/ `right-up` / `left-down` / `left-up`，当前只为 orthogonal 地图实现，其他 orientation 不应依赖该字段
- `infinite`：无限地图开关（图层数据变为 chunk 存储）
- `staggeraxis`（`x`/`y`）、`staggerindex`（`odd`/`even`）：staggered/hexagonal 用
- `hexsidelength`：六边形边长（仅 hexagonal）
- `skewx` / `skewy`：仅 oblique（1.12+）
- `nextlayerid`、`nextobjectid`：**编辑器维护的自增 ID 计数器，写入器必须正确维护，否则 Tiled 打开后会产生 ID 冲突**
- `backgroundcolor`、`parallaxoriginx/y`、`compressionlevel`、`class`

文档：<https://doc.mapeditor.org/en/stable/reference/tmx-map-format/#map>

### 2.2 Layer（图层，4 种，可树状嵌套）

| 类型 | JSON `type` | 说明 |
|---|---|---|
| Tile Layer | `tilelayer` | GID 数组；支持翻转位 |
| Object Layer | `objectgroup` | 自由对象；`draworder`: `topdown`（默认）/ `index` |
| Image Layer | `imagelayer` | 单图；`repeatx`/`repeaty`（1.8+）、`transparentcolor` |
| Group Layer | `group` | 图层文件夹；可见性/opacity/offset/tint 向子层传播，parallax 逐层相乘 |

所有图层通用字段：`id`、`name`、`class`、`opacity`、`visible`、`locked`、`tintcolor`、`offsetx/y`、`parallaxx/y`、`properties`，以及 1.12 新增的混合模式 `mode`（`normal`/`add`/`multiply`/`screen`/`overlay` 等 13 种）。

### 2.3 Object（对象）

通用字段：`id`、`name`、`type`（即 class）、`x`、`y`、`width`、`height`、`rotation`（度）、`visible`、`opacity`（1.12+）、`gid`（tile object）、`template`、`properties`。

形状类型：

- **矩形**（默认，无形状子元素，原点左上角）
- **椭圆** `ellipse`、**点** `point`、**胶囊** `capsule`（1.12 新增）
- **多边形/折线** `polygon` / `polyline`：`points` 为相对对象位置的坐标对（JSON 中为 `[{x,y},...]` 数组）；polygon ≥3 点闭合，polyline ≥2 点开放
- **文本** `text`：`fontfamily`、`pixelsize`（默认 16）、`wrap`、`color`、`bold/italic/underline/strikeout`、`halign`/`valign`
- **Tile Object**：带 `gid` 的对象，可自由缩放旋转，锚点由 tileset 的 `objectalignment` 决定

对象间引用：`object` 类型的自定义属性存目标对象 `id`（如"开关→门"）。

### 2.4 Template（对象模板）与 World（世界）

- **Template**（`.tx`/`.tj`）：单个对象存为独立文件复用；tileset 引用必须在 object 之前，不支持内嵌 tileset。实例上被修改的属性标记为 overridden，不随模板更新。
- **World**（`.world`，JSON）：`maps[]` 按全局像素坐标（`fileName`、`x`、`y`）拼合多张地图；`patterns[]` 支持按文件名正则批量映射。1.11 起脚本 API 可操作 world。

## 3. 文件格式

### 3.1 文件类型总览

| 内容 | XML | JSON |
|---|---|---|
| 地图 | `.tmx` | `.tmj`（`"type": "map"`） |
| 图块集 | `.tsx` | `.tsj`（`"type": "tileset"`） |
| 模板 | `.tx` | `.tj`（`"type": "template"`） |
| 世界 | — | `.world`（`"type": "world"`） |

TMX 与 TMJ 的数据语义大体对应，但序列化结构并非逐字段机械等价：TMX 使用 XML 属性/子元素，TMJ 使用 JSON 字段/数组，少数字段和编码形式存在差异。Tileset 可内嵌在地图中，也可外部引用（1.0 起默认，推荐）：TMJ 地图内通常只存 `{"firstgid": 1, "source": "tileset.tsj"}`，TMX 则使用对应的 `<tileset firstgid="…" source="…"/>`。

### 3.2 Tile Layer 数据编码

- **CSV**：明文 GID 逗号分隔（TMX `encoding="csv"`；JSON 直接为无符号整数数组）
- **base64**：解码后为**小端 32 位无符号整数数组**，可选压缩 `gzip` / `zlib` / `zstd`（1.3+）

### 3.3 GID 与翻转位（最重要的坑）

GID 0 = 空格子。某 GID 属于"`firstgid` 不大于它的最大 tileset"；`local id = GID - firstgid`。32 位 GID 的最高 4 位是标志位：

```c
FLIPPED_HORIZONTALLY_FLAG  = 0x80000000;  // 水平翻转
FLIPPED_VERTICALLY_FLAG    = 0x40000000;  // 垂直翻转
FLIPPED_DIAGONALLY_FLAG    = 0x20000000;  // 对角翻转（hexagonal 地图上语义为旋转 60°）
ROTATED_HEXAGONAL_120_FLAG = 0x10000000;  // 旋转 120°（仅 hexagonal）
```

读取时必须**一次性清除全部 4 位**（官方特别提醒非 hex 地图也要清第 29 位）。因高位被占用，JSON 中翻转的 tile 表现为超大整数（如 `2147483649` = tile 1 + 水平翻转）。

文档：<https://doc.mapeditor.org/en/stable/reference/global-tile-ids/>

### 3.4 无限地图与 chunk

`infinite: true` 时 tile layer 数据变为 `chunks[]`（每个 chunk 有 `x`、`y`、`width`、`height`、`data`，坐标可为负），并有 `startx`/`starty` 记录内容边界。16×16 是常见默认 chunk 大小，不是格式约束；写回器应保留原有 chunk 布局，不能假定或强制重切为固定大小。

## 4. Tileset 细节

### 4.1 两种 tileset

- **图集式**（Based on Tileset Image）：单张图片按 `tilewidth`/`tileheight` 切割，支持 `margin`、`spacing`；`tilecount`、`columns` 记录规模。
- **图片集合式**（Collection of Images）：每个 tile 自带 `image`（尺寸可各不相同），1.9+ 可用子矩形裁剪。

其他字段：`objectalignment`（tile object 锚点，9 方位）、`tilerendersize`、`fillmode`、`grid`（等距 tileset 用）、`tileoffset`（渲染像素偏移）、`transformations`（声明允许的翻转变体 `hflip`/`vflip`/`rotate`/`preferuntransformed`）。

### 4.2 单 tile 能力

- **动画**：`animation: [{tileid, duration}, ...]`，duration 毫秒，单条线性循环
- **碰撞形状**：每 tile 一个 `objectgroup`，内含矩形/椭圆/多边形等碰撞对象（Tile Collision Editor）
- **概率**：`probability`（默认 1），随机笔刷/地形笔刷用
- **自定义属性**：任意 property

### 4.3 Wang Sets / Terrain（地形系统）

Tiled 的地形笔刷基于 Wang tiles，三种匹配类型：

| 类型 | 匹配方式 | 2 种地形完整集所需 tile 数 |
|---|---|---|
| `corner` | 按 4 角 | 16 |
| `edge` | 按 4 边（道路/栅栏） | 16 |
| `mixed` | 角+边同时 | 256 |

- `wangcolor`：每 set 最多 254 色，含 `name`、`color`、`tile`（代表 tile）、`probability`
- `wangtile`：`tileid` + `wangid`（8 个颜色索引，**顺时针从 top 开始：top, top-right, right, bottom-right, bottom, bottom-left, left, top-left**，0 = 未设置）
- 旧版 `terraintypes` 已废弃，被 Wang set 取代

文档：<https://doc.mapeditor.org/en/stable/manual/terrain/>

## 5. 自定义属性系统

- property `type` 共 9 类：`string`（默认）/ `int` / `float` / `bool` / `color` / `file` / `object`（值为对象 id）/ `class`（1.9+ 嵌套结构）/ `list`（1.12+）；`propertytype` 指向自定义类型名
- `list` 可包含多个同类型值，也要覆盖 list/class 的嵌套组合；读写器不能只实现旧版的 8 类属性
- 属性可挂载在：map、tileset、tile、wangset、wangcolor、layer、object
- **自定义类型**（class/enum）定义在 Project 中，可导出为 `propertytypes.json`：enum 有 `storageType`（string/int）、`values`、`valuesAsFlags`；class 有 `members`、`color`、`useAs`（适用范围数组）
- 坑：class 类型属性**只序列化被修改过的成员**

## 6. Tiled 的自动化能力

### 6.1 JavaScript 脚本 API

<https://www.mapeditor.org/docs/scripting/> —— 能力很全（可创建/修改资产、注册自定义格式/命令/工具、操作 world），运行在 Tiled 进程内嵌的 Qt JS 引擎里，而不是可直接链接的独立 Node.js 库。

这不意味着自动化必须让 Tiled 常驻。Tiled 1.9+ 支持一次性命令：

```bash
tiled --evaluate script.js [args...]
```

该模式不会实例化 UI，执行脚本后即退出；脚本仍可加载、修改并保存地图与 tileset。只有需要交互式编辑器状态、实时工具或 UI 的场景，才需要常驻扩展与 IPC。MCP 应优先采用 one-shot adapter，并把 GUI/IPC 桥留作后续可选能力。

### 6.2 命令行

```bash
tiled --export-map [format] <source> <target>      # 地图格式转换/导出
tiled --export-tileset [format] <source> <target>
tiled --export-formats                             # 列出当前安装实际支持的格式
tiled --evaluate <script.js> [args...]             # 一次性执行脚本后退出
tmxrasterizer [options] <map|world> <image>        # 渲染地图或 world 为图片
```

可用导出格式取决于 Tiled 版本、构建和已启用插件，MCP 应在运行时读取 `--export-formats`，不能硬编码格式清单。PNG 等图片输出不应假定为 `--export-map` 格式；应使用随 Tiled 提供、能渲染受支持地图格式和 world 的 `tmxrasterizer`。无头部署还需按目标系统验证 Qt 平台插件，但 `--evaluate` 本身不要求常驻 GUI。

### 6.3 AutoMapping

用“规则地图”描述 input 层→output 层的模式替换（自动铺路、墙角、地形过渡）。命令行没有独立的 `--automap` 参数，但脚本 API 提供 `TileMap.autoMap()`；MCP 可通过 `--evaluate` 一次性加载地图、执行规则并保存，无需常驻编辑器。

Wang 编辑同样已有官方脚本后端：`TileLayer.wangEdit()` 可设置角/边颜色、启用邻格修补并应用结果。自研匹配器仍可作为无需 Tiled、强调确定性或便于测试的备选后端，但不应是首版唯一实现路径。

API：<https://www.mapeditor.org/docs/scripting/classes/TileMap.html#auto-map>、<https://www.mapeditor.org/docs/scripting/interfaces/TileLayerWangEdit.html>

## 7. 第三方读写库生态

核心结论：**生态里"读多写少"** —— 绝大多数库面向游戏运行时加载（只读）。

| 生态 | 代表库 | 读 | 写 | 备注 |
|---|---|---|---|---|
| **TypeScript** | [@kayahr/tiled](https://www.npmjs.com/package/@kayahr/tiled) | ✅ | ✅(JSON) | TS 类型 + JSON Schema + type guard；可作局部 helper 或 fork 起点，不作为 1.12 Schema 真相 |
| Python | pytiled-parser | ✅(TMX+TMJ) | ❌ | 读侧模型干净；写侧用内置 `json` |
| Python | pytmx | ✅ | ❌ | 最流行但明确无 save |
| C++ | tmxlite / Tileson | ✅ | ❌ | 运行时加载用 |
| C++ | libtiled（Tiled 自用） | ✅ | ✅ | 唯一可靠写 TMX 的库，但拖 Qt 依赖 |
| Rust | rs-tiled / bevy_ecs_tiled | ✅ | ❌ | Bevy 生态成熟 |

`@kayahr/tiled` 当前发布版仍为 `0.0.1`，其类型与严格 Schema 快照未覆盖 Tiled 1.12 的若干字段/能力，例如 `oblique`、图层 `mode`、对象 `capsule` 与 `opacity`、`list` 属性；严格校验还可能拒绝未来新增字段。因此写回基底应采用宽松 raw JSON + 自有 typed view，并原样透传未知字段。

除 libtiled 外，生态中缺少成熟、通用的独立 TMX(XML) 写库。TMJ 是标准 JSON，更适合作为 MCP 首阶段的直接读写格式；TMX 写出和兼容性转换可交给 Tiled CLI 或 `--evaluate`。目标引擎是否直接读取 TMJ，以及能覆盖哪些 Tiled 特性，仍需按 importer/导出器逐项确认。

## 8. 现有同类 MCP 分析（竞品）

本次调研抽样查看了 GitHub 上若干 Tiled MCP。按调研时的公开版本与功能说明，它们大多仍处于早期迭代阶段；star、版本、收费模式与功能覆盖都可能变化，实施前应重新核对：

| 项目 | 架构 | 调研时工具规模 | 观察与待核实项 |
|---|---|---|---|
| [chrisgliddon/tiled-mcp](https://github.com/chrisgliddon/tiled-mcp) | TS，直接读写文件 | ~27 个，`tiled_{action}_{resource}` 命名，带 readOnly/destructive 注解 | 调研版本中 TMX 只读，未发现地形/World/Template 覆盖 |
| [youichi-uda/tiled-mcp-pro-public](https://github.com/youichi-uda/tiled-mcp-pro-public) | MCP↔WebSocket↔Tiled 扩展↔脚本 API | 122 工具/12 类，含 Terrain/Export/Analysis | 调研版本依赖 Tiled 常驻；较大的工具面会增加选择与契约维护成本，公开/付费边界需复核 |
| [pujan1/tiled-mcp](https://github.com/pujan1/tiled-mcp) | TS，直接读写 | 16 工具，刻意极简 | 调研版本仅写 TMJ，未发现独立对象/属性工具 |
| [hoberobin/tiled-mcp](https://github.com/hoberobin/tiled-mcp)（npm `tiled-mcp`） | TS，直接读写 + **语义 tile 注册表** | place/fill/replace/校验 | 调研版本为 0.1.0；`grass`/`water` 等语义名映射 GID 的做法值得吸收 |

### 差异化机会（本次样本中的覆盖缺口）

1. **Wang 地形自动铺贴**：样本中覆盖有限；优先封装官方 `wangEdit()` / `autoMap()`，确定性自研算法作为可选后端
2. **World / Template / Project / 自定义属性类型**：样本中的覆盖有限
3. **TMX(XML) 写支持**：直接写回能力有限，可用 Tiled one-shot adapter 提供可靠转换
4. **校验与可视化**：GID 越界检查、地图 PNG 预览、语义 tile 命名
5. **引擎导出集成**：借 Tiled CLI 导出可用格式，并用 `tmxrasterizer` 生成图片
6. **规范的 Resources/Prompts 分层**：样本实现以 Tools 为主

## 9. 关键参考链接

- TMX 格式参考：<https://doc.mapeditor.org/en/stable/reference/tmx-map-format/>
- JSON 格式参考：<https://doc.mapeditor.org/en/stable/reference/json-map-format/>
- GID 与翻转位：<https://doc.mapeditor.org/en/stable/reference/global-tile-ids/>
- 地形手册：<https://doc.mapeditor.org/en/stable/manual/terrain/>
- AutoMapping：<https://doc.mapeditor.org/en/stable/manual/automapping/>
- 脚本 API：<https://www.mapeditor.org/docs/scripting/>
- 脚本命令行模式：<https://doc.mapeditor.org/en/stable/reference/scripting/#command-line>
- 命令行导出：<https://doc.mapeditor.org/en/stable/manual/export/>
- 图片导出与 `tmxrasterizer`：<https://doc.mapeditor.org/en/stable/manual/export-image/>
- 官方库清单：<https://doc.mapeditor.org/en/stable/reference/support-for-tmx-maps/>
- MCP 设计惯例：<https://www.philschmid.de/mcp-best-practices>、<https://github.com/awslabs/mcp/blob/main/DESIGN_GUIDELINES.md>
