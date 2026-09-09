# FLY-2359 设计交付校验 — 调研
Issue: FLY-2359 (https://linear.app/geoforge3d/issue/FLY-2359/2355b2-记忆回流-种回去任务结束把一次性家蒸馏出的记忆汇进-agent项目)
日期: 2026-09-08
基于: plan.md

## 当前结论

**R2 已 APPROVED**：request `e867bdd6-eb14-44dd-a526-447247b65989`，question `dba18a8f-92bd-4a0f-8697-0a293ff1554e`，reviewVerdict/reviewerVerdict 均为 APPROVED。获批 plan blob 为 `a25b22675b2bb7689a822aaafebb74271783a999`。三条非 blocking 实施澄清见同目录 `review-advisories.md`。

最终设计页： https://fw-reports-a53de2.vercel.app/r/4c47034c229a75432039a5d49da5c0e6/ 。下方按时间记录旧版交付与送审过程；旧版的 pending 状态和 URL 不代表当前状态。

完成审计：exploration/research/plan 均在规定文件夹且 frontmatter 正确；B1(a) 范围、确定性导入、两项身份负控、真实 RED/GREEN 交接全部写明；未修改实施代码或启动服务；HTML 已 commit/push/publish-only/report 且 HTTP/CSP 校验通过，评论逻辑已验证；Mermaid 两图分别失败及标准重试失败的允许 fallback 已明示。仅剩写最终进度、Lead 汇报和执行 phase_design_complete/park。

## 本地 HTML

- founder-design.html 为 14716 bytes（初稿 14466 bytes），零外部资源依赖，无自定义 CSP meta。
- 7 个 section 各有一个可输入意见框；只有一个 inline script，nonce 为精确 `__CSP_NONCE__`；无 inline handler。
- HTMLParser 静态检查及 Node JavaScript syntax check 通过。
- 在 Node VM 的最小 DOM 夹具中执行真实 inline script：自动保存、路径隔离、原样文本显示、意见聚合、每段重复 marker 且低于 1800 字、Clipboard API 缺失/拒绝时 execCommand fallback、localStorage 拒绝后仍可复制全部通过。
- 此验证证明脚本逻辑，不是浏览器视觉/真实 CSP 执行证据。托管发布后另外做 HTTP/CSP 校验。

## Mermaid 本地渲染失败（按任务明确允许的 fallback）

两张真实 Mermaid 源已提交：d1-flow.mmd、d2-model.mmd。每张各运行一次并用标准参数重试一次：

```bash
mmdc -i engineering/doc/FLY-2359-memory-history-seed/d1-flow.mmd -o engineering/doc/FLY-2359-memory-history-seed/d1-flow.svg -w 1000 -b white --svgId FLY-2359-d1
mmdc -i engineering/doc/FLY-2359-memory-history-seed/d2-model.mmd -o engineering/doc/FLY-2359-memory-history-seed/d2-model.svg -w 1000 -b white --svgId FLY-2359-d2
```

2026-09-08 12:28 PDT 四次均退出 1，原因一致：Chromium `bootstrap_check_in ... MachPortRendezvousServer ... Permission denied (1100)`。当前权限策略不能升级执行。HTML 对每张图显示精确 `DIAGRAM PENDING LOCAL RENDER`，并展示转义后的 Mermaid 源；没有伪造图像，没有使用远端渲染服务。

## 设计评审

R1：计划提交 f55a27360；questionId `34bc08f0-0cf3-4c71-8c0a-4021dc54bdd8`；requestId `f634d1ad-8e15-4625-9f47-da3f191383b9`。request-review 已 accepted，当前待 verdict。设计阶段不因评审等待而声明 blocked。


## 托管交付

当前页面： https://fw-reports-a53de2.vercel.app/r/0591abfa3f380ea7d88bbbb93c6ad455/

已提交 HTML 的 commit 为 `2dfcca952`，publish-only 成功，未发送频道消息。`verify-report` 返回 `ok:true`、HTTP 200、noncePlaceholder/scriptCsp/scriptNonce/expect 全 pass，expect 为 `127 个旧家`。源码中两处 pending 图稿保留，`hasInlineSvg:false` 是已披露的渲染失败，不是图已完成。

Lead 已收到 DESIGN-HTML URL 报告（report id `d1b16f18-0a83-4764-ac46-8421568c4d07`）和对问题 b3c5f047 的落实报告（`d06415a5-367c-4f37-9787-5a5ff553dcd3`）。较早 URL 被当前含 127 个未导入家说明的版本取代。


## R1 verdict 与修订

R1 有效 verdict 为 CHANGES_REQUESTED；唯一 HIGH 为 `seed-archive-unnavigable`。修订加入 session 的历史日期/任务号/任务标题、有界 index（最多 8 个 snapshot，≤8192 bytes）、完整可搜索 catalog，以及 605 候选/225 非空来源/217 唯一快照/380 no_memory 的生产规模夹具。近八条之外的旧任务也必须能在真实首轮被检索和读取。

另修正不存在的 Blueprint.fly2358 测试引用，改用当前存在的 Blueprint.fly1356-skill-framework；终态谓词改用 isWakeTerminalStatus。忙家可能延迟、种回故障会阻止该次准入、临时目录不自动清扫、锁内历史查询耗时等非 blocking 风险在 plan §9 明示并给出观测/恢复边界，没有新增强制停止或持续回流系统。

HTML 的评论脚本未改动；可用性说明同步增加有界近期入口和可搜索旧历史。新托管 URL 待这版 HTML 提交后发布，旧 URL 仅代表上一版。


## R2 送审与 HTML 交付

- 修订 commit：`d936c9d87`。
- gate questionId：`dba18a8f-92bd-4a0f-8697-0a293ff1554e`；requestId：`e867bdd6-eb14-44dd-a526-447247b65989`；request-review accepted，沿同一 reviewer session `cc47408e-752e-4f19-9c2f-f5ba288e2245` 复审。
- 当前 HTML： https://fw-reports-a53de2.vercel.app/r/4c47034c229a75432039a5d49da5c0e6/ （取代前两版）。
- HTML 15179 bytes；与已通过逻辑夹具的评论 script 逐字相同。verify-report：HTTP 200、noncePlaceholder/scriptCsp/scriptNonce/expect 全 pass；expect=`217 份不同快照`。
- DESIGN-HTML 报告已持久入 Lead 队列：`d4d0af94-d321-4f6d-b1bc-b07f706fabda`；修订/残余 advisories 报告：`d8d1785d-390a-4642-85ec-6c03f9f7461a`。即时 nudge 一次超时但工具确认 durable queue row retained，没有重复发报告。
- 本阶段尚待 R2 的有效 verdict；未以完成 route 提前交接。
