# FLY-3043 Codex 契约文件加沙箱注释 — 探索

Issue: FLY-3043 (https://linear.app/geoforge3d/issue/FLY-3043/qa-sbx-fly-3024-b535a6f9-per-issue-529-without-a-d)
日期: 2026-09-28
基于: 无

## 1. 任务原文与解读

Issue 要求（QA 沙箱合成任务）：在沙箱仓 `packages/claude-runner/agents/codex-runner-contract.md` 末尾**恰好新增（或改成）一行**：

```
- Sandbox note: runners run only the tests related to their change.
```

然后按正常流程：issue 分支提交 → 开 PR → 常规评审 → complete；下游 QA 节点按常规验证。

解读要点：

- 这是一次**纯文档改动**，目的不是改行为而是让整条 DAG（design → implement → qa）真跑一遍。
- "exactly one line at the end" 是硬约束：diff 必须是 `+1` 行、`-0` 行（文件已存在且以换行结尾，见 §2）。
- "runners run only the tests related to their change" 恰好与本 issue 的本机测试政策一致（Definition of Done 第 3 条：本机跑相关测试，完整套件交给 exact-head PR CI；`pnpm test` 不得裸跑）。

## 2. 现状审计（2026-09-28 沙箱分支 `project-slot-2-FLY-3043`，HEAD = `1855f7a1a`，与 `origin/main` 0/0 齐平）

### 2.1 目标文件

| 项 | 实测 |
|---|---|
| 是否存在 | **存在**（113 行，6993 字节） |
| 结尾字节 | `0x0a`（有尾随换行，追加一行不会产生 "No newline at end of file" 噪音） |
| 最后一节 | `## Environment Translation (fixed rules)`，最后一行是 **Precedence** 项目符号（`- **Precedence**: … (FLY-123 §5.5).`） |
| 现有内容里是否已有 "Sandbox note" | 无（`grep -c "Sandbox note"` = 0） |
| 文件性质 | Contract-Version 2（FLY-1188 M4）：Codex runner 的持久行为契约，被物化到每个 runner 的 `$CODEX_HOME/AGENTS.md` |

### 2.2 消费者（改动不能破坏谁）

| 消费者 | 位置 | 对本行的敏感度 |
|---|---|---|
| `codexRunnerContractSource()` | `packages/claude-runner/src/codex-home.ts:335-339` | 只解析**路径**（`../agents/codex-runner-contract.md`），不解析内容 → 不敏感 |
| `provisionCodexHome` 单测 | `packages/claude-runner/test/codex-home.test.ts:203-236` | 断言若干**锚点子串**（`Flywheel Codex Runner Contract`、`--no-block`、`verify-approval`、`flywheel-comm complete`、`request-review`、`FLYWHEEL_COMM_CLI`、`resident`、`terminal goal status`）都是 `toContain`，追加一行不影响 → 不敏感；基线 **37/37 通过** |
| 打包冒烟 | `scripts/__tests__/package-onboard-smoke.test.sh:102-104`（CI `ci.yml:188`） | 只检查文件**存在且随包分发** → 不敏感；本地无 `dist` 时脚本自 SKIP（第 31 行） |
| 其他引用 | `engineering/doc/FLY-1269-*/plan.md`、`FLY-1188-*/m4d-adapter-wiring-spec.md` | 历史文档引用，不受影响 |

结论：**没有任何消费者对文件行数、末尾内容或哈希做断言**，追加一行是零行为风险。

### 2.3 运行时语义（诚实边界）

这一行会随契约物化进沙箱里每个 Codex runner 的 `AGENTS.md`。它的措辞"runners run only the tests related to their change"与项目现行本机测试政策一致，因此即便被 Codex runner 当作指令读到，也**不会引入新行为**——它只是重述既有政策。本 issue 不改任何代码路径。

### 2.4 分支与仓别

- 远端 = `xrliAnnie/flywheel-qa-sandbox`（沙箱仓，非生产 `flywheel`）。
- 分支 `project-slot-2-FLY-3043` 与 `origin/main` 齐平（ahead 0 / behind 0），无需重锚；远端尚无同名分支，尚无 PR。
- CI 触发：`pull_request → main`（`ci.yml`），所以开 PR 即有完整套件证据。

## 3. 需要拍板的点（均已按既定规则自决，非阻塞）

| 问题 | 决定 | 依据 |
|---|---|---|
| 新行放哪 | 文件**最末尾**，作为 Environment Translation 节的最后一个项目符号，前面不加空行 | issue 原文 "at the end"；与相邻 `- **…**:` 项目符号同为 `- ` 前缀，Markdown 上仍是同一列表 |
| 要不要加空行 / 新小节 | 不加 | "exactly one line" —— 加空行 diff 会变成 +2 |
| 要不要顺手改 Contract-Version | 不改 | 注释性内容，不改变契约语义；且违反 "exactly one line" |
| 要不要新增测试 | 新增**一条**锚点断言（`toContain("Sandbox note: runners run only the tests related to their change.")`）到 `codex-home.test.ts` 的 FLY-1188 物化用例 | DoD 第 2 条要求相关测试；这是把"这一行真的进了 AGENTS.md"变成可机器验证的证据，而不是只看 diff。它是**第二个文件**的改动，但 "exactly one line" 约束只作用于契约文件本身 |
| 本机跑什么测试 | 只跑 `packages/claude-runner/test/codex-home.test.ts`（相关测试）；完整套件由 PR CI 证明；不裸跑 `pnpm test` | DoD 第 3 条本机测试政策 |

## 4. 备选方案与否决

| 备选 | 否决理由 |
|---|---|
| A. 不加测试，只改文档一行 | 满足 issue 字面，但 DoD 第 2 条要"相关测试"；一条 `toContain` 成本几乎为零且能被 QA 节点机器复核。**折中**：若 Lead 认为测试改动越界，可退回 A（plan 里给出开关） |
| B. 在契约里新开 `## Sandbox` 小节 | 至少 +3 行，违反 "exactly one line" |
| C. 把这行写进 `generic-executor.md` 等其他角色文件 | 文件名是 issue 硬指定的 |
| D. 用脚本在物化时动态注入而不改源文件 | 过度设计；issue 明说改源文件 |

## 5. 下一步

→ research.md：核实测试运行方式（worktree 里 `pnpm install` 后 `npx vitest run` 的确切命令与耗时）、CI 覆盖范围、以及 PR/评审门在沙箱里的具体走法。
