# FLY-2296 Codex TUI 额度换模菜单钉死停驻体 — 探索

Issue: FLY-2296 (https://linear.app/geoforge3d/issue/FLY-2296/病根-codex-tuiapproaching-rate-limits-switch-to-luna菜单卡住停驻体poller)
日期: 2026-09-03
基于: 无

## 1. 现象(巡检 2026-09-03T09:22Z 首见)

- 7 具 Codex 停驻体(2283/2144/2269×2/2140/2281×2)的 founder 可见 pane 同时停在同一个交互菜单:
  `Approaching rate limits / Switch to gpt-5.6-luna for lower credit usage? / Press enter to confirm or esc to go back`,默认焦点在「Switch」。
- 巡检脚本对该形状的判定是 `INTERACTIVE_MENU`(`scripts/lead-patrol-snapshot.sh:494`,匹配最近 80 行里的 `Press Enter to confirm`),处置是逐具 `Down Down Enter` 选「Keep current model (never show again)」。
- 其中 %131/%165 两具 `/goal` 状态为 paused,巡检用 `/goal resume` 恢复。
- 巡检报告原文(`~/.flywheel/patrol-reports/flywheel-eng-lead/20260903T094625Z-tickNA.md:140`):
  `codex_menu_wedge: 7 codex panes dismissed (keep model), 2 goals resumed.`

## 2. 根因(已在源码与二进制上核实)

### 2.1 菜单从哪里来

Codex CLI 0.153.0(runner 与 Lead 实际用的二进制:`~/.local/bin/codex → ~/.codex-mufasa/packages/standalone/releases/0.153.0-aarch64-apple-darwin/bin/codex`)的 TUI 内置一个「额度逼近 → 建议换到低成本模型」的提示,上游源码 `codex-rs/tui/src/chatwidget/rate_limits.rs`:

| 事实 | 出处 |
|---|---|
| 触发阈值:主窗口或次窗口 `used_percent >= 90.0` | `RATE_LIMIT_SWITCH_PROMPT_THRESHOLD: f64 = 90.0`(第 16 行);`high_usage` 判定(第 339–350 行) |
| 不弹的条件之一:`local_settings.notices.hide_rate_limit_model_nudge == true` | `rate_limit_switch_prompt_hidden()`(第 410–415 行);`maybe_show_pending_rate_limit_prompt()` 命中即置 `Idle`(第 421–425 行) |
| 「Switch」的动作:向线程发 `override_turn_context(model=luna)` + `UpdateModel` | 第 442–463 行 |
| 「never show again」的动作:内存置 true,并把 `[notice] hide_rate_limit_model_nudge = true` 写回 **用户 config 文件** | `event_dispatch.rs:2452–2466`(`ConfigEditsBuilder::for_config_path(user_config_path).set_hide_rate_limit_model_nudge(true)`) |
| `local_settings.notices` 来自启动时加载的 config | `codex-rs/tui/src/local_settings.rs:53–55` |

二进制侧证据:`strings` 该二进制可见 `Noticehide_full_access_warninghide_world_writable_warning…hide_rate_limit_model_nudge…` 与菜单文案 `Keep current model (never show again) / Hide future rate limit reminders about switching models.`,配置 schema(`codex-rs/core/config.schema.json:2690`)描述为 "Tracks whether the user opted out of the rate limit model switch reminder."。

### 2.2 为什么 Flywheel 的体一定会撞上

- runner 的 `$CODEX_HOME/config.toml` 由 `provisionCodexHome`(`packages/claude-runner/src/codex-home.ts:975`)从宿主 `~/.codex/config.toml` 种子渲染:`pinRunnerPolicy` 钉 `sandbox_mode/approval_policy`(第 483 行),再由 `renderCodexHomeConfig` 追加 GH_TOKEN / notify / skills / workspace-trust 四个 flywheel-managed 块(第 560 行起)。**没有任何一处写 `[notice]`**;种子里只有 `[notice.model_migrations]` 子表(`~/.codex/config.toml:814`),没有 `hide_rate_limit_model_nudge`。
- founder 可见 TUI 是 `codex resume --remote unix://<sock> -C <cwd> -s workspace-write -c 'approval_policy="never"' <thread>`(`codex-runner-tui-window.ts:96–110`),`CODEX_HOME` 指向该 runner home,所以它读到的 notices 就是那份没有开关的 config。
- Flywheel 的模型是 founder 决定的(禁自换模),所以这个菜单对无人值守体只剩两种结果:停在那里等人,或被任何一个误按的 Enter 换成 luna(`override_turn_context` 改的是**线程**的模型,daemon 侧后续 turn 同样受影响)。

### 2.3 「never show again」被按下后写到了哪里

巡检按过的体,Codex 把开关写进了各自的 runner home:`~/.flywheel/codex-homes/*/config.toml` 中 21 份含 `[notice] hide_rate_limit_model_nudge = true`(总 783 份)。其中 12 份被 Codex 追加在 flywheel-managed workspace-trust 块**内部**(`[notice]` 落在 `# <<< flywheel-managed workspace trust (FLY-1961) <<<` 之前),下一次重新 provision 时 `stripManagedTrustBlock`(`codex-home.ts:446`)会连同它一起剥掉。这说明「靠人按 never-show-again」既不能提前预防、也不能持久。

### 2.4 未证实的部分(诚实边界)

- **goal paused 与菜单的因果没有代码路径支持。** 代码里 `setGoalStatus("paused")` 只由 Bridge 自己调用:phase hold(FLY-1269,`codex-daemon-client.ts:959`)与 gate hold(FLY-1257,`codex-daemon-client.ts:1149/1165`)。TUI 是同一线程的第二个客户端,菜单是 TUI 本地状态,不会向 daemon 发 pause。%131/%165 当时更可能处在 Bridge 的有意 hold;巡检的 `/goal resume` 有可能越过了那个 hold。这属于另一类,本单只记录并已向 Lead 提出,不在本单修。
- **「poller 不读信」的准确表述**:Codex 停驻体没有 mailbox 唤醒,它靠自己的 goal turn 轮询 `check/inbox`(`CodexTmuxAdapter.ts:17–22`)。菜单把状态行盖住了,巡检看不到 `Pursuing goal`;至于 turn 是否真的停了,本单没有证据能分开「被菜单挡住」和「本来就在 hold」。

## 3. 目标与非目标

**目标**:runner 出生时就带着「永不弹额度换模菜单」的开关,从根上消除这一类 `INTERACTIVE_MENU`;不换模、不加旋钮、不加告警层。

**非目标**:
- 不做额度逼近时的自动切号(FLY-2109 相邻但不同类)。
- 不改巡检脚本:`INTERACTIVE_MENU` 已能命中该文案(大小写不敏感的 `Press Enter to (confirm|continue)`),修好后该计数归零就是场证据。
- 不碰 goal pause/resume 语义。

## 4. 候选方案

| # | 方案 | 判定 | 理由 |
|---|---|---|---|
| A | provision 时把 `notice.hide_rate_limit_model_nudge = true` 钉进 runner `config.toml`(与 `pinRunnerPolicy` 同层) | **选** | 与 Codex 自己持久化偏好的位置、键名、语义完全一致;一处真相;重新 provision 幂等;不动 argv、不动 TUI 启动命令 |
| B | 给 TUI 启动命令加 `-c notice.hide_rate_limit_model_nudge=true` | 拒 | 同一件事两处写(argv 与 config.toml 镜像),FLY-398 §10 已把 config.toml 定为 Lead 侧唯一被验的来源;runner 侧不该反向再开一条 |
| C | 预先把体的模型设成 luna(`current_model == NUDGE_MODEL_SLUG` 时不弹) | 拒 | 直接违反 founder 的模型决定权 |
| D | 巡检自动按 Down Down Enter | 拒 | 把病根留给巡检;人手/脚本一次只救已卡住的体;被按下的偏好还会被下次 provision 剥掉(§2.3) |
| E | 额度到 90% 自动切号 | 拒(不同类) | 是 FLY-2109 的题;本单先把菜单去掉,切号与否是另一决定 |

## 5. 范围内的第二块(待 Lead 裁)

Codex Lead 的 TUI(`packages/teamlead/scripts/codex-lead-tui-home.sh` 写的 `~/.codex-mufasa` / `~/.codex-honeylemon` / `~/.codex-infra-bot` 的 config.toml)同样没有 `[notice]`,同一版本二进制,同一菜单。已向 Lead 提问(question dffb0ecd),Lead 裁定:纳入,同一个病、同一处修法,不算扩范围;但只钉这一个键,不顺手改别的 config.toml 项、不加开关。

## 6. 待解决的开放问题

1. ~~Lead 对 §5 的裁定。~~ 已裁(纳入,只钉一个键)。另加一条硬要求:修复必须有判别力证明——去掉键能复现菜单;research §7 用假 app-server 接真 TUI 已做到。
2. 存量在飞体(当前 17 个会话)的 TUI 进程是修复前启动的,只能等下一次重新 provision + 重新拉起 TUI(Bridge 重启的 recovery 路径:`CodexTmuxAdapter.executeOwned` 对 recovery 同样走 `provisionCodexHome`,第 758 行)才生效;在那之前巡检的手工处置照旧。这是 rollout 边界,写进 plan。
