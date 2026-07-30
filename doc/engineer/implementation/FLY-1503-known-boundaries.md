# FLY-1503 — 已知边界与 follow-up（v2 host/engine/dag gap 修复）

**Issue**: FLY-1503（v2 gaps 整族）
**Date**: 2026-07-29
**Status**: PR #726 待 founder 审批合并（HIGH-1/HIGH-3 已由 founder 裁定为接受边界）
**Source**: Codex code review R1–R4（R4 全文见 review 记录）

本文件记录 **本 PR 明确不修** 的边界，以及降级为 follow-up 的剩余项。
写下来的目的是：这些不是遗漏，是有意识的范围决定，任何人读代码时都应该能找到依据。

---

## 一、已接受的设计边界（founder 裁定 2026-07-29）

R4 把这两项评为 HIGH。founder 裁定：**所有 Runner 共享同一把引擎钥匙
（global host secret）是已接受的设计现状，不是缺陷** —— runner 全部由我们自己派、
跑在 founder 自己的机器上，「同机恶意 runner」没有现实来源。

因此这两项 **不立跟进单、不留占位**，代码里也不加任何半截防护。
`host.ts` 对应位置的注释标题是 `ACCEPTED DESIGN BOUNDARY`。

后续任何评审轮再抛出**依赖同 UID 恶意进程假设**的同族问题，一律按此裁定判为
out-of-scope，直接记进本段，不再上报。

### B-1. `register_lead` 签发入口没有 agent 级授权（R4 HIGH-1）

**位置**: `packages/v2-host/src/host.ts` — `DeliveryCredentialRecord` 上方。

global secret 只能证明「某个 v2 进程」，不能证明「哪个 agent」，所以
`#registerLead` 接受任意 `agentId`，同机进程可以把自己注册成某个 lead
（fresh/generation-0 直接注册；同代 reattach 只需复制 durable session binding
+ 0600 proof，两者同 uid 可读）。按上述裁定接受。

**不要在这个入口加部分授权检查** —— 那会让代码读起来像有边界，而实际什么都没变。

**本 PR 里的 delivery credential 为什么保留**：它的作用是「把一次 pull 绑定到一次
registration」，用来阻止 takeover 之后把 envelope 发给被取代的 generation，
并让过期 credential 变成明确的 fence violation 而不是静默的跨代投递。
这些是**正确性**属性，与「防同机恶意进程」无关，不要混为一谈。

### B-2. `socket.write` 回调不是应用层 ACK（R4 HIGH-3）

**位置**: `packages/v2-host/src/host.ts` — `DispatchOutcome` 上方；
`writeResponse`；envelope 协议 `submit.noAcknowledgement`。

flushed write 只证明字节进了内核，不证明客户端读到或持久化了。所以客户端在 flush
之后崩溃 → delivery 记为 succeeded 却没有 proposal；反向竞态 → requeue → 重复投递。

**注意：这一项与同 UID 威胁模型无关**，它是可靠性窗口。接受它的真实理由是
**失败是有界的，不是终态**：processing attempt 仍停在 `running`，
下一次 crash-settle（`driver.stop()`、generation takeover、或 settled-pending 清扫）
会重新调度该 message，而本 PR 新增的 attempt-scoped delivery scope 让这次重投
**能够成功**（修前会撞 unique 索引）。代价是「等到那次 settle 之前的延迟」，
不是丢消息。ACK 协议只能缩小这个窗口，对正确性不是必需。

**不得**把写回调描述成等价于 ACK。

## 二、降级为 follow-up 的剩余项（本 PR 部分修）

### F-1. onboarding lock 的 release 竞态（R4 MEDIUM-3 剩余部分）

**已修**：无界自旋（unparseable lock 走的 `continue` 跳过了 deadline 检查）、
zero-byte lock（create-then-write 改为 stage + `linkSync` 原子获取）、
瞬态 probe 失败抢活锁（`null` 不再当作 staleness）、
reclaim 的 rename-before-verify 窗口（改为先在锁路径上重读重判 inode）。

**未修**：`#releaseOnboardingLock` 先读 owner token 再 `unlinkSync`，
这个窗口里若锁已被 reclaim 且有 successor，仍可能删掉 successor 的锁。
需要 unlink 时做 fd 级身份校验，或改成目录锁（`mkdir` 天然原子）。

### F-2. undelivered diagnostic 的 outbox drain（R4 MEDIUM-4 剩余部分）

**已修**：aggregate 增加 durable `undelivered_signal` 标记（只有真正发出承载它的
notice 时才清除），notice 上标 `carries_deferred_signal`。信号不再只存在于
「未来恰好又失败一次」的路径上。

**未修**：真正发出这条 deferred notice 仍依赖下一次进入 `appendFailureRecurrence`。
如果任务此后再也不失败，没有任何东西 drain 这个标记。
真 outbox 需要对带标记的 aggregate 做 sweep，而最便宜的挂载点（每个 dispatch tick）
会对所有 recurrence row 增加周期性开销 —— 本仓库刻意避免新增周期负载，
所以这半留作独立单处理。

---

## 三、部署要求（本 PR 引入，operator 必做一次）

`runtime config` 的 tmux launcher 段新增 **必填** 键 `claude_credentials`，
指向 operator 一次性提供的 `.credentials.json`（regular file、非 symlink、
0600 或 0400、合法 JSON）。

原因见 R4 MEDIUM-2：把 Claude config root 改成 per-activation 之后，
新目录里没有 `.credentials.json`，而 runner 是用 `/usr/bin/env -i` + 白名单启动的，
白名单里既没有 `CLAUDE_CODE_OAUTH_TOKEN` 也没有 `ANTHROPIC_API_KEY`。
不配这个键，每次 spawn 都会停在交互式登录屏。

launcher 现在会在**任何 tmux 调用之前** fail closed，并在报错里带上路径。

每个 activation 目录里的 `.credentials.json` 是**复制**，不是软链，而且
**已存在的非空 regular file 永不覆盖**（只有 0 字节才会重新播种）。

早期版本用的是软链，理由是「Claude 轮转 token 会经软链写回源文件」—— 这个前提是
**错的**，已实测：Claude 的凭据写入是「写临时文件 + rename 覆盖」，而 POSIX rename
替换的是**软链本身**，不会写进软链目标。于是轮转之后 activation 目录里那个
regular file 是**唯一**有效 token，而当时的 relaunch 路径会把它 unlink 再重新链回
过期的源 —— 修复本身造成了数据丢失（R5 MEDIUM-2）。

**不要按旧文档预建软链**：launcher 现在会把软链判为非 regular file 并在 tmux 前拒绝。

**残留风险（R6 MEDIUM-2，已转跟进单）**：activation 内轮转出来的新 token 不会回写
源文件，所以后续新建的 activation 仍会从**未更新的源**复制。一旦某个 activation 的
轮转使旧 refresh token 失效，之后新起的 runner 会停在认证流程。当前缓解是运维保持
源文件有效；真解是「取源与各 activation 副本中最新的有效凭据，并回写源」。
