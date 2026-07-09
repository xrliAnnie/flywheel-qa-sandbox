# FLY-980 V6/V7/V8 — 打断 · 工具通路 · 多 Lead override（真机）

Issue: FLY-980
日期: 2026-07-08（PT 夜间）
基于: plan.md §S5/§S6

## V6 打断（barge-in）— PASS，R2 回答完毕

答中打断 ×3（u4slow 长答案 + 答中再喂人声）：

- 平台在 barge-in 后 **~660ms** 发出 `interruption` client event（3 次全有，
  event_id 62/132/244/299）；
- **平台确实会中止对 endpoint 的 in-flight HTTP 请求**：shim 记录到
  2.9s/2.9s/4.8s/5.9s 的 early abort（明显早于 ~7.8s cascade 超时），
  与 interruption 事件对齐 —— 文档没写的行为，真机坐实；
- shim 的 AbortController → claude 子进程 kill 通路全程正确（V1 单测 +
  真机 abort 双验证）；打断后的后续轮次正常回答，会话不受损。

## V7 工具通路 — PASS（a 真机走通 + b 演示成立）

### V7a：language_detection 系统工具（平台工具面）

配置：`built_in_tools.language_detection = {name, description,
params:{system_tool_type:"language_detection"}}`（PATCH 接受形状逐字记录）
+ `language_presets.en.overrides.agent.language="en"`。

完整往返链实录（说英文 u3en 触发）：
1. 平台在 chat.completions 请求带 OpenAI `tools` 数组下发；
2. shim 回 OpenAI tool_calls 格式（`finish_reason:"tool_calls"`）；
3. 平台执行：`agent_tool_response {tool_name:"language_detection",
   is_called:true, is_error:false}` —— **系统工具经 custom LLM 可用**。

⚠️ 真机发现：平台执行完工具会立刻带同一句用户话重新调 LLM——启发式若再
命中就**无限循环**（1.2s 内 6 连发，同 event_id）。生产实现必须 per-turn
去重；spike 已加 15s per-key 冷却演示修法（shim-core
`maybeToolCallWithCooldown`）。

### V7b：endpoint 内消化（推荐主线）

`FLY980_INJECT_FACTS=1`，问「FLY-980 现在是什么状态？」→ shim 把 mock
issue_status 数据注入 prompt → 脑口语化转述：

> "Fly980现在还在进行中,PR还没开。刚跑完延迟压测,shim那边的合同测试都
> 通过了,接下来要做真机端到端的测试。"

注入事实全部命中，零平台侧改动 —— ask_lead/issue_status 类工具走 shim 内
消化的路线成立（工具权限留在我们侧，贴 founder-only-authority 安全模型）。

## V8 单 agent + per-session override 承载多 Lead — PASS，R3 消除

- **override 安全位经 API 一次设置成功**（create 时 `platform_settings.
  overrides.conversation_config_override`，readback 确认 voice_id/prompt/
  language/first_message 全 true）—— 不需要 dashboard 手工，R3 风险消除。
- 同一 agent 两次会话（conversation_config_override 起始帧）：

| 会话 | voice override | persona override | 实测自我介绍 |
|------|----------------|------------------|--------------|
| A | Brian（男声） | Tadashi persona | "我是 Tadashi，Flywheel 的工程 Lead，管技术团队和产品落地这块" |
| B | Sarah（女声） | Cass persona | "我是Cass，Flywheel的总管，平时负责帮大家统筹协调事情" |

声线与自称**均按会话切换**；音频留档
`~/fly980-eleven/e2e-archive/e2e-v8-{tadashi,cass}-u6who.wav`（Annie 可
直接试听对比）。**单 agent 承载 8 Lead 的架构成立。**

persona 通路细节（Codex R1#1 设计的验证）：平台把 override 后的 system
prompt 随 messages 全量下发 → shim 落 per-conversation identity 文件 →
claude -p `--append-system-prompt-file` —— 全链真实生效，无固定 persona
串味。

## 复现

```bash
node e2e-session.mjs <agent_id> --label v6 --rounds u4slow,u4slow,u4slow --interrupt
FLY980_TOOL_MODE=auto node shim.mjs   # + u3en 轮 → V7a
FLY980_INJECT_FACTS=1 node shim.mjs   # + u5status 轮 → V7b
# V8 —— shim 必须 FLY980_RESUME=0(与原始运行一致,shim-v8.log 可证):平台默认
# 不带 elevenlabs_extra_body/user_id,resume 模式下两次会话会落同一个
# single-session 键共享 brain 串味。要用 resume 复现 V8 就必须给每次会话
# --extra-body '{"conversation_id":"<唯一 id>"}'(custom_llm_extra_body 通路)。
FLY980_RESUME=0 node shim.mjs
node e2e-session.mjs <agent_id> --label v8 --rounds u6who \
  --override-voice <voice_id> --override-prompt-file <persona.md>
```
