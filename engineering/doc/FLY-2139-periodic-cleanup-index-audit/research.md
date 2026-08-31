# FLY-2139 Bridge 全方位定期清理与 index 审计 — 调研

Issue: FLY-2139 (https://linear.app/geoforge3d/issue/FLY-2139/bridge-稳定全方位定期清理-文件db-陈旧数据的机制化清理与-index-审计保证-bridge-常快founder-已令开工)
日期: 2026-08-28
基于: exploration.md

## 1. 三个既有载体的可用性核实

### 1.1 launchd janitor(文件面宿主)— 存在但断链,根因已定位

`flywheel-log-janitor.sh` 的 apply 安全门(:1355-1358)要求存在**同配置**的 full-scope dry-run 回执;回执 scope(`dry_run_scope_json`)包含 **`script_sha256`**。launchd plist 只跑 `--apply`,从不跑 `--dry-run` ⇒ **每次部署更新 janitor 脚本后,回执必然失配,apply 从此永远失败**(err.log 连日同错,最后成功 apply 2026-08-22)。

机制化修法(保持安全语义,不开 `--force` 后门):新增 `--cycle` 模式 = 同一进程内先 full-scope `--dry-run`(铸新回执)再 `--apply`(消费刚铸的回执);launchd 改跑 `--cycle`。安全属性不降:apply 消费的仍是「同配置、刚刚跑过」的 dry-run,比现在人肉补跑更严格(零时间差)。

模块框架可直接扩展:`run_<module>()` 函数 + `module_enabled` 开关 + `audit_event` 审计 + lsof in-use 探测(`probe_open_candidates`)+ per-run 删除 cap,全部现成。

### 1.2 FLY-2006 sweep engine(DB 面引擎)— 已合入已实跑,但对 live 库已 fail-closed

- 引擎:`scripts/fly-1998-database-retention-sweep.mjs`(inventory → snapshot(事务内建 SQLite 快照)→ apply → vacuum,evidence 落 `~/.flywheel/maintenance/<issue>/<run-id>`);registry:`scripts/lib/fly-2006-retention-registry.mjs`(`RETENTION_MS=14d`,两库全表分类,`assertClassifiedSchema` 对**未分类新表抛错**);consumer gate 防新读者漏分类。
- 大表分类核实:`lead_events`、`session_events`、`workflow_run_event`、`chat_threads`、`deployment_events` 等 = **deleteTarget**(14 天窗可清);`codex_review_job`(40MB)= protectedAuthority(不可清,合理);`sessions`、`dead_letter_alerts` = protectedCurrentOrReference(现全保护)。
- **缺口 A(阻断级)**:live comm.db 已有 `mailbox_archive`(8/28 协议外止血新表,FLY-2136 接管机制化)与 `runner_stop_declarations` 等 registry 之后出生的表 ⇒ `assertClassifiedSchema` 会抛 `unclassified` ⇒ **引擎今天对 live 库直接 fail-closed**。定时化第一步必须是 registry 对账(逐新表分类 + consumer gate 重跑)。
- **缺口 B(授权级)**:8/23 的 apply 授权是一次性的(founder 原话「删」+ ±1% 行数偏差内可 apply)。周期化 apply 需要一个**有界常设政策**(见 plan §政策),超界 fail-closed 报 Lead。
- 回弹实测:lead_events 8/23 清后 5 天回弹至 58,102 行/102MB(~1.2 万行/天)⇒ 周跑一次可把常驻压在 ~14 天流量(≈17 万行/300MB 级 → 实际上限由清扫周期决定,周跑则峰值 ≈ 21 天流量)。

### 1.3 部署班车(quiescence 宿主)

`com.flywheel.updater.plist`(00:00/12:00)→ `update-flywheel.sh` → `restart-services.sh --reason updater`(:177,前台重启)。重启序列中存在「服务已停、尚未拉起」的窗口 —— WAL checkpoint(TRUNCATE)与 VACUUM 的唯一合法宿主(FLY-2006 纪律:VACUUM 需 quiescence ack;班车窗把「人肉 ack」机制化为「实测无进程持有 DB 再做」)。
实测收益预估:comm.db 文件 497MB、dbstat 活跃 ~330MB ⇒ VACUUM 可回收 ~170MB;WAL 160MB ⇒ checkpoint 后归零;teamlead.db 在周清扫后同理。

## 2. gate marker 生命周期(「用完即删」挂点核实)

| 事件 | 现状 | 缺口 |
|---|---|---|
| 铸造 | `gate.ts:239`(no-block + `FLYWHEEL_GATE_MARKER_DIR`,Codex runner 专属);`ask.ts` 铸 ask marker 进 `ask/` 子目录 | — |
| 答复 | `respond.ts:216` 改写 answeredAt(marker 保留,等 adapter 消费);ask marker 答复时 best-effort 删(gate-marker.ts:248) | 未答复 ask marker 永不删(14,667 个) |
| 消费 | `CodexTmuxAdapter.ts:1495` 消费后 `removeGateMarker` | 唯一删除点;session 崩溃/adapter 未接管 ⇒ 残留 |
| 终态 | **无任何清理** | execution 终态后其名下 marker 全部成为死数据 |

⇒「门关闭时就地删」的正确挂点 = **execution 终态转移处**(Bridge 已知终态;marker 目录是固定默认路径 `~/.flywheel/state/codex-gates`),辅以 janitor mtime 扫尾兜底(处理 Bridge 不在场时段的孤儿)。gate-marker.ts 需新增 `removeGateMarkersForExecution(dir, executionId)`(主目录 + ask/ 一并,按 marker 内容的 executionId 匹配,而非文件名猜测)。
⚠️ 与 FLY-2136 的接缝:2136 给 `listGateMarkersForExecution` 加了目录级 mtime 缓存 —— 删除经 `rmSync` 会更新目录 mtime,缓存自然失效,**无需特殊处理**(2136 已核实无 in-place 写契约)。

## 3. index 审计方法(已有 pattern,不发明新轮子)

- 固化手法:vitest 内 `EXPLAIN QUERY PLAN` 断言(先例:`StateStore.patrol-tick.test.ts`、`StateStore.workflow-engine-transition.test.ts`、`mailbox-query-plans.fly2008/fly2136.test.ts`),断言使用具名索引且无 bare `SCAN <table>`、无 `TEMP B-TREE`。
- 热查询枚举协议(审计完备性的定义):Bridge 每-tick 执行面 = ①GatePoller tick;②LeadInboxRuntime.admit(含 2136 的归档 pass);③RunnerMailboxLane.tick;④patrol tick;⑤workflow engine transition;⑥alert/outbox drain 族(lead_inbox、dead_letter_alerts、workflow_alert_outbox、receipt_alert_outbox、turn_wake_outbox)。对以上路径触到的每条 SQL 逐条 EQP。
- 初勘结论:teamlead 热表已有针对性 partial/复合索引(sessions status 族、lead_events patrol/ack_due/dedup、dead_letter_alerts pending/due、lead_inbox pending/resend);已固化的只有 patrol 与 workflow transition 两个文件 ⇒ 审计的主要产出是**把其余热查询逐条固化 + 查漏补缺**,而非大规模补索引。发现的缺口按「加 partial index、不改查询文本」处理(2136 刀 1 同款纪律)。

## 4. 残留目录处置分级(文件面政策依据)

| 类 | 例 | 处置 | 依据 |
|---|---|---|---|
| 记号类(小文件海量) | codex-gates/*.json(1,344)、ask/(14,667) | 终态就地删 + mtime>2d 归档扫尾 | 04:00 手动先例即 2d 窗 |
| 证据类 | push-guard/worktrees(265MB)、misroute-archive、tmux-rescue-episodes 等 | mtime>14d 归档(压缩后移 `~/.flywheel/archive/`),不删 | 操作基线:归档式 |
| 缓存类(可再生) | fly2054-playwright(520MB) | mtime>14d 直接删(注明可重新下载) | 归档一份可再生缓存无意义;founder HTML 里如实标注此例外 |
| 误放垃圾 | codex-gates/FLY-2024-xhs-mcp(162MB repo clone) | 一次性移出归档(实施时人工确认一次) | 非周期问题 |
| DB 备份 | comm/\*/comm.db.pre-\*、\*.migrated-\*(~1.3GB,最新 2026-08-08) | 保最新 1 份原样,其余 gzip 压缩;压缩件 >30d 删 | 备份的备份没有保护义务,但给 30d 反悔窗 |

## 5. 关键结论(喂给 plan)

1. 不新建任何调度器/守护进程:janitor(+`--cycle` 修复)承文件面与 DB inventory/apply 周期;班车窗承 checkpoint/VACUUM;Bridge 内只留 2136 已有的 mailbox 归档。
2. DB 定时化的前置是 registry 对账(缺口 A),核心设计物是**有界常设清扫政策**(缺口 B,fail-closed)。
3. 「用完即删」= Bridge 终态钩子 + janitor 扫尾双层;单靠任何一层都有洞(终态钩子覆盖不了 Bridge 不在场,扫尾有 2d 延迟)。
4. index 审计是「固化 + 查漏」,预期少量新索引;审计测试本身是防退化闸(未来查询/schema 改动破坏索引使用会红)。
