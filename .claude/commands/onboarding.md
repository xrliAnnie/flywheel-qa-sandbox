# Flywheel Onboarding

New session startup — read current project state and present a status summary in Chinese.

## Step 1: Core Context

Read these files in order:

1. **Memory** (decisions, architecture, progress):
   ```
   ~/.claude/projects/-Users-xiaorongli-Dev-flywheel/memory/MEMORY.md
   ```

2. **Project CLAUDE.md** (conventions, pipeline, non-negotiables):
   ```
   CLAUDE.md
   ```

3. **Current version**:
   ```
   doc/VERSION
   ```

## Step 2: Active Work

Scan for active plans and explorations:

```bash
echo "=== In-Progress Plans ===" && ls doc/plan/inprogress/ 2>/dev/null || echo "(none)"
echo "=== Ready Plans ===" && ls doc/plan/new/ 2>/dev/null || echo "(none)"
echo "=== Draft Plans ===" && ls doc/plan/draft/ 2>/dev/null || echo "(none)"
echo "=== Active Explorations ===" && ls doc/exploration/new/ 2>/dev/null || echo "(none)"
echo "=== Active Research ===" && ls doc/research/new/ 2>/dev/null || echo "(none)"
```

## Step 3: Recent Activity

```bash
git log --oneline -10
```

## Step 4: Running Services

```bash
echo "=== Bridge ===" && curl -s --max-time 2 http://localhost:9876/health 2>/dev/null || echo "Bridge not running"
echo "=== OpenClaw Gateway ===" && launchctl print gui/$(id -u)/ai.openclaw.gateway 2>/dev/null | grep "state =" || echo "Gateway not running"
```

## Output Format

Present to the user (in Chinese):

1. **项目概述**: Flywheel 是什么（一句话）
2. **当前版本**: 从 `doc/VERSION` 读取
3. **最近完成**: 最近 merged 的 PR/feature（从 git log 和 MEMORY.md）
4. **进行中**: 正在实施的 plan（`doc/plan/inprogress/`）
5. **待实施**: 已批准待开始的 plan（`doc/plan/new/`）
6. **待探索**: 活跃的 exploration/research docs
7. **服务状态**: Bridge 和 Gateway 是否运行
9. **关键规则提醒**:
   - 所有改动必须走 worktree + branch + PR（不可直接 push main）
   - 开发流程: /brainstorm → /research → /write-plan → /codex-design-review → /implement
   - 中文为默认语言，代码/commit 用英文
10. **提问**: "你想做什么？"

## Important

- 这个 skill 是**动态的** — 它从文件系统读取当前状态，不依赖硬编码内容
- 如果 MEMORY.md 过期，在 onboarding 结束时提醒用户需要更新
- 如果发现 `doc/plan/inprogress/` 有文件但 git log 没有相关最近 commit，提醒可能有 stale plan
