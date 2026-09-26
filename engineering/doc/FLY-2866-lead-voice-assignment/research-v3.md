# FLY-2866 新引擎 B 九个 v3 声线试听 — 调研
Issue: FLY-2866 (https://linear.app/geoforge3d/issue/FLY-2866/语音声线-按-prd-把每个-lead-的声线写进配置projectsjson-realtimevoice现在-17-个全是-marin)
日期: 2026-09-25
基于: research.md

## 范围改定

Lead `[lead-instruction 37e7f622-a347-4266-ad45-bf8eb06f5c42]`（founder 2026-09-25 15:44 PDT 同意）：
- 新引擎 B（`gpt-live-1-codex`）只接受 9 个 v3 声线：juniper / maple / spruce / ember / vale / breeze / arbor / sol / cove，缺省是 cove。
- 本单改为试听这 9 个声线；founder 选定后，写进 FLY-2885 新增的 `liveVoice` 字段。
- 旧引擎男声 A/B 取消。已写入的 `realtimeVoice` 保留（Lead 答复 `fdd935ae`）。

## 方法

- **路径**：同 FLY-2884 原型。`codex app-server`（codex-cli 0.157.0），realtime `version: "v3"`，显式指定 `model: "gpt-live-1-codex"`，走 WebRTC，用 ChatGPT 订阅账号（account/read 返回 `chatgpt`/`pro`）。
  - 临时 `CODEX_HOME` 里的 auth.json 是指向 `~/.codex/auth.json` 的软链；去掉了 `OPENAI_API_KEY`；没有登录或切号。
  - 不接 Discord。上行每 20 ms 发一个 Opus 静音帧，下行 RTP 解码成 48 kHz 的 wav。
  - 脚本：`evidence/v3/record-v3-voice.mjs`。
- **listVoices**：v1 组 = 上面 9 个，`defaultV1 = cove`（`runs/*/*/session.jsonl`）。
- **朗读**：`appendSpeech` 送同一句：「你好，我是你的 Lead，今天由我来跟你同步进度。我这边有两件事已经做完，还有一件在等你拍板，我一件一件跟你说。」
  prompt 要求逐字朗读、不主动开口。
- **核对**：`evidence/v3/audition.py`。
  - 裁掉首尾静音后，用 `gpt-4o-transcribe` 转回文字，只比较汉字部分的字错率；≤0.05 算照原句念了。
  - 音高用 YIN（`evidence/pitch.py`）；语速 = 43 音节 ÷ 裁剪后片段时长。
  - 每个声线最多录 3 次；spruce、vale、sol 第一轮不理想，又各补录 3 次（`runs/fly2866-v3-run-b`），取字错率最低的一次。
- **鉴权**：全程没有 401。

## 结果（`evidence/v3/audition-final.json`）

| 声线 | 选用那次的字错率 | 音高（所有有效录音） | 字/秒 | 录音次数 |
|---|---|---|---|---|
| juniper | 0 | 182 | 5.0 | 1 |
| maple | 0.022 | 218 | 6.3 | 1 |
| spruce | 0 | 88 / 107 / 111 | 6.2 | 5（2 次自编内容） |
| ember | 0.022 | 113 | 5.8 | 1 |
| vale | 0 | 135 / 175 / 194 | 5.0 | 5（1 次自编，1 次无声） |
| breeze | 0 | 146 / 182 | 4.5 | 2 |
| arbor | 0.022 | 86 / 97 | 5.6 | 2 |
| sol | 0.044 | 155 / 156 / 180 / 198 | 4.7 | 5（1 次自编） |
| cove | 0 | 99（冒烟那次 121） | 5.6 | 1（另有 1 次冒烟） |

读法：
- 9/9 都能用。所有 v3 声线 `realtime/start` 都被接受，都出了声。
- **同一个声线，每次录的音高浮动很大**（vale 135–194 Hz，sol 155–198 Hz）。只有 v3 的 Live 模型这样；旧引擎同一个声线几次录音都很稳（research.md）。所以音高只能当参考，男声还是女声要靠 founder 亲耳听。
- 相对稳定的是：arbor、spruce、cove、ember 偏低沉（86–121 Hz）；maple、juniper 偏高（182–218 Hz）。

## 给 FLY-2885 的发现

1. **v3 的 `appendSpeech` 会自己加内容，不只是改字。** 两轮正式录音一共 23 次（另有 1 次冒烟），其中 4 次在念完原句后又自编了一段「工作汇报」（spruce 2 次，vale、sol 各 1 次，字错率 2.3–2.7），内容是虚构的（「需求文档已补齐」「测试环境已搭好」之类）。
   FLY-2885 R4 只观察到「改写」，这次看到的是**凭空增加事实**。对 `verification:"required"` 的朗读回执、以及 Lead 回复的准确性，风险更高。
2. 23 次里有 1 次整段没有声音（vale）。
3. 另有十几次存在 1–6 个字的出入，一部分是模型改字（比如「做完」念成「做完了」、「跟你」念成「给你」），一部分是识别误差。原始记录见 `runs/*/audition.json`。

## 交付

- 试听页（线上版，Web Audio 播放）：https://fw-reports-6da062.vercel.app/r/8d11a0090348e29641d3225736957db8/
  - 网关 CSP 是 `default-src 'none'; script-src 'nonce-…'`，没有 media-src，所以 `<audio>` 放不出声。
  - 改成把 mp3 以 base64 放进自动加 nonce 的内联脚本，点击后用 `decodeAudioData` 播放。
  - 用 headless Chrome 通过 CDP 模拟点击，确认线上能解码播放，复制和兜底都能用；390px 手机视口下没有横向溢出。
- 页面内容：9 节，每节一个播放按钮和一个评论框；17 位 Lead 各一个下拉框选声线（不选就是默认 cove）；最后一个「复制全部评论」按钮。
- 9 段 mp3 在 `evidence/v3/mp3/`，可以作为 Discord 附件备用。
- founder 选定之后：如果 FLY-2885 已合入，就写 `leads[].liveVoice`（沿用 `evidence/write-voices.py` 的受控写入方式，要改成写 liveVoice 字段）；如果还没合入，先把映射写进 plan。
