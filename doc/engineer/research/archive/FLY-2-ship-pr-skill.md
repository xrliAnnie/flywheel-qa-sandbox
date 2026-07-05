# Research: Flywheel Ship PR Skill — FLY-2

**Issue**: FLY-2
**Date**: 2026-03-30
**Source**: `doc/engineer/exploration/new/FLY-2-ship-cool-flow.md`

## 研究目标

确定 Flywheel `/ship-pr` skill 的具体实现细节：
1. CI 检查 + fix loop 的最佳 CLI 命令
2. 失败分类策略
3. skill 结构 + allowed-tools
4. 与现有 orchestrator 的集成方式

## 1. GitHub CLI CI 检查命令

### `gh pr checks --watch`

```bash
gh pr checks {PR_NUMBER} --watch --fail-level all
```

- `--watch`: 阻塞等待所有 check 完成
- `--fail-level all`: 任何失败都返回非零 exit code
- 退出码: 0=all pass, 非零=有失败

### 读取失败日志

```bash
# 列出 checks，找到失败的 run ID
gh pr checks {PR_NUMBER} --json name,state,link

# 获取失败 run 的日志
gh run view {RUN_ID} --log-failed
```

### 重跑 flaky test

```bash
gh run rerun {RUN_ID} --failed   # 只重跑失败的 job
```

## 2. 失败分类策略

| 分类 | 信号 | 处理 |
|------|------|------|
| **Code bug** | Test assertion, type error, lint error, build error | 修代码 → commit → push |
| **Flaky / External** | Timeout, network error, transient 5xx, rate limit | `gh run rerun --failed` |
| **Config issue** | Missing secret, permission denied, env var error | 上报用户（需手动修） |

### Flywheel CI 特点

Flywheel CI (`ci.yml`) 只有一个 job `build-and-test`，包含：
1. `pnpm install`
2. `better-sqlite3` prebuild
3. `pnpm build`
4. `pnpm typecheck`
5. `pnpm lint`
6. `pnpm test:packages:run`

每个 step 的失败信号：
- **build**: TypeScript compile error → 修代码
- **typecheck**: Type error → 修代码
- **lint**: biome format/lint error → `pnpm lint --write` 自动修 → commit → push
- **test**: Test failure → 读日志判断是 code bug 还是 flaky

## 3. Skill 结构设计

### 与 GeoForge3D `/ship-pr` 的区别

| 特性 | GeoForge3D | Flywheel |
|------|-----------|----------|
| Deploy | Terraform + Cloud Run | 无 |
| `:cool:` trigger | GitHub Action | 不需要 |
| Post-deploy test | Integration + E2E | 无 |
| Branch protection | 可能 Pro | 不可用 |
| Rebase phase | 多 agent 竞争 deploy env | 不需要 |
| Domain lease | backend/frontend lock | 不需要 |
| Post-merge docs | CLAUDE.md bug table, codemaps | archive docs, MEMORY.md, CLAUDE.md milestone |

### Flywheel `/ship-pr` 阶段

```
Phase 1: CI Green Gate
  1a. gh pr checks --watch
  1b. If red → classify → fix/rerun → push → loop
  1c. Max 3 attempts → escalate

Phase 2: Merge
  2a. gh pr merge --squash --delete-branch
  2b. Confirm merge success

Phase 3: Post-merge (orchestrated only)
  3a. Archive docs (git mv plan/inprogress → archive)
  3b. Update MEMORY.md + CLAUDE.md
  3c. Linear → Done
  3d. Worktree cleanup
```

### allowed-tools

```yaml
allowed-tools:
  - Bash(gh pr:*)
  - Bash(gh run:*)
  - Bash(gh api:*)
  - Bash(git diff:*)
  - Bash(git log:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git push:*)
  - Bash(git mv:*)
  - Bash(git worktree:*)
  - Bash(git branch:*)
  - Bash(git checkout:*)
  - Bash(git pull:*)
  - Bash(pnpm lint:*)
  - Bash(pnpm build:*)
  - Bash(pnpm typecheck:*)
  - Bash(pnpm test:*)
```

## 4. Orchestrator 集成

当前 orchestrator.md Ship Gate 段（第 7 节）有 ~60 行 inline 步骤。可以简化为：

```markdown
### 7. Ship + Cleanup
For each PR the user approves to ship:
1. SendMessage(to="worker-{XX}", message="Run /ship-pr for PR #{N}")
2. Worker executes /ship-pr which handles CI gate + merge + docs
3. After worker confirms done → cleanup-agent.sh → shutdown
```

但需要注意：`/ship-pr` 作为 skill 在 worker agent context 中调用，worker 已经有 worktree context。Phase 3 的 post-merge 步骤（archive docs、update MEMORY.md）需要在 main repo 上操作，而 worker 在 worktree 中。

**解决方案**: Phase 3 先 `cd` 到 main repo，pull latest，执行 docs 更新，再 commit + push。worker 在 worktree 被删除前完成所有操作。

## 5. 结论

- **实现简洁**：一个 `.claude/commands/ship-pr.md` skill 文件
- **无需新代码**：纯 CLI 命令组合（`gh`, `git`, `pnpm`）
- **orchestrator.md 最小更新**：Ship Gate 段简化，引用 skill
- **向后兼容**：手动调 `/ship-pr` 也能用，不依赖 orchestrator
