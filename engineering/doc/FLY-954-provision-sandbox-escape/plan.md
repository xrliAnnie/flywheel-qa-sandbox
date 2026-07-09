# FLY-954 provision 测试沙箱逃逸 — 实施计划

Issue: FLY-954 (https://linear.app/geoforge3d/issue/FLY-954/infraprovisioning-provision-测试沙箱逃逸-12-字节-stub-覆盖真-flywheelbin-三脚本2026)
日期: 2026-07-07
基于: research.md(brainstorm gate 已批:方案 A + 不动 plist 指向 + lead-alert.sh 管道)

> **For agentic workers:** 本 plan 由三阶段管线的 Implement 阶段在**同一分支**(flywheel-FLY-954)执行,TDD(RED→GREEN→REFACTOR),按 Task 顺序做、频繁 commit。步骤用 checkbox 跟踪。

**Goal:** 「安装拷贝 == repo 源」从人脑约定升级为机器持续验证的硬不变量:provision 测试/手动跑 provisioner 结构性写不到真 `~/.flywheel`;写坏 bin 的任何路径当场 fail-loud 或自动收敛+告警;部署 kickstart 前必收敛。

**Architecture:** 四层防线——① provisioner(写入者)不再信任为运行时读取者设计的 env 优先级(unset + `--state-dir` flag);② 所有 bin 安装走共享 `assert_sane_script_source` + 原子安装;③ 安装拷贝 chmod 555 写保护;④ 新 `converge-flywheel-bin.sh` 挂三点(Lead 启动 / updater / 部署 kickstart 前)checksum 收敛 + `lead-alert.sh` 告警。

**Tech Stack:** bash(macOS 3.2 兼容,沿用各脚本现有风格)、既有 shell 测试套件形态(pass/fail 计数)、lead-alert.sh claims.db 告警管道、TS 仅类型面(AlertEventType)。

**不做(gate 已拍)**:不动任何 plist 指向(Bridge/updater 保持 repo 直跑、Lead 保持 bin 拷贝);不迁移 `~/.flywheel/bin` 三件套之外的脚本;不动 host-config.sh 的优先级(wrapper 运行时读取语义不变)。**Ship 后 Lead 需建 follow-up issue**:fleet 第二台机器时统一 plist 指向 bin 拷贝(挂 provisioning 系列)。

---

## File Map

| 文件 | 动作 | 职责 |
|---|---|---|
| `scripts/lib/script-sanity.sh` | 新建 | `assert_sane_script_source` + `install_script_atomic`(唯一合法安装形态) |
| `scripts/__tests__/script-sanity.test.sh` | 新建 | 上者单测(含 555 写保护证明) |
| `scripts/provision-fleet-host.sh` | 改 | unset 继承 env、`--state-dir` flag、安装循环走 helper |
| `scripts/__tests__/provision-fleet-host.test.sh` | 改 | fixture 升级为 sane 尺寸;新增 P8 逃逸回归/P9 --state-dir/P10 stub 源拒装/P11 写保护;helper 硬断言 |
| `scripts/__tests__/provision-linux.test.sh` | 改 | helper 硬断言(HOME ≠ 真 HOME) |
| `scripts/flywheel-setup.sh` | 改 | `_fs_provision` 追加 `--state-dir` |
| `scripts/flywheel-daemon.sh` | 改 | `install_wrapper` 走共享 helper(sanity + 555) |
| `scripts/lead-alert.sh` | 改 | kind enum + usage 注释加 `bin_integrity_drift` |
| `packages/teamlead/src/LeadAlertNotifier.ts` | 改 | `AlertEventType` union 加成员(parity convention) |
| `packages/teamlead/src/LeadWatchdog.ts` | 改 | `titleFor`/`bodyFor` 两个无 default 的 exhaustive switch 补 case(**必改**,noImplicitReturns 下不补直接 build fail) |
| `scripts/converge-flywheel-bin.sh` | 新建 | 三件套 checksum 收敛 + 修复 + 告警(单一真相) |
| `scripts/__tests__/converge-flywheel-bin.test.sh` | 新建 | 漂移修复/一致静默/源坏拒修/告警结果行 |
| `packages/teamlead/scripts/claude-lead.sh` | 改 | 挂点 a:每次 Lead 启动收敛(非致命) |
| `scripts/update-flywheel.sh` | 改 | 挂点 b:update_main 入口收敛(非致命) |
| `scripts/restart-services.sh` | 改 | 挂点 c:`do_restart_all_leads` 头部收敛(fail-loud) |

---

### Task 1: 共享 lib — script-sanity.sh

**Files:** Create `scripts/lib/script-sanity.sh`;Create `scripts/__tests__/script-sanity.test.sh`

- [ ] **Step 1.1 写失败测试** `scripts/__tests__/script-sanity.test.sh`:

```bash
#!/bin/bash
# FLY-954: unit tests for scripts/lib/script-sanity.sh — the shared sanity +
# atomic-install helpers every legitimate <state>/bin writer must use.
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../lib/script-sanity.sh
source "$REPO_ROOT/scripts/lib/script-sanity.sh"

SB="$(mktemp -d -t fly954-sanity-XXXXXX)"; trap 'rm -rf "$SB"' EXIT

# S1: the incident's 12-byte stub is rejected
echo '#!/bin/bash' > "$SB/stub.sh"
if ! assert_sane_script_source "$SB/stub.sh" 2>/dev/null; then
  pass "S1: 12-byte shebang-only stub rejected"
else fail "S1: stub accepted"; fi

# S2: comment-only file (large enough) is rejected
{ echo '#!/bin/bash'; for i in $(seq 1 200); do echo "# padding comment line $i"; done; } > "$SB/comments.sh"
if ! assert_sane_script_source "$SB/comments.sh" 2>/dev/null; then
  pass "S2: comment-only file rejected (no substantive lines)"
else fail "S2: comment-only accepted"; fi

# S3: a real script passes
{ echo '#!/bin/bash'; echo 'set -euo pipefail'; for i in $(seq 1 100); do echo "echo real-line-$i >/dev/null"; done; } > "$SB/real.sh"
if assert_sane_script_source "$SB/real.sh"; then
  pass "S3: real script accepted"
else fail "S3: real script rejected"; fi

# S4: missing source rejected
if ! assert_sane_script_source "$SB/nope.sh" 2>/dev/null; then
  pass "S4: missing source rejected"
else fail "S4: missing source accepted"; fi

# S5: install_script_atomic installs with mode 555 (write-protected)
mkdir -p "$SB/bin"
if install_script_atomic "$SB/real.sh" "$SB/bin/real.sh" && [ -f "$SB/bin/real.sh" ] && [ ! -w "$SB/bin/real.sh" ] && [ -x "$SB/bin/real.sh" ]; then
  pass "S5: atomic install lands read-only + executable"
else fail "S5: atomic install"; ls -l "$SB/bin"; fi

# S6: write-protection proof — the incident's bare cp now fails loudly
if ! cp "$SB/stub.sh" "$SB/bin/real.sh" 2>/dev/null; then
  pass "S6: bare cp over installed copy fails (EACCES) — incident shape blocked"
else fail "S6: bare cp overwrote a protected install"; fi

# S7: re-install over a protected copy succeeds (mv is not blocked by target perms)
if install_script_atomic "$SB/real.sh" "$SB/bin/real.sh"; then
  pass "S7: legitimate re-install over 555 copy succeeds (idempotent)"
else fail "S7: re-install blocked"; fi

# S8: degenerate source NEVER installs (dst untouched)
before="$(shasum -a 256 "$SB/bin/real.sh" | awk '{print $1}')"
if ! install_script_atomic "$SB/stub.sh" "$SB/bin/real.sh" 2>/dev/null \
   && [ "$(shasum -a 256 "$SB/bin/real.sh" | awk '{print $1}')" = "$before" ]; then
  pass "S8: stub source refused, existing install untouched"
else fail "S8: stub source installed or dst mutated"; fi

# S9 (Codex R1#4): the floor must NOT be weakenable via inherited env
if ! FLYWHEEL_SCRIPT_MIN_BYTES=1 bash -c "source '$REPO_ROOT/scripts/lib/script-sanity.sh'; assert_sane_script_source '$SB/stub.sh'" 2>/dev/null; then
  pass "S9: FLYWHEEL_SCRIPT_MIN_BYTES env is ignored (stub still rejected)"
else fail "S9: inherited env weakened the sanity floor"; fi

echo ""; echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
```

- [ ] **Step 1.2 跑测试确认 RED**:`bash scripts/__tests__/script-sanity.test.sh` → 预期 source 失败(lib 不存在)。
- [ ] **Step 1.3 写实现** `scripts/lib/script-sanity.sh`:

```bash
#!/bin/bash
# FLY-954: shared sanity checks + atomic install for <state>/bin runtime scripts.
#
# Incident 2026-07-06: the provisioner's bare `cp` installed 12-byte shebang-only
# test-fixture stubs into the real ~/.flywheel/bin (all three wrappers), and the
# next deploy kickstart took all 13 Leads down. Every legitimate writer of
# <state>/bin runtime scripts MUST go through these helpers:
#   assert_sane_script_source <file> [min_bytes]  — refuse degenerate sources
#   install_script_atomic <src> <dst>             — assert + same-dir tmp + atomic
#                                                   mv + chmod 555 (write-protected)
# mv is not blocked by target file perms (only directory perms), so legitimate
# re-installs need no unlock step; accidental `cp`/`>` hit EACCES and fail loudly.
#
# Sourcing only defines functions (no side effects) — same contract as
# host-config.sh / supervisor.sh. Bash 3.2 compatible.

# Floor is deliberately far below the real scripts (6.8K/9.2K/57.9K) but far
# above any stub. NOT env-tunable (Codex R1#4: a writer-side env knob would
# re-introduce exactly the inherited-env trust this issue removes — e.g. a
# sourced ~/.flywheel/.env could silently lower the floor to 1). Tests that
# need a smaller floor pass the EXPLICIT second arg when unit-testing this
# function directly; production installers never do, and install_script_atomic
# exposes no override at all.
FLYWHEEL_SCRIPT_MIN_BYTES=1024

assert_sane_script_source() {  # <file> [min_bytes(test-only)] → 0 sane, 1 + stderr reason
  local f="$1" min="${2:-$FLYWHEEL_SCRIPT_MIN_BYTES}"
  if [ ! -f "$f" ]; then
    echo "[script-sanity] source missing: $f" >&2; return 1
  fi
  local size
  size="$(wc -c < "$f" | tr -d ' ')"
  if [ "$size" -lt "$min" ]; then
    echo "[script-sanity] source too small (${size}B < ${min}B — stub?): $f" >&2; return 1
  fi
  # a sane script has at least one line that is not blank/comment/shebang
  if ! grep -qE '^[[:space:]]*[^#[:space:]]' "$f"; then
    echo "[script-sanity] no substantive lines (shebang/comment-only stub): $f" >&2; return 1
  fi
  return 0
}

install_script_atomic() {  # <src> <dst> → 0 installed, 1 + stderr reason (dst untouched on failure)
  local src="$1" dst="$2"
  assert_sane_script_source "$src" || return 1
  local dstdir tmp
  dstdir="$(dirname "$dst")"
  mkdir -p "$dstdir" || { echo "[script-sanity] mkdir failed: $dstdir" >&2; return 1; }
  tmp="${dst}.tmp.$$"
  if ! cp "$src" "$tmp" 2>/dev/null; then
    rm -f "$tmp"; echo "[script-sanity] cp to tmp failed: $src -> $tmp" >&2; return 1
  fi
  chmod 555 "$tmp" || { rm -f "$tmp"; echo "[script-sanity] chmod failed: $tmp" >&2; return 1; }
  if ! mv "$tmp" "$dst"; then
    rm -f "$tmp"; echo "[script-sanity] atomic mv failed: $tmp -> $dst" >&2; return 1
  fi
  return 0
}
```

- [ ] **Step 1.4 跑测试确认 GREEN**:`bash scripts/__tests__/script-sanity.test.sh` → `Results: 9 passed, 0 failed`。
- [ ] **Step 1.5 shellcheck**:`shellcheck -x scripts/lib/script-sanity.sh scripts/__tests__/script-sanity.test.sh`。
- [ ] **Step 1.6 Commit**:`git add scripts/lib/script-sanity.sh scripts/__tests__/script-sanity.test.sh && git commit -m "feat(FLY-954): script-sanity lib — sane-source assert + atomic 555 install"`

---

### Task 2: provisioner — 写入者不信任继承 env + 安装走 helper

**Files:** Modify `scripts/provision-fleet-host.sh`(参数区 :26-34/:55-69、lib 区 :80-85、`phase_flywheel_home` :297-303);Modify `scripts/__tests__/provision-fleet-host.test.sh`

- [ ] **Step 2.1 先升级测试 fixture(否则新 sanity 会把既有 P2 打红)**:`provision-fleet-host.test.sh:98-100` 的 fixture 循环

```bash
for f in flywheel-lead-wrapper.sh flywheel-bridge-wrapper.sh restart-services.sh; do
  echo '#!/bin/bash' > "$RR/scripts/$f"; chmod +x "$RR/scripts/$f"
done
```

改为(顺带消灭了毒害过生产的 12B fixture 形态本身;真实感 >1KB):

```bash
# FLY-954: fixture wrappers must PASS source sanity (the 12-byte stub shape is
# now exactly what the provisioner refuses to install — see P10 for that case).
for f in flywheel-lead-wrapper.sh flywheel-bridge-wrapper.sh restart-services.sh; do
  { echo '#!/bin/bash'
    echo "# sane fixture for $f (FLY-954)"
    i=1; while [ "$i" -le 60 ]; do echo "echo fixture-$f-line-$i >/dev/null"; i=$((i+1)); done
  } > "$RR/scripts/$f"
  chmod +x "$RR/scripts/$f"
done
```

- [ ] **Step 2.2 写失败测试(追加到套件尾部、P5 之前)** — P8 事故形态逃逸回归(**刻意不用 env -i**:要证明的就是不靠 env -i 也安全)、P9 `--state-dir`、P10 stub 源拒装、P11 写保护:

```bash
# ── P8 (FLY-954 INCIDENT REGRESSION): inherited FLYWHEEL_STATE_DIR must be
#     IGNORED by the provisioner (writer). Deliberately NOT env -i — this is
#     the exact 2026-07-06 escape shape (runner-born prod env + --home sandbox).
H8="$SANDBOX/home8"; mkdir -p "$H8"
FAKEPROD="$SANDBOX/fakeprod/.flywheel"; mkdir -p "$FAKEPROD/bin"
env PATH="$STUB_PATH" HOME="$H8" FLYWHEEL_PLATFORM=darwin \
  FLYWHEEL_STATE_DIR="$FAKEPROD" \
  bash "$PROVISION" --repo-root "$RR" --fleet-dir "$FLEET" --home "$H8" \
  --apply --skip-token-check >"$SANDBOX/prov8.log" 2>&1
P8RC=$?
if [ "$P8RC" -eq 0 ] && [ ! -f "$FAKEPROD/projects.json" ] \
   && [ -z "$(ls -A "$FAKEPROD/bin" 2>/dev/null)" ] \
   && [ -f "$H8/.flywheel/projects.json" ] \
   && grep -q 'ignoring inherited FLYWHEEL_STATE_DIR' "$SANDBOX/prov8.log"; then
  pass "P8: inherited FLYWHEEL_STATE_DIR ignored — writes land under --home, polluted target untouched, warn logged"
else
  fail "P8: escape regression (rc=$P8RC)"; ls -R "$SANDBOX/fakeprod" 2>/dev/null; tail -20 "$SANDBOX/prov8.log"
fi

# ── P9 (FLY-954): --state-dir is the ONLY way to redirect state writes ──────
H9="$SANDBOX/home9"; mkdir -p "$H9"
SD9="$SANDBOX/customstate"
run_prov "$H9" --apply --skip-token-check --state-dir "$SD9"
if [ "$PROV_RC" -eq 0 ] && [ -f "$SD9/projects.json" ] && [ -f "$SD9/bin/flywheel-lead-wrapper.sh" ]; then
  pass "P9: explicit --state-dir redirects state (projects.json + bin installs)"
else
  fail "P9: --state-dir (rc=$PROV_RC)"; tail -20 "$PROV_LOG"
fi

# ── P10 (FLY-954): a degenerate bin source must FAIL the provision loudly ───
RRBAD="$SANDBOX/repobad"; mkdir -p "$RRBAD/scripts"
cp -R "$RR/scripts/." "$RRBAD/scripts/"
echo '#!/bin/bash' > "$RRBAD/scripts/flywheel-lead-wrapper.sh"   # the incident stub
H10="$SANDBOX/home10"; mkdir -p "$H10"
env -i PATH="$STUB_PATH" HOME="$H10" FLYWHEEL_PLATFORM=darwin \
  bash "$PROVISION" --repo-root "$RRBAD" --fleet-dir "$FLEET" --home "$H10" \
  --apply --skip-token-check >"$SANDBOX/prov10.log" 2>&1
P10RC=$?
if [ "$P10RC" -ne 0 ] && [ ! -f "$H10/.flywheel/bin/flywheel-lead-wrapper.sh" ] \
   && ! grep -q '\[provision\] done\.' "$SANDBOX/prov10.log"; then
  pass "P10: 12-byte stub source → provision dies, nothing installed, no done."
else
  fail "P10: stub source was tolerated (rc=$P10RC)"; tail -10 "$SANDBOX/prov10.log"
fi

# ── P11 (FLY-954): installed copies are write-protected (555) ───────────────
W11="$H2/.flywheel/bin/flywheel-lead-wrapper.sh"   # installed by P2a earlier
if [ -f "$W11" ] && [ ! -w "$W11" ] && [ -x "$W11" ] \
   && ! cp "$RRBAD/scripts/flywheel-lead-wrapper.sh" "$W11" 2>/dev/null; then
  pass "P11: installed copy is 555 — bare cp over it fails (incident shape blocked)"
else
  fail "P11: write protection"; ls -l "$W11" 2>/dev/null
fi
```

注意:P11 依赖 P2 的 H2 安装产物,追加位置必须在 P2 之后;P8/P9/P10 相互独立。

- [ ] **Step 2.3 跑套件确认新用例 RED**:`bash scripts/__tests__/provision-fleet-host.test.sh` → P8(无 warn 行、fakeprod 被写)/P9(未知 flag exit 2)/P10(静默装成 12B)/P11(644 可写)失败,P0-P7 仍绿。
- [ ] **Step 2.4 实现 provisioner 修改**:

(a) 默认值区(`:32` 附近)加 `STATE_DIR_FLAG=""`;参数循环(`:63` 附近)加:

```bash
    --state-dir) STATE_DIR_FLAG="$2"; shift 2 ;;
```

usage(`:47` 附近)加一行:`  --state-dir DIR      custom state dir (the ONLY way to redirect state writes; inherited FLYWHEEL_STATE_DIR is ignored)`。

(b) 参数循环结束后、`[ -n "$FLEET_DIR" ] ||`(`:71`)之前插入:

```bash
# FLY-954: the provisioner is a WRITER — it must not trust env vars designed
# for runtime READERS (the wrappers). Incident 2026-07-06: a runner-born
# production FLYWHEEL_STATE_DIR silently outranked the test's --home sandbox
# (host-config.sh gives env top priority) and 12-byte fixture stubs were cp'd
# into the real ~/.flywheel/bin. State-dir intent now enters ONLY via
# --state-dir (or host.json stateDir); inherited env is discarded loudly.
if [ -n "${FLYWHEEL_STATE_DIR:-}" ]; then
  warn "ignoring inherited FLYWHEEL_STATE_DIR='${FLYWHEEL_STATE_DIR}' — writers only honor --state-dir / host.json"
fi
if [ -n "${FLYWHEEL_DIR:-}" ]; then
  warn "ignoring inherited FLYWHEEL_DIR='${FLYWHEEL_DIR}' — use --repo-root / host.json"
fi
unset FLYWHEEL_STATE_DIR FLYWHEEL_DIR
[ -n "$STATE_DIR_FLAG" ] && export FLYWHEEL_STATE_DIR="$STATE_DIR_FLAG"
```

(注:`warn()` 定义在 `:90`,位于此插入点之后——bash 函数需先定义后调用,故实际插入位置放在 helpers 区(`:91` `die()` 之后、`FLEET_DIR` 默认化逻辑连同 `:71-74` 一起**下移到 helpers 之后**;或把这段插到 `:105` `run()` 之后。实现时以「warn/die 已定义」为准,`:71-74` 的 FW/MANIFEST 推导本来就只依赖变量,挪动无副作用——`FW` 在 `main():509` 会被重算。)

(c) lib 区(`:85` 之后)加:

```bash
# shellcheck source=lib/script-sanity.sh
source "$SCRIPT_DIR/lib/script-sanity.sh"
```

(d) `phase_flywheel_home` 安装循环(`:297-303`)替换为:

```bash
  # install runtime bin scripts from the checkout (FLY-954: sanity + atomic +
  # write-protected 555 — a degenerate source must fail the provision loudly,
  # never install silently; bare cp is banned for <state>/bin).
  local f
  for f in flywheel-lead-wrapper.sh flywheel-bridge-wrapper.sh restart-services.sh; do
    if [ -f "$REPO_ROOT/scripts/$f" ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        plan "install (sanity+atomic+555) $REPO_ROOT/scripts/$f -> $FW/bin/$f"
      else
        log "exec: install_script_atomic $REPO_ROOT/scripts/$f $FW/bin/$f"
        install_script_atomic "$REPO_ROOT/scripts/$f" "$FW/bin/$f" \
          || die "bin script failed sanity/atomic install: $f"
      fi
    fi
  done
```

(e) 测试 helper `_iso_prov`(test.sh:56-64)里 `FLYWHEEL_STATE_DIR="$_home/.flywheel"` 一行**替换**为向 provisioner 传 `--state-dir "$_home/.flywheel"`(env -i jail 保留,双保险;flag 追加在固定参数后、`"$@"` 前,这样个别用例可再传 `--state-dir` 覆盖——参数循环后者胜):

```bash
_iso_prov() {
  local _path="$1" _home="$2"; shift 2
  env -i \
    PATH="$_path" \
    HOME="$_home" \
    FLYWHEEL_PLATFORM=darwin \
    bash "$PROVISION" --repo-root "$RR" --fleet-dir "$FLEET" --home "$_home" \
      --state-dir "$_home/.flywheel" "$@"
}
```

- [ ] **Step 2.5 跑套件确认全绿**:`bash scripts/__tests__/provision-fleet-host.test.sh` → P0-P11 全 pass。再跑 `bash scripts/__tests__/provision-linux.test.sh`(不传 STATE_DIR env,应不受影响)与 `bash scripts/__tests__/host-config.test.sh`(host-config.sh 未动,纯回归)。
- [ ] **Step 2.6 shellcheck**:`shellcheck -x scripts/provision-fleet-host.sh scripts/__tests__/provision-fleet-host.test.sh`。
- [ ] **Step 2.7 Commit**:`git commit -m "fix(FLY-954): provisioner ignores inherited state env — --state-dir flag + sanity/atomic/555 bin installs"`

---

### Task 3: flywheel-setup.sh 调用方适配

**Files:** Modify `scripts/flywheel-setup.sh:961-964`(`_fs_provision`)

- [ ] **Step 3.1 修改**(env PIN 保留无妨,值改经 flag 进入——unset 后 env PIN 已无效):

```bash
_fs_provision() {
  FLYWHEEL_STATE_DIR="$FLYWHEEL_SETUP_STATE_DIR" \
    bash "$FS_SCRIPT_DIR/provision-fleet-host.sh" \
    --fleet-dir "$FS_FLEET_DIR" --home "$HOME" --repo-root "$FS_REPO_ROOT" \
    --state-dir "$FLYWHEEL_SETUP_STATE_DIR" "$@"
}
```

同步更新其上方 `:955-960` 的注释:PIN 的机制说明改为「FLY-954 后 provisioner 忽略继承 env,状态根经 --state-dir 显式传入(与 wizard 的 .env/journal 同一状态根)」。

- [ ] **Step 3.2 跑 setup 套件回归**:`for t in scripts/__tests__/flywheel-setup-*.test.sh; do bash "$t" || echo "FAILED: $t"; done` → 全绿。若某 setup 测试的 fixture repo-root 里 wrapper 是小 stub 且走到 flywheel-home 阶段:把 fixture 升级成 sane 尺寸(照 Task 2 Step 2.1 形态)——这是**唯一**允许的补救(Codex R1#4:生产安装路径没有也不许有降级开关;`assert_sane_script_source` 的显式第二参仅限直接单测该函数)。
- [ ] **Step 3.3 Commit**:`git commit -m "fix(FLY-954): flywheel-setup passes --state-dir explicitly (provisioner no longer honors env pin)"`

---

### Task 4: flywheel-daemon.sh install_wrapper 硬化

**Files:** Modify `scripts/flywheel-daemon.sh:184-200`

- [ ] **Step 4.1 修改 `install_wrapper`**(保留原子语义,收敛到共享 helper;lib 从 daemon 自身位置解析,不依赖 FLYWHEEL_DIR):

```bash
install_wrapper() {
  local src="${FLYWHEEL_DIR}/scripts/flywheel-lead-wrapper.sh"
  local dst="${FLYWHEEL_BIN}/flywheel-lead-wrapper.sh"

  if [ ! -f "$src" ]; then
    error "Wrapper source not found: ${src}"
  fi

  # FLY-954: sanity + same-dir tmp + atomic mv + chmod 555 via the shared
  # helper — a degenerate source (the 12-byte stub incident) must fail loudly,
  # never become the live dispatch entrypoint for every Lead's KeepAlive.
  # shellcheck source=lib/script-sanity.sh
  source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/script-sanity.sh"
  if ! install_script_atomic "$src" "$dst"; then
    error "wrapper failed sanity/atomic install: ${src}"
  fi
  log "Wrapper installed: ${dst} (mode 555)"
}
```

- [ ] **Step 4.2 跑 daemon + fleet 套件回归**:`bash scripts/__tests__/flywheel-daemon-install-verify.test.sh && bash scripts/__tests__/flywheel-daemon-plist-env.test.sh && for t in scripts/__tests__/flywheel-fleet*.test.sh; do bash "$t" || echo "FAILED: $t"; done`。fixture wrapper(如 `flywheel-fleet.test.sh:64-69` 的小 heredoc)若被 sanity 拒:升级 fixture 为 sane 尺寸(唯一补救,同 Task 3 Step 3.2)。
- [ ] **Step 4.3 Commit**:`git commit -m "fix(FLY-954): daemon install_wrapper — shared sanity + atomic + 555"`

---

### Task 5: 告警管道加 kind — bin_integrity_drift

**Files:** Modify `scripts/lead-alert.sh:22,:97`;Modify `packages/teamlead/src/LeadAlertNotifier.ts:52-`;Modify `packages/teamlead/src/LeadWatchdog.ts`(`titleFor` `:937-` / `bodyFor` `:1014-` 两个 exhaustive switch,**必改**);Modify `scripts/__tests__/lead-alert-strict-delivery.test.sh`

- [ ] **Step 5.1** `lead-alert.sh:97` case 白名单追加 `|bin_integrity_drift`(行尾 `) ;;` 前);`:22` usage 注释的 kind 列表同步;case 上方注释块补一行:`# FLY-954: bin_integrity_drift — converge-flywheel-bin.sh 检出 <state>/bin 与 repo 源漂移(修复成功/失败/源坏拒修均响)。Same TS-union parity convention.`
- [ ] **Step 5.2** `LeadAlertNotifier.ts` `AlertEventType` union(`:52-`)追加:

```ts
	// FLY-954: <state>/bin runtime-script drift detected by
	// scripts/converge-flywheel-bin.sh (shell path via lead-alert.sh; the
	// Bridge never emits this kind itself — union parity only).
	| "bin_integrity_drift"
```

- [ ] **Step 5.3** `LeadWatchdog.ts` **必改**(Codex R1#3:`tsconfig.base.json:16-19` 开着 `noImplicitReturns`,`titleFor()`(`:937-`)与 `bodyFor()`(`:1014-`)都是无 default 的 exhaustive switch——不补 case 直接 build fail,这不是「若编译报再补」的不确定项):

`titleFor` 追加:

```ts
		case "bin_integrity_drift":
			return "bin runtime script drift";
```

`bodyFor` 追加:

```ts
		case "bin_integrity_drift":
			return "A ~/.flywheel/bin runtime script drifted from its repo source. This kind is emitted by scripts/converge-flywheel-bin.sh via lead-alert.sh (shell path) — the Watchdog never raises it; see the shell alert body for file + sha details (FLY-954).";
```

然后编译验证:`pnpm -C packages/teamlead build`。
- [ ] **Step 5.4**(Codex R1#2:告警层必须被**真实** shell enum 钉住——converge 的 `alert()` 是 `|| true` 且 Task 6 测试用 fake sink,若 allowlist 漏词,漂移告警会静默变 config_error)修改 `scripts/__tests__/lead-alert-strict-delivery.test.sh`:
  (a) 第 7 节(kind allowlist)追加一个真实 sent case(复用该套件既有的 HTTP-200 stub 机制,调用形态照抄第 7 节的直接调用):

```bash
# FLY-954: bin_integrity_drift is a real, accepted kind end-to-end
OUT=$(run_alert 200 --lead flywheel-eng-lead --kind bin_integrity_drift \
  --signature sig-bid --strict-delivery 2>/dev/null); RC=$?
if [ "$RC" = "0" ] && [ "$OUT" = "sent" ]; then
  ok "bin_integrity_drift accepted → sent (exit 0)"
else bad "bin_integrity_drift: rc=$RC out='$OUT'"; fi
```

(若 `run_alert` helper 将 kind 写死为 `restart_guard_bypass`,先把它参数化(kind 缺省保持 `restart_guard_bypass`,既有用例零改动)再加本用例;不许改用 fake sink。)
  (b) 第 8 节 parity grep 追加两条(照抄 `restart_guard_bypass` 两行形态):TS union 含 `"bin_integrity_drift"`、`lead-alert.sh` allowlist 含 `bin_integrity_drift`。
- [ ] **Step 5.5** 跑 alert 套件:`bash scripts/__tests__/lead-alert-strict-delivery.test.sh && bash scripts/__tests__/lead-alert-dirs.test.sh` + `ls scripts/__tests__ | grep -i alert` 下其余套件。
- [ ] **Step 5.6 Commit**:`git commit -m "feat(FLY-954): bin_integrity_drift alert kind (shell enum + TS union + Watchdog cases + strict-delivery parity test)"`

---

### Task 6: converge-flywheel-bin.sh(防线 ④ 单一真相)

**Files:** Create `scripts/converge-flywheel-bin.sh`;Create `scripts/__tests__/converge-flywheel-bin.test.sh`

- [ ] **Step 6.1 写失败测试** `scripts/__tests__/converge-flywheel-bin.test.sh`:

```bash
#!/bin/bash
# FLY-954: converge-flywheel-bin.sh — checksum+mode-converge <state>/bin
# runtime scripts to repo sources; repair + alert on drift; NEVER repair from
# an insane repo source. Hermetic: sandbox STATE_DIR + fake repo (the REAL
# converge script is COPIED into the fake repo and invoked there, so its
# self-derived SCRIPT_DIR/.. repo root points at the fake repo — no env seam
# for repair provenance, Codex R2#1) + stub alert sink (notification-only
# seam FLYWHEEL_CONVERGE_ALERT_BIN).
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }

REAL_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SB="$(mktemp -d -t fly954-converge-XXXXXX)"; trap 'rm -rf "$SB"' EXIT

# fake repo with sane sources + the REAL converge script + the REAL lib
FR="$SB/repo"; mkdir -p "$FR/scripts/lib"
cp "$REAL_REPO_ROOT/scripts/lib/script-sanity.sh" "$FR/scripts/lib/"
cp "$REAL_REPO_ROOT/scripts/converge-flywheel-bin.sh" "$FR/scripts/"
CONVERGE="$FR/scripts/converge-flywheel-bin.sh"
for f in flywheel-lead-wrapper.sh flywheel-bridge-wrapper.sh restart-services.sh; do
  { echo '#!/bin/bash'; i=1; while [ "$i" -le 80 ]; do echo "echo repo-$f-$i >/dev/null"; i=$((i+1)); done; } > "$FR/scripts/$f"
done
# stub alert sink (records invocations)
ALERT="$SB/alert.sh"
cat > "$ALERT" <<'EOF'
#!/bin/bash
echo "ALERT $*" >> "${ALERT_LOG:?}"
exit 0
EOF
chmod +x "$ALERT"

ST="$SB/state"; mkdir -p "$ST/bin"
run_converge() {
  ALERT_LOG="$SB/alerts.log" FLYWHEEL_STATE_DIR="$ST" \
  FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" \
    bash "$CONVERGE" >"$SB/out.log" 2>&1
}

# C1: drifted (the incident stub) → repaired + one alert
: > "$SB/alerts.log"
echo '#!/bin/bash' > "$ST/bin/flywheel-lead-wrapper.sh"
cp "$FR/scripts/flywheel-bridge-wrapper.sh" "$ST/bin/flywheel-bridge-wrapper.sh"
cp "$FR/scripts/restart-services.sh" "$ST/bin/restart-services.sh"
run_converge; RC=$?
if [ "$RC" -eq 0 ] \
   && cmp -s "$ST/bin/flywheel-lead-wrapper.sh" "$FR/scripts/flywheel-lead-wrapper.sh" \
   && [ ! -w "$ST/bin/flywheel-lead-wrapper.sh" ] \
   && [ "$(grep -c '^ALERT' "$SB/alerts.log")" -eq 1 ] \
   && grep -q 'bin_integrity_drift' "$SB/alerts.log"; then
  pass "C1: stub drift repaired to repo source (555) + exactly one alert"
else fail "C1: repair (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

# C2: converged state → silent no-op (no alert, exit 0)
: > "$SB/alerts.log"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && [ ! -s "$SB/alerts.log" ]; then
  pass "C2: converged → silent no-op"
else fail "C2: no-op (rc=$RC)"; cat "$SB/alerts.log"; fi

# C3: missing bin file → repaired
: > "$SB/alerts.log"
rm -f "$ST/bin/restart-services.sh"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && cmp -s "$ST/bin/restart-services.sh" "$FR/scripts/restart-services.sh"; then
  pass "C3: missing bin file re-installed"
else fail "C3: missing repair (rc=$RC)"; fi

# C5 (Codex R1#1): content matches but mode 644 → converge tightens to 555, silently
: > "$SB/alerts.log"
chmod 644 "$ST/bin/flywheel-lead-wrapper.sh"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && [ ! -w "$ST/bin/flywheel-lead-wrapper.sh" ] && [ ! -s "$SB/alerts.log" ]; then
  pass "C5: mode-only drift tightened to 555, no alert"
else fail "C5: mode convergence (rc=$RC)"; ls -l "$ST/bin"; cat "$SB/alerts.log" 2>/dev/null; fi

# C4: drift + INSANE repo source → alert, NOT repaired, exit non-zero
: > "$SB/alerts.log"
echo '#!/bin/bash' > "$FR/scripts/flywheel-bridge-wrapper.sh"     # repo side goes bad
chmod u+w "$ST/bin/flywheel-bridge-wrapper.sh" 2>/dev/null || true
echo 'echo drifted' >> "$ST/bin/flywheel-bridge-wrapper.sh"       # force drift
run_converge; RC=$?
if [ "$RC" -ne 0 ] && grep -q 'drifted' "$ST/bin/flywheel-bridge-wrapper.sh" \
   && grep -q 'insane' "$SB/alerts.log"; then
  pass "C4: insane repo source → alert only, bin untouched, non-zero exit"
else fail "C4: fail-safe (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

echo ""; echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
```

- [ ] **Step 6.2 跑测试确认 RED**(脚本不存在)。
- [ ] **Step 6.3 写实现** `scripts/converge-flywheel-bin.sh`:

```bash
#!/bin/bash
# FLY-954: converge <state>/bin runtime scripts to their repo sources.
#
# "Installed copy == repo source" is a machine-verified invariant now
# (incident 2026-07-06: 12-byte stubs sat in ~/.flywheel/bin for 8 hours;
# the nightly deploy kickstart then took all 13 Leads down). Single source
# of truth for that convergence; mounted at three points:
#   • claude-lead.sh          — every Lead start           (non-fatal)
#   • update-flywheel.sh      — daily sweep + self-ship    (non-fatal; the ONLY
#                               self-heal path that does not depend on a
#                               possibly-broken lead wrapper: its plist execs
#                               the repo script directly)
#   • restart-services.sh::do_restart_all_leads — pre-kickstart (FAIL-LOUD:
#                               kickstarting a corrupt wrapper = fleet down)
#
# Invariant per file = content checksum matches repo source AND mode is 555
# (Codex R1#1: a manually-restored 644 copy must not stay writable until the
# next provision). Per file:
#   content+mode match → silent no-op
#   content match, mode != 555 → chmod 555 (log only, no alert — not a
#                                content breach; keeps first fleet-wide
#                                rollout quiet)
#   content drift/missing → repo source sane → atomic repair (tmp+mv+555)
#                           + ONE alert; repo source INSANE → alert only,
#                           NEVER repair (fail-safe: a mid-pull/corrupted
#                           repo must not be converged in).
# Exit: 0 = all healthy/repaired; 1 = at least one file left unhealthy.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repo source of truth is SELF-DERIVED from this script's own location — the
# converger is a WRITER (it repairs bin from $REPO_ROOT/scripts/*), so it must
# not let inherited env redefine its source root (Codex R2#1; same principle
# as the provisioner's env-unset). The hermetic test copies this script into
# its fake repo and invokes THAT copy, so SCRIPT_DIR/.. resolves naturally.
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"
BIN_DIR="$STATE_DIR/bin"
# Notification-only test seam: redirects WHERE alerts go, never repair
# provenance (repair sources stay pinned to $REPO_ROOT above).
ALERT_BIN="${FLYWHEEL_CONVERGE_ALERT_BIN:-$SCRIPT_DIR/lead-alert.sh}"
ALERT_LEAD="${FLYWHEEL_CONVERGE_ALERT_LEAD:-flywheel-eng-lead}"
ALERT_PROJECT="${FLYWHEEL_CONVERGE_ALERT_PROJECT:-flywheel}"

# shellcheck source=lib/script-sanity.sh
source "$SCRIPT_DIR/lib/script-sanity.sh"

FILES="flywheel-lead-wrapper.sh flywheel-bridge-wrapper.sh restart-services.sh"

log() { echo "[converge-bin] $*"; }
sha() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; }
mode_of() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null; }
alert() {  # <title> <body> <signature> — best-effort (claims.db dedup inside)
  bash "$ALERT_BIN" \
    --lead "$ALERT_LEAD" --project "$ALERT_PROJECT" \
    --kind bin_integrity_drift --severity severe \
    --title "$1" --body "$2" --signature "$3" || true
}

rc=0
for f in $FILES; do
  src="$REPO_ROOT/scripts/$f"; dst="$BIN_DIR/$f"
  if [ ! -f "$src" ]; then log "WARN: repo source missing: $src (skip)"; continue; fi
  src_sha="$(sha "$src")"; dst_sha="$(sha "$dst")"
  if [ -n "$dst_sha" ] && [ "$src_sha" = "$dst_sha" ]; then
    # content converged — enforce the MODE half of the invariant (Codex R1#1)
    mode="$(mode_of "$dst")"
    if [ "$mode" != "555" ]; then
      if chmod 555 "$dst"; then
        log "mode tightened: $f (${mode:-?} -> 555)"
      else
        log "ERROR: chmod 555 failed: $dst"; rc=1
      fi
    fi
    continue
  fi
  size="$(wc -c < "$dst" 2>/dev/null | tr -d ' ')"; size="${size:-0}"
  if ! assert_sane_script_source "$src"; then
    log "ERROR: $f drifted (bin ${size}B) but repo source failed sanity — NOT repairing (fail-safe)"
    alert "bin integrity: $f drifted, repo source insane" \
      "$dst (${size}B, sha ${dst_sha:-missing}) != repo source, and the repo source itself failed sanity (mid-pull/corrupt?). NOT auto-repaired — investigate the repo checkout." \
      "$f|insane|${src_sha:0:12}"
    rc=1; continue
  fi
  if install_script_atomic "$src" "$dst"; then
    log "repaired: $f (bin was ${size}B sha ${dst_sha:-missing}; now repo ${src_sha:0:12})"
    alert "bin integrity drift repaired: $f" \
      "$dst had drifted from the repo source (found ${size}B, sha ${dst_sha:-missing}). Auto-repaired to repo ${src_sha:0:12} (mode 555). Drift itself is abnormal — find the writer (FLY-954)." \
      "$f|repaired|${src_sha:0:12}"
  else
    log "ERROR: repair FAILED for $f"
    alert "bin integrity: repair FAILED for $f" \
      "$dst drifted (found ${size}B) and the atomic repair failed — manual intervention required (FLY-954 runbook: cp from repo + chmod 555)." \
      "$f|failfix|${src_sha:0:12}"
    rc=1
  fi
done
exit "$rc"
```

- [ ] **Step 6.4 跑测试 GREEN**:`bash scripts/__tests__/converge-flywheel-bin.test.sh` → `Results: 5 passed, 0 failed`。
- [ ] **Step 6.5 shellcheck** 两个新文件。
- [ ] **Step 6.6 Commit**:`git commit -m "feat(FLY-954): converge-flywheel-bin — checksum converge + repair + bin_integrity_drift alert"`

---

### Task 7: 三个收敛挂载点

**Files:** Modify `packages/teamlead/scripts/claude-lead.sh`(`:868` `install_restart_guard_hook()` 定义后 + `:897` 调用点后);Modify `scripts/update-flywheel.sh:177-184`(`update_main` 头);Modify `scripts/restart-services.sh:948-950`(`do_restart_all_leads` 头)

- [ ] **Step 7.1 claude-lead.sh**(挂点 a,非致命;形态逐字照 FLY-913 `install_restart_guard_hook`)。在 `install_restart_guard_hook()` 函数定义之后加:

```bash
# ── FLY-954: converge <state>/bin runtime scripts (anti-drift) ──────────────
# Incident 2026-07-06: 12-byte stubs sat in ~/.flywheel/bin for 8h, then a
# deploy kickstart took all 13 Leads down. Every Lead start now verifies
# installed-copy == repo-source and repairs + alerts on drift. Single source
# of truth: scripts/converge-flywheel-bin.sh (FLY-913 convergence pattern).
# NOTE this mount heals bridge-wrapper/restart-services copies and day-to-day
# drift only — a broken lead-wrapper cannot heal itself from here (this code
# runs AFTER the wrapper already worked); the updater + pre-kickstart mounts
# cover that case. Non-fatal: a Lead must still boot if convergence hiccups.
converge_flywheel_bin() {
  if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" = "1" ]; then
    log "DRY-RUN: skipping flywheel-bin convergence"
    return
  fi
  local converger="${FLYWHEEL_ROOT}/scripts/converge-flywheel-bin.sh"
  if [ ! -f "$converger" ]; then
    log "WARNING: converge-flywheel-bin.sh not found: $converger"
    return
  fi
  if bash "$converger" >/dev/null 2>&1; then
    log "flywheel-bin convergence OK"
  else
    log "WARNING: flywheel-bin convergence left unhealthy state (non-fatal; alert sent via lead-alert)"
  fi
}
```

在 `:897` 的 `install_restart_guard_hook` 调用块之后加(every role,同 FLY-913 全局机器不变量理由):

```bash
# FLY-954: converge <state>/bin runtime scripts on every Lead start — global
# machine invariant (installed copy == repo source), same rationale as the
# restart guard above.
converge_flywheel_bin
```

- [ ] **Step 7.2 update-flywheel.sh**(挂点 b,非致命)。`update_main()`(`:177`)内、`trap 'ssq_lock_release' EXIT INT TERM` 行之后插入:

```bash
  # FLY-954: converge <state>/bin BEFORE any deploy decision. This job's plist
  # execs the repo script directly, so it is the ONLY self-heal path that does
  # not depend on a possibly-broken lead wrapper (a stub wrapper exits 0
  # instantly — Lead-start convergence never runs). Non-fatal: deploy
  # availability wins (FLY-739 principle); drift alerts via lead-alert.sh.
  if ! bash "${SCRIPT_DIR}/converge-flywheel-bin.sh" >/dev/null 2>&1; then
    log "converge-flywheel-bin reported unhealthy state (non-fatal; continuing)"
  fi
```

- [ ] **Step 7.3 restart-services.sh**(挂点 c,fail-loud)。`do_restart_all_leads()`(`:948`)函数体开头插入(stdout 契约 = `skipped:N failed:M`(`:940` 注释/`:1011`),收敛输出必须走 stderr;失败经既有 failed 通道让部署中止、deployed-sha 不推进):

```bash
    # FLY-954: converge <state>/bin BEFORE kickstarting any Lead — kickstarting
    # a corrupted wrapper takes the fleet down (2026-07-06: 12-byte stub +
    # KeepAlive throttling = 13 Leads offline). FAIL-LOUD: if convergence
    # cannot leave bin healthy, refuse the whole Lead restart wave (reported
    # through the existing skipped/failed stdout contract; deploy aborts and
    # deployed-sha does not advance).
    local _conv_dir
    _conv_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -f "${_conv_dir}/converge-flywheel-bin.sh" ]; then
        if ! bash "${_conv_dir}/converge-flywheel-bin.sh" >&2; then
            log "ERROR: flywheel-bin convergence failed — refusing to kickstart Leads on a possibly-corrupt bin (FLY-954)" >&2
            echo "skipped:0 failed:1"
            return 1
        fi
    else
        # bin-copy execution context (fleet host): fall back to FLYWHEEL_DIR repo
        if ! bash "${FLYWHEEL_DIR}/scripts/converge-flywheel-bin.sh" >&2; then
            log "ERROR: flywheel-bin convergence failed — refusing to kickstart Leads (FLY-954)" >&2
            echo "skipped:0 failed:1"
            return 1
        fi
    fi
```

(说明:repo 里直跑时 `BASH_SOURCE` 同目录就有 converger;`~/.flywheel/bin/restart-services.sh` 拷贝被执行时同目录没有,fallback 到 `FLYWHEEL_DIR`(`:26` 已定义 `${HOME}/Dev/flywheel`)。失败路径 `failed:1` 会让 `:1168` 既有逻辑打 "1 lead(s) failed to restart. deployed-sha NOT advanced." 并 Discord 告警——数字语义略糙但复用既有 fail 通道、零新契约;真正的细节告警已由 converger 经 lead-alert 发出。)

- [ ] **Step 7.4 验证挂点**:
  - `FLYWHEEL_LEAD_DRY_RUN=1 bash -n packages/teamlead/scripts/claude-lead.sh` + grep 断言两处锚点存在:`grep -n 'converge_flywheel_bin' packages/teamlead/scripts/claude-lead.sh`(定义 + 调用各一)。
  - `bash -n scripts/update-flywheel.sh scripts/restart-services.sh`。
  - 跑既有套件回归:`bash scripts/__tests__/flywheel-lead-wrapper.test.sh`;`ls scripts/__tests__ | grep -iE 'update-flywheel|self-ship|restart'` 下的全部套件逐个跑绿(update-flywheel 的测试以 `UPDATE_FLYWHEEL_SOURCED=1` source,`update_main` 不自动执行,新插入行为对既有用例应零影响;若有用例直接调 `update_main`,其沙箱 STATE_DIR 下 converge 是 no-op/非致命,不改变断言)。
  - 手动冒烟(本 worktree,不碰生产):`FLYWHEEL_STATE_DIR=$(mktemp -d)/state bash scripts/converge-flywheel-bin.sh; echo $?` → 三件套被安装进沙箱 state(缺失→修复路径)+ exit 0。注意别裸跑(默认 STATE_DIR = 真 `~/.flywheel`——那是生产收敛动作,留给部署后)。
- [ ] **Step 7.5 Commit**:`git commit -m "feat(FLY-954): mount bin convergence — Lead start (non-fatal) + updater (non-fatal) + pre-kickstart (fail-loud)"`

---

### Task 8: 测试入口硬断言(issue 要求的结构性自检)

**Files:** Modify `scripts/__tests__/provision-fleet-host.test.sh`(helper 区);Modify `scripts/__tests__/provision-linux.test.sh`(helper 区 `:69` 附近)

- [ ] **Step 8.1** 两套件的 helper 定义前加(变量名按各自套件已有风格):

```bash
# FLY-954: hard isolation self-check — the sandbox HOME every provisioner
# invocation gets must NEVER be the invoking user's real HOME (defense against
# future edits that bypass the isolated helper; the 2026-07-06 escape ran with
# the real env because nothing asserted otherwise).
REAL_USER_HOME="$HOME"
_assert_sandboxed_home() {
  local h="$1"
  if [ -z "$h" ] || [ "$h" = "$REAL_USER_HOME" ]; then
    echo "FATAL(FLY-954): test HOME '$h' is the real user HOME — refusing to run" >&2
    exit 1
  fi
  case "$h" in
    "$SANDBOX"/*) ;;
    *) echo "FATAL(FLY-954): test HOME '$h' escapes sandbox $SANDBOX" >&2; exit 1 ;;
  esac
}
```

darwin `_iso_prov` 与 linux 套件的对应 helper(`:69` 的 env -i 调用封装)开头各加一行 `_assert_sandboxed_home "$_home"`(linux 侧参数名以实际为准)。linux 套件 `:129` 的第二处直接 env -i 调用若不经 helper,则在其前面显式调 `_assert_sandboxed_home "$H"`。

- [ ] **Step 8.2** 两套件重跑全绿;再做一次反向验证(临时把某处 home 改成 `$HOME` 跑一下确认 FATAL 拦截,改回)。
- [ ] **Step 8.3 Commit**:`git commit -m "test(FLY-954): provision suites hard-assert sandboxed HOME (never the real user HOME)"`

---

### Task 9: 全量回归 + 收尾

- [ ] **Step 9.1** 全 shell 套件:`for t in scripts/__tests__/*.test.sh; do echo "== $t"; bash "$t" >/tmp/fly954-t.log 2>&1 || { echo "FAILED: $t"; tail -20 /tmp/fly954-t.log; }; done` → 零 FAILED。
- [ ] **Step 9.2** TS/lint:`pnpm -r build && pnpm lint`(TS 只动了类型 union;lint 全仓干净是 push 前铁律)。
- [ ] **Step 9.3** shellcheck 全部改动脚本:`shellcheck -x scripts/provision-fleet-host.sh scripts/flywheel-daemon.sh scripts/lead-alert.sh scripts/converge-flywheel-bin.sh scripts/lib/script-sanity.sh scripts/update-flywheel.sh packages/teamlead/scripts/claude-lead.sh`(restart-services.sh 按既有基线,只保证不新增 warning)。
- [ ] **Step 9.4** progress.md 更新 + push + PR(PR body 链接 Linear FLY-954;按 APPROVE GATE 流程走 codex code review + 独立 QA)。

---

## 部署与验收说明(给 Implement/QA/Lead)

- **生效方式**:纯 shell 侧 = merge + 生产 `git pull` 即生效(provisioner/测试/converge 脚本都是调用时现读);挂点 a 随各 Lead 下次自然重启生效(**不需要**为此主动重启 fleet);挂点 b 随下次 updater 触发(每日 00:00/12:00 或下次 self-ship);挂点 c 随下次部署。TS union 是编译期类型,无行为变化,不需要 Bridge 重启。
- **首次生产收敛预期**:当前生产 bin 三件套是本 runner 手工 cp 恢复的(644,内容同 repo)。第一次 converge(下一个 Lead 自然重启 / updater 下次触发 / QA 显式跑一次)会因内容一致走 mode 收敛分支,**静默把 644 收紧到 555**(mode-only 修复只打日志不告警;内容漂移才告警——Codex R1#1)。QA 验收:生产显式跑一次 `bash scripts/converge-flywheel-bin.sh`(低风险:内容一致,只收紧 mode)+ 断言三件套 `[ ! -w ]`;修复+告警行为在**沙箱 STATE_DIR** 制造漂移验证,不要在生产制造漂移。
- **QA 红线(memory 已录)**:provisioner/converge 的任何测试一律走沙箱/容器,绝不在 host 上裸跑 `--apply`;本 plan 的所有新测试已 hermetic(P8 的「污染 env」也指向 SANDBOX 内的 fakeprod)。
- **Lead 收尾义务**:建 follow-up issue(fleet 第二台机器时统一 plist 指向 bin 拷贝,挂 provisioning 系列)——gate 已拍,Annie 早报知会。

## Implementation Addendum(实现期变更记录,2026-07-07)

1. **research.md §1.5「env 指错也无害」论断被实测推翻**(反例:既有 `update-flywheel-queue.test.sh` 沙箱 HOME 但继承生产 `FLYWHEEL_STATE_DIR`,经挂点 b 把分支版 restart-services.sh 写进真 `~/.flywheel/bin`;已止血恢复 main 版)。这是防线 ①「writer 不得信任继承 env」的又一实证——修复落测试侧:该套件 defense 块补 `FLYWHEEL_STATE_DIR` 沙箱(Task 8 同族;全仓审计确认执行 `update_main` 的仅此一个,`do_restart_all_leads` 无测试直接执行,claude-lead 系测试全走 DRY_RUN)。research.md 已同步修正。
2. **converge 告警加演习标记**(lead-instruction 4d224848,founder 被冒烟真告警吓到一次):`STATE_DIR != $HOME/.flywheel` 且未设 `FLYWHEEL_CONVERGE_PROD_STATE=1` 时,告警标题带 `🧪[sandbox test] ` 前缀(fail-safe 方向:宁误标演习,不吓 founder;未来 fleet 自定义 stateDir 生产机用该 env 关闭)。新增 C6/C7 用例钉住两种形态。
3. **converge size 读取小修**:缺失文件时 `wc -c < missing` 的 shell 重定向错误先于 `2>/dev/null` 生效,会在 fail-loud 挂点的 stderr 落噪音——改为 `[ -f ]` 先判。

## Self-Review(已跑)

- Spec 覆盖:issue 四条要求——①找真凶(exploration §1 取证完成,env -i 已由 #477 落地,本 plan ① 补结构性根治)✓;②测试硬隔离(Task 2 P8/P9 + Task 8 硬断言)✓;③provisioner 防御(Task 1/2/4:sanity+原子+555+fail-loud)✓;④收敛校验升必做(Task 5/6/7 三挂点)✓;founder 追问的三层防线(写保护/持续校验/根治写入源)分别对应 Task 1-2/6-7/2-3 ✓;架构拍板按 gate 结论落「不动 plist + follow-up」✓。
- Placeholder 扫描:无 TBD/TODO;所有代码块完整可照抄;fixture 升级与 min-bytes seam 的两选一处理给出了明确决策规则。
- 一致性:`install_script_atomic`/`assert_sane_script_source`/`converge_flywheel_bin`/`bin_integrity_drift` 命名各 Task 一致;P8-P11 编号与既有 P0-P7 连续;三挂点的 fatal/非致命语义与 exploration §5 防线 4 一致。
- Codex design review R1(4 项全采纳):① converge 不变量补 mode 半边(chmod 555 静默收紧 + 新 C5 用例 + 部署说明改写);② `lead-alert-strict-delivery.test.sh` 加真实 `bin_integrity_drift` sent 用例 + parity grep(不许 fake sink 代替);③ `LeadWatchdog.ts` 两个 exhaustive switch 定为必改并给定文案(noImplicitReturns);④ 移除 `FLYWHEEL_SCRIPT_MIN_BYTES` env seam(常量化 + 新 S9 反向用例;fixture 升级为唯一补救)。
- Codex design review R2(2 项全采纳):① 移除 `FLYWHEEL_CONVERGE_REPO_ROOT` env seam——converge 是 writer,repo 源只许 `SCRIPT_DIR/..` 自推;测试改为把真 converge 脚本 cp 进 fake repo 后调用那份拷贝(`FLYWHEEL_CONVERGE_ALERT_BIN` 保留,notification-only,不碰修复来源);② file map / Task 5 文件清单的「改(如需)」措辞改为必改。
