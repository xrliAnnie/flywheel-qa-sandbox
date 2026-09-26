# FLY-2886 QA@3 返工 — 证据
Issue: FLY-2886 (https://linear.app/geoforge3d/issue/FLY-2886)
日期: 2026-09-26
基于: ~/.flywheel/artifacts/FLY-2886/qa3/QA3-REPORT.md（QA@3 FAIL @f8e5d048）

## B1 生产布局下 broker socket 超长

先红（`codex-container.test.ts`「production layout (QA@3 B1)」，voice root 取比本机 HOME 更长的路径）：

```
   × the broker socket fits the platform limit in the production layout (QA@3 B1) > admits with a short private activation root, removed when the session closes 467ms
   × the broker socket fits the platform limit in the production layout (QA@3 B1) > removes the activation root when the admission degrades 9ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: expected 221 to be less than or equal to 100
AssertionError: expected 221 to be less than or equal to 100
      Tests  2 failed | 41 skipped (43)
```

后绿：43/43。真宿主零桩（`prodlen-parent.mjs`，voice root 与生产 `~/.flywheel/voice` 同为 33 字节，不碰生产目录；auth realpath 到生产 auth.json）：

```
{"layout":"old","result":"PARENT_ERR","ms":5666,"socketBytes":111,"message":"invalid v2 socket path"}
{"layout":"new","result":"PARENT_OK","ms":7864,"voiceRootBytes":33,"codexHomeBytes":82,"activationRoot":"/private/tmp/fw-vcap-x9JuuV","socketBytes":50,"operations":50,"unavailableIntegrations":[{"id":"context7","reason":"baseline_drift"},{"id":"github","reason":"credential_missing"},{"id":"linear","reason":"credential_missing"}],"authInodeMatchesProduction":true,"mcp":["lead_actions"]}
{"layout":"new","appServer":"STARTED","ms":2165,"accountType":"chatgpt","configOk":"verified","skillsOk":"verified","servers":[{"name":"lead_actions","tools":1}]}
```

old = 旧布局（activation 在 admission 下）复现 QA@3 的 `invalid v2 socket path`（111 字节）；new = 容器现在的 `/private/tmp/fw-vcap-*`（50 字节），parent 起来，capability app-server 用生产长度的 codexHome（82 字节）起来，订阅 `chatgpt`、有效配置与技能核过、模型侧 MCP 只有 `lead_actions`。

## H1 isolated 档同步 codesign 阻塞事件循环

先红（`browser-host-identity.test.ts`，异步 execFile 桩 + 事件循环心跳）：

```
   × pins executable bytes before executing, verifies signatures, and rejects mid-check drift 4ms
   × keeps the event loop running while the deep signature check runs (QA@3 H1) 1ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯
Error: browser_host_identity_unverified
Error: browser_host_identity_unverified
      Tests  2 failed (2)
```

后绿：2/2（browser-worker 11/11）。真宿主（`codesign-loop-lag.mjs`，真 `codesign --verify --deep`，不启动浏览器）：

```
{"case":"sync_execFileSync_control","codesign":"verified","ms":27074,"maxBlockMs":26963,"ticks":2}
{"case":"async_verifyBrowserHostIdentity","codesign":"verified","warnings":["chrome_version_drift"],"ms":23267,"maxBlockMs":19,"ticks":449}
```

旧的同步调用形态单次阻塞 26,963 ms（租约 TTL 15 s）；改后同一真检查 23 s 内事件循环最大阻塞 19 ms、心跳 449 次。isolated 端到端（`--no-headless` Chrome 会弹到 founder 屏幕）本机不跑，归 529 房 QA。
