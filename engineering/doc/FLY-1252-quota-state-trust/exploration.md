# FLY-1252 claude-accounts.json 配额状态可信化 — 探索

Issue: FLY-1252 (https://linear.app/geoforge3d/issue/FLY-1252/infra-claude-accountsjson-配额状态过期不可信-切号器切到已耗尽账号拖垮-lead)
日期: 2026-07-16
基于: 无

## 1. 问题定义

2026-07-14 事故:`~/.flywheel/claude-accounts.json` 里 4 个账号全部 `quotaExhaustedUntil=null`(= 都可用),但 business 实际已撞 weekly limit。Tadashi 手动把机器账号切到 business(切号器和他都信了假状态)→ flywheel-eng-lead + claude-infra-bot-lead 卡死 ~30 分钟,靠人肉恢复。

issue 提出三个修复方向:① 状态要反映真实配额;② 切号前实测目标账号;③ weekly 与 5h 两个窗口都要跟。

## 2. 关键前提:FLY-1256 已经落地了什么(审计结论)

本单开于 2026-07-14 21:07 UTC。**同一事故催生的 FLY-1256(外部配额监控 + 自动切号 daemon)已在本单设计之前完成并 merge(PR #603)且生产部署**。审计生产实况(2026-07-16):

- `com.flywheel.quota-monitor` launchd daemon 在跑(pidfile 活、state 新鲜、errorStreak=0、tier=accelerated、已发生过一次自动切号 generation=1)。
- `FLYWHEEL_QUOTA_DAEMON_CUTOVER=1` 已设 —— Bridge 被动切号管线(FLY-1182 点火路径)已退役,daemon 是唯一自动切号执行体。
- daemon 的行为(`quota-monitor.ts`):每 10-20min 用 OAuth usage API 实测**当前账号**双窗口真实用量;触发切号时对**每个候选**逐一实测(资格 = 5h<100% 且 7d<100%),排序按 7d reset 最早 → 把 quota-verified 的 `preferredOrder` 传给 `switchAccount`。**自动切号路径完全不信 claude-accounts.json 的配额标记**。

也就是说,issue 的三个修复方向,**自动路径**已被 FLY-1256 覆盖:② 切前实测(候选逐一验证)、③ 双窗口(fiveH/sevenD 都跟,weekly ≥100% 是触发条件之一)。

## 3. FLY-1256 之后仍然存在的真缺口

### G1(事故主路径,完全未堵):手动 `flywheel-claude-profile use <name>` / `next` 零配额验证

`packages/claude-runner/bin/flywheel-claude-profile` 的 `use` 只做 **auth freshness 验证**(FLY-871 的 probe-refresh,防 stale token 弄断登录),**没有任何配额检查**,也完全不读 claude-accounts.json。FLY-1256 计划明文「不改 flywheel-claude-profile」。今天再手动 `use business`(business weekly 耗尽)会原样复现 7-14 事故。**Tadashi 事故当天走的正是这条路径。**

### G2(Annie 的字面抱怨,未修):claude-accounts.json 永远不反映观察到的真实配额

`quotaExhaustedUntil` 的**唯一写入点** = `switch-executor.ts::commitSwitch`(切号动作发生时标记「被切走的源账号」)。daemon 每 10-20min 实测到的真实用量:
- 写进 statusline 缓存(`~/.claude/usage-api-cache.json`,只有当前账号);
- 候选验证时观察到某候选 `quota_exhausted` → 只进告警 body 的 panorama,**store 不落盘**;
- **claude-accounts.json 一个字节都不更新**。

生产此刻的实况就是证据:daemon 明知当前账号在 accelerated 档(5h>70%),store 里 5 个账号仍然全部 `quotaExhaustedUntil=null`。「文件是假的」这个状态至今为真。

受害消费面:
1. 手动 `use` 想做「至少别切到刚标记 exhausted 的账号」这种廉价检查,也没有数据可查(方向②的最低要求都不满足);
2. `flywheel-account-summary`(Codex Infra Bot 每日「看」作业,读 ledger + store 发 Alerts)基于假 store 出报告;
3. kill-switch 回滚路径:一旦撤 `CUTOVER` 重启 Bridge(FLY-1256 §8 应急预案),legacy 切号管线复活,它的 `selectNextAccount` 没有 preferredOrder,**直接信 store 的假标记** —— 回滚态 = 事故态;
4. 任何人(Annie/Lead/运维)读这个文件都被骗 —— 呼应「status LIES」教训。

### G3(数据模型缺口):store 无观察时间戳、无双窗口区分

`AccountEntry` 只有 `quotaExhaustedUntil` + `weeklyResetAt`(且后者只在切号时写)。没有「这条信息是什么时候观察到的」(staleness 无从判断),没有 5h/7d 各自的状态。方向③在 store 数据模型层面未落。

## 4. 设计红线(继承自 FLY-696 / FLY-871 / FLY-1256,不可破)

- **R1**:active 账号的凭证只读,绝不 probe-refresh(2026-07-04 事故红线)。
- **R2**:store / 日志 / 告警零 token。
- **generation 语义不可污染**:`generation` 是切号 CAS token(严格 = 已提交的切号次数)。任何「观察回写」都**不许 bump generation**,否则 daemon 的 CAS/state 恢复语义全乱。
- **锁纪律**:对 store 的读改写必须在 `claude-accounts.lock` 下原子完成;网络调用原则上不持锁,唯一有界例外是切号时刻的 freshness 验证(10s 超时 < 120s stale-break),已有先例。
- **byte-compat**:不新增必填字段;新字段 optional,旧读者(isQuotaUsable 等)行为不变。

## 5. 方案选项

### Option A — 只堵手动路径(最小)

`use <name>` 在 freshness_guard 之后加一步配额实测:用刚 rotation 完的 pool token 调 usage API,任一窗口 ≥100% → 硬拒(新 exit code),打印双窗口用量 + reset 时间;紧急旁路 env(镜像 `FLYWHEEL_CLAUDE_FRESHNESS_BYPASS` 模式,只在手动模式生效)。daemon 的 delegated 模式跳过(它切前刚实测过,重复调用浪费限额)。

- 优点:一刀命中事故路径;改动面最小(bash + 一个 Node helper 子命令)。
- 缺点:**G2/G3 原样不动** —— 文件继续是假的,daily summary 继续骗人,回滚态继续危险。Annie 的字面抱怨(「claude-accounts.json is way outdated,this is a real problem」)没有被回应。

### Option B — 只做状态回写(store 可信化)

daemon 把每次成功观察回写 store:active 账号双窗口状态(≥100% → 标 exhausted 带真实 resetsAt;<100% → 清标记)+ 候选验证时观察到的 exhausted/healthy 同样落盘。

- 优点:文件变真;所有 store 读者(summary / legacy 回滚路径 / 人眼)受益。
- 缺点:**G1 只堵了一半** —— 手动 `use` 若只查 store,仍有观察间隔窗口(base 档 20min;闲置候选平时零查询,base 档下可能几小时没观察),事故仍可能复现。单独不够。

### Option C — A + B 组合(推荐)

1. **store 可信化(B)**:daemon 观察即回写(锁下、不 bump generation、只从验证过的 200 payload 写、<100% 自动清)。新增 optional 观察元数据字段(如 `lastObservedAt` / 双窗口 pct)解 G3,旧字段语义不变。
2. **手动路径硬闸(A)**:`use`/`next` 切前实测目标(网络实测为准,store 只是加速/展示层);实测不可用时(网络故障等)fail-closed 拒切 + 明确 bypass env。
3. **顺带一致性**:手动实测发现 exhausted 时也把标记写回 store(已持锁,顺手),让 summary/下次选号立刻受益。

- 优点:三个修复方向全闭环;手动/自动/回滚三条路径全部「只信实测,store 如实记录」;与 FLY-1256 架构同向(daemon 是唯一常驻观察者,store 变成它的观察落盘)。
- 缺点:改动面比 A 大(daemon 回写 + bash 闸门 + helper);候选标记与 `verifyAndRankCandidates` 的既有 store 预过滤有交互,需要明确「先清再选」的顺序(见 §6)。

**推荐 C。** 理由:A 单独留着一个公认「说谎的状态文件」继续喂 daily summary 和回滚路径,治标;B 单独堵不住事故主路径。C 的两半互相成就:实测是权威,store 是如实的账本。

### 考虑过但不推荐:检测链回写(TUI 撞墙瞬间标记 store)

方向①字面提到「撞到 weekly-limit / 429 时标记」。post-CUTOVER 的 TUI 撞墙检测(runner-quota-detector)是纯告警;daemon 会在 ≤10-20min 内实测到同一事实并(按本设计)回写 store;手动路径有实时实测兜底。为「把 pane 文本解析结果写进 store」新增第三个写者,引入 FLY-1285 式平台解析风险,边际收益小。**不做**,若 Lead 认为撞墙瞬间的即时性重要可以加回。

## 6. 关键交互与坑(留给 research 展开)

- **候选标记 vs 选号过滤的顺序**:`selectNextAccount` 对 preferredOrder 里的候选仍会跑 `isQuotaUsable` 过滤。若 store 有过期的 exhausted 标记而候选实际已恢复,`verifyAndRankCandidates` 现有逻辑会在预过滤阶段(cooldown)直接跳过、连实测都不做 —— 标记自带真实 resetsAt 会自然过期,这是「省 API 调用」的既有权衡,保留;但**实测到 <100% 时必须先清 store 标记再进 switchAccount**,否则刚验证合格的候选会被自己的陈旧标记过滤掉。
- **手动闸门的锁内网络调用**:quota 实测跟 freshness_guard 一样落在锁内(10s 超时,有界),沿用既有例外;或评估锁外预测+锁内复核的拆分,research 定。
- **谁来写 helper**:freshness-cli 加子命令 vs 新 sibling CLI(复用 `fetchAccountUsage`),exit code 约定(30/31 已占,拟 32=target quota exhausted)。
- **`next` 的语义**:round-robin 撞到 exhausted 目标是跳过继续找,还是硬停?倾向跳过(它本来就是「找下一个能用的」)。
- **store 新字段形态**:`lastObservedAt`、`fiveHPct`/`sevenDPct` 观察快照放 store 还是复用 FLY-871 ledger?store 是选号依据、ledger 是报告数据源,两者边界 research 里定(倾向:store 只加最小选号相关字段,快照细节留 ledger)。

## 7. 假设清单(headless 自决,gate 时向 Lead 亮出)

1. FLY-1256 的 daemon + CUTOVER=1 是长期形态,本设计以它为地基(不重建自动路径)。
2. 手动 `use` 对 exhausted 目标应当**硬拒**(带 bypass env),不是仅警告 —— 事故证明人会信工具。
3. daemon 观察回写不 bump generation、不发新告警 kind(纯落盘,不加噪音)。
4. 检测链(TUI 撞墙)不新增 store 写者(§5 末)。
5. 本单不动 FLY-1256 的触发/选号/恢复逻辑本体,只在它的观察提交点加回写。

## 8. 成功标准

- 复现事故场景(目标账号 weekly 耗尽)时,`flywheel-claude-profile use <目标>` 被硬拒并打印真实双窗口状态,Keychain/.active 不动。
- daemon 正常运行若干 poll 后,claude-accounts.json 与 usage API 实测一致(exhausted 账号带真实 reset 时间,健康账号为 null)。
- 撤 CUTOVER 回滚演练时,legacy 路径读到的是真状态。
- `flywheel-account-summary` 输出与实测一致。
