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
  - v1→…→v9(全作废)→ **v10 current** https://fw-reports-a53de2.vercel.app/r/6ad8ff1a2bfcc336bf35cc36d0d7a8c2/
  - v9(Annie v8):3 个 Phase 各一 Mermaid 图 + delta(P1 今天单机/P2 自己多机 1005 核心/P3 产品化=C)+ 为什么跳过 B
  - v10(Annie 确认 3-Phase + 加 Phase 2.1):4 图(P1/P2/2.1新/P3)。⭐ **Phase 2.1 = 拆出高 churn 的 Flywheel hub**(4 次/天)从共享 hub 独立、跟稳定 team(Jolt 3D/Tidal Echo 1 次/天)分开,runner 仍分散 = **FLY-978 decouple-restart 多机延伸**;踏脚石 P2 共享 hub→2.1 先拆最高 churn→P3 每 team 一整套=C。精确「跳过 B」=内部共享 hub 是现状/可接受、B 特指对外多租户共享→对外必 C。第6节请 Annie 确认(含 2.1)→写 PRD
- docs 已折进 v3-v8(research §3.2/§3.6a/§3.7(跳过B收敛);plan 顶部 v8 2 阶段收敛框 + §4B+§6)
- **技术**:mmdc 渲图配方=htmlLabels:false + useMaxWidth:false + puppeteer 指系统 Chrome;占位符模板+node 注入 SVG;overflow-x:auto 包图;**坑**:node 标签多 <br/> + 边标签会触发 mermaid v11 splitLineToFitWidth bug → node 标签压短、细节放 HTML 正文;边标签别含 `=`
- **✅ 正式 PRD 已写 + 重写成详细版**(Annie 红线『太精简』→ 重写):engineering/doc/FLY-1005-multi-machine/prd.md(详细版 commit 20a2541e)。14 节 + 8 张 mermaid + v1-v10 全部 co-eval 细节 + 11 条 build-issue 每个写细 scope/验收/依赖(§14)。
  - 详细过目 HTML(current): https://fw-reports-a53de2.vercel.app/r/d5e344594c3d715ce7cbc9cf31f16b8e/ (7 SVG + 10 框;上版 dbe50814 精简版作废)
  - ⚠️ 教训:PRD 首版太精简被 Annie 打回——PRD 要最详细、eng 照着能建、把 co-eval 内容量全搬进去(feedback_design_must_be_eng_buildable_detail)
备注: 仍 research、未 ship、**未跑 codex、未 fire gate**。
**⭐ 下一步 = Lead QA + Annie 过目 PRD → 收敛后 ship 流程**:定稿 → **codex design review 先跑**(记住:先跑再冻再请批,别像 346/942 反复重批)→ 冻 head → fire approve gate → Lead cue Annie → Tadashi executor-merge。**绝不自 :cool:/merge、不自 fire gate**,等 Lead 发话。
