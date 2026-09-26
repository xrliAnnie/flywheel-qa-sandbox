# FLY-2885 探针 4–6：v3 WebRTC `initialItems` 的角色与容量 — 实测
Issue: FLY-2885 (https://linear.app/geoforge3d/issue/FLY-2885/语音b核心连接层-引擎-b-改走-webrtc-订阅替换-websocket-api-key房间进程-webrtc)
日期: 2026-09-25
基于: research.md R3、Lead 问题 `2b75fa29`（FLY-2886 在 V2 websocket 上 `appendText(developer)` 被异步拒绝）

## 结论

1. **developer 角色被接受。** v3 WebRTC 会话把 `initialItems` 放进建会话的 call body，和 FLY-2886 踩到的 V2 `appendText(role=developer)` 不是同一路径。全部 30 场都没有 `thread/realtime/error`，也没有提前 `closed`，每场都只在我们主动 `stop` 时以 `requested` 结束。条目不超过容量上限时，模型确实用上了条目里的事实：本批 developer 8/8 次答对，外加 research 的 probe-run3。**不需要改成 user 角色。**
2. **新发现：服务端有一个不报错的容量上限，大约是真实 8,192 个 o200k token。** 条目总量超过它时，模型一条都看不到，不论事实放在第 1 条还是第 3 条、放在条首还是条中，也不论 developer 还是 user 角色。这时没有任何错误事件，模型会编一个暗号。
   Codex 客户端只按「字节/4」估算（上限 8,192），中文每 token 约 3.4 字节，所以这道检查拦不住：本批失败的 28–30 KB 在 Codex 的估算里只有 7,088–7,610。
3. 对 T8 的影响：计划写的「`initialItems` 合计 ≤32,000 字节（Codex 估计 8,000）」会让 Raya 这种记忆量大的 Lead **静默丢掉全部记忆**。要再加一条：**按 o200k 真实计数 ≤7,600**（相对 8,192 留约 7% 余量），放不下的段按计划里已有的路径回填到 prompt 的「Selected Lead memory (continued)」块。

## 数据

模型 gpt-live-1-codex、v3、WebRTC、声线 cove、固定版本 0.156.1（sha256 前缀 `0196e89f`），订阅登录，无 API key。每场事先录好同一句问题「你好，请问暗号是什么？」，暗号只写在条目里（`prompt` 组除外）。

| 组 | 条数 | 总字节 | o200k 真实计数 | Codex 估算（字节/4） | 答对暗号 | 协议错误/提前关闭 |
|---|---:|---:|---:|---:|---|---|
| research probe-run3（单条，事实在条首） | 1 | 16,461 | 4,576 | 4,115 | 1/1 | 0 |
| single-start | 1 | 10,189 | 2,963 | 2,547 | 2/2 | 0 |
| small3-mid（事实在第 2 条中间） | 3 | 4,836 | 1,426 | 1,209 | 2/2 | 0 |
| sized 8000（事实在第 1 条条首） | 3 | 24,453 | 7,126 | 6,113 | 2/2 | 0 |
| sized 9000 | 3 | 27,309 | 7,951 | 6,827 | 2/2 | 0 |
| **sized 9300** | 3 | 28,353 | **8,251** | 7,088 | **0/2** | 0 |
| **big3-first / big3-last** | 3 | 30,441 | **8,851** | 7,610 | **0/4** | 0 |
| **big3-mid / big3-start（developer）** | 3 | 31,196 / 30,441 | ≈9,000 / 8,851 | ≈7,800 / 7,610 | **0/8** | 0 |
| **big3-mid / big3-start（user +「[旁注,勿回应]」）** | 3 | ≈31,300 | ≈9,000 | ≈7,800 | **0/6** | 0 |
| prompt（暗号只在 prompt，条目是 30 KB 填充） | 3 | 30,378 | ≈8,830 | 7,595 | 2/2 | 0 |

- 上限落在 7,951 到 8,251 之间，与 8,192 吻合。超限时条目**整体**不可见，不是截掉尾部：big3-first 的暗号在第 1 条开头，同样没答出来。
- `prompt` 组说明：超限的条目不会让会话出错，也不影响 prompt 里的事实被用上。

## 证据文件

- 台架：`probe4.mjs`。每场上限 50 秒，临时 home 里只软链 `auth.json`，结束即删；不打印任何凭据。
- 日志：`probe-run4-developer-mid-{a..e}.jsonl`、`probe-run4-{developer,user}-{start,mid}-*.jsonl`、`probe-run5-developer-*.jsonl`、`probe-run6-developer-sized*.jsonl`。每份末行 `summary` 带 `errors`、`closed`、`transcripts`、`codeWordAnswered`。
- 额度：30 场，每场 10–13 秒实时音频。
