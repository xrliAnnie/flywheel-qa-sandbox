# FLY-1929 内核 panic 致全机重启 — 实施计划

Issue: FLY-1929 (https://linear.app/geoforge3d/issue/FLY-1929/infra宿主-内核-panic-致-0135-全机重启-ipc-voucher-泄漏打满-ivac-entries)
日期: 2026-08-20
基于: exploration.md, research.md

> ## ⚠️ 实现细节已过期 —— 以 `as-built.md` 为准
>
> 本文件是**设计阶段**的记录(经过 6 轮 design review),保留作为决策史。
> 但实现期又发生两次方向变化,**下文的组件名、判据分子、状态机描述都已不成立**:
> ① 遏制手段其实早已在生产(root 守卫 `com.annie.voucher-guard`),本单改为「看守它」;
> ② 判据分子从 `bank_task + bank_account` 改成 `bank_task`(前者在健康周期里每小时都会告警);
> ③ 整个 outbox / 锁 / 状态机 / generation id **已全部删除** —— `lead-alert.sh` 本来就有持久投递,
>    那层是重复基建,一半 code-review BLOCKER 就长在里面。
>
> **真实落地的形态见同目录 `as-built.md`。**

> 修订史:R1 推翻了滚动最小值判据、ARC posture、face 计数、launchd 模板、FLY-913 护栏的行为;
> R2 推翻了 signature 方案、XNU 余量论证,并要求补齐 durable state 与投递终态。
> 被证伪的说法一律删除,不与新结论并排保留。

## 0. 结论:验收的前一半已完成

**定位已完成,两条互相独立的证据链:**

| 方法 | 证据 |
|---|---|
| 静态点名(解析 root `lsmp -a` 全量转储) | `ecosystemanalyticsd` pid 616 持有 **47524** 条,占该快照 49816 条的 **95.4%**;第二名 `oahd` 1134;**我方进程人均约一条**(node 122 进程共 121,bun.exe 29 共 29,tmux 17 共 17,claude 本体 24 共 24) |
| 动态归因(断崖释放) | 07:35:52 一次性释放约 48300,同时刻 pid 616 消失、新实例 pid 83903 于 07:35:25 起。**持有量与释放量对得上** |

⇒ **我方进程被排除,持有方是 macOS 的 `ecosystemanalyticsd`。**`playwright-mcp` 正式洗清。

**以下三句是推断不是实测**(R1 更正,保留):
- 「每 fork 一次就留一条永不释放的记录」是推断;实测只支持「它持有 95.4%」与「它死亡时释放」。坐实需要受控 merchant 实验,本单没做。
- 「`runs = 2` 说明它平时很少重启」只对本次开机成立;拿它解释 8/1–8/18 那 17 天**没有证据**。
- 「pid 变了 = 计数清零」不成立;是**那次实测到的释放**证明了清零。故采样记录 `ead_start` 而非仅 pid。
  更强的反例(R2):本次新旧实例存在约 27 秒重叠,单个 daemon start 连「唯一进程集合身份」都不是。

## 1. 机理与判据的源码依据(R2 重写)

### 1.1 panic 条件(已从 XNU 源码逐条核实)

- `IVAC_ENTRIES_MAX = 524288`(`osfmk/ipc/ipc_voucher.h`)。
- 分配走 `ivace_reference_by_value()`:取 `ivac_freelist`,**当且仅当** freelist 为 `IV_FREELIST_END`(空)时才调 `ivac_grow_table()`。
- `ivac_grow_table()` 里 `if (ivac->ivac_table_size >= IVAC_ENTRIES_MAX) panic(...)`。
- 释放走 `ivace_release()`:`ivace->ivace_next = ivac->ivac_freelist; ivac->ivac_freelist = value_index;` —— **完全回到 freelist 可复用**。
- 表增长时新条目也全部挂进 freelist。

⇒ **正确表述:panic = 表已到 MAX **且** freelist 空,即「同时在手的存活条目数」触顶。**

### 1.2 **R2 更正:我之前的余量论证是错的**

我曾两次写「`ivac_table_size` 是只增不缩的历史高水位,所以用当前 inuse 估余量偏乐观」。
**这条推理是错的**,它忽略了 freelist:释放的条目完全可复用,**历史高水位本身不吃掉任何当前余量**。
Codex 指出后我自己回源码复核确认了(见 1.1 的 `ivace_release` 与 grow 时挂 freelist 两段)。

⇒ 正确表述:**存活占用量正是该测的那个量**,不存在系统性乐观偏差。
剩下的唯一不确定性是**分子选得对不对**(见 1.3),那是另一回事。

### 1.3 分子标定 —— **R5:已经做完,结论是分支 A(已解决)**

R2/R3 把「分子未验证」列为已知缺口,R4/R5 要求在实现前把 A/B 分支落定。
**我在活机上把标定做了,不再把这个分叉带进实现。**

**方法**:本次会话的采样器连续采了 **720 个样本**,`bank_task` 跨度 **1176 – 14693**(约 12 倍动态范围),
每个样本同时记录 `bank_task` / `bank_account` / `ipc.vouchers` / `nproc`。

**实测关系**(720/720):

| 关系 | min | median | max |
|---|---|---|---|
| `bank_task − bank_account` | 742 | 956 | 1097 |
| 上一行再减 `nproc` | −353 | −227 | −177 |
| `ipc.vouchers − bank_account` | 52 | 62 | 79 |

- **`bank_task >= bank_account` 在 720/720 全部成立**;
- **`bank_task >= ipc.vouchers` 在 720/720 全部成立**;
- `bank_task − bank_account` 是一个**有界的、随存活任务数走的偏移**(约 0.8 × nproc)。
  措辞收窄(R6):只能说**在这 720 个样本的窗口里它没有随泄漏量增长**,一个窗口不足以确立全局不变量。

**与源码语义对齐**:BANK 的 ivace 值既可能是 `bank_task` 也可能是 `bank_account` 对象,
故「存活 ivac 条目数 = 作为 value 的 bank_account 数 + 作为 value 的 bank_task 数」。
其中 `bank_account` 基本上个个都是 value,而 `bank_task` 是**每个存活任务都有**、不一定被当作 value,
所以「作为 value 的 bank_task 数 ≤ `bank_task` zone 计数」。

**R6 更正 —— 我原来写的「下界」是错的,已删除。**我曾写
`max(bank_task, bank_account) <= 存活 ivac 条目数`。这不成立:`bank_task` 是 **zone 在用计数**,
而我自己上一段刚说过「存活的 bank_task 对象不一定被装成 ivace 值」——
既然如此,task-valued ivace 的数量**可能少于** `bank_task`,它当然不是下界。
「720 个样本里 `bank_task >= bank_account`」只说明两个 zone 的大小关系,**推不出**它是 ivace 的下界。
一般性教训:**已分配的对象**与**当前被 intern 成 voucher 值的不同对象**是两个不同的群体。

源码支持的只有**右边那个方向**:`bank_get_value()` 返回 `bank_task` 或 `bank_account` 指针,
`ivace_reference_by_value()` 对已存在的值做 intern、只为**新的不同值**分配一个槽位;
所以**对象支撑的** BANK ivace 数受这两个 zone 的规模约束:

    对象支撑、非默认的 BANK ivace 数  <=  bank_task + bank_account

两条必须声明的限定(R6):BANK 还有**非 zone 对象**的特殊/默认值;ivac 还**保留了 0 号表项**且不在 freelist 上。
这两项都是固定且极小的量,在 30% / 50% 这个量级上不会让监控变晚。

**定稿决定:分子取 `bank_task + bank_account`。**
准确措辞是 **已标定的保守代理量 / 对象支撑非默认 BANK 值的上包络**;
它**可能明显高估**真实存活 ivace 占用(因为并非每个 zone 对象都被装成值),
另有极少量保留/特殊条目落在它之外。
理由仍是**错误方向不对称**:主要的代理误差偏向**提前寻呼**,而提前可接受、晚了不可接受。
(注意措辞:实测相差约 2 倍的是**两个 zone 表达式**,不是「两个真界」——原文这句也已更正。)

⇒ **分支 A 成立,标定已解决。**阈值(30% / 50%)按这个分子解读,仍是**策略取值**而非源码推出的安全边际。

**溯源留存(R6)**:本次标定的 720 样本原始 capture 与推导命令一并存进本 issue 文件夹
(`calibration-720-samples.ndjson.txt` + `calibration-derivation.md`),否则这条承重的标定无法被独立复核。
**XNU 版本诚实声明**:宿主 panic 报告里的内核是 `xnu-12377.161.14`,而评审期能取到的公开源码修订是
`xnu-12377.121.6` / `main`。所以上面的源码结论对宿主构建而言是**由邻近已发布修订作出的推断**,
**不是**对宿主确切构建的源码验证。
按此分子,本次观测到的峰值合计约 2.8 万,约为上限的 5%。
`bank_task` / `bank_account` / `ipc.vouchers` 三个数仍**全部**写进 NDJSON(便于日后重新解释历史数据)。

> 措辞纪律保留:代码与文档里称它 **已标定的上界代理量**,仍**不**写成「就是 ivac 条目数」——
> 夹逼的上界不等于等式。

## 2. 交付物(完整清单,R2 补齐)

| 产物 | 路径 | 性质 |
|---|---|---|
| 监控脚本 | `scripts/flywheel-voucher-guard.sh` | 唯一新增**生产监控脚本**。**非只读**:写 NDJSON、轮转、写 state。准确说法是**观测型、不做补救**(non-remediating) |
| 测试套件 | `scripts/__tests__/voucher-guard.test.sh` | 命名见 §5.7 |
| launchd 单元 | `scripts/launchd/com.flywheel.voucher-guard.plist` | |
| 单元登记 | `scripts/launchd/units.manifest` | 新增一行 |
| 登记守卫 | `scripts/__tests__/launchd-units-manifest.test.sh` | 硬编码 approved 集合,必须同步 |
| CI 枚举 | `.github/workflows/ci.yml` | R2 补:原清单漏了 |
| kind 面 1 | `scripts/lead-alert.sh` | `--kind` 校验 case |
| kind 面 2 | `packages/teamlead/src/LeadAlertNotifier.ts` | `ALERT_EVENT_TYPES` |
| kind 面 3 | `packages/teamlead/src/bridge/kind-contract.ts` | `KIND_CONTRACTS` |
| kind 面 4/5 | `packages/teamlead/src/bridge/alert-kind-copy.ts` | `titleFor()` / `bodyFor()` |
| kind 守卫 | `packages/teamlead/src/bridge/__tests__/kind-contract.test.ts` | R2 补:针对性断言 |
| copy 覆盖 | `packages/teamlead/src/bridge/__tests__/alert-kind-copy.test.ts` | R3 补:§9 要求的 `titleFor`/`bodyFor` 覆盖落在这里(文件已存在) |
| correlation 行为 | `packages/teamlead/src/__tests__/AlertChannelHub.test.ts` | R3 补:§4.1 那条「最新 voucher 事件替换先前 ticket thread」的显式断言 |
| runbook | `engineering/doc/FLY-1929-kernel-panic-voucher-leak/runbook.md` | 跟 issue 走 |

## 3. `scripts/flywheel-voucher-guard.sh`

子命令:`tick`(**默认**,launchd 只调它,一个进程内完成扫描+采样+评估)、`sample`、`panic-scan`、`status`、`mark <label>`。

### 3.1 durable state 契约(R2 新增,原方案完全缺失)

60 秒一次性 job 的「连续 3 tick」「episode 闩」全部依赖跨次状态,必须先把状态定死,否则不可测。

单个**带版本号**的状态记录,落在既有 Flywheel state root 下,字段至少:

    schema_version
    generation_id            # R3:抗碰撞的本代身份,见 3.1.1
    initialized_at
    last_valid_sample_ts
    per_level: { warn: {consecutive, latched, episode_seq, delivery, superseded_by_severe},
                 severe: {同(无 superseded 字段)} }
    panic: { seen: {<basename>: {classification, delivery,
                                 size, mtime, scan_offset, parse_complete}}, cursor }

规则:
- **原子发布**:写临时文件 + `mv`,与 NDJSON append / `mark` 共用同一把锁。
- **fsync 的确切含义(R3)**:先 fsync 临时文件 → `rename` → **再 fsync 所在目录**,
  之后才可把新的 generation / episode 序号当作已持久。
- **畸形 state ⇒ fail-loud**,绝不静默重置计数器、绝不静默重新 baseline panic 文件
  (静默重置会让告警永远不触发,是最坏失效)。
- **锁的选型(R2)**:`flock(1)` **不是 macOS 基础契约**,不用它。用 `mkdir` 锁,
  并定义**有界等待**与**陈旧锁回收** —— 一次崩溃不得让后续所有 tick 与手工 `mark` 永久瘫痪。

#### 3.1.1 `generation_id` —— 状态丢失不得复用旧回执(R3 BLOCKER)

R3 抓到的真洞:`episode_seq` 的唯一命名空间就在这个状态文件里。若 `pressure:warn:0` 已经发过,
之后状态被删/重建,新状态会再产出一个 `pressure:warn:0`。而 `lead-alert.sh` 对**已 sent 的回执
不会返回 `duplicate`,它返回 `sent` 且退出码 0**(`scripts/lead-alert.sh:504–508`)⇒
guard 会 arm 闩,而 Discord 上**一条新消息都没有**。这正是 episode 身份本来要防的假接受。
fsync 挡不住这个 —— 它是操作员删除 / state root 重建,不是掉电。

⇒ signature 里加一层代身份:

    pressure : pressure:<generation_id>:<level>:<episode_seq>
    panic    : panic:<report basename>

`generation_id` 抗碰撞、持久化在状态里;状态缺失时**持锁**新建一代,只种入已知的那个 panic basename,
并**显式发一条本地/state 重新初始化的诊断**,不静默重置计数器。**畸形状态仍然 fail-loud。**

**必测**:发一次 pressure episode → **删掉 guard 状态但保留假告警脚本的永久回执** →
再来一次高占用 ⇒ 必须真的产生一条新投递。
假脚本必须镜像真行为:**已 sent 的 event 返回 `sent/0`,而不是笼统的 duplicate**。

#### 3.1.2 初始化必须挂在真实的自动 bootstrap 路径上(R3)

原方案说「安装时的显式初始化事务」,但**没有落点**:`converge_nonlead_daemons()` 安装缺失的
`policy=copy` plist 后会**立刻 bootstrap**(`scripts/lib/converge-nonlead-daemons.sh:985–1054`),
而 `RunAtLoad=true` 又让它立刻跑起来 —— 中间没有任何 initializer 钩子。

⇒ **最小解法(采纳)**:**由第一次 `tick` 自己在扫描之前完成 3.1.1 描述的原子初始化**。
不新增部署钩子、不新增 `init` 子命令、不新增安装器产物。
(若将来确需初始化先于 bootstrap,则必须点名那个部署钩子并把它改动的每个文件加进 §2 清单。)

### 3.2 告警判据(R1 推翻滚动最小值;R2 再调 severe 时效)

    p = bank_task + bank_account 当前值,必须通过格式校验(§1.3 标定的上界代理量)
    warn   : 连续 3 个有效 tick 满足 p >= 157286   (524288 的 30%)
    severe : 连续 2 个有效 tick 满足 p >= 262144   (524288 的 50%)
    解闩    : warn 恢复 p <= 125828 ; severe 恢复 p <= 209715   (精确整数比较,不算浮点百分比)

**R2 更正**:原方案 severe 也要 3 tick。这是错的 —— 一个**校验过的** 50% 读数本身已经极其反常
(**本次会话观测窗口内**的峰值不到 10%;R3:不写成「正常峰值」,一个窗口不代表常态),而我**无法给出增长速率上界**,凭什么在那种读数上再等 2–3 分钟?
改为 severe 只需 2 tick(挡单次毛刺,不再多等)。

其它必须定死的转移(R2):
- **「连续」要有最大时间间隔**:超过 `max_gap`(取 180 秒)的两个样本**不算连续**,计数归零。
  否则主机睡眠 / launchd 跳过会把「两个旧高样本 + 一个新高样本」凑成假的连续 3 次。
- **闩只在投递 `sent` 或 `queued_transient` 之后才 arm**;`duplicate`、空/畸形 stdout、超时、
  结果与退出码不一致 —— 一律保持 pending,下次重试。
- **跨 tick 的 severe 压制(R3 BLOCKER,原方案只定义了「同一 tick」所以有洞)**:
  按原计数器,冷启动高于 severe 的自然行为是 —— tick1 两个计数器都 +1,tick2 发 severe,
  **tick3 warn 计数满了又发一条 warn**。「同 tick 不同时发」根本挡不住这个延迟降级,
  而原计划的冷启动用例还会通过。⇒ 定义 episode 级的跨级压制:
  1. severe 先于 warn 被 accepted ⇒ 该 episode 的 warn 标记 `superseded_by_severe`,
     只要占用量仍在 warn 阈以上(**含**只落回 warn–severe 之间的带),**永不再发** warn;
  2. warn 已经在真实渐进上升中被 accepted 过 ⇒ severe 之后照常可发,保住两级升级;
  3. severe 达标时 warn 只是 pending / 未确认 ⇒ **也压制掉**(更安全,免得旧 warn 在 severe 之后才到);
  4. warn 只有在**满足 warn 的恢复条件之后**才重新有资格开启新 episode。
  **必测**:连续至少 4 个高于 severe 的样本,再给若干落在 warn 与 severe 之间的样本 ⇒
  **severe 之后不得出现 warn**;随后走完整的 warn 恢复再升高 ⇒ warn 能重新 arm。
- **解闩阈值写成整数常量**,不在代码里算浮点百分比。
  **精确比较(R3)**:严格低于 80% ⇒ warn 恢复为 `p <= 125828`,severe 恢复为 `p <= 209715`。
- **`ecosystemanalyticsd` 探测失败不得致盲主信号**(R2 抓到的真矛盾:原方案一边说 daemon 探测失败要
  fail-loud、一边说 daemon 缺失要安全降级)。⇒ 只有**占用量本身**读取失败才阻断判定;
  daemon 元数据读不到就记 null / degraded 并继续。

### 3.3 采样与留痕

- 间隔 60 秒。理由是**开销有界 + 趋势分辨率**(不是「60 秒必能抓到每个地板」——那没有证据)。
- NDJSON:`~/Library/Logs/flywheel/voucher-guard.ndjson`。
  字段:`ts / bank_task / bank_account / ipc_vouchers / ipc_spaces / nproc / ead_count / ead_pid / ead_start / ead_age_s`
  **R3**:实例可能重叠(本次新旧重叠约 27 秒),所以加 `ead_count`,并定死选择规则 ——
  `ead_pid`/`ead_start` 取**启动最早**的那个实例;`ead_count > 1` 时该事实本身进 NDJSON。
- **R2:删除 `floor_30m`。**它已不驱动任何动作,原始 NDJSON 足以事后离线算出来,
  在线维护它反而要额外的滚动窗口状态或反复读日志。按「删的比加的多」,这是该砍的残留。
- **轮转**:双阈值滞回 —— 超过 24000 行才轮转到 20000 行,写临时文件 + `mv`,持锁。
  不做「每分钟 tail+覆写」。
- `ead_age_s` 是**代理指标**,当前占用量才是主测风险信号。

### 3.4 `panic-scan`(R2 大改:初始化不能吞事件,分类不能抢跑)

- **范围收窄**:只有 `panicString` 含 `Cannot grow ipc space beyond IVAC_ENTRIES_MAX` 的报告才算命中。
  其它 panic 进 `status` 输出但不告警。
- **判「新」用 marker 记文件名**,绝不比时间戳(本次实测 01:35:28 panic、07:09 落盘,迟 5h34m)。
- **R2 更正 —— 取消「首跑静默 baseline 一切」**。那会吞掉「部署完成到第一次 launchd 触发之间落地的真复发」,
  state 被删/损坏后更会一次性放过所有积压报告。改为:
  - 由 **第一次 `tick` 在持锁的初始化事务**(§3.1.2,**没有**安装期钩子)里,
    **只**把已知的 `panic-full-2026-08-20-070924.0002.panic` 这个确切 basename 种进 marker;
    **状态确实缺失**(新建一代 + 只种这一个 basename)与 **状态畸形**(fail-loud)必须分开处理;
  - 生产环境里遇到**未初始化**的 state,对已存在的 voucher panic **照常告警**(宁可多报一次,不可吞掉复发)。
- **分类不能抢跑**:未验证 DiagnosticReports 的发布是否原子。⇒ 记录「非命中」这个**永久分类**之前,
  必须先确认是**常规文件、非 symlink**,且**跨 tick 大小稳定**。
- **「稳定」还不够 —— 必须证明真的读到了(R3 BLOCKER)**:大小稳定只证明文件不再变,
  **不证明扫描器读到了含 `panicString` 的那段字节**。若字节预算在到达该字段之前就用完,
  却把它永久记成 `non_voucher`,**恰好会漏掉验收唯一在乎的那次复发**。
  ⇒ 只有满足下列之一才可永久判为非命中:
  1. 一个有界的、懂格式的解析器**完整读完了 `panicString` 的第一个逻辑行/值**(panic 原因就在那里);或
  2. 一次**可续扫**跨 tick 读到了 **EOF**。
  撞到每 tick 字节上限 ⇒ 该报告保持 `pending`,并把 `size / mtime / scan_offset / parse_complete`
  写进状态以便公平续扫(字段已加进 §3.1)。
  **跨块边界必须显式处理(R4)**:朴素的「每块各自做一次字符串查找」会在目标字面量**横跨两个块**时
  一路读到 EOF 然后把报告永久判成非命中。⇒ 要么**携带 matcher/parser 状态跨块**,
  要么让相邻块**重叠足够长度**;并且 `size` 或 `mtime` 一变就**重置续扫进度**。
  夹具里要加一条**目标字面量恰好被块边界劈开**的用例 ——
  「`panicString` 被上限截断」那条接近但**没有**明确断言这个劈开情形。
  **必测夹具**:目标字符串落在第一个 tick 字节预算**之外**;`panicString` 字段恰好被预算**截断**;
  以及**初次观测稳定之后文件又变了**。
  (本次那份报告的关键短语恰好靠前,但一个样本不构成格式契约。)
- **有界**:每 tick 限制读取字节数与处理报告数,留**公平 backlog 游标**;
  **panic-scan 的失败或积压绝不能阻断同一 tick 的占用量采样**(否则「有界 tick」只是句口号:
  每多一份报告就多一次最长 15 秒的 `lead-alert.sh` 调用)。

### 3.5 `mark <label>`(R1 削到最小,R2 认可)

Tadashi 的明确指示(Cass 手工 attach 20 个 pane 把计数从约 2300 抬到 10906,实测每 attach client 约 +430;
这正是污染我自己一次速率读数的原因)。只做一件事:往 NDJSON 追加 `{"ts":…,"kind":"mark","label":…}`。
**不**配对语法、**不**自动剔除区间、**不**参与任何告警判据。label 必须 JSON 转义 + 限长,共用同一把写锁。

### 3.7 launchd / manifest —— **一条精确契约**(R5 建议:原先这些事实散落各处甚至只是隐含)

    plist 形态     : 照 scripts/launchd/com.flywheel.bridge-liveness-probe.plist
                     (R1 更正:不是 codex-log-guard —— 那个是 StartCalendarInterval 每天一次、
                      无跨次状态、只调 meta-alert.sh,形态不对)
    Label          : com.flywheel.voucher-guard
    StartInterval  : 60
    RunAtLoad      : true          # 开机/bootstrap 后立刻建状态并扫一次,不白等 60 秒
    ProgramArguments: 只调默认子命令 tick(一个进程内完成 panic-scan + sample + 评估)
    单次执行超时上界: 45 秒(硬性;超时即放弃本 tick 并留 pending,不得挂住下一次 StartInterval)
                      —— 需有一条真正触发超时的测试,不能只写在文档里
    ecosystemanalyticsd 缺失/重启中: 安全降级(记 null/degraded 继续),不得崩、不得致盲占用量判定
    manifest 行    : policy=copy, allowed_exit_codes=0
    权威           : 仓库 checked-in 的 plist 字节即权威,不得手改已安装副本

**不新增安装器**:`policy=copy` 让既有的 non-Lead convergence 路径
(`converge_nonlead_daemons()`,`scripts/lib/converge-nonlead-daemons.sh:985–1054`)
原子安装一个此前不存在的 plist 并 bootstrap 它。
(R1 更正:`install-log-janitor.sh` **不能整段照抄** —— 它在 `scripts/launchd` 之外渲染 plist、
要 first-apply marker 与已构建的 report CLI、还会改 Claude 的 `cleanupPeriodDays`,都不该进本单。)

**必须同步改** `scripts/__tests__/launchd-units-manifest.test.sh`:已复核它硬编码 approved label 集合
并断言目录↔manifest 的**精确对称差**,新增一行不改它必红。

**不**改成常驻长跑采样器:短 job 更容易被 launchd 恢复,也避免新增一个永久循环的生命周期。

### 3.6 fail-loud

`zprint` 缺列 / 非数字 ⇒ fail-loud 且不写样本,绝不把缺失静默当 0。

## 4. 告警投递语义

### 4.1 kind:**一个**,`host_voucher_incident`

| kind | owner | arc | severity |
|---|---|---|---|
| `host_voucher_incident` | `claude` | `human_by_design` | warning / severe |

**R1 更正**:我原来「一个有 ARC 候选、一个是 human-by-design,所以要两个 kind」的论证是**假的** ——
`arc: "auto"` 的定义是可执行、可回滚、有 bot owner 的补救,而 §6 明确不实现任何补救,所以两者今天都是无补救。

不复用 `swap_pressure_high` / `bridge_abnormal_exit` / `deploy_failed`(语义、owner、copy、恢复行为都不同)。
owner 取 `claude` ⇒ `ticket-owner-map.ts` **不需要**改;若改取 `founder_direct` 则必须同时进 `NO_OWNER_KINDS`。

#### 4.1.1 人可读载荷映射(R5 建议,补上)

signature 不会显示给人看,所以 pressure 与 panic 的区分必须落在 **body** 里:

| 触发 | severity | body 必含 |
|---|---|---|
| pressure warn | `warning` | `source=pressure`、代理量 p 的值、`bank_task`/`bank_account`/`ipc_vouchers` 三个原始数 |
| pressure severe | `severe` | 同上,再加触发阈值与 episode 身份(generation + level + seq) |
| 命中的 panic 报告 | `severe` | `source=panic`、报告 basename、匹配到的 panic 原因原文 |

**R3 必须说清的一句**:`owner: "claude"` 是**治理契约上的归属**,**不等于**这条告警在运行时真的会被派给 Claude。
现在的 shell 直发路径在 ticket 头启用时会渲染成 `owner —`;排队的 shell 记录也不带 ticket 上下文,
`attachDeliveredAlertLifecycles()` 原样转发,所以 drain 出来的 thread 没有 owner/status 种子。
本单**显式接受**「根频道投递 + 既有 legacy thread 行为」,**不**把 issue 扩成告警载荷富化 ——
验收要的是 eng 频道收到,不是自动派单。

**5 个生产面**(R1 更正,我原来数成 3–4 个):shell 校验 case、`ALERT_EVENT_TYPES`、`KIND_CONTRACTS`、
`titleFor()`、`bodyFor()`。第 4、5 是我漏的 —— 已复核这两个是**没有 `default` 的穷尽 switch**,不补则 TS 编译不过。
`severityFor()` 有兜底不需改。`kind-contract.test.ts` 是守卫不是面。

**R2 接受的后果**:`AlertChannelHub.correlationKeyFor()` 按 project/lead/eventType(+可选 session key)聚合,
而 shell 队列记录没有 session key ⇒ 排队中的 warn / severe / panic 三类共用一个 correlation key,
后来的会替换/归档先前的 ticket thread。根频道告警因 event id 不同仍是独立消息,所以这不足以推翻「一个 kind」的决定。
⇒ **显式接受并写成文档 + 一条测试**:「最新的 voucher 事件替换先前的 voucher ticket thread」是可接受行为。

### 4.2 signature 必须是 **guard 自己生成的 episode 身份**(R2 推翻原方案)

**原方案用 `<ead_start>|warn` 当 signature,这是错的,会让「解闩后再报」永远发不出去。**
`lead-alert.sh` 的 eventId = `sha1(project|lead|kind|signature)`,而**投递回执是永久保存的**:
同一个 daemon start 下的第二次 episode 会命中旧回执直接返回,不发新消息 ——
更糟的是 guard 可能把旧回执当成「新 episode 已送达」的证据。
(而且如 §0 所述,daemon start 连唯一身份都不是,新旧实例重叠过 27 秒。)

⇒ 改为 **guard 持久化的「代身份 + 每级 episode 序号」**(R4:补上 generation,原来只写 episode 序号,
与 §3.1.1 冲突;实现者照这一节做就会重新踩回永久回执碰撞):

    pressure : pressure:<generation_id>:<level>:<episode_seq>
    # generation_id 见 §3.1.1:每次「状态确实缺失」的合法重新初始化都会换一代
    # episode_seq 只在该等级真正重新 arm 时递增并落盘
    # 本文件里 signature 的唯一权威定义就是这里,§3.1.1 与此完全一致
    panic    : panic:<report basename>

daemon 身份放进 body 与 telemetry,**不当 episode key**。

> 实现期必须防的一个假绿:测试用的假 `lead-alert.sh` **必须模拟永久去重**。
> 一个「忘记永久回执」的假脚本会让上面这条测试通过、而生产依然坏。

### 4.3 身份与频道

- 用 **`--lead system`**(已复核:`scripts/lead-alert.sh:223` 特判该身份,会从 `~/.flywheel/.env` 载入统一频道与 token)。
  `deploy` / `updater` **没有**被特判,它们能工作是因为父进程本来就带路由配置;
  从干净的 launchd 环境里用它们会拿到 unknown-lead / config error。
- 验收要求「eng channel」。**「用了 lead-alert.sh」不算验证过频道**:runbook 必须写明确切频道路由,
  且安装后做一次**真投递 preflight**(§8)。

### 4.4 投递结果的判读与终态(R2 大改)

按 **stdout 那一行 + 退出码一起**判,并且**要求恰好一行已知结果**。
**R3:结果矩阵精确到「值/退出码」对**(真契约是 5 个具名 stdout 值,原方案笼统写「六种」不准确):

| 结果 / 退出码 | 处置 |
|---|---|
| `sent` / 0 | **accepted**:marker 前进 / 闩 arm |
| `queued_transient` / 2(退出码是 2,但已持久入队) | **accepted** |
| `duplicate` / 0 | **pending**:视为未确认,下次重试 |
| `dead_lettered` / 2 | **terminal**:进终态保持,停止重试 |
| `config_error` / 1、`config_error` / 2、`config_error` / 3(event-id 失败路径) | **pending + 去抖的本地失败信号**(理由见下) |
| 其它一切(空 stdout / 多行 / 未知值 / 超时 / 值与退出码不匹配) | **pending**:重试 |

**R2 关键更正 —— `config_error` 不能当终态**:实测源码里它有**两类**且 stdout 分不出来 ——
系统路由缺失/不可读是 **event id 之前**(`lead-alert.sh:223–274`),无频道/无 token 是 **event id 之后**(`:658–668`)。
既然分不出来,对 `--lead system` 这个调用者更安全的策略是:**`config_error` 保持可重试**(配置修好就自愈),
**只有显式的 `dead_lettered` 才进终态保持**。

**终态的恢复路径**必须写进 runbook,而且要点明:恢复要**同时**清 guard 的终态保持**和**对应的
`alert_deliveries` 回执(或者刻意换一个新的恢复 signature)—— **只清一边不会重投**。

**R3 补一条 runbook 必写的运维事实**:一个**先前已被 accepted 的 `queued_transient`**,
后来仍可能被移进 Bridge 的死信目录。那种情况下重放同样要求「清 guard 的 marker/闩 + 清对应的永久投递回执」。
这不推翻「持久入队即 accepted」的判定,但它是一条**与同步返回 `dead_lettered` 不同**的独立恢复路径。

**`meta-alert.sh` 必须由 guard 自己调**(R2 抓到的洞):`lead-alert.sh` 的系统路由 preflight
发生在它定义/调用 `fire_meta_alert` **之前**,所以那类早期 `config_error` 根本没有 meta-alert 兜底。
⇒ guard 在投递降级时自己去抖地调一次 `meta-alert.sh`。但它**永远不能算作**「eng channel 已送达」的证据
(它总是 exit 0、best-effort)。

### 4.5 文件系统契约(R2 补全)

原子 `mv` 只是其中一条。还要定义:常规文件/symlink 校验、目录与文件权限(私有)、磁盘满行为、临时文件清理、
以及 state/marker 在被当作持久之前是否 fsync。两条方向性规则:
- NDJSON append 失败**不得**阻止一条已经校验过的高占用告警;
- 反过来,episode 状态**没能持久化**就**不得** arm 闩(否则丢掉重试)。

## 5. 实施顺序(TDD)

0. **标定门 —— 已完成,结论=分支 A(R5)。**§1.3 记录了方法、720 个样本的实测关系与定稿分子
   (`bank_task + bank_account`,已证明的上界)。**因此本计划不再带任何 A/B 条件分支**:
   下面的压力判据、RED 用例、§9 门、§10 的提前预警行**全部无条件生效**。
   (若将来有人推翻 §1.3 的夹逼,才需要重新引入分支;那属于新一轮设计,不是本计划的隐含状态。)
1. **RED** — `scripts/__tests__/voucher-guard.test.sh`,纯 Bash,注入假 `zprint`、假进程探测、
   假 DiagnosticReports、**会模拟永久去重的**假 `lead-alert.sh`、注入时钟、独立 state/日志根。
   **必须是按时间顺序的多次真实调用**,不能用批式 fixture(会掩盖暖机行为)。用例:
   - 冷启动首 tick;单个高尖峰 ⇒ 不告警;持续高 ⇒ warn 第 3 tick 一次、后续不重复;
   - **冷启动直接跳到 severe 之上 ⇒ 只发 severe,不同时发 warn**;
   - warn→severe 渐进升级 ⇒ 两级都发出去;
   - 解闩后再次升高 ⇒ **能再发一次**(验 episode_seq 递增,且假脚本的永久去重没挡住);
   - 超过 `max_gap` 的间隔 ⇒ 连续计数归零(主机睡眠 / launchd 跳过);
   - `ead_pid` / `ead_start` 变化;**daemon 探测失败但占用量正常 ⇒ 仍然判定并告警**;
   - 畸形 `zprint` ⇒ fail-loud 不写样本;畸形 state ⇒ fail-loud 不静默重置;
   - **§4.4 那张「值/退出码」矩阵的每一行**各自的 state 后置条件(含空 stdout / 多行 / 未知 / 超时 / 值与退出码不匹配);
   - `dead_lettered` ⇒ 终态保持不再重试;`config_error` ⇒ 仍重试 + 去抖 meta-alert;
   - `panic-scan`:命中 voucher panic ⇒ 告警一次、再跑不重复;**非** voucher panic ⇒ 不告警;
     未初始化 state + 已存在 voucher panic ⇒ **照常告警**(不吞);
     一次扫描多份 + 中途投递失败 ⇒ 已成功的不丢;正在写入/不稳定的报告 ⇒ **不**永久分类;
     panic 积压 ⇒ **不阻断**同 tick 的占用量采样;
   - 轮转滞回;并发调用与陈旧锁回收(崩溃后不得永久瘫痪)。
   - **崩溃时序(R5)**:新分配的 pending generation/episode 身份必须**在调用 `lead-alert.sh` 之前**先持久化;
     重试必须**复用同一个身份**;「已 accepted 状态写失败」也必须用同一个身份重试
     (否则一次崩溃就会换身份,又变成一条谁也没收到的新告警)。
   - **锁的归属(R5)**:`mkdir` 锁在陈旧回收之后,**只有当前持锁的那个 owner token 才可以删它** ——
     否则两个进程会互相删对方的锁。
2. **GREEN** — 实现脚本。
3. 新 kind 的 5 个面 + `kind-contract.test.ts` 针对性断言 + §4.1 那条 correlation 行为的测试。
4. plist + `units.manifest` 一行 + `launchd-units-manifest.test.sh` 同步
   (已复核该测试硬编码 approved label 集合并断言精确对称差,不改必红)。
5. runbook。
6. 门:`plutil -lint`、Bash 3.2、ShellCheck、flag 漂移、全仓 `pnpm lint` + `pnpm -r build`、相关 package 测试。
7. **CI 枚举**:已复核 `ci-shell-suite-enumeration.test.sh` 只发现 `*.test.sh`,
   故文件名取 `voucher-guard.test.sh` 并显式接进 `.github/workflows/ci.yml`
   (原方案的 `test-voucher-guard.sh` 会让整套测试 CI 完全看不见)。

## 6. D4 —— 候选遏制动作:只写 runbook,不写代码,不安装

**措辞更正(R1)**:不叫「真正的解药」,叫**候选遏制动作**。
07:35 那次**自然**重启后持有量从约 5 万掉到 552 且系统正常,这是「持有量确实会被清空」的有用证据,
但**不足以证明**定期/人工的 root kickstart 是安全的,也没有回滚证明。
runbook 必须记录这个不确定性,并要求一次 **founder 批准下的受控试验**。

它是 root 身份的 LaunchDaemon ⇒ 动它要 root + founder 拍板。本单不实现、不安装任何会动它的代码。

### 6.1 关于 FLY-913 部署护栏 —— **我写错过,已更正**

我曾写「护栏会拦这类命令,对苹果守护进程属于误报」。**这是错的。**做了两次受控探针:
- 阴性对照:命令只含针对 `com.apple.*` 的 `launchctl` 变更子命令 ⇒ **没被拦**。
- 阳性对照:同一条命令再加上一个 Flywheel 重启脚本标识 ⇒ **被拦**。
复核 `scripts/hooks/flywheel-restart-guard.py`:P1 要求 `launchctl` + 变更子命令 **并且**
同命令内出现 `com\.flywheel\.` 或 `restart-services|self-ship-restart|update-flywheel`。`com.apple.*` 两者都不匹配。
(第三次独立确认:我给 Codex 的 R2 delta 提示词因为散文里同时出现这两个 token 而被拦。)

⇒ **不能执行它的原因是权限与授权(root + founder),不是仓库护栏。**

## 7. 明确不做

- 不降舰队并发 / 不降 churn(issue 自己写了那是「再来一次」之后的动作)。
- 不合并 FLY-1887(冻死,机理不同)。
- 不上报 Apple(需归因数据支撑;本单产出的时间序列正是将来的材料)。
- 不实现任何自动 root 补救。
- tmux 3.5a → 3.7c 不在本单。仅交叉引用:arm64 tmux/gh 已装在 `/opt/homebrew` 但**未切换**
  (靠 PATH 顺序挡着),切换前必须重验 FLY-1672;该风险已单独报给 Tadashi。

## 8. 风险与已知缺口

1. **本单不能保证今天不再 panic。**监控只让我们看见;真正能阻止的是 §6 那个需要 root 的动作。
   **不能让监控上线被误读成「问题解决了」。**
2. **不给「还剩多久」的数字。**测过的两个速率(约 370/min、约 2198/min)**都不能用**:
   前者只覆盖 5 分钟上升段;后者整段落在 Cass 手工 attach 的扰动窗口内。由它们外推的「4 小时 / 10 小时」作废。
   能说的只有一句:上次是开机后 29.8 小时爆的。**「速率随负载起伏一个数量级」这句也已删除** —— 两个速率估计都已判为无效,它们撑不起这个残留论断(R3)。干净区间要等采样器跑满无扰动窗口。
3. **分子已标定但仍是夹逼的上界,不是等式**(§1.3,R5 已完成):定稿分子 `bank_task + bank_account`
   是**已证明的上界**,不是「就是 ivac 条目数」。夹逼的下界(实测恒等于 `bank_task`)在高占用区
   与上界相差约 2 倍。我们**故意取上界**,因为错误方向不对称:估低=告警太晚(要防的),估高=告警偏早(可接受)。
   残余风险:告警可能比真实危险来得早一些。
4. **阈值 30% / 50% 是策略取值**,不是从源码推出的安全边际。
5. **归因方法有盲区**:断崖法只在持有者死亡瞬间生效;`lsmp` 要 root。
   常驻监控不含 root 采样 ⇒ 若换了持有者,监控只能说「涨了」,点名仍需一次性 root 走查(runbook 写清命令与解析法)。
6. **告警链路自身可能坏**(配置漂移、死信)⇒ §4.4 的终态与恢复路径 + §9 的真投递证据是必须项。

## 9. 完成判据

- 全套按时间顺序的 hermetic 测试(注入时钟 / `zprint` / 进程探测 / **带永久去重的**假告警脚本 / 状态与日志根 / DiagnosticReports)。
- **§4.4 矩阵每一行** + state 后置条件 + episode 重新 arm 真能再发(含「删状态但留永久回执」那一例)。
- 多报告原子 marker + 未初始化 state 不吞事件 + 不稳定文件不永久分类。
- 轮转滞回、并发调用、陈旧锁回收。
- 新 kind 的 5 个面 + `kind-contract` / `alert-kind-copy` 覆盖 + correlation 行为的显式测试。
- `launchd-units-manifest.test.sh`、`plutil -lint`、flag 漂移、Bash 3.2、ShellCheck。
- 新 shell 套件**显式进 CI 枚举**。
- §1.3 的标定走了哪一支必须有证据 —— 已完成:分支 A,720 样本,定稿分子 `bank_task + bank_account`。
- **散落在各节的「必测」必须逐条镜像进本清单(R4)**,避免实现者只满足较短的 §5 列表就跳过硬回归:
  §3.1.1 的「删状态但保留永久回执 ⇒ 必须真产生新投递」、
  §3.2 的「≥4 个高于 severe 的样本 + 随后 warn 带样本 ⇒ severe 之后不得出现 warn,再走完整恢复后 warn 能重新 arm」、
  §3.4 的三条 capped-parser 夹具(目标在首 tick 预算之外 / 字段被上限截断 / **字面量被块边界劈开**)
  以及「初次稳定后文件又变了」。
- **标定门走了哪一支必须有证据**(§5 step 0 的 A/B 分支,不能只写「有结论」)。
- **安装后真机证据**:launchd label 确实加载;从 LaunchAgent 上下文写出过合法样本;
  畸形 `zprint` 确实 fail-loud;**一条受控告警确实到达那个确切的 eng 频道**。

## 10. 验收对照

| issue 验收项 | 满足方式 |
|---|---|
| 泄漏源定位(或排除我方进程) | ✅ 已完成:`ecosystemanalyticsd` 占 95.4%,两条独立证据链;我方进程人均一条 |
| 复发监控就位(panic 报告出现即告警到 eng channel) | §3.4 `panic-scan`(内容匹配)+ §4 `host_voucher_incident` + launchd + 投递语义 + §9 真投递证据 |
| (加值)提前预警 | §3.2 当前占用 + 连续确认 + episode 闩 |
