# FLY-342 真人 DIY voice agent 做法 · 接 883 DR — 实施计划

Issue: FLY-342 (https://linear.app/geoforge3d/issue/FLY-342/voiceresearchextend-真人-diy-voice-agent-做法-接-883-drtts-管线-vs-gemini)
日期: 2026-07-05
基于: research.md（同文件夹）

> 本计划给**三段式的 Implement 阶段**执行（同分支）。Design 阶段已完成纸面研究
> （research.md），本阶段只做一件核心事：**把 research.md 里所有「待实测」占位用真机
> 证据回填，定稿交付**。这是 research issue —— **不写 FLY-543 的实现代码**。
> （Codex design review R1 意见已并入：Qwen Mac 路径改为如实描述、B 档退路矩阵化、
> STT 加验收线、生产机安全闸、证据清零规则。）

## 0. 范围（明确边界）

**做**：
1. 本地 TTS 实测（CosyVoice 为 Apple Silicon 主实验对象，Qwen3-TTS 同窗口尝试）；
2. STT 实测（whisper.cpp 中英混说转写，**有验收线**，见 Step 3b）；
3. 一个**最小单轮管线 demo**（wav/mic → STT → Claude → TTS → 播放，纯本地脚本）——
   回答 Annie「本地系统搭出来长什么样」的实物证据；
4. 回填 research.md 全部「待实测/草案」占位（TL;DR、§5.1、§5.2、§6、§8 及声线克隆
   相关句——以 Step 6 的全文扫描为准，不以章节清单为准），定稿推荐配置；
5. PR + 报 Tadashi 转 Annie。

**不做**：FLY-543 skill 代码、Discord 桥（FLY-544）、Gemini Live 实测（883 DR 已给
纸面证据，realtime 实测是 543 动工时的 eval 行动项）、声线克隆产品化（FLY-547）。
demo 脚本是**证据物**不是交付代码——放 doc 文件夹或 scratch，不进 packages/。

## 1. 前置检查（Step 0）

**硬件/环境**：
- [ ] 实测机配置：`system_profiler SPHardwareDataType`（芯片/内存落档案）。
  内存 <16GB 则直接降低预期、优先 B 档验证。
- [ ] 磁盘余量：装单个本地 TTS ≥20GB；**两个都装 ≥50GB**。不足则只装 CosyVoice。
- [ ] Python 3.10+ / uv 或 conda 可用；`brew install ffmpeg sox`。

**云凭据预检（B 档可用性，缺了要留痕不留坑）**：
- [ ] Groq API key 有无（STT 云兜底）；
- [ ] Azure Speech key 有无 + **F0 免费层在账号/区域真可开**（开资源→合成 1 句验证）；
- [ ] 任一缺失：向 Tadashi `flywheel-comm ask` 要一次；要不到就把「B 档 demo 不可执行 +
  原因」如实写进交付（成本结论仍可给，标注未实跑）。edge-tts 无需凭据，作最后兜底。

**生产机安全闸（这台 Mac 同时跑 Flywheel fleet，硬规则）**：
- [ ] 开跑前经 Tadashi 确认空闲窗口（`flywheel-comm ask`，重负载步骤——模型下载/首次
  推理——只在确认后做）；
- [ ] 隔离环境：独立 venv/conda env + 独立 scratch 与模型缓存目录（如
  `~/fly342-voice-lab/`），**不装全局包、不碰 launchd/plist/服务、不改生产配置**；
- [ ] 开跑前后各记一次 Flywheel 进程快照（`ps` Bridge/Lead/runner 计数）；首次推理时
  盯 `memory_pressure` 与 CPU；
- [ ] **停机条件**：内存压力进 yellow/red、系统明显卡顿、或任何 Lead/Bridge 掉线迹象
  → 立即停实验、记录、等窗口再续；
- [ ] 收尾：只清理本 run 创建的缓存/目录。

**不阻塞项**：声线克隆用模型自带/公开 demo 参考音频；克 Annie 声线需她提供 3–10s
录音 + 明确同意（异步要，不卡进度）。

## 2. 实测矩阵（Step 1–3）

### Step 1：TTS 候选安装（各限时 ~2h，超时即记「Mac 路径不成熟」并停手）

| 候选 | 定位 | 路径 | 兜底 |
|------|------|------|------|
| CosyVoice2-0.5B / Fun-CosyVoice3-0.5B | **Apple Silicon 主实验对象**（官方 MPS limited support 有据，PR #1129） | 官方 repo MPS 路径 → 失败换社区 Mac 版 v3ucn/CosyVoice_for_MacOs → 再失败换 MLX 路线 | modelscope 在线 demo（只评质量，不评性能） |
| Qwen3-TTS | **CUDA-first，官方 README 无 Mac 路径**（截至 2026-07-05：Python 3.12 + FlashAttention 2 + `device_map="cuda:0"` 示例）——期望管理：大概率 Mac 跑不起来 | 同一 2h 窗口内只试**最小尺寸模型** + 显式 MPS/CPU fallback；README 仍 CUDA-only 就记录「无官方 Mac 路径」收工 | HF/ModelScope demo 评质量 |

安装即记录：装了多久、踩了什么坑、最终能不能跑——这本身就是「Apple Silicon 成熟度」
的实测结论（负结果也是结论）。

### Step 2：eval set（一次做，三处用）

- [ ] 自建 **~20 句 eval set**（承 883 DR 行动项）：Annie 真实说话风格的中英混排句
  （从她 Discord 消息风格提炼 + 典型指令句「把 FLY-XX 派给 Tadashi」「approve 那个 PR」
  「跑一下 pnpm lint」等，含数字/issue 号/英文术语/approve·ship 类高危短语）。
  文件落 doc 文件夹（`eval-set.md`，每句标注高危 slot）。
- [ ] 用途：① TTS 念（合成质量/混排念对率）；② STT 转写；③ 留给 543 后续 realtime
  同口径对比。

### Step 3a：TTS 测量与验收线

每个跑起来的 TTS 候选记录：

| 指标 | 验收线（达标 = A 档 TTS 成立） |
|------|--------------------------|
| RTF（合成时长/音频时长，公式与计时方法落档案） | **< 1.0** |
| 首包/首句延迟（~30 字句） | **< 1.5s** |
| 混排念对率（20 句人工判） | 英文术语/数字念错 **≤ 2/20 句** |
| 主观质量 | ≥ edge-tts 同句对照（不如免费云就没有本地的意义） |
| 稳定性 | 连续播报 30 min / 100+ 句不崩不漏 |

### Step 3b：STT 测量与验收线（新增，R1 意见 3）

whisper.cpp large-v3-turbo 必测；本地不达标时加测 SenseVoice（sherpa-onnx）与云
Groq 同口径：

| 指标 | 验收线（达标 = 该 STT 可当默认耳朵） |
|------|--------------------------|
| 关键动作反转 | **0 容忍**（把「不要 ship」听成「ship」一类=直接淘汰） |
| issue/PR 号等标识符 | ≥ **19/20** 句正确 |
| 命令 token（pnpm/lint/分支名等） | ≥ **18/20** 句正确 |
| 整体词错 | 记录 WER 作参考（不设硬线，slot 指标优先） |

**换手规则**：本地 whisper.cpp 未过线 → SenseVoice、再 → Groq，谁先过线谁当默认；
全不过线 = 记录「STT 是当前短板」+ 给 543 的接口留「approve/ship 类高危指令必须
文字二次确认」的设计要求（v0.4 风险清单同款，无论 STT 多好这条都建议保留）。

## 3. 决策规则（Step 4）——组件级矩阵，无死角

**组件独立判定，组合按序取第一个全绿**：

| 优先级 | STT | TTS | 前提 |
|--------|-----|-----|------|
| 1（A 档满配） | 本地（whisper.cpp/SenseVoice 过线） | 本地（CosyVoice/Qwen 过线） | — |
| 2 | Groq | 本地 | Groq key 可用 |
| 3 | 本地 | Azure F0（预检通过）或 edge-tts | — |
| 4（B 档） | Groq | Azure F0 | 两侧凭据都可用 |
| 5（兜底） | Groq/本地 | **edge-tts**（无凭据要求） | 本地 STT 过线 **或** Groq key 可用（两者皆无=STT 侧记「不可执行+原因」） |
| 6（可选付费封底，非保证可执行） | gpt-4o-mini-transcribe | Azure S0（设月费上限 ~$5 记入结论） | **仅当 OpenAI/Azure 付费凭据已存在**（Step 0 顺带查，不专门申请）；否则只作成本结论不实跑 |

- 两个本地 TTS 都过线 → 按混排念对率 > 主观质量 > RTF 排序取一，另一个记备选；
- 任何「不可执行」（缺凭据/装不动）都**写明原因**进 research.md，不留无声空洞；
- 最终组合 = research.md §8 定稿默认件；未选组件全部记录测量值供 543 复核。

## 4. 最小管线 demo（Step 5）

用 Step 4 选出的组合跑（本地组合或云组合都要跑得通）：
`say.sh "口述一句"` → 录音/取 wav → STT → `claude -p`（或现有 Lead session 管道）→
按句切 → TTS → afplay。记录**端到端首响**（印证 research.md §3.4 的 0.5–2s 社区口径）。
产出：终端 session 录屏/音频样本，存 doc 文件夹作证据。

## 5. 回填定稿 + 交付（Step 6–7）

- [ ] **占位清零（机器可验，只扫最终交付物）**：
  `rg -n "待实测|草案|TBD|pending" engineering/doc/FLY-342-diy-voice-agent/ --glob 'research.md' --glob 'evidence/**' --glob 'progress.md'`
  归零（留存的必须是显式「留给 FLY-543/544/547」的 deferred 标注）。**exploration.md
  与 plan.md 不在扫描范围**——它们是过程文档，其中「待实测/草案」为历史性描述，
  Implement 不为通过 grep 而改写历史文档；§8 推荐配置从「草案」改「定稿」；
- [ ] **证据包 schema**（QA 按此核）：Mac 硬件档案 / 每个模型的名称·版本·commit /
  安装命令与 env 路径 / 模型缓存位置 / eval-set 文件 / 原始测量日志（RTF 公式与
  首响计时方法）/ 音频样本 / 负结果的失败日志。全部落
  `engineering/doc/FLY-342-diy-voice-agent/evidence/`；
- [ ] progress.md 更新；commit 全部 docs + 证据到本分支，push；
- [ ] PR（走 Runner 标准 APPROVE GATE 流程；标题
  `docs(FLY-342): DIY voice agent research — pipeline vs realtime + CosyVoice 实测`）；
- [ ] `flywheel-comm ask` 报 Tadashi（DONE + 一段话结论 + PR 链接），由他转 Annie。

## 6. QA 阶段提示（三段式第三段，非本阶段执行）

QA 应核：① research.md 数字与来源对得上（抽查 XHS 笔记/价格页）；② 实测声称有证据
（evidence/ 按 §5 schema 齐全）；③ 占位 rg 扫描归零；④ 结论与 Annie 方向一致
（默认管线、特殊场合 realtime）；⑤ 生产机安全闸留痕（前后进程快照一致）。

## 7. 风险

| 风险 | 处理 |
|------|------|
| Mac 上两个 TTS 都装不起来/太慢 | §3 矩阵优先级 3–6 全是活路——负结果照样定稿交付 |
| Qwen3-TTS 官方无 Mac 路径 | 已按事实降级为「同窗口尝试」，CosyVoice 是主实验对象 |
| B 档凭据缺失/F0 开不了 | Step 0 预检 + ask Tadashi 一次 + 「不可执行 + 原因」留痕；edge-tts 无凭据兜底 |
| 实测干扰生产 fleet | Step 0 生产机安全闸（空闲窗口确认/隔离 env/资源监控/停机条件） |
| 模型权重下载慢/大 | 磁盘分档（20/50GB）+ modelscope 镜像优先 |
| 克隆声线素材授权 | 默认公开 demo 音色，Annie 素材异步可选，不阻塞 |
| 价格页时效 | 定稿时复核 Groq/Azure 两个数即可（其余为背景） |

## 8. 里程碑

| # | 里程碑 | 产出 |
|---|--------|------|
| M1 | Step 0–1 完成 | 预检记录（含凭据/安全闸）+ 安装记录（成/败 + 坑） |
| M2 | Step 2–3 完成 | eval set + TTS/STT 测量表 |
| M3 | Step 4–5 完成 | 矩阵定稿决策 + demo 证据 |
| M4 | Step 6–7 完成 | 占位归零 + evidence/ 齐全 + PR + 报 Tadashi |
