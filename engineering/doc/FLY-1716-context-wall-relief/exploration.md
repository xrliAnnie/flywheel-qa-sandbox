# FLY-1716 Lead context 墙泄压 — 探索

Issue: FLY-1716 (https://linear.app/geoforge3d/issue/FLY-1716/投递撞-context-墙无泄压-lead-会话满-context-时投递永远进不去队列冻死今晚-cass-47-条-25h)
日期: 2026-08-14
基于: 无

## 1. 问题一句话

Lead 的 Claude Code 会话(context = 模型一次能看到的对话上限)会涨满撞墙;撞墙后投递管线零感知继续灌注,队列冻死;重启走 `--resume` 把满 context 原样带回 —— Annie 每次都要手工逐个 `/clear`。

## 2. 两波实证 + 本次审计取证

### 2.1 事故时间线(issue 记录)

- **8-11 晚**:cos-lead(Cass)撞 context limit,47 条 QUEUED 冻结 2.5h+,3 个 LEASED 批反复租约重投同一个进不去的会话;手动 `/compact` 失败(conversation could not be reduced);Tadashi 手工 `/clear` 解开。
- **8-14**:Annie 发现重启之后 Cass / Honeylemon 窗口又是 context 满,要求:1) identify why 2) 修到「重启之后不会再出现」。

### 2.2 本次审计新钉死的事实(transcript 取证,细节见 research.md)

对 Cass 当前 session(`ed851bfd`,364MB transcript)全量扫描:

| 事实 | 数据 |
|---|---|
| 会话出生 | **2026-06-16**(近两个月一条会话) |
| 最后一次成功 API 回复 | **2026-08-06 02:05**,context 占用 **731,028 tokens**(claude-opus-5,1M window 的 73%) |
| 之后 | **8 天零成功回复**,transcript 被继续灌入 **55MB** 注入(mailbox 投递 + synthetic 错误行) |
| 手动 /compact 失败实录 | 8-12 transcript 内 `Compaction failed · conversation could not be reduced below the context limit` |
| session-id 文件 | `~/.flywheel/claude-sessions/flywheel-flywheel-cos-lead.session-id` **mtime 停在 Jun 16**,内容 = ed851bfd |
| 今天(8-14 15:28)重启后 | Cass 活进程 argv = `--resume ed851bfd --model claude-opus-5[1m]` —— **重启把 /clear 救活的成果扔掉,又 resume 回 8-06 就死掉的僵尸会话** |
| /clear 接力的痕迹 | workspace 里有 8-11/8-12/8-13 的新 jsonl(每次手工 /clear 后的活会话,几 MB 量级),但 session-id 文件从不回写 |

**这直接回答了 Annie 的「为什么重启之后还是满」:不是重启把 context 塞满了,是重启永远 resume 回那条早已撞死的会话 —— /clear 接力救活的新会话 id 从不被记录。**

## 3. 根因链(分层)

```
[L1 源头]   长寿 Lead 会话 context 单调上涨(投递、告警、订阅注入)
[L2 防线失效] auto-compact 防线(CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70)未生效:
            env 传播链完好、变量在 Claude Code 2.1.233 仍被识别(binary 实证),
            但内部 threshold-compact 有多层可让它不执行或失败(见 research §2):
            reactive 路由实验 / 失败断路器 / rapid-refill 断路器 / prefix overflow;
            1M 会话 compact 失败有实录("could not be reduced")
[L3 结构缺口] GEO-285 四层防线的主力(session rotation)已在后续版本删除,
            只剩 env(黑盒)+ 重启(而重启 --resume 原样带回)
[L4 感知盲区] 撞墙状态对系统完全不可见:pane-blocked-classifier 无 context_limit kind,
            model-cap 显式把「Context limit reached」排除,投递侧 recipientState 硬编码 alive
[L5 冻结机械] 投递 transport 成功(写 inbox 文件)≠ ack;3 个在途批占满槽位 → QUEUED 冻结;
            租约 30min × 3 次重投同一个死会话 → DEAD → 死信通知渲染「不可得」
[L6 重启复发] restart-services 对 session-id 文件零操作 → kickstart → --resume 僵尸会话
```

## 4. 方案空间探索

### 4.1 A 治本 —— 「Lead auto-compact 修到真生效」怎么理解

派工提案原文是「Lead auto-compact 修到真生效(70–80% 自动压缩)」。审计后的判断:**不应该也无法在 Claude Code 内部机制上「修」**:

- override 变量本身在场且被识别(binary 逆向证实,语义 = 降低触发阈值),shell 传播链无洞 —— 没有「修传播」的活可干。
- threshold-compact 是否真的执行,受 Claude Code 内部多层不可控因素支配:服务端实验开关(`tengu_auto_compact_routed_reactive` 把主动压缩路由成「撞墙才反应」)、连续失败断路器、rapid-refill 断路器、fixed-prefix 溢出判定(Lead 的 rules bundle + MCP tools 前缀巨大,可直接判「压缩无济于事」)。这些都是黑盒 + 随版本漂移的面,Flywheel 修不到。
- 1M 会话的 compact 失败已有实录 —— 即使触发,也可能失败。

**收敛:A 的「治本」= Flywheel 侧自己掌握 context 压力读数 + 自己执行泄压**,不再把安全性押在 Claude Code 内部 auto-compact 上(它生效算赚到,不生效有我们兜)。这是对提案 scope A 的形态修正,机制不变的部分是目标:「平时到不了墙」。

### 4.2 泄压动作的选型

| 选项 | 评价 |
|---|---|
| ①注入 `/compact` | 温和(保留对话记忆),但**已证明会失败**(prefix overflow / could not be reduced),且失败后有断路器;只能当第一级尝试,不能当保底 |
| ②注入 `/clear` 接力 | **保底可靠**(fresh context 一定成功);FLY-1751 已把 `/clear → SessionStart hook → adopt-inflight(在途批自动回队重投)`整条腿建好并在生产运行;缺口只剩 clear 腿不发 bootstrap(PostCompact 腿的 bootstrap 脚本可直接复用) |
| ③重启换 fresh 会话 | 语义同②但代价大(整个 launchd 换代);仅在重启路径上作为闸门使用(见 B) |
| ④session rotation(定时轮换) | GEO-285 原主力,被删;比「按压力泄压」更粗暴,不复活 |

**收敛:两级泄压原语 —— 先 ①/compact,失败或无效则 ②/clear 接力(adopt-inflight + 补 bootstrap)。** ②的基建 90% 已存在。

### 4.3 B 重启兜底 —— 「重启出来一定不满」

两个互补的最短修复,全部落在 launcher(`claude-lead.sh`)已有分支结构上:

1. **resume 前泄压闸**:`_v2_is_resume` 判定之前,读上一会话 transcript 末条真实 assistant usage(`input + cache_read + cache_creation`,即该轮实际 context 占用;本次审计已实证此口径可离线读出且能跳过 synthetic 行)÷ 模型 window → 占用率;超阈值 → **把 session-id 文件 rename 成 `.parked-*`**(沿用人肉先例形态)→ 自然落入 fresh 分支,fresh 分支**天然**做 `send_bootstrap` + `_adopt_inflight_before_launch`(不掉批)。fail-open:读不出/解析失败照旧 resume。
2. **/clear 换代回写 session-id**:SessionStart(source=clear) hook 已存在(FLY-1751),补一腿把新会话 uuid 回写 session-id 文件 → 重启 resume 的是 /clear 后的活会话,不再回僵尸。

这两条合起来 = 「重启出来一定不满」的硬验收:要么 resume 的是健康活会话,要么 fresh。

### 4.4 C 减源 —— 基线已被 FLY-1764 改写

FLY-1764(#836,8-14 merge)已**物理删除**「OOM 预警广播全 Lead」那条腿(Honeylemon 连刷 4+ 条的通道已不存在),swap 告警现在只投 claw 一行 mailbox。C 需按新基线重述,残余缺口:

- 生产 `FLYWHEEL_ALERT_ROUTING=1` 需实机确认(default-off,unset 则回旧 Discord 腿);
- flapping(压力 high→clear→high)每个新 episode 穿透全部 5 层 dedup —— 缺 per-(recipient, kind) 时间窗节流;
- `collapse_key` 是死列(只写不读),同 kind 未投递行不塌缩。

**收敛:C 收缩为小项**(验证 1764 生效 + 未投递行按 collapse_key 塌缩),不再有独立大工程。

### 4.5 投递感知(原 issue 的「泄压」诉求)与 Annie 裁决的关系

Annie 8-11 裁决:投递侧补丁「暂时不用修,重点修信箱」。信箱大修(FLY-1569~1576)已落地大半;FLY-1708/1751 把「换代不掉批」修好。本设计据此**不碰投递循环**(也是 FLY-1708 plan 的红线),泄压腿放在投递循环之外:

- 检测:statusline 每帧已拿到 Claude Code 官方 ctx%(`context_window.used_percentage`),落盘一个状态文件(唯一官方口径、零轮询成本);
- 触发:Bridge 现有 GatePoller rider(零新 timer)读状态文件,超阈值执行两级泄压;
- pane-blocked-classifier 增加 `context_limit` kind 只作为**兜底识别**(撞墙已发生时的最后感知),不是主检测路径。

投递循环唯一受益方式是间接的:泄压 → `/clear` → adopt-inflight 清空在途槽位 → 队列自然排空(FLY-1708 F7 对偶已证)。

## 5. 与相邻 issue 的边界

| Issue | 关系 |
|---|---|
| FLY-1708 / FLY-1751 | **依赖并复用**:adopt-inflight 双腿(launcher + SessionStart clear hook)是本设计泄压保底的地基;不改其语义,遵守「一次换代只 adopt 一次」纪律 |
| FLY-1706(compact recovery-nudge) | **吸收**:其「recovery-nudge 端点加 compact action + pane capture 直读校验」的设计并入本单一级泄压;1706 零代码落地,无冲突 |
| FLY-1764 | **基线**:C 部分建立在其 Flow 2 之上,不回退其决策 |
| FLY-396 | 方向吸收(auto-compact 生效目标),机制按 §4.1 修正 |
| FLY-360(lead-1m-context-tier plan) | 1M tier 已在生产(`opus-5[1m]`);本设计的 window 解析需认识 `[1m]` 后缀 |

## 6. 待设计细化的问题(进 research/plan)

1. transcript 末条 usage 的读取实现(大文件尾读、synthetic 跳过、window 解析)与阈值选择(70%?)。
2. 运行时 ctx 巡逻的挂载点(GatePoller rider)与两级泄压的执行通道(recovery-nudge 端点扩 compact/clear action;活性校验按 FLY-1706 约束用 pane capture 直读,不用 terminal MCP 探针)。
3. /clear 腿补 bootstrap 的方式(复用 post-compact-bootstrap.sh)。
4. SessionStart hook 回写 session-id 的竞态与 fail-open 边界。
5. 断路与防抖:泄压动作本身的频控(不能变成新的告警风暴/compact 风暴)。
6. C 项:collapse_key 塌缩的最小实现或明确放弃(删列)。
