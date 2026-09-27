# FLY-2891 本地 Codex 评审逐轮写回 Bridge + 评审门校验模型 — 实施计划
Issue: FLY-2891 (https://linear.app/geoforge3d/issue/FLY-2891/病根修复-claude-线本地-codex-评审每一轮结论-评审模型写回-bridge设计-代码评审门校验模型-4)
日期: 2026-09-25
基于: research.md

**Status**: draft v4(R1 = CR 6H/3M → v2;R2 = CR 3H/2M → v3,⑤ 已签核;R3 = R2 五项关闭 + 1M 自引入 → v4;见 §11)

## 0. 一句话

Claude 作者在本机跑的每一轮 Codex 评审,结束后立刻用一条轻命令把「第几轮 / 结论 / 该回合在 Codex 会话记录里的真实模型与 effort / 审的对象」写进 Bridge 新表(送不到就落一个文件,由 Bridge 常驻巡检代收);评审门放行前按回合 id 核真实模型,并请 Bridge 按路由比对要求模型,错模型的 APPROVED 一律拒收;报表用两线共享的归一化定义算首轮通过率与轮数,数据不全就判「未知」。外加 Lead 追加:分流 arm 可写 effort;按 founder 15:15 更正**删除**「Sol 档额度满自动改走 Opus」的降级。

## 1. 范围

### 做
1. **逐轮写回**:新命令 `flywheel-comm review-round`;Bridge 新路由 `POST /review-rounds` + 新表 `review_round_record`;送不到 → 一条记录一个文件落 spool,Bridge 常驻巡检代收(不依赖 runner 存活)。
2. **评审门校验模型**:结果 JSON 新增必填 `reviewerModel`/`reviewerEffort`/`codexTurnId`,`codexThreadId`/`rounds` 改为必填;门按 turnId 读 rollout 核真实值;Bridge 按路由比对要求值并在回执里声明 `reviewerModelChecked:true`,新门缺此声明即拒;FLY-827 的代码 APPROVED 事件也须带模型,Bridge 不符即不记批准。
3. **顺序竞态**:`stage set design_review` 同步回显 manifest(含要求模型)并落 `design-request.json`;指令改为「先 stage set 再开评,每次 companion 调用都带 `--model/--effort`,每轮评完立刻 review-round」;代码评审 hold 重投带上路由。
4. **报表**:`workflow-scorecard-report` 用共享归一化函数给两条线算首轮通过、通过轮数、覆盖度;每组输出首轮通过率与平均轮数。
5. **④ 分流 arm effort**:`modelSplit.nodes.<node>[].effort` 可选;派发时覆盖模板默认;不支持即拒(配置加载 + 菜单两层);`design-model-split.mjs show` 显示每档生效 effort。
6. **⑤ 删除额度降级**(Lead 更正 64b0d741,founder 15:15 原话「把这个保护拿掉……更想做的是根据 quota 动态调整各模型比例」):删派发侧 `applyImplementQuotaDegradation` 与准入侧的「降级提案」;额度满时 Codex 档走既有 Codex quota 排队。

### 不做(边界)
- 不改 codex-companion 插件,不改评审提示词与评审方式本身(同一个 Codex、同样本机跑)。
- 不改仓外用户级技能 `~/.claude/commands/codex-{design,code}-review.md`(进不了 PR);§9 给补丁文本,由 Lead 上线后手工应用。不改也能工作:Bridge 指令文字已写明 `--model` 与每轮 `review-round`。
- 不回填历史(FLY-2830/2882/2883/2884 等)。不改现网 `models.json` 与分流比例。
- 不防恶意伪造:runner 能伪造 rollout 与结果。本设计针对 4 例那种「无意用了默认模型」。
- 中间轮的「审的对象」是**上报时刻**的 plan blob / HEAD(指令要求评完立刻上报、上报前不改文件);只有最终 APPROVED 那轮的对象由门独立核验(设计 = manifest blob,代码 = HEAD)。中间轮对象仅作参考。
- ⑤ 不做动态分流比例(另开单);**保留**历史降级的读侧(已降级执行的唤醒继承、报表读 `model_arm_degraded`)。
- ④「Astra 在设计/实现节点一律 high」由 Lead 在 models.json 写 `effort:"high"`;代码不硬编码 vendor→effort、不拦 xhigh(Lead 答 111bfdfe)。
- 不新增 Discord 告警通道:投递失败的告警 = Bridge 巡检 warn 日志 + 报表的 `review_round_spool_pending/quarantined` 计数(见 §4.3b)。

## 2. 总体流程

```mermaid
sequenceDiagram
    participant R as Claude runner
    participant C as codex-companion(本机)
    participant F as Codex rollout 文件
    participant S as spool 目录
    participant B as Bridge
    R->>B: stage set design_review --plan(先于开评)
    B-->>R: 同步回显 requestId / blob / 要求模型 gpt-6-astra / xhigh
    loop 每一轮(评完立刻、改文件前)
        R->>C: task --model gpt-6-astra --effort xhigh
        C->>F: turn_context(model, effort) + task_complete(turn_id)
        R->>F: review-round 取本回合 turnId 与真实模型
        alt Bridge 在线
            R-)B: POST /review-rounds
            B-->>R: 回执(要求模型 / 是否匹配;不匹配立刻警告)
        else Bridge 不可达
            R->>S: 写一个记录文件(原子 rename)
            B->>S: 常驻巡检代收、删文件
        end
    end
    R->>R: 写 design-review.json(含 turnId / 模型)
    R->>F: 门:按 turnId 核真实模型 = 声明
    R->>B: /design-review-validation(+真实模型)
    B-->>R: allowed + reviewerModelChecked:true / 拒:要求 X 实际 Y
    R-)B: 写过门接受记录(finalRound + 总轮数;失败则落 spool)
```

## 3. 数据模型

新子 store `packages/teamlead/src/bridge/review-round-store.ts`(仿 `codex-quota-store.ts`:`migrate()` 在 StateStore 初始化时调用,StateStore 暴露 getter `reviewRounds`)。

```sql
CREATE TABLE IF NOT EXISTS review_round_record (
  execution_id           TEXT NOT NULL,
  review_type            TEXT NOT NULL CHECK(review_type IN ('design','code')),
  codex_thread_id        TEXT NOT NULL,
  codex_turn_id          TEXT NOT NULL,
  round                  INTEGER NOT NULL CHECK(round BETWEEN 1 AND 200),
  project_name           TEXT NOT NULL,
  issue_id               TEXT,
  run_id                 TEXT,
  node_id                TEXT,
  author_vendor          TEXT,
  author_model           TEXT,
  verdict                TEXT NOT NULL CHECK(verdict IN ('APPROVED','CHANGES_REQUESTED')),
  findings_critical      INTEGER, findings_high INTEGER, findings_medium INTEGER, findings_low INTEGER,
  observed_model         TEXT,
  observed_effort        TEXT,
  model_evidence         TEXT NOT NULL CHECK(model_evidence IN ('rollout_turn','unavailable')),
  required_model         TEXT,
  required_effort        TEXT,
  model_match            INTEGER CHECK(model_match IN (0,1)),   -- NULL = 无要求或无法核实
  request_id             TEXT,
  reviewed_target        TEXT,
  reviewed_plan_blob_sha TEXT,
  reviewed_head_sha      TEXT,
  delivery               TEXT NOT NULL CHECK(delivery IN ('http','spool')),
  reviewed_at            TEXT NOT NULL,   -- 该回合 task_complete 时间(rollout),取不到时为上报时间
  received_at            TEXT NOT NULL,
  PRIMARY KEY (execution_id, review_type, codex_thread_id, codex_turn_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_round_thread_round
  ON review_round_record(execution_id, review_type, codex_thread_id, round);
CREATE INDEX IF NOT EXISTS idx_review_round_run ON review_round_record(run_id);

-- 评审门接受记录:一次过门一行,不是「轮」,不参与轮去重
CREATE TABLE IF NOT EXISTS review_gate_acceptance (
  execution_id           TEXT NOT NULL,
  review_type            TEXT NOT NULL CHECK(review_type IN ('design','code')),
  codex_thread_id        TEXT NOT NULL,
  codex_turn_id          TEXT NOT NULL,          -- 被接受的 APPROVED 回合
  final_round            INTEGER NOT NULL CHECK(final_round BETWEEN 1 AND 200),  -- 该回合在其线程内的轮号
  rounds_total           INTEGER NOT NULL CHECK(rounds_total BETWEEN 1 AND 200), -- 跨线程总轮数(runner 声明)
  observed_model         TEXT NOT NULL,          -- 门按 turnId 核实过的真实值
  observed_effort        TEXT NOT NULL,
  required_model         TEXT,
  required_effort        TEXT,
  request_id             TEXT,
  reviewed_target        TEXT NOT NULL,
  reviewed_plan_blob_sha TEXT,
  reviewed_head_sha      TEXT,
  project_name           TEXT NOT NULL,
  run_id                 TEXT,
  node_id                TEXT,
  accepted_at            TEXT NOT NULL,
  received_at            TEXT NOT NULL,
  PRIMARY KEY (execution_id, review_type, codex_turn_id)
);

-- Astra 线稳定完成时间(现有表加一列,只在首次 done 时写)
ALTER TABLE codex_review_job ADD COLUMN completed_at TEXT;   -- 按现有「列不存在才 ALTER」模式
```

- 身份:一轮 = Codex 的一个回合,唯一真源是 `(execution_id, review_type, codex_thread_id, codex_turn_id)`;`round` 是 runner 在该线程里的计数,另有唯一约束防同线程两回合报同一轮号。显示标签(「设计 R2」)由报表派生。
- 服务端派生(不信客户端):`project_name/issue_id` 取 session;`run_id/node_id` 取 `getWorkflowRunNodeForExecution`;`author_*` 取 `getWorkflowExecutionRuntime`;`required_*` 见 §4.3;`model_match` 服务端算。
- **轮记录写入语义(不做通用 upsert,不改写历史)**:核心事实 = `round, verdict, reviewed_plan_blob_sha, reviewed_head_sha`,以及**双方都非空时的** `observed_model/observed_effort`。同主键再次提交:核心事实全等 → 幂等 no-op(`duplicate:true`);任一不同 → 409 `review round conflict`,原行不动。**唯一允许的补证**:原行 `model_evidence='unavailable'` 而新提交带 `rollout_turn` 证据、其余核心事实全等 → 只把 NULL 的模型/effort 补上并改 evidence。`reviewed_target`(PR URL 等)是参考信息,只做 NULL→值 填充,不参与冲突。唯一约束冲突(同线程同轮号不同回合)→ 409。
- **接受记录写入语义**:比较集合只含稳定业务事实 = `codex_thread_id, final_round, rounds_total, observed_model, observed_effort, request_id, reviewed_target, reviewed_plan_blob_sha, reviewed_head_sha`(`required_*`、`project_name/run_id/node_id` 由服务端派生,不来自客户端,也不比较)。同主键(`execution_id, review_type, codex_turn_id`)比较集合全等 → 幂等 no-op(`duplicate:true`),**保留首次的 `accepted_at` 与 `received_at`**;任一不同 → 409。`accepted_at` 取自结果 JSON 的 `timestamp`(同一结果重跑门时不变),`received_at` 由服务端在首次插入时写入;二者都是元数据,不参与比较、重投不覆盖。接受记录**不创建、不修改**轮记录;轮记录与接受记录谁先到都行(报表在读侧对账,§4.7)。
- `codex_review_job.completed_at`:`completeCodexReviewJob` 写 `completed_at = COALESCE(completed_at, datetime('now'))`;历史行为 NULL。
- 全部参数化 SQL。保留分类:新增 `review_round_record.json`、`review_gate_acceptance.json` 两个 fragment,均 `protectedCurrentOrReference`;`codex_review_job` 只加列,无需新 fragment。

## 4. 组件设计

### 4.1 rollout 读取器(flywheel-comm,新文件 `src/codex-rollout.ts`)
- `codexHome` = `env.CODEX_HOME?.trim() || join(homedir(), ".codex")`。
- `findRolloutForThread(codexHome, threadId)`:threadId 须匹配 `^[0-9A-Za-z-]{8,128}$`;在 `sessions/`、`archived_sessions/` 下找文件名含 threadId 的最新 `.jsonl`。
- `readTurnEvidence(codexHome, path, threadId, turnId?)`,照搬 `lead-turn-evidence.ts:51-110` 的安全约束:realpath 位于两个根之内;`O_RDONLY|O_NOFOLLOW` 且普通文件;首行 `session_meta.payload.id === threadId`;只认换行结尾的完整行;尾部读 256KB,不够时扩一次到 4MB。
  - 给了 `turnId`:收集该 turnId 的所有 `turn_context`(model/effort 必须一致,冲突 → 无效)与 `task_complete`;二者齐全才返回 `{turnId, model, effort, completedAt}`。
  - 没给 `turnId`(仅 `review-round` 首次取证用):取**最后一个有 `task_complete` 的回合**;若其后还有已开始未完成的回合(`task_started` 无 `task_complete`)→ 返回 `ambiguous`(runner 上报太晚),CLI 拒绝自动取证并要求显式 `--turn`。
- 任何 IO/解析错误 → `undefined`(调用方决定记 `unavailable` 还是拒绝)。

### 4.2 `flywheel-comm review-round`(新子命令)
```
flywheel-comm review-round <design|code> --exec-id <id> --round <n>
  --verdict APPROVED|CHANGES_REQUESTED --thread <codexThreadId> [--turn <turnId>]
  [--findings critical=N,high=N,medium=N,low=N] [--target <plan-path|pr-url>]
```
- 参数校验失败 → exit 2 + 用法(runner 写错命令,不是投递失败)。
- 取证:`readTurnEvidence`(有 `--turn` 用之,否则取最后完成回合;`ambiguous` → exit 2 并说明)。rollout 读不到 → `model_evidence=unavailable`、`codexTurnId` 取 `--turn`,两者都没有 → exit 2(没有回合身份就没有幂等键)。
- 对象:
  - design:plan 路径 = `--target` ?? `.flywheel/runs/<exec>/codex/design-request.json` 的 `planPath`;两者都没有 → exit 2「缺 plan 路径」。`reviewedPlanBlobSha` = `git -c core.hooksPath=/dev/null hash-object --no-filters -- <plan>`;`requestId` 取 design-request.json(没有则不带)。
  - code:`reviewedHeadSha` = `git rev-parse --verify HEAD^{commit}`;`--target` 可选(PR URL)。
- 投递:`POST ${FLYWHEEL_BRIDGE_URL}/review-rounds`,Bearer ingest token,**一次**、1.5s 超时,exit 恒 0(不阻塞评审)。按结果分类:
  - 2xx → 完成。
  - 网络错 / 超时 / 5xx / 503 / 401 / 403 / **404(旧 Bridge 无此路由)** / 响应无 `errorType` 的任何 4xx → **可恢复**,落 spool 主目录(§4.3b),stdout `WARN review round not delivered — queued for Bridge pickup`。
  - 400 且 `errorType:"invalid_payload"`,或 409 且 `errorType:"conflict"`(Bridge 明确声明的永久错误)→ **不重试但保留**:落 spool 的 `quarantine/`(附 Bridge 原因),stderr 打印原因。Bridge 巡检计入隔离计数。
- 回执与结果 JSON:回执打印 `turn=<turnId> thread=<threadId> round=<线程内轮号>`;runner 把 APPROVED 那轮的这三项写进结果 JSON 的 `codexTurnId/codexThreadId/finalRound`。
- **CLI 不做任何冲刷**(无锁、无积压重投),单次调用最坏 = rollout 尾读 + 1.5s。
- 回执打印:`review round recorded: design r2 CHANGES_REQUESTED model=gpt-6-astra/xhigh required=gpt-6-astra/xhigh match=yes turn=<id>`;`match=no` 打印醒目警告:「本轮不是要求模型;最终 APPROVED 会被评审门拒收;请用 `--fresh --model X --effort Y` 重开线程」。

### 4.3 Bridge `POST /review-rounds` 与要求模型
- 挂在 `plugin.ts` 与 `/design-review-validation` 同处、同款鉴权:未配 ingest token → 503;否则 `tokenAuthMiddleware`。
- 处理函数 `bridge/review-round-ingest.ts` 的纯函数 `ingestReviewRound(store, body, {delivery})`(HTTP 与 spool 巡检共用):
  - 输入边界:reviewType ∈ {design, code};verdict ∈ {APPROVED, CHANGES_REQUESTED};round 1..200;条数 0..10000 或缺省;threadId/turnId 同 §4.1 正则;model/effort ≤128;target ≤512;sha 40-hex;时间可解析且不在未来 >60s。非法 → 400。
  - `executionId` 须有 session → 否则 404;body 带 `projectName` 须一致 → 否则 409。
  - `resolveRequiredReviewModel(store, executionId, reviewType, requestId?)`(新,`workflow-review-routing.ts`):设计 → eventUid 以 `:design:<requestId>` 结尾的 `review_model_routed`;代码 → 该 execution 最新一条 reviewType=code 的 `review_model_routed`;都没有 → `resolveWorkflowReviewRouteForExecution` 重算;仍无 → `undefined`(非工作流运行)。只返回 `reviewerVendor==='codex'` 的路由。
  - `model_match` = 有要求且有真实值时 `canonical(observed)===canonical(required) && observedEffort===requiredEffort ? 1 : 0`,否则 NULL;canonical 经 `getModelConfigSnapshot().getDispatchCanonical`(未知 id 原样)。
  - 返回 `{recorded:true, duplicate?, requiredModel?, requiredEffort?, modelMatch: true|false|null}`;写库异常 → 500。拒绝体统一 `{recorded:false, errorType:"invalid_payload"|"unknown_execution"|"project_mismatch"|"conflict", reason}`;其中只有 `invalid_payload`(400)与 `conflict`(409)是客户端应隔离的永久错误,`unknown_execution`(404)按可恢复处理(session 行可能尚未同步)。
  - 同一路由接受 `kind:"round"`(默认)与 `kind:"gate_acceptance"` 两种体;后者只由门发送,写 `review_gate_acceptance`,字段校验同上,另要求 `finalRound`、`roundsTotal`、非空 `reviewedTarget`、真实模型字段。

### 4.3b spool 与 Bridge 常驻代收(重试账 + 告警)
- 目录 `${FLYWHEEL_STATE_DIR:-~/.flywheel/state}/review-round-spool/`(0700),子目录 `quarantine/`。**每次投递一个独立文件**:`<execId>.<reviewType>.<turnId>.<round|gate>.<randomUUID>.json`,先写同目录临时文件(0600,`O_EXCL`)再 `rename`;文件名含随机 UUID ⇒ 永不覆盖他人文件,也不在客户端做「同名即成功」。execId 须匹配 UUID 正则、turnId 须匹配 §4.1 正则,否则不落盘直接报错(防路径注入)。同一回合的重复/冲突由 Bridge 入库时按主键判定(duplicate 删文件;conflict 进 quarantine 且可见)。无共享日志、无重写、无锁。
- Bridge 新巡检 `reconcileReviewRoundSpool(store)`:挂到现有常驻 interval(与 `reconcileDesignReviewInstructions` 同一处,`plugin.ts:9948-9992`),启动时跑一次、之后每 60s;每次最多处理 100 个文件、总耗时上限 5s。
  - 只处理本用户所有、≤16KB 的普通文件(`lstat` 拒软链);解析后走 `ingestReviewRound(…, {delivery:'spool'})`。
  - 成功或 duplicate → 删文件;`invalid_payload`/`conflict` → 移到 `quarantine/`(文件旁写 `.reason`)并 `console.warn` 一行(含 execId、原因,不含正文);`unknown_execution` 与 500/异常 → 留原处下轮再试,超过 7 天仍失败 → 移入 quarantine。
  - 文件年龄 >1h 仍在主目录 → 每小时一次 `console.warn` 汇总。
- 报表 `workflow-scorecard` 输出 `review_round_spool_pending=<n> quarantined=<n>`(直接数目录),让「送不到」可见。
- 这样最后一轮补写失败、runner 结束、worktree 删除后,Bridge 恢复即自动代收,无需任何新评审调用。

### 4.4 评审门 `await-codex-gate`
`validateResult` 新增(两种类型):
1. `reviewerModel`、`reviewerEffort` 非空字符串;`codexThreadId`、`codexTurnId` 合法;`finalRound`(该回合线程内轮号)与 `rounds`(跨线程总轮数)均为 1..200 整数且 `finalRound ≤ rounds`。缺任一 → 拒,原因写明缺哪个字段并提示「按 Bridge 指令 schema 重写结果」。
2. 按 **turnId** 核 rollout:找不到 rollout / 该回合无 `turn_context` 或无 `task_complete` / 回合内 context 冲突 → 拒 `cannot verify reviewer model for Codex turn <turn> (thread <thread>) under <CODEX_HOME>/{sessions,archived_sessions}`;该回合真实值 ≠ 声明 → 拒 `result declares <m>/<e> but Codex turn <turn> ran <m2>/<e2>`。不回退到「线程最后一个回合」。
3. Bridge 比对要求模型:
   - 设计:`/design-review-validation` body 增加 `reviewerModel`、`reviewerEffort`、`codexThreadId`、`codexTurnId`;Bridge 在现有 manifest/blob 校验后调 `resolveRequiredReviewModel(..., manifest.request_id)`,不符 → 409 `reviewer model mismatch: request requires gpt-6-astra/xhigh, review ran gpt-5.6-sol/xhigh`(要求值属路由不属 manifest 私密值,可回显);缺模型字段 → 400 `design review result missing reviewer model (upgrade flywheel-comm and rerun the gate)`;允许时响应 `{allowed:true, reviewerModelChecked:true}`。
   - 代码:新 `POST /code-review-validation`(同款鉴权),body `{executionId, reviewType:'code', reviewedHeadSha, reviewerModel, reviewerEffort, codexThreadId, codexTurnId}`;session 须存在;有要求模型则比对(规则/文案同上);允许时同样回 `reviewerModelChecked:true`。
   - **协议能力声明**:新门对两类响应都要求 `allowed===true && reviewerModelChecked===true`,否则拒 `Bridge did not confirm reviewer-model validation (Bridge not upgraded?)`。⇒ 新门 × 旧 Bridge 不会静默放行。代码门由此新增 Bridge 在线依赖;FLY-827 的 Bridge 硬门本就要 Bridge 在线才能放 founder/merge,可用性不变。
4. 放行后:发送一条 `kind:"gate_acceptance"`(`codexThreadId/codexTurnId/finalRound/rounds→roundsTotal`、核实过的真实模型、`reviewedTarget`、设计 `requestId/reviewedPlanBlobSha` 或代码 `reviewedHeadSha`,**全部取自已通过校验的结果 JSON 与 rollout,不从当前工作区重推**),投递与分类同 §4.2,失败落 spool;它不写轮记录,也就不会与逐轮记录冲突。FLY-827 的 `emitCodexReviewResult` 载荷增加 `reviewerModel/reviewerEffort/codexThreadId/codexTurnId`。补写失败不改变放行结果。
5. 文档注释 schema 同步更新。

### 4.4b 旧门 × 新 Bridge(在飞进程跨部署)
- CLI 与 Bridge 同一 dist 同次部署(runner 调的就是主仓 `packages/flywheel-comm/dist`),新调用自动是新 CLI;风险只在**部署时正在轮询的旧门进程**(最长 30 分钟)。
- 设计:旧门不带模型字段 → 新 Bridge 400「missing reviewer model (upgrade …)」→ 旧门 exit 1,runner 重跑门即为新 CLI。无静默放行。
- 代码:旧门走 `codex_review_result` 事件。`bridge/codex-review-ingest.ts` 改为:该 execution 存在 Codex 评审路由(`resolveRequiredReviewModel` 有值)时,载荷缺 `reviewerModel/reviewerEffort` 或不符 → **不记批准**,`console.warn` 并保持现有 hold(hold 会按既有逻辑重投评审指令,runner 用新 CLI 重过门);无路由的运行维持旧行为。

### 4.5 stage set 同步回显 manifest
- `event-route.ts`:`stage_changed` 且 stage 为 `design_review` 时,`applyStageEvent` 之后用 `store.getDesignReviewManifestForSourceEvent(event.event_id)` 取本事件的 manifest(重放按同一 source event 取),`res.json` 追加 `designReview: {requestId, revision, planPath, reviewedPlanBlobSha, reviewerModel?, reviewerEffort?}`(要求模型经 `resolveRequiredReviewModel`)。取不到 → 不带该字段(旧行为)。
- `flywheel-comm/src/stage-queue.ts`:`postStageEvent` 透传 `designReview`;`stage.ts` 收到时打印 `Design review request: requestId=… blob=… reviewer=gpt-6-astra/xhigh` 并写 `.flywheel/runs/<exec>/codex/design-request.json`(0600);未收到(延迟发送等)打印 `Design review request pending — check inbox before starting Codex`。

### 4.6 指令文字与提示
- `codex-instruction.ts` `buildCodexInstruction`:
  - schema 增加 `reviewerModel, reviewerEffort, codexTurnId, finalRound`(均取自 APPROVED 那轮的 `review-round` 回执);`rounds` 定义为「本次评审跨所有线程的总轮数」;
  - 有路由时:`Pass --model <m> --effort <e> on EVERY codex-companion task call (the /codex-design-review and /codex-code-review skills omit --model — add it). If a round already ran on another model, start a fresh thread (--fresh) with the right model.`;
  - 两类都加:`Immediately after EACH Codex round, before editing any file, run: flywheel-comm review-round <type> --exec-id <id> --round <n> --verdict <APPROVED|CHANGES_REQUESTED> --thread <codexThreadId> [--findings critical=N,high=N,medium=N,low=N]`;
  - 设计加:`Run flywheel-comm stage set design_review --plan <plan> BEFORE round 1 and read the printed reviewer model; re-run it after the final plan commit.`
- `queueCodexCodeReviewInstructionResult`(`codex-instruction.ts:147`):`opts` 增可选 `reviewRoute`,有则传给 `buildCodexInstruction`(位置参数不变)。`CodexReviewEffects`(`codex-review-effects.ts`)deps 增可选 `resolveReviewRoute(executionId)`,在 `plugin.ts:14037-14056` 装配处用 `resolveWorkflowReviewRouteForExecution(store, exec, "code")`(仅 `reviewerVendor==='codex'`)注入;解析抛错 → warn 后不带路由。
- `packages/edge-worker/src/Blueprint.ts:2328-2334, 2682` 两处提示各补一句「每轮评审后立刻 `flywheel-comm review-round …`;companion 调用必须带 Bridge 指定的 `--model`」。

### 4.7 报表:两线共享的归一化定义
新纯函数 `normalizeReviewRounds(rounds: NormalizedRound[]) → ReviewMetric`(`workflow-scorecard-report.ts` 内),两个数据源各写一个适配器产出同一种 `NormalizedRound {at, rawVerdict: 'APPROVED'|'CHANGES_REQUESTED', seriesKey, ordinal}`:

**共享定义**(以 issue 为单位,只计 `at < asOf` 的轮):
- 一轮 = 评审者对作者产物给出的一次**原始**结论(不经严重性策略折算)。
- 按 `at` 排序全部轮;`firstPass` = 第一轮 rawVerdict==APPROVED;`roundsToApproval` = 到第一个 APPROVED 为止的轮数(含)。
- **完整性必须可证明**,否则 `firstPass=null`、`roundsToApproval=null`(缺失绝不当通过):每个 seriesKey 内 ordinal 从 1 连续,**且**适配器给出的「预期总轮数」与去重后的实际轮数相等。任何一条不满足 → `coverage='incomplete'`;无法给出预期总数 → `coverage='unverified'`(同样为 null)。没有任何轮 → `coverage='none'`。完整但无 APPROVED → `roundsToApproval=null`、`firstPass=false`。

**适配器**:
- Astra 线(`codex_review_job`):取 `status='done'` 的行;`reviewer_verdict` ∈ 两类 → 一轮(用原始结论,不用策略后的 `verdict`);**done 但 `reviewer_verdict` 为空或非法 → 覆盖缺口,整组 incomplete**(不过滤、不用 effective verdict 冒充)。failed/skipped/pending/running 不算轮;排除 `codex_review_reuse_binding` 里作为复用副本的 `request_id`。`seriesKey = execution_id|review_type|target_repo_identity`,`ordinal` = series 内按 `created_at` 的序号(不用 `round` 列);预期总轮数 = 该 series 的 done 行数(Bridge 自跑,行即全集);`at = completed_at`,历史 NULL 行回退 `updated_at` 并计入 `timeBasisFallback` 计数(不用 `responded_at`,它是投递时间)。
- Claude 线(`review_round_record` + `review_gate_acceptance`):`seriesKey = execution_id|review_type|codex_thread_id`,`ordinal = round`,`at = reviewed_at`(该回合 task_complete 时间),`rawVerdict = verdict`。预期总轮数 = 该 execution×type **最早一条**接受记录的 `rounds_total`,并要求其 `codex_turn_id` 在轮记录中存在且为 APPROVED、`round = final_round`;无接受记录(评审放弃/未过门)→ unverified。实际轮数只数 `at ≤` 被接受回合 `at` 的轮。
- 一个 issue 下多个 execution(返工)/多个 repo series:全部轮合并按时间排序求 firstPass 与 roundsToApproval;任一 series 不完整即整体 incomplete。
- 输出:issue 上 `designReview`/`codeReview` = `{firstPass, roundsToApproval, reviewerModels, source:'bridge_job'|'local_round'|'mixed'|'none', coverage}`;组上 `designReviewFirstPass`/`codeReviewFirstPass`(同 `qaFirstPass` 形,分母只计 `firstPass!==null`)、`designReviewRoundsMean`/`codeReviewRoundsMean`、以及 `…Coverage: {complete, incomplete, unverified, none}` 与 `timeBasisFallback` 计数。
- `reviewerModels`:local 取 `observed_model` 去重;job 取同 requestId 的 `review_model_routed.reviewerModel`(没有为空)。
- CLI 文本行追加 `design_first_pass= design_rounds_mean= design_incomplete= code_first_pass= code_rounds_mean= code_incomplete=` 与 spool 计数。
- `scripts/fly2403-design-model-comparison.sql` 不改逻辑,文件头加注释「Claude 线轮数口径已由 FLY-2891 scorecard 评审指标取代」。

### 4.8 ④ 分流 arm effort
- `packages/config/src/model-split.ts`:`WeightedModelSplitArm` 增 `readonly effort?: "low"|"medium"|"high"|"xhigh"|"max"`(常量 `MODEL_SPLIT_ARM_EFFORTS`,与 `workflow-template.ts:33` 的 `WorkflowEffort` 同值,加类型级一致性测试);解析允许键 `effort`,不在集合 → 抛 `${path}.effort must be one of …`;冻结对象**只在写了 effort 时**带该键 ⇒ 未写 effort 的配置 `fly2788-v1:<sha>` 字节不变(测试钉住现网配置的版本号)。
- `packages/config/src/model-config.ts` `parseRuntimeModelSplit`(`:207-226`):对带 effort 的 arm,用**本次候选文档的** `lookup` 取 registry entry,检查 `entry.effortsBySurface.workflow ?? []` 包含该 effort(同 `agent-registry.ts:268` 的读法),不含 → 抛错(整个分流标 invalid,派发 `MODEL_SPLIT_CONFIG_INVALID`)。**不调用** `resolveAllowedEffort` / `getModelConfigSnapshot`(避免加载期重入与拿现网表校验候选文档)。
- `workflow-menu.ts:970`:`const effort = override?.effort !== undefined ? callerEffort : (automaticAssignment && armEffort) ? armEffort : modelPolicy.defaultEffort`;`armEffort` 取 `resolveWeightedModelSplit` 选中的 arm。随后原有 `allowedEfforts` 校验拒绝不支持的档位(`EFFORT_NOT_ALLOWED_FOR_MODEL`,文案补「from model split arm <arm>」)。显式 effort 优先。
- 可见:receipt `effort`、冻结 assignment 的 `basis.nodes[].effort`、runtime 行 effort;`scripts/design-model-split.mjs show` 每档打印 `effort=<值>` 或 `effort=inherit(<该节点该模型 defaultEffort>)`。
- `narrowEffort` 保持原样(最后一道)。

### 4.9 ⑤ 删除额度降级(只删生产侧)
- `workflow-dispatch-resolution.ts`:删 `applyImplementQuotaDegradation` 与 `WorkflowDispatchResolution.degradation`;`resolveNodeDispatchAtLaunch` 三个返回点直接返回;其 `codexQuotaRootKey`/`now` 入参只服务降级,一并删除,三个调用处 `bridge/actions.ts:980`、`bridge/runs-route.ts:3249`、`bridge/workflow-engine-dispatcher.ts:2824` 同步去掉(对象字面量多余属性 TS 报错,编译即证全覆盖)。`admitGeneralizedWorkflowExecution` 的 `codexQuotaRootKey` 仍用于额度排队(`StateStore.ts:46787`),保留。
- `StateStore.admitGeneralizedWorkflowExecution`:删入参 `dispatchResolution.degradation`、`currentDegradationEvidence`、`validDegradationProposal` 与「新提案」的 `model_arm_degradation_invalid` 分支;`selectedDispatch = wakeRuntime ? … : (input.dispatchResolution?.dispatch ?? node.dispatch)`;`degradationAssignment` 只剩 `inheritedDegradation?.assignment`(历史已降级执行被唤醒时仍写本次激活的 `model_arm_degraded` 收据)。
- 不动:`readScorecardDegradation`、`ScorecardDegradedReceiptV1`、报表降级计数、wake 继承校验。
- 额度满:Codex 档照常 `isCodexQuotaLaunchPaused` 排队,与未分流 Codex 节点一致。

## 5. 实施分块(TDD,每块先红后绿)

| # | 块 | 主要文件 | 测试 |
|---|---|---|---|
| C1 | rollout 读取器 | `flywheel-comm/src/codex-rollout.ts` | sessions/archived 均能找到;meta id 不符;软链拒;半行不算;扩读;按 turnId 取且 context 冲突拒;无 task_complete 拒;无 turnId 时取最后完成回合、其后有未完成回合 → ambiguous;APPROVED 后同线程再追问一回合(换模型)时按 turnId 仍取原回合 |
| C2 | 表 + ingest + 路由 + 保留分类 + completed_at | `bridge/review-round-store.ts`、`bridge/review-round-ingest.ts`、`plugin.ts`、`StateStore.ts`(getter+migrate、`completeCodexReviewJob`)、`workflow-review-routing.ts`、两个 retention fragment | 幂等 duplicate;核心事实冲突 409(errorType=conflict)且原行不变;unavailable→rollout_turn 补证成功、已知模型互冲 409;PR URL NULL→值 填充不冲突;同线程同轮号异回合 409;接受记录与轮记录两种到达顺序结果一致;fresh-thread(A:R1 CR、B:R1 APPROVED,rounds=2、finalRound=1)接受记录写入成功;**HTTP 入库成功但回执丢失 → 稍后 spool 重投同一接受记录 → duplicate、spool 删、无 quarantine、首次 accepted_at/received_at 不变**;同一结果重跑门 → duplicate;接受记录真实事实(turn 内轮数/模型/目标)不同 → 409;completed_at 只写一次;鉴权 401/503;400/404/409;服务端派生字段忽略客户端值;model_match 三态;设计按 requestId、代码取最新/重算 |
| C3 | spool + 巡检 | `flywheel-comm/src/review-round-spool.ts`、`bridge/review-round-spool-reconciler.ts`、`plugin.ts` | 并发 20 进程同时落盘无丢失;同回合同内容两文件 → 一行 + 两文件都删;同回合不同内容两文件 → 先到者入库、后到者进 quarantine 且可见;非法 execId/turnId 拒;巡检:成功删、invalid/conflict 进 quarantine、unknown_execution/500 保留、7 天转隔离、软链/超大/他人文件跳过、单次上限 100/5s;**runner 已退出且 worktree 删除后 Bridge 恢复即代收** |
| C4 | `review-round` CLI | `flywheel-comm/src/commands/review-round.ts`、`index.ts` | 成功回执(含 turn/thread/round);不匹配告警;网络错/5xx/401/404 → exit 0 + 主目录 spool 文件;**旧 Bridge 404 → runner 结束 → Bridge 升级 → 巡检自动入库**;400 invalid_payload/409 conflict → quarantine;缺 plan 路径 exit 2;ambiguous exit 2;耗时:Bridge 挂时 ≤2s(0/20/200 个既有 spool 文件下相同,CLI 不读积压) |
| C5 | 评审门 | `await-codex-gate.ts`、`codex-review-result.ts` | 缺字段拒;finalRound>rounds 拒;接受记录字段取自结果 JSON(工作区改动后不变);声明≠回合真实值拒;回合缺失/未完成拒;设计 409 模型不符(原因可读)拒;代码 `/code-review-validation` 拒/放;响应缺 `reviewerModelChecked` 拒(新门×旧 Bridge);正确模型放行;补写失败落 spool 仍 exit 0;FLY-827 载荷含模型 |
| C6 | Bridge 校验扩展 + 旧门兼容 | `design-review-validation.ts`、新 `code-review-validation.ts`、`codex-review-ingest.ts`、`plugin.ts` | 设计:缺/错/对/无路由;代码:同;旧门设计请求 400 带升级提示;旧门 `codex_review_result` 无模型且有路由 → 不记批准、hold 保持;无路由运行旧行为不变 |
| C7 | stage set 回显 + 指令 + 重投路由 + Blueprint | `event-route.ts`、`stage-queue.ts`、`stage.ts`、`codex-instruction.ts`、`codex-review-effects.ts`、`plugin.ts`、`Blueprint.ts` | 响应含 designReview、重放同值;CLI 写 design-request.json;指令文本快照;重投带路由;Blueprint 现有测试更新 |
| C8 | 报表 | `workflow-scorecard-report.ts`、`workflow-scorecard-cli.ts`、fly2403 注释 | 归一化函数反例:只有接受记录(rounds_total=3)无轮记录 → incomplete/null;**旧线程整条漏报**(接受 rounds_total=2,只收到 B:R1 APPROVED)→ incomplete/null;无接受记录 → unverified;Astra done 但 reviewer_verdict 空的行后出现 APPROVED → incomplete;固定 asOf 下 done 后延迟 responded → 指标不变;completed_at 为 NULL 的历史行回退 updated_at 并计数;线程 A R1=CR + 线程 B R1=APPROVED → 2 轮、firstPass=false;Astra 失败请求后首个 APPROVED(round 列=2)→ 1 轮;多 repo series;策略把 CR 折成 APPROVED 时按 reviewer_verdict 计 CR;复用副本不计;asOf 截断;无数据 none;组率与均值;CLI 文本 |
| C9 | ④ arm effort | `model-split.ts`、`model-config.ts`、`workflow-menu.ts`、`design-model-split.mjs` | 解析接受/拒绝;现网配置版本号不变;空 cache 首次加载与热更新不重入;候选文档能力与现网不同时按候选判;arm effort 生效且可见;不写继承;不支持档位两层拒;show 输出 |
| C10 | ⑤ 删除降级 | `workflow-dispatch-resolution.ts`、`StateStore.ts`(准入)、三个调用处 | Codex 档额度满 → 仍 Codex + 排队 + 无降级事件;历史已降级执行唤醒仍通过;报表读历史降级不变;`git grep applyImplementQuotaDegradation` 为零 |

本机测试纪律(实现体须遵守):只跑相关文件;排除 `**/tmux-viewer.macos.test.ts`;任何会 `startBridge` 的 teamlead 测试先 `export FLYWHEEL_CODEX_HOMES_ROOT=<临时目录>`;新表确认 retention fragment 已加;`pnpm --filter flywheel-teamlead` 包名勿写错;判成功看 Tests 条数。

## 6. 验收映射

| 验收(Linear) | 证据 |
|---|---|
| 1 设计≥2 轮 + 代码评审:Bridge 轮数=实际,每条有模型/结论;删工作目录后仍在 | QA 用真 companion 跑 2 轮设计 + 1 轮代码,查 `review_round_record`(turnId 与 rollout 对得上);删 worktree 再查;再演练一次「Bridge 停 → review-round 落 spool → worktree 删除 → Bridge 起 → 巡检代收」 |
| 2 错模型 APPROVED 被门拒、原因可读;对的放行 | C5/C6 + QA 实跑:companion 不带 `--model` 出 APPROVED → 门报 `request requires gpt-6-astra/xhigh, review ran gpt-5.6-sol/xhigh` |
| 3 报表算出 Claude 线首轮通过率/轮数 | C8 + QA 对真实数据跑 `workflow-scorecard` CLI |
| 4 评审耗时无明显增加 | review-round 单次:Bridge 在线 <300ms,Bridge 挂 ≤2s 后落 spool;与积压数量无关;门增加一次 rollout 读 + 一次本机 HTTP |
| 5 本机只跑相关测试 | §5 纪律 |
| ④ effort=high 实际按 high 跑且可见;不写继承;不支持被拒 | C9 + QA:show 输出、菜单 receipt、runtime 行 effort |
| ⑤ 降级已删除:额度满走排队,不改模型 | C10 |

## 7. 上线与回滚

- **收紧的合同**:结果 JSON 新必填字段、设计校验需模型字段、代码门需 Bridge、有路由运行的 FLY-827 批准需模型。部署时正在轮询的旧门会被拒一次并提示升级,runner 重跑门即可(§4.4b)。建议 Lead 选无在飞 Claude 设计/实现门的窗口合并;更新器按常规窗口部署,本单不部署。
- 新表、spool 目录纯新增;回滚 = revert,表与目录留着无害。
- **④ 回滚约束**:带 effort 的 arm 会进入冻结 assignment 的 `basis.nodes`,旧解析器会拒(`unknown key: effort`),删 models.json 里的 effort 救不回已冻结的 run。⇒ 回滚前须满足其一:(a) 先把 models.json 的 effort 键删掉,并等所有「assignment 带 effort 的在飞 run」结束(查询:`SELECT run_id FROM workflow_run_event WHERE kind='model_arm_assigned' AND payload LIKE '%"effort"%'` 与非终态 run 求交,为空才回滚);或 (b) 回滚时保留 `model-split.ts` 的 effort 解析(只 revert 其余部分)。不改写冻结历史。写进 PR body。另加一条兼容测试:「带 effort 配置建 run → 配置改回无 effort → 启动剩余节点」仍通过(验证当前代码对冻结 basis 的重放不依赖现行配置)。
- ⑤:回滚即恢复旧降级;删除期间的 run 无降级事件,旧代码读它们为「未降级」,口径一致。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| runner 不按指令每轮调 `review-round` | 接受记录的 rounds_total 对账 ⇒ 报表判 incomplete(不当通过、不当完整);接受记录至少留下过门事实与真实模型;回执/指令/Blueprint 三处提醒 |
| runner 声明的 rounds_total 本身写错 | 与去重后的轮数不等 ⇒ incomplete;只会让数据变「未知」,不会虚增首过率(虚报偏大同理判 incomplete) |
| CODEX_HOME 不一致导致门找不到 rollout | 报错写明查找根;门与 companion 同 env |
| 要求模型未来变更 | 设计按 requestId 取当时 routed 事件;代码取最新 routed 事件;重算兜底 |
| Bridge 巡检与 HTTP 同时写同一轮 | 同一 ingest 函数 + 主键幂等,duplicate 即删文件 |
| spool 堆积(Bridge 长期不可用) | 报表计数 + 每小时 warn;文件 ≤16KB,量级可忽略 |

## 9. 仓外技能补丁(Lead 上线后手工应用,非本 PR 内容)

`~/.claude/commands/codex-design-review.md` 与 `codex-code-review.md`:
- 每个 `node "$COMPANION" task` 调用加 `--model "${REVIEWER_MODEL}"`(由 Bridge 指令 / `stage set` 回显取得;无要求时省略);
- Step 4 每轮判定后、改文件前加:`flywheel-comm review-round <design|code> --exec-id "$FLYWHEEL_EXEC_ID" --round {N} --verdict {VERDICT} --thread {THREAD_ID}`(非 Flywheel 会话无 `FLYWHEEL_EXEC_ID` 时跳过),并把回执里的 `turn=` 记下用于结果 JSON。

## 10. 负向守卫清单
- 门:缺字段 / 回合真实值≠声明 / 真实≠要求 / 回合缺失或未完成 / Bridge 未声明已核模型 → 一律拒,原因含具体值。
- Bridge:无 token 503、错 token 401、未知 exec 404、项目不符 409、超界 400、核心事实冲突 409;客户端给的 issue/run/node/requiredModel 一律忽略;有路由运行的 FLY-827 批准缺模型/不符不记。
- 写回:投递失败 exit 0 不阻塞;重复投递不产生重复行;spool 不丢并发记录;坏记录隔离不无限重试。
- 分流:未知 effort 拒;模型不支持的 effort 拒(按候选文档);不写 effort 的版本号不变。
- 降级:任何节点、任何 Codex 档额度满都不改派 Opus;历史 `model_arm_degraded` 仍可读、已降级执行仍可唤醒。

## 11. Codex design review 记录

| 轮 | 模型 | 结论 | 处置 |
|---|---|---|---|
| R1 | gpt-6-astra / xhigh | CHANGES REQUESTED(0C/6H/3M/0L) | ①「最后一个 turn_context」不能绑定本轮 → 按 turnId + task_complete 取证,结果 JSON 带 `codexTurnId`,冲突提交 409 不改写(§3、§4.1、§4.4);②混合版本可绕过 → 回执 `reviewerModelChecked`、旧门设计 400、有路由运行 FLY-827 批准需模型(§4.4、§4.4b);③指标不统一 → 共享归一化函数、缺失判 unknown、Astra 用 reviewer_verdict + created_at 序号、排除复用与失败(§4.7);④最后一轮无重试责任方 → Bridge 常驻巡检代收 spool(§4.3b);⑤spool 丢记录 → 一记录一文件原子 rename,无共享日志无锁(§4.3b);⑥积压拖慢 → CLI 不冲刷,单次 ≤2s(§4.2);⑦加载期重入 → 用候选 lookup 校验 effort(§4.8);⑧对象来源/时机 → plan 路径来源与缺省失败、安全 git 参数、中间轮对象为参考值写入边界(§1、§4.2);⑨回滚 → 写明排空条件与兼容测试(§7)。另:⑤ 范围按 Lead 更正改为删除降级(§4.9) |
| R2 | gpt-6-astra / xhigh(同线程续轮) | CHANGES REQUESTED(0C/3H/2M/0L);⑤ 删除降级已签核 | ①最终补写与逐轮合同不一致 → 门改写独立的 `review_gate_acceptance`(finalRound 与 rounds_total 分开、字段取自已校验结果),不再重建轮记录;定义 unavailable→真实值补证、PR URL 非核心事实(§3、§4.4);②漏整条线程仍算完整 → 以接受记录 rounds_total 对账、无接受记录判 unverified,Astra 缺原始结论的 done 行算缺口(§4.7);③4xx 丢记录 → Bridge 拒绝体带 errorType,只有 invalid_payload/conflict 进隔离区,404/401/5xx 等进 spool(§4.2、§4.3);④rename 覆盖/同名即成功 → 每次投递独立随机文件名,冲突在入库时判定并隔离可见(§4.3b);⑤Astra 时间用投递时间 → 新增一次性 `completed_at`,历史回退 updated_at 并计数(§3、§4.7) |
| R3 | gpt-6-astra / xhigh(同线程;两次 401 凭据故障后于 Codex 恢复时重跑) | CHANGES REQUESTED(0C/0H/1M/0L);R2 五项全部关闭 | ①(v3 自引入)接受记录「全字段相等」含接收元数据,正常重投会被判冲突 → 比较集合限定为稳定业务事实,`accepted_at` 取结果 JSON timestamp、`received_at` 首次写入,重投不覆盖;补「回执丢失后 spool 重投」与「同一结果重跑门」测试(§3、C2) |
