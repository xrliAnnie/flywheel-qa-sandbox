# FLY-1005 多机部署 — progress ledger

Issue: FLY-1005 (https://linear.app/geoforge3d/issue/FLY-1005/多机部署-multi-machine-runner-分散到多台机器跑-research-prd)
日期: 2026-07-08
基于: 无

## Phase: design (research → PRD)

- [x] onboard + 读关联 issue (FLY-555 epic 全家 / 517 driver / 17 relay / 346 / 353 / 916 / homerail)
- [x] codebase 审计:3 个硬单机锚点 (loopback Bridge / 本地 SQLite StateStore / 本地 tmux+mailbox runner)
- [x] brainstorm gate 确认方向 (Lead 确认 3 点;主线待 Annie 拍)
- [x] exploration.md
- [x] research.md
- [x] plan.md (= PRD 草案)
- [x] codex design review (APPROVED, 3 轮;Round1 8 项 + Round2 4 项事实修正全采纳)
- [ ] PR + approve gate

Cursor: 8/8 — 停在 approve gate(段落终点),等 Annie co-eval/approve
状态: PR #512 (https://github.com/xrliAnnie/flywheel/pull/512) awaiting_review,questionId 65ac4c93-b486-4b02-8135-1cedc7f187f7
- Codex design review APPROVED (3 轮) + code review APPROVED (2 轮,gate 过 @ d6722a09)
- 交互 co-eval HTML 已发频道 1524490063394770977: https://fw-reports-a53de2.vercel.app/r/9bf9318112853429c776f9edb9d16f2f/ (curl 验过)
- commits: fe5d34e1 (初稿) + 825a063b (reframe→横向上云) + d6722a09 (修 review 残留)
备注: 仍 research、未 ship(ship founder-gated)。主线待 Annie co-eval 后 Lead 收口。
若收到 changes-requested wake → 改文档 + 重开 review + 重开 gate;若 verified approval → 才可 ship(:cool:)。loop 已停(撞 approve gate 硬停);gate wake 会重新唤醒。
