# FLY-1927 新建 issue 开出多个 thread — 独立 QA 验收报告

Issue: FLY-1927 (https://linear.app/geoforge3d/issue/FLY-1927/bugthread-新建-issue-会开出多个-thread至少一个不对18671925-实证-实际工作-thread-与登记正主脱节)
日期: 2026-08-20
基于: design-correction.md(收敛后的验收合同), plan.md(审计记录)

---

## 0. 结论

**PASS。**

被验 head `b9108e8d`(PR #905)。本地 QA 台账 commit 之后 `packages/` 子树哈希与该 head
**逐字节相同**(`09b34dd115bbf68b1cd7a7eb2f3611687d1dbec1`),差异只有 `progress.md`,
所以下面所有证据都成立于 PR 的产品代码本身。

---

## 1. 先证「病是真的、且诊断对得上」——生产实证

不预设根因,先从生产库 + 真 Discord 取事实。

| issue | 未登记的野 thread | 登记正主 |
|---|---|---|
| FLY-1867 | `1539838435404157088` @ 03:28:12Z | `1539849790748106784` @ 04:13:19Z |
| FLY-1925 | `1539893450084716545` @ **07:06:53Z** | `1539894121341394994` @ 07:09:28Z |

- 两条野 thread 在 Discord 里**真实存在**(不是幻影),但 `chat_threads` 里**零登记**。
- FLY-1925 野 thread 的创建时刻与 `session_started` 时刻**逐秒吻合**;登记正主的时刻
  正是 Lead 调 `/api/chat-threads/send` 的时刻。
- ⇒ 指纹 = 「第一步已发根消息、第二步在服务端已成功,但客户端 5 秒总预算已 abort
  ⇒ 调用方判定失败、登记表零写入 ⇒ 下一次调用从头再建一条」。
  与 design-correction §2.2 的诊断一致。

**排除的第二病因**:FLY-270 曾因 identifier / UUID 两种 issue key 形态给同一 issue
建两条 thread。核过:`DirectEventSink` 与 `/chat-threads/send` 都以 session 行的
`issue_id` 为键(本 PR 未动这段);生产 `chat_threads` 里 UUID 形态的行**最新一条停在
2026-07-12**,近两日为零。⇒ 不是这次的成因。

---

## 2. 真 Discord 模块级 E2E(前后对照)

`qa-fly-1927-real-discord-e2e.mjs` —— 真编译产物 `ChatThreadCreator` + 真 `StateStore`
(一次性临时库)+ 真 bot token + 隔离的 529 房频道 `1493080991290626079`。
**每一条断言都从 Discord API 读回**,创建函数自己的返回值不作为证据。

两臂跑同一套场景、同一个频道:
- **FIX** = 本 worktree 编译产物(PR head)
- **BEFORE** = 生产 checkout 编译产物(pre-FLY-1927 的 main)

| 场景 | BEFORE | FIX |
|---|---|---|
| S1 健康创建 | ✅ 1 条 | ✅ 1 条,登记 == thread id == 根消息 id |
| **S2 第二步黑洞(Discord 已建成、客户端失联)→ 稍后再调一次** | ❌ **2 条 thread**(首次调用后登记表为空 → 第二次 `created:true`) | ✅ **1 条**,第二次直接复用 |
| S3 第二步上游 500 | ❌ 0 thread + 1 条孤儿根消息 | ✅ 同根重放成功,1 thread / 1 根消息 |
| S4 两个独立 Bridge 并发 | ❌ **2 条 thread** | ✅ **1 条**,败者不开 thread |
| S5 `/register` 覆盖正主 | ❌ `ok:true`,正主被覆盖成不存在的 id | ✅ 409 拒绝,正主不动 |
| S6a 删 thread(根消息还在) | ❌ 建了**新 id** 的 thread + 累积第 2 条根消息 | ✅ **同 id 自愈**,1 thread / 1 根消息 |
| S6b thread 与根消息都没了 | ❌ 静默重建 | ✅ 具名 502 `canonical_root_gone`,不重建 |
| S6c 按手册 fenced 放弃后 | ✅ | ✅ 恰好 1 条新 thread |

**BEFORE 2/8 · FIX 8/8。** S2 就是 founder 看到的那个症状,前后对照是它的直接铁证。

> 顺带实测到一条真实 Discord 语义(我最初的假设是错的,已据此重做前提):
> 删**根消息** → 消息 404 但 thread 仍活;删 **thread channel** → thread 404 但根消息仍活;
> 只有两者都删才是「正主全没」。S6a/S6b 因此是两个不同的状态,不是一个。

---

## 3. 529 隔离房真 Bridge 路由级 E2E

`qa-fly-1927-bridge-e2e.mjs` —— slot 2 真 Bridge(从**被测 worktree** 起房),
`/health` 的 `buildSha` 实测 == 被测 head,真 Linear 预检,真 Discord。
覆盖模块臂覆盖不到的那条腿:`tools.ts` 里新增的 `/send` 首块 404 恢复路径。

| 用例 | 结果 |
|---|---|
| B1 首次 `/send`(无登记行)→ 恰好 1 条新 thread,消息真落在里面 | ✅ |
| B2 正主 id 不是 thread(根消息还在)→ `/send` **同 id 恢复**并送达,不开第二条 | ✅ |
| B3 正主 thread 与根消息都没了 → 具名 502 `canonical_root_gone`,**零新 thread** | ✅ |
| B4 `/chat-threads/create` 对同一死正主 → 同款具名拒绝,不重建 | ✅ |
| B5 按 `operations.md` 的 fenced 放弃后 → 恰好 1 条新 thread | ✅ |
| B6 `/chat-threads/register` 拿真实存在的另一条 thread 抢正主 → 409,正主不动 | ✅ |

**6/6。** 跑完已 `test-teardown.sh 2` 拆房,slot 已释放。

---

## 4. 定向自动化测试

`packages/teamlead` 下四个相关文件 **147/147 通过**:
`fly1927-chat-thread-create.test.ts`、`ChatThreadCreator.test.ts`、
`chat-thread-register.test.ts`、`chat-thread-routes.test.ts`。

---

## 5. 逐条对照 design-correction §5 的验收合同

| 合同条目 | 证据 |
|---|---|
| 第二步超时但 Discord 已建成 → 采用同一个 thread,不发第二条根消息 | S2(前后对照)+ B2 |
| 第二步明确失败且 thread 不存在 → 只重试同一 `rootMessageId` | S3(`startCalls=2`,根消息始终 1 条) |
| 两个独立 Store/Creator 竞争 → 只有 CAS 胜者开 thread | S4(BEFORE 2 条 → FIX 1 条) |
| 已有正主时 `/register` 不能覆盖 | S5 + B6(409) |
| 正主 thread 与根消息都 404 → 响亮失败,重复调用不发新根消息;人工 fenced 放弃后才允许重建 | S6b/S6c + B3/B4/B5 |
| 现有健康创建与复用响应形状保持兼容 | S1 + B1;147/147 既有套件全绿 |

---

## 6. 诚实边界(honest boundary)

1. **没验的:完整 dispatch → Runner → session_started 的真单全链。**
   我验的是这条链上真正会建 thread 的那一段(`ChatThreadCreator.ensureChatThread`,
   `DirectEventSink` 与两条 Bridge 路由调的是同一个入口,已核对为同一函数、同一 issue key)。
   起一条真 Runner 才能覆盖的部分是「谁在什么时候调它」,而不是「它会不会建重复」。
   风险:低。补齐时机:下一次 529 房里跑任意真单时顺带观察即可。

2. **B2/B3 的前提不是靠真删 thread 建立的。** slot-2 的 bot 没有 MANAGE_THREADS
   (`DELETE /channels/<thread>` 实测 403),所以那两条用例改成把 slot 自己的登记行指向
   「已不是 thread 的真实消息」/「完全不存在的 id」—— 与生产上 thread 消失后登记行的状态等价。
   **靠真删建立前提的版本在模块臂(slot-1 token)里跑通了**(S6a/S6b),两者互补。

3. **本改动把「thread 在 Discord 里消失」从自动重建改成了响亮失败 + 人工 fenced 放弃。**
   这是 design-correction §3.5 由 founder 拍板的设计,不是缺陷。代价要说清楚:
   若某条 thread 连同根消息被真正删除,该 issue 的 Lead 通报会一直 502,
   直到有人按 `operations.md` 跑那条 SQL。
   ——注意 founder 处理重复 thread 用的是**归档**,归档的 thread 仍然存在、不会触发这条路径。
   只删 thread(根消息还在)也不会:S6a/B2 证明它会同 id 自愈。

4. **新产生的不可达生产代码:** `createChatThread()` 与 `StateStore.upsertChatThread()`
   在生产路径上已零调用方(仅测试与兼容 helper 在用)。按仓库的 dead-code 纪律,
   是否删除应由实现者/Lead 决定,不在本 QA 的处置范围。

---

## 7. 复现命令

```bash
node engineering/doc/FLY-1927-duplicate-issue-threads/qa-fly-1927-real-discord-e2e.mjs fix
node engineering/doc/FLY-1927-duplicate-issue-threads/qa-fly-1927-real-discord-e2e.mjs before
# 529 房(须先从被测 worktree 起房并核 /health 的 buildSha):
TMPDIR=/tmp/ TEST_REPLY_BY_ISSUE=1 bash scripts/test-deploy.sh 2 --from-branch main
node engineering/doc/FLY-1927-duplicate-issue-threads/qa-fly-1927-bridge-e2e.mjs
```

两个 harness 都会自清理它们在隔离频道里造的 thread / 消息。
