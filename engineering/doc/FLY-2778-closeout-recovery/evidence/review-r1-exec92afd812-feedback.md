# Design Review — plan.md (Round 1)

Date: 2026-09-27
Author: Codex
Status: APPROVED

## Summary

该计划能够沿现有 land operation、immutable target、两阶段 finalization、Lead 鉴权和持久告警机制实现，破坏性操作的身份、生命证据与恢复边界明确。结合源码及 Lead 已将前轮三项 advisory 升格为强制实现验收项的裁定，未发现需要修改计划的新设计缺陷。批准仅针对设计；FLY-2919 正式 provider、cohort 切换门、三项强制验收与真实隔离 ship 仍是实现及部署前置，不能由 implementation.md 中的测试记录替代。

审查目标：`engineering/doc/FLY-2778-closeout-recovery/plan.md`，blob `ab06ff9db83ddba71f4cf70f84b6a2c16a5da251`。源码基线为 `b894a920ddde4819c1a4f53703c59ec7be4736a4`；审查期间 HEAD 前进至 `04901b3e979f54a72b9341ed27a37ee5ce1197af`，提交差异仅为 `progress.md`，计划、指定上下文和相关源码未变。

## What's Good (Keep)

- **生命证据归属清楚。** §2、§3、§12 将来源凭证与 body verdict 分开，禁止窗口式 gone、普通 missing/no_group 或异常 fallback 授权删除；保留 provider 正式切换及在飞 bindingless cohort 归零门。当前 consumer contract、`lifecycle-closeout.ts:1342` 的接线及 `plugin.ts:8031` 的 composition root 提供了可落地的接入位置；本地尚无正式 `execution-body-liveness.ts`，因此部署门必须保留。
- **复用现有收尾顺序和 fencing。** `post-ship-finalization.ts:1446` 起实际执行 physical pass → worktree settlement → record pass；`land-intent-targets.ts:14` 的目标包含 generation、parent identity、sourceExecutionIds/sourceRunId。§3.3、§12 对过期重采、跨 run 身份、新 activation/TURN、真实 absent 和完成收据的约束与这些结构相容。
- **存量清理没有借机扩大权限。** §5 分开 MERGED held/partial、MERGED completed 残留、CLOSED 未合入三种权威；客户端 manifest 只限制选择范围。源码确有 completed reclose 的 `alreadyCompleted` 路径（`StateStore.ts:88516`），独立目录义务设计避免把 no-op 报成回收成功。
- **删除保护覆盖实际风险。** 任意 CWD 进程或 census 不明即拒绝、stock 全程 no-signal、non-force remove 且不删分支、ignored 嵌套仓库检查、新鲜远端 HEAD 保全，以及样本和取证保护均应保留。`WorktreeManager.ts:1926` 已有可扩展的持锁入口，默认分支仍会 reap；§5.2 要求所有后台 stock 路径持续携带 refuse context 是必要约束。
- **告警恢复采用真实投递证据。** `StateStore.ts:88283` 的 held/outbox 事务、`LeadAlertNotifier.ts:658` 的内部 replay option、`workflow-engine-dispatcher.ts:2155` 的 dispatcher 和 `lead-inbox-runtime.ts:723` 起的稳定 mailbox identity 均存在。§4 正确区分 attempt claim、queued、delivery 与模型已读，并要求验证远端成功但本地收据丢失窗口。
- **验收没有被静态检查替代。** 计划保留事故变异红绿、跨 run 真/假关系、真实 DAG ship、远端 archived、operation audit done、生产只读集合对照和阴性样本；§8 明确禁止全仓/全包测试并要求实施后重新发现相关测试。

## Issues & Recommendations

无新增设计 finding。前轮以下三项继续作为 **Lead 已裁定的强制实现验收项**，不重复计入本轮缺陷，也无需仅为重述它们改写冻结的 plan blob：

1. **`stock-reclose-window-teardown-signal`**：no-signal 必须覆盖 physical pass 的 tmux/cmux/window teardown，不能只断言 reaper 或 `process.kill` 未调用。`close-runner.ts:971` 存在 `killTmuxWindow`；存量模式须拒绝未经证明安全的窗口残留，并以 founder shell 阴性用例验证无 SIGHUP 等信号。该要求与 §5.2 的全 stock 路径 no-signal 相容。
2. **`never-started-branch-liveness-source-undefined`**：可信失败来源、closed launch、owner/spawn/restart、socket/lock 和必要的 execution-id census 必须由共同 provider 汇合，source assessor 不能自行授权 dead。`codex-pre-spawn-source.ts:191` 起仅评估来源，当前契约中的可选 never-started 分支不等于正式 provider 已交付；须保留 §3.2、§12 的未知拒绝、跨 run 完整链及实际 yield 验收。
3. **`apply-claim-scope-not-in-schema`**：目录回收必须使用真实的独立 scope/key、request 内容绑定与 CAS，不能仅在 receipt JSON 中加字段后复用无条件 upsert。当前 `StateStore.ts:33206` 的旧入口仍是 issue-closeout upsert，`claimApplyEffect` / `casApplyEffect` 位于 `33250` / `33314`，说明 §5.2 的扩展有明确落点；仍须验证并发、崩溃、同 request 内容冲突及不覆盖整单批准 epoch。

核验方式：只读检查根 `CLAUDE.md`、`packages/CLAUDE.md`、产品体验文档、四份指定上下文、计划及上述源码/相关测试定义；`packages/teamlead/CLAUDE.md` 和根 `README.md` 不存在。本地 Git 不含计划引用的两个外部分支历史对象（2919 `a84a07854`、2754 `3f89b8a76…`），未将其报告状态视为独立验证结果；以当前可读源码和计划明确的后继接口/部署门判断设计可行性。遵守设计阶段边界，未运行实现测试、build、lint、真实 ship、生产 dry-run/execute，未读取生产凭据或数据库；implementation.md 仅作上下文。本次仅写指定反馈文件，未改动计划或源码。

## Findings Count

critical=0, high=0, medium=0, low=0

## Verdict

APPROVED — ready to implement
