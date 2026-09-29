# FLY-3043 沙箱契约末行注记 — 实施计划

Issue: FLY-3043 (https://linear.app/geoforge3d/issue/FLY-3043/qa-sbx-fly-3024-b535a6f9-per-issue-529-without-a-d)
日期: 2026-09-28
基于: research.md

## 目标

在 `packages/claude-runner/agents/codex-runner-contract.md` 末尾追加**恰好一行**：

```
- Sandbox note: runners run only the tests related to their change.
```

并以一条测试断言守住「这一行确实被物化进 runner 的 AGENTS.md」。

## 稳定标识

| 项 | 值 |
|----|----|
| 分支 | `project-slot-6-FLY-3043`（当前 issue 分支，共享 worktree） |
| 目标文件 | `packages/claude-runner/agents/codex-runner-contract.md` |
| 追加行（逐字） | `- Sandbox note: runners run only the tests related to their change.` |
| 测试文件 | `packages/claude-runner/test/codex-home.test.ts` |
| 新断言锚点 | `Sandbox note: runners run only the tests related to their change.` |
| Contract-Version | 保持 `2`（不变） |

## 实施步骤（implement 节点执行）

顺序按 **准备依赖 → RED → 追加 → GREEN** 执行（Codex design review R1 low 建议：先看断言失败，再追加那一行，才能得到真实的 RED→GREEN 记录）。

### Step 0 — 准备依赖
沙箱 worktree **默认没有 `node_modules`**（design 节点实测 `vitest` not found）。先在仓库根安装一次：
```bash
pnpm install --frozen-lockfile        # 仓库根；已装则幂等
```
若安装因沙箱网络受限失败，记为**环境阻塞**并在 PR body 如实写明「本机未能跑 vitest，以 CI 为准」；不得记作 RED 或 GREEN，不得伪造通过记录。

### Step 1 — 先写断言，确认 RED
在 `codex-home.test.ts` 的 `FLY-1188 AGENTS.md contract materialization` describe 内新增：
```ts
// FLY-3043 (QA sandbox): the sandbox note is part of the materialized contract
it("materializes the FLY-3043 sandbox note", () => {
	const home = provisionCodexHome({ executionId: "exec-fly-3043", env });
	const agents = readFileSync(join(home, "AGENTS.md"), "utf-8");
	expect(agents).toContain(
		"Sandbox note: runners run only the tests related to their change.",
	);
});
```
`env` 与 `provisionCodexHome` 沿用同 describe 已有 fixture（见 test:205 现有用例）。然后只跑本文件，**期望这一条失败**（契约里还没有那一行）：
```bash
cd packages/claude-runner && pnpm exec vitest run test/codex-home.test.ts   # 期望: 1 failed (新用例)
```

### Step 2 — 追加末行
```bash
printf '%s\n' '- Sandbox note: runners run only the tests related to their change.' \
  >> packages/claude-runner/agents/codex-runner-contract.md
```
守卫：
```bash
git diff --stat -- packages/claude-runner/agents/codex-runner-contract.md   # 1 insertion(+), 0 deletions
tail -1 packages/claude-runner/agents/codex-runner-contract.md              # 逐字等于追加行
```

### Step 3 — 再跑同一文件，确认 GREEN
```bash
cd packages/claude-runner && pnpm exec vitest run test/codex-home.test.ts   # 期望: 全部通过
```
只跑本文件；完整套件由 PR CI 证明（DoD 第 3 条，`pnpm test` 不裸跑）。

### Step 4 — 提交 & PR
- commit：`docs(FLY-3043): append sandbox note to codex runner contract`
- PR 标题：`docs(FLY-3043): append sandbox note to codex-runner-contract.md`
- PR body 含：变更摘要（1 行追加 + 1 断言）、测试计划（Step 1 RED 与 Step 3 GREEN 的命令与结果、CI）、`## Linear Issue` 段。
- 走常规 review（Codex code review），不自行 merge。

## 回滚边界

`git revert` 单个 commit 即可；无迁移、无数据、无配置变更。

## 负面守卫（不做什么）

- 不替换或删除现有末行（Precedence 规则）。
- 不升 Contract-Version。
- 不改 `SKILL.md`、不改其它文件、不修「顺便发现」的问题。
- 不为一行文档新增独立测试文件；断言就地放进已有 describe。

## 测试证据（Definition of Done 对照）

| DoD | 证据 |
|-----|------|
| 1 验收 | `tail -1` 逐字匹配 + diff 恰 1 insertion |
| 2 测试 | 新 `it` 断言（Step 1 RED → Step 3 GREEN 记录在 PR body） |
| 3 本地只跑相关测试 | Step 1 / Step 3 命令输出 |
| 4/5/6 commit / PR / 描述 | PR 链接 + body |
| 7 独立生产仓 | 不适用（沙箱仓） |

## 已拒绝的替代方案

| 方案 | 拒绝理由 |
|------|----------|
| 替换末行 | 会删掉 Precedence 契约的最后一句，破坏语义 |
| 追加前加一个空行 | 变成「两行」改动，违反 exactly one line |
| 升 Contract-Version 3 | 注记不改变契约语义，升版会误导 M4d 相关测试与读者 |
| 不写测试 | 可接受但弱；一条 toContain 成本极低，且满足 DoD 第 2 条 |
