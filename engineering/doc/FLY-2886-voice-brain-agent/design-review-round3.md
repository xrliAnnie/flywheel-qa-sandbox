# Design Review — plan.md (Round 3)
Date: 2026-09-25
Author: Codex
Status: CHANGES REQUESTED

## Summary

v3 已关闭 R2 第 1、2、4、5、6、7 项的核心阻塞/建议。R2 第 3 项的正常并发路径已有可行设计，但新目标锁的 unknown 放行和生命周期合同仍需修正。本轮保留 2 项阻塞，另列 2 项实现建议。

已完整重读 v3（310 行）及 R2 报告，范围严格限定为 R2 第 1–7 项和 v3 修改引入的回归。保留固定 founder 决策；接受计划对 Claude 常驻写入仅提供尽力预检与动作日志的明确边界，不要求把 Claude 本体改造成 Codex broker，也不重开先前已关闭的事项。

评审基线：HEAD `a1e6fb83ab34055fd8f7e04824772dda364f1369`，plan SHA-256 `a7287543e10620186a02b355a568abaea462077887b3cae4a77316716ccdfdb5`。与 R2 基线相比，本次提交只变更文档；相关生产代码未变。本轮结论来自静态阅读，未运行真实订阅、业务写入或仓库测试；计划中的实验仍待实现期执行。

下文 `P` = `engineering/doc/FLY-2886-voice-brain-agent/plan.md`；`T` = `packages/teamlead/src`；`V` = `packages/voice-codex/src`；`U` = `/tmp/voice-research/codex/codex-rs`。

| R2 项 | 本轮核验 |
|---|---|
| 1 obligation 归属/覆盖 | 核心问题关闭。P:55–61 增加重复去重、5 秒有界等待、迟到未确认，删除段数推断；容器仅播实际回答。迟到写请求的重问文案见建议 3 |
| 2 授权贯穿 | 设计层面关闭。P:87–99 明确 authority 联合类型、handler/envelope/scope/runner 传递、最终副作用前 fence 校验及真实 Claude 身份一读一写验收 |
| 3 常驻优先 | 部分关闭。P:105–110 增加别名归一、持久化 target_key、共享锁和常驻排队，解决正常路径的检查后竞态；unknown 和锁生命周期仍见阻塞 1、2 |
| 4 地板身份与重开 | 核心问题关闭。P:216–218 使用本地语音段、同 item_id 关闭 provider 段、重开保留本地占用；兜底计时的数据来源见建议 4 |
| 5 确认语双生产者 | 关闭。P:146、219 明确模型独占、客户端永不补播，V3 关闭额外 filler；遵从率仅作兼容性证据 |
| 6 改稿订阅启动档 | 设计层面关闭。P:234–240 的 voice-scribe 分开工具/登录策略，独立 home、无 API key、保留旧档，并验证账户、空工具集及普通 turn |
| 7 拒绝分类 | 关闭。P:133 按可信目录区分 reserved、会话 unavailable、未知 invalid；只有 reserved 进入 founder 文案和通知 |

## What's Good (Keep)

- 新 authority 明确贯穿实际调用链，且以当前租约 fence 约束最终副作用，覆盖了 R2 指出的多层 carrier 准入。
- 确认语选择单一生产者，删除宽限期竞争；voice-scribe 也不再把原 API 登录档误当作订阅档。
- obligation 的有限等待和不按段数宣称完成，避免了 R2 的无限挂起及错报具体请求完成问题。
- 正常目标锁顺序明确为“语音已派发则先完成，常驻随后执行”；规范化目标和回执 target_key 值得保留。
- Claude 常驻路径的能力与并发保证分开说明，没有用无法兑现的统一锁保证掩盖实际边界。

## Issues & Recommendations

1. **[blocking] [HIGH] unknown 锁允许常驻直接写，会重新产生被迟到语音写覆盖的问题。（R2#3 未关闭）**

   **问题与证据：** P:108 承诺常驻等语音写结束后执行，但 P:109 又规定常驻遇到 unknown “照常执行”，只记录“覆盖未知在途写”。现有 T/lead-capabilities/broker.ts:349–371 在超时后返回 unknown；它使用 `Promise.race`，不证明 provider 副作用已停止。T/lead-capabilities/handlers/linear.ts:297–299 的检查发生在请求发出前，`client.updateIssue(issue.id, patch)` 没有使用该目标锁的 fence，也没有资源版本前提。

   **为何重要：** 确定的交错是：语音持锁发出请求 → 本地超时、锁转 unknown → 常驻按 P:109 放行并写成功 → 原语音请求才在远端落地。最终仍是语音覆盖常驻。记录“覆盖未知在途写”不能保证实际提交顺序；Bridge 表里的 fence 也不能撤销已经发给 Linear 的请求。这与 P:108、290 的“结果以常驻为准”矛盾，且不同于已明确接受的 Claude 路径边界。

   **建议：** unknown 应当阻止双方继续做可能覆盖同一目标的写，直到可信对账证明旧操作已结束，或实际 provider 支持并校验可阻止旧写提交的版本/fence。常驻可优先获得下一次执行权、发起对账，但不能把“尚未确认结束”当作“已经结束”。不能确认时返回明确待对账状态，不宣称常驻覆盖成功。补“语音超时 → 常驻尝试写 → 旧 provider 晚成功”的验收，断言不会出现两个未终结的冲突副作用同时在途。

2. **[blocking] [MEDIUM] 新目标锁缺少取消、持有者崩溃和失联回执的收尾合同，影响到常驻写路径。（v3 锁机制回归）**

   **问题与证据：** P:106–109 只有 acquire/release、expires_at、终态释放和常驻排队，未定义等待取消、租约过期的状态转换、Bridge/持有者重启恢复或迟到 release 的处理。现有普通操作只有 15 秒期限（`packages/flywheel-comm/src/lead-operation-client.ts:4–22`），T/lead-capabilities/broker.ts:350–375 到期会中止并结束该调用；目标锁是新增的跨进程状态，现有本地 receipt recovery 不会自动清掉它或队列。

   **为何重要：** 常驻等待过程中超时退出，若排队标记仍在，P:107 会继续拒绝所有后来的语音写。持有者在 acquire 成功后崩溃，或 release 响应丢失，也不会再产生计划依赖的正常释放流程。简单按 expires_at 解锁则可能放过仍在远端执行的旧写，回到问题 1；完全不处理又会永久占住业务目标。新增锁接入常驻 broker 后，影响范围已经超出一个语音会话。

   **建议：** 在 §4.3 补一份最小状态转换合同：等待项如何绑定 request/activation 并在取消、超时、失权时移除；等待是否计入现有操作期限；重复 acquire/release 如何幂等；release 必须匹配当前 holder/request/fence；崩溃或失联后如何依据可信回执恢复，无法证明未派发/已结束时进入 unknown，不能直接因 TTL 到期放行。Bridge 重启应恢复或安全清理等待项，并明确回滚时存量锁的处置。补“排队者取消”“acquire 成功后进程死亡”“release 丢包/迟到”“Bridge 重启”的窄集成用例。无需再扩展业务调度体系，只需把这张新表的生命周期定义完整；P:295 的“数据库只加列”也应同步为新增锁表的实际情况。

3. **[advisory] [MEDIUM] 迟到 handoff 的统一“没接上，再说一次”不应诱导重做已经执行的写。（R2#1 修订边界）**

   **问题与证据：** P:57 明确承认上一回合可能已经处理该请求，P:58 却统一要求她重说。U/core/src/realtime_conversation.rs:1769–1779 确实先路由输入再发送 handoff 通知；T/lead-capabilities/broker.ts:224–233 的幂等身份仍是 requestId，新一轮语音请求不天然复用旧操作身份。

   **为何重要：** 对查询而言重问通常只是重复工作；对创建 issue、发消息等操作，若原回合实际已成功，再说一次可能产生新的请求并执行第二次。P:114 的失败账本覆盖额度/会话异常交接，尚未明确用于这一新增加的“归属未确认”分支。

   **建议：** 保留有界等待，但未确认时避免把关联失败说成未执行。优先展示已收到的终态结果/动作回执；涉及可能已经发生的写时说明“结果还没对应上，我先核对”，后续重问携带原义务及已知操作账本。补“写已成功、handoff 迟到、用户重复原话”的用例即可，不要求恢复段数判断或增加业务线程。

4. **[advisory] [MEDIUM] 3 秒无输入兜底应明确使用原始房间接收活动，排除持续补发的静音帧。（R2#4 实现接线）**

   **问题与证据：** P:216 将所有 provider 开放段也纳入 user-active，并以“无任何输入帧 3 秒”兜底。现有 V/discord-room.ts:242–252 每 20ms 调用 uplink.tick；V/pipeline/Uplink.ts:167–179 即使无人说话也向后端 appendAudio；V/audio/JitterBuffer.ts:46–56 在没有采集帧时返回补齐静音。因此在后端收到的帧上计时，兜底永远不会触发。

   **为何重要：** 当本地语音段已经结束，而某个 provider item 的 completed/final 丢失时，新 OR 规则会继续占用地板；若计时器被合成静音持续刷新，结果/议程就无法主动播出。

   **建议：** 在计划里明确计时来源是补静音之前的原始接收/有效语音活动，并约定如何清理没有结束事件的 provider 补充段；可复用 V/pipeline/Uplink.ts:117–135 的原始帧入口。补“本地已结束 + provider final 缺失 + 静音 tick 持续”的用例，验证有界恢复，且旧段清理不影响正在说的新段。

## Verdict

CHANGES REQUESTED

剩余阻塞仅为第 1、2 项目标锁合同。其余 R2 项的核心修订可以关闭，第 3、4 项作为对应分支的实现建议保留；不重开其他已关闭事项或固定决策。本次只写本反馈文件，未修改仓库文件。

