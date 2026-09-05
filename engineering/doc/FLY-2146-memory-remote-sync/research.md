# FLY-2146 记忆定时真同步 — 调研
Issue: FLY-2146 (https://linear.app/geoforge3d/issue/FLY-2146/2132a2-记忆定时真同步以远端上有没有为准-连续多日新鲜度验证)
日期: 2026-09-04
基于: exploration.md

## 1. 调研问题清单

| # | 问题 | 结论(详见对应节) |
|---|---|---|
| Q1 | 定时载体用 launchd 哪种触发,睡眠错过怎么办 | `StartCalendarInterval`:错过的触发在唤醒时合并补跑一次;`StartInterval` 睡眠期间直接丢(§2) |
| Q2 | 无 TTY 的 launchd 进程能不能推 https 远端 | 凭据走 `gh auth git-credential`(macOS keyring);A1 首搬就是它;`GIT_TERMINAL_PROMPT=0` 保证不挂在提示上;**launchd 域下 keyring 可达性要在实施时用 `launchctl kickstart` 真跑一次证明**(§3) |
| Q3 | 「到达」怎么判才不自欺 | 只认 `git ls-remote origin refs/heads/main` 返回的 sha == 本地 HEAD;看者再用 GitHub API 独立读一遍(§4) |
| Q4 | A1 的 sync 模式对提交形状的硬约束 | 一夹一提交、owner 从暂存夹推导、pre-push 拒 admin/非快进/删分支、放行审计写不进即拒(§5) |
| Q5 | 一次跑里某夹被 gitleaks 拦住怎么办 | 该夹 reset 回未暂存,其余夹照常提交推送,整次退出非零并在 receipt 里点名夹与规则 id(不写值)(§5) |
| Q6 | 远端比本地新(另一台机器推过)怎么办 | `git rebase origin/main`(每次跑前 fetch);冲突 ⇒ `rebase --abort`、退出非零、告警;不自动解(§6) |
| Q7 | 告警走哪、怎么去重 | 沿用 `bridge-liveness-probe.sh` 的 `_probe_post` 形状:bot token 从 env 名取、`FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`、state JSON 记 episode,一个 episode 一条,24h 后重提(§7) |
| Q8 | 怎么装、怎么登记、怎么测 | `scripts/launchd/units.manifest` 加两行 `copy`;updater 停机窗的 `converge_nonlead_daemons` 负责装;测试进 CI「Script Tests 4/4」(§8) |
| Q9 | 123 次 dotfiles 积压怎么处置 | 绕开;根因是 9.76 GiB 负载,与记忆仓零共享(§9) |
| Q10 | 「连续多日」证据怎么产生、QA 在一个会话里能验到哪一步 | 看者每日追加一行远端派生台账 + `freshness-report.sh` 随时重算;QA 能验「机制无人值守连跑两次且远端到达」,「连续 N 天」是 ship 后 Lead 跑报告的 follow-up(§10) |

## 2. launchd 触发语义(Q1)

`man launchd.plist` 原文:

- `StartInterval`:「If the system is asleep during the time of the next scheduled interval firing, that interval will be missed」。
- `StartCalendarInterval`:「Unlike cron which skips job invocations when the computer is asleep, launchd will start the job the next time the computer wakes up. If multiple intervals transpire before the computer is woken, those events will be coalesced into one event upon wake from sleep.」

⇒ 写者与看者都用 `StartCalendarInterval`。写者只写 `Minute=17`(每小时第 17 分),看者 `Hour=8 Minute=40`。机器整夜合盖,早上开盖时写者补跑一次、看者补跑一次,顺序不保证 —— 所以看者判「超 26h 未到达」时把写者 receipt 的新鲜度作为独立一项而不是前提(§7)。

已有先例:`com.flywheel.daily-standup.plist`(日历型,03:00)、`com.flywheel.token-usage-daily.plist`。

## 3. 无 TTY 推送(Q2)

| 事实 | 出处 |
|---|---|
| `~/.gitconfig`:`credential.https://github.com.helper = !/usr/local/bin/gh auth git-credential` | `git config --show-origin --get-all credential.helper` |
| `gh auth status`:keyring 登录,scope 含 `repo` | 本机实测 |
| A1 首搬与 smoke 推送走的就是这条 https + gh 凭据链 | FLY-2145 acceptance.md |
| `update-flywheel.sh` 在 launchd 下用 `GIT_TERMINAL_PROMPT=0` + 有界超时跑 git 远端命令 | `scripts/update-flywheel.sh:160,223` |
| chezmoi 脚本失败的一种形态就是 `could not open a new TTY: open /dev/tty` | `~/.local/share/chezmoi-sync.log` |

设计取值:
- 写者与看者所有 git/gh 命令一律前缀 `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false`,并用 `timeout`(coreutils 不保证在 PATH,用 updater 已有的 `bounded-run` 或 bash 内建 `read -t` 形式;实施时沿用 updater 的做法)包裹每条远端命令(fetch/push/ls-remote 各 120s)。
- plist 的 `EnvironmentVariables.PATH` 显式含 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`(gitleaks、gh、trufflehog 在 `/opt/homebrew/bin`;`gh` 在 `~/.gitconfig` 里写的是 `/usr/local/bin/gh` 绝对路径,`which gh` 是 `/opt/homebrew/bin/gh` —— 实施时核 `/usr/local/bin/gh` 存在或是同一二进制,不存在则凭据链断,这是 kickstart 真跑要抓的第一类故障)。
- **未验证项(实施节点必须做)**:在 gui 域用 `launchctl kickstart -k gui/$(id -u)/com.flywheel.lead-memory-sync` 真跑一次,receipt 必须 `arrived=true`;若 keyring 在 launchd 域不可达,故障形态是 push 返回 401/`could not read Username`,receipt `arrived=false`,看者次日告警 —— 这条路径本身就是设计要的行为,但 ship 前必须看到一次 `arrived=true`。

## 4. 「到达」的唯一判据(Q3)

写者:
```
pre_head=$(git rev-parse HEAD)                       # 提交与 rebase 之后、push 之前
git push origin main                                 # sync 模式,pre-push 钩子跑 check-push
remote_head=$(git ls-remote --exit-code origin refs/heads/main | cut -f1)
arrived = [ "$remote_head" = "$pre_head" ]           # 唯一输入
```
- `arrived` 只由 `ls-remote` 的返回决定;push 的退出码、日志、钩子放行都不参与。push 成功但 ls-remote 读不到 ⇒ `arrived=false`(宁可假阴性)。
- receipt 是 JSON,原子写(临时文件 + mv):`{schema:1, run_id, started_at, finished_at, local_head_before, local_head_after, remote_head_before, remote_head_after, arrived, folders_committed:[…], folders_failed:[{folder, reason}], ignored_paths:[…], exit_code}`。路径 `${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/lead-memory/sync/last-receipt.json`,并按 run 追加一行到 `sync/runs.tsv`。

看者(独立进程、独立代码路径):
```
remote_head=$(git ls-remote --exit-code origin refs/heads/main | cut -f1)   # 直接读远端
remote_date=$(gh api repos/xrliAnnie/lead-memory/commits/$remote_head --jq .commit.committer.date)
local_ahead=$(git rev-list --count "$remote_head"..HEAD)                    # 本地有没有没推的提交
dirty=$(git status --porcelain --untracked-files=all -- <各 Lead 夹>)        # 本地有没有没提交的文件
oldest_dirty_age_h = now - min(mtime of dirty files)                        # 最老一份没到远端的内容多老
```
- 判「超 26h 未到达」:`local_ahead>0` 或 `dirty` 非空,且对应内容的最老年龄 > 26h。没东西写就不告警(Lead 三天没写记忆不是故障)。
- 看者**不读**写者的日志判到达;写者 receipt 只用于另一条告警「写者 3 小时没留 receipt」(它没在跑)。

## 5. A1 sync 模式的硬约束与失败处置(Q4、Q5)

`lib/guard.sh` 实测行为(已合入 main 的代码):

| 约束 | 代码位置 | 写者对策 |
|---|---|---|
| `FLYWHEEL_MEMORY_ACTOR=sync` 下暂存跨两个夹 ⇒ 拒 | `check_staged` | 每个夹单独 `git add -A -- "<夹>/"` + `git commit`;下一夹之前暂存区必空 |
| 顶层路径 ⇒ 拒(sync 模式) | `check_staged` | 写者只 add 形如 `^[a-z0-9][a-z0-9-]*$` 的**目录**;其他 untracked 一律不 add,列进 `ignored_paths` |
| owner 从暂存第一条路径推导 | `trailer_owner` | 与上条合起来天然正确 |
| pre-push:只允许 `refs/heads/main`、拒删分支、拒非快进、sync 不得发布 admin owner 提交 | `check_push` | 写者永远 `git push origin main`,不带 `--force*`,不带 `--no-verify`;推前 rebase 保证快进 |
| 放行审计行写不进 ⇒ 拒 | `check_staged`/`check_push` | 审计目录 `${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/lead-memory/` 由写者预检 `mkdir -p` + 可写检查 |
| pre-commit 还跑 `gitleaks git --pre-commit --staged` | `hooks/pre-commit` | 某夹被拦 ⇒ `git reset -q -- "<夹>/"`,记 `folders_failed:[{folder, reason:"gitleaks"}]`(gitleaks 输出里的规则 id 可记,**命中值与行内容不进 receipt / 日志 / 告警**),继续其余夹;结束退出 2 |

merge 提交一律被 `check_commit` 拒 ⇒ 写者不能用 `git pull`(默认 merge),必须 `fetch` + `rebase`。

## 6. 远端领先与冲突(Q6)

顺序:**先提交本地各夹 → fetch → 若 `origin/main` 不是 HEAD 祖先则 `git rebase origin/main` → push**。

- 先提交再 rebase 的原因:rebase 需要干净的工作树;把所有能提交的夹先提交掉,剩下的脏内容只剩「不合法状态的路径」(顶层杂物、被 gitleaks 拦的夹)。此时若仍有脏文件阻碍 rebase,用 `git rebase --autostash`?**不用**:autostash 会把被 gitleaks 拦住的内容暂存再弹回,弹回失败会留 stash 残骸。取而代之:rebase 前若工作树仍脏 ⇒ 跳过 rebase、不推、退出 3、receipt 记 `reason:"dirty-before-rebase"`;看者次日告警。这是有意的保守:远端领先本身只在多机写时出现,今天没有。
- rebase 冲突 ⇒ `git rebase --abort`,断言 HEAD 回到 rebase 前的 sha,退出 4,receipt 记 `reason:"rebase-conflict"`。
- 每夹一提交 + 单写者 ⇒ 同一夹的冲突只可能来自另一台机器上同名 Lead;PRD 不要求双向写,不解。

## 7. 告警与去重(Q7)

复用 `scripts/bridge-liveness-probe.sh` 的形状(不复用代码文件,避免把 Bridge 探针的状态机拖进来):

- 发帖 seam `_arrival_post`:token 从 `${FLYWHEEL_PROBE_BOT_TOKEN_ENV:-CODEX_INFRA_BOT_TOKEN}` 指向的 env 取;频道 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`;`allowed_mentions` 只在 `FLYWHEEL_FOUNDER_DISCORD_USER_ID` 设时 @。plist 的 ProgramArguments 用与 liveness-probe 相同的 `set -a; . ~/.flywheel/.env; set +a; exec …` 形式带入 token(token 不进 plist)。
- 三种 episode 各自独立记在 `state/lead-memory/arrival-check.json`:`stale`(超 26h 未到达)、`writer_silent`(写者 receipt 超 3h)、`remote_unreachable`(看者自己读不到远端/API)。每种:进入 episode 时发一条,之后每 24h 重提一条,恢复时发一条「恢复」。
- 文案固定前缀 `lead-memory-arrival:`,内容只含夹名、小时数、sha 前 12 位;不含文件名以外的记忆内容。
- 台账 `state/lead-memory/freshness.tsv` 每次看者跑追加一行:`utc_date  remote_head12  remote_commit_date  local_ahead  dirty_count  oldest_dirty_age_h  writer_receipt_age_h  verdict`。`verdict ∈ fresh | stale | writer_silent | remote_unreachable`。这行的前三列只来自远端。

## 8. 安装、登记、测试(Q8)

- `scripts/launchd/units.manifest` 新增两行,`policy=copy`,`allowed_exit_codes`:写者 `0,2,3,4`(2=某夹被拦 3=脏树跳过 rebase 4=rebase 冲突;都是「已处理、看者会看到」的结局,不算单元异常);看者 `0`。`launchd-units-manifest.test.sh` 会把 plist 与 manifest 闭合校验。
- 安装靠 updater 停机窗的 `converge_nonlead_daemons`(`update-flywheel.sh:247`)把仓内 plist 拷到 `~/Library/LaunchAgents` 并 bootstrap;本单不手工 `launchctl load`。**首次生效时间 = 下一次 updater 班车**;实施节点用 `kickstart` 做一次性验证不等于「已部署」,ship 后由 QA 从 `launchctl print gui/501/com.flywheel.lead-memory-sync` 核实。
- 测试:`scripts/__tests__/test-lead-memory-sync.test.sh`、`test-lead-memory-arrival-check.test.sh`、`test-lead-memory-freshness-report.test.sh`,登记进 ci.yml「Script Tests 4/4 — cmux repair + Lead memory」那一步(与 A1 套件同段,共用已下载的真 gitleaks 8.30.1)。夹具沿用 A1:临时 HOME、`git init --bare` 假 origin、`FLYWHEEL_STATE_DIR` 指临时目录、PATH 假 gitleaks(记录调用)。
- shellcheck 与 `bash -n` 走仓里既有的 shell 语法门。

## 9. 123 次积压的处置(Q9)

| 事实 | 值 |
|---|---|
| 仓 | `~/.local/share/chezmoi` → `xrliAnnie/dotfiles`,与 `lead-memory`、`claude-config` 三者互不相干 |
| 负载 | `count-objects`: size-pack 9.76 GiB;`diff --stat origin/main..HEAD`: 28 文件、+2,843,346 行 |
| 失败形态 | `RPC failed; HTTP 500`(GitHub 对超大 pack 的服务端拒绝),另 `chezmoi re-add` 被 `Killed: 9` |
| agent-memory 是否被它管 | `chezmoi managed` 0 条;外层 `~/.claude/.gitignore` 也排除 |

处置:**绕开,不修**。理由:① 不是记忆;② 修它需要拆 pack / 重写历史 / 清大文件,是另一个问题域;③ 修它不改变本单任何验收。设计文档与 founder HTML 如实写:「机上那套坏的还在,它管的 46 项不在本单范围;建议另开单处理 dotfiles 积压」。本单唯一与它相关的负向护栏:看者的台账与告警不得引用 chezmoi 的日志。

## 10. 「连续多日」的证据链(Q10)

| 层 | 产生者 | 从哪读 | QA 在一次会话里能验到 |
|---|---|---|---|
| 单次到达 | 写者 receipt `arrived` | `ls-remote` | 能:kickstart 一次,`arrived=true`,且 QA 自己再跑一次 `ls-remote` 对上 |
| 无人值守 | launchd 真触发(不是 kickstart)的 receipt | `runs.tsv` 里 `trigger=launchd` 的两连行 | 能:等两个整点(≈2h) |
| 每日新鲜度 | 看者台账 `freshness.tsv` | 前三列来自远端 | 能:kickstart 看者一次,得一行 `fresh`;并做一次反向对照(临时把 origin 指向不可达 URL 的 fresh clone 台架里跑看者 ⇒ `remote_unreachable` 且发帖 seam 收到一条) |
| 连续 N 天 | `freshness-report.sh --days N`:`gh api repos/…/commits?since=` 按天分组,列每天到达的提交与 `Memory-Owner` | 全部来自远端 | **不能在一次会话里验**;ship 后第 3 天由 Lead 跑一次并贴进 milestone。设计与 HTML 如实写这是 follow-up |
| 新机器最新 | `bootstrap.sh --clone`(A1)后 `git log -1 --format=%ci` 与 `freshness-report` 的远端最新提交一致 | 远端 | 本机 fresh clone 可验;真第二台机器仍是 founder follow-up(与 A1 同边界) |

~~`freshness-report.sh` 的每一行都能用一条 `gh api` 命令重建~~ **(已被 plan.md C4 取代,R1 #4:远端历史不保存 ref 更新时刻,commit 的 committer date 只是元数据日期;「哪天到的」只有看者当时的观察台账知道,台账每行事后用 `compare` 对远端复核祖先关系。)**它不读本机任何 state 文件(`--local` 才附带本地脏龄)。

## 11. 被本调研排除的选项(留档)

- **用 `git pull --rebase --autostash`**:会把被拦内容 stash/弹回,失败留残骸;改为脏树即跳过(§6)。
- **写者每次跑都 push(即使没新提交)**:每次 push 触发远端 `guard.yml`,一天 24 次 × 12 夹上限的空跑;改为只在有新提交时 push。
- **用 GitHub Actions 的 schedule 做看者**:远端不知道本地有没有该来的东西,会误报也会漏报(exploration §4 方案 δ)。
- **把看者并进 `bridge-liveness-probe.sh`**:那是每分钟跑的 Bridge 探针,状态机已有 5 类 episode;记忆到达是每日粒度,混进去会让两边的测试与告警语义互相污染。
- **给写者加 `--dry-run` / `--skip-scan` 类旋钮**:A1 的 founder 直令「不加任何开关」;写者只有位置参数 `--once`(默认)与 `--print-receipt`。
