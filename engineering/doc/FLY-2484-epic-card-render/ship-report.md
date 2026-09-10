# FLY-2484 Epic 卡渲染 — 实施交付报告
Issue: FLY-2484 (https://linear.app/geoforge3d/issue/FLY-2484)
日期: 2026-09-10
基于: plan.md、capacity-ruling.md、implementation-evidence.md

## 交付

E1 范围里的开放 Epic 默认收起，徽标使用 Linear state 原文，计数独立显示。状态分组后按 identifier 稳定排序，终态子单转计数；依赖显示「等单号」、跨 Epic/范围外及「整块在等」。机器进度保持节点、次数、会话状态，页面词表不引入人名。

托管 HTML 每格保留审计 id 与 observed_at；完整 Cell、view from 等进入去重侧车。页脚绑定 hash 路径、SHA-256、条目数和字节。先写 audit，再 GET 公共网关验证 JSON 200 与 hash，成功才替换固定 HTML；失败保留旧页。成功刷新保留当前和上一 audit，14 天清理包含 hash 子目录。诊断用单响应 HTML 接口保持自包含审计，托管页面采用 bundle。

## 证据

原 8-root/60-child 夹具不降规模：HTML 281855 B，audit 217898 B / 1042 条。合成 68 条各280字备注加 attention 警告后 HTML338195 B，三个插槽位置与空值断言通过。原始 audit 逐格还原、hash、稳定渲染及首屏零展开均有可执行测试。

E1 冻结 Linear 回放7根/36子单：子树与计数逐项匹配，显示18张开放子单；HTML92717 B，audit89305 B /292条。运行事实显式 missing，属于离线重放。

阶段回归27文件346测试通过；追加发布前探针、首次/过期恢复、失败 outcome 持久化、hardened HTML512KiB负向边界均红绿验证。最终 lint/build exit0。无新表、无 schema migration、无新 shell 测试。

## 门禁与限制

完整 package suite exit1：teamlead 955文件通过/1失败，12836 tests通过/1失败/7skipped，另有 Vitest onTaskUpdate timeout。唯一断言失败为未修改的 db-hygiene 文件，预期archive100实得64；单次隔离4/4通过，不能替代 full-green。Lead c3982de8 指定停止追本地全绿，以 exact-head CI14/14作为最终门。

codex:rescue 已通过 companion 调用，但 sandbox 初始化 exit71，模型未启动，无审查回执；Lead 明确由 Bridge 精确头 request-review 承担代码门。最终 review/CI 收据随 PR 与 Lead 报告交付，不能从此文档推断已批准。

三张1280/390 PNG为侧车改动前部分视觉回执，视频无效。Lead 接受部分截图，将最后视觉交 QA。没有 Vercel preview：网关路由真机未验，Lead 部署后补验。gateway-deploy.md 记录当前项目、既有迁移命令 no-op、未执行的 helper 部署命令与安全切换顺序。

## 交接与回滚

本 PR 按 Lead 12b30083 在 E1 基线上交付。**E2 #1147 / E4 #1148 合入后需一次 merge origin/main 的技术返工（Lead 交），届时插槽接真实输出并重验。** 本轮合成插槽不是 sibling 真渲染器/预算器的验收。合并顺序由 Lead 控制为2485→2483→2484。

精确头 review 与 CI 后走 needs_review，由 DAG 推进下一阶段。实现节点未 dispatch QA、merge、deploy 或重启服务。上线顺序为 PR 合入、Lead 部署并验证网关、updater带入渲染器、探针通过才发布新格式。整 PR revert 后下一次生成回旧渲染；遗留 audit 有 TTL 清理，网关旧部署回退命令未在本轮验证。

## QA attempt 2 返工交付

修复托管footer完整SHA长串在手机宽撑破：加入overflow-wrap:anywhere，不删hash或审计信息。新增同状态Epic的counts反向夹具，counts.live降序变异必须失败，正式实现按identifier排序。恢复后epic-page 21文件257测试通过。重放HTML现92749 B，audit保持89305 B / 292条。

视觉硬门由QA执行：verify-hosted-layout.mjs支持 --cdp，生成390/1440截图并断言横向宽度、完整SHA与默认收起；使用 --without-footer-wrap作缺陷对照，并另验旧头cef15b9ce。实现侧未出新PNG，不声称视觉PASS。网关hash路由仍无真机回执，Lead部署后补验。其余非阻断建议未扩入本次返工。
