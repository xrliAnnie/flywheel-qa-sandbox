# FLY-2549 预检工作区构建 — 实施计划
Issue: FLY-2549 (https://linear.app/geoforge3d/issue/FLY-2549/病根-班车-restart-预检在-pnpm-build-之前用-tsx-跑源码工作区包新导出flywheel-config)
日期: 2026-09-14
基于: research.md

## 最小实现（R2）
1. 新增脚本级回归：在临时 workspace 复制当前 config/core/comm/teamlead 源码，依赖复用当前 checkout node_modules；为相关包放置不含新导出的旧 dist。真实 summary-registry.ts 及子进程 TeamLead 校验器执行同一 fixture。通过真实迁移器生成隔离 receipt。旧 preflight 无映射时失败，新 preflight 应 exit 0。捕获红侧输出，禁止只模拟 verifier 成功。
2. scripts/tsconfig.restart-preflight.json 使用 paths 把 flywheel-config、flywheel-core、flywheel-comm/lead-identity 映射至对应源码。在 summary_registry_activation_preflight 现有 pnpm 命令前添加 TSX_TSCONFIG_PATH 环境赋值（绝对路径），确保子进程 pnpm exec tsx 同样继承。保留 CLI/inline guard、失败码及原调用位置。
3. 测试断言真实配置映射解决新导出，原 dist/node_modules 在成功与 stale receipt 失败前后字节不变；dry-run 不增加 install/build。现有脚本测试保留所有负向守卫，stub 记录 tsconfig 环境和 argv，仍只运行 verifier。
4. 当前 checkout 的真实 source preflight（含 #1162 新导出）使用隔离 registry + 真实 migration receipt，记录命令、输出、exit 0；禁止生产 registry 变更。
## 验证与交接
- bash scripts/__tests__/fly2030-summary-registry-activation.test.sh 及新增 stale-dist shell 测试。
- pnpm lint；pnpm -r build；pnpm test:packages:run。根据 review 指出的 macOS GUI 风险，聚合测试使用 PATH 中隔离 osascript/open 拒绝器避免打开 founder Terminal；原命令照跑，失败如实报告，不伪称全绿。
- 最后代码批次同时包含测试证据、progress 和 engineering/doc/milestones/FLY-2549.md；push 后经注入 review_code / request-review 流取得有效 verdict，不在 review 后追加文档。
- PR 正文说明：修复合入且班车正常拉取后，12:00 PT 班车预期可自愈此旧 dist 阻塞；实际部署归班车验证，当前不声称已上线。
- 判据 1 字面只列 build-before-preflight，已向 Lead 请求确认题目原建议的源码映射等效满足；Lead 已在问题 8d89356d-91a0-4eb8-968c-c75839ab5566 中确认等价满足，R2 有效设计 verdict APPROVED。
- 使用 complete --route needs_review --pr NUMBER；不派 QA、不 ship。

## 设计评审收敛
- R1 HIGH 接受：不在预检里 install/build；运行中 dist/node_modules 与停机备份边界保持不变。
- R2 APPROVED，question e25bc8f0-1ba1-42d2-8917-899e189b5a7d / request 5133a0e3-24d1-4420-8105-20733456f637。
- 用精确 lead-identity 路径替代 wildcard，避免 exports 非同名布局误映射；测试将每个已安装工作区依赖指到隔离夹具，正向验证时 dist 全部不可用，发现意外的 dist 回退。
- 既有预检在 install 之前运行，因此目标版本新增第三方 npm 依赖仍可能 fail-closed。此项作为非阻塞已知限制报告 Lead；若遇到，应由授权运维窗口处置依赖准备/回滚，不让 runner 在活服务下安装。此次仅修工作区旧 dist 缺导出的事故，不改变 updater/R4。
