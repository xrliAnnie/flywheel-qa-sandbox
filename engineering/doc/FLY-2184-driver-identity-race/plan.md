# FLY-2184 529 driver 身份变量缺口与 PR head 竞态 — 实施计划

Issue: FLY-2184 (https://linear.app/geoforge3d/issue/FLY-2184/529driver-buildslotcommenv-漏-4-个-summary-身份变量-pr-head-读写竞态-生产-pane-跑)
日期: 2026-08-31
基于: research.md

## 目标 / 非目标

**目标**
1. 从生产 runner pane 跑 `scripts/qa-529-generalized-e2e.mjs` 不再撞 step5
   `identity_env_conflict`:driver 的 CLI 子进程 env 携带与房内 canonical
   identity 完全一致的**全套**身份变量(含 4 个 summary 变量)。
2. 消除 step6/step8 的 PR head 读写竞态:push/create 后对 GitHub PR 读模型做
   **有界轮询收敛**,而不是单次读数;authority 护栏语义不变。
3. 结构性根治镜像词表:driver 不再手抄「identity → env」投影,改消费
   flywheel-comm 权威投影(`lead-identity resolve --format env`),并用
   **真校验器对照组测试**锁死(dist `authorizeLeadWrite` 直接吃 driver 产物)。

**非目标**
- 不改校验方(`lead-lease.ts` / `lead-identity.ts` / CLI 任何行为)。
- 不收口沙箱孤儿 PR(FLY-2164)。
- 不动 `flywheel-lead-wrapper-v2.sh` 的生产投影(如需去镜像另立 issue)。

## 已定设计决策

| # | 决策 | 依据(见 research.md) |
|---|---|---|
| D1 | driver 改调 `lead-identity resolve --format env`,`buildSlotCommEnv` 改收投影 KV 并整体 overlay;必备键 fail-closed 守卫 | §1.1;scrub 不可行(summaryRole 必填 enum);镜像词表是根因 |
| D2 | resolve 与 CLI env 双侧统一 `--summary-config-home` / `FLYWHEEL_SUMMARY_CONFIG_HOME` = `<slot>/identity-home`;room-info.json 增 **required** 字段 `summaryConfigHome` | §1.2 一致性闭环、§1.3 兼容性(buildSha 校验强制重建房) |
| D3 | `buildSlotCommEnv` 一并 pin `FLYWHEEL_LEAD_LEASE_DB=<slotDir>/lead-lease.db`(显式加固,非夹带:deny 残留现落生产库,FLY-2155 已实测) | §1.4 |
| D4 | PR 读模型收敛做成 lib 纯件:`classifyRemotePrObservation` 分类器 + 依赖注入的 `pollRemotePrAuthority` 轮询器(5s × 12);stub 与 driver step8 共用。轮询器**不抛错**,返回判别联合,进程语义(抛 authority error vs 走 A3 诊断)由调用方决定 | §2 判别矩阵;Codex R1 #1 |
| D5 | stub `ensurePullRequest`/`completeImplement` async 化(机械,唯一调用点加 await) | §2.3 |
| D6 | 对照组测试用真 CLI + 真 `authorizeLeadWrite`(dist),含「删键必 deny」反向探针;dist 缺失时响亮红,不 skip | §3;CI `script-tests-2` 先 `pnpm build` |

## Chunk 划分

### C1 — lib:权威投影消费 + env 组装重写

`scripts/lib/qa-generalized-e2e-lib.mjs`:

```js
export const REQUIRED_IDENTITY_ENV_KEYS = [
  "FLYWHEEL_LEAD_ID", "LEAD_ID",
  "FLYWHEEL_PROJECT_NAME", "PROJECT_NAME",
  "FLYWHEEL_LEAD_KEY", "FLYWHEEL_LEAD_ROLE", "FLYWHEEL_LEAD_BACKEND",
  "FLYWHEEL_LEAD_SUMMARY_ROLE", "FLYWHEEL_LEAD_HAS_SUMMARY_DUTY",
  "FLYWHEEL_SUMMARY_GRANULARITY", "FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST",
  "DISCORD_STATE_DIR", "DISCORD_EXPECTED_BOT_USER_ID",
  "DISCORD_IDENTITY_MODE",
  "FLYWHEEL_LEAD_IDENTITY_DIGEST", "FLYWHEEL_LEAD_PROJECTS_DIGEST",
];
// 允许空值的键(canonical 可为 null → 投影为空串):
// FLYWHEEL_SUMMARY_GRANULARITY / FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST /
// DISCORD_EXPECTED_BOT_USER_ID

export function parseIdentityEnvProjection(text)
// 按行解析,第一个 "=" 切分;拒绝:无 "=" 的非空行、空 KEY、重复 KEY。
// 返回 Record<string,string>(含可选行如 FLYWHEEL_LEAD_MODEL,原样保留)。

export function buildSlotCommEnv(baseEnv, slotComm, identityEnv, overrides = {})
// slotComm = { commDbPath, flywheelProjectsFile, summaryConfigHome,
//              leaseDbPath }  — 四者 requiredString。
// 守卫:REQUIRED_IDENTITY_ENV_KEYS 每键必须存在于 identityEnv;
//       除三个可空键外值必须非空;违规抛错(fail-closed)。
// overlay 顺序(后者胜):
//   { ...baseEnv, ...overrides, ...identityEnv,
//     FLYWHEEL_COMM_DB, FLYWHEEL_PROJECTS_FILE,
//     FLYWHEEL_SUMMARY_CONFIG_HOME, FLYWHEEL_LEAD_LEASE_DB,
//     FLYWHEEL_LEAD_LEASE_MODE: "off" }
// 语义与现状一致:overrides 永远压不过身份/comm 坐标;
// 4 个 summary 变量从此由 identityEnv(权威投影)供给。
```

单测(`scripts/__tests__/qa-generalized-e2e-lib.test.mjs` 重写现有
`slot comm env …` 用例):
- 解析器:首 `=` 切分、空值行、重复键/坏行拒绝;
- 守卫:缺任一必备键 → 抛;必填键空值 → 抛;三个可空键空值 → 过;
- overlay:baseEnv 预置 4 个 summary 变量**错值** → 产物为投影值;
  overrides 试图覆盖 `FLYWHEEL_LEAD_ID`/`FLYWHEEL_COMM_DB` → 被压回;
  非身份键(`EXTRA`)透传。

### C2 — 房方契约:room-info 增 `summaryConfigHome`

- `scripts/test-deploy.sh` room-info writer(:1911-1929)增
  `--arg summaryConfigHome "$QA_SUMMARY_CONFIG_HOME"` + 模板字段
  (无条件写入,不做条件分支)。
- lib `validateRoomInfo` 增校验(Codex R1 #5,不止非空):
  `summaryConfigHome` 必须存在、为**绝对路径**、且**位于本房 slot 目录内**
  (canonical 形态 = `<slotDir>/identity-home`,slotDir 由 `room.slot` 推导;
  slotDir 作为校验锚点而非取值来源——值仍以 room-info 为准,校验只拒绝
  「manifest 指向 operator HOME / 其它 slot」这类越界)。缺失或越界时错误
  信息明说「teardown 后用当前 test-deploy.sh 重建房」。
- 测试:lib 测试的 `ROOM` fixture 增该字段;补 missing / 相对路径 /
  越界路径(指向 `$HOME`)三个拒绝用例;
  `scripts/__tests__/test-deploy-generalized.test.sh` 增断言:jq writer
  **传参且落字段**(静态断言 writer 源码 + 现有 handoff 断言样式,
  参照其 `flywheelProjectsFile` 用例 :498-503)。

### C3 — driver 接线

`scripts/qa-529-generalized-e2e.mjs`:
- 启动 resolve(main:1374)改
  `lead-identity resolve … --format env --summary-config-home
  ${room.summaryConfigHome}` → `parseIdentityEnvProjection`;
- context 从 `leadIdentity` 换 `identityEnv` + `slotComm`
  (`leaseDbPath = join(slotDir, "lead-lease.db")`);
- `runComm`(:545)与两处调用方(gate probe :581/:611)按新签名接线。

### C4 — PR authority 有界收敛

lib 新增:

```js
export const PR_HEAD_POLL = { attempts: 12, intervalMs: 5_000 };

export function classifyRemotePrObservation({ rows, expectedHead, expectedTitle })
// → { kind: "converged", pr } | { kind: "retry", reason } | { kind: "fatal", reason }
// 矩阵见 research.md §2.2:空 rows / head 落后 ⇒ retry;
// 多行 / draft / title 不符 ⇒ fatal;expectedTitle 传 undefined 时跳过 title 判。

export async function pollRemotePrAuthority({ list, sleep, expectedHead,
  expectedTitle, attempts = PR_HEAD_POLL.attempts,
  intervalMs = PR_HEAD_POLL.intervalMs })
// 循环 list() → classify。**永不抛错**(Codex R1 #1),返回判别联合:
//   { kind: "converged", pr, attempts }
// | { kind: "fatal", observation, reason, attempts }      // 结构性错误,立即返回
// | { kind: "exhausted", observation, reason, attempts }  // 重试耗尽
// 进程语义由调用方决定,共享层不替调用方选择抛错还是诊断。
// 「不抛错」只覆盖对**已取得的 observation** 的分类;注入的 list() 自身
// 抛错(gh/网络/JSON)属基础设施失败,照常 fail-fast 传播,不伪装成
// fatal/exhausted(Codex R2 非阻断意见)。
```

- stub `ensurePullRequest` 改 async,流程重排(Codex R1 #2:
  空 rows 是 retry 态,不能当「需要 create」的证据):
  1. **push 之前**先定位既有 PR:优先 durable `state.lastCompletion.prNumber`
     (crash adoption),否则 pre-push `gh pr list --head <branch>`;
  2. `commitFile` push 之后:已知 PR 路径**只 poll 不 create**;
     确认 fresh branch(pre-push 无 open PR 且无 durable prNumber)才
     `gh pr create` 恰一次,随后同样进入 poll;
  3. poll 结果 `fatal`/`exhausted` → 抛原样
     `sandbox PR authority mismatch: …`(附 expected/observed 双 head 与
     尝试次数);`converged` → body reconcile(保持现逻辑)。
  `completeImplement` async 化,调用点(:593)加 `await`。
- driver step8:`remotePrFromStub` 包进同一 `pollRemotePrAuthority`
  (list 返回 `[pr]` 或 `[]`,expectedTitle 不传,expectedHead =
  `qa2.stub.qaReady.expectedHead`);**任何非 converged 结果都不抛**,
  把最后一次 observation(空 → `null`)交给
  `validateQaShipPreconditions`——现有 A3 诊断出口(driver:1117-1170,
  含 draft / closed / missing / head mismatch)完整保留,只是不再吃
  过期读数。

单测:分类器 table-driven 全矩阵;轮询器用注入的 fake list/sleep 验
「stale→fresh 第 N 次收敛」「fatal 短路返回」「耗尽返回 exhausted」;
调用方两组:stub 把 fatal/exhausted 转 authority error(含
「既有 PR + push 后首次观察为空 → 不调用 create、随后收敛」用例),
driver 把非 converged 映射进 preflight/A3(A3 契约不因共享层改变)。

### C5 — 真校验器对照组测试(锁死镜像词表)

**放入现有 `scripts/__tests__/qa-generalized-e2e-lib.test.mjs`**
(Codex R1 #4:CI `script-tests-2` 逐文件点名,新文件没有 CI 消费合同;
不新建文件、不改 workflow):
1. temp HOME:造 projects.json + `identity-home/.flywheel/summary-config.json`
   (per-lead;形状抄 flywheel-comm `__tests__/helpers/lead-identity-env.ts`);
2. 跑真 CLI `packages/flywheel-comm/dist/index.js lead-identity resolve
   --format env --summary-config-home …`,用 `parseIdentityEnvProjection` 解析;
3. `buildSlotCommEnv` 组 env(baseEnv 预置 4 个 summary 变量错值 +
   生产形状的 FLYWHEEL_LEAD_LEASE_DB 错值),`FLYWHEEL_LEAD_LEASE_DB`
   断言被 pin 到 temp;
4. import dist `lead-lease.js` 的 `authorizeLeadWrite`,以该 env 调用 →
   断言不抛且 disposition `off`;
5. 反向探针(Codex R1 #3:探针必须**穿过** assembler 到达真校验器):
   用**完整**投影正常组出合法 env,然后从**最终 env** 上删
   `FLYWHEEL_LEAD_SUMMARY_ROLE`,直接调 dist `authorizeLeadWrite` →
   断言抛且 `error.reason === "identity_env_conflict"`。
   assembler 对缺键 fail-closed 另有独立用例(C1),两层守卫各测各的。
- dist 缺失 ⇒ import 报错测试红,**不写 skip 分支**(两态一痕)。
  CI `script-tests-2` 已先 `pnpm build`(ci.yml:473,:567)。

### C6 — 文档与证据

- 更新本文件夹 progress.md(每 chunk 落一格)。
- PR body:引用本 plan;测试证据 =
  `node --test scripts/__tests__/qa-generalized-e2e-lib.test.mjs`、
  `bash scripts/__tests__/test-deploy-generalized.test.sh`、`pnpm lint`
  相关面、CI 全绿(按
  [[feedback_qa_pass_must_check_ci_status_on_the_exact_head]],绿要看
  **判定头**的 CI)。
- **真机验收归 QA 节点**(非 implement 节点自证):529 房
  `test-deploy.sh 1 --generalized --stub-runner` 后从生产 pane 跑 driver,
  证据 = step5/step6/step8 通过、`~/.flywheel/lead-lease.db` 无新增 QA 行、
  slot `lead-lease.db` 承接残写。驱动配方见
  [[reference_529_generalized_ab_run_recipe]](其路障 2/3 即本 issue,
  验收时应不再需要手工注入 env)。

## 实施顺序与依赖

C1 → C2 → C3 可并为一个提交序列(C3 依赖 C1 签名与 C2 字段);
C4/C5 独立于 C2,可并行;建议单 PR 交付(改动同属 QA driver 面,
拆 PR 反而让 room 契约与 driver 消费者跨 PR 漂移)。

## 回滚边界

全部改动限于 `scripts/`(driver/stub/lib/test-deploy)与其测试;
不触 packages/ 生产控制面。revert 单 PR 即整体回滚;room-info 新字段
对旧 driver 是多余键,无向后破坏。

## 诚实边界

- 本设计**不**证明 GitHub 读模型一定在 60s 内收敛;超时后 fatal 带双 head
  与尝试次数,人可判别「真 mismatch」vs「极端滞后」。
- 对照组测试锁的是「driver 产物 ⊇ 校验器要求」;若未来校验器改为要求
  **不得存在**某键(负向约束),对照组需同步补反向断言。
- driver 仍假设 slot 布局约定 `/tmp/flywheel-test-slot-<N>`(既有现状,
  本次仅把 summary home 从隐式推导升级为 room-info 显式契约)。
