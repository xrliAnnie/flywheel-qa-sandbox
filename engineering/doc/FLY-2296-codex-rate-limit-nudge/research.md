# FLY-2296 Codex TUI 额度换模菜单钉死停驻体 — 调研

Issue: FLY-2296 (https://linear.app/geoforge3d/issue/FLY-2296/病根-codex-tuiapproaching-rate-limits-switch-to-luna菜单卡住停驻体poller)
日期: 2026-09-03
基于: exploration.md

## 1. 调研问题

1. 让 Codex TUI 永不弹这个菜单的**唯一正规开关**是什么,它从哪里读、写到哪里?
2. runner 的 `config.toml` 是怎么生成的,把开关钉进去要处理哪些 TOML 形状?
3. 修复对**存量在飞体**何时生效,回滚边界在哪?
4. 巡检检测是否需要改?
5. Codex Lead 的 TUI 是否同病?

## 2. 开关:`[notice] hide_rate_limit_model_nudge`

### 2.1 读路径(上游 `openai/codex` main,与本机 0.153.0 二进制字符串一致)

```
codex-rs/tui/src/chatwidget/rate_limits.rs
  16  pub(super) const RATE_LIMIT_SWITCH_PROMPT_THRESHOLD: f64 = 90.0;
 339  let high_usage = is_codex_limit && (secondary.used_percent >= 90 || primary.used_percent >= 90);
 353  if high_usage && !has_workspace_credits && !self.rate_limit_switch_prompt_hidden()
 354     && self.current_model() != NUDGE_MODEL_SLUG && !Shown { self.rate_limit_switch_prompt = Pending; }
 410  fn rate_limit_switch_prompt_hidden(&self) -> bool {
 411      self.local_settings.notices.hide_rate_limit_model_nudge.unwrap_or(false) }
 421  if self.rate_limit_switch_prompt_hidden() || current_model in {luna, luna-reserve} { prompt = Idle; return; }
codex-rs/tui/src/local_settings.rs
  53  notices: config.notices.clone(),          // 启动时从 config 装载
  55  user_config_path: config.user_config_path // = $CODEX_HOME/config.toml
```

### 2.2 写路径(「Keep current model (never show again)」按下后)

```
codex-rs/tui/src/app/event_dispatch.rs
2452  AppEvent::PersistRateLimitSwitchPromptHidden => {
2453      self.local_settings.notices.hide_rate_limit_model_nudge = Some(true);
2454      ConfigEditsBuilder::for_config_path(self.local_settings.user_config_path)
2455          .set_hide_rate_limit_model_nudge(true).apply().await   // 写 [notice] 表
2464      "Failed to save rate limit reminder preference: {err}"   // 本机二进制里有这条字符串
```

本机实证:21 份 `~/.flywheel/codex-homes/*/config.toml` 含

```toml
[notice]
hide_rate_limit_model_nudge = true
```

这就是巡检按下 never-show-again 后 Codex 自己写的;读路径与写路径同一个键、同一个文件。**所以 provision 时预先写入同一形状,与用户手按等价。**

### 2.3 「Switch」有多危险

`rate_limits.rs:442–463`:「Switch」向线程发 `override_turn_context(model = luna, effort = preset.default)` 并 `UpdateModel`。线程是 daemon 与 TUI 共享的(`codex resume --remote` 是同一线程的第二个客户端),因此一次误按 Enter 就把停驻体后续所有 turn 换成 luna。菜单默认焦点在 Switch。

### 2.4 config schema

`codex-rs/core/config.schema.json:2690` — `notice.hide_rate_limit_model_nudge: boolean`, "Tracks whether the user opted out of the rate limit model switch reminder."。同表兄弟键:`hide_full_access_warning`、`hide_world_writable_warning`、`hide_gpt5_1_migration_prompt`、`model_migrations`(子表)。

## 3. runner `config.toml` 的生成链

```
CodexTmuxAdapter.executeOwned (packages/claude-runner/src/CodexTmuxAdapter.ts:721)
  └─ provisionCodexHome (codex-home.ts:975)            ← dispatch 与 recovery 两条路都走(第 758 行无条件)
       ├─ baseToml = ~/.codex/config.toml (sourceCodexDir, 第 279 行)
       ├─ pinRunnerPolicy(baseToml) (第 483 行)         ← 钉 sandbox_mode / approval_policy,替换或前插 root 赋值
       └─ renderCodexHomeConfig(runnerBaseToml, ghToken, {skills, notify, trust}) (第 560 行)
            ├─ 剥掉旧 managed 块(幂等)
            ├─ [shell_environment_policy.set] GH_TOKEN:有字面表头则表头后手术注入,否则整块追加
            ├─ notify / skills / [projects."<cwd>"] trust 各一个 sentinel 块追加在末尾
            └─ parseTomlSanitized(candidate) 校验渲染结果是合法 TOML(第 69 行相对)
```

TUI 读的正是这份文件:`codex-runner-tui-window.ts:96–110` 以 `CODEX_HOME="<home>"` 启动 `codex resume --remote …`。

### 3.1 种子里 `notice` 的现状

- `~/.codex/config.toml:814` 只有 `[notice.model_migrations]` 子表,没有 `[notice]` 表头,没有目标键。
- Lead 三个 home(`~/.codex-mufasa`、`~/.codex-honeylemon`、`~/.codex-infra-bot`)的 config.toml 都没有 `[notice`。

### 3.2 各种 TOML 形状的合法性(smol-toml 1.6.1 实测,与 `codex-home.ts` 同一解析器)

| 形状 | 结果 | 含义 |
|---|---|---|
| `[notice.model_migrations]` … 再在末尾追加 `[notice]\nhide_rate_limit_model_nudge = true` | 合法 | 种子当前形状 → **追加整表**即可 |
| root 点键 `notice.hide_rate_limit_model_nudge = true` 后有 `[notice.model_migrations]` | 合法 | 也可,但见下一行 |
| root 点键之后再出现 `[notice]` 表头 | **非法** | 种子一旦被 Codex 写入 `[notice]`(如按过 full-access 警告),root 点键方案会炸 → 拒用 |
| `[notice]` 出现两次 | 非法 | 已有表头时不能再追加整表 → 必须表头后注入键行 |
| `[notice]` 表头下注入 `hide_rate_limit_model_nudge = true`,之后 `[notice.model_migrations]` | 合法 | 已有表头时的手术形状 |
| 内联表 `notice = { … }` 后接 `[notice.model_migrations]` | 非法 | 内联/点键/引号定义的 `notice` 无法手术 → 与 GH_TOKEN 先例一致:fail-loud |

结论:与 `renderCodexHomeConfig` 处理 `[shell_environment_policy.set]` 完全同构 —— **有字面表头就表头后注入,没有就追加整表,其余形状拒绝**;再叠加 `pinRunnerPolicy` 的 pin 语义(基底已有该键时无论 true/false 都改成 true),最后用解析结果断言 `notice.hide_rate_limit_model_nudge === true` 作为后置条件。

### 3.3 Codex 自己追加的 `[notice]` 落点

12/21 份里 Codex 把 `[notice]` 写在 workspace-trust managed 块内部(toml_edit 把新表挂在最后一个表之后,而末尾注释 `# <<< … <<<` 属于上一个表的尾随 trivia)。重新 provision 时该块被整体剥掉。本单的 pin 写在 base 阶段(managed 块之前),不受此影响;且开关生效后 Codex 不再有写入动作。

## 4. 生效边界与回滚

| 体的状态 | 修复何时生效 |
|---|---|
| 修复合入后新派工的体 | 出生即带开关(provision 渲染) |
| 修复前已在飞的体(当前 Bridge 17 个会话) | TUI 进程在启动时读一次 notices,不热重载;要等下一次 `provisionCodexHome` + 重新拉起 TUI —— 即 Bridge 重启的 recovery 路径(`executeOwned(ctx, recovery)` 第 721/758 行同样 provision,并在第 1064 行附近 `ensureWindow`)。在此之前巡检的 `Down Down Enter` 处置照旧 |
| 回滚 | revert 该提交;已渲染的 home 里留着的 `[notice]` 键是 Codex 自己的合法键,无需清理;下一次 provision 从种子重渲染时自然消失 |

不需要迁移脚本:没有 schema、没有数据库、没有环境变量。

## 5. 巡检检测

`scripts/lead-patrol-snapshot.sh:492–496`:

```bash
recent_capture="$(printf '%s\n' "$filtered_capture" | tail -80)"
if printf '%s\n' "$recent_capture" | grep -Eiq 'Press Enter to (confirm|continue)|resume menu'; then
  findings="$(append_finding "$findings" INTERACTIVE_MENU)"
```

`-i` 使 `Press enter to confirm or esc to go back` 命中;fixture(`scripts/__tests__/lead-patrol-snapshot.test.sh:620`)已用 `Press Enter to confirm` 覆盖。issue 描述的「只在 last-6-lines 命中才可见」指的是 Lead 人工巡检的视窗,不是脚本。**不改脚本**;修复后 Codex pane 的 `INTERACTIVE_MENU` 计数归零是场证据。

## 6. Lead TUI 同病(范围外候选)

`packages/teamlead/scripts/codex-lead-tui-home.sh` 用 bash + python `tomllib` 写/校验 Lead home 的 config.toml(pins 第 615–643 行,trust 第 655–695 行)。Lead 的 `codex resume --remote` 与 runner 同一二进制、同一 TUI 代码。若纳入:在 trust 段之后加一段「`[notice]` 缺则追加、有则用 tomllib 校验有效值为 true、drift(显式 false)fail-close」,形状照抄 trust 段。已向 Lead 提问(question dffb0ecd),默认纳入为独立块。

## 7. 判别力探针:假 app-server 接真 TUI,菜单按需复现(2026-09-03 实测)

Lead 的硬要求是「修完要能证明判别力」。菜单只在真实账号窗口 ≥90% 时弹,不能等生产撞上。本调研做了一个**假 app-server**(node + `ws`,监听 unix socket,按方法名回 canned JSON-RPC 结果)接**真的** `codex resume --remote unix://<sock> -C <cwd> <thread>`(0.153.0 二进制,与生产同一份),结果:

| 运行 | `$CODEX_HOME/config.toml` | pane 结果 | 证据文件 |
|---|---|---|---|
| menu | 只有 `[projects."<cwd>"] trust_level = "trusted"`(无键) | 弹出 `Approaching rate limits / Switch to gpt-5.6-luna for lower credit usage? / 1. Switch … 2. Keep current model 3. Keep current model (never show again) / Press enter to confirm or esc to go back` | `probe/evidence/pane-menu.txt` |
| nomenu | 同上 + `[notice]\nhide_rate_limit_model_nudge = true` | **不弹**;同样显示 `⚠ Heads up, you have less than 5% of your 5h limit left`,同样收到 2 条 turn 事件 | `probe/evidence/pane-nomenu.txt` |
| ctrlfalse | 同上 + `hide_rate_limit_model_nudge = false`(对照) | 弹(与 menu 一致) | `probe/evidence/pane-ctrlfalse.txt` |

三组的 server.log 请求序列一致(`probe/evidence/server-*.log`),唯一变量是那个键。这就是「去掉键能复现菜单、加上键能消失」的红绿对照。

### 7.1 TUI 在 `--remote` 模式下的最小握手(0.153.0 实测)

```
initialize                      → {}(任意对象即可)
config/read {cwd}               → { config: { projects: { "<cwd>": { trust_level: "trusted" } } }, origins: {} }   ← 缺 projects 会先弹「Do you trust」菜单
account/read                    → { account: { type:"chatgpt", email, planType:"pro" }, requiresOpenaiAuth: true }  ← 缺 requiresOpenaiAuth 直接退出
thread/read {threadId}          → { thread: <Thread> }                                                             ← 缺则 "No saved session found"
model/list                      → { data: [ <sol>, <gpt-5.6-luna hidden:false> ], nextCursor: null }              ← 列表里必须有 luna,`lower_cost_preset()` 才找得到
thread/resume                   → { approvalPolicy, approvalsReviewer:"user", cwd, model, modelProvider, sandbox:{type:"workspaceWrite",…}, thread }
account/rateLimits/read         → { rateLimits: { limitId:"codex", primary:{usedPercent:95,windowDurationMins:300}, secondary:{…}, credits:null } }
(server 主动) turn/started + turn/completed {threadId, turn:{id,items:[],status}}   ← 菜单只在一次 live TurnComplete 之后才展示(turn_runtime.rs:232)
其余(skills/list、plugin/list、hooks/list、thread/list、thread/goal/get、app/installed、configRequirements/read)回 {} 即可
```

Thread 的必填字段:`id, sessionId, cliVersion, createdAt, updatedAt, cwd, ephemeral, modelProvider, preview, projectId, source:"cli", status:{type:"idle"}, turns:[]`。Model 的必填:`id, model, displayName, description, hidden, isDefault, defaultReasoningEffort, supportedReasoningEfforts`。

### 7.2 探针文件

`engineering/doc/FLY-2296-codex-rate-limit-nudge/probe/`:`server.cjs`(假 app-server)、`probe.sh`(建隔离 home、起 server、tmux 起 TUI、抓 pane)、`canned-menu.json`(应答表,`run-menu` 路径按运行名替换)、`extra-true.toml` / `extra-false.toml`(注入的 `[notice]` 片段)、`evidence/`(三组 pane、server.log、config.toml)。它依赖本机 tmux、`codex` 二进制与主仓 `node_modules` 里的 `ws`;实现节点把它固化为仓内脚本(见 plan §2.5)。

顺带发现:同一探针也能复现 boot 期的「Do you trust the contents of this directory」菜单(`config/read` 不带 `projects` 时),即 FLY-1961 那一类;将来任何 TUI 交互菜单类的病都可以用它做红绿对照。

## 8. 与 FLY-2109 的边界

FLY-2109 是「账号额度用尽后如何切号」;本单是「额度到 90% 时 TUI 弹的换模菜单」。两者触发点相邻(同一个 `/wham/usage` 快照),但本单的处置(关掉提醒)不改变额度耗尽后的行为,也不做任何切号。
