# FLY-2753 本机定向测试守则 — 调研
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: exploration.md

## 本仓审计

| 来源 | 实际证据 | 设计意义 |
| --- | --- | --- |
| `CLAUDE.md`、产品体验规范、架构/参考文档 | runner 隔离执行，减少 founder 注意力负担 | 避免重复计算，不新增审批或调度层 |
| `.flywheel/agents/engineering/engineer-executor.md:25` | 本机 `pnpm -r build` + `pnpm test:packages:run` | 旧版问题真实存在，但非题目要求的现代三文件 |
| `.flywheel/agents/engineering/qa-executor.md:26` | QA 引用全量包测试 | 旧版独立验证也会重复执行 |
| `.github/workflows/ci.yml:65` | CI 运行全量 package suite | 远端已有全量执行；此 sandbox 非题目所述现代 16-job 布局 |
| `.flywheel/agents/general-executor.md` | general 摘要也写 full-repo | 披露已有相邻条款；本单不顺手改 |

## 现代目标布局：仅只读参考，不能混同本仓

参考工作树初始读取 HEAD `3d67d8350`。下列路径均相对该工作树。其 FLY-2753 文档已记录实现，但本节点不继承它的测试结论、评审或 CI 结论。

- `.flywheel/agents/nodes/{implement,qa,engineer}.md`：本地验证属于 domain body。三份已使用同一选择规则，QA 的红 job 动作是 FAIL/交回作者。
- `packages/teamlead/phase-protocols/{implement,qa}.md`：跨项目阶段协议；实现阶段通常不发 full CI 请求，QA 对冻结头使用 `ci-full ensure`。保留阶段分工，不把 Flywheel 专属 pnpm 命令塞进平台协议。
- `scripts/sync-phase-protocols.mjs`：9 个 managed block 投影；engineer 不在映射中。先校验所有标记/来源再写，`--check` 不修复文件。故“三份语义一致”和“9 个投影同步”是两项不同检查。
- `packages/teamlead/package.json`：prebuild 已运行同步脚本 `--check`。修改 domain body 不应改变 canonical 或 managed blocks；正常只检查即可，不必编辑生成器。
- `scripts/__tests__/package-gate.test.mjs`：直接遍历三份手册的新合同断言；旧版 receipt 断言必须随条款修改。
- `scripts/__tests__/fly2121-node-contract-and-setup.test.sh`：implement 的 build/test 文字合同。
- `packages/edge-worker/src/__tests__/Blueprint.generalized-workflow.test.ts` 与 `fixtures/fly2533-phase-baseline.json`：直接锁定 domain 文本及 prompt（发给模型的实际指令文本）长度。修改须保存真实改前基线，不能抬预算掩盖增长。
- `scripts/__tests__/fly2533-phase-protocol-assets.test.sh`：投影/打包资产护栏。无 canonical 修改时运行同步 check 足以验证该不变边界；若改动触及生成器/资产，补跑此测试。

## 本地选择规则的可执行含义

先记录比较的 base/head，以 `git diff --name-status <base>...HEAD` 枚举改动，重命名/删除也追踪旧路径。确认最近 package.json 的包名。搜索完整相对路径、文件名、父目录及实际导入/重导出关系；以 `git grep -lF` 搜索只是线索，动态拼接引用还要读测试装载逻辑。记录命中与排除理由。

包内直接覆盖变动行为的测试，加上其他包/脚本直接消费变动的测试，都要运行。TypeScript 可用所属包的 `vitest related <files> --run` 辅助发现；零命中不自动证明无需测试。删除、动态加载或重导出需要显式指定测试文件。每个新增 `scripts/__tests__/*.test.sh` 照跑。

构建示例 `pnpm --filter "<pkg>..." build` 包括必要依赖；受影响包有 typecheck 脚本则运行，接口/类型变化再选下游 `pnpm --filter "...<pkg>" typecheck`。没有包代码变更时，说明 build/typecheck 不适用原因，不靠全仓构建补缺。

## 数据、身份与迁移

不新增数据库、API、环境开关、收据 schema、状态枚举或 phase 标识。`implement` / `qa` / `engineer` 是稳定 role 标识，不改名；“本机定向验证”是展示标签。`PACKAGE_GATE_RECEIPT` 只从手册的强制本机要求中移除，底层 CI/诊断消费者不删。

新守则在后续正常指令装载时生效，已有冻结的运行快照不原地改写；不重启 runner。回滚为经审核的同范围提交回退，并重新生成/检查真正变化的投影；merge 与部署仍分离，独立 updater 负责部署。

## 研究边界

无需外部产品/API 研究：判断依据是当前本地源码和只读指定参考。没有访问密钥、生产数据库或写入参考工作树。现有 CI 配置存在不等于本分支 CI 已通过。基线差异必须获得明确处置，不能用缺文件导致的空 grep 宣称通过。
