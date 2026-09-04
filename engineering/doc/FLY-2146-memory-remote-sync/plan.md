# FLY-2146 记忆定时真同步 — 实施计划
Issue: FLY-2146 (https://linear.app/geoforge3d/issue/FLY-2146/2132a2-记忆定时真同步以远端上有没有为准-连续多日新鲜度验证)
日期: 2026-09-04
基于: research.md(exploration.md 为其上游)· codex-review-round1.md … codex-review-round4.md(R1 12 条、R2 8 条、R3 8 条、R4 8 条已全部并入,见 §10)

## 0. 一句话

给 A1 建好的记忆仓 `~/.claude/agent-memory` 配一对**互不共用判断**的 launchd 单元:写者每小时按 A1 合同一夹一提交并推送,「到达」只由推送后重新执行的 `git ls-remote` 决定;看者每小时(写者之后)只读远端与本地待送内容的年龄,超 26 小时没到远端就发 `#flywheel-alerts`,每次观察记一行运维台账。「连续多日」的**权威证据在远端自己身上**:lead-memory 仓里一个每日定时的 GitHub Actions workflow 记录当时 main 的 sha(服务端时间戳,本机零参与),验收只认它在 `main` 上的自然 `schedule` 运行,并用「D 日的树没有、D+1 日的树有」这一对远端树证明前一天新写的记忆真到了。机上那套坏的 chezmoi 同步与它的 123 次积压绕开不碰。

## 1. 范围

**硬约束(继承 A1 的 founder 直令):不加任何开关 / 旋钮。**写者与看者没有 `--skip-*` / `--dry-run` / `--no-scan` 类参数,没有能关掉钩子、扫描、到达核实、告警的环境变量;`FLYWHEEL_MEMORY_ACTOR=sync` 是身份声明不是开关。测试用的「seam」= `source` 脚本后覆盖函数(与 `bridge-liveness-probe.test.sh` 同法)或**常量替换副本**(测试把脚本拷到临时目录、用一次且必须恰好命中一处的 `sed` 把 `REMOTE_URL` 换成 bare fixture 路径;生产脚本与常量合同测试不受影响)。生产脚本没有任何读环境变量改常量的路径。

**做**:`sync.sh`(写者)· `arrival-check.sh`(看者)· `freshness-report.sh`(报告)· 两个 plist + `units.manifest` + `launchd-units-manifest.test.sh` 批准集合 · lead-memory 仓模板新增 `remote-observe.yml` 定时 workflow(A1 变更闭包:`sync-template.sh` 文件清单、`first-import.sh` 的两份精确顶层集合与显式 `git add` 清单、hooks 套件的 installed-file 断言、first-import 测试断言根提交含两份 workflow)· `retire-units.sh` 退役命令 · **新增五套** bash 测试进 CI(sync / arrival-check / freshness-report / observe-workflow / retire),**修改并继续运行**既有的 hooks、first-import、manifest 三套 · README A2 节由「合同」改为「实现说明」· 验收证据 `acceptance.md` · founder HTML。
**不做**:修 chezmoi / dotfiles 积压(建议另开单)· 碰 `~/.claude`(claude-config)仓 · 元监控(FLY-2134 类)· 多机双向写冲突自动解 · 改 A1 护栏 `guard.sh` / 钩子本身(只读调用,常量以合同测试锁定一致;A1 其余改动只限上面列出的模板闭包)· Codex Lead / runner 记忆。

## 2. 稳定标识与显示标签(一处源:`scripts/lead-memory/lib/sync-common.sh` 顶部常量)

| 类别 | 值 |
|---|---|
| 写者 launchd label | `com.flywheel.lead-memory-sync`(`scripts/launchd/com.flywheel.lead-memory-sync.plist`,`StartCalendarInterval {Minute:17}`) |
| 看者 launchd label | `com.flywheel.lead-memory-arrival-check`(同目录,`StartCalendarInterval {Minute:40}`,每小时,在写者之后) |
| 远端观察 workflow | lead-memory 仓 `.github/workflows/remote-observe.yml`:`schedule: cron "5 9 * * *"`(UTC 每日一次)+ `workflow_dispatch`(只为人工补测,**永不计入验收**);`permissions: contents: read`,无 job 级 permissions 覆盖,不引用 `secrets.*` / `github.token`;恰好一个 job、一个 step,只把 `GITHUB_SHA`、`GITHUB_RUN_ID`、UTC 时间写进 job summary。验收只读 GitHub 保存的运行记录,且**固定为逐 UTC 日查询**(`gh run list` 没有分页 flag,只有 `--limit`/`--created`):对每个 D 跑 `gh run list -R xrliAnnie/lead-memory --workflow remote-observe.yml --event schedule --branch main --created D --limit 50 --json databaseId,url,event,headBranch,headSha,createdAt,status,conclusion,attempt`,本地再断言 `event==schedule && headBranch==main && status==completed && conclusion==success && attempt==1`(人工 `gh run rerun` 产生的后续 attempt 不算自然观察;某日只有 rerun 成功 ⇒ 该日 `MISSING`);窗口 `--from/--through` 上限 7 天 |
| 脚本 | `scripts/lead-memory/sync.sh` · `arrival-check.sh` · `freshness-report.sh` · 共用 `lib/sync-common.sh`(函数库,`source` 无副作用;`main` 由各脚本在 `[ "${BASH_SOURCE[0]}" = "$0" ]` 下调用) |
| 常量 | `REMOTE_URL` `MEMORY_PATH` `LEAD_NAME_PATTERN` 与 `guard.sh:5-13` 逐字相同;`guard.sh` 末尾直接 dispatch 不能 `source`,所以 sync-common 重复声明,由合同测试 `assert_constants_match_guard` 抓 `guard.sh` 文本比对 |
| 身份 | 写者所有 hook-bearing 的 git 命令带 `FLYWHEEL_MEMORY_ACTOR=sync`;看者与报告**不设** actor(只读) |
| 状态目录 | `${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/lead-memory/` |
| 写者 receipt | `…/sync/last-receipt.json`(schema 1,原子写)+ `…/sync/runs.tsv`(固定表头) |
| 写者锁 | `…/sync/lock/`,由共用的 `lm_lock_acquire <dir>` 实现(`mkdir` 原子锁含 pid;活 pid ⇒ 占用;死 pid / 缺 pid / 畸形 pid ⇒ 回收后重试一次);`trap` EXIT/INT/TERM 释放 |
| 看者状态 | `…/arrival/state.json`(**四本** episode 账 + 删除项首见指纹表)+ `…/arrival/checks.tsv`;看者持 `…/arrival/lock/`(与写者**同一个** `lm_lock_acquire` 实现:`mkdir` 原子锁含 pid、活 pid 才跳过、死 pid / 缺 pid / 畸形 pid 回收后重试一次、`trap` EXIT/INT/TERM 释放);报告**永不写**这里 |
| 用户可见前缀 | `lead-memory-sync:` · `lead-memory-arrival:` · `lead-memory-report:` |
| 阈值常量 | `STALE_HOURS=26` · `WRITER_SILENT_HOURS=3`(连续两次观察)· `UNFETCHED_CONSECUTIVE=2` · `RENOTIFY_HOURS=24` |
| 验收冻结记录 | `…/acceptance/day-<UTC日期>.json`:`{path, expected_blob, size, frozen_at, run_id_D, run_created_at_D}`;**create-if-absent 原子发布,存在即拒绝**;冻结时校验 D == 当前 UTC 日、`run_id_D` 是 D 日合格自然 attempt、其 `createdAt <= frozen_at`、尚无 D+1 观察、文件是普通 blob 且 < 1 MB(Contents API 上限之内);milestone 当天记录该 JSON 的 sha256;之后只读(只是「待验身份」,判定全由两棵远端树给出) |
| 退役命令 | `scripts/lead-memory/retire-units.sh`(只认本单两个精确 label;沿用 `scripts/lib/fly1814-operator-tools.sh` 的 TTY / 审计 / identity / archive seam) |
| 远端命令超时 | fetch / push / ls-remote / gh 各 120s,经 `scripts/lib/bounded-run.sh`(超时 124) |
| 告警去向 | `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`;token env 名 `${FLYWHEEL_PROBE_BOT_TOKEN_ENV:-CODEX_INFRA_BOT_TOKEN}`;`FLYWHEEL_FOUNDER_DISCORD_USER_ID` 可选 @ |
| plist 日志 | `StandardOutPath/ErrorPath` 是 launchd 直接解释的**绝对字面量** `/tmp/flywheel-lead-memory-sync.log` / `/tmp/flywheel-lead-memory-arrival-check.log`(与 daily-standup 同形;不能写 `$HOME`/`~`,测试断言) |
| trigger 字段 | `FLYWHEEL_SYNC_TRIGGER` 只读标签(plist 固定 `launchd`,人手默认 `manual`),**不区分手动触发与日历触发**;日历触发证据 = `started_at` 分钟落在 :17–:18 且当时无人手动触发 |

### 2.1 写者退出码真值表(唯一真值表;§4 C2 的流程引用它)

先算**业务结局**,再尝试写证据,最后定退出码:

| 业务结局(互斥,按行序判定) | 码 |
|---|---|
| 锁被活进程占用(未做任何写/远端 git 操作,不写共享文件) | 75 |
| 预检失败(记忆仓零改动) | 6 |
| **仓状态 / 所有权无法安全恢复**(广义):rebase abort 后复原失败;add 后发现暂存集含本夹以外路径(`foreign-staged`);trap 清理本 run 暂存失败(停,人工;终结器**不跑**,`observation=undetermined`) | 8 |
| rebase 冲突 / 其他 rebase 错误,已 abort 复原 | 4 |
| 工作树脏,跳过 rebase 未推 | 3 |
| 终结器 `arrived=false`(含 ls-remote 读不到、fetch 失败未推、push 后远端 ≠ expected) | 5 |
| 终结器 `arrived=true` 但某个远端操作命令非零(`fetch_rc≠0` 或 `push_rc≠0`;A1 README 第 5 条) | 7 |
| 至少一夹被钩子拒,其余到达 | 2 |
| 全部到达、操作全成功 | 0 |
| **被 INT / TERM 打断**(任何阶段):trap 释放锁;若本 run 已 add 且暂存集 ⊆ 当前夹 ⇒ `git reset -q -- <夹>/` 成功后 receipt `reason:"interrupted"`;reset 失败 ⇒ 归上面的 8。终结器**不跑**,`observation=undetermined`,`expected_local_sha` 未冻结时 receipt 记 `null` | 130 / 143(**不在** allowed 名单) |

证据规则:除 75 外每个结局都要写 receipt + runs.tsv;**任一证据写失败 ⇒ 退出 9,覆盖上表任何码(含 6 与 8)**——没有证据的成功或失败都比一个更响的退出码危险。状态目录不可写因此不是「预检 6」而是 9(它写不出 6 的 receipt)。manifest `allowed_exit_codes`:写者 `0,2,3,4,5,7,75`;看者 `0`;6/8/9 不在名单 ⇒ launchd census 判异常,这是有意的。

## 3. 文件清单

```
scripts/lead-memory/
├── lib/sync-common.sh          常量 · 日志 · bounded 远端命令 · 原子写(检查 rc)· lead 夹候选集 · origin 校验 · 纯采集的待送扫描
├── sync.sh                     写者(C2)
├── arrival-check.sh            看者(C3)
├── freshness-report.sh         报告(C4)
├── retire-units.sh             退役命令(C5;沿用 fly1814 operator 模式)
├── sync-template.sh            文件清单 +1:remote-observe.yml(A1 文件)
├── first-import.sh             两份精确顶层集合 + 显式 add 清单各 +1(A1 文件)
└── repo-template/
    ├── README.md               A2 节改写为实现说明(C6)
    └── .github/workflows/remote-observe.yml   远端每日观察(C4)
scripts/launchd/
├── com.flywheel.lead-memory-sync.plist
├── com.flywheel.lead-memory-arrival-check.plist
└── units.manifest              +2 行 copy
scripts/__tests__/
├── test-lead-memory-sync.test.sh
├── test-lead-memory-arrival-check.test.sh
├── test-lead-memory-freshness-report.test.sh
├── test-lead-memory-observe-workflow.test.sh   remote-observe.yml 合同(与 A1 guard.yml 测试同法)
├── test-lead-memory-retire.test.sh             retire-units.sh 合同(fly1814 seam)+ converge 复活反例(_cnd_launchctl seam)
├── test-lead-memory-hooks.test.sh / first-import 测试   installed-file 与根提交断言 +1(A1 测试)
└── launchd-units-manifest.test.sh   批准 label 集合 +2 + 两个 shell -c 目标的 resolved-payload 断言 + 日志路径为绝对字面量
.github/workflows/ci.yml        「Script Tests 4/4」步骤追加六条
engineering/doc/FLY-2146-memory-remote-sync/   本夹 + acceptance.md + founder HTML
```
`ci-structure.test.sh` 只钉 shard 步骤名,不改(R1 #12、R2 复核)。

## 4. Chunks(每个 chunk:先写测试 RED → 实现 GREEN → 提交)

### C1 `lib/sync-common.sh` + 夹具
- `lm_log` · `lm_bounded <secs> <cmd…>`(包 `bounded-run.sh`)· `lm_write_json_atomic` / `lm_append_tsv`(每次写检查 rc,表头缺失先写表头)。
- `lm_lead_folders <worktree>`:候选集 = HEAD 树里已跟踪的合法顶层目录 ∪ 工作树当前存在的合法、非符号链接目录(排除 `.git` `.githooks` 与所有顶层文件)。
- `lm_origin_check <worktree>`:(i) `git config --local --get-all remote.origin.url` 恰好一条且 == `REMOTE_URL`;(ii) `remote.origin.pushurl` 为空;(iii) `git remote get-url --all origin` 恰好一条且 **== `REMOTE_URL`**;(iv) `git remote get-url --push --all origin` 恰好一条且 **== `REMOTE_URL`**。即任何 `insteadOf` / `pushInsteadOf` 让解析值离开 canonical 都拒(R2 #1:对称重写能把 push 与终态 ls-remote 一起指向错误仓而假绿)。测试:pushurl / pushInsteadOf / 多 URL / **对称 insteadOf 到同一错误仓** 四种都 ⇒ 拒;bare fixture 用「常量替换副本」而不是 insteadOf。
- `lm_lock_acquire <lockdir>` / `lm_lock_release`:写者与看者共用(合同见 §2 表)。测试:活 pid ⇒ 占用;死 pid / 缺 pid 文件 / 畸形 pid ⇒ 回收后成功;TERM 后锁目录消失;SIGKILL 留下的锁下一轮被回收。
- `lm_read_deps_check`(看者 / 报告用,**不含** gitleaks):`git` `gh` `jq` `python3` `curl` 在 PATH;`scripts/lib/bounded-run.sh` 普通可执行。缺任一 ⇒ 预检失败(不得降格成 `remote_unreachable`,不得发帖)。
- `lm_deps_check <worktree>`(写者用)= `lm_read_deps_check` + `gitleaks version == 8.30.1`;`.githooks/pre-commit` `prepare-commit-msg` `pre-push` 与 `.githooks/lib/guard.sh` 是 repo 内**普通可执行文件**(非符号链接);仓根 `.gitleaks.toml` `.gitleaksignore` 是普通文件;`scripts/lib/bounded-run.sh` 普通可执行。缺任一 ⇒ 预检失败(不降格成 `hook-refused` / undetermined)。
- `lm_remote_head <worktree>`:`ls-remote --exit-code origin refs/heads/main`(bounded);失败 ⇒ 非零且 stdout 为空。
- `lm_pending_scan <worktree> <remote_sha|->`:**纯采集**,输出 NUL 分隔记录 `kind(dirty|deleted|unpushed) · path|sha · observed_mtime|ct`;不读不写任何 state。删除项的首见时间转换是看者专有的 `apply_first_observed`(C3)。
- 测试:五种候选集输入;origin 六种形状;deps 各缺一项(含 bounded-run / python3 / curl 缺失时看者预检 6 且发帖 seam 零调用);`lm_remote_head` 不可达 stdout 空;原子写对只读目录返回非零;`assert_constants_match_guard`(改一个常量的 guard 副本必须红)。

### C2 写者 `sync.sh`
**顺序**:① 只读的仓根不变量(A1 三情形)→ ② 取锁(此后才允许任何会改状态的操作;活锁 ⇒ 75,**零 mutating / 远端 git 操作**,不写共享文件)→ ③ 其余预检:`core.hooksPath == .githooks`、`lm_deps_check`、`lm_origin_check`、分支 main、**index 干净**(否则 `index-dirty`,不 reset)、无 rebase 状态(`.git/rebase-merge` 与 `.git/rebase-apply` 都不存在)、状态目录可写(不可写 ⇒ 直接按 9 处理)。预检失败 ⇒ 6,记忆仓零改动,receipt `{preflight_failed:<原因>, arrival_observation:"undetermined"}`。环境:`GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false`;`env -u FLYWHEEL_LEAD_ID`。

**`expected_local_sha` 状态机**(终结器的唯一比较基准,任何终结器入口都已定义):
- 本地逐夹提交完成时冻结为 `HEAD`(没有任何夹提交也冻结,= 起始 HEAD);
- rebase **成功**后更新为新 `HEAD`;
- 之后不再变化。

**主流程**:
1. `remote_head_before = lm_remote_head`(失败 ⇒ `remote_before:"undetermined"`,继续本地提交,**禁止** fetch/rebase/push)。
2. 对每个候选夹:`git add -A -- "<夹>/"`;断言暂存路径全以 `<夹>/` 开头(否则 `foreign-staged` ⇒ §2.1 的 8,不 reset,停);无变化跳过;否则 `FLYWHEEL_MEMORY_ACTOR=sync git commit -q -m "sync: <夹> <UTC>"`,**stdout/stderr 落 `umask 077` 私有临时文件,不解析不回显,无论成败 finally 删除**;失败 ⇒ `git reset -q -- "<夹>/"`(index 起始为空,安全),断言 index 空,`folders_failed += {folder, reason:"hook-refused"}`;成功 ⇒ 断言 index 空且新提交 `Memory-Owner == 夹`。冻结 `expected_local_sha`。
3. 其余 untracked / 非夹路径 ⇒ `ignored_count`;路径只进 0600 的 `…/sync/ignored-paths.txt`。
4. 远端可读时 `git fetch origin main`(bounded,记 `fetch_rc`)。**`fetch_rc≠0` ⇒ 禁止 rebase 与 push**(A1 README 第 1 条:发布前必须先 pull/rebase;不能拿陈旧的 `origin/main` 算祖先),直接进终结器。`fetch_rc==0` 且 `origin/main` 不是 HEAD 祖先:工作树脏 ⇒ 不 rebase 不 push(结局 3);干净 ⇒ `git rebase origin/main`;失败(冲突或其他错误)⇒ `git rebase --abort`,断言 `HEAD == rebase 前 sha` 且两个 rebase 状态目录不存在 ⇒ 结局 4;断言不成立 ⇒ 结局 8(**不进终结器**,`observation=undetermined`,receipt 给人工恢复命令)。成功 ⇒ 更新 `expected_local_sha`。
5. 允许推(远端可读、fetch 成功、rebase 未失败、结局不是 3)且 `git rev-list --count origin/main..HEAD > 0` ⇒ `FLYWHEEL_MEMORY_ACTOR=sync git push origin main`(bounded,记 `push_rc`;**push 的 stdout/stderr 同样落 0600 临时文件并删除**——pre-push 的 guard 会打印路径级拒绝原因);否则 `pushed=false`。
6. **终结器 `finalize_arrival`(`arrived` 唯一赋值点;除 75/6/8 外所有结局都进)**:重新 `lm_remote_head`;`remote_rc==0 && remote_head_after == expected_local_sha` ⇒ `arrived=true`,否则 `false`;`arrival_observation ∈ observed | undetermined`。
7. 按 §2.1 真值表定结局;写 receipt + runs.tsv;证据失败 ⇒ 9。

runs.tsv 表头:`schema=1  started_at  finished_at  trigger  exit_code  arrived  observation  committed_n  failed_n  ignored_n  head_after12  remote_after12  fetch_rc  push_rc`。

**逐终态断言表**(测试逐行覆盖,每行都断言 `expected_local_sha`、`arrived`、`observation`、退出码):

| 场景 | expected | arrived / observation | 码 |
|---|---|---|---|
| 无变化,远端 == 本地 | 起始 HEAD | true / observed | 0 |
| 初始 ls-remote 不可达(`https_proxy` 关闭端口) | 提交后 HEAD | false / undetermined | 5 |
| fetch rc≠0(假 git 让 fetch 失败)且远端 == expected | 提交后 HEAD | true / observed | 7 |
| fetch rc≠0 且远端 ≠ expected | 提交后 HEAD | false / observed | 5 |
| 脏树、远端领先 | 提交后 HEAD | false / observed | 3 |
| 冲突,abort 成功 | 提交后 HEAD | false / observed | 4 |
| abort 失败注入 | 提交后 HEAD | false / undetermined | 8 |
| 突变 a:push rc=0 但远端不变 | 提交后 HEAD | false / observed | 5 |
| 突变 b:远端已更新但 push rc≠0 | 提交后 HEAD | true / observed | 7 |
| 一夹被拒,其余到达 | 提交后 HEAD | true / observed | 2 |
| 状态目录只读(业务本来 0) | — | — | 9 |

其余测试(与 R1 版相同,保留):整夹删除 / A→B 改名;顶层杂物 `ignored_count`;假 gitleaks 随机样本不出现在任何持久面与 sync.sh 自身 stdout/stderr;**pre-push 打随机敏感路径**同样不出现;index 预先脏 ⇒ 6 不 reset;**add 后收到 TERM** ⇒ 锁释放、本夹暂存被 reset、receipt `interrupted` + `observation=undetermined`、退出 143、runs.tsv +1;**add 后 reset 被注入失败** ⇒ 8;**foreign-staged**(add 期间另一进程 add 了别夹)⇒ 8 且 index 原样;活锁 75 且 runs.tsv 字节不变;预检各形状 ⇒ 6 零改动;`FLYWHEEL_LEAD_ID` 泄入仍 sync;静态:传 `--skip-scan`/`--dry-run` ⇒ usage;`SKIP_SCAN=1` ⇒ 假 gitleaks 调用参数逐字节相同;**静态禁用检查只解析实际 `git push` 调用的 argv**(拒 `-f` / `--force*` / `--no-verify`),不 grep 通用 `-f ` 子串;源码不含 `FLYWHEEL_MEMORY_ACTOR=admin`、`chezmoi`。

### C3 看者 `arrival-check.sh`
预检(失败 ⇒ 6,不发帖不写台账):仓根不变量;`lm_origin_check`;`lm_read_deps_check`(git / gh / jq / python3 / curl / bounded-run;缺 bounded-run **不是** `remote_unreachable`,是 6)。看者不需要 gitleaks、不设 actor、**不写记忆仓、不 fetch 活仓**。取 `…/arrival/lock/`(`lm_lock_acquire`,合同同写者;活 pid ⇒ 退出 0 只 stderr 一行,不写共享文件;陈旧锁回收)。

观察:
1. `remote_head = lm_remote_head`;`remote_commit_date = gh api …/commits/<sha> --jq .commit.committer.date`。任一失败 ⇒ 远端两列 `undetermined`。
2. `git cat-file -e <remote_head>^{commit}`:缺 ⇒ `local_ahead:"undetermined"`;有 ⇒ `local_ahead = rev-list --count <remote_head>..HEAD`,`oldest_unpushed_age_h = now − min(git log --format=%ct <remote_head>..HEAD)`。
3. `lm_pending_scan` 纯采集 → **`apply_first_observed`(看者专有)**:删除项按「路径+状态」指纹在 `state.json` 记首见时间,消失即清;存在项用 lstat mtime。
4. `pending_age_h = max(...)`;都空 ⇒ 无待送。
5. `writer_receipt_age_h` 缺 ⇒ `undetermined`。
6. 标签(多标签集合):
   - `remote_unreachable`:第 1 步失败。
   - `unfetched`:远端可读但对象缺失,**连续两次观察**才成立(与写者每小时 fetch 的节奏匹配;单次多半是「刚推、写者还没轮到」)。
   - `stale`:`pending_age_h > 26`(远端可读时才可判)。
   - `writer_silent`:`writer_receipt_age_h > 3 或 undetermined` 且上一次观察也如此。
7. `checks.tsv` 固定表头:`schema=1  observed_at_utc  remote_head  remote_commit_date  local_ahead  dirty_count  deleted_count  pending_age_h  writer_receipt_age_h  verdict  post_status`。
8. **四本 episode 账各自独立**(`stale` / `writer_silent` / `unfetched` / `remote_unreachable`):进入 ⇒ 发帖,**发帖成功才写 `lastNotifiedAt`**;持续且 ≥24h ⇒ 再发;观察到该标签不成立(且不是 undetermined)⇒ 发恢复帖,**成功才清**;`undetermined` 不清任何账。`unfetched` 的恢复 = 对象出现或 `local_ahead` 可算;它与 `writer_silent` 同时成立时各发各的、各清各的。发帖失败 ⇒ `post_status=failed`,退出 0。
9. 文案固定模板(见 R1 版);夹名以外不含记忆内容。

**运维定位(R2 #2)**:`checks.tsv` 是**运维心跳与告警依据**,**不是** founder「连续多日」验收的权威证据——它是本地文件,事后的祖先检查只能证明「那个 sha 最终进了 main」,证明不了「记录时刻它已在远端」。权威证据见 C4 的远端观察 workflow。

测试(seam 覆盖 `_arrival_remote_head` `_arrival_remote_date` `_arrival_now` `_arrival_post`):R1 版全部保留(fresh / stale 30h 与 24h 重提与恢复 / 2h 不报 / 只有删除项 27h / 两个未推提交取最早 / 空格与 rename 路径 / 远端 sha 不在本地对象库 ⇒ unfetched / receipt 缺 4h 连续两次 / **看者不信 receipt 的突变对照** / 远端失败 undetermined / 转移序列 `stale → remote_unreachable → stale → fresh` / 发帖失败不记时、恢复帖失败不清 / 预检 6 零写 / 只读目录 9),新增:`unfetched` 单次不报、连续两次报、对象出现即恢复;`unfetched → writer_silent → fresh` 各账独立;**报告并发**:看者持锁期间 `freshness-report --local` 仍成功且 `state.json` 字节不变;**锁生命周期**:活 pid 跳过、死 pid 回收、TERM 释放、SIGKILL 后下一轮恢复并照常写台账;**依赖缺失**:bounded-run 缺 ⇒ 6、台账零行、发帖 seam 零调用;静态:不含 `chezmoi`、不读 runs.tsv/日志、不含 `git fetch`。

### C4 报告 `freshness-report.sh` + 远端观察 workflow
**`remote-observe.yml`(lead-memory 仓模板,由 `sync-template.sh` 铺到私仓,Lead 以 admin 提交发布)**:`schedule` 每日 UTC 09:05 + `workflow_dispatch`(只供人工补测);`permissions: contents: read`;**恰好一个 job、一个 step**,无 job 级 `permissions`,不引用 `secrets.*` / `github.token`;step 只 `echo "observed_at=$(date -u +%FT%TZ) head_sha=$GITHUB_SHA run_id=$GITHUB_RUN_ID" >> "$GITHUB_STEP_SUMMARY"`。不 checkout、不写任何东西。GitHub 为每次运行保存 `createdAt`(服务端时间)、`headSha`(schedule 运行 = 调度时刻默认分支最新提交)、`event`、`headBranch`——本机无法伪造。
- A1 变更闭包(R3 #3):`sync-template.sh` 文件清单 +1;`first-import.sh` 的 `verify_staged_scope` / `verify_committed_scope` 两份 `required_top` 集合 +1、显式 `git add` 清单 +1;hooks 套件「exact repository surface」循环 +1;first-import 测试断言根提交含 `guard.yml` 与 `remote-observe.yml` 两份。
- 测试 `test-lead-memory-observe-workflow.test.sh`(与 A1 guard.yml 测试同法 yaml 断言):schedule + dispatch、顶层 `contents: read`、无 job 级 permissions、无 `secrets.` / `github.token` 子串、恰好一 job 一 step、无 checkout、summary 含 `head_sha=$GITHUB_SHA`。

**`freshness-report.sh`**(任何读取前先 `lm_read_deps_check`,失败固定非零退出):
- `--remote-observations --from D1 --through Dn`(**只读远端**;n ≤ 7):对窗口内**每个 UTC 日**各跑一次 §2 的固定逐日命令(`--created D --limit 50`),本地复核 `event/headBranch/status/conclusion/attempt==1`;每天一行 `UTC日 · run databaseId · attempt · url · headSha12`;某日无合格自然 attempt ⇒ 该行 `MISSING`,命令退出非零。`--days N` 只是 `--from (today−N+1) --through today` 的简写。
- `--freeze --day D`(D 日的自然观察之后跑):在 canonical 工作树的合法 Lead 夹里,挑一个**当天真实新增或修改**的普通非符号链接文件(实施 runner / QA 指定路径;报告校验路径物理位于 `MEMORY_PATH/<合法夹>/`、是普通 blob、< 1 MB),记 `path`、`expected_blob = git hash-object`、`size`、`run_id_D` 与其 `createdAt`、`frozen_at` 到 `…/acceptance/day-D.json`。**合同**:文件已存在 ⇒ 拒绝(不覆盖);D ≠ 当前 UTC 日 ⇒ 拒;`run_id_D` 不是 D 日合格自然 attempt ⇒ 拒;`createdAt > frozen_at` ⇒ 拒;已存在 D+1 日观察 ⇒ 拒(晚冻结)。只记身份,不做判定;milestone 当天贴 JSON 的 sha256。
- `--check-visible --day D`(D+1 日的自然观察之后跑):读 `day-D.json`(只读);取 `run_id_D` 与 D+1 日合格自然 attempt 的两个 `headSha`;对 URL-encode 后的 path 各查一次 `gh api "repos/xrliAnnie/lead-memory/contents/<path>?ref=<headSha>"`(endpoint 加引号,`?` 不能裸露给 zsh):**D 日树里该路径缺失(404)或 blob ≠ expected,且 D+1 日树里 blob == expected** ⇒ 通过;其他一律不通过并打印两棵树各自的结果。「是否出现」只由两棵远端树回答;本地只提供身份。
- `--commits --days N`:按提交元数据日期分组(标题写明「元数据日期,不是到达日」)。
- `--local`:只读运维视图(`lm_pending_scan` 汇总 + `checks.tsv` 按 UTC 日汇总),不调用 `apply_first_observed`,不写 `state.json`。
- `--json`。
- 测试(seam `_report_gh_run_list` / `_report_gh_api`):`--remote-observations` 必须**只**在 seam 里出现 `-R xrliAnnie/lead-memory` 且每个 UTC 日恰好一次 `--created D`(wrong cwd 无关);manual dispatch run、非 main 分支 run、conclusion≠success 的 run、**attempt==2 的 schedule run(attempt 1 失败后人工 rerun)**一律不计数 ⇒ 该日 `MISSING`;手工 run 挤满当日 50 条上限时仍能取到自然 run(自然 run 在当日列表内);缺一个 UTC 日 ⇒ `MISSING` 非零;`--through − --from > 6` ⇒ 拒。**从零开始的状态机演练**:一个刚发布、历史自然 run 为 0 的 workflow,按 C6.2 时间线 D1/D2/D3 依次喂 fixture,每一天的命令都必须能跑通(D1 `--from D1 --through D1` 不得因 D-1/D-2 缺失而失败)。`--freeze` 反例:重复冻结、D ≠ 今日、run 不合格、`createdAt > frozen_at`、已有 D+1 观察、文件 ≥ 1 MB / 符号链接 / 不在合法夹 ⇒ 全部拒绝。`--check-visible` 四个反例必须**不通过**:(a) 文件早已在远端且未变(D 与 D+1 两棵树 blob 都 == expected);(b) 只 `touch` 不改内容(同 a);(c) 连续三日同一 headSha;(d) 冻结后本地又改了(D+1 树 blob ≠ expected)。正例:D 树 404 / D+1 树相等 ⇒ 通过;D 树旧 blob / D+1 树 expected ⇒ 通过。路径不在合法夹 / 是符号链接 / 含需转义字符 ⇒ 冻结拒绝或正确转义。`--local` 在看者持锁时仍成功且 `state.json` 字节不变。

### C5 plist + manifest + CI 登记 + 退役步骤
- 两个 plist:`ProgramArguments = /bin/bash -c 'set -a; [ -f "$HOME/.flywheel/.env" ] && . "$HOME/.flywheel/.env"; set +a; exec /Users/xiaorongli/Dev/flywheel/scripts/lead-memory/<脚本>'`(host-prefix 与 manifest 一致,token 不进 plist);`EnvironmentVariables.PATH = /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,`FLYWHEEL_SYNC_TRIGGER=launchd`;`StandardOutPath/ErrorPath` 绝对字面量 `/tmp/flywheel-lead-memory-<单元>.log`(launchd 不做 shell 展开;`/tmp` 在 bootstrap 前必然存在)。
- `units.manifest` +2 行 `copy`(退出码 §2.1);`launchd-units-manifest.test.sh` 批准集合 +2、resolved-payload 断言、**日志路径无 `$HOME`/`~` token** 断言。
- ci.yml「Script Tests 4/4」追加六条 `bash scripts/__tests__/test-lead-memory-*.test.sh`(sync 套件带 `FLY2145_REAL_GITLEAKS_BIN`);A1 的 first-import / hooks 套件因闭包改动照跑。
- **部署语义**:converge 只在 LaunchAgents 缺失时安装并 bootstrap;已装 plist 与仓内不同只记 drift,不自动替换。
- **退役 / 回滚(精确步骤,README + acceptance)**:converge 会把**任何**仍在 `~/Library/LaunchAgents/com.flywheel.*.plist` 且未被 launchd override 标记 disabled 的单元当作 enabled unmanaged unit 重新 bootstrap(`converge-nonlead-daemons.sh:1082-1151`,每班 updater 都跑)。所以「删 manifest 行 + bootout」**不是**回滚。仓里**没有**能删除这两个 plist 的既有 operator 命令(`fly1814-cleanup-zombie.sh` 硬编码单一 label,`fly1814-enable-aux-job.sh` 只认八个固定 aux label,`flywheel-daemon.sh uninstall` 属 Lead 家族;R3 #6 核实),因此本单新增最小专用命令 **`scripts/lead-memory/retire-units.sh`**:只接受本单两个精确 label;沿用 `scripts/lib/fly1814-operator-tools.sh` 的 TTY 确认、审计行、`fly1814_file_identity` 身份核对、`fly1814_archive_publish` 归档模式;顺序 ① `disable`(写 override)→ ② `bootout` → ③ 确认已 unloaded 后把精确 plist **归档**(不裸删,可恢复)→ ④ 打印下一步(revert PR 删 manifest 行与源 plist)。重新启用 = `enable` 清 override + converge 重装。**状态机**(每个 label 独立):状态 = enabled/disabled × loaded/unloaded × active plist {absent, 本单字节, foreign} × archive {absent, 与 active 同 inode(hard-link 已发布、unlink 未完成), 独立副本, foreign}。规则:① 审计行(`fly1814_alert_send` 类 audit)必须在**第一次 mutation 之前**成功,失败 ⇒ 零 mutation;审计后**重新核对** domain / disabled / plist identity 再动手;② active 为 foreign 或 archive 为 foreign ⇒ fail-closed 不动;③ archive 与 active 同 inode(上次在 publish 后、unlink 前被 SIGKILL)⇒ 视为合法中间态,只补做 identity-safe unlink;④ active absent 且 archive 已是独立副本 ⇒ 已完成,幂等退出 0;⑤ 非 TTY ⇒ 拒。**恢复顺序**:先把含 source plist + manifest 行的仓版本恢复(revert 的 revert),再 `enable` 清 override,再由 converge 安装,最后核已安装字节 == 仓内。测试 `test-lead-memory-retire.test.sh`:正常路径;plist 已不在(幂等);disable / bootout / archive 各步失败注入 ⇒ 停在该步、不继续;identity drift(已安装 plist 不是本单字节)⇒ 拒;foreign archive ⇒ 拒;非 TTY ⇒ 零 mutation;审计投递失败 ⇒ 零 mutation;**在 archive publish 之后、source unlink 之前模拟中断** ⇒ 下一次运行识别同 inode 中间态并完成;重新 enable 前若 source/manifest 未恢复 ⇒ 命令拒绝并指出顺序;以及 converge 反例(`_cnd_launchctl` seam + `print-disabled`):「manifest 行已删 + 已安装 plist 仍在 + 未 disable」⇒ converge 会再 bootstrap;「已 disable」⇒ 不会。

### C6 README + 两阶段本机验证(实施节点)+ acceptance.md
- README「Contract for FLY-2132 A2 automation」改为「A2 automation (FLY-2146)」:合同六条逐条标「由 sync.sh 第 x 步满足」(第 1 条 ⇒ fetch 失败禁推;第 5 条 ⇒ 退出 7;第 6 条 ⇒ 终结器);看者 / 报告 / `remote-observe.yml` / 部署语义 / **退役步骤** / 人工恢复命令(退出 8 与 `interrupted-staged`)。README 与 workflow 是仓顶层文件 ⇒ admin 提交,由 Lead 在 QA 通过后发布(与 A1 同);实施节点只改 flywheel 模板并在 acceptance 写明。
- **阶段一(合并前,本 worktree)**:
  1. 人手跑 `sync.sh`(`trigger=manual`):现存待送按夹提交推送;贴 schema-safe 摘要(committed_n / failed_n / ignored_n / head12 / remote12 / arrived / observation / fetch_rc / push_rc)与 `ls-remote`、`gh api …/commits/main` 日期;不贴路径。
  2. 临时隔离 label `com.flywheel.lead-memory-sync.fly2146-verify`(临时 plist 指向**本 worktree** 脚本;日志路径同样绝对字面量)`bootstrap` + 手动触发一次。为让这次 launchd 运行**真的经过 push 与 keyring**:实施 runner 在 `flywheel-eng-lead/_fly2146-launchd-smoke.md` 写一个哨兵**文件**(不 commit);断言 receipt `trigger=launchd, arrived=true, observation=observed, committed_n≥1, push_rc=0`,且 `remote_head_after` 前后推进、== `ls-remote`;再删哨兵文件,下一次触发把删除作为合法单夹提交推上去。push 因 keyring 失败(401 / `could not read Username`)⇒ 记录原文并上报 Lead,不自改凭据配置。看者临时 label 同法触发一次 ⇒ 台账一行、标签集合为空。验证完 `disable` + `bootout` + 删临时 plist(按 C5 退役顺序,防止 converge 复活它)。
  3. 反向对照(隔离台架,不碰活仓,不向真频道发帖):常量替换副本 + 临时 fresh clone + `https_proxy` 关闭端口 ⇒ 写者 5 `undetermined`;看者 `remote_unreachable` 且假 token/频道 ⇒ `post_status=failed`。
  4. 记录当刻 chezmoi 仓 `rev-list --count origin/main..HEAD` 作为「本单没碰它」对照。
- **阶段二(合并并经 updater 班车部署后;Lead + QA;是「关单」硬门,不是 ship 前置 —— Lead 2026-09-04 裁定)**:PR 通过阶段一 QA 即出卡合并部署;merge 后 Linear 自动 Done,所以「关单」在这里的落地形式 = Lead 在 issue 留一条「3 日远端观察未完成前不算验收」的 comment + 计划页标「观察中」;三天证据到齐 Lead 写验收 comment,不到齐 Lead 重开 issue。
  - 两个单元 loaded 且已安装 plist 字节 == 仓内;`runs.tsv` 至少两行 `started_at` 分钟落在 :17–:18、间隔 ≈1h(QA 不手动触发);`checks.tsv` 至少两行标签为空。
  - **连续多日(PRD 原句)—— 唯一 UTC 时间线**(Lead 发布 `remote-observe.yml` 后,以第一个有自然观察的 UTC 日为 D1;三个观察日覆盖**两次**连续的「次日可见」转换):
    - D1(观察后):`--remote-observations --from D1 --through D1` → `--freeze --day D1`。
    - D2(观察后):`--remote-observations --from D1 --through D2` → `--check-visible --day D1` → `--freeze --day D2`。
    - D3(观察后):`--remote-observations --from D1 --through D3` → `--check-visible --day D2`。D3 **不再冻结**(D3 的转换要到 D4 才能检,不在本单关单条件里)。各日输出与 run URL 贴进 milestone;**任一日缺合格自然 run、任一次 check-visible 不通过 ⇒ 不验收,Lead 重开 issue;不回滚已完成的合并部署**。
  - 新机器:fresh clone 完成后**立即**独立 `git ls-remote` 读当时的 main,要求 clone HEAD == 这个同时刻远端 sha;最近一次 schedule 观察的 `headSha` 只需是它的祖先或本身(观察后写者再推过是正常的,不算失败;真第二台机器仍是 founder follow-up)。

### C6.1 Lead post-merge checklist(显式命令 + 判据;Lead 裁定 (A))

以 Lead 身份在本机执行,每步失败即停、不跳步;`W=~/.claude/agent-memory`,`T=/Users/xiaorongli/Dev/flywheel/scripts/lead-memory`。模板管理的顶层集合 `TOP = README.md .githooks/lib/guard.sh .githooks/pre-commit .githooks/pre-push .githooks/prepare-commit-msg .github/workflows/guard.yml .github/workflows/remote-observe.yml .gitleaks.toml .gitleaksignore .gitignore bootstrap.sh`。

| # | 命令 | 判据 |
|---|---|---|
| 1 | `git -C $W diff --cached --quiet && test ! -e $W/.git/rebase-merge && test ! -e $W/.git/rebase-apply` | 退出 0(**index 全局为空**、无 rebase 态;Lead 夹**工作树**脏允许) |
| 2 | `test "$(git -C $W ls-remote --exit-code origin refs/heads/main \| cut -f1)" = "$(git -C $W rev-parse HEAD)"` | 相等(本地 HEAD == 远端 main,没有未推内容混入) |
| 3 | `bash $T/sync-template.sh $W` | 退出 0 |
| 4 | `git -C $W status --porcelain=v1 -z -- $TOP \| tr '\0' '\n'` | **恰好两行**:` M README.md` 与 `?? .github/workflows/remote-observe.yml`(只对 TOP 集合看,不看 Lead 夹) |
| 5 | `git -C $W add -- README.md .github/workflows/remote-observe.yml && git -C $W diff --cached --name-only -z \| tr '\0' '\n'` | **恰好两行**,就是这两个路径(NUL-safe;任何第三条 ⇒ `git -C $W reset -q` 并停) |
| 6 | `env FLYWHEEL_MEMORY_ACTOR=admin git -C $W commit -m "chore: publish A2 README and remote-observe workflow (FLY-2146)" && admin_sha=$(git -C $W rev-parse HEAD)` | 提交 trailer `Memory-Owner: admin`;`git show --stat $admin_sha` 只含两个文件 |
| 7 | `env FLYWHEEL_MEMORY_ACTOR=admin git -C $W push origin main` | 退出 0 |
| 8 | `test "$(git -C $W ls-remote --exit-code origin refs/heads/main \| cut -f1)" = "$admin_sha"` | 相等(到达只看远端) |
| 9 | `test "$(gh api "repos/xrliAnnie/lead-memory/contents/.github/workflows/remote-observe.yml?ref=$admin_sha" --jq .sha)" = "$(git hash-object $T/repo-template/.github/workflows/remote-observe.yml)"` | 相等(远端字节 == 模板字节;endpoint 加引号) |
| 10 | `run=$(gh run list -R xrliAnnie/lead-memory --workflow guard.yml --event push --commit "$admin_sha" --json databaseId,headSha,status,conclusion,url --limit 5)`;取 `headSha==admin_sha` 的**唯一**一条;`gh run watch -R xrliAnnie/lead-memory <id> --exit-status`(bounded 10 分钟) | 恰好一条且最终 `completed/success`(绑定本次 admin_sha,不取「最近一条」) |
| 11 | `gh workflow list -R xrliAnnie/lead-memory --json path,state --jq '.[] \| select(.path==".github/workflows/remote-observe.yml") \| .state'` | 输出 `active` |
| 12 | 记 `before=$(gh run list … --workflow remote-observe.yml --event workflow_dispatch --json databaseId --jq '.[].databaseId')`;`gh workflow run remote-observe.yml -R xrliAnnie/lead-memory --ref main`;轮询(bounded 5 分钟)直到出现**不在 `before` 里**的 dispatch run;`gh run watch <该id> --exit-status`;核该 run `headSha == admin_sha`、`event == workflow_dispatch` | 本次 dispatch 的那一条 `completed/success`(只证明 workflow 能跑;**永不计入验收**) |
| 13 | issue 留 comment:「3 日远端观察(D1–D3)未完成前不算验收;计划页标观察中」 | comment 存在;milestone 文件状态 = 观察中 |
| 14 | 按 C6 阶段二的唯一时间线执行 D1–D3(每日在 UTC 09:05 自然观察之后) | 各日输出、run URL、冻结 JSON 的 sha256 贴进 milestone;齐 ⇒ Lead 写验收 comment;缺 ⇒ Lead 重开 issue |

演练断言(实施节点在隔离 fresh clone + 假 origin 上把第 1–8 步走一遍,写进 acceptance):(a) Lead 夹工作树有脏文件时第 1–5 步照样通过;(b) 事先 `git add` 一个 Lead 夹路径 ⇒ 第 1 步就拒,不产生任何 admin 提交;(c) 第 5 步暂存集多出一条 ⇒ reset 并停。

### C6.2 QA 判据(阶段一 / 阶段二分开;Lead 裁定 (B))

**测试范围红线(Lead advisory 2026-09-04,lead-instruction `921bb7a5`)**:实施与 QA 节点跑任何 vitest(全仓门 / 包级 / 定向)都必须排除 `packages/core/test/tmux-viewer.macos.test.ts`(FLY-116 真机 osascript 用例,会真的开关 Terminal.app 并在 founder 屏幕弹辅助功能授权窗):`--exclude "**/tmux-viewer.macos.test.ts"` 或只跑定向文件;implementation / QA report 写明该用例被排除及原因。本单的 shell 套件不经 vitest,不受影响。
**并行度红线(Lead advisory 2026-09-04,lead-instruction `745140bc`;本机 18 核,Bridge 已因整机负载自我保护退出 3 次)**:① 任何 vitest 前置 `VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1`(或 `--maxWorkers=4`);② 禁止 `pnpm test:packages:run` / `pnpm -r test` 类全仓并行门,多包用 `pnpm --workspace-concurrency=1`;③ 构建用 `pnpm --filter <包> build` 单包串行,不跑全仓 `-r build`;④ 只跑与改动相关的测试文件;⑤ 同上排除 tmux-viewer 用例;report 写明所用并行度。本单的 bash 套件逐个串行跑(`bash scripts/__tests__/<one>.test.sh`),不并发。

**阶段一 PASS(合并前,QA 节点判;全部满足才出卡)**:
1. CI 该头全绿(含六套新测试与 A1 闭包测试、manifest 批准集合、workflow 合同、retire 合同)。
2. acceptance.md 含阶段一四步证据:人手 sync 摘要 `arrived=true, observation=observed`;隔离 label 下哨兵文件 `trigger=launchd, arrived=true, committed_n≥1, push_rc=0`、远端 sha 前进,哨兵删除也经 launchd 推上;反向对照 `observation=undetermined` 与 `post_status=failed`(seam,零真帖);chezmoi 对照数字。
3. QA 自己复跑:`ls-remote` == 本地 HEAD;两条突变对照在 CI 日志里可见变红。
4. 隔离 label 已按退役顺序清理(`launchctl print` 查不到临时 label,临时 plist 归档件存在)。

**阶段二(合并部署后;关单硬门,Lead + QA)**:
1. 两个单元 loaded,已安装 plist 字节 == 仓内。
2. `runs.tsv` ≥2 行 `started_at` 分钟 :17–:18、间隔 ≈1h,期间无人手动触发;`checks.tsv` ≥2 行标签为空。
3. C6.1 第 14 步三天证据齐:D1–D3 各有 `attempt==1` 的 completed/success 自然 schedule/main run;D2 检 D1、D3 检 D2 两次 `--check-visible` 通过;D1、D2 的冻结 JSON sha256 已在当天 milestone 记录。
4. 新机器:fresh clone HEAD == 同时刻 `ls-remote`;最近观察 sha 是其祖先或本身。
阶段二任一条不成立 ⇒ 不验收,Lead 重开 issue;不回滚阶段一的合并部署。

### C7 收尾
acceptance.md · founder HTML 更新 · milestone 文件 `engineering/doc/milestones/FLY-2146.md`(ship 时,含三天远端观察证据)· 不改 CLAUDE.md 表格。

## 5. 负向护栏清单(设计里显式列出,测试覆盖)

1. `arrived` 只由终结器里重新执行的 `ls-remote` 决定;push rc 不能置真(突变 a)也不能置假(突变 b);`expected_local_sha` 在每个终结器入口都已定义(逐终态表)。
2. 看者判标签不读写者 receipt 的 `arrived`、不读 runs.tsv、不读日志;receipt 只用于 `writer_silent`(突变对照)。
3. 写者永不 `--no-verify` / `--force` / admin(静态解析 push argv);永不 add 顶层路径与非法名目录;每提交恰一夹。
4. 钩子输出(commit **与 push**)只落 0600 临时文件并删除;receipt 不记规则 id;路径只在 0600 文件;acceptance 不贴路径。
5. index 起始必须干净,否则 fail-closed 不 reset;add 后断言暂存集 ⊆ 当前夹;commit 后断言 index 空。
6. fetch 失败 ⇒ 禁 rebase 禁 push;rebase 失败 ⇒ abort 且 HEAD 复原、两个状态目录不存在;复原失败 ⇒ 8 停、不进终结器。
7. 远端读不到 ⇒ `undetermined`;对象缺失 ⇒ `unfetched`(连续两次);列值 `undetermined` 不是 0。
8. 没有待送内容 ⇒ 不报 stale;删除项按首见时间计龄。
9. 四本 episode 账独立;发帖成功才记时;恢复帖成功才清;`undetermined` 不清。
10. 预检失败 ⇒ 记忆仓零改动 / 看者零台账零发帖;证据写失败 ⇒ 9 覆盖一切(含 6/8)。
11. 活锁 ⇒ 75,零 mutating / 远端 git 操作、不碰共享文件;信号中断释放锁并按规则处理暂存。
12. 无 TTY:`GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false`;测试全套 `</dev/null`。
13. 无开关:`--skip-*`/`--dry-run` ⇒ 未知参数;`SKIP_*=1` ⇒ 行为逐字节不变;生产脚本无读环境变量改常量的路径。
14. origin:raw URL、resolved fetch URL、resolved push URL 都必须恰好一条且 == canonical;pushurl / pushInsteadOf / 多 URL / 对称 insteadOf 到错误仓 ⇒ 6,在任何 add 之前。
15. 预检覆盖钩子依赖闭包(guard.sh、两份 gitleaks 策略文件、bounded-run.sh);缺 ⇒ 6,不降格。
16. 报告永不写看者 `state.json`;看者写共享文件时持短锁。
17. plist 日志路径为绝对字面量;退役必须先 `disable` 再 `bootout` 再删已安装 plist,否则 converge 复活。
18. 看者与写者源码不含 `chezmoi`;看者不 fetch 活仓;常量与 `guard.sh` 逐字一致。
19. 远端观察只认 `-R xrliAnnie/lead-memory` + `event=schedule` + `headBranch=main` + `conclusion=success`(CLI 过滤 + 本地复核);manual dispatch / 非 main / 失败 run 不计;缺一个 UTC 日即 `MISSING`。
20. `--check-visible` 必须证明内容转换(D 日树缺失或不同 **且** D+1 日树相等);未变化老文件、touch-only、同 headSha 三日、冻结后再改四个反例必不通过。
21. 看者锁与写者锁同一实现、同一陈旧回收合同;看者 / 报告缺 bounded-run / python3 / curl ⇒ 预检 6,不得发帖。
22. 退役走 `retire-units.sh`(disable → bootout → 归档精确 plist),不裸删;identity drift 拒。

## 6. 迁移与回滚边界

| 时点 | 动作 | 记忆文件 |
|---|---|---|
| 首次跑写者 | 现存待送内容按夹进提交并推送 —— A1「交给 A2」的那批;没有迁移脚本 | 零变化(只读 + 提交) |
| 停用 / 回滚 | `retire-units.sh`(disable → bootout → 归档精确 plist)+ revert PR;已推提交留在远端;归档件可恢复 | 零变化 |
| 写者留下 `interrupted-staged` / 退出 8 | README 人工恢复命令;下一轮预检自动接手 | 零变化 |
| 看者误报 | 一条 Discord 消息;改阈值常量走 PR | 零变化 |
| `remote-observe.yml` | Lead 用 admin 提交删除即停;运行记录仍留在 GitHub | 零变化 |

## 7. 诚实边界(照抄进 founder HTML)

- **「连续若干天」是关单硬门,不是 ship 前置,一次 QA 会话验不完**:PR 过阶段一 QA 即合并部署;三天证据来自远端(GitHub 每日 workflow 的 `createdAt` + `headSha` 与 `--check-visible` 的两棵树比对);证据齐之前 issue 由 Lead 的「观察中」comment 守着,不齐则重开。
- **本地台账 `checks.tsv` 只是运维心跳与告警依据**,不是验收证据:远端历史不保存 ref 更新时刻,事后祖先检查证明不了「记录时刻已在远端」。
- **真第二台机器**仍是 founder follow-up。
- **launchd 域下 keyring 凭据**设计阶段未验证;阶段一哨兵首跑即暴露,失败即上报不自改。
- **看者本身没人看**:每小时一行台账 + 每日一次远端观察,是 FLY-2134 可消费的心跳面;本单不做元监控。
- **检测延迟**:stale 最坏 27h;writer_silent / unfetched 最坏 5h。
- **机上那套 chezmoi 同步仍是坏的**;建议另开单。
- **多机同时写同一 Lead 夹** ⇒ 冲突中止 + 告警,不自动解。
- **plist 变更不会被 converge 自动刷新**;回滚必须按四步,否则被复活。
- 告警靠 Discord bot 发帖,配置缺失时只能在台账记 `post_status=failed`。
- **本单对 A1 的改动只限模板闭包**:`sync-template.sh` 清单、`first-import.sh` 两份精确集合与 add 清单、hooks/first-import 测试断言各 +1(铺 `remote-observe.yml`);护栏 `guard.sh` 与钩子本身不动。
- **`workflow_dispatch` 的运行与人工 rerun 的后续 attempt 永不计入验收**;三天证据必须是 `main` 上 `attempt==1` 的自然 `schedule` 运行;三个观察日覆盖**两次**连续的次日转换(D1→D2、D2→D3),不是三次。

## 8. 风险

| 风险 | 处理 |
|---|---|
| launchd 域下 `gh auth git-credential` 读不到 keyring | C6 阶段一哨兵首跑即暴露;上报 Lead 裁凭据形态 |
| `/usr/local/bin/gh`(2.74.2)与 `/opt/homebrew/bin/gh`(2.97.0)双装 | helper 走 `.gitconfig` 写死路径(本机存在);`gh api`/`gh run` 走 PATH 新版;共用 keyring |
| 每小时 push 触发远端 `guard.yml` | 只在有新提交时 push;预估 <10 次/日;`remote-observe.yml` 每日一次几秒 |
| 机器长时间合盖 | 日历触发唤醒补跑;stale 26h;silent/unfetched 连续两次 |
| `sub-lead/assets` 大媒体 | 单次 push 远小于 GB 级;失败 ⇒ 5/7 + 看者 27h 内告警 |
| Lead 正在写的半截文件被提交 | 下一小时修正;与 A1「不停机」同边界 |
| `/tmp` 日志不轮转 | 与 daily-standup 同形;每次 <20 行 |
| 看者每小时台账 ~8760 行/年 | 每行 <200 字节;报告按天汇总 |
| GitHub Actions schedule 可能延迟数十分钟 | 观察是「每日一次」,延迟不影响判据;连续三天缺一天 ⇒ 不算过 |

## 9. 完成定义

C1–C5 测试全绿并登记进 ci.yml(新增五套;修改并重跑 hooks / first-import / manifest 三套);C6 阶段一四步证据齐;README 与 workflow 模板改好;PR 关联 FLY-2146;founder HTML 已发布。**出卡 / 合并 / 部署**只看阶段一 PASS(C6.2)。**关单**另需阶段二(C6.2):Lead 按 C6.1 发布 workflow 后计日,两次自然触发 + 连续 3 个 UTC 日的 `schedule`/`main` 远端观察 + 每日 `--freeze` / 次日 `--check-visible`;merge 后 Linear 自动 Done,以 Lead 的「观察中 / 验收」comment 为准,证据不齐 Lead 重开。

## 10. 评审记录

- R1(2026-09-04,codex-review-round1.md):CHANGES REQUESTED,12 条(6 BLOCKER / 5 HIGH / 1 MEDIUM)。全部接受:到达终结器与非对称突变;看者先判对象在不在;删除项首见计龄与 `-z`;报告改称元数据日期;launchd 两阶段;origin 校验;index 所有权与 trap;候选集含已删夹;钩子输出 0600;看者每小时与独立 episode;固定 schema 与退出 9;常量合同测试与 manifest 批准集合。
- R2(2026-09-04,codex-review-round2.md):CHANGES REQUESTED,8 条(3 BLOCKER / 3 HIGH / 2 MEDIUM)。全部接受:
  - #1 resolved fetch/push URL 各自必须 == canonical(不只彼此相等);测试夹具改常量替换副本;对称 insteadOf 到错误仓必拒(C1、§5-14)。
  - #2 本地台账降为运维心跳;权威多日证据改为远端 `remote-observe.yml` 的 `createdAt`+`headSha` 与 `--check-visible` blob 比对;阶段二列为 ship 硬门(C3、C4、C6、§7、§9)。
  - #3 `expected_local_sha` 状态机、fetch 失败禁 rebase/push、退出 7 覆盖 fetch/push 命令失败、8 不进终结器、逐终态断言表(§2.1、C2)。
  - #4 plist 日志路径改绝对字面量 `/tmp/…`,manifest 测试断言无 `$HOME`/`~`(§2、C5)。
  - #5 退役四步(disable → bootout → 删已安装 plist → revert)+ converge 复活测试(C5、§6)。
  - #6 预检覆盖 guard.sh / 两份 gitleaks 策略 / bounded-run;push 输出同样 0600 隔离;负向测试(C1、C2)。
  - #7 唯一退出码真值表(9 覆盖含 6/8;状态目录不可写归 9);锁前移到只读仓根检查之后;静态检查只解析 push argv(§2.1、C2)。
  - #8 采集与状态迁移分离(`lm_pending_scan` 纯 / `apply_first_observed` 看者专有);报告永不写 state;看者短锁;`unfetched` 独立第四本账、连续两次、恢复条件与并发测试(C1、C3、C4)。
- R3(2026-09-04,codex-review-round3.md):CHANGES REQUESTED,8 条(2 BLOCKER / 4 HIGH / 2 MEDIUM;两个 BLOCKER 都在 R2 新引入的远端验收面)。全部接受:
  - #1 `--remote-observations` 固定 `-R xrliAnnie/lead-memory --event schedule --branch main`,JSON 含 event/headBranch/databaseId/url/status/conclusion,按 UTC 日分页取满,本地复核,缺日 `MISSING`;workflow 合同测试加一 job 一 step / 无 job 级 permissions / 无 secrets 引用;milestone 贴 run URL(§2、C4、§5-19)。
  - #2 `--check-visible` 改为「D 日 `--freeze` 冻结当天真实新增/修改文件的 path+blob;D+1 日两棵远端树证明缺失或不同 → 相等」;四个反例必不通过(C4、C6、§5-20)。
  - #3 A1 变更闭包补 `first-import.sh` 两份精确集合与 add 清单、hooks/first-import 测试;撤回「唯一改动」措辞(§1、C4、§7)。
  - #4 看者锁改用与写者共用的 `lm_lock_acquire`(pid / 陈旧回收 / 重试一次 / trap),测试 SIGKILL 后恢复(§2、C1、C3)。
  - #5 拆 `lm_read_deps_check`(git/gh/jq/python3/curl/bounded-run),看者与报告预检调用;bounded-run 缺失不得变 `remote_unreachable`(C1、C3、C4、§5-21)。
  - #6 新增 `retire-units.sh`(沿用 fly1814 operator 模式:disable → bootout → 归档精确 plist),含各步失败注入 / identity drift / 幂等 / 重新 enable 测试(§2、C5、§6、§5-22)。
  - #7 真值表:8 扩为广义「仓状态/所有权无法安全恢复」(含 foreign-staged 与 trap 清理失败);INT/TERM 终态 130/143 不在 allowed 名单、不跑终结器、receipt 记 `interrupted`(§2.1、C2)。
  - #8 新机器验收改比同时刻 `ls-remote`,最近观察只需是祖先或本身(C6)。
- R4(2026-09-04,codex-review-round4.md):CHANGES REQUESTED,8 条(2 BLOCKER / 2 HIGH / 3 MEDIUM / 1 LOW;旧架构零重开,两个 BLOCKER 都在 R4 新加的 C6.1/C6.2 清单)。全部接受:
  - #1 C6.1 重写为 fail-closed 序列:index 全局为空 + 无 rebase 态 + HEAD==ls-remote 先证;porcelain 只限模板管理的 TOP 集合;add 后 NUL-safe 断言暂存集恰好两条;三条演练断言(C6.1)。
  - #2 唯一 UTC 时间线:D1 窗口 D1 后冻结;D2 窗口 D1–D2 检 D1 后冻结;D3 窗口 D1–D3 检 D2,不再冻结;三个观察日覆盖两次转换;「不 ship」改为「不验收、重开、不回滚」;从零状态机演练测试(C4、C6、C6.2、§7)。
  - #3 run JSON 加 `attempt`,只认 `attempt==1` 的 completed/success;rerun 反例(§2、C4)。
  - #4 guard run 按 `--commit $admin_sha` 绑定并 `gh run watch` 有界等待;workflow list 用 `--json path,state`;dispatch 记 before 集合、按新出现的 run id 核 headSha 并等待;含 `?ref=` 的 endpoint 加引号(C6.1)。
  - #5 逐 UTC 日 `--created D --limit 50` 查询,窗口上限 7 天,`--days N` 只是简写(§2、C4)。
  - #6 retire 状态表(enabled/disabled × loaded × active × archive)、审计成功与复核为首个 mutation 前置、同 inode 中间态恢复、foreign 拒、恢复顺序先还原 source/manifest(C5)。
  - #7 `--freeze` create-if-absent 原子发布、D==今日、run 合格、createdAt<=frozen_at、无 D+1 观察、<1 MB 普通 blob;milestone 记 sha256;反例测试(§2、C4)。
  - #8 测试数目改为「新增五套 + 修改重跑三套」(§1、§9)。
- Lead 裁定(2026-09-04,ask `d76baa93`):(A) 远端 workflow 由 Lead 在 QA PASS 后 admin 发布,发布步骤写成显式 checklist ⇒ C6.1;(B) 阶段二是关单硬门不是 ship 前置,PR 过 QA 即合并部署,关单以 Lead 的 issue comment 落地;QA 判据阶段一/二分开 ⇒ C6.2、§9、§7。

## 11. Residue(Lead acceptance 收口;Lead 裁定 2026-09-04,ask `6605fba4`)

Codex 设计评审四轮:R1 12 条 → R2 8 条 → R3 8 条 → R4 8 条;后两轮的 BLOCKER 全部落在上一轮新写出来的面上(R3 在 R2 新引入的远端验收面,R4 在 R3 后按 Lead 裁定新写的 post-merge 清单)。Lead 裁定:**R5 未跑,由 Lead acceptance 收口**;R4 的 8 条已全部按修法落进本 plan(不新增任何机制或面),逐条处置位置如下。实现段起手照例做 exact-blob 复核当作第五轮。

| R4 # | 严重度 | 要点 | 处置位置 |
|---|---|---|---|
| 1 | BLOCKER | admin 发布清单在 Lead 夹脏的活仓上假失败;预暂存路径可搭便车 | C6.1 表第 1–5 步(index 全局为空 + 无 rebase 态 + HEAD==ls-remote 先证;porcelain 只限 TOP 集合;add 后 NUL-safe 断言恰好两条)+ 演练断言 (a)(b)(c) |
| 2 | BLOCKER | 三日协议 D1 跑 `--days 3` 必然 MISSING;三观察日只验两次转换;「不 ship」措辞与裁定 (B) 冲突 | C6 阶段二「唯一 UTC 时间线」(D1 冻结;D2 检 D1 冻结;D3 检 D2 不冻结);C6.2 阶段二第 3 条;§7「三个观察日覆盖两次转换」;措辞统一为「不验收、Lead 重开、不回滚合并部署」;C4 从零状态机演练测试 |
| 3 | HIGH | `event=schedule` 不能证明无人工 rerun | §2 workflow 行与 C4:JSON 加 `attempt`,只认 `attempt==1` 的 completed/success;rerun 反例测试 |
| 4 | HIGH | guard/dispatch 检查未绑定本次 commit/run;workflow list 判据不精确;`?ref=` 未引用 | C6.1 第 6/9/10/11/12 步(`admin_sha` 捕获;`--commit $admin_sha --event push` 唯一匹配 + `gh run watch` 有界等待;`--json path,state`;dispatch 记 before 集合按新 run id 核并等待;endpoint 加引号) |
| 5 | MEDIUM | `gh run list` 无分页 flag,`--days N` 会静默截断 | §2 workflow 行与 C4:逐 UTC 日 `--created D --limit 50` 查询 + 本地复核;窗口上限 7 天;`--days N` 只是简写 |
| 6 | MEDIUM | retire 缺幂等/中断状态机与恢复顺序 | C5「状态机」段(enabled/disabled × loaded × active × archive;审计成功与复核为首个 mutation 前置;同 inode 中间态恢复;foreign 拒;非 TTY / 审计失败零 mutation;恢复顺序先还原 source/manifest 再 enable 再 converge)+ 对应测试 |
| 7 | MEDIUM | `--freeze` 缺 create-once 与时间边界合同;Contents API 大小限制 | §2「验收冻结记录」行与 C4 `--freeze`(create-if-absent;D==今日;run 合格;`createdAt<=frozen_at`;无 D+1 观察;<1 MB 普通 blob;milestone 记 sha256)+ 反例测试 |
| 8 | LOW | 测试数目与 CI 追加行数对不上 | §1、§9:新增五套 + 修改重跑 hooks / first-import / manifest 三套 |

未跑 R5 的已知残余(如实列出,供实现段第五轮复核):R4 修法本身未经 Codex 复核;C6.1 演练断言 (a)(b)(c) 与 C4 从零状态机演练是新写的测试要求,实现段以 RED 先行验证其可执行性。
