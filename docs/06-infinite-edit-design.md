# 无限地图编辑设计（M2）

状态：**已实施**（S1 核心 + S2 接线 + S3 契约；tests/chunkedCellView.test.ts 与 tests/infiniteMapRead.test.ts 覆盖）。对应已批准工作项"无限地图编辑（chunk 保持写回）"。
语义全部对照 Tiled 1.12.2 源码
（src/libtiled/tilelayer.{h,cpp}、maptovariantconverter.cpp）考证。

## 1. Tiled 1.12.2 的 chunk 语义（源码结论）

- 内存 chunk 是 16×16（`CHUNK_SIZE`）网格；`setCell` 用位运算
  `x >> CHUNK_BITS` 定位 chunk，负坐标 floor 对齐。
- **保存时重分桶**：`sortedChunksToWrite(chunkSize)` 按
  `map.chunkSize()`（`editorsettings.chunksize`，缺省 16×16）把全部非空
  cell 重新分桶为对齐 rect，**空 chunk 一律不写出**；负坐标经 modulo 修正
  实现 floor 对齐；结果按 `compareRectPos` 排序（y 优先、再 x）。
- 层级 `width/height/startx/starty` 写自 `localBounds()`——按 chunk 对齐
  rect 的并集维护（只增不减；新鲜 load→save 等于非空 chunk rect 并集）。
- 读取器接受任意 chunk rect（不要求对齐），因此"保持原 chunk 边界"不是
  Tiled 自身的行为：**Tiled 每次保存都会规范化 chunk 结构**。

## 2. 决策

| # | 决策 | 结论 |
|---|---|---|
| D1 | 被写 chunked layer 的序列化 | **规范化写回**（与 Tiled load→save 逐语义一致）：全部非空 cell 按 `editorsettings.chunksize`（缺省 16×16）floor 对齐重分桶、丢空 chunk、(y,x) 排序、`startx/starty/width/height` 重算为非空 chunk rect 并集。逐格 cell 语义不变；未被写 layer 依旧逐字节保留。M2 路线图早先的"原 chunk 边界保持"措辞按源码证据修正为本决策并披露 |
| D2 | V1 操作面 | chunked tile layer 允许 `setTiles` 与 `stampPattern`（显式 cell 集合，天然有界）；`floodFill`/`copyRegion`/`replaceTiles`/`resizeMap` 对 chunked layer 继续 fail closed（后续另行放行）；对象/图层成员/地图根属性操作与 tile data 无关，经逐操作审计后放行 |
| D3 | 写入既有 chunk 外 | 重分桶自然覆盖：新 cell 落入对齐新 chunk，无需独立分配协议 |
| D4 | 编码 chunk | 沿用层级 `encoding`/`compression` 逐 chunk 重编码，绝不转码；净 no-op 写入恢复原始字节（与有限 encoded layer 先例一致） |
| D5 | 预算 | 沿用既有：≤4,096 chunk/层、chunk 重叠 fail closed、cellWrites 100,000 上限、读取解码预算不变；重分桶后 chunk 数超限 fail closed |

## 3. 实施切片

1. **S1 核心**（tileData.ts 纯函数 + 测试）：`createChunkedCellView`
   （逐 chunk 解码 → 稀疏 `Map<"x,y", gid>` + 读写接口 + 脏标记）与
   `serializeChunkedCells`（重分桶 → 排序 → 逐 chunk 编码 → bounds），
   往返测试含负坐标、非对齐输入 chunk、encoded chunk、净 no-op。
2. **S2 接线**：`planEdits` 对 infinite 开 `allowInfinite`，
   `validateAndSummarizeOperations` 按 D2 逐操作 gate；受影响 chunked
   layer 的 source patch 替换 `chunks` 与 bounds 四成员；summary 计数
   （cellWrites/nonEmpty）基于稀疏视图。
3. **S3 契约**：capabilities（`tileDataReadCapabilities.infiniteMaps`
   与新 `chunkedWriteProfile` 字符串）、guide/README/spec/architecture、
   既有"infinite 绝不可编辑"测试语义翻转、双门禁。
