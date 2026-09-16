# FLY-2391 默认发布与否决 — 设计验证
Issue: FLY-2391 (https://linear.app/geoforge3d/issue/FLY-2391/1143b4-auto-ship-on-silenceopt-out-fail-closed-状态机-否决窗口绑不可变候选delivery)
日期: 2026-09-14
基于: plan.md

## 已有证据

- TURN：design epoch=1，activation=`activation:57fed70b-8c2e-4aef-9762-608633042ce9:da6b7743-891e-424f-a121-1bf7ffdb0c44:eng_design:1`；本节点只修改本 issue 设计目录。
- 设计提交：`870cba0af`，已 push `origin/flywheel-FLY-2391`。
- 正式评审：questionId=`5876cd77-e030-4bc3-b87c-c5abf81d4458`；requestId=`08577d66-7acf-47a9-86a0-06213a2aa495`，accepted=true；截至本条记录仍 pending，不提前写 APPROVED。
- Lead 对 question `b476568a-56e9-492d-890c-f669a1ce814e` 答复：尚无 founder/HL 的发布日/早报/截止钟点决定；启用时必须带时区配置、缺失 unknown、默认 off。HTML 列周二/08:00 PT/15:00 PT 为建议，明确未批准；不阻塞设计。

## HTML 验证

运行 `python3 engineering/doc/FLY-2391-auto-release-veto/build-founder-html.py` 与 `node engineering/doc/FLY-2391-auto-release-veto/verify-founder-html.mjs`，静态与隔离 controller 验证 PASS：

- 每个 section 都有意见输入（10节，包括汇总卡）；自动保存的 key 包含 location.pathname，读写 storage 都捕获失败。
- 实时聚合非空意见，第一行精确 `【页面意见汇总】FLY-2391`；长意见按 1800 字符上限拆分，每段重复标记且不截断 Unicode 代理对。
- Clipboard 成功、拒绝、缺失、fallback失败；storage 禁用；清空/重载/另一页面隔离均覆盖。
- 唯一 inline script 含 `nonce="__CSP_NONCE__"`，无自带 CSP meta、无 inline handlers、无外部依赖、无派生数据 innerHTML。
- 当前 HTML 约 19KB，低于发布器 512KiB 限制。验证器是 Node VM fixture，不等于浏览器视觉 QA 或真实 CSP 执行验证。

## 本地图渲染受限

两图各进行了首次本地 mmdc 与一次标准参数重试，均失败：

```text
mmdc -i <dN.mmd> -o <dN.svg> -w 1000 -b white --svgId FLY-2391-dN
MachPortRendezvousServer ... Permission denied (1100)
```

保留 `d1-flow.mmd` 与 `d2-model.mmd`，HTML 两处明确 `DIAGRAM PENDING LOCAL RENDER` 并附图源。没有用 CSS 伪造图或远端渲染。图源分别使用 flowchart 与 erDiagram，稳定 svgId 各自不同。

## 尚待设计收尾

有效评审 verdict、托管 URL/HTTP 200/nonce与CSP匹配、DESIGN-HTML ready回执和phase completion/park收据尚待后续条目补齐。没有实现测试、生产启用、真实发布或客户机验收证据；这些属于 plan §12 的后续独立阶段。

## 评审收尾（2026-09-14）

- R1 有效 `reviewVerdict=APPROVED`，原始 `reviewerVerdict=APPROVED`；question/request 身份同上。原始结构化响应已保存 review-r1.json。
- 0 阻塞项，9 MEDIUM + 2 LOW；全部保留 follow-ups.md，未自行宣称修复或缩减范围。Lead report receipt=`f137c3ab-34ff-4552-ab5b-2c0cac884936`。
- 保留 plan.md 的已审字节（包括提交时的待审标记），本节及结构化 verdict 为当前批准事实；plan SHA256=`767b366c4b8ab74803c6ce10995477da205dbdedb917a9d0a210c8590d6cdf1f`。没有规范性改动或新评审请求。
- 应角色 closeout 要求，3 条可复用判断通过获准的 native memory extension note 保存；未直接修改 runner-memory 索引。完成命令应报告该索引 unchanged，而非假报已写。

## 托管交付验证（2026-09-14）

- 已提交并推送的 HTML 所在 head：`8eae72f8b`。
- publishOnly=true、messageId=null、delivered=false 为静默发布成功；URL：https://fw-reports-624a39.vercel.app/r/57cdaecff7c36dc60dd75c32c8733318/ 。没有发送 Discord 频道消息。
- 真实托管页 HTTP 200；placeholder 0；唯一 script nonce 与 CSP 匹配，script 正文和本地生成物逐字一致；10 个 comments、0 external assets/inline handlers，2 个明确待渲染标记。原始摘要保存 hosted-verification.json。
- 必需 DESIGN-HTML ready 已报告 flywheel-eng-lead，receipt=`2aca61d2-3752-425b-96bc-4e6f081e5034`。
- 验证层级：静态结构 + 隔离 controller + 托管 HTTP/CSP 契约；未做浏览器视觉 QA、实现测试或生产发布。
- 设计完成/park 收据由随后 exact completion 命令产生，保存到 runner 状态目录；阶段交接后不再无 TURN 修改本目录。
