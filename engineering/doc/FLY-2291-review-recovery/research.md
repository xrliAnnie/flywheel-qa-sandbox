# FLY-2291 审查输出修复与会话恢复 — 调研
Issue: FLY-2291 (https://linear.app/geoforge3d/issue/FLY-2291/审查no-verdict-续写审查员会话连续输出缺尾括号的-json-parser-判-no-verdict且坏会话被新一轮继承粘住2269)
日期: 2026-09-03
基于: exploration.md

## 1. 现有链路与安全边界

### 1.1 parser 与 runner

`packages/teamlead/src/bridge/claude-review-runner.ts` 的 `parseClaudeReviewOutput` 先严格解包 Claude CLI success envelope，再调用私有 `extractVerdictObject`。提取器先扫描平衡对象，失败时最多检查 32 个 `"verdict"` anchor；两条路径都只接受 `JSON.parse` 成功且 verdict 属于 `APPROVED | CHANGES_REQUESTED` 的对象。

当前没有平衡对象便返回 `null`，`runClaudeReviewRound` 因而给出 `failed/no_verdict`。安全的有界修复必须满足全部条件：

- 所有正常 balanced candidates 均失败；
- 解包后的 bare text 经 `trim()` 后从 `{"verdict"` 开始，并以已经闭合 findings 数组的 `]` 结尾；
- 只追加一个最外层 `}`；末字符为引号、数字、逗号、冒号或需要 `]}` 时一律拒绝；
- 修复后通过完整 `JSON.parse`、合法 verdict，并且对象自带 `findings` 数组。

最后一条是设计审查指出的关键 fail-closed guard。只检查 verdict 会把 `{"verdict":"APPROVED","reviewedHeadSha":"..."` 这种刚好停在字符串边界、尚未输出 findings 的半截文本补成可解析批准。完整、未修复对象保留既有兼容语义；错误 envelope、未闭字符串、缺 findings、未知 verdict、缺 `]}` 或更多 closers 的文本仍是 no_verdict。code review 的 SHA echo 继续交给 coordinator 的冻结 head 校验。

### 1.2 repair 审计

`codex_review_job` 已承载 reviewer session、原始/有效 verdict、failure evidence 与 canonical response，适合增加 `repaired_trailing_brace INTEGER NOT NULL DEFAULT 0`。fresh schema、`PRAGMA table_info` 旧库迁移、row mapper 都要同步。

marker 不能只在 `completeCodexReviewJob` 写：repaired verdict 还可能随后被 gate/head guard 拒绝。coordinator 应在拿到 repaired outcome 后立即用幂等 update 写 true，再做后续校验。因此：

- 成功与后续失败的 job 都保留真实 parser 审计；
- 成功 canonical response 携带 `repairedTrailingBrace: true`；
- 修复后又被 guard 拒绝时，既有 failure alert 显示 `repaired_trailing_brace=true`。

这满足“不能静默”，且不增加审计表、alert kind 或消费者层。

### 1.3 reviewer session 继承与同 request retry

`ReviewRequestCoordinator.accept` 当前让新 job 继承同 execution + type 的最近非空 reviewer UUID。`runJob` 对 reround 默认 `--resume`。同 request 的手工/配额 retry 则直接复用本 job 的 UUID；只在 `accept` 判断会漏掉这条路径。FLY-2269 四个 job 产生五份 reviewer 输出，正包含一次同 request 自动 retry。

“连续两轮”需要建模为连续 reviewer 输出，而不是只数 job：

- job 增加 `reviewer_session_generation` 与 `reviewer_session_failure_streak`；新 job 从同 execution + type 的最近状态继承 generation、同 generation UUID 和 streak，因此 requestId 边界不会清掉连败；
- `no_verdict` 与 `reviewed_wrong_head` 都给 streak 加一；其他 failure 或完成 verdict 清零；
- streak 到 2 时，StateStore 在同一持久化动作里把当前 job 的 generation 加一、清空待启动 UUID、把 streak 清零，并返回 `reviewerSessionRotated=true`；两个 request 各失败一次或同 request 连败两次都会触发；
- generation 是“不继承”的持久标记，不以 NULL 本身表达策略。UUID lookup 先读取最新 generation，再只在该 generation 内找最近 UUID；新 generation 没有 UUID 时 `runJob` 才生成并以 `resume=false` 启动。

第二次 session-integrity failure 落库时 generation 已经切换，因此现有 alert 可以准确说明“已换新会话，重试同 requestId 即可”。同 request retry 和下一新 request 都落在新 generation；fresh 会话之后又要连续失败两次才再次切代。

`buildPrompt` 已有 fresh reround 分支，可注入最近 DONE job 的 `findings_json`。新路径需要传入 fresh reason，区分 repeated-no-verdict 与 session-not-found，并注明 durable findings 来自哪一 round；无可靠 findings 时继续诚实 fallback。

### 1.4 failure-shaped alert

失败同时走 structured `review_job_failed` 与既有 `alertLead`。当前 open-gate failure 普遍建议 same-request retry，且 scheduled retry 会覆盖更具体的失败说明。

两个 surface 应共用 failure-shape recovery helper：

- 第一次 no_verdict 可保留一次原 session retry；
- 第二次 no_verdict 或 reviewed_wrong_head 后，说明 reviewer session 已换代，重试同 requestId 会 fresh；若 retry 已排期，同时显示时间；
- repaired verdict 后续被 guard 拒绝时显示 repair marker；
- timeout、gate mismatch 等其他原因维持现有建议。

不增加 alert kind、sink、开关或独立通知。

## 2. 真机夹具审计

Lead 已导出权威 reviewer `result` 字符串。编号按输出而非 review job，因此四个 job 共五份输出（一轮自动 retry）。这些文件不是 Claude CLI 外层 stdout envelope；fixture test 必须逐字读取 raw，再用生产结构 `{type:"result", subtype:"success", is_error:false, api_error_status:null, result:raw}` 包装后调用 parser。

| 文件 | bytes | SHA-256 | 形状 |
| --- | ---: | --- | --- |
| `fly2269-r1-reviewer-raw.txt` | 9589 | `9fe6949b460f0ca6a0a65e022f31293f237e7f3a4c825d3e472b7f6f6b1b6627` | 完整 `CHANGES_REQUESTED` control，8 findings |
| `fly2269-r2-reviewer-raw.txt` | 8650 | `86752ee3b7e8b813f4968f129dbedeb36a755879745c49330dca22a179098480` | `CHANGES_REQUESTED`，6 findings，缺最终 `}` |
| `fly2269-r3-reviewer-raw.txt` | 9126 | `9b53df8c18471ee835fdc0d3a183a3600ecc31a2e13a7b06d229e42c7ba5cd38` | `CHANGES_REQUESTED`，6 findings，缺最终 `}` |
| `fly2269-r4-reviewer-raw.txt` | 9225 | `4f4b4d178512d0ce5712560133befc365914b47862647d4029b0e717fce600d9` | `CHANGES_REQUESTED`，5 findings，缺最终 `}` |
| `fly2269-r5-reviewer-raw.txt` | 2710 | `19ce779dd53cb6330116eeed049fe0b37834986db63f29bbab435dbb6c32f9bc` | `APPROVED`，2 findings，缺最终 `}`；短输出证明与长度无关 |

## 3. TDD seams

### 3.1 parser

公共 seam 是 `parseClaudeReviewOutput` 与 `runClaudeReviewRound`。首批 RED 覆盖完整、缺 `}`、缺 `]}`、真截断；随后以真实 envelope seam 重放 R1–R5。负向组包括 verdict/sha 已完整但 findings 尚未输出、fenced truncated、需要第三个 closer、坏 envelope 和未知 verdict。断言外部 verdict/repair flag，而不是私有扫描过程。

### 3.2 audit persistence

公共 seam 是 marker StateStore API 和 coordinator 完整 outcome。覆盖默认 false、幂等 true、旧 schema 迁移、repair 后 gate/head guard 失败仍保留 true、成功 response 与既有 failure alert 可见。

### 3.3 session recovery

公共 seam 是连续提交 gate/request 或 retry 后观察 runner invocation 和 job 行。分别覆盖跨 request 两次 no_verdict、同 request 两次 no_verdict、no_verdict + reviewed_wrong_head，断言第二次失败已增加 generation，下一次 `resume=false`、UUID 全新且持久化。控制组覆盖一次失败、其他 failure/done，以及 execution/type scope；lookup 不得跨 generation 复活旧 UUID。

### 3.4 prompt 与 alert

更早 DONE finding + 连败 + fresh round 应把 durable finding 和来源 round 写入 prompt，且不声称 `THIS session`。第二次 no_verdict 的两个现有 alert surface 都应给 fresh recovery；scheduled retry 同时给出时间；timeout 等形状保持原文案。

## 4. 风险与守卫

| 风险 | 守卫 |
| --- | --- |
| 宽容 parser 吃掉真正截断 | bare 起始、只接受 findings 已闭合的 `]` 尾部、只补一个 `}`、完整 parse、合法 verdict、自有 findings 数组 |
| 错误 envelope 绕过边界 | repair 只发生在既有 success envelope 校验之后 |
| requestId 边界清掉连败 | 新 job 继承同 execution + type 的 generation 与 streak |
| crash 后复活旧 UUID | generation 是持久边界；UUID lookup 只查最新 generation |
| 连败后仍 resume 坏会话 | 第二次 integrity failure 的同一持久化动作先切 generation，再发 alert |
| 换会话丢上下文 | fresh prompt 注入最近 DONE findings 并标明来源 round |
| alert 双轨漂移 | 两个既有 surface 共用 recovery helper |

## 5. 非目标

- 不改变 envelope、severity policy、gate/outbox、quota retry 或 session-not-found 单次 fallback 语义。
- 不新增 alert event type、配置开关、reviewer 服务或独立重试队列。
- 不修复 fenced JSON、缺 findings 的 verdict-only 片段、缺 `]}` 或更多 closer 的文本。
- 不把所有 reviewer failure 泛化为 session poison；仅 `no_verdict` 与 `reviewed_wrong_head` 计入同会话连败。
