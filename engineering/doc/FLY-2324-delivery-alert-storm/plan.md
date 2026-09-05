# FLY-2324 投递告警风暴收敛 — 实施计划
Issue: FLY-2324 (https://linear.app/geoforge3d/issue/FLY-2324/引擎告警-部署后-bridge-启动-baseline-全量铸-796-条陈年投递契约-episode35min-内-362)
日期: 2026-09-04
基于: research.md

## 目标与验收

部署后第一次及后续 maintenance pass 必须满足：

1. 同一批历史 mailbox/phase-wake/source 不再新铸 attempt/episode；已有不可达 attempt/episode 以
   `legacy_unreachable` 幂等收口。
2. 已有 `alerted_at` / `severe_alerted_at` 原样保留，收口 pass 不发任何新 warning/severe。
3. active/held run 的 terminal-unacked delivery 继续走 FLY-2278 undeliverable → successor reroute/hold，
   不被 legacy guard 截断。
4. completed/terminated/canceled run 不进入 divergence candidate；活跃 run 的 lifecycle revision 变化
   各记一次并收敛，不抛重复 `workflow_event_uid_conflict:divergence:*`。
5. 重放、异常回滚、边界时间与负控均由可执行测试证明；不修改生产数据库、不重启 Bridge。

流程说明：Engineering Lead 已确认本 execution 使用 `simple_code` graph，只有 implement 节点，没有
design node / design-review gate；Bridge 拒绝 `stage set plan` 是预期行为。本文件作为 durable
implementation brief 提交，随后直接进入 TDD；最终仍必须通过 REVIEW_CODE gate。

## 锁定决策

### Legacy reachability 判定顺序

对尚未 source-terminal 的投递：

1. attempt 已绑定 episode run 时，先读该 run：
   - active/held → **保护，继续现有 projector/watch/FLY-2278**；
   - 其他状态 → `legacy_unreachable`。
2. 未绑定 run 时，以 project + issue aliases 查询 current active/held run；存在则保护。
3. 无 current run 时，任一条件成立即 `legacy_unreachable`：
   - 可解析 recipient execution，而 StateStore session 已 operational-terminal 或不存在；
   - 本地 Linear observation 为 completed/canceled；
   - immutable source/attempt age 大于等于 7 天。
4. 无法解析 recipient、没有 terminal issue observation、age 未到 7 天时 fail-open，继续正常观察。

常量名固定为 `LEGACY_UNREACHABLE_AFTER_MS`，值 7 天，注释注明来源 FLY-2324。不给 flag/env。

### 闭包与事务

新增专用 StateStore closure seam，复用 delivery settlement transaction：

- attempt `settlement_reason='legacy_unreachable'`；
- 所有该 attempt 尚 open 的 episode 写 caller `now` 与精确
  `closed_reason='legacy_unreachable'`；
- 不改告警时间戳；已 settlement 重放 no-op；episode close 失败时 settlement 一起回滚。

### Divergence identity

- candidate SQL 增加 `r.status IN ('active','held')`。
- event UID 变成
  `divergence:<runId>:<nodeId>:<attempt>:<observedLifecycleRevision>`。
- check row 仍和 event append 在原事务；不吞 exception、不加仅内存 backoff。

## 文件清单

| 文件 | 改动 |
|---|---|
| `packages/teamlead/src/bridge/delivery-contract/legacy-reachability.ts` | 新增 7 天常量、按 pass 缓存的 guard 与判定结果 |
| `packages/teamlead/src/StateStore.ts` | alias-aware issue/run facts、专用 legacy settlement、divergence SQL/UID |
| `packages/teamlead/src/bridge/delivery-contract/projector.ts` | 对未终态 Comm source 在 project 前判定；skip mint 或收口存量 |
| `packages/teamlead/src/bridge/delivery-contract/watch.ts` | 在开 episode/alert 前执行同一 guard，作为 projector 失败/直接 attempt 的防线 |
| `packages/teamlead/src/__tests__/fly2324-delivery-legacy.test.ts` | projector/watch、存量、重放、回滚、7 天与 FLY-2278 阳性对照 |
| `packages/teamlead/src/__tests__/fly2324-divergence-convergence.test.ts` | terminal-run exclusion 与 revision-scoped convergence |
| `engineering/doc/FLY-2324-delivery-alert-storm/implementation-evidence.md` | RED/GREEN、production dry classification、验证结果与排除说明 |
| `engineering/doc/milestones/FLY-2324.md` | PR 最后一个 commit 的里程碑记录 |

不修改 `CLAUDE.md`，不新增 migration，不新增 `scripts/__tests__/*.test.sh`。

## TDD 实施顺序

每个 slice 严格执行“写一个测试 → 运行并确认因本缺口而红 → 最小实现 → 同命令绿”，不横向先写完
所有测试。

### Slice 1 — unbound terminal recipient 不新铸

在真实临时 CommDB 建一条未 ACK mailbox row，StateStore 中 recipient terminal，无 workflow run。
断言 projector `minted=0`、watch `opened=0/alerted=0`、StateStore 没有 live attempt/episode。

RED 命令：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/fly2324-delivery-legacy.test.ts \
  --exclude "**/tmux-viewer.macos.test.ts"
```

最小实现：legacy guard 的 recipient + no-run 分支，接入 mailbox projector。

### Slice 2 — FLY-2278 active-run 阳性对照

复制同形状 terminal-unacked row，但建立 active run/node；断言仍 mint、watch 打开 undeliverable episode，
添加 successor 后 `DeliveryOperations` reroute 成功。若 slice 1 guard 过宽，此测试必须红。

最小实现：run binding/current active-held 优先级；不得改 FLY-2278 operations。

### Slice 3 — 存量 episode 一次性原子收口

先按旧公开 seam 创建 warning → severe episode，保留其两个 alert timestamp；再跑 projector/watch。
断言精确 `settlement_reason`/`closed_reason`、timestamp 未变、第二 pass 0 新 episode/alert。

再加注入 close trigger 的 rollback 测试：attempt 仍 live、episode 仍 open。

最小实现：StateStore 专用 legacy settlement 与 projector/watch existing-attempt 路径。

### Slice 4 — phase wake、issue terminal 与 7 天边界

逐个 vertical case：

1. terminal/missing phase-wake recipient skip/close；
2. live recent unbound row 保持正常（负控）；
3. live unbound row在 7d-1ms 正常、7d 边界 legacy；
4. Linear UUID observation completed/canceled 通过 session identifier alias 命中并 legacy。

最小实现：source execution 提取、alias-aware facts 与 named constant。

### Slice 5 — terminal run 不进入 divergence

建立 engine-owned、done node、failed session，再把 run 分别置 completed/terminated；断言候选为空。
对照 active run 仍有一个候选。

最小实现：candidate SQL status guard。

### Slice 6 — lifecycle revision 变化只记一次

active run 首次 commit 后推进 session lifecycle revision，再次列出/commit；断言两条不同 event、check
前移、第三次候选为空，且不抛 uid conflict。

最小实现：event UID 加 revision。

## Refactor 与兼容回归

所有 slice 绿后才做 review-stage refactor：去重 projector/watch 的 evidence construction、保证每 pass 按
recipient/issue 缓存，删除任何临时 debug 标记。随后运行：

```bash
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/fly2324-delivery-legacy.test.ts \
  src/__tests__/fly2324-divergence-convergence.test.ts \
  src/__tests__/fly2278-mailbox-event-flow.test.ts \
  src/__tests__/fly2278-settle.test.ts \
  src/__tests__/StateStore.fly1385-dead-exec.test.ts \
  --exclude "**/tmux-viewer.macos.test.ts"
```

再运行 delivery-contract 同族测试，确认 baseline、projector、watch、reroute、settlement 均无回归。

## 生产存量 dry classification

仅只读查询生产 StateStore/CommDB，在最终实现算法同形 SQL/脚本下列出 07:30 batch：

- legacy_unreachable 数量与 reason 分布；
- 被 active/held run 保护的少数 request/root id、run status、recipient status；
- `severe_alerted_at` 非空且将被 closure 保留的数量。

实现节点不把新代码运行在生产 DB，不重启 Bridge。真正“重启后新铸 0 / 日志重复 0 / 8 月告警不升级”
由后续独立 QA/部署观察；本节点提供 fixture replay 与 production dry classification 的可审计前置证据。

## 完整验证门

按顺序运行：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run -- --exclude "**/tmux-viewer.macos.test.ts"
```

第三条保持完整 packages gate，仅按 Lead 红线排除会真实控制 Terminal.app 的
`packages/core/test/tmux-viewer.macos.test.ts`；排除原因写入 implementation evidence 和 PR。

没有新增 shell test，因此 `scripts/__tests__/*.test.sh` 无新增命令。若实现期间新增，则逐个执行。

## Review、PR 与完成

1. 进入 `code_review`，通过受保护的 `codex:rescue` companion 运行 review（绝不 raw
   `codex exec`）。
2. 注册 `review_code` gate，并以 `request-review --type code` 绑定 exact HEAD；只以结构化
   `reviewVerdict` 判定。blocking finding 修复后重新跑相关 RED/GREEN 与完整门，开新 gate/round。
3. APPROVED 后 push 分支并创建 PR；再次检查 inbox。
4. 创建 `engineering/doc/milestones/FLY-2324.md`，作为 PR literal last commit，push exact head。
5. 报告 Lead 后运行：

```bash
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr <NUMBER>
```

不 dispatch QA、不请求 ship approval、不 merge、不 deploy、不重启 Bridge/Lead。
