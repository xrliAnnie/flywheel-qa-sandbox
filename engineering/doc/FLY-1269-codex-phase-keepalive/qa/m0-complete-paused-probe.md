# FLY-1269 Complete→Paused 真机探针 — 验证记录
Issue: FLY-1269
日期: 2026-07-14
基于: plan.md

## Result

**FAIL（架构硬门）**。`codex-cli 0.144.4` 已证明以下前置能力成立：

1. native goal 真正到达 `complete` 后，带完整 `objective + tokenBudget` 的
   `thread/goal/set(status:"paused")` 被接受；
2. paused 状态与字段跨 daemon 退出、重启、`thread/resume` 保持；
3. goal 仍为 paused 时，exact `[phase-wake ...]` `turn/start` 被接受且只启动一个
   manual wake turn；
4. 同一 thread、同一 goal、临时 CODEX_HOME 与 socket cleanup 均可验证。

但 approved plan 的关键假设不成立：manual wake turn 已经 accepted/running 后再把同一
goal设为 `active`，server会在该 wake turn完成后自动启动第二个 goal continuation turn。
本次第二个 turn不是并发抢跑，而是在 wake turn完成后 4ms 顺序启动；但 plan Task 0
逐字要求「exactly one running/accepted wake turn、active transition不产生第二个
auto-start」，所以仍按 failure rule fail-close，停止 production implementation并重新
走 Lead architecture gate，不能自行把断言降级。

## Environment

- Codex: `codex-cli 0.144.4`
- app-server: `Mac OS 26.3.2; arm64`
- model: `gpt-5.6-sol`, reasoning effort `xhigh`
- source auth: 当前 execution 的隔离 `CODEX_HOME`
- probe runtime: 新建临时 CODEX_HOME，只复制 `auth.json` / `config.toml`
- transport: 两个临时 Unix sockets，同一临时 CODEX_HOME
- thread: `019f645c-0e9e-7152-9134-9d3e6e894071`
- command:

```bash
node --check --input-type=module < \
  engineering/doc/FLY-1269-codex-phase-keepalive/qa/m0-complete-paused-probe.mjs.txt
node --input-type=module < \
  engineering/doc/FLY-1269-codex-phase-keepalive/qa/m0-complete-paused-probe.mjs.txt
```

## Timeline

| t(ms) | Event | Observation |
|---:|---|---|
| 568 | thread/start | 新 thread `019f645c-...` |
| 727 | initial goal/set | `active`, objective完整, budget `20000` |
| 733 | initial turn/started | manual initial turn启动 |
| 13,162 | native goal update | status真正到达 `complete` |
| 17,030 | active turn drain | initial/goal continuation全部完成 |
| 17,094 | complete→paused | full-field set成功；tokens/time保留 |
| 17,095 | paused goal/get | 再读仍为 `paused` |
| 27,308 | daemon B resume | 同一 thread恢复；goal仍paused且字段完整 |
| 27,313 | manual wake turn/started | paused goal接受exact wake；只启动一个 |
| 27,410 | paused goal/get | manual wake running时goal仍为paused |
| 27,414 | paused→active | full-field set成功；没有并发第二 turn |
| 30,710 | wake turn/completed | exact wake turn正常完成 |
| 30,714 | second turn/started | active goal自动续轮；违反Task 0 invariant |
| 40,230 | cleanup/result | daemon退出，scratch/socket删除；verdict FAIL |

## Raw Key Frames

```json
{"tMs":13162,"kind":"recv:a","frame":{"method":"thread/goal/updated","params":{"threadId":"019f645c-0e9e-7152-9134-9d3e6e894071","goal":{"status":"complete","tokenBudget":20000,"tokensUsed":9225,"timeUsedSeconds":12}}}}
{"tMs":17094,"kind":"recv:a:thread/goal/set","frame":{"id":125,"result":{"goal":{"threadId":"019f645c-0e9e-7152-9134-9d3e6e894071","status":"paused","tokenBudget":20000,"tokensUsed":9225,"timeUsedSeconds":12}}}}
{"tMs":27308,"kind":"recv:b:thread/goal/get","frame":{"id":3,"result":{"goal":{"threadId":"019f645c-0e9e-7152-9134-9d3e6e894071","status":"paused","tokenBudget":20000,"tokensUsed":9225,"timeUsedSeconds":12}}}}
{"tMs":27313,"kind":"recv:b","frame":{"method":"turn/started","params":{"threadId":"019f645c-0e9e-7152-9134-9d3e6e894071","turn":{"id":"019f645c-7778-7e90-8439-21ac53356ce8","status":"inProgress"}}}}
{"tMs":27414,"kind":"recv:b:thread/goal/set","frame":{"id":6,"result":{"goal":{"threadId":"019f645c-0e9e-7152-9134-9d3e6e894071","status":"active","tokenBudget":20000,"tokensUsed":9225,"timeUsedSeconds":12}}}}
{"tMs":30710,"kind":"recv:b","frame":{"method":"turn/completed","params":{"turn":{"id":"019f645c-7778-7e90-8439-21ac53356ce8","status":"completed"}}}}
{"tMs":30714,"kind":"recv:b","frame":{"method":"turn/started","params":{"threadId":"019f645c-0e9e-7152-9134-9d3e6e894071","turn":{"id":"0675f636-2d73-42c2-9ed5-4ae3406e0771","status":"inProgress"}}}}
{"tMs":40230,"kind":"probe:result","frame":{"verdict":"FAIL","error":"paused-to-active transition created a duplicate turn after the accepted wake","turnStarts":4,"turnCompletions":3,"turnStartRpcCount":2,"cleanup":{"daemonExited":true,"scratchRemoved":true,"socketARemoved":true,"socketBRemoved":true}}}
```

## Architecture Question

最窄可行修订是把安全断言从「active 后永远只有一个 turn」改成：

- exact manual wake 必须是恢复后的第一个 turn；
- `paused→active` 在该 turn仍running时不得并发启动第二 turn；
- 只有 wake turn完成后，native goal才可顺序 auto-continue。

这保留了 exact handback、same-thread goal loop 与 no-concurrent-duplicate，同时把观察到的
第二 turn解释为正常 goal progression。该修订改变已批准 plan 的关键 invariant，必须由
Lead明确批准后才能继续；若不批准，则需重新选择 activation protocol。
