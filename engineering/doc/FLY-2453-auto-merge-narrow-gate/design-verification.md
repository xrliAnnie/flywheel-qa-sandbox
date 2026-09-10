# FLY-2453 自动合并窄口开关 — 调研
Issue: FLY-2453 (https://linear.app/geoforge3d/issue/FLY-2453/2309b45-自动合并窄口开关founder-一句现在放开-现在停止切换开着时同时过三道闸机器判纯文档-人声明-pure-docs)
日期: 2026-09-08
基于: plan.md

## 设计节点实测

- `python3 engineering/doc/FLY-2453-auto-merge-narrow-gate/build-founder-html.py`：成功，HTML 18303 bytes。
- `node engineering/doc/FLY-2453-auto-merge-narrow-gate/verify-founder-html.mjs`：PASS。11节各有评论；单个nonce script；无外部assets、table、inline事件；路径隔离localStorage、拒绝存储仍可汇总；实时汇总；每段≤1800 UTF-16字符且不切断emoji且每段以指定marker开头；clipboard成功/不存在/拒绝/双重失败；清空、刷新、跨页隔离均覆盖。
- `git diff --check`：通过。没有实现代码改动；更改限制在本issue文档目录。
- `mmdc` 三张图各执行一次配置参数、再一次指定标准参数：均退出1。Chromium启动错误为 `bootstrap_check_in ... Permission denied (1100)`，无图形产物。
- 按任务明确fallback，HTML保留三处 `DIAGRAM PENDING LOCAL RENDER`，旁存三份Mermaid源码；没有CSS假图、没有远端渲染。
- Chrome DevTools MCP可列出现有页面，但创建本地验证页被工具审批策略拒绝：`MCP tool call requires approval, but approval policy is never`。未操作已有用户页面；没有可宣称的浏览器视觉或真实CSP执行验证。VM DOM验证不替代它。

## 覆盖审核

- 原issue六项：plan §4控制、§3/6三闸与答卡、§5/9四线审计、§6停止、§7红线、§13 R1增补。
- 三态指令65835c4e：§2/4/8/10，default dry_run、放开auto、停止dry_run、off维护/台架且生产无自由reason入口。
- 机器意见与统计新增范围：§5/8/9及C3；200人工卡窗口、precision主指标、98%仅显示、Wilson下界和b<5样本不足。
- 原issue验收与变异：§11 C4、§12；列为后续实现/QA待执行，不冒充已完成。
- 设计review、提交推送、发布与阶段完成仍须取得实际回执；本文件不预写通过。

## 已知边界

此节点未实现产品功能、未运行产品全套测试、未做529台架，未修改生产flag或部署服务。HTML图形降级来自明确渲染限制；后续有本地渲染能力时可用旁存mmd重新生成SVG并运行同一build脚本。

## 托管页验证（首版）

2026-09-09 03:14Z publish-only成功，reportId=955af162cc537d0732b9dcaa7dfd32cd，无频道消息。curl HTTP200，原nonce占位符已替换，单个script nonce与CSP匹配，11节评论和3处渲染限制均存在。后续评论分段按UTF-16长度收紧，需要在最终提交后重发页面并验证新URL。

## R1 修订复验

- v3同步修改代理声明语义、疑问句拒绝、十分钟新消息时效、样本时间与修正head边界；HTML重新生成18839 bytes。
- `verify-founder-html.mjs` 再次通过全部11节评论、存储隔离、Unicode分段与复制降级断言；`git diff --check`通过。
- 修改后的d2/d3各进行一次正常本地渲染及一次标准参数重试，均exit 1，仍为Chromium MachPort权限错误；保留明确待渲染占位及更新后的Mermaid源码。没有改变浏览器验证限制。

## R2 修订复验

- v4已将消息时效改为单向：只有开启十分钟，停止不因延迟过期；新增B2负向否决边界测试的明确合同，并把样本时间三列同步回C0完整schema。
- HTML重新生成19088 bytes；评论VM全部断言及git diff --check再次通过。三张Mermaid源与渲染失败状态未变，没有重复声称图形已渲染。
- 三个目标包的test:run均已核实为vitest run；未执行产品测试或生产操作。

## 最终交接证据

- R3有效/原始评审均APPROVED；request fdf2d72e-3e3a-48bb-9e05-ab32add89496，回执见review-response.md。
- 最终已提交HTML的publish-only URL：https://fw-reports-a53de2.vercel.app/r/51bec88dabceec8cacb4b73410db18bf/ 。已向实际Lead报告DESIGN-HTML ready，未发送频道消息。
- 托管URL返回200；单个替换后的script nonce与CSP匹配；单向时效、代理声明和生产静音边界存在。该HTTP/静态检查不替代被权限拒绝的真实浏览器验证。
- 设计范围内没有产品实现、产品测试、合并或部署；C0–C4的红绿/变异/529证据仍由实现和QA执行。
- 角色经验共3条：共享作者信任边界、代理声明不是人类签字、开启/停止不同的消息年龄约束。MEMORY索引40行/9134bytes，在上限内。
