# FLY-1959 删除老 self-ship 路 — 实施计划
Issue: FLY-1959 (https://linear.app/geoforge3d/issue/FLY-1959/self-ship净删除-删掉老自-ship-重启路只留定时班车-founder-紧急一张票)
日期: 2026-08-21
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` task-by-task and `superpowers:verification-before-completion` before any completion claim. This DAG implement node executes inline: it must not dispatch subagents, request ship approval, merge, or mutate production launchd state.

**Goal:** 净删除普通 merge 自投重启票链；updater 只接受本地 00:00/12:00 定时班车与 founder `request-restart.sh` 紧急 token 两个入口。

**Architecture:** 普通 merge 不再落任何 durable deployment state。定时 invocation 比较 `deployed-sha` 与最新 `origin/main`，落后时只跑一次既有 deploy/restart；紧急入口从 watched dir 外原子发布最小 JSON token。updater 取得 singleton lock后以 noninteractive `bounded-run` 做最多三次短 fetch probe，再校验并原子 claim开场 token（restart 前移动到 watched dir 外的本轮临时目录），随后只尝试一次 restart；失败不自动重试。late token不在开场 snapshot中，留给下一次受 60 秒 throttle 约束的 invocation。同一 snapshot 的多票合并一次；claim 后的新票是新的 founder intent，不用 `targetSha` 做跨轮去重。

**Tech Stack:** Bash 3.2、launchd plist、git、Python 3 `plistlib`、现有 shell harness、pnpm monorepo gates。

---

## 文件责任图

| 文件 | 最终责任 |
| --- | --- |
| `scripts/request-restart.sh` | founder 紧急入口：校验 target、原子 urgent token、no-`-k` nudge |
| `scripts/update-flywheel.sh` | updater state-root默认值、singleton、开场 token snapshot、scheduled drift、每轮至多一次 deploy |
| `scripts/launchd/com.flywheel.updater.plist` | 唯一 urgent QueueDirectories、00/12 calendar、60 秒 throttle |
| `scripts/r4/r4-window.sh` | installed plist/quiet 前置只认 urgent 新合同 |
| `scripts/provision-fleet-host.sh` | Linux supervisor watch urgent dir |
| `.claude/commands/{spin,orchestrator}.md` | merge 完成与 deployment 解耦，不再 post-merge restart handoff |
| `scripts/hooks/flywheel-restart-guard.py` | deny 文案只指向 founder urgent token，不再承认第三条 self-ship 路 |
| `packages/teamlead/lead-rules-base/founder-only-authority.md` | R4 双入口与 authority 单一心智模型 |
| `scripts/__tests__/request-restart.test.sh` | 紧急 producer 的顺序、失败、dry-run、late-safety |
| `scripts/__tests__/update-flywheel-sources.test.sh` | schedule/urgent 两入口、单 deploy、token消费、lock |
| `scripts/__tests__/updater-trigger-policy.test.sh` | plist + 活引用净删除静态合同 |
| `engineering/doc/FLY-1959-delete-self-ship/rollout.md` | urgent dir + installed plist 的 bootout/staged install/bootstrap 切换与 live 验收 |

删除：`scripts/self-ship-restart.sh`、`scripts/lib/self-ship-queue.sh`、`scripts/__tests__/self-ship-restart.test.sh`、`scripts/__tests__/self-ship-queue.test.sh`、`scripts/__tests__/restart-stabilization.test.sh`、旧 `update-flywheel-queue.test.sh` 及其 CI/package 清单引用。

被删 library 的存活符号必须显式转交：producer/consumer都解析 `FLYWHEEL_HOME=${HOME}/.flywheel` 与由它派生的 `SELF_SHIP_URGENT_DIR`；producer自带 `SELF_SHIP_LAUNCHCTL=launchctl`、`SELF_SHIP_UPDATER_LABEL=com.flywheel.updater`；consumer自带由 state root派生的 `SELF_SHIP_LOCK_DIR`。生产唯一目录合同是 `${HOME}/.flywheel/self-ship-urgent.d`（macOS plist为当前宿主绝对路径，Linux provision为`$st/self-ship-urgent.d`）；consumer在 source harness 才允许 env override，正常执行时必须把 `.env` 中同名变量覆盖回启动时捕获的 canonical path。

## Task 1：RED 固化净删除与双触发 plist

**Files:**

- Create: `scripts/__tests__/updater-trigger-policy.test.sh`
- Modify after RED: `scripts/launchd/com.flywheel.updater.plist`
- Delete after RED: `scripts/self-ship-restart.sh`
- Delete after RED: `scripts/lib/self-ship-queue.sh`

- [ ] **Step 1: 写失败的静态合同测试。** 用 Python `plistlib` 断言 `QueueDirectories` 精确等于 host-pinned 字面绝对路径 `['/Users/xiaorongli/.flywheel/self-ship-urgent.d']`（不从 CI runner 的 `$HOME` 推导）、calendar 精确为 00/12、`ThrottleInterval == 60`；R4 validator 仍从 production `$ENV.HOME` 派生路径，因为它只在目标宿主执行。用 `test ! -e` 断言两个旧脚本与 restart-stabilization 测试已删除。零引用守卫必须使用 CI 原生 `git grep -n -E`，pattern精确为 `self-ship-pending|SELF_SHIP_PENDING_DIR|self-ship-restart|self-ship-queue`。扫描整个 tracked tree，只排除历史过程文档 `engineering/doc/**`、`doc/engineer/{exploration,research,plan,deep-research}/**`、`doc/architecture/archive/**`、`doc/retro/**`、`product/doc/**`，以及本单输入快照 `.claude/skills/linear-issue-context/SKILL.md`；`CLAUDE.md`、`doc/engineer/implementation/**`、所有源码/脚本/测试/配置均不可排除。

  ```bash
  git grep -n -E 'self-ship-pending|SELF_SHIP_PENDING_DIR|self-ship-restart|self-ship-queue' -- . \
    ':(exclude)engineering/doc/**' \
    ':(exclude)doc/engineer/exploration/**' \
    ':(exclude)doc/engineer/research/**' \
    ':(exclude)doc/engineer/plan/**' \
    ':(exclude)doc/engineer/deep-research/**' \
    ':(exclude)doc/architecture/archive/**' \
    ':(exclude)doc/retro/**' \
    ':(exclude)product/doc/**' \
    ':(exclude).claude/skills/linear-issue-context/SKILL.md'
  ```

  该命令预期以 status 1 表示零命中；测试 harness 必须把命中内容打印后失败，而不是把零命中的 status 1 误判为失败。
- [ ] **Step 2: 运行 RED。**

  ```bash
  bash scripts/__tests__/updater-trigger-policy.test.sh
  ```

  预期因 plist 仍看 pending、缺 throttle、旧文件存在而 FAIL；fixture/语法错误不算 RED。
- [ ] **Step 3: 最小 GREEN。** 修改 plist 到 urgent-only + 00/12 + throttle 60；删除旧 producer/library，但先不改其他活引用。
- [ ] **Step 4: 只运行结构断言确认 plist 子项变绿；活引用断言仍应保持 RED，证明后续文档清理是 load-bearing。**

## Task 2：RED/GREEN 实现 founder 紧急 token

**Files:**

- Modify: `scripts/__tests__/request-restart.test.sh`
- Modify after RED: `scripts/request-restart.sh`

- [ ] **Step 1: 在现有 remote lookup 用例外，新增 sourceable harness。** 覆盖 loaded/enabled preflight、token mode/内容、原子 publish 后 tmp 零残留、一次 no-`-k` kickstart、dry-run 零写、publish 失败不 kickstart、kickstart 失败保留 token且返回 69。
- [ ] **Step 2: 运行 RED。**

  ```bash
  bash scripts/__tests__/request-restart.test.sh
  ```

  预期新用例因当前脚本仍委托已删除的 self-ship handoff、不会直接写 urgent token而 FAIL。
- [ ] **Step 3: 最小实现。** 保留 `rr_remote_main_sha` / `rr_local_main_sha`；显式定义 `FLYWHEEL_HOME`、`SELF_SHIP_URGENT_DIR`、`SELF_SHIP_LAUNCHCTL`、`SELF_SHIP_UPDATER_LABEL` 默认值；加入严格 loaded/enabled 检查、`rr_publish_urgent_token` 和 `rr_kickstart_updater`。request先 `mkdir -p` + chmod 700 urgent dir；temp 位于 watched dir之外、同一 parent/filesystem，写入 `schemaVersion=1` / `kind=founder-urgent-restart` / 40-hex `targetSha` / integer `createdAt`并 chmod 600，再以唯一 `.urgent.json` basename原子 `mv`进入 watched dir；成功日志不声称 restart完成。
- [ ] **Step 4: 运行 GREEN + Bash 3.2 syntax。**

  ```bash
  bash -n scripts/request-restart.sh scripts/__tests__/request-restart.test.sh
  bash scripts/__tests__/request-restart.test.sh
  ```

## Task 3：RED/GREEN 将 updater 缩成两个入口

**Files:**

- Create: `scripts/__tests__/update-flywheel-sources.test.sh`
- Modify after RED: `scripts/update-flywheel.sh`
- Delete after GREEN: `scripts/__tests__/update-flywheel-queue.test.sh`

- [ ] **Step 1: 新 harness source updater 并注入 deploy/fetch/census。** 精确覆盖：无 urgent+deployed追平为0 deploy；无 urgent+落后为1 deploy；多个合法 urgent+无 drift仍为1 deploy；合法 token在 deploy前已原子移出 watched dir；deploy中新增 token保留并在下一 invocation 再触发一次（同 SHA 也不按 deployed状态误去重）；deploy失败不留下已 claim token且rc非零；invalid JSON/basename/kind/provably-foreign target被移出且零 deploy；origin fetch禁交互、单次有界且第三次成功时仍保留票，全部失败或后续 git probe失败才属于 indeterminate，token被 claim-once、零 deploy、rc非零且不留下会重复触发 `QueueDirectories` 的 watched condition；claim到primary alert之间的SIGTERM/INT必须由cleanup补告警；用 sandbox `HOME`、`FLYWHEEL_CLAIMS_DB`、`FLYWHEEL_ALERT_QUEUE_DIR`、`FLYWHEEL_ALERT_DEADLETTER_DIR`、假sender token/channel和PATH内假`curl`驱动真实 `scripts/lead-alert.sh`，证明同一 urgent basename重复失败只产生一条`sent` receipt、不同 basename各一条，scheduled同 UTC 日一条、跨日再一条，绝不触达生产；claim目录与 watched dir的 `stat -f %d`（BSD）/`stat -c %d`（GNU）device id相等；真实git fixture在claim前后 `git -C "$FLYWHEEL_DIR" status --porcelain` 都为空且claim path不在checkout内；已claim后模拟 TERM/异常退出会走trap告警；活 identity-match lock不消费token；活但 `ps` 不可探测的lock不回收；活 identity-mismatch（PID reuse）可回收；dead-owner stale lock可回收；singleton owner state写失败必须 fail-loud，不能伪装成正常 contention。
- [ ] **Step 2: 运行 RED。**

  ```bash
  bash scripts/__tests__/update-flywheel-sources.test.sh
  ```

  预期因 queue library/marker loop仍在且缺最小 urgent snapshot API而 FAIL。
- [ ] **Step 3: 最小实现。** 删除 queue source、`report_deployment`、`process_due_markers`、marker loop/backoff/blocked逻辑；在 updater内显式定义 `FLYWHEEL_HOME`、`SELF_SHIP_URGENT_DIR`、`SELF_SHIP_LOCK_DIR` 默认值，再内联 updater-private PID lock、三态 token validator、snapshot/claim helper；`update_main` 每次最多调用一次 `default_deploy`。validation与deploy的所有 remote fetch都经 `GIT_TERMINAL_PROMPT=0` + `bounded-run`；runner缺失用rc127独立报因；fetch后冻结 `origin/main` SHA并用本地 `merge --ff-only` 更新 worktree，不用 timeout强杀 mutation。每轮无条件 `mkdir -p` + chmod 700 urgent dir，并且只能用 `mktemp -d "${FLYWHEEL_HOME}/.urgent-claim.XXXXXX"` 在 watched dir外、repo checkout外创建本轮 claim目录；claim用原子 `mv`，trap清理该临时目录和自身lock。lock保留旧安全不变量：alive+identity match不回收，alive+uninspectable不回收，只有 alive+inspectable identity mismatch 或 dead owner 才回收。`units.manifest` 同步登记 updater 的 handled rc，避免独立 severe告警后又被 census误报 daemon failure。
- [ ] **Step 4: 失败路径。** urgent failure signature逐票固定为 `urgent-<class>-<token-basename>`；同票只报一次、不同票各自可见。scheduled failure signature固定为 `<class>-scheduled-<UTC-YYYYMMDD>`；同日去重、跨日重报。合法 urgent token在 deploy前claim，失败不自动retry；provably-invalid token移出 watched dir且绝不restart；indeterminate token也 claim-once、告警且非零退出，避免坏票让 launchd永久热拉或阻塞后票。cleanup trap维护 claimed/completed/alerted 状态：已claim但未完成且尚未告警时补发相同票据signature，覆盖普通异常/TERM/INT，再删除本轮claim目录和自身lock；SIGKILL/panic/断电无法覆盖，作为已接受的at-most-once边界写进 rollout。
- [ ] **Step 5: 运行 GREEN。**

  ```bash
  bash -n scripts/update-flywheel.sh scripts/__tests__/update-flywheel-sources.test.sh
  bash scripts/__tests__/update-flywheel-sources.test.sh
  ```

## Task 4：RED/GREEN 收敛 R4、provision、restart 与护栏

**Files:**

- Modify tests: `scripts/__tests__/r4-window.test.sh`
- Modify tests: `scripts/__tests__/provision-linux.test.sh`
- Modify tests: `scripts/hooks/test-flywheel-restart-guard.py`
- Modify tests: `scripts/__tests__/fly1783-restart-detach-contract.test.sh`
- Modify tests: `scripts/__tests__/supervisor.test.sh`
- Modify tests: `scripts/__tests__/packaged-seams.test.sh`
- Delete tests: `scripts/__tests__/restart-stabilization.test.sh`
- Modify after RED: `scripts/r4/r4-window.sh`
- Modify after RED: `scripts/provision-fleet-host.sh`
- Modify after RED: `scripts/restart-services.sh`
- Modify after RED: `scripts/hooks/flywheel-restart-guard.py`

- [ ] **Step 1: 先改断言。** plist结构只在新的 Python `plistlib` suite里跨平台断言；R4 harness只测 quiet/restore在bootstrap前创建并检查 mode 0700 urgent dir，不在Linux调用macOS `plutil`；Linux path unit只watch urgent；guard deny reason包含“founder 紧急票”且不再出现自动self-ship提示；`fly1783`删除旧脚本readability前置；supervisor fixture改urgent；packaged-seams不再cp queue lib；pending stabilization suite整文件删除并从manual-only清单移除。
- [ ] **Step 2: 运行 RED。**

  ```bash
  bash scripts/__tests__/r4-window.test.sh
  bash scripts/__tests__/provision-linux.test.sh
  python3 scripts/hooks/test-flywheel-restart-guard.py
  ```

- [ ] **Step 3: 最小 GREEN。** R4 quiet/restore 创建并检查 urgent dir，不再创建旧目录；`r4_validate_updater_plist` 的 jq 同时硬断言 urgent-only、00/12 与 `.ThrottleInterval == 60`；provision spec改 urgent；删除 `_self_ship_active` 与第二 idle sample；从 `scripts/hooks/flywheel-restart-guard.py` 的允许路径 regex 中删除 `self-ship-restart`，护栏 deny 文案只保留 schedule/founder urgent 两入口。
- [ ] **Step 4: 复跑全部受影响suite与 `bash -n`；`plutil -lint`只作为macOS实现机本地门，CI可移植门是Python `plistlib`。**

## Task 5：清理所有活规则、打包与 CI 引用

**Files:**

- Modify: `.claude/commands/spin.md`
- Modify: `.claude/commands/orchestrator.md`
- Modify: `.flywheel/agents/engineering/engineer-executor.md`
- Modify: `.flywheel/agents/general-executor.md`
- Modify: `.flywheel/config.yaml`
- Modify: `.lead/flywheel-eng-lead/identity.md`
- Modify: `packages/teamlead/lead-rules-base/founder-only-authority.md`
- Modify: `doc/engineer/implementation/restart-guard.md`
- Modify: `doc/engineer/implementation/bridge-ship-discipline.md`
- Modify: `CLAUDE.md`
- Modify: `scripts/package-onboard.sh`
- Modify: `scripts/package-onboard-files.allow`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/__tests__/ci-shell-suite-manual-only.txt`
- Modify: `packages/config/src/feature-flags/registry.ts`
- Modify: `scripts/converge-flywheel-bin.sh`
- Create: `engineering/doc/FLY-1959-delete-self-ship/rollout.md`

- [ ] **Step 1: 把 post-merge flow 改成 merge/completion即结束。** 不新增任何替代 handoff；明确 deployment只由下一班或 founder urgent发起。
- [ ] **Step 2: 删除 package/CI 中两个旧脚本与旧测试项，登记两个新 suite；运行 `ci-shell-suite-enumeration.test.sh`，证明无 stale/manual overlap。**
- [ ] **Step 3: 修 R4/FLY-913/CLAUDE 叙述。** 删除 founder-only-authority 的 post-ship restart exemption；说明 founder 对 ship 的批准只授权 merge，不自动授权即时 restart。
- [ ] **Step 4: 完成 rollout.md。** 精确顺序：确认 updater unloaded/urgent dir empty → `install -d -m 700`并验owner/mode → `plutil -lint` repo plist → 同目录stage + mode/owner验证 → `launchctl bootout` → atomic replace installed plist → `launchctl bootstrap` → `cmp` + `launchctl print`证明urgent-only/00/12/60；说明 `r4_restore_updater` 是现有原子安装实现，implement节点不执行生产cutover；逐字标注紧急票at-most-once、可捕获失败会告警、SIGKILL/panic/断电可能静默丢票，未观察到完成时由founder重新投票。
- [ ] **Step 5: 跑净删除合同 GREEN。** 使用Task 1定义的精确 `git grep` pattern/pathspec；所有非历史活代码/规则必须零命中。

## Task 6：验证、review、PR 与 handoff

**Files:**

- Modify: `engineering/doc/FLY-1959-delete-self-ship/progress.md`
- Modify last commit: `CLAUDE.md` milestone and process-doc final state if needed

- [ ] **Step 1: 定向验证。**

  ```bash
  bash scripts/__tests__/updater-trigger-policy.test.sh
  bash scripts/__tests__/request-restart.test.sh
  bash scripts/__tests__/update-flywheel-sources.test.sh
  bash scripts/__tests__/r4-window.test.sh
  bash scripts/__tests__/provision-linux.test.sh
  bash scripts/__tests__/fly1783-restart-detach-contract.test.sh
  bash scripts/__tests__/supervisor.test.sh
  bash scripts/__tests__/packaged-seams.test.sh
  bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
  bash scripts/__tests__/restart-deployed-range.test.sh
  python3 scripts/hooks/test-flywheel-restart-guard.py
  plutil -lint scripts/launchd/com.flywheel.updater.plist
  ```
- [ ] **Step 2: full-repo gates。** 按角色合同运行 `pnpm lint`、`pnpm -r build`、`pnpm test:packages:run` 与所有新增/受影响 shell harness；若宿主 full suite 有既有失败，隔离到精确文件并诚实记录，不伪报全绿。
- [ ] **Step 3: completion audit。** 对验收逐项收集文件、测试与 grep 证据；生产 24h runs 观测明确留给 DAG QA/ship 窗，implement 不冒充已观测。
- [ ] **Step 4: code review。** `stage set code_review` 后按 Codex author 协议开 `review_code` gate + `request-review`，CHANGES必须修复并开新 gate，直到 APPROVED。
- [ ] **Step 5: 提交与 PR。** 保持 milestone/doc archive为最后 commit，push feature branch，创建 PR（base `main`），不请求 ship、不 merge。
- [ ] **Step 6: handoff。** 运行 `complete --route needs_review --pr <number>`，让 DAG controller推进 QA/review successor。

## Plan 自审

- 所有验收均有对应task：净删除、双入口、单deploy/播报、claim-once urgent、60s throttle、late-token、invalid/foreign拒绝、lock identity、R4/FLY-913/docs、installed plist cutover、精确grep与生产观测边界。
- 不存在 TBD/TODO/“之后补错误处理”等占位语句。
- `request-restart.sh` 是唯一 urgent producer；`update-flywheel.sh` 是唯一 consumer；不存在第三个普通 merge producer。
- 计划没有搬 #906 的 pending marker、attempt receipt、blocked/quarantine 或跨 invocation/deploy retry；唯一 retry 是 claim 前三次有界 fetch probe，urgent deploy失败不自动retry。
