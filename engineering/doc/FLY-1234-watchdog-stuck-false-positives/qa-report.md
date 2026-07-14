# FLY-1234 watchdog stuck 误报根治 — QA 验证报告

Issue: FLY-1234 (https://linear.app/geoforge3d/issue/FLY-1234)
日期: 2026-07-13
基于: plan.md, exploration.md, research.md + 本分支已提交实现(commit e4681f2cb + Codex R1/R2)

## 0. 一句话结论

> **✅ 最终裁决(2026-07-14,RE-TEST 后):QA PASS。** 首轮真机 N-to-N 抓到 CONFIRMED HIGH bug(parseJudgeVerdict 对真 codex `--json` 全线 fail-open → §9 FAIL);implement 在 fix head **c9f755aa5** 修复(JSONL `item.completed.item.text` 提取 + declared-park 佐证进 judge prompt);**RE-TEST 6/6 全过、真解析出 verdict(非 fail-open)** —— 详见 §10。完整 0/5 目标达成。
>
> **⚠️ 历史(首轮 N-to-N,已被 fix 推翻):QA = FAIL(kickback)。** 代码层(单测/装配/字节兼容)PASS,但真机 N-to-N 抓到 judge 解析路径对**真 codex `--json`** 全线失效 → judge 依赖的静止帧案例即使通电也不被抑制 → 0/5 实际只到 3/5。详见 §9。**此 FAIL 已由 c9f755aa5 修复 + §10 RE-TEST 6/6 复验推翻。**

**代码层验证 PASS** —— 修复正确定位并根治了 5/5 误报的漏拦点(heartbeat quiet 路径无 pane/进程证据环节),96 个 FLY-1234 单测全过,5 案例回归形态全覆盖,所有硬合同不变量(INV-1..6)落地,fail-open 谱系正确,FLY-1234 触及文件 lint 零错。

**但 ship 前有两项非代码依赖必须由 Lead 编排**(见 §5):① PR CI 现为红 —— 继承自 **main 自身已红**(与 FLY-1234 无关的既存 lint 错误),已有专项 hotfix PR #581 在途,FLY-1234 需 #581 落 main 后 rebase 才转绿;② 完整 0/5 效果依赖部署时把 `FLYWHEEL_WATCHDOG_JUDGE=1` 写进生产 env(plan T6,目前未落),否则 case 1/4(静止帧)仍会 fail-open 告警。

## 1. 验证范围与方法

- 分支: `flywheel-FLY-1234` @ HEAD `390f61d8`,PR #579,base=main。
- 真实 FLY-1234 diff(`origin/main...HEAD`,排除 rebase 带入的 FLY-1185/1224):19 文件,与 plan 交付物 D0-D5 精确对应。
- 方法:① 逐文件通读核心实现(决策模块 / assembly / HeartbeatService 接入 / judge prompt);② 跑 FLY-1234 全部单测;③ 复现全仓 lint;④ 全 teamlead 套件回归 + 失败归因;⑤ 核对生产 env 现状与 ship 依赖。

## 2. 代码正确性核对(逐项 PASS)

| 项 | 核对结论 |
|---|---|
| 根因定位 | 正确。5/5 误报走 HeartbeatService `getStuckSessions` 纯 DB quiet 路径,发射前无任何 pane/进程证据环节;pane 侧检测器(StuckDetector/gap-scan/judge)当天判定正确但守的是另一条管道。修复在 quiet 路径内联「确认层」。 |
| 修复方向 | 与 issue「要查」候选一致:① liveness 探针(仅当死亡检测器,INV-6)→ ② 双帧比较(FLY-92「看两次」+ FLY-195 raw 判据)→ ③ judge 裁决(FLY-1048 `routeSuspiciousReport`)。复用现有件,不引入第四个检测器(plan §4.5)。 |
| 决策表 | `stuck-pane-confirm.ts` 逐行匹配 plan §T1:dead_pin/absent/gone/indeterminate → emit;capture 失败 → emit;双帧同签名 → emit(repeated_error_signature,不可被 judge 降级);帧变+无签名 → suppress(frames_changing);其余 → judge。 |
| INV-1 fail-open | 任何 throw/超时/预算外/holder 未绑定 → 照发(legacy emit)。deadline race + try/catch + belt-and-suspenders 兜底齐全。 |
| INV-2 不饿死 | per-tick budget 外候选走 legacy emit(带 confirm_budget_exhausted 注解),非顺延。单测断言的是预算注解本身。 |
| INV-3 快照重读 | await 后重读 session + 全量重放 isMonitorSuppressed/alreadyNotifiedStuck/isStuckWakeSuppressed;任一变 → 静默 continue,不 dedup。字符串等值判恢复,不做 JS 时间解析。 |
| INV-4 单发射权 | 确认层 judge 路由只审计 + 回传裁决,`notifyDetectionEpisode` 仅注入 suspicious 管道的 onConfirmedStuck。 |
| INV-5 逐字节回退 | `stuckConfirmHolder===undefined` 或 `=0` → 保持 `onSessionStuck` 二参调用(arity sentinel);三参仅在确认层生效时。 |
| INV-6 pane-alive≠进程活 | liveness 探针只当死亡检测器;`alive` 单独永不抑制,推进到步②。 |
| judge prompt few-shot | `buildJudgePrompt` 加入 3 形态(审查等待/长思考/测试套件)+ 明确「静止 pane 文本单独绝不足够,需运行时佐证」。 |
| 缓存键 | 心跳路径注入带版本号(`heartbeat-v1`)的规范化证据序列化再 sha256;targetKey 始终真 execId;frames RAW 入键;comm 事件以 recency 桶入键;墙钟毫秒不入键。 |

## 3. 单测结果

- **FLY-1234 专属套件:96/96 PASS**(耗时 ~1s):
  - `stuck-pane-confirm.test.ts` 45 —— 决策表全行 + throw + deadline token 隔离 + 重复签名不可被 fake a_working 降级 + gone 措辞。
  - `heartbeat-stuck-confirm.test.ts` 14 —— suppress 不调 notifier 不 dedup / emit 三参带 confirmNote / `holder===undefined` 二参零新日志 / `current===null` 三参 confirm_unbound + warn / **饿死回归**(5 会话 budget 3,第 4/5 个以 confirm_budget_exhausted legacy emit)/ **并发重入守卫** / **帧睡眠期间恢复** / await 后闸重放 / exactly-once。
  - `stuck-confirm-cases.test.ts` 13 —— **今天 5 案例回归**(见 §4)+ addendum + true-stuck 仍告警 + annotation 双 runtime 渲染 byte-compat。
  - `stuck-confirm-assembly.test.ts` 6 —— 生产 assembly:judge a_working → 0 通知 0 dedup 1 审计行 + judge prompt 携带 SEEDED stage/comm/真帧。
  - `watchdog-judge-decision.test.ts` 18 —— JudgeDecision 判别联合 + buildJudgePrompt few-shot + 佐证要求断言。
- **feature-flags drift 测试:3/3 PASS**。
- **lint(biome):FLY-1234 触及的 8 个源文件 + 测试文件 —— 零错误**。

## 4. issue 5 案例回归形态覆盖

| # | 案例(exec / 场景) | 走的路径 | 判定 | 是否依赖 judge |
|---|---|---|---|---|
| 1 | 00ddfc18 codex design R2 等待(静止 pane) | 静止帧 → judge | a_working → **SUPPRESS** | **是**(需 judge 启用) |
| 2 | e8c0e865 xhigh 长思考(spinner 计数器变) | 帧变 → frames_changing | **SUPPRESS**(零 judge 成本) | 否(机械) |
| 3 | 097a5dcf 活跃 bash(输出滚动) | 帧变 → frames_changing | **SUPPRESS** | 否(机械) |
| 4 | cc21f3f5 静止帧 + 活进程 | 静止帧 → judge | a_working → **SUPPRESS** | **是**(需 judge 启用) |
| 5 | 2ed82858 vitest 进度(帧推进) | 帧变 → frames_changing | **SUPPRESS** | 否(机械) |

true-stuck 仍准确告警覆盖:dead_pin(remain-on-exit 尸体)、静止帧 + judge c_stuck、rolling error loop(同签名,judge 不可降级)。

**QA 重点结论**:case 2/3/5(3/5)走确定性机械路径(`frames_changing`),**无需 judge 即被抑制** —— 这 3 例的修复不依赖任何部署开关。case 1/4(2/5)是静止帧,只有 **judge 启用且返回 a_working** 才被抑制;judge 未启用 → `judge_unavailable` → fail-open EMIT(安全但仍误报)。因此完整 0/5 硬依赖 §5 的部署步骤。judge prompt 的 few-shot 内容已被单测断言;真 LLM 对 case 1/4 的实际分类是**部署后可验证的行为**(见 §6)。

## 5. Ship 前依赖(非代码缺陷 —— 交 Lead 编排)

### 依赖 A:CI 红是继承自 main 已红,需 #581 落 + rebase

- PR #579 CI「Build & Test」FAILURE,但 **origin/main 自身 CI 也 FAILURE**(76f0560 @ 02:47Z)。
- 唯一 error:`engineering/doc/FLY-1070-.../qa-e2e-harness.mjs:731` noUselessLoneBlockStatements —— 该文件在 main 上就存在、与本分支逐字节相同,**不属于 FLY-1234 的 19 文件 diff**。FLY-1234 引入的文件 lint 零错。
- 已有专项 hotfix **PR #581 `fix/main-lint-sweep-0713`「unbreak main CI」** 在途。
- **建议编排**:#581 先落 main → FLY-1234 rebase onto 绿 main → CI 转绿 → 再走 ship gate。FLY-1234 **不应**自己修那个 lint 错误(会与 #581 撞车)。

### 依赖 B:部署时必须写 `FLYWHEEL_WATCHDOG_JUDGE=1`(plan T6)

- 生产 `~/.flywheel/.env` 现有 `FLYWHEEL_STUCK_ERRORSIG=1` + `FLYWHEEL_DETECTION_GAP_SCAN=1`,**无 `FLYWHEEL_WATCHDOG_JUDGE=1`**,也无 `FLYWHEEL_STUCK_PANE_CONFIRM`(默认 ON,正常)。
- 不设 judge → case 1/4(静止帧)走 `judge_unavailable` fail-open EMIT:**部署后误报率只会从 5/5 降到 2/5,而非 0/5**。
- **产品可用性提醒(不埋)**:仅 merge 本 PR 不等于修好 5/5;deploy 必须同时把 `FLYWHEEL_WATCHDOG_JUDGE=1` 落进生产 env(config 先落再重启,FLY-205 教训),否则 case 1/4 仍会误报。

## 6. 部署后真机验证建议(restart-gated,非本 QA 阶段能完成)

本 bug 的完整真机 E2E 属 restart-gated 特性(需 Bridge 重启 + judge 启用后才生效),应在部署后验证:
1. 真机段(plan T5-3):静止 sleep pane + 真实佐证上下文 → 期望 a_working suppress;同 pane 无佐证 → suspicious emit;kill 后 dead_pin → emit。
2. 观察合同(plan T6③):次日起 session_stuck 告警必须携带 `confirm_note` —— 无注解裸告警 = 确认层被绕过 = 回归。

> 本 QA 阶段**未**跑生产 judge spawn 真机段,原因两条并存:① 生产 judge 走 `codex exec` one-shot,而本机红线是「raw codex exec 会挂死,须走 codex-with-fallback」;② 核实时 load average = 60(严重过载,memory 记载 load 飙高 = crash 根源),再起重进程有 OOM/crash 风险。few-shot prompt 内容 + 编排路由已由单测充分覆盖,真 LLM 分类交部署后验证。

## 7. 全套回归归因(全部环境性,非 FLY-1234 回归)

全 teamlead 套件在本 runner 环境跑出若干失败,**逐一归因为环境性,无一在 FLY-1234 diff 内、无一为代码回归**:

- 两次运行失败集合不同(第一次 5 文件、第二次 6 文件)= load 60 下的 flake。
- `stuck-candidate.test.ts`(watchdog 邻域,但非 FLY-1234 文件):污染 env 下失败 1 个「env unset 默认行为」断言;**干净 env 下 36/36 全过** —— runner 继承生产 `~/.flywheel/.env`(FLYWHEEL_STUCK_ERRORSIG=1 等)污染了断言「env 未设」的测试。
- `runs-route-registration` / `lead-rules-bundle`:干净 env 下通过。
- `createLeadRuntime-preflight`:spawn `codex-lead.sh growth-lead`(lead-backend 预检,读真实 codex home / 机器状态),与 FLY-1234 无关。
- `codex-lead-runtime.test.ts`(×22,FLY-350/245):TMPDIR overlap + remote-control WebSocket 失败(memory 记载的已知环境性假失败)。
- `worktree-quarantine.test.ts`(FLY-1185):real-git submodule 5s 超时(load 60 下环境性)。

**权威口径 = CI 干净 env**:CI 上测试步骤不受这些 env 污染影响;唯一失败是依赖 A 的继承 lint 错误。

## 8. 最终判定

- **代码:PASS**(正确、完整、fail-open 安全、单测充分、lint 洁净、全套失败均环境性)。
- **Ship 阻塞**:依赖 A(#581 rebase 转绿 CI)+ 依赖 B(部署 env)。二者均为 Lead 编排项,非实现阶段能修的代码缺陷,故不 kickback 实现阶段。
- **移交 Lead**:请确认 ship 顺序(#581 落 → rebase → CI 绿 → 走 approve gate;部署时补 `FLYWHEEL_WATCHDOG_JUDGE=1`)。CI 未绿前不开 approve gate(避免绑定将被 rebase 改写的 head,且不向 founder 展示红 CI 的「待批」)。

## 9. 真机 N-to-N E2E(Annie pre-ship 硬验收,Tadashi 40002c05/41a2716d)—— **FAIL**

方法:module-driven(1224 §7 路径 B 同款)驱 #579 head 7a658d8a 真 dist 确认层 + 真 WatchdogJudge(`codex-with-fallback`,`FLYWHEEL_WATCHDOG_JUDGE=1`)对着 6 个真 tmux pane 跑,全隔离(HOME 隔离同时覆盖 CommDB + tmux-lookup 的 `homedir()` 硬路径 + StateStore + CLAUDE_CONFIG_DIR,零碰生产)。case (c)+(f) **经真 `HeartbeatService.checkStuck` tick 入口**驱动(Tadashi 反回归断言:证明检测器 tick→确认层这根管子在构建产物里真通,非测试代码替接)。harness + 逐场景证据在 `e2e-evidence/`。

| # | 场景 | 结果 | 观测 |
|---|------|------|------|
| a | 活跑 pane(命令流滚动) | ✅ PASS | `suppress/frames_changing`,judge 未调 |
| b | 静止 pane + 佐证 | ❌ **FAIL** | 期望 `suppress/judge_a_working`,实得 `emit/judge_unavailable` |
| c | 静止 pane 无佐证(真 tick 入口) | ⚠️ PASS* | 全链真通(check→确认层→judge 调用→3 参 onSessionStuck 带 Confirm-Note→真 Discord msg `1526449295744696332` 读回含 `Confirm-Note:` 行)——但经 fail-open 分支达成,非真正解析出的 suspicious 裁决 |
| d | 真死 pane(remain-on-exit 尸体) | ✅ PASS | `emit/dead_pin`,零帧捕获(探针快路径确认) |
| e | 合法 parked 空壳 | ❌ **FAIL** | 期望 `suppress/judge_b_parked`,实得 `emit/judge_unavailable` |
| f | `FLYWHEEL_STUCK_PANE_CONFIRM=0`(真 tick) | ✅ PASS | legacy 2 参 `onSessionStuck`(`details===undefined`),judge 未调 —— INV-5 字节回退成立 |

### 核心发现(HIGH,CONFIRMED —— 独立复现,非自报)

**`parseJudgeVerdict()` 解析不了真 codex `--json` 输出 → 每次真 judge 调用都 fail-open 成 `judge_unavailable`。**

- 根因:`watchdog-judge.js` `parseJudgeVerdict()` 正则 `/\{[^{}]*"verdict"[^{}]*\}/g` 假设 verdict JSON 在 stdout 里**未转义**。真 `codex exec --json` 是 JSONL,模型答案作**转义字符串**嵌在 `item.completed.item.text`:`{"type":"item.completed","item":{…,"text":"{\"verdict\":…}"}}`。转义引号使正则 0 命中 → 恒返 `null`,即便 codex 调用成功(exit 0、well-formed、verdict 有效)。
- 效果:`decideJudgeOutcome(null)` → `{action:"suspicious"}` → routeSuspiciousReport 以 `decision:"unavailable"` 交付 → 确认层每次 emit `judge_unavailable`。fail-open/安全(真 stuck 不被吞),但**judge 降级到 `a_working` 才能抑制的原审计误报(case 00ddfc18/cc21f3f5)在生产即使 `FLYWHEEL_WATCHDOG_JUDGE=1` 也不会被抑制** —— 完整 0/5 目标破,实际只到 3/5(机械 frames_changing 的 2/3/5)。
- **独立复现(QA 亲手,非信证据文件自报字段)**:把 case-b 证据里的真 codex stdout 喂进 shipping dist 的 `parseJudgeVerdict` → `RESULT: null`;正则 `.match(...)` → `null`;而 `item.completed.item.text` 里模型明明正确答了 `a_working`(附完整 rationale 引用了佐证事件)。
- 归因:`parseJudgeVerdict` 是 **FLY-1048 引入的既存代码**(commit 34644a967 / #525),FLY-1234 未碰它。但 judge 此前「装了没接线、全年 0 调用」从未真跑过,所以从没暴露;**FLY-1234 是第一个真正在生产跑 judge 的改动(接进心跳 + 通电),其 0/5 目标依赖它工作** → 无论归属,FLY-1234 不修它就达不成验收。
- 为何 96 单测全绿却漏掉:`watchdog-judge.test.ts` 的 `parseJudgeVerdict` fixture 把**未转义**裸 verdict JSON 拼进假 JSONL —— 真 codex `--json` 永不产生的形态,所以单测从没走过真路径。**这正是 Annie「先 N-to-N 测」直觉要抓的东西。**

### 次要发现(MEDIUM)

`buildJudgeInputFromStore` 无条件 `park: null` —— `mechanicalParkEvidence()` 为 b_parked accept/reject 读的 CommDB 声明 park 态从没进 judge prompt。即便 parse bug 修了,case (e) 也未必稳到 `b_parked`(2/2 真跑模型都落 `suspicious`,因为 prompt 里根本没看到 park 佐证)。

### 修复方向(交 implement 阶段,Lead 定归属:FLY-1234 内修 or fast-follow)

1. `parseJudgeVerdict`:从 codex `--json` JSONL 的 `item.completed.item.text` 提取(JSON.parse 每行 → 取 agent_message.text → 再 JSON.parse),而非裸正则扫转义 stdout;单测 fixture 换成**真 codex `--json` 形态**(转义嵌套),否则修了也测不住。
2.(可选,治 e)`buildJudgeInputFromStore` 把 CommDB 声明 park / pending blocking gate 态填进 `input.park`,让 judge prompt 真看到 b_parked 佐证。
3. 修后必须重跑本 §9 的 6 例真机 E2E 复验(尤其 b/c/e 要真解析出 a_working/suspicious/b_parked,不再走 fail-open)。

### 结论
- FLY-1234 自身代码(确认层编排、双帧、dead_pin 快路径、fail-open、arity 字节回退、检测器 tick→确认层接线)**真机验证正确**(a/c-链/d/f)。
- 但**验收(5 案例 0 误报)未达成**:judge 依赖的 b/e(及原审计 case 1/4)因既存 `parseJudgeVerdict` bug fail-open 成 emit。**不能 ship**。kickback implement 修 parse + 重验。

## 10. RE-TEST(fix head c9f755aa5,§9 kickback 修复后)—— **6/6 PASS**

implement 在 c9f755aa5 修了两处(commit「parse real codex --json JSONL + feed declared park to the judge」):① `parseJudgeVerdict` 改 JSONL-aware(逐行 parse、取 `item.completed` agent_message `text`、从转义嵌套串提 verdict + legacy bare-scan fallback);② `buildJudgeInputFromStore` `park` 改 caller-supplied + 新 `probeDeclaredParkFromCommDb` 把 runner 声明 park 喂进 judge prompt `park:` 行。dist 重建后同一 harness(§9 committed)重跑全 6 例。

| # | 场景 | RE-TEST | judge 调用 | 真解析 verdict |
|---|------|---------|-----------|---------------|
| a | 活跑 pane | ✅ suppress/frames_changing | 0 | — |
| b | 静止+佐证 | ✅ **suppress/judge_a_working** | 1 | `a_working`(真解析,非 fail-open) |
| c | 静止无佐证(真 tick 入口) | ✅ **emit/judge_suspicious** | 1 | `suspicious`(真解析)+ 真 Discord msg `1526485634120683622` 带 `Confirm-Note:` |
| d | 真死 pane | ✅ emit/dead_pin(快路径) | 0 | — |
| e | parked 空壳 | ✅ **suppress/judge_b_parked** | 1 | `b_parked`(真解析,park 佐证已进 prompt) |
| f | `=0` kill-switch(真 tick) | ✅ legacy 2 参 onSessionStuck | 0 | — |

`outcome.json`: `allPass: true, findings: []`。

**独立复现(QA 亲手,非信子 agent 自报)**:用**新 dist** 的 `parseJudgeVerdict` 喂 §9 捕获的、修复前返 null 的同一份真 codex stdout → case-b 返 `a_working`、case-c 返 `suspicious`(dist 级 replay 确认);全 6 例证据文件逐条核对(b/c/e 均 `judgeCalls=1` + 结构化 `parsedVerdict` + `regexCandidates=null`,证明走新 JSONL 路径、非 legacy fluke、非 fail-open);case-c 真 Discord 读回含 `Confirm-Note:` 行。

**最终 QA 裁决:PASS。** issue 验收(5 案例复现 0 误报)达成 —— 机械路径(a/2/3/5)+ judge 路径(b/c/e/原 case 1/4)双双真机验过;真卡死(d dead_pin)仍准确告警;字节回退(f)成立;检测器 tick→确认层接线在构建产物里真通(c/f 经真 `HeartbeatService.check`)。

> `parseJudgeVerdict` bug 归属仍为 FLY-1048(#525),但按 Annie「一单一完整交付」+ Tadashi 决策在本单(FLY-1234)内修复,不另开单。
