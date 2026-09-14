# FLY-2533 设计验证与评审记录 — 调研
Issue: FLY-2533 (https://linear.app/geoforge3d/issue/FLY-2533/病根-非-work-kind-项目起-runner-不带-taskcategory-409-dag-entry-not)
日期: 2026-09-13
基于: plan.md

## 设计产物验证（不等同实现或生产验收）

- 本轮仅新增本 issue 文档。未更改实现代码、配置、数据库、服务或派发后继。
- 范围包括裁定 1–7 及 A–F：plan §3–7 给出源码与兼容方案，§8–9 给出实际可观察测试与 529 证据合同。
- Lead 回复 `13da1f44-f11f-4f06-b9fc-029d8506b4ca`：批准正式 type 映射、review 单独协议、gate/land 不注入，要求 F 等价有效 prompt。
- Lead 回复 `d7ec1b82-6f6d-4637-af6f-7ad52735b2cc`：接受单源生成兼容文件与 Codex 实际通道；协议+手册总长 >40,000 必须拒绝，已同步计划/HTML。
- 回报已用 ask --report 提交（`c87aa516-6df8-4629-9502-abbf73eb875d`、`877b8709-c96a-4dfc-babd-92763b5b8c22`）。即时 nudge aborted 时 CLI 仍确认 durable queue row retained；不重发制造重复。

## HTML 检查

`design.html` 15,779 字节；8 个 section 均有一个评论输入，包括汇总卡。系统字体、浅色、viewport；无外部依赖、无自写 CSP meta、唯一 script nonce=__CSP_NONCE__、无 inline handler。

2026-09-13 本地 happy-dom 行为 harness PASS：

- localStorage 以 pathname 隔离、保存/恢复；存储读写抛错仍可输入汇总。
- 逐节意见实时汇总，原文作为 text/value，HTML 字符不创建元素。
- 每个分段以精确 `【页面意见汇总】FLY-2533` 开始；长意见按最多 1800 Unicode 字符分段并重复章节名。
- 复制全部/分段按钮；clipboard 成功、Promise 拒绝、API 缺失三条路径，后两者走 execCommand fallback。
- DOM id 唯一，每节评论与章节标题对应。

执行：`node /tmp/verify-fly2533-html.mjs engineering/doc/FLY-2533-snapshot-phase-protocol/design.html`。这是 DOM 模拟验证，不是浏览器视觉或真实 CSP 运行证明。托管后另验 HTTP、nonce 替换和 CSP 匹配。

## Mermaid 本地渲染限制

两张图均用真正 Mermaid source；没有使用 CSS 假图或远程渲染。`flow.mmd`、`model.mmd` 各调用 mmdc 两次（初次加一次标准旗标重试），均失败于 Chromium 启动：

```text
FATAL:mach_port_rendezvous.cc(399)
bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.<pid>: Permission denied (1100)
Error: Failed to launch the browser process!
```

命令旗标：`mmdc -i <source.mmd> -o <output.svg> -w 1000 -b white --svgId fly2533-d1|fly2533-d2`。失败时间 22:44–22:51 UTC 左右。两份当前 Mermaid 源还通过了本地 mermaid.parse 语法检查（flowchart-v2）；这不是渲染验证。HTML 两处均标记 `DIAGRAM PENDING LOCAL RENDER` 并内嵌可展开源码；无 SVG 生成，不声称视觉验收通过。权限配置禁止提权；使用任务明确授权的 pending-render 降级。

## 正式设计评审

Round 1 已登记：questionId=`5cf7c92d-de7b-4b12-a705-6019ee33bb60`；requestId=`2be30402-f92f-4f3d-95c2-188118168153`，CLI 返回 accepted:true/skipped:false/duplicate:false。review 提交 head=`c1a9c9942`，plan blob=`72f93b81db8008ad8eb4c79cd5e3132b5de40c70`。有效 verdict 已由 check 返回 `reviewVerdict=APPROVED`、`reviewerVerdict=APPROVED`（round=1），6 条非阻断 advisories 已保存于 review.md 并通过 ask --report 报 Lead。批准 plan blob 不变。stage design_review 曾 transient abort，之后重试已返回 `Stage: design_review`；review request 本身已持久接受。

## 发布与交接

发布完成（有效 APPROVED 之后）：

- URL：https://fw-reports-624a39.vercel.app/r/51a692e5a4522f011e99bbae2fb5a020/
- reportId：`51a692e5a4522f011e99bbae2fb5a020`；publishOnly=true、messageId=null。没有发频道消息。
- 源 HTML 已在 `c1a9c9942` 提交；审批和 follow-ups 在 `0dacfbd04`；均已推送。
- 托管 HTTP 200；nonce placeholder=0；唯一 script nonce 与唯一 CSP 匹配；外部依赖=0、inline handler=0、pending diagram 标签=2。
- 托管 SHA-256：`5aa0c0beb838a2eb747de21bc91b25857ea747ac3c279e57a1b0c11ddf37e692`。
- 对实际托管 HTML 再执行 DOM 行为 harness，8 节评论、pathname 隔离、恢复/存储故障、1800 字分段、clipboard 成功/拒绝/缺失全部 PASS。此检查未在真实浏览器执行；不声称完整视觉或浏览器 CSP 验证。
- `DESIGN-HTML ready` 已向 flywheel-eng-lead 报告，report questionId=`5c395a02-c5c6-4ea4-aaef-b5fbcfd7156e`。
- 有效批准计划 blob 保持 `72f93b81db8008ad8eb4c79cd5e3132b5de40c70`；实现与 QA A–F 全部仍为后续阶段义务。

交接前审计：文档、正式 APPROVED、HTML commit/push、publish-only、托管验证、Lead 报告均已完成。随后执行 `complete --route phase_design_complete` 和服务器要求的 park；以 CLI/runtime durable 回执作为阶段交接真值，不在命令之前声称交接已接受。
