# FLY-2876 同 slot 孤儿语音房锁 — 调研
Issue: FLY-2876 (https://linear.app/geoforge3d/issue/FLY-2876/病根529-语音房-语音会话自然结束-测试房被拆后语音房锁-tmpflywheel-voice-room-guild-channellock)
日期: 2026-09-26
基于: exploration.md

## 1. 调研目标

exploration.md 推荐方案 A，且该方案已作为「候选实现」存在于本分支。调研要回答三件事：
(1) 分支上的实现是否逐条对应方案 A 的设计要点；(2) 三条硬红判据各由哪条测试证明；(3) 剩余风险与不做的事。

## 2. 实现与设计要点的对应（`scripts/qa/fly2655-voice-room.mjs`）

| 设计要点 | 函数 / 位置 | 核对结果 |
|------|------|------|
| 锁目录 `mkdir` 原子创建，owner.json 在目录内 | `roomLeasePath` :805, `acquireVoiceRoomLease` :912 | 与 #1323 一致 |
| 建锁记录 `holder`（执行 start 的 CLI 进程 pid + `ps` 身份） | :916–919, :937 | 覆盖「锁已建、daemon/回执未写」窗口，并发 start 仍被挡 |
| 每把新锁带 `leaseId`（`randomUUID`），`acquire` 返回，`start` 写进回执 | :928, :940, :1218 | 已实现 |
| 建锁前先查本 slot 回执，未 `STOPPED`（含读不了）⇒ `created:false` 不建锁 | :925 `liveRunReceipt(topology.slotDir)` | R3 修法；`stop` 释放锁→写 STOPPED 的空档被封 |
| 同 slot 孤儿判定 = holder 不活 ∧ daemon 不活 ∧ 回执缺失或 `STOPPED` | `orphanedSameSlotLease` :869 | `STARTED` 回执不论 daemon 死活一律算活（R2 裁定 A） |
| 回执经 `trusted()` 读取；软链接 / 越界 / 畸形 ⇒ 算活 | `liveRunReceipt` :855；仅 `ENOENT` 算不活 | fail closed，宁可不回收 |
| 记录类字段：缺省 = 不活，畸形 = 活 | `recordedProcessAlive` :829（从 #1323 `recordedDaemonAlive` 抽出，行为不变） | 向后兼容旧锁 |
| 回收复用 #1323 tombstone：rename → 复核 → 删；复核不过放回并以 reason 失败 | `reclaimStaleVoiceRoomLease(path, stillStale, reason)` :897 | 同 slot 用 `voice_room_lease_already_owned`，异 slot 保持 `voice_room_lease_conflict` |
| 异 slot 规则不变 | `staleVoiceRoomOwner` :883；acquire :951–961 | 只回收「owner 的 529 slot 目录已消失且无存活 daemon」 |
| `releaseVoiceRoomLease` 只释放同代次；旧锁与旧回执都无 `leaseId`（`undefined === undefined`）照旧配对 | :977–988 | ABA 纵深防御 |
| `stop` 收尾 `settleStoppedVoiceRun`：按代次释放；重读回执，`sessionId`+`leaseId` 仍是本 run 才写 `STOPPED` | :992–1019；`stop` :1287 调用 | 重放的旧 stop 不覆盖新 run 回执 |
| `start()` 本身不改，仍 `check(lease.created)` | :1081–1082 | 孤儿锁在 acquire 内回收成 `created:true` |
| teardown Step 6b / `release-slot-leases` 不改 | `scripts/test-teardown.sh` :1251–1273；`releaseVoiceRoomLeasesForSlot` :1023 | #1323 原样 |
| voice-codex 不改 | `packages/voice-codex/src` 无 `voice-run-receipt` / `flywheel-voice-room` 引用 | 无跨包耦合 |

**上游引用核对**：本分支上的 `engineering/doc/FLY-2867-extra-lead-inbox-lease/plan.md` 是 FLY-2867 的 inbox 租约设计，
只有 6 处提到语音房，不含 plan.md 所称的「部件 C」正文；语音房锁的上游事实以已合入代码（#1323 的 `staleVoiceRoomOwner` / Step 6b）为准，不以该文档为准。

## 3. 「会话自然结束」路径的核实

- daemon 退出后回执停在 `STARTED`。`start` **不**回收（判定为活），由幂等 `stop` 收尾：
  `stop` :1260 对已 `STOPPED` 回执直接返回；否则调 Bridge `voice-session stop`，`waitForTerminal` 对已结束会话立即返回，
  `ownedProcess` 发现 daemon 已死则不 kill，最后 `settleStoppedVoiceRun` 按代次释放并写 `STOPPED`。
- 已核（plan.md R2 节）：Bridge `POST /api/voice/sessions/:id/stop` 对 `ended/cancelled/failed` 会话返回 200 与当前状态。
- 代价：`stop` 因 Bridge 不可用 / 会话 404 失败时，该锁要等下一次 teardown Step 6b。

## 4. 竞态分析结论（三轮 Codex 代码评审沉淀）

| 轮次 | 发现 | 处置 | 现状 |
|------|------|------|------|
| R1 HIGH | 回收引入 ABA：旧 stop 只比 slotDir 会删新锁、覆盖新回执 | `leaseId` 代次 + `settleStoppedVoiceRun` 归属检查 | 已在分支 |
| R2 HIGH | 代次比较与删除/写回非原子，微秒窗口仍可命中新代次 | Lead 裁定减法：`STARTED` 回执一律算活 ⇒ 进行中的 stop 永远不会被回收 | 竞态在结构上消失 |
| R3 MEDIUM | stop 释放锁→写 STOPPED 的空档，同 slot start 走普通 mkdir 不看回执 | 建锁前也查回执 | 已在分支；不改成「先写 STOPPED 再释放」（会重开 R2） |

## 5. 测试证据（本节点复跑，2026-09-26）

环境：`pnpm install --frozen-lockfile` + `pnpm --filter "flywheel-comm..." build`（测试文件 import `flywheel-comm/dist`）。

| 命令 | 结果 |
|------|------|
| `node --test scripts/__tests__/fly2655-voice-room.test.mjs` | 24/24 通过，含 5 条 FLY-2876 用例 |
| `pnpm --filter claude-runner exec vitest run test/kill-path-inventory.test.ts` | 5/5 通过（qa-only 条目已登记） |

硬红判据 ↔ 测试：

| 判据 | 测试 |
|------|------|
| 复现孤儿锁 → start 成功，锁由新运行持有；stop 后锁目录消失 | `FLY-2876 a same-slot lease nothing alive stands behind is reclaimed`；`… naturally ended run is closed by stop …` |
| 锁属于别的 slotDir 时 start 仍拒绝、锁不动 | `voice room lease is same-slot idempotent and never releases a foreign owner`；`FLY-2867 a gone owner with a live recorded daemon, or a non-slot owner, is never reclaimed` |
| teardown 拆完 slot 后该 slot 的语音房锁不存在 | `FLY-2867 teardown releases only its own slot's leases …`；`release-slot-leases CLI …`（#1323，未改） |
| 活对象不被回收 | `… with a live start, daemon, or STARTED receipt is kept`；`… unreadable or symlinked run receipt keeps …` |
| R3 围栏 | `… no start while the slot's last run is unstopped, even with its lease gone` |

真实 `/tmp` 语音锁全程未触碰（测试用临时 `root`）。

## 6. 剩余风险与不做的事

- 合入前遗留、既无 holder/daemon 记录、回执也已删除的锁，若其旧 daemon 实际仍在跑，会按孤儿回收（与 #1323 teardown 对无记录锁的规则一致）。
- 两个并发回收者抢真孤儿锁时，沿用 #1323 墓碑放回流程的理论窗口，不加互斥锁。
- 不改 voice-codex、不改 teardown、不改异 slot 规则、不开新 PR（交付顺序见 plan.md）。
- 本分支所在的 QA 沙箱远端查不到 PR #1332 / #1323；文档只引用正式仓编号，不在沙箱校验。
