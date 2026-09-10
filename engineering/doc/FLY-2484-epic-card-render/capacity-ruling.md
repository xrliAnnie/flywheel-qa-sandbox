# FLY-2484 Epic 卡容量 — 实施裁定
Issue: FLY-2484 (https://linear.app/geoforge3d/issue/FLY-2484/进度页e3-渲染层epic-徽标照抄-linear-子单计数分组稳定排序依赖徽标等-fly-xxxx整块在等跨-epic)
日期: 2026-09-10
基于: plan.md

本文件记录 Lead 对 pinned plan 的显式扩展，不修改已评审的 plan.md。

## 依据与实测

问题 af69050a-1f8c-4bd7-afa4-13f79b8d7d98 的 Lead 响应授权以下顺序，每步必须量一次字节。不减少夹具规模，不丢出处；三步后仍超则再次询问 Lead。

原 E1 基线夹具：8 roots / 60 kids，每标题 120 中文字符、acceptance 4096 B、每子单三条含跨 Epic 的依赖、完整运行事实与一条 signal。尚无 E2 attention 和 E4 note。

原 HTML 769194 B。计划 L1 改为 data-label、相同源时间省略、缩短 audit-head 后 773778 B，容量 39（519621 B），40 张 531798 B。L1 实际变大，已撤回。失败的 60 张/480KiB 断言保留。

## 批准的执行顺序

1. 出处去重：页尾一份 provenance 字典，去重后的 source pointer、observed_at 各一项并有 id。15 个数据格只带 data-src 引用；展示层用现有 nonce 脚本或 CSS title 取值。15 格与每格观测时间无损保留。
2. 长文本不内联：子单 acceptance 放不超过 240 字符的摘录与 Linear 链接。blocked_by/blocks 展示 identifier 与不超过 40 字符短标题，完整标题进入同一字典引用。
3. 终态子单保持不列，折叠区计数不变。

容量合同：基线夹具 8 roots / 60 kids / 标题不超过 120 / 摘录不超过 240 / 字典去重，HTML 不超过 480KiB。输入夹具保持原规模和长文本，用渲染投影实现压缩。每步实数写入 implementation-evidence.md 与 PR。

上游接线与 attention 预算器、notes 相关验收仍在集成阶段验证；512KiB 发布硬上限不改。

## 视觉与服务器裁定

Lead 对 eaf13f7d-c192-4746-bd2e-bd8280f128cc 的响应：接受 1280/390 截图为部分视觉回执；视频无效如实记录，不再重试；最终视觉硬门由 QA 在合并后的头上用真机 Chromium 完成。

两个 loopback 服务交 Lead 清理台账处理。Lead 更正：18485 / PID 85873 是其他执行体留下的，不是本轮创建；此前证据中的归属判断不成立。不再对这些进程操作。

## 第二次容量裁定：独立审计文件

问题 c0ae4f34-41f8-4412-8708-78af9d4de655 的响应：HTML 每格保留出处指针 id 与 observed_at；展开的 from 数组及每格完整审计明细转入同次发布的同名 `.audit.json`，页脚列路径、SHA-256、entry count。字典覆盖 header/root-count/projection/view provenance，并进行重复字符串 intern。HTML 门限仍 480KiB，sidecar 不计入但必须报告大小；不减夹具，不丢信息，仍超则再问。

前一轮实测：来源字典后 768600 B；长标题短显/完整标题入字典后 640926 B；终态排除已存在，第三步仍 640926 B。当前容量测试保持红色。完整包测试本次在 claude-runner 的 Vitest `onTaskUpdate` 超时处退出 1；不能当作全套通过。

发布接口核对：现有 stable-token HTML 是单 Blob 覆盖，gateway 只读 index.html，尚无多文件原子切换。问题 8329af66-228f-4ba7-9257-e15574b67ca6 提交最小方案：先写不可变 hash 子目录下 index.audit.json，再覆盖绑定该 hash 的 HTML，保留旧版本引用；请求裁定路径要求的这项调整。裁定前继续纯字典与渲染工作，不改发布链路。

Lead 已在 8329af66-228f-4ba7-9257-e15574b67ca6 接受 hash 子目录：先写不可变 r/<token>/<sha256>/index.audit.json，成功才覆盖 HTML；gateway 严格 hash 白名单、同 TTL；sidecar 失败则不发布 HTML。每次固定页刷新只保留当前与上一 hash，TTL 清理覆盖子目录。页脚另记 audit bytes；不做 bundle/manifest 大改。

侧车渲染第一轮测试：原 60 子单夹具 HTML 281855 B，audit 217898 B，1042 条；逐格解码等于原 Cell，view from 保留，hash/path/bytes 确认。同次发布接线尚未实现，容量尚不是线上发布验收。单响应 HTML 诊断接口暂保留自包含审计，以免返回不存在的 sidecar 链接；托管发布采用 bundle 接口。

## 最终集成与部署保护

12b30083-a866-4095-bf72-0a13f1b99ccb：Lead 裁定不等 sibling；在 E1 基线完成全门、milestone 最后、一次普通 push、PR、精确头机审与 CI。保留 A/B1/B2，以合成夹具验空值/预算。PR 必须说明 E2 #1147 / E4 #1148 合入后，Lead 再交一次 merge origin/main 技术返工，接真实输出重验。合并顺序 2485 → 2483 → 2484。不 cherry-pick/rebase/force-push。

ffb7ac65-d355-44b7-b42a-e8e513197928：接受当前容量；新增发布前网关 GET/HEAD 探针，audit 上传后、HTML 覆盖前必须成功，否则明确失败并保留旧页。部署文档 gateway-deploy.md 记录现有入口与 no-op 限制。Lead 部署网关后再由 updater 带上线，本节点不部署；无 preview 可将真机网关验收明确递交 Lead 补验。

## 代码审查与本地测试最终裁定

c3982de8-8d17-434e-a4ed-01754b446d67：`codex:rescue` 因 sandbox 初始化失败不再重试，不宣称有 rescue 回执；Bridge 精确头 request-review 为代码门。本地整包按 FLY-2492，只隔离重跑 db-hygiene 该文件一次（已 4/4 通过），失败与 onTaskUpdate 超时如实披露，不追本地全绿。之后 milestone 最后、一次普通 push、PR、精确头 review + CI 14/14；审查期间冻结 HEAD。
