# FLY-1402 规则内容审计 — 17 份 base rules 首次全域生效前置检查

Issue: FLY-1402 (https://linear.app/geoforge3d/issue/FLY-1402/p1装载链-lead-rules-bundle-全-fleet-静默失效-cli-append-system-prompt-file-为)
日期: 2026-07-21
基于: exploration.md(装载链审计)+ 本次独立通读

> 来源:Tadashi scope 增补 A(lead-instruction ba48aae2)。背景认知:本单不是普通 bugfix,是**「17 份从未生效过的规则首次全域同时上线」**——这些规则是在「以为已生效」假设下写/改了几个月的,没有一条经历过真实约束检验。本审计随 ship gate 呈 founder。
> 通读范围:`lead-rules-base/` 全部 17 份行为规则(README 除外)+ launcher 侧 2 份(inbox-ack-rule、screencapture-l3-skill)+ identity 样本 2 份(Tadashi `flywheel-eng-lead`、Cass `flywheel-cos-lead`)。
> **本审计只出报告不改规则文件**(FLY-1402 代码 scope 是装载链);每条处置建议由 Tadashi/founder 裁决后拆 follow-up。

## 0. 置顶发现

### 0.1 🔴 Belle 的 companion-safety-contract 从未进上下文(本 bug 安全等级最高一条)
companion 臂追加顺序:companion-safety-contract → founder-local-time → cross-dept → **discord-reply-contract(末位,唯一生效)**。即:Belle(Claude companion)长期运行中,她**唯一的硬行为边界**(不碰代码/Runner/Bridge action API/不可逆动作需确认、prompt-injection 防线)从未在上下文里 — launcher 对该文件缺失是 fail-STOP 级对待,装了也白装。她实际唯一装上的是 discord-reply-contract(FLY-387 回复泄漏防线 — 讽刺的是她正是该 bug 的受害者,这条真起过作用属于万幸)。Mufasa 不受影响(Codex 路径 CSV→拼接,天然正确)。**修复激活后 Belle 首次受全套 contract 约束 — companion canary 观察点。**

### 0.2 dept/cos Lead 长期唯一生效的规则 = screencapture-l3-skill(末位)
全部 governance(founder-only-authority、FLY-162、Action Gate、auto-QA、routing)零生效;行为全靠 identity + memory + 项目层撑着。这解释了为什么行为「大体对」:identity 文档实际上各自复述了关键纪律(见 §3)——但也意味着**规则与 identity 从未做过一致性对账**,激活即首次对账,冲突见 §3。

## 1. ① 过时条款(与已裁决事实/现状冲突)

| # | 文件 | 条款 | 过时点 | 处置建议 |
|---|---|---|---|---|
| 1.1 | founder-only-authority.md | 全文框架「v1.29.x calibration window」「Track 2 (in design)」「Until Track 2 lands, this rule is the only enforcement」 | 现已 v1.55;Track 2(FounderConsentEvaluator,PR #205)早已 merge(DECISION_MODE 默认 off)。**操作性合同本身仍是现行有效**(CLAUDE.md FLY-350 明确全队合同继续),只是叙事框架停在一年前 | **改**:刷新框架段(版本引用、Track 2 状态),R1/R2/R3 操作条款保留原样 |
| 1.2 | cross-dept-channel-rules.md | Roster 表(9 人:Peter/Oliver/Simba/Hiro/Asha/Triton/Ariel/Mufasa/Belle) | 缺 Tadashi、Aunt Cass、Honey Lemon、rafiki/reflection/infra-bot 等后加入 Lead;项目清单(line 28)也缺 flywheel/growth 等。激活后 sibling Lead 依据此表定位同伴会漏人 | **改**:roster 补全(或改为指向动态来源 + 最小示例) |
| 1.3 | department-lead-rules.md:130-136 | FLY-127 PR #173/#174 配对部署顺序说明(「Don't ship this PR alone」等) | 两 PR 已 merge 一年+,纯历史部署注意事项占 prompt 空间 | **删**(或移入 git history 注释) |
| 1.4 | runner-messaging-rules.md | 「Batch 2 PR 2.1 will replace it with await-mcp + StructuredInboxRouter」 | 前向引用早已过期,机制没换 | **改**一行(去掉前向承诺) |
| 1.5 | founder-ux-rules.md | 「default ON even when config absent(FLY-869)」 | FLY-900 已把 fleet 开关默认 retire(需 FLYWHEEL_FOUNDER_UX_GATE_ENABLED=1 才装载)——该文件当前根本不进 bundle,文本与 FLY-900 现状矛盾但无实际影响 | **保留**(inert);若重新启用先改文本 |
| 1.6 | (identity 样本)flywheel-eng-lead/identity.md:61 | 「.flywheel/config.yaml ships with FLY-270 but is not active until that PR merges」 | FLY-270 已 merge(PR #267),config 已激活 | **改**(identity 归 Lead 手册维护,非本单) |

## 2. ② 规则间冲突 / 重复

| # | 条款对 | 性质 | 处置建议 |
|---|---|---|---|
| 2.1 | FLY-162 Reply Discipline 全文 ×3 副本:department-lead-rules + cos-lead-rules + inbox-ack-rule | **重复**:dept Lead bundle 里同一算法完整出现两次(dept-rules + inbox-ack),cos 同理。约 4.5KB×2 token 冗余 + 三处独立维护的 drift 风险(现已轻微措辞分叉) | **改**(follow-up):算法正文收敛到一处,其余引用;非激活阻塞项 |
| 2.2 | cos-lead-rules.md:5「this file is appended **before** the cos-lead's own identity.md」;department-lead-rules §Order of precedence 同类表述 | **事实相反**:identity.md 是 agent 定义文件(装载在最前),base rules 经 --append 在**其后**。按 prompt-stacking「后者优先」,实际是 **base 压 identity**,与两文件宣称的「project/identity 可 override base」相反(项目层 .lead/shared 文件确实在 base 后追加,那部分表述对;错的是 identity 方向) | **改**:修正表述;凡预期 identity 赢的条款需显式写「identity 载明的例外优先」字样(见 §3 冲突的解法依赖此点) |
| 2.3 | doc-flow-rules(Lead 判档传 docTier)vs 生产 flywheel 项目三段式 pipeline(design 阶段由 DOC-FLOW block 注入 full 档) | 弱张力非冲突:doc-flow 判档知会义务在 flywheel 项目启用 doc_flow 后属首次对 Tadashi 生效,与三段式共存逻辑未经实跑 | **保留** + canary 观察点 |

## 3. ③ 与 identity 文档冲突(样本:Tadashi、Cass)

| # | 冲突 | 影响面 | 处置建议 |
|---|---|---|---|
| 3.1 | 🔴 **FLY-162 机械算法 vs Cass 的 FLY-270 派单流**。算法:任何 inbound 含 N≥1 个 issue token → 必须 /send 进 per-issue thread,top-level 回复 WRONG,「semantic interpretation forbidden」。Cass identity:派单 = **在 #flywheel-core 顶层 @Tadashi 发含 FLY-XX 的 assignment 消息**(FLY-270 Fix B,生产验证过的唯一手递路径);触发场景常是 Annie 顶层说「FLY-XX 派给 Tadashi」(inbound N=1)→ 算法要求 Cass 回进 thread,而 Tadashi 的 Core Channel Routing 监听的是 #core **顶层** @/name → **派单链可能在激活当晚断掉或改道** | CoS→Eng 手递链 = 自托管生命线 | **激活前把裁决写死**:建议在两个 identity 里显式加「dispatch/assignment 例外:派单与接单 ack 属顶层协调消息,不受 N-token 路由约束」;并注意 §2.2 — 光写进 identity 不够(base 后装压 identity),需在 base 算法的 N==0 分支旁加一行「Lead identity 可声明 dispatch-directive 例外」或等价 carve-out。**这是审计里唯一建议在激活前动 base 文本的一条** |
| 3.2 | 同根源:Tadashi identity「在 #core 一行『已接,详见 thread』OK,substance 进 thread」 vs 算法 N==1 → 只许 /send | 接单 ack 行为 | 同 3.1 的 dispatch 例外一并覆盖 |
| 3.3 | Cass identity:87「triage/HTML-dashboard mechanics in base cos-lead-rules.md」 | **悬空引用**:cos-lead-rules.md 里没有 triage/HTML-dashboard 机制章节(该内容在 Simba 的 GeoForge3D 项目层,Flywheel 无 .lead/shared)。激活后 Cass 找不到被指向的内容 — 无害但误导 | **改** identity 引用(非本单) |
| 3.4 | Tadashi/Cass identity 均声明「操作细节来自 base rules,auto-appended,不在此复述」 | 过去一直是**假前提**(没装上);激活后变真。无冲突,但说明两人此前实际运行在「identity+memory 补课」模式 — 激活后 base 细节(status code map、gate 事件处理、stuck ladder)首次接管,行为可能变得更机械/更合规 | 无动作;canary 观察点 |

## 4. ④ 处置汇总 + 激活关联

- **激活前必须裁决(阻塞 W2 全量,不阻塞代码 PR)**:§3.1/3.2 dispatch 例外(base FLY-162 加 carve-out 一行 + 两 identity 显式例外)。不裁决就全量,风险是派单链行为跃变。建议作为独立小 PR 与 W1 canary 并行走。
- **改(非阻塞,follow-up issue)**:1.1 框架刷新、1.2 roster、1.4 一行、2.1 去重、2.2 stacking 表述、3.3 identity 引用。
- **删(非阻塞)**:1.3 历史部署段。
- **保留**:其余 12 份(executor-routing、model-routing、stuck-remanage、reengage、patrol、auto-qa、default-enable、xhs-memory、founder-local-time、founder-html-delivery、discord-reply-contract、companion-safety、external-contract、doc-flow)通读未见过时/冲突,内容与当前机制(FLY-1279 ACK、FLY-1372 DAG、FLY-752 QA 复用等)一致。
- **canary soak 观察点清单**(行为层偏移 = soak 目的):① Cass 派单/triage 回复路由是否改道(3.1);② Tadashi 接单 ack 形态(3.2);③ doc-flow 判档知会首次生效(2.3);④ Belle(W2 时)companion contract 首次约束(0.1);⑤ dept Lead 对 gate/stuck/patrol 事件的处理是否变机械照章(3.4 — 预期是变好,盯误伤)。
