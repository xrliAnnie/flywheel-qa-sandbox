# Design Review — plan.md (Round 6)

Date: 2026-07-10
Author: Codex
Status: APPROVED

## Summary

R6 已完整关闭 Round 5 的 restart-feasibility blocker：pending landing 现在是自足、版本化、按 stage 判别的 durable envelope，并有 fail-closed startup 与真正 cold-start 的回归证明。结合此前五轮已收敛的进程状态机、shutdown/收尸、context ack、BrainPort 安全边界及跨分支完成门，计划已具备实现所需的可行性、完整性和失败语义，可以进入实施。

## What's Good (Keep)

- `plan.md:223-249` 现在明确持久化 `version + issueId + sessionId + outcome + stage`；这正面覆盖了 summary 已在服务端提交、但 client 超时且 success receipt 尚未写出的恢复窗口。
- stage 使用判别联合：summary 持有 marker、transcript 持有 chunkIndex + marker、close 持有 closeTarget，使 reconciliation 所需字段与 mutation 类型绑定，而不是依赖一组可产生非法组合的 optional 字段。
- startup 对未知 version 或缺字段采取“保留 pending、fail-loud、绝不发 Linear mutation”，符合项目的 fail-closed/fail-visible 文化，也避免损坏状态触发重复写。
- cold-start 测试具有正确的证伪能力：清空内存 Session、移除 summary receipt，只允许 scanner 使用 pending envelope + journal/config；它必须定位正确 issue、查询 marker、继续后续 stages 且不重复 summary（`plan.md:244-249`）。
- 当前 voice-bridge resolver 明确只允许一个 huddle project（FLY-1006 `config.ts:83-97`），因此当前 envelope 的 `issueId` 配合启动 config 足以恢复 scoped Linear client；计划也为未来多项目明确保留持久化 project binding 的升级点。
- R4 的三类 unknown mutation 仍全部覆盖：summary/每个 transcript chunk 走分页 marker 查询，close 走 status read-back；确认已落后跳过到下一 stage，不 blind retry。
- 新的 comments-list/status read seams、AbortSignal、late-result fence、durable receipt/TIV 规则与 545/1006 接线 PR 边界保持一致；Phase A 默认 OFF 和 byte-compat 不受影响。
- 先前已审定的 resident turn 状态机、interrupt barrier、无自动 replay、terminal-result context ack、背压/wedge 分离、两阶段 shutdown、同步 forceKillAll、/glaw AUDIO 耳朵与 /eleven exactly-once finalizer 均未被本轮修改破坏。

## Issues & Recommendations

1. **[NON-BLOCKING] 修正文案中的 stage 字段名。** `plan.md:231-233` 的判别联合正确写为 `close:{closeTarget}`，但紧接着的括号写成“无 marker 的 close……不是合法状态”。close 不需要 comment marker；这里应改为“无 `closeTarget` 的 close / 无 `chunkIndex` 的 transcript 不是合法状态”，避免实现者误读。类型合同本身已清楚，因此不阻塞实施。

## Verdict

APPROVED — ready to implement
