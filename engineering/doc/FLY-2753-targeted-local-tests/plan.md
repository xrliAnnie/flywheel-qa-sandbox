# FLY-2753 本机定向验证 — 实施计划
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: research.md

## 交付目标与执行边界

让 implement / qa / engineer 的本机要求一致：`pnpm lint` + 受影响包 build/typecheck + 直接相关定向测试；全量 = 当前冻结提交的 exact-head CI。移除角色条款中的本机全量命令与 PACKAGE_GATE_RECEIPT 例外，保留任一 CI 红灯必须处理。仅设计节点提交此计划；实施由 orchestrator 的后继节点持 TURN 执行。

## 0. 目标核对（必须先完成）

- [ ] 获取 TURN，读取 Lead 对 `70231531-d5e3-4be0-ba98-0b1eb23397ad` 的答复，确认获授权目标，不跨工作树写。
- [ ] 在授权目标检查下列全部文件存在；缺失即报告目标不匹配，不复制生产树、不发明同步器、不用缺失文件的 grep 返回值当验收成功。
- [ ] 复核 HEAD。生产只读源 `3d67d8350` 已有实现 `180bdaa3e`；如果目标包含该提交，执行差异核验，仅补缺口，不重做或 cherry-pick 整条生产分支。

```sh
git status --short
git rev-parse HEAD
git ls-files .flywheel/agents/nodes/implement.md .flywheel/agents/nodes/qa.md .flywheel/agents/nodes/engineer.md scripts/sync-phase-protocols.mjs packages/teamlead/phase-protocols/implement.md packages/teamlead/phase-protocols/qa.md
```

预期六个必需文件都有记录。当前 sandbox 不满足；这项前置不能视为已完成。

## 1. 最小变更面

| 文件 | 动作 |
|---|---|
| `.flywheel/agents/nodes/implement.md` | 只替换第 6 步验证规则及矛盾的描述文字；保留评审/PR/门要求 |
| `.flywheel/agents/nodes/engineer.md` | 只替换第 5 步与其描述里的 full-repo gates；不改其他条款 |
| `.flywheel/agents/nodes/qa.md` | 只替换第 3 步；保留产品验证、报告、作者修复职责 |
| `scripts/__tests__/package-gate.test.mjs` | 使用已有相关命名测试；仅当验收有缺口才补断言/负例 |
| canonical protocols / 同步脚本 / prebuild | 默认不改；运行既有同步检查；若授权目标确有旧强制文字，只修对应源并生成投影 |

### 三份规则共用语义（建议保留已落地原文）

> Local targeted verification — This rule overrides skill defaults that call full-repo build/tests. Run `pnpm lint`; build the affected package plus dependencies with `pnpm --filter "<pkg>..." build`; when exports, APIs, or types change, typecheck dependents with `pnpm --filter "...<pkg>" typecheck`. Select targeted tests from changed files' owning package and test files that directly depend on those changes. Discover consumers with `git grep -lF` using each changed file's full path, file name, and parent directory; document every excluded match. For changed TypeScript, also run the owning package's `vitest related <files> --run`; run all retained matches and every new `scripts/__tests__/*.test.sh`. There is no local full package suite. Only frozen-head full exact-head CI with `CI OK` is full-suite evidence; `CI Scope OK` is not.

`<pkg>` 必须替换成实际 package.json 中的名称；先确认选中包，不能零匹配假绿。不存在 typecheck script 时用项目已有等价类型验证方式并说明，不能静默跳过。纯文档/规则修改若无编译产物影响，记录 build/typecheck 不适用及理由；不要因此运行全仓 build。

实现/engineer 结尾：`Fix every red current-HEAD CI job that ran and disclose local and CI evidence in the PR.` 保留 implement 原有 code-review 句。

QA 结尾：`Any red current-HEAD CI job means FAIL; hand it to the author rather than fixing product code. Disclose local and CI evidence in the report.`

## 2. 回归验证与必要时修改

- [ ] 若旧文本仍在，先运行既有命名测试，确认因具体旧条款失败（RED）；如果规则已满足，应记录基线已绿，不伪造失败。
- [ ] 若测试不存在或漏掉验收项，只在其原有 Node 测试文件中添加最小合同断言，覆盖三角色、选取规则、全量归属和红灯职责。用旧条款的临时文本样例证明负例能抓住回退；不运行真实全量测试。
- [ ] 只修上表规定文字（GREEN）；查看 diff 保证无无关条款变化。
- [ ] 同步检查。若没改协议块，预期零投影差异；若改了 canonical，运行 `--write` 后再次检查全部投影。

定向命令（在含相应文件的授权目标执行）：

```sh
node --test --test-name-pattern='active runner handbooks require targeted local verification and CI-owned full evidence' scripts/__tests__/package-gate.test.mjs
node scripts/sync-phase-protocols.mjs --check
pnpm lint
```

预期命名测试至少 1 个实际通过，不能只看退出码；投影检查返回 9 projections checked（如后续合法新增映射，以脚本实际映射数核实）；lint exit 0。若修改脚本/协议资产，附加 `bash scripts/__tests__/fly2533-phase-protocol-assets.test.sh`，先检查其中打包步骤的依赖并只构建受影响包。每个新增 shell 测试必须执行。

## 3. grep 与差异核查

```sh
rg -n 'pnpm test:packages:run|PACKAGE_GATE_RECEIPT|onTaskUpdate|pnpm -r build' .flywheel/agents/nodes/implement.md .flywheel/agents/nodes/qa.md .flywheel/agents/nodes/engineer.md
rg -n 'pnpm lint|affected package|directly depend|scripts/__tests__|exact-head CI|CI Scope OK|red .*CI job' .flywheel/agents/nodes/implement.md .flywheel/agents/nodes/qa.md .flywheel/agents/nodes/engineer.md
git diff --check
git diff -- .flywheel/agents/nodes scripts/sync-phase-protocols.mjs packages/teamlead/phase-protocols packages/teamlead/package.json
```

第一条预期 exit 1 且没有错误输出；exit 2 是路径/执行错误，不能当作零命中。第二条必须人工核对每一份文件都有完整规则，不能拿总匹配数替代覆盖面。CI 和回执工具本身仍可出现全量命令，不做全仓字符串删除。

## 4. 本单 PR 与 CI 证据

- [ ] 报告本机实际命令、测试数量、选择/排除依据、build/typecheck 适用性、目标 head。此单不在本机跑 `pnpm test:packages:run` 或递归全仓 build。
- [ ] 按注入流程获得有效代码评审、提交/push/开 PR；不派发 QA，不自行 merge，不请求越权 ship。
- [ ] 普通/review 修改头只做已有范围 CI。QA 持 TURN 获取 reviewed head 后按现有协议运行 `node "$FLYWHEEL_COMM_CLI" ci-full ensure --pr <NUMBER> --head $(git rev-parse HEAD) --json`。
- [ ] exit 8 = 等待中，继续独立 QA，不标 PASS；exit 1/2 按输出恢复/上报；PASS 前再次确认相同 head 的 exit 0。核对是完整流程的 `CI OK`、任务集合与提交绑定，不接受只有 `CI Scope OK`、旧提交绿灯、缺失/跳过必需任务或本机回执。
- [ ] 任一当前 head job 红灯都必须处理，即使认为与本单无关也报告并交作者/Lead，不自行降为非阻塞。新提交后旧证据失效。保留现有冻结头、ship 和 updater 边界。

## 5. 验收矩阵

| 要求 | 必需证据 |
|---|---|
| 三份不再要求本机全量 | 文件存在 + grep 零命中 + 三份人工语义审阅 |
| lint + 定向 build/typecheck | 三份规则与实际命令记录或明确不适用依据 |
| 测试选取完整 | owning package/直接消费者映射、排除说明、新 shell 测试结果 |
| 回执要求移除但红灯不放行 | 三份无 PACKAGE_GATE_RECEIPT；作者修复 / QA FAIL 句保留 |
| 所有投影一致 | 授权目标运行 `sync-phase-protocols --check` exit 0；prebuild 未削弱 |
| 无其他条款修改 | 最终 diff 只含验证文字、必要定向测试和任务文档 |
| 本单按新规走 | 本机定向证据 + 最终 head 的全量 CI 记录；设计阶段不冒称已取得 |

## 回退及尚未完成的工作

规则变更没有数据迁移/新 API，不触碰任何凭据。回退只恢复本单验证段与相关测试，并重新同步实际改过的投影；回退不能授权绕过 CI 或上线。

当前交付是设计计划和创始人 HTML，不是实现验收。生产存在同 issue 实现只是调研证据；sandbox 的目标差异须先由 Lead 明确。后继节点必须把答复及实际完成证据写入本目录 progress/验证记录。
