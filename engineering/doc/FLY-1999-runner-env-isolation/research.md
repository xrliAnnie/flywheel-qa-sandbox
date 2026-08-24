# FLY-1999 runner 环境继承污染 — 调研

Issue: FLY-1999 (https://linear.app/geoforge3d/issue/FLY-1999/envbug-runnerlead-环境继承污染codex-home-指向-infra-botflywheel-codex-binpath)
日期: 2026-08-23
基于: exploration.md

> 本文所有生产取证均为只读;秘密只验存在性,值从未打印。取证时刻:2026-08-23(设计节点会话内)。会过期的结论已在 §9 单列。

## 1. 现场取证(生产 default tmux server)

### 1.1 server 出生记录

```
tmux display-message -p '#{pid} #{start_time}'
→ server_pid=6234  start=1787234985 (2026-08-20 07:09:45)
ps -o pid,ppid,lstart,command -p 6234
→ PPID=1 (launchd, daemon 化后 reparent), COMMAND = `tmux new-session -Ad -s flywheel`
```

宿主 launchd 起于 2026-08-20 01:35(当天重启)。出生命令 `new-session -Ad -s flywheel` 与 `packages/teamlead/src/lead-backends/codex/tui-window.ts:136`(`TUI_TMUX_SESSION = "flywheel"`,tui-window.ts:27)**逐字吻合**——这条命令只有 Codex Lead TUI runtime 的 `ensureTuiWindow()` 会发。

### 1.2 server 全局 env(`tmux show-environment -g`)——污染体本体

- `CODEX_HOME=/Users/xiaorongli/.codex-infra-bot`
- `FLYWHEEL_CODEX_BIN=/Users/xiaorongli/.codex-infra-bot/packages/standalone/current/codex`
- `FLYWHEEL_LEAD_ID=codex-infra-bot-lead`、`FLYWHEEL_CODEX_LEAD_STATE_DIR=.../codex-lead/codex-infra-bot-lead`、`DISCORD_STATE_DIR=.../discord-codex-infra-bot-lead`、`FLYWHEEL_CODEX_LEAD_MODE=tui`、`FLYWHEEL_CODEX_TUI_CWD=~/Dev/flywheel` —— **整套 infra-bot Lead 启动身份**
- 秘密存在性:`OPENAI_API_KEY`/`DISCORD_BOT_TOKEN`/`LINEAR_API_KEY`/`TEAMLEAD_API_TOKEN`/`TADASHI_BOT_TOKEN`/`SUPABASE_SERVICE_ROLE_KEY`/`VERCEL_TOKEN` 全部 PRESENT
- `PATH=~/.local/bin:~/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`(值本身是标准序,PATH 不是 env 病)

结论:server 全局 env = `run-codex-infra-bot-tui.sh` 的进程环境快照(该脚本 L72-73 显式 export 前两项,并 set -a source `~/.flywheel/.env`)。

### 1.3 session 级 env(`show-environment -t =flywheel`)

只有 tmux `update-environment` 默认名单(DISPLAY/SSH_* 等),其中 `SSH_AUTH_SOCK` 为 set 状态——founder 终端 attach 时被导入。`SSH_AUTH_SOCK` 是 FLY-1188 点名的 auth-capable handle,allowlist 应不含它(runner 推送走 https,见 §5)。

### 1.4 Bridge 进程 env(pid 13435,`ps eww` 过滤名)

- `OPENAI_API_KEY`:PRESENT(来自 wrapper `set -a; source ~/.flywheel/.env`,`scripts/flywheel-bridge-wrapper.sh:46-48`)
- `CODEX_HOME` / `FLYWHEEL_CODEX_BIN`:**不在** Bridge env

⇒ infra-bot 路径不是 Bridge 注入的;runner 拿到它们只能经 tmux server 全局 env。同时说明:如果那天是 Bridge 先起 server,秘密照样全量固化,只是身份路径换一副面孔——**出生竞赛的每个候选人都带病**。

### 1.5 本设计 runner 自身 env(活症状)

175 个变量;`CODEX_HOME`/`FLYWHEEL_CODEX_BIN` = infra-bot;四类秘密 PRESENT;约 30 个 stale `FLYWHEEL_*`(含 `FLYWHEEL_CODEX_LEAD_*`、`FLYWHEEL_LEAD_KEY/ROLE/RULES_BUNDLE`、`FLYWHEEL_ALERT_*` 等)。`DISCORD_BOT_TOKEN` absent(FLY-1715 六名单剥离生效的直接证据)。`FLYWHEEL_LEAD_ID=flywheel-eng-lead`——被 launch 时 `-e` 显式覆盖(TmuxAdapter.ts:691),盖住了 server 层的 `codex-infra-bot-lead`,这正是"显式注入赢过继承"这一 tmux 语义的实证。

### 1.6 磁盘面(症状 3)

```
~/.local/bin/codex -> /Users/xiaorongli/.codex-mufasa/packages/standalone/current/bin/codex
~/.npm-global/bin/codex -> ../lib/node_modules/@openai/codex/bin/codex.js  (npm 正装,被 .local/bin 排序压住)
command -v codex → ~/.local/bin/codex
```

Mufasa 的 Codex native updater 曾把全局轴 `~/.local/bin/codex` 改写指向自己的 standalone 安装(FLY-1955 已用 `CODEX_INSTALL_DIR=<lead-home>/.local/bin` pin 防再犯并接 FLY-513 漂移告警;**既有 symlink 未复位,属运维动作**)。注意:二进制归属是版本溯源问题;账号身份由 `CODEX_HOME` 决定——本单修好 env 后,"用谁的号"即被治好,"跑谁装的二进制"由 FLY-513/1955 域收口。

## 2. 机制审计:runner pane env 是怎么组成的

tmux 语义:**pane 子进程 env = server 全局 env + session env + 该窗 `new-window -e` 覆盖**。发起 `new-window` 的客户端(Bridge)自身 env 不进 pane(除 update-environment 名单)。

### 2.1 现有边界:`buildAmbientSafeWindowCommand`(TmuxAdapter.ts:172)

```
env -u LEAD_ID -u DISCORD_STATE_DIR -u DISCORD_BOT_TOKEN -u TEAMLEAD_API_TOKEN \
    -u BRIDGE_URL -u PROJECT_NAME [PROJECT_NAME=<ctx>] <binary> <args...>
```

`AMBIENT_IDENTITY_DENYLIST` 恰 6 名(TmuxAdapter.ts:70-77),注释自述 intentionally narrow。gate 版本(sh -c 等 commit token 再 exec)同样把这段 env 前缀作为最终 exec 目标。**该边界是本单的手术位点:机制在,策略换。**

### 2.2 `-e` 显式注入全量清单(allowlist 协议段的实现依据)

TmuxAdapter.execute()(launch 入口)逐条盘点(行号为当前 HEAD 67da67b0c):

| 注入名 | 条件 | 行 |
|--------|------|-----|
| FLYWHEEL_CALLBACK_PORT / FLYWHEEL_CALLBACK_TOKEN / FLYWHEEL_ISSUE_ID | hookServer 模式 | 514-519 |
| FLYWHEEL_COMM_DB | ctx.commDbPath | 525 |
| FLYWHEEL_EXEC_ID | 恒 | 529 |
| FLYWHEEL_RUNNER_STATE_DIR | sentinelDir | 575 |
| FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1 | commdb 回滚档 | 586 |
| TMPDIR=browserTmp | browser 隔离 tmp | 624 |
| FLYWHEEL_BRIDGE_URL / FLYWHEEL_INGEST_TOKEN | ctx | 634/637 |
| FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL / _EXPECTED / _OUTPUT_CREDENTIAL / FLYWHEEL_FOUNDER_REVIEW_REQUIRED | workflow ctx | 640-655 |
| FLYWHEEL_STATE_DB_PATH | ctx.stateDbPath | 661 |
| FLYWHEEL_COMPLETE_MARKER_DIR | env 透传(FLY-1608) | 668 |
| FLYWHEEL_PROGRESS_PATH / FLYWHEEL_PROJECT_NAME | ctx | 672/675 |
| PROJECT_NAME=<ctx 或空> + LEAD_ID= / DISCORD_STATE_DIR= / DISCORD_IDENTITY_MODE= / DISCORD_BOT_TOKEN=(置空) | 恒 | 681-685 |
| FLYWHEEL_LEAD_ID | ctx.leadId | 691 |
| FLYWHEEL_COMM_CLI | 可解析时 | 697 |
| FLYWHEEL_LAND_STATUS_PATH | ctx.sentinelPath | 711 |
| BASH_MAX_TIMEOUT_MS=176400000 | 恒(FLY-102/159) | 719 |
| transportSpawnConfig.env(Agent Team mailbox 身份,若干 key) | transport 接通 | 723-727 |
| extraPaneEnv()(Kimi: NODE_OPTIONS=--dns-result-order=ipv4first) | 子类 seam(FLY-494) | 733-735 |

⇒ **allowlist 的协议段可以精确等于"本次 launch 实际注入的名字集合"**——adapter 在构造 envArgs 时就地收集名字,零猜测。这直接排除了"blanket 保留 FLYWHEEL_*"方案(那会把 server 层 stale 的 FLYWHEEL_CODEX_BIN / FLYWHEEL_CODEX_LEAD_* 一并放行,症状 2 修不掉)。

### 2.3 server 出生点盘点(方案 B 的手术位点)

| 出生点 | 进程宿主 | 出生 env 内容 | 备注 |
|--------|---------|--------------|------|
| `lead-backends/codex/tui-window.ts:136` `new-session -Ad -s flywheel` | Codex Lead TUI runtime | Lead launcher 全套(**本次事故的实际出生者**) | fail-open 设计,spawnSync |
| `TmuxAdapter` ensureSession → rescue CLI `has-session --create new-session -d`(TmuxAdapter.ts:1890-1907) | Bridge | Bridge env(.env 全量秘密) | FLY-1659 FIFO 门控路径 |
| `codex-runner-tui-window.ts:749` `new-session -Ad` | Bridge | 同上 | Codex runner TUI 窗 |

以及理论出生者:founder 手动在带 .env 的 shell 里敲第一条 tmux 命令。⇒ 出生点卫生只能覆盖代码内位点,存量/人工路径靠方案 C 的 boot scrub 兜底。

### 2.4 Codex runner 对照(为什么它免疫)

- daemon:`CodexTmuxAdapter.buildDaemonEnv`(:1633)= `stripInheritedSecretEnv(process.env)` 严格 allowlist(SAFE_BASE_ENV,codex-home.ts:138-162 + LC_* + userinfo 洗过的 proxy;**继承的 FLYWHEEL_* 全丢**)+ 显式分层执行域协议变量。daemon 是 Bridge 直接子进程,不经 pane。
- codex 身份:FLY-123 per-execution `CODEX_HOME`(provisionCodexHome),TUI 窗命令串里显式 `CODEX_HOME="<per-runner home>"`(codex-runner-tui-window.ts:119);这里隔离的是运行目录和同一共享账号的凭据快照,不是为每个 runner 建独立账号或要求独立登录。
- 残余暴露:Codex TUI **pane** 本身仍继承污染 env(display client 进程可见秘密)——统一 pane 洗法应顺带覆盖,且必须保留其命令串内的显式 CODEX_HOME 赋值(赋值在 exec 层,晚于 env 洗,天然保留)。

### 2.5 受害面矩阵

| Runner 形态 | 执行体 env | pane env | codex 身份 |
|-------------|-----------|----------|-----------|
| claude-tmux(+Kimi/Antigravity 子类) | = pane env(**病**) | 污染(**病**) | 继承 CODEX_HOME=infra-bot(**病**,症状 1 主场) |
| codex-tmux daemon | 白名单构造 ✅ | n/a | per-execution home ✅ |
| codex-tmux TUI 窗 | codex 进程拿显式 CODEX_HOME ✅ | 污染(次要暴露) | ✅ |

## 3. `.env` 装载链(症状 4 的源头)

`~/.flywheel/.env` 共 175 行:约 30 个 bot token、`OPENAI_API_KEY`(export 形式)、`LINEAR_API_KEY`、`SUPABASE_*`、`VERCEL_TOKEN`、`ELEVENLABS_API_KEY` 等。装载点:

- `scripts/flywheel-bridge-wrapper.sh:46-48`:`set -a; source "$ENV_FILE"`(launchd 极简 env 的补偿设计——注释明说 bare `KEY=value` 行也要成为子进程 env)。
- 各 Lead launcher(`run-codex-*-tui.sh` 族、claude-lead v2 wrapper)同款模式。

**本单不动 `.env` 装载模式**(Bridge/Lead 自身确实需要这些秘密;瘦身属 FLY-39 泄露面姊妹单)。本单切断的是"从 Bridge/Lead env → tmux server → runner pane"的**转运链**。

## 4. 修法核心机制的技术验证(R3)

### 4.1 为什么必须在 pane 内 exec 层洗,而不是 tmux 层

`new-window -e` 只能**加/改**,不能表达"除名单外全删";`set-environment -u` 改的是 server/session 层(影响所有窗,竞态)。唯一能表达"从零重建"的位点就是 pane 内启动命令的 `env -i` 前缀——恰好 `buildAmbientSafeWindowCommand` 已是所有 runner 窗的公共 exec 前缀。

### 4.2 保值不进 argv 的 POSIX 惯用法

```sh
exec env -i ${PATH+"PATH=$PATH"} ${HOME+"HOME=$HOME"} ... ${FLYWHEEL_EXEC_ID+"FLYWHEEL_EXEC_ID=$FLYWHEEL_EXEC_ID"} "$@"
```

- 值由 **pane shell 从自己的 env 展开**(`-e` 的覆盖已先落进 pane env,故显式注入永远赢);值不出现在 tmux 命令 argv → 不扩大 ps 可见面、不吃 TMUX_COMMAND_BUDGET;
- `${VAR+"VAR=$VAR"}`:unset 时整个词消失(保持 unset ≠ 空串),set 时是**单个带引号词**(空格/引号安全);
- 名字来源:adapter 内程序化生成,写入前逐名校验 `^[A-Za-z_][A-Za-z0-9_]*$`(名字进 sh 模板文本,必须闭注入面);值永远不进模板文本。
- `LC_*` 家族无法通配展开 → 枚举 POSIX 固定集(LC_ALL/LC_CTYPE/LC_COLLATE/LC_MESSAGES/LC_MONETARY/LC_NUMERIC/LC_TIME)。

### 4.3 与 gate wrapper 的组合

现 gate 路径:`sh -c '<等 token 脚本> ... exec "$@"' <gateFile> <token> <cleanup> <promptFile> env -u ... <binary> ...`。洗法落点 = 替换 `"$@"` 里的 `env -u` 前缀段为 `env -i` 重建段;等 token 循环逻辑零改动。非 gate 直跑路径同前缀。

## 5. 被洗掉名字的依赖审计(R2,已做的抽查 + 实现期要求)

已实证的"洗掉安全":

- **Claude 认证**:runner env 无 `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`(实测 absent)⇒ 走 `~/.claude` OAuth,只依赖 HOME(在名单)。
- **git push**:origin = https(`gh` credential helper/keychain)⇒ 不依赖 `SSH_AUTH_SOCK`(该 handle 正是 FLY-1188 点名要挡的)。
- **flywheel-comm CLI**:`packages/flywheel-comm/src` 零处读 `FLYWHEEL_STATE_DIR`/`FLYWHEEL_ROOT`(grep 实测);其依赖(FLYWHEEL_COMM_DB/BRIDGE_URL/INGEST_TOKEN/EXEC_ID/…)全部在显式注入清单内。
- **codex-with-fallback / codex-profile**:PATH 解析(PATH 在名单);身份由 CODEX_HOME 决定——洗掉后回落 `~/.codex`,正是 `codex-profile use` 的写入目标(验收 3 的机制闭环)。

实现期硬要求(不可省):对"当前污染 env 有、洗后没有"的**全部名字**做全仓消费者 sweep(packages/ + scripts/ + `~/.flywheel/hooks/` 里 runner 侧可执行面),逐名给出 `无消费者 | 有消费者且已在注入清单 | 有消费者需补注入` 三态结论表。凡 sweep 与真机 E2E 矛盾,以真机为准。

## 6. scrub 名单构成(R4)

- 来源 1:解析 `~/.flywheel/.env` 的**变量名**(只读名——`cut -d= -f1` 级别解析,兼容 `export K=V` 与 `K=V`;值零读取零打印)。
- 来源 2:固定身份名单:`CODEX_HOME`、`FLYWHEEL_CODEX_BIN`、`FLYWHEEL_CODEX_LEAD_*`、`FLYWHEEL_CODEX_TUI_*`、`FLYWHEEL_LEAD_*`、`DISCORD_*`、`AMBIENT_IDENTITY_DENYLIST` 六名。
- 扣除:canonical 保留集(PATH/HOME 等 OS 基底——scrub 不动它们,PATH 若非 canonical 序则**改写为 canonical**)。
- 位点:Bridge boot(幂等,逐名 `set-environment -g -u`;session 层同名一并 `-u`)。零新 timer。
- 边界:已开 pane 的 env 无法追溯修改(POSIX 无此能力)——存量 runner 带病到自然换代,写入诚实边界。

## 7. 验收 → 测试形态映射(R5)

| 验收 | 测试形态 |
|------|---------|
| 1. runner 内 codex 凭据身份 == 预期(解码 auth 断言 email) | 真机 E2E:隔离 socket 起**故意污染**的 tmux server(镜像 §1.2 名单、dummy 值)→ 经 adapter 真实路径开窗 → pane 内 `codex` 读到的 auth = `~/.codex/auth.json`(断言 CODEX_HOME unset + auth 文件路径/emailclaim);**阳性对照**:同 server 上绕过洗法的裸窗必须读到污染身份(证明尺子能变红) |
| 2. runner env 零非必需秘密 | 同一 E2E 捕获 pane 全量 env 名集合,断言 = allowlist 精确集(denylist 思维改为**逐名相等**,不是"没看见坏名字"——absence-of-bad-news 教训);秘密名单(§1.2 全表)逐名 assert absent |
| 3. `codex-profile use` 切号后新 spawn 随号 | E2E:切 dummy profile 写 `~/.codex/auth.json`(隔离 FLYWHEEL_CODEX_SOURCE_HOME 假 home,不碰真凭据)→ 新开窗读到新身份 |
| 4. 污染源头书面结论 | 本文 §1-§3 + exploration.md §3(已交付) |

单元层:allowlist 模板生成(名字校验拒绝集/`${+}` 惯用法/unset 保持)、真 sh 执行对照(crafted 污染 env → 断言产出 env 精确集)、出生 helper `env -i` 组合、scrub 名单解析(.env fixture 名读取,值不出现在任何输出)。

## 8. 实现期 dropped-name 消费者全仓 sweep(S7)

2026-08-23 在实际 implement runner 的环境名快照上,逐名扫描 `packages/`、`scripts/` 与已部署 `~/.flywheel/hooks/`;仅搜索变量名,未读取或输出变量值。结果先把现有名字分成三组:

- OS 基底保留:`EDITOR`、`HOME`、`LANG`、`LC_*`、`LOGNAME`、`PAGER`、`PATH`、`PWD`、`SHELL`、`TERM`、`TMPDIR`、`USER`;
- 本 launch 显式协议保留:`FLYWHEEL_AGENT_NAME`、`FLYWHEEL_AGENT_TEAM_NAME`、`FLYWHEEL_BRIDGE_URL`、`FLYWHEEL_COMM_CLI`、`FLYWHEEL_COMM_DB`、`FLYWHEEL_EXEC_ID`、`FLYWHEEL_GATE_MARKER_DIR`、`FLYWHEEL_INGEST_TOKEN`、`FLYWHEEL_ISSUE_ID`、`FLYWHEEL_LEAD_ID`、`FLYWHEEL_PROJECT_NAME`、`FLYWHEEL_RUNNER_BACKEND_ID`、`FLYWHEEL_RUNNER_VENDOR_ID`、`FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED`——这些不是 ambient 继承,均由 `appendPaneEnv()`/transport 当次注入;
- 其余名字进入下面的删除审计。

| 删除的 ambient 名 | 三态结论 | 证据/处理 |
|---|---|---|
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`、`CODEX_CI`、`CODEX_SANDBOX`、`CODEX_SESSION_ID`、`CODEX_THREAD_ID`、`COLORTERM`、`FISH_API_KEY`、`FPATH`、`GH_PAGER`、`GOG_ACCOUNT`、`HOMEBREW_CELLAR`、`HOMEBREW_PREFIX`、`HOMEBREW_REPOSITORY`、`INFOPATH`、`MAX_THINKING_TOKENS`、`MINIMAX_API_KEY`、`NANOBANANA_MODEL`、`NODE_EXTRA_CA_CERTS`、`NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S`、`NO_COLOR`、`OLDPWD`、`OPENCLAW_DISCORD_TOKEN`、`OPENCLAW_HOOKS_TOKEN`、`PYENV_ROOT`、`PYENV_SHELL`、`SHLVL`、`_`、`__CF_USER_TEXT_ENCODING` | 无 runner 消费者 | production runner/两个部署 hook 无读取;`NODE_EXTRA_CA_CERTS` 是 Node 平台可选入口,但当前部署无此依赖,不应为未来可能性放宽秘密边界。 |
| `ELEVENLABS_API_KEY`、`GOOGLE_API_KEY`、`LINEAR_API_KEY`、`NANOBANANA_GEMINI_API_KEY`、`OPENAI_API_KEY`、`SUPABASE_KEY`、`SUPABASE_URL`、`TEAMLEAD_NOTIFICATION_CHANNEL`、`TEAMLEAD_OWNS_SLACK` | 有消费者,但仅 Bridge/Lead/voice/独立运维面 | 这些消费者在 runner pane 外;runner 的 Linear/Bridge 操作走 `flywheel-comm` 显式能力,无需原始秘密。无需补注入。 |
| `TEAMLEAD_URL` | 有消费者且已有显式替代注入 | `Blueprint.resolveBridgeUrl()` 在 Bridge 内读取后以 `FLYWHEEL_BRIDGE_URL` 注入 runner;runner hook/CLI 读后者。无需保留 legacy ambient 名。 |
| `CODEX_HOME` | 有消费者且由身份边界显式设置 | production Codex daemon 已在 `buildDaemonEnv()` 显式设 per-runner home(同一共享账号凭据的隔离快照,不是独立账号);founder runner TUI 在 pane wash 后显式设 `spec.codexHome`;ambient 值必须删除。仓内唯一 runner-like ambient reader是隔离 QA stub,由其 test harness 显式供给。 |
| `GH_TOKEN` | 有消费者,但不在 runner pane | 命中 teamlead gateway/Bridge 文档 git 路径;runner 的 `gh`/HTTPS git 通过 keyring。实测在 exact base allowlist 的 `env -i` 下 `gh auth status` 成功,当前 origin push URL 为 HTTPS。无需补注入。 |
| `GIT_PAGER` | 无必需消费者 | `flywheel-comm qa-result` 自己给子进程设置非交互 pager,不依赖 inherited 值;删除仅影响显示偏好。 |

三态结论:`有消费者需补注入` = **零项**。部署 hook 只消费 `HOME` 与当次显式注入的 `FLYWHEEL_*`;因此实现没有为 sweep 结果扩张 allowlist。

书面根因结论不变:2026-08-20 的共享 tmux server 由 Codex infra-bot Lead TUI 的 `tmux new-session -Ad -s flywheel` 首次创建,把该 Lead 的 `CODEX_HOME`/`FLYWHEEL_CODEX_BIN`/整套 Lead 身份和 `.env` 秘密固化为 server global env;Bridge 后续 `new-window` 继承该快照。根因不是某一个账号或切号器,而是“任意带全量环境的出生竞争者 + pane 未做正向边界”的组合。

## 9. 相关单边界

- **FLY-1893**(per-runner CODEX_HOME 磁盘面):Claude runner 的 codex 仍共享 `~/.codex`(随 codex-profile 轮转)——这是本单的**刻意选择**;即使使用隔离快照,也仍是同一共享账号,per-execution 磁盘隔离归 1893。
- **FLY-39**(秘密扫描):`.env` 全量 set -a 的瘦身/分域归它;本单只断转运链。
- **FLY-513/FLY-1955**:`~/.local/bin/codex` symlink 复位 = 运维动作 + 既有漂移告警域;本单文档留 runbook 一行,不写代码。
- **1756 族**(自动切号器):验收 3 是它的前置——本单交付后 codex-profile 的写入目标重新被 codex 读到。

## 10. 会过期的结论(as-of 2026-08-23)

| 结论 | 失效条件 | 重核命令 |
|------|---------|---------|
| default server pid 6234 / 出生者 = infra-bot Lead | 任何 server 重启(出生者重掷骰子) | `tmux display-message -p '#{pid} #{start_time}'` + `ps -o command= -p <pid>` |
| server 全局 env 携带 §1.2 名单 | scrub 落地或 server 重生 | `tmux show-environment -g \| cut -d= -f1` |
| `~/.local/bin/codex` → mufasa | 运维复位 symlink | `readlink ~/.local/bin/codex` |
| `.env` = 175 行、含 export OPENAI_API_KEY | .env 被编辑 | `grep -c "" ~/.flywheel/.env` |
| TmuxAdapter 行号引用(HEAD 67da67b0c) | main 前进 | `git log -S <符号> -1` 重定位 |
