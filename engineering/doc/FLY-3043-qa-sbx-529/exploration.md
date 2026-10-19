# FLY-3043 沙箱契约末行注记 — 探索

Issue: FLY-3043 (https://linear.app/geoforge3d/issue/FLY-3043/qa-sbx-fly-3024-b535a6f9-per-issue-529-without-a-d)
日期: 2026-09-28
基于: 无

## 1. 任务原文

> In the sandbox repository, create the file `packages/claude-runner/agents/codex-runner-contract.md` if it does not exist, and add (or change) exactly one line at the end:
> `- Sandbox note: runners run only the tests related to their change.`

一句话：这是一个 QA 沙箱的**合成任务**（synthetic task，即为了测试流水线本身而人为设计的任务，不承载真实产品需求），目标是让 DAG 流水线（design → implement → QA）在一条**只改一行文档**的变更上完整跑通。

## 2. 现状审计

| 项目 | 现状 |
|------|------|
| 目标文件 | **已存在**，113 行，末行为 `contract and the dynamic prompt win (FLY-123 §5.5).`，末尾有换行符 |
| 文件性质 | FLY-1188 引入的 Codex Runner 行为契约（Contract-Version 2），被 `codexRunnerContractSource()` 读取并物化到每个 runner 的 `$CODEX_HOME/AGENTS.md` |
| 运行时消费者 | `packages/claude-runner/src/codex-home.ts:337`（`provisionCodexHome` 物化） |
| 测试消费者 | `packages/claude-runner/test/codex-home.test.ts:212`（断言若干**锚点子串**存在：`--no-block`、`verify-approval`、`request-review`、`resident` 等，**不做全文快照/哈希**） |
| 打包烟测 | `scripts/__tests__/package-onboard-smoke.test.sh:102`（只断言文件存在） |
| 末尾结构 | 最后一段是 `## Precedence` 类无序列表，末行是一个 `- **Precedence**: …` 列表项的续行 |

结论：任务里的「if it does not exist」分支**不触发**，走「add exactly one line at the end」分支。

## 3. 关键问题与判断

### Q1：追加还是替换末行？
任务允许「add (or change)」。末行是有语义的契约内容（Precedence 规则的最后一句），**替换会破坏契约**。选 **追加**：在文件末尾新增一行 `- Sandbox note: runners run only the tests related to their change.`。

### Q2：追加的行是否会误伤运行时行为？
会被物化进 `$CODEX_HOME/AGENTS.md` 并被 codex runner 读到。内容是一句「只跑与自己改动相关的测试」的注记，与 Definition of Done 第 3 条（injected local-test policy：本机只跑具体相关测试，完整套件交给 PR CI）**语义一致**，不引入冲突指令。且本沙箱仓不是生产仓。

### Q3：是否需要新增测试？
- 现有 `codex-home.test.ts` 断言的是锚点子串，新增行不会让任何现有断言失败。
- 「exactly one line」是本次的核心不变量，值得一个**轻量守卫**：断言物化后的 AGENTS.md 包含这句 Sandbox note。这符合 DoD 第 2 条「写了相关测试」，同时不扩大范围。
- 反面：不新增测试也可接受（纯文档）。plan 里把这条作为**推荐但可裁**项，明确给出取舍。

### Q4：文件末尾格式
末行以 `\n` 结束（od 验证）。追加时保持「每行一个换行、文件以换行结束」的约定，不引入空行分隔（Markdown 列表项紧接上一列表项即可）。

## 4. 范围边界

- 只碰 `packages/claude-runner/agents/codex-runner-contract.md`（+ 可选一个测试断言 + 本 doc 文件夹）。
- 不改 `Contract-Version`（内容是注记，不是契约语义变更）。
- 不改 `.claude/skills/linear-issue-context/SKILL.md`（那是注入物料）。
- 不处理「顺便发现」的任何问题。
