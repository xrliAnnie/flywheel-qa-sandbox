# FLY-3043 沙箱契约末行注记 — 调研

Issue: FLY-3043 (https://linear.app/geoforge3d/issue/FLY-3043/qa-sbx-fly-3024-b535a6f9-per-issue-529-without-a-d)
日期: 2026-09-28
基于: exploration.md

## 1. 消费链路（谁会看到这一行）

```
packages/claude-runner/agents/codex-runner-contract.md   (single source)
        │  codexRunnerContractSource()  codex-home.ts:335-339
        ▼
provisionCodexHome({executionId, ...})
        │  写入 <CODEX_HOME>/AGENTS.md (mode 0600, 带 flywheel-managed 头)
        ▼
每个 codex runner 进程启动时读取 AGENTS.md → 作为持久行为契约
```

- `import.meta.url` 相对解析 `../agents/`，src/ 与 dist/ 两种运行形态同样命中；**追加一行不改变路径解析**。
- 物化是整文件复制加头部，不做逐行解析；**任意合法 Markdown 行都可安全追加**。

## 2. 测试面

| 测试 | 类型 | 对本变更的敏感度 |
|------|------|------------------|
| `packages/claude-runner/test/codex-home.test.ts` `FLY-1188 AGENTS.md contract materialization` | vitest 单测，真实写临时目录 | 断言 `toContain` 锚点子串，新增行**零影响**；可在同一 `it` 或新 `it` 里追加一条 `toContain("Sandbox note: runners run only the tests related to their change.")` |
| `scripts/__tests__/package-onboard-smoke.test.sh` ③b | shell 烟测 | 只测存在性，零影响 |
| 全仓 `pnpm lint`（biome） | lint | biome 不 lint `.md`，零影响 |

本机验证命令（遵循 DoD 第 3 条「只跑具体相关测试」）：

```bash
pnpm install --frozen-lockfile   # 沙箱 worktree 无 node_modules（实测 vitest not found），先装一次
cd packages/claude-runner && pnpm exec vitest run test/codex-home.test.ts
```

（package 名为 `flywheel-claude-runner`。）

## 3. 「exactly one line」的验证方法

实现节点应以 diff 形态自证：

```bash
git diff --stat main...HEAD -- packages/claude-runner/agents/codex-runner-contract.md
# 期望: 1 file changed, 1 insertion(+)
tail -1 packages/claude-runner/agents/codex-runner-contract.md
# 期望: - Sandbox note: runners run only the tests related to their change.
```

## 4. 风险评估

| 风险 | 概率 | 影响 | 处置 |
|------|------|------|------|
| 追加行被当作契约指令改变 runner 行为 | 低 | 低（与 DoD 本地测试政策一致） | 不升 Contract-Version；plan 里显式记录 |
| 末尾没有换行导致 `tail -1` 拼接 | 无（已验证末尾有 `\n`） | — | 追加时用 `printf '%s\n'` |
| 与 main 并发改同文件冲突 | 极低（沙箱仓） | 低 | 实现前 merge origin/main |

## 5. 结论

纯追加一行 + 一条 `toContain` 守卫断言，零运行时代码改动。无需外部库文档查询。
