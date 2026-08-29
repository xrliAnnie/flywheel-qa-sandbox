# FLY-1225 thread 状态前缀错标「✅完成」 — 探索

Issue: FLY-1225 (https://linear.app/geoforge3d/issue/FLY-1225/fix-thread-状态前缀错标完成-awaiting-reviewgate-open-被显示成已完成codex-三段式冒烟单)
日期: 2026-07-13
基于: 无

## 1. Bug 现象

Discord issue thread 的标题前缀把还在等 founder 审批的 issue（session status =
`awaiting_review`、approve_to_ship gate 开着）显示成「✅完成」。founder 扫 sidebar
以为做完了，点进去发现还在等审——状态显示撒谎。这是 2026-07-13 通宵那一族
「替身冒充本体」bug 的展示层形态：「✅完成」的牌子冒充「真的完成」。

## 2. 代码审计 — 标题是谁写的

标题前缀有且只有一个生产权威：**FLY-907 unified issue-display refresher**
（`packages/teamlead/src/bridge/issue-display-refresher.ts`，默认开启，
`FLYWHEEL_ISSUE_DISPLAY_REFRESH=0` 才回 legacy path）。它在每个 lifecycle
事件 + GatePoller sweep 时从真实状态**重新推导**三张脸（A 标题 badge /
B 置顶 pipeline header / C 状态行），推导逻辑在纯函数
`packages/teamlead/src/bridge/issue-display.ts`：

- `derivePhaseDisplayState()` — 每个 phase session → `pending|active|done|blocked`
- `deriveIssueTitleBadge()` — 聚合出标题 badge

其他写标题的点都不是权威：

| 写入点 | 行为 | 结论 |
|---|---|---|
| `auto-qa-coordinator.safeStampIssueStage("approve")`（QA 过、founder 被 surface 时打 ⏳待批） | 直接 stamp，但下一次 refresher sweep 会按推导结果**改写覆盖** | 诚实但会被覆盖 |
| `HeartbeatService.stampReconnect`（⚠️重连中 进/出） | clear 时 completed→✅、running→stage badge、其余剥 badge；之后 refresher 会 reconcile | 非本 bug |
| legacy `stampStageEmojiForSession`（escape hatch） | 只在 `FLYWHEEL_ISSUE_DISPLAY_REFRESH=0` 时活 | 非默认路径 |

所以 bug 必然在 `deriveIssueTitleBadge` 的推导里。

## 3. 根因

### 3.1 三段式（flywheel 项目 `pipeline.three_stage: true`，本单验收场景）

`derivePhaseDisplayState` 的映射表（issue-display.ts:79-114）：

- `awaiting_review` / `approved_to_ship` / `design_done` 是 **boundary status**：
  park 探针 `parked`（显式 park 标记）→ `done`；`unknown` → `done`；
  只有显式 `not_parked`（被 wake 过）→ `active`。
- QA runner 出完 verdict 后 park 在 `running` → 显式 parked → `done`。

`deriveIssueTitleBadge` 的聚合（issue-display.ts:157-162）：

```ts
const allExistingDone = [...phaseStates.values()].every((s) => s === "done");
if (allExistingDone && phaseStates.get(lastPhase) === "done") {
    return { kind: "completed" };   // → 标题 ✅完成
}
```

**病灶：per-phase 的「done」语义是「这一段的活交接完了」，聚合层却把
「所有段都交接完」直接当成 issue 级「已 ship ✅完成」。** 三段式的标准
ship-gate 形态恰好全中：

- design：`design_done` + parked → done
- implement：PR 开完、`complete --route needs_review` → `awaiting_review` + parked → done
- qa：verdict PASS 后 park 在 `running` → done

→ 全 done → 标题 ✅完成。**而此刻 approve_to_ship gate 正开着等 Annie。**
这是「标签冒充事实」bug class 的又一实例：display-state `done`（标签）
冒充 terminal status（事实）。真 terminal 只有 `completed`/`merged`
（`PHASE_DONE_STATUSES`），boundary 的 done 是借来的。

即使 auto-qa-coordinator 在 founder release 时诚实地 stamp 了 ⏳待批，
refresher 下一个 sweep tick 就按上面的推导改回 ✅完成——谁也救不了。

### 3.2 单 session（次要、防御性）

`deriveIssueTitleBadge` 空 phaseStates 分支：`status === "completed"` → ✅；
`awaiting_review` → 返回 **runner 自报的 `session_stage`** badge。若 runner
违反协议提前 `stage set completed`（协议里「COMPLETION REPORTING」一节确实
容易诱导），标题同样 ✅完成 而 status 还是 `awaiting_review`。自报 stage
（标签）冒充 status（事实），同族。

## 4. 修法选项

### Option 1（推荐）：聚合层看 raw status，boundary 挡 ✅

`deriveIssueTitleBadge` 增加 per-phase raw status 输入。all-done 分支改为：

1. 任一 phase status = `approved_to_ship` → `{kind:"stage", stage:"ship"}`（🚀ship，已批、ship 进行中/待执行）
2. 否则任一 phase status = `awaiting_review` → `{kind:"stage", stage:"approve"}`（⏳待批）
3. 否则（全部 `completed`/`merged`，或 QA parked-running 等真收尾形态）→ `{kind:"completed"}`（✅照常）

单 session 分支加防御 clamp：status 为 `awaiting_review`/`approved_to_ship` 时
自报 stage=`completed` 不得渲染 ✅，改渲染 `approve`/`ship`。

- 复用现有词表（⏳待批 = FLY-795 语义「等 founder ship 批准」，零新 glyph、
  零新 rename 频率问题）；纯函数改动，零新 I/O；face B/C 不动
  （header 里 per-phase ✅=「该段活交接完」仍然诚实，标题 ⏳待批 + 三行 ✅
  读起来自洽：活都干完了，等你批）。
- `design_done` 不挡 ✅：ship 后 finalization 前 design 还 park 在
  `design_done` 的窗口，✅ 是诚实的（implement 已 merged/completed）。

### Option 2：给 PhaseDisplayState 加 `awaiting` 第五态

改 `derivePhaseDisplayState` 返回新状态，faces B/C 也换 glyph。
改动面大（三张脸 + glyph 词表 + 所有 pinned 测试），且 per-phase 层面
「交接完」显示 ✅ 本身没毛病。**否**。

### Option 3：只修 coordinator stamp 时序 / 让 approve stamp 赢

治标——refresher 是 derive-from-state 的权威，绕过它等于回到 FLY-907 之前
「各写各的、互相打架」。**否**。

## 5. QA-gated 语义核对（Annie 既有裁定：QA 没过别显示待批）

三段式下修后的时间线：

- implement 在 codex code review 窗口（QA phase 还没 spawn）：qa 缺席 →
  不进 all-done 分支 → 标题 🔨实现（现状不变，不是 ✅）
- QA phase 活跃：last-active-wins → 🧪QA（现状不变）
- QA PASS + park、founder surfaced：all-done → **⏳待批**（修复点；修前 ✅完成）
- founder 批准、implement 被 wake 去 ship：`approved_to_ship` + not_parked →
  active → 🔨实现；若 parked 未醒的瞬间 → 🚀ship（修前 ✅完成）
- 真 merge + finalization（status → completed/merged）→ **✅完成**（照常）
- QA FAIL + implement 被 wake rework：implement active → 🔨实现（FLY-543 现状不变）

## 6. 已知不改的相邻毛病（记录，不扩 scope）

- 单 session issue 在「QA 过了等 founder」时标题显示的是 runner 最后自报的
  stage（通常 📬PR已开）：coordinator 打的 ⏳待批 会被 sweep 按自报 stage 改回。
  不是 ✅ 级别的撒谎（📬 也算等待态），推导层要诚实需要 codex-gate/QA 状态
  探针进 refresher，改动面另开 issue 更合适。
- `HeartbeatService.stampReconnect` clear 时 `awaiting_review` 剥成裸标题
  （丢等待态徽章），随后 refresher sweep 会补正——瞬态，不改。
- legacy escape-hatch path（`FLYWHEEL_ISSUE_DISPLAY_REFRESH=0`）沿用自报
  stage，不改。

## 7. 本单第二身份：FLY-1224 Codex 三段式首跑冒烟

本 issue 同时是 per-phase vendor 三段式（design=Fable / implement=Codex
gpt-5.6-sol windowed / qa=Opus）的首跑验证单。对设计的含义：

- 设计文档（本文件族）必须让 **Codex implement 段**拿着就能写：改哪个文件、
  哪个分支、测试怎么补，都要落到函数级。
- 验收含「Annie 能在 cmux 看到 implement 段是真 Codex 窗口」+ 三段交接正常
  ——这属于流程验收，不是代码改动的一部分。
- 真机验收场景（park 在 awaiting_review + gate open 显示等待态）恰好就是
  本 issue 自己走三段式流水线时会经过的状态。
