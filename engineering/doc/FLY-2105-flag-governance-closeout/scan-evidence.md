# FLY-2105 Flag 治理关门 — 退役扫描证据
Issue: FLY-2105 (https://linear.app/geoforge3d/issue/FLY-2105/flagd关门-ci-守卫改判据env-configyaml-出现任何-flag-值即红legacy-unmanaged-baseline)
日期: 2026-08-30
基于: red-green-evidence.md

## 真实触发

对 production loopback Bridge 的 auth-required `POST /api/flag-scan/run` 发送 `{}`，没有使用
`dryRun`。第一次与修复配置后的重试都返回 HTTP 200：

```json
{"status":"pending","runId":3}
```

这不是新建重复批次；scanner 恢复同一条 durable pending run：

| 字段 | 值 |
| --- | --- |
| run id | `3` |
| run token | `2026-08-30-7cad63274959edd4` |
| candidate count | `4` |
| indeterminate / no-clock count | `6` |
| durable status | `committed`（Discord 已送达；等 Lead mailbox handoff ACK 后转 `published`） |

## 候选与 no-clock

本轮没有伪造“0 候选”。真实候选是：

- `flag_retirement_scan` — candidate，当前值 `true`
- `skill_framework_mode` — orphan candidate，当前值 `"split"`
- `workflow_rework_reentry` — candidate，当前值 `true`
- `workflow_turn_divergence_alerts` — orphan candidate，当前值 `false`

另有六条 no-clock：`doc_flow`、`pipeline_dag`、`pipeline_work_kind`、`proofshot`、
`skill_framework_split_participation`、`xiaohongshu_learning`。它们没有混入 founder 候选，已通过
durable `flag_scan_no_clock` handoff 交给 `flywheel-eng-lead`。

这些是 registry flag 的退役候选，与本单 CI 守卫检查的 raw env/config 残留是两套判据。分支上的
source/config scanner 已证明没有 `FLYWHEEL_X` mutation 读点或 tracked `config.yaml` flag key 残留；
对应 RED/GREEN 见 `red-green-evidence.md`。

## `#flywheel-notification` 回读

首次 delivery fail-closed：Engineering Lead 的 `access.json` 已允许 infra sender bot，但缺少
`groups[1521630422918758472]`。Lead 按配置所有权边界补齐该 group（关联既有 FLY-2176 缺口），
runner 未修改 Lead 通道配置，也没有绕过守卫直接发帖。重触发同一 run 后，durable Discord evidence
记录：

| 字段 | 值 |
| --- | --- |
| channel | `#flywheel-notification` (`1521630422918758472`) |
| sender | `claw-infra-bot` (`1524829037825101975`) |
| preflight | succeeded |
| root message id | `1543690293814239324` |
| thread id | `1543690293814239324` |
| handoff message id | `1543690297924517978` |
| report URL | https://fw-reports-a53de2.vercel.app/r/a2e504829acd1083e3f1054300bd821f/ |

Discord API read-back returned the exact run marker in the root body：

```text
flag 周扫描 · 4 个候选
flywheel:flag-governance run=2026-08-30-7cad63274959edd4
```

因此 user-visible notification leg 已有真实远端证据；`pending` 只表示同一 root 的 Lead mailbox
handoff 尚待 ACK，不表示 Discord 未送达。
