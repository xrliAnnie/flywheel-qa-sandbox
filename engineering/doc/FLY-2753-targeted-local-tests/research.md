# FLY-2753 本机定向验证 — 调研
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: exploration.md

## 当前仓库的权威证据

| 源/消费者 | 实测 | 决策 |
|---|---|---|
| `.flywheel/config.yaml:49–84` | engineer/qa/general 的 agent_file 指向三份 executor 文件 | 以这些实际入口作为当前实现清单 |
| `engineering/engineer-executor.md:25` | 要求全仓 build + `test:packages:run`，description 有 full-repo gates | 改验证段与对应描述，保留其他条款 |
| `engineering/qa-executor.md:26` | 本机全量测试命令 | 改为相同定向规则，保留真实产品验证 |
| `general-executor.md:13` | 转指 engineer 时重申全仓 build/test | 改转指说明并纳入同一验证规则 |
| `packages/qa-framework/agents/qa-parallel-executor.md:20,155` | `pnpm test` 工具例及一键 pre-ship helper 推荐 | 只修相关验证文字，取消 runner 完成门调用全量 helper 的推荐 |
| `scripts/pre-ship-check.sh:38–48` | 本机 build/typecheck/lint/全量包测试 | 工具逻辑本单不改；上游规则明确禁止用它满足本机完成门 |
| `.claude/skills/flywheel-{git-workflow,tdd,context}/SKILL.md` | 本工作树生成且未跟踪的技能文件有 root pnpm test 示例 | 不编辑生成物；生效守则明确覆盖这些较宽默认命令 |
| `packages/edge-worker/src/skill-templates/{flywheel-git-workflow,flywheel-tdd,flywheel-context}.ts` | 上述技能的跨项目模板源 | 不改变全项目默认技能；本项目验证规则覆盖，按表给出豁免，不暗称全仓已零残留 |
| `.github/workflows/ci.yml` | `Build & Test` 执行全量包测试；另有 payload-distribution job | 全量证据使用该 head 完整任务集合，不只看一个 job |
| `package.json` | root pnpm test = `pnpm -r test`，build/typecheck 也是递归 | 守则禁用通过别名间接运行全量 |

本仓不存在 `CI OK`、`CI Scope OK`、`ci-full ensure`、nodes 目录、phase-protocols 或同步器。它们不能成为本仓唯一通过条件。

## 生产源对照（只读，不是本分支成果）

生产 `3d67d8350` 的 `.flywheel/agents/nodes/{implement,qa,engineer}.md` 已有定向规则，但没有把零匹配/缺脚本守卫完整写进最终规则原文。`scripts/sync-phase-protocols.mjs` 同步五种 canonical 文本至九个角色块；验证段位于块外。生产 prebuild 保留 `--check`。一次只读检查返回 `phase protocols: 9 projections checked`，不可当作本仓或 CI 通过。

如果后继获授权的是生产目标：按实际路由扩展同一规则核查，保留 `ci-full ensure` 的冻结头所有权、`CI OK` 完整证据与 `CI Scope OK` 不足以证明全量的区别。只有该目标才执行同步脚本。不得把整个节点体系复制到 sandbox。

## 定向选择与防假绿

1. 从 PR base/head diff 列出文件，读所属 package.json 获取真实包名及 scripts。根文档/脚本无需虚构所属包。
2. 同包直接覆盖测试 + 直接消费方测试。按 import specifier（代码中实际导入的路径/包名）搜索相关源码和测试目录；不对 `index.ts`、`types.ts`、裸父目录做全仓无界搜索。记录选择依据与边界排除即可。
3. TypeScript 可用所在包 `vitest related <files> --run` 辅助；跨包依赖和非导入式脚本引用另列显式测试。related 零收集不能自动通过。
4. 实际选中包名、每个要求脚本的存在性、执行结果、收集/通过数必须有记录。`--fail-if-no-match` 防零匹配，但不能替代逐包 scripts 检查。缺少 script 时使用已存在的项目等价检查；没有等价检查则报未验证。
5. 纯规则变更运行合同验证，明确无编译产物变化，因此 build/typecheck 不适用。新增 shell 测试必须运行。不能以“文档”为由省掉合同验证。

已实测 `pnpm --filter "no-such-pkg-fly2753..." --fail-if-no-match list --depth -1 --json` exit 1。评审提供的 pnpm 默认零匹配/缺 script 仍 exit 0 与脚本结构一致，因此守卫必须进入最终角色文字。

## 身份、持久化与回退

无稳定 ID、显示标签、数据库/API 或凭据变更。执行身份、阶段、审批与部署边界全部保留。PACKAGE_GATE_RECEIPT 在本仓目标文件不存在；若其他授权目标出现，只删除本机完成门的例外条款，不删除 CI 回执工具。

回退只恢复本单验证文字及合同测试；如果实际改过生产 canonical/投影则成对回退并重跑同步检查。不改配置路由、不重启服务、不撤销其他提交。

## 重新派发的现状复核

2026-09-20 本轮从 `6b987d1b1` / PR #206 继续，当前配置仍路由 engineer、qa、general 三份 executor。实现已在保留分支上完成；本阶段只复核、更新设计交付，不改守则或实现。生产源只读 HEAD 仍为 `3d67d8350`，三份 nodes 具有定向规则；`packages/teamlead/package.json` 的 prebuild 保留同步 `--check`。生产同步器不在当前仓库，原题的生产验收仍是必需范围，不能因 sandbox 通过而豁免。新问题 `7889b4bc-48fa-48ae-99eb-e10bae2e7981` 请求 Lead 明确目标安排。
