# FLY-2184 529 driver 身份变量缺口与 PR head 竞态 — 探索

Issue: FLY-2184 (https://linear.app/geoforge3d/issue/FLY-2184/529driver-buildslotcommenv-漏-4-个-summary-身份变量-pr-head-读写竞态-生产-pane-跑)
日期: 2026-08-31
基于: 无

## 问题陈述

FLY-2155 QA(exec 6fb5ec6a)在 529 generalized 房实测出两个 **driver 侧**缺口:

1. **step5 `identity_env_conflict`**:`scripts/lib/qa-generalized-e2e-lib.mjs` 的
   `buildSlotCommEnv` 覆盖了大部分身份变量,但漏了
   `FLYWHEEL_LEAD_SUMMARY_ROLE` / `FLYWHEEL_LEAD_HAS_SUMMARY_DUTY` /
   `FLYWHEEL_SUMMARY_GRANULARITY` / `FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST` 四个;
   `lead-lease.ts` 的身份完整性校验要求四者等于房内身份值 ⇒ 从生产 runner pane
   跑 driver 必撞 step5。
2. **step6 `sandbox PR authority mismatch`**:stub 在 `git push` 后**立即**
   `gh pr list` 读 `headRefOid`,GitHub PR 读模型异步更新,读到推送前的旧 head
   ⇒ 误报 authority mismatch。

附带说明:沙箱孤儿 PR 积压(#133-#147)收口归 FLY-2164,不在本 issue 范围。

## 代码审计:缺口① 完整链路

### 校验方(权威,不改)

- `packages/flywheel-comm/src/lead-lease.ts:2726` `authorizeLeadWrite` 是所有
  Lead 写(`respond`、`send`,见 `commands/respond.ts:63`、`commands/send.ts:19`)
  的共享闸口。
- 它**先**跑 `assertLeadIdentityIntegrity`(`lead-lease.ts:2569`)**再**看 lease
  mode——注释(2564)明说身份完整性不是 lease rollout control,
  `FLYWHEEL_LEAD_LEASE_MODE=off` 挡不住它。这是设计意图,不是 bug。
- 校验在 `lead-lease.ts:2613-2626` 严格比较(节选):

  ```ts
  env.FLYWHEEL_LEAD_SUMMARY_ROLE !== identity.summaryRole ||
  env.FLYWHEEL_LEAD_HAS_SUMMARY_DUTY !== (identity.hasSummaryDuty ? "1" : "0") ||
  env.FLYWHEEL_SUMMARY_GRANULARITY !== (identity.summaryGranularity ?? "") ||
  env.FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST !== (identity.summaryAssignmentDigest ?? "")
  ```

  `summaryRole` 是必填 enum(`producer|aggregator|recipient|exempt`,
  `lead-identity.ts:241-248`)⇒ env 缺失(undefined)**永远不等于**它。
  **推论:issue 里「补齐或显式 scrub」两个修法中,scrub 不可行,只能补齐。**

### 触发方(driver,要改)

- driver `scripts/qa-529-generalized-e2e.mjs` 启动时经 CLI
  `lead-identity resolve --format json` 解出房内 canonical identity(main:1374),
  每次 `runComm`(:545)用 `buildSlotCommEnv(process.env, …)` 组 CLI 子进程 env。
- `buildSlotCommEnv`(lib:155)投影了 15 个变量(LEAD_ID、LEAD_KEY、digest 等)
  但没投影 4 个 summary 变量 ⇒ 生产 pane 的 `process.env` 里这四个值
  (生产 Lead 的值,或根本没有)原样透传 ⇒ step5 的 `respond --lead`
  被 `authorizeLeadWrite` deny(`identity_env_conflict`)。

### 根因时序(为什么会漏)

- PR #847 写下 `buildSlotCommEnv`(当时校验里还没有 summary 变量)。
- PR #975(FLY-2030)给 canonical identity 加上 4 个 summary 字段,同步更新了
  `assertLeadIdentityIntegrity`、`forwardedLeadAuthorizationEnv`
  (lead-lease.ts:2693)、CLI `identityEnvProjection`
  (commands/lead-identity.ts:169)与测试 helper
  `createTestLeadIdentityEnvs`——**唯独漏了 driver 的 `buildSlotCommEnv`**。
- 即:「identity → env 投影」这份词表存在 ≥4 份镜像,#975 改了 3 份漏 1 份。
  这正是本设计要消除的结构性风险:**driver 不该再手写一份投影,应消费
  flywheel-comm 已有的权威投影**(`lead-identity resolve --format env`,
  输出恰好含全部 4 个变量 + `DISCORD_IDENTITY_MODE=managed`)。

### 同族隐患(审计中新发现,一并列出供 plan 决策)

1. **granularity 来源漂移**:校验方解 identity 时 homeDir 取
   `FLYWHEEL_SUMMARY_CONFIG_HOME ?? HOME`(`lead-lease.ts:77
   canonicalIdentityHomeDir`),而 529 房自己的 Bridge 用的是
   `${SLOT_DIR}/identity-home`(`test-deploy.sh:716`,FLY-2030 注释明说
   「QA 不依赖也不改 operator 真 HOME」)。driver 目前两处(启动 resolve、
   写时校验)都落在 operator 生产 HOME:今天恰好能对上(生产选择恰为
   per-lead,与房内一致),但生产 `summary-config.json` 缺失时
   `compileSummaryAssignmentRows` 直接抛 `summary_granularity_unselected`
   (`summary-assignment-core.ts:54`),生产改选 per-project 时 driver 的身份
   词表会静默偏离房内 Bridge。CLI 已有 `--summary-config-home` 参数
   (commands/lead-identity.ts:40),补上即可根治。
2. **deny 路径写生产库**:`persistIdentityIntegrityAudit`(lead-lease.ts:2636)
   在 deny 时把 `blocked` audit 写进 `FLYWHEEL_LEAD_LEASE_DB ??
   ~/.flywheel/lead-lease.db`——driver 从生产 pane 跑、又没 pin 这个变量
   ⇒ QA 钻探的失败痕迹落进**生产** lease DB(FLY-2155 那次实测已经发生)。
   一行 pin 到 slot 本地即可止血。

## 代码审计:缺口② 完整链路

- stub `scripts/qa-529-generalized-stub.mjs`:`commitFile`(:214)
  `git push origin HEAD` 后返回本地 `rev-parse HEAD`;`ensurePullRequest`
  (:302)**立即** `gh pr list --json headRefOid`,在 :354-361 要求
  `rows[0].headRefOid === head`,否则抛 `sandbox PR authority mismatch`。
- `git push` 对 ref 是同步的;滞后的是 GitHub **PR 读模型**(pr list/view 的
  `headRefOid` 由后台任务刷新)。所以「读 push 返回值」不能消除竞态——
  本地 head 本来就有(`commitFile` 返回值就是),要等的是 PR API 视图收敛。
  **正确修法是 push 后 poll `gh pr list` 至 head 一致(有界超时,超时后
  带上 expected/observed 双 head 抛原诊断)。**
- 同一竞态还有两个次级暴露面:
  - create 分支:`gh pr create` 后立刻 `pr list` 可能短暂返回 `[]`(同为读模型
    滞后)⇒ rows.length !== 1 误判;
  - driver 侧:step8 的 `remotePrFromStub`(driver:625)→
    `validateQaShipPreconditions` 的 `sandbox_pr_head_mismatch`(lib:800)。
    窗口远小(step7 等待期已消耗数十秒),但同族,可顺手共用同一 poll 语义。
- 判别哪些 mismatch 可重试:`rows` 为空、`headRefOid` 落后 ⇒ 最终一致性,
  可重试;`rows.length > 1`、`isDraft`、title 不符 ⇒ 结构性错误,立即抛。
- stub 主循环是 async(`main`:531,已有 `sleep` helper:186),
  `ensurePullRequest`/`completeImplement` 改 async 是机械改动。

## 候选方案

### 缺口①

- **方案 A(推荐):driver 消费权威投影。**
  driver 启动改调 `lead-identity resolve --format env
  --summary-config-home <slot>/identity-home`,把输出解析成 KV;
  `buildSlotCommEnv` 改收这份 KV:先做必备键 fail-closed 校验,再整体
  overlay 到 baseEnv 上,最后叠 comm 坐标(COMM_DB、PROJECTS_FILE、
  LEASE_MODE=off、SUMMARY_CONFIG_HOME、LEASE_DB pin)。
  优点:未来 flywheel-comm 加第 5 个身份变量时,CLI 输出自动带上、overlay
  自动透传,drift 从「静默漏值」降级为「自动跟上」;必备键清单只是守卫
  (缺了就抛),不是值的第二来源。
- **方案 B:在 buildSlotCommEnv 手补 4 行**(镜像 `identityEnvProjection`
  的公式)。改动最小,但词表镜像 +1,FLY-2030 式漏改还会再发生。
- **方案 C:显式 scrub 四变量。** 已证不可行(summaryRole 必填,undefined
  永不相等),仅记录以封死这条路。

### 缺口②

- **方案 A(推荐):共享 lib 提供纯分类器 + 注入式 poll。**
  在 `qa-generalized-e2e-lib.mjs` 加一个纯函数(输入:期望 head、观察到的
  rows、期望 title;输出:`converged` / `retry` / `fatal`+原因),stub 与
  driver 各自用自己的 `gh` runner + sleep 包一层有界 poll(如 12 次 × 5s)。
  纯函数可 table-driven 单测,竞态语义只写一遍。
- **方案 B:只在 stub 内联 retry 循环。** 改动最小,但 driver 侧
  step8 的同族窗口仍在,且竞态语义没有单测锚点。
- **方案 C:放宽/删除 head 比较。** 拒绝——这个比较就是「PR 确实指着我们
  推的提交」的 authority 证明,删了等于拆护栏。

## 影响面与消费者

- `buildSlotCommEnv` 唯一调用方是 driver 的 `runComm`(driver:558);
  签名变更只影响 driver + `scripts/__tests__/qa-generalized-e2e-lib.test.mjs`。
- `ensurePullRequest` 唯一调用方是 stub 的 `completeImplement`(stub:395)。
- 校验方(lead-lease.ts / lead-identity.ts / CLI)**零改动**——本 issue
  全部修在 driver/stub/lib/test-deploy(房方 manifest 若采纳 room-info 增字段)。
- 现有测试「slot comm env overrides every ambient or caller registry
  coordinate」(lib test:72)自己喂自造 identity fixture,恰是
  [[feedback_membership_test_fed_a_preresolved_input_proves_nothing]] 的形状:
  它验的是自己的词表,验不出与真校验器的失配。测试策略必须补
  「真校验器对照组」:用 dist 的 `authorizeLeadWrite` 直接吃
  buildSlotCommEnv 的产物,不通过即红。

## 开放问题(带到 research/plan)

1. `<slot>/identity-home` 路径 driver 怎么拿:room-info.json 增 required 字段
   `summaryConfigHome`(test-deploy 写、validateRoomInfo 校验,fail-closed
   提示重建房)vs driver 按 slotDir 约定推导。倾向前者;旧房兼容性无虞——
   driver 代码更新必然伴随 `room checkout drifted` 校验强制重建房。
2. `FLYWHEEL_LEAD_LEASE_DB` pin 到 slot 本地是本 issue 之外的一行加固
   (deny 残留写生产库),按
   [[feedback_a_silent_scope_widening_is_a_finding_even_when_harmless]]
   显式列出、在 plan 里单独成 chunk 论证,不悄悄夹带。
3. poll 参数(次数 × 间隔)与「create 后 rows 为空」是否同用重试语义。
4. dist 依赖:真校验器对照组测试需要 `packages/flywheel-comm/dist` 已构建;
   research 阶段核实 scripts 测试在 CI 里的构建顺序,禁止「dist 缺失就
   silently skip」(两态一痕)。
