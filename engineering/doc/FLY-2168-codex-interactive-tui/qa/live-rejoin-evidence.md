# FLY-2168 原生 TUI live rejoin — QA 证据
Issue: FLY-2168 (https://linear.app/geoforge3d/issue/FLY-2168/派工-fly-2152-的-codex-implement-继任连续出生即死22同窗兄弟全健康-出生失败根因待查)
日期: 2026-08-30
基于: plan.md

## 结论

在当前 FLY-2168 resident runner 已有的 App Server socket 与 thread 上，使用本分支的 `ensureRunnerTuiWindow` 成功创建原生 Codex TUI。窗口保持存活、显示完整交互界面、没有新建 root/fork rollout；删除专用 QA tmux session 后，resident App Server socket 仍存活。

## 前置状态

- `CODEX_HOME`: `/Users/xiaorongli/.flywheel/codex-homes/5a66ae63-fbe1-4d9f-93f3-ad53aac660d9`
- socket: `/Users/xiaorongli/.flywheel/cdx-sock/47b4c3fa1a74c2c2.sock`，类型为 Unix socket
- thread: `01a05167-e5dc-71b2-9b42-8f53efed4e45`
- policy: `sandbox_mode = "workspace-write"`，`approval_policy = "never"`
- rollout: 仅一个 root 文件 `rollout-2026-08-29T23-42-38-01a05167-e5dc-71b2-9b42-8f53efed4e45.jsonl`

## 真实开窗

先创建隔离 session `qa-fly2168-live`，再调用 build 后的生产 helper；仅注入 `ensureSessionAsync: async () => true` 跳过已完成的 session rescue，其余 window purge/create、Codex 命令和 liveness probe 均走真实实现。

返回值：

```json
{"created":true,"windowId":"@440"}
```

tmux 身份与命令：

```text
@440  FLY-2168-live-rejoin-2  pane_current_command=codex  pane_dead=0
codex resume --remote unix:///Users/xiaorongli/.flywheel/cdx-sock/47b4c3fa1a74c2c2.sock \
  -C /Users/xiaorongli/Dev/flywheel-FLY-2168 \
  -s workspace-write -c 'approval_policy="never"' \
  01a05167-e5dc-71b2-9b42-8f53efed4e45
```

`tmux capture-pane` 显示原生 Codex chrome，包括 `Ask Codex to do anything`、model/cwd/status 行和当前 thread 的既有 transcript；不是 `tail -F` transcript pane。由于 `proofshot` 未安装，terminal surface 以真实 tmux pane capture 验证。

## No-fork 与退场

- 开窗后 rollout 清单仍只有上述同一个 root 文件，没有第二个 root 或非 subagent fork。
- 精确删除专用 `qa-fly2168-live` session 后，`tmux has-session` 返回不存在。
- 删除 QA session 后 resident App Server socket 仍为 Unix socket。
- 删除 QA session 后 rollout 清单仍只有上述同一个文件。

## 嵌套 E2E 环境限制

完整 `scripts/qa-fly-1239-e2e.mjs` 从当前 Codex-hosted macOS runner 内启动新 thread 时，Codex 的 filesystem sandbox helper 以 `sandbox-exec: sandbox_apply: Operation not permitted`（status 71）退出；生产 adapter 已完成 daemon 启动、policy 检查与清理。原始结果保存在 `nested-sandbox-blocked-result.json`。该限制发生在新 thread 启动、早于 TUI 路径，因此以上 live rejoin 补充验证真实 remote TUI，而单元测试覆盖完整 adapter 生命周期与失败路径。
