# FLY-2351 快照与磁盘护栏 — 探索
Issue: FLY-2351 (https://linear.app/geoforge3d/issue/FLY-2351/运维磁盘-满盘事故-9-5-0130patrol-repairs-库快照无上限127-份55gb-qa-体往-tmp-拷生产库不回收)
日期: 2026-09-08
基于: 无

## 目标与授权

把两类数据库副本的生命周期补齐：修复前的恢复点自动保留/淘汰，验证副本随执行结束回收，写入前和巡检时检查真正承载用户文件的 Data 卷。本节点只交付设计与审查，不操作生产库、不清理生产文件、不实现或派发下一节点。

依据：任务注入的完整 issue 与 `.claude/skills/linear-issue-context/SKILL.md` 内容一致。无 Linear MCP；未把缺少 live issue 查询包装成“已查 Linear”。基线提交 `ee113cab956bf3d71f186e5d72b24baf545e629c`，TURN design/epoch=1；Bridge health 在审计时为 ok。

## 事故与当前证据分开

- issue 记录 2026-09-05 01:30–01:45Z Data 卷满盘，127 份修复快照占约 55 GB；验证副本遗留 `/tmp`；Bridge 与会话工具无法写文件。
- 2026-09-08 只读目录元数据清点：`~/.flywheel/patrol-repairs` 仍有 15 个顶层 `.db`，逻辑大小合计 12,069,470,208 bytes。没有读取这些数据库的内容，没有执行删除。
- 现存名称如 `FLY-2387-worktree-binding-...db`、`FLY-2387-qa-worktree-binding-...db`、`comm-2403-unpark-...db` 与 `commdb-pending-rebind-2143-2239-...db`。修复动作不是数据库类型；最后一个名称也不能安全猜出唯一 issue。

## 必须实现的行为

| 要求 | 设计应证明的行为 |
|---|---|
| 24h 内 + 每 issue 每类最新一份 | 保留条件取并集；删除只命中可归属、完整、非写入中的旧副本 |
| avail ≥ 5 × 文件大小 | 以 Data 卷可用 bytes 比较，等号允许；容量未知拒绝创建并告警 |
| `/tmp/flywheel-snapshots/<exec>/` | runner 生产库副本的唯一落点；不同 exec 隔离 |
| 单目录 2GB | 获取副本前核算整个目录，拒绝溢出；不得先生成大副本再删来冒充准入 |
| 节点终态 closeout | 覆盖正常交接、QA verdict、失败/取消、进程崩溃；复用 exec 的后续 attempt 不能被旧回调删掉 |
| STEP 5 + capacity | 同一 `disk_avail_gb`、同一字节来源、低于 20GB 为 FINDING，未知为 UNAVAILABLE |
| macOS 文档 | 运维命令使用 `df -h /System/Volumes/Data`；根目录是系统卷，不能代表用户数据写入面 |

## 方案比较

| 方案 | 好处 | 代价/拒绝理由 |
|---|---|---|
| 只提醒人工清理 | 最少改动 | 根因继续累积，不满足自动回收 |
| 通用磁盘管理服务 + 新调度器/数据库 | 可以扩展到任意文件 | 本 issue 不需要；增加新的持久化和运维面 |
| 小型共用存储工具 + 既有 Bridge 维护 tick/closeout | 统一测量、写入和删除规则，复用调度 | 需要逐个迁移当前生成入口，推荐 |
| 操作系统强制目录配额/挂载镜像 | 能限制任意外部写入 | macOS 普通目录无现成目录配额；挂载/权限/恢复复杂，暂不选 |

## 选择与显式边界

采用原生文件系统 API 与 SQLite 在线备份，不新增 npm 依赖、不另起守护进程。修复快照类型固定为数据库身份（teamlead、comm；comm 带 project），不用修复动作/请求 UUID 扩张分组。目录预算以 bytes 定义，展示单位明确；精确单位在实施计划锁定。

2GB 若被理解为对任意 shell/SQL 后续写入的内核强制上限，需要另一个平台方案。这里推荐对受管副本获取作硬准入，整个目录超量由巡检显式报出、终态清理；不能声称它限制了任意绕过工具的写入。已向 Lead 发非阻塞问题 `ec87d39f-aa63-49cb-b098-e96790a1077b`，同时询问类型粒度与旧文件映射；继续独立调研。

## 调研重点

1. API 与巡检共享的容量数据/格式化消费者，避免新字段被投影丢掉。
2. 常驻 Codex 在 phase 完成后仍活着；节点产物终态与进程死亡是两条回收触发条件。
3. 旧文件迁移、并发写入锁、`.partial` 失败收口、symlink/路径穿越/生产库误删阴性验证。
4. 能复用的备份/retention 代码只提取必要部分；保留 archive/db-backups 的独立恢复合同。
