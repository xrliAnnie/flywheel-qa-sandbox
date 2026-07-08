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

Cursor: 7/8 — Annie 重定向已 fold,交互 HTML 已发,进 PR
Next: commit → push → PR → approve gate
备注: Annie 7-08 重定向——1005 = 横向扩展→上云(换大机 separate、不在 1005);三文档已重构;交互 co-eval HTML 已 publish-report 到频道 1524490063394770977 (https://fw-reports-a53de2.vercel.app/r/9bf9318112853429c776f9edb9d16f2f/,curl 验过 nonce+script+7 textarea)。仍 research、未 ship;主线待 Annie co-eval 后 Lead 收口
