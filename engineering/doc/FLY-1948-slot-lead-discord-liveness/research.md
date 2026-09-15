# FLY-1948 slot Lead Discord 通道活连接 — 调研

Issue: FLY-1948 (https://linear.app/geoforge3d/issue/FLY-1948/529房缺陷-slot-lead-的-discord-通道适配器无活连接-founderlead-整圈验不通)
日期: 2026-09-14
基于: exploration.md

## 1. 调研问题

exploration.md 的结论是:529 房缺的不是某一次拉起链的修补,而是「通道活连接」在房里没有任何断言。本文回答三个问题:

1. 「通道活着」在本机、在现有代码里,由哪几件**可机读**的硬证据构成?每一件从哪里取、什么时候成立?
2. 这些断言应该挂在 529 房现有哪几条缝上,才能既 fail-closed 又不改生产 Lead 的行为?
3. founder→Lead→founder 整圈,哪一段能自动化、哪一段只能人手,「N 秒」用什么时间戳量?

## 2. 「通道活着」的三件硬证据

| # | 证据 | 取法 | 成立时刻(本次实测) | 失效形态 |
|---|---|---|---|---|
| E1 进程 | claude(`--agent <agentId>`,且进程 env `DISCORD_STATE_DIR=<slot>/discord-state`)的**直接子进程**里有一条匹配 `_is_discord_adapter` 的 argv(`bun <abs>/discord/<ver>/server.ts`) | `ps axww -o pid= -o ppid= -o command=` + 现成的 `packages/teamlead/scripts/lib/reap-orphan-adapters.sh:_is_discord_adapter`(bash 3.2,可 source)+ 现成的 `scripts/lib/qa-launchd-lead.sh:qa_launchd_process_env_has`(按 env 精确认 claude) | 对话框确认后 ≈1s | 通道没加载(对话框没过 / 插件缺)→ 子进程不存在;适配器起了就死(bun 缺、install 失败、无 token、login 失败)→ 短暂存在后消失 |
| E2 套接字 | E1 的 pid 至少一条 `TCP … ->*:443 (ESTABLISHED)` | `lsof -nP -iTCP -a -p <pid> -sTCP:ESTABLISHED` | `gateway shard 0 ready` 前 ≈1s | identify 限流 / 网络断 / 网关踢下线(`shardDisconnect` 后持续 reconnecting) |
| E3 网关就绪 | `<DISCORD_STATE_DIR>/gateway-health.log` 里有一行 `<ISO> gateway shard <n> ready`,且 ISO ≥ 本次 Lead 启动时刻 | 文件由适配器 `GatewayHealthFiles.log` 追加,0600,256KB 轮转到 `.1`(读时要连 `.1` 一起扫) | lease 后 ≈1.2s(20:24:34.234 → 20:24:35.459) | 同一文件跨 claude 代际累积,不带「自哪次启动起」就会把上一代的 ready 当本代的 |

三件缺一不可:E1 无 E2 是「起了没连上」;E2 无 E3 是「TCP 通了但 IDENTIFY 没过」;E3 无 E1 是上一代的遗物。`bun install` 在 MCP spawn 里的失败只有 stderr,而 stderr 进 claude 的 MCP 日志、不进任何文件——所以 E1 缺失时必须**同时**抓 pane 快照与 launcher 的 poller 账本才能分型(见 §4)。

不采用的证据:
- `~/.flywheel/logs/lead-<agent>-startup.log` 的 `confirmed=1`:只证明按了键,不证明通道起了;而且是全局文件,slot 与生产 Lead 同名时会串。只用它做**分型**,不做判据。
- `Channels (experimental) messages from plugin:discord@flywheel-plugins … inject directly` 那行横幅:claude 一起就打,通道 MCP 起没起都打(本次 pane 截文里它出现在适配器就绪之前)。
- `discord_adapter_census`(`scripts/discord-plugin/cutover-discord-plugin.sh`):明文排除 `--agent flywheel-test-*`;它服务生产切换,不动它。

## 3. 断言挂在哪条缝上

### 3.1 房间就绪门(主缝)

`scripts/test-deploy.sh:1830-1857`(claude 载体分支)现在是 `lease 存在 && kill -0 pid → ready`。在它之后、`LEAD_READY=true` 之前插入一次「通道活连接」等待:

- 预算独立于 lease 预算:`LEAD_CHANNEL_READY_TIMEOUT_SEC`(默认 60s,2s 轮询)。实测适配器就绪比 lease 晚 1.2s,60s 给的是 `bun install` 冷缓存的余量。
- 三件证据全成立 → 把结果写进 `<SLOT_DIR>/launchd/<agentId>/channel-liveness.json`(0600),房间日志一行 `Lead <agent> channel live (adapter <pid>, gateway ready <iso>, established <n>)`。
- 超时 → 走现成的失败快照通道:`qa_launchd_failure_snapshot` 目前只有 `topology|bootstrap` 两个 phase,`qa_slot_report_lead_start_failure` 也只认这两个;新增 `channel` phase,快照里除现有字段外再带 §4 的分型字段。然后与 lease 超时同样处理:`qa_launchd_stop_registry` → 释放锁 → `exit 1`。**不发 room-info.json**,九步 driver 自然起不来。
- `--extra-lead`(`test-deploy.sh:1991-2030`)的每条额外 Lead 走同一函数;Codex 载体(`backend: codex-app-server`)没有插件适配器,显式跳过并在日志说明(不是静默)。

### 3.2 独立探针(第二缝,QA 节点用)

同一套判据封装成可独立运行的 `scripts/qa-529-discord-liveness.sh <slot> [--agent <id>] [--since <iso>] [--json]`,读 `room-info.json` 找坐标,输出与 `channel-liveness.json` 同 schema。用途:QA 中途(例如 Bridge 重启演练后、`kill` Lead 让 launchd 拉回后)重新断言,而不必重装房。`scripts/qa-fly-1189-room-smoke.sh` 的「Lead alive (lease)」段落改为调用它。

### 3.3 room-info.json(第三缝,只加不改)

`schemaVersion` 保持 1(现有读者只校验 `schemaVersion === 1` 与既有键),追加:

```json
"lead": {
  "agentId": "flywheel-test-2",
  "carrier": "claude-code",
  "discordStateDir": "/tmp/flywheel-test-slot-2/discord-state",
  "chatChannelId": "1493080993173737583",
  "channelLivenessPath": "/tmp/flywheel-test-slot-2/launchd/flywheel-test-2/channel-liveness.json"
}
```

`--no-lead` 房型写 `"lead": null`,让读者一眼看出这间房**没有** Discord 腿(FLY-1775 的 fidelity boundary 由此变成机读字段,不只靠路书文字)。

### 3.4 launcher 的 poller(第四缝,只加证据不改行为)

`packages/teamlead/scripts/claude-lead.sh:_poll_dev_channels_dialog_v2` 在 `DEV_CHANNELS_DIALOG_NOT_SEEN after 90s` 时,追加一次 pane 快照到同一 startup.log(每行前缀 `dialog-poller-v2: pane|`,上限 40 行、每行 200 字节),不改 `return 0`、不改超时、不发键。这是生产与房间共用的文件,改动限定为「多写几行日志」,目的只有一个:下次再出 NOT_SEEN,能从账本里直接看到 claude 当时停在哪个画面。

## 4. E1 缺失时的分型(写进 channel-liveness.json / channel-failure.json)

| reason | 判定 | 含义 |
|---|---|---|
| `claude_process_missing` | 按 `--agent` + env 找不到 claude | body 没起或已退出;交给现有 bootstrap 快照 |
| `dev_channels_dialog_parked` | pane 快照里同时含 `WARNING: Loading development channels` 与 `I am using this for local development` | 对话框没被按掉,claude 停在那里;startup.log 通常伴随 `NOT_SEEN` / `SEND_FAILED` / `CONFIRM_UNVERIFIED` |
| `adapter_missing` | claude 在、pane 无对话框、直接子进程无适配器 | 通道 MCP 没起或起了就死;附 pane 尾 40 行与 startup.log 自本次启动起的 poller 行 |
| `gateway_socket_missing` | 适配器在、无 ESTABLISHED 443 | 连不上网关;附 gateway-health.log 尾 20 行 |
| `gateway_ready_missing` | 有 ESTABLISHED、无本代 `ready` 行 | IDENTIFY 未完成 / 在 reconnecting;同上 |
| `gateway_ready_stale` | 有 `ready` 行但时间戳早于 `since` | 只看到上一代的 ready |
| `adapter_orphaned` | 匹配适配器但其 ppid==1 或 ppid≠本 claude | FLY-183 孤儿;launcher 的 reap 应已清理,出现即报 |
| `probe_unavailable` | `lsof` / `ps` / `python3` 缺或超限 | 传感器坏,fail-closed,不当 pass |

`since` = 房间在 `Starting test Lead` 前记下的 UTC ISO;独立探针可用 `--since` 覆盖(例如 launchd 拉回演练用 kill 时刻)。

## 5. founder→Lead→founder 整圈

### 5.1 链路与时间戳

```
founder 在 slot 频道发消息(Discord 服务端 ts = T0)
  → 适配器 messageCreate(非 self、非 bot 或 allowBots 命中)→ gate → chat-ingest
  → CommDB mailbox 行:type='discord_chat', to_agent=<lead>, from_agent='founder'(DISCORD_OWNER_USER_ID 命中)或 'discord:<authorId>'
       created_at = T1(入箱)
  → inbox-mcp 批量通知会话:notified_at = T2(进会话);delivered_at = T3(确认投递)
  → Lead 在同一频道回帖(slot bot 发出,Discord ts = T4)
```

- `T1−T0`:适配器→mailbox,纯代码路径,目标 ≤10s。
- `T2−T0`:「进会话」,目标 ≤30s(inbox-mcp 的批处理节拍决定;实现前实测一次批间隔)。
- `T4−T0`:「可回」,目标 ≤180s(含模型一轮)。三个数字做成探针参数,默认值写在探针里,不是硬编码在断言里。

T0/T4 从 Discord REST 读(`GET /channels/{id}/messages?after=<id>`,用 slot bot token,只读);T1/T2/T3 从 slot 的 `state/comm/<project>/comm.db` 只读(`?mode=ro`,WAL 快照)。所有时间以 UTC ISO 比较。

### 5.2 哪一段能自动化

| 房型 | 消息作者 | 可自动化? | 原因 |
|---|---|---|---|
| slot(默认) | founder 本人 | 否 | `access.json` `allowBots=[self]`,slot bot 自己的消息被适配器当 self-echo 丢弃(`server.ts:1599`);其他 slot bot 在此频道 403(FLY-2442 实测)。自动化需要改 Discord 权限或改插件,都不在本 issue 内 |
| mirror / roundtable | 另一 slot 的 bot | 是 | `allowBots` 含其他 slot bot,共享频道对 bot1 可达;探针 `--author-token-env TEST_BOT_TOKEN_1` 代发 |

所以探针 `scripts/qa-529-discord-roundtrip.mjs <slot>` 两种模式:
- `--watch`(默认,slot 房):不发消息,打印「请以 founder 身份在频道 <id> 发一条含 `[529-rt <nonce>]` 的消息」,然后在 `--timeout` 内轮询 REST 找到该消息(T0)、轮询 comm.db 找到对应 mailbox 行(T1/T2/T3)、轮询 REST 找到 bot 在 T0 之后的回帖(T4);每步落 `e2e-evidence/discord-roundtrip-<nonce>.json`。
- `--send-as <tokenEnv>`(mirror/roundtable 房):先用该 bot 代发,再进入同一 watch 流程。
- 退出码:0 全圈通过;30 T1 超时(入箱失败);31 T2 超时(未进会话);32 T4 超时(进了会话没回);其他非零 = 探针自身/坐标错误。三种超时都带已经拿到的时间戳,是诊断包不是假红。

### 5.3 与现有件的关系

- 不启用 `DISCORD_ECHO_PROBE` / `DISCORD_GATEWAY_WATCH`:它们是适配器自己发消息后的回显探针,只在适配器出站时触发,房间外无法触发,且属于 first-fleet opt-in,不借它当整圈证据。
- 不新增任何进 Lead 子进程的 env(`qa-slot-env-contract.json` 白名单不动);`LEAD_CHANNEL_READY_TIMEOUT_SEC` 只是 `test-deploy.sh` 的 CLI/env 旋钮,同 `--lead-ready-timeout` 一族。
- claude-in-chrome 发 founder 消息仍是 QA 节点的手工腿(本次 runner 的扩展未连接,见 exploration §5.4);探针把这条腿的**证据采集**自动化,不把「发」自动化。

## 6. 影响面与回滚

| 改动 | 文件 | 生产 Lead 影响 | 回滚 |
|---|---|---|---|
| 通道活连接库 + 独立探针 | 新增 `scripts/lib/qa-discord-liveness.sh`、`scripts/qa-529-discord-liveness.sh` | 无(只读 ps/lsof/文件) | 删文件 |
| 就绪门接线 + `channel` phase + room-info `lead` 字段 | `scripts/test-deploy.sh`、`scripts/lib/qa-launchd-lead.sh`、`scripts/lib/qa-lead-diagnostics.py` | 无(529 房专用) | revert |
| 整圈探针 | 新增 `scripts/qa-529-discord-roundtrip.mjs` | 无 | 删文件 |
| poller NOT_SEEN pane 快照 | `packages/teamlead/scripts/claude-lead.sh` | 生产 Lead 在 NOT_SEEN 时多写 ≤40 行日志,行为零变化 | revert 这一段 |
| 路书 + 房间烟测 | `doc/qa/framework/529-room-playbook.md`、`scripts/qa-fly-1189-room-smoke.sh` | 无 | revert |

回滚边界:全部改动都在 QA 房与日志层,不碰 Bridge、不碰插件、不碰 `.mcp.json`、不碰 launchd 生产单元。
