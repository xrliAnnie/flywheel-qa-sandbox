# FLY-727 Daily digest — 实施计划

Issue: FLY-727 (https://linear.app/geoforge3d/issue/FLY-727/founder-ux-daily-digest-每天一条今天谁完成了啥fleet-wide-完成汇总)
日期: 2026-06-30
基于: exploration.md, research.md

---

> ⚠️ **⑤『完成 = deploy 到 live』的设计已被 Annie redirect + 重设计** —— 以
> **`deploy-events-redesign.md`（deployment_events 事件账本,Codex design review 3 轮 APPROVED）** 为准。
> 本文件下面 §3 的 git-ancestry-on-deployed-sha 方案已作废;digest 骨架(HTML/publish-report/dashboard
> 频道/00:35/default-off/按项目分组)保留。

## 修订记录
- **R3.1（Codex design review R3 后）**：采纳 5 条 —— (1) digest channel 显式开关无静默 fallback（token
  频道已设+digest 未设 → 仍 404）；(2) `/api/digest/render` 纯 HTML 响应、Bridge 不写文件、脚本原子写 $OUT；
  (3) flywheel live 用 **mergeCommitSha ancestor-of deployed-sha** 真检查（有 merge 证据时）、无则退 mtime 标
  `live_unverified` 不计真 ship 数；(4) merge SHA **确在 DB**（`stage_changed.payload.landing_status.mergeCommitSha`
  opportunistic）→ `getLatestMergeProof`；(5) HTML 512 KiB 预算守卫 + 截断。
- **R3（Annie UX 全锁定后 — 实质改动，需 re-Codex）**：① 频道 = 扩现有 **cost/token-report 频道**→改名通用
  dashboard 频道（cost 日报 + digest 共处，config）；② 时间 00:35；③ 格式 = **HTML**（不是纯文本）走
  **publish-report**（Apple-light、hosted、频道出整页预览图 + 链接、零 API 成本）；④ 独立 fleet digest、
  不碰 standup；⑤ **『完成』= deploy 到 live 真在用**（不是 merge、不是 route=真产出就算）→ 追部署状态；
  ⑥ 宿主 = **Bridge DigestService**（不用 flywheel-comm 子命令）。
- **R2（Codex design review R1 后）**：采纳 5 条技术契约修正（deriveDigestOutcome / payload→sessions 回填 /
  CompletionEventRow 带 ts / 脚本 Bearer auth + default-off 不挂载 / TZ 宽窗 + dateStringInZone）。**保留**。

## 0. 状态 / 前置门

- Lead approve 方向 ✅；Annie UX 全锁定（见 R3）；⑥ 宿主 Lead 拍 = Bridge DigestService。
- ③HTML + ⑤deployed 是对 R2（Codex-approved）plan 的实质改动 → **改 plan（本 R3）→ re-Codex design review
  → 发 Lead review → 再 implement**（Lead 指令原话）。
- **⑤ 是本 issue 最难/最险的一块**：Annie 明确「评估各项目 deploy-state 数据源、拿不到可靠信号的项目提个
  proxy（如 merged 暂标 pending-deploy）+ flag 我，别硬凑」。见 §3 的 deploy-state 评估。

---

## 1. 设计总览（v3）

```
launchd (com.flywheel.daily-digest.plist, 00:35 PT)
  └─> scripts/daily-digest.sh  (source ~/.flywheel/.env, 单写者锁, Bridge-down 自启, 条件 Bearer auth)
        ├─(1) POST {BRIDGE}/api/digest/render → DigestService 聚合(StateStore + deploy-state + merge 证据) + 渲染 HTML
        │        → 响应体 = HTML;脚本把响应**原子写** $OUT(/tmp/flywheel-daily-digest.html)。Bridge 不写文件。
        └─(2) flywheel-comm publish-report --html $OUT --project flywheel --channel <DASHBOARD> --title "每日完成 Digest"
                  → /api/reports/publish(hosted URL, ≤512KiB) + 截图 + /api/reports/deliver(Discord 单条:整页图+链接)
```

**为何拆两步（honor ⑥ + ③）**：⑥ 要 Bridge DigestService 拿 StateStore/deploy-state → 聚合+渲染在 Bridge；
③ 要 HTML via publish-report（= token 日报的确切机制，含**浏览器截图**，截图由 CLI `publish-report` 做、
Bridge 无浏览器）→ 投递复用 publish-report。DigestService 产出 HTML **字符串**（route 返回响应体，**脚本**落
文件），publish-report 投递。**Bridge 不写文件。**

> ⚠️ **§7 flag 给 Lead 的宿主张力**：③ 翻成 HTML-via-publish-report 后,「render 放 Bridge 还是放
> flywheel-comm 子命令(= 完全 mirror token-report)」值得再确认 —— CLI 能读 teamlead.db + deployed-sha 文件
> (token-report 已这么干)。本 plan 按 Lead 的 ⑥（Bridge render）写,附 §7 备选。

**复用**：token 日报的 `publish-report` 投递 + launchd/bash 骨架；standup 的 `issueLink`/`pacificDateString`；
StateStore；`~/.flywheel/deployed-sha` + `~/.flywheel/project-deployed-sha/<proj>`。**不改** standup/token-report。

---

## 2. File-by-file 变更

### 2.1 新增：`packages/teamlead/src/bridge/digest-service.ts`（聚合 + ship-state + HTML render + service）
- 类型：
  - `type ShipState = 'live' | 'live_unverified' | 'merged' | 'pending' | 'noop'`（见 §3 ⑤ 判定）
  - `type DigestOutcome = 'merged' | 'pr_open' | 'pr_handoff' | 'auto_approve' | 'no_code' | 'blocked'`
  - `interface DigestItem { identifier; title?; outcome; shipState; prNumber?; summary?; completedAt }`
  - `interface FleetDigestReport { date; projects: Array<{ projectName; items: DigestItem[]; ... }>;
     shippedLiveCount; mergedPendingCount; noiseCount; deployStateNote }`

- **【R2 保留】route 派生**：`deriveDigestOutcome({ route, landingStatus, sessionStatus })` —— 真 route 枚举
  `auto_approve|needs_review|blocked|no_code|pr_handoff`（`complete.ts:30`/`event-route.ts:836`），
  merged 认 `payload.evidence.landingStatus.status ∈ {merged, ready_to_merge}`（`event-route.ts:929`）。

- **【R3 新增】ship-state 判定 `deriveShipState(item, mergeProof, deployState)`**（见 §3 evaluation）：
  - `type ShipState = 'live' | 'live_unverified' | 'merged' | 'pending' | 'noop'`
  - outcome=`no_code`/`blocked` → `noop`；未 merged → `pending`
  - 已 merged（landingStatus.status=merged）：
    - **flywheel + 有 mergeCommitSha**：`isAncestor(mergeCommitSha, deployedSha, flywheelRepo)` → `live`；否则 `merged`（待部署）
    - **flywheel + 无 mergeCommitSha**：merge 完成 ts ≤ `mtime(deployed-sha)` → `live_unverified`（不计真 ship 数）；否则 `merged`
    - **非 flywheel**：`merged`（deploy 未追踪，proxy）+ report `deployStateNote`
  - `isAncestor` 复用 `git merge-base --is-ancestor`（`self-ship-queue.sh:168` 同款，40-hex 校验 + 缺对象 fail-safe，**无网络**）。

- `aggregateFleetDigest(store, deployState, { day, tz }): FleetDigestReport`（**纯**，deployState 注入 = 可测）
  - 读宽 UTC 窗 `session_completed`（2.2）→ `dateStringInZone(parseSqliteUtc(ts), tz) === day` 逐事件过滤到 PT 当天。
  - 按 `project_name` 分组；每 issue 去重取当天最后一次 `sessionRole=main`（qa 排除，按 ts 降序）。
  - **【R2 保留】字段优先级**：`payload.X ?? session.X`（route/summary/sessionRole/identifier/
    landingStatus.prNumber ?? session.pr_number；347/619 事件 payload 空，来自 DirectEventSink）。
  - 派生 outcome + shipState。计数 `shippedLiveCount`/`mergedPendingCount`/`noiseCount`。

- `renderDigestHtml(report): string`（**纯**）—— **Apple-light 风格**（遵循 html-report-style：白底 #f5f5f7、
  卡片 12px 圆角 + 左边框色标、系统字体、max-width 960、mobile viewport）。
  - 抬头 `☀️ 今日完成 Digest — <date>` + 概览徽章（🚀已上线 N / ⏳merged待部署 M / 📝进行中 K）。
  - 按项目分组卡片，每 issue 一行：ship-state 徽章 + `FLY-XXX 标题` + PR 链接 + 截断 summary。
  - `deployStateNote`：非 flywheel 项目 live 状态说明（proxy/未追踪）。空 fleet → 「今日无完成」。
  - **【R3 #5 HTML 512 KiB 预算守卫】**：`publish-report` + `/api/reports/publish` 都 cap 512 KiB
    （`publish-report.ts:50`）。render 时按 summary 截断 + 项目内「…+N more」溢出段，保证 ≤ 512 KiB；
    有对应单测强制预算（fleet-wide 长 summary 不能撑爆日投递）。

- `dateStringInZone(date, tz)` / `parseSqliteUtc(ts)`（**【R2 保留】** repo idiom `ts.replace(" ","T")+"Z"`）。
- `class DigestService { constructor(store, deployStateReader, tz, linearBaseUrl?) }`
  - `aggregate(day?)` → report；`renderHtml(day?)` → HTML；`getDeployState()`（读 deployed-sha 文件）。
  - **不含 Discord 投递**（投递由 publish-report CLI 做）；只 aggregate + render。

### 2.2 修改：`packages/teamlead/src/StateStore.ts`（**【R2 保留】** additive 只读方法 + 带 ts 返回类型）
- `interface CompletionEventRow { id; ts; execution_id; issue_id; project_name; payload }`（现有 `SessionEvent`
  不含 `ts` → 专用类型）。
- `getCompletionEventsInRange(sinceUtc, untilUtc): CompletionEventRow[]`（`event_type='session_completed'`，
  显式 map id/ts）+ 幂等索引 `idx_events_type_ts ON session_events(event_type, ts)`。不动现有行为。

### 2.3 新增：`packages/teamlead/src/bridge/deploy-state.ts`（deploy-state reader + merge 证据 + ancestor，纯 IO/可注入 mock）
- `readDeployState({ flywheelShaPath, projectShaDir }): DeployState`
  - `flywheelDeployedSha`（内容 40-hex）+ `flywheelDeployedShaMtime`（`stat`）。
  - `projectDeployedSha[pname]` + mtime（`~/.flywheel/project-deployed-sha/<pname>`）。
  - 缺文件 fail-safe（undefined → 该项目 ship-state 退化 proxy）。
- **【R3 #4】`getLatestMergeProof(store, execId)`**：查该 execution 最近的 `stage_changed` 事件里
  `payload.landing_status.mergeCommitSha`（opportunistic，缺则 undefined）。malformed/缺字段 fail-safe。
- **【R3 #3】`isAncestor(sha, deployed, repoPath): boolean`**：`git -C <repo> merge-base --is-ancestor`，
  40-hex 校验 + 缺对象/git 失败 → false（不谎报 live）。仅 flywheel repo（`~/Dev/flywheel`）用。

### 2.4 新增：`packages/teamlead/src/bridge/digest-route.ts`（render 端点，**纯 HTML 响应，Bridge 不写文件**）
- `createDigestRouter(service): Router`，`POST /render {day?}` → **返回 `text/html`**（**【R4 #2】定死 text/html
  一种线格式**，避免脚本误把 JSON 包装写进 $OUT；`Content-Type: text/html`）。
  （**【R3 #2】Bridge 绝不写调用方指定的本地路径**；落文件由脚本侧做。）
  route 仅在 `FLYWHEEL_DIGEST_CHANNEL` 已配 + DigestService 构造成功时挂载（default-off，见 2.5）。

### 2.5 修改：`packages/teamlead/src/bridge/plugin.ts`（wire）
- **【R3 #1】显式开关，无静默 fallback**：读 `FLYWHEEL_DIGEST_CHANNEL`（**必须显式设**，**不默认回退到**
  `FLYWHEEL_TOKEN_USAGE_CHANNEL` —— 否则生产已有 cost 频道会静默挂 /api/digest 破坏字节兼容）。
  运营把它显式设成与 cost 频道相同的 id（= 同频道共处）。
- **default-off = 不挂载**：`FLYWHEEL_DIGEST_CHANNEL` 未设 → 不构造 DigestService、`/api/digest` 不挂（404 sentinel）。
- token 配置时 route 用 `tokenAuthMiddleware`（同 standup/reports）。现有 standup/token/reports 路径逐字不变。

### 2.6 新增：`scripts/daily-digest.sh`（copy token-usage-daily.sh + daily-standup.sh 结构）
- **【R4 #3】env 顺序**：**先** source `~/.flywheel/.env`，**再**派生 `REPO`/`OUT`/`FLYWHEEL_DIGEST_CHANNEL`/
  `BRIDGE_URL`(或 `FLYWHEEL_BRIDGE_URL`)/`COMM`/`TEAMLEAD_API_TOKEN` 及 auth header（现有 token 脚本有的 var 在 source
  前派生，不能照抄那个顺序）。单写者 mkdir 锁；Bridge 健康检查（down 自启，抄 daily-standup.sh）；条件 Bearer auth。
- (1) `curl POST {BRIDGE}/api/digest/render`（text/html）→ **原子写** `$OUT=/tmp/flywheel-daily-digest.html`
  （**【R4 #2】** 校验响应非空 + 大小 ≤ 512 KiB 再落盘）；
- (2) `node <comm> publish-report --html "$OUT" --project flywheel --channel "$FLYWHEEL_DIGEST_CHANNEL" --title "每日完成 Digest"`。
- 失败 → stderr + 非零。`.env`-only fixture 测（channel + token 从 .env 解析）。

### 2.7 新增：`scripts/com.flywheel.daily-digest.plist`（copy token-usage plist）
- `StartCalendarInterval` Hour=0 Minute=35（错开 token 00:30）；`RunAtLoad=false`；日志 → /tmp；注释含安装步骤。

### 2.8 频道改名（① dashboard）
- **不改代码**：channel 是 config（同一个 Discord 频道 id，既收 cost 日报又收 digest）。「改名成 dashboard」
  是 Discord 端频道重命名（运营动作，非代码）；两个 daily 脚本各自 `--title` 区分。文档说明即可。

---

## 3. ⑤『完成 = deploy 到 live』deploy-state 数据源评估（本 issue 最难，flag Lead/Annie）

### 3.1 可用数据（已审计 — 含 Codex R3 #3/#4 修正）
| 来源 | 内容 | 可靠性 |
|------|------|--------|
| `session_completed` payload / `sessions` | route、`landingStatus.status∈{merged,ready_to_merge}`、`prNumber`、`pr_head_sha` | merge 状态可靠；`pr_head_sha`≠merge commit（squash 不同） |
| **`stage_changed` 事件 payload `landing_status.mergeCommitSha`** | **真 merge commit SHA**（`stage.ts` / `event-route.ts:1527`）| ⚠️ **opportunistic**（live DB 快照:数千 stage_changed 中仅~几十条带 mergeCommitSha，占比小）— **有则用、无则退化**，不当稳定事实 |
| `~/.flywheel/deployed-sha` | flywheel 自身 live commit（40-hex）+ 文件 mtime | flywheel **权威**（`restart-services.sh` 仅成功路径 advance） |
| `~/.flywheel/project-deployed-sha/<proj>` | 各项目 repo HEAD @ 上次 flywheel restart | 随 flywheel restart **一起更新**（非各自产品 deploy）→ **弱代理** |
| `~/.flywheel/runs/*/land-status.json` | merge commit SHA | ⚠️ **不持久**（worktree 内，清理后没了；live runs 目录空）→ **不可用** |
| gh api (PR→mergeCommit) | 精确 merge SHA | 需网络 + gh auth → v1 **不用**（成本/依赖） |

> Codex R3 #4 修正：不是「DB 无 merge SHA」—— `sessions` 表没有，但 `session_events` 的 `stage_changed`
> **opportunistic 带** `landing_status.mergeCommitSha`。用 **按 execution_id 查最近 stage_changed merge 证据**
> 的 helper（`getLatestMergeProof(execId)`）。

### 3.2 结论：per-project ship-state 判定（strong-when-available + honest-fallback）
- **flywheel（self-hosting）**：
  - **有 mergeCommitSha（strong）**：`git -C ~/Dev/flywheel merge-base --is-ancestor <mergeCommitSha>
    <deployedSha>` → 0 = `🚀 live`（deployed 代码含该 merge，复用 `self-ship-queue.sh:168` 同款 idiom，无网络）。
  - **无 mergeCommitSha（fallback）**：退化为 mtime 弱代理 —— merged 完成 ts ≤ `mtime(deployed-sha)` → 标
    `live-unverified`（**不计入 `shippedLiveCount`**，单列/注明），否则 `⏳ merged 待部署`。
- **非 flywheel 项目 = 无可靠 per-issue live 信号**：`project-deployed-sha` 随 flywheel restart 更新、
  不反映各自产品 deploy（geoforge3d 的 Vercel、内容项目 sub/tidal-echo 的发布）→ **不谎报 live**。
  merged completion 标 `⏳ merged`（deploy 未追踪，proxy），report 带 `deployStateNote` 说明。
  （注：若非 flywheel 项目也有 mergeCommitSha + projectRoot 仓库在本机，可选做 project-deployed-sha ancestor
  检查作 `live-unverified` 弱代理 —— 但 project-deployed-sha 非产品 deploy，仍不计入真 `shippedLiveCount`。）
- **概览分档**：`🚀 已上线 N`（= ancestor-verified 真 ship，Annie『只算真 ship』的主数）/
  `❔ live-unverified`（mtime 代理，单列）/ `⏳ merged 待部署/未追踪 M` / `📝 进行中 K`。footer 计 `no_code/blocked`。

### 3.3 flag 给 Lead/Annie（要她/他确认）
- flywheel live 判定：**有 mergeCommitSha 用真 ancestor 检查**（强）；少数无 merge 证据的退 mtime 代理
  （标 unverified，不计真 ship 数）。可接受?
- 非 flywheel 项目 **v1 不追产品 live**（标 merged 未追踪 proxy）。若 Annie 要真 live：需各项目接 deploy 信号
  （geoforge3d Vercel webhook / 内容项目发布确认）= **follow-up issue**。本 v1 先 flag、不硬凑。

---

## 4. TDD 步骤（RED → GREEN → REFACTOR）

1. **RED** `deriveDigestOutcome` 全枚举（auto_approve+merged / needs_review+merged / needs_review / pr_handoff+ready_to_merge / no_code / blocked）。→ GREEN。【R2】
2. **RED** 空 payload fallback（DirectEventSink payload=null + populated sessions 行）。→ GREEN。【R2】
3. **RED** PT 当天边界 + DST（spring-forward/fall-back），宽窗 + `dateStringInZone`/`parseSqliteUtc`。→ GREEN。【R2】
4. **RED** 跨项目分组 + 单 issue 去重取最后 + qa 排除。→ GREEN。
5. **RED** `deriveShipState`【R3 ⑤】：flywheel+mergeCommitSha ancestor-of deployed→live / 非祖先→merged;flywheel 无 mergeCommitSha+mtime≥ts→live_unverified(不计真 ship 数)/ <ts→merged;非 flywheel merged→merged(proxy);未 merged→pending;no_code/blocked→noop（mergeProof + deployState 注入 mock）。→ GREEN。
6. **RED** `readDeployState`：读 deployed-sha(内容+mtime) + project-deployed-sha;缺文件 fail-safe。→ GREEN。【R3】
7. **RED** `getLatestMergeProof`【R3 #4】：stage_changed 有/无/malformed/squash mergeCommitSha 四态。→ GREEN。
8. **RED** `isAncestor`【R3 #3】：真 git merge-base --is-ancestor（temp repo fixture:祖先 true / 非祖先 false / 缺对象 false / 非 40-hex false）。→ GREEN。
9. **RED** `renderDigestHtml` 快照：Apple-light 结构、概览分档徽章(含 live_unverified 单列)、按项目卡片、ship-state 徽章、deployStateNote、空 fleet。→ GREEN。【R3】
10. **RED** **HTML 512 KiB 预算**【R3 #5】：超长 summary fleet → 截断 + 「…+N more」→ 输出 ≤ 512 KiB。→ GREEN。
11. **RED** `getCompletionEventsInRange` 返回带 ts/id + range 过滤。→ GREEN。【R2】
12. **RED** `/api/digest/render` 返回 html JSON/text（day 参数）、**Bridge 不写文件**;未配 channel → 404 未挂载。→ GREEN。
13. **RED** **reverse-compat sentinel**【R3 #1】：`FLYWHEEL_TOKEN_USAGE_CHANNEL` 已设 + `FLYWHEEL_DIGEST_CHANNEL` **未设** → /api/digest 仍 **404**（无静默 fallback）+ standup/token/reports 逐字不变。→ GREEN。
14. **脚本**：`daily-digest.sh` shellcheck + bash -n + 条件 Bearer + 两步（render→原子写 $OUT→publish-report）;plist `plutil -lint`。
12. **REFACTOR**：抽共享 issueLink/日期 helper（若与 standup 重复），保 standup 字节兼容。

---

## 5. Config / env（全 default-off 字节兼容）

| env | 默认 | 作用 |
|-----|------|------|
| `FLYWHEEL_DIGEST_CHANNEL` | 未设=不挂 /api/digest + 不投递（**必须显式设**，无静默 fallback） | dashboard 频道 id（运营显式设成 = cost 频道 `FLYWHEEL_TOKEN_USAGE_CHANNEL` 的同一 id → 同频道共处） |
| `FLYWHEEL_DIGEST_TZ` | `America/Los_Angeles` | 当天边界时区 |
| plist Hour/Minute | 0/35 PT | 触发时间 |

**【R3 #1】** `FLYWHEEL_DIGEST_CHANNEL` 与 `FLYWHEEL_TOKEN_USAGE_CHANNEL` **各自独立显式**（digest 不回退到
token 频道 env），否则生产已配 cost 频道会静默启用 digest 破坏字节兼容。
字节兼容 sentinel：token 频道已设 + digest 频道未设 → Bridge 无新行为、/api/digest 404、standup/token/reports 逐字不变。

---

## 6. 验收标准（AC）
- AC1 一条 **HTML** 消息（整页预览图 + 链接）汇总全 fleet 当天完成，投到 dashboard（=cost）频道。
- AC2 每完成项：ship-state 徽章 + issue 号 + 标题 + PR 链接 + 可选 summary，按项目分组。
- AC3 ⑤『完成』= deploy 到 live：flywheel 有 mergeCommitSha → ancestor-of deployed-sha 真判定 `🚀live`/`⏳merged待部署`,
  无 merge 证据 → `❔live_unverified`(mtime 代理,不计真 ship 数);非 flywheel `⏳merged`(proxy)+note。
- AC4 概览计数（🚀已上线 / ❔live_unverified / ⏳merged待部署 / 📝进行中）+ footer no_code/blocked。
- AC5 default-off：`FLYWHEEL_DIGEST_CHANNEL` 未设 = 不挂载、不投递、生产零变化。
- AC6 时区正确（PT 当天含 DST）;同 issue 去重;空 payload 从 sessions 回填。
- AC7 Apple-light HTML 风格;零 API 成本（publish-report subscription 路径）。

---

## 7. 开放 / 风险（flag Lead review）
- **【要 Lead 拍】宿主张力**：③=HTML-via-publish-report 是 token-report 的 CLI 机制;⑥ 定 Bridge DigestService。
  本 plan 折中（Bridge render + CLI publish-report 两步）。**备选**：render 也放 flywheel-comm 子命令 = 完全
  mirror token-report（CLI 读 teamlead.db + deployed-sha,更少 round-trip）。请 Lead 确认走哪个。
- **【要 Annie/Lead 拍】⑤ live 判定**：flywheel **有 mergeCommitSha 用真 ancestor-of-deployed-sha 检查**（强、无网络），
  无 merge 证据退 mtime 弱代理标 `live_unverified`（不计真 ship 数）;非 flywheel v1 不追产品 live（标 merged proxy + flag）。
  真 live per-project = follow-up。见 §3。
- **多 Bridge**：fleet 完成事件落主 `~/.flywheel/teamlead.db`（sub/tidal-echo 实测在内）;deployed-sha 文件在主机。
- **VERCEL_TOKEN**：publish-report hosted 需 `VERCEL_TOKEN`（token 日报已依赖，同款）。未配 → publish 502,脚本报错非零。
