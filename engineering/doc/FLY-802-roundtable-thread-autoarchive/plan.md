# FLY-802 Roundtable topic thread 1h 自动归档 + 描述性命名 — 实施计划

Issue: FLY-802 (https://linear.app/geoforge3d/issue/FLY-802/roundtable-topic-thread-1h-无活动自动归档-描述性命名-别一排排堆在侧栏)
日期: 2026-07-02
基于: 无(plan_only tier,Lead 降档)

## 目标

`#leads-roundtable` 下的 per-topic thread(FLY-314)别再一排排堆侧栏:建 thread 时设 `auto_archive_duration = 60`(Discord 最短 = 1h),1h 无活动自动从侧栏收起(消息保留、search 可找回、非删除)。命名代码已在 PR #411 修好,老 placeholder thread 靠新的 1h archive 自然清掉。

## 背景审计

roundtable topic thread 的 3-day 常量 `AUTO_ARCHIVE_DURATION = 4320` 在**两处各 hard-code 一份**:
- `packages/teamlead/src/bridge/roundtable/RoundtableThreadManager.ts:530`(Bridge poller = creator 1)
- `packages/teamlead/src/bridge/roundtable/ensure-thread-from-message.ts:75`(shared helper,Codex-lead reply-in-thread = creator 2)

本仓已因同类「多处漂移」把 `ROUNDTABLE_PLACEHOLDER_NAME` 抽到共享 `roundtable-text.ts`。本次同法处理常量。

## 改动

1. **`bridge/roundtable/roundtable-text.ts`**:新增
   ```ts
   /** FLY-802: roundtable topic threads auto-archive after 1h of inactivity
    * (Discord's shortest auto_archive_duration) so they collapse out of the
    * sidebar instead of piling up. Shared by both create paths to avoid drift. */
   export const ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES = 60;
   ```
2. **`RoundtableThreadManager.ts`**:删局部 `const AUTO_ARCHIVE_DURATION = 4320`,import 共享常量,create body 用它。
3. **`ensure-thread-from-message.ts`**:同上。
4. **命名**:不改代码(已正确)。

### 修订(QA·FLY-803 复测 FAIL → 交付路径修复)

**QA 真机复现(2/2 无干预)**:插件的实时 WS 网关抢在 Bridge 3s 轮询前创建 thread,用 Discord **默认 3-day** archive。Bridge 的 `exists`-recovery 路径(`RoundtableThreadManager.commitThread`)撞已存在 thread 时**只 rename + 加 member、不改 archive 时长** → 真实新建 thread 仍 4320,issue 核心「别一排排堆侧栏」在多数真实 thread 未解决。这是原 PR 里我错误地当成「已知边界」放过的路径。

**修复**(仅 `RoundtableThreadManager.ts`,Lead 指定范围):
- `confirmThreadExists` 的 GET 顺带读 `thread_metadata.auto_archive_duration`(免费,同一 GET)。
- `commitThread` 把 name + archive 收进**一个 PATCH**,只发真正需要改的字段:
  - name:仅当当前是 placeholder(既有逻辑)。
  - `auto_archive_duration`:当当前 ≠ 60 时 PATCH 到 60(host bot 自建的 thread currentArchiveMinutes=60 → 跳过,create 路径零冗余写)。
- `renameThread` 泛化成 `patchThread(threadId, { name?, auto_archive_duration? })`,沿用同款 transient/permanent 分类。

**范围红线(不碰)**:`ChatThreadCreator.ts:340`(issue chat thread = 3d,FLY-292)、`AlertChannelHub.ts:68`(alert = 1d)。

## TDD

RED → GREEN(改 4320→60 是让新断言变绿的最小实现):
- `RoundtableThreadManager.test.ts`:新增断言 —— topic 触发后 `POST .../threads` 的 body 带 `auto_archive_duration: 60`。
- `ensure-thread-from-message.test.ts`:新增断言 —— create body 带 `auto_archive_duration: 60`。
- `roundtable-text.test.ts`:断言 `ROUNDTABLE_TOPIC_AUTO_ARCHIVE_MINUTES === 60`。
- 既有命名 rename 测试保持绿(回归保护)。

## 已知边界(记入 PR)

- **plugin-created thread(creator 3,另一个 repo)= 已修**:本仓 Bridge poller 的 `exists`-recovery 现在会 PATCH archive 到 60。poller 处理 `#leads-roundtable` 每条顶层消息 → 无论谁赢 create race,archive 都收敛到 1h。
- **Codex-lead reply-in-thread 路径(`ensure-thread-from-message` 的 exists 分支)不改 archive**:该路径只保证 thread 存在好回帖,不 rename/不改 archive;但 Bridge poller 会处理同一条消息并收敛 archive,所以实际覆盖。保持范围最小(Lead 指定只改 `RoundtableThreadManager.ts`)。
- **rename / archive PATCH 需 poller bot `MANAGE_THREADS`**:缺权限则名字/archive 停原样(已 fail-soft warn)。属部署/权限,非本 issue 代码。

## 验收

- Codex code review 通过。
- 独立 QA:529 Room 真机验 —— 新 roundtable topic thread 建出来 archive 时长 = 60min;issue chat / alert thread archive 时长不变。
- founder-gated ship(不自 ship)。
