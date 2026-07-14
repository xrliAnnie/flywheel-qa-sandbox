# FLY-1254 跨厂商审查 no_verdict 查因 + 修 — 实施计划

Issue: FLY-1254 (https://linear.app/geoforge3d/issue/FLY-1254/fix-跨厂商审查-no-verdict-查因-修审稿人跑完但结论解析不出)
日期: 2026-07-14
基于: research.md

> 执行者:三段式 Implement 阶段(Codex gpt-5.6-sol xhigh),同分支 `flywheel-FLY-1254`。TDD:每步先写红测再实现。全程不改 §7.1/7.2 的 fail-close 语义与 R12-R16 加固——既有 `claude-review-runner.test.ts`(20 例)与 `review-request-coordinator.test.ts` 必须持续全绿,不许改断言迁就实现。

## 0. 变更总览

| # | 变更 | 文件 | 性质 |
|---|---|---|---|
| 1 | verdict 锚定宽容提取(修 no_verdict 根因) | claude-review-runner.ts | 核心 |
| 2 | stderr 有界捕获 + 失败 raw 落库 `failure_raw` | claude-review-runner.ts · StateStore.ts · review-request-coordinator.ts | 观测 |
| 3 | reround prompt:resume 轮去 findings 注入;fresh 重建轮如实声明 | review-request-coordinator.ts | 正确性 |
| 4 | resume session 丢失 → pattern-gated 单次 fresh 回落 | review-request-coordinator.ts | 韧性 |
| 5 | 30min 默认保留 + `FLYWHEEL_CLAUDE_REVIEW_TIMEOUT_MS` env 接线 | plugin.ts | 接线 |
| 6 | contract prompt 追加末行约束(一句) | review-request-coordinator.ts | 辅助 |

不改:信封校验(R12-R14)、gate 绑定/重验、head 冻结/回显(R12 HIGH-6)、authority 顺序(R15)、outbox、调度(串行/并发 2)、`DEFAULT_TIMEOUT_MS=30min`、`DEFAULT_REVIEW_EFFORT=xhigh`、默认 model。

## 1. Step 1 — 宽容提取(核心修复)

### 1.1 先写红测(fixture 先行)

新建 `packages/teamlead/src/bridge/__tests__/fixtures/fly1225-r2-review-output.txt`:**逐字**存入事故 R2 终稿原文(来源:`~/.claude/projects/-Users-xiaorongli-Dev-flywheel-FLY-1225/a4c3f2b5-9439-488b-949a-85134a1c5e4a.jsonl` idx 151 的 assistant text;research.md §2.2。实现时从该 transcript 拷出,确保含 `{p,m}`/`{p,fc,m}`/`{s,c}` prose 与末尾 verdict 行)。同法存 R1 终稿(idx 129)作对照 fixture。

红测(加入 `claude-review-runner.test.ts` 的 `parseClaudeReviewOutput` describe):

1. **FLY-1225 回归主测**:R2 fixture 包成 success 信封 → 解析结果非 null,`verdict==="APPROVED"`,`findings.length===0`,`reviewedHeadSha==="5f4c1165055fe901c43965af2109ec0df5b05635"`。(当前实现下红。)
2. R1 fixture → APPROVED(对照,当前已绿,防回归)。
3. 对抗组(当前实现全部红或未覆盖):
   - prose 含**不配对** `{`("the lone { character")+ 末尾合法 verdict → 解析成功;
   - 文本含**两个** verdict 对象(早处 `{"verdict":"APPROVED",…}` 示例 + 末尾 `{"verdict":"CHANGES_REQUESTED",…}`)→ 取**最后一个**(CHANGES_REQUESTED);
   - verdict JSON 前有一段**无关 fenced 代码块**(内含大括号)、verdict 本身不在 fence → 解析成功;
   - verdict 在 ```json fence 内、prose 前置含大括号 → 解析成功;
   - JSON 字符串值内含 `{`/`}`(如 finding.detail 写 "shape {p,m}")→ 正确解析,不被误配对;
   - 纯 prose 无任何 JSON → null;verdict 值非法(如 "MAYBE")→ null(fail-close 保持);
   - 错误信封(`is_error:true` / `api_error_status` / `subtype:"error_max_turns"`)且 result 内含合法 verdict → 仍 null(R12/R13/R14 组已有,补一条走新提取路径的确认)。

### 1.2 实现

`claude-review-runner.ts`:删除 `extractJsonObject`,新增 `extractVerdictObject(text: string): string | null`(模块内私有;若测试需要可 export 但优先通过 `parseClaudeReviewOutput` 测):

- **pass 1(顶层平衡扫描,O(n))**:单趟状态机扫全文——状态:`inString`(仅在大括号深度>0 时按 JSON 语义跟踪 `"` 与 `\` 转义)、`depth`、`spanStart`。`depth 0→1` 记起点;回落到 0 收一个候选 span。逐候选 `JSON.parse`;保留"是对象且 `verdict` 字段为字符串且 `.toUpperCase()` ∈ {APPROVED, CHANGES_REQUESTED}"者;**取最后一个命中**,返回其原文 span。
  - 注意:prose 里的 `"` 会污染 inString 判断——因此 inString 只在 depth>0 内启用,depth 0 的字符一律只看 `{`。若一个候选因 prose 不配对 `{` 被撑爆(吞掉了后面的 verdict),该候选 parse 失败,靠 pass 2 兜。
- **pass 2(verdict 关键字锚定,仅 pass 1 无命中)**:`indexOf('"verdict"')` 迭代(上限 32 处防病态输入);对每处向**前**找最近 `{`,从那里用同款状态机做一次前向平衡解析(此时起点已在对象内,inString 全程有效),成功且 verdict 字段合法者入候选;取最后一个。
- `parseClaudeReviewOutput` 中 `const candidate = extractJsonObject(text)` 一行换成 `extractVerdictObject(text)`;其余(信封校验、verdict/findings/sha 后置校验、`raw: text`)逐字不动。verdict 枚举校验在 parse 后仍执行一次(提取层与校验层各自独立成立)。
- 复杂度:pass 1 单趟 O(n);pass 2 ≤32 次锚定、每次前向扫描到配平即止;stdout 上限 8MB 下无病态放大。

### 1.3 验收

新增测试全绿;既有 20 例全绿零改动;`pnpm -F teamlead test` + 全仓 lint 绿。

## 2. Step 2 — stderr 捕获 + failure_raw 落库

### 2.1 runner 侧(claude-review-runner.ts)

- `SpawnResult` 加 `stderr: string`;spawner `stdio` 改 `["pipe","pipe","pipe"]`,stderr 有界收集:上限 16KB(超出丢**头**留**尾**——诊断文案在末尾),**不**触发 overflow 杀进程(只有 stdout 才有 8MB overflow 语义,维持不变)。
- `ClaudeReviewOutcome` failed 分支已有 `raw?`;新增 `stderrTail?: string`。各失败路径填充:`no_verdict`/`nonzero_exit` 带 `raw: stdout.slice(0,4000)`(no_verdict 已有,nonzero_exit 已有)+ `stderrTail: stderr.slice(-2000)`;`timeout`/`spawn_error`/`stdout_overflow` 至少带 `stderrTail`。
- 测试:stubbed spawner 各失败路径断言 stderrTail 透传;真子进程组加一例(missing-binary 或写 stderr 的脚本)断言捕获与截断(尾部保留)。

### 2.2 StateStore(StateStore.ts)

- `codex_review_job` 建表语句加列 `failure_raw TEXT`;并循库内既有幂等迁移先例对旧库做 additive `ALTER TABLE`(catch duplicate-column 或先查 PRAGMA table_info,与文件内现有迁移写法保持一致)。
- `failCodexReviewJob(requestId, reason, failureRaw?: string)`:第三参存在时写入(调用侧负责截断到 4000 字符);保持 done/skipped 不可降级守卫不变。`rowToCodexReviewJob` 与 `CodexReviewJob` 类型加字段。
- 测试:`StateStore` 测试加迁移幂等(旧 schema 库开两次不炸)+ fail 带 raw round-trip;既有 fail 双参调用零改动(第三参可选)。

### 2.3 coordinator 侧(review-request-coordinator.ts)

- runJob 失败分支:`failCodexReviewJob(requestId, outcome.reason, composeFailureRaw(outcome))`——组合 `raw` 尾部 + `stderrTail`(带 `STDOUT:`/`STDERR:` 标注,总长 ≤4000)。alert 文案追加一段 ≤300 字符的单行摘要(换行折叠为空格,messages 不用反引号)。
- 测试:coordinator 测试注入失败 outcome,断言 store 收到 raw、alert 含摘要。

## 3. Step 3 — reround prompt 修正

`buildPrompt(job, resume)`(coordinator:754-790)三形态:

1. **round 1**(现状不变):contract + target + "This is round 1."
2. **reround + resume=true**(改):contract + target + "Round N re-review — you reviewed this work before in THIS session and retain that context. Focus on whether your previous findings were correctly fixed and on anything new the changes introduced."——**删除** prior-findings 注入(`latestDoneCodexReviewJob` 调用整段移出该分支)。
3. **reround + resume=false**(新形态,链断/回落重建):contract + target + prior findings 注入**仅当** `latestDoneCodexReviewJob` 有记录;取不到时明说 "(no reliable record of your prior findings survives — treat this as a fresh, full review)",**不再伪造空数组**。

`buildPrompt` 签名已收 `resume`,无接口变化。Step 4 的回落路径会以 `resume=false` 重新调用它,天然落进形态 3。

测试(coordinator 测):三形态各一例断言 prompt 内容——形态 2 不含 "previous findings were"字样、含 in-this-session 措辞;形态 3 有 done 记录时注入其 findings_json,无记录时含 "no reliable record" 且不含 "[]"。

## 4. Step 4 — session-not-found 单次 fresh 回落

位置:coordinator.runJob,在 `outcome.kind === "failed"` 分支**之前**插入回落判定(或重构为内部 `runRound` helper 跑至多两次):

```
第一次 roundRunner 结果 = failed
  && 本次 resume === true
  && outcome.reason === "nonzero_exit"
  && SESSION_NOT_FOUND.test((outcome.stderrTail ?? "") + " " + (outcome.raw ?? ""))
→ 记 log("resume session lost — falling back to a fresh reviewer session (once)")
→ 新 uuid = randomUUID();setCodexReviewJobReviewerSession(requestId, 新uuid)   // 后续轮接新链
→ prompt = buildPrompt(job, /*resume=*/false)                                   // 形态 3
→ 第二次 roundRunner(resume=false, sessionId=新uuid,其余参数同)
→ 以第二次 outcome 走原有全部后续逻辑(gate 重验/head 重验/complete/respond)
```

- `SESSION_NOT_FOUND = /no conversation found with session id/i`(真机实测锚点,research.md §4.4;exit 1、文案在 stderr、秒败)。
- 硬上限一次/Job:第二次无论何种失败都进原 fail-close 分支(落 failure_raw、alert)。非 pattern 的 nonzero_exit(quota "hit your session/weekly limit"、崩溃)**不回落**。
- stop/关闭语义:两次尝试之间重查 `this.stopped`(与既有 R13 HIGH-3 收口一致),stopped 则直接按失败收场不再起第二个子进程。
- 每次尝试各自持有完整 30min timeout(liveness bound 针对单个子进程,不叠加预算)。

测试(coordinator,stub reviewRound):
- resume 轮 nonzero_exit + stderr 含锚文案 → 第二次以 resume=false + 新 uuid 调用,新 uuid 已持久化,第二次成功 → verdict 正常落库/送达;
- 第二次仍失败 → fail-close 一次,不再第三次;
- 非 pattern nonzero_exit → 不回落(reviewRound 只被调 1 次);
- round 1(resume=false)nonzero_exit → 不回落;
- 回落窗口中 stopped → 不起第二次。

## 5. Step 5 — timeout env 接线

plugin.ts coordinator 构造处(6032 附近):

```
reviewerTimeoutMs: parseReviewerTimeoutMs(process.env.FLYWHEEL_CLAUDE_REVIEW_TIMEOUT_MS)
```

`parseReviewerTimeoutMs`:未设/空 → `undefined`(runner 默认 30min 生效);数字化失败、非有限、<60_000 → `undefined` 并 console 警告一行(防误配秒杀审稿)。纯接线,不改默认值。测试:helper 单测四例(未设/合法/非法/低于下限)。

同步在本文件夹 research.md §5 已写明语义边界;实现 PR 描述里带一句:review timeout = 活跃子进程 liveness bound,与 FLY-1253 land-wait 的等待语义无关。

## 6. Step 6 — contract 措辞(一句)

`buildPrompt` 的 contract 末句 "No prose outside the JSON." 后追加:" Your very last line must be that JSON object itself."。防御纵深,不作为正确性依赖(Step 1 才是)。相关既有 prompt 断言测试若有逐字匹配需同步(只允许追加,不改既有语句)。

## 7. 测试与验收总表

- [ ] FLY-1225 R2 原文 fixture 回归:解析出 APPROVED + 正确 sha(交付 1 的 issue 验收项"历史 no_verdict 样本重放能解析出 verdict")
- [ ] R1 对照 + §1.1 对抗组全绿;既有 20 例 runner 测试零改动全绿
- [ ] 错误信封在新提取下仍拒收(fail-close 不松动)
- [ ] stderr 捕获/截断、failure_raw 迁移幂等 + round-trip、alert 摘要
- [ ] reround prompt 三形态断言
- [ ] session-not-found 回落五例(含单次上限与 stopped 收口)
- [ ] timeout env 接线四例
- [ ] `pnpm -F teamlead test` 全绿;全仓 `pnpm lint` 干净;coordinator 既有测试(gate/幂等/outbox/head)零回归
- [ ] Codex code review APPROVED;独立 QA(Claude Opus)按 FLY-1211 硬门执行——建议 QA 项:用生产 transcript 原文重放新旧解析器对比(旧 NULL/新 APPROVED)、真子进程 stderr 捕获、旧 teamlead.db 副本上迁移幂等

## 8. 明确不做(out of scope)

- `alertLead` 接入 FLY-927 alert funnel(plugin.ts 已标注 follow-up,MetaAlertReason 闭合 union)
- flywheel-land 30min 等待语义(FLY-1253/defect#7,另单)
- quota 治理/账号轮转(nonzero_exit quota 类照旧 fail-close,本单只让它可辨识)
- 常驻 reviewer 进程(companion 常驻形态):resume 已提供上下文保留与省 token 的实效(R2 仅 80 秒),进程常驻收益不明确且引入生命周期管理复杂度,YAGNI
- FLY-1198(RC-2 同族,冻结中)——本单证据可供其解冻时参考,不在此动

## 9. 风险与回退

| 风险 | 缓解 |
|---|---|
| 宽容提取误取候选(多 verdict 场景取错) | last-wins 语义 + APPROVED 仍需 sha 逐字回显(R12 HIGH-6 不动);对抗测试钉死 |
| 提取改动破坏既有样本 | 既有 20 例零改动作为字节兼容基线;CI 红即回退 |
| ALTER TABLE 迁移在旧库上出错 | 幂等写法循库内先例 + 双开测试;失败仅影响新列,读路径 `failure_raw` 可空 |
| 回落误触发(把 quota 当 session 丢失) | pattern 锚定唯一文案 + 只在 resume 轮 + 只一次;误触发代价 = 多一次 fresh 审稿轮,无正确性影响 |
| stderr pipe 引入背压挂死 | 有界收集持续消费 data 事件,不 pause;16KB 上限只截存不停读 |
| prompt 措辞变化影响既有断言 | 只追加不修改;测试同步 |

## 10. 交付物

- 实现 PR(同分支):上述 6 步 + 测试;commit/PR 英文;PR 描述含根因一段(引 research.md)与 Linear issue 链接
- 本文件夹三件套随分支合入 main
