# FLY-1048 Watchdog detection 剩余实现 — 实施计划

Issue: FLY-1048 (https://linear.app/geoforge3d/issue/FLY-1048/build-fly-942-watchdog-detection-剩余实现prd-fly-942排除已-ship-的-watchdog)
日期: 2026-07-09
基于: research.md(同文件夹;上游 exploration.md 缺口清单 + brainstorm gate 拍定)

> **状态:Codex design review APPROVED(2 轮,xhigh;R1 6 项全采纳:B1 spawn/stdin 合同、A4/A5 事件面与 echo 防毒、C2/C3 无-thread 语义、C4a 新旧互斥、B3 judge 降级有界、A6 readonly 合同 + FN4 诚实化)。**

> **For agentic workers:** 本 plan 供三段式 Implement 阶段照建(TDD:每任务先 RED 后 GREEN,频繁 commit)。任务用 checkbox 跟踪。1048 = 三个 PR 全落 + QA 覆盖整体才算 done(Tadashi 拍),别把 PR-A 当 done 收。

**Goal:** 按 FLY-942 PRD 落地 watchdog detection 剩余部分:① 检测准确性(三态 a/b/c、≥2 帧观察窗、错误串扩充、重复错误签名、fail-suspicious)② 分钟级 cadence(零 token gap 扫描 + 窄化取帧)③ LLM 判断层(= FLY-976,跑 Codex)④ 统一升级流(新检测类 Lead-first ~30min → @Annie)+ over-notify 抑制补齐。

**Architecture:** 全部压在现有组件上(LeadWatchdog / stuck-candidate / GatePoller piggyback / StateStore 幂等迁移 / 现有通知积木),零新进程、零新 timer;每块行为挂 env,未设 = 现状逐字节。

**Tech Stack:** TypeScript(packages/teamlead + packages/flywheel-comm 只读消费)、sql.js/StateStore 幂等迁移、vitest、真实 pane fixture。

---

## 0. 已锁决定(brainstorm gate,Tadashi 2026-07-09 拍)

| # | 裁定 | 内容 |
|---|---|---|
| D1 | scope = 4 BI 全归 1048,3-PR 切法 | PR-A 机械层+cadence / PR-B LLM 判断层 / PR-C 统一升级流+BI-4;PR-C 排最后(依赖 HL 942 PRD 阈值定稿);三 PR 全落+QA 才算 done,不拆 sibling |
| D2 | FLY-976 被 PR-B 吸收 | 便宜档、跑 Codex 不占 Claude 额度、读文字、ad-hoc 无状态、机械快路可疑才升级、不确定即 fail-suspicious 附 pane 原文;PR-B 落地后把 976 关联 1048 并关闭 |
| D3 | 统一 ~30min 流 = 增强不推倒 | 只覆盖新检测类(case-c 确认 / 漏① / 漏②-非阻塞 ask / consumed-ack 超时 / FN4 对账);FLY-637 阻塞-gate 阶梯(20min×2^n、3 轮页)、FLY-927 checkpoint-park 巡逻、FLY-915 频道管线**原样不动** |
| D4 | FN4 独立小块 | 传输层对账,不混进 pane 帧逻辑 |
| D5 | 不自建 tmux 探活 | pane-dead 真探活归 FLY-820/823;1048 只消费现有 liveness 信号(HeartbeatService / FSM / land-status) |
| D6 | consumed-ack 纳入检测目标 | 「投递了但 N 分钟未消费」作 942 契约检测输入(与 FN4 相邻) |
| D7 | 产品行为以 942 PRD 为准 | 三种失败模式(死 pane+未读 brief / 零进展 N 分 / 状态信号过期)的阈值、报 Lead 还是 founder,由 HL 更新 942 PRD;eng 对接不自定;PR-C 实现前重读 PRD、缺则 ask |

PRD 已锁常量:Lead 宽限 **~30min**(global+per-project 可配);首个 Lead 提醒 **≤~20min**;北极星 = **C 绝不漏(100%)** >> A/B;fleet 级不走 30min(915)。

---

## 1. 三个 PR 的切分与顺序

| PR | 内容 | 依赖 |
|---|---|---|
| **PR-A 机械检测层 + cadence(BI-1 机械 + BI-2)** | 错误签名表 + FrameWindow 多帧 delta + stuck-candidate 重复错误签名路 + LeadWatchdog 多帧叠加 + fail-suspicious 契约 + 廉价 gap 扫描 + 窄化取帧调度 | 无 |
| **PR-B LLM 判断层(BI-1 judge = FLY-976)** | watchdog-judge(一次性 codex exec)+ prompt/verdict 契约 + 可疑升级接线 + 审计 | PR-A(可疑态定义 + FrameWindow 输入) |
| **PR-C 统一升级流 + BI-4(BI-3 + BI-4)** | detection_escalations 耐久表 + Lead-first 通知腿 + ~30min 计时 + Lead-ACK + founder page + 两漏/consumed-ack/FN4 detector 接线 + 清理中抑制态 + fleet guard | PR-A(检测基底);PRD 三失败模式条目定稿(D7) |

每 PR 独立可 ship、独立 reverse-compat sentinel、独立 Codex code review;三 PR 攒一次 Bridge 重启部署(memory 纪律)。

---

## 2. PR-A 机械检测层 + cadence

### Task A1 错误签名表 + 归一化(纯函数)

**Files:**
- Create: `packages/teamlead/src/bridge/error-signatures.ts`
- Test: `packages/teamlead/src/bridge/__tests__/error-signatures.test.ts`

```ts
export type ErrorSignatureKind =
  | "server_error_mid_response"   // FN2 546/975
  | "not_logged_in"               // FN0 910(现 login…expired 正则漏掉)
  | "enoent_loop"                 // FN1 910 worktree 删
  | "stream_idle_timeout";        // 既有 evidence-only 串纳入同表
export interface ErrorSignatureHit { kind: ErrorSignatureKind; line: string; signature: string; }
/** 逐行匹配 + 归一化(剥时间戳/路径/数字→稳定签名,供跨帧重现比对) */
export function scanErrorSignatures(text: string): ErrorSignatureHit[];
export function normalizeErrorLine(line: string): string;
```

- 匹配串(全部大小写不敏感、词边界防误伤):`server error mid-response`、`not logged in`、`\bENOENT\b`、既有 `API Error:.*Stream idle timeout`。
- **echo 免疫约束**:归一化签名只用于内部比对,**新告警文案绝不回显原始匹配行**(防 FLY-220 型回声再分类);Lead 面告警 body 沿用「kind + 建议动作」形态(LeadWatchdog.ts:1045-1052 判例)。
- [ ] RED:FN0/FN1/FN2 真实 pane 片段 fixture(不匹配 FP 组样本)先挂
- [ ] GREEN + Commit

### Task A2 FrameWindow 多帧观察窗(纯逻辑)

**Files:**
- Create: `packages/teamlead/src/bridge/pane-frames.ts`
- Test: `pane-frames.test.ts`

```ts
export interface PaneFrame { text: string; capturedAtMs: number; }
export interface FrameWindowStore {   // 进程内存 per-target ring buffer(K=3)
  push(targetKey: string, frame: PaneFrame): void;
  window(targetKey: string): PaneFrame[];
  prune(activeKeys: ReadonlySet<string>): void;
}
export interface FrameDeltas {
  silenceDelta: boolean;        // live-region hash 跨帧不变 + 空 prompt + 帧距 ≥ minSpanMs
  repeatedErrorSig: ErrorSignatureHit | null; // 同一归一化签名跨 ≥2 帧重现(允许全文指纹在变)
  tokenFlowActive: boolean;     // 内容增长 / working-marker / spinner 行变化 → 判 a
  spanMs: number;               // 首末帧时距(单帧 => 0,调用方不得下 c 结论)
}
export function computeFrameDeltas(frames: PaneFrame[], opts: { minSpanMs: number }): FrameDeltas;
```

- live-region 提取复用 LeadWatchdog 已导出的 `liveRegion`/`ownStateRegion` 思路:**抽出共享纯函数**到可复用位置(不改 LeadWatchdog 现行为,只 re-export),runner pane 无输入框边框时 fallback 末 12 行同判例。
- 帧存储纯内存(重启丢窗口可接受,几分钟重热);**不落原始帧进 SQLite**(隐私+体积);耐久层只放通知去重标记(session_events 惯例)。
- [ ] RED:FN2(error→空框跨帧不变)/FN3(compact 后无进展)/FN1(ENOENT 变但同签名)/FP0(token 在吐)四类 delta 矩阵先挂
- [ ] GREEN + Commit

### Task A3 runner 侧 stuck-candidate 扩展(重复错误签名路 + 新错误串)

**Files:**
- Modify: `packages/teamlead/src/bridge/stuck-candidate.ts`
- Test: `stuck-candidate.test.ts` 扩展

- Episode(stuck-candidate.ts:79-107)增字段:`errorSig?: string`、`firstErrorSigAt?: number`。
- `evaluateStuckCandidate` 新路(env `FLYWHEEL_STUCK_ERRORSIG=1`,未设 = 现状字节不变):在 `output_changing` 分支**之前**查 `scanErrorSignatures(tail)`——若本帧与 prior 帧同签名且 `now - firstErrorSigAt ≥ threshold` → **CANDIDATE**(exclusion 不再挡「变但循环同错」;修 :16-20 自认的 MISS)。签名变/消失 → 重置。
- 新错误串(A1 表)命中 + 静默 delta(空 prompt + hash 不变)→ 与既有 stagnation 门合流(FN0/FN2:pane 恰好静止时现有指纹路也能到,新增串保证 kind/evidence 真话)。
- evidence 增 `errorSignature` 字段(payload 已有 evidence.tail 15 行判例,新字段 additive)。
- 硬门(gate/comm/declared-state)**保持不动**——两漏的触发语义在 PR-C 的 gap 扫描做,不在这里反转(风险清单 #1)。
- [ ] RED:FN1 滚动 ENOENT fixture(现状 = 永不 candidate)→ 新路判 candidate;FP3 长操作(慢但 token 在动)不误报;env 未设全旧测绿
- [ ] GREEN + sentinel + Commit

### Task A4 Lead 侧多帧叠加(isIdleHealthyPane 升级)

**Files:**
- Modify: `packages/teamlead/src/LeadWatchdog.ts`
- Test: `LeadWatchdog` 测试扩展 + 新 fixture

- env `FLYWHEEL_PANE_MULTIFRAME=1`(未设 = 现状单帧行为字节不变;927 Task 3.5 固化的全部 idle/throttle fixture 必须原样绿)。
- 开启时,`tickLead` 每 poll 把 `ownStateRegion(pane)` push 进 FrameWindow(targetKey = stateKey);`isIdleHealthyPane` 判 healthy **之前**加两道多帧否决:
  1. 窗口内任一帧命中 `scanErrorSignatures` → 不 healthy → 走 `pane_error_stalled` 新 kind(错误后静默 = FN2/FN0 Lead 侧等价);
  2. `silenceDelta && !tokenFlowActive` 且窗口含 thinking-residue(现 :678-682 自认盲点)→ **fail-suspicious**(Task A5),不再静默压掉。
- 新 kind **`pane_error_stalled`** 加入 `AlertEventType` union(LeadAlertNotifier.ts)——它是真实告警面 kind,必须**全面接入**该 surface(Codex R1 #2):`titleFor`/`bodyFor` 显式 case(穷举 switch)、severity、`TICKET_KINDS` 路由 + owner map(claude bot,provider 无关默认)、echo 交替组同源派生 + 双向 echo fixture。**`detection_suspicious` 不进 `AlertEventType`**(它不是告警面 kind,是 Lead 面事件;投递契约见 A5)。
- `isTransientThrottlePane`(FLY-218)优先级不变:529 瞬时限流仍在多帧否决之前短路(健康 529 绝不误报)。
- [ ] RED:FN2-lead fixture(Server error 后空框,现状 suppress)→ 开关下 must-alert;Peter ctx-100% 等全部既有 must-suppress fixture 两态(env 开/关)都 suppress;frozen-compact must-alert 不回归
- [ ] GREEN + sentinel + Commit

### Task A5 fail-suspicious 输出契约

**Files:**
- Create: `packages/teamlead/src/bridge/detection-suspicious.ts`
- Modify: 调用点(LeadWatchdog A4 / stuck-runner-detector A3 不确定分支)
- Test: 新文件测试 + 调用点断言

```ts
export interface SuspiciousReport {
  targetKind: "runner" | "lead";
  targetKey: string;            // execId 或 lead stateKey
  reason: string;               // 机械层为何拿不准(枚举 + 一句话)
  paneTail: string;             // ≤15 行(runner evidence.tail 判例);只进 Lead 面
  episodeFingerprint: string;
}
```

- 投递 = **owner Lead only**:lead_event(eventType `detection_suspicious`,加入 `GUARDRAIL_EVENT_TYPES` 重投集合)+ 该 issue thread 一条安静帖(无 mention;Lead 面允许附 paneTail,thread 帖**不附**原文只写 reason —— thread 可能被 founder 看到,沿用隐私判例)。founder 面永不带 raw pane。
- **渲染契约(Codex R1 #2)**:lead_event 的通用 formatter 只渲染已知字段(mailbox-lead-runtime.ts:292-319 / commdb-lead-runtime.ts:160-182),任意 `paneTail` 会被丢——两个 LeadRuntime 的 `formatEnvelope` 增加 `detection_suspicious` 显式分支(渲染 reason + 有界 paneTail),payload 字段显式定型(HookPayload 惯例),两侧渲染测试。
- **echo 防毒(Codex R1 #2)**:paneTail 投进 Lead pane 后会被 LeadWatchdog 重新 capture——现有 echo 剥离只认 `←` 行与 `(<leadId> / <AlertEventType>)` 签名,不认 lead_event 文本。故 paneTail 每行以固定引用前缀 `▏` 包裹投递,`scanErrorSignatures`(A1)与 `evaluateStuckCandidate` 的签名路(A3)**跳过 `▏` 前缀行**;新增 echo-poisoning fixture:投递过 suspicious 报告的 Lead pane 不得触发 `pane_error_stalled` / 二次 `detection_suspicious` 循环。
- 去重:per (targetKey, episodeFingerprint) 一次,复用 session_events UNIQUE event_id 惯例(`detection-suspicious-<fp>`)。
- **绝不静默**:judge 不可用(PR-B 前 / env 关 / fail-closed)时,A4/A3 的不确定分支一律走此路。
- [ ] RED:投递形态(lead_event + thread)/两 runtime 渲染/echo-poisoning/去重/founder 面无 pane 断言先挂
- [ ] GREEN + Commit

### Task A6 廉价 gap/state 扫描(零 token,分钟级)

**Files:**
- Create: `packages/teamlead/src/bridge/detection-gap-scan.ts`
- Modify: `packages/teamlead/src/bridge/gate-poller.ts` + `plugin.ts`(piggyback 接线)
- Test: `detection-gap-scan.test.ts` + gate-poller 测试扩展

- env `FLYWHEEL_DETECTION_GAP_SCAN=1` + `FLYWHEEL_GAP_SCAN_EVERY_N_TICKS`(默认 100 ≈ 5min @3s tick)。GatePoller 加 `onGapScanTick` 回调(仿 codex 健康探针 :381-392 范式:tickCount gating + 独立 try/catch + 零新 timer)。
- 每轮读(全部 readonly,**零 pane、零 token**):
  - StateStore sessions(active/awaiting/stage/时间戳);
  - 各 project CommDB:`runner_declared_states`、pending questions(**含 checkpoint IS NULL 的非阻塞 ask**)、`messages(from_agent=execId AND to_agent=leadId)` 最近通信、`delivered_at/read_at`。
- 产出 **SuspicionRecord**(进程内存注册表,带 firstSeenMs/kind/evidence 摘要):
  - `gap1_parked_unreported`:declared parked 或 awaiting-needs-human,且窗口内无 exec→lead 消息、无 pending question、无 founder-notified evidence;
  - `gap2_ask_unanswered`:非阻塞 ask 无 response 超 `FLYWHEEL_GAP_ASK_UNANSWERED_MS`(默认 30min);
  - `delivery_unconsumed`:`delivered_at IS NOT NULL AND read_at IS NULL AND age ≥ FLYWHEEL_GAP_UNCONSUMED_MS`(默认 30min;**仅现有证据可判的推送路径**,Lead mailbox 消费时间戳缺口按 D7 等 PRD 定稿再补,本 task 不造新回执);
  - `pane_progress_suspect`:active session stage 停滞超阈值(喂 A7 取帧,不直接告警)。
- **PR-A 内 gap 扫描不发任何用户可见告警**(检测基底;PR-C 才接升级流)——只暴露查询 API + debug 日志,便于独立验证与灰度观察。
- 判据全部纯函数(`evaluateGapSuspicion(inputs) → SuspicionRecord[]`),CommDB/Store 读取注入。
- **readonly 读取合同(Codex R1 #6)**:`CommDB.openReadonly()` 刻意跳过建表/迁移(db.ts:111-120)——A6 的 reader API 对**每张表/每列**都要照 `getEffectiveDeclaredState` 判例(db.ts:618-650)显式处理缺表/缺列(旧 comm.db 可能无 `runner_declared_states` / `delivered_at` / `read_at` / `checkpoint`):缺 → 该判据静默降级为「无信号」,绝不 throw、绝不误报;comm.db 文件缺失/readonly 打开失败 → 本轮跳过该 project(fail-closed)。reader API 作为独立模块入 plan 交付面,缺表/缺列/坏库三态测试。
- [ ] RED:判据矩阵(parked×有无 lead 通信×有无 evidence;ask 阻塞/非阻塞×答/未答×超龄;delivered/read 组合)+ reader 缺表/缺列/坏库三态先挂
- [ ] GREEN + sentinel(env 未设 = GatePoller 行为字节不变)+ Commit

### Task A7 窄化取帧调度(focused frames)

**Files:**
- Create: `packages/teamlead/src/bridge/focused-frame-scheduler.ts`
- Modify: gate-poller 接线(同 A6 的 tick 回调内)
- Test: 调度语义测试(注入 clock + capture)

- 输入 = A6 的 `pane_progress_suspect` + 1h 全舰扫标记的可疑对象;对每个可疑 target 以 `FLYWHEEL_FRAME_INTERVAL_MS`(默认 4min)间隔补帧进 FrameWindow,凑满 ≥2 帧即可跑 `computeFrameDeltas` → 明确态(c 候选 → 现有 escalation 入口 / a、b → 清除 suspicion)或不确定 → fail-suspicious(A5)/ judge(PR-B)。
- **成本闸**:每 tick 最多 `FLYWHEEL_FRAME_CAPTURES_PER_TICK`(默认 2)个 capture;同 target 冷却;capture 复用 `session-capture.ts`(每 target 每间隔一次,沿用 one-capture 契约);capture 失败 fail-closed(绝不在盲帧上下 c 结论)。
- ~1h 全舰扫(`DEFAULT_IDLE_POLL_MS`)**不改默认值**——它降级为兜底粗扫;时延契约由 gap 扫描(≤5min 发现)+ focused frames(≤2×4min 判定)承担 → **首个 Lead 提醒 ≤~20min 可达**(PR-C 接通知后成立;验收 §5)。
- [ ] RED:调度(间隔/冷却/每 tick 上限/失败 fail-closed)先挂
- [ ] GREEN + Commit

### Task A8 PR-A reverse-compat sentinel + fixture 汇总

- [ ] 全部新 env 未设 → LeadWatchdog / stuck-candidate / gate-poller 既有测试逐字绿(含 927 Task 3.5 固化 fixture)
- [ ] 新 fixture 双向表:FN0/FN1/FN2/FN3 must-detect(开关下);FP0-FP3 must-not(两态);真实 pane 样本优先,合成样本标注 follow-up 换真样本(FLY-218 判例)
- [ ] Commit

---

## 3. PR-B LLM 判断层(FLY-976 吸收)

### Task B1 watchdog-judge 一次性 codex 调用器

**Files:**
- Create: `packages/teamlead/src/bridge/watchdog-judge.ts`
- Test: `watchdog-judge.test.ts`(注入 spawn runner;不真调 codex)

- argv 模式抄 codex-resume(research §2):`[<bin>, "exec", "--json", "-C", <repoRoot>, "-s", "read-only", ("-m", <model>)?, "-"]`,prompt 走 **stdin**(零 shell 插值);bin = `FLYWHEEL_WATCHDOG_JUDGE_BIN?.trim() || FLYWHEEL_CODEX_BIN || "codex-with-fallback"`;model = `FLYWHEEL_WATCHDOG_JUDGE_MODEL`(未设不传 `-m`,用 codex 配置默认;生产配便宜档)。
- **进程原语 = 可注入 `spawn` runner,不是 `execFile`(Codex R1 #1)**:codex-resume 真身用 `spawn(..., stdio:["pipe","pipe",…])` + `child.stdin.write(prompt)` 让 prompt 不进 argv(codex-resume.ts:261-280);subscription-runner 用 execFile 是因为它 prompt 走 argv——pane 文本不可接受。B1 = 注入式 spawn runner:stdin 写 prompt、stdout 有界采集(1MB 上限,超限 kill+null)、timeout 到点 kill 进程树、fail-closed。
- 调用合同抄 subscription-claude-classifier-runner 的 **fail-closed parser 合同**(仅合同、不抄进程原语):`FLYWHEEL_WATCHDOG_JUDGE_TIMEOUT_MS` 默认 30_000;exec 错/超时/限流/JSON 解析失败/verdict 越界 → 返回 `null`,**永不 throw、永不假装成功**;子进程 env 洗 `*TOKEN*/*SECRET*/*KEY*` + 剥 GH_TOKEN 族(codex-resume :251-259 判例)。测试必须证明 **prompt 不出现在 argv 与 env**。
- **ad-hoc 无状态**:无常驻进程、无 thread/resume;并发闸 = 进程内单飞(同 target 冷却 `FLYWHEEL_JUDGE_COOLDOWN_MS` 默认 10min)+ 全局在飞上限 1(队列化,FLY-513 「别乱拉进程」注释判例)。
- [ ] RED:argv 构造(prompt 不在 argv/env)/stdin 写入/stdout 上限 kill/超时 kill/env 洗涤/解析失败矩阵先挂
- [ ] GREEN + Commit

### Task B2 prompt + verdict 契约

**Files:**
- Modify: `watchdog-judge.ts`(builder + parser)
- Test: 同文件测试扩展

- 输入(纯文字,PRD §3.2 定案):FrameWindow ≥2 帧(每帧截尾 ≤80 行)+ 帧时距 + 真实 stage/FSM 态 + park 元组(有则)+ 最近 CommDB 事件摘要(ask/park/stage,≤10 条)+ 错误签名命中。
- prompt 写清「看什么信号、卡长啥样、健康长啥样」(generic 模型 + 好 prompt,不 fine-tune);要求只输出 JSON。
- 输出 schema:`{ verdict: "a_working"|"b_parked"|"c_stuck"|"suspicious", attribution: "founder"|"lead"|"runner"|"ci"|"unknown", suggestedAction: string, rationale: string }`;strict parse(未知字段忽略,verdict 越界 = 解析失败 → null)。
- [ ] RED:schema 往返 + 恶意/畸形输出(prompt-injection 出格文本)不越界先挂
- [ ] GREEN + Commit

### Task B3 接线:机械快路可疑才升级 + 审计

**Files:**
- Modify: `focused-frame-scheduler.ts`(A7 的不确定分支)+ LeadWatchdog A4 不确定分支
- Test: 接线两侧测试扩展

- env `FLYWHEEL_WATCHDOG_JUDGE=1`(未设 = PR-A 行为:不确定一律 fail-suspicious)。
- 流:机械 delta 明确(c 候选 / a / b)→ **不调 judge**(省 token);不确定 → judge:
  - `c_stuck` → 进现有 escalation 入口(PR-A 阶段 = runner_stuck 流;PR-C 后 = 统一流),附 judge rationale 进 evidence;
  - **judge 降级有界(Codex R1 #5,护 C-绝不漏)**:
    - **高置信机械 C 信号(重复错误签名 + 空 prompt / A1 表内致命错误串命中)judge 无权降级**——这类根本不该进 judge;若仍收到 a/b verdict → 按 `suspicious` 处理(走 A5);
    - `b_parked` 必须有**机械佐证**(CommDB declared park / pending gate / awaiting_review 之一)才生效,仅凭模型 rationale → 按 `suspicious` 处理;
    - 生效的 `a_working`/`b_parked` 抑制**带 TTL**(`FLYWHEEL_JUDGE_SUPPRESS_TTL_MS` 默认 20min):TTL 内静音,到期 target 重回 suspicion 队列重评(不是关死 episode);
    - 抑制必留审计:session_events `watchdog_judge_suppressed`(payload 含 verdict/rationale/帧指纹/TTL)。
  - `suspicious` / `null`(fail-closed)→ fail-suspicious(A5),**绝不静默**。
- [ ] RED:四路(c/a/b/null)行为 + 高置信 C 不可降级 + b_parked 佐证门 + TTL 重评 + 审计行 + env 未设旁路先挂
- [ ] GREEN + sentinel + Commit

### Task B4 FLY-976 收口(流程任务)

- [ ] PR-B merge 后:Linear FLY-976 comment「被 FLY-1048 PR-B 吸收(watchdog-judge)」+ 关联 1048 + 关闭(Lead 侧动作,实现 runner 经 flywheel-comm ask 报 Tadashi 执行或授权代办)

---

## 4. PR-C 统一升级流 + BI-4

> **前置(D7)**:实现本 PR 前重读 `product/doc/FLY-942-proactive-reporting/prd.md` 的三失败模式条目(死 pane+未读 brief / 零进展 N 分 / 状态信号过期)与阈值/路由;HL 尚未更新则 `flywheel-comm ask` Tadashi,拿到前只做与 PRD 无关的地基任务(C1/C5)。

### Task C1 detection_escalations 耐久表

**Files:**
- Modify: `packages/teamlead/src/StateStore.ts`(幂等 CREATE TABLE / ADD COLUMN,FLY-267 判例)
- Test: StateStore 测试扩展

列:`target_key TEXT`(execId 或 lead key)、`kind TEXT`(检测类)、`episode_fingerprint TEXT`、`issue_id TEXT`、`owner_lead_id TEXT`、`first_detected_at_ms INTEGER`、`lead_notified_at_ms INTEGER`、`lead_ack_at_ms INTEGER`、`founder_paged_at_ms INTEGER`、`status TEXT`(NEW/LEAD_NOTIFIED/ACKED/RESOLVED/ESCALATED/CLEARING)、`attempts INTEGER DEFAULT 0`;UNIQUE `(target_key, kind, episode_fingerprint)`。新方法:`upsertDetectionEscalation` / `ackDetectionEscalation` / `getDetectionEscalationsForReconcile` / `resolveDetectionEscalationsForTarget`。跨重启存活(~30min 计时不能靠内存)。
- [ ] RED:迁移幂等 + 方法 + 旧库兼容先挂 → GREEN + Commit

### Task C2 Lead-first 通知腿(自然语言,thread + Lead inbox)

**Files:**
- Create: `packages/teamlead/src/bridge/detection-escalation.ts`
- Test: `detection-escalation.test.ts`

`notifyLeadFirst(record)`:
1. **issue thread 安静帖**(自然语言、无 mention):`emitIssueThreadInfraNotification`(mentionUserId 不传 → parse:[])。**无 thread 语义(Codex R1 #3)**:该 helper 对 missing thread 会记 `issue_thread_infra_notify_skipped` 并强制调 `onUndeliverable`(现有 caller 借此 fail-safe 进 ticket 队列,founder-thread-notifier.ts:623-633)——本腿**不要**带着 undefined thread 去调它:**pre-call guard** 先查绑定,无 thread → 不调 helper、不触发 onUndeliverable、静默跳过 thread 腿(lead_event 腿仍走);有 thread 但 POST 失败 → onUndeliverable 收口到告警队列(现状 fail-safe),Lead 腿不受影响。
2. **Lead inbox**:`appendLeadEvent(ownerLead, "detection_escalation", …)` + `runtime.deliver`;eventType 加入 `GUARDRAIL_EVENT_TYPES`(失败重投)。owner Lead = `resolveLeadForIssue`(dept label,非一律 eng —— PRD §4.5)。
3. 写 C1 行 → LEAD_NOTIFIED。
- 文案:`formatParkAlert` 同源真话模板(球在谁/真实 stage/下一步),kind 专属一句话;**不含 raw pane**(fail-suspicious 的 tail 只在 A5 的 lead_event,本腿不重复)。
- [ ] RED:两腿投递/无 thread 降级/owner 解析/文案断言先挂 → GREEN + Commit

### Task C3 ~30min 计时 + Lead-ACK + founder page

**Files:**
- Modify: `detection-escalation.ts`(reconcile)+ gate-poller 接线(piggyback,~20 tick)
- Modify: `packages/teamlead/src/bridge/stuck-remanage-routes.ts`(ACK 端点扩展)
- Test: 两侧扩展

- reconcile 每轮:`LEAD_NOTIFIED` 且 `now - lead_notified_at ≥ FLYWHEEL_DETECTION_LEAD_GRACE_MS`(默认 1_800_000 = 30min;global + per-project 可配)且无 ack → **founder page**:经 `emitIssueThreadInfraNotification`(@founder,mentionUserId = `config.discordOwnerUserId` 即 founder/Annie 的 user id,勿与 owner Lead 混淆)进该 issue thread,文案「Lead ~30min 未解决」真话模板;`founder_page_ledger` 同款防重页。**只有 page 确证送达(posted)才标 ESCALATED(Codex R1 #3)**:无 thread / POST 失败 → **不标 ESCALATED**,transient 走 helper 既有重试预算,预算烧完/永久失败 → `onUndeliverable` 收口进告警队列(绝不静默),行保持 LEAD_NOTIFIED 待下轮 reconcile 重试。
- **Lead-ACK**:扩展现有 disposition 路由(stuck-remanage-routes 判例)接受 `(target_key, kind, episode_fingerprint)` 的 ack/resolve/dismiss → ACKED/RESOLVED(Lead 自愈或 relay 都算 ACK);runner 侧状态恢复(session 进展/terminal)→ 自动 RESOLVED。
- **fleet guard**:同 kind 同窗口活跃 episode ≥ `FLYWHEEL_DETECTION_FLEET_THRESHOLD`(默认 4)→ 本流**不页 founder、不刷 Lead**,发一条聚合 ticket 进 915 队列(现有 alertSink),episode 标 ESCALATED(fleet)——PRD §4.3 边界。
- [ ] RED:30min 门/ACK 三态/防重页/fleet guard/重启恢复(耐久行接续计时)先挂 → GREEN + Commit

### Task C4a 新旧升级流互斥(interop,先于 C4 GREEN;Codex R1 #4)

**Files:**
- Modify: `detection-escalation.ts` + `packages/teamlead/src/bridge/stuck-runner-detector.ts` / `stuck-escalation.ts`(pre-emit 检查)
- Test: no-double-fire 矩阵测试

- **权威 episode key** = `(execution_id, episode_fingerprint)`(与 `stuck_dispositions` 同键);**权威去重存储 = `detection_escalations`(C1)**。
- `FLYWHEEL_DETECTION_ESCALATION=1` 时的所有权划分:case-c 类(runner 冻结/错误循环)由**统一流独家**通知——`stuck-runner-detector` 在 emit `runner_stuck_escalation` / Q7 `runner_stuck_unhandled` **之前**查 `detection_escalations` 活跃行,存在 → 跳过旧 emitter(旧 lead_event/Q7/ticket 不再发);`runner_throttle_stalled` 的 kind 细分保留(统一流沿用该 kind 语义)。env 未设 → 旧路径逐字不变。
- ACK/resolution 镜像:Lead 对旧 `stuck_dispositions` 的处置(既有 route)同步映射到 `detection_escalations`(ACKED/RESOLVED),反向亦然——单一事实源为 `detection_escalations`,`stuck_dispositions` 保持兼容读写(不迁移旧行)。
- [ ] RED:no-double-fire 矩阵(`runner_stuck_escalation` / `runner_stuck_unhandled` / `runner_throttle_stalled` / `detection_stuck_confirmed` × env 开/关 × episode 活跃/无)+ `alert_threads`/`founder_page_ledger` 不重复行先挂
- [ ] GREEN + sentinel + Commit

### Task C4 detector 接线:case-c + 两漏 + consumed-ack + FN4

**Files:**
- Modify: `detection-gap-scan.ts`(A6 SuspicionRecord → escalation)+ `focused-frame-scheduler.ts`(c 候选 → 统一流)
- Test: 端到端(注入 clock)场景表

- env `FLYWHEEL_DETECTION_ESCALATION=1`(未设 = A6/A7 只观测不通知,现状告警路径不变)。
- 映射(kind 名与阈值**按 D7 与 PRD 定稿对齐**,以下为草案):
  - case-c 确认(A7/B3 判 c)→ `detection_stuck_confirmed`(与既有 runner_stuck 流的关系:env 开启时 c 类走统一流,旧 Q7 路径由同一 episode 去重抑制,不双发);
  - 漏① → `runner_parked_unreported`;漏② → `lead_ask_unanswered`;
  - consumed-ack → `delivery_unconsumed`(D6);
  - **FN4 传输对账(D4 独立小块;范围诚实化,Codex R1 #6)**:本 PR 只对账**今天存在的投递证据**——`lead_events`(delivery_attempts 耗尽 / delivered_at NULL 超龄)+ CommDB delivered/read 超龄 + founder-thread `onUndeliverable` 结果 → `delivery_failed_reconcile`;**不碰 pane 帧逻辑**。⚠️ 574 原事故的「Lead 起草了但从未发出」(draft-intent)今天**没有任何 durable 意图记录**可对账——真 draft-intent 对账 = 显式 follow-up(需先造「意图发 X」的落盘面),本 PR 的 FN4 验收范围限定为「已知投递尝试的失败/未消费不再静默」。
- R1 静默判例:parked 等 founder 且正常路径已处理(有 founder-notified evidence / Lead 已回)→ **绝不触发**(验收 R1)。
- [ ] RED:R1-R4 场景表 + 每 kind 触发/不触发矩阵先挂 → GREEN + sentinel + Commit

### Task C5 BI-4:清理中抑制态 + ghost 不 re-alert

**Files:**
- Modify: `detection-escalation.ts` + 消费点(RunnerIdleWatchdog / stuck-runner-detector 的 emit 前查询)
- Test: 扩展

- `CLEARING` 状态:episode 进入清理(close-runner / reap / Lead dismiss-with-cleanup)→ 标 CLEARING,**所有检测类对该 target 静音**直至 terminal(→RESOLVED)或清理超时(`FLYWHEEL_CLEARING_TTL_MS` 默认 2h,超时回 NEW 可再报——防清理烂尾永久静音);ESCALATED 态绝不 re-alert(治 FLY-970 死着刷 session_stuck)。
- ghost 判定**只消费**现有 liveness 信号(HeartbeatService orphan/reap、FSM terminal)——不自建 tmux 探活(D5)。
- [ ] RED:CLEARING 静音/TTL 回弹/ESCALATED 不重发先挂 → GREEN + Commit

---

## 5. 验收矩阵(PRD §7 全量,QA 阶段照跑)

| 组 | 用例 | 验收 |
|---|---|---|
| FN(真态 c,**100% 不漏**) | FN0 910 auth(Not logged in 空框)/ FN1 910 ENOENT 循环 / FN2 546/975 error-then-idle / FN3 837 compact 静默 / FN4 574 draft-not-sent(范围 = C4 诚实化:已知投递尝试的失败/未消费;draft-intent = follow-up) | 开关全开下全部判 stuck/对账触发;fixture 双向;fail-suspicious 兜底路径可证 |
| FP(可容忍,不误报) | FP0 长 draft turn / FP1 23min 长 turn / FP2 零 commit 只读 / FP3 慢长操作 | 两态(env 开/关)均不告警;token-flow/observation-window 护 |
| R(汇报) | R1 parked 已处理→静默 / R2 漏①→提醒 Lead / R3 漏② 30min→@Annie / R4 case-c Lead-first 30min→@Annie | C4/C3 场景表 |
| 时延契约(BI-2 验收,写死在测试注释) | 廉价 gap 检测 ≤ gap-scan 周期(默认 ~5min);pane case-c 判定 ≤ 发现 + 2×帧间隔(默认 ≤ ~13min);首个 Lead 提醒 ≤ ~20min;founder ≤ +30min | 注入 clock 断言 max 时延 |
| 抑制 | 同 episode 不重发;CLEARING 静音;fleet ≥K 不走 30min;去重跨重启(耐久表) | C3/C5 |
| 字节兼容 | 全部新 env 未设 = 现状逐字(每 PR sentinel) | A8 + 各 task |

## 6. 部署 / 灰度(三 PR 攒一次重启)

1. **Ship 全关**:三 PR merge,所有新 env 未设 → 逐字现状。
2. **配置 + 一次 Bridge 重启**(先改 `~/.flywheel/.env` 再重启,launchd KeepAlive 教训):灰度顺序 ① `FLYWHEEL_DETECTION_GAP_SCAN=1` + `FLYWHEEL_PANE_MULTIFRAME=1` + `FLYWHEEL_STUCK_ERRORSIG=1`(纯观测+机械检测)→ 观察 1 天噪音 → ② `FLYWHEEL_WATCHDOG_JUDGE=1` → ③ `FLYWHEEL_DETECTION_ESCALATION=1`(通知面,最后开)。
3. **独立真机 QA(529 Room)**:FN/FP fixture 注入 + R1-R4 真 Discord 断言 + 生产目录零污染 snapshot;QA 覆盖**三 PR 整体**(D1:整体 done 才算 done)。
4. **Annie 确认项**(Tadashi 递):新检测类首次开启的噪音预期 + 30min 阈值沿用 PRD 值 + judge 跑 Codex 的额度占用说明。

## 7. Out of scope(不碰清单)

tmux 真探活/ghost ground-truth(FLY-820/823);FLY-637 阶梯、FLY-927 巡逻、FLY-915 频道管线逻辑(仅消费/挂缝);tool-call-leak(FLY-941);ghost 清理执行/scope 归属(970/973/962/978);mid-turn hard-stop;持久显示(964);auto-QA-spawn gate(579/707);mailbox 消费时间戳的全面回执改造(仅按 PRD 定稿做最小可判增量);`DEFAULT_IDLE_POLL_MS` 默认值(保 1h 兜底)。

## 8. 风险与缓解(承 research §6)

| 风险 | 缓解 |
|---|---|
| 两漏触发语义反转 → Lead spam | 判据要求「无 Lead 通信证据」多重与门;PR-A 只观测、PR-C 才通知;灰度先观测 1 天;去重+耐久 episode |
| 新 kind 回声风暴(FLY-220 家族) | kind 进 AlertEventType union(echo 同源派生);文案不回显匹配串;每 kind 双向 echo fixture |
| judge 误压真卡(违反 C 绝不漏) | 只对「机械已可疑」可压;压必留 session_events 审计;fail-closed → fail-suspicious;冷却+单飞防抖 |
| codex 额度/进程失控 | ad-hoc 单飞 + 冷却 + 每 tick 上限;FLYWHEEL_WATCHDOG_JUDGE=0 一键回 PR-A 行为 |
| 多帧改动破坏 FLY-193/218 静音 | 全部既有 fixture 两态断言;多帧仅 env 开启叠加 |
| PRD 三失败模式未定稿阻塞 PR-C | C1/C5 地基先行;阈值/路由字段化(env + 常量表),PRD 定稿后纯配置对齐;缺则 ask Tadashi |
| 重启丢内存窗口/suspicion | 通知去重与 30min 计时全在耐久表(C1);窗口/嫌疑重热 ≤ 一个 gap-scan 周期 |
