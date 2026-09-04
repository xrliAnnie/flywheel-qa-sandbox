# FLY-2146 记忆定时真同步 — 探索
Issue: FLY-2146 (https://linear.app/geoforge3d/issue/FLY-2146/2132a2-记忆定时真同步以远端上有没有为准-连续多日新鲜度验证)
日期: 2026-09-04
基于: 无(上游为 product/doc/FLY-1984-codex-home-identity/epic-prd.md §A「定时 update」段;A1 合同见 engineering/doc/FLY-2145-lead-memory-private-repo/plan.md 与 scripts/lead-memory/repo-template/README.md「Contract for FLY-2132 A2 automation」)

## 1. 问题定义

PRD §A 要的不是「写个定时任务」,是两件事:

1. **记忆真的到得了远端**:某天写下的 Lead 记忆,第二天在 `github.com/xrliAnnie/lead-memory` 里看得到,中间无人手动。
2. **判断到没到只看远端**:不看本地跑没跑过,不看日志写没写「完成」。连续若干天成立;新机器拉到的是最新内容。

founder 原话(PRD 引用):「它虽然有仓库,但并没有定时去 update。所以这一部分还是要专门提出来,以确保我们后续能够真正做到定时去 update。」

## 2. 现状审计(2026-09-04 本机实测,不是转述)

### 2.1 A1 已交付的形状(FLY-2145,PR #1064 已合入 main)

| 项 | 实测值 |
|---|---|
| 记忆仓工作树 | `~/.claude/agent-memory`(自有 `.git`,`core.hooksPath=.githooks`) |
| 远端 | `https://github.com/xrliAnnie/lead-memory.git`(私有) |
| 本地 HEAD 与远端 main | 同为 `f39602a8…`(`git ls-remote` 与 `gh api …/commits/main` 一致);**0 ahead** |
| 首搬之后攒下的未提交内容 | `git status --porcelain` 43 行:26 M + 17 ??;按夹分:`flywheel-eng-lead` 35、`flywheel-product-lead` 8 |
| 外层 `~/.claude` 仓 | `.gitignore` 末行 `agent-memory/`,记忆仓不会被外层仓吞进去 |
| 护栏 | `scripts/lead-memory/lib/guard.sh`:`FLYWHEEL_MEMORY_ACTOR=sync` 模式 = 一提交一夹、owner 从唯一暂存夹推导、pre-push 拒 admin 历史 / 非快进 / 删分支、放行必留审计行(`~/.flywheel/state/lead-memory/audit.log`) |
| A2 合同(README) | ① pull --rebase 后再发布 ② 一夹一提交,不 merge ③ commit/push 都带 `FLYWHEEL_MEMORY_ACTOR=sync` ④ 永不产生/发布 `Memory-Owner: admin` ⑤ 审计/钩子/扫描/rebase/push 任一失败即失败 ⑥ **从远端分支核实到达,不把本地提交或成功日志当交付** |

也就是说:**A1 把「怎么提交才合法」全定死了,A2 只需要决定「谁、什么时候、怎么核实」。**

### 2.2 机上「已有的那套同步」到底是什么

PRD 说的「两天一跑、管 46 项、2026-03-15 后没东西真到过远端、本地多 118 次提交」,本机对上号的是 **chezmoi auto-sync**:

| 项 | 实测值 |
|---|---|
| 载体 | `~/Library/LaunchAgents/com.chezmoi.auto-sync.plist` → `~/.local/bin/chezmoi-auto-sync.sh`,`StartCalendarInterval` 每日 02:00(PRD 写「两天一跑」,是观测到的实际间隔;plist 是每日) |
| 管的仓 | `~/.local/share/chezmoi` → `github.com/xrliAnnie/dotfiles.git`(**不是** claude-config,更不是 lead-memory) |
| `.claude` 条目数 | `chezmoi managed \| grep -c '^\.claude'` = **46**(与 PRD 一致);`grep -c agent-memory` = **0** |
| 积压 | `origin/main..HEAD` = **123** 次提交(PRD 当天 118,之后又长了 5);远端最后一次到达 2026-03-15 02:01 |
| 为什么到不了 | 日志原文:`error: RPC failed; HTTP 500 curl 22`,`send-pack: unexpected disconnect`;仓 pack 共 **9.76 GiB**,待推 diff 28 文件 **2,843,346 行**新增 —— 是负载太大被 GitHub 掐断,不是凭据问题 |
| 还有什么坏 | stderr 日志里 `chezmoi re-add` 反复 `Killed: 9`;`chezmoi apply` 因 `/dev/tty: device not configured` 失败 |
| 日志怎么骗人 | 脚本每次照样写 `=== Sync completed ===`,push 失败只记一行 `WARN: Push failed. Will retry next run.`,没有任何一处读远端 |

另一个容易混淆的仓:`~/.claude` 本身是 `github.com/xrliAnnie/claude-config.git`,最后提交 2026-06-12,本地 770 个脏文件、0 ahead —— 它和记忆仓没有关系(`agent-memory/` 已被它 gitignore),本单不碰。

### 2.3 这套现状给 A2 的三条教训(每条都要变成负向护栏)

1. **「写了完成」≠「到了」**:chezmoi 的日志六个月里天天写完成。A2 的到达判定必须来自 `git ls-remote` / GitHub API,写 receipt 的那一行代码不能有别的输入。
2. **写者与看者要分开**:chezmoi 自己既推又自评。A2 要有一个**独立的看者**,它只读远端和本地脏文件年龄,不读 sync 的日志和 receipt 来判「到了」。
3. **负载与环境要有界**:9.76 GiB pack、要 TTY、re-add 被杀 —— A2 的 sync 必须 `GIT_TERMINAL_PROMPT=0`、无 TTY 依赖、每次只提交变了的夹、失败即非零退出并留下可被看者读到的痕迹。

### 2.4 可复用的仓内基础设施

| 需要 | 已有 |
|---|---|
| launchd 单元登记与安装 | `scripts/launchd/units.manifest`(FLY-1814,`copy` 策略 = 仓内 plist 即字节权威,converge 负责装);`launchd-units-manifest.test.sh` 封闭集合 |
| 无 TTY 的 git 远端操作 | `scripts/update-flywheel.sh` 用 `GIT_TERMINAL_PROMPT=0` + 超时包裹;凭据 = `~/.gitconfig` 的 `credential.https://github.com.helper = !gh auth git-credential`(keyring),A1 首搬与 smoke 推送就是走它 |
| 发 #flywheel-alerts | `scripts/bridge-liveness-probe.sh` 的 `_probe_post`(bot token 从 env 名取、`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`、state 文件去重、可测 seam) |
| 工具 | gitleaks 8.30.1、gh、jq、git 都在 `/opt/homebrew/bin` / `/usr/bin`;plist 的 PATH 要显式写进去(updater plist 有现成写法) |
| 测试惯例 | `scripts/__tests__/*.test.sh`(bash,临时 HOME + 假 origin + PATH 假件),登记进 `.github/workflows/ci.yml` 与 `ci-structure.test.sh` |

## 3. 边界(本单做什么 / 不做什么)

**做**:
- 定时把 `~/.claude/agent-memory` 里变了的 Lead 夹按 A1 合同提交、rebase、推送。
- 每次推送后**从远端**核实到达,写不可自欺的 receipt。
- 一个独立的看者:每天从远端 + 本地脏文件年龄判「有没有东西超过一天没到远端」,超了就发 #flywheel-alerts;每天在台账追加一行远端派生的新鲜度记录(这行就是 FLY-2134「监控监控者」可以消费的心跳面)。
- 一条只读远端的报告命令,QA / Lead / founder 用它验「连续多日成立」和「新机器拉到的是最新的」。

**不做**(明确写进 plan 与 founder HTML):
- 不修 chezmoi / dotfiles 的 123 次积压(不同仓、不同远端、根因是 9.76 GiB 负载;另开单)。
- 不碰 `~/.claude`(claude-config)那个仓。
- 不做「监控看者的监控」(FLY-2134 的类);本单只保证看者每天留下一行可被核对的台账。
- 不解决多机同时写同一 Lead 夹的冲突(PRD 只要求「新机器拉下来是最新的」,不要求双向写);rebase 冲突 = 中止 + 告警,不自动解。
- 不改 A1 的护栏与合同。

## 4. 备选方案

### 方案 α:接进 chezmoi(把 agent-memory 加进它管的 46 项)
- 优点:不新增单元。
- 否决理由:它的远端六个月没到过东西、负载 9.76 GiB、需要 TTY、re-add 被杀;而且 chezmoi 把文件**拷贝**到另一个仓再推,和 A1「原地建仓 + 钩子护栏」的形状冲突(钩子不会在 chezmoi 源仓里跑)。PRD 明说「要的不是写个定时任务,机上已有一个烂的」。

### 方案 β:一个 launchd 单元,推完自己核实
- 优点:最少部件。
- 不足:写者自评 —— 它挂了、没装上、凭据失效时,没人知道。正是 chezmoi 的形状。

### 方案 γ(推荐):两个独立单元 —— 写者每小时推 + 看者每天从远端判
- 写者 `com.flywheel.lead-memory-sync`:每小时,一夹一提交,rebase,推,`ls-remote` 核实,写 receipt。
- 看者 `com.flywheel.lead-memory-arrival-check`:每天,只读远端 HEAD/提交日期 + 本地 `status --porcelain` 与脏文件最老 mtime + 写者 receipt 的新鲜度;三种告警:超 26 小时未到达、写者 3 小时没留 receipt、看者自己读不到远端。
- 报告 `freshness-report.sh --days N`:只读远端,按天列「哪个 Lead 的记忆哪天到的」。
- 代价:两个单元 + 两组测试。换来的是「到没到」这个判断和「推」这个动作在进程、代码路径、时间上都分开。

### 方案 δ:GitHub 侧监控(Actions 定时 workflow 检查提交日期)
- 优点:完全在远端。
- 不足:远端只知道「多久没来提交」,不知道本地有没有东西该来;Lead 三天没写记忆时会误报,有东西卡在本地时又只能等到期。可作为 FLY-2134 一类的补充,本单不做。

## 5. 与 founder 相关的判断点(设计阶段要显式定的)

| 判断 | 本单取值 | 理由 |
|---|---|---|
| 写者频率 | 每小时(`StartCalendarInterval Minute=17`,漏跑在唤醒时补跑) | 「第二天看得到」留足余量;launchd 日历型任务睡眠错过后会在唤醒时补跑,间隔型不会 |
| 到达阈值 | 26 小时 | PRD 的「第二天」= 24h,加 2h 容错;超过即告警 |
| 告警去向 | `#flywheel-alerts`(`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`),沿用 liveness-probe 的 bot 与去重形状 | 已有基础设施与值班流程(claw) |
| 积压处置 | 绕开,另开单 | 见 §2.2;本单的两个单元与它零共享 |
| 「连续多日」证据 | 看者每日追加一行远端派生台账 + `freshness-report.sh` 随时重算 | 台账的每个数字都能用命令从远端重建 |
