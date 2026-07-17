# FLY-1327 issue 周期时间分解 — 调研

Issue: FLY-1327 (https://linear.app/geoforge3d/issue/FLY-1327/分析-issue-周期时间分解-时间都花在哪-机制优化建议annie-直令)
日期: 2026-07-16
基于: exploration.md

本调研全部结论来自真机验证(只读查询),无推测。每节附验证方式。

## 1. 数据源逐一验证结果

### 1.1 sessions 表(teamlead.db)— phase session 骨架

- 路径:`~/.flywheel/teamlead.db`,只读打开(`file:...?mode=ro`)。
- 关键列:`issue_identifier` / `session_role`(design|implement|qa)/ `status` / `started_at` / `terminal_at` / `session_stage` / `stage_updated_at` / `pr_number` / `branch` / `retry_predecessor/successor` / `run_attempt`。
- 4 个样本 issue 共 **23 条 session**(FLY-1252 × 9、FLY-1307 × 7、FLY-1309 × 3、FLY-1319 × 4),含 `failed` / `terminated` / `rejected` 等异常态。**注意(Codex R3 更正)**:单个 failed/terminated/session_failed **不是**基建事故证据(DirectEventSink 对普通失败也发 session_failed);基建事故唯一判据 = 同项目同 60s 窗 ≥3 个 session 非正常 terminal 且 last_error 指纹一致的**聚类**(如 FLY-1252 的 3 条 15:53 同时 `terminated` 即此形态),聚类查询跨该项目全部 sessions。
- 口径注意:`terminal_at` 对 running/awaiting_review 的 session 为空 → as-of 快照时以快照时刻截断并标「进行中」。

### 1.2 session_events 表(teamlead.db)— 分钟级事件流

- 4 个样本 issue 合计 **500+ 事件、26 种 event_type**。核心可用:
  - `stage_changed`(payload.stage:onboard/brainstorm/research/plan/design_review/implement/test/code_review/pr_created/approve/ship/completed)—— 段切点主力。
  - `session_started` / `session_completed` / `session_failed` —— handoff gap 计算(前一 phase completed → 下一 phase 首个实质 stage 之间)。
  - `qa_result`(16 条)—— QA verdict 与返工触发点。
  - `three_stage_fix_round`(4 条)—— 显式返工轮。
  - `checkpoint_park_nudged` / `checkpoint_park_paged` —— park 空转的证据。
  - `founder_ship_reply_waked` / `founder_reply_delivered` —— founder gate 交互点。
- 真机样例(FLY-1309 design):08:07 started → 08:08 brainstorm → 08:22 research → 08:24 plan → 08:29 design_review → 10:46 completed。即 design_review(含 Codex design review + gate)占了 design phase 的 2h17m/2h39m —— 事件粒度足以支撑这种结论。

### 1.3 codex_review_job 表(teamlead.db)— cross-family review 轮次

- 每轮一行:`review_type`(design|code)/ `round` / `created_at` / `updated_at` / `responded_at` / `verdict`(APPROVED|CHANGES_REQUESTED)/ `status`(含 failed)。
- 真机验证:FLY-1307 双 PR 合计 11 行 code review(含 2 次 `failed`);FLY-1252 亦 11 行。
- **时长口径(Codex R1 更正)**:`StateStore.failCodexReviewJob()` 失败时写 `updated_at`(StateStore.ts:5544-5556);正常完成也是先写 `updated_at` 再写 `responded_at`(:5517-5536)。所以 **review 运行时长 = created_at → terminal updated_at**;`updated_at → responded_at` 是投递/唤醒延迟,单独归类。failed 轮**有实测时长**(如 FLY-1252 R7:03:20:26→03:38:28),计时并标 outcome=failed;仅当 terminal updated_at 也缺失时才进不可测分支。轮间隙(上轮 terminal → 下轮 created)= 修复/推进时间,归返工或工作段。

### 1.4 CommDB messages 表 — gate 等待

- 路径:`~/.flywheel/comm/flywheel/comm.db`(per-project;根目录 `~/.flywheel/comm.db` 是另一实例,以 per-project 为准)。
- `type='question'` + `checkpoint`(brainstorm / review_code / approve_to_ship)+ created_at;response 为 `parent_id` 关联的 `type='response'` 行,其 created_at = 答复时刻。
- **语义区分(Codex R1 更正)**:`review_code` / `review_design` checkpoint 是 **cross-family 自动 review 的阻塞问答**,不是人工 gate —— review 区间以 codex_review_job 为准,这类 question 只作旁证。**人工 gate 只有 brainstorm 与有效的 approve_to_ship**。真机反例:FLY-1309 一条 review_code question 14:50 创建,session 21:59 已 terminal,response 却 2026-07-17 05:23 才补投 —— 若按 question→response 计「gate 等人」会吞掉整个后续工作段。→ gate 区间必须带 supersession 关闭规则(response / session terminal / head 变更 / 新 gate 均可关闭),晚到 response 不回填。
- 真机验证:样本 issue 的 gate 问答对齐全(如 brainstorm gate 2.1 分钟答复)。未答的**人工** gate → as-of 截断标「等待中」。
- `runner_phase_wakes` 表(同库):queued_at / started_at / finished_at(**epoch 毫秒整数**,与其他表的 SQLite UTC 字符串不同源不同格式 —— 逐源 parse 契约必须分开写)→ wake 排队延迟可测。

### 1.5 GitHub(gh CLI)— PR 与 CI

- `gh pr view <n> --json createdAt,mergedAt,commits` ✅(PR #620:2026-07-16T14:49Z 建,17:12Z merge,33 commits)。
- `gh run list --branch <branch> --json createdAt,updatedAt,conclusion,event` ✅(FLY-1309 分支 4 轮 CI:3.5min / 17min / 17.5min / 17.4min,前两轮 failure 后两轮 success)—— **单轮 CI ~17 分钟、每次 head 变更重跑一轮** 的量化证据直接可得。
- PR 发现方式:sessions.branch → `gh pr list --head <branch> --state all`;双 PR issue(1307/1252)按分支枚举全部 PR。

### 1.6 Linear GraphQL — 外部视角 T0/T_end

- `LINEAR_API_KEY` 在 `~/.flywheel/.env`(已确认存在,查询已真机跑通)。
- `issues(filter:{number,team}){ createdAt startedAt completedAt history{ fromState toState createdAt } }` ✅。
- 真机验证 FLY-1309:createdAt 08:06:49Z → Done 17:12:21Z = **9.09h,与 issue 描述「Backlog→Done ~9h」吻合** —— T0 = issue createdAt,T_end = completedAt(Annie 的口径)。
- **重要发现**:Linear「Backlog→In Progress」15:35 才翻,而 design session 08:07 已开跑 —— Linear 状态机滞后实际工作 7.5h,**不能**用 Linear 状态切换做内部分段,只用它定生命周期两端 + 报告里如实呈现这个滞后(本身就是一个机制观察)。

### 1.7 system-health log — load 饱和标注(gate 补充项 b)

- 路径:`~/Library/Logs/system-health/YYYY-MM-DD.log`,60 秒粒度,`load averages: X Y Z`。
- 真机验证:2026-07-16 峰值 **load 108.76 @ 22:59 本地**(Tadashi 说的「load 106 时段」得到印证,取整分钟粒度曲线可精确圈出饱和窗口)。
- 用法:汇总图与时间轴上叠加「load > 阈值(定 30,≈2×核数量级,实施时可调)」的饱和窗口底纹;饱和窗口内的段在占比图中单独着色/标注,避免机器饱和冒充机制成本。

### 1.8 并发曲线(gate 补充项 c「甜点并发数」)

- 2026-07-16 起 project=flywheel 有 61 条 session(全部有 started_at,35 条有 terminal_at)→ 由区间叠加重建「并发 runner 数-时间」曲线可行。
- 与 load 曲线(1.7)做同轴对照 → 给出「并发 N 时 load/段时长如何变化」的分箱展示。**诚实边界(与 plan 冻结口径一致,Codex R4 对齐)**:每并发档需 ≥60 覆盖分钟且 ≥2 个独立 issue 才可定量;本次单日 4 样本几乎必然不满足 → 该图**仅作描述性观察**,输出固定为「样本不足以定量,建议持续采集」,**不给方向性数字或区间**。

## 2. 互动评审模板(建议清单形态)

- 全 repo grep「互动评审/copy-export/建/不建」无现成组件 —— 模板不在本 repo。
- 最近的实物:`~/.flywheel/deliverables/FLY-1178-voice-agent-ecosystem-interactive.html`(2026-07-11,localStorage 状态 + 「导出」按钮形态)。结论:**复用其交互模式**(每条建议:建/不建 单选 + 评论 textarea,状态存 localStorage,底部「导出反馈」按钮生成汇总文本一键复制),在本报告 HTML 内自含实现,不引外部依赖。
- 硬约束(memory 已验教训):托管页有真 CSP,内联 JS 必须走 nonce 注入;**QA 必须在已发布 URL 上验证交互可用**(chrome console 读不到 CSP violation,要做突变对照:故意去掉 nonce 应当失效)。

## 3. 交付通道核实

- issue 明示:「publish-report 进本 issue thread 给 Annie」。`flywheel-comm publish-report`(FLY-203)= 发布到托管 URL + proofshot + Discord 一条消息。
- 与「founder 物料 Runner 不直投」的纪律关系:本 issue 由 Annie 直令 + Lead 派发时已把 publish-report 写进交付要求 = 已授权;实施阶段仍以**当时**的投递规则为准,若 publish-report 对 Runner 被禁,则 fallback:HTML+截图作为素材经 flywheel-comm ask --report 交 Lead 投递。两条路都写进 plan,不赌一条。

## 4. 归段算法可计算性结论

主线归段所需的全部切点事件均已验证可得:

| 段标签 | 切点来源 |
|--------|----------|
| 基建事故 | **仅指纹聚类**:同项目同 60s 窗 ≥3 session 非正常 terminal 且 last_error 指纹一致(查询跨**该项目**全部 sessions,不限样本 issue);单个 failed/session_failed 不算(见 §1.1 更正) |
| gate 等人 | CommDB question created→response created(**仅 brainstorm/approve_to_ship 人工 gate**;review_* 问答归 review);supersession 关闭规则见 §1.4;approve 未答→as-of 截断 |
| 返工循环 | codex_review_job CHANGES_REQUESTED 轮 + qa_result FAIL + three_stage_fix_round + 后续 fix 推进事件 |
| 独立 QA 运行 | auto_qa_record started/completed + qa session started/terminal |
| review 运行 | codex_review_job created→terminal updated_at(design+code,failed 轮同样计时);updated→responded 差值单列为投递延迟 |
| CI 等待 | gh run createdAt→updatedAt,且区间内无其他主导活动 |
| 工作中 | design/implement session active 且 stage 属工作段(brainstorm/research/plan/implement/test) |
| 空转 gap | 上述全无:phase 间 handoff、park 等 wake(checkpoint_park_* / runner_phase_wakes)、等 dispatch |

优先级冲突消解按 exploration §4 的序。每个区间输出 evidence 数组(event id / review round / run id / message id),HTML 可展开。

## 5. 「无法测量」定版清单(报告如实展示)

1. implement session 内部「写码 vs 本地测试 vs 思考」不可再分 —— 统一「implement 工作中」。
2. review 轮仅当 terminal updated_at 也缺失时才不可测(failed 轮有 updated_at,正常计时,见 §1.3 更正)。
3. Lead 人工决策/转发的思考时间(混在 gate 答复时长里,无法与「没看到」区分)—— gate 段按 PDT 时段标注夜间/白天,不裁决合理性。
4. 2026-07-16 重启窗口内被杀 session 的「已完成但未记账」工作量 —— 按事故段整段计,不拆。
5. Discord thread 里的人际沟通耗时(未结构化)—— 不进段,必要处作附注。

## 6. 对 plan 的输入(要点)

- 脚本 `scripts/cycle-time-report.mjs`,只读访问全部数据源;`--issues` / `--as-of` / `--out` 参数化;中间产物 `data-<issue>.json`(segments+evidence)落 doc 文件夹 commit。
- 渲染:单页静态 HTML,Apple 浅色规范 + dataviz 规范;时间轴 = 纯 HTML/CSS 横向 stacked bar(不引第三方图表库,CSP 自含);load 饱和底纹;PDT 轴。
- 测试:segmenter 纯函数化 + 合成 fixture 单测(不依赖生产 DB、不联网,CI 可跑);extractor 用临时 fixture SQLite 验证;「段和=墙钟」「无法测量不为 0 编数」做成断言。
- 建议清单每条:预期节省(引用本次数据)+ 成本 S/M/L + 建/不建 + 评论 + 导出;含「甜点并发数」条目(本次仅描述性观察 + 持续采集建议,定量留给后续采集,见 §1.8)。
