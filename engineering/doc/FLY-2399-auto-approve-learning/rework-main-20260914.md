# FLY-2399 三点判断 — main 冲突返工
Issue: FLY-2399
日期: 2026-09-14
基于: plan.md

上线后，Flywheel 的 dry_run ship 卡会在原 thread 看到一条持续更新的三点机器意见（需求对齐、在飞冲突、QA 覆盖），并将可见版本与 founder 最终决定配对进台账；线上自动批准仍沿用原纯文档窄口。

本轮 engine rework:0aa1184d566c57de59349298a85c61d73d2bb0c9f9cb8d5bf485257c034a3bbd，从 4a869fcbaf21120d698cd7cebff396af0554ba6a 同步 origin/main。TURN implement attempt 3 epoch 17 已核验。批准 plan 不改。

## 冲突解决及新增验证

- CI 同时保留本单四个脚本测试和 main 的 FLY-2490 回填测试。
- StateStore 同时保留 ship-judgment 账本和 main 的启动失败回执/阶段依赖。生产表金标为 156 保护表、217 总表、214 非 retired 表，真实迁移普查测试通过。
- Epic publisher 同时保留可选摘要容量裁剪与 main 的 hostedContentDigest/24 小时刷新逻辑。
- Bridge 同时保留独立历史 timer 与 main 的报告凭据刷新、清理及用量 timer。
- ReportRegistry 恢复写适配显式 HostingBinding 与异步 commit，恢复普通报告保留原 createdAt、token 及非 mutable 属性。
- 历史页冻结 hostingKey；上传时取得新凭据快照并绑定目标 store，目标变更拒绝上传，提交时再次检查 registry binding。上传不持共享报告锁；必须 await registry commit 后才返回成功。
- Blob 恢复上传适配 gzip gateway；读取压缩或普通对象比较解压后的原正文，输入/解压容量有界；不覆盖已存在对象、不续 TTL。
- retention consumer registry 合并双方新增的只读消费者。

RED：历史发布测试在 main 的新 stagePublish 签名下失败（缺 HostingBinding）；修复后相同测试通过，并覆盖凭据轮换、变更目标拒绝和普通报告属性。

当前验证：全仓 pnpm -r build 通过；聚焦 55 文件 266 测试通过（ship-judgment 全目录、报告恢复、Epic publisher、retention sweep）；pnpm lint 通过，18 个既有 warning 保留。全包套件和新增脚本验收继续收集；下一步冻结最终头、精确 CI、新 review，然后 needs_review 交 QA。

QA 要重验本轮触及的历史托管/页面发布/Bridge timer 与表迁移面；其它旧证据仅在未触及的面继续有效。本节点不执行 founder gate、不合 main、不部署、不触生产库。

## 收尾验证与诚实边界

冻结合入 main 为 fd9e3064d37632e4d7cdab67ce612d3b65107e71（合并提交 57a875ef0）。共享 origin/main 随其它 PR 前进不改变本轮已验证的 merge parent。

异步锁取消用例另作 RED/GREEN：锁未释放时取消发布，原代码仍在锁释放后写 registry；恢复写现在传递 AbortSignal，在拿到锁后、任何持久写入前检查。三份报告恢复/发布测试最终 7/7 通过（包含 gzip 恢复、普通报告 TTL、轮换凭据与取消）。

- 全仓 typecheck 通过。构建和 lint 在最终取消修复后再次执行，结果随最终里程碑冻结。
- 新增四组 node 脚本共 10/10 通过。本分支相对合入 main 无新增 .test.sh。
- 旧授权/页面回归：525/526 通过，一项 founder-budget 5 秒计时超时；没有预算断言失败。
- 全包 pnpm test:packages:run exit 1，停在 comm：2542 通过、7 个 5 秒超时、3 skipped（5 文件）。原完整套件不计绿，未运行的后继包不冒充通过。
- 对失败文件加本单 comm 查询进行单 worker 复验：152/153 通过，仅 lead-registry-cli 的 backend migration 用例仍 5 秒超时。
- 为区分断言与宿主计时，两项剩余测试只在命令行使用 testTimeout=15000 观察，测试文件/断言/CI timeout 未改：backend migration 1/1 通过，实际 2693ms；founder-budget 3/3 通过，cap 测量实际 3713ms。combinedChildCap=69，capBytes=521503；60-child hardenedWithBindingBytes=462671。原超时回执仍保留；该观察不替代精确头 CI。
- 历史发布先前在全包并发期间也曾一次 5 秒超时；单 worker 7/7 通过。所有 testTimeout 延长只在诊断命令，不改生产或 CI 配置。
- 既有 review advisories 以 PR 最后 R3 的 18 项为准（原 17 + 冷缓存页预算可用性），本轮未扩大修复范围。

本轮日志位于 /tmp/fly2399-{merge-focused,cancel-red,cancel-green,all-tests,comm-isolated,comm-observation,legacy-pages,budget-isolated,budget-observation,script-tests,typecheck,final-build,final-lint}.log。精确头审查及 CI 回执由完成报告关联，未通过前不声称实现交接完成。

## 同轮 main 再次前进

3d1e14d7e 推送后 GitHub 判 CONFLICTING、零新 CI：main 已合 FLY-2390 (#1156)，新 base 为 14866f7e5551e3aeafab18b58577df70492b7c73。因此继续同一 engine 返工，不能把旧头的审查或 CI 用于本次交接。旧 review gate f85ec916-3767-4f6a-b737-3e9edeb2b02c/request 0e45cfbe-cfc9-4c04-b896-c0c802be7137 只绑定旧头，已向 Lead 报告。

第二次同步只产生三处相加冲突：StateStore imports 保留双方，retention consumer 保留 release readiness 和 ship-judgment 消费者，表金标随 main 新增 11 张表更新为 228 总表、225 非 retired；保护表164（main156加本单8；Git 将双方旧156自动合并成156，真实普查RED后校正）。frozen-lockfile 安装通过。判断/托管实现无额外变更；再次执行构建/lint与真实迁移/历史集成回归。最终里程碑及外部回执记录新冻结头和结果。
