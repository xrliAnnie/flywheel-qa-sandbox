# FLY-1065 mini-spike:finished flag 真机探针 — 结论

Issue: FLY-1065 (https://linear.app/geoforge3d/issue/FLY-1065/voice-gemini-文本面板双向转写-会话记录持久化annie-真机验收反馈)
日期: 2026-07-09
基于: plan.md P7「mini-spike(P2 前置)」;探针由 implement 段前任 runner(351e77f1)于 OOM 事故前跑完(2026-07-09 14:18),原始结果 /tmp/fly1065-finished-probe.json,本文件由续跑 runner 固化 + 解读

## 跑法

s-a1 形态直连真 Gemini Live(model = 生产同款 `gemini-3.1-flash-live-preview`),发一段中文语音(「今天我们聊一聊转写面板,你觉得这个功能怎么样?」)+ `audioStreamEnd`,录全部 serverContent 事件时序。原始 JSON:`finished-flag-probe.json`(同目录,97 events)。

## 结论(按对 plan 的影响排序)

1. **`Transcription.finished` 双向都不回传**(`inputFinishedSeen: false, outputFinishedSeen: false`)——plan §5 风险表第一行预判成真。主信号在当前生产 model 上不可用,聚合边界完全落在兜底信号上。`finished` 透传(P1)仍保留:字段是官方契约,model 升级后自动升级为快路径。

2. **`turnComplete` 比生成完成晚 10.2 秒**(generationComplete @10446ms → turnComplete @20636ms;生成完到 turn 完之间是音频播放时长量级的空窗)。若按原 plan 只用 turnComplete 兜底 flush:
   - assistant caption 在助理**说完话后约十秒**才出现;
   - user caption 更晚(同一 turnComplete)——她说的话的字幕比助理的回答还靠后。
   「实时双向转写」的体验直接破功 ⇒ **flush 信号链必须增补**(见 plan「续跑修订」):
   - assistant 主兜底 = **`generationComplete`**(@10446ms,距最后一个转写分片 51ms,及时且语义精确 = 本轮生成文本完整);
   - user 主兜底 = **首个 assistant 输出到达**(探针里 input 转写 @7062ms 先于首个 output 分片 @7067ms——她说完、模型接话前,her turn 必然可 flush);
   - turnComplete 降级为终兜底(信号缺失时的轮末保底),interrupted/close 不变。

3. **分片形态实证**(佐证既有设计假设):
   - input 转写:**整句一次到达**(audioStreamEnd 后 1.3s),中文字间带空格(「今 天 我 们 …」——渲染原样即可,不做 CJK 特判,与语言合同一致);
   - output 转写:**细碎 delta 分片**(36 片,逐词「我觉得/转/写/面板/…」),无重叠,拼接即全文——TurnAccumulator 纯拼接假设成立;
   - `generationComplete` 单独一条消息到达,紧跟最后一个 output 分片。

## 对 plan 的 delta

P1 增加 `generation-complete` 事件透传(connector 现忽略 `sc.generationComplete`);P2 flush 信号链按上述优先级重排。架构(TurnAccumulator/三层兜底/scrub 出口/幂等判空)零变化——这是已批设计「不赌单一信号」原则下的信号优先级调整,详见 plan §6b「续跑修订」。
