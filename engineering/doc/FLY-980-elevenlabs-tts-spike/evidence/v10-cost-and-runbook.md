# FLY-980 V10 — 成本记账 + 接入 runbook（真机取证）

Issue: FLY-980
日期: 2026-07-08（PT 夜间）
基于: plan.md §S8；subscription 快照 out/usage-*.json（raw 留档）

## 1. 记账（Creator $22/月，character_limit 159,648 credits）

| 快照点 | character_count | 增量 | 归因 |
|--------|-----------------|------|------|
| before-all（开跑前） | 1,169 | — | 历史用量 |
| before-audition | 5,959 | **+4,790** | 全部 Agents 会话（echo 5+ 阶梯 22 + V5a/V6/V7/V8 ≈ 35+ 轮，约 25-30 分钟会话） |
| after-all（收尾） | 7,264 | **+1,305** | TTS audition（48 flash 短句 + 17 multilingual 终选句） |

**整个 spike 总消耗 6,095 credits ≈ 3.8% 月池 ≈ $0.84 等值。**

### 计费口径修正（推翻 research §3 的一半推测）

- **Agents 会话消耗计入 character（credits）池**——subscription 的
  character_count 随会话实时增长（+4790）；
- subscription API **没有独立的"275 分钟池"计数器**（全部字段枚举见
  raw json；无 convai 分钟字段）——"275 min/月"若存在独立池，
  API 不可见，dashboard 才可核（留 Annie/QA 一验）；
- 60 分钟口径估算（按本轮实测 ~4790 credits/~27min ≈ 177 credits/min）：
  60 min ≈ 10,650 credits ≈ **$1.47/小时 等值**（订阅池内现金 $0，
  月池可支撑 ~15 小时会话）；脑侧 claude -p 订阅内 $0 边际（D10'）。
- 对照（FLY-968）：multi-Gemini gated ≈ $0.68/h、OpenAI text-out ≈
  $1.2-1.3/h ——**/eleven 订阅池内现金成本 $0 是最大差异化**。

## 2. 接入 runbook（实际可用形状，逐字）

1. **shim**：OpenAI 兼容 `POST /v1/chat/completions`（SSE）+ 随机 Bearer。
2. **隧道**：`cloudflared tunnel --url http://localhost:8980`（免费随机
   trycloudflare.com URL；Authorization 头经隧道完好透传，curl 已验）。
3. **鉴权 —— request_headers 是死路**：create/PATCH 接受
   `custom_llm.request_headers.Authorization` 且 GET 回读值正确（存储 OK），
   但**运行时平台不送这个值**——实际送来的是无关的 12 字符 Bearer
   （scheme=Bearer len=19，与配置值 sha 不符）。
   **可用形状 = workspace secret**（create-agent.mjs 已内建此流程，token 走
   env `FLY980_TOKEN` 绝不进 argv）：
   ```
   POST /v1/convai/secrets {type:"new", name, value}  → secret_id
   custom_llm.api_key = {secret_id}                    # 平台送 Bearer <value> ✅
   # 用法: FLY980_TOKEN=<bearer> node create-agent.mjs <tunnel-url>
   # 清理: node delete-agent.mjs <agent_id> <secret_id>
   ```
4. **agent create 最小体**：`agent.language=zh`、`prompt.llm="custom-llm"`、
   `custom_llm={url:<tunnel>/v1, model_id, api_type:"chat_completions",
   api_key:{secret_id}}`、`tts.model_id=eleven_flash_v2_5`、
   `turn.turn_model=turn_v3`。
5. **override 安全位**：create 时 `platform_settings.overrides.
   conversation_config_override.{agent:{prompt:{prompt:true},language:true,
   first_message:true},tts:{voice_id:true}}` —— API 直接生效（R3 消除）。
6. **生产配方旋钮**：`prompt.cascade_timeout_seconds=15`（默认 8=慢脑死刑，
   上限 15）+ `turn.soft_timeout_config={timeout_seconds:3, message:"稍等哈，
   我想一下。", additional_soft_timeout_messages:[…], randomize_fillers:true,
   max_soft_timeouts_per_generation:2}`。
7. **PATCH 陷阱**：PATCH prompt 子对象是整体替换——必须带全 `llm` +
   `prompt` + `custom_llm`，否则 400 `custom_llm can only be set if llm is
   set to CUSTOM_LLM`；language_presets 需要 `{<lang>:{overrides:{agent:
   {language:"<lang>", prompt:null, first_message:null}}}}` 形状。
8. **清理纪律**：spike agent + workspace secret 用后即删（本轮已删：
   agent_7801… + secret HEofQxX…）；隧道随进程撤。

## 3. 平台侧观察杂项

- 平台每轮把**全量对话历史 + system prompt**下发给 endpoint（无状态可行，
  R7 取证：req_arrival 的 messages 原文含 override 后的 persona）；
- `elevenlabs_extra_body`/`user_id` 默认**都不带**（null）——conversation
  keying 靠会话级 WS 连接天然隔离 + spike 的 single-session 假设成立；
  多并发生产形态需在起始帧 `custom_llm_extra_body` 自带会话 id（通路已在
  e2e 脚本验证存在）。
- 温度默认 temperature=0、max_tokens=-1 下发。

## 音频/数据留档（QA 验收前不删）

- `~/fly980-eleven/audition/`（33MB，66 clips + 终选 wav）
- `~/fly980-eleven/e2e-archive/`（4.9MB，全部 e2e jsonl/results/wav）
- `out/usage-*.json` raw 快照（同步入 e2e-archive）
