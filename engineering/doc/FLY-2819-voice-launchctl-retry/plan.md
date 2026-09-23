# FLY-2819 语音 launchd 迁移收敛 — 实施计划
Issue: FLY-2819 (https://linear.app/geoforge3d/issue/FLY-2819/班车部署阻塞-语音按需迁移-bootout-后立刻-bootstrap-失败报错被丢进-devnull-9-23-0000-pdt)
日期: 2026-09-23
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to execute every behavior change red → green, then superpowers:verification-before-completion before commits, review, push, and PR creation. This implement DAG node executes inline; it must not dispatch subagents or successor nodes.

**Goal:** 让 standalone voice 的 launchd on-demand 迁移在 bootout 异步卸载、bootstrap 短暂失败和“新 plist 已装但 label 缺失”三种状态下有界收敛，并保留可诊断的 launchctl stderr/退出码。

**Architecture:** 将既有 on-demand contract check 无语义变化地拆成磁盘契约与 loaded identity 两层。`restart-voice.sh` 新增只服务此 seam 的 absent 条件轮询和有限 bootstrap helper，并沿用 FLY-2758 已验证的 40 次 wait、5 次 bootstrap 与同名 tuning knobs；legacy 迁移与残留恢复共享 bootstrap/error 合同，但 legacy 会话探测和未知漂移 fail-closed 规则保持不变。

**Tech Stack:** Bash 3.2-compatible shell、macOS launchctl 协议、Python `plistlib`（既有）、stateful shell test doubles。

---

## 文件职责

- Modify: `scripts/lib/voice-on-demand.sh` — 暴露磁盘 on-demand 契约检查；原完整检查继续叠加 loaded identity，行为不变。
- Modify: `scripts/lib/restart-voice.sh` — absent wait、bootstrap 重试/错误保真、legacy 迁移调用、unregistered residual 恢复。
- Modify: `scripts/__tests__/restart-voice-on-demand.test.sh` — stateful launchctl stub 与八个独立回归场景（四条 issue 判据 + 契约可见性、恢复失败、生产 lazy source、tuning warning）。
- Modify: `scripts/__tests__/flywheel-voice-wrapper.test.sh` — 显式拦截 restart 测试中的 launchctl，证明不会落到真实 host。
- Create last: `engineering/doc/milestones/FLY-2819.md` — PR literal-last milestone commit。

## Task 1: RED — 为八个失败形态补可独立归因的回归测试

**Files:**

- Modify: `scripts/__tests__/restart-voice-on-demand.test.sh`
- Modify: `scripts/__tests__/flywheel-voice-wrapper.test.sh`

- [ ] **Step 1: 把 launchctl stub 改成有状态模型**

保留现有 `valid|missing|invalid` identity 行为，并用 `$ROOT/launchctl-state` 下的文件表达 bootout teardown、bootstrap 失败余量与 loaded/absent。stub 的核心状态转换必须是：

```bash
launchctl() {
  printf '%s\n' "$*" >> "$ROOT/launchctl-calls"
  case "$1" in
    bootout)
      local ticks=0
      [[ -f "$ROOT/launchctl-state/teardown-ticks" ]] &&
        ticks="$(cat "$ROOT/launchctl-state/teardown-ticks")"
      if [[ "$ticks" -gt 0 ]]; then
        printf '%s\n' "$ticks" > "$ROOT/launchctl-state/teardown-left"
      else
        : > "$ROOT/launchctl-state/absent"
      fi
      return 0
      ;;
    bootstrap)
      local count=0 remaining=0
      [[ -f "$ROOT/launchctl-state/bootstrap-count" ]] &&
        count="$(cat "$ROOT/launchctl-state/bootstrap-count")"
      printf '%s\n' "$((count + 1))" > "$ROOT/launchctl-state/bootstrap-count"
      if [[ -f "$ROOT/launchctl-state/bootstrap-fail-always" ]]; then
        echo 'Bootstrap failed: 5: Input/output error' >&2
        return 5
      fi
      [[ -f "$ROOT/launchctl-state/bootstrap-failures-left" ]] &&
        remaining="$(cat "$ROOT/launchctl-state/bootstrap-failures-left")"
      if [[ "$remaining" -gt 0 ]]; then
        printf '%s\n' "$((remaining - 1))" > "$ROOT/launchctl-state/bootstrap-failures-left"
        echo 'Bootstrap failed: 5: Input/output error' >&2
        return 5
      fi
      rm -f "$ROOT/launchctl-state/absent" "$ROOT/launchctl-state/teardown-left"
      if [[ -f "$ROOT/launchctl-state/registration-lag-ticks" ]]; then
        cp "$ROOT/launchctl-state/registration-lag-ticks" \
          "$ROOT/launchctl-state/registration-lag-left"
      fi
      : > "$ROOT/launchctl-state/loaded"
      return 0
      ;;
    print)
      if [[ -f "$ROOT/launchctl-state/teardown-left" ]]; then
        local left
        left="$(cat "$ROOT/launchctl-state/teardown-left")"
        if [[ "$left" -le 1 ]]; then
          rm -f "$ROOT/launchctl-state/teardown-left"
          : > "$ROOT/launchctl-state/absent"
        else
          printf '%s\n' "$((left - 1))" > "$ROOT/launchctl-state/teardown-left"
        fi
      fi
      if [[ "$LAUNCHCTL_MODE" == missing || -f "$ROOT/launchctl-state/absent" ]]; then
        echo 'Could not find service "com.flywheel.voice" in domain for user' >&2
        return 113
      fi
      if [[ -f "$ROOT/launchctl-state/registration-lag-left" ]]; then
        local lag
        lag="$(cat "$ROOT/launchctl-state/registration-lag-left")"
        if [[ "$lag" -gt 1 ]]; then
          printf '%s\n' "$((lag - 1))" > "$ROOT/launchctl-state/registration-lag-left"
          echo 'Could not find service "com.flywheel.voice" in domain for user' >&2
          return 113
        fi
        rm -f "$ROOT/launchctl-state/registration-lag-left"
      fi
      [[ "$LAUNCHCTL_MODE" == valid ]] || return 113
      printf '%s\n' \
        "${DOMAIN}/com.flywheel.voice = {" \
        $'\tpath = '"$INSTALLED" \
        $'\tprogram = /bin/bash' \
        $'\targuments = {' \
        $'\t\t/bin/bash' \
        $'\t\t'"$WRAPPER" \
        $'\t}' \
        $'\tstate = not running' \
        $'\tlast exit code = 0' \
        '}'
      ;;
  esac
}
```

测试 reset 必须完整隔离每个场景，而不是只清 state 子目录；同时定义 `sleep()` 只记录退避秒数、不真实等待，`log()` 把 restart 日志写入 fixture，`supervisor_is_loaded()` 读取可切换的 `SUPERVISOR_LOADED`：

```bash
reset_fly2819_launchctl_state() {
  rm -rf "$ROOT/launchctl-state"
  mkdir -p "$ROOT/launchctl-state"
  : > "$ROOT/launchctl-calls"
  : > "$ROOT/sleeps"
  : > "$ROOT/voice-restart.log"
  LAUNCHCTL_MODE=valid
  SUPERVISOR_LOADED=1
  VOICE_RESTART_STATE=not_attempted
  VOICE_RESTART_DETAIL=""
}
sleep() { printf '%s\n' "$1" >> "$ROOT/sleeps"; }
log() { printf '%s\n' "$*" >> "$ROOT/voice-restart.log"; }
SUPERVISOR_LOADED=1
supervisor_is_loaded() { [[ "${SUPERVISOR_LOADED:-1}" == 1 ]]; }
```

- [ ] **Step 2: 写八个聚合执行、独立计数的场景**

新增 `run_fly2819_case <name> <function>`，每个场景显式返回 0/1；全部跑完后若失败计数非零再退出。场景断言如下：

```bash
fly2819_waits_for_absent_before_bootstrap() {
  reset_fly2819_launchctl_state
  install_resident_bytes
  printf '2\n' > "$ROOT/launchctl-state/teardown-ticks"
  voice_migrate_to_on_demand "$SOURCE" "$INSTALLED" "$DOMAIN" || return 1
  local first_print bootstrap
  first_print="$(grep -n '^print ' "$ROOT/launchctl-calls" | head -1 | cut -d: -f1)"
  bootstrap="$(grep -n '^bootstrap ' "$ROOT/launchctl-calls" | head -1 | cut -d: -f1)"
  [[ -n "$first_print" && -n "$bootstrap" && "$first_print" -lt "$bootstrap" ]] || return 1
}

fly2819_retries_transient_bootstrap_failures() {
  reset_fly2819_launchctl_state
  install_resident_bytes
  printf '2\n' > "$ROOT/launchctl-state/bootstrap-failures-left"
  voice_migrate_to_on_demand "$SOURCE" "$INSTALLED" "$DOMAIN" || return 1
  [[ "$(cat "$ROOT/launchctl-state/bootstrap-count")" == 3 ]] || return 1
  [[ "$(cat "$ROOT/sleeps")" == $'1\n2' ]] || return 1
}

fly2819_reports_exhausted_bootstrap_error() {
  reset_fly2819_launchctl_state
  install_resident_bytes
  : > "$ROOT/launchctl-state/bootstrap-fail-always"
  ! voice_migrate_to_on_demand "$SOURCE" "$INSTALLED" "$DOMAIN" || return 1
  [[ "$(cat "$ROOT/launchctl-state/bootstrap-count")" == 5 ]] || return 1
  [[ "$VOICE_RESTART_DETAIL" == *'rc=5'* ]] || return 1
  [[ "$VOICE_RESTART_DETAIL" == *'Bootstrap failed: 5: Input/output error'* ]] || return 1
  grep -q 'Bootstrap failed: 5: Input/output error' "$ROOT/voice-restart.log"
}

fly2819_waits_for_registered_contract_visibility() {
  reset_fly2819_launchctl_state
  install_resident_bytes
  printf '2\n' > "$ROOT/launchctl-state/registration-lag-ticks"
  voice_migrate_to_on_demand "$SOURCE" "$INSTALLED" "$DOMAIN" || return 1
  [[ "$(cat "$ROOT/launchctl-state/bootstrap-count")" == 1 ]] || return 1
  [[ "$(grep -c '^print ' "$ROOT/launchctl-calls")" -ge 3 ]] || return 1
}

fly2819_recovers_installed_but_unregistered_contract() {
  reset_fly2819_launchctl_state
  sed "s#/Users/xiaorongli/Dev/flywheel#${FIXTURE_REPO}#g" \
    "$REPO_ROOT/scripts/launchd/com.flywheel.voice.plist" > "$SOURCE"
  cp "$SOURCE" "$INSTALLED"
  : > "$ROOT/launchctl-state/absent"
  SUPERVISOR_LOADED=0
  restart_voice_managed || return 1
  [[ "$VOICE_RESTART_STATE" == registered ]] || return 1
  [[ "$(cat "$ROOT/launchctl-state/bootstrap-count")" == 1 ]] || return 1
  voice_on_demand_contract_check "$FIXTURE_REPO" "$FIXTURE_HOME" "$DOMAIN"
}

fly2819_reports_unregistered_recovery_failure() {
  reset_fly2819_launchctl_state
  sed "s#/Users/xiaorongli/Dev/flywheel#${FIXTURE_REPO}#g" \
    "$REPO_ROOT/scripts/launchd/com.flywheel.voice.plist" > "$SOURCE"
  cp "$SOURCE" "$INSTALLED"
  : > "$ROOT/launchctl-state/absent"
  : > "$ROOT/launchctl-state/bootstrap-fail-always"
  SUPERVISOR_LOADED=0
  ! restart_voice_managed || return 1
  [[ "$VOICE_RESTART_STATE" == failed ]] || return 1
  [[ "$VOICE_RESTART_DETAIL" == *'rc=5'* ]] || return 1
  [[ "$VOICE_RESTART_DETAIL" == *'Bootstrap failed: 5: Input/output error'* ]] || return 1
}

fly2819_lazy_loads_contract_helpers_for_recovery() {
  reset_fly2819_launchctl_state
  sed "s#/Users/xiaorongli/Dev/flywheel#${FIXTURE_REPO}#g" \
    "$REPO_ROOT/scripts/launchd/com.flywheel.voice.plist" > "$SOURCE"
  cp "$SOURCE" "$INSTALLED"
  : > "$ROOT/launchctl-state/absent"
  SUPERVISOR_LOADED=0
  (
    unset -f voice_on_demand_contract_check voice_on_demand_disk_contract_check
    source "$REPO_ROOT/scripts/lib/restart-voice.sh"
    restart_voice_managed || return 1
    declare -F voice_on_demand_contract_check >/dev/null || return 1
    declare -F voice_on_demand_disk_contract_check >/dev/null || return 1
    [[ "$VOICE_RESTART_STATE" == registered ]]
  )
}

fly2819_invalid_tuning_warns_and_uses_default() {
  reset_fly2819_launchctl_state
  local value
  FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS=invalid
  value="$(voice_launchd_tuning FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS 5 '^[1-9][0-9]*$')"
  unset FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS
  [[ "$value" == 5 ]] || return 1
  grep -q "invalid FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS='invalid'; using default 5" \
    "$ROOT/voice-restart.log"
}
```

- [ ] **Step 3: 钉住 wrapper restart fixture，禁止真实 launchctl**

在 `scripts/__tests__/flywheel-voice-wrapper.test.sh` 的 unloaded restart 场景前增加 recorder stub，并把“零调用”写入通过条件：

```bash
: > "$ROOT/restart-launchctl-calls"
launchctl() {
  printf '%s\n' "$*" >> "$ROOT/restart-launchctl-calls"
  return 97
}
supervisor_is_loaded() { return 1; }
if output="$(restart_voice_managed 2>&1)" \
  && grep -q 'not loaded.*no-op' <<<"$output" \
  && [[ ! -s "$ROOT/restart-launchctl-calls" ]]; then
  pass "unloaded voice restart is an explicit no-op without launchctl mutation"
else
  fail "unloaded voice restart"
fi
```

- [ ] **Step 4: 运行 RED 并确认八格均因缺少目标行为失败**

Run:

```bash
bash scripts/__tests__/restart-voice-on-demand.test.sh
bash scripts/__tests__/flywheel-voice-wrapper.test.sh
```

Expected: exit nonzero；输出分别指出等待顺序、三次内瞬时恢复、五次耗尽后的错误 detail、bootstrap 后契约可见性、残留恢复成功、残留恢复失败保真、lazy source、非法 tuning warning 八格失败。失败不得来自测试语法、fixture 路径或真实 launchctl；wrapper 测试必须通过且 recorder 为空。

- [ ] **Step 5: 只提交红测与 launchctl safety pin**

```bash
git add scripts/__tests__/restart-voice-on-demand.test.sh scripts/__tests__/flywheel-voice-wrapper.test.sh
git commit -m "test(FLY-2819): cover voice launchd migration recovery"
```

## Task 2: GREEN — 拆出不放宽语义的磁盘契约检查

**Files:**

- Modify: `scripts/lib/voice-on-demand.sh`
- Test: `scripts/__tests__/restart-voice-on-demand.test.sh`
- Test: `scripts/__tests__/flywheel-voice-wrapper.test.sh`
- Test: `scripts/__tests__/install-voice-launchd.test.mjs`

- [ ] **Step 1: 提取磁盘契约 helper**

将现有行 24–46 原样移动到下列函数；完整检查改为先调用它，再执行原 loaded identity 检查：

```bash
voice_on_demand_disk_contract_check() {
  local repo="${1:-${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}}"
  local home_dir="${2:-${HOME}}"
  local source_plist="${repo}/scripts/launchd/com.flywheel.voice.plist"
  local installed_plist="${home_dir}/Library/LaunchAgents/com.flywheel.voice.plist"
  local wrapper="${repo}/scripts/flywheel-voice-wrapper.sh"

  [[ -f "$source_plist" && ! -L "$source_plist" ]] || return 1
  [[ -f "$installed_plist" && ! -L "$installed_plist" ]] || return 1
  [[ -f "$wrapper" && ! -L "$wrapper" && -x "$wrapper" ]] || return 1
  cmp -s "$source_plist" "$installed_plist" || return 1
  python3 - "$source_plist" "$installed_plist" "$wrapper" 2>/dev/null <<'PY' || return 1
import os,plistlib,stat,sys
plist_path,installed_path,wrapper=sys.argv[1:]
for path in (plist_path,installed_path,wrapper):
    info=os.lstat(path)
    assert stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid()
p=plistlib.load(open(plist_path,'rb'))
assert p.get('Label')=='com.flywheel.voice'
assert p.get('ProgramArguments')==['/bin/bash',wrapper]
assert 'Program' not in p and 'BundleProgram' not in p
assert p.get('RunAtLoad') is False and p.get('KeepAlive') is False
assert type(p.get('ThrottleInterval')) is int and p['ThrottleInterval']==1
assert not p.get('EnvironmentVariables')
PY
}
```

```bash
voice_on_demand_contract_check() {
  local repo="${1:-${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}}"
  local home_dir="${2:-${HOME}}"
  local domain="${3:-gui/$(id -u)}"
  local installed_plist="${home_dir}/Library/LaunchAgents/com.flywheel.voice.plist"
  local wrapper="${repo}/scripts/flywheel-voice-wrapper.sh"
  local loaded

  voice_on_demand_disk_contract_check "$repo" "$home_dir" || return 1
  loaded="$(launchctl print "${domain}/com.flywheel.voice" 2>/dev/null)" || return 1
  printf '%s\n' "$loaded" | voice_on_demand_loaded_identity "$installed_plist" "$wrapper"
}
```

- [ ] **Step 2: 运行受影响的现有契约测试**

Run:

```bash
bash scripts/__tests__/flywheel-voice-wrapper.test.sh
node --test scripts/__tests__/install-voice-launchd.test.mjs
```

Expected: 两个命令 exit 0；完整契约调用者行为不变。

## Task 3: GREEN — 实现条件等待、有限 bootstrap 与残留恢复

**Files:**

- Modify: `scripts/lib/restart-voice.sh`
- Test: `scripts/__tests__/restart-voice-on-demand.test.sh`

- [ ] **Step 1: 新增 absent、wait 与 bootstrap helper**

```bash
voice_launchd_tuning() {
  local name="$1" default="$2" pattern="$3" value
  if declare -F _sup_tuning >/dev/null 2>&1; then
    _sup_tuning "$name" "$default" "$pattern"
    return
  fi
  value="${!name:-}"
  if [[ -n "$value" && "$value" =~ $pattern ]]; then
    printf '%s\n' "$value"
  else
    if [[ -n "$value" ]]; then
      voice_restart_log "WARNING: invalid ${name}='${value}'; using default ${default}" >&2
    fi
    printf '%s\n' "$default"
  fi
}

voice_launchd_label_absent() {
  local target="$1" stderr rc=0
  stderr="$(launchctl print "$target" 2>&1 >/dev/null)" || rc=$?
  [[ "$rc" -ne 0 ]] || return 1
  printf '%s\n' "$stderr" | grep -qiE 'could not find service|no such process'
}

voice_wait_until_launchd_label_absent() {
  local target="$1" attempts interval attempt
  attempts="$(voice_launchd_tuning FLYWHEEL_SUPERVISOR_BOOTOUT_WAIT_ATTEMPTS 40 '^[1-9][0-9]*$')"
  interval="$(voice_launchd_tuning FLYWHEEL_SUPERVISOR_LAUNCHD_POLL_INTERVAL 1 '^[0-9]+$')"
  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    voice_launchd_label_absent "$target" && return 0
    [[ "$attempt" -ge "$attempts" ]] || sleep "$interval"
  done
  VOICE_RESTART_DETAIL="launchctl print did not confirm ${target} absent after ${attempts} attempts"
  voice_restart_log "ERROR: ${VOICE_RESTART_DETAIL}"
  return 1
}

voice_wait_until_on_demand_contract() {
  local repo="$1" home_dir="$2" domain="$3"
  local attempts interval attempt
  attempts="$(voice_launchd_tuning FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS 5 '^[1-9][0-9]*$')"
  interval="$(voice_launchd_tuning FLYWHEEL_SUPERVISOR_LAUNCHD_POLL_INTERVAL 1 '^[0-9]+$')"
  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    voice_on_demand_contract_check "$repo" "$home_dir" "$domain" && return 0
    [[ "$attempt" -ge "$attempts" ]] || sleep "$interval"
  done
  VOICE_RESTART_DETAIL="on_demand_contract_check_failed_after_bootstrap (${attempts} attempts)"
  voice_restart_log "ERROR: ${VOICE_RESTART_DETAIL}"
  return 1
}

voice_bootstrap_on_demand() {
  local domain="$1" installed="$2" repo="$3" home_dir="$4"
  local attempts interval attempt stderr rc
  attempts="$(voice_launchd_tuning FLYWHEEL_SUPERVISOR_BOOTSTRAP_ATTEMPTS 5 '^[1-9][0-9]*$')"
  interval="$(voice_launchd_tuning FLYWHEEL_SUPERVISOR_LAUNCHD_POLL_INTERVAL 1 '^[0-9]+$')"
  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    rc=0
    stderr="$(launchctl bootstrap "$domain" "$installed" 2>&1 >/dev/null)" || rc=$?
    if [[ "$rc" -eq 0 ]]; then
      voice_wait_until_on_demand_contract "$repo" "$home_dir" "$domain"
      return $?
    fi
    [[ -n "$stderr" ]] || stderr="<empty stderr>"
    VOICE_RESTART_DETAIL="launchctl bootstrap attempt ${attempt}/${attempts} failed rc=${rc}: ${stderr}"
    if [[ "$attempt" -ge "$attempts" ]]; then
      voice_restart_log "ERROR: ${VOICE_RESTART_DETAIL}"
      return 1
    fi
    voice_restart_log "WARNING: ${VOICE_RESTART_DETAIL}"
    sleep "$((attempt * interval))"
  done
  return 1
}
```

- [ ] **Step 2: 将 legacy 迁移接到新 helper**

`voice_migrate_to_on_demand` 保持参数与 legacy 安全门不变，只把内部顺序改为：bootout → wait absent → cp/chmod → bootstrap helper。cp/chmod 失败分别写明确 detail；不再丢弃 bootstrap stderr，也不在 helper 外重复 contract check。

```bash
voice_migrate_to_on_demand() {
  local source_plist="$1" installed="$2" domain="$3"
  local repo="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
  launchctl bootout "${domain}/com.flywheel.voice" >/dev/null 2>&1 || true
  voice_wait_until_launchd_label_absent "${domain}/com.flywheel.voice" || return 1
  cp "$source_plist" "$installed" || {
    VOICE_RESTART_DETAIL="copy_on_demand_plist_failed"; return 1;
  }
  chmod 0644 "$installed" || {
    VOICE_RESTART_DETAIL="chmod_on_demand_plist_failed"; return 1;
  }
  voice_bootstrap_on_demand "$domain" "$installed" "$repo" "$HOME"
}
```

- [ ] **Step 3: 保留 optional no-op，并在明确 absent 时恢复完整磁盘契约**

重排 `restart_voice_managed` 的开头时，必须保留生产唯一的 lazy source guard，并同时保证两个 contract helper 都已定义；随后声明全部路径变量并只调用一次 `supervisor_is_loaded`。若未 loaded，仅当磁盘契约完整且第二次 read-only probe 明确报告 absent 时恢复；未知 probe 错误继续走既有 `not_loaded` 成功 no-op。若 label 明确 absent 但五次 bootstrap 全失败，则诚实返回 1：这是一条新的 deploy rollback 路径，但此时 voice 已处于无注册 outage，成功 no-op 会虚报收敛。loaded 时才继续既有完整 registered/legacy 判断：

```bash
if ! declare -F voice_on_demand_contract_check >/dev/null 2>&1 \
  || ! declare -F voice_on_demand_disk_contract_check >/dev/null 2>&1; then
  # shellcheck source=voice-on-demand.sh
  source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/voice-on-demand.sh"
fi
local repo="${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}"
local domain="gui/$(id -u)"
local source_plist="${repo}/scripts/launchd/com.flywheel.voice.plist"
local installed="${HOME}/Library/LaunchAgents/com.flywheel.voice.plist"
local wrapper="${repo}/scripts/flywheel-voice-wrapper.sh"
local supervisor_loaded=false
if supervisor_is_loaded voice service >/dev/null 2>&1; then
  supervisor_loaded=true
fi

if [[ "$supervisor_loaded" != true ]]; then
  if voice_on_demand_disk_contract_check "$repo" "$HOME" \
    && voice_launchd_label_absent "${domain}/com.flywheel.voice"; then
    if voice_bootstrap_on_demand "$domain" "$installed" "$repo" "$HOME"; then
      VOICE_RESTART_STATE="registered"
      VOICE_RESTART_DETAIL="on-demand plist was installed but unregistered; registration restored"
      voice_restart_log "restored the missing voice on-demand registration"
      return 0
    fi
    VOICE_RESTART_STATE="failed"
    voice_restart_log "ERROR: voice on-demand registration recovery failed (${VOICE_RESTART_DETAIL})"
    return 1
  fi
  VOICE_RESTART_STATE="not_loaded"
  VOICE_RESTART_DETAIL="supervisor not loaded"
  voice_restart_log "voice unit not loaded; managed restart is a no-op"
  return 0
fi

if voice_on_demand_contract_check "$repo" "$HOME" "$domain"; then
  VOICE_RESTART_STATE="registered"
  VOICE_RESTART_DETAIL="on-demand registration already current; no process restart"
  voice_restart_log "voice on-demand registration already current; leaving the idle job dormant"
  return 0
fi
```

后续 legacy 安全门复用上面已声明的 `source_plist`、`installed`、`wrapper`。legacy 迁移失败分支只设置 state 并记录现有 detail，不再覆盖它：

```bash
VOICE_RESTART_STATE="failed"
[[ -n "$VOICE_RESTART_DETAIL" ]] || VOICE_RESTART_DETAIL="on_demand_migration_failed"
voice_restart_log "ERROR: voice on-demand migration did not converge (${VOICE_RESTART_DETAIL})"
return 1
```

- [ ] **Step 4: 运行 GREEN 与语法检查**

Run:

```bash
bash -n scripts/lib/voice-on-demand.sh
bash -n scripts/lib/restart-voice.sh
bash -n scripts/__tests__/restart-voice-on-demand.test.sh
bash scripts/__tests__/restart-voice-on-demand.test.sh
```

Expected: 三个 `bash -n` exit 0；行为测试打印八个 FLY-2819 场景 PASS 与总 `restart-voice-on-demand: PASS`。

- [ ] **Step 5: 重构且保持绿**

只消除测试 fixture 重复和 helper 命名歧义；不得改变与 FLY-2758 对齐的默认预算/tuning knobs，或改变 FLY-2701 会话探测/推迟规则。重跑 Step 4。

- [ ] **Step 6: 提交最小生产修复**

```bash
git add scripts/lib/voice-on-demand.sh scripts/lib/restart-voice.sh
git commit -m "fix(FLY-2819): converge voice launchd migration"
```

## Task 4: 聚焦回归、阴性对照与代码评审

**Files:**

- Verify: `scripts/lib/voice-on-demand.sh`
- Verify: `scripts/lib/restart-voice.sh`
- Verify: `scripts/__tests__/restart-voice-on-demand.test.sh`
- Verify: `scripts/__tests__/flywheel-voice-wrapper.test.sh`
- Verify: `scripts/__tests__/install-voice-launchd.test.mjs`
- Verify: `scripts/test-restart-services.sh`

- [ ] **Step 1: 运行所有直接相关 shell tests**

```bash
bash scripts/__tests__/restart-voice-on-demand.test.sh
bash scripts/__tests__/flywheel-voice-wrapper.test.sh
node --test scripts/__tests__/install-voice-launchd.test.mjs
bash scripts/test-restart-services.sh
```

Expected: 全部 exit 0，且每个套件打印实际通过计数/`PASS`；wrapper suite 的 restart launchctl recorder 必须为空，证明测试没有落到真实 host domain。不得把 focused 结果称作 full CI。

- [ ] **Step 2: 运行仓库 lint**

Run: `pnpm lint`

Expected: exit 0。若红，按 current HEAD 的完整输出归因并修复本次引入问题；不得用 grep 过滤后宣称干净。

- [ ] **Step 3: 做八格阴性对照**

在临时目录从基线 `8fc0fab1a` 导出旧 production 脚本、放入当前回归测试后运行；stateful test 会聚合八格结果，因此一次运行必须显示八个目标场景均失败。临时目录不得写工作树或生产 launchd。

```bash
scratch="$(mktemp -d)"
git archive 8fc0fab1a | tar -x -C "$scratch"
cp scripts/__tests__/restart-voice-on-demand.test.sh "$scratch/scripts/__tests__/restart-voice-on-demand.test.sh"
(cd "$scratch" && bash scripts/__tests__/restart-voice-on-demand.test.sh)
```

Expected: exit nonzero，八个 FLY-2819 scenario 都显示 FAIL；随后在当前工作树重跑同一测试必须全绿。

- [ ] **Step 4: 复核消费者扫描与 diff**

```bash
git grep -lF 'scripts/lib/restart-voice.sh'
git grep -lF 'restart-voice.sh'
git grep -lF 'voice-on-demand.sh'
git diff 8fc0fab1a...HEAD -- scripts/lib scripts/__tests__/restart-voice-on-demand.test.sh
```

逐个核对 research.md 已列直接消费者；父目录泛匹配只排除不引用这两个文件/函数的其他 lib 消费者。

- [ ] **Step 5: 请求 effective code review**

按 Codex runner contract：`stage set code_review`，创建 `gate review_code --no-block`，把返回的 questionId 赋给 `review_question_id`，再执行 `request-review --type code --question-id "$review_question_id"`，轮询 structured `reviewVerdict`。CHANGES_REQUESTED 必须修复并以新 head 重新请求；APPROVED advisories 通过 `ask --report` 转交 Lead。

## Task 5: Push、PR、literal-last milestone 与 handoff

**Files:**

- Create: `engineering/doc/milestones/FLY-2819.md`

- [ ] **Step 1: 在提交前检查 inbox 与 TURN**

运行注入的 `inbox --exec-id ...`，对每个 pending question id 执行 `check`；再次执行 `turn --exec-id ...` 并只在 `yours` 时继续。

- [ ] **Step 2: 将 milestone 作为 literal last commit**

`engineering/doc/milestones/FLY-2819.md` 记录 issue/PR/head、修改摘要、本地验证、阴性对照、无生产 launchd 验证边界和回滚方式。创建后只提交该文件并 push；此提交必须是 PR head 的最后一个 commit，之后不再改代码或其他 docs。

- [ ] **Step 3: Push feature branch，创建 PR**

推送 `flywheel-FLY-2819`，用 `gh pr create` 创建面向 `main` 的 PR。PR body 明确区分：focused local tests、code review、未做真实生产 launchctl/529 验证、full exact-head CI 由 QA 冻结头后请求。把返回的 PR number 赋给 `pr_number`；milestone 中的 PR 字段允许先写 branch-to-PR pending，PR 创建后不得再改 milestone，否则会破坏 literal-last 约束。

- [ ] **Step 4: closeout runner memory 与最终回执**

如本执行产生新的可复用判断，按 runner-memory 合同写最多 5 个 topic；否则保持不变并在报告说明。运行 `ask --report "DONE: ..."`，然后：

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js complete --route needs_review --pr "$pr_number"
```

不得 dispatch QA、运行 `ci-full ensure`、请求 ship approval、merge 或 deploy。
