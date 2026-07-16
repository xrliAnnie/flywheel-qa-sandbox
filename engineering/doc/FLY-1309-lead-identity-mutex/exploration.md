# FLY-1309 Lead 身份唯一性 — 探索
Issue: FLY-1309 (https://linear.app/geoforge3d/issue/FLY-1309/fix-lead-身份唯一性-双进程互斥-同身份并存检测1229-改写今晚双-lead-事故根治)
日期: 2026-07-16
基于: 无

## Context

2026-07-15/16 夜里发生两起独立的「同一 Lead 身份双进程并存」事件:

1. **Tadashi 双进程**: 56004 (Opus) + 73168 (Fable) 同时顶 flywheel-eng-lead 身份(Cass 实测),后自行消解。
2. **HL 双进程 + 错误授权指令**: 25056 + 72462 并存;期间「另一个 HL」给她的 runner 发了一条错指令——宣称她合法的 publish「未经授权」,runner 差点去查一个不存在的幽灵流水线。

危害定性(Cass): 两个 Lead 顶同一身份、对同一个 runner 下互相矛盾的授权判决。这次是错误地拒绝,下次可能是错误地批准 ship——授权链上的静默 no-op。

FLY-1229 的 founder-approval 大头已由 FLY-1251 交付(fail-closed, Done);本单承接剩余 scope,聚焦**进程层**的身份唯一性(FLY-865 是显示层,已 Done,不重造)。

## 事故取证(本机实测, 2026-07-16 设计阶段)

| 观察 | 事实 | 含义 |
|------|------|------|
| Lead supervisor 启动时间 | 全部 Jul 15 01:24–01:34,与 `~/.flywheel/pids/*.pid` mtime 一致 | 昨晚 00:13 的 unified restart **没有**重启 Lead supervisor(只有 Bridge 于 00:20 重启,`bridge.pid` mtime 为证) |
| HL 事故进程 25056 | **现在仍然活着**,`claude --agent flywheel-product-lead --model claude-opus-4-8[1m] --resume 796b...`,lstart = Jul 15 01:26:56,正是 supervisor 22686 名下的正主 pane | 事故中「消解」的是**后起的** 72462;25056 是常驻正主 |
| Tadashi 事故进程 56004/73168 | 均已消失;当前正主 pane 9040 (Fable, `--resume 02bdc96d`) lstart = Jul 15 01:26:12,横跨事故窗口存活 | 两个事故 PID 都是**瞬态额外进程**——即当时至少存在第三方拉起的同身份进程 |
| supervisor launchd 日志 (`/tmp/flywheel-lead-flywheel-flywheel-eng-lead.log`) | mtime = Jul 15 01:26,事故窗口**零新行** | 瞬态进程**不是**由正主 supervisor 的 recovery loop 拉起的(否则必有 `[restart #N]` 日志) |
| CommDB 事故窗口 (07:21–08:16 UTC) | HL 有 `instruction`/`response` 写入(经 `flywheel-comm`),但未检索到含「未经授权/publish」字样的那条错指令 | 错指令可能走了 CommDB 之外的通路(mailbox 直写 / relay / 措辞不同);**指令溯源缺失使事后无法定位发送进程——这本身就是验收 #3 要修的问题** |

**结论**: 确切的瞬态触发源(谁在 00:41 拉起了第二个同身份 claude)以现有审计能力无法回放定位——因为 (a) 指令无进程溯源,(b) Bridge 对同 leadId 双活零检测。这正是本单三条验收各自对应的结构性缺口。触发源不确定不影响设计:下述代码审计证明并存向量客观存在多条,修法必须对「任意来源的第二进程」成立。

## 代码审计: 三层结构性缺口

### 缺口 A — 启动层互斥有洞(多入口、守卫不一致)

Lead 真身 = tmux pane 里的 claude CLI(共享 tmux server,session `flywheel`,窗名 `${PROJECT_NAME}-${LEAD_ID}`),**它是 tmux server 的子进程,不是 supervisor 的子进程**——杀 supervisor 不杀 pane。现有守卫:

- supervisor PID file guard(`claude-lead.sh:2714-2732`,FLY-1285 加了 argv 指纹)——只防**双 supervisor**。
- FLY-1285 takeover guard(`_prepare_lead_launch` `claude-lead.sh:1197-1244` + `tmux-supervisor-guard.sh`):archive 文件记 `server_pid/pane_pid/pane_start/window_id`,启动前证明旧 pane 死透才 reap+launch,活着就 HOLD(`ambiguous`/`split_brain`)——**只在启动时刻生效**,且:
  - 未归档活 pane 的检查被 generation 门控(`claude-lead.sh:1230`):tmux server 换代(rescue/饱和/crash)后整块跳过 → 旧代 server 上的活 claude 检不到,新 supervisor 照常 launch → **跨代双 pane**(split-brain 经典路径);
  - `_launch_claude` 无条件覆写 archive(`:1567`)→ 未被 archive 指到的活 pane 永久失踪、不可 reap;
  - supervisor 被 SIGKILL / crash 跳过 `cleanup()` → pane 成孤儿。
- 启动入口共 5 条(launchd KeepAlive / restart-services kickstart / restart-services nohup / fleet daemon bootout+bootstrap / 手动 claude-lead.sh),守卫各不相同;手动路径的 PROJECT_NAME 自动解析与 launchd 路径可产生**不同的 PID file key** → 两个守卫互相看不见 → 双 supervisor → 双 pane。
- 模型来自 manifest,pane launch 时注入 `--model`(`claude-lead.sh:1301-1327`)→ **「旧进程 Opus + 新进程 Fable」正是孤儿 pane 活过一次 model flip 的特征签名**。

### 缺口 B — 运行时零检测

- LeadWatchdog(`LeadWatchdog.ts`,30s tick)按 config 里的 lead 列表巡,`locateLeadWindow`(`LeadWindowLocator.ts:61-72`)按窗名**精确首匹配**——同名双窗只看见第一个;**从不读 PID**,不读 manifest pid,不读 FLY-1285 archive。
- Lead 无 heartbeat、无注册表(`lead_events` 是告警去重账本,不是活进程 registry)。
- ⇒ 两个进程同顶一个 leadId,今天的 Bridge **结构性不可见**。

### 缺口 C — 授权面零绑定、零溯源

- `flywheel-comm respond`(`respond.ts:119` 直写 CommDB)与 `send`(`send.ts:34` 写 instruction + mailbox 唤醒)= **trust-by-invocation**:`--lead`/`--from` 是自由字符串,谁能 exec CLI 谁就是任意 Lead。仅 `approve_to_ship` 走 Bridge fail-closed(FLY-1251)。
- Bridge HTTP 全端点共享**一个** bearer token(`TEAMLEAD_API_TOKEN`),body 里的 leadId 只做审计归属,不做鉴别。
- CommDB `messages` 表 sender 身份 = `from_agent` 字符串,**无任何 pid/进程代次/lease 列**;`[lead-instruction <id>]` 前缀只是投递去重回执(FLY-208),不带进程标识。
- ⇒ 事故里「另一个 HL」发出的指令与正主发出的在系统里**不可区分**,事后不可审计。

## 验收 ↔ 缺口映射

| 验收 | 对应缺口 | 修法方向 |
|------|---------|---------|
| 1 结构性互斥(第二进程拒起或降级只读,绝不能发指令/答 gate) | A + C | **身份 lease + generation token**,授权面 fail-closed 校验 |
| 2 并存检测 + 告警 + 标记后起进程 | B | Bridge watchdog tick 加同身份进程计数(进程表真相,非窗名) |
| 3 指令可溯源 | C | CommDB + mailbox envelope 加进程溯源字段,CLI 自动附带 |
| 4 回归(KeepAlive/resume 不受影响,不误杀合法接替) | A | lease **接替**语义(证明旧持有者死亡→代次+1),不引入新 kill 路径 |

## 方案选项

### 选项 1(推荐): 身份 lease(generation token)+ 授权面校验 + Bridge 双活检测 + 溯源列

**核心思想**: 互斥不再依赖「防止第二个进程存在」(A 类洞永远堵不完——5 条启动入口、tmux 换代、SIGKILL),而是**把「以 leadId 行事的权力」绑定到一张可原子转移的 lease 上**。第二个进程可以存在,但它手里没有当前代次的 lease → 授权面 fail-closed 拒绝它 → 结构性降级为只读。这正是验收 #1 给出的两个出口里更稳的那个(「降级为只读」),同时天然满足 #4:合法接替 = lease 正常转移(代次+1),旧进程瞬间失权,无需杀任何进程。

- **lease 存储**: `~/.flywheel/` 下 SQLite CAS 表(镜像现成的 `launch-claim-store.ts` 原子 claim 模式):`lead_key(project-leadId) PRIMARY KEY, generation, holder_pid, holder_start(进程启动时间指纹,防 PID 复用,复用 FLY-1285 `tmux-supervisor-guard.sh` 的 lstart 证明), acquired_at`。
- **发放**: claude-lead.sh 在 `_launch_claude` 成功后 acquire(代次+1),把 `FLYWHEEL_LEAD_GENERATION` + lease key 注入 pane env(现成 env 注入机制 `:1406`)。接替规则 = 复用 FLY-1285 证明:旧持有者 pid+start 证明死亡才允许 acquire;活着 → 沿用现有 HOLD。
- **校验(fail-closed)**: `flywheel-comm respond`/`send` 在写入前校验「env 代次 == lease 当前代次 && holder 指纹匹配本进程链」。stale → 拒绝 + 大声报错 + 写审计行。三态 rollout(`off | audit_only | enforce`,镜像 FLY-175 的 DECISION_MODE 模式),merge 默认 `audit_only`(零行为变化,只记账),真机 QA 后翻 `enforce`。
- **检测**: LeadWatchdog tick 增加同身份进程计数——用**进程表真相**(`ps` argv 精确匹配 `--agent <leadId>`,注意排除 runner 的 `--agent-id runner-*@<leadId>`,子串 grep 必误报),>1 → 新告警 kind `lead_dual_active`(走现成 claims.db 去重 + FLY-1220 episode latch 防刷屏),按 start 时间标记后起进程 + 指出谁持有 lease。**只告警不自动杀**(验收原文即「告警+标记」;检测类误杀风险高)。
- **溯源**: CommDB `messages` 增列 `sender_pid, sender_start, sender_generation`(幂等 ADD COLUMN 迁移,镜像 FLY-267 的做法);CLI 自动附带;mailbox envelope metadata 同步携带。runner 可见文本 `[lead-instruction <id>]` **字节不变**(id 已可回查 CommDB 行取全溯源;改可见前缀会碰 FLY-208 幂等解析)。
- 启动层只做两个最小加固(不追求堵死所有 A 类洞):(a) launch 前跨代进程表 preflight(任何非本代同身份活 claude → HOLD+告警,呼应 voice-bridge「端口 preflight」的探全局真相精神);(b) PID file key 派生统一化。

**优点**: 对任意来源的第二进程都成立(包括未知触发源);合法接替零风险;完全复用项目已验证的模式(CAS claim / fail-closed verify / 三态 rollout / episode latch / 幂等迁移)。
**缺点**: 授权面校验只覆盖走 CLI 的指令;`terminal-mcp` 直接 send-keys 给 runner pane 的旁路不在 v1(记 follow-up);Codex lead backend(无 claude pane)v1 不覆盖(生产 Codex lead 不 spawn runner,风险低,记 follow-up)。

### 选项 2: 只做启动层强互斥(把 5 条入口全收敛到一把锁)

统一所有入口过同一个 flock/CAS + 跨代 reap。
**否**: 治标——tmux 换代、SIGKILL、未知触发源(本次事故正是!)仍能产生第二进程,且一旦产生依旧全权;把「互斥」寄托在枚举完所有生成路径上,而事故已证明枚举不完。

### 选项 3: Bridge 中心化(Lead 全部指令走 Bridge,per-Lead credential)

给每个 Lead 发独立 token,所有授权动作过 Bridge 鉴权。
**否(v1)**: 动到所有 Lead↔Runner 通路(CommDB 直写是性能/可用性设计,Bridge down 时 Lead 还能工作),爆炸半径大、与 FLY-142/168 邮箱体系纠缠;lease 方案以 1/5 的改动面达到同等互斥效果。per-Lead credential 可作为远期方向。

## 风险与开放问题

1. **验收 #3 的字面解读**: 「runner 收到的指令带进程标识」——v1 放在 mailbox envelope metadata + CommDB 行(runner 收到的 envelope 确实带,但可见文本不变)。若 Tadashi 要求可见文本也带,再改前缀(需同步改 FLY-208 幂等解析,风险可控)。→ gate 上确认。
2. **enforce 的翻闸时机**: lease env 只在 Lead pane 重启后存在;merge 后到 fleet 重启前,enforce 会拒掉所有老 pane → 必须 audit_only 起步,随下一次批量重启翻 enforce。→ 部署纪律写进 plan。
3. **founder 手动 respond**(Annie 终端救火): 无 lease env → enforce 下会被拒。设计显式旁路:`FLYWHEEL_LEAD_LEASE_BYPASS=1`(大声审计,镜像 FLY-1251 的 emergency bypass)。
4. **detection 误报**: runner argv 含 lead 名、Discord 回声、`claude -p` 短命进程——检测必须 argv 精确匹配 + 连续两 tick 确认;fixture 必须含 runner-argv 阴性样本 + 双活阳性样本 + 突变验证(空过绿测是本项目背过的教训)。

## 推荐

选项 1。三层各自独立成立、互为纵深:lease(互斥/降级)是根治,detection(告警)是安全网,provenance(溯源)是事后审计;任一层失效其余仍有效。
