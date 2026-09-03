# FLY-2279 窗口脚本真机竞态修复 — 实施计划
Issue: FLY-2279 (https://linear.app/geoforge3d/issue/FLY-2279/2274-followup-窗口脚本三处真机-bugupdater-loaded-前置与预卸冲突-卸载后零等待判定竞态-verify-的)
日期: 2026-09-02
基于: research.md

> **执行约束：** 当前 DAG implement 节点只在本修订版 design review 通过后内联逐项执行。禁止派
> successor/QA、修改已获 APPROVED 的 pinned blob、执行生产窗口 mutation、merge 或 deploy。

**目标：** 回灌 FLY-2264 真机窗口确认的 bootout/lstart 根因修补，消除 updater 预卸与进程祖先 census
冲突，为尚未归因的 cmux failure 留下可执行诊断，并用慢退出、Lead/tmux-seat 隔离桩锁住回归。

**架构：** 保留 FLY-2274 的脚本边界与 fail-closed 合同。共享 launchd library 负责“全状态队列空 +
updater 两态”安全；bootout 脚本把 mutation 与 deadline-based convergence 分成两轮；verifier 用单一
`lstart` reader、完整 `ps pid,ppid` 快照与具名 cmux failure stages 建立稳定证据；共享 tmux inventory
用 macOS `pgrep -a` 消除祖先漏行。stop-old 不加豁免，runbook 完整规定普通 Terminal、updater 预卸/重装
和新 window directory。

**技术栈：** Bash 3.2、macOS `launchctl`/`ps`、`jq`、现有 shell fixture harness、pnpm monorepo gates。

---

## 文件职责

| 文件 | 责任 |
| --- | --- |
| `scripts/cutover/FLY-2264/lib/launchd-window.sh` | 双队列空 + updater loaded+enabled / absent 的唯一安全判据 |
| `scripts/cutover/FLY-2264/bootout-supervisors.sh` | 19 项 recovery-first bootout 与 60 秒 deadline 异步收敛 |
| `scripts/cutover/FLY-2264/lib/tmux-process-inventory.sh` | exact tmux name census 显式包含调用者祖先 |
| `scripts/cutover/FLY-2264/verify-native-tmux-cutover.sh` | `lstart` 规范化、Lead/child native 证据、具名 cmux owner/sidebar 诊断 |
| `scripts/__tests__/fly2264-supervisor-window.test.sh` | updater 两态/全状态队列负向、慢退出与 fake-epoch deadline 桩 |
| `scripts/__tests__/fly2264-verify-native-cutover.test.sh` | 尾随空格、Lead/tmux-seat suppression 与 cmux failure-stage 桩 |
| `scripts/__tests__/fly2264-stop-old-tmux-servers.test.sh` | ancestor-inclusive census 与 runbook 生命周期静态合同 |
| `engineering/doc/FLY-2264-arm64-tmux-gate/cutover-runbook.md` | 新 window dir、updater 预卸/重装、普通 Terminal 的可执行合同 |
| `engineering/doc/milestones/FLY-2279.md` | PR 最后提交的 issue 交付摘要 |

## Task 1：双队列空约束 updater 的两个合法窗口状态

- [ ] **1.1 写 RED：完整 supervisor cycle 接受安全预卸 updater。**

  在 `fly2264-supervisor-window.test.sh` 建立空的
  `$WINDOW_HOME/.flywheel/self-ship-pending.d` 与 `self-ship-urgent.d`，删除 updater loaded marker，运行
  `bootout-supervisors.sh`，随后运行 `restore-supervisors.sh`。断言 bootout 19 次、restore 19 次、updater
  从未被 mutation、两条命令都 rc=0。

  Run：

  ```bash
  bash scripts/__tests__/fly2264-supervisor-window.test.sh
  ```

  Expected RED：新用例失败，stderr 含 `updater is not loaded`；已有用例仍执行。

- [ ] **1.2 写最小 GREEN：扩展共享 updater 安全谓词。**

  在 `launchd-window.sh` 新增 source-only `fly2264_assert_updater_queues_empty`：路径不存在返回 0；存在则
  必须是 non-symlink directory，`find -mindepth 1 -maxdepth 1 -print -quit` 必须成功且无输出。修改
  `fly2264_assert_updater_safe`：**先**对 pending/urgent 两处调用 queue helper，再通过
  `fly2264_launchd_state` 得到三态；loaded 继续原 `print-disabled` enabled 判定；absent 直接返回 0；unknown
  返回非零。这样 loaded updater 也不能在 urgent token 存在时被误判安全。

- [ ] **1.3 验 GREEN，并补不改变行为的负向矩阵。**

  对 loaded 与 absent updater 分别在 pending/urgent 放 entry，运行 bootout，断言首个 supervisor
  `launchctl bootout` 前失败且 stderr 点名具体路径；另断言 queue path 为 symlink/regular file 时
  fail closed。更新 bootout/restore 调用点的 die 文案，描述“两态 + 双队列空”而不是错误地要求
  “must remain loaded”。再次运行 suite，Expected PASS。

- [ ] **1.4 小提交。**

  ```bash
  git add scripts/cutover/FLY-2264/lib/launchd-window.sh \
    scripts/__tests__/fly2264-supervisor-window.test.sh
  git commit -m "fix(FLY-2279): accept a safely pre-unloaded updater"
  ```

## Task 2：先全卸，再逐项按 60 秒 deadline 等待

- [ ] **2.1 写 RED：慢退出桩证明 mutation-before-poll。**

  扩展 supervisor test 的 launchctl stub：指定 Bridge 为 slow label 时，bootout 只写 pending marker；随后
  `print` 第三次才删除 loaded marker。首次 slow poll 记录当时已有的 bootout call 数。用 test-only
  sleep/date stub 避免墙钟等待。断言 rc=0、slow 首次 poll 前已有 19 次 bootout、slow poll 次数大于 1。

  Run：

  ```bash
  bash scripts/__tests__/fly2264-supervisor-window.test.sh
  ```

  Expected RED：仓库版在第一项 bootout 后立即报 `label still loaded after bootout`，且 ledger 只有一次
  bootout。

- [ ] **2.2 写最小 GREEN：bootout 与 convergence 两轮化。**

  第一轮仅按 reviewed manifest 调用 19 次 `launchctl bootout`，任一次非零立即点名失败。第二轮为每项
  记录 `date +%s` 起点并计算 `+60` deadline：absent break；loaded 时在 deadline 前 `sleep 1`；unknown
  立即失败；每次 state 返回后重读 epoch，达到 deadline 即停止。失败文案为
  `label did not become absent within 60-second convergence deadline: LABEL`，避免把调用次数冒充精确 elapsed。
  外层 120 秒 run-step 仍约束单次卡住的 launchctl。保留后续 fresh manifest 与 final census。

- [ ] **2.3 验 GREEN，并增加 timeout 负向。**

  slow stub 永不删除时让 fake epoch 跨过 deadline，断言不再 poll、rc 非零、诊断含
  `60-second convergence deadline`，且没有绿色 JSON。
  再运行 suite，Expected PASS。

- [ ] **2.4 小提交。**

  ```bash
  git add scripts/cutover/FLY-2264/bootout-supervisors.sh \
    scripts/__tests__/fly2264-supervisor-window.test.sh
  git commit -m "fix(FLY-2279): wait for asynchronous supervisor exits"
  ```

## Task 3：统一规范化 `lstart`，并让 cmux failure 可归因

- [ ] **3.1 写 RED：process-native 与 cmux owner 接受尾随空格。**

  在 verifier test 让 ps fixture 的 `START` 为 `Mon Sep  2 15:00:00 2026   `，同时 owner 文件保持无尾空格。
  分别断言 `fly2264_verify_process_native` 输出规范的 `startIdentity`，以及 `fly2264_verify_cmux` producer
  status=pass。

  Run：

  ```bash
  bash scripts/__tests__/fly2264-verify-native-cutover.test.sh
  ```

  Expected RED：process JSON 带尾空格或 06 producer 因 owner mismatch 失败。

- [ ] **3.2 写最小 GREEN：四个读取点使用同一 helper。**

  在 verifier 顶部新增 `fly2264_process_lstart PID`：执行固定 `TZ=UTC LC_ALL=C ps -o lstart= -p PID`，
  仅以 `sed 's/^[[:space:]]*//;s/[[:space:]]*$//'` 删除两端空白，空值/ps 非零失败。替换
  `start_before`、`start_after`、watcher `actual_start` 与 watcher final recheck 四处管道。

- [ ] **3.3 验 GREEN 与 drift 负向。**

  运行 verifier suite，确认 trailing-space 用例绿且既有 lstart drift negative 仍红转 artifact fail。

- [ ] **3.4 写第二个 RED：cmux 每个失败阶段必须写入 artifact error。**

  扩展现有 06 fixture，逐项制造：owner file 缺失/字段不匹配、heartbeat PID mismatch/stale、
  sidebar 命令非零且 stdout 含结构化 `reasons`、sidebar rc=0 但 verdict 非 pass、owner-after drift、final
  watcher incarnation drift。通过 `fly2264_run_producer 06-cmux.json fly2264_verify_cmux` 断言每个 artifact
  `status=fail`，且 `.error` 分别含稳定阶段名；sidebar 非零用例还必须保留限长后的原始 reason。

  Expected RED：当前裸 `return 1` 让 `.error == ""`。

- [ ] **3.5 写最小 GREEN：固定阶段诊断，不改变判定。**

  为 `fly2264_verify_cmux` 的 launchd PID、owner path/read/shape/identity、heartbeat path/read/PID/age、sidebar
  command/verdict、owner-after、final identity 每个失败边界输出唯一固定前缀。sidebar 调用先用 `set +e`
  捕获 rc 与 stdout，再恢复 `set -e`；对 stdout 做 JSON 验证，失败时经现有 `fly2264_bound_text` 限长写到
  stderr。任何未知仍返回 1，success JSON schema 不变。

- [ ] **3.6 小提交。**

  ```bash
  git add scripts/cutover/FLY-2264/verify-native-tmux-cutover.sh \
    scripts/__tests__/fly2264-verify-native-cutover.test.sh
  git commit -m "fix(FLY-2279): diagnose verifier identity failures"
  ```

## Task 4：消除 Lead child 与 tmux exact census 的祖先盲区

- [ ] **4.1 写 RED：Lead-seat ancestor suppression。**

  verifier test 的 `ps` stub 增加 exact `-axo pid=,ppid=` 分支，从 fixture `children` map 输出完整 snapshot；
  `pgrep -P` 在 Lead-seat 模式下故意隐藏 parent=300 的 child。运行 `fly2264_verify_lead_health`，断言仍应
  返回 leadCount=16。

  Run：

  ```bash
  bash scripts/__tests__/fly2264-verify-native-cutover.test.sh
  ```

  Expected RED：旧实现拿不到 parent=300 的 child，05 producer 非零。

- [ ] **4.2 写最小 GREEN：从完整 ps snapshot 选 direct child。**

  新增 `fly2264_direct_child_pid PARENT`：一次读取 `ps -axo pid=,ppid=`，awk exact 匹配第二列，过滤正整数
  PID，numeric sort 后取最小。`fly2264_verify_lead_health` 调用该 helper，继续用已有
  `ps -o ppid= -p CHILD` 做单 PID 重证，保持 launchd PID 的前后夹取。

- [ ] **4.3 验 GREEN 与缺 child 负向。**

  Lead-seat 模式应绿；从 children map 删除一行时 05 应红。

- [ ] **4.4 写第二个 RED：exact tmux census 包含当前座位祖先。**

  扩展 stop-old/verifier 的 pgrep stub：仅当 argv 为 macOS `-a -x tmux` 时返回一个标记为“调用者祖先”的
  tmux PID，普通 `-x tmux` 按真实 macOS 默认把它隐藏。为该 PID 配完整 lsof/file/socket/coalition fixture；
  断言 `inventory_tmux_servers` 与 04 producer 都包含它。Expected RED：旧 library 不传 `-a`，行缺失。

- [ ] **4.5 写最小 GREEN：tmux name match 显式 include ancestors。**

  把共享 `tmux-process-inventory.sh` 的唯一 census 改为 `pgrep -a -x tmux`。保留 rc 0/1 合同、PID numeric
  验证、image/socket/coalition 与 incarnation 重证，不增加 inventory 行数下限，不改变 atlas exemption。

- [ ] **4.6 小提交。**

  ```bash
  git add scripts/cutover/FLY-2264/lib/tmux-process-inventory.sh \
    scripts/cutover/FLY-2264/verify-native-tmux-cutover.sh \
    scripts/__tests__/fly2264-stop-old-tmux-servers.test.sh \
    scripts/__tests__/fly2264-verify-native-cutover.test.sh
  git commit -m "fix(FLY-2279): include process ancestors in window census"
  ```

## Task 5：闭合 updater/window 生命周期并校正 operator seat

- [ ] **5.1 写 RED：runbook 静态合同。**

  在 `fly2264-stop-old-tmux-servers.test.sh` 断言 runbook 同时包含：普通 Terminal 操作；不得在 Lead seat
  运行；authoritative census 前关闭 operator 自建 `tmux new -s` 会话；使用新的
  `FLY-2264-window-FLY-2279` 且保留旧 window；updater loaded/absent 两态都要求双队列空；§3.3 明确
  bootout updater 并等待 absent；§6 在 queue recheck 后 bootstrap updater，证明 loaded+enabled 后才发
  唯一票；§0 只授权这两个 updater mutation。Expected 当前文本检查失败。

- [ ] **5.2 修改 runbook。**

  - §0 增加普通 macOS Terminal、不得在 Lead tree、authoritative census 前零 operator tmux 的硬前置；
    授权仅 §3.3 exact updater bootout 与 §6 exact updater bootstrap 两个额外 launchd mutation。
  - §1 改用新的 `$HOME/.flywheel/state/FLY-2264-window-FLY-2279`，明确旧
    `FLY-2264-window` 含 recovery/evidence 不得删除或覆盖；installer 只对新目录同字节幂等。
  - 新 §3.3 在 updater loaded+enabled 状态先调用受审 queue helper，执行 exact bootout，再用 epoch deadline
    等待 absent，并二次验证 queues empty；不把 updater 放入 19 项 manifest。
  - §4 把 updater 合同写成“queues empty + loaded+enabled/absent”；§4.1 说明全发 19 次 bootout 后逐项按
    60 秒 deadline 等待。
  - §5.5 删除无条件 updater print，改为从 installed library 调用 `fly2264_assert_updater_safe` 重证 absent
    安全；19 项 restore 行为不变。
  - §6 在 bootstrap 前再次调用 queue helper，bootstrap exact plist，调用 updater safe helper 证明
    loaded+enabled+queues empty，随后才运行全窗唯一 `request-restart.sh`。
  - §7 说明 verifier 的 Lead/tmux census 已不受祖先过滤影响，但所有窗口命令仍必须留在 §0 普通 Terminal，
    禁止为了验证创建临时 tmux server；不得写成“任意座位”。

- [ ] **5.3 验 GREEN，重跑 stop-old 行为测试。**

  ```bash
  bash scripts/__tests__/fly2264-stop-old-tmux-servers.test.sh
  bash scripts/__tests__/fly2264-stop-old-tmux-real.test.sh
  ```

  Expected PASS；真实私有 socket suite 若宿主缺 exact 3.5a，必须按其既有显式 SKIP 合同记录，不能伪报绿。

- [ ] **5.4 小提交。**

  ```bash
  git add engineering/doc/FLY-2264-arm64-tmux-gate/cutover-runbook.md \
    scripts/__tests__/fly2264-stop-old-tmux-servers.test.sh
  git commit -m "docs(FLY-2279): pin a neutral cutover operator seat"
  ```

## Task 6：三脚本真机隔离 dry-run、安装载体与脚本语法

- [ ] **6.1 运行三条目标脚本的 macOS 真机隔离 dry-run suites。**

  ```bash
  bash scripts/__tests__/fly2264-supervisor-window.test.sh
  bash scripts/__tests__/fly2264-stop-old-tmux-servers.test.sh
  bash scripts/__tests__/fly2264-stop-old-tmux-real.test.sh
  bash scripts/__tests__/fly2264-verify-native-cutover.test.sh
  ```

  这四个 suite 在当前 macOS 真机执行真实 Bash/`jq`/文件权限/私有 tmux socket 行为，但所有 launchctl、
  process census、kill 与部署动作都指向 fixture/stub；分别证明 bootout、stop-old、verify 三条脚本全绿，
  不把 production mutation 冒充 dry-run。`fly2264-stop-old-tmux-real.test.sh` 若 exact 3.5a 不存在，只能按
  既有明确 SKIP 输出记录。

- [ ] **6.2 运行安装器、phase-b 与语法回归。**

  ```bash
  bash scripts/__tests__/fly2264-install-window-artifacts.test.sh
  bash scripts/__tests__/fly2264-phase-b-link.test.sh
  bash -n scripts/cutover/FLY-2264/lib/launchd-window.sh \
    scripts/cutover/FLY-2264/lib/tmux-process-inventory.sh \
    scripts/cutover/FLY-2264/bootout-supervisors.sh \
    scripts/cutover/FLY-2264/stop-old-tmux-servers.sh \
    scripts/cutover/FLY-2264/verify-native-tmux-cutover.sh
  ```

- [ ] **6.3 mutation 与 reviewer regression audit。**

  核对 git diff 只含计划文件；测试 ledger 证明 stub 被调用；确认没有生产 launchctl/Homebrew/restart/tmux
  mutation。逐项核对上一轮 findings：ancestor tmux 行进入 inventory、06 error 非空且点名阶段、loaded
  queue 非空会红、runbook updater 预卸/重装闭环、新 window dir 保全旧 evidence、deadline 文案不把迭代
  次数冒充 elapsed。检查 inbox 并处理 Lead 指令。

## Task 7：全仓门、code review、PR 与 implement handoff

- [ ] **7.1 运行 exact 全仓 gates。**

  ```bash
  pnpm lint
  pnpm -r build
  pnpm test:packages:run
  ```

  任一失败先按 failure output 归因；仅修本 PR 引入的失败，既有失败以可复现证据上报。

- [ ] **7.2 运行 Codex code review。**

  通过仓库 `codex:rescue` 路径（绝不 raw `codex exec`）审查从基线到当前 head 的 diff，修复所有
  blocking correctness/security findings，并对每次 fix 重跑相关红绿与全仓门。

- [ ] **7.3 注册正式 review gate。**

  ```bash
  node "$FLYWHEEL_COMM_CLI" gate review_code --lead flywheel-eng-lead \
    --exec-id fb7a7179-e369-4999-8626-be341cef7b01 --no-block \
    "Code review requested for FLY-2279"
  node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id <上一步返回的 questionId>
  node "$FLYWHEEL_COMM_CLI" check <同一 questionId>
  ```

  CHANGES_REQUESTED 必须修复后新开 questionId；APPROVED advisories 用 `ask --report` 转告 Lead。

- [ ] **7.4 创建 PR 前最后检查。**

  检查 `git status`、计划逐项验收、未提交内容与 inbox；push feature branch，创建 PR。不得请求 ship、
  merge 或 deploy。

- [ ] **7.5 milestone 必须是 literal last commit。**

  新建 `engineering/doc/milestones/FLY-2279.md`，记录 PR、改动、红绿证据、全仓 gates、review verdict 与
  明确未执行 production mutation；只提交该文件并 push，确保它是 PR head 的最后 commit。milestone 后不再
  更新 progress，避免 head 绑定漂移。

- [ ] **7.6 报告并完成 bounded implement phase。**

  ```bash
  node "$FLYWHEEL_COMM_CLI" ask --lead flywheel-eng-lead \
    --exec-id fb7a7179-e369-4999-8626-be341cef7b01 --report \
    'DONE: FLY-2279 implementation complete; tests/review/PR evidence attached'
  node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr <PR_NUMBER>
  ```

## 计划自审（design review round 1 修订）

- Scope coverage：updater 冲突/生命周期、异步退出、`lstart`、Lead child/tmux ancestor census、cmux 未归因
  failure、operator tmux shape 与旧 artifacts 换代分别由 Task 1–5 覆盖；慢退出、Lead/tmux-seat、三脚本
  macOS 隔离 dry-run、全仓门、review、PR 和 milestone 均有独立步骤。
- Failure closure：updater unknown/disabled/任一状态 queue nonempty、bootout deadline/state unknown、lstart
  drift、缺 child、tmux ancestor 漏行、cmux owner/sidebar/heartbeat stage、stop-old unreviewed shape 都保持
  fail closed，诊断只增加证据、不放宽 verdict。
- Type/byte consistency：不改 recovery/artifact JSON schema；`lstart` 只删两端 whitespace，不折叠内部；
  child 仍是最低 numeric PID 的 direct child。
- Placeholders：`questionId` 与 `PR_NUMBER` 只能由运行时外部命令生成，步骤明确其来源；没有未决实现
  占位符。
- Review closure：round 1 两项 HIGH 由 Task 3.4–3.5（06-cmux 具名诊断）与 Task 4.4–4.5（tmux census
  `pgrep -a`）阻断性修复；四项 advisory 分别由 Task 1 全状态 queue、Task 5 完整 lifecycle/新 window dir、
  Task 2 epoch deadline 与正确文案吸收。
- Locked boundary：本修订版若获 APPROVED 后不再修改；不触碰 CLAUDE.md，不执行 production window、
  不派 QA、不 merge。
