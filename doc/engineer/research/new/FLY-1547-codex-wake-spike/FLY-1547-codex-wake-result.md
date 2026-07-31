# Research: FLY-1547 Codex 叫醒判定 spike — 裸 TUI 形态不可官方叫醒(隐形分叉实锤)

**Issue**: FLY-1547(design review R1 Finding 5 要求的 pre-implementation 判定)
**Date**: 2026-07-30
**Source**: `/tmp/fly1547-design-review-r1.md` Finding 5;`codex-wake-spike.mjs`

## 实验

1. 按 v2 launcher 现行形态起一个**裸 `codex` TUI**(tmux,`-C /tmp/fly1547-codex-spike-cwd -s workspace-write -a never`),模型回 READY 后闲置;
2. 按 cwd 精确匹配 `~/.codex/sessions` rollout 锁定其 thread id(`019fb4d8-04a5-…`,避免误碰同机其它活 runner 的 thread);
3. 外部 spawn `codex app-server`(stdio JSON-RPC):`initialize` → `thread/resume {threadId}` → `turn/start`(铃文本)。

## 结果(证据:`codex-wake-spike-output.log` + `codex-spike-tui-pane.log`)

| 观察点 | 结果 |
|---|---|
| `thread/resume` 活 TUI 的 thread | **成功**(status idle → resumed,MCP servers 全起) |
| `turn/start` 铃 turn | **成功执行**,模型在 app-server 侧回 `BELL-RECEIVED`(delta 流完整) |
| **活 TUI pane 是否渲染该 turn** | **零渲染** —— pane 停留在 READY/空 prompt,操作者永远看不到这个 turn |

## 结论(冻结契约)

1. **裸 TUI 形态的 codex 会话今天没有官方叫醒口**:外部 app-server `turn/start` 会在一个**隐藏面**上分叉会话活动(烧 token、可当隐形消费者),TUI 不渲染 —— 比"叫不醒"更糟,是危险操作。发送器**必须拒绝**对裸 TUI 会话使用 JSON-RPC 铃。
2. 对现行裸 TUI codex runner,铃 = issue 授权的**最后手段贴指针**(tmux 贴"你有新信",不贴内容)。
## 追加(R2-F4 正向 spike,2026-07-30):远控附着 runner 形态真机 PASS

按 codex R2 Finding 4 要求,对**提案的替代 runner 形态**做了 exact-form spike(`remote-runner-spike.mjs` + `remote-attached-tui-pane.log`):

1. `spawnCodexDaemon`(import 自 `flywheel-claude-runner`,含 lock/socket/进程组机制)起隔离 CODEX_HOME 的远控 daemon(`--remote-control --listen unix://…`,短 socket 路径);
2. daemon 连接上 `thread/start`(workspace-write / approval never)→ **先跑一个 bounded bootstrap turn**(FLY-398 教训:无 turn 的 thread 无 rollout 不可 resume)→ threadId 持久化;
3. tmux 里 `codex resume --remote "unix://<sock>" -C <cwd> -s workspace-write -c 'approval_policy="never"' <threadId>` 附着 TUI —— **渲染出完整 thread 历史**;
4. **第二个外部连接** `turn/start`(带稳定 `clientUserMessageId="fly1547-bell-1"`)注入铃指针 —— **铃与模型回复 BELL-RECEIVED 全部渲染在附着 TUI pane 里**。

结论:替代形态端到端成立;铃 turn 可见、thread 身份由 socket 路径 + 持久化 threadId 决定性绑定、幂等键由 `clientUserMessageId` 承载。daemon 拆除用进程组 kill(spike 实测 single-pid kill 不死,`kill -TERM -- -pgid` 才干净——印证 R2 引用的 `stop()+ensureDead()` 生命周期要求)。

3. 官方 JSON-RPC 铃的**可行形态** = FLY-398 已生产验证的远控附着 TUI(`codex app-server --remote-control --listen unix://…` + `codex resume --remote` 附着;Mufasa Lead 生产每日在用:runtime 经同一 daemon `turn/start`,turn **渲染在 founder 可见的 pane 里**)。v2 codex runner 若切到该 spawn 形态,~30 行发送器(import `flywheel-claude-runner` 的 `connectDaemonTransport`+`CodexDaemonClient`)即成立,thread 身份由 daemon socket 路径决定性绑定(无需 rollout 目录扫猜)。
