# QA Report: FLY-294 — chat-thread auto-archive 可靠性 E2E (#277 / FLY-292)

**Issue**: FLY-294 (QA E2E: FLY-292 chat-thread auto-archive reliability)
**Date**: 2026-06-16
**验证对象**: PR #277 (`flywheel-FLY-292`, head `7e9ee673`) — `packages/teamlead/src/bridge/chat-thread-utils.ts` 等
**QA 角色**: 独立 QA（未参与 #277 实现，QA/Developer 分离，同 FLY-291 之于 FLY-282）
**Verdict**: ✅ **PASS** — 全部 25 项 E2E 检查通过 + #277 自带单测独立复现通过
**Codex code review**: 已过（Round 1 CHANGES REQUESTED 4 MEDIUM → 全部采纳修复 → 复审）

---

## 1. 结论 (Verdict)

| 项 | 结果 |
|----|------|
| Layer A — 可靠性边界（真 socket / 真 timer / fake Discord，含 A0 PR-#277 守卫） | **14 / 14 PASS** |
| Layer B — 真 Discord 上真归档（隔离 cos-test，肉眼/API 可证，含 #277 守卫 + 残留检查） | **6 / 6 PASS** |
| Layer C — 反向对照（base/main 必须回归，证回归门有效） | **5 / 5 PASS** |
| #277 自带单测 `chat-thread-utils.test.ts`（独立复现） | **13 / 13 PASS** |
| #277 自带单测 `post-ship-finalization.test.ts`（独立复现，单文件隔离） | **17 / 17 PASS** |

**总判定**：#277 的 chat-thread auto-archive 可靠性加固 **真实有效、可在真 Discord 上证实归档、回归门有牙**，建议跟 batch 一起 ship。

> ⚠️ **诚实标注（按 Tadashi 要求 fake-server 边界与真 Discord 分开标）**：Layer A / C 的 429 / 5xx / 慢挂起边界 **无法对真 Discord 按需触发**，故对**本地 fake-Discord HTTP server** 触发。但**被测代码、TCP socket、`AbortController`、`Retry-After` 解析、`Response` 解析全是真的**——只有“目标服务器”是 fake。**真 Discord 路径见 Layer B**（真归档 + 真 404）。

---

## 2. 隔离 (Isolation) — 零生产接触

- **Discord**：只用 `TEST_BOT_TOKEN_1`（bot `flywheel-test-1`）+ `cos-test` 频道（`1493080991290626079`，"QA Testing" category，guild `1485787271192907816`）。**绝不碰**生产 Lead bot / 生产频道。
- **StateStore**：`StateStore.create(":memory:")` 内存 DB，**绝不碰**生产 `~/.flywheel` StateStore。
- **Linear**：未触碰（本 QA 不需要建 Linear issue）。
- **Bridge**：未起任何生产/sandbox Bridge——直接在 worktree 用 `tsx` 驱动被测函数 + 真实编排器。
- **清理**：Layer B 每个测试线程跑完即删（先解归档→删消息→删线程，回退重归档）。跑后核对 cos-test：**0 个 fly294 残留线程**（active + archived 均为 0；现存 2 个 active 线程是其它 QA run 的 FLY-221/FLY-217/FLY-212，非本次）。

---

## 3. 方法 (Method)

worktree 隔离：`worktrees/fly294-pr277`（detached `7e9ee673` = #277 tip）+ `pnpm install` + `pnpm --filter "flywheel-teamlead^..." build`（teamlead 的 workspace 依赖闭包，供 Layer B 的真实编排器加载）。harness 用 `tsx` 直接 import **#277 的真实源码模块**运行。

- `qa-fly294/fake-discord.mts` — 本地 fake-Discord HTTP server + origin-rewriting **真** fetch（`https://discord.com` → `http://127.0.0.1:<port>`，真 socket）+ PASS/FAIL 证据助手。
- `qa-fly294/layerA.mts` — 真 `archiveChatThread` / `removeUserFromChatThread`（#277）vs fake server。
- `qa-fly294/layerB.mts` — 真 `runPostShipFinalization`（#277）+ 真 StateStore + **真 Discord**（cos-test）。
- `qa-fly294/layerC.mts` — base/main `archiveChatThread`（`chat-thread-utils.base.mts`，monkeypatch `globalThis.fetch`）vs 同场景。

复跑：
```bash
cd worktrees/fly294-pr277
set -a; source ~/.flywheel/.env; set +a   # 仅用 TEST_BOT_TOKEN_1
node_modules/.bin/tsx qa-fly294/layerA.mts
node_modules/.bin/tsx qa-fly294/layerB.mts
node_modules/.bin/tsx qa-fly294/layerC.mts
```

---

## 4. Layer A — 可靠性边界（14/14 PASS）

| ID | 验证点 | 真实证据 |
|----|--------|----------|
| A0 | **PR-#277 守卫**：加载的 `archiveChatThread` 返回 `ArchiveChatThreadResult`（非 base void）→ 否则 harness abort | `probeResult={archived:true,reason:ok}`（base 返回 undefined 即拒跑，杜绝错 checkout 假证据）|
| A1 | happy 200 → 1 次真 PATCH 归档 | `archived=true attempts=1 reason=ok method=PATCH body={"archived":true}` |
| A2 | 429 + Retry-After **被尊重**（真等待 ~1s）| `sleepArg=1000ms realElapsed=1012ms`（真 wall-clock 等了 Retry-After:1s）|
| A3 | 恶意 Retry-After 999s **被截到 10s** | `sleepArg=10000ms`（从 999000ms 截断，MAX_RETRY_AFTER_MS）[value-asserted] |
| A4 | 持续 5xx → 3 次真重试后 `exhausted` | `attempts=3 realRequests=3 backoff=[200,400]` |
| A5 | 404 → `markDiscordMissing` + `reason=missing`，不重试，不抛 | `markedMissing=["tA5gone"] attempts=1 threw=false` |
| A6 | 401 不重试 | `reason=unauthorized realRequests=1` |
| A7 | 归档后校验：200 body `archived:false` → 重试 → `archived:true` | `attempts=2 reason=ok` |
| A8 | lenient verify：200 无 archived 字段视作成功（byte-compat）| `archived=true attempts=1` |
| A9 | **真 connection-refused** → 重试后 `reason=error`，不抛 | `error="fetch failed" attempts=2 threw=false` |
| A10 | 慢挂起被 per-attempt timeout **真 abort**（强化断言：1 次 PATCH 到达 + attempts=1 + 耗时∈[650,2000)ms 证 abort，非别的快失败）| `attempts=1 realRequests=1 method=PATCH realElapsed≈704ms`（≥650=等到 timeout；<2000=没等满 5000ms server hold）|
| A11 | `removeUser` happy → 真 DELETE，不抛 | `method=DELETE url=.../thread-members/u1` |
| A12 | `removeUser` 404 忽略 | `threw=false` |
| A13 | `removeUser` 慢挂起被 timeout abort（强化：1 次 DELETE + 耗时∈[650,2000)ms）→ **不能阻塞 archive** | `realRequests=1 method=DELETE realElapsed≈701ms` |

---

## 5. Layer B — 真 Discord 上真归档（6/6 PASS）⭐ 不可替代证据

| ID | 验证点 | 真实证据 |
|----|--------|----------|
| B-guard | **PR-#277 守卫**（fake server 探测，不发真 Discord）| `probeResult={archived:true,reason:ok}` |
| B0 | TEST bot 能看见隔离的 cos-test 频道 | `status=200 channel=cos-test guild=1485787271192907816` |
| B1 | 真 `archiveChatThread` → **Discord GET 确认** `thread_metadata.archived=true` | `fnResult={archived:true,reason:ok}` **discordArchived: before=false after=true** |
| B2 | 真 `runPostShipFinalization`（issue 完工→归档+审计）→ Discord archived=true **且** StateStore 落 `chat_thread_archived` audit event | `discordArchived=true` audit payload `{reason:"ok"}` event 链 `post_ship_finalization_claim → post_merge_completed → runner_ready_to_close_claim → runner_ready_to_close_notified → chat_thread_archived` |
| B3 | **真 Discord 404**（建线程→删→归档已删 id）→ `markDiscordMissing` + `reason=missing`，不抛 | `fnResult={status:404,reason:missing} markedMissing=[<threadId>] threw=false` |
| B-cleanup | **每个测试线程删净、零残留**（删后逐个 GET 校验，残留即 FAIL 非静默吞掉）| `deleted 2 thread(s), 0 residue` |

> B2 的 notifier 真发了 `🏁 Runner 完工可关闭 — FLY-294` 进线程（archive 之前），archive 最后跑 → 线程终态 archived（与设计的 `notifier → archive` 顺序一致，真链路）。

---

## 6. Layer C — 反向对照（5/5 PASS，base 必须回归）

证 #277 的可靠性属性 **此前确实不存在** → #277 的测试是真回归门。PASS = base 表现出 #277 修复的旧坏行为。

| ID | base（pre-#277）行为 | 真实证据 |
|----|----------------------|----------|
| C1 | 429：**无重试**，1 次请求即放弃（#277 重试→归档）| `baseRequests=1 baseReturn=undefined`（真 `[chat-thread-utils] archiveChatThread failed: 429`）|
| C2 | 5xx：**无重试**，仅 1 次请求（#277 做了 3 次）| `baseRequests=1` |
| C3 | 404：**无 markDiscordMissing**、无结构化结果 | `baseReturn=undefined`（void——无法标 missing、无法审计）|
| C4 | 慢挂起：**无 timeout**，阻塞满整个 server 延迟（#277 在 700ms abort）| `baseElapsed=3038ms`（真等满 3000ms；真挂起会无限阻塞 teardown）|
| C5 | 返回 void：无 `ArchiveChatThreadResult` → post-ship 无法发真审计 | `baseReturn=undefined` |

---

## 7. #277 自带单测独立复现 + flakiness 分析

| 文件 | 全套并行跑 | 单文件隔离 + 30s timeout |
|------|-----------|--------------------------|
| `chat-thread-utils.test.ts`（13）| **13/13 PASS** | — |
| `post-ship-finalization.test.ts`（17）| 8 个 **timeout 失败** | **17/17 PASS** |

**判定：超时 = load-induced flakiness，非回归。** `post-ship-finalization.test.ts` 的若干用例 spawn **真 tmux/git 子进程**（如 "runs tmux → notifier → archive in strict order" 真起 tmux 耗 9398ms）；并行 + 高 load（38-40）下子进程竞争超 5s 默认 timeout。**单文件隔离 + 充足 timeout 即 17/17 全过**（含 2 个新 FLY-292 audit 用例）。与 PR body 注明的 flakiness 完全吻合；且 **Layer B 已用真 `runPostShipFinalization`（含真 `postMergeTmuxCleanup`）在真 Discord 上跑通** → 编排器真实路径健康。**CI（低 load）是权威门。**

---

## 8. 纪律 (Discipline)

- worktree 隔离 ✅ / 不 merge ✅（停在本报告）/ 真 Discord ✅ / 零生产接触 ✅ / 测试线程跑后清理（0 残留）✅。
- ship 决定 = Annie 跟 batch 一起拍（不在本 QA 范围）。

## 9. 证据路径

- `qa-fly294/layer{A,B,C}.mts` + `fake-discord.mts` + `chat-thread-utils.base.mts`（可复跑）
- 运行日志：`/tmp/fly294-layer{A,B,C}.log`、`/tmp/fly294-final.log`
