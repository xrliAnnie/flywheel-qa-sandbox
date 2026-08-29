# FLY-960 evidence — 00 环境就绪清单

日期: 2026-07-07
执行: implement 阶段 Runner (exec abb1b54d)

## Bot 身份 (Step 0.1)

| 用途 | Pool slot | Claim 名 | Token |
|------|-----------|----------|-------|
| 耳朵 bot | flywheel-pool-04 | fly960-ears | TOKENS_LOADED(值不记录) |
| 发送 bot | flywheel-pool-05 | fly960-sender | TOKENS_LOADED(值不记录) |

Token 装载方式:`export FLY960_EARS_TOKEN="$(cat ~/.flywheel/discord-bot-pool/flywheel-pool-04/token)"`(不回显、不落盘)。

**命名(Annie 拍,lead-instruction 37491654)**:全局 username 保持 pool 名不动;测试 server 内
昵称 = 「耳朵bot·借用中」(pool-04)/「嘴巴bot·借用中」(pool-05),已生效。

**Spike 收尾清单(Annie 拍,覆盖 plan「不 release」的原设定)**:
- [ ] 清掉两只 bot 的 guild 昵称(PATCH nick=null)
- [ ] 两只 bot 退出测试 guild(DELETE /users/@me/guilds/{guild})、release pool claim 放回池
- 边界:这两只只进测试 server、prod 永不使用;FLY-545 正式上线另建正式命名 bot。

## 场地 (Step 0.2)

- ask 已发 Tadashi(question cb3eea53);Tadashi 回复(lead-instruction 1a5161d9,2026-07-07):
  - 语音频道已就绪:**channel 1485787273193853170**(guild 1485787271192907816;Tadashi 原话「#fly960-spike = 用现有 General」——bot 进 server 后先 GET /channels/<id> 验 type=2 GUILD_VOICE 再用)。
  - 两个 bot 的 OAuth 邀请 = founder 动作(不冒用 founder 会话红线),已排进 Annie 早报清单。
- Token 登录 smoke(2026-07-07):`login-smoke.mjs` 两个 token 均 LOGIN_OK
  (flywheel-pool-04#6413 id=1523225879180742777 / flywheel-pool-05#0771 id=1523230048243417178),
  guilds=0 —— token 有效、等 OAuth 邀请。

## 本机环境 (Step 0.3)

| 项 | 结果 | 备注 |
|----|------|------|
| .node-version(repo 钉) | 22 | |
| node --version(实际) | v25.6.1 | **偏差**:本机无 mise/nvm/volta/fnm/brew node@22,切不到 22 → 按 plan 记录偏差,依赖 Task 1 的 opusscript 纯 JS 兜底(原生 @discordjs/opus 单独装、失败不阻塞) |
| ffmpeg | 8.1.2 | OK |
| flywheel-comm main-checkout dist | FWCOMM_OK | /Users/xiaorongli/Dev/flywheel/packages/flywheel-comm/dist/index.js 存在 |
| GEMINI_API_KEY | GEMINI_OK source=zshrc | 解析链前四级(shell / ~/.flywheel/.env / GOOGLE_API_KEY / NANOBANANA)在非交互 shell 均空;`~/.zshrc` 含 `export GOOGLE_API_KEY=…` 与 `export NANOBANANA_GEMINI_API_KEY=…`(值不记录)。转写运行时从 zshrc 提取 export 行装载。key 真通的证明 = Step 1.4 transcribe ref 音频跑通 |

## Upstream 刷新 (§0 note 6, 2026-07-07)

| 检查 | 结果 |
|------|------|
| discord.js repo 0.19.2(2026-03-17)之后新开 DAVE issue | **零条**(gh search created:>2026-03-17 + DAVE,结果空)— 与 research.md §3.1 一致 |
| pycord PR #3159(B 路径收侧分支) | 仍 open、未 merge;head 05cf65fa6d81567a8a4347ac961a093981554137;最后更新 2026-06-15 — 与 research.md §4.1 一致 |
| @discordjs/voice npm latest | 0.19.2 — 与 plan pin 一致 |

结论:research.md 的已审计状态无实质变化,按 plan 原样执行(A → B → C)。

## Spike 依赖版本(Task 1 实装)

- discord.js: 14.26.4
- @discordjs/voice: **0.19.2**(pin ✓)
- @snazzah/davey: **0.1.12** ✓
- prism-media: 1.3.5
- opusscript: 0.0.8(plan 原写 ^0.1.1 与 prism-media 1.3.5 peerOptional ^0.0.8 冲突 → 降级,偏差记录)
- opus decoder 实际生效: **opusscript**(@discordjs/opus 无 Node 25/v141 prebuild、源码编译未产出;路径 A 采集不解码——原始 opus 写 Ogg、ffmpeg 端解码,无影响)

## STT 上限校准(Step 1.4)

- GEMINI key 真通:`node transcribe.mjs` 对参考音频转写成功(gemini-2.5-flash)。
- 正式参考音频 = `ref/ref-48k-slow.wav`(rate=-20%);基线命中宽松 12/15 / 严格 10/15,
  miss 全部来自 zh-TTS 读英文专名发音。判据②主口径改为「收音轮 transcript vs 校准
  transcript 相对比较(≥ 基线的 80%)」,副口径关键词绝对数照记——细节见 spike README。
- 校准 transcript:`ref-calibration-slow.txt`(归档于本 evidence 目录)。
- afplay 人耳抽查:headless session 无法执行;由转写自检等价覆盖(5 句结构完整、内容对应)。
