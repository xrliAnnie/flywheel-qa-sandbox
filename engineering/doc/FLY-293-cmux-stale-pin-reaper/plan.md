# FLY-293 cmux 死 pane 不自动消失 — 实施计划

Issue: FLY-293 (https://linear.app/geoforge3d/issue/FLY-293/cmux-pane-不自动消失close-runner-后渲染层残留死-paneclose-触发-refresh-surfaces-清理)
日期: 2026-06-30
基于: research.md

## 0. 一句话

在 `scripts/flywheel-cmux-sync.sh` 加一个 **anchor-independent orphan-pin reaper**:只清「provably
Flywheel-managed 的 runner workspace pin,且后台 tmux 状态全没了」的死 tab;并加 read-only dry-run 预览
+ operator 一次性即时清理入口。只改 watcher(+ 其测试),Bridge/close_runner 不动。

## 0.1 Codex design review R1 收口(全部采纳)

| # | 关切 | 本计划的落地 |
|---|------|--------------|
| HIGH-1 | predicate 过宽,会关到 founder 个人 cmux tab / title-drift 的活 workspace | 加 **managed-runner-title gate**(§3.1):只对匹配当前 producer 真能产出的 runner 命名 `{issueId}-claude-{title}`(runnerName 硬编码 `claude`)的 title 生效。Lead workspace(`<project>-<lead>`,非 close_runner 目标)+ 用户个人 tab(`home`/`notes`)结构上被排除。(R2 收紧:去掉 codex/gemini/cursor/kimi/agy —— producer 产不出) |
| HIGH-2 | tmux inventory 失败被当空集 = fail-open,transient tmux 挂 → 全量误清 | orphan 检测对 **tmux inventory 也 tri-state fail-closed**(§3.2):strict 探针,`list-sessions`/`list-windows` 任一失败 → rc=2 跳过本轮。 |
| HIGH-3 | `ORPHAN_PIN_STATE` 按 title 做 key 不安全(title 不唯一/可漂移/转义) | grace **按 cmux ref 做 key**(§4),存 `ref|first_seen|title_b64`;ref 单调不复用(dedup 注释已证)。 |
| MED-4 | `--reap` derive→close 之间 TOCTOU | 所有 close 走 `close_orphan_workspace_pin_if_still_orphan ref title`(§3.3)—— close 前现场重载 JSON + strict tmux + 全 predicate 复核。 |
| MED-5 | kill-switch 未覆盖 startup GC / wiring,off 路径非 byte-compat | `FLYWHEEL_CMUX_ORPHAN_REAPER=0` 时:周期/`--once`/startup-GC 全部 **完全 inert**(不扫 JSON、不碰 state、不打新 log、不 refresh)。CLI(`--list`/`--reap`)是显式 operator 动作,不受 flag 管。 |
| MED-6 | wiring 漏 early-return 分支(只剩 orphan pin 的 quiet 态) | reaper 在 `sync_additive` **empty + normal 两个分支**都挂;`sync_once` 同理。 |
| LOW-7 | refresh-surfaces 非核心修 | 保留为关完的 best-effort 重绘,**非**安全条件(测里断言「关了才 refresh」,但逻辑不依赖它)。 |

## 1. 范围

**改**:`scripts/flywheel-cmux-sync.sh`、`scripts/test-cmux-sync.sh`(单测)、
`scripts/test-cmux-sync-hooks-integration.sh`(可选真 tmux 场景)。
**不改**:`close-runner.ts` / 任何 Bridge TS / cmux CLI-in-Bridge。
**docs**:本文件夹三件套随 PR 走;merge 时 `git mv` 归档(如项目 archive 约定适用)。

## 2. 新增函数 / CLI 总览

| 名 | 类型 | 作用 |
|----|------|------|
| `is_managed_runner_title <title>` | 纯判定 | title 是否匹配 Flywheel runner 命名契约(§3.1) |
| `collect_agent_window_names_strict` | tmux 探针 | 打印活 agent 窗口名;**任一 tmux 失败 → rc=2**(fail-closed,§3.2) |
| `orphan_pin_refs` | 检测(read-only) | 打印 orphan `ref\t title`;cmux JSON 或 tmux inventory 不可用 → rc=2 |
| `close_orphan_workspace_pin_if_still_orphan <ref> <title>` | 单 close 收口 | close 前现场全 predicate 复核(§3.3),过则 `close_workspace_by_ref` |
| `reap_orphan_workspace_pins` | 周期 | env-gated;`orphan_pin_refs` + ref-keyed grace(§4)→ 逐个走上面的 close 收口 → 关了 ≥1 补 refresh |
| `gc_orphan_pin_state_file` | startup | env-gated;删 state 里 ref 已不在 cmux JSON 的行 |
| `--list-orphan-pins` | CLI(read-only) | 打印 orphan 清单(title + ref + 依据),绝不 close(= Q1 dry-run) |
| `--reap-orphan-pins` | CLI(一次性) | 现场重推导,逐 ref 走 close 收口(**无 grace**),末尾 refresh(= Q1 授权后执行) |

## 3. 判定逻辑(安全性核心)

### 3.1 managed-runner-title gate（HIGH-1 — source-accurate,R2 收紧）
runner 窗口名(= cmux workspace title)由 `packages/core/src/tmux-naming.ts:buildWindowLabel`
生成 = `{issueId}-{runner}-{cleanTitle}`,再经 `sanitizeTmuxName`(仅留 `[a-zA-Z0-9-]`)。
- `issueId` = Linear identifier = `[A-Z][A-Z0-9]*-[0-9]+`(如 `FLY-293`/`LEARN-143`/`TIDE-22`)。
- `runner` = **`ctx.runnerName`**(`Blueprint.ts:1347` 传入 `buildWindowLabel`)。**权威事实(R2 verify)**:
  `run-dispatcher.ts:307` 与 `:586` 两条 dispatch 路径都**硬编码 `runnerName: "claude"`**,全仓无任何位置把
  它设成 codex/antigravity/kimi/gemini/cursor。即 —— **不论后端(claude-tmux/codex-tmux/antigravity-tmux/
  kimi-tmux),真实生产窗口名一律是 `{issueId}-claude-{title}`**。生产只读实测印证:`FLY-637-claude-…`、
  `TIDE-22-claude-round-2-…`、`LEARN-143-claude-…` 全带 `-claude-`。

`is_managed_runner_title` 正则(anchored,大小写敏感,**只认 producer 真能产出的 token**):
```
^[A-Z][A-Z0-9]*-[0-9]+-claude(-|$)
```
- **为何不含 codex/gemini/cursor/kimi/agy**(R2 HIGH-1):它们不是 `ctx.runnerName` 当前能产出的值 →
  一个 `FLY-X-codex-foo` 的 workspace **不可能**是当前 dispatcher 建的 = 不能当「provably managed」。含它们
  就是对 source 证明不了的 title 误判 managed(可能误关用户 tab)。**codex/agy/kimi 后端的 runner 窗口本身
  就是 `-claude-`**(因 runnerName 硬编码),所以本 gate **不漏**任何真 runner pin。
- **coupling 契约(代码注释 + 测试注释必写)**:此正则绑定 `run-dispatcher.ts` 的 `runnerName` 常量 +
  `EXECUTOR_BACKENDS`。**若将来把 `runnerName` 改成 backend-specific(如 `-codex-`)**,必须同步扩这里的
  alternation。反向哨兵测试:`gemini`/`cursor`/`codex`/`kimi`/`agy` 段当前**必须判 non-managed**。
- **排除 Lead**:Lead 窗口名 = `<project>-<leadName>`(project 小写 `flywheel`/`geoforge3d`/…),不匹配
  `^[A-Z]…-[0-9]+-claude`。且 Lead **本就不是 close_runner 目标**(见 close-runner.ts;不走 orphan 路径)。
- **排除用户个人 tab**:`home`/`notes`/`scratch`/`FLY-X-notes` 等不匹配。
- **bare issue-key(无 `-claude-`)不 reap**(R2 MED-1):若出现 `FLY-637`(裸,无 vendor 段)这类 title,
  **故意不当 managed**(缺 producer 证明)。生产实测无此形态(全带 `-claude-`),故不影响 Q1 backlog。

### 3.2 strict tmux inventory（HIGH-2,fail-closed;LOW-1 单快照）
**单一 tmux session 快照**(LOW-1:绝不发两次 `list-sessions`):`orphan_pin_refs` 顶部只取一次
`sessions_snapshot`,并把它**传入** strict collector,linked-session 判定也复用它。
```
raw=$(get_cmux_workspaces_json) || return 2                       # cmux JSON 不可用 → 跳过
sessions_snapshot=$(tmux list-sessions -F '#{session_name}') || return 2   # tmux server 不可用 → 跳过
agent_names=$(collect_agent_window_names_strict "$sessions_snapshot") || return 2  # inventory 不确定 → 跳过
```
`collect_agent_window_names_strict <sessions_snapshot>`:
- 入参 = 已取好的 session 名单(不再自己发 `list-sessions`);
- 对名单里每个 `flywheel` / `runner-*` session 发 `tmux list-windows -F …`:任一 rc≠0 → **return 2**;
- 全成功 → 打印 agent 窗口名(滤 zsh/bash),rc=0(**空输出 = 真的没窗口**,可安全据此判 orphan)。
- linked-session 判定 = `grep -qxF "cmux-<title>"` 对 `sessions_snapshot`(字面,不另发 tmux)。

### 3.3 orphan predicate + 最终复核（MED-4）
一个 workspace 判 orphan 死 pin ⟺ 同时:
- (a) title 非空且非 ghost(`~`);
- (b) `is_managed_runner_title "$title"`(§3.1);
- (c) title ∉ `agent_names`(**窗口存在与否,死活都算存在** —— dead-pin remain-on-exit 窗口仍被
  `list-windows` 返回 → 不命中 (c) → 留给 FLY-720 crash-reaper,不越界);
- (d) `cmux-<title>` ∉ sessions_snapshot(无 linked session)。

活 Lead / 活 runner 结构上不可能命中((b) 排 Lead;活 runner 占 (c)+(d) 双否定)。

`close_orphan_workspace_pin_if_still_orphan ref title`(所有 close 的唯一入口):
1. 现场重载 cmux JSON + strict tmux inventory(任一不可用 → skip,不关);
2. `ref` 必须匹配 `^workspace:[0-9]+$`(malformed → log skip);
3. 该 ref 在当前 JSON 里仍存在且 title 未变(ref 单调不复用;title 漂了 → skip);
4. 全 predicate (a)-(d) 仍成立;
5. 才 `close_workspace_by_ref "$ref" "orphan-pin-<title>"`。

### 3.4 流程图
```mermaid
graph TD
    Entry["sync_additive / sync_once / --reap-orphan-pins"] --> Flag{"ORPHAN_REAPER on? (CLI 免检)"}
    Flag -- no(仅周期/--once) --> Inert["完全 inert (byte-compat)"]
    Flag -- yes / CLI --> J{"cmux JSON ok?"}
    J -- rc=2 --> Skip["fail-closed skip"]
    J -- ok --> T{"strict tmux inventory ok?"}
    T -- rc=2 --> Skip
    T -- ok --> Loop["每个 workspace"]
    Loop --> A{"title 非空 且非 ~ ?"}
    A -- no --> Ghost["→ ghost reaper 管"]
    A -- yes --> B{"is_managed_runner_title? (排 Lead/用户 tab)"}
    B -- no --> KeepU["保留 (Lead / 用户个人 tab)"]
    B -- yes --> C{"有同名活窗口? (死活都算)"}
    C -- yes --> KeepR["保留 (活 runner / dead-pin=FLY-720)"]
    C -- no --> D{"有 cmux-&lt;title&gt; session?"}
    D -- yes --> KeepR
    D -- no --> Orphan["orphan 候选"]
    Orphan --> G{"grace(周期,ref-keyed) / 免 grace(--reap)?"}
    G -- 未满 --> Wait["记 ref state, 等"]
    G -- 满/免 --> Reval["close_...if_still_orphan: 现场全复核"]
    Reval -- 仍 orphan --> Close["close_workspace_by_ref → drain state → closed_any=1"]
    Reval -- 变了 --> Skip2["skip"]
    Close --> Refresh["closed_any → cmux refresh-surfaces (best-effort)"]

    style Orphan fill:#ffd9d9
    style Close fill:#ffb3b3
    style KeepU fill:#d9ead3
    style KeepR fill:#d9ead3
```

## 4. grace（周期路径,ref-keyed — HIGH-3）
`ORPHAN_PIN_STATE`(默认 `/tmp/flywheel-cmux-orphan-pin.state`,test 可覆盖),每行 `ref|first_seen_ts|title_b64`:
- 首次见某 ref orphan → 记 `ref|now|b64(title)`,不关;
- 已连续 orphan 满 grace 秒 → 走 `close_orphan_workspace_pin_if_still_orphan`;关成功 → 删该 ref 行;
- 某 ref 不再 orphan(有窗口/session 了,或 ref 不在 JSON 了)→ 删该行(取消);
- key=ref(单调不复用),title 存 b64 仅供 log + drift 侦测,不做 key。
- awk `-F'|'` 字面比较增删行(ref 是 `workspace:N`,无 regex 元字符,安全)。

grace 秒:`FLYWHEEL_CMUX_ORPHAN_PIN_GRACE`(默认 = `CONSERVATIVE_CLEANUP_SECONDS`=300)。
`--reap-orphan-pins`(显式 operator)**免 grace** —— 即时,同 `--once` 语义。

`gc_orphan_pin_state_file`(startup,env-gated):删 state 里 ref 已不在当前 cmux JSON 的行(照抄
`gc_stale_state_file` 模式);JSON 不可用则跳过 GC(不清 state)。

## 5. env / 常量

| 名 | 默认 | 作用 |
|----|------|------|
| `FLYWHEEL_CMUX_ORPHAN_REAPER` | ON(`=0` 关) | **周期 + --once + startup-GC 的 kill-switch**;off = 全 inert(byte-compat)。CLI 不受管。 |
| `FLYWHEEL_CMUX_ORPHAN_PIN_GRACE` | `=CONSERVATIVE_CLEANUP_SECONDS`(300) | 周期 grace 秒 |
| `ORPHAN_PIN_STATE` | `/tmp/flywheel-cmux-orphan-pin.state` | ref-keyed grace state(test 可覆盖) |
| `FLYWHEEL_CMUX_DRY_RUN` | (已有) | dry-run;`close_workspace_by_ref` 已支持 |

## 6. wiring（MED-5 + MED-6）

- `sync_additive`:**empty-tmux_windows 分支**(现只有 conservative + ghost)+ **normal 分支**都加
  `reap_orphan_workspace_pins`(env off → 函数自身 return 0,byte-compat)。
- `sync_once`:同样两分支都加(保留其 `--watch already running → exit` 守卫)。
- `watch_main` startup:`gc_orphan_pin_state_file`(env off → return 0)。
- 新 case:`--list-orphan-pins`(read-only)、`--reap-orphan-pins`(一次性);usage 文本更新。
- **env off byte-compat**:关时上述所有点都不扫 JSON / 不碰 state / 不打新 log / 不 refresh。

## 7. TDD 步骤（RED → GREEN → REFACTOR）

顺序:1 判定原子 → 2 检测 → 3 close 收口 → 4 周期 reaper+grace → 5 CLI → 6 wiring/byte-compat → 7 refactor。

### Step 1 — `is_managed_runner_title` + `collect_agent_window_names_strict`
- RED:managed 正则 —— 命中 `FLY-293-claude-…`/`LEARN-143-claude-…`/`TIDE-22-claude-…`(真生产全 title 夹具);
  **反向哨兵必判 non-managed**:`gemini`/`cursor`/`codex`/`kimi`/`agy` 段(producer 当前不产出)、Lead 名
  (`flywheel-flywheel-cos-lead`)、用户 tab(`home`/`notes`)、bare `FLY-637`(无 vendor 段)。strict 探针:
  `list-windows` 失败 → rc=2、全成功空 → rc=0 空、入参 sessions_snapshot 复用(不重发 list-sessions)。
- GREEN:实现两函数。正则 = `^[A-Z][A-Z0-9]*-[0-9]+-claude(-|$)`,函数上方注释写明 coupling(绑
  `run-dispatcher.ts` runnerName + `EXECUTOR_BACKENDS`,producer 变 backend-specific 时需扩 alternation)。

### Step 2 — `orphan_pin_refs`（tri-state cmux JSON + tri-state tmux）
- RED(research §6 的 1–6、11 对应):orphan 命中 / 活 runner 不动 / 活 Lead 不动 / dead-pin 窗口不动 /
  ghost 不吞 / 用户非 managed tab 不动 / cmux JSON rc=2 → rc=2 / tmux inventory 失败 → rc=2。
- GREEN:§3.2 顶部三 gate + §3.3 (a)-(d) 过滤,打印 `ref\ttitle`。

### Step 3 — `close_orphan_workspace_pin_if_still_orphan`
- RED:ref malformed → skip;ref 不在 JSON → skip;title 漂了 → skip;现在有窗口/ session 了 → skip;
  仍 orphan → close(`MOCK_CMUX_CLOSED` 捕获);tmux/JSON 现场不可用 → skip。
- GREEN:§3.3 五步复核。

### Step 4 — `reap_orphan_workspace_pins` + `gc_orphan_pin_state_file`
- RED:grace 首见不关(记 ref state)/满 grace 关/中途不再 orphan → 取消;关 ≥1 → refresh、关 0 → 不
  refresh;`FLYWHEEL_CMUX_ORPHAN_REAPER=0` → 完全 no-op(不扫/不碰 state/不 log/不 refresh);多 orphan
  全清;**HIGH-3**:两个同 title 不同 ref 的 workspace,stale ref 行不会误 age 新 ref;title-reuse。
- GREEN:ref-keyed state 机 + env gate。

### Step 5 — `--list-orphan-pins` + `--reap-orphan-pins`
- RED:`--list` 打印清单且 `MOCK_CMUX_CLOSED` 空(纯读);`--reap` 无 grace 首见即关 + 走 close 收口 +
  refresh;`--reap` 对 non-managed / 活的不动;CLI 在 `FLYWHEEL_CMUX_ORPHAN_REAPER=0` 下仍工作(operator)。
- GREEN:两 case 分支 + usage 更新。

### Step 6 — wiring + byte-compat
- RED:`sync_additive` empty 分支也调 reaper;normal 分支也调;`sync_once` 同;`watch_main` startup GC;
  **env off**:`sync_additive`/`sync_once`/startup 全 inert(用 mock 断言无 close/无 state 文件写/无 refresh)。
- GREEN:挂点 + flag gate。

### Step 7 — REFACTOR + 全量校验
- 复用已有 state-file GC/drain helper,不复制;`bash -n`;全量 `scripts/test-cmux-sync.sh`(+ 可选真 tmux
  hooks-integration 场景);shellcheck(若 CI 有)。

## 8. gate / 流程序列

1. plan.md(本轮)→ Codex design review resume 复审 → APPROVED。
2. `stage set implement` → Step 1–7 TDD。
3. **Q1 岔路(与实现并行)**:Step 1–3 + `--list-orphan-pins` 写完测过 → 对生产跑 `--list-orphan-pins`
   (纯读,与活 --watch 并存安全)→ dry-run 清单(title+ref+依据)。
   **MED-1 stop-gate**:清单的**数量 + 形态**必须对得上已知生产 backlog(只读实测 ~29 个死 pin,全为
   `{issueId}-claude-{title}`)。若清单**明显对不上**(数量差很多 / 出现意料外 title / 含疑似 Lead 或用户
   tab)→ **不跑 `--reap`**,先回头修 ownership predicate + 报 Lead。对得上 → dry-run 清单发 Lead 核对 →
   Lead 授权 → 跑 `--reap-orphan-pins`(现场重推导 + 逐 ref 复核 close + refresh)给 Annie 即时清爽。
   **不裸手、不 aggressive --once。**
4. `stage set test` → 全量绿 → worktree/branch commit → push → `gh pr create`。
5. `stage set pr_created` → Codex code review → APPROVED。
6. QA(真 cmux 验:造 managed orphan pin → 被 reap;活 Lead/runner + 用户 tab → 不动;tmux/JSON 不可用
   → fail-closed 不误清)。auto-QA 若开则独立 QA session。
7. approve gate(`--no-block`)→ `complete --route needs_review` → 等 verified 批准。
8. **restart-gated infra**:改的是 `--watch` 守护进程逻辑 → ship 需重启 launchd
   `com.flywheel.cmux-watcher` 才生效 → founder-gated + 和其他排队 Bridge/watcher PR 攒一次重启(问 Lead)。
9. verified 批准 → `:cool:` → merge → 改 landing signal → `stage set completed`。

## 9. 部署生效 & 与相邻 issue 关系

- 纯 `scripts/flywheel-cmux-sync.sh` 改动 → 需重启 `--watch`(launchd `com.flywheel.cmux-watcher`)。
- Q1 一次性清理不需重启(直接 `--reap-orphan-pins`)。
- 与 **FLY-720**(crash 拆 tmux 侧,dead-pin remain-on-exit 归它)互补 —— §3.3 (c) 用「窗口存在」而非
  pane-alive,故本 reaper 不动 dead-pin 窗口。与 **FLY-280**(live 渲染 drift 重绘)不重叠。

## 10. 验收标准

- [ ] runner 下线(close_runner 正常关 / crash 后 FLY-720 拆完)→ 对应 managed cmux pin 自动撤,侧栏只留
      leads + 活 runner。
- [ ] 活 Lead / 活 runner / **founder 个人 cmux tab** 绝不被动(managed gate + 双 predicate + 测双保)。
- [ ] cmux JSON **或** tmux inventory 不可用 → fail-closed,不误清、不误判。
- [ ] dead-pin(remain-on-exit,窗口在)不被本 reaper 动(留 FLY-720)。
- [ ] ref-keyed grace:同名不同 ref 不互相污染 grace 时钟。
- [ ] `--list-orphan-pins` 纯读;`--reap-orphan-pins` 一次性即时 + 逐 ref 复核。
- [ ] `FLYWHEEL_CMUX_ORPHAN_REAPER=0` → 周期/--once/startup 全 inert(byte-compat)。
- [ ] 全量 bash 测试 + Codex design/code review APPROVED + 真 cmux QA PASS。
