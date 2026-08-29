# FLY-1188 Codex Runner 一等公民 — QA 报告

Issue: FLY-1188
日期: 2026-07-13(round 1 FAIL → round 2 PASS)
基于: plan.md, m4d-adapter-wiring-spec.md, PR #568

---

# Round 2 结论:**PASS** — 产品树 head `9341ad5e`

两条 HIGH 都**真机验证修好了**,三道硬门全过。

```
node scripts/qa-fly-1188-e2e.mjs        (真 daemon + 真 linked worktree + 真 tmux TUI)

✅ H1-agents-md                  $CODEX_HOME/AGENTS.md 落地 6456 bytes
✅ H1-contract-anchors           契约锚点齐全
✅ H2-resident-multi-turn        resident /goal 自主跑 3 turn(无外部 kick)
✅ H2-goal-terminal              终态 complete / succeeded
✅ H3-founder-tui-visible        真 codex TUI 在 tmux 里实时渲染(34 行)
✅ H4-sandbox-linked-worktree    daemon 在 linked worktree 真落 3 个 commit
✅ T-clean-teardown              0 孤儿 daemon,socket 已释放
VERDICT: PASS
```

## 三道硬门(Lead 定的验收线)

**① TUI 必须真渲染(Annie 打开 cmux 要真能看见)—— 过。**
founder pane 实拍(`qa/tui-pane-capture.txt`),这是 codex 在**干活当时**的画面:

```
• Added step1.txt (+1 -0)
    1 +alpha
• Ran git add step1.txt && git commit -m "qa step1"
  └ [qa-wt cdab5fd] qa step1
     1 file changed, 1 insertion(+)
• Step 1 committed as cdab5fd (qa step1).
```

这就是这个 issue 的立命之本 —— **founder 现在真能在 cmux 里看着 codex 干活**。
修法:TUI 改用**裸 codex**(TTY-capable),daemon 继续用 shim(app-server 不需要 TTY,
且确实要 429 轮换)。另外 `ensureRunnerTuiWindow` 现在**自己探活**(800ms settle +
`isRunnerTuiWindowAlive`),不再听 tmux 一面之词 —— 我 round 1 那条
「tmux 只报告能不能 spawn,里面的命令瞬死它照样返回成功」被直接做进了修复。

**② 跑完不许留孤儿 app-server —— 过。**
新逻辑在真机日志里**看得见它动手**:

```
runtime: daemon still listening on …/cdx-sock/xxx.sock after stop
         — escalating to a group SIGKILL
→ socket removed=true; orphan daemons=[]
```

daemon 进自己的进程组、按 **socket** 判死(不按 pid)、kill 整组。round 1 那个
「pid 96912 / PPID 1 / 178MB / 攥着 socket 不放」的孤儿,现在**零**。

**③ 绝不误杀生产进程 —— 过。**
跑前抓 baseline、跑后逐一核对,3 个生产 codex app-server **全部存活**:

```
✓ ALIVE 20505   ✓ ALIVE 61792   ✓ ALIVE 92613
```

## 代码级

- `claude-runner` **494/494** 绿(含我 round 1 留下的 2 个回归测试,现在都转绿)。
- ⚠️ **环境坑记一笔**:在 runner session 里直接跑会看到 4 个 fail —— 假的。
  `TMPDIR` 落在 `~/.flywheel/runner-state/<长 exec-id>/` 下,测试临时 socket 路径
  116~119 bytes,撞 SUN_LEN(103)上限,**在跑到真断言之前就挂了**。
  `TMPDIR=/tmp pnpm test` → **494/494**。这不是回归,恰恰是那个长度守卫在正常工作。

## 我自己的两次翻车(留档,比结论更值钱)

QA 的检测器**两次骗过我自己**,两次都是「工具自报健康」的同一个病:

1. **round 1**:teardown 按 **pid** 探活 → 报「daemon alive=false」,而真 daemon
   (孙子进程)好好活着 178MB。→ 改成**按 socket 探**。
2. **round 2**:harness 自己**把 shim 塞给了 TUI**(没走 adapter 的生产接线),
   于是复现出一个「TUI 还是死」的假 FAIL —— **是我的测试架子错了,不是产品**。
   同一轮里 H3 的断言还要求画面出现字面量 "Codex",而真 TUI 根本不打这个词,
   于是**TUI 明明渲染得好好的,我的检查却判它死**。

两条都已修进 `scripts/qa-fly-1188-e2e.mjs`:**QA 架子必须复刻生产接线,绝不自创**;
**单张快照不是证据**(按时间采样,取最丰满的一帧)。差一点我就把自己架子的 bug
当成产品的 FAIL 报上去了。

## ⑤ 审查不变量(不阻塞本单)

codex 作者那一半是**真锁死的**(所有 authority 消费者全过 `crossFamilyReviewSatisfied`,
家族从服务端 `adapter_type` 派生,runner 伪造不了)。但 claude 作者那一半仍是
**self-attested**(`auto-qa-coordinator.ts:851` 的 `reviewer_family=codex` 按事件类型
硬编码,而那事件是 runner 自己发的)—— FLY-827 就有的既有状态,**本分支没让它变差**。
建议开 follow-up。另有 MEDIUM:`adapterTypeToFamily()` 对未知/NULL backend
**fail-open** 成 "claude"(`review-family.ts:20`),当前拓扑不可达,但安全默认值方向反了。

## 复跑

```bash
TMPDIR=/tmp node scripts/qa-fly-1188-e2e.mjs
```

真机环境:codex-cli 0.144.3,macOS,真 `~/.codex` auth。
产出:`qa/e2e-result.json`、`qa/tui-pane-capture.txt`(founder pane 实拍)、
`qa/orphan-daemon-evidence.txt`(round 1 铁证)、`qa/tui-failure-diagnosis.txt`。

---

# Round 1 结论:FAIL(2 HIGH)—— 已全部修复,存档

- **HIGH-1 可视 TUI 根本没起来**:pane 秒死于 `Error: stdout is not a terminal` exit 1。
  根因 `CodexTmuxAdapter.ts:377` 把 tee-管道的 fallback shim 传给了 TUI。
- **HIGH-2 孤儿 daemon**:每个 codex runner 泄漏 ~178MB 的 app-server + socket。
  `stop()` 杀的只是 shim,真 app-server 是它子进程,活下来被 reparent 到 PID 1。
  连带:交给 `onDaemonPid`、复用作 `reapOrphanPid` 的 pid 是 shim 的 →
  **Bridge 重启后永远 reap 不到孤儿**(HIGH-2 一直在悄悄废掉 HIGH-3)。

详见 `qa/orphan-daemon-evidence.txt`。
