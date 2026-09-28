# FLY-2885 T9 各 Lead 的 liveVoice 写入配置 — 配置变更记录
Issue: FLY-2885 (https://linear.app/geoforge3d/issue/FLY-2885/语音b核心连接层-引擎-b-改走-webrtc-订阅替换-websocket-api-key房间进程-webrtc)
日期: 2026-09-25
基于: plan.md §3 T9

## 授权

- Lead 裁定 `54c3646c`：founder 选定的声线映射写进 `liveVoice`，由本单 T9 执行；不回 FLY-2866 改，也不跑它写 `realtimeVoice` 的旧脚本。
- 输入是 FLY-2866 已合入 main 的 `engineering/doc/FLY-2866-lead-voice-assignment/live-voice-assignment.json`（commit `9034bddc3`，schema `fly2866.live-voice-assignment.v1`，founder 2026-09-26T00:09Z 选定）。
- 只写 `chosen: true` 的 9 位 Lead；其余 8 位不写，引擎 B 消费时缺省 `cove`（plan T9：「其余 8 个缺省 cove」）。

## 变更

| 项 | 值 |
|---|---|
| 文件 | `~/.flywheel/projects.json`（0600） |
| 写入时间 | 2026-09-26T02:21Z（2026-09-25 19:21 PDT） |
| 写入前 sha256 | `ff9da6f1a144f06174f9b9454256ea75abe65d0f94faac23feaf5ab9d61ac74b`（即 FLY-2866 写入后的值） |
| 写入后 sha256 | `67c95f4b6a31c7c109a657e559c574ccb623fbad192281ccfa07d567d2303a5b` |
| 备份 | `~/.flywheel/projects.json.bak-fly2885-livevoice-20260926T022113Z`（sha256 与写入前一致，0600） |
| 改动 | 9 行 `realtimeVoice` 行尾加逗号，9 行新增 `liveVoice`，没有别的改动 |

| Lead | liveVoice |
|---|---|
| raya/raya | sol |
| flywheel/flywheel-eng-lead | cove |
| flywheel/flywheel-product-lead | breeze |
| flywheel/flywheel-cos-lead | vale |
| geoforge3d/product-lead | ember |
| geoforge3d/ops-lead | spruce |
| joycon-typeless/joycon-lead | arbor |
| tidal-echo/tidal-echo-content-lead | maple |
| tidal-echo/sub-lead | juniper |
| 其余 8 位 | 不写（缺省 cove） |

写入方式（`write-live-voice.py`，在 `scripts/flywheel-config-lock.sh ~/.flywheel/projects.json.cfglock 10` 锁内执行）：
- 核对写入前 sha256，不一致就拒绝写入。
- 核对映射文件的 schema、字段名、缺省值、九个声线全对得上。
- 核对 JSON 能逐字节往返，证明只改了指定字段。
- 每个 Lead 必须恰好出现一次；已有不同的 `liveVoice` 就拒绝，已是同值就跳过。
- 先写 0600 备份并核对 sha；再原子写：临时文件 → fsync → chmod 0600 → rename → 目录 fsync。

写入前先在副本上跑过：
- dry-run 的输出与真实写入逐字节相同；
- 用错误的 sha 做反例，拒绝写入，exit 2；
- 在已写的副本上重跑，applied 为 0，9 条全部跳过（幂等）。

## 校验（在副本上核了写入前后，在正式文件上又核了写入后）

| 校验 | 写入前 | 写入后 |
|---|---|---|
| 已部署的 `validate-projects.js`（主仓 `59123848a`） | OK (v1) | OK (v1) |
| 本分支带 T9 校验的 `validate-projects.js` | — | OK (v1) |
| `summary-registry verify-activation` | ok，`643403c6…fc67a` | ok，`643403c6…fc67a`（不变） |
| 9 位 Lead 的 `lead-identity resolve` `identityDigest` | 见下 | 全部不变 |

`identityDigest` 前 16 位（写入前后相同）：raya `fa94497b8ce44757`、flywheel-eng-lead `69e406c8d0c1727c`、flywheel-product-lead `f0661056ba05d2df`、flywheel-cos-lead `a576c6afebef2acf`、product-lead `bfc1e5a796754f00`、ops-lead `d45b95dd1a857427`、joycon-lead `46581d915642b59a`、tidal-echo-content-lead `53dc9b582dd09a8b`、sub-lead `130caea3e90a6c30`。

已部署的校验器（T9 之前的代码）不认识 lead 顶层的 `liveVoice`，写了也会忽略；副本上即使写一个非法值它也照样返回 OK。所以这次写入对正在运行的 Bridge 没有影响。

## 生效方式

- Bridge 只在启动时读 `projects.json`。本单合入并部署后的下一次 Bridge 重启（定时部署 00:00 / 12:00）起，投影才带 `liveVoice`，引擎 B 才用它。
- 本单没有重启任何 Lead 或 Bridge。
- 旧引擎继续读 `realtimeVoice`，不受影响。

## 回滚

```sh
bash scripts/flywheel-config-lock.sh ~/.flywheel/projects.json.cfglock 10 \
  cp ~/.flywheel/projects.json.bak-fly2885-livevoice-20260926T022113Z ~/.flywheel/projects.json
```

回滚前先确认当前文件的 sha256 仍是 `67c95f4b…`，确认期间没有别人改过它。
