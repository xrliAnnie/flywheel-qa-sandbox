# FLY-2408 Ship gate 标题标记 — 实施计划
Issue: FLY-2408 (https://linear.app/geoforge3d/issue/FLY-2408/discordthread-标题-到-ship-gate-的单要有专属状态标记让-founder-一眼看出哪些在等她-founder)
日期: 2026-09-07
基于: research.md

> **For agentic workers:** 逐 task 严格执行 failing test → 最小实现 → focused green → commit；不得修改 gate、approve 识别或其他 display face。

**Goal:** 任意活动 workflow run 在 approval/founder gate 等待 founder 时，Discord issue thread 标题稳定显示 `🔔 ⏳待批`，保留 model marker；批准或 design/implement/qa 返工后自动移除 bell。

**Architecture:** `IssueDisplayRefresher` 对所有 workflow 类型读取 active run 的 immutable snapshot + `current_node_id`，并与现有 approval-wait aggregate 一起派生唯一的 founder-gate title state。两种信号都映射到同一个 `🔔 ⏳待批`，避免 workflow/session 写入顺序产生额外 rename；现有 badge 规则一旦派生到 ship 就优先退出。`stage-utils` 可逆解析 compound prefix，现有 `ChatThreadCreator` 继续负责 model marker、100 字符预算、no-op 与 coalescing。active run identity/node 进入现有 display fingerprint，使 sweep 与重启可重算。

**Tech Stack:** TypeScript、Vitest、StateStore(SQLite)、Discord REST title writer、pnpm monorepo。

---

## 锁定决策与范围

- Lead 指令 `[lead-instruction f3313216-8fb2-4bf1-9a5d-2aee531b08db]` 已锁定行首 `🔔`；不生成候选或 founder HTML 选型卡。
- Gate 标题固定为 `🔔 ⏳待批 [model] [FLY-2408] …`。`🔔` 不替换现有 `⏳待批` 或 model marker。
- 只改 title renderer/status mapping：`issue-display.ts`、`issue-display-refresher.ts`、`stage-utils.ts` 及 focused tests；不新增 StateStore API/schema，不重构 writer。
- 不改 workflow transition、gate materialization、founder verdict/approve 识别、Discord 卡片、pipeline header/status line。

## 首轮设计审查修正

- 不再用 `latestPhase.length > 0` 限制 active-run 查询；main-role 的 `tpl_prd`、`tpl_design`、`tpl_prototype`、generic-menu 也必须显示 bell。
- Gate attention 可包在 stage-kind path 上；不只支持 phase badge。
- 横切优先级锁定为 `🔴 blocked > ⚠️ reconnecting > 🔔 founder wait`；除 blocked/reconnect 和持久批准外，active gate 覆盖 phase、main stage 与历史 conclusion 等所有 base badge。
- Gate overlay 使用 deny-list：覆盖所有 base badge，只有 blocked、reconnect ownership、当前持久 `approved_to_ship` 三个例外；过早 `session_stage=ship` 不算退出事实。持久状态只控制 bell 是否退出，不改变 base badge 的既有映射。
- Active gate 与 legacy approval-wait aggregate 产生字节相同的标题，批准过渡不会出现 `🔔 → ⏳ → 🚀` 三连 rename。
- Focused 命令改用 `pnpm --filter flywheel-teamlead exec vitest run <paths>`，并包含 legacy `stage-status-emoji.test.ts`。
- 复用现有 `getActiveWorkflowRunForIssue`；不为性能 advisory 扩张 StateStore 范围。同步修正 fingerprint 的 literal Pick test stub。
- 回滚时先保留 compound parser 并清理已写标题，再回退 parser，避免 bell 残留。
- R3 已用完；Lead 采纳 HIGH 并就地处理 LOW，明确不开放 R4。以下 deny-list 与测试矩阵冻结，进入 TDD。

### Task 1: 锁定可逆的 `🔔 + 主 badge` 语法

**Files:**
- Modify: `packages/teamlead/src/bridge/__tests__/stage-utils-badge.test.ts`
- Modify: `packages/teamlead/src/__tests__/stage-status-emoji.test.ts`
- Modify: `packages/teamlead/src/bridge/stage-utils.ts`

- [ ] 写红测：

```ts
expect(splitStatusEmoji("🔔 ⏳待批 [G] [FLY-2408] title")).toEqual({
  attentionEmoji: "🔔",
  emoji: "⏳",
  word: "待批",
  base: "[G] [FLY-2408] title",
});
expect(stripStatusEmojiPrefix("🔔 ⏳待批 [G] [FLY-2408] title"))
  .toBe("[G] [FLY-2408] title");
expect(stripStatusEmojiPrefix("🔔 literal title")).toBe("🔔 literal title");
expect(founderGateAttentionBadge("⏳待批")).toBe("🔔 ⏳待批");
```

- [ ] 红测：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/stage-utils-badge.test.ts \
  src/__tests__/stage-status-emoji.test.ts
```

Expected: helper/export 与 compound parser 尚不存在而 FAIL。

- [ ] 最小实现：新增 `FOUNDER_GATE_ATTENTION_EMOJI` 与 `founderGateAttentionBadge(primaryBadge)`。把单主 badge 解析抽成内部 helper；仅当 `🔔` 后紧跟已注册 stage/phase badge 时才把它视为受管 overlay，否则保留手工 `🔔 literal title`。
- [ ] 同命令绿测。
- [ ] Commit: `feat(teamlead): parse founder gate title attention`

### Task 2: 将 approval gate 真相与 run node 纳入 renderer fingerprint

**Files:**
- Modify: `packages/teamlead/src/bridge/__tests__/issue-display-refresher.test.ts`
- Modify: `packages/teamlead/src/bridge/issue-display-refresher.ts`

- [ ] 写红测：
  - immutable snapshot 的 approval gate 与 `current_node_id` 相等时 helper 为 true；离开、inactive、missing/malformed snapshot 都 fail-closed。
  - 只有 active run `current_node_id` 改变时，`computeSessionsFingerprint` 必须改变。
  - 没有 phase session 的 main-role workflow 也读取 active run，不能以 `getLatestPhaseSessionsForIssue` 为 guard。
  - 更新 fingerprint Pick 的 literal test stub，使它显式提供 `getActiveWorkflowRunForIssue`。

- [ ] 红测：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/issue-display-refresher.test.ts
```

Expected: approval-gate helper 尚不存在，fingerprint 不随 run node 改变。

- [ ] 最小实现：
  - 用 `parseWorkflowRunSnapshot` + `workflowApprovalGate(snapshot.manifest).node` 派生 `isWorkflowApprovalGateCurrent`，不写死 `founder_gate`。
  - `computeSessionsFingerprint` 的 store contract 加 `getActiveWorkflowRunForIssue`，JSON 加 active run 的稳定 `{id,node}` 或 `null`。
  - refresh 对每个 issue 只读取一次 active run并复用，不受 phase rows 限制。
- [ ] 同命令绿测。
- [ ] Commit: `feat(teamlead): fingerprint workflow approval gate state`

### Task 3: 纯派生统一 gate 与过渡期状态

**Files:**
- Modify: `packages/teamlead/src/bridge/__tests__/issue-display.test.ts`
- Modify: `packages/teamlead/src/bridge/issue-display.ts`

- [ ] 写红测，为新纯函数 `deriveFounderGateTitleState` 覆盖：
  1. design/implement/qa phase 全 done-like + `awaiting_review`、active gate → `{ badge: approve, attention: true }`。
  2. base 为 active phase + active gate → 同一输出；`phaseStates.size===0`、base 为任意 main stage + active gate → 同一输出。
  3. `issueConcluded=true` / 历史 finalization + active gate → 仍是 bell+approve，不得是 completed。
  4. base badge 为 blocked + active gate → blocked、attention=false。
  5. run node 先离开但 base badge 仍是 `stage=approve` → 仍是同一 bell+approve；同时覆盖 phase aggregate 与 legacy single-session `mainSessionStage=completed/status=awaiting_review`。
  6. 当前持久 status 为 `approved_to_ship` 时，即使 node 尚在 gate也保持 base badge、attention=false：正常 completed-stage 路径仍是 ship；`main stage=pr_created/status=approved_to_ship` 仍保持现有 `pr_created`，不扩大 base mapping。
  7. `main stage=ship/status=running` + active gate → bell+approve，证明过早/短暂 stage 标签不能压铃。
  8. design/implement/qa active 返工 → 原有对应 phase、attention=false。

- [ ] 红测：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/issue-display.test.ts
```

- [ ] 最小实现：
  - 先调用现有 `deriveIssueTitleBadge` 得到 base badge。
  - base badge 是 blocked 时原样返回，无 attention。
  - 当前持久 session status 含 `approved_to_ship` 时原样返回 base badge，无 attention；不重新派生或扩大 ship mapping。
  - 其次 active approval gate 覆盖其余所有 base badge，强制 `stage=approve` + attention。
  - 再次把 base badge 已是 `stage=approve` 的 phase aggregate 与 legacy single-session approval wait 映射到同一 attention state。
  - 其余原样返回 base badge；不改现有 phase/stage 算法。
- [ ] 同命令绿测。
- [ ] Commit: `feat(teamlead): derive founder gate title state`

### Task 4: 在生产 renderer 叠加 bell，覆盖所有 workflow 与退出路径

**Files:**
- Modify: `packages/teamlead/src/bridge/__tests__/issue-display-refresher.test.ts`
- Modify: `packages/teamlead/src/bridge/issue-display-refresher.ts`

- [ ] 写生产调用点红测：
  - phase workflow 在 gate 调用 writer 时得到 `stage=""`、`phaseBadge="🔔 ⏳待批"`。
  - base 仍是 active phase 的 gate run 同样得到 bell；这是 R3 HIGH 的直接回归。
  - 没有 phase rows 的 main-role workflow 在 gate 得到完全相同的 title badge。
  - historical `issueConcluded` + active gate 仍显示 bell，而不是 completed。
  - blocked session + active gate 保持 `🔴受阻` 且无 bell。
  - reconnect ownership + active gate 保持现有 `⚠️重连中`，title writer defer/no-call 且无 bell。
  - 持久 `approved_to_ship` + gate 无 bell：正常 completed-stage 路径走 `stage=ship`；`pr_created + approved_to_ship` 保持 `pr_created`，证明只控制 overlay。
  - `stage=ship/status=running` + gate 仍写 `🔔 ⏳待批`，证明标签不能冒充持久批准。
  - 更新现有 “qa PASS holding ship gate” 与 “merge_block without post-ship claim” 两条无 run 断言：legacy approval wait 预期从 `stage=approve` 变为 `phaseBadge="🔔 ⏳待批"`。
  - `it.each(["design","implement","qa"])` 将 run 离开 gate且对应 session wake/active，分别恢复 `🎨设计`、`🔨实现`、`🧪QA`，无 bell。
  - header/status-line 断言保持原值，证明只改 title face。

- [ ] 红测：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/issue-display-refresher.test.ts
```

- [ ] 最小实现：
  - refresh 把 active run gate bool 传给 `deriveFounderGateTitleState`。
  - attention=true 时通过既有 `stampStageEmojiResult(..., "", withWord, founderGateAttentionBadge(stageBadge("approve", withWord)!))` 写入。
  - 现有 reconnect guard 仍在 badge 写入之前；blocked 分支仍在 attention 分支之前。除明确给 legacy `stage=approve` 加 bell 外，其余非 attention 分支字节不变。
- [ ] 同命令绿测。
- [ ] Commit: `feat(teamlead): show bell at founder ship gate`

### Task 5: 真实 title writer 的残留、模型、长度与幂等

**Files:**
- Modify: `packages/teamlead/src/__tests__/ChatThreadCreator.test.ts`
- Production writer 仅在测试揭示 parser/writer 边界缺口时最小修改。

- [ ] 写红测：
  1. 当前 `🔔 ⏳待批 [G] [FLY-2408] title`，返工 stamp `🔨实现` 后 PATCH body 精确为 `🔨实现 [G] [FLY-2408] title`。
  2. 当前与目标均为 `🔔 ⏳待批 [G] …` 时只有 GET、无 PATCH。
  3. 200 字符 tail 在 gate stamp 后 `.length === 100` 且前缀 `🔔 ⏳待批 [G] [FLY-2408]` 完整。
  4. 从普通 badge 进入 bell 时只发一次目标 PATCH。

- [ ] 红/绿命令：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/ChatThreadCreator.test.ts
```

- [ ] 若 Task 1 已让新断言直接绿色，先临时使用可证伪反向期望确认测试可捕获残留，再恢复正确期望；提交不得保留反向断言。
- [ ] Commit: `test(teamlead): pin founder gate title transitions`

### Task 6: 回归、全仓 gates 与代码评审

- [ ] Focused（必须包含 legacy parser suite）：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/bridge/__tests__/stage-utils-badge.test.ts \
  src/__tests__/stage-status-emoji.test.ts \
  src/bridge/__tests__/issue-display.test.ts \
  src/bridge/__tests__/issue-display-refresher.test.ts \
  src/__tests__/ChatThreadCreator.test.ts
```

Expected: 5 files PASS、focused 零 skip。

- [ ] Package：

```bash
pnpm --filter flywheel-teamlead build
pnpm --filter flywheel-teamlead test:run
```

如 package suite 有既有 skip，精确报告，不能写成 focused zero-skip 或 full green 的替代证据。

- [ ] 注入的全仓 gates：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

检查并运行本分支新增的 `scripts/__tests__/*.test.sh`；预计无新增。不得把 harness/instrumentation failure 写成产品失败。

重型套件排除真实 GUI `**/tmux-viewer.macos.test.ts`；若注入命令无法排除且会启动真实 Terminal，停止并如实报告 harness 边界，不以窄测替代全 gate。

- [ ] 代码评审：不得运行 raw `codex exec`。执行：

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js gate review_code \
  --lead flywheel-eng-lead \
  --exec-id 9be71e8c-315d-4076-bad7-76c40b1aed7f \
  --no-block "Code review requested for FLY-2408"
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js request-review \
  --type code --question-id <captured-question-id>
```

轮询 `check <questionId>`；CHANGES_REQUESTED 修 blocking findings并开新 gate/review。APPROVED with advisories 用 `ask --report` 转给 Lead。

### Task 7: Milestone、PR 与 implementation handoff

- [ ] 用 comm CLI 把 progress 推到最终 cursor。
- [ ] 按 `engineering/doc/milestones/README.md` 新建 `engineering/doc/milestones/FLY-2408.md`，记录范围、测试、review 与未验证的真实手机截图边界。该 milestone 是 PR 前 literal last commit；不改 `CLAUDE.md`。
- [ ] 普通 fast-forward push feature branch，开 PR。PR body 必须说明：
  - `🔔 ⏳待批` 与 all-workflow mapping；
  - approve 与 design/implement/qa kickback；
  - model/100-char/idempotence/fingerprint evidence；
  - parser rollback ordering；
  - full gate 真实结果与手机截图留给授权 QA。
- [ ] 发送 Lead instruction receipt：

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js ask \
  --lead flywheel-eng-lead \
  --exec-id 9be71e8c-315d-4076-bad7-76c40b1aed7f \
  --report "DONE: [lead-instruction f3313216-8fb2-4bf1-9a5d-2aee531b08db] implemented line-leading bell at founder gate for all workflow shapes, preserved the existing wait/model markers, and covered approval plus design/implement/qa kickback | commits: <implementation shas> | PR: <url>"
```

- [ ] 完成：

```bash
node /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js complete \
  --route needs_review --pr <PR-number>
```

不 dispatch QA、不请求 ship approval、不 merge、不 deploy。

## 验收映射

| 验收 | 证明 |
|---|---|
| 任意 run 到 founder gate 一个 reconcile 周期内出现 `🔔` | unconditional active-run lookup + phase/main production tests + run-node fingerprint sweep |
| Founder 批准后移除 | explicit `approved_to_ship` priority + writer exact PATCH |
| design/implement/qa 打回移除并恢复 | parameterized refresher matrix + compound parser residual test |
| 阶段/model 不丢、≤100、幂等 | `🔔 ⏳待批` 保留既有 primary/model + writer payload/length/no-PATCH tests |
| 重启后一致 | run id/node fingerprint + derive-from-state sweep |
| 手机侧栏实测截图 | implementation 不改生产、不冒用 founder；DAG QA 在授权环境完成真实 Discord screenshot |

## 自检

- Scope：没有 gate/approve/StateStore schema/API/notification 改动，没有候选 HTML。
- Priority：bell deny-list 只有 `🔴 blocked`、`⚠️ reconnect ownership`、持久 `approved_to_ship`；短暂 ship label 不能退出。
- Transition：entry 两种信号同值；持久批准退出但不改 base mapping；kickback 无中间 legacy approve rename。
- Coverage：phase、main-role、legacy single-session、blocked、reconnect、historical conclusion、approval lag、三类返工、parser、model、100-char、no-op、restart fingerprint 都有生产路径或纯函数测试。
- Rollback：先 cleanup/restamp，后移除 parser；不遗留 `🔔` base。
