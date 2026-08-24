# FLY-1911 evidence —— 原件清单与刻意的取舍

**这些是一次性的实验原件,大部分不可复现**(每次会话的时刻、转写、音频都不一样)。
原本全部只存在于 `/tmp` 的 scratchpad 里,已全部捞进仓库。

## ⚠️ 刻意**没有**提交的两件(写在这里,免得变成静默省略)

| 文件 | 大小 | 为什么不提交 |
|---|---|---|
| `B2-asker-heard-in-room.wav` | 27 MB | bot 对 bot 那次的房间原始录音,**不是 Annie**;已保留去静音版 `B2-room-speech-only.wav` |
| `probe-in-48k.wav` | 716 KB | 由已提交的 `probe-in.wav` 转出,**可复现,不是原件** |

## Annie 本人那一场

`LIVE-annie-3.jsonl` —— **她本人从未被录音**(默认不录),所以她那场**只有转写和时刻,没有音频**。
`LIVE-annie.jsonl` / `LIVE-annie-2.jsonl` 是她进房前后的两条桥。

> `LIVE-annie-4.jsonl` 和 `ANNIE-LIVE-SESSION-FINDINGS.md` **不是我写的** ——
> 同一 worktree 里有另一个 agent 在工作。我没有删改,也没当成自己的产出提交。

## 命名

`S*` 说话/听懂/打断/长会话 · `E*` 端到端 · `V*` 音色 · `W*` v3 RTP 与端点隔离 ·
`X*` v3 全链 · `D*` Discord 三条腿 · `B*` Discord↔Codex 桥 · `C*` 并发占用 · `Z1` 强制中文 ·
`LIVE-*` Annie 真机
