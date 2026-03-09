# Research: Worktree + Hook + Session Forking 模式

> 来源：superset-sh/superset, ruvnet/ruflo
> 影响范围：v0.1.1（hook 实现）、v0.2+（并行执行）
> 状态：研究完成，待 architecture 整合

## 1. 背景

Flywheel v0.1.1 的 TmuxRunner 需要：
- 检测 Claude Code session 完成（SessionEnd hook）
- 安全管理 git worktree（Phase 2 并行化）
- 构建 claude CLI 命令（防转义）

superset-ai 和 ruflo 中有**生产级 TypeScript 实现**可以直接复用。

## 2. SessionEnd Hook 注入（superset-ai）

### 原理

superset-ai 用 `claude-settings.json` 的 `hooks` 字段注入生命周期事件处理：

```typescript
// apps/desktop/src/main/lib/agent-setup/agent-wrappers-claude-codex-opencode.ts
const settings = {
  hooks: {
    Stop: [{
      hooks: [{ type: "command", command: notifyScriptPath }]
    }],
    // 还注入了 UserPromptSubmit, PostToolUse, PermissionRequest
  },
};
```

通过 wrapper 脚本注入 settings 路径：
```bash
exec "$REAL_BIN" --settings "/path/to/claude-settings.json" "$@"
```

### Notify Hook 实现

```bash
# templates/notify-hook.template.sh
# 从 stdin（Claude）或 $1（Codex）读取事件 JSON
EVENT_TYPE=$(echo "$INPUT" | grep -oE '"hook_event_name"...' | ...)

# 通过 curl 异步通知本地 HTTP server
curl -sG "http://127.0.0.1:${PORT}/hook/complete" \
  --data-urlencode "eventType=$EVENT_TYPE" \
  --connect-timeout 1 --max-time 2 > /dev/null 2>&1
```

### 对 Flywheel 的适配

Flywheel 的 v0.1.1 plan 设计了 SessionEnd hook + marker file（`fs.watch()`）作为 primary path，pane_dead polling 作为 fallback。

**superset-ai 的方案更优**：用 HTTP callback 替代 marker file，避免文件系统 watch 的平台差异问题。

建议的实现路径：
1. TmuxRunner 启动一个轻量 HTTP server（或复用现有进程的端口）
2. 生成 notify hook 脚本（模板化），写入临时路径
3. 通过 `--settings` 注入到 claude 进程
4. HTTP callback 到达 → resolve Promise
5. Fallback：pane_dead polling 保持不变

## 3. Git Worktree 管理（superset-ai）

### 核心函数（可直接复制）

**创建 worktree**：
```typescript
// git.ts L452-518
async function createWorktree(
  mainRepoPath: string,
  branch: string,
  worktreePath: string,
  startPoint = "origin/main",
): Promise<void> {
  // ${startPoint}^{commit} 防止 implicit upstream tracking
  await execWorktreeAdd({ args: [
    "-C", mainRepoPath, "worktree", "add",
    worktreePath, "-b", branch, `${startPoint}^{commit}`
  ]});
  // 自动设置 push.autoSetupRemote
  await execFileAsync("git", ["-C", worktreePath, "config",
    "--local", "push.autoSetupRemote", "true"]);
}
```

**删除 worktree**（macOS 关键 trick）：
```typescript
// git.ts L651-708
async function removeWorktree(mainRepoPath, worktreePath): Promise<void> {
  // 先 rename 到临时目录（同文件系统，避免 EXDEV error）
  const tempPath = join(dirname(worktreePath), `.superset-delete-${randomUUID()}`);
  await rename(worktreePath, tempPath);
  // git worktree prune 清理 metadata
  await execFileAsync("git", ["-C", mainRepoPath, "worktree", "prune"]);
  // 后台 rm -rf（不阻塞调用方）
  const child = spawn("/bin/rm", ["-rf", tempPath], { detached: true, stdio: "ignore" });
  child.unref();
}
```

**检查 worktree 是否注册**：
```typescript
// git.ts L43-75 — porcelain 解析
async function isWorktreeRegistered({ mainRepoPath, worktreePath }): Promise<boolean> {
  const { stdout } = await execFileAsync("git",
    ["-C", mainRepoPath, "worktree", "list", "--porcelain"]);
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    if (resolve(line.slice("worktree ".length).trim()) === resolve(worktreePath)) return true;
  }
  return false;
}
```

**路径解析策略**：
```typescript
// resolve-worktree-path.ts
function resolveWorktreePath(project, branch): string {
  const baseDir = project.worktreeBaseDir
    ?? globalSetting?.worktreeBaseDir
    ?? join(homedir(), ".superset", "worktrees");
  return join(baseDir, project.name, branch);
}
```

### Flywheel 适配

Phase 2 并行执行时，每个 Linear issue 一个 worktree：

```
~/.flywheel/worktrees/
├── GEO-76/   ← issue GEO-76 的工作副本
├── GEO-78/   ← issue GEO-78 的工作副本
└── GEO-79/   ← issue GEO-79 的工作副本
```

直接复用 superset-ai 的 `createWorktree` / `removeWorktree` / `isWorktreeRegistered`。

## 4. Claude Code SDK Session Forking（ruflo）

### 原理

```typescript
// ruflo/v2/src/sdk/session-forking.ts
import { query, type Options } from '@anthropic-ai/claude-code';

const sdkOptions: Options = {
  forkSession: true,           // 复用会话，避免重复初始化
  resume: options.baseSessionId,
  model: 'claude-sonnet-4',
  maxTurns: 50,
};

const forkedQuery = query({ prompt, options: sdkOptions });
for await (const message of forkedQuery) {
  // 收集 streaming messages
}
```

### 优势

- 比 `tmux new-window` + `claude` CLI 快 10-20x（跳过初始化）
- 原生 TypeScript，不依赖 tmux
- 支持 streaming message 收集

### 劣势

- 用户**看不到**交互过程（非 TUI 模式）
- 需要 `@anthropic-ai/claude-code` SDK（当前 v0.1.1 用 CLI）

### Flywheel 适配建议

**Phase 1（v0.1.1）**：继续用 tmux（用户可见 = 核心需求）
**Phase 2（v0.2）**：混合模式
  - 用户在场（Present mode）→ tmux（可见）
  - 用户离开（Away mode）→ SDK forkSession（高效）

## 5. 命令构建（superset-ai）

### Heredoc 防转义

```typescript
// packages/shared/src/agent-command.ts
function buildHeredoc(prompt, delimiter, command, suffix): string {
  return [
    `${command} "$(cat <<'${delimiter}'`,  // 单引号 delimiter = 不展开变量
    prompt,                                  // prompt 原样输出
    delimiter,
    closing,
  ].join("\n");
}
```

TmuxRunner 构建 tmux 命令时可直接参考此模式。

## 6. Follow-up Session 建议

### Session R1: Hook 实现优化

**目标**：将 superset-ai 的 HTTP callback 模式整合到 v0.1.1 的 TmuxRunner 设计

**输入**：
- `superset-ai/templates/notify-hook.template.sh`
- `superset-ai/agent-wrappers-claude-codex-opencode.ts`
- Flywheel v0.1.1 architecture doc（SessionEnd hook 章节）

**输出**：
- 更新 v0.1.1 architecture：hook 实现从 marker file → HTTP callback
- 或保持 marker file 但增加 HTTP callback 作为 enhanced option

### Session R2: 并行化 Worktree 设计

**目标**：为 Phase 2 设计 worktree-based 并行执行架构

**输入**：
- `superset-ai/utils/git.ts`（完整 worktree API）
- `superset-ai/workspace-init-manager.ts`（per-project mutex）
- `ruflo/session-forking.ts`（SDK 模式）
- GeoForge3D orchestrator（现有 worktree 实践）

**输出**：
- `doc/exploration/new/v0.2-parallel-execution.md`
- Worktree lifecycle 设计 + present/away 模式切换
