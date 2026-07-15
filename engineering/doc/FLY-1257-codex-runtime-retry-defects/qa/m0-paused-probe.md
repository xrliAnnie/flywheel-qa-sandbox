# FLY-1257 Codex paused RPC — 验证记录

Issue: FLY-1257
日期: 2026-07-14
基于: plan.md

## Result

**PASS**。本机 `codex-cli 0.144.4` 的 app-server 原生 goal 状态满足 M-opt 的四个
前置条件:

1. 活跃 goal 可用 `thread/goal/set {status:"paused"}` 真正暂停自动续轮;
2. partial status update 保留原 `objective` 与 `tokenBudget=100000`;
3. paused 状态、objective、budget 在 daemon 退出、重启、`thread/resume` 后完整保留;
4. partial `{status:"active"}` 真正恢复,本次不需要补 kick,12ms 内自动发出新 turn。

因此按 plan 的条件门实现 M-opt paused overlay;主修 M1 本地 hold/latch 仍是安全边界,
paused RPC 失败只记日志、不得破坏本地 hold。

## Environment

- Codex:`codex-cli 0.144.4`
- app-server init:`Mac OS 26.3.2; arm64`
- model:`gpt-5.6-sol`,reasoning effort:`xhigh`
- transport:两个独立临时 Unix socket,同一认证 `CODEX_HOME`
- thread:`019f6408-a6d0-78c0-84ee-37727df10e22`
- scratch:`/var/folders/.../T/fly1257-paused-probe-0Cpj0p`
- 脚本:`m0-paused-probe.mjs.txt`
- 公开控制面交叉验证:OpenAI Codex Manual 的 Goal mode 明确支持 pause/resume;
  App Server 文档明确其 JSON-RPC + Unix-socket transport。公开文档未承诺字段保留
  和 daemon restart 语义,所以下列结论以本机原始 RPC 帧为准。

## Timeline

| t(ms) | Event | Observation |
|---:|---|---|
| 633 | initial goal/set | `active`,objective 完整,budget `100000` |
| 696 | first turn/started | 活跃 turn `299019fb-...` |
| 1797 | partial pause send | 请求只传 `threadId + status=paused` |
| 1799 | pause response | `paused`,objective 与 budget 原样保留 |
| 1800 | goal/get | 再读仍为 `paused` |
| 35646 | in-flight turn completed | pause 不伪造中断;当前 turn 正常收尾 |
| 50707 | 15s quiet window end | turn starts `1→1`,workdir actions `0→0` |
| 50732 | daemon A exit | 正常退出(code 0) |
| 50932 | daemon B thread/resume | 同一 thread 恢复 |
| 50935 | post-restart goal/get | 仍 `paused`,objective 与 budget 完整 |
| 50935 | partial active send | 请求只传 `threadId + status=active` |
| 50942 | active response | `active`,objective 与 budget 原样保留 |
| 50947 | turn/started | 自动恢复,无需 kick |
| 51083 | cleanup | goal clear 成功;最终 verdict `PASS` |

首个 turn 在 macOS sandbox 内尝试写 `step-01.txt` 时被拒,但不影响本 probe 的控制
面结论:pause 前已有真实活跃 turn 与工具尝试;pause 后以不可伪造的 turn/started 计数
验证 15 秒无新续轮;active 后又收到新的 turn/started。

## Raw frames

以下为脚本 stdout 的原始关键帧(只省略与结论无关的 thread history/item 流):

```json
{"tMs":1797,"kind":"send:a","frame":{"jsonrpc":"2.0","id":5,"method":"thread/goal/set","params":{"threadId":"019f6408-a6d0-78c0-84ee-37727df10e22","status":"paused"}}}
{"tMs":1799,"kind":"recv:a:thread/goal/set","frame":{"id":5,"result":{"goal":{"threadId":"019f6408-a6d0-78c0-84ee-37727df10e22","objective":"In the current directory create twenty files step-01.txt through step-20.txt, each containing its own two-digit number. Work on exactly one new file per goal turn, verify that file, then end the turn so the goal dispatcher can continue. The goal is complete only after all twenty files are verified.","status":"paused","tokenBudget":100000,"tokensUsed":0,"timeUsedSeconds":1,"createdAt":1784089716,"updatedAt":1784089718}}}}
{"tMs":50707,"kind":"probe:paused-quiet","frame":{"quietBaseline":{"turnStarts":1,"turnCompletions":1,"files":[]},"quietAfter":{"turnStarts":1,"turnCompletions":1,"files":[]},"quietWindowMs":15000}}
{"tMs":50935,"kind":"recv:b:thread/goal/get","frame":{"id":3,"result":{"goal":{"threadId":"019f6408-a6d0-78c0-84ee-37727df10e22","objective":"In the current directory create twenty files step-01.txt through step-20.txt, each containing its own two-digit number. Work on exactly one new file per goal turn, verify that file, then end the turn so the goal dispatcher can continue. The goal is complete only after all twenty files are verified.","status":"paused","tokenBudget":100000,"tokensUsed":0,"timeUsedSeconds":1,"createdAt":1784089716,"updatedAt":1784089718}}}}
{"tMs":50935,"kind":"send:b","frame":{"jsonrpc":"2.0","id":4,"method":"thread/goal/set","params":{"threadId":"019f6408-a6d0-78c0-84ee-37727df10e22","status":"active"}}}
{"tMs":50942,"kind":"recv:b:thread/goal/set","frame":{"id":4,"result":{"goal":{"threadId":"019f6408-a6d0-78c0-84ee-37727df10e22","objective":"In the current directory create twenty files step-01.txt through step-20.txt, each containing its own two-digit number. Work on exactly one new file per goal turn, verify that file, then end the turn so the goal dispatcher can continue. The goal is complete only after all twenty files are verified.","status":"active","tokenBudget":100000,"tokensUsed":0,"timeUsedSeconds":1,"createdAt":1784089716,"updatedAt":1784089767}}}}
{"tMs":50947,"kind":"recv:b","frame":{"method":"turn/started","params":{"threadId":"019f6408-a6d0-78c0-84ee-37727df10e22","turn":{"id":"65079af5-f826-46f9-afbc-58169561a1b4","items":[],"itemsView":"notLoaded","status":"inProgress","error":null,"startedAt":1784089767,"completedAt":null,"durationMs":null}}}}
{"tMs":51083,"kind":"probe:result","frame":{"verdict":"PASS","version":"codex-cli 0.144.4","threadId":"019f6408-a6d0-78c0-84ee-37727df10e22","resumeMode":"automatic","quietWindowMs":15000,"turnStarts":2,"turnCompletions":1,"files":[],"durationMs":51083}}
```

## Implementation decision

- `setGoalStatus(active|paused)` 仍显式重发 runtime 缓存的 objective + token budget;
  不依赖 probe 中已经证实的 partial-update 保留作为生产安全假设。
- 持有进入只尝试 pause 一次;失败走 injected logger 后继续 M1 local hold。
- preflight 读到 paused + marker open 时不 set、不 kick;marker 已解析时用缓存字段
  active + wake,成功后才清 durable latch。
- `FLYWHEEL_CODEX_GATE_WAIT=0` 同时关闭 M1 hold 与 paused overlay,保留既有回滚面。
