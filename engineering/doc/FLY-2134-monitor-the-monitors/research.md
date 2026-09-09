# FLY-2134 监控者的监控 — 调研
Issue: FLY-2134 (https://linear.app/geoforge3d/issue/FLY-2134/infra观测-没有人监控这些监控者4-例自动机制静默失效-2-5-个月无一发出声音-其中全舰-12-个-lead-的-1043)
日期: 2026-09-08
基于: exploration.md

本文回答 exploration §5 Option B 落地要碰的每一处仓内事实,所有路径 2026-09-08 在 `flywheel-FLY-2134` worktree(基 `ee113cab9`)实读。

## 1. 架构模板:`arrival-check.sh` 能泛化到什么程度

`scripts/lead-memory/arrival-check.sh`(318 行)的骨架与本单要的东西逐段对照:

| arrival-check 现状 | 泛化后 | 差异 |
|---|---|---|
| 5 个写死条件 `stale / writer_silent / unfetched / remote_unreachable / structural`(`:9-13`) | 每个登记行 = 一个 episode,名字 = `artifact_id` | 条件集从常量变成登记表驱动 |
| 条件三态 `True / False / None`,`None`=「判不出」不清账(`:219-225`);另有独立 `remote_unreachable` 条件会告警 | 四态 verdict `fresh / stale / missing / undetermined`;`undetermined` 不进不清 `incident`,连续两轮进独立 `unobservable` 账(对应 arrival 的 `remote_unreachable`) | `missing` 是新增,专给形状 B |
| episode 账 `enter / renotify(24h) / recover`,发帖成功才记 `lastNotifiedAt`,恢复帖失败不清(`:226-236,284-295`) | 原样 | 无 |
| 直发 Discord,`_arrival_post` seam(`:24-38`) | `_af_post` seam,同 env 三元组 | 消息体加 artifact_id / 期望 / 实际 / owner |
| 状态 `state.json` + 台账 `checks.tsv` 固定表头(`:14,305`) | `state.json` + `checks.tsv`(每行一个 artifact)+ **新增 `last-run.json`**(给 W-4 读) | 多一个 receipt |
| 锁 `lm_lock_acquire`(mkdir + pid,死 pid 回收,`sync-common.sh:195-232`) | 原样 | 无 |
| 永远返回 0/6/9/10,manifest 只允许 0(`units.manifest:11`) | 同 | 无 |
| 依赖 `MEMORY_PATH` / `REMOTE_URL` 常量与 `lm_origin_check` | **不依赖**;`sync-common.sh` 顶部三个常量是 lead-memory 专用,source 它会把 `MEMORY_PATH` 等带进来 | ⇒ 把 `lm_bounded / lm_write_json_atomic / lm_append_tsv / lm_lock_acquire / lm_lock_release / lm_remote_head` **抽到 `scripts/lib/freshness-common.sh`**?还是直接 `source sync-common.sh`? |

**决定:直接 `source scripts/lead-memory/lib/sync-common.sh`,不抽库。** 理由:① 该文件 `source` 不 dispatch main、不改 shell options(FLY-2146 §2 合同);但它会强制展开 `${HOME:?}`、解析路径并赋值 `REMOTE_URL/MEMORY_PATH/LM_*` 与锁全局(`:3-20`,Codex R1 #9)⇒ 新脚本必须在任何锁之前、自身常量之前 source,并先检查 `HOME` 与 library 文件;② 带进来的三个常量只是变量,不用即无害;③ 抽库要动 FLY-2146 的 5 个 suite 与 `assert_constants_match_guard`,横切改动与本单无关。代价:新脚本对 lead-memory 目录有 source 依赖,写在 plan §2 稳定标识里;`lm_remote_head` 硬写 `refs/heads/main` 且 ls-remote `origin`——chezmoi 仓默认分支也是 `main`(`## main...origin/main`),runner-memory 目前非仓;登记行加 `branch` 列不值,写死 `main` 并在 `--status` 输出分支名。

## 2. 登记表语法(新文件 `scripts/launchd/artifact-freshness.manifest`)

放在 `scripts/launchd/` 与 `units.manifest` 同目录、同 TSV 风格、同 `#` 头部指令习惯,但**独立文件、独立解析器**(exploration §5 Option A 的否决理由:`_cnd_load_manifest` 5 列 fail-closed 语法被五套 CI 守卫与 `retire-units.sh:41` 的 awk 读,不能加列)。

```
# FLY-2134 artifact freshness authority. TSV columns:
# artifact_id	kind	target	max_age_h	state	owner	note
# state: active | suspended
# kind:  file_mtime | sqlite_max | git_remote_head
```

| 列 | 语法 | 说明 |
|---|---|---|
| `artifact_id` | `^[a-z0-9][a-z0-9-]{2,63}$`,全表唯一 | episode 名、台账列、告警文案里的稳定标识 |
| `kind` | 三枚举 | 见 §3 |
| `target` | 路径允许且仅允许 `$HOME/` 前缀展开(字符串替换,**不 eval**);`sqlite_max` 为 `<path>::<table>::<column>` | 见下 |
| `max_age_h` | 正小数,`^[0-9]+(\.[0-9]+)?$`,上限 8760 | 期望新鲜度 |
| `state` | `active` 页;`suspended` 只算不页,`--status` 列出并标「已知停用」 | 把「被 disabled」变成登记表里一个**有理由**的显式状态 |
| `owner` | launchd label 或 `external:<name>` 或 `none` | 文案用;测试锁:label 形态的 owner 必须在 `units.manifest` 第 1 列 |
| `note` | 自由文本,`suspended` 时必须含 `FLY-\d+` | 停用理由可追溯 |

`sqlite_max` 需要指明表和列:不加第 8 列,`target` = `<path>::<table>::<column>`,table/column 各匹配 `^[A-Za-z_][A-Za-z0-9_]{0,63}$`,脚本自行拼 `SELECT max("<column>") FROM "<table>"`,用 `sqlite3 -readonly -batch -noheader -bail` 执行,超时经 `lm_bounded`。**登记表里不放 SQL**(Codex R1 #2:本机 `/usr/bin/sqlite3` 暴露 `writefile` / `load_extension`,`-readonly` 只管库文件打开模式,任何「select 前缀白名单」都挡不住 `select writefile(...)`)。解析器拒绝不合语法的行 ⇒ 整表拒绝、exit 6、零发帖(fail-closed,与 `_cnd_manifest_reject` 同纪律)。

**未知 kind / 重复 id / 列数不对 / suspended 无 issue 号 ⇒ 整表拒绝。** 一行坏、全表不跑,比「跳过坏行继续」更诚实——否则登记表自己就成了形状 A。

## 3. 三种探针的判定规则(全部只读)

统一输出 `verdict	observed_value	age_h	detail`;`age_h` 用 UTC epoch 差,`date -u +%s` 走 `_af_now` seam。

| kind | 观察什么 | fresh | stale | missing | undetermined |
|---|---|---|---|---|---|
| `file_mtime` | `stat` mtime(macOS `stat -f %m`,先试 `stat -c %Y`,抄 `meta-alert.sh:39-58` 的可移植顺序);**零字节文件不算新鲜**(同 meta-alert 的教训) | `now - mtime ≤ max_age_h` | `>` | 路径不存在 / 是 symlink | `stat` 失败但路径存在(权限) |
| `sqlite_max` | `sqlite3 -readonly -batch -noheader -bail <path> 'SELECT max("<column>") FROM "<table>"'` 得单值,值必须是 `YYYY-MM-DD`(按 UTC 当日 00:00 计)或 ISO-8601 或 epoch 秒 | 同上 | 同上 | 文件不存在;或查询返回空/NULL(表存在但无行——例如新库) | 库锁死 / `SQLITE_BUSY` / 表或列不存在 / 输出非单行单列或非日期 / 超时 124 |
| `git_remote_head` | ① `git -C <path> rev-parse HEAD`;② `lm_remote_head <path>`(ls-remote `origin refs/heads/main`,120s 有界);③ 相等 ⇒ fresh;④ 否则 `merge-base --is-ancestor` 定拓扑:HEAD 是远端祖先(远端领先)⇒ fresh;远端是 HEAD 祖先或分叉 ⇒ 取 `remote..HEAD` 最早提交 `%ct` | 远端 == 本地 HEAD;或远端领先;或最早本地独有提交年龄 ≤ max_age_h | 最早本地独有提交年龄 > max_age_h(分叉时台账标 `diverged`) | `<path>/.git` 不存在,或 `git remote get-url origin` 失败(**无远端 = 假设不成立**) | ls-remote 失败(网络/认证)、远端 sha 不在本地对象库(与 arrival-check 的 `unfetched` 同因:不 `git fetch`,只报判不出)、ancestry 命令异常退出 |

三点纪律,抄 FLY-2146 §5:不读任何机制的日志、runs.tsv、退出码;不 `git fetch`、不 `chezmoi`、不 `launchctl`(静态断言锁);`undetermined` 不进不清 `incident` 账——但**连续两轮** `undetermined` 进入独立的 `unobservable` 账并告警(Codex R1 #1:否则 stat 永久失败 / 认证永久失败又成了新的沉默)。

**chezmoi 的特殊性**:它的 launchd 单元在 `com.chezmoi.*`,不在 census-scope;`owner=external:com.chezmoi.auto-sync`。远端最新提交 2026-03-15 而本地最新 09-06 ⇒ v1 首跑即 `stale`(最早未推提交 2026-03-16 02:04,≈176 天)。这是**预期的阳性**,QA 用它当真实正例(exploration §1 #2)。

**runner-memory 的特殊性**:`~/.flywheel/runner-memory/.git` 不存在 ⇒ `missing`,直到有人建仓建远端。这是形状 B 的字面断言(Q2,推荐登记)。

## 4. 初版登记表(v1,5 行)

| artifact_id | kind | target | max_age_h | state | owner | 依据 |
|---|---|---|---|---|---|---|
| `token-usage-daily-row` | `sqlite_max` | `$HOME/.flywheel/token-usage.db::token_usage_daily::day` | 36 | **active**(Lead 裁定) | `com.flywheel.token-usage-daily` | issue #1;库现存 96 行,`max(day)=2026-06-30`,首跑即 stale(≈70 天) |
| `chezmoi-remote-head` | `git_remote_head` | `$HOME/.local/share/chezmoi` | 48 | active | `external:com.chezmoi.auto-sync` | issue #2;首跑即 stale |
| `lead-memory-arrival-ledger` | `file_mtime` | `$HOME/.flywheel/state/lead-memory/arrival/checks.tsv` | 3 | active | `com.flywheel.lead-memory-arrival-check` | FLY-2146 §7「看者本身没人看」;每小时 :40 追加一行,3h = 允许漏两轮 |
| `bridge-liveness-probe-state` | `file_mtime` | `$HOME/.flywheel/state/bridge-liveness-probe.json` | 0.25 | active | `com.flywheel.bridge-liveness-probe` | 三方环的一边;probe 每 60s 原子重写状态文件(`:106-120`),15 分钟 = 漏 15 轮 |
| `runner-memory-remote-head` | `git_remote_head` | `$HOME/.flywheel/runner-memory` | 26 | active(Lead 裁定) | `none` | 形状 B 新实例;首跑即 missing,直到 Lead 另开的建远端单落地 |

**故意不登记的**(写进 plan §7 诚实边界):`daily-standup` 日志(那是「跑过」不是「产出」;它的产出是 Discord 帖,要读频道才能验,越界)、`quota-monitor.log`(KeepAlive 守护进程,日志新鲜 = 活着,同上)、`notify-receipts.json`(与 token-usage 同机制,一机制一产出物即可)、`lead-memory` 远端 head 本身(arrival-check 已看,本单看它的台账,不重复)、gbrain sync(GeoForge3D 的机制,归 geoforge3d 项目;在 exploration 记为证据)。

## 5. 看者本体:`scripts/artifact-freshness-check.sh`

| 项 | 值 | 来源/理由 |
|---|---|---|
| launchd label | `com.flywheel.artifact-freshness-check` | 与 probe / arrival 命名同族 |
| plist | `scripts/launchd/com.flywheel.artifact-freshness-check.plist`,`StartCalendarInterval {Minute:50}`,`bash -c 'set -a; . $HOME/.flywheel/.env; set +a; exec <script>'`,`StandardOut/ErrorPath` 绝对字面量 `/tmp/flywheel-artifact-freshness-check.log`(不能写 `$HOME`,FLY-2146 §2 测试断言同形) | 每小时,在 arrival-check(:40)之后 10 分钟,这样 `lead-memory-arrival-ledger` 每轮看到的都是本小时的行 |
| `units.manifest` 行 | `com.flywheel.artifact-freshness-check	com.flywheel.artifact-freshness-check.plist	copy	0	artifact freshness observer; reports incidents independently` | `copy` 策略 ⇒ 由 restart-services / update-flywheel 的 `converge_nonlead_daemons`(`restart-services.sh:3226`,`update-flywheel.sh:272`)原子安装并 bootstrap;`launchd-units-manifest.test.sh` 要求 repo plist 集合与 manifest 闭合 ⇒ 同 PR 加行 |
| 状态目录 | `<state-root>/state/artifact-freshness/`,`<state-root>` = `FLYWHEEL_STATE_DIR` 去首尾空白后非空则取之、否则 `$HOME/.flywheel`(shell 与 TS 同一语义,**不是** `${VAR:-default}`;合同以 plan §2 为准)— `state.json`(两本 episode 账,schema 1)· `checks.tsv`(固定表头,含 `run_id` 与 `detail`,见 plan §2)· **`last-run.json`**(整轮 commit marker:`{schema:1, run_id, observed_at, registry_sha256, rows, counts, unobservable_active, post_status, run_status}`,原子写)· `lock/` | `last-run.json` 是 W-4 读的 receipt,Bridge 侧 fail-closed 校验全部字段(plan §2.5);registry sha 让 Bridge/人能对上是哪版登记表 |
| 用法 | `artifact-freshness-check.sh`(观察一轮)· `--status`(只读打印表,不写状态、不发帖;给 Lead 巡检与 QA)· `--registry <path>`(测试与 QA 注入的**唯一**覆盖方式,无 env)· `--validate`(只解析登记表,exit 0/6) | `--validate` 进 CI:生产登记表每次 PR 都过解析 |
| 退出码 | 0 正常(含锁被占)· 6 预检/登记表拒绝(零发帖、零写台账)· 9 状态 IO 失败 · 10 有发帖失败(台账已写) | 抄 arrival-check;manifest `allowed_exit_codes=0` |
| 告警文案 | `artifact-freshness <artifact_id> <enter|renotify|recover>: verdict=<v> expected≤<max_age_h>h observed=<value> age=<age_h>h owner=<owner>`,≤ 1900 字符,纯文本,不含路径以外的用户数据 | 与 arrival-check 同风格;不 @ founder 除非 `FLYWHEEL_FOUNDER_DISCORD_USER_ID` 设了(同 probe 语义) |
| 阈值常量 | `RENOTIFY_HOURS=24`(全表统一,不按行)· `UNDETERMINED_CONSECUTIVE=2` | 与 arrival-check 一致;按行可配是 YAGNI;**不新增任何 `FLYWHEEL_*` env**(Codex R1 #8:`truth.ts:1013-1019` 拒绝未登记的 `FLYWHEEL_*` 名,登记它们不值) |
| 时间 | 全 UTC | 台账可跨机器比对 |

**为什么不用 `lead-alert.sh`(Q3)**:它的 queue 由 Bridge `LeadAlertNotifier.drainQueue()` 排空(`plugin.ts:12804`);一条「监控者死了」的告警如果只进 queue,就与 Bridge 同死。直发 + 自带 episode 账把重复发帖限在「每 episode 一次 + 24h 重提」,不需要 claims.db。代价:不进 Claw duty 的 alert-ticket 通路——但记忆库记「duty write path 2026-09-06 在生产未启用」,今天也没有人靠它。

## 6. 三方环:W-4 可选 lane

| 端 | 改动 | 兼容性 |
|---|---|---|
| Bridge builder `liveness-manifest.ts:174-195` | `components` 加 `w4_artifact_freshness: { class:"W-4", wired:true, effective_enabled:true, switch:"required/no_switch", observation:"receipt_file", receipt_path, last_run_at, freshness, run_status }`;`freshness` = `not_started`(receipt 不存在)/ `invalid`(存在但任一字段不合 plan §2.5)/ `fresh`(`now - observed_at ≤ 180min`)/ `stale`;阈值为代码常量 `ARTIFACT_FRESHNESS_STALL_MS`(每小时 cadence × 2 + 1h 宽限,同 W-1 的 2× 思路),不设 env | Phase A 只加键、`schema_version` 保持 2;Phase B 升 3 且 W-4 必有(plan §2.4) |
| Bridge 调用点 `plugin.ts:5871` | 传 `artifactFreshness: { receiptPath }`,`receiptPath = join(artifactFreshnessStateDir(env), "last-run.json")`,state root 解析与 `plugin.ts:5294-5295` 同式(`trim() \|\| join(homedir(), ".flywheel")`);receipt 读取同步、≤4KB;文件缺失 ⇒ `not_started`,存在但任一字段/派生不变量不合 ⇒ `invalid`,**不抛**(plan §2.5) | /health 已在同步读 tracker 快照;4KB 文件读不进事件循环预算问题 |
| `truth.ts validateLivenessManifest:1030-1173` | Phase A:`REQUIRED_LIVENESS_ROWS` 不变;`schema_version ∈ {2,3}`;W-4 存在时校验形状(`freshness` 四枚举、`run_status` 三枚举、`observation == "receipt_file"`);3 ⇒ W-4 必有。Phase B:REQUIRED 加 W-4、schema 必须 3 | 已核:validator 只遍历 REQUIRED 行,不拒绝额外 component ⇒ Phase A 旧 Bridge 不带 W-4 也合法 |
| probe `bridge-liveness-probe.sh` | 新函数 `w4_freshness_unhealthy_reason <body>`:键不存在且 schema ≤2 ⇒ 无(旧 Bridge);键存在但不过 plan §2 完整谓词 ⇒ 理由;`invalid` / `stale` / `run_status=degraded` ⇒ 理由;`not_started`:schema 2 静默、schema 3 立即「W-4 看者从未产出 receipt」(不用 Bridge uptime,plan §2);折进既有 `degraded` episode(`:265-288`),沿用 grace + 连续 3 次滞回 | `liveness_manifest_valid` 接受 `schema_version ∈ {1,2,3}`,**3 ⇒ 断言 W-4 存在且合法**(Phase A 先教 probe 认 3,Phase B Bridge 才发 3;plan §2.4) |
| 看者 | 登记 `bridge-liveness-probe-state`(§4) | 环的第三边 |

环:**看者**(launchd,每小时)看 probe 的 state.json 年龄 → **probe**(launchd,每分钟)看 Bridge /health 含 W-4 → **Bridge** 看看者的 last-run.json 年龄。三进程两域(看者与 probe 都在 gui launchd 域,Bridge 由 `com.flywheel.bridge` 拉起也在同域——「不同故障域」只做到进程级;机器级是 founder follow-up)。

## 7. 测试与 CI 登记点(仓内约定实核)

| 套件 | 形态 | 登记 |
|---|---|---|
| `scripts/__tests__/artifact-freshness-check.test.sh` | source-and-stub(抄 `bridge-liveness-probe.test.sh:28-45` + `test-lead-memory-arrival-check.test.sh:1-50` 的夹具仓法):seam `_af_now / _af_stat_mtime / _af_sqlite_query / _af_remote_head / _af_post`;夹具登记表 + 临时 git 仓(bare origin)+ 临时 sqlite | 必须写进 `.github/workflows/ci.yml` 的 bash 列表(`ci-shell-suite-enumeration.test.sh` 抓漏登);建议独立 step「FLY-2134 artifact freshness」,并在 `ci-structure.test.sh` 加与 FLY-2146 块(`:944-948`)同形的命令集断言 |
| `scripts/__tests__/artifact-freshness-manifest.test.sh` | 生产登记表 `--validate` 过;每个 `owner` 为 label 形态者在 `units.manifest` 第 1 列;`suspended` 行含 `FLY-\d+`;fail-closed 变体(坏 kind / 重复 id / 列数错 / `$HOME` 之外的展开)各被拒 | 同上 |
| 既有 `launchd-units-manifest.test.sh` / `-fail-closed` / `launchd-census*.test.sh` | 加了 plist + manifest 行后必须仍绿;`census` fixture 若枚举 copy 行需同步 | 已在 CI |
| `packages/teamlead/src/bridge/__tests__/liveness-manifest.test.ts` | W-4 四态;receipt 缺 ⇒ `not_started`、存在但坏 ⇒ `invalid`,均不抛;180 分钟阈值边界;state-root 五组输入与 shell 逐字相等 | vitest 已在 CI |
| `packages/config` truth 测试(`validateLivenessManifest` 现有用例文件) | 无 W-4 仍 ok;有 W-4 形状坏 ⇒ 报错 | vitest |
| `scripts/__tests__/bridge-liveness-probe.test.sh` | **manual-only**(`ci-shell-suite-manual-only.txt:20`,macOS/launchd 集成类),不在 required lane;只改其真 producer 交叉核对段。W-4 接收端的 CI 覆盖靠**新建** Linux-safe `bridge-liveness-probe-w4.test.sh`:无 W-4 + schema 2 不进 degraded;W-4 stale 连续 3 次一次页;schema 3 `not_started` 立即页(Bridge 反复重启也页);invalid / degraded / 逐字段非法 ⇒ 页;恢复清 | 新 suite 进 ci.yml(三条命令) |
| `scripts/__tests__/test-lead-memory-retire.test.sh` + `retire-units.sh` | allowlist 加第三个 label,usage / error / audit 措辞去 memory-only;第三 label 跑完整矩阵(preview / apply / resume / audit failure / identity drift / idempotent / enable authority) | 已在 CI |

**红线**:任何 suite 都不得真发 Discord、真动 launchd(`launchctl` 字面量在测试文件里也会撞 FLY-913 护栏,FLY-2146 的 suite 用 `--enable/--apply` 需 TTY 的方式规避)。

## 8. 交付、回滚、迁移

- **交付**(`docs/operations/launchd-units.md:8-52`):repo plist + `copy` 行 + allowed exits + 五套 FLY-1814 suite 绿 → 合并后由独立 updater 的 `update-flywheel.sh:272 converge_nonlead_daemons` 安装并 bootstrap。首轮真跑预期:`token-usage-daily-row` stale、`chezmoi-remote-head` stale、`runner-memory-remote-head` missing 各发一帖 enter;其余 fresh。QA 判据即这三帖 + `checks.tsv` 5 行 + `last-run.json` 存在 + `/health` 出现 `w4_artifact_freshness.freshness=fresh`。
- **回滚边界**:① 登记表删行 = 普通 PR;② 停看者 = **先**在 `copy` 行仍在时 `retire-units.sh --apply --i-am-operator <label>`(其 `retire_authority_present` 只接受 `copy` 行,`:33-40`),**后** PR 把行改 `hold`(顺序反了 apply 被拒);③ W-4:Bridge 回滚到不带 W-4 的版本时 probe 读到 `absent` ⇒ 静默,不页;probe 回滚而 Bridge 带 W-4 ⇒ 多一个键无人读,不页。两个方向都不会「回滚即告警」。
- **迁移**:无数据迁移;状态目录首跑创建;`notify-receipts.json` 半成品**不动**(不读、不删,留给 FLY-929 族)。
- **plist 变更不会被 converge 自动刷新**(FLY-2146 §7 教训):改 plist 要走四步(unload → 改 → manifest → bootstrap),plan 写清。

## 9. 边界校验与安全(Non-Negotiables 对照)

- 登记表是仓内受控输入,但解析仍 fail-closed(§2);路径只允许 `$HOME/` 前缀字符串替换,不 `eval`、不 `envsubst`。
- sqlite 只读打开(`-readonly -bail`);登记表只给 `<path>::<table>::<column>` 三段 identifier,SQL 由脚本拼固定模板(`-readonly` 挡不住 `writefile` / `load_extension`,前缀白名单方案已否决);单值单行。
- 远端命令全部经 `bounded-run.sh`(120s,超时 124 ⇒ undetermined);curl 发帖 `-fsS`、超时同。
- 密钥只从 `~/.flywheel/.env` 经 plist 的 `set -a; . …` 进环境;脚本不打印 token;台账不含 token 与 Lead 记忆内容,只有路径、sha、日期。
- 告警文案纯文本 ≤1900 字符;不含 Discord markdown 注入向量(用 `jq -cn --arg` 造 payload,同 arrival-check)。
- 所有状态写入原子(`lm_write_json_atomic` 0600 + mv),目录 0700,拒 symlink。

## 10. Lead 裁定与剩余假设

- Lead 已裁定(2026-09-08,ask `5025382b`):Q1 token-usage 行 `active`;Q2 runner-memory 行登记,建远端单由 Lead 开;Q3 直发;Q4 W-4 纳入(两阶段)。
- 假设 `sqlite3` 在 launchd PATH 可见(`/usr/bin/sqlite3`,已核);`python3` 同 arrival-check 前提;`jq` 同 probe 前提。
- 假设 `com.chezmoi.auto-sync` 的仓分支为 `main`(已核 `## main...origin/main`)。
