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
  - v1→v2→v3→v4(全作废)→ **v5 current** https://fw-reports-a53de2.vercel.app/r/294ac86d68fda0521de9430fb9f429ee/
  - v4(Annie v3 深挖):hub 容器+通信 / ⭐Hub+DB 一体vs分离(她直觉对)/ 多租户 3 模型 / warm=节点非session / spot / 联邦诚实推荐
  - v5(Annie v4 批注):多租户 A/B/C 对比图 / ⭐warm pool profile 分池(采纳)+ 答3问(预烤/站346沙箱/⭐状态sync+清理一等要求)/ 节点来源可选(云 OR 自己物理机,spot 消失=spot 特性非必然)/ 联邦对比图 + 双推荐(Runner 分层组合 + HL 先非联邦横扩、联邦=productization 后续)
- docs 已同步折进 v3+v4+v5(research §3.2 联邦双推荐 / §3.6a 节点来源可选 / §3.7 DB+多租户+profile池+346+状态sync清理;plan §4B(7)(7b) + §6 D0/D10/D11+sync+节点来源)
备注: 仍 research、未 ship。**最关键待 Annie 拍:联邦 vs 非联邦 主线(v5 第4节,Runner+HL 双推荐都在)**。
下轮 co-eval:攒齐一轮改 + 发一张新 HTML(先告诉 Lead 上版作废)。不 ship、不 fire gate。图全 CSS/内联无外链(CSP 安全)。
