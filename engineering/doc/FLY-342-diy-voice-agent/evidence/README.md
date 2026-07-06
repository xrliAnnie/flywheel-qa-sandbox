# FLY-342 Implement 实测证据包

本文件夹 = research.md §3b·附录B 实测结果的原始证据，QA 按此核（plan §6 验收口径）。
本机：Apple M5 Pro / 48GB / macOS 26.3.2；实测日期 2026-07-05。

## 文件清单

| 文件 | 是什么 | 对应 research.md |
|------|--------|-----------------|
| `environment.txt` | 硬件 / 工具链版本 / whisper 模型 sha256 与 commit / lab 路径 | §3b·附录B 抬头、方法 |
| `../eval-set.md` | 20 句中英混排 eval set（承 883 行动项，逐句标高危 slot + 评分口径） | §3b·附录B、plan §2 |
| `tts_bench_edgetts.py` | edge-tts 流式合成 benchmark（首包延迟 / RTF / 音频时长） | §3b·附录B TTS 行 |
| `logs/edgetts_bench_zh-CN-XiaoxiaoNeural.json` | 上面脚本的**原始逐句日志**（20 句） | §3b·附录B TTS 行 |
| `stt_bench_whisper.py` | whisper.cpp large-v3-turbo STT + slot 评分（反转 0 容忍 / token） | §3b·附录B STT 行 + 高危表 |
| `logs/whisper_bench.json` | 上面脚本的**原始逐句日志**（ref/hyp/rtf/reversal） | §3b·附录B STT 行 + 短板表 |
| `pipeline_demo.sh` | 最小端到端管线 demo（wav→whisper→claude→edge-tts→afplay，有界脑） | §3b·附录B demo |
| `logs/pipeline_demo.log` | demo 一次真实运行日志（分段计时 + 端到端） | §3b·附录B demo |
| `safety-gate.txt` | 生产机安全闸：实验前后进程快照 + load/内存对比 + 隔离足迹 | §3b·附录B 安全闸、plan Step 0 |
| `samples/eval02_approve-ship.mp3` | edge-tts 合成样本（第 2 句「approve…可以 ship」） | §3b·附录B TTS |
| `samples/eval03_bie-ship.mp3` | edge-tts 合成样本（第 3 句「先别 ship」，高危否定） | §3b·附录B 高危 |
| `samples/demo_reply.mp3` | demo 里 TTS 念出的回复音频 | §3b·附录B demo |
| `cosy_bench.py` | CosyVoice2-0.5B 推理 benchmark（device 可选 cpu/mps；含 device 补丁说明） | §3b |
| `logs/cosy_bench_cpu.json` | CosyVoice2-0.5B CPU 真跑逐句日志（RTF/首包/时长） | §3b |
| `samples/cosyvoice2-0.5b_cpu_01_FLY342.mp3` | CosyVoice2-0.5B 本地产出中英混说样本（第 1 句，Annie 可听） | §3b |
| `samples/cosyvoice2-0.5b_cpu_02_approve-ship.mp3` | 同上（第 2 句 approve/ship） | §3b |

## 复现（如需）

```bash
# 环境：~/fly342-voice-lab/（隔离 venv + whisper.cpp，Metal 构建）
cd ~/fly342-voice-lab
.venv/bin/python <evidence>/tts_bench_edgetts.py zh-CN-XiaoxiaoNeural   # TTS
.venv/bin/python <evidence>/stt_bench_whisper.py                        # STT（需先跑 TTS 生成音频）
bash <evidence>/pipeline_demo.sh                                        # 端到端 demo
```

## 关键数字（一眼核对）

- **edge-tts（无凭据兜底 TTS）**：首包中位 0.66s（<1.5s ✓）、RTF 中位 0.22（<1.0 ✓）→ 达标。
- **whisper.cpp large-v3-turbo（Metal，STT）**：稳态 RTF 中位 0.472、**高危否定反转 0 容忍 5/5 PASS**。
- **诚实短板**：干净音频上罕见技术 token 退化（pnpm→PMPM / xhigh→嗨到 / E2E→一二一 / hex 尾错）
  → 543 必须对 issue 号/命令 token/approve·ship 高危指令做文字二次确认。
- **端到端 demo**：本地管线部分（STT+TTS 首包）3.11s，同社区口径量级（块1 延迟行）。
- **CosyVoice2-0.5B 本地基准（48GB Mac，CPU）**：**确实跑起来了**（arm64 原生 MPS 环境，模型
  加载 ~9.5s，产出中英混说样本）；**CPU RTF 3.2–5.1 太慢，不可用于实时**。MPS + 完整 20 句
  deferred（跑时 memory_pressure flapping yellow，安全闸停）。
- **deferred**：大模型（CosyVoice3/Qwen3）延迟/RTF 需真硬件（3090 修好 / Mac Studio），本地无
  大模型机；小模型 MPS 待真空闲窗口。免费在线 demo 质量测不能干净自动化（见块3），给 Annie
  demo 链接 + 已发布指标 + 本地样本作可听参考。

## 注意

- STT 输入音频是 edge-tts **干净合成**（非真人 mic）→ slot 准确率是**上限**；真人 mic zh-en 复测 = 543 行动项。
- demo 的 claude -p 脑步骤 >60s 是本机**既有 fleet 重载**（baseline load 15）竞争，非本实验引入的负载。
