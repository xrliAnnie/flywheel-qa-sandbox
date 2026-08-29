# QA Report: FLY-307 Bridge GatePoller Wedge Fix — Independent Validation

**Issue**: FLY-312 (QA: independent validation + E2E — FLY-307 Bridge GatePoller wedge fix, PR #288)
**Date**: 2026-06-17
**Validated commit**: `origin/flywheel-FLY-307 @ 17cf4fd3` (== PR #288 head, clean worktree, dist 与 src 同步)
**QA owner**: runner-3e5580ac (independent — 未参与 FLY-307 实现)
**Verdict**: ✅ **PASS — GO for FLY-307 deploy**(无 bug)

> 独立性声明:本次 QA 未修改任何实现代码。全程在隔离环境验证(隔离 test Bridge :19873 / slot 3,临时 CommDB + 临时 HOME + 临时 StateStore)。**生产 Bridge(:9876)、slot 1(FLY-309)、slot 2(FLY-310)、真实密钥全程未触碰。**

---

## 1. What was validated

FLY-307 修今天(2026-06-17)~10 分钟 Discord 全断事故的根因:Bridge `GatePoller` 100% CPU 卡死、主循环挂死,launchd `KeepAlive` 只重启 crash 不重启 hang。三层修复:

| Layer | 机制 | 边界 |
|-------|------|------|
| **A** stale-gate evict | 完成态 session 的 `gate_question` 经 `resolveGate(qid,0)` 驱逐,`getPendingQuestions` 永久不再返回(停止每 3s 热轮询 + sql.js `getSession` churn) | 仅 `gate_question`(checkpoint!=null);`runner_question`(checkpoint==null)必须存活(FLY-161) |
| **B** per-lead circuit breaker | 某 lead 连续 N 次 poll 失败 → 冷却跳过(relay + misroute patrol 都跳),一个坏 lead 不拖垮整个 poller | clean pass 重置;`FLYWHEEL_GATEPOLLER_CIRCUIT=0` 旁路 |
| **C** BridgeEventLoopWatchdog | worker 线程 + `BigInt64Array` 共享内存观测主循环心跳,stall > 60s → `SIGKILL` 自身 → KeepAlive 重启(把 hang 变成可恢复的 crash) | 默认 ON;`FLYWHEEL_BRIDGE_WATCHDOG=0` kill-switch;`VITEST` 下在 `startBridge()` 边界自动关 |

---

## 2. Results summary

| 验证项 | 结果 | 关键证据 |
|--------|------|----------|
| dev 单测独立重跑 (gate-poller 16 + watchdog 10 + misroute 12) | ✅ 38/38 | watchdog #10 = 真子进程 SIGKILL(POSIX) |
| E2E1 重现事故 + 驱逐 + CPU 有界 | ✅ PASS | 死 gate poll#1 驱逐;500 poll 死 gate 零 churn;CPU 0.68ms/poll |
| E2E2 watchdog SIGKILL → KeepAlive 重启(事故缺的自恢复) | ✅ PASS | 2717ms 内 SIGKILL + forensic line;重启后健康复活 |
| E2E3 per-lead 熔断 + 隔离 + 重置 + kill-switch | ✅ PASS | 3 连败开、冷却跳过、健康 lead 每 poll 被服务、probe 重置、=0 旁路 |
| E2E4 边界(FLY-161 runner_question 不被驱逐) | ✅ PASS | gate 驱逐 / ask 存活 30 poll、TTL 未动、仍 relay |
| E2E5 watchdog 不误报(busy-but-loop-turning) | ✅ PASS | 7s 高 CPU(心跳推进)未被杀,exit 0 |
| slot3 Discord smoke(Annie 视角 outage→恢复) | ✅ PASS | 真 startBridge :19873;真 watchdog SIGKILL(exit 137);#ops-lead-test 3 条消息全 200 |

---

## 3. Evidence detail

### 3.1 dev 单测独立重跑(38/38)
`vitest run` on `gate-poller.test.ts` + `bridge-event-loop-watchdog.test.ts` + `gate-poller.misroute.test.ts` → **38 passed**。覆盖 FLY-307 关键 Case:8(驱逐)、8b(二次 poll 静默,无 getSession)、8c(写失败 → 退避重试)、8d(runner_question 边界)、10/10b/10c/10d(熔断开/重置/kill-switch/patrol 同 tick 跳)、watchdog `isLoopStalled` 边界 + 真跨线程 stall + 真子进程 SIGKILL。

### 3.2 E2E1 — 重现 2026-06-17 事故并证明修复(`harness/e2e1-wedge-repro.mjs`)
造 2 个完成态 session(execution_id 取 `d0ea9175…` 镜像事故)的 `gate_question`(镜像 qid 9d450c0b/2c5835eb)+ 1 个 active session 的 healthy gate。真 GatePoller:
```
pending before poll#1: 3 (2 stale + 1 live)
[GatePoller] evicting stale gate_question qid=71ad3ad0…: source session terminal
[GatePoller] evicting stale gate_question qid=513383e8…: source session terminal
pending after poll#1: 1 (live 存活)
--- 500 additional polls ---
getSession calls during 500 polls: 500  (= 1/poll = 仅 live gate;死 gate 贡献 0)
CPU used: 340.0ms  wall: 274.8ms  -> CPU/poll: 0.680ms
```
**结论**:死 gate poll#1 即被永久驱逐,后续零 `getSession` churn、CPU 有界(无热循环)。事故前态为:这 2 个死 gate 在 48h TTL 内每 3s 被重新轮询 = 2 calls/poll × ~28800 poll/day。修复把它降为一次性。

### 3.3 E2E2 — 缺失的自恢复(`harness/e2e2-watchdog-restart.mjs` + `watchdog-child.mjs`)
真 `BridgeEventLoopWatchdog`(production path,`testMode:false` 真 SIGKILL),阈值降到 2s(生产 60s)做快代理:
```
[phase 1] child exited: code=null signal=SIGKILL after 2717ms   ← worker 线程杀挂死进程
forensic stall line: {"event":"bridge_event_loop_stall","stall_age_ms":2040,"threshold_ms":2000,...}
[phase 2] relaunched child: code=0 signal=null — RECOVERED ALIVE   ← KeepAlive 重启后健康
```
**结论**:hang → 可恢复 crash → 重启,正是事故当时缺失、需手动 kickstart 的那一环。

### 3.4 E2E3 — per-lead 熔断隔离(`harness/e2e3-circuit.mjs`)
2 lead(ops 注入抛错 / product 健康),threshold=3 cooldown=5:
```
poll | ops invoked | product invoked
 1-3 |     1       |      1      ← 累计失败
 4-7 |     0       |      1      ← ops 熔断冷却被跳过;product 每 poll 仍被服务
  8  |     1       |      1      ← probe
```
+ probe 成功后重置(lead 恢复正常服务);+ `FLYWHEEL_GATEPOLLER_CIRCUIT=0` 时失败 lead 每 poll 仍被调(旁路验证)。**结论**:一个坏 lead 不拖垮整个 poller。

### 3.5 E2E4 — FLY-161 边界(`harness/e2e4-boundary.mjs`)
同一完成态 session 同时有 `gate_question` 与 `runner_question`:
```
gate_question EVICTED (gone from pending)
runner_question SURVIVES after 30 polls
runner_question TTL untouched (expires_at 2026-06-20 23:20:48) — resolveGate(qid,0) 从未施于它
runner_question relayed to Lead (30x) — 可答
```
**结论**:驱逐是外科手术式的,Annie 仍能回答完成态 Runner 的 ask(FLY-161 不回归)。

### 3.6 E2E5 — watchdog 不误报(`harness/e2e5-no-misfire.mjs`)
真 watchdog 阈值 2s,7s 高 CPU 但拆成 30ms 让步块(心跳持续推进):
```
[child] SURVIVED busy load — no misfire
child exited: code=0 signal=null after 7119ms
```
**结论**:busy-but-loop-turning ≠ stall,不误杀健康但繁忙的 Bridge。

### 3.7 slot3 Discord smoke — Annie 视角(`harness/smoke-supervisor.sh` + `smoke-bridge.mjs`)
隔离真 `startBridge` 跑 :19873(slot 3),日志确认 `[Bridge] EventLoopWatchdog started`。KeepAlive 监督脚本驱动完整周期,并经 slot3 bot 在 #ops-lead-test 叙事:
```
🟢 UP on :19873 (slot 3) — relay serving        (Discord http=200)
🔴 event loop FROZEN — /health 超时, relay DOWN  (Discord http=200)   ← 客观事故证据
bridge #1 exit status: 137 (SIGKILL)            ← 真 watchdog 杀真 Bridge
forensic: {"event":"bridge_event_loop_stall","stall_age_ms":5041,"threshold_ms":5000}
PID before kill: 15584  →  after restart: 17518 (changed: YES)
🟢 AUTO-RECOVERED — /health green, relay RESTORED (Discord http=200)
```
测试阈值降到 5s(生产 60s)。**说明**:三条频道消息由 slot3 bot 经 REST 发出(叙事可见化);Bridge 真实死亡/恢复由 `/health`(冻结期超时 / 恢复 200)+ exit 137 + forensic line + PID 变更客观证明。

---

## 4. Boundaries & honesty notes

- 测试用降低的 watchdog 阈值(2–5s)做生产 60s 的**快代理**——阈值是 `FLYWHEEL_BRIDGE_WATCHDOG_STALL_MS` 读入,逻辑同构。E2E5 证明降阈值不影响"busy 不误报"的判据。
- E2E2 是 watchdog 自恢复的**严谨 gate**(真 SIGKILL + KeepAlive 重启);slot3 smoke 是**给 Annie 看的用户视角演示**(真 Bridge + 真 watchdog + 真 Discord 频道),两者互补。
- smoke 的 #ops-lead-test 叙事消息由 slot3 bot 发(透明标注);未走 `/api/chat-threads/send`(FLY-162 thread-gated,配置繁琐且非 FLY-307 改动面)。Bridge relay 的中断/恢复以 `/health` 客观证明。

---

## 5. How to reproduce

> **Note**: FLY-307 (PR #288) is now **merged to main** (`2b7a6100`), and its
> worktree was cleaned up. The harness therefore defaults to the **main repo**
> teamlead dist; override with `FLY307_DIST=<path>/packages/teamlead/dist`.

```bash
# 0) build the teamlead dist if needed (main repo, FLY-307 merged)
cd /Users/xiaorongli/Dev/flywheel && pnpm --filter @flywheel/teamlead build   # or: cd packages/teamlead && pnpm build

# 1) dev unit suites (independent re-run)
cd /Users/xiaorongli/Dev/flywheel/packages/teamlead
./node_modules/.bin/vitest run \
  src/__tests__/gate-poller.test.ts \
  src/__tests__/bridge-event-loop-watchdog.test.ts \
  src/__tests__/gate-poller.misroute.test.ts

# 2) real-component E2E (copy the appendix scripts out to a work dir, then:)
ln -sfn /Users/xiaorongli/Dev/flywheel/packages/teamlead/node_modules ./node_modules
node e2e1-wedge-repro.mjs
node e2e3-circuit.mjs
node e2e4-boundary.mjs
node e2e2-watchdog-restart.mjs
node e2e5-no-misfire.mjs

# 3) slot3 Discord smoke (needs TEST_BOT_TOKEN_3 in ~/.flywheel/.env)
bash smoke-supervisor.sh
```

---

## 6. Codex code-review gate (FLY-310-style, on the QA harness itself)

Per Lead instruction (FLY-310/#287 had Codex catch 4 real false-PASS/isolation
bugs in the QA scripts), this QA harness went through the same adversarial Codex
gate. **3 rounds → APPROVED.** Codex's findings were harness-quality defects
(weak/incorrect assertions, isolation hygiene) — **none invalidated the FLY-307
verdict**; the core assertions (gate evicted, runner_question survives, TTL
untouched, watchdog SIGKILL→restart, CPU bounded) were sound throughout.

| Round | Finding | Severity | Resolution |
|-------|---------|----------|------------|
| R1 | **E2E4 false-PASS**: relay condition `env?.event?.type === "runner_question" \|\| true` checked a non-existent field (`event.type`; real field is `event.event_type`) AND `\|\| true` made it moot → counted ANY delivery as a relay | HIGH | Capture `event.event_type`; assert `runner_question` relayed ≥1x AND `gate_question` relayed 0x (evicted pre-delivery). Re-run: runner_question 30x, gate 0x ✓ |
| R1 | **smoke-supervisor isolation**: no check that :19873 was free before launch → could hit a stray bridge | MED | Added isolation guard (reject prod 9876 / slot1 19871 / slot2 19872; abort if `lsof :19873` LISTENing) |
| R1 | **hardcoded `flywheel-FLY-307` dist path** (now-deleted worktree) | LOW | Parameterized via `FLY307_DIST`, default = main repo dist |
| R2 | isolation guard **not fail-closed** (cleanup `rm -f` ran before the port check) | MED | Moved the guard BEFORE any file mutation — occupied-port run now touches nothing |
| R2 | `SMOKE RESULT: PASS` possible even if the OUTAGE post (HC2) failed (only HC1/HC3 asserted) | LOW | Final assertion now requires HC1 && HC2 && HC3 all delivered |
| R3 | — | — | Both R2 fixes confirmed → **VERDICT: APPROVED** |

After every fix, all 5 real-component E2E + the slot3 Discord smoke were re-run
against the **merged** FLY-307 code (main repo dist) → all PASS. Codex review
thread: `019ed8c3-22eb-7a32-9392-389c98267edd` (round 1/2). Machine-readable
result: `.flywheel/runs/<exec>/codex/code-review.json` (status APPROVED, rounds 3).

---

## Appendix: harness source (embedded — markdown, not linted; copy out to run)

> One-time QA scripts, embedded here as the QA record (not committed as repo
> biome source). To run: copy to a work dir, `ln -sfn <main-repo>/packages/teamlead/node_modules ./node_modules`,
> and (optionally) set `FLY307_DIST`. See §5.

### `e2e1-wedge-repro.mjs`

```js
/**
 * FLY-312 E2E1 — INDEPENDENT QA of FLY-307 layer A (stale-gate eviction).
 *
 * Reproduces the 2026-06-17 incident: completed-session gate_questions
 * (mirroring qids 9d450c0b / 2c5835eb from session d0ea9175) that the old
 * GatePoller re-polled every 3s for up to 48h (TTL) — log spam + constant
 * sql.js getSession() churn that, combined with a WASM trap, pegged CPU.
 *
 * PASS criteria (all must hold):
 *   1. After poll #1 the stale gate_questions are EVICTED from CommDB
 *      (getPendingQuestions returns []).
 *   2. getSession() churn STOPS: called only while the gate is live (poll #1),
 *      then 0 for the rest of the run — no per-tick re-poll of a dead gate.
 *   3. CPU stays BOUNDED across many polls (no hot-loop peg).
 *   4. Contrast: a healthy ACTIVE-session gate keeps being relayed (control
 *      proves the poller still does its real job; eviction is targeted).
 *
 * Uses REAL components: better-sqlite3 CommDB + sql.js StateStore + the real
 * compiled GatePoller from the FLY-307 dist. No mocks of the code under test.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TL = process.env.FLY307_DIST || "/Users/xiaorongli/Dev/flywheel/packages/teamlead/dist";
const { StateStore } = await import(`${TL}/StateStore.js`);
const { GatePoller } = await import(`${TL}/bridge/gate-poller.js`);
const { defaultGetCommDbPath } = await import(`${TL}/bridge/session-capture.js`);
const { RuntimeRegistry } = await import(`${TL}/bridge/runtime-registry.js`);
const { CommDB } = await import("flywheel-comm/db");

const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("  ✓", m);

const PROJECT = "fly312-e2e1";
const originalHome = process.env.HOME;
const tmpHome = join(tmpdir(), `qa-fly307-e2e1-${process.pid}`);
mkdirSync(tmpHome, { recursive: true });
process.env.HOME = tmpHome;
// keep the circuit out of the way for this scenario
process.env.FLYWHEEL_GATEPOLLER_CIRCUIT = "0";

const projects = [{
  projectName: PROJECT,
  projectRoot: "/tmp/fly312-e2e1-root",
  leads: [{ agentId: "ops-lead", chatChannel: "chat-ops", match: { labels: ["ops"] } }],
}];

const dbPath = defaultGetCommDbPath(PROJECT);
const seed = new CommDB(dbPath);

// --- a real terminal (completed) session, mirroring incident session d0ea9175 ---
const DEAD_SESSION = "d0ea9175-dead-4000-9000-completedsess";
const ACTIVE_SESSION = "aaaa1111-live-4000-9000-runningsess0";
const store = await StateStore.create(":memory:");
store.upsertSession({
  execution_id: DEAD_SESSION, issue_id: "FLY-INC-1", project_name: PROJECT,
  status: "completed", issue_labels: JSON.stringify(["ops"]),
});
store.upsertSession({
  execution_id: ACTIVE_SESSION, issue_id: "FLY-INC-2", project_name: PROJECT,
  status: "running", issue_labels: JSON.stringify(["ops"]),
});

// instrument getSession to count churn (does NOT change behavior)
let getSessionCalls = 0;
const realGetSession = store.getSession.bind(store);
store.getSession = (id) => { getSessionCalls++; return realGetSession(id); };

// two stale gate_questions from the dead session (mirror 9d450c0b / 2c5835eb)
const staleQid1 = seed.insertQuestion(DEAD_SESSION, "ops-lead", "stale gate A (mirrors 9d450c0b)", { checkpoint: "approve_to_ship" });
const staleQid2 = seed.insertQuestion(DEAD_SESSION, "ops-lead", "stale gate B (mirrors 2c5835eb)", { checkpoint: "brainstorm" });
// one healthy gate from the active session (control — must keep flowing)
const liveQid = seed.insertQuestion(ACTIVE_SESSION, "ops-lead", "live gate from running session", { checkpoint: "approve_to_ship" });
seed.close();

// recording runtime so we can see the live gate get relayed
let relayCount = 0;
const runtime = {
  type: "stub",
  async deliver(env) { relayCount++; return { delivered: true }; },
  async sendBootstrap() {}, async health() { return { status: "healthy", lastDeliveryAt: null, lastDeliveredSeq: 0 }; }, async shutdown() {},
};
const registry = new RuntimeRegistry();
registry.register(projects[0].leads[0], runtime);

const poller = new GatePoller({
  pollIntervalMs: 999999, projects, store, runtimeRegistry: registry,
  circuitThreshold: 9999, // disabled-ish for this scenario
});

const pendingFor = (lead) => {
  const ro = CommDB.openReadonly(dbPath);
  try { return ro.getPendingQuestions(lead); } finally { ro.close(); }
};

console.log("== FLY-312 E2E1: stale completed-session gate hot-loop eviction ==");
console.log(`  seeded stale qids: ${staleQid1.slice(0,8)} / ${staleQid2.slice(0,8)} (session ${DEAD_SESSION.slice(0,8)} = completed)`);
console.log(`  live qid: ${liveQid.slice(0,8)} (session ${ACTIVE_SESSION.slice(0,8)} = running)`);

const before = pendingFor("ops-lead");
console.log(`  pending before poll#1: ${before.length} (expect 3: 2 stale + 1 live)`);
before.length === 3 ? ok("3 pending questions present before fix runs") : fail(`expected 3 pending, got ${before.length}`);

// ---- poll #1 ----
await poller.poll();
const afterChurn1 = getSessionCalls;
const after1 = pendingFor("ops-lead");
console.log(`  pending after poll#1: ${after1.length} (expect 1: only the live gate survives)`);
console.log(`  getSession calls during poll#1: ${afterChurn1}`);
const remainIds = after1.map((q) => q.id);
const staleGone = !remainIds.includes(staleQid1) && !remainIds.includes(staleQid2);
const liveSurvives = remainIds.includes(liveQid);
staleGone ? ok("both stale completed-session gates EVICTED from CommDB") : fail("stale gates still pending after poll#1");
liveSurvives ? ok("live active-session gate SURVIVES (eviction is targeted, not blanket)") : fail("live gate wrongly evicted");
relayCount >= 1 ? ok(`live gate relayed to Lead (relayCount=${relayCount}) — poller still does its job`) : fail("live gate never relayed");

// ---- churn / CPU bounded over many polls ----
const churnBeforeLoop = getSessionCalls;
const POLLS = 500;
const cpu0 = process.cpuUsage();
const wall0 = process.hrtime.bigint();
for (let i = 0; i < POLLS; i++) await poller.poll();
const cpu1 = process.cpuUsage(cpu0);
const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6;
const churnInLoop = getSessionCalls - churnBeforeLoop;
const cpuMs = (cpu1.user + cpu1.system) / 1000;

console.log(`  --- ${POLLS} additional polls ---`);
console.log(`  getSession calls during ${POLLS} polls: ${churnInLoop}`);
console.log(`  CPU used: ${cpuMs.toFixed(1)}ms  wall: ${wallMs.toFixed(1)}ms  -> CPU/poll: ${(cpuMs/POLLS).toFixed(3)}ms`);

// After eviction, the dead gates are gone; only the live gate triggers getSession each poll.
// The KEY anti-wedge property: dead gates contribute ZERO churn after poll#1.
// live gate = 1 getSession/poll (expected, real work). dead gates = 0.
const churnPerPoll = churnInLoop / POLLS;
churnPerPoll <= 1.01
  ? ok(`getSession churn bounded at <=1/poll (${churnPerPoll.toFixed(3)}) — dead gates add ZERO churn (pre-fix would be 3/poll for 48h)`)
  : fail(`getSession churn ${churnPerPoll.toFixed(3)}/poll — dead gates still churning`);
// CPU must stay tiny — a hot-loop wedge would peg this.
cpuMs / POLLS < 5
  ? ok(`CPU bounded at ${(cpuMs/POLLS).toFixed(3)}ms/poll — NO hot-loop CPU peg`)
  : fail(`CPU ${(cpuMs/POLLS).toFixed(3)}ms/poll too high — possible hot-loop`);

// final pending state stable (live gate only)
const finalPending = pendingFor("ops-lead");
finalPending.length === 1 && finalPending[0].id === liveQid
  ? ok("final CommDB state stable: only the live gate remains pending")
  : fail(`final pending unexpected: ${finalPending.length}`);

store.close();
process.env.HOME = originalHome;
rmSync(tmpHome, { recursive: true, force: true });
console.log(process.exitCode ? "\nE2E1 RESULT: FAIL" : "\nE2E1 RESULT: PASS");
```

### `e2e2-watchdog-restart.mjs`

```js
/**
 * FLY-312 E2E2 — INDEPENDENT QA of FLY-307 layer C (event-loop self-watchdog
 * → auto-restart). This is the auto-recovery that was MISSING during the
 * 2026-06-17 outage: a hung Bridge sat dead for ~10 min until a manual
 * kickstart, because launchd KeepAlive only restarts a CRASHED process.
 *
 * Reproduces the full outage→recovery cycle:
 *   1. Spawn a child running the REAL watchdog, then FREEZE its event loop.
 *   2. Assert the watchdog's worker thread SIGKILLs the hung child (hang→crash).
 *   3. Assert a forensic stall line was written.
 *   4. "KeepAlive" relaunch a healthy child → assert it comes back ALIVE
 *      (exit 0, prints RECOVERED) == relay restored.
 *
 * Low thresholds via env so the test runs in seconds (production = 60s).
 */
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("  ✓", m);

const CHILD = join(import.meta.dirname, "watchdog-child.mjs");
const logPath = join(tmpdir(), `qa-fly307-wd-${process.pid}.log`);
const wdEnv = {
  ...process.env,
  FLYWHEEL_BRIDGE_WATCHDOG_STALL_MS: "2000",
  FLYWHEEL_BRIDGE_WATCHDOG_CHECK_MS: "200",
  FLYWHEEL_BRIDGE_WATCHDOG_HEARTBEAT_MS: "200",
  FLYWHEEL_BRIDGE_WATCHDOG_LOG: logPath,
};

function run(mode, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD], { env: { ...wdEnv, MODE: mode } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; process.stdout.write(`   [${mode}] ${d}`); });
    child.stderr.on("data", (d) => { out += d; });
    const killer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const t0 = Date.now();
    child.on("exit", (code, signal) => { clearTimeout(killer); resolve({ code, signal, out, ms: Date.now() - t0 }); });
  });
}

console.log("== FLY-312 E2E2: event-loop stall → watchdog SIGKILL → KeepAlive restart ==");
console.log(`  watchdog: stall=2000ms check=200ms (production=60s); forensic log=${logPath}`);

// --- 1+2: stall → SIGKILL ---
console.log("\n  [phase 1] freeze a live Bridge child and watch the watchdog kill it");
const stalled = await run("stall");
console.log(`  child exited: code=${stalled.code} signal=${stalled.signal} after ${stalled.ms}ms`);
stalled.signal === "SIGKILL"
  ? ok("hung child was SIGKILLed by the watchdog worker thread (hang → recoverable crash)")
  : fail(`expected SIGKILL, got code=${stalled.code} signal=${stalled.signal}`);
!stalled.out.includes("busy-wait ended")
  ? ok("process died DURING the freeze (before the busy-wait could finish) — not a normal exit")
  : fail("busy-wait completed — watchdog did not kill in time");
// stall detected in ~ (stall threshold + check interval), well under the 6s freeze
stalled.ms < 5000
  ? ok(`killed in ${stalled.ms}ms (≈ threshold 2s + check) — fast detection`)
  : fail(`kill took ${stalled.ms}ms — slower than expected`);

// --- 3: forensic log ---
let logTxt = "";
try { logTxt = readFileSync(logPath, "utf8"); } catch {}
logTxt.includes("bridge_event_loop_stall")
  ? ok(`forensic stall line written: ${logTxt.trim().split("\n").pop()}`)
  : fail("no forensic stall line in the watchdog log");

// --- 4: KeepAlive relaunch comes back healthy ---
console.log("\n  [phase 2] KeepAlive relaunch → prove the Bridge comes back");
const recovered = await run("recovered");
console.log(`  relaunched child exited: code=${recovered.code} signal=${recovered.signal} after ${recovered.ms}ms`);
recovered.code === 0 && recovered.signal === null
  ? ok("relaunched child ran cleanly (exit 0, NOT killed) — Bridge recovered")
  : fail(`relaunch unhealthy: code=${recovered.code} signal=${recovered.signal}`);
recovered.out.includes("RECOVERED ALIVE")
  ? ok("relaunched child reported RECOVERED ALIVE — relay would be restored")
  : fail("relaunched child never reported recovery");

try { rmSync(logPath, { force: true }); } catch {}
console.log(process.exitCode ? "\nE2E2 RESULT: FAIL" : "\nE2E2 RESULT: PASS");
```

### `e2e3-circuit.mjs`

```js
/**
 * FLY-312 E2E3 — INDEPENDENT QA of FLY-307 layer B (per-lead circuit breaker).
 *
 * A single lead whose poll keeps failing (mirroring a poisoned sql.js heap for
 * that lead's project DB) must NOT wedge the whole poller. After N consecutive
 * failures the lead is skipped for a cooldown; OTHER leads keep being served;
 * a clean probe poll resets the breaker.
 *
 * PASS criteria:
 *   1. Breaker OPENS after exactly circuitThreshold consecutive failures.
 *   2. During cooldown the failing lead is SKIPPED (its runtime is not invoked).
 *   3. The healthy lead is served on EVERY poll throughout (isolation).
 *   4. After cooldown + a clean probe, the breaker RESETS (lead served again).
 *   5. FLYWHEEL_GATEPOLLER_CIRCUIT=0 disables the breaker (never skips).
 *
 * REAL compiled GatePoller from FLY-307 dist; failure injected via a throwing
 * runtime (a thrown deliver propagates to poll()'s catch == a failed poll).
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TL = process.env.FLY307_DIST || "/Users/xiaorongli/Dev/flywheel/packages/teamlead/dist";
const { StateStore } = await import(`${TL}/StateStore.js`);
const { GatePoller } = await import(`${TL}/bridge/gate-poller.js`);
const { defaultGetCommDbPath } = await import(`${TL}/bridge/session-capture.js`);
const { RuntimeRegistry } = await import(`${TL}/bridge/runtime-registry.js`);
const { CommDB } = await import("flywheel-comm/db");

const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("  ✓", m);

async function scenario(label, { circuitEnv }) {
  console.log(`\n== ${label} ==`);
  const PROJECT = "fly312-e2e3";
  const tmpHome = join(tmpdir(), `qa-fly307-e2e3-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  const prevHome = process.env.HOME; process.env.HOME = tmpHome;
  if (circuitEnv === undefined) delete process.env.FLYWHEEL_GATEPOLLER_CIRCUIT;
  else process.env.FLYWHEEL_GATEPOLLER_CIRCUIT = circuitEnv;

  const projects = [{
    projectName: PROJECT, projectRoot: "/tmp/fly312-e2e3-root",
    leads: [
      { agentId: "ops-lead", chatChannel: "c-ops", match: { labels: ["ops"] } },      // failing
      { agentId: "product-lead", chatChannel: "c-prod", match: { labels: ["product"] } }, // healthy
    ],
  }];
  const dbPath = defaultGetCommDbPath(PROJECT);
  const seed = new CommDB(dbPath);
  // runner_questions (checkpoint null) → routed purely by to_agent, no active-session gate.
  seed.insertQuestion("runner-x", "ops-lead", "ask to ops (will fail to deliver)");
  seed.insertQuestion("runner-y", "product-lead", "ask to product (healthy)");
  seed.close();

  const store = await StateStore.create(":memory:");
  // runner_question survives session completion (FLY-161) — sessions exist but completed.
  store.upsertSession({ execution_id: "runner-x", issue_id: "FLY-A", project_name: PROJECT, status: "completed", issue_labels: JSON.stringify(["ops"]) });
  store.upsertSession({ execution_id: "runner-y", issue_id: "FLY-B", project_name: PROJECT, status: "completed", issue_labels: JSON.stringify(["product"]) });
  const registry = new RuntimeRegistry();

  let opsDeliver = 0, prodDeliver = 0, opsHealthy = false;
  registry.register(projects[0].leads[0], {
    type: "stub",
    async deliver() { opsDeliver++; if (opsHealthy) return { delivered: true }; throw new Error("sql.js: memory access out of bounds (simulated)"); },
    async sendBootstrap() {}, async health() { return { status: "healthy", lastDeliveryAt: null, lastDeliveredSeq: 0 }; }, async shutdown() {},
  });
  registry.register(projects[0].leads[1], {
    type: "stub",
    // delivered:false (NOT a throw) → re-attempted every poll == a clean "served" signal each tick.
    async deliver() { prodDeliver++; return { delivered: false }; },
    async sendBootstrap() {}, async health() { return { status: "healthy", lastDeliveryAt: null, lastDeliveredSeq: 0 }; }, async shutdown() {},
  });

  const THRESHOLD = 3, COOLDOWN = 5;
  const poller = new GatePoller({
    pollIntervalMs: 999999, projects, store, runtimeRegistry: registry,
    circuitThreshold: THRESHOLD, circuitCooldownTicks: COOLDOWN,
  });

  const trace = [];
  for (let i = 1; i <= 10; i++) {
    const o0 = opsDeliver, p0 = prodDeliver;
    await poller.poll();
    trace.push({ poll: i, opsCalled: opsDeliver - o0, prodCalled: prodDeliver - p0 });
  }
  console.log("  poll | ops invoked | product invoked");
  for (const t of trace) console.log(`   ${String(t.poll).padStart(2)}  |     ${t.opsCalled}       |      ${t.prodCalled}`);

  const result = { store, prevHome, tmpHome, trace, opsDeliver, prodDeliver, THRESHOLD, COOLDOWN };
  return result;
}

// ---- Scenario 1: breaker ON (default) ----
{
  const r = await scenario("E2E3-A: circuit breaker ON (default)", {});
  // polls 1..3: ops invoked (throws) -> 3 failures -> opens at poll 3.
  const opsInvokedPolls = r.trace.filter((t) => t.opsCalled > 0).map((t) => t.poll);
  const firstThree = r.trace.slice(0, 3).every((t) => t.opsCalled === 1);
  firstThree ? ok("ops invoked on polls 1-3 (accumulating failures)") : fail("ops not invoked as expected on polls 1-3");
  // poll 4..7 cooldown: ops NOT invoked
  const cooldownSkipped = r.trace.slice(3, 7).every((t) => t.opsCalled === 0);
  cooldownSkipped ? ok("ops SKIPPED during cooldown (polls 4-7) — breaker open, not re-touching the failing lead") : fail(`ops invoked during cooldown: ${JSON.stringify(r.trace.slice(3,7))}`);
  // product served EVERY poll (isolation)
  const prodEvery = r.trace.every((t) => t.prodCalled === 1);
  prodEvery ? ok("product-lead served on EVERY poll (1-10) — one bad lead does NOT wedge the poller") : fail(`product not served every poll: ${JSON.stringify(r.trace.map(t=>t.prodCalled))}`);
  // probe at poll 8 (tick==cooldownUntil): ops invoked again
  const probe = r.trace.find((t) => t.poll === 8);
  probe && probe.opsCalled === 1 ? ok("probe at poll 8 re-invokes ops (cooldown elapsed)") : fail(`expected probe at poll 8, got ${JSON.stringify(probe)}`);
  r.store.close(); process.env.HOME = r.prevHome; rmSync(r.tmpHome, { recursive: true, force: true });
}

// ---- Scenario 2: breaker RESET after a clean probe ----
{
  console.log("\n== E2E3-B: breaker RESETS after a healthy probe ==");
  const PROJECT = "fly312-e2e3b";
  const tmpHome = join(tmpdir(), `qa-fly307-e2e3b-${process.pid}`);
  mkdirSync(tmpHome, { recursive: true });
  const prevHome = process.env.HOME; process.env.HOME = tmpHome;
  delete process.env.FLYWHEEL_GATEPOLLER_CIRCUIT;
  const projects = [{ projectName: PROJECT, projectRoot: "/tmp/r", leads: [{ agentId: "ops-lead", chatChannel: "c", match: { labels: ["ops"] } }] }];
  const dbPath = defaultGetCommDbPath(PROJECT);
  const seed = new CommDB(dbPath); seed.insertQuestion("runner-z", "ops-lead", "ask"); seed.close();
  const store = await StateStore.create(":memory:");
  store.upsertSession({ execution_id: "runner-z", issue_id: "FLY-C", project_name: PROJECT, status: "completed", issue_labels: JSON.stringify(["ops"]) });
  const registry = new RuntimeRegistry();
  let calls = 0, healthy = false;
  registry.register(projects[0].leads[0], {
    type: "stub",
    async deliver() { calls++; if (healthy) return { delivered: false }; throw new Error("boom"); },
    async sendBootstrap() {}, async health() { return { status: "healthy", lastDeliveryAt: null, lastDeliveredSeq: 0 }; }, async shutdown() {},
  });
  const poller = new GatePoller({ pollIntervalMs: 999999, projects, store, runtimeRegistry: registry, circuitThreshold: 3, circuitCooldownTicks: 4 });
  // polls 1-3 fail -> open (cooldownUntil = 3+4 = 7). polls 4-6 skipped. poll 7 = probe.
  for (let i = 0; i < 6; i++) await poller.poll();
  const callsBeforeProbe = calls; // should be 3 (polls 1-3), skipped 4-6
  healthy = true; // make the probe succeed
  await poller.poll(); // poll 7 = probe -> success -> reset
  const callsAfterProbe = calls; // 4
  await poller.poll(); // poll 8 -> breaker closed -> served again
  await poller.poll(); // poll 9 -> served again
  const callsEnd = calls; // 6
  callsBeforeProbe === 3 ? ok("3 failures then SKIPPED through cooldown (calls frozen at 3)") : fail(`expected 3 calls before probe, got ${callsBeforeProbe}`);
  callsAfterProbe === 4 ? ok("probe poll re-invoked the lead (call #4) and succeeded") : fail(`probe call count ${callsAfterProbe}`);
  callsEnd === 6 ? ok("after a clean probe the breaker RESET — lead served normally again (calls 5,6)") : fail(`post-reset calls ${callsEnd}, expected 6`);
  store.close(); process.env.HOME = prevHome; rmSync(tmpHome, { recursive: true, force: true });
}

// ---- Scenario 3: kill-switch ----
{
  const r = await scenario("E2E3-C: FLYWHEEL_GATEPOLLER_CIRCUIT=0 disables the breaker", { circuitEnv: "0" });
  // With breaker off, the failing ops lead is invoked on EVERY poll (never skipped).
  const opsEvery = r.trace.every((t) => t.opsCalled === 1);
  opsEvery ? ok("with kill-switch, failing lead invoked on EVERY poll (breaker bypassed)") : fail(`kill-switch did not bypass: ${JSON.stringify(r.trace.map(t=>t.opsCalled))}`);
  r.store.close(); process.env.HOME = r.prevHome; rmSync(r.tmpHome, { recursive: true, force: true });
  delete process.env.FLYWHEEL_GATEPOLLER_CIRCUIT;
}

console.log(process.exitCode ? "\nE2E3 RESULT: FAIL" : "\nE2E3 RESULT: PASS");
```

### `e2e4-boundary.mjs`

```js
/**
 * FLY-312 E2E4 — INDEPENDENT QA of the FLY-307/FLY-161 BOUNDARY.
 *
 * From the SAME completed session:
 *   - a gate_question (checkpoint != null)  -> MUST be evicted (FLY-307 A)
 *   - a runner_question (checkpoint == null) -> MUST SURVIVE so Annie can still
 *     answer asks from a finished Runner (FLY-161).
 *
 * The eviction must be surgical: only the gate goes, the ask stays — and the
 * ask keeps being relayed to the Lead.
 *
 * PASS criteria:
 *   1. gate_question from the completed session is evicted (no longer pending).
 *   2. runner_question from the completed session SURVIVES many polls (pending).
 *   3. runner_question's TTL is NOT shortened (its expires_at stays far future,
 *      proving resolveGate(qid,0) was never applied to it).
 *   4. runner_question is relayed to the Lead (answerable).
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TL = process.env.FLY307_DIST || "/Users/xiaorongli/Dev/flywheel/packages/teamlead/dist";
const { StateStore } = await import(`${TL}/StateStore.js`);
const { GatePoller } = await import(`${TL}/bridge/gate-poller.js`);
const { defaultGetCommDbPath } = await import(`${TL}/bridge/session-capture.js`);
const { RuntimeRegistry } = await import(`${TL}/bridge/runtime-registry.js`);
const { CommDB } = await import("flywheel-comm/db");

const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("  ✓", m);

const PROJECT = "fly312-e2e4";
const tmpHome = join(tmpdir(), `qa-fly307-e2e4-${process.pid}`);
mkdirSync(tmpHome, { recursive: true });
const prevHome = process.env.HOME; process.env.HOME = tmpHome;
process.env.FLYWHEEL_GATEPOLLER_CIRCUIT = "0";

const projects = [{ projectName: PROJECT, projectRoot: "/tmp/r", leads: [{ agentId: "ops-lead", chatChannel: "c", match: { labels: ["ops"] } }] }];
const dbPath = defaultGetCommDbPath(PROJECT);

const DEAD = "d0ea9175-done-4000-9000-completedsess0";
const store = await StateStore.create(":memory:");
store.upsertSession({ execution_id: DEAD, issue_id: "FLY-161-B", project_name: PROJECT, status: "completed", issue_labels: JSON.stringify(["ops"]) });

const seed = new CommDB(dbPath);
const gateQid = seed.insertQuestion(DEAD, "ops-lead", "gate from finished runner (must evict)", { checkpoint: "approve_to_ship" });
const askQid = seed.insertQuestion(DEAD, "ops-lead", "ask from finished runner (must SURVIVE — Annie answers)"); // checkpoint null
seed.close();

// Capture the ACTUAL event_type of every relayed envelope (the discriminator
// the GatePoller sets: payload.event_type = "runner_question" | "gate_question").
// Codex R1: the old `env?.event?.type === "runner_question" || true` checked a
// NON-EXISTENT field (`event.type`) AND `|| true` made it moot → it counted any
// delivery as a relay (false-PASS). Assert on the real field instead.
const deliveredTypes = [];
const registry = new RuntimeRegistry();
registry.register(projects[0].leads[0], {
  type: "stub",
  async deliver(env) { deliveredTypes.push(env?.event?.event_type); return { delivered: false }; }, // delivered:false → re-relayed each poll
  async sendBootstrap() {}, async health() { return { status: "healthy", lastDeliveryAt: null, lastDeliveredSeq: 0 }; }, async shutdown() {},
});
const poller = new GatePoller({ pollIntervalMs: 999999, projects, store, runtimeRegistry: registry });

const ro = () => { const d = CommDB.openReadonly(dbPath); try { return d.getPendingQuestions("ops-lead"); } finally { d.close(); } };
const askRow = () => { const d = CommDB.openReadonly(dbPath); try { return d.getMessageById(askQid); } finally { d.close(); } };

console.log("== FLY-312 E2E4: gate evicted, runner_question survives (FLY-161 boundary) ==");
console.log(`  gate qid=${gateQid.slice(0,8)} (checkpoint=approve_to_ship), ask qid=${askQid.slice(0,8)} (checkpoint=null), both from completed session ${DEAD.slice(0,8)}`);

const before = ro();
before.length === 2 ? ok("2 pending before: gate + ask") : fail(`expected 2 pending, got ${before.length}`);
const ttlBefore = askRow().expires_at;

for (let i = 0; i < 30; i++) await poller.poll();

const after = ro().map((q) => q.id);
const gateEvicted = !after.includes(gateQid);
const askSurvives = after.includes(askQid);
gateEvicted ? ok("gate_question EVICTED (gone from pending)") : fail("gate_question still pending — eviction failed");
askSurvives ? ok("runner_question SURVIVES after 30 polls (Annie can still answer)") : fail("runner_question wrongly evicted — FLY-161 REGRESSION");

const ttlAfter = askRow().expires_at;
ttlBefore === ttlAfter
  ? ok(`runner_question TTL untouched (expires_at ${ttlAfter}) — resolveGate(qid,0) never applied to it`)
  : fail(`runner_question TTL changed ${ttlBefore} -> ${ttlAfter} — it was wrongly resolved/expired`);

const relayedRunnerQ = deliveredTypes.filter((t) => t === "runner_question").length;
const relayedGate = deliveredTypes.filter((t) => t === "gate_question").length;
relayedRunnerQ >= 1
  ? ok(`runner_question RELAYED to Lead (${relayedRunnerQ}x; event_type asserted == "runner_question") — answerable`)
  : fail(`no runner_question relayed; delivered event_types: ${JSON.stringify([...new Set(deliveredTypes)])}`);
relayedGate === 0
  ? ok("gate_question was NEVER relayed (evicted BEFORE delivery) — eviction is pre-relay, not a post-relay cleanup")
  : fail(`gate_question wrongly relayed ${relayedGate}x — eviction did not pre-empt delivery`);

store.close(); process.env.HOME = prevHome; delete process.env.FLYWHEEL_GATEPOLLER_CIRCUIT;
rmSync(tmpHome, { recursive: true, force: true });
console.log(process.exitCode ? "\nE2E4 RESULT: FAIL" : "\nE2E4 RESULT: PASS");
```

### `e2e5-no-misfire.mjs`

```js
/**
 * FLY-312 E2E5 — INDEPENDENT QA that the watchdog does NOT MISFIRE.
 *
 * The whole point of a worker-thread + heartbeat (vs a naive CPU%/timer-lag
 * detector) is that a BUSY-but-alive Bridge — high CPU, timers firing late by
 * ms — must NOT be killed. Only a genuine event-loop FREEZE counts.
 *
 * Drives the REAL watchdog with a 2s stall threshold, then runs 7s of heavy
 * CPU split into 30ms chunks that yield to the loop (setImmediate) between
 * chunks — so the heartbeat keeps advancing. Expect: NO kill, clean exit 0.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("  ✓", m);

const CHILD = join(import.meta.dirname, "watchdog-child.mjs");
const env = {
  ...process.env,
  MODE: "busy",
  FLYWHEEL_BRIDGE_WATCHDOG_STALL_MS: "2000",
  FLYWHEEL_BRIDGE_WATCHDOG_CHECK_MS: "200",
  FLYWHEEL_BRIDGE_WATCHDOG_HEARTBEAT_MS: "200",
};

console.log("== FLY-312 E2E5: busy-but-loop-turning must NOT trip the watchdog ==");
console.log("  7s of heavy CPU in 30ms yielding chunks; stall threshold = 2s");

const res = await new Promise((resolve) => {
  const child = spawn(process.execPath, [CHILD], { env });
  let out = "";
  child.stdout.on("data", (d) => { out += d; process.stdout.write(`   ${d}`); });
  child.stderr.on("data", (d) => { out += d; });
  const t0 = Date.now();
  const killer = setTimeout(() => child.kill("SIGTERM"), 20000);
  child.on("exit", (code, signal) => { clearTimeout(killer); resolve({ code, signal, out, ms: Date.now() - t0 }); });
});

console.log(`  child exited: code=${res.code} signal=${res.signal} after ${res.ms}ms`);
res.signal !== "SIGKILL"
  ? ok("watchdog did NOT SIGKILL the busy-but-alive process (no misfire)")
  : fail("watchdog MISFIRED — killed a healthy busy process");
res.code === 0
  ? ok("process completed the full busy run and exited 0")
  : fail(`unexpected exit code ${res.code}`);
res.out.includes("SURVIVED busy load")
  ? ok("process reported SURVIVED after 7s of high CPU (> threshold)")
  : fail("process did not report survival");
res.ms >= 6500
  ? ok(`ran the full ~7s busy window (${res.ms}ms) without being killed mid-load`)
  : fail(`exited too early (${res.ms}ms) — may have been killed`);

console.log(process.exitCode ? "\nE2E5 RESULT: FAIL" : "\nE2E5 RESULT: PASS");
```

### `watchdog-child.mjs`

```js
/**
 * FLY-312 watchdog child harness — runs the REAL compiled
 * BridgeEventLoopWatchdog (production path, testMode:false → real SIGKILL).
 *
 * MODE env:
 *   stall     — start watchdog, then block the event loop > threshold.
 *               Expect: the worker thread SIGKILLs THIS process.
 *   recovered — start watchdog, stay healthy, print RECOVERED, exit 0.
 *               (emulates the launchd-relaunched Bridge after the kill.)
 *   busy      — start watchdog, run heavy CPU in yielding chunks (loop keeps
 *               turning) past the threshold. Expect: NO kill, exit 0.
 */
const TL = process.env.FLY307_DIST || "/Users/xiaorongli/Dev/flywheel/packages/teamlead/dist";
const { BridgeEventLoopWatchdog } = await import(`${TL}/bridge/BridgeEventLoopWatchdog.js`);

const MODE = process.env.MODE;
const wd = new BridgeEventLoopWatchdog({ enabled: true });
wd.start();
console.log(`[child] watchdog started, enabled=${wd.isEnabled()}, mode=${MODE}, pid=${process.pid}`);

// keep the main loop referenced so the process doesn't exit on its own
const keepAlive = setInterval(() => {}, 100);

if (MODE === "stall") {
  // give the worker + heartbeat a moment to settle, then freeze the loop.
  setTimeout(() => {
    console.log("[child] blocking the event loop now (busy-wait)...");
    const end = Date.now() + 6000; // >> stall threshold
    while (Date.now() < end) { /* spin — heartbeat timer cannot fire */ }
    console.log("[child] busy-wait ended (should have been SIGKILLed before this)");
    clearInterval(keepAlive); wd.stop();
  }, 800);
} else if (MODE === "recovered") {
  setTimeout(() => { console.log("[child] RECOVERED ALIVE — relaunched Bridge healthy, relay restored"); clearInterval(keepAlive); wd.stop(); process.exit(0); }, 2500);
} else if (MODE === "busy") {
  // heavy CPU, but yield to the loop between chunks so the heartbeat advances.
  const deadline = Date.now() + 7000; // longer than the 2s threshold
  let acc = 0;
  const chunk = () => {
    const chunkEnd = Date.now() + 30; // 30ms of CPU, then yield
    while (Date.now() < chunkEnd) { acc += Math.sqrt(acc + 1); }
    if (Date.now() < deadline) { setImmediate(chunk); }
    else { console.log(`[child] SURVIVED busy load (acc=${acc.toFixed(0)}) — no misfire`); clearInterval(keepAlive); wd.stop(); process.exit(0); }
  };
  setImmediate(chunk);
} else {
  console.error("[child] unknown MODE"); process.exit(2);
}
```

### `smoke-bridge.mjs`

```js
/**
 * FLY-312 Discord smoke — REAL test Bridge entry (dist replica of
 * scripts/run-bridge.ts) so the REAL startBridge() + REAL
 * BridgeEventLoopWatchdog (FLY-307 layer C) run on the isolated slot-3 port.
 *
 * SMOKE_STALL=1 → after the Bridge is up, freeze the event loop (busy-wait
 * far beyond the watchdog threshold). The real watchdog worker thread then
 * SIGKILLs THIS process — exactly the outage→crash conversion under test.
 * Without it (the KeepAlive relaunch), the Bridge just stays healthy.
 *
 * NOT VITEST → the watchdog is live (auto-disable only triggers under VITEST).
 */
const TL = process.env.FLY307_DIST || "/Users/xiaorongli/Dev/flywheel/packages/teamlead/dist";
const { startBridge } = await import(`${TL}/bridge/plugin.js`);
const { loadConfig } = await import(`${TL}/config.js`);
const { loadProjects } = await import(`${TL}/ProjectConfig.js`);
const { StateStore } = await import(`${TL}/StateStore.js`);

const config = loadConfig();
const projects = loadProjects();
const store = await StateStore.create(config.dbPath);
console.log(`[smoke-bridge] starting startBridge on :${config.port}, pid=${process.pid}`);

const { close } = await startBridge(config, projects, { store });
console.log(`[smoke-bridge] READY pid=${process.pid} port=${config.port}`);

let shuttingDown = false;
const shutdown = async () => { if (shuttingDown) return; shuttingDown = true; await close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (process.env.SMOKE_STALL === "1") {
  const delay = Number(process.env.SMOKE_STALL_DELAY_MS ?? "9000");
  setTimeout(() => {
    console.log(`[smoke-bridge] FREEZING event loop now (pid=${process.pid}) — watchdog should SIGKILL`);
    const end = Date.now() + 25000; // >> watchdog threshold
    while (Date.now() < end) { /* spin — main loop frozen, /health will time out */ }
    console.log("[smoke-bridge] freeze ended (should have been SIGKILLed)");
  }, delay);
}
```

### `smoke-supervisor.sh`

```bash
#!/usr/bin/env bash
# FLY-312 Discord smoke (slot-3) — KeepAlive supervisor.
#
# Drives a full outage→auto-recovery cycle on an ISOLATED test Bridge
# (port 19873, slot 3) and narrates it in the real #ops-lead-test channel via
# the slot-3 bot, so Annie sees the user-visible story:
#   🟢 Bridge up & serving  →  🔴 event loop frozen (relay DOWN = the outage)
#   →  watchdog SIGKILL + KeepAlive restart  →  🟢 recovered (relay restored)
#
# Objective proof (not narration): /health before/during/after, PID change,
# SIGKILL exit (137), and the watchdog forensic log line.
#
# NEVER touches the production Bridge: own port, own temp DB, own process.
set -uo pipefail

QA=/tmp/qa-fly-307
PORT=19873
CH=1493080995862413439   # ops-lead-test
WD_LOG="$QA/smoke-wd.log"
# FLY-307 is merged to main; default the dist to the main repo (the FLY-307
# worktree is cleaned up post-merge). Override with FLY307_DIST if needed.
FLY307_DIST="${FLY307_DIST:-/Users/xiaorongli/Dev/flywheel/packages/teamlead/dist}"
# shellcheck disable=SC1090
source "$HOME/.flywheel/.env"
TOKEN="${TEST_BOT_TOKEN_3:-}"
[[ -z "$TOKEN" ]] && { echo "FATAL: TEST_BOT_TOKEN_3 not set"; exit 1; }

post() { # $1 = message
  curl -s -X POST "https://discord.com/api/v10/channels/${CH}/messages" \
    -H "Authorization: Bot ${TOKEN}" -H "Content-Type: application/json" \
    -d "$(jq -nc --arg c "$1" '{content:$c}')" -o /dev/null -w "%{http_code}"
}
health() { curl -sf --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; }
export FLY307_DIST TEAMLEAD_PORT=$PORT TEAMLEAD_HOST=127.0.0.1 \
  TEAMLEAD_DB_PATH="$QA/smoke-state.json" \
  FLYWHEEL_PROJECTS="$(cat "$QA/slot3-projects.json")" \
  FLYWHEEL_BRIDGE_WATCHDOG_STALL_MS=5000 FLYWHEEL_BRIDGE_WATCHDOG_CHECK_MS=250 \
  FLYWHEEL_BRIDGE_WATCHDOG_HEARTBEAT_MS=250 FLYWHEEL_BRIDGE_WATCHDOG_LOG="$WD_LOG" \
  SMOKE_STALL_DELAY_MS=9000

echo "== FLY-312 slot-3 Discord smoke: outage -> watchdog -> auto-recovery =="

# ── ISOLATION GUARD (Codex R1+R2): fully fail-closed — runs BEFORE any cleanup
# or file mutation, so an occupied-port run touches NOTHING shared. A stray/
# production bridge on :19873 would make /health hit the WRONG process → false
# results / interference. Also reject the production port and slots 1/2 outright.
if [[ "$PORT" == "9876" || "$PORT" == "19871" || "$PORT" == "19872" ]]; then
  echo "FATAL: refusing to run on port $PORT (production / slot1 FLY-309 / slot2 FLY-310)"; exit 1
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "FATAL: port $PORT already in use — another process is listening. Aborting (no files touched) to avoid hitting the wrong bridge."; exit 1
fi
echo "[sup] isolation guard OK — :$PORT is free (slot 3), prod :9876 untouched"

# Only AFTER the guard passes do we mutate shared smoke artifacts.
rm -f "$WD_LOG" "$QA/smoke-bridge.log" "$QA/smoke-state.json"* 2>/dev/null

# ── launch #1 (will freeze) — direct child so `wait` sees the real signal ──
SMOKE_STALL=1 node "$QA/smoke-bridge.mjs" >> "$QA/smoke-bridge.log" 2>&1 &
PID1=$!
echo "[sup] launched test Bridge pid=$PID1 (SMOKE_STALL=1)"
for i in $(seq 1 40); do health && break; sleep 0.5; done
if ! health; then echo "FAIL: bridge #1 never became healthy"; kill -9 "$PID1" 2>/dev/null; exit 1; fi
echo "[sup] /health OK — bridge serving"
HC1=$(post "🟢 [QA FLY-312] isolated test Bridge UP on :$PORT (slot 3) pid=$PID1 — Discord relay serving. Forcing the 2026-06-17 outage now…")
echo "[sup] posted UP (http=$HC1)"

# ── wait for the freeze, detect the wedge via /health timeout ──
FROZE=0
while kill -0 "$PID1" 2>/dev/null; do
  if ! health; then
    if [[ $FROZE -eq 0 ]]; then
      FROZE=1
      HC2=$(post "🔴 [QA FLY-312] event loop FROZEN — /health timing out, Discord relay DOWN (this is the outage). Watchdog should now SIGKILL the hung Bridge + KeepAlive restart it…")
      echo "[sup] detected wedge (/health timeout) — posted OUTAGE (http=$HC2)"
    fi
  fi
  sleep 0.4
done
wait "$PID1"; EXIT1=$?
echo "[sup] bridge #1 (pid=$PID1) exited: status=$EXIT1 ($([[ $EXIT1 -eq 137 ]] && echo 'SIGKILL=128+9' || echo other))"
[[ $FROZE -eq 1 ]] && echo "[sup] confirmed /health was unreachable during the freeze (relay outage)" || echo "[sup] WARN: did not observe the /health timeout window"

# ── KeepAlive relaunch (healthy) ────────────────────────
echo "[sup] KeepAlive relaunch…"
SMOKE_STALL="" node "$QA/smoke-bridge.mjs" >> "$QA/smoke-bridge.log" 2>&1 &
PID2=$!
echo "[sup] relaunched test Bridge pid=$PID2 (healthy)"
for i in $(seq 1 40); do health && break; sleep 0.5; done
if ! health; then echo "FAIL: bridge #2 never recovered"; kill -9 "$PID2" 2>/dev/null; exit 1; fi
echo "[sup] /health OK again — bridge recovered"
HC3=$(post "🟢 [QA FLY-312] AUTO-RECOVERED — watchdog SIGKILLed the hung Bridge (pid=$PID1), KeepAlive restarted it (pid=$PID2), /health green, Discord relay RESTORED. Pre-fix this sat dead ~10 min until a manual kickstart.")
echo "[sup] posted RECOVERED (http=$HC3)"

# ── evidence ────────────────────────────────────────────
echo "== EVIDENCE =="
echo "  PID before kill: $PID1   PID after restart: $PID2   (changed: $([[ "$PID1" != "$PID2" ]] && echo YES || echo NO))"
echo "  bridge #1 exit status: $EXIT1 (137 == SIGKILL)"
echo "  /health unreachable during freeze: $([[ $FROZE -eq 1 ]] && echo YES || echo NO)"
echo "  watchdog forensic line:"; grep "bridge_event_loop_stall" "$WD_LOG" 2>/dev/null | tail -1 | sed 's/^/    /'
echo "  Discord posts (http codes): UP=$HC1 OUTAGE=${HC2:-NA} RECOVERED=$HC3 (200/204 == delivered)"

# ── teardown ────────────────────────────────────────────
kill -TERM "$PID2" 2>/dev/null; sleep 2; kill -9 "$PID2" 2>/dev/null
echo "[sup] teardown: stopped recovered bridge pid=$PID2"

PASS=1
[[ $EXIT1 -eq 137 ]] || { echo "FAIL: bridge #1 was not SIGKILLed (status=$EXIT1)"; PASS=0; }
[[ "$PID1" != "$PID2" ]] || { echo "FAIL: PID did not change across restart"; PASS=0; }
[[ $FROZE -eq 1 ]] || { echo "FAIL: never observed the /health outage window"; PASS=0; }
grep -q "bridge_event_loop_stall" "$WD_LOG" 2>/dev/null || { echo "FAIL: no forensic stall line"; PASS=0; }
# Codex R2 LOW: assert ALL three narration posts (incl. the OUTAGE post HC2) —
# the outage→recovery story in #ops-lead-test is the required user-visible evidence.
[[ "$HC1" =~ ^20 && "$HC2" =~ ^20 && "$HC3" =~ ^20 ]] || { echo "FAIL: Discord posts not all delivered (UP=$HC1 OUTAGE=${HC2:-NA} RECOVERED=$HC3)"; PASS=0; }
echo
[[ $PASS -eq 1 ]] && echo "SMOKE RESULT: PASS" || echo "SMOKE RESULT: FAIL"
exit $((1-PASS))
```

### `slot3-projects.json`

```json
[
  {
    "projectName": "fly312-smoke",
    "projectRoot": "/tmp/qa-fly-307/smoke-root",
    "leads": [
      { "agentId": "ops-lead", "chatChannel": "1493080995862413439", "match": { "labels": ["ops"] }, "canSpawnRunners": false }
    ]
  }
]
```
