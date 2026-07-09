# FLY-1020 progress ledger

Phase: plan (PRD Codex-APPROVED + 终审卡已发 · 待 Annie 终审)
Cursor: 终审/1 (终审 HTML published, awaiting Annie sign-off)

## Chunks
- [done] onboard + 核码 + homerail grounding
- [done] co-eval v1→v6(6 轮),v6 Annie 拍板(三层设计;UI 拆出 FLY-1038)
- [done] 非 UI 详细 PRD:engineering/doc/FLY-1020-workflow-templates/prd.md
- [done] Codex design-review R1(10)→R2(5)→R3 **APPROVED**;3 条非阻塞注记折入;证据存档 codex-review-r1/r2/r3.md
- [done] **PRD 冻结 head f6f39c6e**(其后所有 commit 均未动 prd.md,已 git diff 核实)
- [done] Lead QA PRD 过
- [done] 终审 HTML(结论版,照 353 c5f664d6 风格)commit d6b45ac1 + publish + curl 自验
- [wait] Lead QA 终审卡 → relay Annie 终审(§2 MVP 收敛需她拍板)
- [next] Annie OK → 按 §13 九步拆 build issue 交 Tadashi

## Publish artifacts
- 终审卡 (current): https://fw-reports-a53de2.vercel.app/r/41631d6833489c7238eaa3d9beee4b8f/ · msg 1524657811064361041
- v6 co-eval 设计卡(设计阶段已完成,历史): .../bdcfb9ead0683e0c75c05cf6a0554443/

## ⭐ 需 Annie 拍板的一条(终审卡 §2)
MVP 只做内建 design/implement/qa;任意节点类型(创作视频 Research/生成视频)挪阶段 2。
理由:三角色硬编码在 持久化/展示/ship收尾/retry/重启对账 五个生产面。
**不是砍功能,是排期** —— 三层设计 + 注册表 seam 原样保留。

## Codex 逼出的实质修正(全部独立核过源码)
auto-QA 是 default-ON opt-out(非 opt-in,被 types.ts:616 stale 注释误导)· **ship-gate 死锁**(qa_required 索要 auto_qa_record,三段式只写 three_stage_verdict)· product skip-QA 搭不上 main-only 的 onMainAwaitingReview · snapshot 须物化(+workflow_run_id)· loop 须含 founder_feedback_kickback · MVP 收敛 · build 顺序:ship-gate 证据契约先于 orchestrator · workflow_qa_passed 的 head 服务端校验、不信 runner 自报

## Notes
- 遵 Lead steering:不 ship、gate 别碰。PR #514 = doc 载体不 merge。Annie 睡了不急。

## §2 深挖轮(agent.md vs DAG)— Annie 要求先论证清楚再回 PRD
- [done] **firsthand clone homerail 读真码**(github.com/xiaotianfotos/homerail,333 ts 文件)
  - 结论与预期相反:**它处理了 DAG vs agent 定义,而且就是分层**
  - DAG 模板三块:runtime_profiles(agent→model_alias+agent_type)/ agents(内嵌 system 角色提示词)/ nodes(节点按名 `agent: drafter` 引用 agent)
  - worker/src/index.ts:`systemPrompt = agentConfig.system` → **worker 只拿自己 agent,拿不到 DAG**(实锤「DAG 永不甩给模型」)
  - createWorkerContainer:一 node 一容器 → **防 bias = 结构隔离**
  - profile:reviewer=kimi-main/kimi_code,default=local-qwen/claude-sdk → **实锤「多 model」理由**
  - ⚠️ 不该抄:agent 定义内嵌进每个 DAG,**agents 数==nodes 数(1/1、5/5、2/2)零复用**;全 repo 无独立可复用 agent.md 等价物 → 我们独立 agent.md 更好
- [done] 我们自己的码:readAgentFile 当纯文本读+40k 截断;**全仓零 frontmatter 解析** → agent.md 的 model/skills/permissionMode 全 inert
  → 推论:**「agent.md 管 WHO / 别层管模型+能力」不是提案,是代码现状**;且用户 agent.md **物理上无法自授 can_ship/can_land/creates_pr/选模型** = 通用节点天然安全
- [done] co-eval HTML `agentmd-vs-dag.html`(10 节)commit 6c72d4be + publish + curl 自验
  - URL: https://fw-reports-a53de2.vercel.app/r/a5141aed5695504a3203f3b77538c2cf/ · msg 1524663718905122916
- [wait] Lead QA → relay Annie → 她 confirm 分层 → Lead 给 fold 指令
- [next] fold 进 PRD(加「DAG↔agent.md 对齐」节 + MVP 加通用节点)→ 出**一个大 epic** 交 Tadashi(按 Annie §11:一个大 PRD + 一个 epic,他自己拆)

## 约束状态
- prd.md 仍冻结在 f6f39c6e(每次 commit 后 git diff 核过)· 未写 PRD · 未拆 build · 未 ship · 未碰 gate
