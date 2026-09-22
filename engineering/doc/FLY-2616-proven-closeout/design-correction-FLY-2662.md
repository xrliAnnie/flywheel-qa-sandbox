# FLY-2662 对 FLY-2616 可证明收尾设计的修正

日期：2026-09-17

FLY-2616 建立了“只有可证明 gone 才能清记录”的正确底线，但它的实现与复审遗漏了部署前旧作业和 `:pending` 占位窗口。FLY-2662 不放宽底线，而是补齐证据来源、恢复正门与围栏。

## 被本单取代的判断

- `runner-*:pending` 不是永久 unknown。只要 exec-marker 全窗扫描为空、execution-wide host process/daemon 均 absent，且持久身份在写入前未变化，它可以形成 gone 证据；任一活进程仍是一票否决。
- `closeout_targets_* IS NULL` 的已合并旧 operation 不是“没有 operation”。`land reclose` 对原 operation 做只读重采样，并在同一 resume 事务里附加 v2 target snapshot；失败不创建 replacement operation，也不恢复 merge 权力。
- 缺失 worktree 的旧绑定可使用 `legacy_absence_observation`：同一 repo lock 内验证叶子两次 ENOENT、未注册、parent dev/ino 稳定，再把证据附到原 operation。它不是历史 parent 身份的伪造。
- closeout 顺序固定为：确认 physical gone → worktree settled → CommDB/运行记录 finalize → thread archive → Linear Done。land 路径禁止用裸 finalize 跨过前两步。
- owner deadline 采用生产实现的 5 分钟，不采用 FLY-2616 文档中的 20 秒。进程死亡仍由独立的本机 `(pid,start,boot)` 探针在 10 秒内围栏；可见代价是“进程仍活但不再前进”的 owner 最多占 lane 5 分钟，并触发去重 owner-health 告警。

## 复审 advisory 的收口

- runId 扩展只进入 land-managed closeout；非 land 保持原 inventory。
- shipped husk、worktree settle、evidence 与 reservation 都携带并核对 `ownerInstanceId`。
- 窗口证据总是做 exec-marker 全窗发现，不能只信 CommDB target。
- CommDB identity 使用单调 epoch；内容 digest 只用于内容绑定，不承担 ABA revision。
- owner heartbeat 写入进度 tuple；hung owner 走 durable、去重的 health outbox。
- 通知、thread archive、worktree audit 与最终 settlement 均在 owner/generation/lease 围栏后执行。
- closeout attribution 使用单调 epoch + digest 双围栏；采样前后与落盘/消费时都复核。
- sibling session 不再给无 gate-entry 的 finalization 借身份。
- closeout-only 恢复要求 Lead 身份：Claude 通过 Darwin Unix peer 的内核进程身份链，Codex 通过 carrier；共享 bearer 单独不足。
- request replay 同时绑定 expected head、merge SHA、resume generation 与 request id；host probe 错误映射 unknown；realpath/stat 错误均转 typed refusal。

本修正文档只描述设计差异。生产旧卡的逐张 reclose、Discord/Linear readback 与部署验证仍由 Lead 在修复部署后执行，Runner 不写生产数据库。
