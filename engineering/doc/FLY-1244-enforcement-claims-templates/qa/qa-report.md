# FLY-1244 执法层 — QA 阶段报告

Issue: FLY-1244
日期: 2026-07-14
基于: plan.md（Codex design 6 轮 APPROVED）、qa/acceptance-matrix.md、qa/mutation-report.md
被验 head: `ca54d3ff8098d41f816dda28723aac57428530aa`（PR #593）

## Verdict

**PASS** —— 实现与 plan 一致，未发现实现缺陷。**发现并已补齐 1 项覆盖缺口**（详见
mutation-report.md）：6 条执法点写对了但没有任何测试证明，QA 补 9 格测试后 11/11 突变全杀。

补测属 QA 职责范围内的「add any missing test coverage」，不构成 kickback：**没有一条
执法逻辑被改动**，本次 QA 只动了测试文件。

## 1. 红测（总验收 1 / E1）

- 与原始 `origin/fly-1204-split 58cecc1f` 逐字比对：两条承重断言
  `expect(verdict.passed).toBe(false)` + `expect(verdict.reason).not.toBe("qa_not_required")`
  **一字未改，未弱化**。
- 唯一实质改动 = env 钉 `FLYWHEEL_WORKFLOW_FORCE_LEGACY: "0"`。这是 plan §6 明列的 hermeticity
  钉子，方向上是**更严**（禁掉应急回退这条绕过路径），不是放水；其余为注释框线的装饰性改动。
- 结果：**GREEN**，且经 dist 突变验证**真依赖本单修复**（撤销修复→立刻回红）。

## 2. 真机 E2E（总验收 5 / plan §7）—— 独立复跑，非采信实施者自报

`node scripts/qa-fly-1244-os-proof.mjs`（隔离 HOME/state/CommDB/worktree + 独立 tmux session）。

- **21/21 checks PASS，`pass: true`**，含真 tmux 三段式 fresh-spawn、server 选定 head、
  精确重放幂等、mismatched/无凭证拒、head 前进作废旧 claim、caller 自选 head 拒、
  新 attempt 恢复 ship 资格。
- 与实施者留档逐键比对：**verdict 全等（零 diff）**，`known_accepted_residuals` 一致。
  → 实施者的 E2E 证据是真的，可复现，不是自报。
- 证据文件 `qa/fresh-spawn-e2e.json` 已由本次独立跑重新生成（generated_at 更新为 QA 跑）。

## 3. 测试套件

| 套件 | 结果 |
|---|---|
| flywheel-comm 全量 | **837/837 passed（57 files）** |
| FLY-1244 自有 teamlead 文件（decision-routes / template / template-routes / founder-approval-projector / write-gate-response） | **37/37 passed** |
| 红测 | **1/1 passed** |
| teamlead 全量（本机） | 6854 passed / 64 failed —— **全为负载性超时，非本单回归**，见下 |
| biome lint（改动文件） | clean |

**teamlead 本机失败的定性（证据链，不是猜测）**：
1. 失败原因逐条是 `Test timed out in 5000ms` / `15000ms`，**不是断言不符**；
2. 同样这些文件**单独跑全绿**（含本单新增的 `workflow-decision-routes.test.ts` 7/7）；
3. 两次全量跑失败数不同（47 → 64）= 非确定性 = 负载；跑时 load 22–41 / 18 核，
   另有 20 个 vitest 进程 + 我的真机 E2E 并行；
4. 失败集中在真 git / 真 tmux / 读生产 `~/.codex-infra-bot/config.toml` 一类环境依赖测试；
5. **CI「Build & Test」在同一 head `ca54d3ff8` 通过**。

## 4. Default-off / 字节兼容

- 三 flag 分立且各自 default-off：`…_CLAIMS_WRITE`（写）/ `…_CLAIMS_READ`（读）/
  `…_FORCE_LEGACY`（应急回退）；`FORCE_LEGACY` 在**任何 claims 查询之前**解析（plan §4.4），
  已有测试锁住「长命 runner flip live-`.env` 即时生效」。
- 真值表 (c)（非 durable 三段式身份）走原旧布尔路径；legacy 分支的 `session_not_found` /
  `qa_not_required` / `qa_ok` / `qa_not_passed` 语义与 main 一致。
- **唯一有意行为改变**（plan §0 已声明、非「字节兼容」范畴）= durable 三段式 QA 身份无条件
  停认 `qa_required=0`，按 enrollment 分流：(d) 读账本 /（e）fail-closed。红测正是 (e)。

## 5. 结转的已知限制（plan §11b / §2.1，**接受项，非本次缺陷**）

- per-execution submission 凭证 = **纵深防御，不是 OS 隔离**：凭证生命期内同用户 sibling 可伪造
  PASS；同 uid shell-snapshot 可能暴露 execution-scoped 凭证。E2E 证据里 3 条
  `known_accepted_residuals` 显式记为 `true`，未粉饰。
- head-binding **不认证提交者**，只保证 claim 绑对 head；两条不变量（subject integrity /
  verdict authentication）独立，绝不声称 head-binding 挡得住 verdict 伪造。
- 因此 **生产 `FLYWHEEL_WORKFLOW_CLAIMS_READ` 必须保持 off**，直到 peer-cred / 独立 OS
  principal follow-up 落地（plan §6 Gate-0 两个硬前置之②尚未满足）。本单实际部署路径 = §6 (b)。
- 部署顺序提醒（plan §6）：携带本单的 Bridge 重启前，需先把 `FLYWHEEL_WORKFLOW_FORCE_LEGACY=1`
  写进生产 `~/.flywheel/.env`，否则在飞的 durable 三段式 run 会被 (e) fail-closed 卡 ship。
  这是本单的**部署前置**，不是代码缺陷。

## 6. QA 改动清单

- `packages/flywheel-comm/src/__tests__/ship-eligibility.test.ts` —— 仅测试：fixture 加
  6 个旋钮 + 9 格新测（19 → 28 tests）。
- `engineering/doc/FLY-1244-enforcement-claims-templates/qa/mutation-report.md` —— 新增。
- `engineering/doc/FLY-1244-enforcement-claims-templates/qa/qa-report.md` —— 本文件。
- `engineering/doc/FLY-1244-enforcement-claims-templates/qa/fresh-spawn-e2e.json` —— QA 独立跑重新生成。

**零执法逻辑改动。**
