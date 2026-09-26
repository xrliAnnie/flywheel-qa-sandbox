# FLY-2891 本地 Codex 评审逐轮写回 Bridge + 评审门校验模型 — 调研
Issue: FLY-2891 (https://linear.app/geoforge3d/issue/FLY-2891/病根修复-claude-线本地-codex-评审每一轮结论-评审模型写回-bridge设计-代码评审门校验模型-4)
日期: 2026-09-25
基于: exploration.md


> **2026-09-25 更正(plan v2,Codex R1 后)**:R4 的幂等键改为按 Codex 回合 id(turnId)而非「线程+轮号」;R5 的「CLI 冲刷 + 共享 spool 日志 + O_EXCL 锁」整段作废,改为「一条记录一个文件 + Bridge 常驻巡检代收」;R8(降级泛化)作废,按 Lead 更正改为删除降级;R9 的指标定义改为 plan §4.7 的共享归一化定义。以 plan.md 为准。

本文把 exploration 里选中的方向(A1 + B2 + C1/C2/C3 + D,外加 Lead 追加的 ④⑤)逐项落到「能不能做、用什么已有零件、有什么坑」。

## R1. 实际评审模型:读 Codex rollout 是否可靠

**事实(本机实测 2026-09-25)**
- 文件位置:`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`;评审技能在收尾会 archive 线程 ⇒ 文件移到 `$CODEX_HOME/archived_sessions/`。两个根都要搜。`CODEX_HOME` 未设时为 `~/.codex`(companion 进程继承 runner 的 env,所以门与 companion 看到的是同一个家)。
- 第一行是 `session_meta`,`payload.id` = threadId(可用来防「文件名碰巧含这个串」)。
- 每个回合有一行 `turn_context`,`payload.model` / `payload.effort` / `payload.turn_id` 齐全(实测 `gpt-5.6-sol` / `xhigh`)。`--resume-last` 续轮时每次 `task` 调用是一个新回合,且**可以换模型**(`thread/resume` 与 `turn/start` 都带 model)。
- 仓内先例:`lead-turn-evidence.ts:51-110`(O_NOFOLLOW、realpath 限定在 sessions/archived_sessions 之下、只读尾部 256KB、只认换行结尾的完整 JSONL 行)、`codex-rollout-probe.ts:10-35`(按 threadId 找最新文件)。

**结论**:可靠。「本轮的实际模型」= rollout 最后一行 `turn_context` 的 model/effort。flywheel-comm 不依赖 claude-runner / teamlead 包,所以在 flywheel-comm 内新写一个约 80 行的只读读取器,照搬上面两处的安全约束(路径限定、不跟软链、尾部有界读取、半行不算数)。
**坑**:
- 大 rollout(几十 MB)——只读尾部,找不到 turn_context 时再向前扩一次到 4MB 上限,仍找不到则判「无法核实」。
- 自定义 `CODEX_HOME`(FLY-2358 的隔离家):门与 companion 同 env,天然一致;runner 若手动换家跑评审,门会报「找不到 rollout」——这是正确的 fail-closed,报错文字写明查找的根。
- 不是防恶意:runner 能伪造 rollout。4 例都是「无意用错默认模型」,本设计针对的是无意错误;这一边界写进 plan。

## R2. 要求模型:服务端从哪取

- 设计:`review_model_routed` 事件的 eventUid = `review_model_routed:<run>:<node>:design:<requestId>`(`workflow-review-routing.ts:104`),requestId 就是当前 manifest 的 `request_id` ⇒ 精确对上。
- 代码:`event-route.ts:629` 用 `requestId: event.event_id`(pr_created 事件),runner 不知道这个 id。取「该 execution 最新一条 reviewType=code 的 review_model_routed」即可;没有就当场 `resolveWorkflowReviewRouteForExecution(store, exec, "code")` 重算(纯函数,输入是不可变的 runtime 行)。
- 非工作流运行(snapshot 无 `modelRouting`):无要求模型 ⇒ 只记录、不比对。
- 比对规则:`observedModel === requiredModel` 且 `observedEffort === requiredEffort`。模型比对用精确 id(rollout 里是 canonical id,如 `gpt-6-astra`;路由里 `MODEL_IDS.*` 也是 canonical id)。别名(`astra`)不会出现在两侧,但比对前仍经 `getModelConfigSnapshot().getDispatchCanonical` 归一以防将来路由写别名。

## R3. Bridge 写入口:新路由还是走 /events

- `/events` 会先 `insertEvent` 进事件表再分发,且 FLY-827 的 `codex_review_result` 已占用那条语义(只收 code+APPROVED)。逐轮记录是评估数据,不是会话事件;塞进 `/events` 会把每轮都变成 session 事件、影响事件相关的派生刷新。
- **选新路由 `POST /review-rounds`**,与 `/design-review-validation` 同款:`tokenAuthMiddleware(config.ingestToken)`;token 未配置时 503(不继承无 token 放行的旧行为)。
- 身份校验:body 的 `executionId` 必须是 StateStore 里存在的 session,且 `project_name` 与 session 一致;issue / run / node 由服务端从 session 与 `getWorkflowRunNodeForExecution` 取,**不信**客户端给的 issue/run。
- 输入边界:reviewType ∈ {design, code};verdict ∈ {APPROVED, CHANGES_REQUESTED};round 为 1..200 的整数;各级条数 0..10000 整数或缺省;字符串字段长度上限(model 128、threadId 128、target 512);sha 必须 40-hex;时间戳必须可解析且不在未来 >60s。全部参数化 SQL。
- 存储:新子 store `bridge/review-round-store.ts`(仿 `codex-quota-store.ts` 的 `migrate()` + StateStore getter 模式,`StateStore.ts:3261, 6731`),避免再往 9 万行的 StateStore.ts 里塞表。
- 保留分类:新表需要 `scripts/lib/fly-2006-retention-tables/teamlead/review_round_record.json`,分类 `protectedCurrentOrReference`(评估参考数据,同 `workflow_scorecard_turn`);否则 Quick Gate `schema_unclassified`(见记忆 reference_new_statestore_table_needs_retention_fragment)。

## R4. 幂等与轮次身份

- 自然键:`(execution_id, review_type, codex_thread_id, round)`。同一轮重投(重试账冲刷、门的补写)命中同一键 ⇒ `INSERT … ON CONFLICT DO UPDATE` 只在内容不同时更新并把 `revision_count+1`,相同则 no-op。
- 为什么带 threadId:`--fresh` 重开线程时 runner 可能从 1 重新数轮;不同线程的「第 1 轮」是不同的轮。报表按 `reviewed_at` 排序全组,不依赖跨线程的轮号连续。
- 门补写的最终轮:`round = result.rounds`,`source = 'gate'`;若 runner 已用 `source='cli'` 写过同键,门的补写只补 `gate_accepted_at`,不覆盖 runner 写的条数。

## R5. 非阻塞 + 重试账

- CLI 投递:单次 fetch 超时 2s,最多 2 次尝试(间隔 300ms);失败即追加一行到 `$FLYWHEEL_STATE_DIR ?? ~/.flywheel/state` 下 `review-round-spool/<execId>.jsonl`(0600),打印 `WARN review round not delivered — spooled for retry`,**退出码 0**。
- 冲刷点:每次 `review-round` 与 `await-codex-gate` 开头先冲刷该 exec 的 spool(按行,成功即删行,原子重写临时文件+rename)。
- 告警:门放行时若 spool 仍非空 ⇒ 写 `review-round-delivery-failed` 标记文件(与 FLY-827 `codex-review-result-failed` 同目录同格式)并在 stdout 打一行 `WARN`;报表对该组标 `coverage=incomplete`。不新增 Discord 告警通道(沿用标记文件,Lead 巡检已读该目录——若没读,见 plan 的边界)。
- 时延预算:每轮额外 = rollout 尾读(<50ms)+ 一次本机 HTTP(<50ms 正常,最坏 2×2s 后落盘)。相对一轮 Codex xhigh 评审(分钟级)可忽略 ⇒ 满足验收 4。

## R6. stage set 同步返回 manifest

- Bridge 在 `res.json` 之前已同步跑完 `applyStageEvent → handleCodexAutoTrigger → advanceDesignReviewManifest`(`event-route.ts:3402-3404, 895-903`),可以用 `store.getDesignReviewManifestForSourceEvent(event.event_id)`(`StateStore.ts:21437`)取到本事件铸的 manifest,重放(duplicate)时同样按 source event 取,不会拿到别次的。
- 响应追加 `designReview: {requestId, revision, planPath, reviewedPlanBlobSha, reviewerModel?, reviewerEffort?}`;客户端 `postStageEvent` 透传,`stage` 命令打印并写 `.flywheel/runs/<exec>/codex/design-request.json`。
- 泄露顾虑:`design-review-validation.ts:19` 的「拒绝时不回显期望值」针对的是**校验失败**时防猜;这里回给的是同一个持 ingest token 的 runner、且与信箱指令里本就下发的值相同,不扩大暴露面。
- 延迟发送(Bridge 不可达、事件入队后补发)时拿不到回执 ⇒ CLI 打印「manifest 待投递,见 inbox」;兜底是 C2(门校验)与 C3(首轮回执告警)。

## R7. 分流 arm 的 effort(④)

- `parseWeightedModelSplit`:arm 允许可选 `effort`,值须 ∈ `WorkflowEffort` 全集 `low|medium|high|xhigh|max`(`workflow-template.ts:33`;config 包不能反向依赖 teamlead,故在 `model-split.ts` 内声明同值常量,并加一条类型级测试保证两处一致);未知值直接抛错(配置加载即拒,`model-config.ts:216` 会把整个分流标 invalid ⇒ 派发 `MODEL_SPLIT_CONFIG_INVALID`,这是现有 fail-closed 通道)。
- **版本号兼容**:冻结的 arm 对象只在写了 effort 时才带 `effort` 键 ⇒ 未写 effort 的现网配置 `JSON.stringify(semantics)` 字节不变 ⇒ `fly2788-v1:<sha>` 不变,历史 assignment 重放(`assertWeightedModelAssignment`)不受影响。需要一条回归测试钉住现网配置的版本号。
- 生效点:`workflow-menu.ts:970` 取 effort 时,若本节点是自动分流且 arm 带 effort 且调用方没显式覆盖 effort ⇒ 用 arm.effort;随后原有 `allowedEfforts` 检查会**拒绝**该模型不支持的档位(`EFFORT_NOT_ALLOWED_FOR_MODEL`,可读原因)。启动时的 `narrowEffort` 保持原样作最后一道(只会在模型能力表变化时触发)。
- 调用方显式 effort 与 arm effort 冲突:沿用模型冲突的处理风格——显式覆盖优先(调用方是人工指定),receipt 如实记录。
- 可见性:receipt 的 `effort` 已随 `receipts[node.id]` 输出;assignment 冻结收据里的 `basis.nodes` 自带 arm.effort,可审计;`design-model-split.mjs show` 每档打印 `effort=<值>` 或 `effort=inherit(<节点模板默认>)`。

## R8. 额度降级泛化(⑤)

- 现条件:arm 名 ∈ {impl_sol56, impl_sol6} 且存在 arm `impl_opus`/model `opus`。
- 新条件:`nodeId === "implement"` 且 weighted 分流、**被分到的 arm 解析后 vendor === "codex"**(用 `resolution.dispatch.vendor`,即已解析的真实派发,不看 arm 名),且策略里存在某个 `model === "opus"` 的 arm(不绑定 arm 名)。其余(额度事实、Opus 5.5 注册与 xhigh 支持)不变。
- 读侧 `readScorecardDegradation` 不看 arm 名,只核 assignment 与 payload 一致 ⇒ 无需改。
- 测试:Astra arm(model `astra` → vendor codex)额度满 → Opus xhigh + degradation 收据;opus arm 不降级;无 opus arm 的策略不降级;额度未满不降级。

## R9. 报表

- `workflow-scorecard-report.ts` 在每个 issue 上新增 `designReview` / `codeReview`:`{firstPass: boolean|null, roundsToApproval: number|null, reviewerModels: string[], source: "bridge_job"|"local_round", coverage: "complete"|"final_only"|"incomplete"|"none"}`。
  - Codex 作者(Astra 线):读 `codex_review_job`(status='done',verdict ∈ APPROVED/CHANGES_REQUESTED),按 round 排序;模型取同 requestId 的 `review_model_routed` 事件(没有则 null)。
  - Claude 作者:读 `review_round_record`,按 `reviewed_at, round` 排序;`roundsToApproval` 取被门接受那轮(`gate_accepted_at` 非空)的序号,若无门记录则取最后一个 APPROVED。
  - 覆盖度:收到的轮数 == 最终轮号 ⇒ complete;只有门补写的一行 ⇒ final_only(首轮通过与轮数仍可算);介于其间 ⇒ incomplete。
- 分组聚合:`designFirstPass`/`codeFirstPass` 用 `{numerator, denominator, rate}`(与 `qaFirstPass` 同形),`designRoundsMean`/`codeRoundsMean` 用 `mean()`;CLI 文本行追加 `design_first_pass=a/b design_rounds_mean=x code_first_pass=… code_rounds_mean=…`。
- 旧脚本 `scripts/fly2403-design-model-comparison.sql` 不动(历史复现用),在 plan 里注明其 Claude 线口径已被取代。

## R10. 受影响的消费者清单(改动前 git grep 确认)
- `await-codex-gate` 结果 schema:生产者 = Bridge 指令文字(`codex-instruction.ts`)+ runner;消费者 = `await-codex-gate.ts`、`/design-review-validation`。新增必填 `reviewerModel`/`reviewerEffort`/`codexThreadId`/`rounds` 是**收紧**:旧 runner 写的旧格式结果会被拒——在飞的设计/实现体升级后第一次过门会收到可读的缺字段错误,补写即可。上线时机由 Lead 选空窗(plan 写明)。
- `/design-review-validation` body:新增字段为可选输入,老客户端不带时 Bridge 判「缺实际模型」拒绝——同上,属有意收紧。
- `WeightedModelSplitArm` 类型:消费者 `model-config.ts`、`workflow-model-assignment.ts`、`workflow-menu.ts`、`scripts/design-model-split.mjs`、测试;加可选字段不破坏类型。
- `applyImplementQuotaDegradation`:仅 `resolveNodeDispatchAtLaunch` 调用。
- 不删除、不改名任何 `flywheel-comm` 子命令(只新增 `review-round`),不触发 FLY-1914 的消费者 sweep 要求。
