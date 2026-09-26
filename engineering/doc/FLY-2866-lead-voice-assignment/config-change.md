# FLY-2866 Lead 声线写进配置 — 配置变更记录
Issue: FLY-2866 (https://linear.app/geoforge3d/issue/FLY-2866/语音声线-按-prd-把每个-lead-的声线写进配置projectsjson-realtimevoice现在-17-个全是-marin)
日期: 2026-09-24
基于: research.md

## 授权

- founder 定了第 1 件：Tadashi 继续用 verse。她的原话（经 Lead 转达）：「我更喜欢老的声音，不过新的声音也 OK 吧，没有太大关系」。
- Lead 指令（2026-09-24）：先只写 Tadashi→verse、Honey Lemon→alloy，Raya 本来就是 marin；持 cfglock 原子写，记前后 sha256，跑身份和摘要校验；不重启任何进程；写完停下，等第 2 件。
- 第 2 件（5 位男性人设 Lead 是否改配男声）founder 还没答复，本次**没有改动**。

## 变更

| 项 | 值 |
|---|---|
| 文件 | `~/.flywheel/projects.json`（0600） |
| 写入时间 | 2026-09-25T01:39Z（2026-09-24 18:39 PDT） |
| 写入前 sha256 | `311dd85fbf9eaefbb513a33dae8f2adc22ca8871db1ce7b13599215d85f4fbc0` |
| 写入后 sha256 | `ff9da6f1a144f06174f9b9454256ea75abe65d0f94faac23feaf5ab9d61ac74b` |
| 备份 | `~/.flywheel/projects.json.bak-fly2866-voices-20260925T013906Z`（sha256 与写入前一致，0600） |
| 改动 | `flywheel/flywheel-eng-lead`：marin → **verse**；`flywheel/flywheel-product-lead`：marin → **alloy** |
| diff | 只有第 327 行和第 350 行，各一个 `realtimeVoice` 值 |
| 分布 | marin 15 个，verse 1 个，alloy 1 个（raya 仍是 marin） |

写入方式（`evidence/write-voices.py`，在 `scripts/flywheel-config-lock.sh ~/.flywheel/projects.json.cfglock 10` 锁内执行）：
- 核对写入前 sha256，不一致就拒绝写入。
- 核对 JSON 能逐字节往返，证明只改了指定字段。
- 每个 Lead 必须恰好出现一次，当前值必须是 marin。
- 原子写：临时文件 → fsync → chmod 0600 → rename → 目录 fsync。
- 先在副本上试跑，diff 同样只有这两行；另外用错误的 sha 做了反例测试，拒绝写入，exit 2。

## 校验（写入前后各跑一遍，在已部署主仓 `637752fcc` 下执行）

| 校验 | 写入前 | 写入后 |
|---|---|---|
| `validate-projects.js` | OK (v1) | OK (v1) |
| `summary-registry verify-activation` | ok，`643403c6…fc67a` | ok，`643403c6…fc67a`（不变） |
| `lead-identity resolve` flywheel-eng-lead `identityDigest` | `69e406c8…2d617` | `69e406c8…2d617`（不变） |
| 同上，flywheel-product-lead | `f0661056…9fff7` | `f0661056…9fff7`（不变） |
| 同上，raya | `fa94497b…8f9b3` | `fa94497b…8f9b3`（不变） |
| raya persona 门（`personaProjection`） | 无 | 无，门不生效 |

注：`verify-activation` 在 runner 默认的 TMPDIR 下会报 tsx IPC 管道 `listen EINVAL`，原因是路径过长。这是运行环境的问题，不是配置的问题。改用 `TMPDIR=/tmp/fly2866` 后通过。

## 生效方式

- Bridge 只在启动时 `loadProjects()` 读一次（`packages/teamlead/src/index.ts:21`），语音会话从内存里的 `input.projects` 取声线（`voice-session-services.ts:232`）。**要等下一次 Bridge 重启才生效**，也就是定时部署 00:00 / 12:00。本单没有重启任何 Lead 或 Bridge。
- 生效以后，今天在跑的 legacy 语音链路（`gpt-realtime-1.5` 直连）会按 Lead 取声线。FLY-2798 的引擎 A 目前只用 `FLYWHEEL_VOICE_OPENAI_LIVE_VOICE`，不读这份配置。

## 回滚

```sh
bash scripts/flywheel-config-lock.sh ~/.flywheel/projects.json.cfglock 10 \
  python3 engineering/doc/FLY-2866-lead-voice-assignment/evidence/write-voices.py ~/.flywheel/projects.json \
  <当时的 sha256> flywheel/flywheel-eng-lead=verse:marin flywheel/flywheel-product-lead=alloy:marin
```

## 后续（2026-09-25 范围改定）

- Lead 2026-09-25 改定范围（`[lead-instruction 37e7f622-a347-4266-ad45-bf8eb06f5c42]`）：新引擎 B（`gpt-live-1-codex`）只认 9 个 v3 声线，本单改为试听这 9 个，结果写进 FLY-2885 新增的 `liveVoice` 字段。
- 旧引擎男声 A/B **取消**。
- 本页记录的 `realtimeVoice` 写入**保留，不回滚**（Lead 答复 `fdd935ae`）：旧引擎还在读这个字段，而且与 PRD 一致。
- 第 5 步「529 房验证 verse」**取消**。

## 引擎 B 的 `liveVoice` 分配（founder 2026-09-26 00:09Z 已选，尚未落配置）

- **来源**：FLY-2866 Discord thread msg `1553196834481119273`，由 Lead `[lead-instruction 6f32a182-ceed-4e8a-8a8b-e1c172cc41d4]` 转达。试听页和录音见 `research-v3.md`。
- **机器可读映射**：[`live-voice-assignment.json`](live-voice-assignment.json)，17 个 leadId → v3 声线，缺省 cove。
  - 已用线上 `~/.flywheel/projects.json`（sha256 `ff9da6f1…1ac74b`）核对：17/17 个 `(projectName, agentId)` 一一对应，声线都在 9 个 v3 值以内。

| Lead | agentId | liveVoice |
|---|---|---|
| Raya | raya | **sol** |
| Tadashi | flywheel-eng-lead | **cove** |
| Honey Lemon | flywheel-product-lead | **breeze** |
| Aunt Cass | flywheel-cos-lead | **vale** |
| Peter | product-lead | **ember** |
| Oliver | ops-lead | **spruce** |
| Hiro | joycon-lead | **arbor** |
| Ariel | tidal-echo-content-lead | **maple** |
| Asha | sub-lead | **juniper** |
| Claw、Codex Infra Bot、Simba、Belle、Mufasa、Rafiki、reflection-lead（未命名）、Triton | 见 json | cove（默认） |

founder 对各声线的描述（原话留档）：

| 声线 | founder 原话 |
|---|---|
| juniper | 像播音员的中年女生 |
| maple | 声音比较高、说话比较快的中年女生 |
| spruce | 很低沉、有点大舌头的中年男声 |
| ember | 听起来有点狡猾的中年男声 |
| vale | 很沉稳、靠谱的中老年女生 |
| breeze | 比较高、听起来有一点奇怪的中年女生 |
| arbor | 低沉、听起来有气无力的中年男生 |
| sol | 比较好听的中青年女生 |
| cove | 比较好听的中青年男声 |

**怎么落地**：
- FLY-2885 还没合入，`liveVoice` 字段和它的校验（`LIVE_V3_VOICES`）都还不存在，所以**本单不写主机配置**。
- 生产的 `projects.json` 保持 sha256 `ff9da6f1…1ac74b` 不变；旧引擎的 `realtimeVoice`（Tadashi=verse、Honey Lemon=alloy，其余 marin）也不动。
- 由 FLY-2885 按这份映射写入 `leads[].liveVoice`。沿用 `evidence/write-voices.py` 的受控写法：持 cfglock、核对写入前 sha、确认 JSON 能逐字节往返、原子写。
