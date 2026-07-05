# FLY-727 ⑤ 重设计 — deployment_events 事件账本（替代 git-ancestry）— 设计底档 v3（Codex APPROVED）

Issue: FLY-727 (https://linear.app/geoforge3d/issue/FLY-727/founder-ux-daily-digest-每天一条今天谁完成了啥fleet-wide-完成汇总)
日期: 2026-07-01
基于: plan.md（R4 Codex-approved 的 digest 骨架保留）+ Annie ⑤ redirect + Codex design review R1

---

## 修订
- **v3.2（Annie 扩全跨项目化 —— 每个项目都有 digest + 新项目自动接入）**:§2.7 新增。① 新项目
  自动接入 —— `setup-new-project.sh` 每建新项目就自带 ready 的 `.flywheel/hooks/report-deployment.sh`
  上报 hook（项目名写死、best-effort、经 FLYWHEEL_DIR 找 CLI）+ cutover checklist 第 10 步接线;digest
  侧零 per-project 配置（按 deployment_events 的 project 分组）。② 存量项目 onboarding 一句话文档化。
  ③ 别 repo 具体接线 = 各 Lead 独立任务（不在本 PR）。test-setup-new-project +4 断言。
- **v3.1（QA FLY-739 fix — 真机 E2E 抓出 write-side 生产接线缺口）**:独立 auto-QA 在 pinned head 上跑真 updater
  env 发现:launchd `com.flywheel.updater` 只带 PATH、`~/.flywheel/.env` 无 `FLYWHEEL_BRIDGE_URL/BRIDGE_URL`、
  `restart-services.sh` 设 `BRIDGE_URL` 但从不 export → `report-deployed` 拿不到 bridge url → **exit 2(不 POST 也不 spool)**。
  单测总注入 url 故漏掉这条真生产路径。两个后果:① **回归**(v3 的「report 失败留 marker + block/alert」把这个 env 缺口
  变成每次 self-ship 部署都 block marker + severe_alert Annie,**不受 digest 频道 gate、违反 AC5「default-off 零生产变更」**);
  ② `record_deployed_range` 的 exit 2 被 `|| true` 吞 → flywheel deployment 事件永不落 → 即使开频道也「今日无上线」。
  **修**(3 处、最小):① `report-deployed` **默认 bridge url = `http://localhost:9876`**(Bridge 恒本机;显式 env 仍优先;
  连本机 Bridge 都连不上则 spool)—— 根除 exit-2;② `update-flywheel.sh`:deployment-event report 降为**纯 best-effort
  副作用**,satisfied marker **无条件 ack**(report 失败只 log、绝不 block/alert)—— 消回归、复 AC5;③ `restart-services.sh`
  显式把 url 传给 report-deployed 子进程。新增回归测试:report-deployed 无 url 默认本机(+ 空串当未设 + 显式 url 优先 +
  无 url·Bridge down 仍 spool 返 1);update-flywheel-queue T7/T7b(satisfied marker 在 report 非 durable 时仍 ack、不 block)。
- **v3（Codex design review R2 后）**:采纳 6 点 —— ① **ack 顺序持久化**(split ack:`ssq_is_satisfied` 查不删 →
  read marker → report-deployed **durable(HTTP inserted 或 spool 落盘)** → 才 `ssq_delete_ack`;report 失败留
  marker+backoff);② `/api/deployments/report` **强制 auth**(无 token → 503,不继承 /api/runs 的 tokenless);
  ③ 加 `source_event_id`,ingestion 须至少一个 {merge_sha,deployed_sha,deploy_batch_id,source_event_id},
  dedup 从 event 身份算(非 source 文本);④ **markerless fallback 强制**(每个 markerless deployed-sha advance,
  source=fallback-git-log inferred);⑤ marker schema 版本化(新 marker 要 issueIdentifier,旧 marker 仍可部署、
  报 PR-only/inferred、不隔离);⑥ enrichment v1 只按 (project,issue)→(project,pr)(sessions 无 merge_sha)。
- **v2（Codex design review R1 后）**:Codex 确认「deployment_events 事件账本是最优总体方向、无更好替代」,
  但提出机制加固(全部采纳):① **Bridge-owned ingestion**(`POST /api/deployments/report`)替代 CLI 直写
  StateStore;② **self-ship marker/ack 源**替代 commit-subject regex;③ schema dedup/审计列加固;
  ④ digest 以 deployment_events 为 primary、sessions 仅 enrichment;⑤ **at-least-once**(spool+drain)不静默丢;
  ⑥ 跨项目 transport 契约明确;⑦ 测试覆盖并发/幂等/Bridge-down/ack-once/无-session 行。

## 0. 为什么（Annie redirect + Codex 验证）
原 ⑤ git-ancestry + mtime + live_unverified 太启发式。Annie 换 **部署事件账本**:干净时间线/简单/全项目复用/
便宜索引查询/不累积/不用 Linear API。Codex R1 验证:这是**正确总体方向**,但把「CLI 直写 StateStore + commit
regex」换成「Bridge 端点 + marker/ack」更 sound。digest 其余(DigestService/HTML/publish-report/dashboard 频道/
00:35/default-off)保留。

## 1. 目标（complete-deliverable,一个 PR,不 phase-split）
表 + Bridge ingestion 端点 + `report-deployed` CLI(薄 HTTP client)+ flywheel self-ship 写端(marker/ack)+
digest 读 —— 完整可用。各项目 hook = 各自接入、明列 727 issue、不 defer。

---

## 2. 设计（v3）

### 2.1 `deployment_events` 表（StateStore / teamlead.db，Bridge 拥有写）
```sql
CREATE TABLE IF NOT EXISTS deployment_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_name      TEXT NOT NULL,
  issue_identifier  TEXT,                 -- 归一化大写(nullable)
  pr_number         INTEGER,              -- nullable
  merge_sha         TEXT,                 -- 该 issue 的 merge/target commit(代码部署强烈建议;归一化小写)
  deployed_sha      TEXT,                 -- 上线时的 live head(分组用)
  deploy_batch_id   TEXT,                 -- 同一次 deploy 的多行分组
  environment       TEXT NOT NULL DEFAULT 'production',
  source            TEXT NOT NULL,        -- 'self-ship' | 'manual' | 'vercel' | 'fallback-git-log' | ...
  source_event_id   TEXT,                 -- 【R2#3】source 侧 event 身份(Vercel deploy id/url;内容 publication id;manual --source-event-id)
  deployed_at       TEXT NOT NULL,        -- UTC,上线时间(digest 按它查)
  recorded_at       TEXT NOT NULL DEFAULT (datetime('now')),  -- 写入时间(backfill/延迟上报可 ≠ deployed_at)
  metadata_json     TEXT,                 -- 原始 subject / marker path / deploy URL / CI run id / range 等
  dedup_key         TEXT NOT NULL         -- 确定性非空(见下),幂等
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deployment_events_dedup ON deployment_events(dedup_key);
CREATE INDEX IF NOT EXISTS idx_deployment_events_time ON deployment_events(deployed_at);
CREATE INDEX IF NOT EXISTS idx_deployment_events_proj_time ON deployment_events(project_name, deployed_at);
CREATE INDEX IF NOT EXISTS idx_deployment_events_issue ON deployment_events(project_name, issue_identifier);
```
- **【R2#3】ingestion 校验**:project + source 必填;issue 或 pr 至少一个;且 **{merge_sha, deployed_sha,
  deploy_batch_id, source_event_id} 至少一个非空**(否则拒:无 event 身份的重复部署会被 dedup 合并)。
- **【R1#3 + R2#3】dedup_key 从 event 身份算,非 source 文本**(避开 SQLite NULL-distinct):
  `dedup_key = project|COALESCE(issue,'')|COALESCE(pr,'')|<eventIdentity>|environment`,
  其中 `eventIdentity = COALESCE(merge_sha, source_event_id, deploy_batch_id, deployed_sha)`(必非空,见上校验)。
  Bridge 写入前计算(归一化:issue 大写、sha 小写)→ `INSERT OR IGNORE`。
- **【R1#4】审计列**:merge_sha(per-issue proof)、deploy_batch_id(分组)、environment、recorded_at、metadata_json、source_event_id。

### 2.2 Bridge ingestion 端点（**Bridge 拥有 StateStore 写边界**,R1#1）
- 新 `packages/teamlead/src/bridge/deployments-route.ts`:`POST /api/deployments/report`
  body: `{ projectName, issueIdentifier?, prNumber?, mergeSha?, deployedSha?, deployBatchId?, sourceEventId?,
  environment?, source, deployedAt? }`(校验见 2.1)。**【R3#3】`deployedAt` 可省 → Bridge 默认取当前 UTC**
  (schema `deployed_at NOT NULL`,Bridge 补默认),`recorded_at` 另记写入时间。校验 + 计算 dedup_key + StateStore.insertDeploymentEvent。
  **【R2#2】强制 auth**:`TEAMLEAD_API_TOKEN` 未设 → 挂 503 route(**不**继承 /api/runs 的 tokenless fallback);
  精确 mirror `/api/reports`(它无 token 即 503)。理由:这是 digest「今天上线」的真相源 + 含远程 Vercel webhook 入口,
  tokenless 会让任何能连 Bridge 的调用方伪造 shipped 行。
- StateStore 新增 `insertDeploymentEvent(row)`(幂等)+ `getDeploymentEventsInRange(sinceUtc, untilUtc)`(只读)。

### 2.3 `flywheel-comm report-deployed` CLI（**薄 HTTP client**,mirror complete/stage,R1#1/#6）
```
flywheel-comm report-deployed --project X (--issue FLY-N | --pr N) [--merge-sha SHA] [--deployed-sha SHA]
                              [--deploy-batch-id ID] [--source-event-id ID] [--environment production]
                              [--source self-ship] [--deployed-at UTC] [--metadata-json JSON]
```
**【R3#1】每个 caller 须给至少一个身份字段**:`--merge-sha` / `--deployed-sha` / `--deploy-batch-id` /
`--source-event-id`(否则 Bridge 拒,见 2.1 校验)。webhook 类(Vercel)无 git SHA → 用 `--source-event-id`(deploy id/url)。
- POST 到 `{FLYWHEEL_BRIDGE_URL}/api/deployments/report`,Bearer `TEAMLEAD_API_TOKEN`(同 publish-report)。
- **【R1#6 at-least-once】**Bridge down / 非 2xx → **spool** 一条 JSON 到 `~/.flywheel/deployment-events-pending.d/`
  (原子 rename),**非 `|| true` 静默丢**。Bridge 启动时 + 定期 drain(loopback POST,dedup 幂等,成功删)。
- **不**直写 StateStore(无 CLI-write 先例 + flywheel-comm 不依赖 teamlead 的包边界,R1#1)。

### 2.4 flywheel self-ship 写端（**marker/ack 源**,非 regex,R1#2）
self-ship 已有更强本地真相:marker 存 canonical `targetSha`(squash merge SHA)+ `prNumber`(`ssq_enqueue`),
`update-flywheel.sh process_due_markers()` 现在 `ssq_try_ack` 成功(targetSha ancestor-of deployed-sha)时**即删
marker**。接入(**【R2#1】split ack 顺序保 at-least-once**):
- **拆 ack**:`ssq_is_satisfied(marker, deployed, repo)`(查 ancestor,**不删**)取代「查即删」;新增 `ssq_delete_ack(marker)`。
- **顺序**:deploy → 每 marker:`ssq_is_satisfied`? → **读 marker 字段(文件还在)** → `report-deployed`
  (durable = HTTP inserted **或** spool 落盘)→ **成功才** `ssq_delete_ack`。report 不能 post 也不能 spool →
  **留 marker + classify/backoff**(下轮重试),绝不先删。
- **扩 marker schema(版本化,R2#5)**:新 marker 加 `issueIdentifier`(handoff enqueue 时写,spin/self-ship 知 issue)
  + `schemaVersion`。**旧 pending marker 仍可部署**:无 issueIdentifier → 报 PR-only event(或本机 StateStore/PR
  查补)、或 inferred metadata;**不因缺新字段隔离旧 ship marker**。
- **event 身份**:self-ship 的 `eventIdentity = merge_sha(=targetSha)`(每 merge 唯一)→ dedup 天然 exactly-once。
- **【R2#4 markerless fallback = 强制**,非可选**】**:**每个** markerless `deployed-sha` advance(restart-services.sh
  456/470 fast-advance + main verified path;update-flywheel.sh 日历/手动 fallback deploy)→ 必跑
  **`git log --format='%H%x00%s' OLD..NEW`**(本机、无网络、确定性):每个 commit 用 **commit hash 作 `--merge-sha`**
  (eventIdentity),subject 抽 issue/PR,`report-deployed --source fallback-git-log --merge-sha <hash>
  --deployed-sha NEW --deploy-batch-id <id>` + metadata 存 subject,**标 inferred**。
  **【R3#2】dedup 确定性**:fallback 的 merge_sha = commit hash;marker event 的 merge_sha = marker.targetSha
  (= squash merge commit hash)→ **同一 commit 两条自然同 eventIdentity → dedup 合并**(fallback 不产重复行)。

### 2.5 digest 读模型（**deployment_events primary,sessions enrichment**,R1#5）
- **主查询**:`getDeploymentEventsInRange(<PTday起UTC>, <PTday止UTC>)`(索引、便宜)。按 project 分组,
  每行 = 一个上线的 issue/PR。ship-state = 在表里(当天)= `🚀 已上线`(确定信号,删 git-ancestry/mtime/live_unverified)。
- **enrichment(v1,R2#6)**:每行按 `(project, issue_identifier)` → `(project, pr_number)` join `sessions` 拿
  title/summary(**不按 merge_sha** —— sessions 无此列,merge SHA 只在 stage_changed payload,`event-route.ts:1545`
  明确不入 Session 列;要 merge-sha enrichment = follow-up 加索引列/扫 session_events)。
  **无匹配 session 仍渲染**(project + issue/PR/sha + source + "摘要暂缺",R1#5)。
- **次要 footer(可选,待 Annie/Lead 定)**:`session_completed` 当天但**不在** deployment_events 的
  「merged 待部署 / 进行中」计数 —— 一眼看全用,**不计入 shipped 主数**。
- 删除:deploy-state.ts(git-ancestry)、DigestService 的 mergeProof/session_stage/ancestor/live_unverified。

### 2.6 跨项目 onboarding（transport 契约明确,R1#7,明列 727 issue 不 defer）
| 项目 | deploy 机制 | transport | 本 PR? |
|------|------------|-----------|--------|
| flywheel | self-ship marker/ack | 本机 CLI→Bridge(+spool) | ✅ 本 PR 完整 |
| geoforge3d | Vercel prod deploy | Vercel deploy hook(webhook)→Bridge `/api/deployments/report`(带 token) | ⏳ 项目接入(issue 列) |
| sub / tidal-echo | 内容发布脚本 | 本机 CLI→Bridge(+spool) | ⏳ 项目接入(issue 列) |
| growth / joycon | 各自 deploy 点 | 本机 CLI→Bridge / webhook | ⏳ 项目接入(issue 列) |
每 hook 必传 `--project --issue/--pr --deployed-at --environment production --source`。

### 2.7 全跨项目化（Annie 扩:每个项目都有 digest + 新项目自动接入）

**① 未来项目自动接入（新增,核心）** —— `scripts/setup-new-project.sh`（FLY-284 零到一脚手架）
每建一个新 Flywheel 项目就**自带**一个 ready 的上报 hook `.flywheel/hooks/report-deployment.sh`:
- 项目名脚手架时写死（`report-deployed --project <name> --source project-deploy "$@"`）;经 `FLYWHEEL_DIR`（默认 `~/Dev/flywheel`）找 flywheel-comm CLI;**best-effort**（绝不失败部署 —— report-deployed 默认打本机 Bridge `localhost:9876` 或 spool 落盘）。
- 脚手架**只写文件**（filesystem-only,与 FLY-284 契约一致）;把它接进项目 deploy 点是**印在 gated cutover checklist 第 10 步**的 founder-gated 动作（新项目 born-with-hook,接线一步）。
- digest 侧**无需 per-project 配置** —— DigestService 按 deployment_events 里出现的 project 分组,项目一上报就自动进 digest。

**② 存量项目 onboarding（一句话）** —— 在项目的 deploy 点（或 CI post-deploy）调:
```
report-deployed --project <X> (--issue FLY-N | --pr N) --merge-sha <40hex> [--deployed-at <ts>]
```
或直接调脚手架的 `.flywheel/hooks/report-deployment.sh --issue FLY-N --pr N --merge-sha <sha>`。它 POST 到本机 Bridge（默认 `localhost:9876`,`FLYWHEEL_BRIDGE_URL` 可覆盖）或 spool;digest 随即覆盖项目 X。

**③ 别 repo（geoforge3d/sub/tidal-echo 等）的具体接线** = 各自 Lead 的独立接入任务（Eng Lead 另派,不在本 PR）。

---

## 3. 测试计划（R1#8 + R2#8）
1. 重复 report → 一行(dedup_key)。
2. nullable issue/pr 不重复(确定性 dedup_key)。
3. **无 SHA 的两次不同部署(带不同 source_event_id)→ 两行**(R2#3:不因缺 SHA 合并)。
4. 两进程并发 report 不丢行(better-sqlite3 WAL + busy_timeout)。
5. Bridge-down → spool 落盘 + drain 幂等重放,不静默丢。
6. **【R2#1】satisfied marker + report 失败 → marker 保留**(可重试);report durable 后才删 marker;ack exactly-once(updater 重跑不重复)。
7. **【R2#2】auth-required:`TEAMLEAD_API_TOKEN` 未设 → `/api/deployments/report` 503**(不 tokenless 接受写)。
8. digest 含无匹配 session 的 deployment 行(渲染「摘要暂缺」)。
9. **【R2#4】每个 markerless deployed-sha advance 都产出 fallback 事件**,标 `source='fallback-git-log'` inferred、不 overclaim;同一 merge 已有 marker event 不重复。
10. **【R2#5】旧 marker(无 issueIdentifier)仍可部署** + 报 PR-only/inferred,不隔离。
11. `getDeploymentEventsInRange` PT-day + DST 边界正确。
12. reverse-compat sentinel:`/api/deployments` 端点存在但不影响现有路由;digest default-off 不变。

## 4. 保留 / 删除
- 保留:DigestService、renderDigestHtml(Apple-light 512KiB)、publish-report 投递、dashboard 频道、00:35、
  default-off、按 project 分组/去重/PT-day+DST。
- 删除:deploy-state.ts(git-ancestry)、mergeProof/session_stage/ancestor/live_unverified。

## 5. 待 Lead/Annie 确认（Codex 提的机制改进,relay 决策）
- ✅ 方向(deployment_events 账本)= Codex 确认最优、无更好替代。
- 机制细化(采纳 Codex):CLI-direct-write → **Bridge `/api/deployments/report` 端点**;commit-regex →
  **self-ship marker/ack 源**;+ dedup/审计列 + at-least-once spool。**user-facing 契约不变**(仍是
  report-deployed 工具 + self-ship 自动写 + digest 读表),只是内部机制更 robust。请 Lead/Annie 确认这个细化 OK。
