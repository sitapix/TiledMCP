# 跨文件 WAL 事务设计（M2，待批准）

状态：**设计稿，未实施**。本文对应已批准工作项"跨文件 WAL 事务（先设计后实施）"，
给出方案对比、推荐设计与需要拍板的决策点。批准后按第 7 节切片实施。

## 1. 目标与非目标

**目标**：一次批准的多文档提交要么全部落盘、要么完全不落盘；进程在提交过程中的
任意点崩溃后，启动对账能把项目恢复到"完全提交前"或"完全提交后"之一，且恢复
动作可机器验证、可向操作者解释。

典型场景（按价值排序）：

1. 一批**互相独立**的已批准 change set 原子提交（多张地图各自的编辑、地图编辑 +
   不相关 tileset 的编辑）——"all-or-nothing 批量应用"。
2. `tiled_create_tileset` + `tiled_add_tileset_to_map` 原子组合（创建即挂载）。
   可行性依据：create 计划的 `expectedRevision` 就是 prospective TSJ bytes 的
   SHA-256，attach 计划可据此预先 pin 新 tileset 的确切 revision。
3. `tiled_update_tile` + 依赖新 tileset revision 的地图编辑（改元数据并同步改
   地图）——需要"计划 pin 改写"语义，复杂度显著更高。

**非目标**：

- 不改变 `filesystemThreatModelContract` v1 的运维前提：提交窗口内的非合作写者
  仍是 unsupported。跨文件原子性只在单文件原子性成立的同一前提下成立。
- 不做跨进程分布式协调、不做网络/云文件系统承诺。
- 不引入通用嵌套事务或保存点。

## 2. 必须保持的既有不变量

- 单文档提交路径（CAS + checkpoint + 同目录 rename/hard-link promotion +
  项目文件锁）逐字不变；事务是其上的组合层，不是替代。
- 每个净变更目标在写前先有 checkpoint（事务成员逐一沿用）。
- change set 的 preview→批准→apply 边界与 anti-ABA digest 机制不变；事务不得成
  为绕过单成员批准的通道。
- `.tiledmcp` 内部状态的启动对账模式（scan → 分类 → 自动处理/留给裁决）沿用。

## 3. 方案对比

### 方案 A（推荐）：redo journal + 内容寻址 staging + 有序逐文件 promotion

- 事务 manifest 存于 `.tiledmcp/transactions/<uuid>.json`，字段：
  `{version, id, state: "prepared" | "committed", createdAt, label,
  entries: [{path, kind: "replace" | "create" | "delete",
  expectedRevision | expectedAbsent, afterRevision | afterAbsent,
  contentObjectHash?, checkpointId}]}`。
- 新内容以**内容寻址对象**staged（直接复用 checkpoint store 的 object 存储与
  GC 根机制：prepared 事务 manifest 是新的 GC 根类别）。
- 提交协议：
  1. 按 canonical 路径序对全部目标取既有项目文件锁（全序 → 无死锁）。
  2. 逐目标 CAS 复核（replace/delete 校验当前 revision；create 校验缺失）。
  3. 逐目标建立 before-state checkpoint（沿用现有 prepare 机制，manifest 关联
     事务 id 作为 label 约定）。
  4. staged 内容对象落盘并 fsync。
  5. **提交点**：事务 manifest 以 `state:"committed"` 原子落盘（单文件 tmp +
     fsync + rename）。此前崩溃 → 回滚；此后崩溃 → 前滚。
  6. 逐目标 promotion（replace 走 rename、create 走 hard-link no-replace、
     delete 走 checkpoint-先行 unlink——三者都是现成机制）。
  7. 删除事务 manifest（终态即"无 manifest"），checkpoint 标记 committed。
- 启动对账新增事务扫描（在现有 checkpoint 对账之前）：
  - `prepared` manifest：提交点未过 → **回滚**：目标未动（promotion 未开始），
    删除 manifest 与孤儿 staged 对象；成员 checkpoint 走既有 prepared 对账。
  - `committed` manifest：**前滚**：逐目标核对当前 revision——已等于
    afterRevision 的跳过；仍等于 expectedRevision 的重放 promotion（staged 对象
    内容寻址、重放幂等）；两者皆非（崩溃窗口内被外部写）→ 该目标标记 conflict，
    进入类似 prepared-checkpoint 裁决的人工流程，其余目标照常前滚——原子性承诺
    在此退化为披露（与威胁模型的非合作写者边界一致）。
  - 前滚完成 → 删除 manifest。

### 方案 B：undo log（先写目标、before 镜像兜底回滚）

提交点在最后一个目标写完之后；崩溃恢复方向是回滚。缺点：提交点不是单一原子动
作（需要"全部写完"这一复合事实），恢复语义与现有 create/delete 机制的组合更
绕；对账时必须区分"第 N 个目标写到一半"。不推荐。

### 方案 C：generation 目录切换

整目录换代 + 符号切换。与"保留未触碰文件原始 bytes、`.tiledmcp` 之外零额外状
态"的项目原则冲突，工作区语义对外部工具不透明。排除。

## 4. Wire 契约设计（推荐形态）

**组合既有已批准 change set，而不是新的嵌套操作语言：**

- 新 preview 工具 `tiled_preview_transaction`：输入
  `{changeSetIds: [2..16 个已存在且未 apply 的 change set id]}`。
- 校验：成员必须是文档提交类计划（`mapEdit` / `tilesetEdit` / `tilesetCreate` /
  `fileDelete`）；目标路径两两不同（V1 不合并同文件多计划）；成员之间无 pin 耦
  合（成员 A 的 apply 不得使成员 B 的任何 revision pin 失效）——唯一放行的耦合
  是场景 2（create+attach，attach pin 的正是 create 的 prospective revision）。
  checkpoint 类计划、restore 类计划 V1 排除。
- 返回 `transaction` change set：域分隔 digest 固化全部成员的计划 digest 与目标
  pin 集，`expectedRevision` 采用聚合 digest（有序 `{path, revision}` 对的
  SHA-256，与 batch prune 的聚合 pin 先例一致）。
- apply：走第 3 节协议；响应返回逐目标的 commit 结果数组 + 事务 id。
- 成员 change set 在事务 preview 时**转移所有权**（成员单独 apply 与事务 apply
  互斥，防双重提交）；事务过期释放成员。

## 5. 预算与边界

- 成员数 2..16；staged 总字节 ≤ 64 MiB（与依赖聚合上限一致）。
- 事务 manifest 计入 checkpoint store 配额体系（staged 对象与 before 对象同池，
  prepared 事务是 GC 根）。
- 同一时刻 pending 事务 change set ≤ 4。

## 6. 需要拍板的决策点

| # | 决策 | 推荐 |
|---|---|---|
| D1 | 方案 A（redo journal + 前滚）vs 方案 B（undo log + 回滚） | A |
| D2 | wire 形态：组合既有 change set vs 新嵌套操作语言 | 组合既有 change set |
| D3 | V1 是否包含场景 2（create+attach 耦合放行） | 包含（价值高、pin 可静态验证） |
| D4 | committed 前滚遇到外部写坏单目标时：整体阻塞人工裁决 vs 该目标单独 conflict、其余前滚 | 单目标 conflict + 披露 |
| D5 | 成员所有权：事务 preview 即锁定成员（互斥单独 apply） | 锁定 |

## 7. 实施切片（批准后）

1. **S1 存储核心**：事务 manifest 读写/校验、staged 对象复用 checkpoint store、
   提交协议、启动对账（回滚/前滚/conflict 分类），全部配崩溃注入测试（在每个
   协议步骤间插入 kill 点重放对账）。无 wire 变化。
2. **S2 wire**：`tiled_preview_transaction` + `transaction` change set kind +
   apply 分发 + 成员所有权 + 契约/文档/guide；含场景 1。
3. **S3 场景 2**：create+attach 耦合校验与端到端测试。
4. **S4（可选，另行拍板）**：场景 3（pin 改写）与同文件多计划合并。
