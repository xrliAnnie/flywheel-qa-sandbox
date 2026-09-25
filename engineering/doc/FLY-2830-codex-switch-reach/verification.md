# FLY-2830 Codex 切号器够不到实现节点 — 实施验证记录
Issue: FLY-2830 (https://linear.app/geoforge3d/issue/FLY-2830/codex-切号器-号打满了活却没切到有额度的号上读数-25-小时没刷新认错当前号切号到不了-implement)
日期: 2026-09-25
基于: plan.md

## 1. 交付与提交

| 切片 | 提交 | 要点 |
|---|---|---|
| W1 | `2f0389c6c` | `resolveSocketProbePath`（claude-runner 包根导出）：软链 → 只信本 uid 的 socket 目标；runtime 与收割器两处 lsof 探针都只经它选路径。缺失路径仍按 `plain` 交给 lsof（与改前行为一致）。|
| W2 | `99ff1cc12` | resident 分支按 executionId 分组：先用现有 `residentEvidence` 全链路找 daemon，其余进程只接受精确的 `codex resume --remote unix://<本执行体 socket>` TUI 客户端，否则 `resident_process_unbound`（带 pid）。|
| W4 | `7806646e4` | `occupancyVerdict` 纯函数 + `OccupancyAnswer{verdict,detail}`；`guard()` 用自己那次 `collect()` 作答；`noteDetail` 写入前校验。|
| W5 Bridge / W7 | `19c0298ca` | `SwitchRefreshTrigger`、`last-switch.json`、页面逐格标注与横幅；卡到期到分钟、每行读于、占用盘点原因、HTTP 401/403、Claude 扣费日原因。|
| W5 quota-monitor | `866c52ced` | `sweep-request.json` + state V2 三键 + 请求模式（swept / 3 轮 partial / blocked_monitor_only；瞬态闸门不计次）。由子代理实现，我复审 diff 并复跑其测试后提交。|
| W8 | `eed8561e7` | `recordPoolExhausted` 同事务固化 `alertSnapshot`；outbox 只按 payload 渲染中文正文，解析失败走旧英文正文。|
| W5 接线 / W6 | `836bdedc0` | plugin：GatePoller tick 上挂 trigger（在 Codex 维护 reconcile 之后）、专用 waker、页面路由取 last switch；调度器改用 Codex + Claude 卡/订阅刷新，只有 Codex 一路能判本轮失败。|

## 2. 与计划的偏差（均为实现细节，不改设计）

1. **W1 缺失路径**：计划写「其它错误 → untrusted」。`lstat` 的 ENOENT 按 `plain` 处理——lsof 对不存在路径本来就答「无持有者」，收割器 after-kill 阶段依赖这一点；改成 untrusted 会把收割器的 `ok/[]` 变成 `unknown`，是行为回退。其余 lstat 错误照计划 `untrusted:lstat_failed`。
2. **W6 分路结果**：`createAccountReadingsRefresh` 返回 `{codex, claude}` 两路结果；给调度器的适配器 `scheduledReadingsRefresh` 只在 Codex 一路失败时 reject（沿用原错误对象，`failureCode` 与改前一致），Claude 失败只记 `[reading-scheduler] claude_details_failed:<code>`。调度器本身未改。
3. **W8 正文**：中文表格之后保留原有的一行 `Trigger=… affected_runs=… restarted_runs=…` 明细（现有测试「founder notification with quota and run details」依赖它，属现有契约）。
4. **W8 模块位置**：快照构建 / 严格解析 / 渲染放在新文件 `codex-quota/pool-exhausted-alert.ts`，store 与 outbox 只调用它。
5. **W7 时间格式**：「读于」「切号」时刻在页面生成日（PT）内写 `HH:MM`，跨日写 `MM/DD HH:MM`——隔天的读数不能看起来像当天的。
6. **trigger 挂点**：计划写「与 `onAccountSwitchTick` 同处」。该回调只在 review coordinator 就绪后才装，故改挂在同一个 GatePoller tick 的 `onLandOperationTick` finally 段，紧跟 FLY-2869 调度器之后（Codex 手动切号的 reconcile 在同一 tick 的维护步骤里先完成）。
7. **quota-monitor 请求路径**：守护进程读 `FLYWHEEL_CLAUDE_SWEEP_REQUEST_PATH`，否则取 state 文件同目录下的 `claude-quota/sweep-request.json`（与 witness 同一定位方式）；生产解析为 `~/.flywheel/claude-quota/sweep-request.json`，与 Bridge 的 `defaultSweepRequestPath()` 相同（已只读核对 plist 与 `.env` 未设置覆盖变量）。

## 3. 本地定向验证（均为本机实跑，退出码与条数如下）

- `pnpm lint`：exit 0，0 error（26 条 warning 均为既有；plugin.ts 的 2 条 `useConst` 在 origin/main 上同样存在）。
- `pnpm --filter "flywheel-teamlead..." build`：exit 0。
- `pnpm --filter "...flywheel-claude-runner" typecheck`（claude-runner 导出变更的全部依赖方 claude-runner / edge-worker / voice-bridge / teamlead / voice-codex）：exit 0。首跑 voice-codex 报 `Cannot find module 'flywheel-voice-bridge'`，原因是本 worktree 未构建 voice-bridge 的 dist；`pnpm --filter "flywheel-voice-codex^..." build` 后复跑全部通过。
- `vitest related`：
  - claude-runner `src/codex-daemon-runtime.ts`：7 文件 / 354 条通过。
  - teamlead `src/account-heal/quota-monitor-runtime.ts`：5 文件 / 168 条通过。
  - 其余 teamlead 改动文件的反向依赖闭包经 `bridge/plugin.ts`（105–110 个测试文件）或 `StateStore.ts`（824–848 个测试文件）膨胀到整包量级，按规则不在本地跑，改为下面的直接消费者清单；整包交给 CI。
- 直接消费者（静态导入深度 1 的全部测试文件，排除 `tmux-viewer.macos`）：39 个文件 / 863 条，分 7 批全部通过。
- 直接读 `plugin.ts` 源码的结构测试：20 个文件，加 `capacity-route` 与 `account-quota-refresh`，共 22 个文件 / 226 条通过。
- 脚本侧消费者（按导入说明符 `<目录>/<名>.js` 检索）：`codex-home-reconcile-cadence.test.sh`、`fly1674-residue.test.sh`（85/0）、`codex-quota-readiness-check.test.sh`、`qa-codex-lead-parity.test.mjs`（9/9）、`ship-judgment-timer.test.mjs`（2/2）、`fly-2006-retention-consumer-gate.test.mjs`（10/10）全部通过。
- 清册守卫：`kill-path-inventory`、`codex-sync-timeout-contract`（7/7）、`bridge-child-process-census`（1/1）通过；本单未新增生产 spawn/kill/同步子进程调用，未新增 SQLite 表。
- 跑任何 teamlead vitest 前均 `export FLYWHEEL_CODEX_HOMES_ROOT=<scratchpad 隔离根>`、`TMPDIR=/tmp`。

**排除项（git grep 命中但不跑，理由）**

- `packaged-seams.test.sh`、`run-bridge-isolation-boot.test.sh`：自己写桩 `dist/bridge/plugin.js`，不读本单代码。
- `scripts/qa-fly-1252-quota-state-e2e.sh`：人工 QA 驱动脚本，不是测试。
- `claude-runner/src/index.ts` 的通用名命中（`index.js`）：属其它包；本单只在包根追加导出，依赖方 typecheck 已覆盖。
- `bridge/plugin.ts` 的 82 个导入方测试：多数起真 Bridge；在 VITEST 下 `onLandOperationTick` 提前返回，trigger 不会 tick；构造 trigger 与专用 waker 无 I/O。交 CI。

**CI 与 lsof**：W1 的真实 socket 用例依赖 `lsof`；`ci.yml` 的 unit-tests 作业已安装 `lsof`（`scripts/ci-apt-install.sh tmux lsof ffmpeg`），未做平台跳过。夹具在 `realpath` 后的目录 listen——darwin 的 lsof 按 socket 的绑定名匹配（本机实验：在 `/tmp/x` 绑定、对 `/private/tmp/x` 查询得不到持有者），Codex 自己也是在 `/private/tmp/codex-daemon-<uid>/` 下绑定。

**合并 origin/main 之后复验**（合并提交 `839b47e23`，main 带进 299 个文件，本单文件中仅 `plugin.ts` 重叠且自动合并）：`pnpm install --frozen-lockfile`、构建、claude-runner 依赖方 typecheck、`pnpm lint`（0 error）均 exit 0；teamlead 定向集（直接消费者 + plugin 源码结构测试 + capacity-route，并加入评审轮新增的 `private-directory.ts`、`candidate-selector.ts` 的直接消费者）61 个文件 / 1084 条全过；claude-runner `vitest related` 7 个文件 / 369 条全过；6 个脚本侧消费者测试全过。

## 4. 生产只读证据（`evidence/implement-readiness-and-reaper-drill-2026-09-25.txt`）

- **readiness 回放**（plan 附带的回放脚本，`R` 指向本 worktree 的 dist；StateStore 只读句柄）：
  - 原样：阻塞仅剩 `resident_evidence_incomplete(implement)`——来自 FLY-2873 已结束执行体的孤儿 app-server 86434（CommDB 无行，W3 已删，靠收割器收）；第二轮另有一个 `/tmp/fly2884-proto/home-s4` 的 `unapproved_live_home`，是别的单在 `/tmp` 起的真 Codex 原型进程，属真实未登记读者，不是误判，第一轮不存在。
  - 快照中剔除 86434（模拟收割器已收掉）：implement home = `active`（60140 daemon + 18081 TUI 客户端被 W2 正确归属），第二轮 `complete=true`，`readiness {"ready":true,"failures":[]}`。
  - 4 个 `comm_orphan`（FLY-2519/2608/2619/2766 的 CommDB running + `phase_keep_alive=1` 残行，StateStore 均 completed）在第二轮按现有规则转为 `comm_stale_running`（info），不阻塞。
- **孤儿收割器演习**（生产清单；`signalGroup`/`removeSocket` 为只记录桩）：生产 dist 对 86434 判 `socket_holder_mismatch`；本单 dist 走到对 pgid 86434 发 SIGTERM（被桩拦下）。演习后 `ps` 仍见 86434 存活。收割器总开关 `worktreeAutocleanEnabled()` 恒为 `true`，年龄门槛 2h 早已满足 ⇒ 上线后第一个维护周期即可收掉（QA 判据 7 在生产核）。

## 5. 回滚（plan §10：quota-monitor state 新三键在旧版严格白名单下会被判损坏）

必须按此顺序：

```bash
# ① 停 quota-monitor
launchctl bootout "gui/$(id -u)/com.flywheel.quota-monitor"
# ② 原子删除三个新键（临时文件 → rename）
node --input-type=module -e '
import { readFileSync, writeFileSync, renameSync } from "node:fs";
const p = process.env.HOME + "/.flywheel/quota-monitor-state.json";
const s = JSON.parse(readFileSync(p, "utf8"));
for (const k of ["lastSweepRequestId", "lastSweepRequestOutcome", "pendingSweepRequest"]) delete s[k];
writeFileSync(p + ".rollback-tmp", JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
renameSync(p + ".rollback-tmp", p);'
# ③ 装旧版本（revert 本 PR 后构建）并用旧版解析器校验：recovery 不能是 corrupt
node --input-type=module -e '
import { loadQuotaMonitorState } from "<旧版 repo>/packages/teamlead/dist/account-heal/quota-monitor-state.js";
const r = loadQuotaMonitorState(undefined, { nowMs: Date.now(), storeGeneration: 0 });
if (r.recovery === "corrupt") { console.error("state still corrupt"); process.exit(1); } console.log("ok", r.recovery);'
# ④ 启动 quota-monitor（由 updater / launchctl bootstrap 按现有方式）
```

`sweep-request.json` 与 `last-switch.json` 旧版本不读，无需清理。

## 6. 代码审查（`codex:rescue`，xhigh，review-only）

**R1（CHANGES REQUESTED，1 HIGH + 2 MEDIUM + 1 LOW）→ `679a1928a`**

| # | 级别 | 意见 | 处理 |
|---|---|---|---|
| 1 | HIGH | `last-switch.json` 临时名只含 PID、以 `"w"` 打开：同 UID 进程预置同名软链即可让切号时截断/改写 Bridge 可写的任意文件；既有父目录不收紧 | 临时名加随机后缀、`"wx"`（O_CREAT\|O_EXCL，不跟随软链）创建、父目录每次 `chmod 0700`、只删本次创建的临时文件。回归：预置软链于临时名 → 写入抛错、软链目标不变；既有 0755 父目录 → 0700、文件 0600（修前 2 条 RED）|
| 2 | MEDIUM | quota-monitor 按 `FLYWHEEL_QUOTA_STATE_PATH` 的目录推导请求路径，Bridge 按 `FLYWHEEL_STATE_DIR` 写：设任一 override 后两端分叉，SIGUSR1 成功但请求永远看不到 | `QuotaMonitorPaths` 加 `sweepRequestPath`，默认 `defaultSweepRequestPath()`（与 Bridge 同一函数），不再从 state 路径推导；测试走显式 seam。回归：设 `FLYWHEEL_QUOTA_STATE_PATH` 后默认路径仍等于 `defaultSweepRequestPath()`（修前 RED）。teamlead `vitest.setup.ts` 每个测试把 `FLYWHEEL_STATE_DIR` 指向临时目录，测试不会读到生产请求文件 |
| 3 | MEDIUM | 中文正文后拼接的 `Trigger=… affected_runs=… restarted_runs=…` 仍从实时 incident/targets 读：歧义重放前 runner 恢复会改变正文 | 该行也在 `recordPoolExhausted` 同一事务冻结为 `alertDetails`（严格解析：source/target 标签、canonical ISO、计数 0..10000 且 restarted ≤ affected），outbox 只从 payload 渲染；details 缺失则不渲染该行，非法则记日志并省略。回归：首发后把 runner 目标改为 `recovered` 再重放 → 正文逐字相同（修前 RED）|
| 4 | LOW | 严格解析仍接受语义上不可能的快照（非打满账号、乱序/重复 profile、负时间）| 解析与构建都要求时间非负、profile 严格升序（即唯一）、每个账号 `reached` 或有 100% 窗口。回归：5 种非法快照被拒（修前 RED）|

**R2（限定验证轮，CHANGES REQUESTED，2 MEDIUM，均为 R1 修复带出的缺口）→ `2702af2f4`**

| # | 级别 | 意见 | 处理 |
|---|---|---|---|
| 1 | MEDIUM | `mkdirSync(recursive)` 接受已存在的目录软链，`chmodSync` 随后跟随：`~/.flywheel/codex-quota` 若是软链，会改目标目录权限并把记录写到别处 | 新 `src/private-directory.ts` `preparePrivateDirectory()`：`O_RDONLY\|O_DIRECTORY\|O_NOFOLLOW` 打开、`fstat` 核本 uid、`fchmod 0700`，否则 fail closed 不写。`last-switch.json` 与 `sweep-request.json` 两个写者共用（后者是同类缺陷，一并修）。回归：父目录为软链 → 两个写者都抛错、目标目录权限与内容不变（修前 2 条 RED）。残余：检查与随后按路径创建临时文件之间仍有同 uid 竞态窗口（Node 无 openat），与既有状态文件写法同级 |
| 2 | MEDIUM | selector 对每个 pool profile 取最新一条读数，同一 profile 有历史读数时仍判 `pool_exhausted`，但 builder 收到全部读数、因重复 profile 返回 null → payload 丢快照，outbox 退回读实时数据的旧正文 | 抽出导出函数 `latestPoolObservations()`，selector 自身与快照构建共用同一份逐 profile 证据（历史读数与 pool 外的 profile 被忽略）。capacity fact 的存证内容不变。回归：同 profile 两条读数 + 一个 pool 外 profile → 仍冻结快照与 details，且快照等于只用证据构建的结果（修前 RED）|

**R3（限定验证轮）→ APPROVED，无 finding。** 评审核实：两条 R2 意见已修且有修前失败的回归；`preparePrivateDirectory` 在 darwin 实测拒绝软链、`O_DIRECTORY`/`O_NOFOLLOW` Linux 同样支持；写入异常由 trigger 与 sweep requester 捕获，不会逃逸到 Bridge 启动或 GatePoller tick；`latestPoolObservations` 与 selector 原内联逻辑等价（排序、取最新、并列行为不变）。评审沙箱只读，未能跑 vitest；以上各轮回归测试均由我在本机实跑通过（见第 3 节与各轮说明）。

## 7. QA 返工（implement attempt 2，Lead 指令 4d3b2939）

QA attempt 1（头 `ce128505c`，报告 `~/.flywheel/artifacts/FLY-2830/qa-attempt1-ce128505c/QA-REPORT.md`）判 FAIL，唯一阻断是 full CI 的 `Unit (light)` 红：`packages/config` 的 `feature-flags-drift.test.ts` 报新环境变量 `FLYWHEEL_CLAUDE_SWEEP_REQUEST_PATH` 未登记。这个守卫按「源码里出现的 env 名」全仓扫描，按文件名找消费者找不到它，所以第 3 节的定向集漏掉了。同轮按 Lead 指令修三条 founder 看得到的非阻断项。提交 `b2eb73bf5`：

| 项 | 改动 | 回归 |
|---|---|---|
| F1 | `FLYWHEEL_CLAUDE_SWEEP_REQUEST_PATH` 登记进 `NON_FLAG_ALLOWLIST`，理由：Bridge 写者与 quota-monitor 共用的请求文件路径覆盖，不是开关 | `feature-flags-drift` 14/14（改前 2 条红）|
| O1 | 已取消且用量已读不到的 Claude 号（与页面显示「已取消」同一判定，如 personal1）不带数据源时间：不参与切号后标注，也不计入横幅，横幅可以到「已全部重读」。已取消但仍能读用量的号照常判定 | 视图用例：personal1 无 `sources`、页面该行无标注（改前 RED）|
| O2 | 只有在用号的只读（WHAM）路径会只刷新配额、不刷新兑换卡列表，于是卡列表与时间沿用旧的一轮。判定为「卡读数时间早于配额读数时间」（app-server 路径两者总是同一时刻写；deadline / read_failed 行两者一起沿用；旧版 store 没有卡读数时间，按配额时间计）→ 卡格写「读不到（在用中，只读接口不给兑换卡明细）」，不再显示旧卡；该格的数据源时间取配额读数时间（原因与配额同样新）| 视图用例：旧卡不出现、原因出现、数据源时间正确（改前 RED）。两条既有用例的期望随之调整：FLY-2869 阈值用例改为卡与配额同时读旧（仍验「按 Codex 阈值判旧」）；数据源时间用例改为断言沿用时取配额时间 |
| O3 | 全部打满告警正文不用竖线伪表格，改为「各号用量与重置（PT）：」加一行一个号 `- 号：窗口… → 恢复 …` | 正文逐行断言、断言不含 `\|`；outbox / bench 用例全过 |

返工本地验证：`pnpm lint` 0 error；`flywheel-config` 起的构建与其依赖方 13 个包 typecheck exit 0；config `vitest related src/feature-flags/truth.ts` 18 个文件 / 328 条；teamlead 直接消费者（view、page、capacity-snapshot、capacity-route、pool-exhausted-alert、codex-quota-outbox、codex-quota-bench）7 个文件 / 176 条；脚本守卫 `fly1674-residue`（85/0）、`fly2102-flag-freeze`（46/0）。`test-deploy-generalized.test.sh` 用 glob 排除了 truth.ts，不读它，未跑。

返工评审（`codex:rescue`，xhigh，只审 `b2eb73bf5`）：**APPROVED**，无 finding。评审核实：O1 与「已取消」显示同一判定，仍能读用量的已取消号不被隐藏；O2 的「卡时间早于配额时间」只由在用号只读路径沿用旧卡产生，标注映射诚实；O3 每号一行无竖线；allowlist 理由准确；改过期望的两条既有用例仍验原意。评审沙箱只读未跑 vitest，上述测试均由我本机实跑。
