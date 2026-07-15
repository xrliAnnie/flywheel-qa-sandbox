# FLY-1091 Feature flag 该怎么定 / 怎么管 — 实施计划(explainer 构建计划,非 PRD)

Issue: FLY-1091 (https://linear.app/geoforge3d/issue/FLY-1091/feature-flag-该怎么定-怎么管-research-设计我们的-flow小团队不-over-engineering)
日期: 2026-07-09
基于: research.md、exploration.md(同文件夹)

---

## 0. 这份 plan 是什么、不是什么

- **是**:本 issue 唯一「实现物」——**可交互 explainer HTML**——的构建计划。
- **不是** PRD。Lead 明确:本 issue research-first,**不落 PRD、不下 verdict**。方向由 Annie co-eval 后再定,PRD 是另一张单。
- 因此本计划**不触发 codex-design-review gate**:explainer 的「设计评审」就是 Annie 本人的 co-eval(Lead 定的流程 = host-only publish → Lead curl 验 → 投给 Annie → 逐节批注回来)。这符合「过程轻重按风险分档」——一个用来跟 founder 一起想的物料,不该压一道机器设计门。

## 1. 交付物

1. `exploration.md` ✅(已写)
2. `research.md` ✅(已写)
3. `feature-flag-explainer.html` —— 本计划的产出
4. 以上三者 + `progress.md` 一起进 docs PR(满足流水线「开 PR」)
5. explainer 经 **host-only publish**(直接 `POST /api/reports/publish {projectName, html, title}`,**不走 publish-report CLI**——CLI 必跑 deliver、会落 core 频道),拿到不可猜 URL → 报 Lead。Lead curl 验完投 Annie。

## 2. explainer HTML 硬规格(继承 FLY-930 / Annie 偏好)

- 单文件、完全自包含;Apple 浅色 light-only(复用 FLY-1020 定稿卡片样式)。
- **零 inline handler**:所有交互用 `addEventListener`;`<script nonce="__CSP_NONCE__">`(publish 时注入真 nonce,CSP `default-src 'none'` 下也能跑)。
- **每节一个留言框**(`textarea[data-k][data-label]`),`localStorage` 自动存。
- **底部一键复制批注**:把所有留言 + 所有选择项拼成 markdown → clipboard + `<dialog>` 预览 + 下载 .md。
- **可挑选的决策项**:6 个「不知为何关着」的 flag 逐个给单选(故意关/该开/删掉/去查),三个问题各给 2-3 个 option + 我的推荐 —— 用 `input[type=radio][data-q]`,export 时一并读进 markdown,change 时一并存 localStorage。
- mobile-first;表格进 `.scroll` 容器横向滚动,body 绝不横向滚动。

## 3. 内容结构(节 → 卡)

1. **顶注**:这是 co-eval 物料不是 PRD;你要做两件事——读业界发现 + 底部裁 flag/选方向。
2. **一句话重定框**:不缺 registry/规矩/看板;缺「时钟」和「意图」;病在 merge 与 enable 之间的空窗。
3. **业界四类 toggle**(寿命 × 动态性表)+ 为什么只有 Release+Ops 对我们成立(Experiment 零流量、Permission 单用户)。
4. **Toggle 债**:flag = 有持有成本的库存;五条业界纪律;我们一条没落地;一周 40→77、从没删过。
5. **睡着的功能 = 四种病**(A 忘了开 / B 开了但空 / C 关着不知为何 / D 设了 =1 没重启)+ Knight Capital 精准警示。
6. **别人怎么治**:Unleash 五阶段 + 使用指标自动判 cleanup;Fowler 到期日 + time bomb。
7. **管理形态**:为什么不换 LaunchDarkly(它的价值我们三样没有);正典倾向「源码+重新部署」;我们 registry 方向对、缺的是生命周期字段。
8. **当场演练**:请你裁 6 个「不知为何关着」的 flag(每个单选 + 留言)。这既是内容也是新规矩「关着的 flag 必须为自己辩护」的第一次真用。
9. **你的三个问题**:每个 2-3 option + 我的推荐(单选 + 留言)。
10. **方向确认框**:大方向 sign-off 留言。

## 4. 每个问题给 Annie 的 option(推荐来自 research,但标注为「待她定」)

- **Q1 每个 feature 都加 flag 吗** → 推荐 (ii) 默认不加,只在 (a) 合入未完成的活 (b) 有风险要 kill switch (c) 有环境差异 时加。
- **Q2 在哪管** → 推荐 (i) 留在 registry 只加生命周期字段(零成本、随代码走、符合正典)。
- **Q3 何时开/关** → 推荐:做完验证过就开;判「该开却没开」用 owner + 到期日 + time-bomb(Fowler)+ 未来接使用指标(Unleash);删用到期日/库存上限。核心 = 反转举证责任:关着的 flag 要持续为自己辩护。

## 5. 验证(docs-only)

- 本 issue **不触发 QA**(Lead 明示);无运行时行为改动。
- 客观完成证据:explainer 文件存在 + host-only publish 返回 URL(HTTP 2xx)+ Lead 收到 URL + docs PR 开出。
- 打开 PR 后止于 approve gate(ship 仍 founder-gated)。

## 6. 我不碰的东西(scope discipline)

- 不改 registry 代码、不加字段实现(那是方向定后的 eng 单)。
- 不建 FLY-1038 的 dashboard tab(我的发现只是重塑它该怎么做,记进 FLY-1038)。
- 不 ship、不碰 founder-gate、不下 verdict、不写 PRD。
