# FLY-825 cmux 重启后同一 lead session 冒出两个 attach 视图 — 实施计划

Issue: FLY-825 (https://linear.app/geoforge3d/issue/FLY-825/infracmux-重启后同一-lead-session-冒出两个-attach-视图重复-tab-命令当-tab-名-heal-send)
日期: 2026-07-03
基于: exploration.md, research.md

## 目标

治两个独立但同属"cmux 簇"可靠性问题（Tadashi 已确认根因 + 已批准两个都在本 issue 修）：

1. **主症状**：`create_workspace_for_window` 在 `drain_events`（事件驱动 create 分支）
   和 `sync_additive`（60s 周期 missing-workspace 扫描）两条路径下可能针对同一个
   window_name 各自判"不存在"、各建一个 cmux tab，导致同一 lead session 挂两个 attach
   client + 两个 tab（其中一个因 rename 竞态而顶着原始 attach 命令当名字）。
2. **顺带发现**：`flywheel-cmux-install.sh` 的 `launchctl bootout` → `bootstrap`
   序列不等旧进程真正退出就起新的，留下孤儿常驻 watcher 进程（生产实测 pid 64108）。

## 改动清单

> **v2 修订说明（Codex Round 1 CHANGES REQUESTED 后）**：以下 6 处全部采纳 Codex 反馈：
> ①② 去重状态用 `window_name|window_id` 双键（不再只按标题）——生产实锤本来就是同一个
> window_id 被建两次，双键既治得了这个 bug，又不会误伤"同名新 window_id 的真实重启"；
> ③ 时间戳/TTL 全部照抄既有 `reap_orphan_workspace_pins` 的"digit-only 校验 + 长度上限 +
> `10#` 强制十进制"三件套，绝不裸算术，避免 `set -euo pipefail` 下非数字触发
> unbound-variable 杀死 watcher；④ 标记时机挪到 ready gate 通过之后、真正调用
> `cmux_call new-workspace` 之前，不再在"链接 session 还没 ready，本该重试"的分支上
> 误耗 TTL；⑤ 孤儿 watcher 的等待/收尾逻辑改放进 `flywheel-cmux-sync.sh` 本体（新增
> `--wait-for-watcher-exit` 子命令），而不是塞进没有 `BASH_SOURCE` 守卫、从第一行就有
> 副作用的 `flywheel-cmux-install.sh`——这样它天然可以被现有 `test-cmux-sync.sh` 的
> `source` 测试框架覆盖，install 脚本只改一行调用；⑥ 等待循环单位/阈值改成真 5 秒
> （原稿 0.5s×5 次判断=2.5s 的算术错误已修正），PID 逐个 kill + log，不用无差别 `pkill -f`。

### Change 1 — `create_workspace_for_window` 加进程内去重（主修复）

`scripts/flywheel-cmux-sync.sh`

**1a. 新状态文件 + TTL 常量**（紧跟 `HEAL_STATE` 之后，同样的
`"${VAR:-default}"` 可覆盖模式；TTL 校验挪到函数内部做，见 1b，不在这里裸用
`validated_int_env`——这台脚本靠自顶向下 source，`validated_int_env` 定义在文件更后面，
顶层声明时调不到）：

```diff
 HEAL_STATE="${HEAL_STATE:-/tmp/flywheel-cmux-heal.state}"
 CLEANUP_DELAY_SECONDS="${FLYWHEEL_CMUX_CLEANUP_DELAY:-30}"
 CONSERVATIVE_CLEANUP_SECONDS="${FLYWHEEL_CMUX_CONSERVATIVE_CLEANUP:-300}"
+
+# FLY-825: create-vs-create dedup. drain_events()'s event-driven "create" branch
+# and sync_additive()'s 60s missing-workspace scan can, within the SAME watch_loop
+# tick (ticks where tick % 4 == 0 run both), each independently decide a
+# workspace is "missing" for the same (window_name, window_id) and both call
+# create_workspace_for_window — producing two cmux tabs attached to the same
+# linked view_session (production repro 2026-07-03: `growth-mufasa-lead (@1210)`
+# created twice, 1s apart, IDENTICAL window_id — see exploration.md). Keyed by
+# window_name|window_id (not window_name alone) so a genuine restart — same name,
+# FRESH window_id — is never suppressed by this guard; only a true repeat call
+# for the exact same window instance is skipped. This state file is
+# process-local ground truth, independent of cmux's own workspace-list read
+# consistency (a second JSON read cannot fix this — it can observe the same
+# stale snapshot). Short TTL — long enough to span a same-tick double fire,
+# short enough that a same-name window closed-and-genuinely-recreated (new
+# window_id) minutes later is unaffected (and would use a different key anyway).
+CREATE_STATE="${CREATE_STATE:-/tmp/flywheel-cmux-create.state}"
```

**1b. guard 函数**（紧跟 `heal_state_clear`/`gc_heal_state_file` 之后，同样的
`awk -F'|'` 字面匹配模式，不用 bash 4 关联数组——这台机器 `/bin/bash` 是 3.2。TTL 与
每一行时间戳在使用前都过"digit-only → 长度上限 → `10#` 转十进制"三件套，跟
`reap_orphan_workspace_pins`/`validated_int_env` 的既有模式一致，绝不把未校验值
喂给 `(( ))`）：

```bash
# FLY-825: validated TTL — called at each guard entry (not once at top-level,
# since env can't change mid-run anyway; this just keeps the validation next to
# its only two call sites and avoids a load-order dependency on
# validated_int_env, which is defined later in this file). Same three-step
# pattern as reap_orphan_workspace_pins's `grace`: digit-only check, length cap
# (4 digits ≤ 9999s is far more than this guard will ever need), then use.
_create_dedup_seconds() {
  local v="${FLYWHEEL_CMUX_CREATE_DEDUP_SECONDS:-30}"
  case "$v" in ''|*[!0-9]*) v=30 ;; esac
  [[ ${#v} -gt 4 ]] && v=30
  echo "$((10#$v))"
}

# FLY-825: true (rc=0) if THIS EXACT (window_name, window_id) pair was created
# within the last CREATE_DEDUP_SECONDS. Best-effort — an unreadable/missing
# state file, or a corrupt/non-numeric stored timestamp, reads as "not recently
# attempted" (fail-open on the guard itself: the guard is a hardening layer,
# not a safety-critical gate — worst case on guard failure is reverting to
# pre-fix duplicate-tab behavior, never a hang or a false suppression of a real
# create).
create_recently_attempted() {
  local wname="$1" wid="$2" now ts dedup_seconds
  [[ -f "$CREATE_STATE" ]] || return 1
  now=$(date +%s)
  dedup_seconds=$(_create_dedup_seconds)
  ts=$(awk -F'|' -v n="$wname" -v w="$wid" '$1 == n && $2 == w { print $3; exit }' "$CREATE_STATE" 2>/dev/null || true)
  case "$ts" in ''|*[!0-9]*) return 1 ;; esac
  [[ ${#ts} -gt 12 ]] && return 1   # implausible/corrupt epoch → treat as not-recent
  (( now - 10#$ts < dedup_seconds ))
}

# FLY-825: record (window_name, window_id) as just-attempted. Idempotent
# overwrite (mktemp + rewrite, matching heal_state_clear's pattern) so a retry
# for the same pair refreshes the timestamp instead of growing the file.
create_mark_attempted() {
  local wname="$1" wid="$2" now tmp
  now=$(date +%s)
  touch "$CREATE_STATE" 2>/dev/null || return 0
  tmp=$(mktemp "${CREATE_STATE}.XXXX" 2>/dev/null) || return 0
  if ! awk -F'|' -v n="$wname" -v w="$wid" '!($1 == n && $2 == w) { print }' "$CREATE_STATE" > "$tmp" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    return 0
  fi
  printf '%s|%s|%s\n' "$wname" "$wid" "$now" >> "$tmp"
  mv "$tmp" "$CREATE_STATE" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
}

# FLY-825: GC rows older than the TTL (watcher startup — mirrors gc_heal_state_file).
# Same digit/length guard on each stored timestamp before arithmetic; a corrupt
# row is dropped (self-heals) rather than risking `(( ))` on a bad value.
gc_create_state_file() {
  [[ -f "$CREATE_STATE" ]] || return 0
  local now tmp dedup_seconds
  now=$(date +%s)
  dedup_seconds=$(_create_dedup_seconds)
  tmp=$(mktemp "${CREATE_STATE}.XXXX") || return 0
  while IFS='|' read -r name wid ts; do
    [[ -z "$name" || -z "$wid" ]] && continue
    case "$ts" in ''|*[!0-9]*) continue ;; esac
    [[ ${#ts} -gt 12 ]] && continue
    (( now - 10#$ts < dedup_seconds )) && printf '%s|%s|%s\n' "$name" "$wid" "$ts" >> "$tmp"
  done < "$CREATE_STATE"
  mv "$tmp" "$CREATE_STATE"
}
```

**1c. 挂到 `create_workspace_for_window` 里**（去重检查放最前面——比 cmux JSON 快照
更早、更便宜、不依赖 cmux socket；标记调用则挪到 ready gate **通过之后**、真正调用
`cmux_call new-workspace` **之前**——Codex Round 1 指出原稿放在"已存在快照检查"之后
就标记，会连"link session 还没 ready、本该在下一次 tick 重试"这种 defer 分支也算
一次尝试，白白吃掉 TTL）：

```diff
 create_workspace_for_window() {
   local source_session="$1"
   local window_id="$2"
   local window_name="$3"
   local view_session="${VIEW_PREFIX}${window_name}"
 
+  # FLY-825: skip if we already attempted a create for this EXACT
+  # (window_name, window_id) within the dedup TTL — prevents drain_events +
+  # sync_additive (same tick) from both creating a tab for the same window.
+  if create_recently_attempted "$window_name" "$window_id"; then
+    log "Skipping duplicate create for: $window_name ($window_id) (attempted within last $(_create_dedup_seconds)s)"
+    return 0
+  fi
+
   local raw_before
   raw_before=$(get_cmux_workspaces_json) || return 0  # JSON unavailable → skip
 
   # Existence check against the snapshot — inline so we never read rc=2 as
   # "not found" (workspace_exists_for would do the right thing but it'd
   # re-fetch JSON; we already have it).
   if printf '%s' "$raw_before" | python3 -c '...' "$window_name"; then
     return 0  # already exists, nothing to create
   fi
 
   log "Creating workspace for: $window_name ($window_id) from session $source_session"
 
   # 1. Create linked session ...
   if ! linked_session_exists "$view_session"; then
     tmux new-session -d -t "$source_session" -s "$view_session" 2>/dev/null || true
   fi
 
   # 2. (FLY-169 §2.6) Ready gate ...
   if ! linked_session_exists "$view_session" \
      || ! tmux select-window -t "=${view_session}:=${window_name}" 2>/dev/null; then
     log "WARN: $view_session not ready (session/select-window) — deferring create for $window_name"
     return 0
   fi
 
+  # FLY-825: mark AFTER the ready gate passes (this call site is truly
+  # committing to a create attempt) and BEFORE the cmux mutation, so a
+  # concurrent-tick duplicate call sees the mark even if the cmux IPC below
+  # is slow. A deferred (not-ready) call above never reaches here — it does
+  # NOT burn the TTL, so the next tick's retry is never suppressed.
+  create_mark_attempted "$window_name" "$window_id"
+
   # 3. refs_before from the snapshot we already have (no extra cmux call).
   local refs_before
   ...
   # 4. Create cmux workspace attaching to the linked session
   if ! cmux_call new-workspace --command "env -u TMUX tmux attach -t '=${view_session}'"; then
     log "WARN: cmux new-workspace failed for $window_name (see prior log lines)"
     return 0
   fi
   ...
```

**1d. 启动时 GC**（跟 `gc_heal_state_file` / `gc_stale_state_file` 一起，在
`watch_main` 成功获取锁之后调用一次）：

```diff
   gc_heal_state_file
+  gc_create_state_file
```

### Change 2 — 孤儿 watcher：新增 `--wait-for-watcher-exit` 子命令 + install 脚本改一行

**放在哪**：Codex Round 1 指出 `flywheel-cmux-install.sh` 从第一行起就有副作用
（`mkdir`、`ln -sf`、写 `~/.zshrc`、`defaults write`……）且没有 `BASH_SOURCE` 守卫，
把等待/kill 逻辑的函数定义塞在它的 launchd 分支里，没法被 `source` 单独测试。
`scripts/flywheel-cmux-sync.sh` 本身**已经**是可安全 `source` 的（文件末尾有
`if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then return 0 ...; fi` 守卫，
`test-cmux-sync.sh` 全程就是这么用它的）。所以把这段逻辑做成
`flywheel-cmux-sync.sh` 的一个新函数 + 新 CLI 子命令，`test-cmux-sync.sh` 直接
`source` 后调函数测试；`flywheel-cmux-install.sh` 只需要在 bootout 和 bootstrap
之间插一行调用，不需要自己重构。

**2a. `scripts/flywheel-cmux-sync.sh`** —— 新函数（放在 `_pid_is_watcher` 之后，
复用它已有的"是不是 watcher 命令行"判定风格）：

```bash
# FLY-825: bootout is not guaranteed synchronous — the old watcher process can
# outlive its launchd job record (production repro: pid 64108, no longer
# tracked by `launchctl list`, still alive + still the lock owner hours after
# a same-label bootout/bootstrap cycle). Poll for `flywheel-cmux-sync --watch`
# process(es) to actually disappear before the caller (install script)
# bootstraps a fresh instance, so a new launchd-tracked instance never has to
# coexist with a not-fully-dead predecessor. Bounded ~5s real time; falls
# through to an explicit, PID-targeted TERM-then-KILL (never a broad `pkill`)
# if bootout's own signal didn't land in time. Every PID killed is logged for
# audit. Exposed as its own function (not inlined in the install script) so it
# is covered by this file's existing bash-3.2 `source`-based test harness.
wait_for_watcher_exit() {
  local half_seconds=0 pids pid
  # 10 × 0.5s = 5s real deadline (Codex R1 #5: the original 0.5s-sleep/×1-count
  # loop only waited 2.5s before escalating — fixed by counting half-seconds
  # against a threshold of 10, not seconds against 5).
  while true; do
    pids=$(pgrep -f "flywheel-cmux-sync(\.sh)? +--watch" 2>/dev/null || true)
    [[ -z "$pids" ]] && return 0
    if (( half_seconds >= 10 )); then
      log "wait_for_watcher_exit: still alive after 5s, escalating to TERM/KILL: $pids"
      for pid in $pids; do
        log "wait_for_watcher_exit: TERM pid=$pid"
        kill -TERM "$pid" 2>/dev/null || true
      done
      sleep 1
      pids=$(pgrep -f "flywheel-cmux-sync(\.sh)? +--watch" 2>/dev/null || true)
      for pid in $pids; do
        log "wait_for_watcher_exit: KILL pid=$pid (survived TERM)"
        kill -KILL "$pid" 2>/dev/null || true
      done
      return 0
    fi
    sleep 0.5
    half_seconds=$((half_seconds + 1))
  done
}
```

新增 CLI 子命令（跟 `--refresh` 一样"从外面调用安全"）：

```diff
   --refresh)
     refresh_linked_sessions
     ;;
+  --wait-for-watcher-exit)
+    # FLY-825: called by flywheel-cmux-install.sh between bootout and
+    # bootstrap. Safe from outside cmux (no cmux socket needed — pure
+    # tmux/process-table operation, same tier as --refresh).
+    wait_for_watcher_exit
+    ;;
```

Codex R1 #6 的顾虑（"pkill -f 会杀掉主机上所有匹配的 flywheel-cmux-sync --watch，
不只是刚被 bootout 的那个"）——**这是有意为之，且现在逐 PID kill + log 使其可审计**：
这是单机单例 watcher，任何"额外匹配到的"进程本来就是需要被清掉的孤儿（正是本 issue
要修的那一类）。不再用一句不透明的 `pkill -f`，而是 `pgrep -f` 枚举 + 逐个 PID
`kill -TERM`/`kill -KILL` + 逐个 log，行为对外一致，但排查时能看清杀了谁。

**2b. `scripts/flywheel-cmux-install.sh`** —— 只改一行：

```diff
     launchctl bootout "gui/$(id -u)/$WATCHER_LABEL" 2>/dev/null || true
+    # FLY-825: give the bootout'd process a bounded chance to actually exit
+    # (SEE flywheel-cmux-sync.sh:wait_for_watcher_exit for why bootout alone
+    # is not enough) before bootstrapping a fresh instance.
+    "$REPO_DIR/scripts/flywheel-cmux-sync.sh" --wait-for-watcher-exit
     if launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST" 2>/dev/null; then
```

## 测试（TDD：先改断言 RED → 实现 GREEN）

### `scripts/test-cmux-sync.sh`

- **新增** Test：两次连续 `create_workspace_for_window "flywheel" "@1" "lead-a"`
  （`MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'` 全程不变，模拟两次调用各自的
  "建前"快照都看不到对方）→ 断言 `MOCK_CMUX_OPS` 里 `new-workspace` 只出现一次。
- **新增** Test：同一 `window_name`、**不同** `window_id`（模拟真实重启：旧 tab 已经
  没了，新窗口分配了新 id）→ 两次调用都应该真正创建（去重键不匹配，不能被误伤）。
- **新增** Test：`create_recently_attempted` / `create_mark_attempted` 单元行为——
  标记后立刻查询命中；不同 window_id 查询不命中；TTL 过期后查询不命中（直接往
  `CREATE_STATE` 写一个超过 TTL 的历史时间戳，不真的等待）；非数字/超长时间戳视为
  "未命中"而不是让脚本崩。
- **新增** Test：`_create_dedup_seconds` 对非数字 / 超长 `FLYWHEEL_CMUX_CREATE_DEDUP_SECONDS`
  回退默认值 30，不进入 `(( ))` 崩溃。
- **新增** Test：`gc_create_state_file` 清理过期行、保留未过期行、丢弃损坏行（跟
  `reap_orphan_workspace_pins` 对损坏 `first_seen` 的处理方式一致）。
- **新增** Test：`create_workspace_for_window` 在 ready gate 失败（`select-window`
  失败）时**不**写入 `CREATE_STATE`（复用既有 select-window 失败夹具，参照
  `scripts/test-cmux-sync.sh` 里 Test 12 的写法）——验证 Codex R1 #2 的修复确实生效。
- **改**：`reset_mocks` 里加 `rm -f "$CREATE_STATE"`，避免跨测试污染（参照现有
  `HEAL_STATE`/`STALE_STATE` 在 `reset_mocks` 里的清理方式）。
- **新增** Test：`wait_for_watcher_exit`——
  - mock `pgrep` 立刻返回空 → 函数立即返回，不调用 `kill`。
  - mock `pgrep` 持续返回非空直到超过等待窗口 → 依次 `kill -TERM` 每个 PID，再
    （若仍存活）`kill -KILL` 每个 PID；断言真实等待时长在 5s 量级（而不是 2.5s）。
  - mock 多个 PID → 逐个 kill，逐个 log，不是一次性 `pkill`。
  - `--wait-for-watcher-exit` CLI 分发正确路由到 `wait_for_watcher_exit`。

## 回归 / 验证

1. `bash -n scripts/flywheel-cmux-sync.sh` && `bash -n scripts/flywheel-cmux-install.sh`
2. `/bin/bash scripts/test-cmux-sync.sh`（后台跑，全绿，含新增用例）
3. `/bin/bash scripts/test-cmux-sync-hooks-integration.sh`（不回归）
4. 全仓 `pnpm lint`（biome）—— 本次改动都是纯 bash，预期无 lint 影响，但仍跑一遍确认
   没有意外触碰到别的文件。

## 风险 / 边界

- **不改** `acquire_watcher_lock` 的锁/mutex 逻辑本身（已过多轮 Codex review，本次
  investigation 没发现新 bug）——只是让新实例更少遇到"旧进程没死透"的情况。
- **不改** `dedup_workspaces_by_title`（按标题去重的兜底仍然保留，作为万一 TTL 没
  盖住的情况下的第二道防线）。
- **不新增周期扫描 / 新 timer**（Annie 否决 polling 的既有红线）——`gc_create_state_file`
  只在 watcher 启动时跑一次，跟 `gc_heal_state_file`/`gc_stale_state_file` 同等级别。
- 去重键用 `window_name|window_id` 双键，TTL 默认 30s：覆盖"同一 tick 内"的双触发，
  同时因为 window_id 不同就不匹配，真实重启（旧 window 已死、新 window 新 id）永远
  不受影响，不存在 Codex R1 #3 担心的"crash-loop 重启被误伤 30s"问题。
- `wait_for_watcher_exit` 的 5s 超时 + TERM 再 KILL 的顺序，给 EXIT trap 留出时间跑
  （释放锁文件），KILL 只在 TERM 5s 后仍存活时才用；逐 PID kill + log，不用无差别
  `pkill -f`，行为对外等价但可审计。

## 验证结果（2026-07-03 实测）

- `bash -n scripts/flywheel-cmux-sync.sh` / `bash -n scripts/flywheel-cmux-install.sh`
  / `bash -n scripts/test-cmux-sync.sh` → **全部 OK**。
- `/bin/bash scripts/test-cmux-sync.sh` → **344 passed, 0 failed**（新增 FLY-825
  相关用例：dedup 同 window_id 只建一次、不同 window_id 不误伤、ready-gate 失败不
  写状态、`create_recently_attempted`/`create_mark_attempted` 全部边界(命中/不
  同键miss/TTL过期/损坏时间戳/未来时间戳全部 fail-open)、`_create_dedup_seconds`
  环境变量校验(空/非数字/超长/合法)、`gc_create_state_file` 清理逻辑、
  `wait_for_watcher_exit` 三个场景(无进程/TERM 后 KILL/多 PID 逐个 kill)）。
- **过程中抓到并修复了一个真实的测试隔离回归**：最初把 `kill()` 定义成无条件
  遮蔽真实 builtin 的 mock 函数，导致既有 FLY-177 "supervised takeover" 测试
  （依赖真实 `kill` 杀掉一个真实的 `sleep 60 &` 后台进程来验证
  `acquire_watcher_lock` 的死亡检测）**挂死**——因为它的 `kill "$fake_watcher"`
  被静默拦截成只记录日志、不发真信号。修复：给 `kill()` 加
  `MOCK_KILL_INTERCEPT`（默认 0 = 透传真实 builtin，与所有既有测试字节兼容；
  仅 `wait_for_watcher_exit` 自己的三个新用例显式置 1，因为那里的"pid"全是
  `MOCK_PGREP_PIDS` 虚构的，不是真进程）。修复后同一测试套件重跑，该测试恢复
  通过，全部 344 条零失败。
- `/bin/bash scripts/test-cmux-sync-hooks-integration.sh` → **11 passed, 0
  failed, 0 skipped**（真实 tmux server，不回归）。
- 全仓 `pnpm lint`（biome，1122 文件）→ **exit 0**，13 条 pre-existing warning
  （均在 `packages/teamlead/src/__tests__/`，与本次改动的 3 个 bash 文件无关）。
- `git status` 确认改动范围精确：`scripts/flywheel-cmux-sync.sh` /
  `scripts/flywheel-cmux-install.sh` / `scripts/test-cmux-sync.sh` +
  新增 `engineering/doc/FLY-825-cmux-dual-attach-restart/`，无意外改动。
