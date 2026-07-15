# FLY-293 cmux 死 pane 不自动消失 — 调研

Issue: FLY-293 (https://linear.app/geoforge3d/issue/FLY-293/cmux-pane-不自动消失close-runner-后渲染层残留死-paneclose-触发-refresh-surfaces-清理)
日期: 2026-06-30
基于: exploration.md

## 1. 目标

给 `flywheel-cmux-sync.sh` watcher 加一个 **anchor-independent orphan-pin reaper**：清掉那些
「后台 tmux 状态全没了、只剩 cmux workspace pin 在侧栏」的死 tab。同时提供一条 read-only 的
dry-run 预览命令，供 Lead 核对后授权一次性即时清理现存 ~29 个死 pin（Q1）。

## 2. 修复面（精确改点，全在 `scripts/flywheel-cmux-sync.sh`）

### 2.1 现有可复用的原子

| 函数 / 变量 | 行 | 作用 | 复用点 |
|-------------|----|------|--------|
| `get_cmux_workspaces_json` | 379 | 取 cmux workspace JSON,tri-state(rc=2=JSON 不可用) | 检测 orphan、fail-closed |
| `get_all_workspace_refs` | 471 | 所有 ref(rc=2 fail) | 参考 |
| `get_tmux_agent_windows` | 290 | `session|wid|wname`(flywheel + runner-*,滤 zsh/bash) | field 3 = 活窗口名集合 |
| `linked_session_exists` | 593 | `tmux has-session -t =cmux-<name>` | 判有无 linked session |
| `close_workspace_by_ref` | 502 | 单一 close 收口 + audit log + **已内建 `FLYWHEEL_CMUX_DRY_RUN`** | 关 pin(dry-run 天然支持) |
| `reap_ghost_workspaces` | 518 | 清 title 为 null/空/`~` 的 ghost | **同层放我的新函数** |
| `dedup_workspaces_by_title` | 538 | 清同名重复 | 同层参考(python 解析 JSON 模式) |
| `drain_stale_state_row` / `gc_stale_state_file` | 661 / 674 | STALE_STATE 行的 awk -F'|' 字面比较增删 | grace state 文件照抄这套 |

`close_workspace_by_ref` 已经支持 `FLYWHEEL_CMUX_DRY_RUN=1`(短路真 close,仍打 `[audit] close … dry_run=1`)
—— dry-run 预览可直接复用，无需另造 dry 逻辑。

### 2.2 新增

1. **`orphan_pin_refs()`**(纯检测,read-only)—— 返回 orphan 死 pin 的 `ref|title` 每行一条。
   tri-state:JSON 不可用 → rc=2(caller fail-closed,绝不当「无 orphan」)。判定见 §3。
2. **`reap_orphan_workspace_pins()`**(周期路径)—— 遍历 `orphan_pin_refs`,套 grace(独立 state
   文件 `ORPHAN_PIN_STATE`,复用 `cleanup_stale_conservative` 的 first-seen-then-age 模式),满 grace
   → `close_workspace_by_ref … "orphan-pin-<title>"`。关了 ≥1 个 → 末尾补一次 `cmux_call refresh-surfaces`
   重绘。放进 `sync_additive`(周期,和 `reap_ghost_workspaces` 并列)。
3. **`--list-orphan-pins`**(新 CLI 模式,read-only)—— 打印 `orphan_pin_refs` 的人读清单(title + ref +
   判定依据),**绝不 close**。与 `--watch` 并存安全(纯读)。= Q1 dry-run 预览。
4. **`--reap-orphan-pins`**(新 CLI 模式,一次性 targeted 清理)—— 现场**重新推导** orphan 集合(防
   list→reap 之间 TOCTOU),**无 grace**(显式 operator 动作,同 `--once` 的即时语义),逐个 close +
   refresh-surfaces。与 `--watch` 并存安全(narrow + 幂等 + `close_workspace_by_ref || true`),故**不加**
   `--once` 那种 "--watch already running → exit" 守卫。= Q1 Lead 授权后的一次性清理入口。
5. env 开关 `FLYWHEEL_CMUX_ORPHAN_REAPER`(default ON;`=0` 关掉周期 reaper,byte-compat 逃生口)。
   grace 秒数复用 `CONSERVATIVE_CLEANUP_SECONDS`(默认 300s)或新 `FLYWHEEL_CMUX_ORPHAN_PIN_GRACE`。

`sync_once`(手动 --once)里也加 `reap_orphan_workspace_pins`(和它已有的 `reap_ghost_workspaces`/
`dedup` 并列),保持 --once = 全套 hygiene。

## 3. 检测 predicate(安全性核心)

> **注**:Codex design review R1 把 predicate 收紧了(managed-title gate + strict tmux fail-closed +
> ref-keyed grace + close 前最终复核)。**最终权威设计见 plan.md §3–§4**。下面保留原始推导 + R1 增量。

**R1/R2 新增 (b0) managed-runner-title gate**:workspace title 必须匹配当前 producer 真能产出的 runner 命名
(`tmux-naming.ts:buildWindowLabel` = `{issueId}-{runner}-{title}`,而 `runnerName` 在 `run-dispatcher.ts`
硬编码 `claude`)→ **source-accurate 正则 `^[A-Z][A-Z0-9]*-[0-9]+-claude(-|$)`**(R2 收紧,去掉
codex/gemini/cursor/kimi/agy —— 它们不是 producer 当前能产出的 token)。这排除 founder 个人 cmux tab
(`home`/`notes`)和 Lead workspace(`<project>-<lead>`,且 Lead 非 close_runner 目标)。**权威见 plan.md §3.1。**

**R1 新增 tmux fail-closed**:检测顶部 `tmux list-sessions` + 每 flywheel/runner-* session 的
`list-windows` 任一失败 → rc=2 跳过(不再把 tmux 挂当「无窗口」)。

一个 cmux workspace 判为 **orphan 死 pin** ⟺ 同时满足:
- **(a) title 非空** 且不是 ghost 占位(`null`/`""`/`~`)—— 那些归 `reap_ghost_workspaces`;
- **(b0) managed-runner-title**(R1,见上);
- **(b) 无同名活 agent 窗口** —— title ∉ `collect_agent_window_names_strict`(strict 版,tmux 失败 rc=2)。
  **注意:这里用「窗口存在与否」(死活都算存在),不是 pane-alive。** 理由:
  - `close_runner` 走 `killTmuxWindow` 真杀窗口 → 窗口彻底没 → 命中 (b) → 该清(FLY-293 正路)。
  - crash 的 runner 窗口是 dead-pin(`remain-on-exit on`,窗口还在、pane 死)→ `get_tmux_agent_windows`
    **仍返回它** → **不**命中 (b) → **不清**。这正好把 dead-pin forensics 留给 **FLY-720** crash-reaper
    (它有 grace + forensics dump),我不越界踩它。
- **(c) 无 `cmux-<title>` linked session** —— `! linked_session_exists "cmux-<title>"`。

活 Lead / 活 runner **结构上不可能命中**:它们永远有活源窗口(命中 (b) 的否定)**且**活 linked
session(命中 (c) 的否定)—— 双重保护。这满足 issue 的硬约束「绝不能端掉仍活的其它 runner 窗口 / 不碰
Lead」。

JSON 不可用(`get_cmux_workspaces_json` rc=2)→ `orphan_pin_refs` rc=2 → caller **跳过本轮**(绝不
把「读不到」当「无 orphan」而误清 or 误判)。

## 4. grace(仅周期路径)

> **R1 修正**:grace **按 cmux ref(`workspace:N`,单调不复用)做 key,不用 title**(title 不唯一/可漂移)。
> state 行 = `ref|first_seen_ts|title_b64`。且 close 前走 `close_orphan_workspace_pin_if_still_orphan`
> 现场重载 JSON + strict tmux + 全 predicate 复核(见 plan.md §3.3/§4)。下面原始描述已被 plan.md 取代。

周期 `reap_orphan_workspace_pins` 用 `ORPHAN_PIN_STATE`(~~`<title>|<first_seen_ts>`~~ → `ref|first_seen|title_b64`,awk -F'|'
字面比较,和 STALE_STATE 一套):
- 首次见某 title orphan → 记 ts,不关;
- 已连续 orphan 满 `CONSERVATIVE_CLEANUP_SECONDS`(300s)→ 关 + 从 state 删行;
- title 不再 orphan(重新有窗口/session)→ 删 state 行(取消)。
watcher 启动时 GC 该 state(照抄 `gc_stale_state_file`)清掉上个 watcher 漏的行。

grace 目的 = 防创建竞态(create_workspace_for_window 里 workspace 创建与 linked-session/rename 有短暂
时序差)。虽然实际死 pin 已 orphan 数小时、随便过 grace,但周期路径必须保守。

`--reap-orphan-pins`(显式 operator)**无 grace** —— 即时清,同 `--once` 的 `cleanup_stale_workspaces`
即时语义。

## 5. 测试基建(已有,直接接)

`scripts/test-cmux-sync.sh` —— mock tmux + mock cmux 的纯 bash 单测框架:
- `MOCK_CMUX_WORKSPACES_JSON` 喂 workspace JSON;`MOCK_TMUX_*` 喂 sessions/windows;
- `MOCK_CMUX_CLOSED` 捕获 `close-workspace` 调用;`MOCK_TMUX_KILLED` 捕获 kill-session;
- 已有针对 `cleanup_workspace_for` / `reap_ghost` / `dedup` / `process_pending_cleanups` 的用例可仿写。
- source 脚本(`BASH_SOURCE != $0` 守卫,行 2501)后直接调新函数。

`scripts/test-cmux-sync-hooks-integration.sh` —— 真 tmux 集成(可选加一个真 cmux-less 的场景:真 tmux
建/杀窗口 + 建/杀 `cmux-*` session,断言 `orphan_pin_refs` 判定,但 close 用 mock cmux)。

`.github/workflows/ci.yml` 跑这些 bash 测试(需确认 job 名/入口)。

## 6. 回归测试清单(TDD,先红)

1. **orphan 命中**:workspace title=X,无同名 agent 窗口,无 `cmux-X` session → `orphan_pin_refs` 含 X。
2. **活 runner 不动**:title=Y 有活 `runner-*` 窗口 + `cmux-Y` session → 不在 orphan 集。
3. **活 Lead 不动**:title=Z 有 `flywheel` 窗口 + `cmux-Z` session → 不在 orphan 集。
4. **dead-pin 不动(FLY-720 边界)**:title=W 窗口存在但 pane_dead=1(remain-on-exit),无 `cmux-W`
   session → **不**在 orphan 集(窗口仍存在)。
5. **ghost 不误吞**:title=`~`/空/null → 不在 orphan 集(归 ghost reaper)。
6. **JSON 不可用 fail-closed**:`get_cmux_workspaces_json` rc=2 → `orphan_pin_refs` rc=2 →
   `reap_orphan_workspace_pins` 本轮 no-op(不关任何东西)。
7. **grace**:周期路径首见 orphan 不关(记 state);满 grace 才关;中途不再 orphan → 取消。
8. **`--reap-orphan-pins` 无 grace**:首见即关。
9. **close 后 refresh-surfaces**:关了 ≥1 个 → 调用一次 `cmux refresh-surfaces`;关了 0 个 → 不调用。
10. **env off**:`FLYWHEEL_CMUX_ORPHAN_REAPER=0` → 周期 reaper 完全 no-op(byte-compat)。
11. **`--list-orphan-pins` 只读**:打印清单但 `MOCK_CMUX_CLOSED` 为空(绝不 close)。
12. **多个 orphan 全清**:两个 orphan → 两个都被 close。

## 7. Q1 立即清理(Lead-approved 流程)

1. 写完 `orphan_pin_refs` + `--list-orphan-pins` + 测过。
2. 对**生产** cmux 跑 `flywheel-cmux-sync.sh --list-orphan-pins`(纯读,和活 --watch 并存安全)→ 得
   title+ref+依据 清单。
3. 发 Lead 核对(应 = ~29 个死 pin,0 个活 Lead/runner)。
4. Lead 授权 → 跑 `flywheel-cmux-sync.sh --reap-orphan-pins`(现场重推导 + close + refresh-surfaces)
   → Annie 即时清爽。
5. 全量修(周期 reaper)随 PR ship 后 restart 生效,防复发。

## 8. 风险 & 缓解

> **R1/R2 收口后的权威缓解见 plan.md §0.1 + §3–§4**;下表已对齐。

| 风险 | 缓解 |
|------|------|
| 误关 founder 个人 tab / 非-Flywheel workspace | **managed-runner-title gate**(§3.1 `^[A-Z][A-Z0-9]*-[0-9]+-claude(-|$)`,source-accurate);测反向哨兵守 |
| 误关活 Lead/runner | managed gate 排 Lead + predicate (c)(d) 双否定(无窗口 + 无 linked session);测守 |
| 踩 FLY-720 dead-pin forensics | (c) 用窗口存在(死活都算在),dead-pin 窗口不清;测守 |
| cmux JSON **或 tmux inventory** 抖动误清 | 双 tri-state rc=2 fail-closed(cmux JSON + strict tmux 探针);测守 |
| 创建竞态误清刚建的 workspace | 周期路径 ref-keyed grace(300s);`--reap` 一次性由 operator 显式授权 |
| list→reap / derive→close 之间状态变化(TOCTOU) | **所有 close 走 `close_orphan_workspace_pin_if_still_orphan`**:现场重载 JSON + strict tmux + 同 ref 同 title + 全 predicate 复核 |
| ref-key 安全 | ref=`workspace:N` 单调不复用(dedup 注释已证);title 仅存 b64 供 log/drift,不做 key |
| kill-switch byte-compat | `FLYWHEEL_CMUX_ORPHAN_REAPER=0` → 周期/--once/startup-GC 全 inert(不扫/不碰 state/不 log/不 refresh) |
| 生产 --watch 与一次性 reap 并发 | 幂等 close + `|| true` + 逐 ref 最终复核;narrow scope(不跑 aggressive --once) |
| 引入新周期负载 | 复用 `sync_additive` 已在扫的 JSON;仅多一次 python 解析 + 少量 tmux 只读 |

## 9. 归属边界(Lead-confirmed)

- 只改 `scripts/flywheel-cmux-sync.sh`(+ `scripts/test-cmux-sync.sh` 测试)。
- **不**碰 `close-runner.ts` / Bridge TS / cmux CLI-in-Bridge。
- 与 FLY-720(crash 拆 tmux 侧)、FLY-280(live 渲染 drift 重绘)互补,不重叠。
