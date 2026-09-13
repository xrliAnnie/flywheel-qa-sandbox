# FLY-2459 迁移游标后续裁定 — 实施计划
Issue: FLY-2459 (https://linear.app/geoforge3d/issue/FLY-2459)
日期: 2026-09-11
基于: plan.md

## Lead 后续裁定

问题 `c83ad949-2a85-46d8-8887-a8531104344e` 的 Lead 答复调整了已批准计划 §4.3 的证据来源。保留原 plan.md 与其审查绑定，不改写历史批准内容。本记录说明后续实现依据。

- 不新建 journal。旧 Claude Lead 没有逐条已处理的持久回执，使用 Discord 本身。
- 停旧 writer 后，用 bot token REST 读取各订阅频道最新 message id，记录 channel、cutoff id 与时间戳到迁移 operator 产物。
- 旧 Lead 自己在 inbound 之后发出的 bot 作者消息，是已处理证据；mailbox delivered_at 不作为完成证据。
- cutoff 前没有旧 bot 回复的 inbound 列入 unresolved，随迁移交给新 Lead 重读。此类缺少处理证据不再作为 hold 条件。

此裁定不授权生产重启、派单或自动重做可能已有副作用的操作。新 Lead 重读 unresolved 时仍须使用现有部门、幂等和 founder 权限合同，先对账已有结果。后续 seed 接线须保留 unresolved 的来源 ID，不能把它们标成已完成或丢弃。

## 实施状态

已实现有界 REST 采集函数：记录最新 cutoff、旧 bot 的后续回复，以及 unresolved 消息 ID；达到历史分页上限时保留 unresolvedBefore 范围，空频道明确为 null cutoff。operator 文件已按 intentSha 绑定并以 0600 不可覆盖写入；重跑优先读取首次快照。迁移专用 seed 适配先将 unresolved ID 与历史边界交给标准 mailbox，再复查停机窗口并写传输游标。交接或停机检查失败时不写游标；原 seed-lead-inbound-cursor 工具拒绝非空 unresolved 的默认保护不变。尚未接入实际重启执行器或生产调用。

空频道 seed 已支持显式 `emptyChannels`：保存传输游标 `0`（第一条消息之前），避免新 owner 首次 baseline 跳过停机窗口消息。这不是伪造的已确认消息 ID。真实轮询组件已验证第一条消息被交付、游标推进，并可再次 seed 校验为 already_advanced；运行时 cursor 写入保持 0600。临时 SQLite + cursor 文件测试覆盖交接后重启重读、失败不推进游标；投递回执不是业务处理完成证据。

## 目标 preflight 的两阶段裁定

问题 `2a724d78-3b3c-4f11-af11-69008de3f1af`：现有 generic preflight 强制使用 live registry，因此不能在旧 Claude row 仍生效时检查 Codex 候选。Lead 裁定不新建 candidate-preflight API、不向 launcher 暴露候选 registry 覆盖。

- prepared：停旧 owner 前检查静态目标前置，包含 auth 文件存在、Codex home/link truth、root 校验、full-access profile、host tmux 门、编译工具和 token 存在。
- activation：CAS 配置及 manifest 后、激活前运行完整既有 generic preflight。
- 后一步失败须执行条件回滚并恢复旧 owner，返回 deployed_unverified/failed 与结构化原因，不留半套配置。此要求是此次 Lead 对该失败路径的明确裁定；其余失败路径不据此扩展自动回滚权限。

当前尚未完成此执行器与回滚接线；既有纯 CAS/文件恢复函数不构成已验证的完整恢复流程。

## 窗口外因果锚点裁定（2026-09-11）

Lead question `cc77e56d-6624-4423-b11e-db858c3b67e6` 已回复：不新建跟踪系统。真 @ 用 bot REST 精确回读 founder 作者、频道、message ID、时间；Bridge 账本核对 issue/run/node/execution/activation/issue_delivery，派单时间必须晚于 @。start_runner 的 idempotencyKey 从源消息引用派生并绑定 issue，verifier 重算后比对 Bridge 持久化 key；无源消息的手动/巡检调用保留普通 key 并明确 `source=none`。QA 鉴权 transcript 是辅助，不信证据文件的 passed 布尔。

实现使用现有参数内的 `discord:<channelId>:<messageId>` 形状，Bridge key 仍是原 project/lead/issue/key JSON 的 SHA-256，既有普通 key 摘要不变。源引用是待核验的归因，不是授权；部门闸与 actor 权限保持原机制。

## 成功 intent 退休裁定（2026-09-11）

Lead question `fd14d506-1a3c-45bd-8a73-911fd63fda2f` 确认：verifier 只读核验并提交 verified/committed 回执后，将该 intent 原子退休到同一私有迁移目录固定名 `FLY-2459-honey-lemon.committed.json`，哈希绑定回执、内容不可变。归档不覆盖；同一 intent 重放幂等。失败/held 留在活动路径。正常班车无活动 intent 时正常重启，不写 config/service/admission。实现与回执共用短锁串行化退休调用，rename 后 fsync 目录。
