# FLY-3164 Claude 传输探针 — 探索
Issue: FLY-3164 (https://linear.app/geoforge3d/issue/FLY-3164/529-canary-fly2127-canary-7b7c4e0e-f5ee-4fc2-ac0a-544468dfb145-claude)
日期: 2026-10-01
基于: 无

## 一句话结论

本 design node 只确认并回执当前 Claude execution 的真实 TURN，并为 `probe.txt` 的精确 marker 追加定义一份“来源可核验”的下游合同；它不追加任何 marker，也不把 FLY-2127 driver 为另一条 Claude execution 预设的 literal 冒充成本 execution 收到的原生邮件。

## 已确认事实(onboarding 审计)

| 事实 | 取值 | 来源 |
|---|---|---|
| Execution | `d27c7945-fbe3-40f1-9144-99486f6fb84b` | 注入的 `FLYWHEEL_EXEC_ID` |
| Activation | `activation:d27c7945-fbe3-40f1-9144-99486f6fb84b:b4d80259-ad7c-43dd-8c99-e47b22cb3119:eng_design:1` | 注入的 `FLYWHEEL_WORKFLOW_ACTIVATION_ID` |
| TURN | `yours phase=design epoch=1 … run=b4d80259-… node=eng_design attempt=1` | `flywheel-comm turn --exec-id …` |
| Runner backend | `claude-code`(dispatch: `claude` / `claude-opus-5-5` / effort `xhigh`) | 注入 env + `workflow_run.snapshot` |
| Workflow | run `b4d80259-…`(本 QA room 的 workflow DB 中 FLY-3164 唯一的 run),template `tpl_code` rev 1:`eng_design → implement → qa → founder_gate → land`;`workflow_run_node` 只有 `eng_design` 一行(running) | `workflow_run` / `workflow_run_node` 只读查询 |
| Mailbox | `inbox` → `No instructions.`;comm DB 中 `to_agent` / `from_agent` 为本 execution 的行 = 0(live projection、`mailbox_log`、`mailbox_terminal_archive` 都是 0) | `flywheel-comm inbox` + 只读 sqlite |
| Marker literal | 当前 user turn 中没有 `Append the exact line … to probe.txt` 形式的文本 | 本 execution 的初始 prompt |
| 分支基线 | `project-slot-5-FLY-3164` = `origin/project-slot-5-FLY-3164` = `b306fcf3a`,`origin/main` `7df383e6f` 是其祖先且 main 无新提交；根目录无 `probe.txt` | `git rev-parse` / `git merge-base` / `ls` |

## Re-dispatch 对账(本次 execution 的起点)

本分支先后经过两条 design execution:`2cd673b2-8210-45f9-982c-48dc9358da2b`(run `db0433f4-…`)产出了本文件夹的文档 / 图 / HTML;`f0635f3b-cf33-4d40-89f7-a9cebb32ab9d`(run `2f38be47-…`)刷新身份、跑了一轮 review 修订(`fe990167c`)并把进度推到 6/6。两条都没有在当前 workflow DB 留下 `phase_design_complete` 记录——当前 DB 里 FLY-3164 只有 run `b4d80259-…`,其唯一节点 `eng_design` 由本 execution `d27c7945-…` 持有且仍为 running。所以本 execution 从 `b306fcf3a` 接续，而不是从头开始。

| 继承物 | 是否沿用 | 原因 |
|---|---|---|
| 设计结论(TURN 回执 + 来源绑定的下游合同) | 沿用 | 事实没有变化：本 execution 同样没有 marker literal,也没有收到指令 |
| 文档文本 | 沿用并刷新 | 身份、runtime 版本与行号改为本 execution 实测值 |
| 旧 review 批准 | **不沿用** | 批准绑定旧 execution 的 review request 与 plan blob;`.flywheel/runs/<exec>/codex/design-review.json` 是 git-ignored 本地文件，新 worktree 中不存在。本 execution 必须重新 `stage set design_review` 并拿到自己的 `APPROVED` |
| 旧 Founder HTML 回执 / 旧 Lead 问题 | **不沿用** | 回执与问题属于旧 execution;本 execution 重新发布、重新回执、重新提问 |
| 新 run 的 comm DB | 全新(0 行) | QA room 状态已重建，旧 execution 的邮件在本 DB 中不存在 |

## 先例(同一 FLY-2127 canary 家族)

- **FLY-3121**(早期):design node 自己写了一条自描述行(owner + node + exec + activation + turn + 时间戳)。这条行能记录本地事实，但它不是“被请求的 marker”,把设计节点日志伪装成上游传输内容。
- **FLY-3122 / FLY-3125**(后期修正):design node 不碰 `probe.txt`,只做 TURN 回执 + 文档 + review + Founder HTML;`probe.txt` 的修改移到下游，并要求 marker 字节来自**绑定该下游 execution 自身**的原生指令。FLY-3125 的 Lead 回答(question `0b3a68be-…`)明确要求不追加 driver 预设的 boot literal。

本 issue 沿用修正后的边界。

## 成功标准

1. 产出 `exploration.md`、`research.md`、`plan.md`、两份 Mermaid source + 本地渲染 SVG、Founder HTML、restart-resilient `progress.md`。
2. 拿到有效的 `APPROVED` design-review verdict,提交 design artifacts 并推送到 feature 分支(依据：本 node 注入的 design 合同要求 “Commit and push the required artifacts”;issue 只要求 marker “commit locally”,没有禁止推送设计文档；不碰 main、不建 PR)。
3. 发布 Founder HTML 并用结构化回执报告 URL。
4. 通过结构化回执确认 TURN(满足 issue 的 “acknowledge … TURN”)。
5. `probe.txt` 在 design phase 保持不存在；不改产品代码，不建 PR,不请求 ship,不 merge / deploy,不派发后继节点。

## 方案比较

### A. TURN 回执 + 下游只追加“绑定自身的原生精确指令”(采用)

Design 记录真实 TURN;只有当下游 execution 收到一条可核验地发给它自己的 Lead 指令、且指令里有受支持格式的精确 marker 时，才逐字节追加并本地提交。
优点：来源证据完整，不会制造 canary 假阳性。代价：如果没有指令送达,`probe.txt` 就一直不存在——这是诚实结果，不是失败掩盖。

### B. 按 driver 模板重建 `<owner>-CLAUDE-BOOT` / `<owner>-R4-CLAUDE`(拒绝，除非 Lead 明确授权)

这两个 literal 与 driver 的验收字符串一致，写进去“看起来”通过。但它们属于 driver 用 `randomUUID()` 自己起的那条 Claude execution(直接 prompt 投递，不是本 DAG activation)。在本 execution 重写它们只证明“会抄模板”,不证明“本 execution 收到了原生邮件”。

### C. 自定义诊断行(FLY-3121 做法，拒绝)

TURN 事实已经由 `flywheel-comm turn` 原生给出并会通过 `ask --report` 回执；再造一条近似证据行只会让 `probe.txt` 混入非请求内容。

## 诚实边界

- **做**:记录本 design execution 的身份与 TURN;定义下游追加合同(来源核验、语法、区分“已写入”与“已提交”的幂等恢复、提交范围、无 marker 时的停靠路径);定义 QA 按 writer 身份做只读审计(含归档指令);走 review / HTML / 回执流程。
- **不做**:追加任何 marker;证明本 execution 收到原生 Claude 邮件(它没有收到);重新实现或替代 FLY-2127 driver 的 R4-claude 用例；创建 PR、push marker commit、ship、merge、deploy;解决 `tpl_code` 要求 PR 与本 issue 禁止 PR 之间的路由冲突(交给 workflow owner)。
