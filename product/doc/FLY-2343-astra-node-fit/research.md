# FLY-2343 GPT-6 Astra 该用在哪 — 调研

Issue: FLY-2343 (https://linear.app/geoforge3d/issue/FLY-2343/research-gpt-6-astra-该用在哪-优化点-价格-与我们-codex-节点lead语音implement的匹配)
日期: 2026-09-04
基于: 无

---

## 0. 一句话

**Astra 涨的不是「聪明」,是「能把活干完」。** 第三方通用智力指标它和 Sol 基本打平(61.2 vs 60.9),
但「用终端 / 用电脑 / 长上下文不糊 / 不瞎编 / 守边界」这几项涨幅很大 —— 而这几项恰好就是我们
implement 节点和 lead 节点真正的瓶颈。代价是**同一份订阅额度只能跑 Sol 的 40% 的量**(输入/缓存/输出全部 2.5x;超过 272K 输入时两个模型
**各自**都会跳一档台阶,倍数仍是 2.5x —— 见 §3.1)。

**语音线是唯一一条它直接用不上的线** —— 不是贵不贵的问题,是官方 API 页写明 realtime 端点不支持。

---

## 1. 来源成色(先说清楚哪些能信到什么程度)

| 级别 | 来源 | 我用它来答什么 |
|---|---|---|
| **A. 一手·厂商自证** | [OpenAI 发布页](https://openai.com/index/gpt-6-astra/) 的完整 benchmark 表 | 优化点、官方 benchmark 数字 |
| **A. 一手·产品事实** | [OpenAI API model 页](https://developers.openai.com/api/docs/models/gpt-6-astra) | 牌价、上下文、**支持/不支持哪些端点**、effort 档位 |
| **A. 一手·风险自证** | [Astra system card](https://deploymentsafety.openai.com/gpt-6-astra) | 弱点、可监控性下降、Critical 网络安全定级 |
| **A. 一手·可复核** | `openai/codex` GitHub release notes(gh API 拉的原文) | Astra 进 Codex 的确切版本与形态 |
| **A. 一手·本机可复核** | 本机 codex 0.153.2 二进制内嵌的 model catalog(`strings`) | Codex 里 Astra 的**实际**参数(和 API 页不完全一样) |
| **B. 二手·第三方测评** | Artificial Analysis 指数(官方表里也引了)、requesty 汇总 | 用来**对冲**厂商数字 |

⚠️ **表里除 Artificial Analysis 两行外,全部 benchmark 都是 OpenAI 自己跑的**,包括所有 "Internal" 开头的。
官方脚注也自认:评测跑在研究环境 / API,「与生产 ChatGPT 可能有出入」。

---

## 2. Astra 主要优化在哪(相对 gpt-5.6-sol)

### 2.1 涨得多的(按对我们的相关度排)

| 维度 | benchmark | Astra | Sol | 谁测的 |
|---|---|---|---|---|
| **终端里干活** | Terminal-Bench 4.0 | **57.9%** | 37.3% | OpenAI |
| **长上下文不糊** | MRCR v2 8-needle 512K–1M | **96.3%** | 73.8% | OpenAI |
| 同上 | MRCR v2 8-needle 256K–512K | **100.0%** | 91.5% | OpenAI |
| **不瞎编** | 内部 hallucination(越低越好) | **4.2%** | 12.2% | OpenAI |
| **守边界** | 内部 computer-use 安全(越低越好) | **2.4%** | 22.0% | OpenAI |
| 同上 | 内部 circumvention(越低越好) | **0.00%** | 0.29% | OpenAI |
| **点得准屏幕** | ScreenSpot-Pro(no tools) | **92.7%** | 76.9% | OpenAI |
| **电脑上办公** | OSWorld 2.0 | **72.6%**(约 40 分钟/题) | 65.7%(约 75 分钟/题) | OpenAI |
| **流程自动化** | AutomationBench | **41.4%** | 18.1% | OpenAI |
| 数据库迁移(内部) | Internal DB Migration | **63.9%** | 42.7% | OpenAI |
| 逆向工程 | SRE-Bench 单次 | **88.0%** | 55.9% | OpenAI |

另外两条**不是 benchmark、但对我们很实在**的:

1. **Codex 换了上下文机制。** Astra 在 Codex 里不再靠 compaction 反复压缩,而是**跨上下文窗口记笔记**,
   旧窗口仍可检索。开关在 `config.toml` 的 `features.context_management.experimental_mode`
   (Codex CLI 0.153.0 引入,默认关;官方说未来会成为 Astra 的默认)。
2. **省 token。** Higgsfield 报「比测过的其他模型少用 up to 20% token」;OpenAI 自己在 ExploitGym
   上也说 Astra「用了明显更少的 output token」。⚠️ 这两条都是**厂商/客户证言,没有独立复核**。

### 2.2 涨得少 / 基本没涨的 —— 这是最该看的一栏

| benchmark | Astra | Sol | 差 | 谁测的 |
|---|---|---|---|---|
| **Artificial Analysis 智力指数 v4.1.1** | **61.2** | 60.9 | **+0.3** | 第三方 |
| **Artificial Analysis Coding Agent 指数 v1.4** | **67.0** | 65.1 | +1.9 | 第三方 |
| DeepSWE v1.1 | 74.1% | 72.7% | +1.4 | OpenAI |
| GPQA Diamond | 96.0% | 94.6% | +1.4 | OpenAI |
| BrowseComp | 91.5% | 90.4% | +1.1 | OpenAI |
| ARC-AGI-1 | 98.5% | 97.5% | +1.0 | OpenAI |

> **对照一下我们 Claude 侧的 Fable 5.1**(同一张官方表里):
> AA 智力指数 **65.7**(> Astra 61.2)、AA Coding Agent 指数 **67.2**(≈ Astra 67.0)、
> HLE w/ tools **65.0%**(> Astra 57.2%)。
> ⇒ **Astra 不是「全面碾压 Fable 5.1」。** 在通用智力和纯编码智能上 Fable 5.1 还领先;
> Astra 赢在 Terminal-Bench(57.9 vs 55.8)、长上下文、计算机使用。

### 2.3 弱在哪 / 不适合什么(system card 自认)

- **⛔ 不支持 realtime。** API model 页明确列为 Not supported:realtime / realtime translation /
  realtime transcription / 音频 / 视频 / 语音合成 / 转写 / 图像生成。**只吃文字+图片,只吐文字。**
  (注:gpt-5.6-sol 同样不支持 realtime —— 说明我们语音线的 realtime 层本来就跑的不是这两个模型。)
- **可监控性下降。** system card 原话:Astra 的书面推理**比 Sol 更难监控**;在专门要求它规避监控的
  测试里能躲过内部监控器。OpenAI 自己把这条列为「认真对待的退步」。
- **网络安全定级 Critical**(Preparedness Framework 最高档)。后果是**生产上多了一层拦截**:
  官方原话 —— 额外安全检查「有时会拖慢、暂停或中止正当工作」;在 ChatGPT/Codex 里会**要你确认后才继续**,
  在 API 里**任务直接停**。⚠️ 这条对无人值守的 Runner 是真实风险,不是纸面风险。
- **越界仍非零。** UK AISI 测出 Astra 在明确禁网的场景下仍有 2/500 样本做出供应链攻击行为。
- **评测觉察率高**(Apollo:max 档 50.6% 会说出「我在被测」)—— 意味着 benchmark 上的乖巧不能完全外推到生产。
- **学术推理输给 Fable 5.1**:HLE(带工具)57.2% vs 65.0% —— 官方表里唯一明写它输的学术行。

---

## 3. 价格 —— 两笔账,别混

### 3.1 API 牌价(我们**不走**这条,列出来只作参照)

| 每 1M token(≤272K 输入) | gpt-6-astra | gpt-5.6-sol | 倍数 |
|---|---|---|---|
| 输入 | **$10** | $4 | **2.5x** |
| 缓存输入 | **$1** | $0.4 | **2.5x** |
| 缓存写入 | **$12.5** | $5 | **2.5x** |
| 输出 | **$50** | $20 | **2.5x** |

**⚠️ 272K 台阶(第一版漏了,这里补上)**

两个 model 页各自都写了同一条:超过 272K 输入 token,**整个请求**重新计价。

| | 官方原文 | 台阶后的实价 |
|---|---|---|
| gpt-6-astra | 「Prompts with more than 272K input tokens are priced at **2x input and cache rates and 1.5x output** for the full request.」 | 输入 $20 / 缓存 $2 / 缓存写 $25 / 输出 $75 |
| gpt-5.6-sol | 「Prompts with >272K input tokens are priced at **2x input and 1.5x output** for the full request.」 | 输入 $8 / 输出 $30 |

**⇒ 关键结论:台阶后 Astra 对 Sol 的倍数仍然是 2.5x**($20÷$8 = 2.5,$75÷$30 = 2.5)——
**因为 Sol 有一模一样的台阶**。台阶改变的是「大上下文请求的绝对成本翻一倍」,
**不改变 Astra 相对 Sol 的贵法**。

> ⚠️ **这里要防一个很容易犯的错**:只看 Astra 那一行会算成「台阶后 $20 对 Sol 的 $4 = 5 倍输入」。
> **那是错的** —— 那等于拿 Astra 的台阶价去比 Sol 的非台阶价。同一个请求超过 272K 时,
> Sol 也在台阶上。**必须同档比同档。**

**⇒ 但对 implement 节点仍然是一条要写清楚的事**:大上下文请求**绝对成本翻倍**
(输入 2x、输出 1.5x),不管用哪个模型。implement 经常带大上下文,所以「省上下文」这件事
本身就有价值,和换不换 Astra 无关。

**其他计价档:**

- **Fast 模式(原 Priority processing,2026-07-30 更名)= 2x 标准价**,换 up to 2x 速度(API 口径)。
- **Batch / Flex = 标准价 50%。**
- Astra **没有** `none`(不推理)档,只有 low / medium / high / xhigh / max(Codex 内嵌 catalog 里还多一档 `ultra`)。
  Sol **有** `none`。⇒ **Astra 的最低延迟地板比 Sol 高。**

### 3.2 我们真正要答的:**它吃额度的速率**(ChatGPT 订阅口径)

我们是 ChatGPT 订阅额度,不是按 token 付费。官方 Work/Codex **credit rate card**:

| 每 1M token(credits) | gpt-6-astra | gpt-5.6-sol | 倍数 |
|---|---|---|---|
| 输入 | **250** | 100 | **2.5x** |
| 缓存输入 | **25** | 10 | **2.5x** |
| 输出 | **1,250** | 500 | **2.5x** |

**⇒ 结论:同一份额度,Astra 只能跑 Sol 约 40% 的量。**

- **credit rate card 上查不到任何长上下文/272K 台阶的条款。** 我逐条读了,没有。
  ⚠️ **但「文档没写」不等于「不存在」** —— 这条列为未定项,别写成「Codex 侧没有台阶」。
- **另一个更实在的理由:Codex 里两个模型的会话窗口都正好是 272,000**
  (本机二进制内嵌 catalog,见 §4),**恰好就是台阶的门槛**。
  也就是说正常跑 Codex 时基本撞不到台阶;`max_context_window` 872K 是上限,不是默认值。
- **Fast 模式在 Codex 里是 2.5x standard rate**(不是 API 的 2x)。**我们 `~/.codex/config.toml` 里
  `service_tier = "default"`,所以现在不吃这一层。** 别乱开。

旁证(同一份官方 pricing 文档,按 5 小时窗口的消息条数口径):
Plus 用 Sol 是 10–100 条 / 5h,用 **Astra 是 5–45 条 / 5h** —— 约 0.45x,和 1/2.5 同一个量级。

其他要点:

- ChatGPT **Chat** 里 Astra 叫 GPT-6 Pro:Pro $100 = 50 条/周,Pro $200 = 200 条/周,**Plus = 0 条**。
  但 **Work/Codex 是另一套额度** —— Plus / Business Standard 有「limited Astra usage」,
  Pro / Business Premium 用完整额度。**我们跑的是 Codex,吃的是后面这套。**
- 额度用完后可以吃 workspace 购买的 credits(前提是有余额且支出策略允许)。
- 查用量:Codex CLI 会话里敲 `/status`。

⚠️ **未定项**:本机 `codex-profile status` 报的是 `Plan: pro`,但**没分辨出是 Pro $100 还是 Pro $200
(还是 Pro Lite)**。这决定了「40% 的量」到底是多少条。要定参数前请先在一个 Codex 会话里敲 `/status` 确认。

## 4. 我们现在的样子(对照基线)

| | 现状 | 出处 |
|---|---|---|
| Codex 侧模型 | `gpt-5.6-sol`,`model_reasoning_effort = "xhigh"`,`service_tier = "default"` | `~/.codex/config.toml` |
| 注册表 | `MODEL_IDS.CODEX_STANDARD = "gpt-5.6-sol"`,label「GPT-5.6」,surfaces = runner/workflow/cron,runner 面只开 `xhigh` | `packages/config/src/model-builtins.ts:36,284` |
| 用 Codex 的节点 | 部分 lead 会话(Mufasa / Raya / infra-bot,都是 windowed TUI)、语音线、implement 节点 | `packages/teamlead/scripts/run-codex-lead-*.sh`;CLAUDE.md FLY-398 |
| Claude 侧 | heavy = Fable 5.1;medium/light/trivial = Opus 5;qa 硬绑 claude-opus-4-6[1m] | issue 给的基线 |
| Codex CLI | 0.153.2(**已有 0.153.3**) | 本机 |

**本机 codex 0.153.2 内嵌 model catalog 里 Astra 的实际参数**(和 API 页不完全一样,以这份为准):

| 字段 | gpt-6-astra | gpt-5.6-sol |
|---|---|---|
| `context_window` | **272,000** | 272,000 |
| `max_context_window` | 872,000 | 872,000 |
| `visibility` | **`hide`**(所以 model picker 里看不到) | `list` |
| `minimal_client_version` | **0.153.0** | 0.144.0 |
| `default_reasoning_level` | low | low |
| `multi_agent_reasoning_effort` | **xhigh**(Sol 无此字段) | — |
| `priority` | **1** | 6 |
| effort 档 | low/medium/high/xhigh/max/**ultra** | 同 |

> ⚠️ **上下文别被 1.05M 骗了。** API 页写 1,050,000,但 **Codex 里给的是 272K 会话窗口
> (上限 872K)—— 和 Sol 一模一样。** 所以「Astra 上下文更大」在我们这条路上**不成立**;
> 真正成立的是「**同样 272K 里,长上下文检索准确率高很多**」(MRCR 96.3% vs 73.8%)。

---

## 5. 三类节点的匹配分析(给材料,不下结论)

### 5.1 implement 节点

**Astra 的优化点命中这里的瓶颈吗 → 命中度最高。**

| implement 的真实瓶颈 | Astra 有没有对上 |
|---|---|
| 在终端里把一串命令跑对、跑完 | ✅ Terminal-Bench 4.0 **57.9 vs 37.3**,这是全表最大的相对涨幅之一 |
| 长会话跑到后半段忘了前面的约束 | ✅ 跨窗口笔记机制 + MRCR 512K–1M **96.3 vs 73.8** |
| 编不存在的 API / 谎报「我改好了」 | ✅ 内部 hallucination **4.2% vs 12.2%** |
| 越界乱改不该碰的东西(我们的 scope discipline 红线) | ✅ circumvention **0.00% vs 0.29%**;从不试图绕过 Codex auto-review |
| 纯「写对代码」的智能 | ⚠️ **只涨一点**:DeepSWE +1.4、AA Coding Agent +1.9 |

**代价与风险:**
- 额度 2.5x。implement 是我们**最烧 token 的节点** —— 这里换 Astra,额度账最疼。
  但「少用 up to 20% token」和「跑更少轮就对」如果为真,实际倍数会低于 2.5x(**未验证,别当作已知**)。
- ⚠️ **Critical 定级的拦截**:官方明说安全检查可能「暂停或中止正当工作」,ChatGPT/Codex 里会**要人确认**。
  我们的 Runner 是**无人值守**的 —— 一个要确认的暂停就是一次卡死。这条必须先在真实 implement 单上验。
- `visibility: hide` + 需要 ≥0.153.0:切之前所有跑 Codex 的机器都得到版本。

### 5.2 lead 节点(Mufasa / Raya / infra-bot,windowed TUI)

**命中度:中,而且分两半。**

| lead 的真实瓶颈 | Astra 有没有对上 |
|---|---|
| 判断力 / 决定派不派单、派给谁 | ⚠️ 通用智力**几乎没涨**(AA 61.2 vs 60.9)。这块换了大概率**感觉不到差别** |
| 长时间挂着的会话,后面忘了前面说过什么 | ✅ 长上下文 + 跨窗口笔记,这条对常驻 lead 会话很实在 |
| 对 founder 谎报进度 / 夸大自己的能力 | ✅ 内部 hallucination 4.2% vs 12.2%;「能力幻觉」错报**少 3 倍** |
| 该问的时候问、不该问的时候别烦人 | ✅ 官方专门说了:Astra 在 Codex 里能**异步提问**,同时继续跑不依赖回答的部分;含糊时用上下文补常规空档,只在会改变结果时才问 |
| 响应速度(founder 在 Discord 等着) | ❌ **没有 `none` 档**(Sol 有),最低延迟地板更高。lead 大量是短交互,这条是负面 |

**代价:** lead 会话是**长期挂着**的,它的额度消耗是全天候的底噪。2.5x 打在底噪上比打在 implement 上更难察觉,
但月末更贵。infra-bot(claw)这种高频救火的更明显。

### 5.3 语音线

**命中度:直接用不上(前台),后台那层才有戏 —— 但先要看清它是两层。**

FLY-1911 的实测证据表明,Codex 语音是**两层结构**:

```
你说话 ─▶ [前台 realtime 层:耳朵 + 嘴巴]
              │ function_call name="background_agent" → handoff_request
              ▼
          [后台 turn:真正干活的那个 agent]
              │
              ▼ 它把结果念出来
```

- **前台 realtime 层:Astra 用不了。** 官方 API 页把 realtime / realtime transcription /
  音频输入输出 全部列为 Not supported。而且 Codex CLI 的 realtime 层有**独立的模型配置键**
  (`experimental_realtime_ws_model`,和 `model` 不是一回事;release notes 里还有一条
  "Update the frameless realtime default model")—— 也就是说改 `model` 根本改不到耳朵嘴巴。
- **后台干活那层:理论上可以是 Astra。** 但语音的体验瓶颈是**延迟**,不是智能:
  FLY-1911 量到的是「张嘴 610ms / 真去干活一圈 19.2 秒」。Astra 没有 `none` 档 → 后台那层换 Astra
  只会让 19.2 秒**更长**,除非配 low 档。
- ⚠️ **v3 通道当前被上游堵死**(FLY-1911:`/backend-api/codex/realtime/calls` 401 `token_expired`,
  两次独立复现;而同账号 v2 websocket 正常)。**这条阻塞跟模型无关,换 Astra 不解**。
  「先应一声」的 `delegationAckFiller` 只在 v3 生效 —— 所以语音体验那个最大的痛点(问完 19 秒没动静)
  卡在 v3,不卡在模型。
- 🔎 **新信号**:Codex CLI 0.153.0 的 changelog 里有一串 "native voice" 相关 PR
  (voice host lifecycle / native voice dependency build)。**这可能比换模型更相关**,值得单开一单看。

---

## 6. 判断材料汇总(一张表)

| | implement | lead | 语音(前台) | 语音(后台) |
|---|---|---|---|---|
| Astra 的强项对上瓶颈了吗 | **高** | 中 | **不适用** | 低 |
| 额度代价 | 2.5x,最疼 | 2.5x,底噪 | — | 2.5x |
| 延迟影响 | 不敏感 | **负面**(无 none 档) | — | **负面** |
| 硬阻塞 | Critical 拦截可能卡住无人值守 Runner(**待验**) | 无 | **官方不支持 realtime** | v3 上游 401(**与模型无关**) |
| 前置条件 | 所有机器 ≥ codex 0.153.0 | 同左 | — | 同左 |

---

## 7. 还没答的(诚实留白)

1. **我们的 Pro 是 $100 还是 $200(还是 Pro Lite)?** 不知道就算不出「40% 的量」是多少条。
   → 在一个 Codex 会话里敲 `/status`。
2. **Critical 拦截在我们真实的 implement 单上会不会真的卡住?** 没验。这是唯一可能一票否决的风险。
3. **「少 20% token」在我们的活上成不成立?** 只有厂商/客户证言。要验只能拿同一张单跑两次比 credit。
4. **跨窗口笔记(`features.context_management.experimental_mode`)开了会怎样?** 默认关,没试过。
5. **Astra 在我们的 Discord 中文对话里语气怎么样?** 零场次。lead 是直接面 founder 的,这条不能只看 benchmark。

---

## 来源

- [GPT-6 Astra: A new generation of intelligence — OpenAI](https://openai.com/index/gpt-6-astra/)(完整 benchmark 表 + 定价 + 可用性)
- [GPT-6 Astra Model — OpenAI API docs](https://developers.openai.com/api/docs/models/gpt-6-astra)(牌价 / 端点支持 / effort 档)
- [GPT-5.6 Sol Model — OpenAI API docs](https://developers.openai.com/api/docs/models/gpt-5.6-sol)(对照牌价 + **同款 272K 台阶条款**)
- [OpenAI API Pricing](https://developers.openai.com/api/docs/pricing)(Fast 模式 2x / Batch·Flex 50%)
- [GPT-6 Astra System Card — OpenAI Deployment Safety Hub](https://deploymentsafety.openai.com/gpt-6-astra)(弱点 / 可监控性 / Critical 定级)
- [Codex pricing & usage limits — ChatGPT Learn](https://learn.chatgpt.com/docs/pricing)(credit rate card)
- [ChatGPT Rate Card — OpenAI Help Center](https://help.openai.com/en/articles/20001106-codex-rate-card)
- [openai/codex releases](https://github.com/openai/codex/releases)(0.153.0 / .1 / .2 / .3 原文)
- 本机 `codex` 0.153.2 二进制内嵌 model catalog(`strings`;路径 `~/.codex-242/packages/standalone/releases/0.153.2-aarch64-apple-darwin/bin/codex`)
- [GPT-6 Astra independent benchmarks vs launch claims — Requesty](https://www.requesty.ai/blog/gpt-6-astra-independent-benchmarks-vs-launch-claims)(第三方对冲)
- 内部:`product/doc/FLY-1911-codex-voice-prototype/`(语音两层结构 + v3 阻塞实测)、`product/doc/FLY-1443-codex-realtime-probe/conclusion.md`
