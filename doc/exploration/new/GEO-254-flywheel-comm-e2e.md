# Exploration: flywheel-comm E2E Integration Verification — GEO-254

**Issue**: GEO-254 (E2E 验证：flywheel-comm Runner 提问链路)
**Date**: 2026-03-28
**Status**: Complete

## Background

flywheel-comm 是 Lead ↔ Runner 双向通信的核心：SQLite-backed message queue，提供 CLI + library API。
当前有 5 个 unit test suite（1261 行），覆盖了 CommDB CRUD、command function 调用、CLI arg parsing、cleanup mock、path resolution。

但 **缺少真正的 E2E 集成验证**：
- send/inbox CLI 完全没有测试
- sessions/capture CLI 完全没有测试
- 跨包集成（TmuxAdapter → CommDB → Bridge）没有验证
- 完整工作流（CLI → DB → CLI）只覆盖了 ask/check/respond/pending

## 现有测试覆盖分析

| 模块 | Unit Test | CLI Test | E2E Integration |
|------|-----------|----------|-----------------|
| ask/check/respond/pending | ✅ commands.test.ts | ✅ cli.test.ts | ❌ |
| send/inbox | ❌ | ❌ | ❌ |
| sessions/capture | ❌ | ❌ | ❌ |
| cleanup | ✅ (mocked tmux) | ❌ | ❌ |
| DB path resolution | ✅ resolve-db-path.test.ts | ✅ cli.test.ts | ❌ |
| Cross-package (TmuxAdapter) | ❌ | N/A | ❌ |
| Cross-package (Bridge) | ❌ | N/A | ❌ |
| Concurrent WAL access | ✅ db.test.ts (basic) | ❌ | ❌ |

## E2E 验证目标

### Workflow 1: Question-Answer 完整链路
```
Runner CLI ask → comm.db → Lead CLI pending → Lead CLI respond → Runner CLI check
```
- 验证 CLI 进程间通过 SQLite 的数据传递
- 验证 JSON output 格式一致性
- 验证 multi-lead 隔离

### Workflow 2: Instruction 完整链路
```
Lead CLI send → comm.db → Runner CLI inbox → mark read → inbox empty
```
- 验证 send/inbox round-trip（当前零覆盖）
- 验证 mark-read 语义
- 验证 multi-runner 隔离

### Workflow 3: Session Lifecycle
```
register session → list sessions → capture output → update status → cleanup
```
- 验证 sessions CLI listing
- 验证 session status transitions
- 验证 capture 命令（需要 mock tmux 或 skip）

### Workflow 4: Cross-Package Integration
```
TmuxAdapter.registerSession() → CommDB → Bridge tmux-lookup → Bridge session-capture
```
- 验证 TmuxAdapter 写入的数据能被 Bridge 正确读取
- 验证 readonly mode 并发访问
- 验证 dynamic timeout (hasPendingQuestionsFrom)

### Workflow 5: Edge Cases & Robustness
- DB 不存在时的 graceful degradation
- 过期消息 purge
- UNIQUE constraint enforcement（duplicate response）
- path traversal guard（session-capture）

## 方案选项

### Option A: flywheel-comm 内 E2E test suite
在 `packages/flywheel-comm/src/__tests__/` 新增 `e2e-*.test.ts`。
- CLI 测试：spawn 真实 CLI 进程，通过共享 temp DB 验证数据流
- Cross-package 测试：直接 import TmuxAdapter / Bridge 模块，验证集成

**优点**: 集中管理，容易跑 CI
**缺点**: 跨包 import 复杂，monorepo 依赖顺序

### Option B: 独立 E2E test suite (推荐)
在 `packages/flywheel-comm/src/__tests__/` 新增纯 CLI E2E 测试（spawn process）。
跨包测试放在各自 package 的 test 中。

**优点**: 职责清晰，不引入跨包依赖
**缺点**: 分散

### Option C: 根级 integration test
在 monorepo root 新增 `tests/integration/` 目录。

**优点**: 自然跨包
**缺点**: 新目录，需要额外配置

## 推荐方案

**Option B** — 在 flywheel-comm 内新增 E2E 测试文件：
1. `e2e-workflows.test.ts` — Workflow 1-3（纯 CLI 进程级测试）
2. `e2e-integration.test.ts` — Workflow 4（跨包 library import 集成测试）
3. `e2e-edge-cases.test.ts` — Workflow 5（边界条件和健壮性）

所有测试使用 temp DB，不依赖真实 tmux session（capture 相关 mock tmux）。

## Scope 约束

- **In scope**: CLI 进程级 E2E、library API 集成、CommDB 数据流验证
- **Out of scope**: 真实 tmux session 管理（需要 tmux server，CI 不稳定）、真实 Claude CLI 调用、Discord/Bridge HTTP API 测试
- capture 命令涉及 tmux：使用 mock 或标记为 skip-in-ci
