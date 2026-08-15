# Design Review — FLY-1716 plan.md (Round 7)

Date: 2026-08-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

r7 的大方向符合 founder 裁决：活动交付面已删除整套自研运行时泄压，`actionLookup` 及其 episode 消费者也没有遗留，B 的 pre-resume gate、`/clear` write-back、gen/lock/keyed-claim 主链仍可独立成立。当前还不能实施，原因是 native 实验不能稳定归因、override 删除风险被技术性低估、`current.json/seq` 在 rider 消失后已成孤儿复杂度，以及清理/验收口径与实际代码和历史证据不一致。

## What's Good (Keep)

- 保留 §0 的逐项 founder 原话与明确红线；active scope 中没有 GatePoller rider、pane classifier kind、alert kind、terminal-action primitive 或自动 `/compact`/`/clear` 注入。
- 保留 B 的三态 fail-closed resume gate、可证明 usage 上界、共享 authority lock、launch-generation fence 和 keyed `absent | pending | completed` claim；这些不依赖已删除的 Wave 2/3。
- `actionLookup` 从 hook schema、步骤和验收中删除是干净的；`cleared_external/cleared_degraded` 等概念只存在于明确标注为非交付的 Appendix A，没有活动态 dangling consumer。
- 保留 manual `/clear` 的 session-id write-back、adopt-inflight 与 local bootstrap。即使没有 auto-clear，这三项仍修复 founder 每次重启又回旧 zombie 的核心问题。
- 保留 §4 对 steady-state wall 风险的诚实披露，以及把 r6 外部泄压设计和六轮 review 作为 opt-in archive，而不是默认实现。
- C 已正确缩为 `FLYWHEEL_ALERT_ROUTING=1` 的生产核验，未把 flapping/ticketSink 加固偷带回本单。

## Issues & Recommendations

1. **[BLOCKER] E1–E4 还不能产生可归因、可推广的 native-config 结论。** E1 只灌到“约 78%”，不能证伪 80% 边界；E3 把 `autoCompactEnabled=true` 与 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 同时设置，且没有给出 window 的具体值。2.1.233 的内嵌 schema/default 表明 `autoCompactEnabled` 默认已为 true，而 window env 是 token-window override，并会优先于 setting；当前组合即使成功也无法说明是哪一项生效。服务端 reactive/context-collapse 路由又会让一次成功或失败受实验桶影响。建议把矩阵写成可执行协议：每 cell 使用 fresh isolated config/session、固定 binary/model/account/prefix/load；E1 跨过 80%（例如到 82%，或先 compact/wall）才判失败；E2 记录 `/autocompact` 前后的精确 settings diff；E3 至少拆成 discovered setting-only、window-env-only、必要时 combo，并钉死每个 window token 值；E4 对 1M 做 control + winning config。成功必须是无手动 `/compact`、无 prompt-too-long/reactive 先行、transcript compact boundary/summary 与 ctx drop 同时可见，并至少 fresh-session 重复两次；同时给 1M 灌入设成本/时间/停止上限。若得到 winner，先把精确 key/value、workspace-vs-global scope、版本绑定、发布/回滚与 launcher 测试写回计划再采纳，不能让 Runner 从一次黑盒实验直接把未审过的配置推广到全 fleet。

2. **[HIGH] `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 不是“无行为的死开关”，删除风险必须按证据重写。** research §2.1 已证明它被消费，并在 threshold enforcement 生效的路径上进一步降低阈值；不保证 threshold worker 执行，不等于变量从不改变行为。删除符合 founder 裁决，但可能让原本处于 `enforced=true` 的健康会话更晚 compact，尤其在 native replacement 未找到时扩大 steady-state 暴露面。把 §3.1/风险表中的“删除仅去掉假安全感”改为“移除一个条件有效但不可作为保证的 test override”；生产删除应发生在矩阵留证后，并记录 winner 同步替代或 no-winner 风险接受、部署前后真实 child env、版本号和明确 revert 条件。§4 也应写明 no-winner 时风险可能比当前条件性 70% 行为更高，而不仅是维持现状。

3. **[HIGH] `current.json + seq + high-water scan + pointer repair` 在 Wave 3 删除后已经是 orphaned machinery。** active §2.2 的 launcher 只以 session-id 文件和 gate receipt 做决策，并没有读取 clear receipt pointer；运维也可直接查看不可覆盖的 keyed receipts、session-id `.history` 和当前 session-id。keyed claim 本身已经足够保证 `(gen,newSessionId)` replay idempotency，B→C→replay B 不需要全目录 seq、第二份 pointer 或 repair 状态机。按“删的比加的多”，建议删除 `current.json`、seq 分配/全目录解析、pointer repair 及其 fault-injection/high-water tests；completed replay 变成纯 no-op，pending 仍为 audit-only。若坚持保留，必须先定义一个真实 launcher authority decision 及失败语义，而不是仅写“供 launcher/运维查最新”；那会扩大 B scope，当前没有必要。

4. **[MEDIUM] 删除面和验收仍有三个具体不一致。** 第一，除了 `claude-lead.sh` 的 export/log/child env 与 shell golden，`packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:407` 还把该变量列在“Claude-pane mirror”正向 allowlist 中；删除 Claude pane 变量后这里也应删除并更新对应 runtime tests，否则留下 orphan contract。第二，V5 的“全仓零残留”不可能成立：本计划、research、historical GEO-285/FLY-31 文档和 `codex-review/` 必须保留该字符串作为证据；守卫应精确为 active executable/config/test surface 零传播，并显式排除 archival docs。第三，V1 要求的“adopt receipt”当前不存在：`_adopt_inflight_before_launch` 只有 stdout launcher log 和 CommDB mutation，`lead-body-receipt.sh` 也不记录 adoption。不要为验收再造 receipt；改为断言 fork 前 CLI 恰好调用一次，并以 launcher log + `LEASED→QUEUED`/`lease_retry_count` 的 CommDB 后置状态留证，复用 FLY-1708 已有合同。

## Verdict

CHANGES REQUESTED — address items above
