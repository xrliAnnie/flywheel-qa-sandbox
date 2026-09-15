# FLY-2413 设计交付核验 — 调研
Issue: FLY-2413 (https://linear.app/geoforge3d/issue/FLY-2413/fly-2006-retention-registry-是并发热点任何加表的单都要改同一个测试文件同批-pr-必然互撞)
日期: 2026-09-14
基于: plan.md

## 设计评审

- Plan commit: `3543d4664`。
- Gate question: `83db1992-ed25-441d-a206-9f823e2c5f55`。
- Explicit request accepted: `973697f8-42b9-4da0-b202-f34dfc709e0e`。
- 有效 `reviewVerdict=APPROVED`；原始 `reviewerVerdict=APPROVED`，round=1。4 MEDIUM / 4 LOW advisories，无 blocking findings；完整去凭证回执见 design-review-receipt.json。

## 页面本地证据

`node engineering/doc/FLY-2413-retention-registry-fragments/verify-founder-html.mjs` PASS：8 节各有评论；唯一 nonce placeholder 脚本；无 inline handler、外部依赖、innerHTML；location.pathname 隔离；实时汇总；1800 字符 Unicode 分段并重复精确 marker；clipboard 成功、reject、API 缺失及回退失败；localStorage 被禁；清空和刷新恢复。

另以 parse5 实际解析 HTML 树确认 8 section 各一个 textarea、唯一 script。

本核验是静态结构及 VM controller 行为，不是浏览器视觉 QA，不能证明真实浏览器 CSP 执行。

两张 Mermaid 分别执行标准命令并重试一次，均 exit 1：

```sh
mmdc -i engineering/doc/FLY-2413-retention-registry-fragments/flow.mmd -o engineering/doc/FLY-2413-retention-registry-fragments/flow.svg -w 1000 -b white --svgId fly2413-d1
mmdc -i engineering/doc/FLY-2413-retention-registry-fragments/model.mmd -o engineering/doc/FLY-2413-retention-registry-fragments/model.svg -w 1000 -b white --svgId fly2413-d2
```

错误：`MachPortRendezvousServer ... Permission denied (1100)`。源码保留，HTML 两处 `DIAGRAM PENDING LOCAL RENDER`；未使用远程渲染或 CSS 假图。

## 基线环境核验

限定安装 `pnpm install --filter flywheel-teamlead... --ignore-scripts --frozen-lockfile` 成功；`pnpm --filter flywheel-teamlead... build` 成功（13 个 workspace 包的构建路径）。没有修改实现源码。

focused 2 个现有 schema test：首次缺 vitest、二次缺 dist 均未实际运行测试；构建后旧静态全集测试通过，真实临时建库测试因缺 better-sqlite3 本机 binding 失败。限定 rebuild 该依赖成功。最终重新执行同一 focused 命令：**2 passed / 29 skipped**，真实临时库和旧全集两项均通过（2026-09-14 13:28 本地）。这些是旧行为基线，不计为未来实现验收通过。

另只读 import 检查现有执行策略与分类 deleteTarget 集合：teamlead 21 / comm 7，双向差集均为空。

## 发布与报告证据

最终 HTML 与全部设计提交 `30d45d957` 已推送。

Hosted URL: https://fw-reports-624a39.vercel.app/r/539582ab67d3ad32e78ca5a93ed7e639/

publish-report: `reportId=539582ab67d3ad32e78ca5a93ed7e639`, `publishOnly=true`, `messageId=null`, `delivered=false`；按要求仅托管、未发送频道消息。

verify-report: `ok=true`, HTTP 200，noncePlaceholder/scriptCsp/scriptNonce/expect 全 pass，warnings=[]；额外 fetch 确认与本地 controller 字节一致、无外部依赖或 inline handler。hasInlineSvg=false 与已披露的本地渲染失败一致。

DESIGN-HTML ready 及 self-contained DONE 报告均已通过指定 Lead/exec 的 ask --report 提交。评审 8 项 advisories 已独立 fire-and-forget 报告。

剩余顺序：提交本证据和最终进度、push、exact phase_design_complete、park。完成回执由 Comm/controller 持久化，交 TURN 后不再回写本工作树。当前未运行任何生产清理、迁移、部署、重启或 ship。

## 记忆收尾

按本会话允许的记忆更新路径保存一条 reusable judgment：`memories/extensions/ad_hoc/notes/2026-09-14-retention-fragment-digest-closure.md`。本轮未直接改共享 runner-memory 索引；closeout receipt 预计 unchanged。
