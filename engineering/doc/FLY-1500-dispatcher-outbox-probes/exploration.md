# FLY-1500 dispatcher + outbox + 探针 — 探索

Issue: FLY-1500 (https://linear.app/geoforge3d/issue/FLY-1500/v2批次2-dispatcher-outbox-探针-外发执行与应有实际状态对账)
日期: 2026-07-27
基于: 无(上游=doc/engineer/plan/v2/design-FINAL-v2.md 设计终版,Codex R13 APPROVED)

---

## 1. 一句话问题

v2 里所有对外部世界的副作用(GitHub/Discord/Linear/进程)如何做到:**转化事务只写账(pending command),外发由唯一执行者异步完成,崩溃后靠"应有 vs 实际"对账恢复,永不静默丢、永不猜测重发**。

## 2. 输入与约束

### 2.1 设计终版对本批的硬约束(不可重开的决定)

| 条款 | 内容 | 出处 |
|---|---|---|
| 外发=outbox | 转化事务只写 pending command;"处理完成"="回复 command 已入 outbox";Discord 罕见重复诚实入基线 | FINAL §1.2e |
| commands 状态机 | 6+2 态:pending→claimed→accepted→executing→succeeded\|failed;rejected/canceled;result_code 六枚举 | FINAL §1.1 |
| **claim 术语区分** | mailbox 消息层的 claim/租约**已删除**(单收件人无竞争);**commands 的执行 claim 协议保持不变**(外发需所有权)——两个状态机不可混淆 | FINAL §T;Lead 强化① |
| 唯一执行者 | 每个 command.kind 有且只有一个 executor class;projector=dispatcher 的 adapter,同一 claim loop | v2 §1.3 |
| 结果分类法 | stale/policy_denied/noop→rejected 结清永不告警;retryable_failure 走重试预算;effect_unknown 走 reconcile | v2 §2.1 |
| 崩溃规则 | accepted 后崩溃→lease 过期→reconcile(查 intent/receipt)→无 intent 安全重放,有 intent 无 receipt 先对账;**effect_unknown 永不猜测重发** | v2 §1.1 |
| 探针三态 | desired vs observed(present/absent/unknown);枚举成功+同 host_epoch+明确 absent 才判 dead;枚举失败=unknown 但有界升级(N 次→obligation);**计数落库不落内存** | v1 §2.3 |
| saga 总表 | 穷举 command.kind 的 effect 处置;未知 kind fail closed;github_merge/destructive_delete 不入自动 saga,走独立高权限 gate | final §2.5 |
| notify-then-do | admission(非豁免 action 必带 ≥1 notify_before)+claim(依赖全 succeeded)双校验;kind 三分类:prerequisite_notification={notify,founder_page}/readonly={status_read,probe_query,mailbox_read,events_read}/其余=action | final §2.9 |
| 无直接 DB 写权 | 全部 executor 经 kernel 提交结果 | v2 §1.3 |
| bypass 封闭矩阵 | 审计=commands.result_code+events.kind='bypass_used';拒绝不静默 | final §5-P12 |

### 2.2 批次1(FLY-1497,已 merge main@6caa082d)已建成的地基

- `packages/v2-kernel`:17 表迁移(0001-0004)、`Kernel.write()`(BEGIN IMMEDIATE 单写 + CAS + tx 预算 + SQL 关键字守卫)、`AgentIdentity`(**仅 lead/runner 两类**)+ meta registry(`lead_registry:`/`consumer_registry:` 键空间)+ `FENCE` canonical CAS 语句。
- **commands 表 schema 已全量存在**:8 态 CHECK、result_code、claim_owner/claim_generation/lease_expires_at、effect_key UNIQUE、cutover_epoch、accepted_at/completed_at。
- **command_dependencies 已存在**:kind CHECK('notify_before')、禁自环+禁环触发器、行不可变触发器。
- 本批**不改**以上任何已落库结构;若需簿记列/表,新迁移 0005 **只加不改**(Lead 强化③),迁移测试入验收。

### 2.3 Lead 强化四点(brainstorm gate 回复,全部吸收为验收项)

1. plan 显式写明 mailbox-claim(已删)vs commands-claim(保留)的区分。
2. effect_unknown 配**可执行判据**:什么算 unknown、reconcile 顺序、多久升级——不许只写原则。
3. 0005 迁移只加不改,迁移测试入验收。
4. 反 over-reaction 逐机制真答两问,答不出即删;保护性机制写明"删了会怎样"。

## 3. 场景驱动(本批负责的已枚举场景)

| 场景 | 内容 | 本批的角色 |
|---|---|---|
| A7 | Lead→Annie 汇报,Discord 发送失败→她不知道 | outbox 重试直到 receipt/dead;不再"发出去就忘" |
| C1 | runner 进程死(额度/崩溃/被杀) | 探针 observed=absent→attempt failed→Lead 判断 |
| C2 | runner 活着但卡住 | 探针诚实回答"在"(present),不越权判卡死(那是 Lead/T_max 的事) |
| C4 | Bridge 死/重启 | 进行中的外部动作靠 effect receipt 对账,重启后 reconcile |
| C5 | vendor 挂(Codex 503) | spawn command failed(retryable)→重试预算→升级 |
| C7 | 派发失败(起不来进程) | dispatcher 报错→重试 N 次→仍失败升级给人 |
| C8 | DB 写失败/锁 | 事务整体回滚,command 未结清→下次重放 |
| B2/P10 | 打回→下游已产生的外部 effect 怎么办 | saga 处置总表(补偿/forward-repair/不可逆排除) |
| P2 | spawn 后立杀进程 | 60s 内 observed=absent 且重派或 obligation(v2 §5 验收原文) |
| P8 | expected denial 制造告警噪音 | 结果分类法:rejected 类结清零告警 |
| D1(边缘) | github_merge | 不入自动 saga;claim 需 founder gate 绑定(gate 内容归 FLY-1498) |

**反例(本批明确不管)**:A1-A6/A8 消息消费(FLY-1499)、告警聚合与抑制规则内容(FLY-1501)、task 级派发与 ship 前置三条(FLY-1498)、注入垫片(FLY-1501)。

## 4. 核心问题拆解与选项

### Q1 "每类 command 唯一执行者"如何成立 + dispatcher 的身份

唯一性有三层,逐层判定:
- **静态层**:kind→executor class 映射是一张编译期总表(TS 联合类型穷尽)。一个 kind 恰好一个 executor class——这是"唯一执行者"的定义本体。
- **进程层**:所有 executor class 住在**同一个 dispatcher 进程**里(v2 §1.3:projector=同一 claim loop 的 adapter)。单机单实例,不存在跨进程竞争。
- **世代层**:dispatcher 重启/复活旧进程→generation fence 拒旧世代写(与 lead/runner 同一套机制)。

身份选项:
- **A. 扩 AgentIdentity 增 `dispatcher` 类**(registry 键 `dispatcher_registry:<id>`):与现有 fence 对称,claim_owner/claim_generation 语义与 identity 直接对应。批次1 的 `parseIdentity` 是封闭枚举,加第三类=只加不改。
- B. 复用 `consumer_registry:` 把 dispatcher 当一个 agent:省一个键空间,但把"消息消费者"与"命令执行者"两个概念混进一个注册表,正是 v1 病根式的语义含混。
- **倾向 A**。反 over-reaction 答辩:C4/C3 场景(进程重启+旧进程复活)需要 fence;根治(单实例)不够,因为"单实例"是运维意愿不是机器事实,launchd 双拉起/旧进程僵而不死在本机历史上真实发生过(FLY-172 orphan reconcile、FLY-176 multi-PID)。

### Q2 命令生命周期:三个崩溃窗口与 intent/receipt 载体

状态机(批次1 已定):`pending →(claim CAS)→ claimed →(校验+接收)→ accepted →(写 intent)→ executing →(receipt)→ succeeded|failed`;kernel 裁定终局 `rejected/canceled`。

三个崩溃窗口的处置(= reconcile 协议的骨架):
| 崩溃点 | 库内痕迹 | 恢复动作 |
|---|---|---|
| claimed 后、accepted 前 | claim 字段有值,无 intent | lease 过期→CAS 回 pending,安全重放(零副作用窗口) |
| accepted 后、executing 前 | accepted_at 有值,无 intent | 同上——accepted 定义即"尚未产生副作用" |
| executing 后、receipt 前 | **intent 已落库**,无 receipt | **先对账**:按该 kind 的探针查外部实际状态;present→补记 receipt;absent(可信)→按 kind 的重放安全性处置;unknown→有界升级,永不猜测重发 |

intent/receipt 载体选项:
- **A. events 行**:`events.kind='effect_intent'/'effect_receipt'`,与 `commands.state` CAS 同事务。审计天然 append-only;commands 表不加列;receipt payload(外部 id、URL、PR number)有地方放。
- B. commands 加列(intent_at/receipt payload 列):查询少一跳,但审计历史只剩最后一次,重试多次的痕迹丢失;且要动批次1 表(改列违背"只加不改"精神——加列虽合规但把可变状态与不可变证据混在一行)。
- **倾向 A**:executing 态本身(state 列)是"有没有 intent"的快速判据,events 行是证据本体;`state='executing'` 与 intent 行同事务写入,两者不可能分家。

### Q3 探针:什么算 unknown、对账顺序、有界升级(Lead 强化②的可执行判据)

**两个探测对象,一套三态语义**:
1. **进程类**(spawn/terminate 的效果;attempts.observed_state):probe=枚举 tmux session/PID+host_epoch 标记。判据:枚举调用成功+目标可枚举=present;枚举成功+目标不在+host_epoch 同代=absent;枚举调用本身失败(tmux server 无响应/超时)=unknown。
2. **效果类**(commands 的外部效果):按 kind 分**可探测性等级**——
   - `probeable`:GitHub PR(按 head branch/URL 查)、Linear issue 状态(按 id 查)、进程(has-session)。probe=对外部系统的只读查询,带 effect_key/外部 id。查询成功且效果在=present;查询成功且效果不在=absent;查询失败(网络/限流/5xx)=unknown。
   - `non_probeable`:Discord 消息(翻历史不可靠且有权限/分页噪声)。**设计终版已裁决**:接受罕见重复+幂等键(消费端幂等/更正帖),不为它造探针。
- **unknown 的可执行判据**:探针动作自身失败(超时 T_probe、连接错、5xx、限流),或返回结果不可判读(枚举成功但证据不完整,如 host_epoch 不匹配)。**absent ≠ unknown**:absent 是"查成功了、确实不在"。
- **有界升级**:unknown 连续计数**落库**(不落内存,进程重启不清零);连续 N 次(拟 N=3)且跨度 ≥ T_escalate(拟 5min)→ 建 obligation 交人裁决 + command result_code='effect_unknown' 冻结(不再自动重试);任一次 probe 得到确定答案(present/absent)→ 计数清零。
- **簿记落点选项**:
  - **A. 0005 迁移给 commands 加 `probe_unknown_streak INTEGER NOT NULL DEFAULT 0` + `last_probe_at TEXT`(attempts 已有 observed_* 三列,补 streak 列)**——只加列,最小。
  - B. 独立 probes 表:每次探测一行。审计最全,但探测是高频低值操作,行数膨胀与 retention 负担不成比例(over-reaction 红旗)。
  - C. 数 events 里的 probe 行:零 schema 变更,但每次探测要 COUNT 查询+probe 结果也得写 events(还是在写),复杂度换了个地方。
  - **倾向 A**;探测结果只有在**改变判断**时(unknown→升级、absent→判死)才写 events 行,常态 present 不刷 events。

### Q4 saga 处置总表

- 载体:TS `Record<CommandKind, Disposition>` 编译期穷尽(新增 kind 不写处置=编译失败)+ 运行期收到表外 kind=saga 拒绝启动(fail closed,result_code='policy_denied'+obligation)。
- Disposition 枚举:`compensate(生成指定补偿 command)` / `forward_repair(重投影)` / `none(信息类无需)` / `manual_gate(不入自动 saga;github_merge/destructive_delete)`。
- 补偿本身=普通 command 走同一 outbox 生命周期(补偿的补偿不存在:补偿 command 的 disposition 必须是 none/forward_repair——表内静态可查,防递归)。
- kind 枚举以 research 阶段 v1 外发路径审计结果定稿(事实先于设计;审计进行中)。

### Q5 notify-then-do 双校验落点

- **admission 单点**:SQLite 触发器做不了"INSERT commands 时校验它带 ≥1 依赖"(依赖行在同事务稍后插入,SQLite 无 deferred trigger)→ admission 校验必须住在**类型化 kernel op**(`admitCommand(tx, cmd, deps[])`:一次调用里插 command+全部依赖+分类校验,不给"先插命令后补依赖"的裸写路径)。这与 FLY-1499 台账里"写入面走类型化操作"的方向一致,但本批只交付 commands 域的 op,不做全库类型化(范围纪律)。
- **claim SQL 硬门**(真正的强制层,admission 是早失败):claim CAS 的 WHERE 带两个谓词——①该 command 的全部 notify_before 依赖 state='succeeded'(NOT EXISTS 未完成依赖);②action 类 kind 必须 EXISTS ≥1 notify_before 依赖(防绕过 admission 裸插)。分类表(kind→class)是静态常量,SQL 里以 IN 列表展开。
- 依赖 effect_unknown → 该依赖非 succeeded → 谓词天然挡住 → 先 reconcile(与 §2.9 "任一依赖 effect_unknown → action 不可 claim"逐字一致)。

### Q6 与三姊妹的接缝(单向依赖,不做对方的事)

| 姊妹 | 接缝 | 方向 |
|---|---|---|
| FLY-1499 | 转化事务调用我的 `admitCommand` 把 pending command 落进 outbox;"处理完成"的定义引用我的 admission 语义 | 1499 →调用→ 1500 |
| FLY-1501 | 父抑制子=**dispatcher claim predicate**(claim 时查无匹配 open parent)。我在 claim SQL 处预留谓词插槽(notify 类 kind 的 claim 额外 AND 一个由 1501 定义的抑制条件);抑制规则表内容、tier 债记账全归 1501 | 1501 →注入谓词→ 1500 |
| FLY-1498 | github_merge/destructive_delete 的 claim 需 gate 绑定 capability;gate 语义/ship 三条通用前置归 1498。我只承诺:这两个 kind 在处置总表里=manual_gate,且 claim 谓词要求 capability 引用存在 | 1498 →提供 gate 事实→ 1500 |

## 5. 反 over-reaction 初筛(机制 × 两问)

| 机制 | 哪个已枚举场景需要它 | 根治为何不够 | 判定 |
|---|---|---|---|
| transactional outbox | A7(Discord 发失败她不知道)、C4(重启后在途动作)、C8(写锁回滚) | "根治"=把外发塞进 SQL 事务——物理不可能(跨系统无单事务) | 必须 |
| 执行 claim(commands 层) | C4/C7:崩溃后谁接手、接到哪一步 | 单实例意愿≠机器事实(本机历史:FLY-176 multi-PID、FLY-172 orphan) | 必须(注意与 mailbox 已删 claim 严格区分) |
| lease 过期回收 | claimed/accepted 窗口崩溃→command 永久卡住 | 无 lease 则需人工发现"卡在 claimed"——就是 v1 病根式的静默 | 必须,但 lease 只用于**自我接管**,无竞争语义 |
| generation fence(dispatcher) | C3 变体:旧 dispatcher 复活双写 | 见 Q1 | 必须 |
| effect intent/receipt | executing 窗口崩溃后"发没发过"唯一判据 | 不记 intent=只能猜,猜=P2/A7 复发 | 必须 |
| 探针(效果类) | C1/C2/P2、executing 对账 | receipt 缺失时唯一的事实来源 | 必须 |
| unknown 有界升级 | 探针本身坏了(tmux server 挂)不能无限 hold | 无界=僵尸 command 无人知晓 | 必须(N/T 参数供砍) |
| saga 总表 | B2/P10 打回后外部残留 | 不穷举=新 kind 静默无处置,P10 复发 | 必须 |
| notify-then-do 双校验 | 设计终版 §2.9 逐字要求(P11 族:先斩后奏) | admission 单点可被裸写绕过→claim SQL 硬门兜底 | 必须 |
| **保护性(供砍)清单** | 见 §6 | | |

## 6. 保护性机制单列(founder 可砍;砍了会怎样)

1. **claim 谓词里的"action 类必须 EXISTS ≥1 notify_before"**(双保险的第二道):砍了→绕过 admitCommand 的裸 INSERT(理论上只有 kernel 内代码能做)可以直接被 claim。风险=内部代码 bug 一层防护变零层;成本=一个 EXISTS 子查询。
2. **probe 常态 present 不写 events 的例外——升级/判死时写**:砍"写 events"→审计里看不到"为什么这个 command 被冻结";成本=极低频写。
3. **补偿防递归的静态检查**(补偿 command 的 disposition 必须 none/forward_repair):砍了→错误配置可造补偿环;编译期检查零运行时成本,建议保。
4. **unknown 升级参数 N=3/T_escalate=5min 的双条件**(次数+跨度):砍跨度只留次数→探针风暴(连续 3 次毫秒级失败)误升级;砍次数只留跨度→单次瞬时失败挂 5min 才升级,慢。两者都便宜,建议保双条件,参数任调。

## 7. 带进 research 的开放问题

1. v1 外发路径审计结果(进行中,后台 agent):kind 枚举定稿、各外部系统幂等/可探测性真实事实(gh CLI 的重复行为、Discord API 无 dedup 的确认、Linear mutation 语义)。
2. lease 时长、重试预算(retryable_failure 几次进 dead/obligation)、T_probe/N/T_escalate 参数表——research 里对齐设计终版参数风格(§1.2c 的 T_* 家族)。
3. dispatcher 的驱动方式:事件驱动(kernel 写 command 后门铃)vs 周期 tick——对齐 §1.2a"唤醒三路"风格,倾向 门铃(可丢)+ 周期扫描兜底(活性),扫描间隔=T_dispatch_tick。
4. `probe_query` 是 readonly 类 command kind(§2.9)——探针是"由 dispatcher 内部直接做的动作"还是"也走 commands 表的 readonly command"?倾向:**内部动作**(探针不产生副作用,走 command 表=为对账动作再造对账,over-reaction);readonly kind 保留给外部调用方的查询。research 定稿。
5. 0005 迁移的精确 DDL(加列清单)与迁移测试形态(参照批次1 obligations-migration.test.ts)。
