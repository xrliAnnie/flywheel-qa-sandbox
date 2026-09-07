# FLY-2385 Raya 仓纳入班车部署 + 「合入≠上线」防线 — 实施计划
Issue: FLY-2385 (https://linear.app/geoforge3d/issue/FLY-2385/raya运维-raya-仓纳入班车部署-合入上线防线生产-checkout-落后-originmain-244-commits)
日期: 2026-09-06
基于: research.md

**Status**: draft v6（Codex R5 两条规范歧义写死；待 Lead leadAcceptance 收口）
**Version**: v1.57.0
**Base**: main `8126576cf`
**本文件是唯一实施规范**：research.md 只保留代码锚点与修订记录；凡本文与 research.md 冲突，以本文为准。

## 0. 一句话

让既有的 `com.flywheel.updater` 班车在**定时（scheduled）**唤醒时多做一段独立的 Raya 部署（锁 → 身份门 → 围栏 → fetch → 只读分类 → **会话宽限（任何写之前）** → ff-only → install/build → `raya preflight` → 围栏 → 身份重验 → kickstart `com.xrli.raya.brain`（voice 在跑就一并换）→ 验证 → 先写 receipt 再写 deployed-sha；失败只回滚到**已验证的 known-good** 并告警），让 Eng Lead 巡检 STEP 5 多一行「Raya 生产 checkout / 账本 / 班车新鲜度」的确定性事实并按规则在 #flywheel-engineer 发 warning，并把「合入 ≠ 上线」写进 Done 判据。不改 Raya 代码，不改 plist，不新增任何调度器，不新增任何人工生产入口。

## 1. 假设（明示）

1. Raya 生产目录固定为 `${FLYWHEEL_HOME}/raya/code`，`origin` 的 URL 必须是 `https://github.com/xrliAnnie/raya.git`（或 `git@github.com:xrliAnnie/raya.git`），部署分支只有 `main`，生产 checkout 必须停在本地分支 `main`。
2. `com.xrli.raya.brain` / `com.xrli.raya.voice` 两张 plist 由 Raya 仓自己安装（`apps/brain/src/launchd.ts:30-33`：`ProgramArguments = [nodeBin, entrypoint, "run"]`），本仓不模板化、不改写、不 bootout/bootstrap。班车只 `kickstart -k` **已加载且运行身份正确**的 label。
3. 「preflight ready」= `node apps/brain/dist/cli.js preflight` 退出码 0（`cli.ts:85-110`）。**Lead 裁定 fail-closed**（question `189b4924`）；`RAYA_PREFLIGHT_MODE` 不作为生产开关存在。
4. **Lead 裁定（`189b4924`）**：不顺延到下一班。有活跃语音/会议会话时最多等 10 分钟（每 30s 轮询），到点照重启，并在 #raya 文本频道留一句「班车重启，断了抱歉」。**宽限只在任何 checkout 写操作之前计一次**；宽限结束后（含 build 期间）新出现的会话按裁定直接打断并通知，不再二次停放已写入的 checkout（R3）。宽限期间到达的 founder 紧急票**不被抢占、只被延迟**：本实例持有 updater singleton，票留在 QueueDirectories，本实例退出后 launchd 按 `ThrottleInterval 60` 再起一个实例消费它（plist 注释已如此约定）；最大延迟 = 600s + 本次 Raya 部署耗时。
5. `launchd` 用户域为 `gui/$(id -u)`。
6. **前置运维事实**：Codex R1 发现已加载的 voice job argv 指向旧 worktree；Lead 于 2026-09-06 已 bootout+bootstrap 重载（report `b646bac7`），本节点复核 `launchctl print` 两个 label 的 arguments 均为 `[/opt/homebrew/Cellar/node/25.6.1/bin/node, ~/.flywheel/raya/code/apps/<app>/dist/cli.js, run]`。身份门（§3.3）保留为长期防线。
7. Raya 只在**定时**唤醒时部署。founder 紧急票（urgent token）只授权 flywheel 的 `targetSha`，不授权任何 Raya 版本；无效/不确定/失败的 urgent 唤醒对 Raya 零 mutation。

## 2. Chunk 划分

| chunk | 内容 | 依赖 | 回滚 |
|---|---|---|---|
| **A** 库 + 测试 | `scripts/lib/updater-raya-deploy.sh`、`scripts/__tests__/updater-raya-deploy.test.sh` | 无 | 删文件 |
| **D** Done 判据 | `linear-issue-context.ts` 模板第 7 条 + `founder-only-authority.md` R1 小节 + `summary-inflow.md` 一句 + 模板测试 | 无 | revert 文本 |
| **B** 接入班车 | `update-flywheel.sh`：wake kind / cycle result、source、`raya_configure_runtime_paths`、告警 helper、`updater_cleanup` 集成、调用点、CI 登记、`update-flywheel-sources.test.sh` 追加 | A | revert PR |
| **C** 巡检事实行 | `lead-patrol-snapshot.sh` STEP 5 + 测试 + `runner-patrol-rules.md` 第 5 步 + 规则/validator 测试 | B 已上线且至少一次定时班车写过 receipt | revert |

合入顺序 **A → D → B → C**。没有 chunk E，也没有任何等价的人工生产入口（§10）。

## 3. Chunk A — `scripts/lib/updater-raya-deploy.sh`

### 3.1 契约

- source-only；库内不开 `-e`；**不设任何 trap**；不冻结路径（§4.1 `raya_configure_runtime_paths` 派生）。
- 输出：`RAYA_DEPLOY_STATE ∈ {missing, locked, identity_drift, observe_failed, wrong_branch, dirty, remote_mismatch, fetch_failed, mutated, diverged, ledger_probe_error, session_state_unreadable, current, deployed, rolled_back, rollback_blocked_mutation, failed}`，`RAYA_DEPLOY_DETAIL`（单行、无 secret）。
- 返回码：`0` current/deployed/rolled_back；`1` refused（missing/locked/identity_drift/observe_failed/wrong_branch/dirty/remote_mismatch/mutated/diverged/ledger_probe_error/session_state_unreadable）；`2` fetch_failed；`3` failed/rollback_blocked_mutation。
- **单一出口 `raya_finish <state> <detail> <rc>`**：仅当 `RAYA_LOCK_OWNED=1` 才写 receipt/deployed-sha；释放自己的锁；设置状态变量；return。`missing`、`locked` 两个 pre-lock 出口**不写任何共享文件**，只日志 + 告警。
- seam（全部 `declare -F` 可覆盖）：`raya_git`、`raya_git_fetch_bounded`、`raya_pnpm_install`、`raya_pnpm_build`、`raya_preflight`、`raya_launchd_print <label>`、`raya_plist_program_arguments <label>`（`plutil -extract ProgramArguments json -o - $RAYA_PLIST_DIR/<label>.plist`）、`raya_kickstart <label>`、`raya_process_start <pid>`（`ps -o lstart= -p`）、`raya_sleep`、`raya_now`、`raya_alert <severity> <class> <title> <body>`、`raya_notify_interruption <new8>`。

### 3.2 锁（先于一切共享读写）

- 目录 `$RAYA_HOME/deploy.lock.d`，文件 `pid`、`start`（owner 的 `ps -o lstart=` 原文）、`created`。
- 获取：`mkdir` 成功 → 写三文件（任一写失败 → 清理 → `locked`，warning `raya-lock-state-failed`）。`mkdir` 失败 → 读 `pid`/`start`：pid 不活 → stale；活且 `raya_process_start pid == start` → **live owner，不驱逐** → `locked`；活且 start 可读但不等 → PID reuse → stale；活但 start 不可读 → **不驱逐** → `locked`。stale → 清理后重试 mkdir 一次。
- 不用命令行字符串判身份（生产 argv 是 `/bin/bash …/update-flywheel.sh`，与任何 ident 无关，R2 抓到）。
- 释放：`raya_lock_release` 只在 `pid == $$` 时删；`updater_cleanup` 末尾追加调用（§4.3），信号路径靠它收尾。
- 测试：生产 argv 形状与 sourced 台架 argv 形状各一组；foreign-live / PID-reuse（start 不同）/ start 不可读 / owner 写失败 / 每个 return 后锁不存在 / INT 经 `updater_cleanup` 释放且 urgent claim 逻辑不变。

### 3.3 身份门（持锁后、任何写操作前；kickstart 前逐次重验）

对 brain、voice 各做：

| 项 | 期望 |
|---|---|
| job 已加载 | `launchctl print` rc 0 |
| `program` | == `arguments[0]` == 磁盘 plist `ProgramArguments[0]`（`raya_plist_program_arguments`），且存在、可执行 |
| `arguments` | 恰好 3 项：`[<program>, $RAYA_CODE_DIR/apps/<app>/dist/cli.js, run]` |
| `working directory` | `$RAYA_CODE_DIR` |
| `RAYA_ENV_FILE` | `$RAYA_HOME/raya.env` |
| brain 与 voice 的 `program` | 相同 |
| `raya.env` 单键 | `grep '^RAYA_HOME='` == `$RAYA_HOME`、`^RAYA_METRICS_DIR=` == `$RAYA_HOME/data/metrics`、`^RAYA_STATE_DIR=`（缺省允许，存在则）== `$RAYA_HOME/data/state`（Raya `config.ts:42-55` 允许 env 覆盖这两个目录；不 source 整个文件，只 grep 三个键） |
| 观测一致性 | 任一 label `state = running` 时 `pid` 必须是正整数；running 但 pid 缺失/不可解析 → `observe_failed`（severe），不继续 |

任一不符 → `identity_drift`（severe `raya-launchd-identity-drift`，正文列出 label、实际 vs 期望），不 fetch 不写 checkout。通过后 `RAYA_NODE_BIN=<program>`。**每次 kickstart（正常与回滚）前重跑同一函数**（TOCTOU：build 可达 120s，期间有人 reload 到错误 job）；重验失败 → 该分支按「kickstart 失败」处理（§3.6），不 kickstart。

### 3.4 主流程 `updater_raya_pass`

1. `code/` 不存在或非 git → `missing`（warning `raya-checkout-missing`，无锁、无 receipt）。
2. 锁（§3.2）。
3. 身份门（§3.3）。
4. **围栏 #1**：`symbolic-ref --short HEAD == main`（否则 `wrong_branch`，severe）；`status --porcelain --untracked-files=no` 为空（否则 `dirty`，warning）；`checkout_before=$(rev-parse HEAD)` 40-hex；`remote get-url origin` ∈ 允许集合（否则 `remote_mismatch`，severe）。
5. **fetch**（bounded 20s ×3，只拉 `+refs/heads/main:refs/remotes/origin/main`）失败 → `fetch_failed`（warning），rc 2。
6. `target=$(rev-parse origin/main)` 40-hex。**围栏 #2**：branch/clean/`HEAD == checkout_before` 重验 → 否则 `mutated`（severe）。
7. **known-good 锚（算法照 `update-flywheel.sh:340-354`）**：`ledger=$(cat deployed-sha)`。缺文件 → `missing`；非 40-hex **或** `cat-file -e ledger^{commit}` 非零（本机实测不存在对象返回 128，不是 1）→ `invalid`；对象存在后 `merge-base --is-ancestor ledger target`：rc 0 → `ok`（`rollback_sha=ledger`）、rc 1 → `not_ancestor`、其他 rc → `probe_error` → `ledger_probe_error`（severe，停手）。`missing|invalid|not_ancestor` 都是 bootstrap（`rollback_sha=""`）。
8. **只读分类**（不 merge）：`HEAD==target` → `already-at`；`is-ancestor HEAD target` → `behind`（只记分类）；否则 `diverged`（severe，停手）。本步没有任何写操作；唯一的 ff 写点是第 13 步。
9. **current 出口**：already-at 且 `rollback_sha == HEAD` → `raya_finish current "ledger==head" 0`（receipt 刷新 `checked_at`，`deployed_sha` 保持为该 sha）。此前**没有任何写操作**。
10. **会话宽限（Lead 裁定；在任何 checkout 写之前）**：`raya_session_active` ⇔ `$RAYA_STATE_DIR/voice-mode.requested` 存在 **或** `meeting.json` 存在且 `jq -e '.status | IN("starting","live","interrupted")'` 为真（`scheduled` 不算在开会：Raya 在会议仅排期时就写该文件，`meeting.ts:270-282`；坏 JSON/无 status → `session_state_unreadable`，warning，本轮拒绝、下一班再试） **或** voice job `state = running`。active → 每 30s 重查，最多 `RAYA_SESSION_GRACE_SECONDS=600`；任一次 inactive 即继续；到点仍 active → 继续（receipt `session_grace=exhausted:600`——这只记「等满了」这个事实，是否真的打断由第 16 步的 `session_at_cutover` 决定）。宽限期间 checkout 仍是旧字节，brain 若崩溃 KeepAlive 拉起的也是旧字节。
11. **代际基线（第一次写之前）**：`gen_before[brain|voice] = {pid, start}`（`launchctl print` + `raya_process_start`；明确 `state != running` → null）。running 但 `start` 读不到 → `observe_failed`（两个空 start 绝不能被当成「未变」）。
12. **围栏 #2b**：宽限后重验 branch/clean/`HEAD == checkout_before`。
13. **ff（唯一的 checkout 写点）**：分类为 `behind` → `merge --ff-only target --quiet`（失败 → `mutated`）；`already-at` 但 ledger 不符 → 不 merge。`new_head=$(rev-parse HEAD)`（必须等于 `target`）。
14. **build**：install → build → preflight（`RAYA_NODE_BIN`、`RAYA_ENV_FILE`、120s bounded，非 0 即失败）。失败 → §3.6 路径 A。
15. **围栏 #3**：`raya_assert_checkout <expected>`（可复用断言：branch==main、clean、`HEAD == <expected>`）以 `new_head` 断言 → 失败 → 路径 A（reason `mutated`）。**同一断言在此后每次 kickstart 紧前、每次成功账本（receipt+sha）写入紧前都重跑**：正常路径期望 `new_head`，回滚路径期望 `rollback_sha`。`raya_assert_checkout` 失败的**唯一转移表**（R5）：

| 断言位置 | 期望 | 失败去向 | 账本 |
|---|---|---|---|
| 围栏 #3（第 15 步，未 kickstart） | `new_head` | 路径 A（reason `mutated`） | 按路径 A 终态写 |
| 正常路径 brain/voice kickstart 紧前（第 17/18 步） | `new_head` | 第 17 步前失败 → 路径 A；第 18 步前失败（brain 已 kick）→ 路径 B | 按回滚终态写 |
| 正常路径成功账本写入前（第 19 步） | `new_head` | **直接终态 `rollback_blocked_mutation`**（不进路径 B：紧接着的 #R1 会撞同一 mutation 或在瞬时故障消失后错误 reset；两者都不等价于停手） | 不写成功账本、`deployed-sha` 不推进；**写 failure receipt**（§3.7 outcome=failed） |
| 回滚路径 #R2（rebuild 后、每次回滚 kickstart 前、`rolled_back` 账本前） | `rollback_sha` | 终态 `rollback_blocked_mutation` | 同上：不写成功账本，写 failure receipt |

「不写账本」在本文任何地方都只指「不写成功 receipt / 不推进 `deployed-sha`」；failure receipt（outcome=failed/refused）按 §3.7 照写（持锁前提下）。
16. **cutover 采样（紧邻 kickstart）**：重跑身份门（含观测一致性）；`brain_pid_before`、`voice_pid_before`、`voice_running_at_cutover` 取自**此刻**的 `launchctl print`。`session_active` 此刻再算一次：`active` → `raya_notify_interruption`（§3.8；只在所有围栏与身份重验通过后、第一次 kickstart 紧前发）并记 `session_at_cutover=active`；`inactive` → 记 `inactive`；**不可读**（build 期间 `meeting.json` 变坏）→ `session_at_cutover=unreadable`，不通知、不 kickstart，走路径 A（reason `session_state_unreadable`；checkout 已写，所以是回滚而不是拒绝）。
17. **brain 替换**：`raya_assert_checkout new_head` → `raya_kickstart brain`（rc≠0 → 路径 B）。验证（2s × 30）：`state = running`、numeric pid、`brain.pid` 文件 == pid、`pid != brain_pid_before`、且**相邻两次采样 pid 相同**。**冷启动豁免只在 cutover 采样明确 `state != running` 时成立**（豁免 `pid != before` 一项）。超时 → 路径 B。
18. **voice 替换（规则：cutover 时在跑就换）**：`voice_running_at_cutover=yes` → `raya_assert_checkout new_head` → 重验身份 → `raya_kickstart voice`（rc≠0 → 路径 B）→ 验证（2s × 30）：`state = running`、numeric pid、`pid != voice_pid_before`、`$RAYA_HOME/data/metrics/run/voice.pid == pid`、相邻两次采样 pid 相同（voice 先写 pidfile 后装配 runtime，`apps/voice/src/cli.ts:380-402`，单次命中可能是即将退出的进程）。超时 → 路径 B。`voice_running_at_cutover=no` → receipt `voice=untouched:not_running`。**不再做 delta 判定**：部署即新字节，正在跑的 voice 一律换；不在跑的由 brain 下次按需拉起新 dist。
19. `raya_assert_checkout new_head` → `raya_finish deployed "<old8>→<new8>" 0`（§3.7）；断言失败 → 直接 `raya_finish rollback_blocked_mutation "ledger-fence:<detail>" 3`（不进路径 B；见第 15 步转移表）。

### 3.5 Trigger 门（Raya 只在定时唤醒时运行，与 flywheel 周期结果无关）

两个独立变量：
- `UPDATER_WAKE_KIND ∈ {scheduled, urgent}`：`updater_run_cycle` 在 `updater_snapshot_tokens` 之后立刻判定——snapshot 为空 → `scheduled`；有任何文件（合法与否）→ `urgent`。
- `UPDATER_CYCLE_RESULT ∈ {claim_dir_failed, invalid, indeterminate, fetch_failed, urgent_deployed, urgent_failed, scheduled_current, scheduled_deployed, scheduled_failed}`：各 return 点前设置，仅供日志/测试。

`update_main` 只看 `UPDATER_WAKE_KIND == scheduled` 决定是否调用 `updater_raya_pass`。这样 00:00/12:00 唤醒时 flywheel 自己的 fetch 失败（`update-flywheel.sh:434-465` 提前返回）**不会**让 Raya 跳过——Raya 段有自己独立的 fetch；而带 token 的唤醒（含验证 fetch 失败）一律不跑 Raya。测试：空 queue + flywheel fetch 失败 → Raya 恰一次；空 queue + scheduled current/deployed/failed → 各恰一次；有 token（合法/非法/不确定/claim 失败/验证 fetch 失败/urgent 部署成功或失败）→ Raya 零次。

### 3.6 回滚（只回到 `rollback_sha`，reset 前必须再围栏）

**回滚围栏 #R1**（任何 `reset --hard` 前）：`symbolic-ref == main`、`status --porcelain --untracked-files=no` 为空、`HEAD == new_head`。不满足 → `rollback_blocked_mutation`（severe `raya-rollback-blocked-mutation`，正文：检测到并发修改，未 reset、未重建，需人工），rc 3。这样围栏 #3 发现的 tracked 修改不会被回滚删掉（R2 反例）。

**回滚围栏 #R2**（`raya_assert_checkout rollback_sha`）：reset + install/build **之后**跑一次，此后**每次** brain/voice kickstart 紧前、以及 `rolled_back` 账本写入紧前各再跑一次（brain 验证 60s + voice 验证 60s 都是可被 operator 改 HEAD 的窗口）。任一次不满足 → `rollback_blocked_mutation`，不 kickstart、不写成功账本、写 failure receipt（第 15 步转移表；R3/R4/R5）。

**代际证明**（路径 A 终态前；逐 label 判定，结果写进 `generation.{brain,voice}`）：
- 读取当前 `{pid, start}`；running 但 start 不可读 → `observe_failed`（不得把空值当「未变」）。
- **brain**：baseline 非空且当前 tuple 相同 → `unchanged`；其他任何情况（tuple 变了、当前 not running、baseline 为 null 但现在 running）→ brain 的运行代际不可证明 → 在 restored bytes 上重验身份 → `raya_assert_checkout rollback_sha` → `kickstart -k brain` → 第 17 步验证 → `replaced`；失败 → `raya-brain-down-after-rollback`。
- **voice**：当前 running 且 tuple 与 baseline 相同 → `unchanged`；当前 running 且 tuple 变了 → 同 brain 流程受管替换 → `replaced`；当前 **not running**：若 `voice-mode.requested` 已不存在（用户在 build 期间正常停掉）→ `stopped_by_user`，**不拉起**；若 `voice-mode.requested` 仍存在（仍 desired 却 down）→ 从 restored bytes 拉起并验证 → `recovered`，失败 → `raya-voice-down-after-rollback`。
- 判定顺序固定 brain → voice；任一 label 失败立即终止（`failure=brain_replace_failed|voice_replace_failed|voice_recover_failed|generation_start_unreadable:<label>`，`generation=null`）。全部 label 判定完毕且无失败 → `rolled_back`，receipt `generation` 写完整对象 `{brain: <值>, voice: <值>}`。

| 触发 | 锚 | 动作 | 终态 / class |
|---|---|---|---|
| 路径 A（未 kickstart：build/preflight/围栏 #3/cutover 状态不可读） | 有 | 围栏 #R1 → `reset --hard $rollback_sha` → install+build → 围栏 #R2 → 逐 label 代际证明；代际未变则**不 kickstart** → 账本写入前再断言 | `rolled_back` / severe `raya-deploy-rolled-back` |
| 路径 A | 无 | 不 reset、不重建、不 kickstart | `failed` / severe `raya-deploy-failed-no-known-good` |
| 路径 B（brain kickstart/验证失败，或 voice kickstart/验证失败） | 有 | 围栏 #R1 → reset → install+build → 围栏 #R2 → 重验身份 → `kickstart -k brain` → 验证；若本轮已 kickstart 过 voice **或** `voice_running_at_cutover=yes` → `kickstart -k voice` → 验证 | 全部通过 `rolled_back` / severe `raya-deploy-rolled-back`；brain 不通过 `failed` / severe `raya-brain-down-after-rollback`；voice 不通过 `failed` / severe `raya-voice-down-after-rollback` |
| 路径 B | 无 | 不 reset；重验身份 → 再 `kickstart -k brain` → 验证；若本轮碰过 voice 或 cutover 时在跑 → 再 `kickstart -k voice` → 验证 | 通过 `failed` / severe `raya-deploy-failed-no-known-good`（进程在跑但版本未经验证）；不通过按 brain/voice 分别 `raya-brain-down-after-rollback` / `raya-voice-down-after-rollback` |
| 回滚重建失败 | — | 停手 | `failed` / severe `raya-deploy-rollback-failed` |

`reset --hard` 的目标只能是 `$rollback_sha`（负向 grep）。不写 `deployed-sha`。

### 3.7 receipt 与 deployed-sha（单一 schema，逐 state 可判）

顺序：receipt 先、deployed-sha 后；都 `tmp → mv`。只在 `RAYA_LOCK_OWNED=1` 时写。

`~/.flywheel/raya/deploy-receipt.json` schemaVersion 1，键集合固定（`jq -e 'keys == [...]'` 测试）：

| 键 | 类型 | 何时非 null |
|---|---|---|
| `schemaVersion` | 1 | 总是 |
| `checked_at` | epoch 秒 | 总是 |
| `outcome` | `current\|deployed\|rolled_back\|failed\|refused` | 总是。映射：`current`→current；`deployed`→deployed；`rolled_back`→rolled_back；`failed`、`rollback_blocked_mutation`→failed；`identity_drift`、`observe_failed`、`wrong_branch`、`dirty`、`remote_mismatch`、`fetch_failed`、`mutated`（写前）、`diverged`、`ledger_probe_error`、`session_state_unreadable`（写前）→refused；`missing`/`locked` 不写 receipt |
| `state` | §3.1 枚举 | 总是 |
| `failure` | token 字符串 | outcome ≠ current/deployed 时；否则 null |
| `checkout_before` | 40-hex | 围栏 #1 之后；否则 null |
| `head` | 40-hex | 总是（能 rev-parse 时） |
| `origin_main` | 40-hex | fetch 成功后；否则 null |
| `ledger` | `ok\|missing\|invalid\|not_ancestor\|probe_error` | 第 7 步后；否则 null |
| `rollback_sha` | 40-hex | `ledger=ok`；否则 null |
| `deployed_sha` | 40-hex | **真实运行锚**：`deployed`→`new_head`；`current`→`head`（即上次的锚，不清空——Done/Lead 引用它）；`rolled_back`→`rollback_sha`；`failed`/`refused`→上一份 receipt 的值原样保留（若无则 null）。与 `deployed-sha` 文件的关系：文件只在 `deployed` 时写 |
| `identity` | `ok\|drift:<label>` | 身份门后 |
| `session_grace` | `none\|waited:<秒>\|exhausted:600` | 第 10 步后；否则 null（只记等待事实） |
| `session_at_cutover` | `active\|inactive\|unreadable` | 第 16 步后；否则 null（`active` = 真的打断了） |
| `generation` | `{brain: unchanged\|replaced, voice: unchanged\|replaced\|stopped_by_user\|recovered}` | **仅**路径 A 成功 `rolled_back` 时写完整对象；路径 A 内任何 failed / observe_failed / rollback_blocked_mutation 终态一律 null（失败原因在 `failure` token，如 `brain_replace_failed`、`voice_recover_failed`、`generation_start_unreadable:<label>`）；其他路径 null |
| `gen_before` | `{brain:{pid,start}\|null, voice:{pid,start}\|null}` | 第 11 步后；否则 null |
| `interrupt_notice` | `sent\|failed\|skipped` | 第 16 步后；否则 null |
| `brain_pid` | `{before, after}` 数字或 null | cutover 后 |
| `voice` | `replaced\|untouched:not_running` | cutover 后；否则 null |
| `voice_pid` | `{before, after}` | 同上 |
| `node_bin` | 路径 | 身份门后 |
| `preflight_rc` | 整数 | preflight 跑过后；否则 null |

写失败：receipt tmp/mv 失败 → severe `raya-ledger-write-failed`，若已切到新代码则 state `failed`、**不写** deployed-sha（下一班车 `ledger != HEAD` 重部署收敛）；deployed-sha tmp/mv 失败 → 同上（receipt outcome=deployed 已落，sha 未推进，巡检 `deploy_drift=yes` 为真实状态）。四个注入测试 + `cmp` + 重跑收敛。

### 3.8 打断通知与告警

- `raya_notify_interruption <new8>`：文案固定「🔄 Flywheel 班车正在重启 Raya（部署 `<new8>`），当前语音/会议会话会中断，抱歉。」；频道 id 只 `grep '^RAYA_DISCORD_TEXT_CHANNEL_ID='` 自 `$RAYA_HOME/raya.env`（不 source）；身份 `CLAUDE_INFRA_BOT_TOKEN`（curl `-K -` stdin，`--max-time 5`）。失败/未配置 → warning `raya-interrupt-notice-failed`，**继续部署**。
- `raya_alert_dispatch <severity> <class> <title> <body>`（放 `update-flywheel.sh`）：kind 由 severity 派生（severe→`deploy_failed`、warning→`deploy_degraded`），`--title` 固定「Raya deploy failed」/「Raya deploy degraded」，`--signature "$(updater_scheduled_signature "$class")"`（**helper 不加前缀**，class 自带 `raya-`，最终形如 `raya-deploy-rolled-back-scheduled-<UTCday>`），severe 且 `FLYWHEEL_FOUNDER_USER_ID` 存在才 `--mention-user`。测试用假 `lead-alert.sh` 记录 exact argv。

### 3.9 测试 `scripts/__tests__/updater-raya-deploy.test.sh`

台架：真 bare remote + clone；seam 全桩；`launchctl print` 桩返回含 `arguments = { node / cli.js / run }` 的真实形状文本；`plutil` 桩返回 JSON 数组。用例（编号稳定）：

1 current；2 behind→deployed（brain 新 pid、brain.pid、两次采样稳定）；3 already-at 且 ledger 缺失（bootstrap 成功）；4 dirty；5 锁六型（§3.2）；6 diverged；7 fetch ×3 失败；8 build 失败 + 锚 → 路径 A，HEAD==rollback_sha，0 次 kickstart；9 build 失败 + 无锚 → `failed/bootstrap-no-known-good`，HEAD 不变；10 `ledger=A checkout=B build@B 失败` → reset 到 A；11 ledger 非法 / 非祖先 / probe error 三态；12 preflight 非 0 → 路径 A（无 warning 模式）；13 brain 验证超时 → 路径 B（二次通过 / 二次失败）；14 回滚重建失败；15 voice：cutover 在跑 → 替换并验 voice.pid + 稳定采样；cutover 不在跑 → untouched；第 3 步在跑但 cutover 不在跑 → untouched（R2 时间窗）；第 3 步不在跑但 cutover 在跑 → 替换；voice 验证超时 → 路径 B 且回滚也重试 voice；无锚 + voice 失败 → `raya-voice-down-after-rollback`；16 冷启动 brain 验证；17 身份门：未加载 / `arguments` 少一项或多一项 / `arguments[1]` 指向 worktree / `program != plist[0]` / working directory 不符 / brain 与 voice program 不同 → `identity_drift`，无 fetch、无 receipt 以外的写、**receipt 在持锁下写**；18 围栏：wrong-branch、detached、remote URL 不符、fetch 期间 HEAD 被动 → `mutated`、build 期间 tracked 文件被改 → 路径 A 触发但**回滚围栏拒绝 reset**，写入的可辨识字节仍在 → `rollback_blocked_mutation`；19 kickstart 前身份重验失败 → 不 kickstart，走路径 B 的「kickstart 失败」分支；20 会话宽限三信号 + 600s 上限 + 通知调用；21 通知：channel 单键 grep、token 不进 argv、失败继续；22 四个账本写失败注入；23 receipt 键集合 + 逐 state nullability；24 负向 grep（`pkill|kill -9|bootout|bootstrap|launchctl load|reset --hard "\$(new_head|target|checkout_before)`）；25 告警 exact argv（含签名无双前缀）；26 pre-lock 出口（missing/locked）不写 receipt；27 会话宽限位置：宽限期间 HEAD 不变、merge 调用数为 0、pnpm 调用数为 0；`meeting.json status=scheduled` → 不等待；`status=live` → 等待；坏 JSON → `session_state_unreadable` 拒绝；28 通知时机：围栏 #3 或身份重验失败时通知**未**发出；cutover 时 active 才发；29 wake kind：空 queue + flywheel fetch 失败 → Raya 恰一次；有 token + 验证 fetch 失败 → 零次；30 known-good：40-hex 但对象不存在 → `invalid`（bootstrap），不是 `ledger_probe_error`；31 围栏 #R2：回滚重建 seam 改 HEAD/写 tracked 字节 → `rollback_blocked_mutation`，不 kickstart；32 代际证明：forward build 期间桩把 brain pid/start 换掉 → 路径 A 走 managed replacement，receipt `generation == {brain:"replaced", voice:"unchanged"}`（对象字段断言）；brain replacement 验证失败 → `failure=brain_replace_failed`、`generation=null`、outcome=failed；voice recovery 验证失败 → `failure=voice_recover_failed`、`generation=null`；33 观测一致性：`state = running` 但 pid 缺失 → `observe_failed`，不 kickstart；voice 同；34 env 路径：`raya.env` 中 `RAYA_STATE_DIR`/`RAYA_METRICS_DIR` 指向别处 → `identity_drift`；35 围栏过期：brain 验证期间桩改 HEAD → voice 不 kickstart、sha 不推进、进入路径 B；最后一次验证后改 tracked 字节 → 不写成功账本、终态 `rollback_blocked_mutation`、**reset/rebuild 计数为 0**、failure receipt 已写；36 代际逐 label：voice 在 build 期间被用户正常停掉（`voice-mode.requested` 消失）→ `stopped_by_user` 不拉起；voice down 但仍 desired → `recovered`；brain 与 voice 同时换代 → `generation={brain:replaced,voice:replaced}`；running 但 start 不可读 → `observe_failed`；37 receipt：`current` 保留上次 `deployed_sha`；`exhausted:600` 与 `session_at_cutover=inactive` 可同时出现且不通知；cutover 状态不可读 → 路径 A、不通知、不 kickstart。

## 4. Chunk B — `scripts/update-flywheel.sh`

### 4.1 路径 pin
source 区后加 `source "${SCRIPT_DIR}/lib/updater-raya-deploy.sh"`；`updater_configure_runtime_paths` 之后紧接 `raya_configure_runtime_paths`（从 `FLYWHEEL_HOME` 派生 `RAYA_HOME`、`RAYA_CODE_DIR`、`RAYA_STATE_DIR=$RAYA_HOME/data/state`、`RAYA_DEPLOYED_SHA_FILE`、`RAYA_DEPLOY_RECEIPT`、`RAYA_DEPLOY_LOCK_DIR`、`RAYA_BRAIN_PID_FILE`、`RAYA_VOICE_PID_FILE`、`RAYA_PLIST_DIR=$HOME/Library/LaunchAgents`）；生产拒绝 env 偏转，sourced 台架允许。`update-flywheel-sources.test.sh:57-64` 的重 pin 断言扩展到 Raya 路径。

### 4.2 Wake kind + 调用点
`updater_run_cycle` 开头 reset 两个变量为 `unknown`；`updater_snapshot_tokens` 之后立刻 `UPDATER_WAKE_KIND=scheduled|urgent`（snapshot 为空 → scheduled）；各 return 点前设 `UPDATER_CYCLE_RESULT`（§3.5，只记录）。`update_main`：

```bash
updater_run_launchd_then_cycle
rc=$?
log "updater cycle: wake=${UPDATER_WAKE_KIND:-unknown} result=${UPDATER_CYCLE_RESULT:-unknown}"
case "${UPDATER_WAKE_KIND:-unknown}" in
  scheduled) updater_raya_pass || true ;;   # FLY-2385: scheduled wake only; independent of the flywheel cycle result; never changes rc
  urgent)    log "raya shuttle: skipped wake=urgent" ;;
  *)         log "raya shuttle: skipped wake=unknown (fail closed)" ;;
esac
log "raya shuttle: ${RAYA_DEPLOY_STATE:-not_run} ${RAYA_DEPLOY_DETAIL:-}"
updater_cleanup
```

### 4.3 `updater_cleanup`
末尾（`updater_lock_release` 前）加 `raya_lock_release || true`。

### 4.4 测试与 CI
`update-flywheel-sources.test.sh` 追加（通过真实 `update_main` 接线，不只测 helper）：有 token 的唤醒（合法/非法/不确定/claim 失败/验证 fetch 失败/urgent 部署成功或失败）→ Raya 零调用；空 queue 的唤醒（flywheel fetch 失败 / current / deployed / failed）→ Raya 恰一次且在 cycle 之后；`UPDATER_WAKE_KIND` 未设（unknown）→ 零调用；rc 不变；INT 释放 Raya 锁且 urgent 逻辑不变；路径重 pin。CI `.github/workflows/ci.yml:966-975` 加新测试。`check-global-path-hygiene`、`launchd-units-manifest`、`updater-trigger-policy` 仍绿。

## 5. Chunk C — 巡检 STEP 5

### 5.1 事实行（仅 `PROJECT_NAME=flywheel`）

```
raya checkout=<path> head=<sha8> origin_main=<sha8|none> branch=<main|other|detached> behind=<N|unknown> deployed_sha=<sha8|missing|invalid|not_ancestor> receipt_age_h=<n|missing|malformed> drift_age_h=<n|-> checkout_drift=<no|behind|diverged> deploy_drift=<yes|no> shuttle_stale=<yes|no> overdue=<yes|no>
```

- 结构性缺失 → `raya checkout=UNAVAILABLE(structural: raya_checkout_missing|raya_git_unreadable)`。
- `checkout_drift`：behind>0 → `behind`；local-ahead/diverged → `diverged`；否则 `no`。
- `deployed_sha` 状态：缺失 → `missing`；非 40-hex 或对象不存在 → `invalid`；不是 HEAD 祖先（`merge-base --is-ancestor deployed HEAD` rc 1）→ `not_ancestor`；否则 sha8。`deploy_drift=yes` ⇔ 非 ok 或 `!= head`。
- `shuttle_stale=yes` ⇔ receipt 缺失/坏 JSON/`checked_at` 非数或在未来 或 `now - checked_at > 13*3600`。
- `drift_age`（raw 秒）：`checkout_drift=behind` → `HEAD..origin/main` 最老 commit `%ct`；`deploy_drift=yes` 且 `deployed_sha` 为 ok-祖先 → **`deployed_sha..HEAD` 最老 commit** `%ct`（不是 HEAD 自身，R2 反例：旧未部署 commit + 新 tip）；两者都有取更老者。
- `overdue=yes` ⇔ `shuttle_stale=yes` 或 `checkout_drift=diverged` 或 `origin_main=none` 或 `branch≠main` 或 `deployed_sha ∈ {missing, invalid, not_ancestor}` 或 （`checkout_drift=behind` 或 `deploy_drift=yes`）且 `drift_age > 13*3600`。
- 常量 `RAYA_SHUTTLE_STALE_SECONDS=$((13*3600))` 单点；`PATROL_NOW_EPOCH`；`GIT_OPTIONAL_LOCKS=0`；只读。

### 5.2 规则（`runner-patrol-rules.md` 第 5 步末尾）

> **Raya 生产 checkout（仅 flywheel 项目）**。
> - `overdue=yes`：本 tick 在 `CHAT_CHANNEL_ID` 发 warning（原事实行 + `FLY-2385`）；第 5 步定稿 `STEP 5: FINDING` 并写
>   `FINDING step=5 bridge_problem=no result=advanced evidence=raya_checkout_overdue.<head8>.<origin8|none> owner=n/a next=n/a epic=n/a epic_marker=n/a`；
>   发送失败 → `FINDING step=5 bridge_problem=no result=escalated-with-plan evidence=raya_checkout_overdue.<head8>.<origin8|none> owner=agent:flywheel-eng-lead next=retry:raya-overdue-warning epic=n/a epic_marker=n/a`。连续两个 tick → 第 6 步建单（token `raya_checkout_overdue`）。同一 evidence 同一 UTC 日只发一次 Discord，重复 tick 只写 FINDING 行。
> - `raya checkout=UNAVAILABLE(structural: <token>)`：写 `UNAVAILABLE_CAUSE step=5 class=structural token=<token>`；第 5 步无其他 UNAVAILABLE 时定稿 `STEP 5: UNAVAILABLE(structural: <token>)`；gh 也不可用时 STEP 5 沿用 gh token，Raya 的以 `UNAVAILABLE_CAUSE` 行记账并建单。
> - `overdue=no`：正常态，不发话。

（两条 FINDING 样例已用当前 FLY-2080 validator 校验：含 `epic=n/a epic_marker=n/a` 返回 0。）

### 5.3 测试
`lead-patrol-snapshot.test.sh`：默认；退一 commit + receipt 新 → `overdue=no`；退一 commit + receipt 缺失 → `overdue=yes`；receipt `13h±1s`；`behind=0` + stale；head current + deployed 旧且 `deployed..HEAD` 最老 commit 老于 13h 而 tip 只有 1h → `overdue=yes`（R2 反例）；deployed 非祖先 / invalid / missing → 各自 token + `overdue=yes`；diverged；origin ref 缺失；detached / 非 main；坏 JSON / 未来时间；目录缺失；非 flywheel 项目无此行；gh 三案例不变。
规则反漂移：`lead-rules-bundle.test.ts` 家族加断言（模板句 + evidence 前缀 + `epic=n/a epic_marker=n/a`），并把 §5.2 两条 FINDING 样例喂给 FLY-2080 awk 断言 rc 0。

## 6. Chunk D — Done 判据
按 research.md §3 的表落文本；模板测试 `toContain("合入 ≠ 上线")`。R1 小节写：人工回滚锚 = `deployed-sha`；Raya launchd 身份漂移的修复入口 = Raya 仓 `install-launchd`（founder 授权）；**没有**人工 Raya 部署脚本，追上只靠定时班车。

## 7. 稳定标识 / 显示标签 / 迁移 / 负向守卫

| 类别 | 值 |
|---|---|
| 稳定标识 | label 两个；`deployed-sha`、`deploy-receipt.json`（v1，§3.7 键集合）、`deploy.lock.d`（pid/start/created）；alert class `raya-*`，签名 `<class>-scheduled-<UTCday>`；`UPDATER_WAKE_KIND` / `UPDATER_CYCLE_RESULT` 枚举；STEP 5 前缀 `raya checkout=`；evidence `raya_checkout_overdue.<head8>.<origin8>` |
| 显示标签 | 日志 `[flywheel-updater] raya: …`；标题「Raya deploy failed」/「Raya deploy degraded」；#raya 打断文案固定 |
| 迁移 | 首次 = bootstrap，无锚不回滚不假报；receipt/deployed-sha 由第一次定时班车创建；C 在其后合入 |
| 回滚边界 | 代码 revert；运行级 §3.6（reset 前再围栏）；人工级 R1（锚 = deployed-sha） |
| 负向守卫 | 用例 4/5/6/9/10/11/17/18/19/22/24/26；trigger 门五种唤醒零 mutation；`resident-codex-lead-*` 反向断言不变；plist/manifest 字节不变 |
| 单一事实源 | 本文 §3.7 schema；13h 常量；身份期望向量单点；receipt 与 sha 同一 `raya_finish` |

## 8. QA 判据（qa 节点）——**本期无生产 mutation**

1. hermetic：§3.9 全部用例、`update-flywheel-sources`、`lead-patrol-snapshot`、`updater-trigger-policy`、`launchd-units-manifest`、`check-global-path-hygiene` 全绿；edge-worker 模板测试与 `lead-rules-bundle` 家族绿；CI 在 exact head 绿。
2. 生产只读：`launchctl print` 两 label 身份向量；`git -C ~/.flywheel/raya/code` branch/clean/HEAD/remote URL；`flywheel-patrol-snapshot --project flywheel --lead flywheel-eng-lead` 第 5 段出现 `raya checkout=` 行且字段可解析。
3. **定时班车后核对**（issue 验收第一条）：B 合入并部署后的第一班 00:00/12:00，`/tmp/flywheel-updater.log` 出现 `raya:` 行；`deployed-sha == git rev-parse origin/main`；receipt `jq -e` 通过、`outcome ∈ {deployed,current}`；brain pid 换代（对照班车前记录）。
4. **「退一个 commit」验收**以 hermetic 用例（§5.3）+ 生产只读快照证明，不在生产执行 `reset`；若 founder 坚持生产演练，由 Lead 另开带 fresh 授权与精确 sha 的演练单，本 issue 不含。

## 9. 不做
exploration.md §4 全部；不并入 restart-services 播报；不建 `project-deployed-sha` 条目；不做 voice delta 判定（在跑即换）；不在 urgent 唤醒时部署 Raya。

## 10. 没有人工入口（R2 收紧）
Chunk E 与任何「QA 手工调用 `updater_raya_pass`」都不存在于本期：它们都是不受 production pin 与 exact-target 约束的第二条生产部署入口。今天那种手工追上，以后靠定时班车（最多 12h）；真要 break-glass 另开设计（固定生产路径、与 updater 协调的锁、显式 `expected_raya_sha` 且 fetch 后精确相等、完整信号清理、fresh 授权 receipt）。
