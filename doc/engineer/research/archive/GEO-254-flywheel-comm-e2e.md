# Research: flywheel-comm E2E Testing Strategy — GEO-254

**Issue**: GEO-254
**Date**: 2026-03-28
**Source**: `doc/engineer/exploration/new/GEO-254-flywheel-comm-e2e.md`

## 1. Current Test Inventory

| File | Lines | Scope | Method |
|------|-------|-------|--------|
| db.test.ts | 309 | CommDB CRUD, WAL, migration, sessions, readonly | Direct API |
| commands.test.ts | 112 | ask/check/respond/pending round-trip | Function import |
| cli.test.ts | 271 | CLI ask/check/respond/pending + DB path resolution | execFileSync (process) |
| cleanup.test.ts | 528 | cleanupStaleSessions | Mocked tmux |
| resolve-db-path.test.ts | 41 | Path resolution priority | Function import |

**Total**: 1,261 lines, 5 suites

## 2. Identified Gaps

### A. Zero-Coverage Commands (Critical)

| Command | Function Test | CLI Test | Notes |
|---------|--------------|----------|-------|
| send | ❌ | ❌ | Lead → Runner instruction |
| inbox | ❌ | ❌ | Runner reads instructions + auto mark-read |
| sessions | ❌ | ❌ | List sessions with filters |
| capture | ❌ | ❌ | Requires tmux (mock in CI) |

### B. Missing Integration Workflows

1. **send → inbox round-trip**: 零覆盖。send 插入 instruction → inbox 读取并 mark read → 再次 inbox 应为空
2. **Session lifecycle via CLI**: register (library) → sessions list → status update → sessions filter
3. **Multi-agent isolation**: 多个 lead 的 pending 互不干扰，多个 runner 的 inbox 互不干扰
4. **inbox idempotency**: inbox 调用 markInstructionRead，第二次调用应返回空

### C. Cross-Package Data Contract

TmuxAdapter 写入 CommDB 的 session 数据必须能被 Bridge 的 tmux-lookup 和 session-capture 正确读取。
当前没有任何测试验证这个数据契约。

## 3. Test Infrastructure Findings

### vitest 配置
- flywheel-comm 没有 vitest.config.ts（使用 vitest 默认配置）
- 默认 test include: `**/*.{test,spec}.{ts,tsx,js,jsx}`
- CLI tests 需要 `pnpm build` 先编译（引用 `dist/index.js`）

### CLI test pattern (已验证可行)
```typescript
const CLI_PATH = path.resolve(__dirname, "../../dist/index.js");
function runCli(args: string[]): string {
  return execFileSync("node", [CLI_PATH, ...args], { encoding: "utf-8" }).trim();
}
```

### tmux 依赖
- capture 和 cleanup 都依赖 tmux server
- CI 环境通常没有 tmux
- 策略：capture CLI test 标记为 `it.skipIf(!hasTmux)` 或 mock

## 4. Test Design Decisions

### 文件组织
在现有 `__tests__/` 目录下新增：
- `e2e-workflows.test.ts` — 完整工作流（CLI 进程级）
- `e2e-send-inbox.test.ts` — send/inbox 命令测试（函数级 + CLI 级）
- `e2e-sessions.test.ts` — sessions/capture 命令测试

理由：遵循现有 test 文件命名惯例，按功能分文件而非全部放一个巨大文件。

### 测试层级
1. **Function-level**: 直接 import command function，验证数据正确性（快，可靠）
2. **CLI-level**: execFileSync 调用编译后的 CLI，验证 arg parsing + output format
3. **Cross-package**: import CommDB + Bridge modules，验证数据契约（仅在 flywheel-comm 内做 CommDB 层面的验证）

### temp DB 策略
每个 test suite 用 `mkdtempSync` 创建独立 temp 目录 + DB，afterEach 清理。
这是现有 test 的一致模式。

## 5. 预期测试矩阵

| Test | Type | Commands Covered | Est. Cases |
|------|------|-----------------|------------|
| send → inbox round-trip | Function + CLI | send, inbox | 6 |
| send → inbox multi-agent isolation | Function | send, inbox | 3 |
| inbox idempotency (mark-read) | Function + CLI | inbox | 2 |
| sessions list + filters | Function + CLI | sessions | 5 |
| capture (mock tmux) | Function | capture | 3 |
| Full Q&A workflow (CLI) | CLI | ask, pending, respond, check | 2 |
| Full instruction workflow (CLI) | CLI | send, inbox | 2 |
| Session lifecycle (CLI) | CLI | sessions | 3 |
| Concurrent WAL (mixed read/write) | Function | send, inbox, sessions | 2 |
| Edge: DB not exists → graceful | Function | inbox, sessions, check | 3 |
| **Total** | | | **~31** |

## 6. Scope Boundaries

**In scope**:
- CLI process-level E2E for all 8 commands
- Function-level integration for send/inbox/sessions/capture
- Multi-agent isolation verification
- Graceful degradation (missing DB, empty results)

**Out of scope**:
- Real tmux session interaction (capture uses mock)
- Cross-package import tests (TmuxAdapter, Bridge) — these belong in their respective packages
- Bridge HTTP API tests — belongs in teamlead package
- Real Claude CLI invocation
