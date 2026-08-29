# FLY-545 S2 证据 — bot 供给(pool claim)+ FLY-960 残留清账
Issue: FLY-545 (URL 不可得,只写 issue 号)
日期: 2026-07-07
基于: plan.md §7 P0-S2 + gate 补充指令(清 pool-04/05 残留)

## Bot 身份台账(操作后状态)

| slot | app/bot id | 用途 | 用户名 | claim | guild 成员资格 |
|------|-----------|------|--------|-------|----------------|
| flywheel-pool-04 | 1523225879180742777 | **Note-taker(耳朵 bot,Annie 定名)** | `Note-taker`(已 PATCH) | `huddle-note-taker`(自 fly960-ears 转移) | **已在生产 guild**(FLY-960 入的;huddle 正好要它在这里,零新增邀请) |
| flywheel-pool-05 | 1523230048243417178 | FLY-960 sender → **PR-1/QA 扬声 rig** | flywheel-pool-05 | `fly545-qa-speaker`(自 fly960-sender 转移) | 在生产 guild;**teardown = QA 阶段 FINAL PASS 后退出 guild + release 回池**(见下) |
| flywheel-pool-06 | 1523232391349403850 | **Huddle 编排 bot** | `Huddle`(已 PATCH) | `huddle-orchestrator`(新 claim) | **不在任何 guild — 需 founder 点邀请**(下方 URL) |

pool.json 变更有备份:`~/.flywheel/discord-bot-pool/pool.json.bak-fly545`。

## 关键事实更正(影响部署清单)

FLY-960 的「测试 guild」**就是生产 guild**(`DISCORD_GUILD_ID` = 1485787271192907816;
Tadashi 当时原话「#fly960-spike = 用现有 General」,VC = 1485787273193853170)。所以:

- Note-taker 已就位,**不需要**founder 邀请动作;
- PR-1 真机闭环(pr1-loop.md)在生产 General VC 跑(≈20 秒两 bot 短暂进出,与 spike 同一
  授权通道);
- 「pool-04/05 残留」的实质 = 生产 guild 里的 spike 遗留成员 + 悬空 claim。**claim 已清**
  (上表);**guild 成员资格刻意保留**——pool-04 是 huddle 的正式耳朵,pool-05 是 QA 复跑
  唯一的扬声 rig(独立 QA 阶段要复现收发/barge-in 闭环)。pool-05 的退出+release 定为
  QA FINAL PASS 后的显式 teardown 步骤,不静默蒸发。

## founder 部署清单(PR-1 合入后、staged E2E 前)

1. 点邀请把 **Huddle 编排 bot** 拉进生产 guild(权限 = View/Send/Connect/Speak/**MOVE_MEMBERS**):
   `https://discord.com/oauth2/authorize?client_id=1523232391349403850&scope=bot&permissions=19926016&guild_id=1485787271192907816&disable_guild_select=true`
2. 定 **#huddle 常驻 VC**:新建一个语音频道(bot 无 MANAGE_CHANNELS,建频道是 founder 动作),
   或拍板直接用现有 General VC(1485787273193853170)。频道 id 落 `projects.json` 的
   `huddle.voiceChannelId`。
3. `~/.flywheel/.env` 加两行(token 在 `~/.flywheel/discord-bot-pool/flywheel-pool-0{4,6}/token`):
   `HUDDLE_ORCH_BOT_TOKEN` / `HUDDLE_EARS_BOT_TOKEN`,并把 `GEMINI_API_KEY` 也放进去
   (现在只在 ~/.zshrc,launchd wrapper source 不到)。
4. `projects.json` flywheel 项目加 `huddle` 块(schema 见 packages/voice-bridge/src/config.ts)。

## 复现

```bash
bash scripts/discord-bot-pool.sh list           # 台账
bash scripts/discord-bot-pool.sh verify --all   # token 活性
```
