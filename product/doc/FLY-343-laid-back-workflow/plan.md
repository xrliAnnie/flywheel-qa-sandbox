# FLY-343 躺平工作流 — 实施计划(折入判定 + 建议评论)

Issue: FLY-343 (https://linear.app/geoforge3d/issue/FLY-343/xhsclaude-躺平工作流cli-画板-手柄-语音改图)
日期: 2026-07-08
基于: product/doc/FLY-343-laid-back-workflow/exploration.md, product/doc/FLY-343-laid-back-workflow/research.md

> 本「实施计划」= 一次**产品判定 + 轻交付**,不是工程建单。方向已由 brainstorm gate 定
> (Honey Lemon confirm 选项 A 折入)。产出全是文档/评论,**不碰 packages 代码、不建 build issue**。

## 0. 判定(Decision)

**FLY-343 不单独立项 → 折入。** 理由(证据见 research.md §1–§3):
- 三个交互面已分别归属 FLY-906(语音)/ JoyCon(手柄)/ FLY-914(交互可视化),独有可建 scope≈0。
- draft 的第四面「投影/大屏」= 纯**输出/可读性**语境(躺着也能看),不是独立 scope —— 已被现有
  交付物/报告可视化面(FLY-914 + publish-report)+「离屏舒适」北极星覆盖,无需单独承接。
- 独立立项撞两条教训(draft 自带「交互可视化难做好用」+ FLY-212「造了没戳心坎」),`Low` 优先级也不支持重投入。
- 折入 = 轻、零工程、强化两个在建 PRD 的既有方向。

## 1. 交付物清单(Deliverables)

| # | 交付 | 形态 | 状态门 |
|---|------|------|--------|
| D1 | 本 folder exploration/research/plan(判定 3 件套) | docs,随 PR merge 到 main | Codex design-review 过 |
| D2 | FLY-906 一条结构化建议评论(见 §2) | Linear 评论 | design-review 过后 post |
| D3 | FLY-914 一条结构化建议评论(见 §3) | Linear 评论 | design-review 过后 post |
| D4 | 手柄面指回 JoyCon | 写进判定 + D2 评论一句,**不**单独建评论/issue | — |
| D5 | FLY-343 → 建议标 folded / 关 | 判定写清理由;**实际关单留给 Honey/Annie**(founder-gated,不自作主张关) | — |

**执行顺序**:D1 先落 → Codex design-review(本 plan)→ 过后 post D2/D3 → 开 docs PR → approve gate。
(评论虽可先发,但内容嵌在本 plan 里,先过 Codex review 再 post,避免措辞返工。)

## 2. FLY-906 建议评论草稿(D2)

> 落点:FLY-906(Voice 产品体验设计)。语气 = 建议,不改 PRD 正文(它在跟 Annie 逐版共创)。

```
## FLY-343 折入建议 — 躺平/离屏工作流(XHS 学习)

来源:FLY-343 小红书 auto-draft「躺平工作流:大屏+手柄+语音改画板」(👍47/⭐42)。经 brainstorm
判定不单独立项,折入 Voice 当设计原则参考。

建议（结构化,供逐版共创参考,不改 PRD 正文）:
1. 外部佐证离屏北极星:外部社区在追同一个「把 coding agent 交互从键盘挪开、离屏也顺畅」的
   人机工效方向 —— 独立佐证 Voice 的北极星 FLY-212(离屏也顺畅工作,PRD Problem/成功标准处的
   动机)+ §17 离屏多-agent 机制方向对。可在 §17 或成功标准处引一句作外部数据点。
2. 输入模态边界(建议记一句):语音是本 issue 选定的解法形状;手柄类「离键盘输入」归 JoyCon
   项目,建议 Voice 不纳入多模态手柄输入,避免 scope 混。
3. 避坑呼应:draft 自带教训「别为酷而上交互」——与 §真实意图「voice 是解法不是目的,避
   shiny-object」一致,方向无需改动,仅作佐证。

（FLY-343 折入判定详见 product/doc/FLY-343-laid-back-workflow/。）
```

## 3. FLY-914 建议评论草稿(D3)

> 落点:FLY-914(可交互 HTML 审阅件)。语气 = 建议 + 佐证现有克制路线。

```
## FLY-343 折入建议 — 交互可视化的可用性红线(XHS 学习)

来源:FLY-343 小红书 auto-draft(👍47/⭐42)带一条社区可用性教训:「我曾尝试把交互意见过程
展现在一个交互页面,最终因为太难使用放弃了」。经 brainstorm 判定折入 FLY-914 当设计约束佐证。

建议（结构化,不改 PRD 正文）:
1. 外部佐证现有克制路线:这条「交互页容易做重、难做好用」的教训,正好独立印证 FLY-914 已走的
   方向 —— 段落级(A)胜过划词(B,真机别扭)、剪贴板复制胜过 relay、严守「每加一项必砍一项」。
   可记成一条外部数据点,强化 Non-goals 纪律。
2. 给未来加料设卡:后续想加 finer granularity(句级/跨段)、自动回流 relay 等(现 backlog)时,
   先过一道「拇指顺不顺、能不能砍」的可用性关,别让交互面重回「做重难用」的老路。

（FLY-343 折入判定详见 product/doc/FLY-343-laid-back-workflow/。）
```

## 4. 明确不做(Scope discipline)

- ✂ 不建任何 build issue(无工程要建)。
- ✂ 不改 FLY-906 / FLY-914 的 PRD 正文(只留建议评论,共创稿由 Annie/Honey 收敛)。
- ✂ 不碰 packages 代码、不碰 JoyCon repo(手柄只做指针)。
- ✂ 不自行关闭 FLY-343(关单 = founder-gated,判定写清理由供 Annie 决定)。

## 5. 风险 / 已知

- **评论可能与 906/914 正在收敛的版本轻微重复**:接受 —— 评论是外部佐证/边界提醒,不是新增
  需求,重复也只是加强既有方向。发前会 fetch 两个 issue 最新评论,避免撞已有同类结论。
- **本 plan 走 doc-flow full 的 design_review gate**:stage set design_review --plan 触发 Codex
  design review;过后再 post 评论 + 开 PR。

## 6. 验收(完成 = 什么为真)

- D1 三件套 merge 进 main(docs PR)。
- D2/D3 两条评论真出现在 FLY-906 / FLY-914(Linear 可见)。
- 判定(不独立立项、折入 + 抽 2 原则 + 手柄指 JoyCon)在文档里可查。
- Codex design-review 过 + approve gate 过(ship 仍 founder-gated)。

## 7. 执行记录(Execution log)

- Codex design-review:**APPROVED**(round 1,xhigh;事实链全核实,2 条非阻断建议已 fold)。
- D2 FLY-906 建议评论:已 post,comment id 791bd337。
- D3 FLY-914 建议评论:已 post,comment id 21fb3046。
- FLY-343 折入判定摘要评论:已 post 到本 issue(供 founder keep/close 决定)。
- D5:FLY-343 关单 **未自行执行**(founder-gated),判定已写清理由供 Annie 决定。
