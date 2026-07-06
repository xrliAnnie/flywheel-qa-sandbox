# FLY-904 QA E2E scratch — FLY-887 R2 真机 529 Room 验证 — Exploration

Issue: FLY-904 (QA E2E scratch — FLY-887 R2 real-machine 529 Room verification, FLY-902 disposable)
日期: 2026-07-06
基于: FLY-902 独立 QA 复验任务;先例 FLY-895/FLY-896(FLY-887 自身早期 QA 轮)、`qa-fly294/`、`qa-fly310/` scratch 目录形态

## 问题是什么

FLY-904 **不是真实功能开发**——它是 FLY-902 独立 QA 会话造出来的一次性(disposable)scratch issue,
唯一目的是在隔离的 529 QA Testing Room slot-2 里驱动一次**真机完整三段式 pipeline**
(design → implement → QA,单分支 `project-slot-2-FLY-904`),让 FLY-902 从外部观测并验证
FLY-887 R2 的三个场景:

1. **keep-alive fix-loop** — QA FAIL → wake 活体 implement 修 → wake 同一 QA 复验 → PASS;
2. **design-redo** — parked 的 design session 被唤醒改设计后再交还;
3. **ship-cleanup** — founder 批准 + verified merge 后统一 `finalizeDone` 收尾三段、删 worktree。

E2E 完成后本 issue 直接关闭/归档,产物永不进真分支(同快照 commit d095fdf 的约定)。

## 设计阶段要回答的唯一问题

三段 pipeline 要有一个「小而真实」的工件让 implement 有东西可 TDD、QA 有合同可有牙地验。
它必须:足够小(pipeline 机制是主角,不是工件本身)、可 TDD、有权威 oracle 可对照、
零生产代码接触、落点遵循 scratch 先例。

## 候选方案

| 方案 | 内容 | 评估 |
|---|---|---|
| A | 平凡字符串工具 | 太无意义;QA 没有权威基线,验证无牙。弃。 |
| B | shell 冒烟脚本 | 不走 vitest,TDD 形态弱;QA 只能看退出码。弃。 |
| **C(选定)** | **纯 TS reducer 模拟 FLY-887 TURN 状态机** | 主题自洽:implement 按 FLY-887 plan.md 权威状态表 TDD 一个 `nextTurn(state, event)` 纯函数;QA 可逐行对照权威表当 oracle。单文件 + 单测,零依赖,零 `packages/` 接触。 |

## Lead brainstorm gate 结论(已批)

- 方案 C 批准;边界确认:设计只产文档、不碰 `packages/`、不接 build 线、
  **不预埋 bug**(fix-loop / design-redo 由 harness/Lead 驱动,非设计预埋)。
- Lead 追加两点硬要求(已折进 plan.md):
  1. 权威状态表**每一个 transition**(含 keep-alive 分支)映射成一条 vitest case,
     **非法/越界 event 也要有 case**——QA 拿状态表当 oracle 逐行对照;
  2. 文档落点 `engineering/doc/FLY-904-qa-e2e-529-room/`,沿用 FLY-887 同仓先例形态。

## 边界(不做什么)

- 不改 `packages/` 下任何文件;不接 pnpm workspace / build 线(standalone `.mts` + vitest 直跑)。
- 不预埋故意缺陷;不模拟 Bridge/CommDB 真实读写——reducer 是 FLY-887 **协议语义**的纯函数镜像,
  不是其实现的重写。
- 设计阶段零实现代码;commit 文档后 `complete --route phase_design_complete` + park。
