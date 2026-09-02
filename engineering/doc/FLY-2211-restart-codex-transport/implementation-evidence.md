# FLY-2211 重启传输隔离 — 实施证据
Issue: FLY-2211 (https://linear.app/geoforge3d/issue/FLY-2211/引擎重启隔离-重启波会间接杀死-codex-runner工人窗不动但其-app-server-broker-随波死tui-失去传输后-10)
日期: 2026-08-31
基于: plan.md

## M4 定向验证

- claude-runner:本批 8 个文件精确复跑,396/397 先绿;唯一红项是新增全仓 kill-path inventory 在并发负载下 5.45s 超过 Vitest 默认 5s。显式给扫描测试 15s 预算后,单测 1/1 绿(实际 1.31s),随后 claude-runner typecheck 绿。
- teamlead:re-own、transport death snapshot、zombie snapshot、tmux cleanup/identity 共 61/61 绿,typecheck 绿。
- edge-worker:误触整包后 107 files、1256 tests 绿(14 skipped),typecheck 绿。
- shell:kill-ledger parity 绿;codex-guard 44/44 绿;restart stop/port-free 6/6 绿。
- 机械 inventory 固化 481 个命中:runner mutation 16、service mutation 2、signal-0 probe 66、QA-only 317、out-of-scope 80。生产 runner mutation 均收敛到先 fsync ledger、再 mutation 的 choke point。

## 全仓验证

精确门禁结果:

- `pnpm lint`:exit 0;保留 14 个基线 warning,无 error。
- `pnpm -r build`:exit 0;全部 workspace build 完成。
- `bash scripts/__tests__/kill-ledger.test.sh`:PASS。负例故意触发 `EEXIST` 以证明 ledger 写失败时 signal 路径 fail-closed。
- `pnpm test:packages:run`:exit 1。最终 head 复跑的失败不在 FLY-2211 行为断言:core 的两个真实 Terminal/osascript GUI 用例在 resident runner 无 Aqua GUI 会话下返回 `Connection Invalid`;本轮 config schema census 27/27 绿。pnpm 的 first-fail 随后截断其余 package。

补偿验证与全包发现:

- config census 单独复跑 27/27 绿,目标用例实际 1.628s;core 排除两项 GUI-only 测试后 19 files、219/219 绿。GUI-only 两项留给真机 QA。
- claude-runner 全包 963/965 绿,两个真实 tmux 用例在并发下越过 5s;隔离复跑 3/3 绿。FLY-2211 daemon runtime fresh 56/56 绿。
- flywheel-comm 全包 1751/1752 绿,一个 CLI 用例在并发下 5.545s 超时;隔离复跑 8/8 绿,目标用例 1.197s。
- teamlead 全包 9910/9931 绿;19 项为同类并发时间预算超时,单 worker 隔离复跑后相关文件 125/126 绿。隔离过程另发现一个新增 export mock 缺口;连同全包发现的 orphan wiring 旧契约与 `recovery_claim` retention registry 漏项一并修复。修后精确相关集 176/176 绿,retention+orphan 41/41 绿,route registration 1/1 绿。
- edge-worker 107 files、1256/1256 绿;voice-bridge 60 files、649/649 绿;其余有 `test:run` 的 workspace package 已由精确门禁前段或串行补跑覆盖。未出现新的行为失败。

因此当前 head 的代码、lint、build 与所有可在 resident sandbox 执行的行为测试均为绿;精确 packages 聚合命令仍如实为红,最终复跑原因只有两个 GUI-only 用例,未通过放宽断言或改动无关基线来伪造绿灯。早期补偿全包中的固定并发时间预算波动保留在上方,作为完整验证史而非最终聚合失败原因。

## Code review

`codex:rescue` companion 已按要求在 review-only 模式尝试,但 resident 外层 macOS seatbelt 在 reviewer 读取仓库前拒绝其嵌套 `sandbox-exec` (`sandbox_apply: Operation not permitted`),因此该尝试不计作 review PASS,也没有用作者自审替代。

随后走 request-driven cross-family review gate:

- round 1 在 `c54bad936b73f6807551718edbd82b68cea07a32` 返回 `CHANGES_REQUESTED`,两项 HIGH 分别为 clean fence abort 消耗 recovery budget,以及 daemon restart 重放 initial-turn hook 时重复 commit 已关闭 claim。
- 先补三项失败断言确认红灯,再在 `08cca8fb7` 做最小修复:pre-mutation clean fence abort 原子退还 attempt;首次 recovery commit 成功后后继 hook 重放幂等返回。目标 recovery 套件 27/27 绿,teamlead typecheck 绿,daemon restart 套件 29/29 绿。
- round 2 在精确 head `d3300acaafb0dc3f11b4d6e8e91ef1e1085f8b15` 返回 **APPROVED**,两项 HIGH 均关闭。保留 5 条 MEDIUM 与 3 条 LOW advisory,已通过 `ask --report` 报告 Lead;按 `medium_low_findings_are_non_blocking_v1` 不阻断本 gate。

其中 reviewer 对缺少 runtime kill switch 的意见不再出现在 round 2;实现继续遵守 Lead 的明确治理裁决:reowner 默认开启且不加运行时 flag,分阶段通过合入顺序与 QA 控制,回滚使用 git revert。

### Lead 指定的 round-2 advisory 收口

round 2 批准后,Lead 明确要求本轮再收两条 advisory,因此 `d3300acaa` 不再是最终交棒 head,必须在新 head 上重新 code review:

- transport/zombie death snapshot 不再在 Bridge 主线程串行调用 `execFileSync(lsof)` 与 `execFileSync(ps -axo)`。两条探针现在并发异步执行,各自 `timeout=3000ms`,`maxBuffer=1MiB`;写入事件的字段与 32KiB 持久化边界不变。异步契约 3/3 绿,teamlead typecheck 绿。
- TURN writer 的共享 mutation lease 继续跨 CommDB 变更与 StateStore 投影持有,commit 仍复验 claim token、TTL 与当前 `lifecycle_revision`;但 TURN writer 不再递增该 revision。recovery 在拿到 lease 后重新读 binding 与 CommDB TURN,由这两个事实阻止旧 holder reap/spawn;`lifecycle_revision` 继续只服务真正的 lifecycle authority,不会让 founder lifecycle request 或 pane-loss CAS 因无关 TURN 授予失效。相关 recovery/lease/reowner 30/30 绿。

### 最终 CI 枚举收口

新 head 首次推送后,GitHub Quick Gate 在 build 前由 `ci-shell-suite-enumeration.test.sh` fail closed:`scripts/__tests__/kill-ledger.test.sh` 没有进入显式 CI inventory。该失败作为红灯证据;随后把 suite 加入 shard 2 的 FLY-1955/2211 daemon mutation safety step。第二层 `ci-structure.test.sh` 又按设计对 step 名称漂移报红,同步更新其固定 inventory 后转绿。

首次完整 CI 继续在 Unit(light) 暴露四个新环境变量未被 feature-flag governance 解释:`FLYWHEEL_KILL_LEDGER_ROOT`、`FLYWHEEL_KILL_LEDGER_NOW`、`FLYWHEEL_KILL_LEDGER_TEST_NO_MUTATE` 与既有 `FLYWHEEL_NODE_BIN`。新增显式红灯断言后,四者分别按路径 override、测试时钟、测试 mutation suppression 与 Node executable path 写入 `NON_FLAG_ALLOWLIST`;没有把它们注册成开关。定向断言 1/1、完整 drift suite 14/14、config 全包 687/687、config typecheck 均绿。

env-governance 收口后的 implementation head 为 `01f3c3ca4ef89e7bcb38095042dd66a50f45c3ea`。以下四项在该 head 绿:

- `bash scripts/__tests__/ci-shell-suite-enumeration.test.sh`
- `bash scripts/__tests__/ci-structure.test.sh`
- `bash scripts/__tests__/fly2045-milestone-layout.test.sh`
- `bash scripts/__tests__/kill-ledger.test.sh`

该 head 的完整 Script Tests 2/2 随后又由 path-hygiene fail closed:新生产文件 `scripts/lib/kill-ledger.sh` 的 native-first `/opt/homebrew/bin/node`→`/usr/local/bin/node` fallback 尚未进入精确 source registry。把该文件加入既有 registry 后,`path-hygiene.test.sh` 12/12、kill-ledger、shell enumeration 与 CI structure 均绿;对应最终 implementation code head 为 `3270e9234c0686a723002b3083bb64a90751d1e1`。

最终 head 上 `codex:rescue` companion 再次以 review-only 模式尝试,仍在读取仓库前被外层 seatbelt 拒绝嵌套 `sandbox-exec`;因此继续不把该尝试记作 review PASS。新的 request-driven review 只接受覆盖上述 implementation head 的 verdict。

request-driven code review round 6 在精确 `reviewedHeadSha=01f3c3ca4ef89e7bcb38095042dd66a50f45c3ea` 返回 **APPROVED**,无 HIGH/blocking finding。4 条 MEDIUM 与 6 条 LOW advisory 按 `medium_low_findings_are_non_blocking_v1` 不阻断 gate,且已逐 key 通过 `ask --report` 报告 Lead。MEDIUM 是 lsof 零 holder 表达、writer commit 仍重置 recovery episode、parked 非 TURN holder 事件噪声、rehydration drift 自比较;LOW 是 shell 测试 env seam 可达性、inventory locale 排序、异步取证 tick 采样时点、共享 rescue adapter、tmux benign disappearance、injected exec audit 绕过。除本轮 Lead 明确指定收口的两项 advisory 外,其余维持 follow-up,没有在批准计划外继续扩 scope。

path-hygiene 注册修复后重新走 round 7;它在精确 `reviewedHeadSha=3270e9234c0686a723002b3083bb64a90751d1e1` 再次返回 **APPROVED**,无 blocking finding,4 MEDIUM/6 LOW advisory 集合不变并再次报告 Lead。该 verdict 是本 implementation 节点的最终 code-review gate。

### QA rework 与最终 code head

QA attempt 1 发现三类可复现的诊断/演练缺口,implementation attempt 3 按 TDD 收口:

- shell kill-ledger 不再从 production 读取 `FLYWHEEL_KILL_LEDGER_TEST_NO_MUTATE`;测试改为 source 后覆写 mutation function seam,并证明真实 mutation 调用参数。配置 allowlist 同步删除该 env。`lsof` 以 rc=1 且 stdout/stderr 全空表示“无 holder”,不再误记 probe error;parked 非 TURN holder 改记 `reown_skipped_not_turn_holder`,避免错误宣称 fence lost。
- `scripts/test-deploy.sh` 新增仅限 isolated generalized room 的 `--codex-runner`,生成真实 Codex runner + `codex-tmux` backend + `gpt-5.6-sol` 配置;默认配置保持 byte-compatible。529 playbook 固化真实重启演练命令,production ConfigLoader 已接受生成 YAML。
- QA 在 Codex 0.152.0 证明 attach 可拥有 live goal loop,同时证明重复 `clientUserMessageId` 不具 exactly-once receipt。按 Lead 裁决,attach-adopt 另立 follow-up;本 PR 不在 `exactlyOnceKickSupported=false` 时冒险 re-kick。

合入 `origin/main` 的 FLY-2207 cmux watcher 自愈变更后,既有 kill-path fixture 在本地与 Linux 同样稳定报红:删除 6 条已移除 watcher 路径,新增 2 条只杀故障注入 shell 自身的 crash seam。按 scanner 实际结果把 inventory 从 481 同步为 477;`test/kill-path-inventory.test.ts` 红灯后 1/1 绿,Unit(heavy) 随后在 Linux 绿。

attempt 3 的精确全仓门禁:

- `pnpm lint`:exit 0,仅既有 non-blocking warnings;`pnpm -r build`:exit 0。
- `pnpm test:packages:run`:exit 1,仍只有 core 的两个真实 Terminal.app/Apple Events 用例在 managed resident sandbox 返回 `Connection Invalid`;无 FLY-2211 行为失败。
- 本 PR 新增/改动的 `ci-structure.test.sh`、`codex-guard.test.sh`(44/44)、`kill-ledger.test.sh` 与 `test-deploy-generalized.test.sh` 全部 exit 0。

`codex:rescue` companion 在 final head 再次实际发起 read-only review,仍在加载 AGENTS.md 前被外层 seatbelt 拒绝嵌套 sandbox,不计作 PASS。request-driven review round 8 在 `51ba203bd6d49dacaf778d8b323a068ead34dd12` **APPROVED**;合入 main 并同步 fixture 后必须重新审查,round 9 在精确 `reviewedHeadSha=a808df2ea0634027b7f825e0fd724ec580b67b4e` 再次 **APPROVED**,无 HIGH/blocking finding。新增 MEDIUM advisory `inventory-scanner-blind-to-shell-form-tmux-kills` 与既有 advisory 均已通过 `ask --report` 报告 Lead;按 `medium_low_findings_are_non_blocking_v1` 留给 follow-up,未扩张本单锁定范围。

GitHub CI run `33468051938` 首跑的所有断言均通过,但 Script Tests 1/2 最终 capacity tripwire 以 1048s 超过 1020s 阈值报红。对照最新 main 同 shard 为 1019s,且 FLY-2211 只在 shard 2 新增 kill-ledger;Lead 明确裁定不把 FLY-1870 的重分片滚入本单,允许同 head failed-job rerun 一次作为容量仪器。attempt 2 在同一 head 全绿,tripwire `elapsed=913s`,`usage=76%`,最终 11/11 jobs **success**。

## FLY-1955 身份栅栏互查

FLY-1955 与本单共享的硬约束如下,两侧都不得退化:

- zombie/orphan 豁免与 mutation **不得按进程名**判断。活体保护从精确 `executionId` 的 process-local owner、当前 workflow binding 与 active runway 出发;进程名 `codex`/`app-server` 本身既不是保活凭证,也不是 kill authority。
- broker/daemon mutation 只在 canonical CODEX_HOME inventory、execution-private socket、精确 `codex app-server --remote-control --listen unix://<socket>` argv、持久化/新鲜 PGID 与 fresh `lsof` socket holder 一致时授权;任一事实 unknown/mismatch 即 fail closed。
- 保护穿波 broker 不得制造不可收的孤儿。execution 仍 active 时 orphan lane 在 TERM 前、KILL 前、删 socket 前重复 `isExecutionActive` 并跳过;一旦 ownership/binding runway 消失,reverse-axis 仍可用 canonical socket→execution 映射与上述多事实身份栅栏回收同一孤儿。socket 只有在精确 group 与 holder 均证明消失后才删除。
- 非 runner 的 app-server、Flywheel socket root 外的 sidecar、recycled PGID、argv/socket/lsof 任一不一致的进程永远不因 basename 相似而被 signal。

互查复跑:`codex-runner-orphan-reaper` + reowner wiring 24/24 绿;`codex-daemon-runtime` 56/56 绿。该互约束没有要求、也没有执行 production broker 保活、zombie reap、launchd 或重启波操作。

## M5 隔离 529 attach/adopt 探针

探针脚本:`scripts/qa-fly-2211-attach-probe.mjs`。它只创建临时 repo、临时 CODEX_HOME root、临时 Unix socket 和唯一 `qa529-fly2211-*` execution;不触发 Bridge、launchd、tmux 或重启波。脚本使用生产等价的 `workspace-write + approval=never`,客户端 A 建 goal 并发 kick 后断开,客户端 B 探测 live `thread/resume`、goal get/list/subscribe、thread read/list、后继通知流与重复 `clientUserMessageId` receipt。

implement resident 环境中的真实 Codex 0.151.0 daemon 可以启动并监听,但 `thread/start` 在加载 AGENTS 时被外层 macOS seatbelt 拒绝嵌套 `sandbox-exec`:

```text
fs sandbox helper failed with status exit status: 71:
sandbox-exec: sandbox_apply: Operation not permitted
```

精确的 0.151.0 负证据见 `qa-529-attach-probe.json`:threadStart 768ms 内返回该错误;随后 `daemonConfirmedDead=true`,`socketGone=true`,`codexHomeGone=true`。另以 `danger-full-access` 试图绕过内层执行 sandbox 仍在 AGENTS 加载阶段触发同一 fs helper;该尝试没有获得额外主机权限,也没有进入 agent turn。最终脚本恢复生产等价配置,不为测试环境弱化验收。

QA attempt 2 随后在无嵌套 seatbelt 的同机节点、Codex 0.152.0 上运行同一脚本,得到 `fatalError=null`,`attachCanOwnLiveGoalLoop=true`,`durableKickOperationIdVisible=true`,且后继 client 能看到未来 goal event。这一结果**证伪了“真实 active thread 无法 attach/adopt”的 0.151.0 环境结论**。与此同时,重复 `clientUserMessageId` 没有返回原 receipt,故 `exactlyOnceKickSupported=false`。QA 报告的精确布尔值、thread id、candidate head、cleanup 三项与 mailbox provenance 已保存为 `qa-529-attach-probe-0.152.0-qa-attestation.json`;原始临时 probe JSON 随 QA 房 teardown 未宣称留存。

529 stub 协议骨架验证:

```text
node --test scripts/__tests__/qa-generalized-codex-stub.test.mjs
tests 3, pass 3, fail 0
```

### M5 决策

QA 已证明 attach/adopt 在 0.152.0 上技术可行,所以 no-attach **不再建立在“attach 不可行”这一前提上**。本 PR 仍不启用 attach、零 re-kick 或 exactly-once kick 模式,理由只剩两项:其一,`exactlyOnceKickSupported=false`,此时直接升级会引入 double-kick 风险;其二,批准计划把 M5 定义为可选研究升级,本单锁定范围是重启波下由 M1–M4 re-owner/watch/revive/recycle 保住工人。Lead 已裁定 attach-adopt 另立 follow-up,本 PR 不回炉 design。

## QA 节点待执行

### QA attempt 3：PR 侧全绿，真机验收被 529 凭据投影阻断

QA attempt 3 在精确 head `2a6e222c92359c6c75b80718f32d4491dcc63097`
复核了 attempt 2 的全部收口：GitHub CI 11/11 绿，定向 recovery/reown/lease/
orphan/transport 套件 66/66 绿，kill-ledger 的生产 mutation seam、反向 env 守卫与
M5 记录均符合裁决。该轮没有发现新的 FLY-2211 代码缺陷，也没有产生代码提交。

该轮 FAIL 的唯一依据是真机验收仍未发生。`--generalized --codex-runner`
房可以启动候选 Bridge，且 `/health` 的 build/candidate head 与上述 SHA 一致；但
design runner 完成工作后在 `await-codex-gate design` fail closed。QA 用 pane 原文、
slot runner 的 `ps eww` 与生产 runner 正向对照确认：slot runner 有项目身份，但缺
`FLYWHEEL_INGEST_TOKEN`；生产 runner 有该变量。数据流复核进一步证明根因位于
529 generalized Bridge 启动边界：`TEAMLEAD_INGEST_TOKEN` 未生成/投影，因而
Blueprint 无法给 Claude/Codex adapter 提供 `bridgeIngestToken`，runner 自然拿不到
Bearer 凭据。不得以导出整份生产 `.env` 或复用 `TEAMLEAD_API_TOKEN` 修复此缺口；
正确边界是独立的 slot-local ingest credential。

因此 design gate 无法进入 implement Codex 节点，房内没有可供 A2 谋杀演练的
`codex-tmux` worker。A2、A1、reaper/reconciler 同 tick 交错与 N-to-N 中继在该轮均
保持未验，不能用单测或“session=running”代替。Lead 已把 slot-local ingest token
和 `--alerts`×launchd-v2 identity duplicate 两项台架债务归入 FLY-2174；本节点
attempt 4 通过 question gate `7ebbcb73-c7f3-43ed-9492-174eeef8c522` 等待所有权/
集成裁决，避免在两棵活跃工作树重复实现。

### Implementation attempt 4：FLY-2174 依赖落地主线并完成 ②/③ 复核

FLY-2174 已通过 PR #1021 squash 落到 main `b60c753f6ee412b889c2ffbf4e1b00ff365c8a9a`。
本分支按 reviewer 审过的原始顺序集成五个代码提交：`97f462724`、`c7a80a336`、
`aae1b3b02`、`5a033aa9e`、`7f17ef18b`；`git range-diff` 证明对应 cherry-pick 的 patch
逐项相等。又把最新 `origin/main` clean merge 到 `8f3fc1429713c25cd1cc2b7c18f2cefb98468621`，
无人工冲突编辑，且 `origin/main` 是该 head 的祖先。

QA attempt 3 指出的两项台架依赖现已在落地后的 main 与集成 head 上复核：

- ② 重复 Lead 身份来源已移除：`scripts/test-deploy.sh` 中不再存在第二条
  `LEAD_EXTRA_ENV+=("FLYWHEEL_PROJECTS_FILE=...")`。`fly1726-lead-identity-wrapper` 6/6、
  `test-deploy-fly1389` 13/13、`test-deploy-qa-room` 18/18 与 `qa-room-env` 16/16 全绿。
- ③ generalized room 使用独立 slot-local ingest credential：`test-deploy.sh` 生成
  `TEST_TEAMLEAD_INGEST_TOKEN`，`qa-generalized.sh` 投影 `TEAMLEAD_INGEST_TOKEN`，Bridge
  配置读取后由 Blueprint 传给 adapter，最终 runner 得到 `FLYWHEEL_INGEST_TOKEN`。
  `test-deploy-generalized.test.sh` 全绿，Blueprint 36/36、`TmuxAdapter` +
  `CodexTmuxAdapter` 256/256 全绿；测试同时证明不会复用 master token、不会泄漏 ambient
  production auth，且 diagnostics 不暴露 bearer 字节。

集成 head 的精确仓库门禁：`pnpm lint` exit 0（14 条既有 warning/info）、
`pnpm -r build` exit 0；分支相对 main 的四个 shell 套件 `ci-structure.test.sh`、
`codex-guard.test.sh`（44/44）、`kill-ledger.test.sh`、`test-deploy-generalized.test.sh` 全部
exit 0。`pnpm test:packages:run` 仍只因 core 两个真实 Terminal.app/AppleScript 用例 exit 1；
目标文件与实现相对 `origin/main` 无差异，隔离复跑稳定返回 resident 环境的
`com.apple.hiservices-xpcservice: Connection Invalid`。该环境例外没有通过改断言伪造绿灯。

本 implement 节点至此完成 ②/③ 的落地主线复核。真实 A1 重启波 ≥30 分钟与 A2 murder
drill 仍由独立 QA 节点在 529 隔离台架执行；implement 没有启动 production launchd、没有发送
真实重启波，也没有越过 DAG 边界自行 dispatch QA。

### Code review round 10：补齐已持有目标的 recovery commit seam

依赖集成后的 request-driven review round 10 在 `reviewedHeadSha=1f17a95360b0071a88620a8068632a7963c55cfe`
返回 `CHANGES_REQUESTED`。唯一 blocking HIGH
`recovery-commit-seam-unreachable-for-parked-and-gate-held` 指出：旧实现只在 fresh
`startInitialTurn` 回调里 commit recovery claim；而 phase hold、gate hold 与已恢复/终态 goal
都会设置 `skipInitialActivation=true`，因此已持有目标虽然完成 re-own，却永远不会 commit，随后会
耗尽 recovery episode。

修复严格按 TDD 推进：先新增 persisted phase-hold 用例，证明回调次数为 0；再把硬 seam 抽象为
`onRecoveryOwnershipEstablished`，只接受 daemon 已确认的五类 receipt：`turn_started`、
`phase_hold_confirmed`、`gate_hold_confirmed`、`goal_resumed`、`terminal_goal_confirmed`。
fresh 路径仍只在真实 turn/start receipt 后 commit；phase/gate hold 必须先确认 goal paused 与持久化
hold；resolved goal 必须先得到 authoritative active/terminal 响应。callback 全程 `await` 且
fail closed，失败统一传播为 `recovery commit failed`。最小实现提交为 `946f3e79d`。

定向验证：claude-runner 的 daemon client/runtime/adapter 198/198 绿，teamlead reowner/runtime
24/24 绿；两包 typecheck、claude-runner build、目标 Biome 与 `git diff --check` 全绿。精确全仓门禁
再次得到 `pnpm lint` exit 0（同 14 条既有 warning/info）、`pnpm -r build` exit 0；四个分支 shell
套件全部 exit 0。`pnpm test:packages:run` 仍仅在 core 两个依赖 Aqua GUI 的 Terminal.app/
AppleScript 用例返回 `Connection Invalid` 后 first-fail。

受影响包的补偿全包揭示并收口两项确定性测试库存漂移：

- FLY-2174 的真实 Codex daemon teardown fixture 新增 4 个 kill-path 命中；它们均位于
  `scripts/__tests__` 且机械分类为 `qa-only`。inventory 先稳定报 477/481 红，再由 `162267dad`
  同步为 481，单测 1/1 绿，生产分类没有变化。
- 本分支新增的 `recovery_claim` 表已在 retention registry 中按 current/reference 保护，但 schema
  census 的精确计数仍停在 161。测试先稳定报 161/162 红，再由 `4e89577d8` 加入显式包含断言并
  更新完整/去 retired 总数；该文件 22/22 绿。

补偿全包的最终诚实结果：claude-runner 961/965 绿（2 skipped），两个并发 real-tmux 用例分别
在 5s 内超时/丢 socket，隔离复跑 2/2 与 1/1 绿；teamlead 9973/9984 绿（6 skipped），4 项
为 full-suite 资源竞争下的 5–10s timeout/global mock 污染，隔离复跑 preflight 4/4、账号锁
3/3、归档调度 22/22 全绿，余下 retention 确定性失败已按上项修复。没有把并发预算或断言放宽
来伪造全包绿灯。

fresh request-driven gate 在精确 `reviewedHeadSha=193edcb82772b18f1c20e822faa36fdb6cd69903`
返回 **APPROVED**，`reviewerVerdict` 同为 `APPROVED`，无 HIGH/blocking finding。8 条 MEDIUM
advisory 为 recovery confirmation 的 transport-death 分类、gate-hold pause 单次确认、claim TTL、
writer episode reset、reap ledger execId、recovery window label、rollout mtime 比较与 529 exclusion；
1 条 LOW 为 already-absent tmux window 的 evidence quality。完整 finding keys 已通过
`ask --report` 报告 Lead；按 `medium_low_findings_are_non_blocking_v1` 不阻断本 implementation
gate，留给 Lead 决定 follow-up。

### Implementation attempt 5：Lead advisory 裁定后的三项必修

Lead 在 QA 审计后明确指出：上一轮“advisory 已上报”只证明完成了报告义务，不等于代码已经
收口。三项必修重新进入 implementation scope；其余 claim TTL、writer episode reset、reap ledger
execId、recovery window label、gate-hold single-shot 与 already-absent tmux evidence 继续按 Lead
裁定记 follow-up，不冒充本轮已修。

本轮逐项执行 RED→GREEN：

- recovery confirmation 的两个 catch 原先把 socket close 都重写为 `setup_failed`。参数化回归先在
  gate-hold 与 resumed-goal 两条路径稳定得到错误分类，再以 `86e32c2c0` 在 `client.isClosed()`
  时恢复 `transport_closed`；目标 2/2 与 daemon-client 全文件 74/74 绿，claude-runner typecheck 绿。
- daemon teardown 的 throw path 原先只向 `console.warn` 写真实原因，两个异常在 StateStore 中都只剩
  相同的 `unverifiable`。回归以 `EACCES`/`ETIMEDOUT` 先得到两个 `undefined` cause，再把结构化
  `{kind,code,message}` 写入 host-process 与 Lead cleanup event，并把稳定 cause hash 加进 event id，
  避免唯一键把不同死因折叠。
- generalized QA room 排除不再猜 `qa-slot-529` 名字。回归使用真实
  `project_name=test-slot-3`、`tmux_session=runner-test-slot-3`、`/tmp/flywheel-test-slot-3/...`
  与纯 UUID execution；没有显式 marker 时必须不排除，只有 schema-valid、`generalized:true` 且
  `projectName` 精确匹配的 `room-info.json` 才排除。由于 marker 在 Bridge 启动后才落盘，另加一条
  wiring RED，要求每次 exclusion decision read-on-use；畸形 JSON/字段 fail closed。
- rollout mtime 由“只记录首值”改为跨 pass 保存 `{mtimeMs,lastAdvancedAtMs}`。递增序列即使跨过
  10 分钟阈值仍保持 healthy；不变序列在阈值前仍 healthy，达到阈值后进入现有 fail-closed
  `reown_probe_unknown` 通道，连续两次才 alert，且断言 claim/reap/revive 全为零。两种序列由同一
  exported threshold 驱动，避免测试与生产常量漂移。

三项主体与 late-marker 修正落在 `59cc876ec`，格式收口为 `2d2f232a0`。受影响 teamlead 三文件
32/32、teamlead typecheck、目标 Biome 与 `git diff --check` 全绿。精确仓库门禁在该代码 head：
`pnpm lint` exit 0（14 条既有 warning/info），`pnpm -r build` exit 0；四个分支 shell 套件全部
exit 0。`pnpm test:packages:run` 仍只在 core 两个真实 Terminal.app/HiServices 用例得到
`Connection Invalid` 后 first-fail（219 个 core 非 GUI 测试已绿），没有 FLY-2211 行为红灯。

按合同实际调用 `/codex:rescue` review-only；companion 在读取 AGENTS.md 前仍被 resident 外层
seatbelt 拒绝嵌套 `sandbox-exec`（status 71），因此不记 PASS，也没有用 raw `codex exec` 冒充。
fresh request-driven cross-family review 已在精确
`reviewedHeadSha=ce49cc7233b8d82dee583081e53fbfdf6cd6de4d` 返回 **APPROVED**，
`reviewerVerdict` 同为 `APPROVED`，没有 HIGH/blocking finding。review request 为
`a127398e-3a64-4b91-afa4-6324691127e7`，gate 为
`e539651d-e9c1-40c3-ab0f-12f686ceff14`。新列出的四项 advisory 是 generalized room 会令
529 playbook 的 re-owner drill 失去辨别力、畸形 room marker 会中止整轮 pass、owner
success-without-commit 可能泄漏 claim、10 分钟 rollout 静默阈值可能误报；其余为此前已记录的
recovery TTL、episode reset、kill-ledger execId、window label、gate-hold single-shot 与 tmux
already-absent evidence 项。全部 finding 已通过 `ask --report` 回传 Lead，并按
`medium_low_findings_are_non_blocking_v1` 留待治理，不冒充本轮三项必修。

补偿包级验证的最终诚实结果：claude-runner full package 为 964 pass、2 skipped、1 个
`prompt-overflow.real-tmux` 在 5 秒门槛超时；同文件立即隔离复跑 2/2 绿，核心场景 4.975 秒完成。
teamlead full package 为 9978 pass、6 skipped、4 fail，且 Vitest 同时报
`Timeout calling onTaskUpdate`；三个失败文件以单 worker 隔离复跑 29/29 绿。没有放宽 timeout、
修改断言或隐去 full-suite 的真实退出码。Lead 同时确认 re-own 真机触发等待 FLY-2237 台架原语，
不是本 implement attempt 的未交付项。

- attach 探针已由 QA attempt 2 在 0.152.0 上完成;后续 attach-adopt 升级由独立 follow-up 承接,不属于本 PR 验收。
- **真重启波 ≥30 分钟存活 + kill ledger 关联 + 谋杀演练**是本单唯一真验收面:执行真实重启波,观察全部在场 Codex worker rollout 连续前进至少 30 分钟,并把每个 survivor 与同窗口 kill ledger 对齐,证明无越权 mutation。
- 谋杀演练:kill 一个 gate-free daemon group,要求一个维护节拍内同 execution、同 thread 复活,TUI 重开,无第二 execution/双 daemon,TURN holder 不变。

### Implementation attempt 6：合入 FLY-2237 台架原语与四分片 CI

QA attempt 5 已确认 attempt 5 的三项必修全部通过，唯一返工动作是按 Lead 指令机械合入
`origin/main`：同时取得 FLY-2237 的 slot-only Bridge cycle 原语与 FLY-2245 的四路 shell 分片。
合入前 acceptance guard 稳定为 RED：缺少 `scripts/test-cycle-bridge.sh`、
`scripts/lib/qa-slot-bridge.sh`，CI 只有 2 个 shell shard；merge commit `83b6fb134` 后同一 guard
转为 GREEN，两份文件存在且 shard 数为 4。没有冲突，也没有修改 FLY-2211 产品逻辑。

合入后的受影响验证：cycle primitive 31/31、CI structure、generalized deploy helper 与 multilead
23/23 全绿；FLY-2211 的 11 个目标 Vitest 文件 137/137 全绿。首次目标运行因 pre-merge
`packages/config/dist` 没有新 `MODEL_ALIASES` export 而 collection fail；先执行既有 config build
刷新 workspace dist 后，原命令完整转绿，未用产品代码掩盖 stale build artifact。

首个合入 head 的 GitHub run `33590585140` 证明四分片已生效，但 Unit(heavy) 暴露确定性的语义
merge drift：FLY-2237 新增的 QA cycle/slot 脚本进入本 PR 的机械 kill scanner，实际 552 条而 fixture
仍是 481 条。Lead 明确批准在“合 main”授权内机械同步。逐条 set-difference 审计结果如下：

- `scripts/__tests__/test-cycle-bridge.test.sh`：45 条；
- `scripts/__tests__/test-deploy-fly1389.test.sh`：9 条；
- `scripts/lib/qa-slot-bridge.sh`：2 条；
- `scripts/test-cycle-bridge.sh`：15 条。

71/71 均由 scanner 分类为 `qa-only`，`non_qa_only=[]`；四个路径也都限定在 test/QA slot
surface，没有 production kill 路径混入。fixture 由同一 scanner 机械再生到 552 条，只有 426 行
插入，提交为 `faad9fe1c`；原精确 RED `test/kill-path-inventory.test.ts` 随即 1/1 GREEN。

最终 code head `474329334f739817ac2317b956699c2e960340ae` 的仓库门禁：

- `pnpm lint`：exit 0（14 条既有 warning/info）；
- `pnpm -r build`：exit 0（22/23 workspace projects）；
- `bash scripts/__tests__/kill-ledger.test.sh`：PASS，负例仍证明 ledger append 失败时拒绝 signal；
- `pnpm test:packages:run`：exit 1，仍只因 core 两个真实 Terminal.app/Apple Events 用例在
  resident sandbox 返回 `Connection Invalid`；其余 core 219/219 绿，相关实现与测试相对 main
  无差异；
- GitHub run `33591221412`：最终 13/13 checks PASS，包括 Unit(heavy)、Unit(light)、teamlead
  3/3 与 Script Tests 4/4；四个 shell shard 分别用时 8m30s、9m10s、9m31s、9m10s，容量
  tripwire 不再触发。

按合同实际走 `/codex:rescue` review-only；companion task
`task-mtjlb1mw-b76dn0` 在读取 AGENTS.md 前被 resident 外层 seatbelt 拒绝嵌套
`sandbox-exec`（status 71），没有产生 verdict，且没有改走禁止的 raw `codex exec`。fresh
request-driven review request `19d772ab-a6d3-4913-a3b2-8807a9935a9b` 在精确
`reviewedHeadSha=474329334f739817ac2317b956699c2e960340ae` 返回 **APPROVED**，
`reviewerVerdict=APPROVED`，无 HIGH/blocking finding。既有 MEDIUM/LOW follow-up 保持
non-blocking；新增 LOW `cycle-primitive-restart-signals-absent-from-kill-ledger` 提醒 QA：slot-only
cycle 的信号正确归类 QA-only，但不能把 production ledger 中没有该 QA 信号误读成“重启波没有
发 signal”。全部 advisory 已通过 `ask --report` 回传 Lead。

本 implement 节点没有启动 529 room、没有触发真实 restart wave，也没有自行 dispatch QA。
FLY-2237 原语与全绿 head 已准备完毕，A1 ≥30 分钟 survivor 观察及 A2 murder drill 仍由独立 QA
节点执行。
