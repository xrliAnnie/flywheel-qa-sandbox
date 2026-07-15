# FLY-1254 跨厂商审查 no_verdict 查因 + 修 — 实施计划

Issue: FLY-1254 (https://linear.app/geoforge3d/issue/FLY-1254/fix-跨厂商审查-no-verdict-查因-修审稿人跑完但结论解析不出)
日期: 2026-07-14
基于: research.md

> 执行者:三段式 Implement 阶段(Codex gpt-5.6-sol xhigh),同分支 `flywheel-FLY-1254`。TDD:每步先写红测再实现。全程不改 §7.1/7.2 的 fail-close 语义与 R12-R16 加固。兼容基线的准确表述(Codex design review R1 #6):R12-R16/安全类断言与既有行为覆盖**不许削弱**;两处**有意替换**除外——reround prompt 的 prior-findings 断言(Step 3 有意改变该行为)与 `SpawnResult` stub 补 `stderr` 字段的机械更新。除此之外不许改断言迁就实现。

## 0. 变更总览

| # | 变更 | 文件 | 性质 |
|---|---|---|---|
| 1 | verdict 锚定宽容提取(修 no_verdict 根因) | claude-review-runner.ts | 核心 |
| 2 | stderr 有界捕获 + 失败 raw 落库 `failure_raw` | claude-review-runner.ts · StateStore.ts · review-request-coordinator.ts | 观测 |
| 3 | reround prompt:resume 轮去 findings 注入;fresh 重建轮如实声明 | review-request-coordinator.ts | 正确性 |
| 4 | resume session 丢失 → pattern-gated 单次 fresh 回落 | review-request-coordinator.ts | 韧性 |
| 5 | 30min 默认保留 + `FLYWHEEL_CLAUDE_REVIEW_TIMEOUT_MS` env 接线 | plugin.ts | 接线 |
| 6 | contract prompt 追加末行约束(一句) | review-request-coordinator.ts | 辅助 |

不改:信封校验语义(R12-R14,**唯一例外 = §1.2.0 的判定加固**——比现状更严,绝不更松)、gate 绑定/重验、head 冻结/回显(R12 HIGH-6)、authority 顺序(R15)、outbox、调度(串行/并发 2)、`DEFAULT_TIMEOUT_MS=30min`、`DEFAULT_REVIEW_EFFORT=xhigh`、默认 model。

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
   - 错误信封(`is_error:true` / `api_error_status` / `subtype:"error_max_turns"`)且 result 内含合法 verdict → 仍 null(R12/R13/R14 组已有,补一条走新提取路径的确认);
   - **信封判定加固组(Codex R1 #1,必须红→绿)**:错误信封的 `result` 为**非字符串**(对象/数组,内嵌合法 verdict 对象,如 `{"type":"result","subtype":"error_max_turns","is_error":true,"result":{"payload":{"verdict":"APPROVED",…}}}`)→ null;整个 stdout 是合法 JSON 对象、带任一信封判别键但非精确 success 形态 → null;整个 stdout 是合法 JSON 对象、无信封判别键、顶层无合法 verdict 字段(verdict 只在嵌套层)→ null(不向整体 JSON 内部递归);顶层裸 verdict 对象(现状已支持)→ 继续解析。

### 1.2 实现

**1.2.0 信封判定先加固(Codex R1 #1——宽容提取的前置条件,防止回落绕过 R12-R14 边界)**:现行信封分支只在 `typeof envelope.result === "string"` 时才做 success 形态校验;`result` 为对象/数组的错误信封会漏过分类,再被下面的 pass 2 从嵌套里捡走 verdict。改为:若整个 stdout 能 `JSON.parse` 出一个对象——
- 精确 success 信封(`type==="result"` 且 `subtype==="success"` 且非 `is_error` 且 `api_error_status` 为 null/undefined 且 `result` 为字符串)→ `text = result`,继续走提取;
- 该对象带**任一**信封判别键(`type`/`subtype`/`is_error`/`api_error_status`/`result`)但不满足上一条 → 直接返回 null(不进任何提取 pass);
- 该对象顶层有合法 verdict 字段(裸 verdict 对象,现状已支持)→ 照常解析;
- 其他整体 JSON 对象(无判别键、verdict 只在嵌套层)→ 返回 null,**不向整体 JSON 内部递归**。
宽容提取只作用于"非整体 JSON 的 assistant 文本"(即真实事故形态:prose + JSON 混排);安全边界 = 外层 CLI 信封,assistant 文本里被引用的信封形状字符串不构成边界(pass 1 对其 parse 后无顶层 verdict 字段,天然不是候选)。

`claude-review-runner.ts`:删除 `extractJsonObject`,新增 `extractVerdictObject(text: string): string | null`(模块内私有;若测试需要可 export 但优先通过 `parseClaudeReviewOutput` 测):

- **pass 1(顶层平衡扫描,O(n))**:单趟状态机扫全文——状态:`inString`(仅在大括号深度>0 时按 JSON 语义跟踪 `"` 与 `\` 转义)、`depth`、`spanStart`。`depth 0→1` 记起点;回落到 0 收一个候选 span。逐候选 `JSON.parse`;保留"是对象且 `verdict` 字段为字符串且 `.toUpperCase()` ∈ {APPROVED, CHANGES_REQUESTED}"者;**取最后一个命中**,返回其原文 span。
  - 注意:prose 里的 `"` 会污染 inString 判断——因此 inString 只在 depth>0 内启用,depth 0 的字符一律只看 `{`。若一个候选因 prose 不配对 `{` 被撑爆(吞掉了后面的 verdict),该候选 parse 失败,靠 pass 2 兜。
- **pass 2(verdict 关键字锚定,仅 pass 1 无命中)**:`indexOf('"verdict"')` 迭代(上限 32 处防病态输入);对每处向**前**找最近 `{`,从那里用同款状态机做一次前向平衡解析(此时起点已在对象内,inString 全程有效),成功且 verdict 字段合法者入候选;取最后一个。
- `parseClaudeReviewOutput` 中 `const candidate = extractJsonObject(text)` 一行换成 `extractVerdictObject(text)`;信封分支按 §1.2.0 加固,其余(verdict/findings/sha 后置校验、`raw: text`)逐字不动。verdict 枚举校验在 parse 后仍执行一次(提取层与校验层各自独立成立)。
- 复杂度:pass 1 单趟 O(n);pass 2 ≤32 次锚定、每次前向扫描到配平即止;stdout 上限 8MB 下无病态放大。

### 1.3 验收

新增测试全绿;既有 20 例中除 §0 所述两处有意替换外全绿不削弱;`pnpm --filter flywheel-teamlead test`(workspace 包名是 flywheel-teamlead,`-F teamlead` 匹配不到)+ 根目录 `pnpm lint` 绿。同步更新两处过时注释(Codex R1 #6):claude-review-runner.ts 头部第 7-8 行"R2+ = delta + prior findings"与 coordinator 里 `latestDoneCodexReviewJob` 相关注释,改为与 Step 3 的三形态一致。

## 2. Step 2 — stderr 捕获 + failure_raw 落库

### 2.1 runner 侧(claude-review-runner.ts)

- `SpawnResult` 加 `stderr: string`;spawner `stdio` 改 `["pipe","pipe","pipe"]`,stderr 有界收集:上限 16KB(超出丢**头**留**尾**——诊断文案在末尾;持续消费 data 事件只截存不停读,防背压),**不**触发 overflow 杀进程(只有 stdout 才有 8MB overflow 语义,维持不变)。
- `ClaudeReviewOutcome` failed 分支已有 `raw?`;新增 `stderrTail?: string`。各失败路径填充:`no_verdict`/`nonzero_exit` 带 `raw: stdout.slice(-4000)`(**改为取尾**,Codex R1 #2:no_verdict 的关键证据——verdict 行——恰在末尾;既有两处 `slice(0,4000)` 一并改)+ `stderrTail: stderr.slice(-2000)`;`timeout`/`spawn_error`/`stdout_overflow` 至少带 `stderrTail`。
- 测试:stubbed spawner 各失败路径断言 stderrTail 透传 + raw 取尾(长文本下末尾内容保留);真子进程组加一例(missing-binary 或写 stderr 的脚本)断言捕获与截断(尾部保留)。

### 2.2 StateStore(StateStore.ts)

- `codex_review_job` 建表语句加列 `failure_raw TEXT`;旧库迁移(Codex R1 #3,**不许宽 catch 吞错**):先 `PRAGMA table_info(codex_review_job)` 查列,缺才 `ALTER TABLE ADD COLUMN`;仅当需要支持并发启动竞态时才容忍 duplicate-column 这一种特定错误,**其余迁移错误一律 rethrow 让启动响亮失败**(列缺失时写路径会持续报错,静默吞错=带病运行)。迁移测试断言列真实存在。
- **`failure_raw` 生命周期 = "最近一次尝试的失败证据"(Codex R1 #2)**:①`claimCodexReviewJobRunning` 置 running 时同时清 `failure_reason=NULL, failure_raw=NULL`(开跑即不再是"当前失败");②每次 `failCodexReviewJob(requestId, reason, failureRaw?)` **覆写** `failure_raw`(有值写值、无值写 NULL,绝不残留上一次的);③`completeCodexReviewJob` 现已清 `failure_reason`,同步加 `failure_raw=NULL`。保持 done/skipped 不可降级守卫不变。`rowToCodexReviewJob` 与 `CodexReviewJob` 类型加字段。
- 测试:迁移幂等(旧 schema 库开两次不炸 + 列存在断言);fail-带-raw → complete 后两列皆空;fail-带-raw → 再 fail-不带-raw 后 raw 为 NULL(覆写不残留);claim 清场;既有 fail 双参调用零改动(第三参可选)。

### 2.3 coordinator 侧(review-request-coordinator.ts)

- runJob 失败分支:`failCodexReviewJob(requestId, outcome.reason, composeFailureRaw(outcome))`——组合 `raw` 尾部 + `stderrTail`(带 `STDOUT:`/`STDERR:` 标注,总长 ≤4000);Step 4 回落场景下两次尝试都失败时,两段证据都进组合(标注 attempt 1 resume / attempt 2 fresh,各自截半)。alert 文案追加 ≤300 字符**已消毒**摘要(Codex R1 #2:审稿人输出当不可信文本——折叠为单行、剥控制字符/反引号/@提及;完整诊断尾留在 DB,alert 只给线索)。
- 测试:coordinator 测试注入失败 outcome,断言 store 收到组合 raw、alert 摘要已消毒(含控制字符/反引号样本);双尝试皆败时两段证据都在。

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
→ 前置重验(Codex R2 #2:先验后写,回落放弃时不留未用 uuid 污染 resume 链):
    stopped? → 按失败收场;gateStillOpen 不成立 → gate_answered_externally 收场;
    code 类重导 head ≠ frozen → head_moved 收场
→ 记 log("resume session lost — falling back to a fresh reviewer session (once)")
→ 新 uuid = randomUUID();setCodexReviewJobReviewerSession(requestId, 新uuid)   // 后续轮接新链
→ prompt = buildPrompt(job, /*resume=*/false)                                   // 形态 3
→ 第二次 roundRunner(resume=false, sessionId=新uuid,其余参数同)
→ 以第二次 outcome 走原有全部后续逻辑(gate 重验/head 重验/complete/respond)
```

- `SESSION_NOT_FOUND = /no conversation found with session id/i`(真机实测锚点,research.md §4.4;exit 1、文案在 stderr、秒败)。
- **回落作用域的精确表述(Codex R1 #5)**:上限是"**每次 runJob 调用**至多一次",不是"每个 durable job 终生一次"——不加新持久化列。推论(有意为之、需在代码注释写明):新 uuid 持久化后、fresh spawn 前崩溃 → boot redrive 重跑该 job,round≥2 + 新 uuid → resume 新 uuid;若新 session 也不存在(从未 spawn 过)→ 再次命中 pattern → 再回落一次。每轮 runJob 内收敛,无循环风险。
- 第二次 spawn 前重验(Codex R1 #5,防第一次尝试期间世界已变还烧 30 分钟;**在生成/持久化新 uuid 之前执行**,Codex R2 #2):重查 `this.stopped`(R13 HIGH-3 同款收口)+ `gateStillOpen`(gate 已被外答/过期 → 按 `gate_answered_externally` 收场,不起第二个子进程)+ code 类重导 head 与 frozen 比对(动了 → `head_moved` 收场)。第二次尝试完成后的**终局重验链保持原样不动**。
- 硬上限一次/runJob:第二次无论何种失败都进原 fail-close 分支(落 failure_raw、alert,两段证据见 Step 2.3)。非 pattern 的 nonzero_exit(quota "hit your session/weekly limit"、崩溃)**不回落**。
- 回落成功路径复用原有 complete→respond→authority 全链,**不新增任何送达机制**(outbox/终局写入路径唯一)。
- 每次尝试各自持有完整 30min timeout(liveness bound 针对单个子进程,不叠加预算)。

测试(coordinator,stub reviewRound):
- resume 轮 nonzero_exit + stderr 含锚文案 → 第二次以 resume=false + 新 uuid 调用,新 uuid 已持久化,第二次成功 → verdict 走既有 complete/respond/outbox 路径落库送达;
- 第二次仍失败 → fail-close 一次,不再第三次;
- 非 pattern nonzero_exit → 不回落(reviewRound 只被调 1 次);
- round 1(resume=false)nonzero_exit → 不回落;
- 回落窗口中 stopped → 不起第二次;
- 回落窗口中 gate 被外答 → 不起第二次,按 gate_answered_externally 收场;code 类 head 移动 → head_moved 收场;
- **boot-redrive 一例(Codex R1 #5)**:模拟"新 uuid 已持久化、fresh 未 spawn 即崩"→ redrive 后 job 以新 uuid resume 重跑,仍到达既有终局写入/outbox 路径,无第二套送达。

## 5. Step 5 — timeout env 接线

plugin.ts coordinator 构造处(6032 附近):

```
reviewerTimeoutMs: parseReviewerTimeoutMs(process.env.FLYWHEEL_CLAUDE_REVIEW_TIMEOUT_MS)
```

`parseReviewerTimeoutMs`:未设/空 → `undefined`(runner 默认 30min 生效);其余仅接受**有限安全整数**且落在 `[60_000, 2_147_483_647]`(Codex R1 #4:Node 定时器 32 位上限,超过会被折成 1ms——本机实测 `setTimeout(…,3000000000)` 触发 TimeoutOverflowWarning 并 1ms 触发;小数、非数、越界一律 console 警告一行并返回 `undefined` 回默认)。纯接线,不改默认值。测试:helper 单测六例(未设/合法/非数/小数/低于下限/超 32 位上限)。

同步在本文件夹 research.md §5 已写明语义边界;实现 PR 描述里带一句:review timeout = 活跃子进程 liveness bound,与 FLY-1253 land-wait 的等待语义无关。

## 6. Step 6 — contract 措辞(一句)

`buildPrompt` 的 contract 末句 "No prose outside the JSON." 后追加:" Your very last line must be that JSON object itself."。防御纵深,不作为正确性依赖(Step 1 才是)。相关既有 prompt 断言测试若有逐字匹配需同步(只允许追加,不改既有语句)。

## 7. 测试与验收总表

- [ ] FLY-1225 R2 原文 fixture 回归:解析出 APPROVED + 正确 sha(交付 1 的 issue 验收项"历史 no_verdict 样本重放能解析出 verdict")
- [ ] R1 对照 + §1.1 对抗组全绿;既有 runner 测试除 §0 两处有意替换外不削弱
- [ ] 错误信封在新提取下仍拒收,含**非字符串 result 嵌套 verdict** 加固组(fail-close 不松动)
- [ ] stderr 捕获/截断、raw 取尾、failure_raw 迁移(fail-loud)+ 生命周期(claim 清/fail 覆写/complete 清)、alert 摘要消毒
- [ ] reround prompt 三形态断言 + 两处过时注释更新
- [ ] session-not-found 回落全组(单次上限/stopped/gate 外答/head 移动/boot-redrive/送达路径唯一)
- [ ] timeout env 接线六例(含 32 位上界)
- [ ] `pnpm --filter flywheel-teamlead test` 全绿;根目录 `pnpm lint` 干净;coordinator 既有测试(gate/幂等/outbox/head)零回归
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
| 宽容提取绕过信封边界(嵌套 verdict 的错误信封) | §1.2.0 信封判定先加固:整体 JSON 带判别键即全量校验,失败即 null;加固组测试红→绿 |
| 提取改动破坏既有样本 | 既有用例除 §0 两处有意替换外作为兼容基线;CI 红即回退 |
| ALTER TABLE 迁移在旧库上出错 | PRAGMA 查列 + 缺才加 + 非预期错误 rethrow 响亮失败(不带病运行);双开幂等测试 + 列存在断言 |
| 回落误触发(把 quota 当 session 丢失) | pattern 锚定唯一文案 + 只在 resume 轮 + 每 runJob 一次 + spawn 前 gate/head/stopped 重验;误触发代价 = 多一次 fresh 审稿轮,无正确性影响 |
| stderr pipe 引入背压挂死 | 有界收集持续消费 data 事件,不 pause;16KB 上限只截存不停读 |
| prompt 措辞变化影响既有断言 | 只追加不修改;测试同步 |

## 10. 交付物

- 实现 PR(同分支):上述 6 步 + 测试;commit/PR 英文;PR 描述含根因一段(引 research.md)与 Linear issue 链接
- 本文件夹三件套随分支合入 main
