# FLY-1926 updater 收尾误报 — 实施计划
Issue: FLY-1926 (https://linear.app/geoforge3d/issue/FLY-1926/bug误报-updater-收尾-bridge-复测在-lead-重启波峰上跑-22-次部署都误判-degradedbridge-实际健康)
日期: 2026-08-31
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan inline task-by-task. Do not dispatch subagents in this DAG implementation node.

**Goal:** 消除 updater 收尾对 Lead 统计与 Bridge 可用性的两类假 degraded，同时保留真实失败的现有告警。

**Architecture:** 机器可读统计仍采用严格单行 stdout，新增 gate/census 的人类诊断在生产者边界转 stderr。Bridge 延迟探针保留为 observation，但前移到 Lead 波之前；它的失败态改为 unavailable，不再推翻此前已通过的启动健康与 build identity。

**Tech Stack:** macOS Bash 3.2、shell fixture/stub、`curl`、`jq`、pnpm monorepo gates。

---

## 文件职责

- `scripts/restart-services.sh`：部署时序、Lead 重启统计生产边界、最终 alert 决策。
- `scripts/lib/restart-notify.sh`：纯渲染逻辑，把健康判决与可选延迟观测分开。
- `scripts/test-restart-services.sh`：真实函数提取与完整 restart fixture，提供 TDD 回归。
- `scripts/__tests__/launchd-census-wiring.test.sh`：renderer 参数合同和 launchd summary 兼容性。
- `scripts/__tests__/host-tmux-selection-restart-mounts.test.sh`：host-tmux gate/census 调用点与顺序的结构合同；实现必须保持调用行不变。
- `engineering/doc/FLY-1926-updater-bridge-recheck/progress.md`：每批工作完成后的 durable cursor。
- `engineering/doc/milestones/FLY-1926.md`：PR 前 literal last commit 的工程账本。

## 不变量

- `rn_parse_count` 继续拒绝任何多行或前后缀污染。
- Bridge startup-health 是独立显式事实；主健康检查或 build identity 失败仍在 Lead 波之前终止部署，renderer 不从 latency observation 猜健康。
- Lead 失败/跳过、统计不可读、波次未执行、零候选、watcher 非健康的现有非成功/degraded 语义不变。
- 收尾短探针不再承担 Bridge 存活判决；波中/波后持续死亡由已加载的 `com.flywheel.bridge-liveness-probe` 每分钟探测、连续 5 分钟去抖后报警。
- 不增加 timeout、retry、load 阈值、环境变量或部署动作。

### Task 1: 用真实 helper 复现 Lead 统计 stdout 污染

**Files:**

- Modify: `scripts/test-restart-services.sh`（host-tmux helper 提取测试）
- Test: `scripts/test-restart-services.sh`

- [ ] **Step 1: 提取真实 helper 并安装会写 stdout 的 fake gate**

在 `do_restart_all_leads` 测试前新增：

```bash
rn_host_tmux_funcs="$TMPDIR_ROOT/restart-host-tmux-functions.sh"
awk '
  /^restart_host_tmux_gate\(\)/ { capture=1 }
  capture && /^preflight_pull_latest_main\(\)/ { exit }
  capture { print }
' "$SCRIPT_DIR/restart-services.sh" > "$rn_host_tmux_funcs"
source "$rn_host_tmux_funcs"

rn_host_root="$TMPDIR_ROOT/host-tmux-stdout"
mkdir -p "$rn_host_root/state/bin" "$rn_host_root/repo"
cat > "$rn_host_root/state/bin/host-tmux-selection-gate.sh" <<'EOF'
#!/usr/bin/env bash
printf 'host-tmux-%s\n' "$1"
EOF
chmod +x "$rn_host_root/state/bin/host-tmux-selection-gate.sh"
printf 'candidate\n' > "$rn_host_root/candidates"
```

捕获两个 helper 的 stdout/stderr：

```bash
rn_gate_stdout="$(FLYWHEEL_STATE_DIR="$rn_host_root/state" \
  FLYWHEEL_DIR="$rn_host_root/repo" \
  restart_host_tmux_gate \
  1111111111111111111111111111111111111111 restart-lead-wave test-mount \
  2>"$rn_host_root/gate.err")"
rn_census_stdout="$(FLYWHEEL_STATE_DIR="$rn_host_root/state" \
  FLYWHEEL_DIR="$rn_host_root/repo" \
  restart_host_tmux_census "$rn_host_root/candidates" \
  2>"$rn_host_root/census.err")"

[[ -z "$rn_gate_stdout" && -z "$rn_census_stdout" ]] \
  && grep -qxF host-tmux-gate "$rn_host_root/gate.err" \
  && grep -qxF host-tmux-verify "$rn_host_root/gate.err" \
  && grep -qxF host-tmux-census "$rn_host_root/census.err"
```

- [ ] **Step 2: 运行测试并验证 RED**

Run: `bash scripts/test-restart-services.sh`

Expected: FAIL，helper stdout 捕获值包含 `host-tmux-gate` / `host-tmux-verify` / `host-tmux-census`；这直接复现生产者违反机器通道合同。

### Task 2: 在共享 helper 边界恢复单行统计合同

**Files:**

- Modify: `scripts/restart-services.sh:593-656`
- Test: `scripts/test-restart-services.sh`
- Verify unchanged: `scripts/__tests__/host-tmux-selection-restart-mounts.test.sh:91-110`

- [ ] **Step 1: 让两个共享 helper 永远 stderr-only**

```bash
"$gate_bin" gate "$carrier" 1>&2 || rc=$?
```

```bash
"$gate_bin" verify "$carrier" 1>&2 || rc=$?
```

```bash
"$gate_bin" census "$candidates_file" 1>&2
```

在 helper 注释中写明 stdout discipline。`do_restart_all_leads` 的两个调用行保持逐字节不变，使 line-anchored CI 结构测试继续覆盖原顺序；preflight 的 stdout/stderr 本来都进入 updater 日志，因此诊断可见性不变。

- [ ] **Step 2: 运行测试并验证 GREEN**

Run: `bash scripts/test-restart-services.sh`

Expected: 新 helper 测试 PASS，`FLY-1603 skip-test is skipped without counting` 仍 PASS，整个脚本 0 failures。

- [ ] **Step 3: 运行 host-tmux 结构套件**

Run: `bash scripts/__tests__/host-tmux-selection-restart-mounts.test.sh`

Expected: 5 passed, 0 failed；尤其 `Lead wave gate/candidate/census ordering` 继续 PASS。

- [ ] **Step 4: 提交统计合同修复**

```bash
git add scripts/restart-services.sh scripts/test-restart-services.sh
git commit -m "fix(FLY-1926): isolate Lead restart count stdout"
```

- [ ] **Step 5: 更新 progress**

Run:

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js progress \
  --exec-id a7fe146c-b94f-4093-a531-e38e87b95fa3 \
  --file engineering/doc/FLY-1926-updater-bridge-recheck/progress.md \
  --phase implement --cursor 4/6 --set-chunk lead_count_contract=done \
  --next "TDD Bridge observation semantics"
```

### Task 3: 用测试锁定“观测不到不等于 degraded”

**Files:**

- Modify: `scripts/test-restart-services.sh`（restart-notify renderer 测试与完整 fixture case 9）
- Modify: `scripts/__tests__/launchd-census-wiring.test.sh`（renderer arg-20 兼容测试）
- Test: `scripts/test-restart-services.sh`
- Test: `scripts/__tests__/launchd-census-wiring.test.sh`

- [ ] **Step 1: 添加 clean + unavailable renderer 用例**

```bash
unavailable_observation=$(rn_render_completion_message \
  "1111111" "2222222" "updater" 3 0 0 "" "" known "" \
  unavailable - "8s" healthy "pid=222" 3 0 0 "" passed)
unavailable_first_line="${unavailable_observation%%$'\n'*}"
[[ "$unavailable_observation" == *"✅ Flywheel 全量重启完成"* ]] \
  && [[ "$unavailable_observation" == *"启动健康检查通过"* ]] \
  && [[ "$unavailable_observation" == *"Lead 波前延迟观测未取得"* ]] \
  && [[ "$unavailable_first_line" != *"degraded"* ]]
```

同时把现有 clean `ok` renderer 用例和完整 fixture case 9 的 Bridge 行都改为要求 `Lead 波前 /health 实测 87ms`。用 `rg -n 'rn_render_completion_message' scripts scripts/__tests__` sweep 每个调用方，给现有 19 参数调用追加 arg 20 `passed`；`launchd-census-wiring.test.sh` 的 old18/with19 兼容测试也要显式传入 `passed`，避免 default=unknown 假改变其主题。

- [ ] **Step 2: 添加负向守卫**

复用真实 Lead failure 参数，把 Bridge observation 设为 `unavailable`、startup health 设为 `passed`，仍要求首行包含 `degraded` 和 Lead 名单。这证明只降级 observation，不吞真实故障。

再增加 startup health `unknown` 的输入，要求首行是 `状态未知` 而不是成功，证明 renderer 不从 observation 或调用路径猜测启动健康。

- [ ] **Step 3: 运行测试并验证 RED**

Run: `bash scripts/test-restart-services.sh`

Expected: FAIL，当前 renderer 不接受显式 startup-health 事实，unavailable 用例得到 `Bridge 复测异常`，且不存在新的波前措辞。

### Task 4: 将 renderer 改成健康判决 + 可选观测

**Files:**

- Modify: `scripts/lib/restart-notify.sh:110-240`
- Modify: `scripts/test-restart-services.sh`（全部 renderer 调用方）
- Modify: `scripts/__tests__/launchd-census-wiring.test.sh`（renderer arg 20）
- Test: `scripts/test-restart-services.sh`
- Test: `scripts/__tests__/launchd-census-wiring.test.sh`

- [ ] **Step 1: 增加独立 startup-health 事实并归一化 observation**

renderer 的第 20 个参数必须是独立事实：

```bash
local bridge_startup_state="${20:-unknown}"
case "$bridge_startup_state" in
  passed|unknown) ;;
  *) bridge_startup_state="unknown" ;;
esac
```

observation 只接受：

```bash
case "$bridge_state" in
  ok) [[ "$bridge_ms" =~ ^[0-9]+$ ]] || { bridge_state="unavailable"; bridge_ms="-"; } ;;
  unavailable) bridge_ms="-" ;;
  *) bridge_state="unavailable"; bridge_ms="-" ;;
esac
```

- [ ] **Step 2: 成功首行依赖 startup fact，不依赖 observation**

```bash
if [[ "$clean_leads" == "true" && "$watcher_state" == "healthy" \
  && "$bridge_startup_state" == "passed" ]]; then
    first_line="✅ Flywheel 全量重启完成 (reason=${reason})"
```

其他 Lead/watcher 分支顺序不变；删除仅由 Bridge observation fail 触发的“Bridge 复测异常”分支，并保留显式 terminal else：

```bash
else
    first_line="⚠️ Flywheel 全量重启结束 — 状态未知 (reason=${reason})"
fi
```

- [ ] **Step 3: 明确采样时点和未知语义**

```bash
if [[ "$bridge_state" == "ok" ]]; then
    bridge_line="Bridge: healthy (启动健康检查通过；Lead 波前 /health 实测 ${bridge_ms}ms)"
elif [[ "$bridge_startup_state" == "passed" ]]; then
    bridge_line="Bridge: 启动健康检查通过；Lead 波前延迟观测未取得"
else
    bridge_line="Bridge: 启动健康状态未知；Lead 波前延迟观测未取得"
fi
```

- [ ] **Step 4: 运行测试并验证 GREEN**

Run: `bash scripts/test-restart-services.sh`

Expected: renderer 的 clean、unavailable、startup unknown、Lead failure、watcher failure 全部 PASS；launchd census wiring 套件也 PASS。

### Task 5: 前移 Bridge observation 并删除假告警

**Files:**

- Modify: `scripts/test-restart-services.sh`（完整 restart fixture）
- Modify: `scripts/restart-services.sh:2770-2975`
- Test: `scripts/test-restart-services.sh`

- [ ] **Step 1: 先改 integration 期望为新语义**

在 fake `launchctl` 的 Lead kickstart 分支记录 probe marker 是否已存在：

```bash
if [[ -f "$BO_CALLS/prewave-probe" ]]; then
  printf 'probe-before-lead\n' >> "$BO_CALLS/order.calls"
else
  printf 'lead-before-probe\n' >> "$BO_CALLS/order.calls"
fi
```

把 fixture 的 `completion-probe` marker 和 `FAKE_COMPLETION_PROBE_FAIL` test env 全部改名为 `prewave-probe` / `FAKE_PREWAVE_PROBE_FAIL`；把 case 11 改为要求：

```bash
(( rc == 0 && tail_alerts == 0 )) \
  && grep -qxF probe-before-lead "$BO_CALLS/order.calls" \
  && echo "$discord_calls" | grep -q '✅ Flywheel 全量重启完成' \
  && echo "$discord_calls" | grep -q 'Lead 波前延迟观测未取得' \
  && ! echo "$discord_calls" | grep -q 'Bridge 复测异常' \
  && ! bo_calls lead-alert | grep -q 'bridge-completion-probe-failed'
```

fake `date +%s` 仍以 probe marker 在 1000/1123 间翻转。前移后 Lead 波内的 date 都读 1123，但 `SCRIPT_START_EPOCH` 仍在 marker 前读 1000，最终 `总耗时: 2m03s` 不变；同一 bounded loop 内没有跨翻转点比较。保留 case 9 的时长断言作为守卫。

- [ ] **Step 2: 运行测试并验证 RED**

Run: `bash scripts/test-restart-services.sh`

Expected: FAIL；当前 Lead kickstart 先于 marker，且仍发 `bridge-completion-probe-failed`。

- [ ] **Step 3: 前移现有有界探针**

在 `ensure_voice_bridge_for_deploy` 成功之后、`# Step 4: Restart Leads` 之前执行并保存：

```bash
local bridge_startup_state="passed"
local bridge_probe="" bridge_state="unavailable" bridge_ms="-"
bridge_probe=$(rn_probe_bridge_health "$BRIDGE_URL")
IFS=$'\t' read -r bridge_state bridge_ms <<< "$bridge_probe" || true
if [[ "$bridge_state" != "ok" || ! "$bridge_ms" =~ ^[0-9]+$ ]]; then
    bridge_state="unavailable"
    bridge_ms="-"
    log "WARNING: Bridge Lead-wave preflight latency observation unavailable; startup health and build identity already passed"
fi
```

`passed` 不是 renderer 推断：控制流只有在 15 分钟主健康循环和 build identity 都通过后才能到达此行。删除原来位于 launchd census 后的 probe 块，保证一次部署只采样一次；删除旧的 “end-of-restart Bridge response” 注释，把函数/test 注释统一称为 “Lead-wave preflight latency observation”。最终 `rn_render_completion_message` 调用追加第 20 参数 `"$bridge_startup_state"`。

- [ ] **Step 4: 删除 observation-only tail alert**

删除 `if [[ "$bridge_state" != "ok" ]]` 对 `tail_signature=bridge-completion-probe-failed` 和“服务可用性需人工确认”的拼接。真实 Lead/watcher tail 分支不动。

安全论证写进代码附近注释：该短探针只提供波前延迟 observation；真正波中/波后 Bridge 持续 down 由已加载的 `com.flywheel.bridge-liveness-probe` 每 60 秒执行、连续 5 次 down 后独立 page，不依赖 Bridge 进程或 deploy tail。

- [ ] **Step 5: 运行测试并验证 GREEN**

Run: `bash scripts/test-restart-services.sh`

Expected: 0 failures；prewave marker 在 Lead kickstart 前，observation unavailable 不告警，case 9 时长仍为 2m03s，真实 Lead degraded case 仍告警。

- [ ] **Step 6: 提交 Bridge 修复并更新 progress**

```bash
git add scripts/restart-services.sh scripts/lib/restart-notify.sh \
  scripts/test-restart-services.sh scripts/__tests__/launchd-census-wiring.test.sh
git commit -m "fix(FLY-1926): decouple Bridge observation from health"
```

更新 ledger 到 `tdd_implementation=done`，next 指向全仓 gates。

### Task 6: 验证、review、PR 与 implementation handoff

**Files:**

- Create: `engineering/doc/milestones/FLY-1926.md`
- Modify: `engineering/doc/FLY-1926-updater-bridge-recheck/progress.md`（由 comm CLI 独占更新）

- [ ] **Step 1: 聚焦静态与行为验证**

Run:

```bash
bash -n scripts/restart-services.sh scripts/lib/restart-notify.sh scripts/test-restart-services.sh
bash scripts/test-restart-services.sh
bash scripts/__tests__/launchd-census-wiring.test.sh
bash scripts/__tests__/host-tmux-selection-restart-mounts.test.sh
git diff --check
```

Expected: exit 0，shell test 报 0 failures，diff 无 whitespace error。

- [ ] **Step 2: 精确全仓 gates**

依次运行：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

shell 改动还必须逐个运行所有已注册且覆盖这些文件/合同的 CI 套件；不能用 TS gates 代替：

```bash
bash scripts/__tests__/packaged-restart.test.sh
bash scripts/__tests__/host-tmux-selection-restart-mounts.test.sh
bash scripts/__tests__/lead-restart-controlled-wave.test.sh
bash scripts/__tests__/setup-quota-monitor.test.sh
bash scripts/test-restart-services.sh
bash scripts/__tests__/restart-services-voice-bridge.test.sh
bash scripts/__tests__/restart-pull-preflight.test.sh
bash scripts/__tests__/restart-deploy-consistency.test.sh
bash scripts/__tests__/restart-services-admission-pause.test.sh
bash scripts/__tests__/restart-notify-routine.test.sh
bash scripts/__tests__/restart-services-notify.test.sh
bash scripts/__tests__/launchd-census-wiring.test.sh
bash scripts/__tests__/bridge-liveness-probe.test.sh
```

若实现时新增其他 `scripts/__tests__/*.test.sh`，同样逐个运行。

- [ ] **Step 3: 运行 code review gate**

先按仓库合同通过 `codex:rescue` 做 code review，再执行：

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js stage set code_review
review_gate_json="$(node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js gate review_code \
  --lead flywheel-eng-lead \
  --exec-id a7fe146c-b94f-4093-a531-e38e87b95fa3 \
  --no-block "Code review requested for FLY-1926")"
review_question_id="$(jq -er '.questionId' <<<"$review_gate_json")"
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js request-review \
  --type code --question-id "$review_question_id"
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js check \
  "$review_question_id"
```

轮询到 APPROVED；若 CHANGES_REQUESTED，按 finding TDD 修复、推新 head、开新 review gate。

- [ ] **Step 4: 创建 milestone 作为 literal last commit**

在 review 和 gates 均基于最终代码 head 通过后，用 `apply_patch` 新建 milestone，记录行为、测试、review 与未部署边界；随后：

```bash
git add engineering/doc/milestones/FLY-1926.md
git commit -m "docs(milestone): record FLY-1926 updater repair"
```

正常路径此后不再提交任何文件；milestone 是打开 PR 时的 literal last commit。

- [ ] **Step 5: push、开 PR、核对 exact head**

push 当前 feature branch，使用 `gh pr create`，运行 `stage set pr_created`，确认 PR diff、head SHA 和 checks。GitHub Actions billing 若仍拒载，按 Lead 指令记录为外部状态，不把本地全绿冒充 CI。

若 CI 实际执行后出现代码/测试红灯，completion 仍禁止：先读 exact-head job 日志，按 TDD 修复，重跑聚焦 + 全仓 + 上述 shell suites，开新的 code-review gate；随后更新 milestone 证据并再提交一次，使更新后的 milestone 重新成为 literal last commit，再 fast-forward push。这个 repair loop 可重复直到真实红灯消失。只有明确的 GitHub Actions billing 拒载可以按 Lead 的现有指令以“CI 未运行”状态交 review，不能写成 CI green。

- [ ] **Step 6: Lead report 与 bounded completion**

对收到的 `[lead-instruction f0c5afb4-7072-4ec5-9036-cd9eb63cf565]` 发送完整 DONE report（含 commits 和 PR URL），再运行：

```bash
pr_number="$(gh pr view --json number --jq '.number')"
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js complete \
  --route needs_review --pr "$pr_number"
```

不得 dispatch QA、请求 ship、merge、deploy 或重启服务。
