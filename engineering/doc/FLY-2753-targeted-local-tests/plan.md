# FLY-2753 本机定向验证 — 实施计划
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: research.md

## 目标与当前可执行范围

本机 = 全仓 lint + 受影响包 build/typecheck + 直接相关测试；全量 = exact-head CI；任一当前提交 job 红即处理。以下计划针对当前获授权 sandbox 的真实路由，可执行，不再以缺失生产节点作为实施前置。生产节点/投影的原题验收仍列为单独目标差异，不冒称在 sandbox 满足。

## 0. 确认真实入口与文件存在（实现持 TURN）

- [ ] 读取 `.flywheel/config.yaml` 的 agent_file；确认 engineer/qa/general 路由仍与下列清单一致。
- [ ] 逐文件查版本化存在性；缺文件是失败，不能把 `git ls-files` exit 0 当存在证明。
- [ ] 检查 Lead 对 `70231531-d5e3-4be0-ba98-0b1eb23397ad` 的答复；无答复按本授权仓真实入口执行，若指定其他目标先获取对应 TURN。

```sh
set -eu
for file in .flywheel/config.yaml .flywheel/agents/engineering/engineer-executor.md .flywheel/agents/engineering/qa-executor.md .flywheel/agents/general-executor.md packages/qa-framework/agents/qa-parallel-executor.md; do
  git cat-file -e "HEAD:$file"
  test -f "$file"
done
rg -n 'agent_file:' .flywheel/config.yaml
```

预期五个文件均存在，路由人工核对一致；任一缺失 exit 非零。实施不得修改路由以满足此检查。

## 1. 只修验证条款

| 文件 | 具体动作 |
|---|---|
| `.flywheel/agents/engineering/engineer-executor.md` | 第 5 步换成下述完整规则；description 的 full-repo gates 改为 targeted local verification |
| `.flywheel/agents/engineering/qa-executor.md` | 第 3 步保留真实行为验证，追加完整规则和 QA 红灯职责 |
| `.flywheel/agents/general-executor.md` | 第 13 行去掉全仓 build/test 门重述；保留工程角色路由，追加完整规则 |
| `packages/qa-framework/agents/qa-parallel-executor.md` | 工具示例改成包内显式测试；第 155 行一键 helper 推荐改成“按工程角色定向验证规则执行，不调用 pre-ship-check 作为本机完成门”；保留 E2E/隔离/权限条款 |
| `scripts/__tests__/fly2753-targeted-verification-contract.test.sh` | 新增最小角色合同测试，覆盖上面真实入口，先 RED 后 GREEN |

### 必须实际进入三份守则的规则原文

> **Local targeted verification** — Run `pnpm lint`. Before any filtered command, read package.json and record the actual selected package names and required scripts. Use `pnpm --filter "<pkg>..." --fail-if-no-match build` for affected packages and necessary build dependencies; when exports, APIs or types change, typecheck affected direct dependents with `pnpm --filter "...<pkg>" --fail-if-no-match typecheck`. Check every selected package for the required script; use its documented equivalent if absent and record the result. Select tests that cover changed files in their owning package plus test files in direct consumers. Bound import/reference searches to relevant source and test directories; record selected tests and material exclusions, not every incidental documentation match. For changed TypeScript, use the owning package's `vitest related <files> --run` where supported, plus explicit direct-consumer tests. Run every new `scripts/__tests__/*.test.sh`. Record actual collected/passed test counts. Zero selected packages, missing required scripts without a verified equivalent, zero collected tests, skipped or unreached checks are NOT a pass even with exit 0. For a documentation-only change, identify affected contract checks and explicitly justify build/typecheck as not applicable. Do not run the full package suite locally, including via root `pnpm test`, recursive build/test commands, or `scripts/pre-ship-check.sh`; this rule overrides broader skill/helper defaults. Full-suite evidence comes only from the complete CI job set for the exact reviewed commit. Missing, pending, cancelled or skipped required jobs are not green; a green subset or an older commit is insufficient. Record the commit, run URL and all job results. Every red current-HEAD CI job must be handled.

作者角色结尾：`Fix failures and disclose local and CI evidence in the PR.` QA 结尾：`Any red current-HEAD CI job means FAIL; report it to the author rather than changing product code.` 保留所有原有评审、报告、产品验证、审批和部署语义。

## 2. TDD 与精确验证

- [ ] 新增下述 shell 合同测试；旧守则运行应失败，记录具体失败项。该测试不执行任何包套件。
- [ ] 按 §1 修改角色文字，再运行同一测试，应通过。
- [ ] 负例验证：仅在临时文件副本中分别放回全量条款、删除零测试守卫、把 direct-consumer 选择删掉；这些变异必须被同一断言拒绝。不要临时改共享规则或实际启动全量测试。
- [ ] 运行所有本单新增 shell 测试、`pnpm lint`、`git diff --check`；查看最终 diff，无无关条款修改。纯文字/合同检查不涉及编译资产，build/typecheck 明确记 N/A；若实际补代码，则按规则做定向构建。

建议 shell 合同主体（可抽函数用于临时文本负例，不新增测试选择运行时）：

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
files=(.flywheel/agents/engineering/engineer-executor.md .flywheel/agents/engineering/qa-executor.md .flywheel/agents/general-executor.md)
for file in "${files[@]}"; do
  test -s "$file"
  for required in 'pnpm lint' '--fail-if-no-match' 'actual selected package names' 'Check every selected package' 'direct consumers' 'scripts/__tests__/*.test.sh' 'Zero selected packages' 'zero collected tests' 'NOT a pass' 'complete CI job set' 'exact reviewed commit' 'Every red current-HEAD CI job'; do
    grep -Fq -- "$required" "$file"
  done
  if grep -Eq 'pnpm test:packages:run|PACKAGE_GATE_RECEIPT|pnpm -r build|Self-verify — FULL REPO' "$file"; then
    printf '%s\n' "obsolete local gate in $file" >&2
    exit 1
  fi
done
grep -Fq 'targeted local verification' .flywheel/agents/engineering/engineer-executor.md
grep -Fq 'FAIL' .flywheel/agents/engineering/qa-executor.md
if grep -Fq '**一键检查**' packages/qa-framework/agents/qa-parallel-executor.md; then exit 1; fi
printf '%s\n' 'FLY-2753 active-role verification contract PASS (3 roles plus helper entry)'
```

```sh
bash scripts/__tests__/fly2753-targeted-verification-contract.test.sh
pnpm lint
git diff --check
```

不能只看 exit 0：确认脚本实际检查三份存在文件及 helper 入口。新增 shell 测试不需要 root 包测试才能执行。

## 3. 入口残留逐项判定

| 路径/规则 | 本单处置 | 原因/验证 |
|---|---|---|
| 三份 active executor | 改写全量完成门及矛盾描述 | grep + 合同测试 + 人工语义核对 |
| QA parallel 的 helper 推荐 | 改写，禁止作为本机完成门 | 合同测试验证旧推荐消失，diff 确认 E2E 条款保留 |
| `scripts/pre-ship-check.sh` | 显式豁免工具实现，取消 runner 调用义务 | 三份新规则直接点名不能间接调用；不改工具/其他手工用途 |
| `.claude/skills/flywheel-*` 生成技能 | 不编辑；角色规则显式覆盖 root pnpm test 和递归 build/test | 生成物未跟踪，不把覆盖说成源字符串清零 |
| `packages/edge-worker/src/skill-templates/` | 不改跨项目默认模板 | 本项目 active 角色优先，避免顺手扩到所有项目 |
| CI YAML、root 包脚本 | 保留全量命令 | 完整测试仍由 CI 运行，不删除工具能力 |
| 原题 nodes/projection | 只有对应目标存在才核查 | 见 §5，缺机制不能标绿 |

搜索限制在上述入口及其直接消费者，避免全仓短文件名匹配。`rg` 零命中为 exit 1；exit 2 是路径/执行错误，不是通过。

## 4. 本单 PR 的 exact-head CI 证据

当前仓无 `CI OK` 或 `ci-full ensure`；使用已有 workflow 的实际完整任务集合：`.github/workflows/ci.yml` 的 `Build & Test`（含 `pnpm test:packages:run`）和 `FLY-1062 payload distribution (endpoint + release pipeline)`，以及最终 head 触发的其他必需检查。

- [ ] 作者记录本机定向证据，走注入代码评审/PR 流程；不得自行派发 QA、请求越权 ship 或合并。
- [ ] QA 取得 PR 当前 head，与 `git rev-parse HEAD` 对齐，查询对应运行与所有 jobs。提交、运行链接、全量测试 step 和每个任务结果都进入报告。
- [ ] 仅在全部 required jobs 完成且成功时记完整证据。pending/cancelled/skipped/missing 不算绿；任何红灯交作者处理/报告 Lead，不因“无关”放过。head 改变就重新核对证据。

```sh
gh pr view <PR_NUMBER> --json headRefOid,statusCheckRollup
gh run list --commit <HEAD_SHA> --workflow ci.yml --json databaseId,headSha,status,conclusion,url
gh run view <RUN_ID> --json headSha,status,conclusion,jobs,url
```

必须核对实际输出数量、headSha、完整任务集合与 tests step，不仅检查命令退出码。`<PR_NUMBER>`、`<HEAD_SHA>`、`<RUN_ID>` 来自真实 PR/运行结果，不写死旧头。没有完整证据时不得 QA PASS。此设计阶段不创建 PR、不获取 ship 权限。

## 5. 原题生产三份守则及投影义务（不得冒称完成）

当前仓的路由修正只证明当前部署目标，不能替代原题点名的 nodes/同步检查。Lead 若确认实施目标也包括生产源，后继在该目标的授权 TURN 下：

1. 核对路由与 `.flywheel/agents/nodes/{implement,qa,engineer}.md`；把相同守卫直接写入最终规则，保留各角色职责。生产已落地部分只补差异。
2. 对 `packages/teamlead/phase-protocols/` 及 `scripts/sync-phase-protocols.mjs` 查验证规则是否在 managed block 内；本次观察位于块外，不改同步器。实际改 canonical 才 `--write`，所有情况下运行 `--check`。保留 prebuild 的 `--check`。
3. 执行既有 `package-gate.test.mjs` 中 active runner handbooks 命名测试；若规则措辞变化，只调整相应合同断言，不重跑全量。必要的协议改动再运行相关资产测试。
4. 保留生产冻结头 CI 协议：QA 用已有 `ci-full ensure`，必须相同 head exit 0；`CI Scope OK` 不足以证明全量；核对完整 `CI OK` 的来源与全部任务。
5. 报告该授权目标的 grep、自身定向证据、投影检查和最终 CI。没有被授予该目标或文件缺失，记录未覆盖并交 Lead，不能写“原题所有投影已绿”。

不在 sandbox 新建缺失的生产机制，不移植整个分支，不修改其他任务成果。Lead 问题 pending 不阻止当前实际路由的限定修改；issue 级完整验收要明确两种目标的边界。

## 6. 验收/回退

| 要求 | 当前仓证据 | 生产目标证据（若纳入） |
|---|---|---|
| 生效角色本机不再全量 | config 路由核对 + 三份合同测试 | nodes 三份存在 + grep/合同测试 |
| 选择规则/零匹配/缺脚本/零收集守卫 | 守则原文必须包含，不能只留计划旁注 | 同义条款与测试 |
| shell 测试照跑、CI 红即处理 | 本单 shell 结果 + 角色职责句 | 相同 |
| 所有投影一致 | 本仓无该机制，明确 N/A，不声称通过 | sync --check exit 0，prebuild 未削弱 |
| 本单按新规则 | lint + 定向合同结果 + exact-head CI 全套 | 同目标对应证据 |
| 没有顺手改其他条款 | 仅 §1 文件验证段/必要合同检查 | 同样最小 diff |

无数据库/身份/接口迁移。回退只还原本单验证段与测试；生产实际改过的 canonical/投影一起恢复并检查；不重启服务、不回滚别人的提交、不改变既有审批和 updater 部署边界。
