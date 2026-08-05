# FLY-1643 Codex 适配器不投递 workflow 凭据 — 实施计划

Issue: FLY-1643 (https://linear.app/geoforge3d/issue/FLY-1643/引擎bug高优-codex-适配器不向-runner-投递-output-credential-vendorcodex-的-produces)
日期: 2026-08-05
基于: research.md(design review: Codex R1 6 项已全采纳,见 §8)

## 0. 一句话

把三个 workflow 凭据 env 名注册进 Codex spawn wash 的精确白名单(修法 a),配一条「显式 env 必须能通过下游 wash」的 launch 前置自检 + 防漂移守卫测试,让这个 bug class(上游加 env、下游 wash 静默丢)从「23 项观测全瞎」变成「测试红 / launch 即炸且 Lead 可见」。

## 1. 目标 / 非目标

**目标**
1. `vendor=codex && produces_output=true` 节点真机能 consume output credential、落 `workflow_node_output_current`。
2. codex 决策节点(review/qa)能拿到 submission credential + expected 信号,交得出 verdict。
3. 该 bug class 结构性防复发(测试层 + 运行时层双保险);运行时违例必须**拒绝 execute() 的 promise**(而非被内层 catch 吞成无名 `success:false`),沿 Blueprint 的 adapter-throw 路径产出点名变量的 `session_failed`。
4. Claude 路径字节不变。

**非目标**
- 不做修法 (b)(拆 baseEnv/explicitEnv API)——理由见 research.md §3。
- 不做 FLY-1639 的全套观测盲区治理;只落与本单直接相关的最小 launch 自检。
- 不动凭据铸造/台账/透传(上游健康,research.md §1.1)。

## 2. 改动清单(3 个生产文件 + 4 个测试文件)

### C1. `packages/claude-runner/src/codex-home.ts` — 白名单 +3(核心修复)

`RUNNER_ALLOWED_FLYWHEEL_ENV`(:136-156)追加:

```ts
	// FLY-1643: per-execution generalized-workflow job credentials — the runner
	// IS the intended holder (same trust class as FLYWHEEL_INGEST_TOKEN, but
	// narrower: per-attempt, expiring, single-consume, revocable). Without them
	// a produces_output / decision node silently dies completed_no_artifact.
	"FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL",
	"FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED",
	"FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL",
```

**三个全加,缺一不可**(research.md §1.5:丢 `SUBMISSION_EXPECTED` = 引擎 decision runner 静默回落 legacy 路径,连「该交作业」都不知道)。

### C2. `packages/claude-runner/src/codex-home.ts` — 新导出 `assertRunnerEnvDeliverable`(launch 自检)

```ts
/**
 * FLY-1643 launch self-check: every FLYWHEEL_ var the caller intends to hand
 * the daemon MUST survive stripInheritedSecretEnv — otherwise the runner is
 * launched with a capability silently stripped (the completed_no_artifact
 * death class). Throws naming ALL offending vars (names only, never values).
 */
export function assertRunnerEnvDeliverable(env: NodeJS.ProcessEnv): void {
	const dropped = Object.keys(env).filter(
		(k) => k.startsWith("FLYWHEEL_") && env[k] !== undefined && !keepInheritedEnv(k),
	);
	if (dropped.length > 0) {
		throw new Error(
			`runner env var(s) would be silently dropped by the spawn wash: ${dropped.join(", ")} — register them in RUNNER_ALLOWED_FLYWHEEL_ENV (codex-home.ts) if the runner is the intended holder (FLY-1643)`,
		);
	}
}
```

要点:与 `keepInheritedEnv` 同模块,直接复用**真实私有谓词**(无需导出它),自检与 wash 不可能各自漂移。泛化到全部 FLYWHEEL_ 显式键 —— 第四次漏注册会在 launch 就炸、报错点名全部违例变量(只报名字,绝不含值)。

不误伤论证:`buildDaemonEnv` 输出里,继承键已过第一次 wash(必然在白名单上);显式键在 +3 后全数在名单上(research.md §1.3 逐名核对,含 transport 注入的 AGENT_TEAM_NAME/AGENT_NAME)。现状恒过,只有未来漂移触发;未来 transport 新增未注册变量按设计也应 fail(静默丢 transport 身份同样是能力剥夺)。

### C3. `packages/claude-runner/src/CodexTmuxAdapter.ts` — env 构造+校验前移到 fail-loud 区(R1 #1)

**问题**:原方案把 assert 放 `buildDaemonEnv`(:505 调用点)—— 在 :452 try 内,抛错被 :844-846 catch 吞成 `caughtError` → `success:false`,`AdapterExecutionResult` 不携带点名原因,Blueprint 走不到 adapter-throw catch(`Blueprint.ts:2704`),decision 路径甚至可能继续 —— fail-loud/Lead 可见合同不成立。

**修正**:daemon env 的构造+校验**前移到 execute() 序幕的 fail-loud 区**,且必须在 `provisionGitHubCredential`/`provisionCodexHome` **之前**(此后 CODEX_HOME 已持活 GH_TOKEN,try/finally 外抛错会泄 token):

```ts
// execute() 序幕,紧随 resolveGitWritableDirs 之后、provisionGitHubCredential 之前:
// FLY-1643: build + validate the daemon env in the FAIL-LOUD zone — a
// would-be-stripped FLYWHEEL_ var must reject execute() (Blueprint
// adapter-throw → named session_failed), never enter the inner catch as an
// anonymous success:false. Must run BEFORE credential provisioning so the
// throw cannot leak a live GH_TOKEN home.
const gateMarkerDir = defaultGateMarkerDir();
const daemonEnv = this.buildDaemonEnv(ctx, gateMarkerDir);
assertRunnerEnvDeliverable(daemonEnv);
```

- `defaultGateMarkerDir()` 为纯路径解析(env override / `~/.flywheel` 默认,flywheel-comm 测试佐证),提早调用零副作用;`buildDaemonEnv` 只读 ctx/process.env(内部 resolveCommCli/transport 均已自带 try/catch),提早调用语义不变。
- try 内 :461 原 `gateMarkerDir` 定义删除,:505 改 `env: daemonEnv`(复用已校验对象,无二次构造漂移)。
- **provenance 规则(R2 #1,防陈旧跨 execution 凭据)**:C1 之后三个名字能通过第一次 wash —— 若 Bridge/嵌套 runner/测试进程/操作员 shell 的 `process.env` 里残留这三个变量,而本次 ctx 没供值,陈旧值会冒充权威值被投递(EXPECTED flag 可假逼 submission 行为;未过期 bearer 可作用于它原绑定的别的 execution/attempt)。故 `buildDaemonEnv` 在第一次 wash 之后**先无条件 delete 三个 workflow 键,再只从 ctx 层叠**(现有 `if (ctx.…)` 之外补齐 else-delete 语义)。**这三个 env 的唯一供值来源是 ctx,永不继承。**
- 注释校准(同文件):
  - `buildDaemonEnv` docstring(:1402-1408):`stripSecretEnv` 误名 → `stripInheritedSecretEnv`(R1 #4);追加合同句:任何在此新增的 `FLYWHEEL_*` 名字必须同步注册 `RUNNER_ALLOWED_FLYWHEEL_ENV`,否则 spawn 侧 wash 丢弃(FLY-1643);
  - :1413-1417「FLYWHEEL_* … is preserved by the wash」→「FLYWHEEL_ vars on the RUNNER_ALLOWED_FLYWHEEL_ENV allowlist are preserved」。

### C4. 注释更正(零行为改动;R1 #4 扩到两处矛盾根)

1. `codex-daemon-runtime.ts:516-519`「FLYWHEEL_* (the daemon's own scoped tokens) is preserved」→「FLYWHEEL_ vars on the RUNNER_ALLOWED_FLYWHEEL_ENV allowlist are preserved; any other FLYWHEEL_ name — including one explicitly layered by the caller — is dropped (register new names there; FLY-1643)」。
2. `codex-home.ts:256-257`(`stripInheritedSecretEnv` docstring 尾句)「Apply on the INHERITED env BEFORE layering the runner's explicit …」与 `spawnCodexDaemon` 对**合并后** env 的第二次调用矛盾 —— 本次事故的注释根源。改为如实描述两个调用位点:buildDaemonEnv 洗继承 base;spawnCodexDaemon 对合并 env 复洗(故显式名必须在白名单上)。

### T1. `packages/claude-runner/test/codex-home.test.ts`

- **RED-1(复现主 bug;只用既有 API)**:`stripInheritedSecretEnv` 对三个 workflow 名的输入必须原样保留(main 上红,C1 后绿)。三名各一断言,值字节一致。
- **RED-2(自检语义;依赖新 helper,后置到 Step 1b)**:`assertRunnerEnvDeliverable`
  - 对含未注册 FLYWHEEL_ 名(如 `FLYWHEEL_NOT_REGISTERED_X`)的 env 抛错,报错文本点名该变量;
  - 多个未注册名**全部列出**;
  - 不抛的正例用**代表性样本**而非名单镜像(R1 #5:不再造第二个手维护 17+3 拷贝):三个新名、一个既有名(如 `FLYWHEEL_EXEC_ID`)、`LC_ALL`、一个 SAFE_BASE 名(如 `PATH`)混入即可;全集覆盖交给 RED-3 的 adapter 真实产物。

### T2. `packages/claude-runner/test/CodexTmuxAdapter.test.ts`

- **RED-3(防漂移守卫,闭掉 :678 的断言盲区;只用既有 API)**:全字段 ctx(三 workflow 字段都给值)→ 捕获 adapter 构造的 env → **对其复跑 `stripInheritedSecretEnv`** → 断言输出中所有 `FLYWHEEL_*` 键值与输入字节一致(不变性表述,不硬编码名单;含 transport 注入键)。main 上红,C1 后绿。既有 :678 pre-wash 测试保留。
- **RED-4(自检接线 = launch 拒绝合同;后置到 Step 1b)**:测试注入一个会往 daemon env 塞未注册 FLYWHEEL_ 名的路径 → `execute()` **reject**,错误点名该变量,且 **`runtimeFactory` 从未被调用**(R1 #1 的两条断言);不产生静默 spawn、不落 `success:false` 假完成。
- **SENTINEL-6(provenance 哨兵;R2 #1;既有 API,归 Step 1a)**:`process.env` 毒化三个 workflow 名、ctx **不**供 workflow 字段 → 断言 adapter 构造的 daemon env **不含**三名;另一条 ctx 供值断言权威值字节一致存活。此哨兵在当前 main 上**绿**(main 反正丢弃),且必须跨 C1 保持绿 —— 它抓的正是「裸加白名单」这步不安全展开。**env 隔离(R3 建议 2)**:该文件既有 teardown 只还原五个选定 env 键、不含三个 workflow 键 —— 毒化值须在 `finally`/`afterEach` 中显式 save/restore(或 vitest env stub + 显式 cleanup),否则 C1 之后毒化值能穿 wash 污染后续测试。

### T3. `packages/claude-runner/test/codex-daemon-runtime.test.ts`

- **RED-5(终点取证;只用既有 API)**:`spawnCodexDaemon` 以含三个 workflow env 的 `opts.env` 调用,注入 `spawnFn` 捕获**最终传给子进程的 env**,断言三名在场、值字节一致(凭据必须活着到达 codex 进程,而非只活在适配器构造物里)。同时反向断言:未注册 FLYWHEEL_ 名(模拟 Bridge 侧 secret 句柄)在最终 env **不在场**(白名单其余语义未松动)。

### T4. `packages/edge-worker/src/__tests__/Blueprint.test.ts` — 边界测试(R2 #2:核查已做,覆盖**缺失**,故无条件补)

既有 Blueprint 失败覆盖用的是正常 resolve 的 adapter、只查 `emitFailed` 被调用 —— **没有** `adapter.execute()` reject 且保留 rejection message 的用例。补一条:adapter mock reject(错误点名假 env 变量)→ 断言 `Blueprint.run()` 返回 failed 结果 + `emitFailed` 收到**逐字**该 message(违例变量名活着到达 Lead 可见的 session_failed)。

## 3. TDD 执行顺序(R1 #3:拆两步,RED 必须是行为红,不是模块加载红)

- **Step 1a(RED/GREEN 基线,既有 API)**:落 RED-1/3/5 + SENTINEL-6 + T4 → `pnpm --filter flywheel-claude-runner test:run`(**注意**:包名是 `flywheel-claude-runner`;`--filter claude-runner` 会 "No projects matched" 且 **exit 0** 假绿 —— R1 #2。跑完必须核对 vitest 确实执行了目标文件;T4 在 edge-worker 包同理防假绿)→ T4 在 edge-worker 包单独跑 `pnpm --filter flywheel-edge-worker test:run` 并核对 vitest 列出了 `Blueprint.test.ts`(R3 建议 1:防假绿规则必须可执行)→ 逐条记录实际失败断言与 research.md §1.3 断点一致(SENTINEL-6/T4 此时即应绿,作为跨修复不变量基线)。
- **Step 1b(RED,新 helper)**:落 C2 函数签名(空实现或 throw TODO)+ RED-2/4 → 单独跑,记录行为红。
- **Step 2(GREEN)**:C1(白名单)+ C3 provenance delete-then-layer(**同一步落,不许只加白名单不加 delete** —— SENTINEL-6 会抓)→ RED-1/3/5 绿、SENTINEL-6 保持绿;C2 实现 + C3 接线 → RED-2/4 绿。
- **Step 3(REFACTOR)**:C3/C4 注释校准;确认无多余 diff。
- **Step 4(全仓门)**:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(FLY-224/248 教训:全仓,不只改动包)。

## 4. 验收(与 issue 逐条对应;implement/qa 节点执行)

| # | issue 验收项 | 验法 |
|---|---|---|
| 1 | 受控对照复跑:codex carrier 凭据 `consumed_at` 非空 + `workflow_node_output_current` 落行 | 529 房同款对照(FLY-1638 QA 二轮剧本),查凭据台账两字段 |
| 2 | tpl_generic + codex 真机 execute→needs_review→approve gate 全链 | 529 房真机走通,gate 开出为准 |
| 3 | 回归:Claude carrier 行为不变 | 同场 Claude carrier 对照跑 + `TmuxAdapter.ts` zero-diff 佐证 |
| +4 | launch 自检不误伤:修后 codex runner 正常起、无 assert 抛错 | 验收 1/2 顺带覆盖(能起来跑完即证) |

## 5. 风险与回滚

- **风险 1:自检误伤未知生产 env 形态**。已按现状逐名核对恒过(C2 论证);若真出现,错误自带变量名与修法指引,一行注册即解。自检是独立一行调用,可单独摘除,不影响核心修复 C1。
- **风险 2:白名单 +3 把凭据交进联网的模型 shell**(R1 #6 修正措辞)。这是**有意的、必要的授权面扩大**,不是「零扩大」:runner 本就是凭据的预期持有者,不交它节点必死。残余后果如实记录:凭据泄漏最坏可为**当前 execution/attempt** 冒交一次 output / 一个允许谓词族内的 verdict,受 loopback 路由、execution/attempt 绑定、expiry/revocation、单次消费/幂等重放约束(消费端逐项核实,research.md §2);`EXPECTED` 是零秘密 flag。不触碰名单既有排除项。
- **风险 3:env 构造前移改变语义?** `defaultGateMarkerDir`/`buildDaemonEnv` 均无副作用(C3 论证),仅执行时点前移;唯一行为差 = 违例时从「静默跑完」变「launch 拒绝」,即本设计目标。
- 回滚:单 commit revert 即回到现状(死但已知)。

## 6. 工作量

生产改动 ~55 行(核心修复 3 行 + provenance delete-then-layer ~6 行 + 自检 ~15 行 + 前移 ~8 行 + 注释),测试 ~190 行(claude-runner 3 文件 + edge-worker Blueprint 1 条)。单 PR。

## 7. 里程碑收尾(implement 节点)

CLAUDE.md 里程碑行 + 本文件夹 docs 随主 PR 最后一个 commit(`feedback_archive_docs_in_main_pr`;doc-flow 无状态子目录,不挪 archive)。

## 8. Design review 记录

- Codex R1(xhigh,2026-08-05):CHANGES REQUESTED,6 项 —— #1 assert 放 try 内不满足 fail-loud 合同(已改:前移 fail-loud 区 + reject 合同 + runtimeFactory 不被调用断言 + 边界覆盖核查);#2 `--filter claude-runner` 是 exit-0 假绿(已改:`flywheel-claude-runner` + 核对提示);#3 RED 一把梭会被模块加载错误遮蔽(已改:1a/1b 拆步);#4 注释矛盾根还有两处(已并入 C3/C4);#5 RED-2 不得镜像名单(已改:代表性样本);#6 安全声称过强(已改:有意扩大 + 残余后果如实)。全采纳,无拒绝项。
- Codex R2(xhigh,2026-08-05):CHANGES REQUESTED,3 项 —— #1 白名单 +3 后陈旧继承凭据可跨 execution 投毒(已改:C3 provenance 规则 delete-then-layer,ctx 是唯一供值来源 + SENTINEL-6 哨兵,与 C1 同步落);#2 Blueprint reject 边界覆盖经核查**确认缺失**,改无条件 T4(已加);#3 research.md §5 仍写 spawn 处自检的旧位置(已同步为 execute 序幕 + reject 传播)。全采纳,无拒绝项。
- Codex R3(xhigh,2026-08-05):**APPROVED**。3 条 non-blocking 已折入:#1 T4 的 edge-worker 跑测命令显式化(§3 Step 1a);#2 SENTINEL-6 env 毒化需显式 save/restore(T2);#3 research.md §4/§6 与终稿对齐(已改)。
