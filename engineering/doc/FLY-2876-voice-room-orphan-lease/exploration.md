# FLY-2876 同 slot 孤儿语音房锁 — 探索
Issue: FLY-2876 (https://linear.app/geoforge3d/issue/FLY-2876/病根529-语音房-语音会话自然结束-测试房被拆后语音房锁-tmpflywheel-voice-room-guild-channellock)
日期: 2026-09-26
基于: 无

**Mode**: Technical · **Depth**: Standard · **Status**: complete（本节点为 eng_design 重派；Linear MCP 本会话 401 不可用，issue 正文以派单文本为准）

## 0. 本次设计节点的起点（诚实声明）

分支 `project-slot-3-FLY-2876` 在本节点启动前**已经**带着上一轮运行留下的产物：
`plan.md`（经 Codex 代码评审 R1–R3 三次修订）、`scripts/qa/fly2655-voice-room.mjs` 的租约改动、
5 条新单元测试、里程碑文件 `engineering/doc/milestones/FLY-2876.md`（记 PR #1332，但 QA 沙箱远端查不到该 PR 号，它属于正式仓）。
缺的是 `exploration.md`、`research.md` 和一次**显式的 design_review gate 通过记录**。

本节点的工作因此是：把已有实现当作「候选设计」重新审计，补齐探索 / 调研 / 计划三份文档，
走 design_review gate，产出 founder HTML；**不改代码、不动 PR、不派发后继节点**。
已向 Lead 发非阻塞确认（question 014757f9）。

## 1. 现象与根因链

| 步骤 | 事实（来自 issue + 代码） |
|------|------|
| 1 | `start` 建锁 `/tmp/flywheel-voice-room-<guild>-<channel>.lock/owner.json`，`owner.slotDir = /private/tmp/flywheel-test-slot-1` |
| 2 | founder 实测结束；**没有人跑 `stop`**（语音会话自然结束不释放锁） |
| 3 | `test-teardown.sh` 拆 slot 两次（当时无 Step 6b）：slot 目录连同 `voice-run-receipt.json` 一起删掉，锁留在 `/tmp` |
| 4 | 新部署 slot 1，路径相同 ⇒ `acquireVoiceRoomLease` 看到 `owner.slotDir === 本 slot`，返回 `created:false` |
| 5 | `start` 要求 `check(lease.created)` ⇒ `voice_room_lease_already_owned` |
| 6 | `stop` 先读 `voice-run-receipt.json` ⇒ ENOENT 拒绝 |
| 7 | 手工 `rm` 被 Lead/QA 权限层挡住（正确） ⇒ 只能等 founder |

根因不是「锁没释放」一个点，而是三条缺口叠加：
(a) 自然结束无释放；(b) teardown 不清锁；(c) `start` 把「同 slot 的锁」一律当作「自己还在用」。

## 2. 已由 FLY-2867（PR #1323）覆盖的部分

| 缺口 | #1323 做了什么 | 本单还剩什么 |
|------|------|------|
| (b) teardown 不清锁 | Step 6b：删 slot 目录前调 `release-slot-leases`，daemon 已死的本 slot 锁全部删除，失败只 WARN | 无 |
| 异 slot 锁误删风险 | `staleVoiceRoomOwner`：只回收「owner 是已消失的 529 slot 目录且无存活 daemon」的锁，rename→tombstone→复核→删 | 无（判据 2 已覆盖） |
| (c) 同 slot 旧锁 | **没碰**：同 slotDir 仍直接 `created:false` | **事故本体**：重新部署后的同 slot 被自己旧锁挡死 |
| (a) 自然结束 | 无 | 需要一条正规路径能收尾 |

## 3. 受影响文件

| 文件 | 影响 | 说明 |
|------|------|------|
| `scripts/qa/fly2655-voice-room.mjs` | 修改（仅租约函数 + stop 收尾） | `acquireVoiceRoomLease` / `releaseVoiceRoomLease` / `settleStoppedVoiceRun` / `orphanedSameSlotLease` / `liveRunReceipt` |
| `scripts/__tests__/fly2655-voice-room.test.mjs` | 新增 5 条 | 事故本体、活对象保留、自然结束→stop→恢复、无锁但回执 STARTED、不可信回执 |
| `packages/claude-runner/test/fixtures/kill-path-inventory.json` | 新增 1 条 qa-only | 新测试里的 `process.kill` 需登记 |
| `scripts/test-teardown.sh` | **不改** | Step 6b 已在 #1323 |
| `packages/voice-codex/*` | **不改** | 不加退出钩子（见方案 C） |

## 4. 架构约束

- 锁是目录（`mkdir` 原子），owner 记录是目录内 `owner.json`；文件系统没有「内容匹配才删」的原子操作。
- 回执 `voice-run-receipt.json` 住在 slot 目录内，会随 teardown 消失 ⇒ **回执缺失本身就是事故信号**，不能把「无回执」当成「活」。
- 回执读取必须走 `trusted()`（软链接 / 越界 fail closed）；读不了 ⇒ 按「活」处理，宁可不回收。
- `stop` 的收尾顺序是「释放锁 → 写 `STOPPED`」，中间有空档；任何 `start` 侧的判定都要考虑进行中的 `stop`。
- 权限层不允许 Lead/QA 手工 rm `/tmp` 锁，所以自愈必须在 `start` / `stop` / teardown 这三条正规路径之内。
- 合入前遗留的锁没有 `holder` / `daemon` / `leaseId` 字段，判定要向后兼容（缺省 = 不活；畸形 = 活）。

## 5. 方案比较

### 方案 A：`start` 自愈同 slot 孤儿锁 + 锁代次 + 回执围栏（现分支实现）
- **核心**：同 slot 锁只在「建锁的 start 进程、记录的 daemon、未 `STOPPED` 的回执」三者都不活时，经 #1323 的 tombstone 流程回收重建。每把新锁带 `leaseId`，`stop` 只释放同代次；建锁前先看本 slot 回执，未 `STOPPED` 不建。
- **优点**：事故本体（回执随 slot 目录消失）直接自愈；只改一个文件的租约函数；异 slot 规则 / teardown 不动；进行中的 `stop` 在结构上不可能被回收（它对应 `STARTED` 回执）。
- **缺点**：判定条件多（三活一死）；行为变化：回执 `STARTED` 而锁已不在（`stop` 中途崩溃）要再跑一次幂等 `stop` 才能 `start`。
- **工作量**：S（已在分支上，24/24 测试 + 9 变异被杀，待本节点复验）。

### 方案 B：不改 `start`，只靠「再拆一次 slot」（#1323 Step 6b）
- **核心**：接受同 slot 锁需要下一次 teardown 才清。
- **优点**：零改动。
- **缺点**：事故第二例正是「已部署好的新 slot 被挡」，再拆一次等于把 founder 早上实测再推迟一轮；并不满足硬红 1（复现孤儿锁 → `start` 成功）。
- **结论**：放弃。

### 方案 C：给 voice-codex daemon 加退出钩子释放锁
- **核心**：会话自然结束时 daemon 自己删锁 / 写 `STOPPED`。
- **优点**：自然结束立刻释放。
- **缺点**：跨包耦合（QA 脚本的锁格式泄漏进产品包）；daemon 被 SIGKILL / 机器重启时钩子不跑，事故本体照样发生；仍需方案 A 兜底。
- **结论**：放弃；自然结束改由幂等 `stop` 收尾（Bridge 对已结束会话 stop 返回 200）。

### 方案 D：给锁再加一把互斥锁，严格消除回收竞态
- **核心**：同 slot 回收前先取第二把互斥锁。
- **缺点**：互斥锁自己也会成为孤儿（持锁崩溃），问题递归；Codex R2 后 Lead 裁定改用减法（`STARTED` 回执一律算活），竞态在结构上消失，不需要互斥锁。
- **结论**：放弃。

### 推荐：方案 A
理由：唯一同时满足三条硬红（孤儿锁 `start` 可恢复；异 slot 仍拒；teardown 后无锁）的方案，改动面最小，且已被三轮 Codex 代码评审逼到「结构上无竞态」而不是「窗口变窄」。

## 6. 需要 Lead 判断的问题（非阻塞，已发送）

1. 本节点是重派：是按「补文档 + design gate + HTML」推进，还是因 FLY-2867 已覆盖而 park？（question 014757f9）
2. 里程碑文件记的 PR #1332 在 QA 沙箱远端不存在；设计文档只引用不校验，是否可接受？（随 1 一并回答即可）

## 7. 下一步

- [x] 写 exploration.md（本文）
- [ ] research.md：逐函数核对现分支实现与方案 A 的对应关系，复跑相关测试取证据
- [ ] plan.md：补「基于: research.md」、本节点现状节；走 design_review gate
- [ ] founder HTML（Mermaid 本地渲染）→ publish-report → 报 Lead → phase_design_complete
