# FLY-904 — Research: FLY-887 R2 权威协议提取(reducer oracle)

Issue: FLY-904
日期: 2026-07-06
来源: `engineering/doc/FLY-887-phase-session-keepalive/plan.md`(权威状态表 + 时序图)、
`exploration.md` R2.2/R2.3(TURN 机制定案)

## 1. 权威状态表(FLY-887 plan.md「Annie 六条」原表)

| 时刻 | design | implement | QA | TURN 持有者 |
|---|---|---|---|---|
| 设计中 | running | — | — | design |
| 实现中 | design_done + parked | running | — | implement |
| QA 中 | parked | awaiting_review + parked | running | QA |
| FAIL 修复中 | parked | woken 修复 | running + parked(等 RE-TEST) | implement |
| 复验中 | parked | 重新 parked | woken 复验 | QA |
| founder 批准→ship | parked | parked | approved_to_ship → ship | QA |
| merged 收尾 | finalizeDone→completed→关 | 同左 | completed→关 | —(worktree 此刻才删) |

## 2. TURN 协议要点(R2.2/R2.3 提取,reducer 需镜像的语义)

- **授予/交还全落在既有 pipeline 信号上,零新事件类型**:
  - `phase_design_complete` — design 交还 → 授予 implement(epoch+1);
  - `needs_review` — implement 交还 → 授予 QA(epoch+1);首次与 fix 后 RE-TEST **同一信号**;
  - `qa-result fail` — QA 交还 → 授予 implement 修复(epoch+1);**fix 循环 cap = 3 轮**,
    超 cap → refuse + 升级 Lead(不翻转 TURN);
  - `qa-result pass` — 进 approve gate,**TURN 留在 QA** 直到 ship;
  - verified merge → 统一 finalizeDone:三段全关、删 TURN 行、**此刻才删 worktree**。
- **不变量**(时序图明示):任一时刻 TURN 只指向一个 phase,其余 parked 不碰 worktree;
  epoch 每次授予严格递增;worktree 生命周期 = issue 生命周期(创建一次、ship 后才删)。
- **design-redo**(FLY-904 要验的场景 2):design 完成后是 parked 活体(design-context holder),
  可被 Lead 唤醒改设计;其交还信号仍是再一次 `phase_design_complete`(同信号复用,与 RE-TEST 同理)。
- **非法输入语义**:非 TURN 持有者发交还信号、或在错误状态发事件,协议上不该发生
  (runner 有 `turn` 自查 belt);reducer 把它显式建模为**拒绝且状态不变**——这正是 QA 的
  越界 case 素材(Lead gate 要求)。

## 3. 落点与工具链先例

- scratch 目录先例:`qa-fly294/`(`.mts` 模块 + QA 报告)、`qa-fly310/`(脚本群 + 报告)——
  均为仓库根平级目录,不接 workspace。FLY-904 采用 `qa-fly904/`。
- 测试:仓库已有 vitest(pnpm workspace 根)。standalone `.mts` 可用
  `npx vitest run qa-fly904/` 直跑,无需登记 package。
- 文档:`engineering/doc/<ISSUE>-<slug>/{exploration,research,plan,progress}.md`,
  抬头 = 标题 + Issue/日期/基于 三行(FLY-887 先例形态,Lead gate 确认)。

## 4. 结论

reducer 的完整合同(状态形状、事件集、每条 transition、非法 case、不变量)
可全部从 §1/§2 机械推导——见 plan.md §2「reducer 合同」与 §3「测试映射表」。
