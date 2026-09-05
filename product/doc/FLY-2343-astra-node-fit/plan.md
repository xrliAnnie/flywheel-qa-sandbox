# FLY-2343 GPT-6 Astra 该用在哪 — 交付计划

Issue: FLY-2343 (https://linear.app/geoforge3d/issue/FLY-2343/research-gpt-6-astra-该用在哪-优化点-价格-与我们-codex-节点lead语音implement的匹配)
日期: 2026-09-04
基于: research.md

---

## 这单要交什么

Annie 的原话就是验收结构,三件:①Astra 优化在哪 ②价格 ③三类节点(lead / 语音 / implement)的匹配讨论。
**这单只出研究 + 判断材料,不改任何模型配置,不下「该切哪个」的结论。**

## 交付物

| # | 产物 | 状态 |
|---|---|---|
| 1 | `research.md` —— 全部发现 + 来源成色标注 | ✅ 已落盘 |
| 2 | `astra-node-fit.html` —— 交互式 explainer(Apple light 主题,逐卡评论 + 一键汇总复制) | 本轮 |
| 3 | `founder_review` 轮次(publish-only + hosted URL) | 本轮 |
| 4 | PR(docs 分支)+ `complete --route needs_review` | 本轮 |

## explainer 的结构(founder-facing,已去黑话)

1. **一句话结论** —— 涨的不是「聪明」,是「能把活干完」;额度 2.5x;语音线用不上
2. **它到底强在哪** —— 分「涨得多 / 涨得少」两栏,厂商数据与第三方数据分色标注
3. **它弱在哪** —— 可监控性下降、Critical 定级带来的生产拦截、越界非零、学术输给 Fable 5.1
4. **价格两笔账** —— API 牌价(参照)vs **吃额度速率**(我们真正要看的,2.5x → 只能跑 40% 的量)
5. **三类节点逐个过** —— implement / lead / 语音,每个说「它的强项对上瓶颈了吗 + 代价 + 硬阻塞」
6. **语音是两层** —— 一张图说清前台耳朵嘴巴(Astra 用不了)vs 后台干活层
7. **还没答的 5 个留白** —— 明说哪些是「没验」而不是「验过没事」
8. **可选的下一步(选项,不是结论)** —— 每条都标代价,供 Annie 和 Lead 讨论

## 明确不做

- ⛔ 不动 `models.json` / `config.toml` / phase 绑定 / `MODEL_IDS.CODEX_STANDARD`
- ⛔ 不替 Annie 决定该切哪个节点
- ⛔ 不拿 Astra 跑长任务烧额度(本单全部探测走本机二进制 + 公开文档,**零 Astra 推理调用**)

## 风险 / 前置

- 「Critical 定级的安全拦截会不会卡住无人值守 Runner」是唯一可能一票否决的风险,**本单没验**,
  已作为留白交给 Annie 决定要不要单开一单验。
- 切任何节点前所有跑 Codex 的机器需 ≥ codex-cli 0.153.0(Astra `minimal_client_version`)。
