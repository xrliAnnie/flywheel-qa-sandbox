# FLY-2891 本地 Codex 评审逐轮写回 Bridge + 评审门校验模型 — 探索
Issue: FLY-2891 (https://linear.app/geoforge3d/issue/FLY-2891/病根修复-claude-线本地-codex-评审每一轮结论-评审模型写回-bridge设计-代码评审门校验模型-4)
日期: 2026-09-25
基于: 无

## 1. 问题陈述(founder 视角)

founder 在 FLY-2889 模型报告页问:为什么 Claude 线的设计师「首轮 approve」和「通过轮数」拿不到,Astra 线却拿得到?

答案一句话:**Astra 线(Codex 作者)的评审由 Bridge 自己跑,每轮落 `codex_review_job` 一行;Claude 线(Claude 作者)的评审由 runner 在工作目录里本地跑 codex-companion,结论只写进工作目录的一个 JSON,Bridge 最多只收到「代码评审最终 APPROVED」一条(FLY-827),设计评审则一条都不收。** 工作目录一删,数据就没了。

同一个根上还长着第二个问题(本单 class_key 的 4 例):评审门 `await-codex-gate` 从不核「是哪个模型评的」,于是设计节点在 manifest(Bridge 下发的评审请求)还没到信箱之前就用本机默认模型 gpt-5.6-sol 起评审,写个 APPROVED,门照样放行——而路由要求的是 gpt-6-astra。

Lead 范围追加(2026-09-25 15:14 PDT,founder 15:13 原话):④ 分流配置每个 arm 可选 effort;⑤ implement 节点任何 Codex 档额度满都降级 Opus。

## 2. 现状审计(带文件行号)

### 2.1 评审门 `await-codex-gate`
- `packages/flywheel-comm/src/commands/await-codex-gate.ts:151-219` `validateResult`:只核 executionId / reviewType / status / reviewedTarget / timestamp,设计另核 requestId + reviewedPlanBlobSha,代码另核 reviewedHeadSha == HEAD。**无任何模型字段。**
- 设计评审再调 Bridge `/design-review-validation`(`:270-326`);代码评审通过后 best-effort 调 `emitCodexReviewResult`(`:343-368`)。
- 结果 schema 由 Bridge 指令文字规定:`packages/teamlead/src/bridge/codex-instruction.ts:37-104`。唯一提到模型的是一句话 `Use the server-selected reviewer model X at Y effort; do not substitute another model.`(`:50`),**不在 schema 里**。

### 2.2 manifest 与路由
- 路由:`packages/teamlead/src/workflow-review-routing.ts:11-34`——Claude 作者 → Codex 评审,设计 `gpt-6-astra`、代码 `gpt-5.6-sol`,effort 一律 xhigh;仅对带 `modelRouting` 的工作流运行生效(`:36-85`),其他运行不指定模型。
- 路由的唯一持久记录:`recordWorkflowReviewRoute` 写一条 `workflow_run_event` kind=`review_model_routed`,payload 含 requestId / reviewerModel / reviewerEffort(`:86-120`)。设计在 `design-review-manifest.ts:233-245` 写,代码在 `event-route.ts:624-635` 写(requestId = pr_created 事件 id)。
- `design_review_manifest` 表(`StateStore.ts:11653-11668`)**没有模型列**;manifest 经 CommDB 信箱投递(`design-review-manifest.ts:217-277`),runner 下次轮询收件箱才看到。
- `stage set design_review` 的 HTTP 响应在 manifest 行已写入 StateStore 之后才返回(`event-route.ts:3402-3404, 3874-3881`),但响应体只有 `{ok, applied, duplicate}`,CLI 只打印 `Stage: design_review`(`flywheel-comm/src/commands/stage.ts:226-228`)。⇒ **顺序竞态的根**:runner 不等信箱就开评,开评时不知道要用哪个模型。
- 代码评审的 hold 重投 `queueCodexCodeReviewInstructionResult`(`codex-instruction.ts:161`)不带路由 ⇒ 重投的指令连那句模型提示都没有。

### 2.3 Bridge 现有评审数据
- Astra 线:`codex_review_job`(`StateStore.ts:11919-11961`),一轮一行,`round` 由服务端按 (execution, reviewType, identity) 计数 +1(`review-request-coordinator.ts:1069-1073`),verdict / findings_json 齐全。**模型、effort 也不是列**,只在 `review_model_routed` 事件里(且只对 Claude 评审者写,`review-request-coordinator.ts:1574`)。
- Claude 线:只有 FLY-827 的 `codex_review_record`(`StateStore.ts:11791-11819`),一 head 一行、只记 APPROVED、`rounds` 是 runner 自报的整数,无模型、无逐轮、无 CHANGES_REQUESTED;设计评审**零记录**(`/design-review-validation` 连 rounds / codexThreadId 都丢)。

### 2.4 报表
- `packages/teamlead/src/workflow-scorecard-report.ts` **不算任何评审指标**;唯一的首轮通过是 QA(`:763`)。按 arm 分组(`:171-250`),CLI 打印 `qa_first_pass` / `founder_reject`(`workflow-scorecard-cli.ts:47-52`)。
- 唯一的评审轮数对比是独立脚本 `scripts/fly2403-design-model-comparison.sql`:Astra 线用 `codex_review_job.round`,Claude 线用 `MAX(design_review_manifest.revision)`——后者数的是「重进 design_review 的次数」,不是 Codex 实际轮数,**两条线口径不可比**。

### 2.5 「实际模型」从哪来
- codex-companion(`~/.claude/plugins/cache/openai-codex/codex/1.0.0/scripts/codex-companion.mjs:706-716`)接受 `--model`,但**不记录**解析后的模型;不带 `--model` 时用 `~/.codex/config.toml` 默认(gpt-5.6-sol)。
- Codex 会话记录(rollout,`$CODEX_HOME/sessions/**/rollout-*-<threadId>.jsonl`,归档后在 `archived_sessions/`)**每个回合**都有 `turn_context` 行,带 `model` 与 `effort`。本机实测:`{"model":"gpt-5.6-sol","effort":"xhigh",...}`。
- 仓内已有读它的先例:`packages/teamlead/src/lead-backends/codex/lead-turn-evidence.ts:51-110`(按 session_meta 核 thread id、读尾部 turn_context)与 `packages/claude-runner/src/codex-rollout-probe.ts:10-35`(按 threadId 找文件)。⇒ **「实际评审模型」可以取自 Codex 自己写的记录,不必信 runner 自报。**

### 2.6 分流 effort(④)与降级(⑤)
- `packages/config/src/model-split.ts:125-214` `parseWeightedModelSplit`:arm 只收 `arm/model/weight`,多一个键即拒;`version` = semantics 的 sha256(`:208-213`),**加字段会改历史版本号**,需保证不写 effort 时字节不变。
- effort 选取:`packages/teamlead/src/workflow-menu.ts:970-981`——自动分流时 effort = 该模型策略的 `defaultEffort`,再核 `allowedEfforts`。
- 启动时 `narrowEffort`(`workflow-dispatch-resolution.ts:162-174`)会**静默丢弃**不支持的 effort。
- 降级:`applyImplementQuotaDegradation`(`workflow-dispatch-resolution.ts:37-80`)写死只认 arm 名 `impl_sol56 | impl_sol6`,并要求存在名为 `impl_opus` 的 arm。
- 现网 `~/.flywheel/models.json` 的 implement 分流 arm 为 `impl_opus` / `impl_sol56`;本单**不改**分流比例与现网配置。

## 3. 方案选项

### A. 每轮写回的触发方式
| 选项 | 做法 | 评价 |
|---|---|---|
| A1 runner 每轮调新命令 `flywheel-comm review-round` | 指令 + 评审技能要求每轮结束调一次;命令读 rollout 取实际模型、异步投 Bridge,失败落本地重试账 | **选**。零改评审本身,单次 <1s |
| A2 包一层 `flywheel-comm codex-review run` 代跑 companion | 由我们的命令拉起 companion 并解析结论 | 否:依赖第三方插件路径与输出格式,插件一升级就碎;改变评审运行方式,违背「不改评审本身」 |
| A3 只在评审门时一次性上传整段历史 | runner 在 JSON 里写 roundLog 数组 | 否:没过门的评审(放弃 / 中途挂掉)全丢;仍是自报 |

A1 的弱点是「靠 runner 记得每轮调」。补法:**评审门在放行时自己补写最终那一轮**(幂等),且报表按「最终轮号 vs 已收到轮数」标覆盖度。于是即使 runner 一次都没调,首轮通过率与轮数仍可从最终记录算出(rounds==1 ⇔ 首轮通过),逐轮明细缺口会被如实标出而不是被当成完整数据。

### B. 模型校验放哪
| 选项 | 评价 |
|---|---|
| B1 只信 JSON 里自报的 reviewerModel | 否:4 例都是「以为自己用对了」,自报等于没校验 |
| B2 门读 rollout 取实际模型 + Bridge 按路由记录比对 | **选**。实际值来自 Codex 自己的记录;要求值来自 Bridge 的 `review_model_routed`(服务端权威) |
| B3 Bridge 端读 rollout | 否:Bridge 进程与 runner 的 CODEX_HOME 不一定同一个,且 Bridge 不该读 runner 私有目录 |

### C. 顺序竞态
- C1 `stage set design_review` 同步打印 manifest(requestId / blob / reviewerModel / effort),并写 `.flywheel/runs/<exec>/codex/design-request.json`。**选**,配合指令改为「先 stage set 再开评」。
- C2 门的模型校验兜底:即使顺序错了,错模型的 APPROVED 过不了门。
- C3 每次 `review-round` 的 Bridge 回执带「要求模型 / 是否匹配」,第一轮评完就大声告警,不必等到门口才发现。

### D. 报表口径
两条线统一定义(按 execution × reviewType 为一组):
- **首轮通过** = 该组时间上最早一轮的结论是 APPROVED;
- **通过轮数** = 到被门接受的那次 APPROVED 为止的轮数;
- Astra 线读 `codex_review_job`,Claude 线读新表;按现有 arm 分组输出,每条带数据来源与覆盖度。

## 4. 待确认 / 假设
1. (已发 Lead 非阻塞问)「Astra 一律 high」默认由配置值落实,代码只提供 arm 级 effort 能力,不硬编码 vendor→effort 策略。
2. (已发 Lead 非阻塞问)⑤ 只改 implement 节点。
3. 不改 codex-companion 插件、不改 `~/.claude/commands/*.md` 用户级技能文件(不在仓内,改了进不了 PR);runner 行为靠 Bridge 下发的指令文字与 Blueprint 的仓内提示驱动。技能文件的同步修改列为上线后 Lead 手工步骤并在 plan 中给出补丁文本。
4. 历史数据不回填(FLY-2830/2882/2883/2884 保持原样)。
