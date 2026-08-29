# FLY-968 参考话术集（写死，供 gen-ref-audio.sh 生成音频）

Issue: FLY-968
日期: 2026-07-07
基于: ../../doc/FLY-968-voice-model-bakeoff/plan.md §3 P0

| id | 用途 | 文本 |
|----|------|------|
| u1 | 中文问话（S1 同款，V1/V2/V6/V8 用） | 帮我看一下，Huddle 模式今天能不能用？ |
| u2 | 中英混说（转写质量，V1/V9 用） | 帮我 check 一下 FLY-968 的 status，顺便看看 PR 有没有 approve。 |
| u3a | 点名句 Tadashi（T3-b 编排用） | Tadashi，帮我总结一下今天的部署进展。 |
| u3b | 点名句 Honey Lemon（T3-b 编排用） | Honey Lemon，产品这边有什么新的想法？ |
| u3c | 点名句 Hiro（T3-b 编排用） | Hiro，Joy-Con 项目下一步做什么？ |
| u4a | 跨 agent 事实源（T3-c：A 的回答埋唯一事实） | Tadashi，这次部署的内部代号是什么？ |
| u4b | 跨 agent 引用验证（T3-c：问 B 必须用 A 的事实） | Honey Lemon，Tadashi 刚才说的部署代号是什么？ |
| u4c | 负对照（T3-c：C 未补喂，同问应答不出） | Hiro，Tadashi 刚才说的部署代号是什么？ |
| u5 | founder 补喂后点名提问（T3-c 场景①） | Tadashi，我刚才说发布时间定在什么时候？ |

生成命令见 `../gen-ref-audio.sh`（edge-tts → ffmpeg 16k/24k mono PCM，
音频产物 gitignored，文本以本文件为准）。
