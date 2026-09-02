# FLY-2240 原子切号与通用轮换 — 调研
Issue: FLY-2240 (https://linear.app/geoforge3d/issue/FLY-2240/切号器-统一-atomic-切号-flow手动自动同路必发通知-轮换改-generic可用号中选-reset-最早)
日期: 2026-09-01
基于: exploration.md

## 1. 调研问题

1. 如何在不制造 Keychain↔Discord 假事务的情况下，严格证明“切号成功 ⇒ 必有通知”？
2. 如何让公开 bash `use/next` 与 daemon 进入同一执行单元，同时不造成 delegated-lock 递归或死锁？
3. 如何把 generic 选号建立在本轮 fresh/live 事实上，并保守处理旧 `lastObservedAt`、null reset、stale token、usage API 失败？
4. 哪些既有通知/恢复机制可复用，哪些 caller-side 发送必须退役？

## 2. 既有 durable 模式可直接复用

`quota-incident.ts::finalizeModelSwitchIncident` 与 `quota-monitor-state.ts::alertOutbox` 已提供仓内工作样例：

- 先把 `eventId + generation + alert` 放入有界 outbox，再持久化 state；
- daemon tick 前后调用 `drainQuotaMonitorAlertOutbox`；
- 发送/外部队列确认后删除 intent；投递异常保留，下轮重放；
- 同一 `eventId` 幂等，outbox 满时在切号前拒绝。

普通 account-level 切号当前没有这条保证：它在 `switchAccount` 返回 `switched` 后才由 `pollOnce` 直接 `deps.alert`。进程若停在二者之间，store 已变而通知永远不存在。手工 bash 更完全不经过这一层。

研究结论：不用发明新 daemon 或 transport，只需把同一 outbox 思路移动到**账号 store 的切号 commit**。通知 intent 与 `activeAccount/generation` 位于同一个 `writeStore(temp + fsync + rename)`，这是本机可实现的原子边界。

## 3. Store schema 与 crash/replay 合同

### 3.1 新字段

在 `AccountStore` 增加可选、读取时归一化为空数组的：

```ts
pendingSwitchNotifications?: Array<{
  eventId: string;              // account-switch-g<generation>
  generation: number;
  createdAt: string;
  alert: {
    kind: "account_switched" | "account_switch_degraded" | "model_cap_switched";
    severity: "info" | "severe";
    title: string;
    body: string;
    signature: string;
  };
}>;
```

字段有硬上限 64。若预计的新 event 尚不存在且 outbox 已满，`switchAccount` 在 freshness、Keychain、`.active` 等任何 mutation 前返回 `failed/notification_outbox_full`。

### 3.2 成功 commit

`commitSwitch` 必须在一次 store write 中完成：

- outgoing quota/model bench 标记；
- `activeAccount = to`；
- `generation + 1`；
- 同 generation 的 notification intent。

因此以下状态不可达：

- store 显示 generation N 已切换，但 generation N 没有通知 intent；
- intent 宣称 N 已切换，但 store 仍在 N-1。

### 3.3 投递与 ack

`switchAccount` 在释放 accounts lock 后尝试 drain 最旧 intent，绝不在网络 I/O 期间持有账号锁。`sent`、`duplicate`、`queued_transient` 都表示通知已经被投递链接受，可以重新拿锁按 eventId ack；`process_error`、`invalid_result`、`config_error`、`dead_lettered` 保留 intent 并返回 `notification=pending` 事实。

quota daemon 每个 tick 在正常 poll 前后继续 drain store outbox，所以手工 CLI 在成功 commit 后被 kill、或即时网络失败，都会由现有 daemon 重放。签名绑定 generation，send 成功但 ack 前 crash 最多造成 transport dedupe，不会产生另一条业务切号。

## 4. 统一执行边界

### 4.1 Mechanical primitive 不重写

保留 bash 内 `prepare_profile_locked` / `commit_profile_locked` 作为唯一 Keychain 原语；保留 Node `switchAccount` 的 CAS、lock、lease、journal 与 candidate loop。统一的含义不是复制这些字节到 TypeScript，而是：

- 公开 trigger 永远调用 Node `switchAccount`；
- Node 在自己持有 lock 时，以已经存在的 delegated proof 调 bash `use` 原语；
- bash 只有在 delegated proof 被真实 holder 验证通过后才允许进入内部 mutation。

### 4.2 手动 trampoline

公开 `flywheel-claude-profile use/next` 在**非 delegated**模式下先 exec 新的 `flywheel-claude-switch` launcher；新 CLI 读取/验证目标或 live-rank 候选，构造 `SwitchInput(trigger="manual")`，再调用同一个 `switchAccount`。

当 `switchAccount` 反向调用 bash `use` 时设置专用内部标记（与已验证 delegated lock 绑定），bash 跳过公开 trampoline，进入既有 primitive。裸伪造内部标记不能绕过 lock，因为现有 `DELEGATED_LOCK_ACCEPTED` 仍是 mutation 权威。

这保留了 macOS bash 3.2、process-group、journal、Keychain 无 secret argv 等 119 项既有红线测试；只是公开入口的 owner 从 bash orchestration 改为 Node orchestration。

### 4.3 Caller 迁移

- quota daemon：继续负责阈值检测、候选 live 验证、revive/confirmation；调用 `switchAccount` 后不再自己发 success alert。
- manual `use/next`：新 CLI 调 `switchAccount`；不在 bash 末尾另发消息。
- Bridge repair：调用相同 executor；删除 `RepairDisposition.notifySuccess` 这个第二套 caller-side success seam。
- model-cap：成功 intent 同样由 switch commit 产生；`finalizeModelSwitchIncident` 只持久化 pane suppression/revive/confirmation，不再追加第二条 switch alert。

## 5. Generic candidate 合同

### 5.1 候选集合

候选取：

```text
(store.accounts ∩ pool directories)
− active
− attempt-local exclusions
− auth/identity unusable
− active switch cooldown
− model bench（若本次为 model trigger）
```

`quota-monitor.json.order` 不再是候选 allowlist 或优先级。为保持现有启停安全，空 `order` 仍表示 monitor-only；一旦已启用，候选必须覆盖 pool∩store 的全部账号。旧 order 只可作为配置兼容字段，不能影响 winner；最终稳定 tie-break 用账号名。

### 5.2 “能用”的实时证明

每个剩余候选必须按顺序完成：

1. accounts lock 内复核 active credential digest + generation 未变化；
2. freshness verify 成功（允许 helper refresh 并原子写回 pool）；
3. 重新读取 pool credential；
4. live usage API 返回两个 window；
5. `fiveH.pct < 100 && sevenD.pct < 100`。

任一步失败即排除并进入 panorama；不能用旧 store/ledger 把它“补回”。现有 `degradedSwitch` 以陈旧 `weeklyResetAt` 选择 unverifiable candidate 的行为与 founder 新定义冲突，配置字段可继续解析以兼容旧文件，但执行面不再用它授权切号。

Panorama entry 不能只有人类字符串；必须携带稳定 `excludedBy: "cooldown" | "auth" | "quota" | "unverifiable" | "model" | "pool" | null`。FLY-2240 只消费它生成 skipped/no-target 文案，不改变 cooldown 决策；独立 backlog **FLY-2229** 后续可在同一结果上只对 `cooldown` 分支增加“唯一剩余目标”回退，无需重写 live verifier。

### 5.3 reset 排序

合格候选只按本轮 `sevenD.resetsAt`：

1. 有效 ISO 时间升序；
2. `null`/invalid 属于未知，排在所有有效时间之后；
3. reset 相同或都未知时按账号名稳定排序。

不再按 5h headroom 分 tier，也不按 config order。5h 只参与“是否已经耗尽”，不参与 winner 次序。

### 5.4 陈旧观测策略

- `lastObservedAt` 比本轮 `verifiedAt` 更新：沿用 `selectNextAccount` 的 TOCTOU guard，更新事实胜出并排除该候选。
- `lastObservedAt` 比本轮旧：它可以被本轮 live 结果覆盖，不参与排名。
- 没有本轮 live 结果：保守排除，哪怕 store 写着 `quotaExhaustedUntil=null`。
- weekly reset null：账号仍可用，但 reset 未知，排最后；不能再用 `-Infinity` 让未知胜过已知。

### 5.5 stale 与全灭可见性

- 部分候选 stale/exhausted/unverifiable：唯一 success notification 的 body 追加一行 `skipped=<name>:<reason>,...`，无需新 alert kind/第二条通知。
- 无候选：沿用 `quota_no_target` + panorama；手动 CLI 也走同一 sender。通知/告警中只放账号标签与非 secret 原因，不放 access/refresh token。

## 6. 验证策略

### 6.1 TDD 单元与集成

- RED：manual `use` 的公开入口必须调用 Node executor sender；当前测试会显示 Keychain 切换但 sender 记录为空。
- RED：committed store generation 必须同时出现 notification intent；当前 `commitSwitch` 不产生。
- RED：模拟切号 commit 后即时投递失败，再启动 daemon tick，必须重放并 ack；当前普通 account switch 无 intent 可重放。
- RED：pool/store 有三个账号、config order 故意漏一个，winner 必须仍是漏掉但 reset 最早的账号。
- RED：低 headroom 但 reset 更早必须胜出；当前 tier 行为会失败。
- RED：stale/exhausted 排除；部分坏账号出现在成功 notice；全灭发 `quota_no_target`。
- RED：旧 `lastObservedAt` 不能进入排名；更晚 exhaustion 仍能挡住刚验证结果。
- mutation：恢复旧 tier/config-order/null-first 排序，新增测试必须变红。

### 6.2 Crash/replay 与负向 guard

- outbox 满 → 零 `applyProfile`、零 Keychain/store generation mutation；
- send 成功、ack 前模拟 crash → 重放得到 duplicate 后 ack；
- send 失败 → intent 保留；重启后的新 runtime tick 投递；
- CAS noop/failed/no_account → 不生成成功 intent；
- 伪造 manual internal marker → 仍无法通过 delegated lock；
- stale target → Keychain/.active 不动，panorama/全灭告警可见。

## 7. 基线证据

依赖安装后，当前 main 基线：

- `account-store.test.ts` 47/47；
- `switch-executor.test.ts` 43/43；
- `quota-monitor.test.ts` 65/65（先构建 `flywheel-config` 后）；
- `claude-profile-cli.integration.test.ts` 3/3；
- `packages/claude-runner/test/claude-profile.test.ts` 119/119，真实 bash/假 Keychain 全套耗时约 226 秒。

这些结果证明后续 RED 应来自新要求，而不是 worktree 初始损坏。

## 8. 调研结论

推荐方案可以用仓内已有构件闭合，不需要新服务：账号 store 承担切号 commit + notification intent 的共同原子边界，现有 quota monitor 承担失败重放，现有 lead-alert transport 承担投递。选号器则必须去掉 config-order/tier/null-first 三个旧优先级，统一使用同轮 live freshness + quota + earliest known reset。
