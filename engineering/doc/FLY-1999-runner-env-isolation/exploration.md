# FLY-1999 runner 环境继承污染 — 探索

Issue: FLY-1999 (https://linear.app/geoforge3d/issue/FLY-1999/envbug-runnerlead-环境继承污染codex-home-指向-infra-botflywheel-codex-binpath)
日期: 2026-08-23
基于: 无

## 1. 问题一句话

runner 的进程环境不是"按这个 runner 的身份构造出来的",而是"碰巧继承了谁先起 tmux server 谁的全套环境"——2026-08-22 晚它继承的是 codex-infra-bot Lead 的环境,导致 runner 里的 `codex` 全用 infra-bot 凭据、`OPENAI_API_KEY` 等秘密全量下发,酿成一晚连环误诊 + 跨号烧量 + 一次明文泄露。

## 2. 症状复核(2026-08-23 本设计节点在自己进程内实测,全部仍在)

本设计 runner(execution `192de8bf`)自己的环境就是活症状:

| # | Issue 声称 | 本节点实测 | 状态 |
|---|-----------|-----------|------|
| 1 | `CODEX_HOME=~/.codex-infra-bot` | `CODEX_HOME=/Users/xiaorongli/.codex-infra-bot` | ✅ 复现 |
| 2 | `FLYWHEEL_CODEX_BIN` 指 infra-bot 安装 | `=/Users/xiaorongli/.codex-infra-bot/packages/standalone/current/codex` | ✅ 复现 |
| 3 | PATH 解析 `codex` → mufasa 安装 | `~/.local/bin/codex -> ~/.codex-mufasa/packages/standalone/current/bin/codex`(磁盘 symlink) | ✅ 复现 |
| 4 | `OPENAI_API_KEY` 等秘密全量下发 | `OPENAI_API_KEY`/`LINEAR_API_KEY`/`TADASHI_BOT_TOKEN`/`SUPABASE_SERVICE_ROLE_KEY` 全部 PRESENT(只验存在性,值未打印) | ✅ 复现 |

额外发现:本 runner env 共 **175 个变量**,其中约 30 个 stale `FLYWHEEL_*` 来自别的 Lead 的启动环境(`FLYWHEEL_CODEX_LEAD_*` 五件套、`FLYWHEEL_LEAD_KEY/ROLE/RULES_BUNDLE` 等 **Lead 身份变量**混在 runner 环境里)。`DISCORD_BOT_TOKEN` 是唯一 absent 的秘密——因为它在 FLY-1715 的 6 名单里,说明**剥离机制本身有效,只是名单太窄**。

## 3. 根因链(逐层实证,证据见 research.md)

```
~/.flywheel/.env (175 行,set -a source 全量入 env)
        │
        ├──> Bridge wrapper (flywheel-bridge-wrapper.sh: set -a; source .env)
        │        Bridge 进程 env = 全部秘密(实测 OPENAI_API_KEY 在,infra-bot 路径不在)
        │
        └──> codex-infra-bot Lead TUI launcher (run-codex-infra-bot-tui.sh)
                 export CODEX_HOME=~/.codex-infra-bot        ← L72
                 export FLYWHEEL_CODEX_BIN=$CODEX_HOME/...   ← L73
                 + set -a .env 全量秘密 + FLYWHEEL_CODEX_LEAD_* 身份
                 │
                 │ 2026-08-20 01:35 宿主重启 → default tmux server 死
                 │ 2026-08-20 07:09:45 该 Lead 的 ensureTuiWindow() 执行
                 │   `tmux new-session -Ad -s flywheel`  ← 重启后第一条 tmux 命令
                 ▼
        default tmux server (pid 6234) 出生,全套污染 env 固化为 server 全局环境
                 │
                 │ tmux 语义:pane env = server 全局 env + session env + 每窗 -e 覆盖
                 ▼
        此后每个 runner 窗口(claude-tmux / kimi / antigravity / codex TUI 窗)
        以污染 env 为基底出生;FLY-1715 只 `env -u` 剥 6 个名字,其余全过
```

**四个症状各自的最后一跳**:

- 症状 1/4(CODEX_HOME、秘密):tmux server 全局 env 直接继承进 pane。
- 症状 2(FLYWHEEL_CODEX_BIN):同上;它让 pane 内任何调 `flywheelCodexBin()` 的路径显式选中 infra-bot 的二进制。
- 症状 3(PATH→mufasa):**不是 env 病,是磁盘病**——`~/.local/bin/codex` 这个全局轴上的 symlink 被 Mufasa 的 Codex native updater 改写指向 `.codex-mufasa`(FLY-1955 已修 Lead 侧 `CODEX_INSTALL_DIR` pin 防再犯,FLY-513 有漂移告警;既有 symlink 本身未复位)。PATH 值本身是正常的标准序。
- **误诊/跨号的合成机制**:pane 内 `codex`(经 PATH→mufasa 二进制)+ `CODEX_HOME=infra-bot`(env)⇒ 二进制是 mufasa 的、**凭据是 infra-bot 的**;`codex-profile use` 只写 `~/.codex/auth.json`,而 codex 因 CODEX_HOME 指向别处从来不读它 ⇒ "五个 profile 同 reset 时刻"= 同一个 infra-bot 号被测五遍。

## 4. 为什么会走到今天(结构性理解)

1. **FLY-1715 的边界是刻意窄的**:`AMBIENT_IDENTITY_DENYLIST` 注释自述 "The allow-by-default boundary is intentionally narrow" ——当时按事故涉案的 6 个名字收口,是合理的最小修。FLY-1999 的新证据证明 allow-by-default 本身就是病根:名单永远追不上污染集合(这次是 CODEX_HOME/OPENAI_API_KEY/30 个 stale FLYWHEEL_*,下次是别的)。
2. **server 出生权是一场无主竞赛**:重启后谁第一个碰 tmux,谁的全套 env 就成为所有后续窗口的基底。生产里至少三类进程都可能赢:Bridge(TmuxAdapter.ensureSession)、Codex Lead TUI runtime(ensureTuiWindow)、Codex runner TUI(codex-runner-tui-window)。**没有任何一处对出生 env 做卫生处理**。这次是 infra-bot Lead 赢;换个重启时序就是 Bridge 赢(秘密照样全量,只是身份路径不同)——所以这不是 infra-bot 的 bug,是所有出生点共同的 bug。
3. **`.env` 的 set -a 全量装载**是秘密扩散的放大器:Bridge 和每个 Lead launcher 都把 175 行(30+ bot token、云服务密钥)整体注入自身 env,再顺着出生/继承链条流进每个 pane。

## 5. 已有的"对照组"——正确姿势在仓里已经存在

| 先例 | 机制 | 与本病的关系 |
|------|------|-------------|
| FLY-1188/1643 `buildDaemonEnv`(CodexTmuxAdapter) | `stripInheritedSecretEnv()`:**严格 allowlist**(SAFE_BASE_ENV + LC_* + 洗过 userinfo 的 proxy),继承的 FLYWHEEL_* 全丢,再显式分层本 execution 的协议变量 | Codex runner 的 daemon 因此**天生免疫**——它是 Bridge 直接子进程,不走 pane 继承。这就是本设计要搬到 tmux pane 边界的模板 |
| FLY-123 per-runner CODEX_HOME | Codex runner 每 execution 使用隔离的运行目录与同一共享账号凭据快照(不是每 runner 一个账号/独立登录) | Codex runner 的 codex 身份路径已正确;受害者是 **Claude runner 里 shell 出去的 codex**(codex-code-review / codex-rescue),它们裸继承 pane env |
| FLY-1715 pane `env -u` 六名单 | 剥离机制(env 边界)已存在且有效 | 只需把"六名单 denylist"换成"allowlist 重建",机制骨架复用 |
| FLY-1955 `CODEX_INSTALL_DIR` pin | Lead managed start 固定 per-Lead 安装轴 | 防止 native updater 再改写全局 `~/.local/bin/codex`;**既有 symlink 的复位是运维动作**,不在本单代码面 |

## 6. 修法方向盘点(结论:方案 A 为核心,B/C 为纵深)

### 方案 A:pane 边界 allowlist 重建(核心修,直接命中验收 1/2/3)

把 `buildAmbientSafeWindowCommand` 的 `env -u <6名>` 升级为**从零重建**:pane 内 exec 前用 `env -i` + 逐名保留(OS 基底 ∪ TMUX 身份 ∪ 本次 launch 显式注入的协议名单)。不在名单 = 不存在。CODEX_HOME 被自然清掉 → codex 回落 `~/.codex` → `codex-profile use` 重新生效(验收 3);秘密清零(验收 2)。

- 优点:结构性根治;不依赖 server 是否干净;Kimi/Antigravity 子类免费继承;与 FLY-1188 policy 同源。
- 风险:allowlist 漏了 runner 真需要的名字 → spawn 挂。缓解:名单从实测依赖出发(HOME→~/.claude OAuth、PATH→工具、git=https 不需 SSH_AUTH_SOCK,均已核),实现期做 dropped-name 消费者全仓 sweep + 真机 E2E。

### 方案 B:server 出生点卫生(防再污染)

三个生产出生点(`TmuxAdapter.ensureSession`、`tui-window.ts`、`codex-runner-tui-window.ts`)统一经共享 helper 用最小规范 env 起 server(`env -i PATH=<canonical> HOME=... tmux new-session ...`)。重启竞赛谁赢都不再把自己的全套 env 固化进 server。

### 方案 C:存量池清扫(Bridge boot 幂等 scrub)

server 已经污染的现网:不能杀 server(会杀掉 founder 的 cmux 视图和所有活 runner)。用 `tmux set-environment -g -u <name>` 逐名清除:名单 = `.env` 解析出的变量名(只读名,不读值)∪ 已知身份名单。挂在 Bridge boot(幂等、零新 timer)。已开 pane 无法追溯改 env——只能等自然换代,诚实边界写明。

### 被否掉的选项

- **只扩 denylist(FLY-1715 加名字)**:这次证明 denylist 永远慢一步;第 30 个 stale FLYWHEEL_* 说明污染集合是开放的。否。
- **杀掉/重启 default tmux server**:摧毁 founder cmux 视图 + 全部活 runner,代价不成比例。否。
- **给 Claude runner 也做 per-execution CODEX_HOME**:改变 runner 侧 codex 的账号轮转语义(现在刻意共享 `~/.codex` 随 codex-profile 走),是 FLY-1893 的领域,不混入本单。

## 7. 威胁模型的诚实边界(必须写进设计)

runner 与 Lead 同 macOS 用户、无 sandbox——它**随时可以主动读** `~/.flywheel/.env` 和任何 auth.json。所以本修**不是** confinement(防恶意),而是:

1. **身份确定性**:runner 里工具解析到的身份 == 该 runner 的目标身份,不再看运气;
2. **事故卫生**:`env` 自查/日志/transcript 不再天然携带全量秘密(本次明文泄露正是 runner 自查 env 打进 transcript);
3. **最小默认视图**:不需要的东西默认不在场。

## 8. 待研究问题(→ research.md)

- R1: TmuxAdapter 全部 `-e` 注入的精确清单(协议 allowlist 的实现依据)。
- R2: 被洗掉名字的 runner 侧消费者 sweep 范围与方法。
- R3: `${VAR+"VAR=$VAR"}` sh 惯用法在 gate wrapper 里的组合细节与注入面校验。
- R4: scrub 名单的构成(`.env` 名解析 + 固定身份名单)与幂等实现位点。
- R5: 验收四条各自的可执行测试形态(真 tmux、阳性/阴性对照)。
