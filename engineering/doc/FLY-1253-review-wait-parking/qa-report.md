# FLY-1253 审查等待 park 重试 — 独立 QA 报告
Issue: FLY-1253 (https://linear.app/geoforge3d/issue/FLY-1253)
日期: 2026-07-14
基于: plan.md · exploration.md · research.md · PR #596

**QA 阶段**: 三段式流水线的 QA 阶段（Design → Implement → QA）· QA 模型 = Claude Opus
**被测分支**: `flywheel-FLY-1253` · HEAD `b1c1f84a0`（与 origin 一致）
**被测 PR**: #596 `fix(runner): preserve bound review waits`
**判定**: ✅ **PASS**

---

## 1. 改动是什么（本分支 = PR-A）

事故背景（FLY-1225）：等审查结论的会话被 `DEFAULT_TIMEOUT_MS`（30 分钟）到点**硬杀**，
修复被丢。审查等待是长期基建，不该被普通执行超时切掉。

本分支（flywheel repo，PR-A）交付**两层**：

1. **新模块 `wait-aware-exec.ts`** —— bounded 进程监督器。跑单个 child，只要
   `isWaiting()`（有 checkpointed 阻塞 gate 挂起）为真就**暂停** active-work 预算，而非
   杀 child。三重上界：累计 ACTIVE 预算 / 每段 WAITING 上界 / 绝对 OUTER 上界；probe
   抛错时 fail-closed（当作 not-waiting，保留原超时语义）；单 settle 守卫；**永不 respawn**。

2. **`ClaudeCodeAdapter.execute()`** 改用 `runWaitAwareExec`，`isWaiting =
   hasPendingBlockingGateFrom(execId)`（查 CommDB，仅 `checkpoint IS NOT NULL` 的
   review/gate，不含普通 ask）。老版是 Node `execFile({ timeout })` 内建硬杀 → 新版
   等待期不计入预算。附 direct-run env parity（FLYWHEEL_COMM_DB/EXEC_ID/… + BASH_MAX_TIMEOUT_MS）。

**真事故修复在 PR-B**（flywheel-skills PR #17，flywheel-land SKILL.md v0.4.0 park/retry）——
独立仓、独立 PR，本分支不含。PR-A 是 **dormant direct adapter hardening + 生产兼容性证据**。

## 2. 结论对得上 plan 的核心 invariant

| Plan invariant | 验证方式 | 结果 |
|---|---|---|
| ② reachability：direct `type="claude"` 不注册、不接线；backend union 不加 bare `claude` | scope 审计（见 §4） | ✅ |
| ④ 普通语义不变：无 gate 时仍按 active timeout 杀 | 负向测试（checkpoint-less ask / 别的 exec / 无 DB / 坏 DB / probe 抛错）全部 `timedOut:true` | ✅ |
| ⑥ live adapter boundary：TmuxAdapter/CodexTmuxAdapter runtime 不改 | 源码 diff 为空（见 §4） | ✅ |
| ⑦ direct budget：累计 active、每段 wait cap、outer cap、gate close 恢复剩余预算不刷新 | wait-aware-exec 9 测 + 我新增的适配器层判别测试 | ✅ |
| 交付：等待 > timeout 会话存活 + 结果就绪后同 child 继续 | 4 层回归证据（见 §3） | ✅ |

## 3. 验证执行（全部本地实跑，非自报）

### 3.1 焦点套件（plan Task 6 Step 6）
```
vitest run test/wait-aware-exec.test.ts test/ClaudeCodeAdapter.test.ts \
           test/TmuxAdapter.test.ts test/codex-daemon-client.test.ts
→ 4 files, 170 tests PASSED   （含我新增 1 个 QA 回归测试）
pnpm --filter flywheel-claude-runner typecheck → PASS
pnpm --filter flywheel-comm  typecheck         → PASS
biome check（7 改动文件）                        → clean
```

### 3.2 完整套件（回归面）
```
flywheel-claude-runner test → 25 files / 558 tests PASSED  (TMPDIR=/tmp)
flywheel-comm          test → 56 files / 808 tests PASSED  (TMPDIR=/tmp)
```

### 3.3 "等待 > timeout 存活 + 继续" 的四层证据
- `wait-aware-exec`：`pauses active accounting while one blocking gate is open`（等待期推进
  2000ms 未被杀）+ `continues the same child with remaining active budget after response` +
  `does not refresh active budget across repeated open-close cycles`（400+400+201ms → 超时，
  证明预算不刷新）。
- `ClaudeCodeAdapter`：`survives beyond the active timeout and continues the same child after a
  review verdict`（review_code gate）+ `also pauses for a generic checkpointed question gate`。
- `TmuxAdapter`（**live claude-tmux**，真定时器）：`characterizes production claude-tmux across
  bound review wait` —— 跨过缩短的 active timeout pane/heartbeat 仍活、response 后同 window 继续、
  从不 kill-window；负向 `keeps the ordinary active timeout when no question is pending` 仍杀。
- `codex-daemon-client`（**live codex-tmux**）：`continues one goal on the same thread after a
  bound review wait closes` —— 同 thread、不重发 goal/set、deadline 单调不回缩。

### 3.4 我新增的 QA 回归测试（`test/ClaudeCodeAdapter.test.ts`）
`survives a wait far beyond the active timeout, then resumes the remaining (not refreshed) budget`

补的是**唯一未在适配器集成层合并测过**的组合性质，也正是 Annie 标记的事故形状：
1. 100ms active 预算，bound review gate 开着挂 **1000ms（10×）** → 全程 `kill` 未被调用、
   child 只 spawn 一次；
2. response 落地、gate 关闭 → 预算从 **70ms 处恢复**（非刷新回 0）；
3. 关闭后仅 ~30ms 预算余量，再推进 60ms active → 触发 active 超时，`{success:false, timedOut:true}`。

**判别性**：若有回归让 gate 关闭时刷新预算（回 0），步骤 3 的 60ms < 100ms 不会超时，`run`
永不 resolve 成 `timedOut` → 测试失败。故这条绿测同时证明了"长等待存活"与"预算恢复而非刷新"。

## 4. Scope discipline 审计（独立核验，不信自报）

- **无 bare-claude 生产注册**：`run-infra.ts` 的 `AdapterRegistry` 只注册
  `claude-tmux`/`codex-tmux`/`antigravity-tmux`/`kimi-tmux`，无 `claude`。
- **claude-runner 版 `ClaudeCodeAdapter`（type="claude"，本次改的这个）无生产消费者**：
  非 test 生产代码无一处 `import ... ClaudeCodeAdapter from "flywheel-claude-runner"`；
  teamlead 内出现的 `new ClaudeCodeAdapter()`（wiring-postwrite.test.ts）用的是**另一个**同名类
  `agent-team-transport` 的（有 `getInboxPath`），非本次改动对象。→ dormant 声明成立。
- **live adapter + routing 源码零改**：`TmuxAdapter.ts` / `codex-daemon-client.ts` /
  `claude-review-runner.ts` / `run-infra.ts` / `config/types.ts` / `Blueprint.ts` diff 均为空。
- **flywheel-comm 生产代码零改**：仅新增一个测试文件；`hasPendingBlockingGateFrom` /
  `openReadonly` 是**复用现有**方法（db.ts 未改）。
- CI（PR #596）：Build & Test **pass**、FLY-1062 payload check **pass**。

## 5. 环境噪声说明（非缺陷，不阻塞）

`flywheel-claude-runner test` 首跑有 4 个失败，全在 `codex-daemon-runtime.test.ts`
（FLY-1188，**本分支未触碰**该文件），错误 `assertSocketPathFitsSunLen: socket path 116 bytes
exceeds SUN_LEN (103)`。根因是**本 QA runner 的 TMPDIR** 指向超长路径
`~/.flywheel/runner-state/<长 execId>/browser-tmp/`，`mkdtempSync(tmpdir(), …)` 生成的 unix
socket 路径超 103 字节。`TMPDIR=/tmp` 复跑 → 37/37 全过。与 FLY-1253 无因果，参照
`reference_qa_codex_lead_runtime_tmpdir_overlap`。

## 6. 潜在关注点（记录，非阻塞）

- 本分支 = dormant 硬化 + 兼容证据；**当前生产事故的实际闭环靠 PR-B**（flywheel-skills #17）。
  两 PR 无 merge 依赖（plan invariant ⑨），需各自 review/land。PR-B 状态：OPEN。
- direct adapter 默认 outer cap = `max(active, waiting×7)` ≈ 49h×7 的公式未单测（纯公式，
  fake-timer 推进不现实）；不影响生产（dormant）。

## 结论

PR-A 实现干净、tests 完整、scope 严格守住 dormant/兼容边界，回归面全绿，交付的核心验收
（等待 > timeout 会话存活并在结果就绪后继续、普通超时语义不变）在 4 个 runtime 层都有实测证据。
新增 1 条适配器层判别性回归测试固化了"预算恢复而非刷新"。**VERDICT: PASS**。
