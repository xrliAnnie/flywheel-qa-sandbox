# FLY-2184 529 driver 身份变量缺口与 PR head 竞态 — 调研

Issue: FLY-2184 (https://linear.app/geoforge3d/issue/FLY-2184/529driver-buildslotcommenv-漏-4-个-summary-身份变量-pr-head-读写竞态-生产-pane-跑)
日期: 2026-08-31
基于: exploration.md

本文核实 exploration.md 留下的 4 个开放问题,并把关键契约钉到行号级证据。

## 1. 权威投影与消费路径(缺口①方案 A 的可行性)

### 1.1 CLI 已具备全部所需能力,零新增

- `lead-identity resolve --format env`:`commands/lead-identity.ts:104-117`,
  `--format` 只认 `json|env`;env 分支逐行输出 `identityEnvProjection(identity)`。
- `identityEnvProjection`(:169-199)输出 **17+ 行** KV,含全部 4 个 summary
  变量、`DISCORD_IDENTITY_MODE=managed`、双别名(`FLYWHEEL_LEAD_ID`+`LEAD_ID`、
  `FLYWHEEL_PROJECT_NAME`+`PROJECT_NAME`)与两个 digest——与
  `assertLeadIdentityIntegrity` 的比较集是**同一文件族维护的同一词表**。
  可选行(`FLYWHEEL_LEAD_MODEL`/`EFFORT`/`MODEL_CONTEXT_WINDOW`)仅在字段存在
  时输出,对校验无影响,overlay 原样透传即可。
- `--summary-config-home`(:40,:45-53):仅 resolve 子命令合法,要求绝对路径,
  传给 `resolveLeadIdentity({... homeDir})`(:107-112)。**driver 只需把现有
  resolve 调用加 `--format env --summary-config-home <room.summaryConfigHome>`。**
- 解析格式:每行 `KEY=VALUE`,按**第一个 `=`** 切分。value 可能为空串
  (`FLYWHEEL_SUMMARY_GRANULARITY=`、`DISCORD_EXPECTED_BOT_USER_ID=`)。
  registry 值经 `parseProjects` 校验,路径类值不含换行(`summary-config-home`
  同款校验在 `lead-lease.ts:77-90` 拒绝 `\r\n`)。目前仓内尚无 `--format env`
  的脚本消费者(wrapper v2 走 `--format json` + jq 自行投影,
  `flywheel-lead-wrapper-v2.sh:239`),driver 是第一个——解析器要配单测。

### 1.2 写时校验的再解析与 env 的一致性闭环

写路径:`respond`/`send` → `authorizeLeadWrite`(`lead-lease.ts:2726`)→
`assertLeadIdentityIntegrity`(:2569)→ `resolveLeadIdentity({homeDir:
canonicalIdentityHomeDir(env)})`(:2591)。`canonicalIdentityHomeDir`(:77)
优先 `env.FLYWHEEL_SUMMARY_CONFIG_HOME`,否则 `env.HOME`。

⇒ 闭环条件:**driver 启动 resolve 用的 summary-config home,必须与
buildSlotCommEnv 塞进 CLI env 的 `FLYWHEEL_SUMMARY_CONFIG_HOME` 指同一目录**,
两次解析才必然产出同一组 summary 字段与 digest。两处都指
`<slot>/identity-home`(房内 Bridge 同源,`test-deploy.sh:716,1748`)即闭环。

反证(为什么不能继续用生产 HOME):
- `readSummaryGranularity`(`summary-config.ts:49`)返回 `unselected` 时
  `compileSummaryAssignmentRows` 直接抛 `summary_granularity_unselected`
  (`summary-assignment-core.ts:54`)⇒ 操作机没有
  `~/.flywheel/summary-config.json` 时 driver 启动即死。
- 生产改选 per-project 时,driver 与房内 Bridge 的 granularity/digest 词表
  分叉(digest = `sha256(JSON.stringify(canonical))`,canonical 含
  granularity,`summary-assignment-core.ts:114-118`)。
- FLY-2030 在 test-deploy.sh:712-715 写明设计意图:「QA 不依赖也不改
  operator 真 HOME」。driver 现状违反该意图,本次一并归位。

### 1.3 room-info 增字段的兼容性核查

`room-info.json` 全部读者:
- driver(`validateRoomInfo`,唯一做字段校验的读者);
- `inject-linear-issue.sh:109-120`(只读 `.generalized`,additive-safe);
- `scripts/lib/qa-generalized.sh:281`(teardown 只删文件);
- `test-deploy.sh:1910-1929`(writer,jq -n 单点)。

⇒ 增 `summaryConfigHome` 字段仅需改 writer 一处 + `validateRoomInfo` 的
required 列表一处。**旧房兼容性由既有机制天然解决**:driver 与 test-deploy
同仓,driver 更新必然使 `room checkout drifted`(driver main:1332-1338,
`checkoutHead !== room.buildSha` fail-closed)逼迫重建房;不存在
「新 driver 读旧房」的存活路径。校验错误信息按此写:提示 teardown + 重新
`test-deploy.sh … --generalized` 即可。

### 1.4 deny 残留面(加固项的证据)

`persistIdentityIntegrityAudit`(`lead-lease.ts:2643-2644`)写
`env.FLYWHEEL_LEAD_LEASE_DB ?? join(homedir(), ".flywheel", "lead-lease.db")`。
`homedir()` 是 os-level(不吃 env.HOME)⇒ 从生产 pane 跑 driver 时 deny 审计
落**生产** `~/.flywheel/lead-lease.db`(FLY-2155 实测已发生一次)。
buildSlotCommEnv pin `FLYWHEEL_LEAD_LEASE_DB=<slotDir>/lead-lease.db` 即隔离;
lease mode 已是 `off`,该库只承接 deny/audit 残写,slot 本地化无副作用。

## 2. 缺口②:竞态窗口与重试判别矩阵

### 2.1 事实链

- `commitFile`(stub:214-225):写文件 → add → commit → `git push origin HEAD`
  → 返回**本地** `rev-parse HEAD`。push 对 remote ref 同步生效。
- `ensurePullRequest`(stub:302-376):立即 `gh pr list --json
  number,url,isDraft,headRefOid,title,body`;:354-361 要求恰 1 行、非 draft、
  `headRefOid === head`、title 相符,否则抛
  `sandbox PR authority mismatch: <rows>`。
- GitHub 的 pr list/view 是读模型,push/create 后由后台刷新,秒级但**无上界
  保证**。已在 FLY-2155 实测踩中(step6 窗口:attempt 2 push 到既有 PR 后
  立刻 list)。
- 同族暴露面:
  - create 分支(stub:324-353):`gh pr create` 后立刻 list,可能短暂 `[]`;
  - driver step8:`remotePrFromStub`(driver:625-640,`gh pr view`)→
    `validateQaShipPreconditions`(lib:776-811)的
    `sandbox_pr_head_mismatch` ⇒ 会把纯竞态误诊成 A3
    「diagnosed_not_released」并终止 QA 会话(driver:1117-1170)——
    诊断出口本身是合法路径,但**喂给它过期读数就是假诊断**。

### 2.2 重试判别矩阵(纯分类器的规格)

| 观察 | 判别 | 理由 |
|---|---|---|
| `rows.length === 0` | retry | create/push 读模型未收敛 |
| `headRefOid !== expectedHead` | retry | push 读模型未收敛(也可能真错,超时后由 fatal 兜底) |
| `rows.length > 1` | fatal | 同分支双开 PR 是结构性错误,等不来收敛 |
| `isDraft === true` | fatal | 状态不会因等待而变 |
| `title !== expected` | fatal | create 后 title 不变 |
| 超时仍 retry 态 | fatal(带 expected/observed 双 head + 尝试次数) | 保留原 authority 护栏,只是把「一次读数」升级为「有界收敛证明」 |

轮询参数:间隔 5s × 12 次(≈60s 上界)。driver 步级 waitFor 上界是 15min
(`DEFAULT_TIMEOUT_MS`,driver:48),60s 子轮询远在其内;GitHub 读模型
正常收敛在个位数秒,12 次给足余量又不掩盖真故障。

### 2.3 async 化的机械代价

stub `main` 已是 async(stub:531),有 `sleep`(:186);
`completeImplement`(:378)与 `ensurePullRequest`(:302)改 async 后,
唯一调用点 switch 分支(:593)加 `await` 即可。driver 侧 `runDrillSteps`
已 async,包装 `remotePrFromStub` 为有界轮询无结构变化。

## 3. 测试地基核查

### 3.1 CI 构建顺序(开放问题 4 的答案)

lib 测试跑在 `.github/workflows/ci.yml` 的 `script-tests-2` job(:425),
步骤顺序:checkout → pnpm install → **`pnpm build`**(:473-474)→ …→
`node --test scripts/__tests__/qa-generalized-e2e-lib.test.mjs`(:567)。
⇒ **CI 里 dist 一定先于测试存在**,「真校验器对照组」测试可直接
`import('…/packages/flywheel-comm/dist/lead-lease.js')` 取
`authorizeLeadWrite`(dist 按模块保留,`dist/lead-lease.js` 与
`dist/commands/lead-identity.js` 均存在)。本地未 build 时该测试**响亮地红**
(import 失败),不做 skip——skip 即两态一痕
([[feedback_two_states_one_trace]]):跑了没跑分不出来。

### 3.2 现有测试的缺陷与对照组设计

现有 `slot comm env overrides …` 测试(lib test:72-144)手造 identity
fixture(不含 summary 字段)、手抄期望 env——词表三抄,校验器缺席,
恰是 [[feedback_membership_test_fed_a_preresolved_input_proves_nothing]]。
对照组测试规格:

1. temp dir 造 projects.json + `identity-home/.flywheel/summary-config.json`
   (per-lead)——形状抄 `createTestLeadIdentityEnvs`
   (flywheel-comm `__tests__/helpers/lead-identity-env.ts`,它就是这么造的);
2. 跑**真 CLI** `dist/index.js lead-identity resolve --format env
   --summary-config-home <temp>/identity-home`,用**被测解析器**解析;
3. `buildSlotCommEnv` 组出 env,喂**真校验器** dist `authorizeLeadWrite`;
4. 断言不抛(disposition `off`);再做错形状对照:baseEnv 预置 4 个 summary
   变量的**错值**,断言 overlay 后仍通过(证明覆盖生效);把其中一个键从
   投影里删掉重组 env,断言 deny `identity_env_conflict`(证明校验器真的在看,
   测试没有空转)。

未来 flywheel-comm 加第 5 个身份变量时:CLI 输出自动带上、overlay 自动透传、
对照组吃真校验器自动跟进——FLY-2030 式漏改在这条测试上**无法再静默发生**。

## 4. 改动面清单(供 plan 分 chunk)

| 文件 | 改动 | 性质 |
|---|---|---|
| `scripts/lib/qa-generalized-e2e-lib.mjs` | `buildSlotCommEnv` 改收权威投影 KV + 必备键守卫;新增 env-format 解析器;新增 PR head 纯分类器 | 核心 |
| `scripts/qa-529-generalized-e2e.mjs` | resolve 改 `--format env --summary-config-home`;step8 remote PR 读取套有界轮询 | 核心 |
| `scripts/qa-529-generalized-stub.mjs` | `ensurePullRequest` 改有界轮询 + async 化 | 核心 |
| `scripts/test-deploy.sh` | room-info 增 `summaryConfigHome` | 契约 |
| `scripts/__tests__/qa-generalized-e2e-lib.test.mjs` | 重写 env 测试 + 对照组 + 分类器 table-driven | 测试 |
| flywheel-comm / lead-lease / CLI | **零改动** | — |

## 5. 风险与边界

- **不修**:沙箱孤儿 PR 收口(FLY-2164);`flywheel-lead-wrapper-v2.sh` 的
  json+jq 镜像投影(生产路径,另立 issue 才动);校验方任何行为。
- 残余风险:`gh` CLI 输出契约变化(字段改名)会让分类器 fatal——可接受,
  fatal 带原始 rows,诊断成本低。
- 回滚边界:全部改动都在 QA driver/stub/lib/test-deploy,ревert 单 PR 即回滚,
  不触生产控制面。
