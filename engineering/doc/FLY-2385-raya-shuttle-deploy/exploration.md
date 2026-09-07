# FLY-2385 Raya 仓纳入班车部署 + 「合入≠上线」防线 — 探索
Issue: FLY-2385 (https://linear.app/geoforge3d/issue/FLY-2385/raya运维-raya-仓纳入班车部署-合入上线防线生产-checkout-落后-originmain-244-commits)
日期: 2026-09-06
基于: 无

## 1. 事故还原（事实，全部本机核过）

| 事实 | 证据 |
|---|---|
| 生产 Raya 运行目录 `~/.flywheel/raya/code` 于 2026-09-06 15:2x PT 被发现停在 8-28 的 `bb9656f`，落后 `origin/main` 244 commits；raya#9(FLY-2031)、raya#14(FLY-2249) 合入后从未上线 | issue 正文；本机 `git -C ~/.flywheel/raya/code log` 现已在 `b1b5a64`（手工追上后） |
| 班车 `com.flywheel.updater` 每天 00:00/12:00 只看 flywheel 仓：`update-flywheel.sh` 比较 `~/.flywheel/deployed-sha` 与 flywheel 的 `origin/main`，落后才调 `restart-services.sh` | `scripts/update-flywheel.sh:527-540` |
| `restart-services.sh`（3368 行）全文没有 `raya/code`、`com.xrli.raya.*` 任何引用；唯一读该目录的生产脚本是 `qa-raya-voice.sh:6`（只借 QA harness） | 两个审计代理 grep 结论一致 |
| updater census 报的 `codex-raya=0` 是 **Lead TUI carrier plist 计数**（`host-tmux-selection-gate.sh:176`），与 Raya 仓部署毫无关系；launchd 舰队 census 的 `census-scope` 只有 `com.flywheel.` / `com.xiaohongshu` / `com.codex.xiaohongshu`，Raya 的 `com.xrli.raya.*` 根本不在视野里 | `scripts/launchd/units.manifest:4-6` |
| `~/.flywheel/raya/` 下没有任何 `deployed-sha` 账本；两张 plist 直接指向 `~/.flywheel/raya/code/apps/{brain,voice}/dist/cli.js`，**不 build 就 kickstart = 跑旧 JS** | `plutil -p ~/Library/LaunchAgents/com.xrli.raya.brain.plist` |
| Raya brain 自带 `raya preflight` 子命令：探 Codex 可用性 + Discord bot 身份，输出 JSON `{ready, pending, discord, codex}`，`ready=true` 退 0，否则退 75 | `~/.flywheel/raya/code/apps/brain/src/cli.ts:85-110` |
| brain 启动后把自己的 pid 写到 `$RAYA_METRICS_DIR/run/brain.pid`（生产 = `~/.flywheel/raya/data/metrics/run/brain.pid`） | `apps/brain/src/runtime.ts:312-316` |
| voice 不是独立常驻：`RunAtLoad=false`，由 brain 通过 `launchctl kickstart -p gui/<uid>/com.xrli.raya.voice` 按需拉起、用 `launchctl kill` 收掉 | `apps/brain/src/voice-mode.ts:404-515` |

根因一句话：**Raya 仓从来没有部署者**。FLY-2259 明确把 `com.xrli.raya.brain` 列为「原样保留、非目标」，FLY-2216 的自愈只管 Codex Lead carrier `com.flywheel.lead.raya-raya`，而且两处测试（`resident-codex-lead-patrol.test.ts:345`、`resident-codex-lead-recover.test.sh:176`）**反向断言** 自愈永不碰 `com.xrli.raya.brain`。所以「合入」和「上线」之间是一段真空，六天没人发现是因为没有任何检测面看这段真空。

## 2. 名词澄清（founder 友好）

- **班车（shuttle）**：`com.flywheel.updater` 这个 launchd 定时任务，每天两班（00:00/12:00），把 flywheel 主仓 `origin/main` 拉到生产并重启舰队。
- **两个「Raya 脑」**：`com.xrli.raya.brain` 是 Raya 产品本体（Discord 语音/会议网关，代码在 xrliAnnie/raya）；`com.flywheel.lead.raya-raya` 是 FLY-2216/2259 设计的 Codex Lead carrier（代码在本仓）。本 issue 只管前者；后者今天尚未激活（plist 不在 `~/Library/LaunchAgents`）。
- **巡检 STEP 5**：Eng Lead 每个 patrol tick 跑 `lead-patrol-snapshot.sh` 生成六步报告，第 5 步「外部真相（整仓维度）」今天只查 GitHub 的 PR/CI；Lead 读报告后自己决定要不要在 #flywheel-engineer 发话。issue 里写的「Bridge liveness」另有其物（`bridge-liveness-probe.sh`，只探 Bridge `/health`），不是这个检测面该去的地方。
- **preflight ready**：Raya 自己的 `raya preflight` 命令退出码 0 且输出 `ready: true`。founder 用的词与 Raya CLI 的词一致，本设计直接采用这个定义。

## 3. 三件要做的事，各自的选项

### 3.1 部署步骤放哪

| 选项 | 说明 | 取舍 |
|---|---|---|
| **A. `update-flywheel.sh` 里独立一段 `updater_raya_pass`（推荐）** | 班车每次醒来（定时或 urgent token），跑完 flywheel 周期后，独立跑一遍 Raya：fetch → ff-only → install/build → preflight → kickstart brain → 验证 → 写 receipt | ✅ flywheel 没变更时 Raya 也会部署（事故的主形态就是「只有 Raya 变了」）；✅ 失败隔离，Raya 挂了不影响 flywheel 的 deployed-sha；✅ 不进 3368 行的全舰重启事务；✅ 完全遵守 R4（同一个 updater，零新调度器） |
| B. `restart-services.sh` 加 Step 3.6（照抄 voice-bridge） | 与 voice-bridge 同形：失败 → 全舰回滚 | ❌ 只有 flywheel 落后才会跑，Raya 单独变更永远等不到；❌ Raya build 失败会把 flywheel 部署一起拖进回滚，两仓耦合 |
| C. Raya 仓自己加 launchd/cron | 自成一体 | ❌ 违反 R4「不新增 launchd/cron」，且重复 2026-08-14 66 连爆的形态 |

选 A。B 的 voice-bridge 形状我只借它的**验证纪律**（老 pid 消失、新 pid 健康、失败不推进 sha），不借它的耦合。

### 3.2 部署触发条件

issue 写「若 HEAD != origin/main 则 pull」。我把条件放宽成两级（超集，与 flywheel 班车同构）：

1. `HEAD != origin/main` → ff-only pull（不允许 diverged/local-ahead：告警 + 停手，与 `preflight_pull_latest_main` 的分类一致）。
2. `deployed-sha != HEAD` → install/build/preflight/kickstart/验证 → 写 `deployed-sha`。

第 2 级覆盖今天这种「founder 手工 pull + build + kickstart 但没有账本」的情形：下一班车看到 receipt 缺失/不等于 HEAD，会**再做一次干净的部署并落账**，让账本收敛，而不是永远报 drift。

### 3.3 回滚边界

- 进入前：工作区必须干净（tracked 文件；`git status --porcelain --untracked-files=no` 为空），否则拒绝、warning 告警、不动任何东西——FLY-2031 起 QA 规则就是「不得改生产 checkout」，脏就是异常。
- 记 `old_head`（pull 前 HEAD）与 `old_pid`（brain 当前 pid）。
- install/build/preflight 任一失败（**还没 kickstart**）：`git reset --hard old_head` → 重新 install/build（让磁盘上的 dist 回到旧版，否则 KeepAlive Crashed 拉起时会跑坏 dist）→ **不** kickstart（内存里的旧进程本来就健康）→ severe 告警「raya deploy rolled back before restart」。
- kickstart 后验证失败（60s 内没看到新 pid / `brain.pid` 不等于新 pid / launchd state 不是 running）：reset 到 old_head → 重建 → 再 kickstart → 再验证 → severe 告警；二次验证也失败 → severe「raya brain down after rollback，需人工」。
- 任何失败路径都**不写** `deployed-sha`；receipt 里记 `outcome=failed` 与原因 token，让巡检能读到。

### 3.4 voice「按需」

brain 是 voice 的 supervisor（kickstart -p / kill 都在 brain 里）。班车只在两条同时成立时才 `kickstart -k` voice：① 部署前 voice 正在运行；② 本次 `old_head..HEAD` 的 diff 触及 `apps/voice/`、`packages/contracts/`、`pnpm-lock.yaml`。否则不碰——voice 下次被 brain 拉起时自然跑新 dist。这样 00:00/12:00 撞上一场正在进行的语音会话时，只在 voice 代码真变了才打断它。

### 3.5 检测面

| 选项 | 取舍 |
|---|---|
| **A. 巡检 STEP 5 加一行本地 git 事实（推荐）** | 与 issue 一致；纯本地读（HEAD、本地 `origin/main` ref、`deployed-sha`、receipt），零网络、零副作用、可 hermetic 测试；Lead 按规则在 #flywheel-engineer 发 warning |
| B. STEP 5 里 `git ls-remote` 拿真远端 | 更实时，但引入网络+凭据依赖；而且「班车不再碰 Raya」这类回归可以用 receipt 年龄发现，不需要它 |
| C. `bridge-liveness-probe.sh` 加探针 | 那是 Bridge `/health` 的每分钟探针，投递到 #flywheel-alerts；语义不对、频道也不对 |

选 A。事实行形状（一行，机器可解析）：

```
raya checkout=~/.flywheel/raya/code head=<sha8> origin_main=<sha8> behind=<N|unknown> deployed_sha=<sha8|missing> receipt_age_h=<n|missing> drift_age_h=<n|-> shuttle_stale=<yes|no> overdue=<yes|no>
```

- `behind` = `git rev-list --count HEAD..origin/main`（本地 ref）。
- `drift_age_h` = `HEAD..origin/main` 中最老一个 commit 的 committer date 距今小时数。
- `shuttle_stale=yes` ⇔ receipt 缺失 **或** `receipt.checked_at` 距今 > 13h（一班 12h + 1h 宽限）——这是「班车不再碰 Raya」这类回归的信号，事故的原形。
- `overdue=yes` ⇔ `behind>0` **且**（`shuttle_stale=yes` 或 `drift_age_h>13`）——即「落后且已经过了一班车还没追上」。
- 目录不存在 / git 不可读 → `UNAVAILABLE(structural: raya_checkout_missing|raya_git_unreadable)`，沿用 STEP 契约，禁止静默跳过。
- 只对 `--project flywheel` 生成此行（Raya 仓归 flywheel 项目管）。

Lead 规则（`runner-patrol-rules.md` STEP 5）加一条：`overdue=yes` → 当 tick 就在自己的 chat channel（#flywheel-engineer）发一条 warning，引用原事实行；连续两个 tick 仍 `overdue=yes` → 第 6 步建工程单。这就是 issue 说的「N>0 超过一班车即 warning 告警到 #flywheel-engineer」——巡检是确定性的事实层，Lead 是投递层，与现有六步契约完全同构（快照脚本自身「从不写 Discord」的不变量不被打破）。

另外班车侧的确定性告警走既有 `lead-alert.sh`（→ #flywheel-alerts，按日签名去重）：部署失败/回滚 = severe（@founder），脏工作区/锁被占/diverged = warning。两层互补：班车告「我没做成」，巡检告「不管谁的锅，生产就是落后了」。

### 3.6 Done 判据落在哪

- **runner 侧**（implement / QA 节点都读）：`linear-issue-context` skill 模板的 Definition of Done 加第 7 条：「若本 issue 改动的是独立生产仓（如 xrliAnnie/raya）：合入 ≠ 上线，Done 还要求生产 checkout 已到该 sha + 服务已重启 + `raya preflight` ready，证据是班车 receipt 或人工部署记录」。
- **Lead 侧**：`founder-only-authority.md` R1 下加一小节「Raya 仓：merge 不等于 deploy」，指明 `com.xrli.raya.brain`、receipt 路径、由班车负责上线；`summary-inflow.md` 按 issue 要求加一句（那份文件是唯一的 Raya 专属 Lead 规则，虽然它讲的是 summary PR，一句提醒足够，不在那里长篇写判据）。

## 4. 明确不做（边界）

- 不改 Raya 仓任何代码、plist、raya.env；不给 Raya 建 launchd/cron。
- 不把 `com.xrli.raya.*` 加进 launchd census 的 `census-scope`（那会让 census 对 Raya 的两个 FLY-2031 QA 残留 job 报 unmanaged，属另一张单）。
- 不激活 `com.flywheel.lead.raya-raya`（FLY-2259 的事）。
- 不让 `resident-codex-lead-*` 自愈碰 `com.xrli.raya.brain`；现有两条反向断言保持。
- 不做 `git ls-remote` 实时远端探测。
- brain plist 里硬编码的 `/opt/homebrew/Cellar/node/25.6.1/bin/node`：brew 升级 node 会让两张 plist 一起失效，与本 issue 无关，只在 receipt 里记 `node_bin_exists` 事实并在设计里点名。

## 5. 待 Lead 确认的非阻塞问题

1. 00:00/12:00 班车重启 brain 会打断正在进行的 Raya 会议/语音。flywheel 舰队本来就在这两个点全量重启，我按「与舰队同步」处理；如需「有活跃语音会话就顺延到下一班」，是一个 receipt 字段 + 一个判断，可加，但我默认不加（少一个静默跳过的理由）。
2. `raya preflight` 会真的探 Discord REST 与 Codex（几秒到几十秒）。我放在 kickstart **之前**、以 120s bounded-run 跑，退出码非 0 视为失败进回滚。若 Lead 认为 preflight 太重可以降为 warning-only；我默认 fail-closed。
