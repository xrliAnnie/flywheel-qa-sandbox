# FLY-543 Phase 0 spike 记录

Issue: FLY-543
日期: 2026-07-06
基于: plan.md §4 Phase 0

> 来源注记（2026-07-06，design r2 补）：本 spike 由首个 implement 会话（后因 scope 改向
> 被回收）真机产出。spike 内容是 claude CLI / mic 设备的机器事实，与新旧计划无关，
> r2 计划直接沿用（plan.md §4 S0.1/S0.1b）。该会话按旧接口建的 voice-core 脚手架已
> 归档出 worktree（接口已改为 announce/converse 双面），implement 按 r2 plan §3 重建。


## S0.1 claude -p 零工具 + resume spike

实测(claude CLI,本机,model=haiku 快速验证):

| 问题 | 结论 |
|------|------|
| 零工具形态 | **`--tools "" --strict-mcp-config` 两个都要**。只给 `--tools ""` 时内建工具没了但项目 `.mcp.json` 的 MCP servers 照样加载(round-1 实测 num_turns=5、模型真列出了仓库文件);加 `--strict-mcp-config`(且不给 `--mcp-config`)后 num_turns=1、无任何工具执行,模型只能输出假的 bash 代码块(不会真跑)。 |
| persona 注入 | `--append-system-prompt-file <file>` 生效(自称 Tadashi ✅)。 |
| resume | `--resume <session_id>` **保留** append-system-prompt 语境(续轮仍自称 Tadashi),无需重传 system prompt;resume 轮 6.5s vs 首轮 25.7s(首轮 cache 建立 ~134k tokens,项目上下文)。resume 轮**仍须重传** `--tools "" --strict-mcp-config`(工具配置不随 session 持久)。 |
| stdin prompt | `echo "<prompt>" \| claude -p ...` 生效,prompt 不进 argv ✅。 |
| session_id 获取 | `--output-format json` 的 result 对象带 `session_id`;`--output-format stream-json` 每个事件也带。 |
| 流式 | `--output-format stream-json --include-partial-messages --verbose`(--print 下 stream-json 强制要求 --verbose)→ `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":...}}}`;thinking 增量是 `thinking_delta`,只取 `text_delta`。 |

**HeadlessClaudeBrain 实现参数定稿**:resume 优先(首轮记 session_id,续轮 `--resume`),
fallback = 历史回注(resume 失败时);零工具 = `--tools "" --strict-mcp-config`;prompt 走
stdin;流式 = stream-json + include-partial-messages + verbose,过滤 text_delta。
voice-context 提示里显式写明「你没有任何工具,别输出代码块假装执行」(spike 观察到零工具
时模型会假装跑 ls)。

## S0.2 mic 采音 spike

- `ffmpeg -f avfoundation -list_devices true -i ""` → `[0] MacBook Pro Microphone`
  (另有 [1] LG UltraFine Display Audio、[2] DJI MIC MINI)。
- `ffmpeg -y -f avfoundation -i ":0" -t 3 -ar 16000 -ac 1 out.wav` 实录成功(27KB/3s)。
- whisper-cli(large-v3-turbo, Metal)转写成功。已知现象:纯静音段 whisper 幻听
  "Thank you."(whisper 静音幻觉,业界已知)——POC 确认门(gate)本来就要人工过目,
  不额外处理;VAD 接入(v1.1)后自然消失。

## S0.3 接口复审（⚠️ 已作废，勿引用）

> 本节是**旧接口合同**（whisper 管线版 plan）下的冻结结论，随 round-1 改向
> Edge TTS + Gemini Live 双面接口后**作废**。r2 的接口冻结点 = plan.md §4 S0.3：
> 必须等 **S0.2 Gemini Live spike** 跑完回照 r2 §3 合同后才冻结 types.ts。
> 本文件仅 S0.1（claude -p）与 S0.1b（mic 采音）两节的机器事实继续有效。
