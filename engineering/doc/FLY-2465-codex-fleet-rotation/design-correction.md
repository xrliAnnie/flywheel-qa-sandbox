# FLY-2465 quota 开关启动边界 — 设计更正
Issue: FLY-2465 (https://linear.app/geoforge3d/issue/FLY-2465)
日期: 2026-09-09
基于: plan.md

Lead 裁定来源：question `7cab4237-dddd-4a68-9eb8-824921684e6a`，
针对 review `604cdfd1-878d-4f9a-9506-80729cca1c1c` 的两个 HIGH。
原已批准 plan.md 保持原字节；本更正优先于其中 OFF 保留启动暂停栅栏的文字。

- Abolished concept: **OFF retains pause fence**。
- Retained organs: **pause facts / audit / switch-audit.jsonl**。
- OFF：quota 完全退出每条启动准入及物理启动路径，包含已经排队的 engine
  启动和用户请求。已有排队启动在下一次 dispatcher pass 继续；这是取消
  生效中的启动栅栏，不是主动恢复已死亡体。事故/暂停事实不删改，重新开启
  时继续依据这些事实执行暂停/恢复策略。
- ON：有意的 typed `quota_launch_paused` 拒绝继续 fail-closed；新执行尚无
  binding 不能绕过 root 暂停。基础设施、迁移及绑定故障继续 fail-open，
  rotation disabled，保留 structured code/cause 和按主机限流告警。
- 不开启额外的死亡体扫描或恢复；已有 quota casualty 的自动换体守卫保留。

## Lead 原文

> RULING: both HIGHs are valid and in scope (they are regressions of my own rework). AUTHORIZED: one more bounded TDD cycle fixing exactly H1+H2, then ONE ordinary push at milestone-last, fresh exact-head review, CI 14/14. OFF SEMANTICS (supersedes plan text "OFF retains pause"; record it in design-correction.md with abolished concept = "OFF retains pause fence", retained organs = pause facts/audit/switch-audit.jsonl, quote = this ruling): OFF means the quota system is OUT of the launch path entirely - no admission fence, no pause fence, for every launch whether engine-queued or user-requested; launches already queued behind the pause proceed on the next dispatcher pass (that is fence bypass applying to them, not a proactive restart); pause/incident facts are preserved as data so re-enable resumes from them; bodies that already died are NOT auto-restarted. ON semantics: a deliberate typed quota_launch_paused refusal is honored fail-CLOSED (that is the feature; no blind retry, isExecutionPaused respected for fresh executions too); only infrastructure/migration/bind errors (runtime construction, credential truth missing) fail-OPEN with rotation disabled + structured reason. Red/green: (H1) ON + typed pause -> launch refused, no retry; (H1b) ON + bind error -> legacy launch; (H2) OFF + persisted root pause + queued launch -> launch proceeds next pass, pause row untouched. STOP RULE: if the fresh review raises another HIGH of the same origin, stop and report to me instead of a third cycle. Review running => no push. Goal ACTIVE.

## H2 scoped-origin reservation dependency

Lead question `f63ad162-39a7-44ea-964a-f12631b08d1f` authorizes preserving the
server-stored freshStart actor solely for authenticated master replay of an
existing waiting/resuming legacy reservation with matching authority and reason.
All remaining normalized fields retain the frozen digest comparison; changed
reason or arbitrary changed requests remain HTTP 409. This closes the scoped
origin queue path required by H2 without changing actor semantics or schema.

> RULING: AUTHORIZED under H2, exactly as proposed and no wider: for an AUTHENTICATED master replay of an existing waiting/resuming legacy reservation only, retain the server-stored freshStart actor when authority and reason match; every other normalized field still compares against the frozen digest and any arbitrary change still 409s. Required tests: scoped->master replay releases under OFF; negative changed-reason -> 409; existing digest tests unchanged. Rationale: without it H2 (every queued launch proceeds under OFF) is false for scoped-origin reservations. If the fix needs anything beyond that (schema, new actor semantics), stop and keep it advisory instead. Still ONE push at milestone-last, fresh review, CI 14/14, no third cycle.
