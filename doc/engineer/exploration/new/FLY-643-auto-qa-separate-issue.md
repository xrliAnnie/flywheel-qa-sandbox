# Exploration: Auto-QA 改用单独 QA·FLY-XX issue — FLY-643

**Issue**: FLY-643 (FLY-579 follow-up — auto-QA 改用『单独 QA·FLY-XX issue』而非同-issue session)
**Date**: 2026-06-28
**Status**: Complete
**Source**: relates FLY-579 (`doc/engineer/plan/inprogress/v1.60.0-FLY-579-global-auto-qa-pipeline.md`)

## 背景

FLY-579 ship 的全局 auto-QA pipeline 用『同-issue sessionRole=qa session』承载 QA —— code-review 过后，在【父 issue 本身】上 spawn 一个 `sessionRole="qa"` 的 runner，共用父 issue 的 `[FLY-XX]` thread。这是昨晚 Annie 睡时 Lead 替拍的 D1。

Annie 醒后明确（D1，2026-06-28）：要用【单独的 QA issue】—— 像手动 `QA·FLY-631/636/641` 那样，自动建一个 `QA·FLY-XX` Linear issue + 它自己的 thread + 它自己的 runner，**取代**同-issue session。

## 为什么（Annie 的诉求）

- 单独 issue = QA 有自己干净的 thread / 工作叙事，不和实现 issue 的对话混在一起。
- 和手动 QA 的形态一致（founder 已经习惯 `QA·FLY-XX` 的样子）。
- 父 issue 的 thread 保持是『实现 + founder 批准 ship』的单一叙事；QA 的细节挪到 QA issue。

## 关键约束（审计 codebase 得出）

1. **生产 `~/.flywheel/projects.json` 的 `linear` 字段全是 `null`**（`ProjectConfig.ts` 注释明确）。所以**不能**靠 per-project `linear` binding 拿 team/project/label 去建 QA issue。→ 改为【读父 Linear issue 镜像】team/project/labels（零新配置、永远和父一致）。
2. `onQaResult` 的链路校验里有一条 `qaSession.issue_id === parent.issue_id` 等值检查 —— QA 一旦换到独立 issue 就会**误拒** verdict。权威绑定其实是 `record.qa_execution_id === 上报的 qaExec`（FLY-579 Codex R1 HIGH-2 加的），它把 verdict 绑死到 record spawn 的那个确切 QA runner，比 issue 等值强。→ 去掉 issue 等值，保留 exec 绑定。
3. `isQaHeld` 键在【父】`execution_id + pr_head_sha`，**不受** QA 换 issue 影响 → 三面抑制（event-route / GatePoller / Heartbeat）零改。
4. QA runner 起在新 issue 上后，Blueprint 的 QA prompt 现在写的 `issueId` 会变成【QA issue 自己】的 identifier → prompt 会说『验证它自己的 QA issue』而非父。→ `QaContext` 加 `parentIssueIdentifier`，prompt 指向父。
5. 新 issue 起 runner 后，`DirectEventSink` 在 `session_started` 自动给它建 `[QA·FLY-XX]` thread —— 不需要手动建 thread。

## Lead 确认的设计（BRAINSTORM GATE，2026-06-28）

理解 + HOW 全部确认，**一处收紧**：

| 消息 | 去向 | 说明 |
|------|------|------|
| 🧪 started | 父 issue thread（轻 FYI） | 让 Annie 看到 feature 进了 QA；配合 FLY-560 🧪QA emoji。引用新 `QA·FLY-XX` issue |
| ✅ ship-ready | 父 issue thread | **唯一真正 ping founder 的那条**；founder 在父 issue 批 ship |
| 🔴 failed | **不进父 thread** | QA 没绿就 ping 父 thread = 违反『QA 绿前不惊动 founder』。failed = Lead-facing → 发到 QA issue 自己的 thread + 唤醒 implementer 驱动 dev-fix→QA-retest loop；只有终态卡死才升级 founder |
| QA 工作叙事（日志/细节） | QA·FLY-XX 自己的 thread | QA runner 自己的输出 |

## 不变量（全部保留）

founder-gating（QA 绿前不惊动）、`isQaHeld`（键在父 exec+sha）、三面抑制、durable `auto_qa_record` + 重启 reconcile、fail-closed `pr_head_sha`、`qa.auto` 默认 OFF（字节兼容）。

## Enable 顺序（Annie 明确）

本改**先落**（仍默认-off），之后 Annie 再 flip `qa.auto=true` → 她拿到的是单独-issue 行为，而非她不要的同-issue 行为。**本 PR 不开 enable。**
