# FLY-2550 PRD 补充(拟并入 FLY-2119 PRD 作为 §5.7)— 常驻 Lead 的线程形态
Issue: FLY-2550 (https://linear.app/geoforge3d/issue/FLY-2550/2355e-常驻-lead-记忆蒸馏真拦点-codex-threadsid-current-thread-id-排除常驻-lead-永不换)
日期: 2026-09-14
基于: plan.md

> 目标位置:`engineering/doc/FLY-2119-codex-identity-memory/prd.md` §5.7(PRD 在 PR #1024,尚未合入 main)。本文按 PRD 的口吻写成可直接粘贴的一节;并入时只改标题编号。

## 5.7 常驻 Lead 的线程形态决定记忆能否累积(FLY-2360 诊断 → FLY-2550 设计)

### 5.7.1 事实(2026-09-14,Codex 0.154.0 源码 + 生产读数)

Codex 的后台整理只挑「**别的**、已静置 ≥6h、≤10 天、未归档、来源为交互式」的线程(`state/src/runtime/memories.rs:236-249`)。「别的」= 不是正在触发整理的那条线程。TUI 形态的常驻 Lead(Mufasa、Infra Bot、切到标准运行时后的 Raya)一辈子只有**一条**线程,它既是唯一够新的线程,又永远是触发者 ⇒ **候选恒为 0**。四道节流闸(§5.6.3)放到任意宽都没用——FLY-2360 已逐道量过。

另一条同源事实:模型读记忆(`memory_summary.md`)只在「新的上下文窗口」开始时注入(线程开始/恢复、或一次压缩之后;`core/src/session/mod.rs:4217`),不是每轮重读。一条永不结束的线程,也就很少读到新整理出来的记忆。

### 5.7.2 决定:TUI 常驻 Lead 每 7 天换一页(线程轮换),不退出 Codex 记忆

- **方式**:到期、本页确有真实对话、且经可验证的 fence 确认空闲(router 暂停并等待当前执行完成,新到消息留在 accepted 队列、终端窗口已关、Codex 侧最后一轮非进行中、30 分钟安静)时,用 `thread/start` 起一条全新线程;新线程的 `developerInstructions` 是**代码内置的固定文本**,**不携带任何旧对话**(模型写便签、原文摘录两条路分别在 Codex R1/R2 被否决:都是让无人确认的自动回合执行历史内容);`thread-id` 指向新线程;**旧线程原地不动**(不归档、不改 memory_mode、不再 resume)。旧线程 ≥6h 后自然成为候选,由已有的 6 小时 `summary_due`(FLY-2382)触发的 memory startup 认领。
- **为什么不用 `thread/fork`**:legacy 历史模式的 fork 会把整份旧历史复制进新线程的 rollout(`core/src/session/mod.rs:1478-1515`),每次整理都重复消化整条家谱。
- **为什么不退出 Codex 记忆改走自有 MEMORY.md**:与 §1.1 方案 D「身份记忆用 Codex 本来就有的机制」相悖;FLY-2357 的 pin 门对 `memories≠true` fail-close;模型手写笔记无蒸馏、无审阅、两套真相。
- **代价(诚实)**:每周一次「换页」——founder 在终端里看到 Mufasa 窗口重开一次;上一页的细节**只**以 Codex 整理出的记忆摘要带过去,换页后第一句可能要重述上下文;换页期间到达的消息在新页照常回答(journal 恢复)。主线程本来就靠压缩活着(4 次压缩、36.9M 累计 token),连续性早已是摘要级。
- **回滚栓**:项目级 SQLite 开关 `codex_lead_thread_rotation=0`（现有 flag stage/apply，附 reason；下一 generation 生效；项目行 → `*` → 默认开启）。

### 5.7.3 逐 Lead 的处置与验收

| Lead | 形态 | 处置 | 验收(一周) |
|---|---|---|---|
| Mufasa(`~/.codex-mufasa`) | TUI 单线程,自 06-09 | 线程轮换(FLY-2550 plan) | `memories/rollout_summaries/` ≥1 篇真摘要;**或**日志显示窗口内每次 startup 都被额度闸(25%)拦下 ⇒ 记 `blocked_by_quota_gate`,不调闸,上报 |
| Infra Bot(`~/.codex-infra-bot`) | 同一 TUI 运行时;08-23 起零 turn | 同一轮换规则,但**本页没有真实对话就不换页**(`countCompletedSince ≥ 1` 门)⇒ 现状不会被换页、不会多跑 bootstrap turn;无 turn 则无 startup、无产出 | 记录「无 turn ⇒ 按设计不产生」;一旦有真实对话,按 Mufasa 判据 |
| Raya(`~/.codex-raya`,标准 Codex Lead,2026-09-14 切换) | 同一 TUI 运行时 | **权威记忆 = 她自己的 `MEMORY.md`(FLY-2131,`RAYA_MEMORY_FILE`)**;Lead 裁定(`8b57c58e`)不为她做 Codex 记忆设计;运行时的轮换对她同样生效(不特判) | 记录「按设计不产生 rollout_summary;记忆看 MEMORY.md」——**不是失败** |
| legacy `~/.flywheel/raya/codex-home` | 退役中 | 不设计、不写 pin、不量 | — |

### 5.7.4 量法(替换 §5.1「一周后看目录」的单一读数)

一周后同时看四样,缺一不可:①`rollout_summaries/` 文件;②`memories_1.sqlite` 里 `memory_stage1` 行与 `stage1_outputs` 非空;③`logs_2.sqlite` 里 `memories/%` 的额度闸/phase2 行;④运行时 `thread-rotation.jsonl` 的 `rotated` 行。命令见 FLY-2550 research §6。**空目录 + 有 `rotated` + startup 次数 > 0 + 窗口内跳过次数 = startup 次数** 是「被额度拦」,不是「设计失败」,也不是「该去调闸」;**空目录 + 有 `rotated` + 跳过次数 < startup 次数 + 旧线程谓词全真** 才是未解释的失败,要开单。

统计口径:bootstrap 仅计 completed 且按新线程 `to` 去重。`Q > S` 或无法归类时记录 `measurement_inconsistent`,不凭 0=0 宣称额度闸拦截。生产一周验收未由实现定向测试替代。
