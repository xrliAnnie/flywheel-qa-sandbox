# FLY-1643 Codex 适配器不投递 workflow 凭据 — 调研

Issue: FLY-1643 (https://linear.app/geoforge3d/issue/FLY-1643/引擎bug高优-codex-适配器不向-runner-投递-output-credential-vendorcodex-的-produces)
日期: 2026-08-05
基于: exploration.md

## 1. 完整链路(逐行核实,base = main `6fbc4292`)

### 1.1 上游(健康)

- Bridge 发凭据:`StateStore` 的 `rotateGeneralizedWorkflowOutputCredential` / `rotateGeneralizedWorkflowSubmissionCredential`(`workflow-engine-dispatcher.ts:1980/1994`,retry 路径 `actions.ts:1138`、`runs-route.ts:2773` 同款)。
- 凭据表带 `issued_at / expires_at / absolute_deadline_at / consumed_at / attempt`(`StateStore.ts:1580-1597`)—— **per-execution、per-attempt、带过期、单次消费**。
- 派发透传:`run-dispatcher.ts:860/1481` → `Blueprint.ts:2664-2666`(ctx.workflowSubmissionCredential / workflowOutputCredential)→ adapter ctx。FLY-1638 真机已实证 runs-route 透传完好。

### 1.2 Claude 路径(对照组,健康)

`TmuxAdapter.ts:452-466`:三个 env 经 `tmux new-window -e KEY=VALUE` argv 直投 pane。链路无 wash。真机对照:16:37 发出 → 16:41 consumed → node_output 落行。

### 1.3 Codex 路径(断点)

```
buildDaemonEnv (CodexTmuxAdapter.ts:1409-1468)
  = stripInheritedSecretEnv(process.env)     ← 第一次 wash:洗继承 base,意图正确
  + 显式叠加 FLYWHEEL_* 17+3 个              ← :1434-1440 三个 workflow env 在此设置 ✓
      ↓ 作为 opts.env 传入
spawnCodexDaemon (codex-daemon-runtime.ts:494-524)
  env: { ...stripInheritedSecretEnv(opts.env), CODEX_HOME }   ← :520 第二次 wash
      ↓ keepInheritedEnv (codex-home.ts:237-243)
      FLYWHEEL_* 必须命中 RUNNER_ALLOWED_FLYWHEEL_ENV 精确白名单 (:136-156, 17 条)
      三个 workflow 名不在 → DROPPED               ← ★ 断点
      ↓
codex app-server 进程 env 无凭据 → 模型 shell 跑 flywheel-comm workflow-output
  → "FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL is required" (workflow-output.ts:33)
  → 节点跑完零 artifact → 台账 completed_no_artifact
```

**为什么其余 17 个 env 都活着**:`buildDaemonEnv` 设置的其他名字(GATE_MARKER_DIR、COMM_DB、EXEC_ID、INGEST_TOKEN、AGENT_NAME…)恰好全部在白名单上 —— 它们是 FLY-1188 建名单时的「当时全集」。名单注释自述:These are the SAME names the adapter's buildDaemonEnv sets explicitly。**名单与 buildDaemonEnv 曾经是镜像,后来漂移了。**

### 1.4 漂移时间线(git 考古)

| 提交 | 往 buildDaemonEnv 加的 env | 同步注册白名单? |
|---|---|---|
| FLY-1244 (#593) claims-backed templates | `FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL` | ❌ |
| `c989ee5f` generalize DAG template execution | `FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL` | ❌ |
| FLY-1425 (#673) fail loud on missing QA decisions | `FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED` | ❌ |

三次独立提交、三次同样的漏 —— 这是 **bug class**(上游加 env、下游 wash 静默丢),不是一次手误。任何只加名字的修法,若不加防漂移守卫,第四次必然重演。

### 1.5 消费端(反向印证)

- `flywheel-comm workflow-output`(`workflow-output.ts:28-33`):env 缺失即 throw。
- `qa-result.ts:172-190`:`SUBMISSION_EXPECTED === "1"` 才强制要求凭据;报错文案 "do not use env -u or a shell that drops the runner environment" —— 实际丢 env 的是适配器自己的 spawn 链。
- `workflow-activation.ts:29-30`:两个凭据名的 env 名类型联合。
- ⇒ **`SUBMISSION_EXPECTED` 丢失的独立危害**(FLY-1639 复核第 1 条):它是「本节点必须交东西」的信号。丢了它,`qa-result` 不再强制要求凭据 → runner 连「该交作业」都不知道,静默降级为不交。所以修法必须**三个名字全加**,只加两个凭据 = 拿到钥匙仍不知道要交。

## 2. 安全论证:三个名字加白名单是否破坏 FLY-1188 契约?

白名单的威胁模型(`codex-home.ts:124-134` 注释原文):挡的是 **Bridge 侧 auth-capable 句柄** —— `FLYWHEEL_*_KEYCHAIN_SERVICE/_ACCOUNT`(Keychain 坐标)、`FLYWHEEL_WRAPPER_ENV_FILE`(secret .env 路径)、`FLYWHEEL_GATEWAY_BROKER_SOCKET`(权限 broker socket)。这些是**属于 Bridge、不属于 runner** 的能力。

三个 workflow env 的属性:

| env | 性质 | 预期持有者 |
|---|---|---|
| `FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL` | per-execution/attempt、带 `expires_at` + `absolute_deadline_at`、单次 `consumed_at`、可 `revoked` 的作业凭据 | **runner 本人**(不给它节点交不了 artifact) |
| `FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL` | 同上(decision 节点交 verdict 用) | **runner 本人** |
| `FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED` | 字面 `"1"` 的信号 flag,零秘密含量 | runner 本人 |

同类先例已在名单上:`FLYWHEEL_INGEST_TOKEN` —— scoped、发给 runner 自己用的 ingest token。两凭据与它同信任级(实际更窄:单次消费+过期)。**结论:加名单与既有意图一致。如实措辞(Codex R1 #6):这是对联网模型 shell 的一次有意、必要的授权面扩大 —— runner 本就是凭据的预期持有者,不交它节点必死。残余后果:凭据泄漏最坏可为当前 execution/attempt 冒交一次 output / 一个允许谓词族内的 verdict,受 loopback 路由、execution/attempt 绑定、expiry/revocation、单次消费/幂等重放约束(消费端逐项核实);台账可审计(consumed_at/attempt 绑定),过期自灭。**

## 3. 为什么不选修法 (b)(只洗继承 base、显式值免洗)

1. `spawnCodexDaemon` 收到的是**一个合并后的 env 对象**,无从区分「继承」与「显式」—— 实现 (b) 必须拆 API 成 `baseEnv` + `explicitEnv` 两参,所有调用点(含测试)跟着改,侵入面大。
2. 二次 wash 的存在价值是防御其他调用方直接传 raw env;(b) 之后**任何未来显式值自动免洗**,失去 per-name 安全 review 咽喉点 —— 一个未来开发者把某个 secret-carrying 值放进显式层,不会再有任何机制拦截。
3. (a) + 防漂移守卫测试达到与 (b) 同等的防复发效果(往 buildDaemonEnv 加名忘注册 → 测试红,PR 过不去),且保留咽喉点。

## 4. 测试落点(现状)

- `packages/claude-runner/test/codex-home.test.ts` — `stripInheritedSecretEnv` 既有测试在此;白名单三名字 + `assertRunnerEnvDeliverable` 语义单测落这里。
- `packages/claude-runner/test/CodexTmuxAdapter.test.ts` — `buildDaemonEnv` 相关;防漂移守卫(buildDaemonEnv 输出 ∘ stripInheritedSecretEnv 不变性)、自检**接线**(execute reject 合同)、provenance 哨兵落这里。
- `packages/claude-runner/test/codex-daemon-runtime.test.ts` — spawn env 合成;**最终 spawn 投递**(终点取证)测试落这里。
- `packages/edge-worker/src/__tests__/Blueprint.test.ts` — adapter reject → `emitFailed` 逐字传递的边界测试落这里(既有覆盖缺失,R2 核实)。

## 5. launch 自检的可行位置(增补 2 评估;R1 #1 + R2 #3 修正后)

~~spawn 前/内断言~~(初稿位置,R1 推翻:`buildDaemonEnv` 的调用点在 execute() 的 try 内,抛错被 :844-846 内层 catch 吞成无名 `success:false`,到不了 Blueprint 的 adapter-throw catch,fail-loud 合同不成立)。
**修正位置**:env 构造+`assertRunnerEnvDeliverable` 前移到 **execute() 序幕的 fail-loud 区** —— `resolveGitWritableDirs` 之后、`provisionGitHubCredential`/`provisionCodexHome` **之前**(此后 CODEX_HOME 持活 GH_TOKEN,try 外抛错会泄 token)。违例 **reject execute() 的 promise** → Blueprint adapter-throw catch(:2704)→ 点名变量的 `session_failed`(Lead 可见);`runtimeFactory` 不被调用。
成本:~25 行 + 测试。价值:把「能力供给被静默剥夺」这类死法从「23 项观测全瞎」变成 launch 即炸。与守卫测试互补(测试防代码漂移,自检防运行时环境/调用方差异)。**随本单落。**

## 6. 回归面

- Claude 路径零改动(不碰 `TmuxAdapter.ts`)。
- Codex 路径改动 = 白名单 +3 名字、**provenance delete-then-layer**(第一次 wash 后无条件删三键、只从 ctx 层叠 —— ctx 是唯一供值来源,防陈旧继承凭据跨 execution 投毒,R2 #1)、env 构造+自检前移 execute 序幕、注释更正。其余 17 名字行为不变;非 FLYWHEEL env 的 wash 行为不变;proxy 清洗不变。
- 需更正的注释:`codex-daemon-runtime.ts:518-519`「FLYWHEEL_* … is preserved」→ 改为「on the RUNNER_ALLOWED_FLYWHEEL_ENV allowlist is preserved」;`CodexTmuxAdapter.ts:1413-1417` 同款措辞一并校准。
