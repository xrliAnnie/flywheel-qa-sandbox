# FLY-1643 Codex 适配器不投递 workflow 凭据 — 探索

Issue: FLY-1643 (https://linear.app/geoforge3d/issue/FLY-1643/引擎bug高优-codex-适配器不向-runner-投递-output-credential-vendorcodex-的-produces)
日期: 2026-08-05
基于: 无

## 1. 问题是什么

同一 slot、同一 Bridge、同一 PR head,只换 carrier vendor 的受控对照(FLY-1638 QA 二轮,2026-08-05):

- **Claude carrier**:output credential 发出 → 16:41:37 被 consume → `workflow_node_output_current` 落行 ✅
- **Codex carrier**:output credential 发出 → **永远没被 consume**(Runner pane 实测 env 里 `FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL` 不存在)→ `revoked=1 reason=completed_no_artifact`,只能走 no_code ❌

结论:**Claude 适配器把凭据送到 Runner 手上,Codex 适配器没有。** 非通道级缺陷,Codex 侧特有。

## 2. 影响面(为什么高优)

任何 `vendor=codex && produces_output=true` 的 generalized workflow 节点在真机上:

1. 交不出 artifact → 永远到不了 `needs_review` → **开不出 approve gate** → 只能落 no_code。tpl_generic 整族(6 僵尸单模板族)在 Codex 上是死路。
2. 且不止 output:**submission 凭据同样丢失** → codex 决策节点(review/qa)交不出 verdict → 本机全部内建 runner_ship 模板到不了 founder gate。
3. FLY-1638 的 QA 因此无法用 codex carrier 走通 ship 链(已被迫改用 Claude carrier 对照)。

## 3. 根因(代码级闭链,已逐行复核)

三文件链,本 worktree(base = main `6fbc4292`)逐行确认:

1. **`packages/claude-runner/src/CodexTmuxAdapter.ts:1434-1440`** — `buildDaemonEnv` 显式设置三个 workflow env(意图正确):
   - `FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL`
   - `FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED`
   - `FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL`
2. **`packages/claude-runner/src/codex-daemon-runtime.ts:520`** — `spawnCodexDaemon` 对**构造好的** `opts.env` 再跑一遍 `stripInheritedSecretEnv`(二次 wash 洗的是构造结果,不只是继承 base)。
3. **`packages/claude-runner/src/codex-home.ts:136-156`** — `RUNNER_ALLOWED_FLYWHEEL_ENV` 精确白名单 **17 条**(实数,与 FLY-1639 复核一致),三个 workflow 名都不在 → "Any FLYWHEEL_ var not on this list is DROPPED"。

⇒ 适配器设了、spawn 前被白名单静默洗掉、codex 进程从没见过。

**对照组(Claude 路径为何没事)**:`TmuxAdapter.ts:452-466` 经 `tmux new-window -e KEY=VALUE` 直投 pane env,链路上没有任何 wash。

**引入时间线(git 考古)**:三个 env 是三个 generalized-workflow PR 分批加进 `buildDaemonEnv` 的 —— SUBMISSION_CREDENTIAL @ FLY-1244 (#593)、OUTPUT_CREDENTIAL @ `c989ee5f`(generalize DAG template execution)、SUBMISSION_EXPECTED @ FLY-1425 (#673) —— **没有一个同步注册进白名单**。这是一个会反复发生的 bug class:上游加 env、下游 wash 静默丢。

**上游无辜确认**:`Blueprint.ts:2664-2666` 两凭据透传完好;runs-route 侧 FLY-1638 已实证保留。FLY-1638 亦非引入者(其 PR 未动 CodexTmuxAdapter.ts)。

**讽刺现场**:消费端 `qa-result.ts:190` 的报错文案是 "do not use env -u or a shell that drops the runner environment" —— 实际丢 env 的正是适配器自己的 spawn 链。

## 4. 死法分类学(FLY-1639 §2.6/§7.4)

此病属「**能力供给被静默剥夺**」:适配器成功、runner 零报错跑完、失败表现为缺席。23 项常规观测全瞎,唯凭据台账 `completed_no_artifact` 可见。FLY-1639 建议的观测点:启动后自检必需能力到位,缺了按 launch 阶段失败上报。

## 5. 方案空间

### 修法 (a):三个名字加进 `RUNNER_ALLOWED_FLYWHEEL_ENV` 【QA 建议,首选】

- 最小 diff(一处 Set 加三行 + 注释更正)。
- 与白名单既有意图一致:名单上已有 `FLYWHEEL_INGEST_TOKEN`(scoped ingest token)—— per-execution、单用途、带过期的凭据,runner 本就是预期持有者。白名单要挡的是 Bridge 侧第三方 secret / Keychain 坐标 / broker socket,不是发给 runner 自己的作业凭据。
- 保留白名单作为 per-name 安全 review 咽喉点。

### 修法 (b):只洗继承 base,再叠适配器显式值

- 更治本(显式意图结构性不再可能被洗掉),但:
  - 需要改 `spawnCodexDaemon` API(拆 baseEnv / explicitEnv 两参),侵入面大;
  - 需复核 `buildDaemonEnv` 每个显式值的安全性;
  - **弱化安全契约**:未来任何人加显式值都自动绕过 wash,失去 per-name review 咽喉点。
- 结论:不采纳。(a) + 防漂移守卫测试可达到同等防复发效果,且保留咽喉点。

### 增补 1:防漂移守卫测试(结构性防复发)

单测:构造全字段 `AdapterExecutionContext` → `buildDaemonEnv` → 对结果跑 `stripInheritedSecretEnv` → 断言所有 `FLYWHEEL_*` key 原样存活。未来任何人往 `buildDaemonEnv` 加名字而忘了注册白名单,测试红。这是治 bug class,不只治本例。

### 增补 2:launch 自检(FLY-1639 建议,「顺手加,小」)

spawn 收口处:若 ctx 携带 workflow 凭据而最终 env 缺失 → launch 阶段 fail loud(而非静默跑完)。属 belt-and-suspenders;规模小,建议随本单加。是否折进本单或留 B 单 = 设计决策之一,plan 中定。

## 6. 验收(issue 原文)

1. 同款受控对照复跑:Codex carrier 的凭据 consumed 非空 + node_output 落行
2. tpl_generic + codex 真机走通 execute→needs_review→approve gate 全链
3. 回归:Claude carrier 行为不变

## 7. 边界

- 本单只修 Codex spawn 链的凭据投递;不动 Claude 路径、不动 Bridge/Blueprint 上游、不动凭据台账语义。
- FLY-1639 的全套 23 项观测盲区治理不在本单;只顺手落最小 launch 自检(若 plan 采纳)。
