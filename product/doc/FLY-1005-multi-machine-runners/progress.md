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

Cursor: co-eval 迭代中(v3 已发)— park 等 Annie 逐节批注
状态: PR #512 (https://github.com/xrliAnnie/flywheel/pull/512) = **draft**(research 挂着,不 ship、不 fire gate)
- Codex design(3 轮)+ code(2 轮)APPROVED;旧 ship gate 65ac4c93 已被 Annie changes-requested、任其 stale(Lead 定:research 不 fire ship gate)
- **纠正记录**:research docs-only 不该 fire approve_to_ship / 不该触发 QA(FLY-1011);以后 research 只到 Codex design/code review
- co-eval HTML 迭代(一个 current 链接,旧版作废):
  - v1 9bf93181 → v2 c26e11a2 → v3 d19f816d →(全作废)→ **v4 current** https://fw-reports-a53de2.vercel.app/r/ea3369886024684131b87fc46979151e/
  - v3:加 3 图 + 讲细阶段/节点池 + secrets 降级 + D2 物理机 + D9 成本
  - v4(Annie v3 批注深挖):hub 容器+通信 / ⭐Hub+DB 一体vs分离(她直觉对,单写者不变≠共识坑)/ ⭐多租户 3 模型 / warm pool=warm 节点非 session / spot 消失+兜底 / ⭐联邦vs非联邦优劣+诚实推荐(分层:team 内非联邦弹性、跨 team 联邦隔离)
- docs(exploration/research/plan)已同步折进 v3+v4 实质改动(research §3.2 联邦推荐 / §3.7 DB+多租户+warm pool;plan §6 D0/D10/D11)
备注: 仍 research、未 ship。**最关键待 Annie 拍:联邦 vs 非联邦 主线(v4 第6节,已给分层推荐)**;Lead 会加她的推荐。
下轮 co-eval:攒齐一轮改 + 发一张新 HTML(先告诉 Lead 上版作废)。不 ship、不 fire gate。
