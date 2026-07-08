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
  - v1→…→v6(全作废)→ **v7 current** https://fw-reports-a53de2.vercel.app/r/97081a31a3e065beb81542c3f476f08f/
  - v6(Annie v5):图全改真 Mermaid inline SVG;多租户 a/b/c 真实 team 名 + 联邦 + sync sequence 图
  - v7(Annie v6 两问):① 托管/SaaS B vs C 决策图 —— 内部可信=B(便宜/隔离弱)、对外付费 SaaS=C(硬隔离);⭐ C=联邦=productization(FLY-648)、容器化=规模化 provision C 的手段;结论内部 B/对外 C。② 沙箱 vs container:要浏览器不必上 AIO,做瘦容器(浏览器+headless Chrome+终端、去 IDE/Jupyter)就够,接 profile 池『带浏览器 profile』=预登录 Chrome 瘦容器;要『容器(隔离)+浏览器(provision)』非整套 AIO。
- docs 已折进 v3-v7(research §3.2 联邦双推荐 / §3.6a 节点来源 / §3.7 DB+多租户(B理解+C跨team Discord+SaaS内部B对外C+C=联邦=productization)+profile mapping+沙箱vs container+瘦容器+sync 时序;plan §4B+§6)
- **技术**:mmdc 渲图配方=htmlLabels:false + useMaxWidth:false + puppeteer 指系统 Chrome;占位符模板 + node 注入 SVG(不读进上下文);overflow-x:auto 包图
备注: 仍 research、未 ship。**最关键待 Annie 拍:联邦 vs 非联邦 主线**。
下轮 co-eval:攒齐一轮改 + 发一张新 HTML(先告诉 Lead 上版作废)。不 ship、不 fire gate。图 Mermaid→inline SVG 无外链(CSP 安全)。
