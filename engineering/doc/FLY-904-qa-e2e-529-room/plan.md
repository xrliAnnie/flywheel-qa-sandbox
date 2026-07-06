# FLY-904 QA E2E scratch — 实施计划(turn-reducer)

Issue: FLY-904 (QA E2E scratch — FLY-887 R2 real-machine 529 Room verification, FLY-902 disposable)
日期: 2026-07-06
基于: exploration.md(Lead brainstorm gate 已批方案 C)+ research.md(FLY-887 R2 权威协议提取)
状态: design 阶段产出;本 issue 为一次性 scratch,产物永不进真分支

## 1. 定案(Lead gate 已批)

implement 阶段在仓库根新建 `qa-fly904/`(镜像 `qa-fly294/`、`qa-fly310/` 先例),
TDD 一个**纯 TypeScript reducer** 镜像 FLY-887 R2 的 TURN 协议语义:

- `qa-fly904/turn-reducer.mts` — 纯函数 `nextTurn(state, event)`,零依赖、零 I/O;
- `qa-fly904/turn-reducer.test.mts` — vitest 单测,**权威状态表每条 transition 一条 case,
  非法/越界 event 也各有 case**(Lead gate 硬要求);
- 不碰 `packages/`、不接 pnpm workspace/build 线;测试用 `npx vitest@3.2.4 run qa-fly904/` 直跑。

QA 阶段的 oracle = `engineering/doc/FLY-887-phase-session-keepalive/plan.md` 的权威状态表
(research.md §1 有逐字转录)——逐行对照 reducer 行为即可有牙地判 PASS/FAIL。

## 2. reducer 合同

### 2.1 状态形状

```ts
type Phase = "design" | "implement" | "qa";
type PhaseStatus = "absent" | "running" | "parked" | "closed";

interface TurnState {
  turn: Phase | null;        // TURN 持有者;仅 finalize 后为 null
  epoch: number;             // 每次授予 +1,严格递增;初始 1(design 首授)
  design: PhaseStatus;       // 初始 "running"
  implement: PhaseStatus;    // 初始 "absent"
  qa: PhaseStatus;           // 初始 "absent"
  verdict: "none" | "pass";  // qa-result pass 后置 pass(approve gate 挂起态)
  fixRounds: number;         // qa_fail 记账;cap = 3
  worktreePresent: boolean;  // 初始 true;仅 merged 收尾时翻 false
}

const FIX_ROUNDS_CAP = 3;

// 初始态(design dispatch + TURN epoch 1):
export const initialState: TurnState = {
  turn: "design", epoch: 1, design: "running", implement: "absent",
  qa: "absent", verdict: "none", fixRounds: 0, worktreePresent: true,
};
```

### 2.2 事件集(全部对应 FLY-887 既有 pipeline 信号,零新事件类型)

```ts
type TurnEvent =
  | { type: "phase_design_complete" }  // design 交还(首次 与 design-redo 后同信号)
  | { type: "needs_review" }           // implement 交还(首次 与 fix 后 RE-TEST 同信号)
  | { type: "qa_fail" }                // QA 交还 → 修复循环
  | { type: "qa_pass" }                // 进 approve gate,TURN 留 QA
  | { type: "design_redo" }            // Lead 唤醒 parked design 改设计(场景 2)
  | { type: "merged" };                // verified merge → 统一 finalize(场景 3)
```

### 2.3 返回形状(非法输入显式拒绝、状态不变)

```ts
type TurnResult =
  | { ok: true; state: TurnState }
  | { ok: false; reason: "not_your_turn" | "bad_state" | "fix_cap_exceeded"; state: TurnState };
// ok:false 时 state === 入参 state(引用相等,零变异);nextTurn 不得变异入参。
```

### 2.4 Transition 表(权威;implement 逐行实现)

| # | 前置(guard) | 事件 | 后置 | epoch |
|---|---|---|---|---|
| T1 | turn=design ∧ design=running | `phase_design_complete` | design→parked;implement→running;turn→implement | +1 |
| T2 | turn=implement ∧ implement=running ∧ qa=absent | `needs_review` | implement→parked;qa→running;turn→qa | +1 |
| T3 | turn=qa ∧ qa=running ∧ **verdict=none** ∧ fixRounds<3 | `qa_fail` | fixRounds+1;qa→parked;implement→running(wake);turn→implement | +1 |
| T4 | turn=implement ∧ implement=running ∧ qa=parked | `needs_review`(RE-TEST) | implement→parked;qa→running(wake);turn→qa | +1 |
| T5 | turn=qa ∧ qa=running | `qa_pass` | verdict→pass;各 phase 状态与 TURN **均不变**(approve gate 挂起) | 不变 |
| T6 | verdict=pass | `merged` | design/implement/qa 全部(≠absent 者)→closed;turn→null;worktreePresent→false | 不变 |
| T7 | design=parked ∧ verdict=none ∧ 当前 running 者(若有)先 park | `design_redo` | design→running;原 running phase→parked;turn→design | +1 |
| T8(redo 交还) | turn=design ∧ design=running ∧ implement≠absent | `phase_design_complete` | design→parked;implement→running(wake);turn→implement | +1 |

守卫细节:
- T3 在 `fixRounds === 3` 时 → `{ok:false, reason:"fix_cap_exceeded"}`(refuse + 升级 Lead 的镜像;TURN 不翻转)。
- T1 与 T8 同一事件名,按 `implement` 是否 `absent` 区分 spawn(T1)/wake(T8)——镜像 wake-or-spawn。
- T7 的「原 running 者」在真实时序里只可能是 implement(QA running 时 design-redo 不是 887 定义的场景);
  若 qa=running 时收到 `design_redo` → `{ok:false, reason:"bad_state"}`。

### 2.5 非法/越界事件(全部 `ok:false`、状态零变化)

| # | 场景 | reason |
|---|---|---|
| X1 | 非 TURN 持有者的交还信号(如 turn=implement 时收 `qa_fail`) | `not_your_turn` |
| X2 | 事件归属 phase 正持 TURN 但状态不满足 guard(如 design=running 而非 parked 时收 `design_redo`) | `bad_state` |
| X3 | fixRounds=3 时的 `qa_fail` | `fix_cap_exceeded` |
| X4 | verdict=none 时的 `merged`(未过 approve gate 不得 finalize) | `bad_state` |
| X5 | finalize 后(turn=null)的任何事件 | `bad_state` |
| X6a | verdict=pass 后的 `design_redo`(ship 挂起期不得回卷) | `bad_state` |
| X6b | verdict=pass 后的 `qa_fail`(ship 挂起期不得回卷;**优先于 T3**,见优先级 0.5) | `bad_state` |

拒绝理由**判定优先级**(消除 X 类之间的歧义,implement 按此顺序写 guard):
0. `bad_state` — turn=null(已 finalize,X5)时任何事件,先于一切判定;
0.5. `bad_state` — verdict=pass 时的 `qa_fail` 或 `design_redo`(X6a/X6b),**先于 T3/T7 的任何授予判定**——ship 挂起期绝不回卷,这也是 T3 guard 加 verdict=none 的原因(双保险,两侧测试都要有);
1. `fix_cap_exceeded` — 仅 `qa_fail` 且 turn=qa ∧ qa=running ∧ verdict=none ∧ fixRounds≥3 时;
2. `not_your_turn` — 交还型事件(`phase_design_complete`/`needs_review`/`qa_fail`/`qa_pass`)
   的归属 phase(design/implement/qa/qa)≠ 当前 turn 时;
3. `bad_state` — 其余一切 guard 不满足(含 `design_redo`/`merged` 这类无归属 phase 的 Lead/系统事件)。

### 2.6 不变量(每条测试后断言,可提公共 helper)

- I1:任一时刻 `running` 状态的 phase ≤ 1,且(finalize 前)= TURN 持有者;
- I2:`epoch` 只增不减,且仅在授予型 transition(T1-T4/T7/T8)+1;
- I3:`worktreePresent` 从初始到 `merged` 恒为 true,`merged` 后恒为 false;
- I4:`ok:false` 时返回的 state 与入参**引用相等**;且**一切调用**(ok:true 与 ok:false)
  均不得变异入参——公共测试 helper 在每次调用前对入参做 deep-clone 快照(或 `Object.freeze`),
  调用后 deep-equal 断言入参逐字未变(Codex R1 #2:仅靠引用相等只护住 ok:false 半边)。

## 3. 测试映射表(Lead gate 硬要求:transition 与非法 case 全覆盖)

vitest case 与 §2.4/§2.5 一一对应,命名前缀对齐行号,QA 拿表核对零遗漏:

- `T1 design complete → implement spawned` … `T8 redo handback → implement woken`(8 条)
- `X1 not_your_turn` … `X5 after finalize`、`X6a redo after pass`、`X6b qa_fail after pass`
  (7 条,X1/X2 可各带 2-3 个变体;X6a/X6b **必须分开两条 case**,缺一即 QA FAIL)
- `I1-I4 invariants`(公共断言 helper,折进每条 case;另加 1 条全链 happy-path
  串烧:T1→T2→T3→T4→T5→T6,沿途断言 epoch 序列 1,2,3,4,5,5,5)
- 预期合计 ≥ 15 条 case;全部通过 `npx vitest@3.2.4 run qa-fly904/` 直跑。

## 4. implement 阶段步骤(TDD,RED→GREEN→REFACTOR)

1. `git pull` 确认在共享分支 `project-slot-2-FLY-904` 最新 head(单 worktree 原地接手,不新建);
2. 先写 `turn-reducer.test.mts` 全量 case(§3)→ 跑出 RED;
3. 最小实现 `turn-reducer.mts` 过全绿 → GREEN;
4. REFACTOR(guard 提公共谓词等),保持全绿;
5. commit(英文 message,`feat: FLY-904 scratch turn-reducer mirroring FLY-887 turn protocol`
  之类)+ push → 开 PR(base=main;PR body 链接 FLY-904 并标注 scratch/never-merge 性质
  由 harness 决定处置)→ `stage set pr_created` → approve gate 流程照协议走。

## 5. QA 阶段验收合同(oracle)

1. 独立复跑 `npx vitest@3.2.4 run qa-fly904/` 全绿;
2. 拿 research.md §1 权威状态表 + 本 plan §2.4/§2.5 逐行对照测试文件:每条 transition
  有 case、每类非法 case 有 case、不变量 I1-I4 有断言——任一遗漏即 FAIL(这正是驱动
  fix-loop 的天然抓手,无需预埋 bug);
3. QA 报告落 `qa-fly904/QA-REPORT-FLY-904.md`(镜像 qa-fly294 报告形态),commit 到同分支。

## 6. 边界与不做

- 零 `packages/` 改动、零 workspace/build 接线、零生产行为影响(scratch 目录 + 文档而已);
- 不预埋缺陷;fix-loop / design-redo / ship-cleanup 三场景由 FLY-902 harness 与 Lead 驱动;
- reducer 是 FLY-887 协议**语义镜像**,不是实现重写——不模拟 CommDB/tmux/mailbox。

## 7. 验收(设计阶段自身)

- 本文件夹 exploration/research/plan/progress 四件套 commit 并 push 到 `project-slot-2-FLY-904`;
- `stage set design_review --plan <本文件>` 已触发;
- `complete --route phase_design_complete` + park 保活,等 TURN 交接。
