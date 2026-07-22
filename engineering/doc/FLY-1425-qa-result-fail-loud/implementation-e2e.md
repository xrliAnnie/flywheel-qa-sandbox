# FLY-1425 qa-result credential-loss fail-loud — E2E 证据

Issue: FLY-1425 (https://linear.app/geoforge3d/issue/FLY-1425/enginebug2-qa-result-凭据缺失静默回退-events-假成功-fail-loud-引擎层未消费看门狗)
日期: 2026-07-22
基于: plan.md

## 隔离边界

- 真机本地进程: 当前分支编译出的生产 `run-bridge.ts`、`StateStore` 与 `flywheel-comm` CLI。
- Bridge 只监听 `127.0.0.1:19879`。
- 状态库、HOME、hooks 与 bin 全部落在 `/private/tmp/flywheel-fly1425-isolated.Z0yTS1/`，未触碰生产 Bridge 或生产状态库。
- 项目为 `test-slot-1425`。
- 启动时清除了 Linear、Discord、Supabase 与 Google 凭据；探针不依赖外部服务。

此前官方 `scripts/test-deploy.sh --alerts --no-lead 1` 预检发现四个测试槽均留有旧 PID lock，且当前 sandbox 禁止该脚本用于安全判定的 `ps -o lstart`。本轮未删除或绕过共享 lock；继续用手工启动的等价全隔离生产 Bridge 完成 drill。修正后的可复跑 driver 为 `scripts/qa-fly-1425-fail-loud-e2e.mjs`。

## 结果

2026-07-22 epoch 6 最终探针真实输出:

```json
{
  "ok": true,
  "isolation": {
    "bridge": "http://127.0.0.1:19879",
    "dbPath": "/private/tmp/flywheel-fly1425-isolated.Z0yTS1/teamlead.db",
    "projectName": "test-slot-1425"
  },
  "clientFailLoud": {
    "localExit": 1,
    "serverExit": 1,
    "eventsPersisted": 0,
    "credentialConsumed": false,
    "nodeState": "running"
  },
  "credentialHappyPath": {
    "exit": 0,
    "log": "[qa-result] decision consumed (claimId=2 serverSeq=2 idempotentReplay=false) for target=qa-fly1425-happy-exec-1784736607000-92597-implement (attempt 1/4)",
    "decisionEvents": 1,
    "credentialConsumed": true,
    "qaNodeState": "done",
    "runCurrentNode": "founder_gate",
    "founderGateState": "review"
  }
}
```

验收映射:

1. engine-owned runner 带 `FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED=1`、剥掉 credential: CLI 在网络请求前 exit 1，错误明确点名缺失的 `FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL`。
2. 即使 sentinel 也被剥掉，服务端 authority guard 仍以 `workflow_submission_required` 拒绝 engine-owned `qa_result` 的 `/events` 假路由；exit 1，事件表新增 0 行。
3. 同一隔离 Bridge 中另起 engine-owned QA attempt 并保留真实 credential: CLI 只投 `/api/workflow/decision`，exit 0，打印 `decision consumed`；credential 的 `consumed_at` 落盘，`workflow_decision` 事件 1 条，QA node 从 `running` 变为 `done`，run 真正推进到 `founder_gate=review`。

隔离 Bridge 在探针结束后已正常 SIGINT 关闭。

Founder correction 后，原 drill 中的 watchdog 结果不再是本 PR 的交付证据，也不保留对应代码或复跑逻辑；「runner 死了没交账」统一归 FLY-1386 generic 不变量框架。本页的 `clientFailLoud` 与 `credentialHappyPath` 均来自修正后 driver 的同一次真实运行，已替换 QA epoch 5 指出的陈旧误植 JSON。
