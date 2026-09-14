# FLY-2549 源码预检 — 验证回执
Issue: FLY-2549 (https://linear.app/geoforge3d/issue/FLY-2549)
日期: 2026-09-14
基于: plan.md

## 范围与裁定
生产行为只改 restart-services.sh 的一次命令环境赋值，新增 scripts/tsconfig.restart-preflight.json 的三条精确映射。测试及 CI 注册随附；没有 packages 生产 src、调度、R4、停服务或回滚修改。
Lead 问题 8d89356d-91a0-4eb8-968c-c75839ab5566 回答：接受源码路径映射为判据 1 等价修法，目的为预检不再撞旧 dist，且不得在停机窗口前改写 live dist。设计 R2 有效 APPROVED：e25bc8f0-1ba1-42d2-8917-899e189b5a7d。

## 脚本级红绿（同一测试，两版 restart 脚本）
```
git show 14866f7e5:scripts/restart-services.sh > /tmp/FLY-2549-restart-before.sh
bash scripts/__tests__/restart-summary-source-preflight.test.sh /tmp/FLY-2549-restart-before.sh
# exit 1
bash scripts/__tests__/restart-summary-source-preflight.test.sh
# exit 0
```
测试运行真实 summary-registry 源码和它启动的 TeamLead 校验子进程。先仅使 config dist 缺导出，复现事故的具体 SyntaxError；随后把所有夹具工作区 dist 置为不可用，检查 source preflight 成功、dry-run 成功、过期 receipt 仍失败，且 dist 字节和依赖链接前后相同。所有 registry/receipt 都是临时测试数据，真实迁移 wrapper 生成有效回执。夹具重新连接已安装的 workspace 依赖至隔离包，避免回退到 checkout 新 dist 而假绿。

红侧原始输出：
```text
{"ok":false,"code":"summary_registry_command_invalid","message":"TeamLead validator rejected candidate: /private/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/fly2549-summary-source.CGaF8R/repo/packages/teamlead/src/ProjectConfig.ts:6\nimport { resolveCodexLeadCapabilities } from \"flywheel-config\";\n         ^\nSyntaxError: The requested module 'flywheel-config' does not provide an export named 'resolveCodexLeadCapabilities'\n    at #asyncInstantiate (node:internal/modules/esm/module_job:319:21)\n    at async ModuleJob.run (node:internal/modules/esm/module_job:422:5)\n    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:655:26)\n    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)\n\nNode.js v25.6.1"}
PASS: unmapped real verifier fails on missing resolveCodexLeadCapabilities
{"ok":false,"code":"summary_registry_command_invalid","message":"TeamLead validator rejected candidate: /private/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/fly2549-summary-source.CGaF8R/repo/packages/teamlead/src/ProjectConfig.ts:7\nimport { SAFE_IDENTIFIER_RE } from \"flywheel-core\";\n         ^\nSyntaxError: The requested module 'flywheel-core' does not provide an export named 'SAFE_IDENTIFIER_RE'\n    at #asyncInstantiate (node:internal/modules/esm/module_job:319:21)\n    at async ModuleJob.run (node:internal/modules/esm/module_job:422:5)\n    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:655:26)\n    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)\n\nNode.js v25.6.1"}
FAIL: source preflight cannot validate with stale workspace dist
```
绿侧原始输出：
```text
{"ok":false,"code":"summary_registry_command_invalid","message":"TeamLead validator rejected candidate: /private/var/folders/zl/nz5kfm5976q8p6kbt4d0cpgr0000gn/T/fly2549-summary-source.Mv9mTI/repo/packages/teamlead/src/ProjectConfig.ts:6\nimport { resolveCodexLeadCapabilities } from \"flywheel-config\";\n         ^\nSyntaxError: The requested module 'flywheel-config' does not provide an export named 'resolveCodexLeadCapabilities'\n    at #asyncInstantiate (node:internal/modules/esm/module_job:319:21)\n    at async ModuleJob.run (node:internal/modules/esm/module_job:422:5)\n    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:655:26)\n    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)\n\nNode.js v25.6.1"}
PASS: unmapped real verifier fails on missing resolveCodexLeadCapabilities
{"ok":true,"granularity":"per-lead","summaryAssignmentDigest":"d9765868fed8541047f3d9c1e6821e70fab2297e03eccacde99dbda84ea96162"}
PASS: source preflight and child validator pass with stale workspace dist
{"ok":false,"code":"summary_registry_projection_mismatch","message":"summary_registry_projection_mismatch: live assignment digest 6a61234e1558b3346f53b90842d4886c33c758a3c3ebfd946bb84dd60ca952a2 does not match receipt d9765868fed8541047f3d9c1e6821e70fab2297e03eccacde99dbda84ea96162"}
PASS: dry-run and stale-receipt rejection leave dist and dependency links unchanged
```

## 当前 checkout 的真实命令
先用 scripts/migrate-summary-registry.sh 为 /tmp/FLY-2549-real-preflight 中的 fixture 创建回执。HOME 限制 summary-config 读入测试目录；npm_config_manage_package_manager_versions=false 避免 pnpm 在临时 HOME 下载自身。
```bash
HOME=/tmp/FLY-2549-real-preflight/home \
npm_config_manage_package_manager_versions=false \
TSX_TSCONFIG_PATH="$PWD/scripts/tsconfig.restart-preflight.json" \
pnpm --dir "$PWD" exec tsx "$PWD/packages/flywheel-comm/src/bin/summary-registry.ts" \
  verify-activation \
  --projects-file /tmp/FLY-2549-real-preflight/projects.json \
  --receipt-file /tmp/FLY-2549-real-preflight/receipt.json
```
exit 0：
```json
{"ok":true,"granularity":"per-lead","summaryAssignmentDigest":"d9765868fed8541047f3d9c1e6821e70fab2297e03eccacde99dbda84ea96162"}
```
此 checkout 已构建，单凭成功不能证明消除旧 dist 依赖；因此同时保留上面的旧 dist 红绿，以及同一 TSX_TSCONFIG_PATH 下的 import.meta.resolve 输出：
```text
flywheel-config file:///Users/xiaorongli/Dev/flywheel-FLY-2549/packages/config/src/index.ts
flywheel-core file:///Users/xiaorongli/Dev/flywheel-FLY-2549/packages/core/src/index.ts
flywheel-comm/lead-identity file:///Users/xiaorongli/Dev/flywheel-FLY-2549/packages/flywheel-comm/src/lead-identity.ts
```

## 全仓及相关门禁
- pnpm install --frozen-lockfile：exit 0。
- pnpm -r build：实现后再次运行，exit 0。
- pnpm lint：exit 0，既有 warning 保留。
- bash scripts/__tests__/fly2030-summary-registry-activation.test.sh：9 passed / 0 failed，CLI 缺失、inline split-brain、verifier 返回码、pre-mutation 顺序均保留。
- bash scripts/__tests__/restart-summary-source-preflight.test.sh：exit 0（上文回执）。
- shell inventory：316 shell / 54 Node 套件登记守卫通过；CI structure：PASS；workflow-startup：4 tests passed。
- bash -n 两个修改/新增 shell 入口、git diff --check：通过。

## 聚合测试基线失败（不是全绿）
在尚无实现代码改动、全仓 build 完成之后运行精确命令 pnpm test:packages:run。PATH 前置临时 osascript/open 拒绝器，避免 macOS Terminal GUI 行为。结果 exit 1：flywheel-comm 6 files failed / 182 passed；9 tests failed / 2530 passed / 3 skipped；1 unhandled error。因聚合 fail-fast，不能声称未执行的下游包已通过。
失败文件：cli、lead-backend-migration-registry、lead-registry-cli、runner-stop-declaration-race、commands/dependency、commands/qa-result-lock。除 race 的 stale/sent 断言外，其余均为 5000ms timeout；另外有 `[vitest-worker]: Timeout calling "onTaskUpdate"`。
对上述 6 文件以原超时、单 worker 聚焦重跑：5 files passed / 1 failed；150 tests passed / 1 failed。race 与其他超时均通过，qa-result-lock 仍在 5000ms 超时。本次未修改这些源码或测试，也未扩大范围修复；聚合门禁继续如实记 FAIL，交 Lead/QA 评估，CI 是独立结果。

## 交付与剩余边界
本地验证不等于生产上线。修复合入且班车正常拉取后，12:00 PT 班车预期自愈本次旧 dist 缺导出阻塞；未执行任何生产 checkout 改动、restart、调度修改或 QA 派发。
新的第三方 npm 依赖在 install 前不可用，仍可能让 source preflight fail-closed；这是已报告的非阻塞限制，授权运维窗口另行处理。本次不增加 dependency bootstrap 或运行中 install。
本文件和 progress/里程碑在代码评审前冻结；后续 review/CI/complete 回执写入结构化 comm 与 PR，不追加文档提交。
