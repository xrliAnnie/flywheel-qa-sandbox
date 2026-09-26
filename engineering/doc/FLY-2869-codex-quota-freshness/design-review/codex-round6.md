# Design Review — plan.md (Readiness Round 3)
Date: 2026-09-24
Author: Codex
Status: CHANGES REQUESTED

## Summary

本轮只复核 commit `330418ebd` 对 Readiness R2 四项意见的修订及其新引入契约；A–D 未重审。

R2 #3 与 #4 已关闭：逐行矩阵现在区分“排除/忽略”与“仍进入原归属”，lease-only 明确保留 `lease_without_process`/`complete=false`；§1.7 与 QA 表也已把实验结论限定在已测 non-refresh 路径和 15 秒窗口。三快照方案关闭了 argv prefix-extension 的算法漏洞，tracker 的 generation、完整轮、失败重置、realpath key、单调时钟与严格 UTC 日历校验也基本完整。

仍有两个 HIGH 问题：60 秒窗口以首轮 start time 起算会被慢采集提前“攒满”；测试注入口与切片表仍只描述两份快照，无法表达刚新增的三快照硬红。

## What's Good (Keep)

- args ① → authoritative ucomm+args+env → args ② 的 sandwich，以及两份 args 逐字相等要求，能阻止新增 argv token 被当成环境 suffix。
- tracker 以 start-order generation 防止旧轮晚到回写；失败/不完整轮清空候选，Bridge 重启从头计时，均保持保守。
- key 使用 comm.db realpath，避免仅用 project label 的碰撞；`2026-02-30`、墙钟跳变、并发乱序和重启均已列入测试。
- info diagnostic 名称和字段已固定；desktop/test-slot 等排除项不再被错误要求留在生产 homes/active。
- terminal process-only/lease-only 各自进入既有 reconciliation，未把 lease 单独提升成 liveness。

## Issues & Recommendations

1. **BLOCKING/HIGH — sustained-absence 把首次证据时间回溯到慢采集的开始时刻，可在没有 60 秒两次有效观测间隔时成熟。**

   **Why it matters:** §1.6.7 为每轮记录 start monotonic time，并用各轮 start time 差判断 60 秒。反例：generation 1 在 `t=0` 开始，因慢 comm/ps/lsof/lease 读取到 `t=70` 才首次完整提交“无 process/lease”；generation 2 随即在 `t=70` 开始并快速完成。按当前合同，start 差已达 70 秒，第二轮会输出 `comm_stale_running`，但系统直到 `t=70` 才获得第一份完整缺席证据，两份有效样本实际几乎相邻。这重新引入了“一次缺席快照即可豁免”的效果。

   **Suggested fix:** 首次满足时把 `firstConfirmedAt` 设为该完整轮成功提交时的单调时刻，而不是 round start。后续轮只有在其 **start time >= firstConfirmedAt + 60s** 且自身完整成功后才可成熟；较早开始但晚完成的轮仍 blocking。或者串行化该 collector，使第二轮只能在第一轮提交后开始，再按两次成功提交间隔计时。增加 hard-red：首轮耗时 >60 秒，紧接着第二轮完成仍必须 `comm_orphan`；从首轮成功提交后再满 60 秒的第三轮才允许 `comm_stale_running`。

2. **BLOCKING/HIGH — `processSnapshot` 测试 seam 和切片 12 仍是两快照形状，无法执行三快照合同及新增 hard-red。**

   **Why it matters:** §1.6.1 已要求 args ①、authoritative、args ②，但同项末尾仍写 `processSnapshot: { args: string, authoritative: string }`，切片 12 也仍写“两次 ps”。单一 `args` 字段不能表达 args ①是 args ②严格前缀的测试，因此计划声称的关键阴性无法通过约定的注入口落地。

   **Suggested fix:** 将 seam 固定为例如 `{ argsBefore: string, authoritative: string, argsAfter: string }`（或三个具名 provider），分别执行非空/大小/重复行校验；同步切片 12 为“三次 ps”。hard-red 必须经这个公开测试 seam 提供两份不同 args，而不是绕过 parser mock 内部函数。

3. **MEDIUM/LOW — SQLite 日历 round-trip 的字符串比较表述有一字符长度歧义。**

   **Why it matters:** 改写串是 `YYYY-MM-DDTHH:mm:ssZ`（20 字符），而 `toISOString()` 的“前 19 位”不含 `Z`。若按“前 19 位与改写串逐字相等”字面实现，所有合法 timestamp 都会失败；这会保守阻塞 readiness，但使功能不可达。

   **Suggested fix:** 写成精确表达式，例如 ```${parsed.toISOString().slice(0, 19)}Z === rewritten```，并保留合法闰日与非法 `2026-02-30` 两个向量。

## Verdict

CHANGES REQUESTED。矩阵、实验措辞和三快照算法主体已闭环；最终实现前仍需把 60 秒起点改为首个完整证据的提交时刻，并把测试 seam/切片表同步为三快照。按 Lead 的轮次上限，本文件为最终复审结论。
