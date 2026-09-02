# FLY-2237 房内 Bridge 循环 — 实施计划
Issue: FLY-2237 (https://linear.app/geoforge3d/issue/FLY-2237/529台架原语-缺保留在飞工人只循环房内-bridge的动作-reown-reconciler-类重启机制永远无法真机触发2211-三轮实证)
日期: 2026-09-01
基于: research.md

## 目标与锁定范围

新增 `bash scripts/test-cycle-bridge.sh <slot>`：对一个 ready 的 529 slot 只 SIGTERM Bridge，再用该房首次启动时同一份声明式 env/command 合同重启；Lead、在飞 Runner、Codex daemon、tmux 与 slot 数据保持原位。`test-deploy.sh` 继续作为 env composition 唯一 authority，并让首次启动也消费该合同，杜绝 deploy/cycle 两套拼装逻辑。

不修改 reconciler/reown 产品逻辑，不拆房，不重启 Lead/生产服务，不 dispatch QA/ship。

## 已确认的公共测试 seam

TDD 只在以下公开 seam 写断言，设计评审通过即视为 seam 确认：

1. `scripts/test-deploy.sh` 的 ready-slot JSON/slot artifacts：新增 `bridgeLaunchSpec` 路径；spec 是 0600 regular file，initial Bridge 实际由它启动。
2. `scripts/test-cycle-bridge.sh <slot>`：stdout JSON、exit status、Bridge/Lead/sentinel PIDs、health、pid/lock files 与 append log 是可观察结果。

helper 函数不单独作为行为目标；只有 validation 组合无法经 CLI 低成本到达时才 source helper 做纯输入矩阵测试，并由至少一个真实 CLI E2E 覆盖同一分支。

## 运行时合同

`${SLOT_DIR}/bridge-launch.json` schema 1：

```json
{
  "schemaVersion": 1,
  "slot": 31,
  "port": 43131,
  "bridgeUrl": "http://localhost:43131",
  "cwd": "/absolute/deploy/cwd",
  "logPath": "/tmp/flywheel-test-slot-31/bridge.log",
  "environment": ["HOME=/...", "PATH=/...", "TEAMLEAD_PORT=43131", "FLYWHEEL_BIN_DIR=..."],
  "secretEnvironment": [
    {"name":"LINEAR_API_KEY", "path":"/tmp/flywheel-test-slot-31/state/bridge-env-secrets/LINEAR_API_KEY"}
  ],
  "command": ["/absolute/path/to/npx", "tsx", "/abs/repo/scripts/run-bridge.ts"],
  "ownershipPidFiles": ["/tmp/flywheel-test-slot-31.lock/pid"]
}
```

`test-deploy.sh` 先按当前三分支的原始 `env -u ... NAME=value` 语义解析一次 final child env，再把 normalized **完整环境**写成 ordered assignments；process-generated `_`/`SHLVL` 删除，`PWD` 固定为 `cwd`。executor 只能 `env -i` + spec 重放，因此 cycle shell 的 `PATH`、HOME、TMPDIR、API keys 或未来 ambient flags 都不能漂入。default/reply/generalized 的 scrub 结果表现为对应 key 在 final environment 中确实缺失或是 slot value，而不是一份仍依赖 parent env 的 delta。

bearer/API/secret 值不进入 spec。分类器 deny-by-name：env name（case-insensitive）匹配 `TOKEN|KEY|SECRET|PASSWORD|PASSWD|BEARER|CREDENTIAL|AUTH` 或 explicit additions list 时，必须写入 `${SLOT_DIR}/state/bridge-env-secrets/<name>` mode 0600；spec 只保存 name/path，executor 读 regular file 后以 argv assignment 注入。这个规则覆盖 caller-driven extra-lead/alert token env names，而非只认固定列表。slot/secret parent 0700。deploy readiness 失败时保留 `bridge.log` 但删除 spec + secret dir。schema 同时验证 env name、value 无 NUL/换行、command[0] 是 capture 时解析并验证的 absolute executable、`run-bridge.ts` 是 canonical absolute path、所有 path落在预期 slot/repo，任何错误不得输出 assignment/secret value。generalized wrapper command中的 inner `npx` 同样固化 absolute path。

cycle 顺序：串行 lock → validate spec/PID/locks/old health → strict `lsof` 成功并对 PID dedupe后取得唯一 listener → slot 专属 ancestry walker 从 listener 纯沿 PPID 上溯且必须精确到达 `bridge.pid` wrapper（argv/path 不参与 membership）→ TERM 前将 ownership locks写成 `cycle-failed` 并安装 EXIT/signal保留 trap → 对 chain每个PID只发SIGTERM → 等chain退出 → strict lsof成功且无listener + Node按resolved `TEAMLEAD_HOST`/port temporary bind正向证明free → `cd "$cwd"`后 `env -i` start absolute command → strict listener/PPID-chain/new PID/real cwd + health闭合 → atomically写/read-back `bridge.pid` 与全部ownership locks → trap先条件确认live `bridge.pid` 与所有locks已一致再no-op/disarm → stdout JSON。

不复用 production `bridge-process-tree.sh`：它的 `*worktrees/*` exclusion 正是为避免 production restart杀QA房，而本动作必须拥有QA slot walker；shared helper保持不改。也不使用其 fail-open listener seam作为“free”证据。walker以lsof listener和pidfile wrapper这两个已验证端点做纯PPID闭环，避免真实tsx listener argv没有`run-bridge.ts`或祖先使用relative path造成假拒绝。cycle要求`lsof`可用且命令成功，raw rows先dedupe；empty结果还必须用spec host的real bind proof确认。TERM timeout时若old tree仍live可恢复old lock；其余失败与任何中断都由pre-TERM sentinel/EXIT trap保留精确`cycle-failed`。trap在收尾时重读状态：若`bridge.pid`是live PID且所有ownership locks已等于它则不得覆写，否则保留sentinel。`claim_slot`与multi-lead claim看到该值只能拒绝自动reclaim，等待operator显式teardown。全路径不升级SIGKILL。

## Task 1：RED/GREEN — 让 test-deploy 首次启动拥有可重放合同

**Files:**

- Add: `scripts/lib/qa-slot-bridge.sh`
- Add: `scripts/lib/qa-slot-bridge-spec.mjs`
- Modify: `scripts/test-deploy.sh`
- Modify: `scripts/__tests__/test-deploy-fly1389.test.sh`
- Modify: `scripts/__tests__/test-deploy-generalized.test.sh`

### Slice 1.1 RED：公共 deploy artifact

扩展 fly1389 的真实 `test-deploy.sh` fixture，先断言：

- output JSON 有绝对 `bridgeLaunchSpec`；
- 文件存在、非 symlink、0600，slot dir 0700；
- spec schema/slot/port/cwd/log/command/lock path 正确；
- `environment` 是 full snapshot，包含 PATH/HOME/PWD 与所有非 secret coordinates；`secretEnvironment` 仅含 validated name/path且 spec byte scan找不到 fixture secrets；
- 注入一个此前未知的 `FLYWHEEL_NOVEL_WEBHOOK_TOKEN`，证明 name-policy 自动送入 secret file 且 spec environment/plain bytes 均不存在该值；
- master/Discord/Linear/projects、`FLYWHEEL_STATE_DIR`、三根 Codex scope、`FLYWHEEL_BIN_DIR`、`FLYWHEEL_HOOKS_DIR` 在 resolved initial live env 中显式且正确；default final env 中 master/ingest/reply/tmux ambient coordinates确实缺失；
- 初次 stub Bridge env 与 pre-change expected values 一致；
- test-deploy source 中不再保留三条直接 background `npx tsx` launcher。

在当前代码运行，预期因 output/spec 缺失而 RED；必须保存准确失败，不接受 fixture/依赖错误。

### Slice 1.2 GREEN：shared spec executor

`qa-slot-bridge-spec.mjs capture` 作为三条原始 `env -u ... NAME=value` 分支的 child command，在**最终 child env 内**直接读取 `process.env`，normalized 后原子写 full environment + secret refs；不用 `env` 文本输出或 Bash delimiter解析。test-deploy先解析绝对capture runtime `QA_SLOT_BRIDGE_NODE="${FLYWHEEL_QA_NODE:-$(command -v node)}"` 并要求可执行；生产默认是真实Node，fly1389在prepend stub PATH前保存real Node并通过`FLYWHEEL_QA_NODE`显式注入，因此不删除load-bearing `node` stub、也不会把缺spec误报成产品RED。capture同时将Bridge argv[0]（以及generalized wrapper的inner npx）用final child PATH解析成absolute executable并验证canonical `run-bridge.ts` path。`qa-slot-bridge.sh`负责schema/path/mode validation、真实`cd "$cwd"`、array + `exec env -i` start与cycle helpers，不`eval`/source spec。`test-deploy.sh`首次truncate`bridge.log`后调用shared start helper；`BRIDGE_PID=$!`仍等于真实launcher process identity。capture与executor都由public deploy→cycle E2E覆盖，Node helper不成为替代公共seam的私有测试终点。

fly1389 fake repo 的 explicit copy list同步加入新 lib/CLI，避免 missing fixture 假 RED。更新 `test-deploy-generalized.test.sh` 的 source-shape guards：原“两个 inline `-u TEAMLEAD_INGEST_TOKEN`”改为断言 default/reply 两份 captured final env都无 ambient ingest；原 generalized helper/background text coupling 改为 real generalized spec→initial live env只含独立 slot ingest且 `$!` 绑定 real wrapper/listener tree。不得删除 FLY-2174 的 scrub/identity intent。运行 fly1389/generalized/qa-room 至绿并提交。

## Task 2：RED/GREEN — happy-path 房内 cycle

**Files:**

- Add: `scripts/test-cycle-bridge.sh`
- Modify: `scripts/__tests__/test-deploy-fly1389.test.sh`
- Add in `scripts/lib/qa-slot-bridge.sh`: slot-owned process-tree walker（不修改/复用 production worktree-excluding helper）

### Slice 2.1 RED：真实 deploy → cycle

fly1389 fixture explicit copy list加入新 lib/CLI。fixture在prepend stub PATH前保存real Node并设置`FLYWHEEL_QA_NODE`，保留现有`node` stub给better-sqlite3 preflight。增加sibling-checkout arm与fake repo path含`/worktrees/fly-2237/`的mandatory arm。让stub Bridge建成真实三层进程树：npx wrapper保持自己PID、不`exec`；中层argv只保留repo-relative`scripts/run-bridge.ts`；child listener argv只有`node --require ...preflight.cjs --import ...loader.mjs`且无任何`run-bridge.ts`文本。每次boot：

- 分别记录 wrapper/intermediate/listener PID、normalized full env与 boot ordinal；
- 记录 listener 的 real cwd；
- wrapper 捕获 TERM，listener保留默认 TERM行为；
- 继续提供真实 localhost `/health`。

保留一个 ready Lead-ful slot，不先 teardown；另起 worker/daemon/tmux 三个独立 sentinel process 并记 PID/start identity。调用真实 `test-cycle-bridge.sh`，断言：

- sibling与`/worktrees/`两臂都通过纯PPID闭环精确枚举old三层chain、各只收一次TERM并退出；测试显式证明listener argv无脚本路径且中层只有relative path，stop后按spec host的real bind probe成功；
- new wrapper/listener PID都不同且 live，slot walker证明new listener ancestry包含new`bridge.pid`，live real cwd等于spec cwd，`/health`成功；
- Lead PID与三个 sentinel PID/start identity 完全不变且 live；
- initial/new **normalized full env** byte-for-byte相等；另点名全部 slot vars、master/ingest、Discord、Linear、projects、三根 Codex roots、BIN/Hooks均正确，cycle caller 注入的 fake production env完全不存在；
- `bridge.pid` 与 owner lock 都等于 new PID；
- bridge.log 同时包含 boot-1/TERM/boot-2，证明 append；
- stdout JSON 只含 slot/URL/old/new PID/spec path，不含任一 fixture token。

当前代码预期因 CLI 不存在而 RED。

### Slice 2.2 GREEN：最小 cycle CLI

实现 slot/path/PID/old-health validation、fail-closed+dedup lsof listener query、listener→wrapper纯PPID slot ancestry walker、cycle mutex、pre-TERM`cycle-failed`+条件幂等EXIT/signal trap、chain TERM-only wait、host-aware strict lsof + Node bind release proof、same-spec absolute-command+real-cwd start、新listener/PPID-chain/cwd/health identity、atomic PID/lock update与redacted JSON。timeout knobs只供hermetic test缩短等待，严格验证整数范围。

不得调用或 source `test-teardown.sh`；不得调用 tmux、launchctl Lead stop、Runner API、Codex daemon reap。运行 happy-path 变绿，提交小批次。

## Task 3：RED/GREEN — campaign ownership 与 fail-closed guards

**Files:**

- Modify: `scripts/test-deploy.sh`
- Modify: `scripts/test-cycle-bridge.sh`
- Modify: `scripts/lib/qa-multilead.sh`
- Add: `scripts/__tests__/test-cycle-bridge.test.sh`
- Modify: `scripts/__tests__/test-deploy-multilead.test.sh`（若 campaign public E2E 在该 fixture 更自然）
- Modify: `.github/workflows/ci.yml`

按 vertical slice 逐条 RED→最小 GREEN：

1. campaign spec 列出 owner + borrowed locks；cycle 前全部必须等于 old PID，成功后全部等于 new PID，`campaign.json` 不变。
2. `bridge.pid`/lock mismatch：拒绝且 old Bridge、Lead、sentinel 全不变。
3. spec/secret ref 缺失、symlink、权限过宽、schema/path/env/command malformed：拒绝且不发 TERM；diagnostic/spec bytes 不含 secret bytes。
4. old health control 失败：拒绝且不发 TERM。
5. `lsof` missing/denied/ambiguous 或 empty-without-bind-proof：fail closed；duplicate rows dedupe成一个 PID；IPv4/IPv6 bind proof使用spec resolved host。
6. TERM timeout：只发 TERM，不发 KILL，不启动 new Bridge；old tree仍 live则 ownership lock恢复 old live PID。
7. old tree已退后的 start/new-health failure：TERM new tree，写 `cycle-failed` marker + owner/borrowed lock value；default/multilead claim都拒绝自动 teardown；显式 `test-teardown.sh` 仍可回收。
8. SIGINT/TERM interruption：pre-TERM sentinel与EXIT trap使所有owner/borrowed locks保持`cycle-failed`，绝不留下cycle PID；SIGKILL不可trap但同样安全，因为sentinel先写。另覆盖成功write/read-back与disarm之间的信号窗口：trap看到live`bridge.pid`且全部locks一致时必须no-op，不得把healthy room改回sentinel。
9. concurrent live cycle holder：第二个 cycle立即拒绝；dead holder 可回收后继续。

每条只加一个 failing test，再做最小 fix，不横向先写完整矩阵。新 suite完全 hermetic（stub lsof/process tree、local high port、temp locks），显式加入 `.github/workflows/ci.yml` 的 Linux script-tests lane；`ci-shell-suite-enumeration.test.sh` 证明它未掉进未分类缝隙。完成后运行新 suite + fly1389 + generalized + multilead + teardown lease/cleanup suites，提交小批次。

## Task 4：真房 drill 与全仓验证

### 4.1 529 executable drill

在可用 slot 上用本分支 `test-deploy.sh --generalized`（按 FLY-2211 需要选择 real runner；若只验证 launcher mechanics 可先跑 stub control）建立房，保存 ready JSON与 Bridge/Lead/worker PID census；执行 `test-cycle-bridge.sh`，保存 cycle stdout与 append bridge.log。证明：

- build SHA/slot不变、Bridge PID变化；
- Lead与既有 worker/daemon/tmux identity不变；
- 新 Bridge boot pass 出现；
- 针对 FLY-2211 scenario 能观察 `reown_watch_started → revive_started/succeeded`。

若 implement 节点缺少可安全复现 owner-absence 的现成 FLY-2211 fixture，报告“cycle primitive true-machine proven；reown verdict留给 DAG QA”，不得伪造 PASS，也不得扩大到改 reconciler。

### 4.2 Exact gates

依次执行并保存结果：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
bash scripts/__tests__/test-cycle-bridge.test.sh
bash scripts/__tests__/test-deploy-fly1389.test.sh
bash scripts/__tests__/test-deploy-generalized.test.sh
bash scripts/__tests__/test-deploy-multilead.test.sh
bash scripts/__tests__/test-deploy-qa-room.test.sh
bash scripts/__tests__/test-teardown-lease-contract.test.sh
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
```

以上是本变更新增/受影响且安全 hermetic 的 shell suites。`test-deploy-qa-room.test.sh` 虽在 manual-only inventory，但已逐行确认只对 `mktemp` root source纯 helper、无 Discord/launchd/host mutation，因此是本任务唯一明确列出的 verified-hermetic exception；这不授权运行任何其他 manual-only suite。绝不 glob全目录；其余live Discord、cmux、launchd、fleet/host-mutating suites不在implement节点运行。任何失败先区分本分支regression与authoritative baseline；不得静音成“无失败”。

## Task 5：code review、PR 与 bounded handoff

1. 检查 inbox，提交所有产品/测试/docs改动并 push feature branch。
2. 通过 `codex:rescue` 运行 code review；同时按 runner contract 注册 `review_code` gate + `request-review --type code`。blocking finding 修复后跑相关 RED/GREEN与全门，推新 head，开新 review round。
3. 新建 `engineering/doc/milestones/FLY-2237.md`，作为 literal last commit；之后不再运行会推进 HEAD 的 progress commit。
4. 开 PR，确认 exact head CI；不 merge、不 dispatch QA。
5. 通过唯一 report channel 汇报自包含 DONE，并执行 `complete --route needs_review --pr <NUMBER>`。

## 完成证据矩阵

| 要求 | 权威证据 |
|---|---|
| 只 SIGTERM 房 Bridge | multi-level listener→tsx→npx tree CLI E2E；每 PID TERM marker + no KILL guard + positive port bind release |
| 同一 test-deploy env 重启 | initial/cycle 共用 `env -i` full snapshot；normalized full env byte-equality + cycle ambient negative control |
| 三根 Codex roots + BIN/Hooks显式 | spec 与 new live env 双重断言 |
| 不触碰 worker/daemon/tmux | Lead + 三 sentinel PID/start identity before/after不变；CLI 无相关 cleanup调用 |
| ownership持续正确 | bridge.pid + owner/borrowed lock read-back一致 new PID |
| reown 可真机触发 | 529 drill boot/reown event sequence与保存的 append log |
| 失败不伪 ready/不泄密/不被自动拆房 | negative CLI exits、`cycle-failed` claim guard、unchanged sentinels、spec structural secret refs + redaction assertions |
| repo 可交付 | exact gates、code review APPROVED、PR exact-head CI |
