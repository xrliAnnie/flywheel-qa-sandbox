# FLY-1663 拆除 Lead lifecycle 层，回归 launchd 原生 — 探索

Issue: FLY-1663 (https://linear.app/geoforge3d/issue/FLY-1663/拆除-lead-lifecycle-层回归-launchd-原生根治非补丁)
日期: 2026-08-08
基于: 无

## 1. 宪法（founder 原话，verbatim）

> 「这就是和我们之前一样的毛病啊，这个东西就是越修、加了越多的补丁之后，就越容易出问题。怎么样才能把我们的系统整个简化，不要加这么多补丁呢？你这个东西已经修了 3 天了，到现在还不行，不能用。」（Annie，2026-08-08，R5 后定性）

> 「我觉得应该是要根治，而不是打补丁。」（Annie，V6.2 D1 留言）

> D1′ 拍板：「同意，立 design 单」（Annie，2026-08-08 晚）

本探索的一切结论必须服从三条红线：

1. **修复 = 净删除**。每保留一个机制都要有真实事故场景支撑，无场景不加护。
2. **design 阶段零生产改动**。只写文档、攒分支，不碰运行系统。
3. **本单例外硬 gate**：design HTML 交付后必须等 founder 批准方案，才能进 implement。

## 2. 问题定性：八个事故、一个器官

三天内 8 个表面不同的事故，逐一归因后全部长在同一个器官——**自研 Lead lifecycle 层**：

| # | 事故 | 病灶机制 |
|---|------|---------|
| 1 | quiesce 杀不净 / 杀错窗 | 共享 tmux session（杀窗要在全舰共享的 session 里精确瞄准） |
| 2 | 热循环堵死 Bridge（FLY-1648/1661） | 收尾账面死循环 + Bridge 无 launchd 兜底 |
| 3 | 锁风暴（Simba 崩 5 小时，FLY-1659） | 全局 tmux 锁（所有进程抢一把锁） |
| 4 | watchdog 自杀无人复活（FLY-1651/1661） | Bridge 自杀设计依赖的 KeepAlive 从未加载 |
| 5 | supervisor 自撞 restart #400+（FLY-1662） | identity preflight 把自己刚 spawn 的孩子判成陌生活体 |
| 6 | Discord 静默降级 | 事故连锁后 Lead 事件链路无声失效 |
| 7 | 收养死角杀健康活体 | archive/收养仲裁（FLY-1602 加、FLY-1634 拆过一轮，残余仍伤人） |
| 8 | 应急体 env 交叉污染（收据记到 Mufasa 名下） | 手工救活绕过正规启动路径的副作用 |

**Lead 本体（Claude Code 进程）一次都没病过。** 病全在包着它的保姆层。

### 2.1 这层是怎么长出来的

每个机制单独看都有"当时的理由"：

- supervisor：怕 Lead 死了没人拉 → 自研 KeepAlive；
- 全局锁：怕并发 tmux 操作互相踩 → 全局串行化；
- 租约 + preflight：怕双 body 抢同一身份 → 自研仲裁；
- 共享 tmux session：让 founder 在 cmux 一眼看全舰 → 所有 Lead 挤一个 session；
- archive/收养/rescue：怕重启后孤儿没人管 → 自研认领。

但它们合在一起复刻的正是 **launchd 自带的能力**（KeepAlive = 死了重拉；label 单实例 = 不双跑），而且复刻坏了：每个"为了更健壮"的机制都成了新的故障面，且互相踩踏（preflight 撞见 supervisor 自己的孩子、锁风暴由 supervisor 的 inspect 触发、收养逻辑杀健康活体）。三天 8 修 8 坏就是这个结构的必然产物。

### 2.2 与 FLY-1655 的同构性（设计语言对齐）

FLY-1655 的裁定：self-ship 修了 10 次没修好，因为**每次修复只覆盖上一次事故的状态签名**（快照式补丁），要按**不变量**重设计。本单是同一场战役打在另一个器官上：

- FLY-1655 器官 = ship-gate / workflow 引擎账面；
- FLY-1663 器官 = Lead 进程生命周期。

共同设计语言：**不再为"见过的故障形状"写补丁，而是让系统只依赖少数几条被 OS / 被结构保证的不变量**。本单的不变量清单（见 §4）就是按这个语言写的。两单各修各的器官，互不阻塞。

## 3. 方向：launchd 原生两层形态

**目标形态 = 「launchd → Lead」两层**，中间不再有任何自研生命周期层：

- 每个 Lead 一个独立 launchd job（`com.flywheel.lead.<project>-<lead-id>`），`KeepAlive` + 单 label 单实例，由 launchd 保证"死了重拉、不双跑"。
- 薄启动器（thin launcher）替代现 claude-lead.sh 那族联动脚本：只做"准备环境 + exec Lead 本体"，不含监护、锁、租约、收养逻辑。
- 不共享 tmux server：每个 Lead 自带自己的终端可见面（具体实现在 research 中定，候选见 §5）。
- 全局锁、租约、preflight、archive/收养随层拆除，机制性消失。
- rescue 捞号（login_expired 自愈）从生命周期里剥出来，做成独立小工具，人/infra-bot 按需调用。

**先例已在生产验证**：Mufasa（FLY-250 起）就是一个 launchd job 直跑的 Lead（`com.flywheel.lead.growth-mufasa-lead`，KeepAlive 1s 自起实测），wrapper source `~/.flywheel/.env` 拿 token 不进 plist 明文。这条路不是纸上设计，是把 Mufasa 形态推广到全舰。

## 4. 目标不变量清单（design 的锚）

拆除后系统只依赖这些不变量，每条都由 OS 或结构保证，不由自研代码保证：

| # | 不变量 | 保证者 |
|---|--------|--------|
| I1 | 同一 Lead 身份至多一个 body 在跑 | launchd label 单实例语义（同 label 同 domain 只能 bootstrap 一份） |
| I2 | Lead 死了会被重拉 | launchd KeepAlive |
| I3 | Lead 的环境（token/env）来自唯一正规路径 | 薄启动器 + wrapper source `~/.flywheel/.env`（应急手工路径废除，救活=踢 launchd 重拉） |
| I4 | 一个 Lead 的终端可见面不被别的 Lead 的操作波及 | per-Lead tmux 隔离（不共享 server / session，无跨 Lead 写操作） |
| I5 | Bridge 死了会被重拉 | Bridge 同样进 launchd KeepAlive（必答 6） |

推论：不需要全局锁（没有共享可变面）、不需要租约/preflight（I1 由 OS 保证）、不需要收养（没有孤儿：job 死了 launchd 重拉的是全新 body，旧 body 由薄启动器的 exec 语义保证同生共死）。

## 5. 关键设计问题（research 要取证回答）

1. **cmux 可见性**（必答 3 的核心难点）：cmux 是否支持同时挂多个 tmux session / 多个 server？per-Lead 隔离的三个候选：
   - A. 每 Lead 一个独立 tmux **session**（同一默认 server）——隔离 session 级操作，但仍共享 server 进程；
   - B. 每 Lead 一个独立 tmux **server**（独立 socket）——完全隔离，cmux 侧怎么发现/展示要取证（FLY-1578 cmux-lead-session-grouping 研究已有材料）;
   - C. Lead 不进 tmux，launchd 直跑，可见性走别的面（tail 日志 / cmux 只读 attach）——最激进，可见性损失要评估。
2. **launchd 单实例语义的边界**（必答 4）：什么情形下会出现双 body（bootout 竞态？手动直跑绕过 launchd？plist label 冲突？），是否需要最小补强（如启动器内 `launchctl` 自查），还是纯靠纪律（废除手动直跑路径）。
3. **薄启动器的最小职责集**：环境装配、cd、exec——还有什么是真必需（如 tmux 窗口自建）？每多一行都要有场景。
4. **rescue 剥离**：现有 login_expired / quota 救号逻辑长在哪里，剥成独立工具后的调用方是谁（人 / claude-infra-bot / quota daemon）。
5. **Bridge launchd 化**（必答 6）：FLY-1651/1661 已两次坐实"plist 存在但未加载、restart-services.sh 以子进程拉起"。初步立场 = **并入本单**：同一设计原则（OS 原生监护），且 EventLoopWatchdog 自杀设计的前提就是 KeepAlive 在场——不并入则本单拆完 Lead 层，Bridge 仍是孤儿。
6. **FLY-1661 处置**（必答 7）：初步立场 = **拆分**——"Bridge 回 launchd"部分并入本单（即上条）；"boot 积压热循环燃料"（stage-emoji stamp 无界重试 + receipt-settlement 冲突无终态）属消息/收据层，判给批E 收据机器或最小修，待 research 确认批E 范围后定。
7. **迁移与回滚**（必答 8）：全舰 15+ Lead 逐个迁 or 一波切？重启几次、每次影响谁、回滚怎么走。约束：迁移本身不得再造一个"大爆炸 cutover"事故窗。
8. **Runner 窗口归属**：Runner tmux 窗口今天挂在哪个 session/server？Lead 隔离后 Runner 可见面是否跟着动（初步立场：Runner 生命周期归 Bridge/TmuxAdapter，不在本单 scope，但窗口归属要在 design 里说清不留悬空）。

## 6. 关联单处置（初步，design 结论中定稿）

| 单 | 处置 |
|----|------|
| FLY-1662（supervisor 自撞） | **不修**。机制随拆除消失，本单 ship 后 close。 |
| FLY-1661（Bridge boot 防洪） | 拆分：launchd 部分并入本单；热循环燃料判给批E/最小修（见 §5.6，research 后定）。 |
| FLY-1651（已 Cancel） | 其两条遗产（"Bridge 为什么死"取证 + "死亡不留证据"）由本单 Bridge launchd 化 + 日志/退出证据方案吸收。 |
| FLY-1655（self-ship 按不变量重设计） | 独立单、独立器官。设计语言对齐（§2.2），互不阻塞。 |

## 7. 不做什么（honest boundary，初稿）

- 不动 Lead 本体（Claude Code 进程、identity.md、rules 注入）。
- 不动 Runner 生命周期（TmuxAdapter / pr_handoff 等 executor 机制）。
- 不新增任何 watchdog / 陪跑告警体系（founder 红线，FLY-1651 教训）。
- 不做跨机 / 多机编排（单机 launchd 域内）。
- design 阶段不碰生产。
