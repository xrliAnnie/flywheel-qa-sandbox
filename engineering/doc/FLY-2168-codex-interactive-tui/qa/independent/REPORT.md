# FLY-2168 独立 QA 报告 — 恢复 Codex 执行体原生 TUI

Issue: FLY-2168 · PR #998 · 验证头: 250d233540300fc0a49e084e5464669e57da7078
日期: 2026-08-30
角色: DAG qa 节点(独立验证,不改产品代码)

## 结论

**FAIL**(产品行为达标;但本 PR 自带的真机验收脚本在该头上跑不过,且失败方式会被读成「功能坏了」)

## 一、产品验收 — 达标(已真机证明)

真机跑生产 `CodexTmuxAdapter.execute()`(全新出生:新 CODEX_HOME + 新 daemon + 新 thread + 真 tmux),
按生产形态传 `pretrustWorkspace: true`,任务时长 304s:

```
RESULT: 10/10 passed   (evidence: fresh-birth-run.log, after-native-tui-pane.txt)
```

- pane 进程 = `codex resume --remote unix://…/99317c9da30cc8fc.sock -C … -s workspace-write -c approval_policy="never" 01a053e5-…`,不是 `tail -F`;
- `capture-pane` 呈现完整原生 chrome:对话气泡、`Ran 2 commands · ctrl + t to view transcript`、分隔线、
  `◦ Working (58s • esc to interrupt)`、输入框 `› Ask Codex to do anything`、页脚 `gpt-5.6-sol xhigh · <cwd>  Pursuing goal (2m)`;
- **founder 输入能力实测**:`send-keys` 打字后 pane 显示 `› founder typing check`,`C-u` 清除,未发出 turn;
- 同名窗采样最大 = 1(152 次采样);
- thread 无 fork:root = machine `result.sessionId` = `01a053e5-…`,roots=1,unexpected=none;
- teardown 干净:窗口 0、socket 已删、无孤儿 daemon、无残留 TUI;
- machine goal `success=true timedOut=false`。

BEFORE 对照(生产 main 构建、当时在跑的真 Codex runner pane):`cmd=tail`,内容是裸 JSON 事件流水
(`[item/commandExecution/outputDelta] {...}`)—— 即 founder 说的 "this looks ugly"。见 `before-tail-pane.txt`。

其它硬门:
- 该头 CI 全绿(11/11,run 33324894745),`MERGEABLE / CLEAN`;
- 本地定向套件:`codex-runner-tui-window.test.ts` + `CodexTmuxAdapter.test.ts` = 140 passed;
  `codex-runner-orphan-reaper.test.ts` = 19 passed;
- 无 feature flag 门控 —— 新出生体默认即此形态;`pretrustWorkspace` 由 Blueprint(FLY-1961)对
  「有 worktree 的 codex 运行」恒置 true,已在**在跑的生产 runner** 的 config.toml 里核到
  `[projects."/Users/xiaorongli/Dev/flywheel-FLY-2168"] trust_level = "trusted"`。

## 二、阻断项 D1 — 本 PR 修改的 `scripts/qa-fly-1239-e2e.mjs` 在该头上 FAIL

原样跑(plan §8 列的验证命令):

```
RESULT: 9/10 passed
FAILED: A3-founder-tui-recovered — founder TUI never rendered a live pane (aliveSamples=15, 329 bytes)
```

真因(已定位到行):harness 构造的 ctx(`scripts/qa-fly-1239-e2e.mjs:109`)**没有** `pretrustWorkspace: true`,
而生产 Blueprint 对 codex worktree 运行恒置该值(`packages/edge-worker/src/Blueprint.ts:2690`)。
不带它 ⇒ `provisionCodexHome` 不写 `trustedProjectPath` 条目(`CodexTmuxAdapter.ts:472`)⇒
原生 TUI 停在 Codex 的目录信任弹窗上,永远不渲染会话:

```
> You are in /private/tmp/qa-fly1239-dCAIB2/repo-qa-wt
  Do you trust the contents of this directory? ...
› 1. Yes, continue
  2. No, quit
```

**只加这一行**,同一个头、同一台机器、同一个脚本变成 `RESULT: 10/10 passed / ALL PASS`(即上文第一节的证据)。

为什么算阻断:
1. 这是本 PR 自己改过的文件(+157 行,plan §7 指定它为真机证据路径、§8 列为验证命令),合入后仓库里就带着一个红的验收台架;
2. 它的失败长得像「功能坏了」(pane 不渲染),会误导下一个跑它的人;
3. 它还盖住了一个真实的失效形态:**任何没有被 pretrust 的 codex 工作区,founder 看到的是信任弹窗而不是会话**
   (本机 `~/.codex` 基础配置恰好信任 `/Users/xiaorongli`,所以生产路径被兜住了;/private/tmp 之类不在其下)。

另:实现方 evidence 里「嵌套 sandbox 阻断」是**宿主特定**、不是结构性不可测 —— 从 Claude 宿主的 runner 里,
该脚本可以完整跑完(本报告三次真跑为证)。

## 三、观察项 D2 — 短任务拿不到窗口(诚实边界,非本 PR 独有)

实测 `ensureRunnerTuiWindow` 单次开窗 **65.3s**,其中大头是 tmux guarded session-ensure 的跨进程 hold lock 争用
(两次 `hold_lock_unavailable`,owner 分别持有 9.4s / 6.6s;本机 load ~9、20+ 个 cmux session)。

后果:两次独立的 ~50s 真跑(pretrust 已开)**完全没有窗口**,只留下
`runner-tui-window: terminal visibility loss trigger=run-ended attempts=1 reason=unknown`
(见 `short-run-no-window.log`)。304s 的跑则正常开窗。

本 PR 把开窗链从 daemon spawn 挪到 `onThreadReady`(更晚),并把预算从 10 次/30 分收到 3 次/8 分。
`run-ended` 这个触发器与锁争用都是既有的,所以我**不把它记为本 PR 引入的回归**;但 founder 可见的后果是:
短 Codex 跑会没有窗口,并产生一条 visibility-lost 告警。建议 Lead 决定是否单开一张单。

## 四、529 房 / N-to-N — 跑了,但结构上够不到 Codex 体(有据)

在候选头上真起了一间 generalized 529 房:`scripts/test-deploy.sh 2 --generalized`,
`room-info.json` 记 `buildSha: 250d2335…`(= 候选头)、`runnerMode: "real"`。
房里真出生的 runner 是 **claude(fable)**:窗口 `FLY-2027-design-claude-Fable-…`,pane 进程是 `claude --agent-id …`。

原因不是我跳过 —— 是 `test-deploy.sh` 生成的沙箱 `config.yaml` 里**只声明了 claude runner**:

```yaml
runners:
  default: claude
  available:
    claude: { type: claude, model: sonnet }
```

(原件已拷:`529-room-slot-config.yaml`)。要在 529 房里逼出 codex 体,得改房生成器本身 —— 超出本节点授权。
因此 Codex 侧 founder 面证据以第一节的真机全新出生跑为准(它走的是同一个生产 adapter)。

`--alerts` 无法用:test bot 2 对 `test-flywheel-alerts` 403。改为不带 `--alerts` 起房,
Bridge 侧 `FLYWHEEL_STATE_DIR=/tmp/flywheel-test-slot-2`(test-deploy.sh:1695)已隔离。
跑完按内容(不是文件名)核生产告警目录:新增 2 个死信的 `leadId` 都是 `flywheel-eng-lead` / `projectName: flywheel`
(生产 Lead 自己的 cmux_cleanup,起房前 18:08 就有同族),`meta-alert/codex_global_unhealthy.txt` 的
`reason=lead-home-binary` 指向 mufasa lead home —— **均不可归因于 slot 2**。房已 `test-teardown.sh 2` 拆净,slot 2 已释放。

## 五、没测到的(honest boundary)

- 未在 529 房里跑通「Bridge/Blueprint 驱动的 **Codex** 出生」(见第四节的结构原因)。
  Blueprint→adapter 这段接线本 diff 未改动,并有在跑生产 runner 的 config.toml 旁证。
- 未验证 founder 在 TUI 里**真发一个 turn** 与 machine client 并发时的行为(plan §9 已声明不加锁,是已知设计取舍)。
- 未做 pane watchdog 场景(founder 中途关窗不会重开)—— plan §3 明确列为非目标,与改前一致。
- 未跑全仓 `pnpm test:packages:run`(该头 CI 已覆盖同等门:Unit heavy/light + teamlead 1-3 全绿)。

## 证据清单(本目录)

| 文件 | 内容 |
|---|---|
| `before-tail-pane.txt` | BEFORE:生产 main 构建下真 Codex runner 的 `tail` 裸事件流水 pane |
| `after-native-tui-pane.txt` | AFTER:本分支全新出生的原生 Codex TUI pane(含 pane 进程身份) |
| `fresh-birth-run.log` | 生产形态真机 E2E,`RESULT: 10/10 passed / ALL PASS` |
| `short-run-no-window.log` | ~50s 短跑:无窗口 + `terminal visibility loss trigger=run-ended` |
| `e2e-result.json` / `tui-pane-capture.txt` | 原样跑(缺 pretrust)的 9/10 结果与信任弹窗 pane |
| `fresh-birth/e2e-result.json` | 10/10 的机器可读结果 |
| `529-room-observation.txt` / `529-room-slot-config.yaml` / `529-room-bridge-tail.log` | 529 房真起 + 只有 claude runner 的证据 |
