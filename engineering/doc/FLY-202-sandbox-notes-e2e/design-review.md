# FLY-202 QA 沙箱 fixture 笔记 — 设计评审记录
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: plan.md

---

## 结论

**APPROVED（effective `reviewVerdict`，Round 1）。** Reviewer 原始票同为 `APPROVED`；全部 findings 为 MEDIUM/LOW advisory，没有阻塞项，`settled` 为空。

| 字段 | 值 |
|---|---|
| execution | `cd41d8e7-9d88-45e1-9921-4f0e91b42485` |
| question id | `b4bc52e6-c0ec-4e02-91da-bdcd11258bed` |
| review request id | `005ed472-95c1-402a-a274-051ba2626de4` |
| reviewed commit | `cda9b1839149d1bad7e441fa85d58fcc34c82c1a` |
| reviewed plan blob | `ba34275cb1172f4e83df255b026943dac136553d` |
| advisory report receipt | `f52085d3-bed7-4e8a-ae83-d9b4fd592391` |

## 非阻塞 advisories

| findingKey | 严重度 | 摘要 |
|---|---|---|
| `committed-scope-guard-gaps` | MEDIUM | 最终 committed-scope 检查应同时捕获 rename 和白名单外修改，而不只筛 A/D。 |
| `base-sha-not-restart-durable` | MEDIUM | implement baseline 应进入 durable ledger pointer；tmp 文件在恢复执行时可能被覆盖。 |
| `overbroad-production-discord-claim` | MEDIUM | 当前 notes 的“不碰 production Discord channels”过宽；无 `--alerts` 时 production-default alert path 仍可能到生产告警频道。 |
| `v4-bsd-ls-portability` | LOW | 建议固定 `/bin/ls` + `LC_ALL=C` 并检查 ignored `doc/` 文件，避免 GNU/BSD 输出差异。 |
| `pr-body-overwrite-drops-linear-section` | LOW | 更新 PR body 时保留 Linear Issue section，并说明新旧 V 编号映射。 |
| `v9-github-eventual-consistency` | LOW | push 后读取 PR SHA 可做 3 次、每次 10 秒的有限重试，再判真正不一致。 |
| `design-review-record-stale` | LOW | 本文件已刷新为本轮 execution、commit、blob 与 review ids。 |

## 处理

- 按 Runner 合同，`APPROVED with advisories` 已通过硬门；以上 findings 已通过唯一报告通道发给 Lead。
- 不改已批准的 `plan.md`，避免在没有新 review 的情况下把当前 plan blob 替换成未审版本。
- `design-review-record-stale` 已在本文件解决；其余 advisories 作为 implement/QA 的审计上下文，由 Lead 决定是否开后续工作或在执行时收紧。
- `overbroad-production-discord-claim` 会在 founder HTML 中明确展示为已知非阻塞边界，不再把现有 notes 描述成“所有事实无保留地正确”。
