# FLY-2922 QA stub 路由边界 — 调研
Issue: FLY-2922 (https://linear.app/geoforge3d/issue/FLY-2922/病根修复-8-held-回滚之后有出口只留一个统一恢复口放行必须真铸出派发关死体不连带终结-run9-张-37)
日期: 2026-09-28
基于: exploration.md

## Evidence Scope

设计 carrier 基线是 `2b7701c55`，不含 candidate harness 代码。为避免按旧符号猜测，本轮只读核对了注入任务指出的 host feature checkout；未在该 checkout 切分支、写文件、merge 或 reset。任务给出的失败证据是：QA@2 房内 `review-request-coordinator` 以默认 `claude` 启动真实评审，但被 Bridge-wide raw stub 截获；进程因没有 `FLYWHEEL_EXEC_ID` 在 stub 的前置条件处退出。

本调研只把现有接口和调用关系当设计依据，不把 host checkout 的后续提交、测试或 review 状态当本设计节点的完成证明。

## Current Harness Contract

`scripts/test-deploy.sh` 已有两类不同控制：

- `--stub-runner`：整个 generalized 房使用 stub，允许同时安装 `claude` 与 `codex` shim；
- `--qa-stub-runner`：与 `--generalized --codex-runner` 绑定，目标是 design/implement 真 Codex、QA stub。

缺陷发生在第二类：它把 raw QA stub 作为 `stub-bin/claude`，再把该目录放到 Bridge 可见的 `PATH` 前端。路径影响面不按 workflow node 分割，所有从 Bridge 派生的 bare `claude` 调用都可能命中它。

`packages/teamlead/src/bridge/review-request-coordinator.ts` 将 `reviewerBinary` 交给 `runClaudeReviewRound`；未覆盖时最终使用 bare `claude`。`packages/teamlead/src/bridge/claude-review-runner.ts` 的真实 spawner 把 `opts.env` 原样传给 `spawn`。因此评审环境继承 candidate Bridge 的 `PATH`，但它不是 workflow Runner，没有 `FLYWHEEL_EXEC_ID` 或 workflow activation。

`scripts/qa-529-generalized-stub.mjs` 正确要求 `FLYWHEEL_EXEC_ID`、StateStore 路径和 comm CLI；这些要求对 QA Runner 是安全边界，对 review child 则是确定性失败。这不是“让 stub 接受缺身份”能修的：缺身份调用必须走真实 Claude，而不是削弱 stub 前置条件。

## Available Identity

### Fresh workflow launch

Runner 启动环境包含：

- `FLYWHEEL_EXEC_ID`：逻辑 execution；
- `FLYWHEEL_WORKFLOW_ACTIVATION_ID`：`activation:<execution>:<run>:<node>:<attempt>`；
- `FLYWHEEL_STATE_DB_PATH`：slot-local StateStore。

selector 应同时校验 activation 内 execution 等于 `FLYWHEEL_EXEC_ID`，node 精确等于 `qa`，attempt 是正整数。只匹配字符串包含 `qa` 会误接 `qa-extra`；只看 execution id 会把 producer、review 或跨节点复用误送到 stub。

### Same-execution standby resume

standby 恢复沿用 execution，但启动形态可以不带 activation。持久归属在 `workflow_execution_binding(execution_id, node_id, ...)`。selector 可用装房时钉死的 slot DB 只读查询 `SELECT DISTINCT node_id ... WHERE execution_id = ?`：

- 唯一 `qa`：stub；
- 唯一非 QA 或零行：真实 Claude；
- `qa` 与其它节点并存：拒绝；
- DB 查询失败：拒绝。

execution id 必须先通过 `[A-Za-z0-9._-]+`，再进入 sqlite parameter binding；不把它直接拼成 SQL literal。

## Real Binary Pinning

selector 必须在安装前解析真实 Claude 并把绝对路径写进 owner-only shim。解析流程逐个检查原始 `PATH` entry：

1. entry 必须是绝对目录；
2. 跳过目标 shim 目录及其 realpath alias；
3. candidate 必须是 regular executable；
4. candidate 不能与已安装 shim `-ef`；
5. candidate 前 512 bytes 不能带 QA shim marker，防止 symlink、hardlink 或复制后的 shim 被当作“真实 Claude”。

没有合格 candidate 时装房失败。运行时 selector 不再调用 `command -v claude`，避免自递归。

## Why Codex Must Stay Real

`--qa-stub-runner` 的 generalized driver 已把 producer 节点固定到 Codex、QA 固定到 Claude。QA-only installer 因此只创建 `stub-bin/claude`，并在目录已有 `codex` 文件或链接时 fail closed。这样 design/implement 以及 Codex daemon/TUI 的路径都不经过该 shim；full `--stub-runner` 仍保留原有双 shim 行为，两种模式不能混合。

## Proposed Selector Contract

```text
call claude
  ├─ no FLYWHEEL_EXEC_ID ────────────────> exec pinned real Claude
  ├─ malformed exec id ──────────────────> exit 70
  ├─ activation present
  │    ├─ exact same-exec / qa / n>=1 ──> exec node QA stub
  │    └─ everything else ───────────────> exec pinned real Claude
  └─ no activation (standby resume)
       ├─ DB says only qa ───────────────> exec node QA stub
       ├─ DB says non-qa or no row ──────> exec pinned real Claude
       └─ unreadable / qa+other ─────────> exit 70
```

Review child and version probes take the first branch. Fresh design/implement Runner calls take the activation/non-QA branch. QA attempt 1, QA replacement, and QA attempt 2 each use their own exact activation. A same-execution QA standby resume uses the DB branch。

## Test Surface

| File | Required evidence |
|---|---|
| `scripts/__tests__/test-deploy-generalized.test.sh` | RED reproduces identity-free review hitting raw stub; GREEN proves review/version/producer passthrough, exact QA routing, standby QA routing, ambiguity/malformed/DB failure guards, argv preservation, real-binary anti-recursion, and no `codex` shadow |
| `scripts/lib/qa-generalized.sh` | owner-only selector installer, real Claude resolver, shim marker/alias detection |
| `scripts/test-deploy.sh` | `--qa-stub-runner` captures real Claude before install, pins slot DB, installs selector; full `--stub-runner` remains unchanged |
| `doc/qa/framework/529-room-playbook.md` | operator-visible meaning: QA stub is node-scoped; review is real; final evidence still belongs to the outer driver |

No production TypeScript test is required because the selected approach does not change product code. Discovery must search the changed full paths, filenames, parent directories, `--qa-stub-runner`, `qa_generalized_install_qa_stub`, `stub-bin`, and `FLYWHEEL_WORKFLOW_ACTIVATION_ID`; excluded matches and reasons must be recorded before running the one concrete shell test.

## Risks and Mitigations

- **Selector loops into itself**: pin absolute real binary before install; skip path aliases, `-ef` aliases and marker-bearing copies.
- **Foreign activation spoofs QA**: require same execution prefix and exact node/positive attempt shape.
- **Standby resume loses activation**: exact StateStore fallback; ambiguous QA ownership refuses.
- **StateStore temporarily unreadable**: fail closed for exec-only identity, rather than silently running a QA as real or a producer as stub.
- **Wrapper changes argv or signal behavior**: use shell `exec` for both branches and assert exact argv in the focused test.
- **Production behavior becomes weaker**: flag remains isolated-room-only/default-off; no role prompt, judge, coordinator, dispatcher or product StateStore code changes.

## Honest Boundary

Focused shell tests can prove the routing decision and installer guards, but not that a real subscription-backed Claude review succeeds in a room. QA@3 must launch the exact documented room parameters, observe a genuine design-review response from Claude, and complete all generalized driver steps. The prior two-hour wait is failure evidence, not a passing baseline.
