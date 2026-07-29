# FLY-1502 一次性切换 — QA 报告(三段式 QA 阶段)

Issue: FLY-1502
日期: 2026-07-29
基于: plan.md、runbook.md、Tadashi 的 QA 授权书(夜班)

## 结论

**FAIL — 不建议在本次窗口上电。**

两个缺陷都是**在真生产数据副本上跑出来的**,都落在切换窗口的关键路径上,
且都**静默**:守恒式平、`manual=0`、`conflicts=0`、Go/No-Go 报 GO。

| # | 缺陷 | 严重度 | 证据 |
|---|---|---|---|
| F1 | 活着的 Lead 被判「missing or terminal」,其未读业务消息被打进死信而非迁移 | **High(数据丢失,静默)** | 真机计数 + 回归测试(带阳性对照) |
| F2 | step 5 在 promote+marker 之后、ledger 记 done 之前崩溃 → 续跑永久 wedge(`no such table: meta`) | **High(窗口内不可自恢复)** | 真机 6 次进 step 5 / 4 次 failed / 永不 done + 回归测试 |
| F3 | step 5 的 NO-GO 报错只打守恒式,不打真正的阻塞原因(域 B) | Medium(可诊断性) | 真机:NO-GO 但 `balanced=true, manual=0, conflicts=0` |
| F4 | `migration-plan.json` 内嵌全量 `inputSnapshot`(含消息正文明文)→ 真语料 **140 MB**,步 7/8 各重新 JSON.parse 一次 | Medium(运维 + 数据暴露面) | 真机实测字节数 |
| F5 | `rehearse-v2-cutover.sh` 的 production-unchanged 闸在真 `~/.flywheel` 上跑不完,且步①时生产仍在活写,前后不可能字节一致 | Medium(步①闸形同虚设) | 真机 >20 分钟未跑完 |

硬门状态:Codex 跨家族 code review 对当前 head `37fd9b24` 已 **APPROVED**(09:56:33Z),
CI 9 项全绿,`pnpm lint` 干净,`pnpm -r build` 通过 —— **缺陷不是这些门能看见的类型**,
必须靠真数据预演才暴露。

---

## 一、测试环境与口径

- 分支 `flywheel-FLY-1502` @ `37fd9b24`,PR #724。
- 隔离预演入口:`scripts/__tests__/qa-fly1502-real-rehearsal.sh`(本 PR 新增)。
  用**真生产数据的副本**跑同一份 `flywheel-v2-cutover run`(同码路,非 stub):
  - 6 个真 comm.db(`~/.flywheel/comm.db`、`comm/flywheel`、`comm/geoforge3d`、
    `comm/tidal-echo`、`comm/growth`、`comm/test-slot-1`),经 `sqlite3 .backup` WAL-safe 复制;
  - 6 个真 Codex Lead `journal.db`;
  - 真 Claude Code Agent Team JSON 信箱树;
  - live-fire 用**真 `flywheel-comm` CLI** + 真 JSON 信箱重建,打冻结后的副本。
  - 隔离根放在 `/tmp`(短路径):macOS `sun_path` 上限 104 字节,v2 host 监听
    `<root>/host.sock`,长 TMPDIR 会直接 `listen EINVAL`。
- 真语料规模:域 A 未读 696 行,域 C `lead_inbox` 78,407 行。

## 二、F1 — 活着的 Lead 被当成已终结,未读业务消息进死信

### 现象

`readLegacySourceSnapshot` 只从 comm.db 的 `sessions` 表推导 agent 存续
(`migration.ts:970/975`,全仓仅此两处 `mergeAgent` 调用点),
`isLiveLead` 要求 `kind==='lead' && !terminal`。
**一个 Lead 只有在派过 Runner 之后才会出现在 `sessions.lead_id` 里** ——
没派过 Runner 的 Lead 在快照里根本不存在,于是走 rule 5 / rule 9 的
「missing or terminal」分支,`disposition='dead'`。

### 真机计数(扫全部 22 个含 `sessions` 表的生产 comm.db)

Bridge `/health` 当时报活的 Lead 共 16 个;迁移器能看见的只有 8 个 lead_id。

**Bridge 活着但迁移器完全看不见的 Lead(13 个)**:
`belle-lead`、`claude-infra-bot-lead`、`codex-infra-bot-lead`、`cos-lead`、
`flywheel-cos-lead`、`mufasa-lead`、`ops-lead`、`product-lead`、`rafiki-lead`、
`reflection-lead`、`sub-lead`、`tidal-echo-content-lead`、`tidal-echo-cos-lead`

**会被误打进死信的「未过期 + 业务类」行(16 行)**:

| 收件 Lead | 行数 | 来源 |
|---|---|---|
| sub-lead | 7 | `~/.flywheel/comm/tidal-echo/comm.db` |
| codex-infra-bot-lead | 3 | `~/.flywheel/comm/flywheel/comm.db` |
| mufasa-lead | 3 | `~/.flywheel/comm/growth/comm.db` |
| belle-lead | 3 | `~/.flywheel/comm/personal-assistant/comm.db` |

预演里那一跑的实际判决:**696 行未读全部 dead,0 行 migrate**
(630 条 reason=`business recipient is missing or terminal`,66 条是合法的过期)。

### 为什么现有的闸拦不住

`dead` 计入 `uniqueCanonical`,所以守恒式仍然 `balanced=true`;
`manual=0`、`conflicts=0`;Go/No-Go check 8 = pass;最终报告 = **GO**。
founder 会在「全绿」的界面上按下上电。

### 与设计的冲突

plan §4.4 分类表:
- rule 6 `messages | 未读 + business 类 + 收件人=存续 Lead → migrate-pending`
- rule 10 `lead_inbox | 未消费 + msg_class='model' + Lead 存续 → migrate-pending`
- rule 1 `无法归入下表 → manual`

**「没有证据」不等于「已终结」**。一个现在正在跑、且步 8b 还会被
`startCommands.leads` 重新拉起的 Lead,毫无疑问是「存续」。
即便实现方要保守,正确的兜底也是 rule 1 的 `manual`(触发 `manual=0` 闸,交 founder 裁),
而不是静默 `dead`。

manifest 里也**没有任何字段**可以声明存续 Lead 集合,所以运维层面无从绕开。

### 回归测试

`packages/v2-cutover/src/__tests__/qa-fly1502-findings.test.ts`
- **阳性对照**(通过):同一份数据加一行 running session → 两行都 `migrate`,证明尺子没坏。
- **缺陷用例**(当前失败):去掉 session 行 → `lead_inbox row ... classified "dead"`。

## 三、F2 — step 5 崩在 promote 之后 → 续跑永久 wedge

### 现象(真机复现序列)

预演脚本在 step 5 打了两次 SIGKILL:第一次在进入 step 5 的瞬间,
第二次在 migration plan 落盘之后。第三次平跑续跑:

```
flywheel-v2-cutover: no such table: meta
```

之后**再平跑三次,三次同样报错**。ledger:6 条 step-5 `started`、4 条 `failed`、
**一条 `done` 都没有**。切换在步 5 卡死,且此刻全部 Lead 已被步 3 停掉。

### 机制(磁盘状态实证,非推测)

第二次 SIGKILL 落在 `promoteStagingDatabase` 成功之后、`ledger.step(5,"done")` 之前:

```
flywheel-v2.db                                 704512 B  integrity=ok  mode=0600  21 tables
  meta: cutover_window_id / cutover_epoch / cutover_intent=frozen / rollback_state=clear
migration-complete.json                        已发布(带 migration_manifest_digest)
flywheel-v2.db.staging-fly1502-qa-real-rehearsal  4096 B  ← 空库,续跑时新建的
```

即:**step 5 的实际工作全部做完了**,只差 ledger 的那一行 append。
续跑时 `isStepDone(5)` 为 false → 重跑 step 5 →
`Kernel.open({ path: staging })` 打一个**已经不存在**的 staging 路径 →
SQLite **静默新建**一个空库(fail-open)→ `migrateLegacyPlan` 撞 `no such table: meta`。

`prepareStagingDatabase` 本身**已经建模了这个状态**(返回 `already_promoted`,
`database-lifecycle.ts:130-160`),但 **step 5 从不查它**。

### 与设计的冲突

plan §4.3:「checkpoint/rename/目录 fsync/marker 四个边界各定义 crash reconciliation
(重入判定属地)」;§6.2 要求「staging promote 四边界 crash reconciliation 各一例」。
**marker 边界之后、ledger 记账之前**这一段没有 reconciliation,而这正是最宽的一段。

### 回归测试

同文件,`step 5 re-entry across the promotion marker`:跑完 1-5 步后只删掉 ledger
末尾那一行 step-5 done(正是 SIGKILL 落在那个缝里留下的形态),再跑 step 5 →
当前抛 `SqliteError: no such table: meta`,与真机逐字一致。

## 四、F3 / F4 / F5(次级,不单独构成 FAIL,但建议同窗处理)

**F3 可诊断性**:step 5 的 NO-GO 只打 `plan.conservation`(`run.ts:764`)。
真机第一跑:`{rawCommUnread:696, ..., manual:0, conflicts:0, balanced:true}` —— 全是好数字,
真正的阻塞是 `domains.b = {deliveryObligations:7, receiptObligations:24, blockingManual:1}`,
一个字都没打出来。凌晨 3 点全 Lead 停机时,运维拿不到下一步动作。

**F4 计划文件体积 / 明文**:`migration-plan.json` 真语料 **139,924,740 字节**,
其中 `inputSnapshot` 占 141.6 MB(`decisions` 只有 2.7 MB)—— 因为它 `structuredClone`
了全部输入行,包括域 C 的 78,407 条 `lead_inbox`。副作用两条:
① 步 7 与步 8 各 `readObject` 一次,即在停机窗口里各做一次上百 MB 的 `JSON.parse`;
② 文件里是 **Discord / founder 消息正文明文**(已抽样确认),留在证据目录里给 founder 过目。

**F5 步①的 production-unchanged 闸**:`rehearse-v2-cutover.sh:52` 用
`find -s "$production_root" -exec stat {} \;`(每文件 fork 一次 `stat`)扫整棵
`~/.flywheel`。本机实测 **单次快照 >20 分钟仍未完成**,而一次预演要跑两次;
更要紧的是——步① 在步③「停全部旧写者」**之前**,此刻生产仍在活写
(Bridge、16 个 Lead、alert 队列、hot DB),前后快照**不可能**字节一致,
脚本会在 `diff` 处直接 `exit 1`。本次 QA 因此改用**归属法**做零变更证明:
对 manifest 能触及的每一条生产路径 + launchd/tmux 控制面前后比对,结果为空 diff(见下)。

## 五、通过的部分(照实记账)

- `pnpm -r build`:**通过**。
- `pnpm lint`:**干净**(exit 0,0 error,15 条既有 warning)。
  首跑 645 error 全部落在我自己 `pnpm install` 产生的 `.pnpm-store/` 与
  runner 的 `.flywheel/runs/` 里(两者都只在 `.git/info/exclude`,biome 不认),
  把这两个目录挪开后复跑即 exit 0 —— 属本地产物,非分支缺陷,CI 亦为绿。
- 各包测试:`v2-kernel` / `v2-cutover` / `v2-dag` / `v2-engine` / `v2-scheduler` 全绿;
  `v2-host`(11)与 `v2-cli`(11)首跑各有失败,根因是本 session 的 `TMPDIR` 位于
  `~/.flywheel/runner-state/<execId>/browser-tmp/`,叠上 `host.sock` 超过 macOS
  `sun_path` 104 字节 → `listen EINVAL`;`TMPDIR=/tmp` 复跑 **两套件全绿**。属环境,非分支缺陷。
- PR #724 CI:9 项全部 SUCCESS;`mergeable=MERGEABLE`。
- Codex 跨家族 code review:`codex_review_record` 对 head `37fd9b24` = `approved`
  (2026-07-29 09:56:33,`reviewer_family=claude`,`author_family=codex`)。
- **九步 ledger 本身是好的**:hash 链在两次 SIGKILL 前后完整;步 1-4 幂等 skip 正确;
  primitive 子账 intent→apply→verify→complete 四态齐全并带 preimage(实测 stop-legacy)。
- **step 5 之前的重入是安全的**:第一次 SIGKILL 后平跑续跑,1-4 步正确 skip、step 5 正确重入。
- **promote 本身是正确的**:被 promote 的库 `integrity_check=ok`、`0600`、21 张表、
  meta 齐全、`-wal`/`-shm` 已清、marker 带 manifest digest。
- **生产零变更**:对 manifest 能触及的全部生产路径(7 个 comm.db、全部 codex-lead
  journal.db、`~/.claude/teams` 下全部 mailbox、`~/.flywheel` 一级目录 mode、
  launchd label 集、tmux session 集)前后比对 = **空 diff**。

## 六、Go/No-Go 十条的证据产出情况

因 F2 在 step 5 wedge,**步 7/8 未能到达,十条证据未能完整产出**。
按 Tadashi 的口径「哪条产不出证据 = FAIL 那条」,本轮:

| 条 | 标题 | 本轮状态 |
|---|---|---|
| 1 | 旧 writer PID/tmux/daemon 全退出 | 证据已产(step-3 + check-1) |
| 2 | 旧 API token 与旧 capability 被拒 | 未达(需 8a held-start) |
| 3-7 | attempt 唯一 / effect_key / outcome 结算 / gate 绑 head / DB 权限完整性 | 未达(步 7) |
| 8 | 双源冻结 + canonical 迁移对账 + journal 清账 | **产出但语义错**(见 F1:migrated=0/dead=696 却判 pass) |
| 9 | 旧信箱只读归档 + fence 就位 | 未达(步 6 之后被 wedge 阻断) |
| 10 | 实弹测试 | 未达(步 7) |
| namespace / github | 不相交 / GitHub lane | 未达 |

修掉 F1+F2 后需要**重跑一遍完整九步**才能把十条证据补齐 —— 本轮拿不到。

## 七、复现方式

```bash
# 真数据隔离预演(会在 /tmp/qa1502 下建隔离根,只读生产)
TMPDIR=/tmp bash scripts/__tests__/qa-fly1502-real-rehearsal.sh

# 两个缺陷的最小回归用例(当前应 2 failed | 1 passed)
cd packages/v2-cutover && TMPDIR=/tmp npx vitest run src/__tests__/qa-fly1502-findings.test.ts
```

## 八、给实现方的建议(不代替设计决策)

- **F1**:让「存续 Lead」有一个不依赖 `sessions` 副产物的来源 —— 最直接的是让
  target manifest 显式声明本次窗口会被 `startCommands.leads` 拉起的 Lead 集合
  (它本来就是那份权威),`sessions` 只作补充证据;
  同时把「查无此人」的兜底从 `dead` 改成 `manual`,让 `manual=0` 闸真正兜住。
- **F2**:step 5 进入时先走 `prepareStagingDatabase` 的 `already_promoted` 判定
  (finalPath+marker 齐全 → 直接记 step 5 done);并且 staging 打开点改成
  open-existing-only,不许 `Kernel.open` 静默新建库。
- **F3**:NO-GO 报错带上 `domains.b` 与首个未清零项。
- **F4**:`inputSnapshot` 与 `decisions` 分文件,或计划文件只留 digest + 计数,
  原始行另存(步 7/8 不必再 parse 全量)。
- **F5**:production-unchanged 闸改成对 manifest 可触及路径集求值(本报告用的归属法),
  而不是全树 `stat` 且要求字节一致。

---

# 复验第 2 轮(2026-07-29,head 338a1308)

## 结论

**仍为 FAIL —— 但性质完全变了,且离可上电只差一步。**

F2 **已彻底修好**(真机证明)。F1 的**危险那一半也修好了**——不再静默丢消息。
但同一个根因的另一半浮出水面:整九步**仍然走不完**,卡在步 5 的 `manual=0` 硬闸。

| # | 上轮 | 本轮 |
|---|---|---|
| F1 | 活 Lead 未读业务消息**静默**进死信 | **已修**:活 Lead 的行现在真的迁移了(`migrated` 0→17),unknown 走 `manual` 失败关闭 |
| F1-b | (被 F1 掩盖) | **新暴露,High,阻塞**:Runner 存续判定仍建在错误证据源上 → 713 行里 **597 行(84%)判 manual** → `manual=0` 硬闸 → 步 5 NO-GO |
| F2 | promote 后崩 → 永久 wedge | **已修**,真机复现原场景不再 wedge |
| F3 | NO-GO 报错不打真因 | **已修**,现在打 `leadLiveness` + `domains.b` + `conservation` |

## 一、F2 已修 —— 真机证据

复验跑的是同一条路径、同一个杀点:

```
phase 2: resume, then SIGKILL once the migration plan is durable
[qa1502] second SIGKILL landed after the plan was durable, before step 5 completed
phase 3: plain re-run must resume and finish all nine steps   → 不再 no such table: meta
```

上一轮这个序列必然产出 `no such table: meta` 并永久 wedge(4 次平跑续跑全同);
本轮同一序列续跑正常推进。修法也正对根因:
`prepareStagingDatabase` 的 `already_promoted` 重入护栏 + `Kernel.open({fileMustExist:true})`
堵掉静默建空库那条 fail-open。

我冻结的回归用例 `step 5 re-entry across the promotion marker` 现已转绿。

## 二、我冻结的断言未被改动(逐字核对)

`git diff b2b2f3a4..HEAD -- packages/v2-cutover/src/__tests__/qa-fly1502-findings.test.ts`
唯一改动是 fixture 补一个类型必需字段 `authoritativeLiveLeadIds: []`,**断言一字未动**。
预演脚本 `fail "..."` 断言数 22 → 25(纯加性:curl / Bridge registry 可达 / registry 非空),
原有断言一条未删。三条用例(含阳性对照)现全绿。

## 三、F1-b(新,High,阻塞上电)—— Runner 存续仍建在错误证据源上

### 现象

真语料复验:

```
authoritativeLiveLeadIds : 16   (Bridge fleet registry 全部活 Lead,已正确接入)
conservation             : rawCommUnread=713  migrated=17  dead=99  manual=597  conflicts=0
unknownRecipientIds      : 61
```

`migrated=17` 证明 F1 主症状已解。但 **597 行(84%)判 `manual`**,
而 `manual=0` 是步 5 的硬前置 → **NO-GO,整九步走不完**。

### 根因

F1 修复给 **Lead** 接了权威来源(Bridge `/api/fleet/snapshot`),
但 **Runner** 的存续判定原封不动,仍只读每个 comm.db 自带的 `sessions` 表。
那 61 个 unknown 绝大多数是 Runner 的 exec UUID。

我做了两个证伪实验:

1. **不是我源集太窄**:把 61 个 id 拿去比对**全部 24 个**生产 comm 库的 sessions ——
   **0 个**能被解决。所以扩大 manifest 里的 comm 库清单没有用。
2. **权威登记表在别处**:61 个里 **48 个**在 `~/.flywheel/teamlead.db` 的 `sessions`
   表(1795 行)里查得到,状态全是 `completed` / `terminated` ——
   它们是**已结束的 Runner**,按 plan 4.4 rule 5 正确处置就是 `dead`。
   按行数算:加上这张表可解 **592/597**,只剩 **5 行 / 13 个 id**。

### 但 manifest 层面无解 —— 这条建议我自己证伪了

`teamlead.db` 确实带完整 comm schema(`messages` 0 行、`lead_inbox` 0 行、`sessions` 1795 行),
是个"零载荷、纯证据"的源,看起来正好可以塞进 `legacy.commDatabases`。
**我真的试了,当场崩**:

```
flywheel-v2-cutover: no such column: lead_id
```

原因:`readLegacySourceSnapshot` 固定发 `SELECT execution_id,lead_id,status FROM sessions`,
而 `teamlead.db.sessions` 的列是 `execution_id / status / session_role`,**没有 `lead_id`**。

所以**运维层面没有任何绕法**:comm 库全加进去解决不了(实验 1),
加权威登记表会直接崩(实验 2)。必须动代码。

### 还有一层:manual 行没有裁定通道

`manual=0` 是硬闸,但 cutover CLI 只有 `run` 和 `rollback-t1` 两个动词,
runbook 也只写"manual/conflict 必须为 0",**没有给运维任何记录人工裁定的入口**。
即便 F1-b 修完只剩 5 行 manual(其中 5 个 id 是被截断的畸形收件人:
`0fcbe0cd` / `30ea5bda` / `65e81f76` / `d7843ef6-0` / `flywheel-test-3`),
凌晨窗口里也**没有工具路径**把它们裁掉再往下走。

## 四、Go/No-Go 十条:仍未补齐

因步 5 NO-GO,九步停在第 5 步,证据只产出到步 1-4。
按「产不出证据 = FAIL 那条」的口径,十条本轮仍拿不全。**这是我判 FAIL 的直接依据。**

## 五、通过项(照实记)

- `pnpm -r build` 通过;`pnpm lint` exit 0。
- 7 个 v2 包测试全绿:v2-kernel / v2-cutover / v2-host / v2-cli / v2-dag / v2-engine / v2-scheduler。
- PR #724 CI **9/9 SUCCESS**,head `338a1308`,local = origin = PR 三方对齐,`mergeable`。
- 我的三条冻结用例全绿(含阳性对照)。
- 步 1-4 幂等重入、ledger hash 链跨两次 SIGKILL 完整、primitive 四态子账带 preimage。
- **生产零变更**:归属法核验 —— 7 个生产 comm 库、全部 codex-lead journal、
  `~/.claude/teams` 下全部 mailbox、`~/.flywheel` 一级目录 mode、launchd label 集、
  tmux session 集,前后**空 diff**。
- F3 已修:NO-GO 报错现在直接打出 `leadLiveness` 与 `domains.b`,
  本轮我就是靠它一眼定位到 597 manual 的成因 —— 这条修得很实用。

## 六、给实现方(不代替设计决策)

F1-b 的关键是:**Runner 和 Lead 一样需要一个不依赖 comm.db `sessions` 的权威存续来源**。
可选方向(权衡留给实现方):

- 让 manifest 也带一份权威 Runner 终态集合(与 `authoritativeLiveLeadIds` 同构,
  停机前从 StateStore 快照),unknown 仍走 manual;
- 或让 `readLegacySourceSnapshot` 的 sessions 读取容忍缺列
  (`lead_id` 可选),这样 `teamlead.db` 能作为纯证据源列入 `commDatabases`;
- 无论哪条,**都要给 manual 行一个可审计的人工裁定入口**,否则那 5 行畸形收件人
  会在凌晨窗口里把整个切换钉死。

---

# 复验第 3 轮(2026-07-29,产品码 head f3e70313)

## 结论

**PASS** —— 整九步在真生产数据副本上走通,Go/No-Go 十条(含 namespace/github 共 12 项)
证据逐条产出,生产零变更成立。

| 上两轮的判死项 | 本轮 |
|---|---|
| F1 活 Lead 静默进死信 | **已修**(R2 验讫) |
| F2 promote 后重入 wedge | **已修**(R2 验讫) |
| F1-b Runner 存续证据源错 | **已修**:unknown 61→14,manual 597→47,migrated 17→269 |
| manual 行无裁定通道 | **已补**:`adjudicate-manual` 动词可用,负例正确拒绝 |

## 一、九步 + 十条证据(核心交付)

```
phase 1: SIGKILL as soon as step 5 is entered      → 步 1-4 done,步 5 未 done
phase 2: SIGKILL once the migration plan is durable → 跨 plan/promote 边界重入
phase 3: 平跑续跑                                   → 停在 manual 闸(设计如此)
phase 3a: adjudicate-manual × 47                    → 放行
最终: 步 1-9 全部 done;ledger hash 链 235 行完整
```

Go/No-Go **12 项全部 pass 且证据文件可读**(上两轮只到第 1 条):

| 项 | 证据 |
|---|---|
| 1 旧 writer 全退出 | `check-1-writers.json` |
| 2 旧凭据被拒 | `check-2-credentials.json`(8a held-start 后真探) |
| 3 attempt 唯一 | `check-3-attempts.json` |
| 4 effect_key 契约 | `check-4-actions-key.json` |
| 5 outcome 已结算 | `check-5-actions-outcomes.json` |
| 6 gate 绑 exact head | `check-6-gates.json` |
| 7 DB 权限/完整性 | `check-7-database.json` |
| 8 双源对账 + journal 清账 | `migration-plan.json` |
| 9 归档 + fence 就位 | `archive-receipts.json` |
| 10 实弹测试 | `check-10-live-fire.json` |
| namespace 不相交 | `check-namespace.json` |
| github lane | `github-lane.json` |

守恒式在 **979 行真实未读**上平衡,`conflicts=0`。

## 二、F1-b 修复验收(Tadashi 指定重点一:597 批落点)

R2 时 597 行判 manual;本轮 **47 行**。差额去向经核验是**正确的**:

- `unknownRecipientIds` 61 → **14**;新增的 `runnerSessionDatabase`(StateStore
  `sessions`,1795 行)作为**独立字段**接入,而不是塞进 `commDatabases` ——
  这正好绕开我 R2 证伪的那条死路(该表无 `lead_id` 列会崩)。
- `migrated` 17 → **269**,`dead` 99 → **654**(已终结 Runner 按 rule 5 正确进死信)。

剩下 47 行 manual **不是缺陷,是正确的失败关闭**,两类:

- **42 行**:`business recipient is a live Runner, not a live Lead` ——
  收件人是**此刻仍在运行的 Runner**,其中就有本工单流水线自己
  (implement `265d4e1d` running、QA `f774ba4b` running、`65e81f76` awaiting_review、
  design `1a094764` design_done)。plan §4.4 rule 5 只覆盖**终态** Runner,
  活着的 Runner 既不是「存续 Lead」也不是「终态」,迁移器拒绝替它自动决定 —— 对的。
  **真窗口里不会有这一类**:plan §9 要求本 pipeline 自身 ship + park/completed
  之后才满足步② 前置。
- **5 行**:`business recipient liveness is unknown` —— 被截断的畸形收件人
  (`0fcbe0cd` / `30ea5bda` / `65e81f76` / `d7843ef6-0` / `flywheel-test-3`),
  结构上永远不可路由,只能人工裁。

## 三、manual 裁定通道验收(Tadashi 指定重点二)

`adjudicate-manual --target --source-kind --source-id --payload-digest --disposition --reason`

- **负例先行**(否则绿灯只证明动词会写 ledger,不证明它绑对了行):
  故意传错 payload-digest → **被拒**,报
  `manual adjudication payload digest mismatch for legacy-comm/comm/01e412a5-…`。
- 三种 disposition(`dead` / `tombstone` / `migrate`)各验一条,全部接受,
  每条都保留 `originalReason` 原文。
- 47 行全部裁定后步 5 放行,九步走完;**裁定记录落 append-only hash 链 ledger**
  (188 条 `manual-adjudication:` 记录,含跨轮次累积)。

## 四、关于 R6 MEDIUM advisory「manual-adjudication-not-founder-gated」的判断

Tadashi 问:凌晨窗口自主裁定 5 行畸形 id 是否可接受,还是必须挂 founder 门。

**我的判断:可接受,但建议补一处可见性,不建议加第三道 founder 门。**

理由(基于实读代码,不是感觉):

1. **裁定不能凭空造outcome**:disposition 只能是 `migrate|dead|tombstone`,
   都在设计自己的分类词表内;且必须精确匹配 payload digest(我用负例验过),
   `reason` 强制非空,`originalReason` 一并留档,全部进 hash 链 ledger —— 事后可审计。
2. **窗口本来就有两道 founder 门**(§4.2 步 7→8 的 held-start 授权与最终 GO),
   裁定发生在步 5,天然在这两道门**之前**。给 5 行机械裁定再加一道逐行 founder 门,
   凌晨窗口里的操作代价与收益不成比例。
3. **但有一处真空**:`go-no-go.ts` 里**没有任何 adjudication 字段**
   (我 grep 过,零命中)。裁定虽然进了 `migration-plan.json`(证据第 8 项),
   可那是个上百 MB 的文件(见 F4),founder 在最终 GO 那一刻从报告上
   **看不到「有 N 行被人工裁过」这个事实**。
   风险不在「运维能裁」,而在「运维裁了、founder 不知道」。

**建议**(留给实现方/Tadashi 定):把裁定条数(最好带清单)打进 Go/No-Go 报告,
让 founder 在**已有的**最终 GO 门上一次性追认。这样既不新增门,又堵住可见性真空。
真正危险的是对**可路由**收件人裁 `dead` —— 那正是 F1 的形态;有了计数,
founder 一眼能发现批量 `dead` 扫荡。

## 五、我这轮改了自己的 harness(照实交代,三处都是我的 bug 不是产品的)

前两轮从未走到步 7,所以这三处才第一次暴露:

1. **live-fire JSON 探针写错**:jq 单引号串里嵌 `'` 被吞,`require('fs')` 变成
   `require(fs)`。产品**正确拒绝**了它(`did not fail loud`)—— 以错误理由失败的
   writer 不能算被围栏挡住,这个判定是对的。已改为 `printf x >>` 探针。
2. **探针路径选错**:步 6 把整棵 legacy 树归档并留 0500 墓碑目录,
   原 mailbox 路径已不存在 → ENOENT,而 ENOENT 证明不了围栏。改为探测
   **墓碑根下的新建**(plan §4.5 的「ensure​FileExists 重建」),得到 `Permission denied`。
   (顺带确认:fail-loud 正则本轮已包含 `unable to open database file` /
   `SQLITE_CANTOPEN` 等,真 `flywheel-comm` writer 被挡时的原话能匹配。)
3. **sidecar 断言时点错**:我原来断言跑完后 `-wal/-shm` 不存在。
   `promoteStagingDatabase` 自己在 promote 边界就强制 WAL 已 drain 并 unlink
   (非空即抛);步 7/8/9 之后**合法重开**库,WAL 模式自然重建 sidecar。
   已改为断言真正承诺的东西:promote 证据 + WAL 已 drain(实测 0 字节)。
4. **清理未处理只读归档**:上一轮留下的 0500/0400 归档让 `rm -rf` 失败 ——
   那是围栏在起作用。已在清理前 `chmod -R u+rwX`。

## 六、生产零变更(方法修正)

步① 在步③停写者**之前**跑,生产此刻仍在活写,所以逐字节比对整棵树必然假红:
本轮首跑就抓到两处 —— macOS Spotlight 的 `com.apple.mdworker.*` 标签漂移,
以及 `teamlead.db` 涨了 52KB(Bridge 与全部 Lead 的心跳,**包括我自己这个 session**)。
两者都与预演无关。

改为比对「预演真写了才会变」的东西:
- flywheel 自有 launchd 标签集(滤掉 `com.apple.*` 系统噪音)+ tmux session 集;
- 全部生产源与 `~/.claude/teams` mailbox 的**权限位**(不比大小,大小会被活写搅动);
- `~/.flywheel` 一级目录 mode;
- **决定性信号**:cutover 的写入都是**创建**动作,所以在生产树下断言
  `.flywheel-v2-tombstone.json` / `*.staging-<window>` / `migration-complete.json` /
  `cutover-authority.json` / `cutover-armed.json` **一个都不出现**。
  预演真碰了生产,这些名字必然现身。

结果:**空 diff**。

## 七、通过项汇总

- `pnpm -r build` 通过;`pnpm lint` **exit 0**。
- 7 个 v2 包测试全绿:v2-kernel / v2-cutover / v2-host / v2-cli / v2-dag / v2-engine / v2-scheduler。
- 我冻结的三条回归用例(含阳性对照)**全绿**,断言逐字未被改动
  (`git diff bca5bf05..f3e70313` 对该文件为空)。
- 预演脚本 `fail` 断言数 25 → 25,**我的断言一条未删**(comm 逐条比对为空)。
- PR #724 CI 9/9 SUCCESS @ `f3e70313`,`mergeable`。
