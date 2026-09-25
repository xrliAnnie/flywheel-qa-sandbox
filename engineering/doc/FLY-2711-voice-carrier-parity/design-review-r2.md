# Design Review — plan.md (Round 2)
Date: 2026-09-24
Author: Codex
Status: APPROVED

## Summary

v2 已关闭 Round 1 的六项反馈，无剩余阻断项。可以按计划进入实现；本结论不代表插件实现、真实锁测试或 slot QA 已通过。

本轮完整重读计划，检查 v1→v2 差异，并沿六项修订核对相关源码。评审 HEAD 为 `238d8029016ee45a926d9699b136e23abbf77d3f`，计划 blob 为 `cacf088d4b06dd3c7602584b7e4934a648be0b4c`。本轮 packages/scripts 零变更，工作树干净，`git diff --check` exit 0。

证据以 `[verified by reading code]` 为主。Bun 1.3.11/darwin 的跨进程 EAGAIN、close/SIGKILL 后释放锁采用用户提供的执行证据；本轮独立核对了本机 SDK 的 `O_EXLOCK=0x20` 及系统语义，没有重跑会写文件的锁测试，也没有执行部署、生产探针或故障注入。唯一写入为本反馈文件。

## What's Good (Keep)

| Round 1 项目 | Round 2 核验与结论 |
|---|---|
| #1 启动期 probe 毒化身份 | **关闭。** `plan.md:47,58,68` 明确只在 botId 已固定后检测漂移；F1-T5 覆盖 user 已存在、首次 ready 尚未来到时的探针，以及随后恢复正常 intake。原反例不再成立。 |
| #2 回收/close 删除活 socket | **关闭。** `plan.md:76,82–88` 使用永久保留的同一锁文件，取得锁后才清理和发布，整个 bound 生命周期持锁；删除公共/私有名及 server.close 均先于释放锁。新主人无法进入旧主人的删除窗口。真实 darwin 竞争、崩溃回收和交接测试已登记。 |
| #3 Q3/Q4/Q7 不可执行 | **关闭。** `plan.md:138–142` 改用 slot 输入调用导出的 runPreflight，保留真实依赖并复用收据比较 runtimeId；Q4 明确 founder presence、同 sessionId 有界等待 live。`test-deploy.sh:2514–2532` 确有所用 room-info 字段，`fly2598-voice-preflight.mjs:136–147` 有 import 守卫；live 条件与 `voice-codex/src/daemon.ts:600–627` 一致。 |
| #4 resume QA 假绿 | **关闭。** `plan.md:63,70,141` 将目标 messageId 的实际放行事件严格夹在 reconnecting 与 resume 之间，并在发消息前等待旧连接 CLOSE_WAIT。旧连接缓冲消息无法再满足该事件顺序；未触发指定窗口必须 HARNESS INVALID。 |
| #5 上游合同不一致 | **关闭。** `plan.md:59,114` 补充身份漂移例外，并以 M3a 明确登记旧合同及 plan 的修订落点。这里确认的是实施要求已完整列入，未将尚待修改的上游文件说成已经更新。 |
| #6 上线触发路径遗漏 | **关闭。** `plan.md:152` 列明 Lead 自然重生也会 checker→updater→recheck，并将窗口协调和冻结提前到 merge 前，与 `claude-lead.sh:1129–1139` 一致。 |

内核锁解决的是遵守本协议的插件实例之间的互斥；这符合本单既有边界。生产 0.0.7 没有该 socket，未上线的 PR #28 不构成本次必须支持的无锁旧 owner。Apple 的 open/flock 文档也支持 O_EXLOCK 原子取排他锁及协作进程互斥的判断。[open(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html)、[flock(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html)

保留同 guard 的入站/探针分离、非 darwin 不开放探针、0.0.8 bump、黄金向量及 fork merge 前完成隔离 QA 的安排。Linux 假锁测试与 darwin 真锁测试的证据边界已写清；不需要重新打开 FLY-2712 或扩大主仓生产代码范围。

## Issues & Recommendations

无 BLOCKER/HIGH。以下两项是实现时补齐的细节，不要求再开设计轮次。

1. **LOW — Q3 调用时显式补全目标参数。**

   **证据与影响：** `plan.md:138` 已给出正确的配置、env 和代码来源；`scripts/qa/fly2598-voice-preflight.mjs:38–44` 还依赖 `input.projectName` 与 `input.leadId`。遗漏会返回 project_not_unique/lead_not_unique，导致验收脚本无效。

   **建议：** 落地脚本显式传 `projectName: room.projectName`、`leadId: room.agentId`，与已校验的 slot topology 一致。这两个坐标已有权威来源，不需要新接口。

2. **LOW — 新诊断行直接附带进程身份。**

   **证据与影响：** `plan.md:70,141` 要求同一 adapter pid 的有序证据；现有插件 `gateway-health-files.ts:43–59` 只加时间戳，不自动附 PID。仅凭 seq，跨重生或并存 adapter 的日志需要额外关联。

   **建议：** 在 lifecycle 与 admitted 两类行统一附 `pid` 或进程 runtimeId，QA 按同一身份筛选后再比较 seq。这样直接兑现计划已有的“同一进程”要求，仍保持无正文、无 token 和有界日志。

## Verdict

APPROVED

Round 1 六项均已关闭。后续按 v2 完成两仓实现、真实 darwin 锁测试、slot Q1–Q7 和代码复审，再进入既定合入及受管上线流程。
