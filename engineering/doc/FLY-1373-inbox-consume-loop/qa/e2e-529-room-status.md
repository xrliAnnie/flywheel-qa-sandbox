# FLY-1373 · 529 房 Discord 真机 E2E — 结果

Issue: FLY-1373 (https://linear.app/geoforge3d/issue/FLY-1373/消息系统-照抄-claude-code-消费循环-lead-收件全链路根治1s轮询销账语义忙时挂起批量投递类型分流)
日期: 2026-07-19
基于: qa-report.md §7 覆盖边界

**状态: 4 个场景全部真机 PASS。N-to-N(≥2 Lead)仍缺第二个 bot 身份 — 需 founder/Lead 决策,不属我自决。**

---

## 0. 总账

| 场景 | 结果 | 决定性证据 |
|---|---|---|
| ① 正常投递 | ✅ PASS | 真/假 exec-id 单变量对照;真 id ≤1s 物化投递销账 |
| ② 并发顺序/优先级 | ✅ PASS | **对抗性构造**:先入队 p3 后入队 p1,p1 仍先投递 → FIFO 无法解释 |
| ③ 崩溃重投 | ✅ PASS | 真 kill -9 命中 claimed-but-unconsumed 窗口;15/15 不丢,重复恰好 1 条 |
| ④ 忙时挂起恢复 | ✅ PASS | 确认忙态期间投 10 条,队列 10/10 + Lead 实收 10/10 |
| N-to-N(≥2 Lead) | ⛔ 未做 | 缺第二个 bot 身份(invite = 访问控制变更,不自决) |

**全程零丢**:comm.db lead_inbox 最终 85 total / 85 consumed / **0 pending**。
**生产零触碰**:delivery-secret md5 `68d0112efd3ed35a57db2f18df0d71a1` 与开工基线逐字一致(含 2 次 Bridge 击杀)。

---

## 1. 房间与复活能力(本轮新增,是③的前提)

| 项 | 值 |
|---|---|
| slot / 端口 | 2 / 19872,跑 `flywheel-FLY-1373` checkout(= PR #652) |
| Lead | `flywheel-test-2`,tmux window `test-slot-2-flywheel-test-2` |
| 队列表 | comm.db 的 **`lead_inbox`**(不是 `messages`,也不是 teamlead.db 的 `lead_events`) |

### ✅ 复活脚本 `/tmp/q13/fly1373-e2e/revive-bridge.sh`

上一轮③被阻塞的原因是"杀了起不来"(重跑 `test-deploy.sh` 要 teardown → teardown 要 cmux
mutator lease → lease 被生产 watcher 持着)。**本脚本绕开 teardown**,只重起 Bridge 进程,
slot 目录 / DB / 锁 / Lead tmux 窗口原地保留 → 完全不碰 cmux,该阻塞点不适用。

env 不是猜的:显式覆盖组逐条对齐 `test-deploy.sh:1394-1411`,`FLYWHEEL_PROJECTS` 从活
进程 env 抠出真值。**停机前做过差分预检**:键差异仅 npm 自注入的 25 个(`npx` 会重新注入)
+ `TEST_API_TOKEN`(已补);16 个关键值逐个比对全部一致。

**复活实证**(空房间单独验证,刻意不与③合并 —— 合并会分不清"复活配方坏了"还是"崩溃恢复坏了"):
- owner_epoch `db8977e3` → `671bbd5b`(loop 真重启并重新拿租约,epoch fencing 生效)
- 心跳恢复、session 保留、生产密钥不变、冷启 ~19s

---

## 2. 各场景细节

证据文件在 `/tmp/q13/fly1373-e2e/`:`s2-evidence.txt` `s3-evidence.txt` `s4-evidence.txt`

### ② 并发顺序/优先级 — 关键是构造方式

**先入队 10 条 p3,再入队 10 条 p1**(窗口 <1s)。这样"p1 先到"不可能由 FIFO 解释。

Lead session transcript 里的**原始投递顺序**(不是 Lead 的转述):

```
位置 1      Event #23     stage_changed  p3   ← 属更早批次,不在争用集
位置 2-11   Event #33-42  runner_question p1  ← 后入队,先投递
位置 12-20  Event #24-32  stage_changed  p3   ← 先入队,后投递
```

组内 seq 严格单调 → 优先级内 FIFO 保持。20 个成员合为 Lead 的一条消息 = 一个 turn。

> 中途纠错:第一次量 `consumed_at` 排序,发现整批时间戳完全相同 —— 因为 `maxBatchSize=10000`,
> 现实 burst 撑不爆单批,**优先级根本没被迫仲裁**,那是一次空过的绿测。真正的观测点是
> claim 查询 `ORDER BY priority, seq` 决定的**批内成员排列**,即 Lead 读到的先后。

### ③ 崩溃重投 — 命中了正确的窗口

入队 15 条后 ~420ms 发 kill -9。崩溃瞬间快照:

```
total=15  consumed=0  unconsumed=15
claimed_but_unconsumed = 1   ← seq 43,已认领但 consumed_at 未写 = 真·投递途中
```

复活后 15/15 销账(22s,含冷启 ~19s);seq 43 终态 `consumed=1 / disposition=delivered`。

投递次数(逐事件计数):**#43 = 2 次**(恰为那条在途消息),#44-57 各 1 次。

**重复不是缺陷** —— `lead-inbox-loop.ts:2` 明确声明 *"per-Lead **at-least-once** inbox
consumption loop"*。at-least-once 的定义就是不丢、崩溃窗口内可能重投。实测重复被精确
限制在唯一那条在途消息,不是重复风暴;Lead 层按事件号识别重复。

### ④ 忙时挂起 — 连续两次探测器失败,均为我方工具问题

v1 找 `esc to interrupt`(该 Lead 忙态不显示这串)、v2 用 `capture-pane -S -8`
(状态栏占 7-8 行,spinner 被挤出窗口)。**两次都先自查"是没收到还是没测到"**:
A 组每次都 5/5 销账且 Lead 确实处理了 → 是尺子坏,不是产品坏。
v3 改用 transcript 末条 type(user=收到未答=忙),发探针实测翻转后才使用。

确认忙态期间投 10 条:队列 10/10 销账、Lead 实收 Event #76-85 各 1 次。

**需如实说明**:"挂起"不发生在队列层 —— 实测 +2s 时 Lead 仍忙、10 条已全部 consumed。
inbox loop 在 Lead 忙期间照常全速消费,缓冲发生在下游 Lead session 邮箱。
耐久边界是「adapter 收妥」而非「Lead 已读」。若验收意图是"队列层挂起",实现与之不符;
若意图是"忙时来的不丢、空闲后能看到",完全满足。**意图判定留给 Lead,我只报实测。**

---

## 3. 仍未完成

| 项 | 阻塞原因 |
|---|---|
| 真 N-to-N(≥2 Lead) | slot 1/3/4 身份被别的 QA 活 Lead 占用;FLY-882 bot 池取新身份要 `invite`(= 往 guild 加 bot = 访问控制变更)→ **不自决** |

---

## 4. 给接手人的提醒

1. **判据纪律**:本轮 4 次差点误报,全靠"先量再断"救回 —— 假 exec-id 当丢消息、burst 计数
   误读、空过的优先级绿测、探测器失败当投递失败。**读到空 ≠ 目标没收到**,先排除自己的 setup。
2. **别拿转述当 artifact**:Lead 自己归纳的"组A/组B"顺序是它的叙述,不是投递顺序;
   真顺序要从 session transcript 的原始消息取。
3. **`FLYWHEEL_DELIVERY_SECRET_PATH` 必须自己 export** —— `test-deploy.sh` 从不设它,
   不设就抹掉生产密钥。复活脚本已内置。
