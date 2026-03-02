# Ralph 可复用模式参考

> 来源: [snarktank/ralph](https://github.com/snarktank/ralph) (11.5k stars)
> 日期: 2026-02-27

## 概述

Ralph 是一个 ~100 行 bash 脚本实现的自治 AI agent 循环。核心理念：**orchestrator 越简单越好，所有智能交给 LLM**。

```
prd.json → bash loop → spawn fresh Claude/Amp → AI picks story →
implement → test → commit → update prd.json → log learnings →
check completion → loop or exit
```

## 核心循环 (ralph.sh)

```bash
for i in $(seq 1 $MAX_ITERATIONS); do
  OUTPUT=$(claude --dangerously-skip-permissions --print \
    < "$SCRIPT_DIR/CLAUDE.md" 2>&1 | tee /dev/stderr) || true

  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo "Ralph completed all tasks!"
    exit 0
  fi
  sleep 2
done
exit 1
```

**设计亮点**:
- `|| true`: spawn 永不崩，失败是下一轮的输入
- `tee /dev/stderr`: 实时流式输出 + 变量捕获
- `<promise>COMPLETE</promise>`: AI → orchestrator 的完成信号
- 每轮完全无状态，所有 state 在文件里

## 可复用模式

### 1. Sentinel 完成信号 ⭐ 直接采纳

AI 通过 stdout 输出约定的 XML tag 通知 orchestrator。

```typescript
const SENTINELS = {
  complete: /<flywheel>COMPLETE<\/flywheel>/,
  blocked:  /<flywheel>BLOCKED:\s*(.+?)<\/flywheel>/,
  error:    /<flywheel>ERROR:\s*(.+?)<\/flywheel>/,
};

function parseSentinel(output: string):
  | { status: "complete" }
  | { status: "blocked"; reason: string }
  | { status: "error"; message: string }
  | { status: "unknown" } {
  if (SENTINELS.complete.test(output)) return { status: "complete" };
  const blocked = output.match(SENTINELS.blocked);
  if (blocked) return { status: "blocked", reason: blocked[1] };
  const error = output.match(SENTINELS.error);
  if (error) return { status: "error", message: error[1] };
  return { status: "unknown" };
}
```

### 2. Append-only 学习日志 ⭐ 直接采纳

每轮迭代追加 learnings，顶部浓缩 patterns。

```
## Codebase Patterns                    ← 浓缩，先读
- migration 用 IF NOT EXISTS
- API 用 zod 校验 input

## 2026-02-27 14:30 - PROJ-42           ← 时间线追加
- 实现了 priority 字段
- 发现: migration 必须幂等
- 文件: src/db/migrations/003.sql
---
```

**Flywheel 映射**: `.flywheel/learnings.md`，PreHydrator 注入 prompt。比 event-sourced SQLite 简单得多，Phase 1 足够。

### 3. `|| true` 韧性 ⭐ 直接采纳

```typescript
// 非零退出码 ≠ 没有产出
// Claude 可能写了一半代码后 crash
try {
  const result = await runner.run(request);
  return result;
} catch {
  // Check if partial progress was made (files changed, commits created)
  const hasProgress = await checkGitDiff(projectRoot);
  return { success: false, partialProgress: hasProgress, costUsd: 0, sessionId: "" };
}
```

### 4. 双层知识沉淀 — Session + Project 级别

| 层 | Ralph | Flywheel 映射 |
|----|-------|--------------|
| Session | `progress.txt` (本次 run 的 learnings) | `.flywheel/learnings.md` |
| Project | `AGENTS.md` / `CLAUDE.md` (持久 patterns) | 项目 CLAUDE.md + `.flywheel/patterns.md` |

AI 发现的 pattern 不仅服务当前 run，还写入项目配置，让未来的开发者受益。

### 5. Story Sizing 作为质量杠杆

不在 runtime 做复杂的 context 管理，在 **input 阶段** 确保每个任务一个 context window 能完成。

```typescript
// Dispatch 前检查 issue 复杂度
function validateIssueScope(issue: LinearIssue): { ok: boolean; warning?: string } {
  const descLength = (issue.description || "").length;
  const criteriaCount = (issue.acceptanceCriteria || []).length;

  if (descLength > 5000 || criteriaCount > 10) {
    return { ok: false, warning: "Issue too large for single context window. Consider splitting." };
  }
  return { ok: true };
}
```

## Ralph vs Flywheel 对比

| 维度 | Ralph | Flywheel |
|------|-------|---------|
| 复杂度 | ~100 LOC bash | ~3000 LOC TypeScript |
| 任务来源 | 本地 prd.json | Linear API |
| 依赖 | 手动 priority 排序 | DAG 拓扑排序 |
| 记忆 | 文件 (progress.txt) | SQLite + sqlite-vec (planned) |
| 错误恢复 | `|| true` 重试 | 分类 + Decision Layer |
| 花费追踪 | 无 | $5/$10 per issue |
| 通知 | `exit 1` | Slack → OpenClaw → CEO |
| 并行 | 无 | Phase 3+ |
| 安全 | `--dangerously-skip-permissions` | Blueprint shell mock + 白名单 |

## 关键启示

**Ralph 证明了**: 一个极简的 "spawn fresh AI per iteration" 循环可以非常有效。Orchestrator 不需要复杂——LLM 本身就是智能层。

**对 Flywheel 的启示**:
- Phase 1 的记忆系统用 `progress.txt` 模式（append-only markdown）而非 SQLite
- Sentinel 信号是 zero-cost 的 IPC 方案
- 不要把 orchestrator 做成 "smart" 的——保持它 "dumb but resilient"
- LLM 模型迭代速度极快，今天 over-engineer 的复杂逻辑明天可能被更好的模型直接解决
