# FLY-2080 巡检升级 — QA 报告
Issue: FLY-2080 (https://linear.app/geoforge3d/issue/FLY-2080/巡检升级-发现即补账推进-病根记录进-epic所有-lead-巡检强制两步founder-8-26-直令)
日期: 2026-08-26
基于: plan.md

## 结论

FLY-2080 的规则、分发 seam 与回归断言均通过。全仓 lint/build 通过；全包测试已运行，命中的失败均为既有的真实 macOS/Keychain/npm cache 环境约束或默认 5 秒预算，逐文件隔离复跑后全部通过。未发现本改动引入的失败。

## 变更专项验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Patrol 规则 + Lead bundle 测试 | PASS | `2 files / 41 tests` |
| 修改脚本语法 | PASS | `bash -n packages/teamlead/scripts/claude-lead.sh packages/teamlead/scripts/lead-rules-bundle.sh` |
| 格式与空白 | PASS | 修改 TS 的 Biome check 与 `git diff --check` 均为 0 |
| 检测面/频率不变 | PASS | `packages/teamlead/scripts/lead-patrol-snapshot.sh` 无 diff；变更只在 finding 后的规则与所有 Lead 的规则分发 seam |

专项测试覆盖：founder 原话、步骤 A/B、反篡改/漏账分流、`FINDING.result` 枚举门、FLY-2072 comment 回执、两个 SQL 配方的表/字段/条件、CoS 与非 CoS Lead 的规则注入，以及旧版 `known-waiting`/`blocked` 结果拒绝。

## 全仓门禁

| 命令 | 结果 |
| --- | --- |
| `pnpm lint` | PASS（仅既有 advisory warnings） |
| `pnpm -r build` | PASS，22 个 workspace package 构建完成 |
| `pnpm test:packages:run` | 已完整运行；见下方环境/时序复验 |

全包测试首轮暴露的非本改动失败及复验：

- `flywheel-core`：真实 macOS Terminal/AppleScript 用例因 sandbox 的 `com.apple.hiservices-xpcservice Connection invalid` 失败；排除该 OS integration 文件后 `19 files / 219 tests` 通过。
- `flywheel-claude-runner`：全包并发下 worker RPC / real-tmux 默认 5 秒超时；目标 real-tmux 文件以 20 秒预算复跑，`2/2` 通过。
- `flywheel-comm`：全包并发下一个 CLI nudge 用例默认 5 秒超时；目标用例以 20 秒预算复跑通过。
- `flywheel-teamlead`：首轮 `723 files / 9,614 tests` 通过，8 个失败集中在 npm cache 所有权与默认 5 秒预算。失败文件隔离复验全部通过：
  - `StructuredInboxRouter.test.ts`：`19/19`；
  - `shell-publish.e2e.test.ts`：改用可写 npm cache 后 `24/24`；
  - `claude-profile-cli.integration.test.ts`：20 秒预算下 `3/3`；
  - `createLeadRuntime-preflight.test.ts`：20 秒预算下 `4/4`；
  - `terminal-thread-archive.test.ts`：20 秒预算下 `22/22`。

FLY-2080 的专项测试在全量 Teamlead 运行中也通过：`fly369-patrol-rule.test.ts` 的 `20/20` 全绿。

## Code review R1 修复复验

R1 的两个 HIGH finding 已按 RED→GREEN 处理：

- 接力查询明确排除巡检自己写入的 `patrol:FLY-2080:%` event，Bridge 停机时不能再靠 repair receipt 假绿；
- 恢复原有 role boundary：`runner-patrol-rules.md` 只注入会收到 `patrol_tick` 的 dispatch-capable department Lead，`canSpawnRunners=false` 的 CoS 不获得无效且越界的 Runner/DB 操作面。

同时消除内嵌 awk 的跨实现命名碰撞。新增断言先以 `4 failed / 37 passed` 证明能抓住旧行为，修复后 `2 files / 41 tests` 通过；随后 `pnpm lint`、`pnpm -r build`、脚本 `bash -n`、`git diff --check` 再次通过。

## 风险核对

- SQL 配方保留事务、CAS、外键和备份前置条件，不把修账脚本升级为绕过真实性守卫的手段。
- `escalated-with-plan` 必须带 owner/next_action/due_at 与 founder 上报凭证，不能伪装成「known/waiting」。
- 每个处置项必须写 FLY-2072 comment 并记录 comment URL/id；验证 Bridge 接力失败时不得报 `fixed`。
- 未改巡检 snapshot、检测查询或 cadence。
