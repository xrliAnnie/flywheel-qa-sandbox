# FLY-2134 监控者的监控 — 实施计划
Issue: FLY-2134 (https://linear.app/geoforge3d/issue/FLY-2134/infra观测-没有人监控这些监控者4-例自动机制静默失效-2-5-个月无一发出声音-其中全舰-12-个-lead-的-1043)
日期: 2026-09-08
基于: research.md

**Status**: **lead-accepted v4**(Codex R1 11 → R2 9 → R3 4 → R4 1 条全部处置;Lead leadAcceptance 2026-09-08,见 §10)

## 0. 一句话

新建一张「期望产出物」登记表和一个每小时跑的进程外看者 `artifact-freshness-check.sh`:对每行只看**产出物年龄**(文件 mtime / sqlite 指定表列的最大日期 / git 远端 head 与本地的祖先关系),四态判词 `fresh | stale | missing | undetermined`,按两本 episode 账(`incident`、`unobservable`)直发 `#flywheel-alerts`;Bridge `/health` 加 W-4 lane 读看者的 `last-run.json`(完整 fail-closed 校验),probe 把 W-4 异常折进既有 degraded episode,看者反过来登记 probe 的状态文件年龄 —— 看者 / probe / Bridge 三方成环。W-4 的「可选」只是两阶段 rollout 的 Phase A;Phase B 在同一 issue 内把它变成 schema 3 的必有行。

## 1. 范围

**做**:登记表 + 解析器(fail-closed)· 三种只读探针 · 看者主体(两本 episode 账、台账、receipt、锁、`--status`)· launchd plist + `units.manifest` 行 + 退役路径泛化 · Bridge W-4 lane(Phase A 可选 / Phase B 必有)+ receipt fail-closed reader + validator · probe W-4 理由折入 degraded + schema 3 接受 · CI 登记(含 Linux-safe 的 W-4 接收端 suite)· 运维文档节 · v1 登记 5 行(research §4)。

**不做**(exploration §7):不 enable 任何 disabled 单元;不修 chezmoi;不建 runner-memory 远端;不动 `notify-receipts.json`;不做每日正向摘要;不做第二台机器;不读任何机制的日志/退出码;**不新增任何 `FLYWHEEL_*` 环境变量**(R1 #8:阈值全部固定为常量,测试注入走 CLI flag 与 seam)。

**Lead 4 问**(ask `5025382b`,**2026-09-08 Lead 裁定:四条全按推荐**):Q1 token-usage 行 `active`;Q2 runner-memory 登记为 `git_remote_head` 行持续报 `missing`,**建远端的 follow-up 单由 Lead 开**(本单只留断言);Q3 直发 Discord + 自带 episode 账;Q4 W-4 纳入,Phase A 保持可选行、`REQUIRED_LIVENESS_ROWS` 不变(Phase B 见 §2.4,R1 #3 要求的收口)。

## 2. 稳定标识与显示标签(一处源:`scripts/artifact-freshness-check.sh` 顶部常量)

| 类别 | 值 |
|---|---|
| 看者脚本 | `scripts/artifact-freshness-check.sh`;在**任何锁之前、脚本初始化处**先做 source 前置检查(`HOME` 非空且为目录;`scripts/lead-memory/lib/sync-common.sh` 是普通非 symlink 文件;`LM_PID_LOCK_PATH` 为空、`LM_WRITER_LOCK_HELD` 非 1、`LM_WRITER_LOCK_PATH` 为空——库 source 时会无条件重置这些锁全局,R2 #6),再 `. sync-common.sh`(失败 ⇒ exit 6,零写);复用 `lm_bounded / lm_write_json_atomic / lm_append_tsv / lm_lock_acquire / lm_lock_release / lm_remote_head`;本脚本常量在 source **之后**赋值(R1 #9);`main` 在 `[[ "${BASH_SOURCE[0]}" == "$0" ]]` 下调用 |
| 用户可见前缀 | `artifact-freshness:`(stderr 日志与 Discord 文案首词) |
| 登记表 | `scripts/launchd/artifact-freshness.manifest`;7 列 TSV `artifact_id kind target max_age_h state owner note`;头部 `#` 注释;测试注入走 `--registry <path>` **CLI flag**(无 env 覆盖) |
| kind 枚举 | `file_mtime` · `sqlite_max` · `git_remote_head`(闭集,其它拒表) |
| verdict 枚举 | `fresh` · `stale` · `missing` · `undetermined`(闭集) |
| state 枚举 | `active` · `suspended`(`suspended` 的 note 必含 `FLY-[0-9]+`) |
| target 语法 | 路径**必须以字面 `$HOME/` 开头**(唯一允许的变量,做一次字符串替换;绝对路径、`~`、其它 `$VAR` 一律拒表;禁 `eval`);`file_mtime` / `git_remote_head` 为 `<path>`;`sqlite_max` 为 `<path>::<table>::<column>`,table/column 各匹配 `^[A-Za-z_][A-Za-z0-9_]{0,63}$`,由脚本自行拼 `SELECT max("<column>") FROM "<table>"`(双引号标识符,**登记表里没有 SQL**,R1 #2) |
| sqlite 执行 | `lm_bounded 120 sqlite3 -readonly -batch -noheader -bail "<path>" "<拼好的单句>"`;输出必须恰好一行一列 |
| launchd label | `com.flywheel.artifact-freshness-check`;plist `scripts/launchd/com.flywheel.artifact-freshness-check.plist`,`StartCalendarInterval {Minute:50}`(arrival-check :40 之后),`ProgramArguments` = `/bin/bash -c 'set -a; [ -f "$HOME/.flywheel/.env" ] && . "$HOME/.flywheel/.env"; set +a; exec /Users/xiaorongli/Dev/flywheel/scripts/artifact-freshness-check.sh'`,`EnvironmentVariables` 只有 `PATH`,`StandardOutPath/ErrorPath` 绝对字面量 `/tmp/flywheel-artifact-freshness-check.log` |
| `units.manifest` 行 | `com.flywheel.artifact-freshness-check	com.flywheel.artifact-freshness-check.plist	copy	0	artifact freshness observer; reports incidents independently` |
| 状态目录 | **一个语义,两侧逐字实现(R3 #1)**:取 `FLYWHEEL_STATE_DIR`,去掉首尾空白(空格/制表),trim 后为空 ⇒ `$HOME/.flywheel`,非空 ⇒ trim 后的值;再拼 `/state/artifact-freshness/`。TS:`(env.FLYWHEEL_STATE_DIR?.trim() \|\| join(homedir(), ".flywheel"))`(与 `plugin.ts:5294-5295` 同式);shell:纯 Bash helper `_af_state_root`(`${v#"${v%%[![:space:]]*}"}` / `${v%"${v##*[![:space:]]}"}` 双向 trim,**不用** `${VAR:-default}`,它不 trim)。跨语言合同测试(C3+C5)五组输入两侧路径逐字相等:unset / 空串 / 纯空白 / ` /tmp/x `(带边缘空白)/ `/tmp/x`。0700,拒 symlink |
| 状态文件 | `state.json`(schema 1,见 §2.2)· `checks.tsv`(固定表头 `schema=1	run_id	observed_at_utc	artifact_id	kind	verdict	observed_value	age_h	max_age_h	state	detail	post_status`)· `last-run.json`(schema 1,**整轮 commit marker**,字段见 §2.3)· `lock/`(mkdir+pid) |
| 常量(代码内,非 env) | `RENOTIFY_HOURS=24` · `UNDETERMINED_CONSECUTIVE=2` · `LM_REMOTE_TIMEOUT_SECONDS=120`(复用)· `RECEIPT_MAX_BYTES=4096` · `RECEIPT_FUTURE_SKEW_SECONDS=300` · TS `ARTIFACT_FRESHNESS_STALL_MS=180*60000`(probe 侧无 W-4 宽限常量,R2 #3) |
| 告警去向 | `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`;token env 名 `${FLYWHEEL_PROBE_BOT_TOKEN_ENV:-CODEX_INFRA_BOT_TOKEN}`;`FLYWHEEL_FOUNDER_DISCORD_USER_ID` 可选 @(三元组与 probe / arrival-check 逐字相同,均为既有变量) |
| 告警文案 | `artifact-freshness <artifact_id> <incident\|unobservable> <enter\|renotify\|recover>: verdict=<v> expected<=<max_age_h>h observed=<value\|none> age=<age_h\|n/a>h owner=<owner> detail=<detail>`;纯文本 ≤1900 字符;`jq -cn --arg` 造 payload |
| 退出码 | `0` 正常(含锁被占跳过)· `6` 预检失败 / source 失败 / 登记表拒绝(零发帖、零台账、**不写 last-run.json**)· `9` 状态校验或 IO 失败(**优先于 10**)· `10` 有发帖失败(台账与 receipt 已写,`post_status=failed`) |
| Bridge W-4 | `components.w4_artifact_freshness = { class:"W-4", wired:true, effective_enabled:true, switch:"required/no_switch", observation:"receipt_file", receipt_path, last_run_at, freshness, run_status }`;**完整 W-4 谓词(TS validator 与 probe jq 逐字段等价,R2 #1)**:`class=="W-4"` ∧ `wired==true` ∧ `effective_enabled==true` ∧ `switch=="required/no_switch"` ∧ `observation=="receipt_file"` ∧ `receipt_path` 非空字符串 ∧ `freshness ∈ {not_started, fresh, stale, invalid}` ∧ `run_status ∈ {ok, degraded, unknown}` ∧ 组合关系:`freshness ∈ {not_started, invalid} ⇒ run_status=="unknown" ∧ last_run_at==null`;`freshness ∈ {fresh, stale} ⇒ run_status ∈ {ok, degraded} ∧ last_run_at` 为严格 UTC 秒串。Phase A `schema_version` 2 + `REQUIRED_LIVENESS_ROWS` 不变;Phase B `schema_version` 3 + W-4 必有且过完整谓词(§2.4) |
| probe W-4 | `w4_freshness_unhealthy_reason`:键**不存在**且 schema ≤2 ⇒ 无(旧 Bridge);键存在但不过完整谓词(任一字段缺失/非法/组合非法)⇒ 「W-4 形状非法」;`invalid` ⇒ 「W-4 receipt 非法」;`stale` ⇒ 「W-4 看者上一轮完成过久」;`run_status==degraded` ⇒ 「W-4 看者上一轮有不可判定或投递失败」;`not_started`:schema 2 ⇒ **无**(Phase A rollout 期,靠 §6.1 第 3 条人眼;R2 #3——不再用 Bridge uptime 推宽限,重启可无限重置),schema 3 ⇒ **立即**「W-4 看者从未产出 receipt」(Phase A 已有 24h 前置证据);schema 3 且 W-4 缺失 ⇒ 「manifest 缺少 W-4」;全部折进 `degraded` episode(grace + 连续 3 次滞回不变) |
| 退役 | `scripts/lead-memory/retire-units.sh` 泛化为按 manifest 驱动的 allowlist(三个 label 常量),usage / error / audit kind / title 去掉 memory-only 措辞(R1 #7) |
| 时间 | 全 UTC;`age_h` 一位小数;mtime 在未来 ⇒ age=0、`detail=future_mtime`(仍 fresh,但台账可见) |

### 2.1 判词真值表(唯一真值表;C2 测试逐格覆盖)

| kind | fresh | stale | missing | undetermined |
|---|---|---|---|---|
| `file_mtime` | 普通文件、非零字节、`now-mtime ≤ max` | 普通文件、`now-mtime > max`,**或零字节** | 路径不存在 / symlink / 目录 / 非普通文件 | 存在但 `stat` 失败 |
| `sqlite_max` | 单值可解析为 `YYYY-MM-DD`(按 UTC 00:00)/ ISO-8601 / epoch 秒且 `age ≤ max` | 可解析且 `> max` | 文件不存在;查询返回空或 NULL(表在、无行) | `sqlite3` 非零退出(busy / 损坏 / 表或列不存在)、超时 124、输出非单行单列、输出非日期 |
| `git_remote_head` | ① 远端 sha == 本地 HEAD;② 或 `HEAD` 是远端的祖先(远端领先、本地无独有内容,`detail=remote_ahead`);③ 或远端是 `HEAD` 的祖先且最早本地独有提交 `%ct` 年龄 `≤ max`(`detail=local_ahead`) | 远端是 `HEAD` 祖先且最早本地独有提交年龄 `> max`;或**分叉**(互非祖先,`detail=diverged`)且最早本地独有提交(`remote..HEAD`)年龄 `> max` | `<path>/.git` 不存在;`git remote get-url origin` 失败(**无远端 = 假设不成立**) | `rev-parse HEAD` 失败;ls-remote 失败(网络/认证/124);远端 sha 不在本地对象库(`cat-file -e` 假,**不 fetch**);`merge-base --is-ancestor` 非 0/1 退出 |

分叉策略(R1 #5,显式选择):分叉时本地仍有未到远端的内容,新鲜度按「最早本地独有提交年龄」判,与 `local_ahead` 同尺,只在 `detail` 标 `diverged` 供人排查;不单列 incident 类别。所有 ancestry / `rev-list` / `log -1 --format=%ct` 调用经 `_af_git` seam 且 `lm_bounded`。

`suspended` 行:判词照算、照写台账,**不进不清任何账、不发帖**;`--status` 标 `suspended(<note>)`,判词 `fresh` 时额外标 `suspended-but-fresh`。

### 2.2 两本 episode 账(每个 active 行各一本 `incident` + 一本 `unobservable`;R1 #1)

`state.json` schema 1:`{"schema":1,"episodes":{"<artifact_id>":{"incident":{"active":bool,"lastNotifiedAt":int|null},"unobservable":{"active":bool,"lastNotifiedAt":int|null,"streak":int}}}}`。读取时**严格校验**(R1 #10 + R2 #5):顶层 object、`schema===1`、`episodes` object、每个 artifact 条目**恰有** `incident` 与 `unobservable` 两本账(缺一本 ⇒ 非法;整个 artifact 条目缺失才初始化空账)、每本账 `active` boolean、`lastNotifiedAt` null 或非负整数且 `≤ now + 300`、`streak` 非负整数;**语义不变量**:`active ⇔ lastNotifiedAt != null`;`unobservable.active ⇒ streak ≥ 2`;任一不符 ⇒ exit 9,原字节不变。

| 账 | 本轮判词 | 当前 active | 动作 | 记账 |
|---|---|---|---|---|
| incident | `stale` / `missing` | false | 发 `enter` | 成功 ⇒ `active=true, lastNotifiedAt=now`;失败 ⇒ 不变 |
| incident | `stale` / `missing` | true 且 `now-lastNotifiedAt ≥ 24h` | 发 `renotify` | 成功才更新;失败 ⇒ 原样 |
| incident | `fresh` | true | 发 `recover` | 成功才 `active=false, lastNotifiedAt=null` |
| incident | `undetermined` | 任意 | 无 | 不动(不清) |
| unobservable | `undetermined` | false | `streak+1`;`streak ≥ 2` ⇒ 发 `enter` | 成功 ⇒ `active=true, lastNotifiedAt=now`;**失败 ⇒ 递增后的 `streak` 仍持久化,`active=false, lastNotifiedAt=null`,下轮重试 enter** |
| unobservable | `undetermined` | true 且 `≥ 24h` | 发 `renotify` | 成功才更新;失败 ⇒ 三字段原样 |
| unobservable | 任何可判定判词 | true | 发 `recover` | 成功才 `active=false, lastNotifiedAt=null, streak=0`;失败 ⇒ `active/lastNotifiedAt/streak` 三字段原样,下轮再发 |
| unobservable | 任何可判定判词 | false | `streak=0` | — |
| 两本 | 行从登记表消失 | 任意 | 无(不发 recover) | 该 artifact 的两本账从 `state.json` 删除 |
| 两本 | 行改为 `suspended` | 任意 | 无 | 两本账 `active=false, lastNotifiedAt=null, streak=0`(静默收账) |

`unobservable` 单轮瞬态不页(streak=1);连续两轮页;它**不能**清 `incident`(只有 `fresh` 能)。

### 2.3 一轮的发布顺序、`last-run.json` 与崩溃窗口(R1 #10)

顺序:**sink 预检**(状态目录 0700 非 symlink;`state.json` / `checks.tsv` / `last-run.json` 若存在必须是普通非 symlink 文件;`checks.tsv` 若存在首行必须 == 固定表头;`state.json` 过 §2.2 严格校验——任一不符 ⇒ exit 9,**零探针、零发帖、三个文件字节不变**,R2 #7)→ 探针 → 计算 actions → 逐条发帖 → **原子写 `state.json`** → 逐行 `lm_append_tsv checks.tsv` → **原子写 `last-run.json`**。每行与 receipt 共用同一 `run_id`(格式 `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$`)。

`last-run.json` schema 1:`{"schema":1,"run_id","observed_at":"<UTC ISO 秒>","registry_sha256":"<64 hex>","rows":<int>,"counts":{"fresh","stale","missing","undetermined","suspended"}(非负整数,合计 == rows),"unobservable_active":<int>,"post_status":"none|success|failed","run_status":"ok|degraded"}`;`run_status=degraded` ⇔ `unobservable_active>0` 或 `post_status=failed`。全 fresh 也照写(心跳与告警解耦),但 receipt 只在整轮完成时写 —— 它是 commit marker。

| 崩溃/失败点 | 下一轮行为 | 披露 |
|---|---|---|
| 发帖成功后、写 state 前 | 该 action 重发一次(≤1 重复) | §7 |
| state 写成功后、checks 前 | 本轮无台账、无 receipt;账已记 ⇒ 不重发;W-4 继续读上一轮 receipt(可能 stale) | §7 |
| checks 第 k 行后失败 | 本轮部分行(同 run_id)、无 receipt;下一轮新 run_id;读者按 run_id 分组;exit 9 | §7 |
| last-run 写失败 | exit 9;W-4 最终 stale ⇒ 环出声(期望行为) | §7 |
| exit 9 与 10 同时成立 | 9 优先 | §2 |

### 2.4 W-4 两阶段合同(R1 #3;同一 issue,两个 PR,顺序不可反)

| 阶段 | Bridge | truth.ts validator | probe | 结束条件 |
|---|---|---|---|---|
| **Phase A**(C5/C6,本 PR) | `schema_version` 2;`components` 加 W-4(§2) | `REQUIRED_LIVENESS_ROWS` 不变;W-4 **存在时**校验完整形状与枚举;`schema_version ∈ {2,3}`,且 **3 ⇒ W-4 必有** | `liveness_manifest_valid` 接受 `schema_version ∈ {1,2,3}`;**3 ⇒ 断言 W-4 存在且形状合法**;reason 函数按 §2 | ① 主机部署后 `/health` W-4 `fresh/ok` 连续 24h;② **新 consumer 正/负对照**(R2 #4,旧 probe 无法通过):`source /Users/xiaorongli/Dev/flywheel/scripts/bridge-liveness-probe.sh`(主 checkout 实际文件)后喂合成 manifest `schema_version:3 + 完整 W-4` ⇒ `liveness_manifest_valid` 为 true,删掉 W-4 ⇒ false;记录主 checkout exact HEAD 与该脚本 sha256,并证明其 mtime 早于至少一个 60s probe 周期前(probe 状态文件 `lastOkTs` 晚于脚本 mtime);③ probe 状态文件无 degraded。三条齐 = C8 PR 可开的硬门槛 |
| **Phase B**(C8,第二个 PR) | `schema_version` 3 | `REQUIRED_LIVENESS_ROWS` 加 `w4_artifact_freshness`;`schema_version` 必须为 3 | 不变(已接受 3) | 合并 + 部署后 probe 无 degraded;**DoD 含 Phase B** |

为什么两个 PR:probe 脚本从主 checkout 即时生效、Bridge 是构建产物,两者跨部署边界;若同一 PR 让 Bridge 发 3 而旧 probe 只认 1/2,会在 updater 窗口内页 founder。Phase A 先教 probe 认 3,Phase B 再让 Bridge 发 3。Phase B 之后,W-4 消失 = manifest 非法 = degraded,形状 B 对 W-4 自身闭合。

### 2.5 W-4 receipt reader(Bridge 侧,fail-closed;R1 #4)

`readArtifactFreshnessReceipt(path, nowMs)` → `{freshness, run_status, last_run_at}`:
- 路径不存在 ⇒ `not_started / unknown / null`。
- 存在但任一不符 ⇒ **`invalid / unknown / null`**(不抛;R2 #2 逐字段):非普通文件或 symlink;`size > 4096`;JSON 解析失败或非 object;`schema !== 1`;`run_id` 不匹配 `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$`;`observed_at` 非严格 `YYYY-MM-DDTHH:MM:SSZ`、`Date.parse` 非有限、或 `toISOString().slice(0,19)+"Z"` round-trip 后不等于原串(拒非法日历日期);`observed_at > now + 300s`;`registry_sha256` 非 64 hex;`rows` 非非负 safe integer;`counts` 不恰好五键 `{fresh,stale,missing,undetermined,suspended}` 或任一非非负 safe integer 或合计 ≠ `rows`;`unobservable_active` 非非负 safe integer 或 `> rows`;`post_status ∉ {none,success,failed}`;`run_status ∉ {ok,degraded}`;**派生不变量**:`run_status` 必须等于 `(unobservable_active>0 || post_status==="failed") ? "degraded" : "ok"`,不等即 `invalid`(reader 不信任 receipt 里的派生值)。
- 合法 ⇒ `freshness = now - observed_at ≤ 180min ? fresh : stale`,`run_status` 照抄,`last_run_at = observed_at`。
- 任何读取异常在函数内 catch ⇒ `invalid`;provider 外层的 catch 不再是唯一防线。

## 3. 文件清单

| 动作 | 路径 |
|---|---|
| 新 | `scripts/artifact-freshness-check.sh` |
| 新 | `scripts/launchd/artifact-freshness.manifest`(含 5 行 v1 登记) |
| 新 | `scripts/launchd/com.flywheel.artifact-freshness-check.plist` |
| 改 | `scripts/launchd/units.manifest`(+1 行 `copy`) |
| 改 | `scripts/lead-memory/retire-units.sh`(allowlist 三 label;usage / error / audit 措辞泛化) |
| 改 | `scripts/bridge-liveness-probe.sh`(`liveness_manifest_valid` 接受 schema 3 且 3 ⇒ W-4 必有;+ `w4_freshness_unhealthy_reason`;degraded 折入) |
| 改 | `packages/teamlead/src/bridge/liveness-manifest.ts`(+ `readArtifactFreshnessReceipt`、W-4 builder、`ARTIFACT_FRESHNESS_STALL_MS` 常量、`artifactFreshnessStateDir(env)` helper) |
| 改 | `packages/teamlead/src/bridge/plugin.ts:5871`(传 `artifactFreshness: { receiptPath }`) |
| 改 | `packages/config/src/feature-flags/truth.ts`(`schema_version ∈ {2,3}`;W-4 存在时校验;3 ⇒ 必有;Phase B 改 REQUIRED) |
| 新 | `scripts/__tests__/artifact-freshness-check.test.sh` |
| 新 | `scripts/__tests__/artifact-freshness-manifest.test.sh` |
| 新 | `scripts/__tests__/bridge-liveness-probe-w4.test.sh`(**Linux-safe** 的 W-4 接收端 suite:只 source probe、只调 `liveness_manifest_valid` / `w4_freshness_unhealthy_reason` / `probe_once` 的 seam 版,不碰 launchd/Keychain;R1 #6) |
| 改 | `scripts/__tests__/bridge-liveness-probe.test.sh`(真 producer 交叉核对段 `:302-349` 用真 receipt 产出 W-4)、`test-lead-memory-retire.test.sh`(第三 label 全矩阵)、`launchd-census*.test.sh` fixture(如枚举 copy 行) |
| 改 | `packages/teamlead/src/bridge/__tests__/liveness-manifest.test.ts`(reader 全部拒绝分支 + W-4 四态 + `plugin.ts` wiring 静态断言:`rg` 到 `artifactFreshness:` 与 `artifactFreshnessStateDir(`)、`packages/config/src/__tests__/flag-truth.test.ts` |
| 改 | `.github/workflows/ci.yml`(新 step「Test — FLY-2134 artifact freshness」**三条** bash:manifest / check / probe-w4)、`scripts/__tests__/ci-structure.test.sh`(锁三条命令及顺序,与 FLY-2146 块 `:932-953` 同形)、`scripts/__tests__/ci-shell-suite-manual-only.txt`(不动:`bridge-liveness-probe.test.sh` 留 manual-only,新 w4 suite 进 required lane) |
| 改 | `docs/operations/launchd-units.md`(+「产出物新鲜度登记」一节:与 units.manifest 的分工、加行流程、suspended 语义、退役顺序) |
| 新 | `engineering/doc/FLY-2134-monitor-the-monitors/acceptance.md`(实施节点写,模板见 §6.2) |

## 4. Chunks(每个 chunk:先写测试 RED → 实现 GREEN → 提交;shell suite 用 source-and-stub,红线见 §5)

### C1 登记表解析器 + `--validate` + source 前置
- `_af_registry_load <path>`:跳过 `#` 与空行;7 列严格;`artifact_id` 正则与唯一;kind/state 闭集;`max_age_h` 数值 `(0, 8760]`;`target` 的 `$HOME/` 展开与「只此一种替换」;`sqlite_max` 的 `::` 三段拆分与 identifier 正则;`suspended` 必含 `FLY-[0-9]+`;任一失败 ⇒ `_AF_REGISTRY_ERROR`、返回 1。`--validate` 打印 `rows=<n> sha256=<x>`,exit 0/6。
- source 前置:`HOME` 非空目录、library 普通非 symlink、且三个锁全局都空闲(`LM_PID_LOCK_PATH` 为空、`LM_WRITER_LOCK_HELD` 非 1、`LM_WRITER_LOCK_PATH` 为空)才 `.`;失败 ⇒ exit 6。
- 测试 `artifact-freshness-manifest.test.sh`:生产表过;坏变体各被拒:坏 kind / 重复 id / 6 列 / 8 列 / `max_age_h=0` / `target=/etc/passwd`(缺字面 `$HOME/` 前缀的绝对路径)/ `target=$TMP/x`(非法变量)/ `~` 前缀 / `sqlite_max` 二段或四段 / table 含 `;` / column 含 `"` / column 为 `max(day)` / 含控制字符 / suspended 无单号;每个 label 形态 owner 在 `units.manifest` 第 1 列;`external:` / `none` 放行。缺 HOME、library 为 symlink、预持 PID 锁 ⇒ exit 6、零状态写;**预持 writer lock**(在临时 git 仓真 `lm_writer_lock_acquire` 后 source 看者)⇒ exit 6,且原 `LM_WRITER_LOCK_*` 变量未被覆盖、随后 `lm_writer_lock_release` 正常释放 FD。

### C2 三种探针(seam:`_af_now`、`_af_stat`、`_af_sqlite`、`_af_git`、`_af_remote_head`)
- 输出 `verdict\tobserved_value\tage_h\tdetail`,只读;sqlite 调用前脚本已拼好单句且 seam 记录实际参数。
- 测试:§2.1 每格一例 + 边界:零字节 stale;symlink / 目录 / FIFO missing;未来 mtime ⇒ fresh+`future_mtime`;`max_age_h=0.25` 两侧一秒;sqlite 三种日期格式;NULL ⇒ missing;表/列不存在 ⇒ undetermined;多行/多列输出 ⇒ undetermined;**seam 收到的整句必须严格等于模板 `SELECT max("<column>") FROM "<table>"`(只替换两个占位),并单独断言 table/column 原始值不含 `(` / `"` / `writefile` / `load_extension`**(R2 #8a);git:无 `.git` ⇒ missing;无 origin ⇒ missing;equal ⇒ fresh;HEAD 是远端祖先 ⇒ fresh+`remote_ahead`;远端是 HEAD 祖先 ⇒ 最早独有提交年龄两侧;分叉 ⇒ 按最早独有提交年龄 + `diverged`;远端 sha 不在对象库 ⇒ undetermined 且 fetch seam 零调用;ls-remote 失败 / 124 ⇒ undetermined;静态断言脚本文本不含 `git fetch`、`launchctl`、`chezmoi`、`.log`、`runs.tsv`。

### C3 看者主体 `af_main`
- 流程按 §2.3;`--status` 只读、不锁、不写、不发帖。
- 测试 `artifact-freshness-check.test.sh`(虚拟时钟 + 发帖 seam):incident enter 一次;24h 内不重提、≥24h 重提;fresh recover 并清;recover 失败不清;enter 失败不记时且下轮重发;**unobservable:单轮 undetermined 无帖且 streak=1;连续两轮页;第三轮 24h 内不重提;可判定后 recover 并 streak=0;undetermined 不清 incident;enter 失败 ⇒ streak 已递增持久化且 active=false/null、下轮重发;recover 失败 ⇒ active/lastNotifiedAt/streak 原样**;missing 走 incident;suspended 零发帖且台账 `state=suspended`;行删除 ⇒ 两本账消失、无帖;active→suspended 静默收账;登记表拒绝 ⇒ exit 6、无 last-run、零帖;`state.json` 坏(schema 2 / `active` 非 bool / `lastNotifiedAt` 未来 / `streak` 负 / **`active=true` 而 `lastNotifiedAt=null` / `unobservable.active=true` 而 `streak=1` / artifact 条目只有一本账**)⇒ exit 9 且字节不变、零探针、零帖;**checks 首行非表头 / 任一 sink 为 symlink ⇒ 预检即 exit 9,零帖,`state.json` 与旧 receipt 字节不变**;锁:活 pid 跳过 exit 0、死 pid 回收、SIGTERM 释放、`--status` 在锁被持有时成功且状态字节不变;**崩溃窗口注入**(seam 让 state 写 / 第 k 行 append / last-run 写各失败一次):按 §2.3 表逐行断言下一轮行为与 exit 9 优先于 10;`last-run.json` 的 `counts` 合计 == rows、`run_id` 与台账一致、`registry_sha256` == `--validate`;`post_status=failed` ⇒ `run_status=degraded`;台账只追加;文案 ≤1900 且不含 token(假 token 注入后 grep 零命中);全 fresh 零帖但 receipt 更新。

### C4 plist + `units.manifest` + 退役泛化 + CI 登记
- plist 按 §2;`units.manifest` +1 行;`retire-units.sh`:allowlist 三 label,措辞泛化,authority 状态机不变(仍要求 `copy` 行在);`ci.yml` 新 step 三条 bash;`ci-structure.test.sh` 锁三条;`ci-shell-suite-enumeration` 因新 suite 均登记而过。
- 测试:五套 FLY-1814 suite 绿;plist 断言(Label 一致、`StandardOutPath` 不含 `$HOME`/`~`、`EnvironmentVariables` 只有 `PATH`、Minute=50);`test-lead-memory-retire.test.sh` 对第三 label 跑**同一矩阵**(preview / apply / resume / audit failure / identity drift / idempotent / enable authority),并断言 usage/audit 文本不再含 memory-only 措辞;FLY-2146 两 label 的既有用例不变。

### C5 Bridge W-4(Phase A)
- `liveness-manifest.ts`:`readArtifactFreshnessReceipt`(§2.5)、`artifactFreshnessStateDir(env)`(trim || default)、`ARTIFACT_FRESHNESS_STALL_MS`;builder 新入参 `artifactFreshness?: { receiptPath: string }`,产出 §2 的 W-4 对象;`plugin.ts:5871` 传 `receiptPath = join(artifactFreshnessStateDir(process.env), "last-run.json")`。`truth.ts`:`schema_version ∈ {2,3}`;W-4 存在时按 **§2「完整 W-4 谓词」逐字段 + 组合关系**校验(不在此重复清单,以 §2 为唯一源);`schema_version===3` 且无 W-4 ⇒ 错误。
- 测试(vitest):reader 每个拒绝分支各一例(缺文件 ⇒ not_started;symlink / >4096 / 坏 JSON / schema 2 / 缺 `run_id` / `run_id` 格式错 / 时间格式错 / 非法日历日期 `2026-02-30` / 未来 >300s / hash 非 hex / `rows` 为字符串 / counts 四键 / counts 合计错 / `unobservable_active > rows` / status 非法 / **`post_status=failed` 而 `run_status=ok`** / **`unobservable_active>0` 而 `run_status=ok`** ⇒ invalid),不抛;合法 fresh/stale 边界;`run_status` 照抄;`artifactFreshnessStateDir` 对 unset / 空 / 空白 / 有值;builder 带 receipt 与不带 receipt 两种输出;validator:schema 2 无 W-4 ok;schema 2/3 有 W-4 时**逐字段删除或篡改**(`class` / `wired=false` / `effective_enabled=false` / `switch` / `observation` / `receipt_path=""` / `freshness` 非法 / `run_status` 非法 / `not_started`+`ok` / `fresh`+`unknown` / `fresh`+`last_run_at=null`)各一例 ⇒ 具体错误串;schema 3 无 W-4 ⇒ 错;既有 REQUIRED 用例不变;**wiring 静态断言**:`plugin.ts` 含 `artifactFreshness:` 与 `artifactFreshnessStateDir(`。

### C6 probe W-4(Phase A 接收端)
- `liveness_manifest_valid`:`schema_version ∈ {1,2,3}`;3 ⇒ W-4 存在且**过 §2 完整谓词**(逐字段 + 组合关系,与 truth.ts 等价;jq 谓词抽成一个函数 `w4_predicate` 供 validity 与 reason 两处复用)。`w4_freshness_unhealthy_reason <body>`(无宽限参数,R3 #2)按 §2;在 `probe_once` 的 degraded 理由链里 `w1_reason` 之后取,两者同在时 `; ` 拼接。
- 测试:新 `bridge-liveness-probe-w4.test.sh`(进 CI):无 W-4 + schema 2 ⇒ 不进 degraded;W-4 stale 第 1、2 轮无帖、第 3 轮一帖;schema 2 + `not_started` ⇒ 无(Phase A);**schema 3 + `not_started` ⇒ 帖,且 Bridge 每轮 uptime 都很小(模拟反复重启)仍在第 3 轮页**;`invalid` ⇒ 帖;`run_status=degraded` ⇒ 帖;键存在但任一字段缺失/非法/组合非法(逐字段各一例)⇒ 帖;schema 3 无 W-4 ⇒ manifest 不合法 ⇒ degraded;schema 3 有完整合法 W-4 ⇒ 合法;W-4 恢复 fresh ⇒ 既有 degraded 恢复路径清账。既有 `bridge-liveness-probe.test.sh` 的真 producer 段改为用真 `buildLivenessManifest` + 临时 receipt 产出 W-4 并喂 probe(仍 manual-only,不改分类)。

### C7 文档 + 收尾
- `docs/operations/launchd-units.md` 新节(含 §6 退役顺序);登记表头注释写「加一行 = 一次 PR:改表 + `--validate` + manifest suite」;`acceptance.md` 模板落地(§6.2)。

### C8 Phase B(第二个 PR,Phase A 结束条件满足后)
- Bridge `schema_version` 3;`truth.ts` `REQUIRED_LIVENESS_ROWS` 加 W-4、`schema_version` 必须 3;既有 vitest 与 `flag-truth.test.ts` 用例随之更新;probe 不改。
- 验收:部署后 probe 状态文件无 degraded episode 连续 24h;`/health` `schema_version==3`。

## 5. 负向护栏清单(测试覆盖)

1. 看者**不读**任何被观察机制的日志、`runs.tsv`、退出码、launchd 状态;静态断言脚本文本不含 `launchctl` / `chezmoi` / `git fetch` / `.log` / `runs.tsv`。
2. 登记表任一行不合法 ⇒ 整表拒绝,exit 6,零发帖、零台账、零 receipt。
3. 登记表**不含 SQL**;`sqlite_max` 只接受 identifier 三段;拼出的语句形态固定;`sqlite3 -readonly -bail`;多行/多列输出 ⇒ undetermined。
4. `target` 只做 `$HOME/` 前缀替换;含其它 `$` 或 `~` ⇒ 拒。
5. `undetermined` 不进不清 `incident`;连续 2 轮才进 `unobservable`;`suspended` 不发帖。
6. 发帖成功才记时;恢复帖成功才清账;`state.json` 形状或不变量不符 ⇒ exit 9 不覆盖;sink 预检(symlink / 表头)在任何探针与发帖**之前**,失败 ⇒ exit 9 零副作用;exit 9 优先于 10。
7. 所有远端/子命令经 `bounded-run.sh`(124 ⇒ undetermined);`--status` 永不写、永不发。
8. 状态文件原子写 0600、目录 0700、拒 symlink;台账只追加、固定表头、每行带 `run_id`;receipt 只在整轮完成时写。
9. 文案不含 token、不含 Lead 记忆内容。
10. Bridge reader 任何异常 ⇒ `invalid`,不抛,且不信任 receipt 的派生 `run_status`(重算比对);probe 对「键不存在 + schema ≤2」静默,对「键存在但不过完整谓词」一律 degraded;schema 3 缺 W-4 ⇒ 不合法;schema 3 `not_started` ⇒ 立即 unhealthy(无 uptime 宽限)。
11. 不新增 `FLYWHEEL_*` env;state root 解析 shell / TS 同式(跨语言合同测试:同一组 env 输入两侧路径字串相等)。
12. 任何测试不得真发 Discord、真动 launchd、真读生产状态目录、真改生产登记表(全部经 `--registry` / `FLYWHEEL_STATE_DIR` 临时目录 / seam)。

## 6. 迁移与回滚边界

- **无数据迁移**;状态目录首跑创建。`notify-receipts.json` 不读不删。
- **上线(Phase A)**:合并 → 独立 updater 的 `update-flywheel.sh:272 converge_nonlead_daemons` 按 `copy` 行原子安装 + bootstrap。首轮真跑预期 3 帖 incident enter(`token-usage-daily-row` stale ≈70 天、`chezmoi-remote-head` stale ≈176 天、`runner-memory-remote-head` missing),其余 2 行 fresh;`/health` 出现 W-4 `fresh/ok`。
- **回滚**(R1 #7,顺序固定):① 删登记行 = PR;② 停看者 = **先**在 `copy` 行与源 plist 仍在时由操作员 `retire-units.sh --apply --i-am-operator com.flywheel.artifact-freshness-check`(审计 + bootout + disabled override,convergence 不会复活),**后** PR 把行改 `hold`;顺序反了 apply 会在 mutation 前被 authority 检查拒绝;③ Bridge 回退到无 W-4 版本(Phase A 期间)⇒ probe 读 `absent` 静默;probe 回退而 Bridge 带 W-4 ⇒ 多一键无人读;Phase B 之后回退 Bridge 到 schema 2 版本 ⇒ 新 probe 仍接受 2,不页;④ plist 变更不被 converge 自动刷新:改 plist 走 retire → 改 → manifest → bootstrap。

### 6.1 Lead post-merge checklist(显式命令 + 判据)
1. `bash scripts/artifact-freshness-check.sh --validate` ⇒ `rows=5 sha256=<x>` exit 0。
2. `bash scripts/artifact-freshness-check.sh --status` ⇒ 5 行(2 stale + 1 missing + 2 fresh,以当日实况为准)。
3. 单元被 converge 安装后一小时内:`tail -6 ~/.flywheel/state/artifact-freshness/checks.tsv`、`cat …/last-run.json`(`run_status=ok`);`curl -s localhost:9876/health | jq '.liveness.components.w4_artifact_freshness | {freshness, run_status}'` ⇒ `fresh / ok`。
4. `#flywheel-alerts` 出现 3 条 `artifact-freshness … incident enter`。
5. Phase A 结束条件满足后开 Phase B PR。

### 6.2 QA 判据(acceptance.md 要贴的证据;R1 #11:全部 hermetic)
- 阶段一(合并前):C1–C7 全部 suite 绿 + CI exact head 绿;**隔离跑**:`FLYWHEEL_STATE_DIR=<tmp>`、source 脚本并覆盖 `_af_post` 记录到文件(或 unset 三元组,此时 `_af_post` 仍被调用、只是内部零网络),`--registry <生产表的临时副本>` 跑一轮 ⇒ `checks.tsv` 5 行、`last-run.json` 存在;**判据**:stub 返回 0 ⇒ `post_status=success`;stub 返回 1(或 unset 三元组)⇒ `_af_post` 调用恰 3 次、网络 seam 0 次、`post_status=failed`、`run_status=degraded`;`none` 只在零 action 时出现(R2 #8c);`--status` 输出截图;结束 `git status --short` 为空。
- 阶段二(部署后 24h 内):§6.1 前四条;probe 状态文件无 degraded;`checks.tsv` 每小时 +5 行;**阴性对照**:把生产登记表**复制**到临时文件、只改副本里 `bridge-liveness-probe-state` 的 `max_age_h=0.01`,以 `--registry <副本> --status` 只读运行看到 stale,记录副本 sha256,删副本,`git status --short` 为空。**不编辑生产权威文件。**

## 7. 诚实边界(照抄进 founder HTML)

- **看者与 probe 与 Bridge 在同一台机器、同一个 launchd 域**:环只做到「进程级不同故障域」;整机死或 launchd 域坏时三方同死。第二台机器是 FLY-2146 §7 记录的 founder follow-up。
- **「远端有」只证到 `ls-remote` + 祖先关系一层**:远端内容能否恢复、有没有被 force-push 覆盖,不在本单;分叉按「最早本地独有提交年龄」判,台账标 `diverged`。
- **检测延迟**:file/sqlite/git 最坏 `max_age_h + 1h`;持续不可判定最坏 2h+;看者自己死 ⇒ W-4 3h 变 stale + probe 3 分钟滞回 ⇒ ≈3h05m;probe 死 ⇒ 看者 15 分钟阈值 + 下一整点 ⇒ ≈1h15m。
- **崩溃窗口**(§2.3):发帖后写账前被杀 ⇒ 下轮至多重发一帖;写账后台账前被杀 ⇒ 本轮无台账无 receipt、不重发;台账中途失败 ⇒ 半轮同 run_id、无 receipt;receipt 写失败 ⇒ W-4 最终 stale。
- **W-4 在 Phase A 是可选行,且 schema 2 下 `not_started` 静默**:这期间「W-4 从未接上」与「看者从未产出 receipt」都只能靠 post-merge checklist 第 3 条人眼看到;Phase B(schema 3)合并后 `not_started` 立即由 probe 机器抓,不依赖 Bridge uptime。DoD 含 Phase B。
- **首轮三帖是预期阳性**,不是误报;本单只让它们出声,不修它们。
- **Discord 全挂时**看者与 probe 同时发不出;`run_status=degraded` 在 Discord 恢复后由 probe 补页。
- **`suspended` 是登记表里的显式状态**,改它要 PR;不会因单元被 enable 而自动变回 `active`。
- **不覆盖的机制**(research §4 末):daily-standup、quota-monitor 这类「日志新鲜 = 跑过」的对象故意不登记。
- Linear 评论本会话未读(MCP 401);若 issue 上有本文未见的裁定,以裁定为准写 `design-correction.md`。

## 8. 风险

| 风险 | 处置 |
|---|---|
| 首轮三帖被当噪音、24h 又来 | 文案带 owner 与 detail;Lead 若改裁 Q1 为 suspended,一行即静 |
| `ls-remote` 在 launchd 域无凭据 | 连续 2 轮 undetermined ⇒ `unobservable` 页,不再静默;FLY-2146 阶段一同一坑已踩过 |
| sqlite 被写者持锁 / 表结构改名 | busy 与表不存在都 ⇒ undetermined ⇒ 两轮后页 |
| 三方环互相报对方雪崩 | 每方有滞回(probe 3 次、看者 1h、W-4 3h);只报年龄与 run_status,不级联 |
| Phase A→B 之间 W-4 被删无人抓 | 结束条件 24h 内开 Phase B;DoD 含 Phase B |
| `.env` 三元组缺失 | `post_status=failed` ⇒ `run_status=degraded` ⇒ probe 页(与 R1 前「仍 fresh」相反) |
| 泛化 `retire-units.sh` 措辞动到 FLY-2146 suite | C4 同 PR 更新其断言;两 label 行为不变 |

## 9. 完成定义

- C1–C7 合并;CI exact head 绿;五套 FLY-1814 suite + FLY-2146 全部 suite + 新三 suite 绿。
- 生产 `--validate` 5 行;converge 装上单元;`/health` W-4 `fresh/ok`;`#flywheel-alerts` 三帖;`checks.tsv` 每小时 5 行连续 24h(阶段二)。
- **C8 Phase B 合并并部署,probe 24h 无 degraded**。
- `docs/operations/launchd-units.md` 有新节;acceptance.md 贴齐 §6.2。
- follow-up:**runner-memory 远端建仓单由 Lead 开**(Lead 裁定 2026-09-08,ask `5025382b`;登记行 note 单号未出前写 `pending-lead-issue`);chezmoi 推送修复另开单;D3b 逐条救回已有通道。

## 10. 评审记录

- R1(2026-09-08,Codex thread `01a0828a-be0f-7900-892f-243991ed3a28`,`/tmp/codex-rescue-design-feedback-flywheel-FLY-2134-plan-round1.md`):CHANGES REQUESTED,11 条(3 BLOCKER / 6 HIGH / 2 MEDIUM)。处置:
  - #1 BLOCKER undetermined 永不进账 → **接受**:新增 `unobservable` 账(连续 2 轮进入、24h 重提、可判定即恢复;不清 incident),`last-run.json` 加 `run_status`。
  - #2 BLOCKER raw SQL → **接受**:登记表改 `<path>::<table>::<column>`,脚本拼固定语句,`-bail`,反例测试。
  - #3 BLOCKER W-4 永久 optional → **接受**:两阶段合同 §2.4,Phase B 进 DoD。
  - #4 HIGH receipt 只验 schema → **接受**:§2.5 fail-closed reader,`invalid` 态,`run_status` 分离,发帖失败 ⇒ degraded。
  - #5 HIGH git 拓扑 → **部分接受**:补 `remote_ahead` / `local_ahead` / `diverged` 三格;分叉不单列 incident,按最早本地独有提交年龄判并标 detail(理由:分叉时本地仍有未到远端的内容,年龄是诚实的度量)。
  - #6 HIGH C6 不在 CI → **接受**:新 Linux-safe `bridge-liveness-probe-w4.test.sh` 进 required lane,ci-structure 锁三条,`plugin.ts` wiring 静态断言,真 producer 段带 W-4;文件名修正为 `ci-structure.test.sh`。
  - #7 HIGH 退役顺序 → **接受**:先 audited retire 后改 hold;`retire-units.sh` 措辞泛化 + 第三 label 全矩阵。
  - #8 HIGH 新 env knob → **接受(做减法)**:零新 env;阈值常量;`--registry` flag;state root helper trim||default + 跨语言合同测试。
  - #9 MEDIUM source 副作用 → **接受**:source 前置检查、锁前 source、失败 exit 6、三例测试。
  - #10 HIGH state 形状与多文件窗口 → **接受**:严格 shape 校验、表头核对、`run_id`、receipt 作 commit marker、崩溃窗口表与注入测试、9 优先 10。
  - #11 MEDIUM QA 触真边界 → **接受**:seam/unset 保证零网络;阴性对照用登记表副本 + `--registry`。

- R2(2026-09-08,同 thread,`/tmp/codex-rescue-design-feedback-flywheel-FLY-2134-plan-round2.md`):CHANGES REQUESTED,9 条(2 BLOCKER / 3 HIGH / 4 MEDIUM)。处置:
  - #1 BLOCKER W-4 只验键存在 → **接受**:§2 完整谓词(逐字段 + 组合关系),TS/jq 等价,逐字段篡改测试。
  - #2 BLOCKER reader 未验全字段/未重算 run_status → **接受**:§2.5 逐字段 + round-trip 时间 + 派生不变量重算。
  - #3 HIGH not_started 宽限可被 Bridge 重启重置 → **接受(方案一)**:schema 2 静默、schema 3 立即 unhealthy;删 `W4_BOOT_GRACE_SEC`。
  - #4 HIGH Phase A 结束条件证不了新 consumer → **接受**:§2.4 正/负对照 + 脚本 sha + cadence 证据为 C8 硬门槛。
  - #5 HIGH 双账不变量与失败转移 → **接受**:§2.2 不变量、两本账各自的失败转移、三种语义非法 state 测试。
  - #6 MEDIUM source guard 漏 writer lock → **接受**:三个锁全局都查,真 writer lock 测试。
  - #7 MEDIUM 坏表头检查太晚 → **接受**:sink 预检前移到探针之前,零副作用。
  - #8 MEDIUM 三处测试文字互斥 → **接受**:SQL 模板整句相等 + 原始值断言;`$HOME/` 字面前缀唯一语法;QA post_status 判据改写。
  - #9 MEDIUM research.md 旧合同 → **接受**:research §6–§8 同步(invalid、CI 分类、退役顺序与矩阵)。

- R3(2026-09-08,同 thread,`/tmp/codex-rescue-design-feedback-flywheel-FLY-2134-plan-round3.md`):CHANGES REQUESTED,4 条(0 BLOCKER / 1 HIGH / 3 MEDIUM),全为文档一致性。处置:
  - #1 HIGH shell/TS state-root 不等价 → **接受**:统一为 trim-then-default,shell 用纯 Bash 双向 trim helper,五组输入跨语言测试。
  - #2 MEDIUM C1/C5/C6 实现行残留旧指令 → **接受**:C1 三锁、C5 引用 §2 谓词、W-4 四态、reason 签名去 grace。
  - #3 MEDIUM research §6–§9 残留 → **接受**:probe 行 schema-aware、reader 四态、§9 固定三段 target、§10 记录 Lead 裁定。
  - #4 MEDIUM §6.2 零调用 vs 三次调用矛盾 → **接受**:统一为 `_af_post` 3 次、网络 0 次。
  - 三轮未 APPROVED ⇒ 按 Lead 既有规则上报,由 Lead 裁定开确认轮或 leadAcceptance。

- R4 确认轮(2026-09-08,同 thread,`codex-review-round4.md`;Lead ask `8d027341` 准开,范围限 R3 四条):CHANGES REQUESTED,**1 条 MEDIUM**——research.md 两处旧措辞(状态目录行 `${VAR:-default}`、§10 标题「Lead 未答」),plan.md 四项确认全部解决。两处已修(commit `26cbe0a3a`),plan.md 未动。
- **Lead 裁定记录**:ask `65441362-d9da-4a6d-abee-ae992c12a8ba`,flywheel-eng-lead 2026-09-08 **leadAcceptance:接受**。依据:R4 仅剩 1 条 MEDIUM 且是 research.md 措辞(非 plan),plan.md 四项 Codex 确认全部解决,措辞已修提交。按 FLY-2382 规则不开 R5。
- 修订轨迹:v1(2e6c976d7)→ v2(6481dd1e4,R1)→ v3(0fb879a6a,R2)→ v4(9510ee734,R3)→ research 残留修正(26cbe0a3a,R4)→ 本次 §10/§11 收口。

## 11. Residue

- Codex R4 的 1 条 MEDIUM 已在 research.md 修掉;plan 无未吸收条目。
- follow-up(Lead 开单):runner-memory 远端建仓;chezmoi 推送修复;Phase B(C8)作为本 issue 第二个 PR,前置条件见 §2.4。
- 实施节点注意:R1–R4 的全部负向用例已写进 C1–C6 测试段,实现时以 §2 / §2.1–§2.5 为唯一源,不要回读 research 的早期段落。
