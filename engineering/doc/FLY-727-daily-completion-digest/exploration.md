# FLY-727 Daily digest（每天一条『今天谁完成了啥』fleet-wide 完成汇总）— 探索

Issue: FLY-727 (https://linear.app/geoforge3d/issue/FLY-727/founder-ux-daily-digest-每天一条今天谁完成了啥fleet-wide-完成汇总)
日期: 2026-06-30
基于: 无

---

## 1. 问题 / 目标

Annie 要**每天一条 fleet-wide「今天谁完成了啥」的完成汇总**。这是从 FLY-725（主动完成通知）
brainstorm 里拆出来的第 ③ 条：

- FLY-725 ②（默认、实时）：每个 runner 完成 → 推到它自己的 issue thread（per-completion）。
- **FLY-727 ③（本 issue、每天一条）：一条 fleet-wide 汇总 = 兜底 + 一眼看全**。

Annie 原话：『这个要做的。不过值得单独搞成一个 issue、因为要稍微讨论它做成啥样、会需要 iterate。』
所以本 issue 是**设计先讨论 + iterate**（FLY-598 类），UX 三点（推哪 / 时间 / 格式）+『完成』定义
由 Annie 拍板，实现按可配置来，让她定了改配置即可、不重写。

### 核心用户价值
Annie 每天**一条消息**就能一眼看全昨天全 fleet（所有项目）谁完成了哪些 issue（结果 + PR），
不用去翻每个 issue thread。digest 是 ② 的**兜底**（万一某条 per-completion 没看到）+ **全局视图**。

---

## 2. 已审计的现有机制（不从零设计）

### 2.1 数据源已现成：`session_completed` 事件 + `sessions` 表（`~/.flywheel/teamlead.db`）

- `session_events` 表：`event_type='session_completed'`，含 `ts`（UTC）、`issue_id`、
  `project_name`、`payload`（JSON）。当前库里有 619 条此类事件；跨全 fleet。
- payload 富信息（实测样本）：
  - `decision.route`（`needs_review` / `no_code` / `blocked` / `merged` / `pr_handoff` …）
  - `evidence`（`commitCount` / `filesChangedCount` / `linesAdded` / `linesRemoved` / `headSha`
    / `commitMessages[]` / `changedFilePaths[]`）
  - `summary`（**runner 自己写的一句话总结** —— 这是 digest 最有价值的字段）
  - `sessionRole`（`main` / `qa`）、`exitReason`、`issueIdentifier`
- `sessions` 表补：`issue_title`、`pr_number`、`decision_route`、`status`、`last_activity_at`。

> 结论：digest「谁完成了啥」= 读当天的 `session_completed` 事件（按 `ts` 过滤当天，按 `project_name`
> 分组），join `sessions` 拿 title/pr。**零新数据管线**。

### 2.2 可复用的「每日推送」机制骨架：token 日报（FLY-614 / FLY-699）

`scripts/token-usage-daily.sh` + `scripts/com.flywheel.token-usage-daily.plist`：
- launchd 在 **00:30**（Pacific）触发 → bash 脚本（单写者 mkdir 锁 + 从 `~/.flywheel/.env` 载 env）→
  `flywheel-comm token-report daily --out <html>` → `flywheel-comm publish-report --channel <id>`。
- token-report 已经**读 `~/.flywheel/teamlead.db` 的完成集**（`completedDbPath`），验证了「日报读
  StateStore」这条路可行。

> 结论：digest 复用同款 **launchd plist → bash 脚本 → flywheel-comm 子命令 → Discord 投递** 骨架。

### 2.3 ⚠️ 重要重叠：已有一个 daily 完成汇总在跑 —— Daily Standup（GEO-288）

`packages/teamlead/src/bridge/standup-service.ts`（`StandupService`）:
- 每天 **3AM**（Pacific）由 `daily-standup.sh` → `POST /api/standup/trigger` 触发。
- **已经**聚合『Completions (24h)』段（issue 链接 + 状态 + owner lead），+ System Status，
  + `@Simba` triage trigger，发**一条文本**到 `STANDUP_CHANNEL`（直接 Discord API + Bot token）。
- 但它是 **per-project**（单项目 `STANDUP_PROJECT_NAME`）、含系统状态和 triage trigger、
  用 `sessions` 表（**没用** `session_completed` 事件里的 `summary`/`route`/`PR` 富信息）、上限 10 条。

**FLY-727 与 standup 的差异**（→ FLY-727 是真正不同的 feature，不是 standup 的重复）:

| 维度 | Daily Standup (GEO-288) | FLY-727 Daily Digest |
|------|------------------------|----------------------|
| 覆盖范围 | **per-project**（单项目） | **fleet-wide**（所有项目，按项目分组） |
| 内容重点 | 系统运营状态 + triage 触发 | 聚焦『谁完成了啥』（PR + 一句话 summary） |
| 数据粒度 | `sessions` 表（status + last_activity） | `session_completed` 事件富 payload |
| 时间 | 3AM | 待定（建议跟 token 日报同节奏 00:35） |
| 受众动作 | 触发 Simba 今日 triage | Annie 一眼看全，无需动作 |

> **可复用的底层工具**（不改 standup，只复用）：`splitDiscordMessage`、`issueLink`、
> `pacificDateString`、`discord-utils.ts` 的 Discord-API 直发模式（`DISCORD_API` + Bot token）。

---

## 3. 方案选项

### 方案 A（推荐）：独立 fleet digest，复用底层工具，不碰 standup
- 新增 `flywheel-comm` 一个 digest 子命令 + `scripts/daily-digest.sh` + `com.flywheel.daily-digest.plist`。
- 聚合器读全 fleet `session_completed`，按项目分组，渲染一条文本，投到一个（**可配置**）频道。
- 复用 `splitDiscordMessage` / `issueLink` / `pacificDateString`；**零改动** standup / token-report。
- ✅ 聚焦、fleet-wide、富信息（summary/route/PR）；✅ scope 干净（不重构相邻系统）；
  ✅ UX 三点全做成 config，Annie 定了改配置即可。

### 方案 B（否决）：把 standup 改成 fleet-wide
- standup 本质 per-project（带系统状态 + triage trigger + 投 per-project STANDUP_CHANNEL）。
  改成 fleet-wide 会破坏它的模型，且违反 scope 纪律（重构相邻系统）。❌

### 方案 C（部分采纳为「关系」选项）：fleet digest 取代 standup 的 completions 段
- fleet digest 上线后，standup 里的 completions 段可只保系统状态（避免两处列完成）。
- 这是**跟 standup 的关系**的一个可选终局，**由 Annie 拍**（见 §4 设计点 5）。不阻塞 A 的实现。

**采纳：方案 A** 作为实现骨架；跟 standup 的关系（并存 / repoint 频道 / 取代 completions 段）= Annie UX 决策。

---

## 4. 待 Annie 拍板的设计点（UX，实现全做成 config）

Lead（Tadashi）已 approve 方向，并正把以下摆到 FLY-727 thread 让 Annie confirm/iterate。
**我按「推荐默认」当工作假设往下写 research/plan，UX 锁定后再 implement。**

1. **推到哪** — 推荐：投到一个**已有**频道（env `FLYWHEEL_DIGEST_CHANNEL` 可配），**不新建独立频道**。
   > Lead flag：Annie 之前说过**不喜欢额外 status board / 独立频道**（倾向进 thread）。
   > 但 fleet digest 天然跨所有 issue，进不了单个 thread → 频道级决策。候选：复用 token 日报频道 /
   > standup 频道 / 一个 founder 状态频道 / DM。**默认可配、不硬编码新频道。**

2. **什么时间** — 推荐：跟 token 日报同节奏 **00:35**（错开 00:30），覆盖**刚过去那一天**。
   独立 plist（不跟 token 耦合），`StartCalendarInterval` 可配。

3. **粒度 / 格式** — 推荐：**一条 Discord 文本消息**，按项目分组，每完成 issue 一行：
   `FLY-XXX 标题 — [route] + PR 链接`（可选截断的一句话 summary）。**不带成本 $**（token 日报已覆盖），
   **带 PR 链接**。纯文本比 HTML 更「一眼看全」、不用点开。超单条 Discord 长度上限时按项目截断 + 尾注计数。

4. **覆盖范围** — 推荐：**全 fleet 所有项目**，按 `project_name` 分组（这就是 fleet-wide 的点）。

5. **跟 ② / standup 的关系** — 推荐：digest = 当天 roll-up 兜底 + 一眼看全；② = 实时到 thread 的细节；
   读同一份 `session_completed` 事件，互补不重复。跟 standup 的关系（并存 / repoint 同一频道 /
   取代其 completions 段）由 Annie 拍（见 §3 方案 C）。

### 4.1 『完成』的定义（Lead 倾向我的推荐，一起给 Annie 确认）
- **主列表**只列真正有产出的（route ∈ `needs_review` / `merged` / `pr_handoff`）。
- **尾注一行**计数：`另有 N 个 no-op/blocked/failed`（避免噪音，但不隐藏事实）。
- 排除 `sessionRole='qa'`（QA session 不算「完成一个 issue」；或单独归一类 —— 待定，倾向排除主列表）。
- 同一 issue 当天多次完成（retry）→ 取当天**最后一次** completion 去重。

---

## 5. 风险 / 开放问题

- **R1 频道决策悬而未决**：`推到哪` 是 Annie UX，未锁定前不 implement 投递目标（做成 env，默认可配）。
- **R2 与 standup 重叠**：需 Annie 明确「并存 / repoint / 取代 completions」，否则可能两处列完成（可接受但需知情）。
- **R3 多 Bridge / 多项目**：fleet-wide 读的是单一 `~/.flywheel/teamlead.db`（主 Bridge StateStore）。
  需确认所有项目的完成事件都落这一个库（token-report 也这么假设，已验证可行）。
- **R4 时区**：`session_completed.ts` 是 UTC；「当天」按 Pacific 计（复用 `pacificDateString`）。
- **R5 字节兼容**：新增 plist/脚本/子命令，`FLYWHEEL_DIGEST_*` env 不设 = 不触发投递（default-off 安全）。

---

## 6. 下一步

→ research.md：确认聚合查询（SQL + 时区边界 + 去重 + role 过滤）、Discord 投递复用点的确切 API、
config/env 契约、字节兼容 sentinel、测试策略。→ plan.md：分步实现（TDD）。→ design_review（Codex）。
implement 等 Annie UX 锁定。
