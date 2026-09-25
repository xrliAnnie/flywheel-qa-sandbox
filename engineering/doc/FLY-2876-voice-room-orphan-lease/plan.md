# FLY-2876 同 slot 孤儿语音房锁 start 自愈 — 实施计划
Issue: FLY-2876 (https://linear.app/geoforge3d/issue/FLY-2876/病根529-语音房-语音会话自然结束-测试房被拆后语音房锁-tmpflywheel-voice-room-guild-channellock)
日期: 2026-09-25
基于: 无（上游设计为 engineering/doc/FLY-2867-extra-lead-inbox-lease/plan.md 部件 C；范围由 Lead 2026-09-25 裁定选项 B）

## 背景与范围

FLY-2867 PR #1323（头 `709b576`）已覆盖本单 QA 判据 2（别的 slot 的锁仍拒绝）与判据 3（teardown Step 6b 释放本 slot 的锁）。
**未覆盖的是事故本体**：同一 slot 被重新部署后，`/tmp/flywheel-voice-room-<guild>-<channel>.lock/owner.json`
里的 `slotDir` 仍等于本 slot，回执已随旧 slot 目录删除、也没有存活进程 ——
`acquireVoiceRoomLease` 对同 slotDir 直接返回 `{created:false}`，`start` 用 `check(lease.created, "voice_room_lease_already_owned")` 拒绝，
正规路径只剩「再拆一次 slot」能清。会话自然结束（daemon 退出、回执仍是 `STARTED`）后也同样被挡。

本单只补这一个缺口；不改 teardown、不改异 slot 回收规则、不改 voice-codex daemon。

## 设计

改动只在 `scripts/qa/fly2655-voice-room.mjs` 的租约函数：

```mermaid
flowchart TD
  A[mkdir lease] -->|EEXIST| B{owner.slotDir == 本 slot?}
  B -->|否| C[#1323 原逻辑: 旧 slot 目录已消失且无活 daemon 才回收, 否则 conflict]
  B -->|是| D{holder / daemon / STARTED 回执 任一仍活?}
  D -->|是| E[created:false → start 报 already_owned（行为不变）]
  D -->|否 = 孤儿| F[rename→tombstone→复核仍孤儿→删] --> A
```

1. **`holder` 记录**：新建租约时在 owner.json 写 `holder: {pid: process.pid, processIdentity}`（执行 start 的 CLI 进程）。
   它覆盖「租约已建、daemon 尚未记录、回执尚未写」那段窗口，保证并发的第二个 `start` 仍被 `already_owned` 挡住，不因本改动退化。
2. **同 slot 孤儿判定** `orphanedSameSlotLease(owner)`：以下三者**都不活**才算孤儿：
   - `owner.holder`（pid + `ps` 身份一致才算活）；
   - `owner.daemon`（#1323 已有的 `recordedDaemonAlive`）；
   - `<slotDir>/voice-run-receipt.json`：经 `trusted()` 读取；`ENOENT` → 不活；`status === "STOPPED"` → 不活；
     其余状态按 `pid` + `processIdentity` 判断。**读取失败 / 不可信（软链接、越界）/ 字段畸形一律按「活」处理**，宁可不回收。
   记录类字段（holder/daemon）缺省 = 不活、畸形 = 活，与 #1323 `recordedDaemonAlive` 语义一致；
   为此把它的函数体抽成 `recordedProcessAlive(record)` 复用，`recordedDaemonAlive` 行为不变。
3. **回收**：复用 #1323 的 tombstone 流程，把 `reclaimStaleVoiceRoomLease` 参数化为 `(path, stillStale, reason)`：
   rename 后用同一判定复核，复核不过就 rename 回去并以 `reason` 失败（同 slot 用 `voice_room_lease_already_owned`，异 slot 保持 `voice_room_lease_conflict`）。
4. **「会话自然结束」**：daemon 退出后 holder（start CLI 早已退出）、daemon、回执 pid 均不活 ⇒ 下一次 `start` 自动回收。
   不在 voice-codex 里加退出钩子（跨包耦合且 daemon 被 SIGKILL 时钩子也不跑）。
5. `start()` 本身不改：它仍要求 `lease.created`，只是孤儿锁现在会在 acquire 里被回收成 `created:true`。

## 已知限制

- 合入前遗留的租约没有 `holder`/`daemon` 字段；若其回执也已删除，但一个未登记的旧 daemon 仍在跑，本判定无法识别，会按孤儿回收。
  这与 #1323 teardown Step 6b 对「无 daemon 记录」租约的既有规则一致（同样释放），不另开新口子。

## 测试（先红后绿，`scripts/__tests__/fly2655-voice-room.test.mjs`，用临时 `root` + 临时 slot 目录，不碰真实 `/tmp` 租约）

| # | 场景 | 期望 |
|---|------|------|
| T1 | 同 slot 租约，无 holder/daemon，无回执（事故本体） | `created:true`，owner.json 是新记录，无 `.stale-` 残留 |
| T2 | 同 slot，回执 `STARTED` 且 pid+身份存活 | `created:false`，租约原样不动 |
| T3 | 同 slot，owner.daemon 存活（回执缺失） | `created:false` |
| T4 | 同 slot，回执 `STARTED` 但 pid 已死、daemon 记录已死（自然结束） | `created:true` |
| T5 | 同 slot，回执是软链接 / 不可解析 | `created:false`（宁可不回收） |
| T6 | 同进程连续两次 acquire（holder 活） | 第二次 `created:false`（既有幂等用例继续绿） |
| T7 | 异 slot 规则 | #1323 既有用例全部保持绿 |

新增测试里的 `process.kill` 需同步登记到 `packages/claude-runner/test/fixtures/kill-path-inventory.json`（qa-only）。

## 验证（仅与改动直接相关）

- `node --test scripts/__tests__/fly2655-voice-room.test.mjs`
- `packages/claude-runner` 的 `kill-path-inventory.test.ts`（登记表消费者）
- `pnpm lint`；`git grep -lF` 查 `fly2655-voice-room` 的其余消费者并逐个记录取舍。

## 交付顺序（Lead 裁定）

在 `709b576` 之上本地开发；**#1323 合入前不开 PR**，做完即 `ask` Lead 并停住等待；
#1323 合入后 rebase 到 `origin/main`（只重放本单提交），对 main 开 PR，里程碑文件作为最后一个提交。
