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
  - v1→…→v8(全作废)→ **v9 current** https://fw-reports-a53de2.vercel.app/r/6f688a6d6bdde55f8b30fd3633d556c4/
  - v8(Annie v7):分阶段路线收敛 + 跳过 B(2 图:路线 + 过渡版形态)
  - v9(Annie v8):⭐ 重新编号 Phase 1=今天。3 个 Phase 各一张 Mermaid 架构图 + delta:P1 今天单机 / P2 自己多机(1005 核心,单 hub+多机无状态卫星容器+profile+sync,hub+DB 可拆云)/ P3 产品化(打包别人自部署=C 联邦)。明确「为什么跳过 B」(内部单租户不需要/对外硬隔离用 C)。第6节请 Annie 确认→写 PRD
- docs 已折进 v3-v8(research §3.2/§3.6a/§3.7(跳过B收敛);plan 顶部 v8 2 阶段收敛框 + §4B+§6)
- **技术**:mmdc 渲图配方=htmlLabels:false + useMaxWidth:false + puppeteer 指系统 Chrome;占位符模板+node 注入 SVG;overflow-x:auto 包图;**坑**:node 标签多 <br/> + 边标签会触发 mermaid v11 splitLineToFitWidth bug → node 标签压短、细节放 HTML 正文;边标签别含 `=`
备注: 仍 research、未 ship。**⭐ 下一步取决于 Annie 确认 v8 分阶段计划:她 OK + Lead 发话 → 写正式 PRD(不抢跑)**。
若继续 co-eval:攒齐一轮改 + 发新 HTML(先告知上版作废)。不 ship、不 fire gate。图 Mermaid→inline SVG 无外链(CSP 安全)。
