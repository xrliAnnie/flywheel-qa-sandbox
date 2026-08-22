# FLY-1944 宿主终端链收口 · 第二轮 — 实施计划

Issue: FLY-1944 (https://linear.app/geoforge3d/issue/FLY-1944/宿主终端链-tmux-统一升级-brew-护栏-cmux-守护看门狗并-19501951)
日期: 2026-08-21(R1×9 + R2×6 + R3×5 评审项全采纳。R3 关键修正:token 升级为**版本化载体文法**+全消费者严格解析;五字段收据闭环到 v2 create 路径与判官(经 `_ledger_upsert`,加四→五升级);reap-state 定义严格 schema 且在既有 15s 健康 tick 上推进(守住 ≤60s);A2 显式双证据 contingent(respawn-pane 生效 **且** processTitle 新鲜度);adopt-cap 文件与 deadline 补安全/公平合同)
基于: exploration.md(第二轮)、research.md(第二轮)

## 0. 总览

**一个 correctness PR**(本 run 的 land 只落一个 PR),四个工作面 S1/S2/S3′/S5′ + 全局预算 G。行号基线 `d97bd1173`。

### 0.1 implement 停止门裁决(2026-08-22,覆盖本文 A2 修复段)

两轮 scratch 依次证明 `respawn-pane` rc=0 假绿、cmux 0.61 `new-workspace --command` 静默造空表面;guarded `send` 又会绕过 immutable birth `processTitle`,破坏 C2 出生权威。Lead 因此在 gate `4027acd2-ad8a-4bac-90dd-787278faefee` 裁决:**A2 本 PR 显式定档 report-only,带出生凭据的修复原语拆独立单**。

本裁决覆盖 §1.2/§1.3/§5 中所有 `respawn-dead-view`、create-before-close 与修复 mutation 预算描述:本 PR 只做阳性死形态 `exited|empty|no-pty` 分类(相同 class 两轮 + min-age)、durable `dead-<class>`、精确 founder-visible status 和既有通道去重告警;class 漂移重新观察,任何 cmux generation 均零 create/close/respawn。A2 不标覆盖。其余 S1a/S2/S3′/S5′ 不变。

### 0.2 round-3 生产证据覆盖(2026-08-22)

reviewer 在当前宿主实测约 1/3 managed workspace 没有可解析 birth 载体行(`processTitle=Terminal NN`),同时 receipt/helper/source 均可为活。此证据覆盖本文所有“immutable birth 是普遍硬前提”的旧描述。Lead 对两条 HIGH 与毁灭安全簇的统一裁决为:**birth 只作 corroboration;缺失 = unattributable,绝不授权毁灭动作**。

本轮实现边界:

- private-v2 缺 birth 时沿旧 title/variant transaction 继续 naming + heal;只有 exact birth join 才做 UUID upgrade。
- 判官缺 birth 输出 `receipt-uuid-unattributable` WARN;birth 存在时 receipt UUID mismatch 仍 RED。
- ordinary/private-v2 duplicate close/promotion 因只有单次 screen sample,统一 report-only;receipt/title 收敛保留。
- orphan helper 合并 current workspace inventory 与 birth rows 证明“无人认领”,tmux absence 改为 bounded + message-anchored;两轮观察后只告警,不再从 orphan observer 铸 TERM→KILL authority。已由 confirmed workspace close 产生的 exact ref/UUID/token reap seam 保留。
- heal 复用 exact birth token,避免每次轮换让后续归因失效。
- `cmux-adopt-cap` 为跨 private Lead/ordinary view 的 process-local pass budget:regular non-symlink 单行整数 1..10;文件缺失默认 1,不安全/非法内容禁用 adoption。每个 bootstrap/additive/once pass 清零计数。
- 四→五 receipt CAS 唯一性限定当前 generation;v2 birth guard 在 birth RPC 后重 pin generation;unledgered dismantle 显式捕获 candidate parser status。
- round-5 性能修正:carrier grammar 统一由 `_cmux_carrier_classify` 一次解释整个输入;`workspace_title_candidates`、兼容 command 比对、`stock_workspace_records` 不再按 workspace/variant fork Python。37-row 回归夹具逐入口断言一个 Python process。adopt-cap 只延迟 authority mutation,不跳过既有 Lead heal;失败 adoption 归还 pass slot。

尚未纳入的 non-blocking advisories(在 PR 披露):process census 与 birth join 中仍有独立 parser 副本,需后续 differential corpus/最终收口;全局 action scheduler/deadline 未在本轮补齐,但 destructive duplicate/orphan 自动动作已下线且 adoption 有独立 cap。

红线:
1. **简单优先 / 净删除优先 / 不加新告警层**(本 PR 零新 alert kind;新 daemon/新通知通道禁止)。
2. **只调用/扩展已合入机制,不平行重写**;现行基线已覆盖的项(create 活体验证 `flywheel-cmux-sync.sh:8283-8305`、prepared stall 机制 `:110/:6797`、generation 域内 ledger 唯一性 `:5138-5148`)一行不加。
3. **一切 mutation fail-closed + 有界**:证据不齐/inconclusive/进程表不可信/归属歧义 → 不动手只报;无 committed receipt 的 workspace **永不授权修复**。
4. 空壳判定继承 #907 宽限纪律(连续两次 determinate round + min-age)。
5. **全局预算 G(§5)**:按**逻辑动作**计(一次收编 / 一次修复签发 / 一棵进程树进入 TERM→KILL = 各 1 单位),单位在最终 mutation guard 处预留,预留不到整动作原样推迟;generation/mutator lease 变化即中止且**不推进任何 determinate-round 状态**。

| 工作面 | 内容 |
|---|---|
| S1 | 存量收编(exact UUID join + 只写收据的 CAS,健康+死态都收编)+ dead-view 阳性分类、durable RED、精确标签与告警;自动修复拆独立单 |
| S2 | attach-bearing confirmed close 的 post-close seam(cardinality fence)+ 结构化 reap-state;孤儿 helper 只做两轮 report-only,不铸新信号权威;heal 复用可证 token |
| S3′ | 死 tmux socket 文件 janitor(owner/mode 全查,per-apply 上限;活 server 一律只报) |
| S5′ | `select_live_view_window` 残留 race 修 + 判官接线(dead = 显式 RED)+ 两阶段部署停闸 |
| 砍除 | S4 → follow-up A8;S1e 第二套状态机 → 解散;活 server 自动杀 → 只报;helper 信号转发方案 → 弃(需 real-TTY 证明,选外部闭包) |
| PR-1b | fork/cache 优化(第一轮 plan §6 规格)——**不在本 PR**,显式登记合后另派 |

改动文件:`scripts/flywheel-cmux-sync.sh`、`scripts/lib/cmux-mutator-process-census.sh`、`scripts/flywheel-log-janitor.sh`、**`scripts/flywheel-view-attach.sh` + `scripts/flywheel-lead-attach.sh`**(载体文法 v2:接受 legacy 单参形态或 target+token 双参形态,校验 token 格式,行为不变)、`scripts/test-cmux-sync.sh`、`scripts/__tests__/*`。**零 TS 改动**。

## 1. S1 — 存量收编 + dead-view 修复

### 1.1 S1a 收编 = exact UUID join + 只写收据的 CAS

**现状**:`ensure_v2_lead_workspace:3765` 对 `named+receipt==none` 直接 preserve,13 个存量 Lead 锁在 heal 外(research §2.1);`--verify-sidebar` 的 `rule=v2-receipt` 要求每个 v2 Lead 有 committed receipt → 健康存量不收编则判官永远不绿(R1 项 1)。

**机制**:
- **只读身份 helper(单函数)** `cmux_workspace_identity(ref)`:基于 `cmux --json --id-format both list-workspaces` + `list-pane-surfaces --workspace <ref>`(R2 确认 surface UUID 可得且与持久 panel `id` 相符)+ `session-com.cmuxterm.app.json`,一次返回:当前 generation、workspace ref/UUID、title、**恰一个** terminal surface ref/UUID、载体 kind(canonical helper / legacy 一次性 / 其他)、exact target(socket 路径或 view session 名)——target 取自**唯一**持久父 workspace 的 `processTitle`(注意:processTitle 是父 workspace 字段、是**现时进程证据**,R2 项 1)经严格 shlex 解析。任何一步重复/缺失/解析失败 → 整体 inconclusive。
- **收编条件**(全部成立):identity 完整 ∧ title 与 roster expected-title(v2)/`cmux-<窗名>`(v1)逐字相等 ∧ 载体 kind ∈ {canonical, legacy} ∧ target 与 roster 行 socket / 窗名精确相等 ∧ session-json 文件身份(dev/inode)与 mtime ≤ 10min ∧ 落账前重读 generation/surface UUID 无漂移。
- **收编动作 = 只写收据的 guarded CAS**:写既有 view-ledger 的 committed 五字段行(`committed|<generation>|<ref>|<title>|<workspace UUID>`),**经既有校验封装 `_ledger_upsert`**(不裸调 `_ledger_transaction`——R3 项 2),**零 cmux 调用**。**不用 `_v2_lead_prepare_and_name`**(它会 rename workspace/tab 且带 title 接受门,收编不需要改名:title 已逐字相等)。v1 存量同一 CAS 形态(区别仅 roster 源)。
- **五字段收据不变量闭环(R3 项 2)**:
  ① `_v2_lead_prepare_and_name` 的收据写入段扩展为携带 workspace UUID(create 时 `get_cmux_workspaces_json --id-format both` 已有该值)贯穿 prepared 与 committed 两次写(经 `_ledger_upsert`)——否则**新建** v2 Lead 永远进不了 `respawn-dead-view` 的 UUID 比对;
  ② 存量**四字段** v2 committed 收据:同 generation 下用与收编完全相同的现时 identity 证明做 guarded、计预算的**四→五升级**;歧义 preserve;
  ③ `respawn-dead-view` guard 与 `rule=v2-receipt` 都要求 `ledger_exact_receipt_uuid != __LEGACY__` **且**与现场 workspace UUID 逐字相等(四字段行 = 判官 RED);
  ④ surface UUID 是**两读的 mutation 目标**(guard 内 pin + 签发前重读),不是 ledger 字段。
- 健康与死态都收编;健康路径零 surface mutation(只落账,`rule=v2-receipt` 转绿);死态路径进入 §1.2。
- **节奏**:`sync_additive` 内执行;收编上限走**文件旋钮** `~/.flywheel/state/cmux-adopt-cap`——常驻 watcher 不吃 operator shell 的 env(R2 项 4),放量不需要重启 watcher。**旋钮安全合同(R3 项 5,round-5 澄清)**:必须是当前 uid 所有的 regular 非 symlink 文件、内容为有界整数(1..10);文件缺失 → 1,文件存在但不安全/非法 → 禁用 adoption(heal 不受影响);文件跨部署持久,**阶段 1 开始前显式原子 pin 回 1** 列入部署 runbook;调高 = 审计过的原子替换。计入预算 G。

**TDD**:重名 workspace UUID join 消歧 / join 双成立 → 都不收编 / 多 surface / panel UUID 不符 / json 缺失/超龄/inode 变 / generation 漂移 → preserve;健康收编 = receipt 落账 + mock 断言**零 cmux mutation 调用**;收编后 `rule=v2-receipt` 转绿;**收编后现时漂移**(helper 已被 founder 换成编辑器)→ §1.2 guard 拒绝;**收据闭环组(R3 项 2)**:新建 v2 create 落五字段 / 存量四字段 guarded 升级 / 错 UUID 收据 → guard 拒 + 判官 RED / 四字段行 → 判官 RED / 升级中 crash/lease 丢失 → 无半写。

### 1.2 S1b dead-view 分类 + `respawn-dead-view`(修复边界重跑现时 join,无历史 sidecar)

- **分类(观察侧)**:目标 session/socket 可用 ∧ 目标客户端计数==0 ∧ read-screen 可读 ∧ 非 bare ∧ 非 no-pty ∧ 连续两轮 determinate + min-age(走 #907 既有 `_attach_state_*` 持久重试表,复用其 `rebuild-issued→rebuilt/dead` phase 词汇)。
- **guard(mutation 边界,`_attach_mutation_guard` 新分支 `respawn-dead-view`)**:committed exact receipt(无收据永不授权)∧ **重跑完整现时 UUID join**(§1.1 identity helper)。**身份分工(R4 项 3)**:收据证明的是 generation/ref/title/**workspace UUID** 四类身份;**surface UUID 不在收据里**——它由现时 join 独立取得,并作为 mutation 目标在 guard 内 pin、签发前再读一次(两读一致才动),绝不当历史权威、绝不进 ledger schema。另要求:唯一持久父 workspace 的**现时** `processTitle` 严格解析后仍为 canonical/legacy 载体且 target 精确匹配 roster ∧ 0-client 重证 ∧ 屏幕重读仍非 bare 非 no-pty ∧ 两轮 determinate + min-age。**不与任何历史「收编时快照」比对**——现时重证本身就是授权(R2 项 1 的简化正解);founder 把 surface 换成编辑器后 processTitle 即变 → join 失败 → 拒绝。
- **前置真机证明(与 §1.3 同场)**:scratch workspace 上实测「helper 被替换为活编辑器后 processTitle 多快反映」。**processTitle 新鲜度与 respawn-pane 生效是 A2 的两个并列 contingent 证据(R3 项 4):任一证明不了都走 §1.3 的同一条停下/上报分支**——「dead-view report-only」只描述部分实现的安全运行时行为,**不构成可落地的 A2 达成**,除非 Lead/founder 显式改验收。
- 0-client 语义边界:零客户端只证「无人在看」;guard 的载体重证 + 屏幕重读补齐「不是 founder 的活内容」。founder 手动 attach(clients>0)→ healthy 不动(§8.3)。

**TDD 难例**:活非 tmux 命令 + 0-client → guard 拒(processTitle 现时解析挡);收编后 helper 换编辑器 → 拒;clients=1 → 不动;两轮未满 → 不动;无收据 → 永不授权。

### 1.3 S1c respawn-pane 真机证明 = **落地范围门**(R2 项 2)

**实现第一门 = scratch positive control**(Lead 知会 founder 后执行,qa 前缀 scratch workspace 自建自测自删):真跑 `respawn-pane --workspace <ref> --surface <ref> --command <canonical>`,以回读(客户端计数/屏幕)判生效;同场做 §1.2 的 processTitle 新鲜度实测。

- **证真** → 修复原语单点化:一次签发落 `_attach_state_*` 的 `rebuild-issued`,回读**跨 additive 轮推进**(无内联秒级等待),生效 → `rebuilt`;耗尽(沿用 `_attach_retry_limit`)→ `dead`(显式状态字)。同一 episode 单次签发不重复(persist 表已有 attempts 语义)。
- **任一证据失败(respawn-pane 证伪 或 processTitle 新鲜度不足)** → **停:这不是静默降级**。dead-view/no-pty 的「自动修复」承诺(A2)无法由本 PR 兑现 → 按流程上报 Lead/founder 二选一:(a) 显式修改验收(A2 降为「显式失效标记」,A1 的 explicit-failure 半边仍成立);(b) 本单补一个**先建后拆**替换事务的设计增量(new-surface 无 `--command`,注入需经 send,需要新的事务/回滚设计)再回评审。**验收表 A2 在任一证据缺席时都不许标「已覆盖」**(R2 项 2 + R3 项 4)。
- 修后回读不过不算成功(rc=0 非证据);**终局 `dead` 在 `--verify-sidebar` 中是显式 RED/degraded 结果,不算 green**(判官规则表同步扩展)。

### 1.4 S1e 解散 → 审计优先(R1 项 4,保留)

现行基线已有 verify-at-create(`:8283-8305`)、`PREPARED_STALL_STATE`(`:110/:6797`,tests `test-cmux-sync.sh:6480-6613`)、generation 域内唯一性(`:5138-5148`)。不加第二套状态机。mufasa / codex-infra-bot 无 tab = `codex-tui-cmux` 共享窗载体无源窗时的**正确 roster 行为**(评审 + 本 runner 复核一致);implement 只补回归锚,真实缺口须先举证。

## 2. S2 — close 后回收 seam + 孤儿 helper 树清扫(R2 项 3 收口)

### 2.1 归属与算法(在 plan 定死,不留 implement 选择题)

- **census 谓词**:`cmux_attach_helper_command_matches(cmd)` 严格 argv 形状(basename ∈ 两 helper 脚本 + 位置参数;拒 `bash -c`/子串),同时接受文法 v1 与 v2 两形态。
- **载体文法 v2(R3 项 1,端到端协议)**:
  - 文法:v1 = `<helper> <target>`(legacy,继续接受);v2 = `<helper> <target> <token>`,token = 调用方(watcher)**每次命令签发时**生成的高熵校验格式串(`fwtok1-<32hex>` 之类带版本前缀,格式可校验),builder 在一次事务内**绝不静默重生成**(token 由 caller 传入 builder,同一 create→rename-lag→recovery 事务链复用同一 token,防「重生成 token → raw-title 不再匹配 → 重复建 workspace」)。
  - **单一严格解析器** `managed_view_command_parse` 升级为全量文法权威,`managed_view_command_variants`、raw-title stock 解析、`workspace_title_candidates`、rename-lag recovery/rollback、v2 duplicate 发现、rebuild 目标解析、`--verify-sidebar` **全部改经该解析器**(token 化 raw title 用全串解析归一化,不做变体枚举);tokenless legacy 形态永远被接受。
  - 两个 helper 脚本:接受恰 1 参(v1)或恰 2 参且 token 格式合法(v2),其余拒绝;token 对 helper 行为**无影响**(只是 argv 身份标记)。
  - **收据绑定 = 活链而非存储字段**:五字段收据 workspace UUID → 现时 UUID join → 该 workspace 现时 `processTitle` 的 target+token → 恰一个同 target+token 的 helper PID。close 前把该 token 写进 reap 记录。respawn 换载体时 token 轮换(新签发)。
  - **消费者审计清单**(implement 必须逐一测):`managed_view_command_parse` / `managed_view_command_variants` / raw-title stock parser / `workspace_title_candidates` / rename-lag create→recovery→rollback / v2 duplicate 发现 / rebuild 目标解析 / `--verify-sidebar` / 同 target 双 helper / respawn token 轮换 / legacy 单参载体。
  - *弃选(fence-only 无 token)*:duplicate-loser close(target 存活、workspace 已关)的 helper 与 winner helper argv 完全同形,无 token 不可归属 → 永久泄漏类;故文法成本值得付。
- **存量无 token helper**:只在 **exact cardinality fence** 下动手——close 前:恰一个 managed workspace/ref 映射该 target ∧ 恰一个 helper incarnation 映射该 target;close 证明成功后:该 ref 已消失 ∧ 无其他 managed workspace 认领该 target。任何歧义 → 不动只报。**歧义存量 close 显式落在 A5 的 per-tab 保证之外**(诚实边界 §8.10),最终由 §2.3 孤儿清扫在「target+workspace 全局双缺席」时收走。
- **树策略 = 外部后代闭包 + 严格版本化 reap-state**(helper 信号转发方案弃:需隔离 real-TTY 证明):
  - **schema(版本化,原子写,strict 校验)**:`tree_id` / token(有则)/ target / phase(`term-issued|kill-pending|terminal-hold`)/ TERM 时间戳与 deadline / root tuple / **按深度排序**的后代 tuple 列表 / 有界 attempts。malformed / symlink / 校验失败 → **冻结全部信号**。
  - 铸树:一次 conclusive 进程表快照;恰一个 helper root + 已证 ancestry;拒重复 PID。**尺寸/投递关系不变量(R6 项 2)**:`MAX_TREE_PROCESSES`(含 root,默认 **4**)与 `MAX_TREE_DELIVERIES`(默认 **8**)分立,配置校验强制 `MAX_TREE_DELIVERIES ≥ 2 × MAX_TREE_PROCESSES`(保证无 crash 时每 tuple 有完整 TERM+KILL 容量);**铸态前**判尺寸,超 `MAX_TREE_PROCESSES` → 不铸只报。tests:恰限 / 超一 / 断言「无 crash 的合法树绝不因投递容量不足进 terminal-hold」。crash 重放消耗储备导致提前 tombstone 的窗口,并入 A5 fail-closed 边界表述。
  - 信号:叶先根后;**每次信号前**对存档 tuple 重证(reparent 后仍按存档 tuple 追;tuple 不符 = PID 复用 → 放弃该 PID)。**write-ahead 协议(R4 项 2 + R5 项 2,诚实 at-least-once)**:**每一次物理信号投递前**(含 crash 恢复的重放)先持久化并递增独立的 **delivery 计数** → 重证 tuple → `kill(2)` → 持久化下一 phase。crash 在「已递增未投递」处 = 该槽位视为已消耗(fail-closed);**delivery 计数达每树上限 → 直接转 tombstone 零后续信号**。crash 恢复只重放已记录意图,绝不铸新 episode、绝不重置 attempts/delivery。**不承诺 exactly-once**(文件事务 + POSIX 信号给不出);承诺的是「实际信号投递次数 ≤ 配置上限」——crash-loop 注入测试在「信号已发/phase 未落」边界反复 crash,统计真实 kill 调用次数 ≤ 上限。
  - **terminal-hold 墓碑(R4 项 2)**:attempts 耗尽后,只要存档的 root/token 或任一后代 incarnation 仍 conclusively 在场,reap-state **保留为 tombstone(零信号)**——孤儿发现路径遇 tombstone 覆盖的 incarnation **不铸新树**;GC 仅在 conclusive 全缺席或该 incarnation 确证已终结后。防「有界 episode × 无限重发现 = 全局无界信号」。
  - **节奏(R3 项 3,守住 ≤60s)**:孤儿**发现**留在 60s additive pass;**已签发的 reap 记录在每个既有 15s 健康 tick 上推进**(TERM→重证→KILL→缺席验证,全程零新 timer),TERM 后下一 tick 即可 KILL,余量充足。
  - **fail-closed 边界(写进验收)**:进程表 inconclusive 或 watcher 不健康 = 零信号 = **该窗口内无 A5 墙钟保证**。

### 2.2 统一 post-close seam(全位点)

`close_workspace_by_ref:2019` + 5 个 guarded 直调位点(`:1625/:3756/:6088/:6190/:6237`)全部路由到单一 seam(close 成功证明后调用;失败/GUARD_BLOCKED → 不回收)。close **前**采集 helper incarnation + cardinality fence 判定;TERM→KILL 跨 pass(reap-state 驱动),无内联等待;树进入流程 = 预算 G 的 1 单位(**按树计,不按 PID**,R2 项 5)。

### 2.3 孤儿清扫

挂 `sync_additive`:helper census → target 与对应 workspace 双缺席 + 连续两轮 → 进入 §2.1 树流程;每 pass 受 reap 预算(树数)约束。任一存在 → 合法等待。

**TDD**:真 helper + 真阻塞 `tmux attach` 子进程 → 树归零;**抗 TERM 子进程在真实 15s tick 推进下 ≤60s 收敛(实测计时,R3 项 3)**;PID/incarnation 复用 → 放弃;reparent 后按快照 tuple 仍收;双 workspace 同 target(歧义)→ 零信号只报;6 个 close 位点 seam 路由断言;token 载体精确归属 + duplicate-loser 场景 token 消歧;malformed/symlink reap-state → 冻结信号;每树后代超上限 → 只报;**write-ahead 各持久化边界注入 crash → 重放不铸新 episode 不重置 attempts;抗 TERM+KILL 进程跨多个 additive pass → tombstone 后零新增信号、零替换树**;无关 Codex daemon 全程零信号;dry-run 零信号;进程表 rc=2 零动作。文法消费者审计清单(§2.1)逐项用例。
**验收口径**:token/fence 成立的 close = per-PID 树前后 census 归零 ≤60s;歧义存量 = 孤儿路径最终收敛(全量 teardown 断言),A5 表述随此拆分。

## 3. S3′ — 死 socket 文件 janitor(R2 项 6 收口)

`flywheel-log-janitor.sh` 新模块 `tmux_dead_sockets`:

- **只删死文件;活 server / 一切 unknown 只报**。
- 删除链(全部成立):目录 `lstat` 证明 = 当前 uid 所有 ∧ 真目录 ∧ 非 group/world-writable;socket `lstat` 证明 = 当前 uid 所有 ∧ S_ISSOCK ∧ 非 symlink;不在 allowlist(`default`/`atlas`)∧ mtime>1h ∧ 有界探活(`bounded-run` 包 `tmux -S <sock> list-sessions`)返回**可理解的死结果**(超时/权限错 = inconclusive → 只报)∧ `lsof` **conclusive** 证明无持有者(lsof 自身错误 = inconclusive → 只报)∧ unlink 前以 `(dev,inode,mtime)` pin re-stat 重证。canonicalization/stat 任何错误 → 只报。
- **per-apply 删除上限**:validated config,默认 25/次;超出滚入下一日拍(101 存量 ≈ 4 天收敛)。
- **scope 绑定**:生效 root、uid、min-age、probe timeout、allowlist、delete cap 全部写入 `dry_run_scope_json`(非编译期常量的都绑)。
- 排产 apply 前:**部署字节 full-scope dry-run**(module-only 不算 `full-dry-run-ok`,FLY-1330 既有合同)。

**TDD**:owner 不符 / group-writable 目录 / symlink / S_ISSOCK 失败 / probe timeout / lsof error / 有持有者 / re-stat 漂移 → 全部只报;cap 截断滚动;allowlist 永不碰;dry-run 零 mutation。真机段:101 死文件 full-scope dry-run 报告。

## 4. S5′ — race 修 + 判官 + 两阶段部署停闸(R2 项 4 收口)

1. **race 修**:`select_live_view_window` 改走 `window_source_pane_alive`;implement 先 re-audit 现行树只修真实残留位点(`refresh_linked_sessions` legacy 环已被 #907 移除,评审确认)。
2. **判官**:`--verify-sidebar` 为唯一判官;新增规则:收编完成度(`v2-receipt` 覆盖)与 dead-view 终局(`dead` = 显式 RED/degraded,**不算 green**)。
3. **两阶段部署停闸**(FLY-1959 现实:平常班车波先部署字节并重启 watcher——canary 不可能发生在部署前):
   - **阶段 1(canary)**:波前 runbook 步骤 = **原子 pin adopt-cap 文件回 1**(§1.1 旋钮合同;文件跨部署持久,不 pin 则上次放量值残留)→ 班车波 N 部署本 PR → 新 watcher 起 → 收编第一个 Lead → `--verify-sidebar --target <该 Lead>` **定向绿** + 观察一个 soak 期;绿后经审计过的原子替换放量(建议 3/pass),全舰收编收敛(13 Lead × 1-3/pass ≈ 5-13 分钟)后 **全局双快照绿**。
   - **阶段 2(考题)**:收敛后的**下一个平常班车波**须在 ≤5min 内回到全局双快照绿 + founder 零手工零空白;**绿才授权 W2 运维窗口;不绿即停**排查,不拿 founder-gated 全 server 重启当实验。
   - 不发明 watcher-only 部署载体;若运维想提前单独重启 watcher,用既有 FLY-1482 lease-handoff 工具(`--recover` 族),须 founder/Lead 授权,plan 不新造。

## 5. 全局预算 G(R2 项 5 收口)

- 计量单位 = **逻辑 authority 动作**:一次收编 CAS(含四→五升级)/ 一次 `respawn-dead-view`(或 no-pty respawn)签发 / 一棵树进入 TERM→KILL = 各 1;伴生只读/回读/状态 RPC 不计、不拆分动作。
- 预留制:动作开始前在最终 mutation guard 处预留单位;预留后立刻重证 generation+lease;预留不到 → 整动作原样推迟(状态在持久表,天然可续)。
- 默认/上限(validated):mutation 预算默认 3(上限 10)、reap 预算默认 5 **棵树**(上限 10)。
- **deadline 与成本模型(R3 项 5 + R4 项 1)**:硬墙钟只约束**新的 S1/S2 动作调度器**,单调钟从调度器入口起算;命名 `FLYWHEEL_CMUX_ACTION_SCHED_DEADLINE_SECONDS`,默认 **30s**(validated 10..60)。**关键:不能拿全局 `CMUX_CALL_TIMEOUT_SECONDS=20` 当单调用最坏值做准入算术**(那样一次调用就吃满 deadline,所有多调用动作被永久推迟——R4 抓出的结构性饿死)。新证明类只读 RPC(list-workspaces / list-pane-surfaces / read-screen 等)在调度器内走**独立的短超时** `T_proof`(默认 5s,validated 2..20,永不放宽全局值);调度器内 **mutation 显式独立上界** `T_mut`(默认 5s,validated ≤ 全局 20s)——**`T_proof`/`T_mut` 必须贯通到最终 guard 内部的每一个嵌套 RPC**(保持「guard 是 spawn 前最后一步」不变量,不能只包外层)。**成本用公式不用定数(R5 项 1 + R6 项 1)**:`T_proof`/`T_mut` 是**命令阶段超时**(command-phase timeout;R7 术语澄清),单调用的**总墙钟配额** = `T + grace`(`_cmux_bounded_spawn` 超时路径 = T + TERM + `CMUX_TIMEOUT_KILL_GRACE_SECONDS`(现 1s)+ KILL + 清理),另加固定 overhead 余量常量(spawn/JSON/记账,默认 1s/动作)。每动作最坏耗时 = `(最大证明调用数 × (T_proof+grace)) + (mutation ? (T_mut+grace) : 0) + overhead`;最大调用数按分支最坏枚举写进代码常量并被 tests 锚定(收编 CAS = 4 证明;四→五升级 = 4 证明;respawn 签发 = 3 证明 + 1 mutation)。默认值自检:4×6+1=25s、3×6+6+1=25s ≤ 30s ✓。**T_proof=20 × deadline=60 不是合法启用组合**(4 证明 ≥ 84s)——关系校验必须把它判为非法 → 回落安全默认组或禁用该动作并上报,tests 断言这个 fallback 真发生。`T_mut` 有显式正整数下界(≥2);校验作用在**生效后的 tuple**(post-validation)而非原始输入。**准入规则**:mutation 动作仅当其公式最坏值 ≤ 剩余 deadline 才开始;只读推进可 clamp 到 `remaining - grace`。tests:min/default/max 配置三角 + 非法组合 fallback。**工作序**:①推进已签发 reap 记录(15s tick 与 additive 皆然)→ ②收编/修复公平分配(重复被推迟者优先,防饥饿)。tests:每个调用边界超时 / 阈值上下准入 / 连续推迟下的公平性。这是 scoped correctness 调度器,不改全局 cmux 超时,也不是被顺延的 PR-1b 优化。
- generation/lease 丢失:不 mutate、**不推进 determinate-round 计数**。
- 日志:episode 化 transition-only(继承 `_alert_cmux_cleanup` latch 形态)。

## 6. 测试与 QA 策略

- 机制层:`test-cmux-sync.sh` mock harness 扩展(§1/§2/§4 RED→GREEN + 全部阳性保护难例);census/janitor 各自 hermetic harness;真 tmux 一律隔离 socket(mktemp+trap,不给 tmux-501 添残骸)。
- 全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 相关 `scripts/__tests__/*`;宿主全量 vitest 不当验收门。
- 真机段(implement/QA,顺序在前):
  (a) **scratch positive control = 实现与落地范围门**(§1.3;含 processTitle 新鲜度实测;Lead 知会 founder);
  (b) 部署后阶段 1 canary 观察(只读 + 定向判官);
  (c) janitor full-scope dry-run(101 死文件)。
- 难例必真跑:healthy 永不动 / founder 手动 attach 不修 / 活非 tmux 命令 + 0-client guard 拒 / 收编后载体漂移拒 / 双 workspace 同 target 零信号 / rc=2 零动作 / PID 复用放弃 / Codex daemon 零信号。

## 7. 部署与运维顺序

§4.3 两阶段停闸;W2 窗口在阶段 2 绿后(工装已 ship);W5 维持 17:03Z 裁决不因本 PR 关单。

## 8. 风险与诚实边界

| # | 边界 | 处置 |
|---|---|---|
| 1 | respawn-pane 与 create-time command 两种修复原语均已证伪 ⇒ **A2 不由本 PR 兑现** | §0.1 显式 report-only;修复原语独立单 |
| 2 | processTitle 只可作出生权威,不可作现时内容证据;guarded send 会破坏该权威 | §0.1 禁止 send 替代;阳性死态只报 |
| 3 | session-json mtime>10min ⇒ 收编停摆(preserve 现状);判官 `v2-receipt` 持续红可见 | follow-up 观察 |
| 4 | clients 计数 session 级:founder 手动 attach 时死 surface 判 healthy 漏修 | 接受(founder 在场景) |
| 5 | 「任意重启波零空白」真机端到端只能真实波验;QA 交付机制证据,真机 = 两阶段停闸观察 | §4.3;founder HTML 明示 |
| 6 | **PR-1b 第二次顺延**(规格在第一轮 plan §6,git 历史同路径) | PR body + founder HTML + 里程碑三处登记 |
| 7 | 活孤儿 tmux server(~36 未归属)只报不杀 | janitor 报告可见;要自动挡另立 issue |
| 8 | S4 砍单:A8 侧栏标记缺席(告警通道仍在) | follow-up(需 durable episode 状态 + Store/API,独立产品改动) |
| 9 | mufasa/codex-infra-bot 无 tab = 正确 roster 行为;headless Codex Lead 可见 tab 是新需求 | 另立 issue;founder HTML 写明 |
| 10 | **歧义存量 close 在 A5 per-tab 保证之外**(cardinality fence 不成立时只报),由孤儿清扫最终收敛 | §2.1;验收表 A5 拆分表述 |
| 11 | Codex runner brew 护栏缺口(W3 遗留)不动 | 维持第一轮登记 |

## 9. 开放问题(带给 design review / Lead)

1. PR-1b 顺延登记方式是否认可(§8.6)。
2. 放量判据:canary 定向绿 + soak 多久(建议一个班车周期)后调 adopt-cap 至 3。
3. ~~respawn-pane 证伪后的分支选择~~ → 已由 §0.1 停止门裁决:本 PR report-only,修复原语拆单。

## 10. 验收总表

| 条款 | 本 PR 落点 | 验收方式 |
|---|---|---|
| A1 重启波全 tab 自动恢复或显式失效+重建 | S1a 收编 + S1b/S1c 修复(或显式失效)+ S5′ 停闸 | 机制 RED→GREEN;真机 = 两阶段停闸 |
| A2 app 存活期 surface 空掉自愈 | **本 PR 不覆盖**;阳性死态仅 durable `dead-<class>` + 精确标签 + 去重告警,修复原语拆独立单 | 两轮 scratch 反证 + 三类 report-only 零 mutation 用例 |
| A3 新生空壳 | §1.4 现行 verify-at-create 已覆盖,补回归锚 | 回归用例 |
| A4 复活体无镜像补建 | 已覆盖(#912 sync_additive) | 回归用例 |
| A5 close 后进程树归零 ≤60s | S2;**token/fence 位点 per-tab 保证;歧义存量走孤儿路径收敛**(§8.10);fail-closed 边界 = **census inconclusive / watcher 不健康 / crash-replay 耗尽 delivery 储备**三类窗口内无墙钟保证(恢复后的 watcher 保留 terminal tombstone 不续发信号) | per-PID 树 census(含抗 TERM 子进程 15s 推进实测)+ 全量 teardown 断言 |
| A6 孤儿 socket 回收 | S3′(死文件,cap 滚动;活 server 只报) | janitor 用例 + full-scope dry-run |
| A7 空壳判定宽限 | 红线 4 贯穿 | 高负载慢渲染用例 |
| A8 TUI 失败侧栏标记 | 砍单 → follow-up(§8.8) | n/a |
