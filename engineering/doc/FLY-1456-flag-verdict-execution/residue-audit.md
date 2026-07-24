# FLY-1456 62 flag 逐条定值执行 — 残留审计
Issue: FLY-1456 (https://linear.app/geoforge3d/issue/FLY-1456/flag治理清存量eng-62-flag-逐条定值执行-按-hl-盘点圈选-删固化动态化承接-fly-1413)
日期: 2026-07-24
基于: execution-ledger.md

## 1. 审计口径

- 裁决与 62 条全集固定来自 `67b35748` 的 `tab-decisions.js` / `snapshot.json`，不从实现后的活 registry 反推。
- 「活残留」指 production source、当前运维脚本、活规范或活 runbook 中仍可能作为可配置开关读取/设置的引用。
- 「历史引用」指 FLY-1413 审计证据、FLY-1456 计划/台账、归档设计文档和测试墓碑断言；这些引用用于解释迁移，不是运行时 authority。
- 审计实现基线为 G1-G4 末端 `6c36c2e6`；PR 为 #695，merge SHA 在 founder-gated merge 前保持 `pending`。

## 2. 14 条代码动作闭环

| group | flag | registry | production read / setup write | tombstone |
|---|---|---|---|---|
| G1 | `park_watch`、`park_watch_cadence`、`park_watch_n1_ms`、`park_watch_n2_ms`、`park_watch_qa_n3_ms` | 0 | 0；park-watch 保留固定默认值 | 5/5，`retiredBy=FLY-1456` |
| G2 | `delivery_ack`、`delivery_unconsumed_v2`、`delivery_ack_timeout_ms`、`delivery_max_redeliver`、`delivery_max_transport_failures`、`ack_late_window_ms` | 0 | 0；legacy coordinator 保留固定参数 | 6/6，`retiredBy=FLY-1456` |
| G3 | `legacy_delivery_watchdogs`、`checkpoint_watchdog` | 0 | 0；checkpoint-park patrol 已删除 | 2/2，`retiredBy=FLY-1456` |
| G4 | `quota_daemon_cutover` | 0 | 0；setup 源码也对该变量零引用 | 1/1，`retiredBy=FLY-1456` |

G3 同时清掉只服务 checkpoint patrol 的非 flag 调参
`FLYWHEEL_CHECKPOINT_STUCK_MS`：production read、allowlist 和活操作步骤均为 0。

G4 固化后的运行真值为：

```text
cutover=true
attachAccountSwitch=false
runAccountSwitchWatchdog=false
retireAccountSwitchRoute=true
quarantinePending=true
runRunnerQuotaScan=true
```

认证层保持不变：tokenless `/api/account-switch` 返回 503；认证后固定返回 410。
`setup-quota-monitor.sh` 的 `enable` 不再写 env / 重启 Bridge；`--monitor-only`
和 `--disable` 都在运行时明确打印 automatic switching OFF + NO Bridge fallback。

## 3. 62 条台账闭环

| 项目 | 结果 |
|---|---|
| 唯一 flag 行 | 62 |
| 与 pinned `newSinceBaseline` 的 missing / extra | 0 / 0 |
| 分桶 | `40 + 1 + 12 + 2 + 6 + 1 = 62` |
| 删除 | 13 |
| 固化后删 flag | 1 |
| 零代码动作 | 46 |
| FLY-1405 动态化候选 | 45 |
| FLY-1446 owner | `cmux_linked_view` 1 条 |
| FLY-1436 RESERVED | 2 条 |
| PR 记录 | 62/62 均为 #695 |
| merge SHA | 62/62 均为 `pending`（合入前不得伪造） |

## 4. RESERVED 红线

`workflow_template_dispatch` 与 `workflow_generalized_templates` 均未进入任何
G1-G5 代码 diff；registry、默认值、读点和测试保持原状。两条继续由 FLY-1436
独占，FLY-1456 只在台账中记录「RESERVED，不碰」。

相邻但不属于本单 62 条名单的 `issue_status_emoji` 与 `issue_status_word`
也保持活 registry、默认值和全部读点原状，FLY-1456 source diff 为 0。它们已由
Lead 指令 `[lead-instruction 015578a7-1c2c-4094-9ff0-44904b3fbb99]`
锁给 FLY-1150 pilot，本单不删除、不固化。

## 5. 活引用与历史引用分栏

### 活引用（已收敛）

- `packages/config/src/feature-flags/registry.ts`：14 个目标定义均不存在。
- `packages/teamlead/src/**` 与 `packages/config/src/**`（排除测试与
  `feature-flags/truth.ts`）：14 个 env 名零命中。
- `scripts/setup-quota-monitor.sh`：`FLYWHEEL_QUOTA_DAEMON_CUTOVER` 零命中。
- `doc/architecture/infra-alerts-spec.md`、FLY-1049 enable runbook、FLY-1182
  recovery runbook：均已改为 FLY-1456 墓碑/永久退役口径。

### 历史/审计引用（刻意保留）

- FLY-1413 audit snapshot、收敛裁决和相关历史设计证据保持不动，保证 provenance。
- 本文件夹 exploration/research/plan/design-review/ledger 保留 flag 名，解释裁决与执行链。
- 测试保留 tombstone 断言和 setup fake-restart 负向哨兵；它们证明旧变量不能复活，
  不构成 production read。
- `feature-flags/truth.ts` 保留 14 个 `RETIRED_FLAGS` 墓碑，遇到生产 `.env`
  残留时 fail-loud 提示删除。

## 6. 可复核命令

```bash
pnpm --filter flywheel-config test
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/account-switch-route.test.ts \
  src/__tests__/quota-daemon-cutover.test.ts \
  src/__tests__/account-selfheal-bytecompat.test.ts
bash scripts/__tests__/setup-quota-monitor.test.sh
bash scripts/qa-fly-1252-quota-state-e2e.sh
pnpm lint
pnpm -r build
pnpm test:packages:run
```

最终 head 验证结果：

- `flywheel-config`：31 files / 554 tests 全绿。
- G4 Teamlead 聚焦：3 files / 7 tests 全绿。
- `setup-quota-monitor.test.sh`：17/17；`qa-fly-1252-quota-state-e2e.sh`：
  3 个真场景全绿。
- `pnpm lint`：2,343 files，0 error（15 个既存 warning）；`pnpm -r build`：
  全 workspace 通过。
- `pnpm test:packages:run` 在当前 resident/headless 沙箱不能干净退出：原始运行
  只有 2 个 Terminal.app/`osascript` GUI 用例失败；按测试自带的 headless skip
  路径重跑后，core 219 pass / 3 skip、flywheel-comm 1236/1236、
  claude-runner 725 pass / 2 skip，但 Vitest worker 随后报
  `Timeout calling "onTaskUpdate"`。进一步把 claude-profile 拆成 7 个 fresh-worker
  shard，112/112 assertions 全绿；Teamlead 聚合运行到 9,400/9,410，5 个负载/沙箱
  失败文件的隔离复跑全绿，余下 2 个未改 preflight timing/mock-order 用例与 2 个
  未改 FLY-247 shell suite 仍受当前 runtime 影响。相关失败文件均无 branch diff，
  因此这里如实记录环境/测试框架例外，不把 canonical package gate 标成通过。

代码审查在 PR #695 最终 head 上单独发起；pending verdict 不写成已通过。
