# FLY-1006 M2 P6 — Annie 语音房真人 E2E（plan §S9 证据落点）

Issue: FLY-1006 (URL 不可得,只写 issue 号)
日期: 2026-07-09
基于: plan.md §S9、m2-staged-venue.md（venue 同 rig）、m2-sonnet-latency.md（后续换档）

## 状态

- **首场（haiku 脑）：已发生**（2026-07-09 晚，本文件）——链路全通，她的结论
  =「可以测，但是非常非常的慢」。
- **sonnet 版复听（终验）：待进行**——她拍板「等这整个 loop 都跑完了，QA 那边
  都测 pass 了，你再让我去测」。venue 已带 sonnet 脑重启常驻（health :9885）。

## 首场会话（haiku 档）

- venue：`e2e/p6-live-venue.mjs`（Annie 自己触发 /eleven，无 autostart），529
  房，waiting-cue 开启（QA 的 cue-soft clip），声线 override DowyQ68vDpgFYdWVGjc3。
- Annie 原话结论（gate thread，逐字）：

  > OK，我测试了 eleven，怎么说呢，可以测，但是非常非常的慢。

- 她的三条反馈与处置：

| # | 反馈（她的原话要点） | 处置 |
|---|---------------------|------|
| 1 | 响应时间太长：「它不止 7 到 10 秒，好像比那还要慢」 | 根因 = haiku 脑每轮冷启动且先吐 thinking；已按她拍板（「那我们试一下 Sonnet」）换 sonnet，机器复测典型 3-4s（m2-sonnet-latency.md） |
| 2 | 等待音很奇怪，要换一个 | 换 clip 零代码（waitingCuePath 配置项）；她自选音效中，选好由 Lead 转交 |
| 3 | 延迟能修吗？为什么 Gemini 不这么慢？ | 已答（经 Lead）：/gemini 的脑是 Gemini Live 本身（Claude 只是深查工具），/eleven 每轮都过 Claude；可修部分 = 换 sonnet（已做）；订阅形态地板 3-4.5s，进 1-2s 只有付费 API 直连 |

## 三维记录（issue 验收口径：延迟/质量/成本）

| 维度 | 首场（haiku）实测 | 换档后（机器口径） |
|------|-------------------|--------------------|
| 延迟 | 她体感 >7-10s/轮（与机器口径 haiku 中位 8.3-9.2s 一致，体感另含她说话时长与听写收尾） | sonnet 中位 ~3.6s、典型 3-4s（m2-sonnet-latency.md；待她复听给体感结论） |
| 质量 | 链路全通：STT/对话/打断可用；等待音 clip 需换（形态她不喜欢）；声线可选已验 | 同左（质量面未动）；音效 clip 待她选 |
| 成本 | credits 合并区间 +4,973（含 QA cue 复验，无法逐项拆分，见 credits-ledger.md）；现金 $0（订阅池内） | sonnet 复测 +1,739；累计 14,717 = 98.1% of 15k 预估（月度钱包上限内无风险） |

## 终验待办

sonnet 版复听一场（约 10 分钟）：确认提速体感 + 音效体验（若她的新 clip 已到则
配上）→ 她的体验结论落 thread = 本 issue M1/M2 的终审素材。
