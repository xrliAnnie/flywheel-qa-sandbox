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
  - v1→v2→v3→v4→v5(全作废)→ **v6 current** https://fw-reports-a53de2.vercel.app/r/ce2de378310d42091e53685d81735163/
  - v5(Annie v4):多租户/联邦 CSS 图 + profile 分池 + 节点来源可选 + 状态 sync/清理一等要求
  - v6(Annie v5):⭐ 图全改真 Mermaid→本地 mmdc 渲 inline SVG(htmlLabels:false→0 foreignObject/0 外链/CSP 安全)。5 张图:多租户 a/b/c(真实 team 名 Flywheel/GeoForge3D/Tidal echo)+ 联邦对比 + ⭐状态 sync sequence 图。核对 Annie B 理解(对)+ 答 C 跨 team Lead 走 Discord 共享层 + profile=mapping(lead→profiles,正交 B/C)+ 沙箱 vs container(346 对齐:载体=container 镜像非沙箱)+ sync 时序(session 不可原样复用、每次起前 sync)
- docs 已折进 v3-v6(research §3.2 联邦双推荐 / §3.6a 节点来源 / §3.7 DB+多租户(B理解+C跨team Discord)+profile mapping+沙箱vs container+sync 时序;plan §4B(7)(7b)+§6)
- **技术**:mmdc 渲图配方=htmlLabels:false + useMaxWidth:false + puppeteer 指系统 Chrome;占位符模板 + node 注入 SVG(不读进上下文);overflow-x:auto 包图
备注: 仍 research、未 ship。**最关键待 Annie 拍:联邦 vs 非联邦 主线(v6 第5节)**。
下轮 co-eval:攒齐一轮改 + 发一张新 HTML(先告诉 Lead 上版作废)。不 ship、不 fire gate。图 Mermaid→inline SVG 无外链(CSP 安全)。
