# FLY-2385 Raya 仓纳入班车部署 + 「合入≠上线」防线 — 调研
Issue: FLY-2385 (https://linear.app/geoforge3d/issue/FLY-2385/raya运维-raya-仓纳入班车部署-合入上线防线生产-checkout-落后-originmain-244-commits)
日期: 2026-09-06
基于: exploration.md

本文只做两件事：（1）给 plan.md 的每个决定提供**代码锚点**（本分支基于 main `8126576cf`，Raya 仓以 `~/.flywheel/raya/code` 当前 `b1b5a64` 为准）；（2）记录 Codex 设计评审各轮的修订。**实施规范只在 plan.md**；本文不含任何可执行伪代码。

## 1. 班车入口 `scripts/update-flywheel.sh` 的锚点

| 锚点 | 内容 | plan.md 用处 |
|---|---|---|
| `:8` `set -uo pipefail`（无 -e） | 返回码由调用方显式处理 | §3.1 库不依赖 -e |
| `:30-41 updater_configure_runtime_paths` | 生产钉死 `HOME`/`FLYWHEEL_HOME`；仅 `UPDATE_FLYWHEEL_SOURCED=1` 允许覆盖 | §4.1 `raya_configure_runtime_paths` 紧随其后 |
| `:72-93 severe_alert / updater_scheduled_signature` | `lead-alert.sh --project flywheel --lead updater`；签名 `<class>-scheduled-<UTCday>` | §3.8 `raya_alert_dispatch` 复用签名函数，class 自带 `raya-` 前缀 |
| `:158-167 updater_git_bounded` | `bounded-run.sh` 包一层 git | §3.4 第 5 步 fetch 同款、`-C` 指 Raya |
| `:275-320 updater_lock_*` | mkdir 锁、pid 文件、stale 判定 | §3.2 Raya 锁复制骨架，但身份改用 `ps -o lstart=`（生产 argv 是 `/bin/bash …/update-flywheel.sh`，不能靠命令行子串） |
| `:323-354 updater_token_shape_valid / updater_token_target_state` | urgent token 只含 flywheel `targetSha`；object + ancestry 三态（valid/invalid/indeterminate） | §1.7 urgent 不授权 Raya；§3.4 第 7 步 known-good 三态判定同款 |
| `:416-465` `updater_run_cycle` token 分支各 return | invalid / claim-failed / indeterminate 出口 | §3.5 每个出口设 `UPDATER_CYCLE_RESULT`（仅日志）；`UPDATER_WAKE_KIND` 在 snapshot 后立刻判定 |
| `:467-525` valid urgent → `SELF_SHIP_DEPLOY_CMD` | urgent 部署成功/失败出口 | §3.5 `UPDATER_WAKE_KIND=urgent`（Raya 不跑） |
| `:527-540` scheduled 分支 | `deployed-sha` vs `origin/main`，一次部署 | §3.5 `UPDATER_WAKE_KIND=scheduled`（Raya 一律跑，与 flywheel fetch/deploy 结果无关） |
| `:551-554 updater_run_launchd_then_cycle`、`:556-607 update_main` | cycle 之后 `updater_cleanup`；EXIT/INT/TERM trap 由 `update_main` 保存/接管 | §4.2 调用点在 cycle 之后、cleanup 之前；§4.3 `updater_cleanup` 末尾追加 `raya_lock_release`；库不设 trap |
| `scripts/launchd/units.manifest:7` | updater allowed_exit_codes `0,1,2,3,127,130` | §4.2 Raya 不改 rc |
| `scripts/launchd/com.flywheel.updater.plist:7-11` | 生产 argv `/bin/bash /Users/xiaorongli/Dev/flywheel/scripts/update-flywheel.sh` | §3.2 锁身份不能用命令行子串 |
| `scripts/lib/bounded-run.sh` | `<timeout> <cmd…>`，124 = 超时 | fetch / preflight 都走它 |

## 2. 全舰重启脚本 `scripts/restart-services.sh` 里可借的纪律（不改此文件）

| 锚点 | 内容 | 借来做什么 |
|---|---|---|
| `:939-972, 1026-1084` preflight 在 fetch 前后都验 branch/dirty/ref | 单写者围栏 | §3.4 三道围栏 |
| `:1106-1172` `rev-list --count` + `already-at/behind/local-ahead/diverged` 分类 | 分类词汇 | §3.4 第 8 步 |
| `:2830-2873` `rollback_and_restart`：无 known-good 拒绝自动回滚；reset 前重读 `git status`，脏/不可读即拒绝 | 回滚安全 | §3.6 回滚围栏 + 无锚不回滚 |
| `:2935-2956` `ensure_voice_bridge_for_deploy` + `scripts/lib/restart-voice-bridge.sh:177-221` | seam 式受管替换：老 pid+start 树消失、新 pid 健康、失败不推进 sha | §3.4 第 17/18 步验证、§3.9 台架形状 |
| `:757-786 notify_routine` | curl `-K -` stdin 传 token 的 Discord POST | §3.8 打断通知 |
| `:3203-3208` deployed-sha 只在服务健康后推进 | 账本纪律 | §3.7 |

## 3. Raya 仓（`~/.flywheel/raya/code`）与生产事实

| 锚点 | 事实 | plan.md 用处 |
|---|---|---|
| `apps/brain/src/launchd.ts:30-33` | `ProgramArguments = [nodeBin, entrypoint, ...args]`；`run` 是第三项 | §3.3 身份门期望向量恰好 3 项 |
| `launchctl print gui/501/com.xrli.raya.{brain,voice}`（2026-09-06 复核） | `program = /opt/homebrew/Cellar/node/25.6.1/bin/node`；`arguments = {node, code/apps/<app>/dist/cli.js, run}`；working directory `code/`；`RAYA_ENV_FILE=~/.flywheel/raya/raya.env`；brain running pid 19544，voice not running（Lead 已重载，R1 发现的 worktree 漂移已消失） | §1.6、§3.3 |
| `~/Library/LaunchAgents/com.xrli.raya.*.plist`（`plutil -extract ProgramArguments json`） | 与 loaded job 一致 | §3.3 `program == plist[0]` |
| `apps/brain/src/cli.ts:85-110` | `raya preflight`：探 Codex + Discord REST，`ready` 退 0，否则 75 | §1.3 preflight 定义 |
| `apps/brain/src/runtime.ts:312-316` | brain 启动 `claimPidFile(metricsDir/run/brain.pid)` | §3.4 第 17 步 |
| `apps/voice/src/cli.ts:380-402` | voice 先 `claimPidFile(run/voice.pid)` 再装配 runtime | §3.4 第 18 步：稳定采样两次 |
| `apps/brain/src/voice-mode.ts:404-515` | brain 用 `launchctl kickstart -p` / `kill` 管 voice | voice 由 brain 按需拉起；班车只换正在跑的 |
| `packages/contracts/src/integration-contract.ts:18-21` `RAYA_STATE_PATHS` | `voice-mode.requested`、`meeting.json` 在 `RAYA_STATE_DIR` | §3.4 第 10 步会话宽限三信号（meeting 只认 `starting\|live\|interrupted`，`packages/contracts/src/meeting.ts:180-184`） |
| `raya.env`（0600，含 secret） | `RAYA_DISCORD_TEXT_CHANNEL_ID` 等键 | §3.8 只 grep 单键、不 source |
| `package.json` / `pnpm-workspace.yaml` | pnpm workspace；`onlyBuiltDependencies: onnxruntime-node`（native postinstall） | install 失败与 build 失败同等处理 |
| `git remote -v` | `https://github.com/xrliAnnie/raya.git` | §3.4 第 4 步 remote 白名单 |
| `~/.flywheel/raya/` | 无 `deployed-sha`、无 receipt | 首次班车 = bootstrap |

## 4. 巡检 `scripts/lead-patrol-snapshot.sh` 与规则

| 锚点 | 内容 | plan.md 用处 |
|---|---|---|
| `:3-4` | 快照从不写 StateStore/CommDB/GitHub/Discord/Linear | §5.1 只读本地 git，不 fetch |
| `:33-47, :108, :159-181` | `PROJECT_NAME`、`STATE_DIR`、`PROJECT_REPO` | §5.1 仅 flywheel 项目；Raya 路径从 `STATE_DIR/raya` 派生 |
| `:981-1019` | STEP 5 现有 gh 块 | Raya 事实行追加在其后、独立于 gh 成败 |
| `:1538-1569` | 报告渲染 | `## STEP 5` 段原样输出 |
| `packages/teamlead/lead-rules-base/runner-patrol-rules.md:49-59, :157-170, :394-470` | 产出物合同、第 5 步原文、FLY-2080 finding validator（`FINDING` 行对 `bridge_problem=no` 要求 `epic=n/a epic_marker=n/a`） | §5.2 两条 FINDING 样例已用 validator 验证 rc 0 |
| `scripts/__tests__/lead-patrol-snapshot.test.sh:61-133` | `make_case` / `run_snapshot`（`FLYWHEEL_STATE_DIR=$dir/state`） | §5.3 台架在 `state/raya/code` 建假仓 |
| `packages/teamlead/src/__tests__/lead-rules-bundle.test.ts` 等 | 规则文件反漂移测试家族 | §5.3 规则测试 |
| `~/.flywheel/bin/flywheel-patrol-snapshot` → 仓内脚本符号链接 | 随 flywheel 班车部署 | 无额外安装 |

## 5. Done 判据落点

| 文件 | 改动 |
|---|---|
| `packages/edge-worker/src/skill-templates/linear-issue-context.ts:22-31` | DoD 第 7 条：「若本 issue 改动的是独立生产仓（如 `xrliAnnie/raya`）：**合入 ≠ 上线**。Done 还要求生产 checkout 已到该 sha、`com.xrli.raya.brain` 已重启、`raya preflight` ready；证据为 `~/.flywheel/raya/deploy-receipt.json`（定时班车）。」 |
| `packages/teamlead/lead-rules-base/founder-only-authority.md` R1 段（`:72` 之后、`:94` 豁免之前） | 小节「Raya 仓：merge 不等于 deploy」：由 `com.flywheel.updater` 定时段上线；Lead 报「已上线」前必须引用 receipt 的 `deployed_sha`；人工回滚锚 = `deployed-sha`；launchd 身份漂移修复入口 = Raya 仓 `install-launchd`（founder 授权）；没有人工部署脚本 |
| `packages/teamlead/lead-rules-base/summary-inflow.md` `:19-23` 附近 | 一句：「Raya 仓的**代码** PR 合入不等于上线；上线由定时班车完成并写 receipt，Done 判据见 founder-only-authority.md R1。」 |
| `packages/edge-worker/src/prompts/subroutines/verifications.md` | 仅在确认存在 DoD 镜像时同步 |

## 6. 守卫与运维事实

- FLY-913 `scripts/hooks/flywheel-restart-guard.py:93-99`：P1 只拦 `launchctl <mutating>` 与 `com.flywheel.` 或 `restart-services|update-flywheel` 同句；实施/QA 写含这些词的文件用 Write 工具（记忆库 `reference_fly913_guard_blocks_bash_by_text_not_by_action`）。
- `launchctl list`：两个 `*.fly2031.qa` 残留 job 仍 loaded（FLY-2259 明确不清），本设计不碰。
- brain/voice plist 硬编码 `/opt/homebrew/Cellar/node/25.6.1/bin/node`：brew 升级 node 会让两张 plist 失效；身份门会报 `identity_drift`（program 不存在），属正确行为，修复归 Raya 仓。

## 7. 未决/已决

| 问题 | 状态 |
|---|---|
| 活跃语音会话是否顺延 | **已决**（Lead `189b4924`）：不顺延，最多等 10 分钟，然后重启并在 #raya 致歉 |
| preflight fail-closed | **已决**（同上）：fail-closed，不降 warning |
| voice job 身份漂移 | **已修**（Lead，report `b646bac7`）；身份门长期保留 |
| receipt 放 `~/.flywheel/raya/` | 已决 |
| brain 验证用 `brain.pid` | 已决；voice 用 `voice.pid` + 稳定采样 |
| urgent 唤醒是否部署 Raya | 已决：否（R2） |
| 生产 mutation QA | 已决：本期无（R2） |

## 8. 修订记录

### R1（2026-09-06，Codex round 1）

| # | 反馈 | 处置 |
|---|---|---|
| 1 | 已加载 launchd job 身份未校验；生产 voice job argv 指向 `worktrees/raya-FLY-2074` | 接受：身份门；删 Node 回退；上报 Lead → Lead 已重载 |
| 2 | `old_head` 不是 known-good | 接受：回滚锚只取合法 `deployed-sha`；bootstrap 失败不假报 |
| 3 | voice 基线空集、无替换证明 | 接受（R2 进一步简化为「在跑即换」并验证 voice.pid） |
| 4 | 锁/trap 合同 | 接受：库不设 trap；单一出口；`updater_cleanup` 集成 |
| 5 | 分支/mutation 围栏；路径冻结 | 接受：三道围栏；`raya_configure_runtime_paths` |
| 6 | receipt 顺序矛盾、写失败语义、告警 `--title` | 接受 |
| 7 | overdue 漏两类事故 | 接受：三分谓词 |
| 8 | FINDING 合同、合入顺序 | 接受：A→D→B→C |
| 9 | 删 chunk E；QA 授权 | 接受 |

### R2（2026-09-06，Codex round 2）

| # | 反馈 | 处置 |
|---|---|---|
| 1 | urgent/invalid 唤醒也会跑 Raya，越出 R4 授权 | 接受：R2 时用 `UPDATER_TRIGGER_OUTCOME`，R3 改为 `UPDATER_WAKE_KIND`（plan §3.5） |
| 2 | `arguments[0]` 索引写错（真实向量 `[node, cli.js, run]`）；缺 kickstart 前重验；voice 漂移已修 | 接受：期望向量恰好 3 项、`program == plist[0]`；每次 kickstart 前重验；§1.6 改为已修事实 |
| 3 | 围栏发现修改后仍无条件 `reset --hard`；known-good 需 ancestry；remote URL 白名单 | 接受：回滚围栏 → `rollback_blocked_mutation`；三态 ancestry；remote 白名单 |
| 4 | 锁 ident 与生产 argv 不符会驱逐活 updater；pre-lock 出口写 receipt | 接受：`ps -o lstart=` 身份；`RAYA_LOCK_OWNED=1` 才写；missing/locked 不写 |
| 5 | voice 采样时间窗、delta 正则漏输入、无锚路径 B 不重试 voice、单次 pid 采样 | 接受：cutover 重采样；**在跑即换**（删 delta 判定）；路径 B 含 voice；两次采样稳定 |
| 6 | §8 用 prose 重建了手工入口 | 接受：本期无生产 mutation QA（plan §8、§10） |
| 7 | FINDING 行缺 `epic=n/a epic_marker=n/a`；deploy drift 年龄被新 tip 掩盖 | 接受：补字段并已过 validator；年龄取 `deployed_sha..HEAD` 最老 commit |
| 8 | research/plan 双规范、schema/签名冲突 | 接受：本文重写为纯锚点；schema 只在 plan §3.7；helper 不加前缀 |
| 9（R2 原第 2 项漏记，R3 指出） | 会话宽限放在 ff/build 之后：等待期间 checkout 已是新字节 | 接受：宽限移到任何写之前（plan §3.4 第 10 步） |

### R3（2026-09-06，Codex round 3）

| # | 反馈 | 处置 |
|---|---|---|
| 1 | 宽限顺序危险；`meeting.json` 仅 scheduled 也被当在开会；通知先于最终围栏 | 接受：宽限在写之前；`jq` 只认 `starting\|live\|interrupted`（`packages/contracts/src/meeting.ts:180-184`）；通知只在 cutover 紧前；宽限后新会话按 Lead 裁定直接打断；urgent 票只延迟不抢占 |
| 2 | flywheel fetch 失败的定时唤醒会跳过 Raya | 接受：`UPDATER_WAKE_KIND` 与 `UPDATER_CYCLE_RESULT` 分离 |
| 3 | 回滚重建后无围栏；路径 A 无代际证明 | 接受：围栏 #R2；`gen_before` + 代际证明 |
| 4 | `cat-file -e` 对不存在对象返回 128（本机实测） | 接受：算法照 `update-flywheel.sh:340-354` |
| 5 | running 但 pid 缺失被当冷启动；`raya.env` 可覆盖 `RAYA_STATE_DIR`/`RAYA_METRICS_DIR`（`apps/brain/src/config.ts:42-55`） | 接受：`observe_failed`；身份门单键 grep 三个路径键 |

### R4（2026-09-07，Codex round 4；Lead 裁定 `210becfa` 前先落 v5）

| # | 反馈 | 处置 |
|---|---|---|
| 1 | 第 8 步仍写 merge（v3 残句），与「宽限前无写」矛盾 | 接受：第 8 步只读分类，唯一写点第 13 步；测试 27 断言 HEAD/merge/pnpm 计数不变 |
| 2 | Chunk B 代码仍用 `UPDATER_TRIGGER_OUTCOME`（v3 残句） | 接受：§4.2 改为 `UPDATER_WAKE_KIND` 门控，unknown fail closed；测试经真实 `update_main` |
| 3 | 围栏在长验证窗口过期 | 接受：`raya_assert_checkout <expected>` 在每次 kickstart 前与账本写入前重跑（正常 `new_head`、回滚 `rollback_sha`） |
| 4 | 路径 A 代际算法非全函数（误拉起用户停掉的 voice；双 label） | 接受：逐 label 策略；voice `stopped_by_user`/`recovered`；`generation` 改对象；空 start → `observe_failed` |
| 5 | receipt 逐 state 不可判；current 抹掉 `deployed_sha`；grace exhausted≠interrupted；`raya_finish` 示例缺参 | 接受：outcome 映射补全；`deployed_sha` 记真实运行锚；`exhausted:600` 与 `session_at_cutover` 分离；示例补齐三参 |

### R5（2026-09-07，Codex round 5 确认轮；Lead 裁定不开 R6，以 leadAcceptance 收口）

| # | 反馈 | 处置 |
|---|---|---|
| 1 | 成功账本前断言失败有两个互斥终态；「不写账本」是否含 failure receipt 不唯一 | 接受：plan §3.4 第 15 步唯一转移表；账本前失败直接 `rollback_blocked_mutation`，不进路径 B；failure receipt 照写、成功账本不写；测试 35 加 reset/rebuild 计数为 0 |
| 2 | `generation` 对象无法表达 replacement/recovery 失败；测试 32 仍是标量断言 | 接受：仅成功 `rolled_back` 写完整对象，失败终态 null + `failure` token；判定顺序 brain→voice；测试 32 改对象断言并加两条失败 schema 用例 |
