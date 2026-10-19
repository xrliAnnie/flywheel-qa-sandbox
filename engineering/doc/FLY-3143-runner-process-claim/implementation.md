# FLY-3143 Runner 进程认领：沙箱核验与交接 — 实现记录
Issue: FLY-3143 (https://linear.app/geoforge3d/issue/FLY-3143/急起体-1238-pdt-起-runner-起体-原会话续跑的进程认领时好时坏claude-全部失败codex-也有失败process)
日期: 2026-10-01
基于: plan.md

## 1. 候选头核验

命令：`sh engineering/doc/FLY-3143-runner-process-claim/verify-candidate.sh candidate`

退出码：`0`

```text
candidate_head=d7d72733b101472bd82236b558906f9c90d0e4d4
PASS C1 candidate source tree is clean at the pinned head
PASS C2 approved plan text at the head is blob 5e27094f7a3ad0573b52e1d92f8e361525b3dafd
PASS C3 R3-reviewed plan blob 0dbf0ea588adf1fe891f0e08078b27d71a32f9e8 exists in history
PASS B1 head is built on the revert of FLY-2919 + FLY-3123
PASS B2 restore commit equals original FLY-2919 except the FLY-3123 fixture
PASS Q1 workflow body-death replay index
PASS Q2 session body-death replay index
PASS Q3 lead inbox expression index
PASS R1 owner barrier column
PASS R2 barrier row reads as unknown
PASS R3 old-owner reconciler module
PASS D1 bind window stays 30s
PASS D2 owner diagnostic projection
PASS D3 resume attempt diagnostic column
PASS D4.invalid_input closed bind reason
PASS D4.host_boot_mismatch closed bind reason
PASS D4.expected_leader_mismatch closed bind reason
PASS D4.process_group_empty closed bind reason
PASS D4.process_group_too_large closed bind reason
PASS D4.worker_unreadable closed bind reason
PASS D4.worker_executable_mismatch closed bind reason
PASS D4.worker_cwd_mismatch closed bind reason
PASS D4.candidate_missing closed bind reason
PASS D4.candidate_ambiguous closed bind reason
PASS D4.probe_timeout closed bind reason
PASS D4.probe_command_failed closed bind reason
PASS D4.probe_output_limit closed bind reason
PASS D4.snapshot_unstable closed bind reason
PASS D4.writers_incomplete closed bind reason
PASS D4.nonce_writer_missing closed bind reason
PASS D4.daemon_absent closed bind reason
PASS D4.daemon_unknown closed bind reason
PASS D4.cancelled closed bind reason
PASS E1 typed pending-spawn absence proof
PASS E2 typed recovery cause
PASS E3 pre-auth rejection keeps its code
PASS S1a resume takeover revives a stale failed label
PASS S1b non-revivable failed label refuses the resume before any write
PASS S1c rework delivery asks the body truth before returning a failed actor
PASS S1d holder wake revives a failed label only when alive
PASS S2 parked body without binding can be proved gone
PASS S3a resident hold refusal is typed
PASS S3b refused adoption is released, not failed
PASS S3c refused adoption is recorded with its reason
PASS T1 query-plan regression test
PASS T2 revert-gap reconciliation test
SUMMARY total=46 fail=0 unverifiable=0
VERDICT PASS
```

## 2. 当前 implement 体认领

命令：`sh engineering/doc/FLY-3143-runner-process-claim/verify-candidate.sh body "$FLYWHEEL_EXEC_ID"`

退出码：`0`

```text
execution=99face57-6b83-44e9-9b33-d5e3e7b527c0
accepted=yes
generation_consistent=no_body
resume_current_state=none
resume_current_attempt_id=none
resume_current_generation=none
session_status=running
adapter=codex-tmux
last_error=empty
owner_generation=1
spawn_epoch=1
binding_spawn_epoch=1
spawn_inflight=0
close_requested=0
reconcile_required=0
bind_attempts=1
bind_last_stage=nonce
bind_last_reason=none
bind_elapsed_ms=988
bind_os_ms=979
bind_schedule_lag_ms=4
executable_observed=codex
body_state=none
body_generation=none
PASS BODY current spawn of this body was claimed (strict binding accepted)
SUMMARY total=1 fail=0 unverifiable=0
VERDICT PASS
```

## 3. 当前 implement 体原会话拉回

命令：`sh engineering/doc/FLY-3143-runner-process-claim/verify-candidate.sh resume "$FLYWHEEL_EXEC_ID"`

退出码：`4`（NOT_RUN）

```text
execution=99face57-6b83-44e9-9b33-d5e3e7b527c0
accepted=yes
generation_consistent=no_body
resume_current_state=none
resume_current_attempt_id=none
resume_current_generation=none
session_status=running
adapter=codex-tmux
last_error=empty
owner_generation=1
spawn_epoch=1
binding_spawn_epoch=1
spawn_inflight=0
close_requested=0
reconcile_required=0
bind_attempts=1
bind_last_stage=nonce
bind_last_reason=none
bind_elapsed_ms=988
bind_os_ms=979
bind_schedule_lag_ms=4
executable_observed=codex
body_state=none
body_generation=none
NOT_RUN: no original-session resume attempt exists for this body's current generation
```

本体是新起体，本代没有发生原会话拉回；按 plan §4，exit 4 只记录 NOT_RUN，不算通过，也不算失败。

## 4. 未执行

| 编号 | 项 | 本节点结果 | 原因 / 归属 |
|---|---|---|---|
| A5 | 原会话拉回成功 | NOT_RUN | 当前 implement 体本代没有拉回尝试；后续若真被拉回，由该体活着时重跑 `body` 与 `resume` |
| B1 | 被标 failed 后恢复（验收补充 2） | NOT_RUN | 沙箱节点无权把体标 failed |
| B2 | 启动对账遇 activation_mismatch 不杀活体（验收补充 3） | NOT_RUN | 需要重启 Bridge，超出本节点权限 |
| B3 | plan §10 其余真机矩阵（Claude 新起 ≥2、同体连续拉回 ≥3、Codex 冷启动 ≥10、近生产负载、例行重启接管、socket 复用、quota pre-auth 原因） | NOT_RUN | 归持有本测试房的生产 QA |
| B4 | 529 e2e flow | NOT_RUN | 本 implement 节点只完成沙箱合同中的候选头与当前体核验；是否计入 529 由 Lead 与 QA 判定 |

本记录只覆盖沙箱核验合同，不是 FLY-3143 plan §10 的真机验收。
