# TiledMCP 文件系统威胁模型

> **状态：Frozen v1（direct filesystem backend）。** 本文冻结的是当前文件系统后端的
> 信任边界，不代表所有本机攻击面都已被消除。权威机器值由
> `tiled_get_capabilities.filesystemThreatModelContract` 返回；其
> `name` 为 `tiled-mcp-direct-filesystem-threat-model`，`version` 为 `1`。
> v1 任一字段或值发生语义变化都必须提升版本。

该 contract 的 `scope` 只覆盖 direct backend 提交的项目资产 JSON 文档目标。locks、
checkpoint manifests、content-addressed objects 与 asset registry 等 `.tiledmcp`
server-internal state 明确不在此 scope；它们分别由 checkpoint、asset identity 等契约和
实现规则约束，不能从本文的 document promotion 保证中推导内部 metadata 的写入语义。

## 1. 受支持的部署模型

v1 面向一个显式配置的本地项目根目录，并要求：

- 所有合作写者针对同一逻辑目标使用同一个规范化 project-relative POSIX path，并遵守
  TiledMCP 的锁协议；
- 项目位于支持同文件系统原子 `rename`、hard link、文件 `fsync` 和目录 `fsync` 的本地
  文件系统；分布式/网络文件系统语义尚未验证；
- 项目根及其父目录不会被同权限恶意进程在一次操作中主动替换；
- Tiled GUI、同步程序和其他不遵守锁的写者不会与既有目标提交并发保存。

这些是运维方必须验收的前提。服务器会传播实际 syscall failure，但不会探测或证明底层
文件系统真正实现了声明的原子性、锁或 durability 语义，尤其不会验证分布式文件系统。

若部署必须抵御同权限恶意本机进程，direct filesystem backend 不够。应使用容器、
`openat2` 等 OS 沙箱与 descriptor-relative 路径策略，或把所有写入强制经过
FUSE/write broker；这些后端当前尚未实现。

## 2. 已保证的边界

| 范围 | v1 保证 |
|---|---|
| Revision | 已存在文件的精确原始 bytes SHA-256；不是 generation，恢复成相同 bytes 的 ABA 仍是同一 revision |
| 同进程写者 | 按规范化项目路径的 mutex 串行 |
| 合作跨进程写者 | lock file + 锁内最终完整 SHA-256 检查；stale lock fail closed，不自动抢占 |
| 既有目标 promotion | 同目录 staging 写入并 `fsync` 后，用无条件原子 `rename` 替换 |
| 不存在目标 promotion | 同目录 staging 写入并 `fsync` 后，用 hard link 实现原子 no-replace；`EEXIST` 必然拒绝 |
| 静态路径 | 拒绝非规范路径、越界、预先存在的 symlink 和非普通文件；读 final component 时在平台支持下使用 no-follow |
| promotion 后失败 | 只有本次调用已安装目标且回读 bytes 的 SHA-256 匹配 proposed revision，才把后续 durability 失败降为 warning |
| 可见性 | 单路径 old-or-new 可见性；不承诺跨文件原子快照或事务 |

这些保证只有在第 1 节的运维条件成立时有效。

## 3. 明确不保证

### 3.1 非合作写者的既有目标 CAS

既有目标提交的顺序是：

```text
final full-byte SHA-256 check
        |
        |  non-cooperative writer can save here
        v
unconditional rename(temp, target)
```

portable Node `fs` 没有“目标仍匹配某个 SHA-256 才替换”的原子 primitive。普通
`rename`、`renameat2(RENAME_NOREPLACE)` 和 hard link 都不能给已存在目标增加该 predicate。
因此：

- 最终检查前已经可见的不同 bytes 会返回 `REVISION_CONFLICT`；
- 最终检查完成后、`rename` 前的非合作保存仍可能被覆盖；
- 一次成功 promotion 只证明该事件曾发生，不是“响应时目标仍是该 revision”的 lease；
- 需要当前状态时必须重新读取，不能依赖成功响应或 change-set replay。

`tiled_create_map` 不使用该既有目标路径。它的 hard-link no-replace 对“另一个进程抢先
创建目标”的竞态提供更强保证，即使外部 bytes 相同也不会认领为本次成功。

### 3.2 Path check-to-use race

`lstat`、`realpath` 和 final-component no-follow 能拒绝静态 symlink，却不能让一串普通
Node path API 变成 descriptor-relative sandbox。同权限恶意进程若在检查后替换中间父目录，
可能改变后续 `open`、`rename` 或 `link` 的实际命名空间目标。v1 把这类 hostile parent
swap 明确列为 unsupported，而不是声称已由路径规范化解决。

### 3.3 其他不保证

- 不提供 target inode/metadata CAS；
- 不提供跨文件原子性，map + TSJ + image 仍是 `non-atomic-read-set`；
- 不保证异常断电后的所有文件系统/硬件 durability；
- 不验证 distributed filesystem 的锁、hard-link、rename 或 `fsync` 语义；
- 不提供 mediated writer backend。

## 4. 锁和 hardlink alias

锁键来自规范化项目路径，不来自 inode。两个不同路径即使是同一个 hardlink inode，也不会
自动共享一把锁。因此受支持的合作写者模型要求“一个逻辑目标只使用一个规范化项目路径”。
如果项目故意用多个 hardlink alias 指向同一 TMJ/TSJ，调用方必须在外部统一串行，不能把
TiledMCP 的路径锁解释成 inode 锁。

stale lock 永远 fail closed。手动删除前必须确认原 PID/写者已不再活动；PID 存活检查不是
租约，也不会自动判断锁已安全过期。

## 5. Change set 与依赖语义

- change set 固定 map revision、依赖 revisions、计划 digest、连接和 TTL；
- apply 会重算计划并复核这些 pin，但多个依赖与 map 提交不是同一原子读集；
- 成功后的相同 `changeSetId` replay 返回首次缓存结果，不重新验证当前磁盘状态；
- 外部写者在最后一次依赖复核后仍可能改变依赖；
- 因此每次需要“当前”结论时都应重新读取 map summary/依赖，而不是把 replay 当查询。

## 6. 运维清单

执行任何既有目标提交前：

1. 确认项目位于满足 v1 原子性与 `fsync` 语义的本地文件系统；
2. 暂停 Tiled autosave、文件同步器和其他非合作写者；
3. 确保同一逻辑文件没有通过另一个 hardlink alias 被编辑；
4. 不在不可信的共享写目录中运行 direct backend；
5. 提交成功后，如后续决策依赖当前状态，重新读取 revision；
6. 监控 stale locks、prepared checkpoints 和
   `checkpointCapabilities.storagePolicy` 报告的 quota；quota/GC 属于
   `.tiledmcp` internal-state contract，不属于本文 document-target scope。

如果无法满足第 2～4 项，应把当前后端视为只读，或部署强制写入中介。

## 7. 与其他契约的关系

- `safetyStatus` 只保留 JSON 词法保真摘要；文件系统安全边界以本 v1 contract 为准；
- `mapCreationCapabilities` 进一步冻结 create-map 的 no-replace 特例；
- `assetIdentityContract` 只描述 opaque ID/registry，不把 file identity 当写入 CAS；
  registry 属于本 contract 明确排除的 server-internal state；
- `snapshotConsistency:"non-atomic-read-set"` 继续描述跨文件读取；
- `applicationErrorContract` 描述应用错误 wire，不扩大本威胁模型的保证。

## 8. 与 checkpoint rolling retention 的关系

checkpoint retention 属于本文明确排除的 `.tiledmcp` internal-state contract，但它删除
recovery point 前仍依赖本文的合作写者和安全普通目标读取前提。默认不启用；只有
`--checkpoint-retain-per-target N` /
`TILEDMCP_CHECKPOINT_RETAIN_PER_TARGET=N` 的进程启动配置才构成 standing approval，
且 `N` 至少为 2。

启用不会扩大 direct backend 的保证。自动策略只处理带 durable ordinal 的 v2
`rolling` existing-file committed manifest；legacy、protected/create 与 prepared
manifest 永远保留。它仍在当前 target lock 内取 checkpoint-store lock，重新读取目标并
要求 revision 等于最新 rolling checkpoint 的 `afterRevision`。任一非合作目标写入、
内部状态漂移、完整 inventory 或 object hash/size 校验失败都会令本轮零删除。revision
仍只是 bytes identity，不是 generation；顺序来自内部 durable ordinal，不从 SHA-256、
wall clock、mtime、UUID 或 label 推导。

retention 不在 quota-pressure 或 `ensureCapacity()` 中运行。新 checkpoint 必须先完整
发布且 durable 标记 committed；目标 promotion 有 durability warning 时跳过本轮。这样，
新写入或配额检查失败不会先删除旧恢复点，也不会引入 `store → target` 反向锁序。manifest
unlink + checkpoint 目录 fsync 是独立 destructive commit point；其后的 GC/锁故障在成功
document mutation 的有界结果中报告，不能解释为目标写入可以安全重试。
