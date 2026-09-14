# FLY-2538 报告托管账号轮换 — 实施记录
Issue: FLY-2538 (https://linear.app/geoforge3d/issue/FLY-2538/报告托管-vercel-账号轮换做成一条命令migratereport-hosting-retarget-凭据热切换-报告用量削减-水位告警)
日期: 2026-09-13
基于: plan.md

实施遵循已固定 v5 plan。Lead 范围裁定见 review.md：跨 token 不去重，使用独立 REPORT_HOSTING_VERCEL_TOKEN，不承诺未经生产计量的月用量降至 1/3。Epic audit 清理按 Lead f180cf70 裁定延迟到 registry commit 成功后。

## 本地证据

- 同一 HTTP router 从无凭据启动，写入文件后可发布；registry 切到另一 store 后使用新 token。上传补偿、Epic audit 和分页 sweep 固定使用操作开始时的快照。
- retarget 使用真实临时 registry、模拟远端 API/Blob：首次三份报告切换成功，重跑零 put/deploy/probe 且 registry 字节不变。并发 publish 触发第二轮收敛；连续三次 stale 保留旧 hosting。第 26 次上传失败后，重跑跳过 25 条已落盘 proof。
- 创建响应丢失保留 intent，不重复 POST；显式 store id 恢复、放弃 intent 归档、死 PID 锁在同次运行中恢复均有测试。
- secrets 文件：0600、单行、同 store 重跑不改文件；symlink、错误 owner/store/mode、多行和可写父目录拒绝。真实子进程在 rename 前退出，留下 0600 临时文件，重跑可完成。
- 水位覆盖阈值、低水位配额超限、同日去重、退避、每日次数上限、跨日、换 store、热添加凭据和通知回执共存。
- CLI 有实际子进程退出码测试及三个成功模式的接线测试；远端 API 与内核行为另有独立测试。

## 压缩实测

仓库 epic-shape fixture，经 generateEpicPage → renderEpicPageBundle → ReportRegistry HTML 加固 → gzip(level 9)：

| 项目 | 字节 |
|---|---:|
| 加固 HTML | 31,025 |
| gzip HTML | 6,587 |
| HTML 减少 | 78.77% |
| 未压缩 audit JSON | 14,727 |

加固 HTML SHA-256：5f2d8c05f8bbd1374a6d9e04e09cadb966f845264c516ebf1846fbadcb50683f。这是本地 fixture 测量，不是生产账单；audit、截图、请求次数、带宽另计。固定页 digest 跳过减少重复 put，但不能单独推导月总用量。

## 验证状态

pnpm lint 已通过（17 个警告）；pnpm -r build 已通过。两次 pnpm test:packages:run 均未通过：首次 flywheel-comm 四个 5 秒超时和一个 sent/stale race 断言失败（2475 passed / 5 failed）；五个失败文件单独运行 146/146 通过。第二次 flywheel-comm 2480 passed，但 claude-runner 在 1268 passed / 2 skipped 后报未处理错误 `[vitest-worker]: Timeout calling "onTaskUpdate"`，exit 1。被 fail-fast 跳过的四个包正在单独补跑，不能据此将 aggregate 标绿。首次全仓 lint 的本次格式错误已修正。未新增 scripts/__tests__/*.test.sh 或 *.test.mjs。

空 Vercel 账号、生产 store count/size、浏览器打开和通知频道收件由后续 QA 提供证据，当前实现阶段未执行。未部署、未重启 Bridge、未申请 ship。

## API 传输核对

本地 store 比较值去前缀并转小写；独立的 storeApiId 保留 Vercel 返回的大小写与 store_ 前缀，GET/connection/DELETE 使用该 API identity。最初精确调用断言也遗漏了该前缀，已先修正断言得到失败，再修正客户端并验证通过。依据：[官方 store-get](https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/blob/store-get.ts) 与 [官方 getStoreIdFromAuth](https://github.com/vercel/vercel/blob/main/packages/cli/src/util/blob/token.ts)。

## R2 HIGH 修复验证

API identity 修复先以混合大小写断言验证失败，再修复 API、journal、registry 和用量读取；43 项相关测试通过。Epic 新发布持久化 mutable 标记，retarget 从只读 epic_page_publication 恢复旧 token 身份，仅稳定 token 排除冻结 createdAt manifest。普通报告保留原始时间与 14 天过期规则。部署网关单独重跑同样保留该区分。

新增 day-15 网关测试证明 day-14 刷新的 Epic 返回 200、gzip 与 nonce，普通迁移 token 返回 404；旧数据库身份恢复、身份冲突和缺失权威数据在远端变更前失败也有测试。相关 6 文件 122 项通过；teamlead build 产出当前本地提交 67f2728d3 的 build identity。没有重跑全量或下游四包。R1 其余 advisories 依 Lead c1b16001 裁定留后续。
