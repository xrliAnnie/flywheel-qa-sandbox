# FLY-727 Daily digest — 调研

Issue: FLY-727 (https://linear.app/geoforge3d/issue/FLY-727/founder-ux-daily-digest-每天一条今天谁完成了啥fleet-wide-完成汇总)
日期: 2026-06-30
基于: exploration.md

---

## R3 更新（Annie UX 锁定后）
下面 §2/§3 的部分结论被 Annie 的 UX 决策覆盖，以 plan.md R3 为准：
- **投递**：Annie 要 **HTML**（不是纯文本）→ `publish-report` 从「overkill 不用」变成 **采用**（HTML→hosted→
  频道整页预览图+链接，零 API 成本）。§2.1 里「publish-report 不用」作废。
- **频道**：投到现有 **cost/token-report 频道**（改名 dashboard），不新建。
- **宿主**：Lead 拍 **Bridge DigestService**（render）+ publish-report（deliver）。
- **『完成』定义**：= **deploy 到 live 真在用**（不是 merge）→ 新增 deploy-state 数据源评估（见 plan.md §3）：
  flywheel 用 `~/.flywheel/deployed-sha` mtime 真判定;非 flywheel `project-deployed-sha` 是弱代理、无可靠
  per-issue live 信号 → 标 merged(proxy)+flag。land-status.json **不持久**(runs 目录空)、DB **无 merge commit
  SHA**(只有 PR 号 + landingStatus.status + pr_head_sha) → 不做精确 merge-SHA 祖先检查。

---

## 1. 数据源：聚合查询（已在 live `~/.flywheel/teamlead.db` 验证）

### 1.1 权威事件
`session_events` 表，`event_type='session_completed'`。每条含：
`ts`（TEXT, UTC, `datetime('now')` 格式 `YYYY-MM-DD HH:MM:SS`）、`issue_id`、`project_name`、`payload`（JSON）。

payload 关键字段（实测）：
```
decision.route      → needs_review | no_code | blocked | merged | pr_handoff | ...
summary             → runner 自写的一句话总结（digest 最有价值字段）
sessionRole         → main | qa
evidence.commitCount / filesChangedCount / linesAdded / linesRemoved / headSha
issueIdentifier
exitReason          → completed | ...
```

> 注意 payload 可能为空串（部分早期事件）。渲染需对空 payload / 缺字段 fail-safe（用 sessions 表兜底 title/pr）。

### 1.2 补充维度来自 `sessions` 表
join key = `issue_id`（或 `issue_identifier`）：`issue_title`、`pr_number`、`decision_route`、`status`。
（`session_completed` 事件本身没有 issue_title / pr_number；从 sessions 取。）

### 1.3 「当天」边界 + 去重 + 过滤（草拟 SQL / 逻辑）
- **当天**：Pacific 日历日。`ts` 是 UTC → 目标日 `YYYY-MM-DD`（PT）对应 UTC 窗口
  `[day 07:00Z or 08:00Z, next-day 07:00Z/08:00Z)`（夏令时 -7 / 冬令时 -8）。
  实现用现成 `pacificDateString` + 把每条事件的 `ts` 转成 PT 日历日再比较（比手算 UTC 偏移稳，自动含 DST）。
- **去重**：同一 `issue_id` 当天多条 completion（retry / QA + main）→ 主列表取当天**最后一次** main completion。
- **role 过滤**：`sessionRole='qa'` 不进主列表（QA 不算「完成一个 issue」）。
- **『完成』定义**（Lead 倾向、待 Annie 确认）：主列表 route ∈ {`needs_review`,`merged`,`pr_handoff`}；
  尾注计数 `no_code`/`blocked`/`failed`。

草拟聚合（伪 SQL，实际在 TS 里读全部当天事件再在内存分组/去重，避免 payload JSON 在 SQL 里解析）：
```sql
SELECT ts, issue_id, project_name, payload
FROM session_events
WHERE event_type = 'session_completed'
  AND ts >= :dayStartUtc AND ts < :dayEndUtc
ORDER BY ts ASC;   -- asc → 内存里 last-write-wins 去重
```
（`sessions` 单独一把 `SELECT issue_id, issue_identifier, issue_title, pr_number FROM sessions` 建 map。）

---

## 2. 投递：复用已验证的 mention-safe Discord 路径

### 2.1 候选复用点（实测存在）
- `packages/teamlead/src/bridge/discord-utils.ts`：
  - `DISCORD_API`、`MAX_DISCORD_MESSAGE_LENGTH=1900`、`splitDiscordMessage()`
  - **`postDiscordMessageToChannel()`**（FLY-162 P2）：split + 顺序 POST + `allowed_mentions:{parse:[]}`
    （防 `@everyone`/role 误 ping）+ 失败信封。**正是文本 digest 需要的投递原语。**
- `StandupService.deliver()`：`fetch ${DISCORD_API}/channels/${channel}/messages`（Bot token 在 Bridge）。
- `flywheel-comm publish-report`：经 Bridge `/api/reports/{publish,deliver}`，但走 **HTML 截图 + 托管 URL**
  （需 `FLYWHEEL_BRIDGE_URL` + `TEAMLEAD_API_TOKEN`）—— 对纯文本 digest 是 overkill，**不用**。

### 2.2 bot token / channel
- Bot token：Bridge 启动时从 env 载（standup 用同款）。CLI 侧脚本从 `~/.flywheel/.env` 载（daily 脚本惯例）。
- channel：**可配 env**（暂命名 `FLYWHEEL_DIGEST_CHANNEL`），**未设 = 不投递**（default-off 字节兼容）。

---

## 3. 架构决策：mirror standup（Bridge service）vs flywheel-comm 子命令

Lead 原话「复用 token 日报骨架（launchd + bash + flywheel-comm 读 session_completed 事件）」。
但**文本投频道**正是 **standup（Bridge service）**已经在做的事；token-report 走的是 HTML+publish-report。
两条路：

| | 方案 1：Bridge DigestService（mirror standup） | 方案 2：flywheel-comm 子命令（mirror token-report） |
|--|--|--|
| 聚合/渲染 | Bridge 内读 StateStore | CLI 内 better-sqlite3 读 teamlead.db（同 completion.ts） |
| 投递 | 直接复用 `postDiscordMessageToChannel`（Bridge 持 token + mention 安全） | 需 POST 到 Bridge 新 route，或 CLI 直发（需把 token 给 CLI） |
| 触发 | `scripts/daily-digest.sh` → `POST /api/digest/trigger`（copy daily-standup.sh） | `scripts/daily-digest.sh` → `flywheel-comm daily-digest`（copy token-usage-daily.sh） |
| 复用量 | 最大（bot token / Discord 投递 / split / PT date / issueLink 全复用） | 中（复用 better-sqlite3 读法；投递要新造或经 Bridge） |
| Bridge 依赖 | 是（daily-standup.sh 已有 Bridge-down 自启模式可抄） | 投递若经 Bridge 则同样依赖 |
| 新表面 | Bridge service + route + 脚本 + plist | CLI 子命令 + 脚本 + plist（+ 投递路径） |

### 采纳：**核心逻辑做成纯函数模块**（无 Bridge/CLI 耦合）+ **推荐用方案 1 投递**
- 新建纯模块（暂定 `packages/teamlead/src/bridge/digest-service.ts`，或独立 `completion-digest.ts`）：
  - `aggregateFleetDigest(store, {day, tz})` → 结构化 report（按项目分组、去重、role/route 过滤）。**纯**、可单测。
  - `formatDigestReport(report, {linearBaseUrl})` → 一条 Discord markdown 文本。**纯**、可单测（快照）。
  - `DigestService.deliver()` → 复用 `postDiscordMessageToChannel(channel, text, botToken)`。
- 触发：`scripts/daily-digest.sh` + `com.flywheel.daily-digest.plist`（copy standup 脚本/plist 结构）。
- **理由**：文本投频道 = standup 的确切工作，复用最大、mention 安全在 Bridge 内不外泄 token。
  聚合器纯函数化 → 若 Lead 更想要 flywheel-comm 子命令，套一层 CLI adapter 即可，**不重写核心**。

> ⚠️ **这是要跟 Lead 确认的架构点**（他字面说 flywheel-comm；我发现 standup 是更近的类比）。
> 已在进展里 flag;不 block —— 核心纯函数两种投递宿主都能用。

---

## 4. Config / env 契约（全 default-off 字节兼容）

| env | 作用 | 未设行为 |
|-----|------|---------|
| `FLYWHEEL_DIGEST_CHANNEL` | digest 投递频道 id | 不投递（渲染 dry-run 可用） |
| `FLYWHEEL_DIGEST_TZ` | 报告时区 | 默认 `America/Los_Angeles` |
| （plist `StartCalendarInterval`） | 触发时间 | 默认 00:35 PT（错开 token 00:30） |

- Bridge 侧：`FLYWHEEL_DIGEST_CHANNEL` 未设 → DigestService 不构造 / route 返回 400（同 standup 无
  STANDUP_CHANNEL 的处理）→ **生产零变化、不用改现有行为**。
- reverse-compat sentinel：加一条测试断言「env 全不设时，Bridge 启动 & 现有 standup/token 路径逐字不变」。

---

## 5. 测试策略（TDD）

1. **`aggregateFleetDigest` 单测**：喂 temp StateStore（塞入若干 session_completed 事件 + sessions 行），
   断言：跨项目分组、PT 当天边界（含跨 UTC 午夜、DST）、同 issue 去重取最后、qa role 排除、
   route 分类（主列表 vs 尾注计数）、空 payload fail-safe。
2. **`formatDigestReport` 快照测**：给定 report → 断言 markdown（按项目分组、每行 issueLink + route + PR、
   尾注计数、空 fleet「今日无完成」）。超长 → split 后 ≤ MAX_DISCORD_MESSAGE_LENGTH。
3. **`DigestService.deliver` 测**：mock fetch，断言 POST 到正确 channel、`allowed_mentions:{parse:[]}`、
   多 chunk 顺序、失败信封。
4. **route/CLI adapter 测**：dryRun 返回 report 不投递；无 channel 返回 400。
5. **reverse-compat sentinel**：env 全不设 → 现有 Bridge 行为字节不变。
6. **脚本**：`daily-digest.sh` shellcheck + bash -n；单写者锁；Bridge-down 处理（若走 Bridge 触发）。

---

## 6. 与并行 issue 的关系（无冲突）
- **FLY-725 ②**（per-completion → issue thread，runner 3956787d 正在并行开发）：读同一份
  `session_completed` 事件，但写到**各 issue thread**；digest 写到**汇总频道**。数据源共享、写目标不同，无冲突。
- **standup（GEO-288）**：不改；关系（并存 / repoint 频道 / 取代其 completions 段）= Annie UX 决策。
- **token-report（FLY-614）**：不改;仅复用其 launchd/bash 脚本结构。

---

## 7. 待锁定（→ implement 前）
- **[Annie UX]** 频道（推哪）/ 时间 / 格式 / 跟 standup 关系 / 『完成』定义。
- **[Lead 技术]** 投递宿主：Bridge DigestService（推荐）vs flywheel-comm 子命令。
- 以上均**不 block 写 plan**（按推荐默认，核心纯函数两种宿主通吃）。
