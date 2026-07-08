# FLY-1001 Raft 竞品分析 — 实施计划(edit-plan:折进 FLY-909)

Issue: FLY-1001 (https://linear.app/geoforge3d/issue/FLY-1001/raft-竞品分析-raft-vs-flywheel-差异化-competitor-scan-round-3)
日期: 2026-07-08
基于: research.md

> 无代码,纯文档 edit。像处理 Matrix 那样:独立 deepdive + 折进 competitor-scan。FLY-911 只出建议不擅改。

## 交付清单(3 处改动)

### 1. 新建 `product/doc/FLY-909-competitor-scan/raft-deepdive.md`(独立深挖,仿 matrix-deepdive.md)
结构:
- 抬头(FLY-909 格式,注明本轮 = FLY-1001 round-3)
- 为什么单独挖它(最贴对标,产品化版)
- 一句话定位(verbatim)+ 目标用户 + 产品形态 + agent 机制 + 定价 + 团队
- 跟 Flywheel:像(形态逐条命中)/ 不一样(差异化收窄表)
- **三轴 vs Raft 逐轴标(成立/部分/不成立)** —— 核心
- Cass 三压测点结论(简版,详见 FLY-1001/research.md)
- 值得借鉴 / 别学
- 一句话差异化候选
- 对 FLY-911 的影响 + 建议(指到 research.md §6)

### 2. 编辑 `product/doc/FLY-909-competitor-scan/competitor-scan.md`(折入 round-3)
- **抬头**:加〔round-3.2 Raft〕说明本轮改了什么(仿现有 round 批注风格)。
- **横切表 A**:加 **Raft** 一行(定位/目标用户/形态/非技术体验/定价)。
- **§⑥ 或新 §⑧**:加一节「Raft —— 最贴的产品化版 + 三轴 vs Raft」,含三轴速览表 + Cass 三压测点一句话结论 + 供应商中立/复利被匹配的诚实认账。放在 OpenClaw §⑦ 后当 §⑧,和现有「加 X 竞品」的扩展风格一致。
- **『我们跟谁像 / 差异候选』节**:加 Raft(最贴、最该警惕、引擎领先),更新「真差异该落在」那句(退供应商中立/复利)。
- **『最该警惕』**:Cowork 之外加 Raft(侧翼威胁)。

### 3. FLY-911:**不改文档**,只在 DONE 报告 + deepdive 里出「影响评估 + 建议」(research.md §6)。Annie 拍。

## 顺序
raft-deepdive.md → competitor-scan.md 编辑 → 更新 progress ledger → commit → push → PR → DONE 报 Honey Lemon(带结论)→ approve gate。

## 不做(scope 纪律)
- 不做『报数』可抄工程清单(FLY-999)。
- 不擅改 FLY-911 positioning.md。
- 不新建状态子目录。
- 不动 competitor-scan 里 Raft 无关的既有内容(只加,不重写别家)。
