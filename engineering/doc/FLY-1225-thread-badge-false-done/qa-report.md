# FLY-1225 thread 标题假「✅完成」— 独立 QA 报告

Issue: FLY-1225 (https://linear.app/geoforge3d/issue/FLY-1225/fix-thread-状态前缀错标完成-awaiting-reviewgate-open-被显示成已完成codex-三段式冒烟单)
日期: 2026-07-14
基于: plan.md / research.md / exploration.md（同文件夹，implement 段产出）

## VERDICT: PASS

被测对象：PR #587 @ `aaf9b2837de889244bf68273adbf71dc65ff8d4a`（= PR headRefOid = Codex code review approved 的同一 sha，逐字核对过）。

QA 独立性：本报告作者不是 #587 的作者（#587 由 implement 段 Codex `gpt-5.6-sol` 产出，exec `70c90e64`）。

## 一、根因（独立复核，不是转述 plan）

thread 标题走 `deriveIssueTitleBadge`。两条路径都会把「等审」渲染成「✅完成」：

1. **单-session 路径**：直接把 runner **自报的** `session_stage` 当真。runner 按 COMPLETION REPORTING 规则跑 `stage set completed`，但 `status` 还是 `awaiting_review`（gate 开着）→ 标题 ✅完成。
2. **三段式聚合路径**：各 phase 的 `awaiting_review` 被 `derivePhaseDisplayState` 判成 `done` → 全 done 聚合成 `{kind:"completed"}` → 同样假 ✅。

**这是「标签冒充事实」的展示层形态**：`session_stage` 是 runner 自己贴的标签，`status` 才是耐久事实；旧代码让标签压过了事实。

## 二、生产实证（bug 是真的，不是理论）

只读 `~/.flywheel/teamlead.db`：

| status | session_stage | 行数 |
|---|---|---|
| awaiting_review | completed | 11 |
| approved_to_ship | completed | 1 |

## 三、验收结果

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| ① | awaiting_review + gate open → 等待态 | PASS | 真 Discord + 真库 |
| ② | approved_to_ship → 🚀ship | PASS | 真 Discord + 真库 |
| ③ | 真 completed 照常 ✅完成 | PASS | 真 Discord + 真库 |
| ④ | 三段式聚合路径同验 | PASS | 真库 102 个三段式 issue |

### ① 真 Discord E2E（隔离 529 房 cos-test）

驱动**真** `ChatThreadCreator` 写标题 → 再从 Discord API **读回**线程名（ground truth，不是自报）。每个场景一个新线程（Discord 硬限 2 改名/10min/线程）。

| 场景 | 真 Discord 标题读回 |
|---|---|
| 修前公式 · awaiting_review | `✅完成 [QA-1225] Codex 三段式冒烟 case1` ← **谎被复现出来** |
| #587 · awaiting_review | `⏳待批 [QA-1225] Codex 三段式冒烟 case2` |
| #587 · approved_to_ship | `🚀ship [QA-1225] Codex 三段式冒烟 case3` |
| #587 · 真 completed | `✅完成 [QA-1225] Codex 三段式冒烟 case4` |

证据线程（保留至 Annie 验收完，勿删）：`1526817309723852933` / `1526817318062129247` / `1526817327021031447` / `1526817336076795924`。

### ②③ 真生产数据回归（单-session）

432 行真 session 跑一遍修前/修后：**修前撒谎 10 行 → 修后全治；422 行逐字不变**（无误伤）。

修好的真 issue：GEO-360 / GEO-351 / LEARN-136 / LEARN-80 / LEARN-157 / LEARN-158 / LEARN-160 / LEARN-123 → 全部 ✅完成 → ⏳待批；LEARN-123（approved_to_ship）→ 🚀ship。
已经正确的（stage=approve / pr_created）不变；400+ 真 completed 行仍 ✅完成。

### ④ 三段式聚合（真库 102 个三段式 issue）

修前假 ✅完成 → 修后 ⏳待批：**FLY-1082 / FLY-1160 / FLY-1255**（三个都是 implement/qa 停在 `awaiting_review`、gate 开着的真形态）。其余 99 个逐字不变。

## 四、测试真伪 —— 突变验证（不敢只信「绿」）

PR head 上 58/58 绿。但绿测不等于抓得住 bug，所以逐条撤掉修复、测试留着：

| 撤掉的修复 | 结果 |
|---|---|
| 单-session guard | 1 条红：`expected { kind:'stage', stage:'completed' } to deeply equal { kind:'stage', stage:'approve' }` ← 正是 bug 形态 |
| 三段式 ship-evidence guard | 6 条红（含 `IssueDisplayRefresher` 集成用例） |

**结论：回归测试是真的，不是空转。** 撤掉修复后立刻红，且红出的正是这张单要修的形态。

## 五、主动排查的两个坑（都不是坑）

1. **「三段式要正向 ship 证据才给 ✅」会不会让真 merge 的 issue 永远卡 ⏳？**
   不会。`post_ship_finalization_claim` 在生产 `session_events` 真有 **113 行**；`countEventsByIssueAndType` 读的正是同一张表。另有「全 phase 终态（completed/merged）」兜底。证据路径是活的，不是死码。

2. **fingerprint 加了 `fc` key → 上线时全量重算，会不会把上百个 thread 全 rename 撞 Discord 限速？**
   不会。**实测**：对已正确的线程重复 stamp 同一 badge，writer 返回 `noop`、不发 PATCH。只有真错的那十几个会改名。

## 六、其它

- CI：Build & Test pass；mergeable = MERGEABLE / CLEAN。
- Codex code review：approved，`target_pr_head_sha` 与当前 head 逐字一致。
- 本 QA 未改任何产品代码；改动只有本文件。

## 七、三段式冒烟（本单第二身份，如实报）

| 段 | 模型 | 结果 |
|---|---|---|
| design | claude-fable-5 | `design_done` 正常 |
| implement | gpt-5.6-sol (Codex) | 最终产出 #587；但前面 **4 blocked + 1 failed** 才成 |
| qa | claude-opus-4-8 | 该 session `terminated` |

两个值得回 FLY-1224 的交接问题：

1. **implement 段重试 5 次**才产出 PR —— per-phase vendor 能跑通，但首跑不平顺。
2. **QA 段派单错位**：qa session 被 terminated 后，接手的 session（本 session）被派成 `role=main` 却拿到 **implement 提示词**，worktree 却叫 `-qa`。照提示词做会产出与 #587 冲突的竞争 PR —— 已在 brainstorm gate 拦下，由 Tadashi 裁决改做独立 QA。

## 八、结论

四条验收全部 PASS，证据为真库 + 真 Discord 读回 + 突变验证，非「测试绿」背书。**建议 ship #587**。
