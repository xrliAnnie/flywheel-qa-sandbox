# FLY-1716 Lead context 墙泄压 — 实施计划

Issue: FLY-1716 (https://linear.app/geoforge3d/issue/FLY-1716/投递撞-context-墙无泄压-lead-会话满-context-时投递永远进不去队列冻死今晚-cass-47-条-25h)
日期: 2026-08-14
基于: research.md
版本: r10(r6 = Codex 六轮 APPROVED 的全量版;r7 = founder 逐刀批注重构 scope;r8 = 吸收 Codex R7 全 4 项;r9 = 吸收 R8 全 3 项;r10 = 吸收 R9 唯一项:winner/rollout 绑定 model tier,200k window 值不得泄漏到 1M)

## 0. Scope 裁决(founder 原话,2026-08-14)

1. 刀 A:「不需要做A,我们用那个 Auto Compact 就可以了,不要自己加这些东西」→ **零自研压缩/泄压层**;只允许 ①删除条件有效但不可作为保证的 test override(`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`)②用原生 settings/env 让 Claude Code 内部 auto-compact 真正生效。
2. 刀 B:「B需要做的,但我不知道它是先打开再 compact 还是怎么样」→ 保留,实现形态在本设计定死(见 §2 引言的选型回答)。
3. 刀 C:「C这个东西已经做完了吧?」→ Lead 裁决(6928994d):**移出本单 scope**;design 阶段只核实 FLY-1764 后同类 fleet-alert 是否仍会对同一 Lead 重复投递(核实结论见 §5:已覆盖,C 不做)。

## 1. 目标与非目标

**目标**

1. **B(硬验收,最高优先)**:重启出来一定不满 —— resume 前三态闸门(只有**可证明**安全才 resume,`unsafe`/`unknown` 一律 park→fresh)+ `/clear` 换代回写 session-id(launch-generation fence + 共享 authority lock)。
2. **A(原生-only)**:①删除 test override `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`(条件有效但不可作为保证,research §2/§3.1 实证)②原生配置实验矩阵钉死「能否让内部 auto-compact 在 70–80% 区间真执行」,能 → 经 plan 修订轮采纳该配置;不能 → A 终态 = 删 override + 证据落档,平时防线的缺位进「残余风险」明示(§4)。
3. **C(移出 scope)**:核实结论落 design 报告(§5),无交付物。

**非目标(红线)**

- **不自建任何压缩/泄压管线**(founder 裁决):无 ctx 巡逻 rider、无 /compact //clear 自动注入、无 pane classifier 新 kind、无新告警 kind。r6 版外部泄压设计整体移出,存档为附录 A(founder 显式选装项)。
- 不碰 mailbox 投递循环 / `loop_owner` / 状态机(FLY-1708 红线);不修改 adopt-inflight SQL 语义。
- 不回退 FLY-1764;不做 collapse_key 塌缩;不动 statusline。
- FLY-1706(Lead 注入 compact 的 recovery 动作)不吸收,另案。

## 2. B:重启出来一定不满(刀 B,Codex 六轮打磨机械保留)

**选型回答(founder 的「先打开再 compact 还是怎么样」)**:不是「先打开再 compact」——满会话 resume 后再 compact 已被实证走不通(8-12 Cass 实录 `Compaction failed · conversation could not be reduced below the context limit`,且内部有失败断路器)。选型 = **超阈就不 resume**:检测在 resume **之前**做(离线读上一会话 transcript),超阈直接 park 留档、走 fresh 分支干净起,靠 memory + bootstrap + adopt-inflight(FLY-1708/1751 现成机制)无损接续在途批。零自建压缩。

### 2.1 会话 context 占用读取器(三态,可证明上界)

**新文件** `packages/teamlead/scripts/lib/session-ctx-usage.mjs`(node,无外部依赖):

- 输入:`--transcript <path> --window <tokens>`(window 由 launcher 传入,来自 canonical model resolver;读取器不自行猜 model)。输出单行 JSON `{"verdict":"safe_resume|unsafe|unknown","estTokens":...,"base":...,"tailBytes":...,"window":...,"reason":"..."}`,恒 exit 0。
- **占用上界**:`base = 末条真实 assistant 行(model != "<synthetic>",usage 和 > 0)的 input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`(该轮输出同样进入下一轮 context,且不在尾部字节里);`tailUpper = 该行之后尾部字节数 × 1 token/byte`(UTF-8 下每 token ≥1 字节,可证明上界,非经验均值)。`estTokens = base + tailUpper`。
- 阈值比较用**整数交叉乘法**:`estTokens * 100 >= threshold * window` → unsafe;无浮点/舍入参与 authority 判定。
- 三态:未越阈 → `safe_resume`;越阈 → `unsafe`;文件缺失/解析失败/预算(128MB 或 30s)耗尽/window 缺失/任何异常 → `unknown`。**unknown 按 park 处理**(硬保证的必要条件;unknown 各形态本身即僵尸征兆或 resume 注定失败)。
- **明示 tradeoff**:1:1 尾部上界会把「末条回复后紧跟大 tool-result 的健康会话」保守判成 unsafe → park;代价 = fresh+bootstrap+adopt(与 /clear 接力等价),换取 `safe_resume` 可证明性;gate receipt 留证观察误杀率。
- 测试矩阵:①正常(safe)②尾部 synthetic 堆(unsafe)③全 synthetic(unknown)④文件缺失(unknown)⑤1M window ⑥损坏行跳过 ⑦跨 4MB 块边界 ⑧预算耗尽 ⑨路径空格/Unicode/symlink ⑩高 output_tokens 反例 ⑪1-byte/token 对抗尾部反例 ⑫恰好跨阈值整数边界。

### 2.2 launcher 闸门

**改** `packages/teamlead/scripts/claude-lead.sh` resume 判定处(现 `:3090-3115` 一带):

- **model/window resolution 提前**:把 `_launch_claude` 内 canonical model 解析(现 `:1646-1727`)抽出,闸门与 launch **共用同一次 decision**;window = resolved model 含 `[1m]` → 1,000,000,否则 200,000。transcript 内的 model 字符串不参与判定。
- transcript 路径推导:`CLAUDE_CONFIG_DIR`-aware 的 Claude project-slug 规则(新写 helper + 单测,fixture 锚定本机真实目录名)。推导失败 → unknown。
- 判定与副作用在 **per-Lead authority lock 内**执行(与 hook 共享同一把锁,见 2.3):锁内轮换 gen → 重读 session-id 文件 → 调读取器 → `verdict != safe_resume` 时 `mv` park(`.parked-<verdict>-ctx<pct|na>pct-<ts>`)→ `_v2_is_resume=false`(落 fresh:`send_bootstrap` + `_adopt_inflight_before_launch` 天然执行)。
- **独立 launch-gate receipt**:`~/.flywheel/state/lead-launch-gate/<project>-<lead>.json` 原子写 `{verdict,estTokens,base,tailBytes,window,reason,sessionId,gen,ts,action:"parked|resumed"}`,旧值 append `.history`(不复用 `lead-body-receipt.sh` —— 它是退出后写的 exit receipt,同文件覆盖)。
- 逃生口:`FLYWHEEL_LEAD_CTX_RESUME_GATE=0` 跳过(receipt 记 `gate=disabled`);阈值 `FLYWHEEL_LEAD_CTX_RESUME_MAX` 默认 **70**。

### 2.3 /clear 换代回写(authority lock + gen fence + keyed claim/receipt)

**共享 per-Lead authority lock**:`~/.flywheel/state/lead-authority-lock/<project>-<lead>/` mkdir-lock(bash 3.2 兼容,含 owner 信息与 stale 判定),launcher 与 hook 共用:

- **launcher**(每次真实 launch):锁内完成 ①生成新 gen token(uuid)并原子写 `~/.flywheel/state/lead-launch-gen/<project>-<lead>.gen` ②2.2 的 gate 判定与 park/receipt ③session-id 读取。child_env 注入 `FLYWHEEL_LEAD_LAUNCH_GEN=<token>`、`FLYWHEEL_SESSION_ID_FILE=<path>`。**fail-closed**:gen 写失败或锁超时(30s)→ abort 本次 launch(launchd 重拉),绝不带着不明 authority 继续 resume。
- **hook**(`session-start-adopt-inflight.sh`,matcher `clear` 不变):锁内串行执行,进锁后**先复验 gen**(env token vs gen 文件;不等 → 旧代,零副作用只写 fenced 审计),消除 TOCTOU —— launcher 换代也在同一锁内轮换 gen,两者线性化。hook 锁超时(2s)→ 零副作用只审计(fail-closed 方向安全:launcher 腿下次换代补 adopt,租约到期自然 requeue,消息不丢)。

**claim/receipt 持久化形状(真 keyed ledger,后续 clear 永不覆盖旧 key;R7-3 简化:无 pointer/seq)**:

- 目录式 ledger:`~/.flywheel/state/lead-clear-receipt/<project>-<lead>/<gen>-<newSessionId>.json`,单文件 pending→completed 原地(tmp+mv)更新;**任何后续 clear 不删除/不覆盖既有 key**。keyed claim 本身即提供 `(gen,newSessionId)` replay 幂等(「B completed → C completed → replay B」由此挡住);**无 `current.json`、无 seq、无 pointer repair**(r6/r7 为 rider 的 actionId 闭环而设,rider 删除后是孤儿复杂度——运维查最新直接看不可覆盖的 keyed receipts、session-id 文件与 `.history` 即可)。
- 自身 key 文件不可读/畸形 = claim authority failure(零业务副作用并审计)。
- **首次乱序的唯一权威 = upstream 串行契约**:Claude Code SessionStart hook 同步阻塞会话启动、timeout-kill 后不重试 ⇒ 同一 Lead 进程内多次 /clear 的 hook 首次执行天然串行,「B 首次 hook 晚于 C completed」不可达。列为显式 assumption + harness 锚测试;若 Claude Code 行为变化,gen fence 与 keyed-replay no-op 仍保住跨代与重放两类安全,残余风险如实记录。
- **重放规则**:key `completed` → 纯 no-op(零业务副作用);key `pending`(上次 crash 于副作用中途)→ 零业务副作用,只审计。

**hook 锁内步骤序(authority gate 必须短路,业务副作用才 best-effort)**:

- **authority gates(任一不过 → 零业务副作用,只审计,exit 0)**:
  1. gen 复验;stdin `session_id` 缺失/非 UUID → fenced。
  2. **三向 claim branch**:key `absent` → 原子写 pending **成功后才允许继续**;`pending` → 仅审计 return;`completed` → 纯 no-op return。pending 写入自身失败(mkdir/tmp/write/mv 任一)→ 零副作用 return(claim-before-effect 不可绕过)。
- **业务副作用(durable pending 成功后,各自 best-effort、互不短路,结果汇总进 receipt)**:
  3. adopt-inflight(现有 CLI 调用,SQL 语义不动)。
  4. session-id 回写:旧值 append `.history` → tmp+mv 写新值;同值幂等。
  5. bootstrap:stdout 追加**本地模板**指针文本(不 curl;避开 hook 10s timeout)。
  6. receipt 落 completed(本 key 文件):`{key:{gen,newSessionId},steps:{fence,claim,adopt:{ok,count},writeback,bootstrap},ts}`。

(r6 版的 actionId lookup 已随 Wave 3 移除 —— 无自动 clear,hook 不再需要因果归属。)

**crash 窗口(明示)**:①claim 已写、adopt 前 crash → 重放 no-op,本次少 adopt(有界:launcher 腿下次换代补 adopt,租约到期自然 requeue,消息不丢);②adopt 后、receipt completed 前 crash → 重放被 pending 挡住不重复 adopt。两窗口都不丢消息,`lease_retry_count` 至多正常 +1。

**时序自洽性**:回写后,下次重启 resume 的是 /clear 后的活会话;若又涨满,2.2 闸门兜住。两者合并 = 「重启出来一定不满」完备覆盖。

### 2.4 测试(TDD,先红后绿)

- 读取器 harness:2.1 矩阵全 12 项。
- 闸门 harness:unsafe→parked+fresh;safe→resume(**反空过绿**:断言 parked 不存在);unknown→parked;`=0` 逃生;receipt 内容;model decision 与 launch 同值;launcher 锁超时 abort;gen 写失败 abort。
- hook harness(扩 FLY-1751 harness):正常回写+history+keyed receipt;旧代 hook 进锁后被 gen 复验拦下(TOCTOU:检查通过后 launcher 换代);同 body 第二次 clear 正常;「B completed → C completed → replay B」断言 session-id 仍为 C、adopt 不增、`lease_retry_count` 不多增;pending 重放零业务副作用;claim 写入各失败点(mkdir/tmp/write/mv)→ 全零副作用;畸形 keyed receipt → claim authority failure;upstream 串行契约锚;畸形 session_id;业务副作用各自失败不短路(authority gates 必须短路);锁超时零副作用有审计。

## 3. A:原生 auto-compact 修复面(founder 裁决形态)

### 3.1 删除 test override(按证据表述,R7-2)

**改** `claude-lead.sh:1365`(export 默认 70)与 `:1861`(child_env 白名单)—— 删除 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 两处;**同步删** `packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:407` 的 Claude-pane mirror allowlist 条目及对应 runtime 测试(R7-4:否则留 orphan contract);清理引用该 env 的注释/日志与既有测试断言(实现时 grep active surface)。

**风险的诚实表述**:该变量**不是无行为的死开关** —— research §2.1 证明它被消费,且在 threshold enforcement 真生效的路径上会进一步降低触发阈值;「不保证执行」≠「从不改变行为」。删除 = 移除一个**条件有效但不可作为保证**的 test override(founder 裁决:不要自己加的东西)。后果:若某会话恰处 `enforced=true` 路径,删除后其 compact 触发点回到默认(更晚)。因此:**生产删除必须发生在 §3.2 矩阵留证之后**,receipt 记录「winner 配置同步替代」或「no-winner 风险接受(founder 已裁)」;部署前后抓取真实 child env 对照 + Claude Code 版本号;revert 条件 = 观察到删除后撞墙频率显著上升且 §3.2 无 winner。

### 3.2 原生配置实验矩阵(可归因协议,R7-1;实现 Runner 第一步)

**协议纪律**:每 cell 用 fresh 隔离 `CLAUDE_CONFIG_DIR` + fresh session(互不污染);固定 binary(2.1.233,receipt 记版本)、model、账号、system-prefix 与灌入负载;灌入方式统一(同一批大 tool-result);每 cell 留 pane 截图 + transcript 证据。**winner 判据**(全部同时满足,R8-1):无手动 `/compact`;transcript 出现 compact boundary/summary 且 ctx 显著下降;**compact 前最后占用(transcript usage,与 2.1 同一整数口径)落在模型真实 window 的 70%–80% 区间内** —— 区间外触发(55%/65%/90%)单独记 `works_outside_target`,不自动进推广 amendment,除非 founder 另行接受;**「非 reactive 先行」用 debug/telemetry 证据**(threshold source/enforced 态,或明确无 prompt-too-long/reactive 事件记录;仅 pane+transcript 不足以归因)——binary 有 `tengu_auto_compact_routed_reactive`/`tengu_reactive_compact_*` 遥测名可作 debug 输出锚;**fresh session 重复 ≥2 次**。E1 必须**跨过 80%**(灌到 ≥82% 或先见 compact/墙)才可判失败——78% 无法证伪边界。E3b 的 window 试值**预先登记**(首值 140000;因 threshold = effective window 减 summary buffer,真实触发会低于该值,允许按首轮实测校准,但每个尝试值必须在跑前记录,不得事后挑结果)。

| 实验 | 内容 | 判定 |
|---|---|---|
| E1 | 默认态(无任何 override),灌到 ≥82% 或先见 compact/墙 | 原生防线是否本来就工作 |
| E2 | `/autocompact` 对话框逐项记录;操作前后 settings 精确 diff | 官方配置面有哪些旋钮 |
| E3a | 仅 E2 发现的 setting(如 `autoCompactEnabled`/阈值项),不设 env | setting 单独能否让 threshold compact 真执行 |
| E3b | 仅 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`(token 窗口 override,值钉死:200k 模型试 140000 ≈ 70%),不改 setting | window env 单独效果(它优先于 setting,必须拆开归因) |
| E3c | (仅当 a/b 单独都失败而有理由怀疑组合)a+b 组合 | 组合归因 |
| E4 | 1M tier(`[1m]`):control(默认态)+ **1M-specific candidate**(R9:固定 token window 的 winner 不得复用 200k 值——140000 对 1M 是 ~14% cap,必然测错目标;按 1M 的 70–80% 目标与 summary buffer 预登记专用试值,如 750000)重跑,仍按实际 trigger occupancy 判 in-band | 1M 特殊分支是否吞掉防线。**预算分支(R8-3)**:E1–E3 完成后 Runner 提交 cost estimate 报 Lead;Lead 未给出数值批准 → E4 记 `inconclusive_budget_not_approved`,**不阻塞** B 与 override 删除的既定分支(该结论态写进 V6,Runner 不得自定花费、不得把未运行的 E4 报作通过);单次时间上限 30min |

- **服务端实验桶噪声**:binary 里 reactive 路由是服务端 flag(research §2.2),单次成败可能受桶影响 —— 这正是「重复 ≥2 次」的原因;结论文档必须记录已知不可控项。
- 结论落 `native-autocompact-verdict.md`:**有 winner → 不直接推广**,winner identity = `{binaryVersion, modelId/modelWindow, key, value}`(R9:绑定 model tier),amendment scope 同时含 workspace/global **与 model tier**;先把精确 key/value、scope、版本绑定、发布/回滚方式、launcher 测试写回本 plan(修订轮)再采纳。**tier 合同**:只有 E4 在 1M 上重复 ≥2 次得到 in-band winner,配置才可覆盖 `[1m]` Lead;E4 为 `inconclusive_budget_not_approved`/failed/`works_outside_target` 时,200k winner 只进 200k-only amendment,1M 保持未配置。launcher 测试断言 model resolver 对 200k/1M 各选各自批准值,**200k 固定 window 绝不泄漏到 1M**。**no-winner → A 终态 = 3.1 删 override + 证据落档**,平时防线缺位进 §4。
- 红线:无论结果如何,不自建压缩/泄压代码。

## 4. 残余风险(平时/非重启撞墙)— 显式明示,默认不做

B 只治**重启时刻**;运行中的长寿会话仍会缓慢涨向墙(Cass 两个月涨到 73%),撞墙后的自动自愈在本单 scope 外:

- 若 §3.2 实验证明原生 auto-compact 可配置生效 → 平时防线 = 原生,残余风险显著收窄(仅剩 compact 失败形态,如 prefix overflow)。
- 若原生防线确认不可用(no-winner)→ 平时撞墙的暴露面 = 撞墙到下次重启之间(B 保证重启即恢复;mailbox 侧 FLY-1708/1751 保证不丢批,但撞墙期间该 Lead 冻结)。**且需明示(R7-2):no-winner + 删 override 后,平时暴露面可能比当前「条件性 70% 行为」更大**(当前 override 在 enforced 路径上确实会提前触发)—— 这是 founder「不要自己加的东西」裁决的已知代价,证据全给、由她拍。
- 平时防线的候选方案(检测 + 自动泄压)已完整设计并经 Codex 六轮 review(附录 A),**作为 founder 显式选装项存档,默认不做**(founder:「不要自己加这些东西」)。design HTML 中以显式选项卡呈现此边界供 founder 拍板。

## 5. C:移出本单 scope(Lead 裁决 2026-08-14,lead-instruction 6928994d)

design 阶段核实结论(基于 research §5 代码审计):**「同类 fleet-alert 对同一 Lead 重复投递」的那条腿已被 FLY-1764(#836)物理删除** —— 原 `broadcastLoadShed()` 对全部 Lead 逐个 `notifyLead()` 写 CommDB instruction 的代码整段移除,`FleetSensorsDeps` 已无 `notifyLead`/`listLeadIds`,且有反向哨兵测试(`fleet-sensors.test.ts` `expect(notifyLead).not.toHaveBeenCalled()`)。此删除**不依赖任何 flag**(`FLYWHEEL_ALERT_ROUTING` 只决定 ticket 走 claw mailbox 还是旧 Discord 腿,两条路都不再对普通 Lead 广播)。→ **Honeylemon 连刷 4+ 条的形态已被结构性覆盖,C 不做**。残余小缺口(flapping 多 episode 穿透去重,现只影响 claw 自己的 mailbox;ticketSink 无 try/catch 的脆弱点)记录于 research §5,是否另立小单由 Lead 定,本单不扩。

## 6. 验收标准

### 硬验收(「重启出来一定不满」)

- **V1**:满 context fixture(session-id 指向 pct≥70 fixture transcript)→ kickstart 重启 → 新进程 argv 无 `--resume` + `.parked-unsafe-*` + gate receipt(parked)+ bootstrap 已发 + **adoption 证据 = fork 前 CLI 恰好调用一次(launcher log)+ CommDB 后置状态(`LEASED→QUEUED` / `lease_retry_count`),复用 FLY-1708 既有合同(R7-4:不为验收再造 adopt receipt——现机制本无此物)**。
- **V1b**:unknown 形态(缺失/全 synthetic/预算耗尽)→ 同样 park+fresh。
- **V2**:健康会话(safe_resume)重启 → 照常 resume,resume argv 与既有语义兼容;gate receipt(resumed)。
- **V3**:/clear 换代 → session-id 文件 = 新 uuid + keyed clear receipt 完整;随后重启 resume 新会话;旧代 delayed hook(含 TOCTOU 场景)→ 文件不被覆盖,fenced 审计在。
- **V4(生产验收,真机)**:对现存僵尸会话 Lead(如 Cass)重启一次,pane 出来即正常回话,无「Context limit reached」。

### A 验收

- **V5(R7-4 精确化)**:`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 在 **active executable/config/test surface**(shell 脚本、TS 源码含 `codex-lead-runtime.ts` allowlist、活动测试)零传播(grep 守卫,**显式排除** archival docs:本 plan/research/GEO-285 历史文档/codex-review 留档);Cass/任一 Lead 活进程 env 中不再有该变量(部署后实测)。
- **V6**:§3.2 实验矩阵各 cell 有留证结论(winner 判据含 70–80% 区间锚 + telemetry 归因,重复 ≥2 次;合法结论态含 `works_outside_target` 与 E4 `inconclusive_budget_not_approved`),`native-autocompact-verdict.md` 落档;winner identity 绑定 `{binaryVersion, model tier, key, value}`,1M 覆盖仅当 E4 在 1M 上 in-band ≥2 次;若有 winner,配置经 plan 修订轮写回后才采纳,并有 launcher 测试断言 200k/1M 各用各自批准值。

### 全仓门

`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(host 例外照实留证)+ 新增 shell harness 进 CI。

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 保守上界误 park 健康会话(大 tool-result 尾部) | 明示 tradeoff;代价 = fresh+bootstrap+adopt;receipt 留证观察误杀率;`FLYWHEEL_LEAD_CTX_RESUME_GATE=0` 逃生 |
| safe_resume 误判 | base 含 output_tokens + 尾部 1:1 可证明上界 + 整数比较 + 对抗反例测试 |
| launcher 锁死锁/gen 写失败 | fail-closed abort→launchd 重拉;stale lock 判定;30s 预算 |
| 旧代 hook TOCTOU | 共享 authority lock + 锁内 gen 复验(launcher 换代同锁线性化) |
| 重复/乱序 clear 多次 adopt / 倒写旧 id | keyed ledger 永不覆盖旧 key,completed 重放纯 no-op、pending 重放仅审计 + 首次乱序由 upstream 串行契约排除(显式 assumption + 锚测试)+ gen fence;crash 窗口有界且不丢消息 |
| 删 override 后 enforced 路径会话更晚 compact(R7-2) | 表述按证据:条件有效但不可作为保证;删除在 §3.2 留证之后执行,winner 同步替代或 no-winner 风险接受留 receipt;部署前后 child env 对照 + 版本号;revert 条件明写 |
| 平时撞墙无自动防线 | §4 显式明示(含 no-winner 可能比现状更晚 compact 的诚实边界);§3.2 实验决定原生防线可用性;founder 已知情裁决 |
| Claude Code 版本漂移 | B 检测只依赖 transcript usage 结构(token-usage scanner 同源口径);V6 实验证据标注版本号 |

回滚:B 闸门 `FLYWHEEL_LEAD_CTX_RESUME_GATE=0` 或整体 revert(纯 launcher shell + hook);A 删开关可单独 revert。

## 8. 工作量与派法

- 单 PR 交付(launcher shell + 读取器 + hook + harness + 删 override + 实验留证);实验矩阵(§3.2)为实现 Runner 第一步。
- executor=code,model=fable;完整独立 QA(V1–V6;V4 必须真机)。

---

## 附录 A:外部泄压设计存档(founder 选装项,默认不做)

r6 版(Codex 六轮 APPROVED)含一套「平时防线」:Bridge GatePoller rider 直读 Lead pane ctx%(阈值 80%)→ 两级泄压(一级注入原生 `/compact`,失败/超时升级 `/clear` 接力,靠本单 2.3 的 hook 机械无损接续)→ SQLite episode 状态机(compact_sent → resolved_by_compact | clear_requested → cleared_confirmed/cleared_degraded/cleared_external/abandoned,CAS + gen/session 绑定)→ Lead terminal-action primitive(per-action pane predicate、双 capture fingerprint、audit-before-keystroke fail-closed、全 Bridge Lead 注入唯一收口 + 静态守卫)→ `context_limit`/`context_relief_degraded` 两 kind 告警注册。设计细节与安全契约的逐轮打磨记录见 `codex-review/`(六轮 feedback 全文留档)。若 founder 未来拍板要平时自动防线,以本附录 + 该记录为起点重启设计。
