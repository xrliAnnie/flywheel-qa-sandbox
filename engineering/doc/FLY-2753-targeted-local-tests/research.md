# FLY-2753 本机定向测试守则 — 调研
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: exploration.md

## 当前源码证据

基线为本仓 `1855f7a1a`；设计提交不改变下列产品文件。

| 文件 | 精确证据 | 处理 |
| --- | --- | --- |
| `.flywheel/agents/engineering/engineer-executor.md:25` | `Self-verify — FULL REPO, not just changed files`；`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 新 shell tests | 替换整条验证规则，保留其他 work loop |
| `.flywheel/agents/engineering/qa-executor.md:26` | `the package's own tests where relevant: pnpm test:packages:run` | 移除全量引用，保留真实行为验证 |
| `.flywheel/agents/general-executor.md:13` | engineer 引用后有 `TDD, full-repo pnpm lint + pnpm -r build + tests` | 只换该括号里的验证摘要并投影同一规则 |
| `.flywheel/config.yaml:50,55,84` | 指向上述真实角色路径 | 不改 routing/identity |
| `packages/teamlead/package.json` | 有 build/typecheck/test:run，无 prebuild | 新增同步 --check 前置，不改 build 命令 |
| `.github/workflows/ci.yml` | Build & Test 运行 `pnpm build`、typecheck、lint、`pnpm test:packages:run`；另有 payload-distribution | 现有 CI 已覆盖 teamlead 包测试；不新增 workflow |
| `packages/teamlead/vitest.config.ts` | 默认 Vitest 发现 src 内测试，使用隔离 CommDB setup | 新合同测试放同包，纳入现有 full CI |

本仓三个目标没有 PACKAGE_GATE_RECEIPT 或 onTaskUpdate 文本：不发明待删除条款。对 PACKAGE_GATE_RECEIPT 加禁止重新成为本机交卷要求的合同保护；不全文件禁止 onTaskUpdate 诊断术语。没有现代 prompt-budget fixture，因而不创建或重设那套 baseline。未来移植到具有既有 budget anchor 的分支必须保留累计基线，不通过改 anchor 绕过上限。

## 消费者审计

- 角色加载来自 `.flywheel/config.yaml`；直接 dispatch 验证为 `packages/edge-worker/src/__tests__/AgentDispatcher.test.ts`，其中既有 engineer/qa/general 路径断言。定向运行本文件，证明 routing 未变。
- `scripts/__tests__/test-pm-executor-contract.sh` 检查 PM 而非三份验证段，排除且不修改。
- `scripts/package-onboard-files.allow` 的 `agents/qa-executor.md` 是 shipped-generic 资产，不是本仓 `.flywheel/agents/engineering/qa-executor.md`。本单不改全局通用 prompt。
- 新 `packages/teamlead/src/__tests__/local-verification-policy.test.ts` 直接消费 canonical、三个投影、同步器与 prebuild，因此全部用例本机定向运行。
- 新同步器以自身位置推导仓库根目录，不依赖进程 cwd；固定三个受管路径，不接受任意文件路径或外部输入。先验证全部输入再写任何文件。

## 定向测试如何选

记录 diff base/head，包含删除/重命名旧路径。按文件最近的 package.json 确定包，检查包内直接覆盖变更行为的测试及跨包/脚本直接消费者。以完整相对路径、文件名、父目录进行 `git grep -lF`，再读实际装载/导入/重导出逻辑；零搜索命中不等于无测试。每个排除命中写理由。

TypeScript 使用所属包的 `vitest related <files> --run` 辅助选择；删除/动态加载/重导出无法解析时显式选测试。每个新增 scripts/__tests__/*.test.sh 照跑。受影响包运行可用 typecheck；导出接口/类型变动再检查下游。构建仅 affected package 与必要依赖，不扩大为本机全仓 build/tests。

## 同步与状态模型

canonical 新文件为 `scripts/lib/local-verification-policy.md`，只承载共同验证段。三个角色均嵌入 `FLYWHEEL_LOCAL_VERIFICATION:BEGIN/END` managed block。角色红 job 动作在 block 后保留本地语义：工程师/通用实现修复，QA FAIL/交回作者。同步器对缺源、空源、非法标记、缺/多/逆序 marker、任意目标缺失或漂移 fail closed；check 不写，write 仅替换三个合法块且二次运行零 diff。

无数据库、新 API、凭据、环境开关或新角色。初次 migration 为作者手动替换旧验证句、插入明确标记，再 --write；同步器不猜测迁移。已有会话快照不修改、不重启服务。正常合并与独立 updater 部署分离。回滚应整体回退条款/同步器/source/prebuild/test 对应提交，避免留下引用不存在脚本的 prebuild。
