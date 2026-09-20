# FLY-2753 本机定向测试守则 — 实施计划
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: research.md

**Goal:** implement / qa / engineer 本机仅运行 lint、受影响包 build/typecheck 和直接相关测试；完整包套件只由最终提交的 full exact-head CI 证明。

**Architecture:** 修改三份 domain 守则的既有验证段和直接依赖其文字的合同测试。复用现有 canonical phase protocols 与同步器，不新增测试调度、收据类型或运行时逻辑。

**执行方式:** 后继实现节点按注入 TURN 和本计划逐项执行；可使用 superpowers:executing-plans。设计节点不实施、不派发后继。Tech stack 为 Markdown、Node/Bash 合同测试、Vitest、pnpm。

## 0. 基线准入：先证明任务文件真实存在

当前设计分支是 sandbox `1855f7a1a` 的后代，任务指定现代文件缺失；参考工作树 `3d67d8350` 已有本单实现。Lead question `7f5f22f8-74f5-4e9a-ad6f-2fb736347237` 尚待回答。本方案不授权移植整套工作流基础设施或写另一个工作树。

- [ ] 实现节点取得自身 TURN，读 inbox，记录 remote、HEAD、未提交改动和 Lead 的基线处置。
- [ ] 验证三份 node、同步脚本、teamlead phase protocols、下列测试/fixture 存在。缺失必须报告真实 prerequisite；禁止创建空文件/空 checker 让验收绿。Lead 若选择旧 sandbox 适配，先追加 design-correction 并重新审核范围，不能只改两个旧文件后宣称完成原始目标。
- [ ] 对已具备现代布局的获准分支重审当前差异。若现有条款已实现目标，只做缺口修复与本分支独立验证；不得复制参考分支的 PASS。

```bash
git remote -v
git status --short
git rev-parse HEAD
for f in .flywheel/agents/nodes/implement.md .flywheel/agents/nodes/qa.md .flywheel/agents/nodes/engineer.md scripts/sync-phase-protocols.mjs; do
  test -s "$f" || exit 1
done
node scripts/sync-phase-protocols.mjs --check
```

Expected: 文件存在且投影基线一致。当前 sandbox 在文件存在性检查应失败；这是已披露的基线差异，不是实现 PASS。

## 1. 文件清单与限制

| 路径 | 最小变动 |
| --- | --- |
| `.flywheel/agents/nodes/implement.md` | 第 6 步验证条款；description 中 full-repo → targeted local |
| `.flywheel/agents/nodes/qa.md` | 第 3 步验证条款，保留真实行为验证；红 CI → FAIL/交回作者 |
| `.flywheel/agents/nodes/engineer.md` | self-verify 条款；description 中 full-repo → targeted local |
| `scripts/__tests__/package-gate.test.mjs` | 三角色手册正/负合同断言，不动 package-gate 引擎测试 |
| `scripts/__tests__/fly2121-node-contract-and-setup.test.sh` | 替换全仓 build/全量 test 的旧正断言 |
| `packages/edge-worker/src/__tests__/fixtures/fly2533-phase-baseline.json` | 仅 implement/qa 的实际改前 prompt anchor 与逐项迁移记录 |
| 同文件夹 `implementation.md` | 实现者记录本分支 RED/GREEN、选择依据与结果 |
| `engineering/doc/milestones/FLY-2753.md` | 按后继注入协议作最后里程碑提交 |

保留 `packages/teamlead/phase-protocols/*`、所有 managed blocks、`scripts/sync-phase-protocols.mjs`、prebuild、CI workflow、package-gate 执行器与现有身份/权限。三份 domain 语义一致由合同测试证明；9 个 managed projections 一致由同步 check 证明。没有发生 managed block 改动时不强行运行 --write 产生无关 diff。

## 2. RED：先修改直接合同测试

- [ ] 先阅读这两个测试当前断言。若仍锁定旧要求，替换为下列新规则，再运行得出仅因旧手册不满足新合同的失败；若已是新规则，不制造虚假 RED。
- [ ] `package-gate.test.mjs` 保留其他测试，用以下用例检查三角色：

```js
test("active runner handbooks require targeted local verification and CI-owned full evidence", () => {
  for (const name of ["implement", "engineer", "qa"]) {
    const text = readFileSync(new URL(`../../.flywheel/agents/nodes/${name}.md`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /pnpm test:packages:run|PACKAGE_GATE_RECEIPT|onTaskUpdate/, name);
    for (const required of ["pnpm lint", "affected package", 'pnpm --filter "<pkg>..." build',
      "typecheck", "owning package", "directly depend", "git grep -lF",
      "full path, file name, and parent directory", "document every excluded match",
      "vitest related", "scripts/__tests__/*.test.sh", "no local full package suite",
      "full exact-head CI", "CI OK", "CI Scope OK", "skill defaults"]) {
      assert.ok(text.includes(required), `${name}: ${required}`);
    }
    assert.match(text, /red .*CI job/i, name);
    if (name === "qa") assert.match(text, /FAIL.*author/s, name);
  }
});
```

- [ ] FLY-2121 保留 lint 断言，将旧 build/test 的两行改成：

```bash
assert_contains 'pnpm --filter "<pkg>..." build' 'implement scopes build to affected packages and dependencies'
assert_contains 'no local full package suite' 'implement delegates full package evidence to CI'
```

- [ ] 运行 `node --test scripts/__tests__/package-gate.test.mjs` 和 `bash scripts/__tests__/fly2121-node-contract-and-setup.test.sh`。先满足其真实 dist 前提；只按其依赖构建 `pnpm --filter "flywheel-edge-worker..." build`。失败必须是预期文本合同，不将缺依赖当 RED。
- [ ] 提交测试锚点，记录改动前 node 文件与提交 SHA。每步只暂存本单文件。

## 3. GREEN：三份手册复用同一验证规则

以下英文核心段放进三份既有验证行；只调整角色尾部动作，保留原有真实行为、review、PR 和 gate 条款。

> **Local targeted verification** — This rule overrides skill defaults that call full-repo build/tests. Run `pnpm lint`; build the affected package plus dependencies with `pnpm --filter "<pkg>..." build`; run available typechecks for affected packages, and when exports, APIs, or types change, typecheck dependents with `pnpm --filter "...<pkg>" typecheck`. Select targeted tests from changed files' owning package and test files that directly depend on those changes. Discover consumers with `git grep -lF` using each changed file's full path, file name, and parent directory; document every excluded match. For changed TypeScript, also run the owning package's `vitest related <files> --run`; explicitly cover deleted files, dynamic imports, and re-exports when related-test discovery cannot resolve them. Run all retained matches and every new `scripts/__tests__/*.test.sh`. There is no local full package suite. Only frozen-head full exact-head CI with `CI OK` is full-suite evidence; `CI Scope OK` is not.

- [ ] implement / engineer 尾部：“Fix every red current-HEAD CI job that ran and disclose local and CI evidence in the PR.” 保留原 review 方式及反 raw exec 条款。
- [ ] qa 尾部：“Any red current-HEAD CI job means FAIL; hand the failure to the author and verify the corrected head.” QA 不修产品代码；保留真实 E2E 条款。
- [ ] description 只改两处 full-repo 措辞；删除原条款内本机 `PACKAGE_GATE_RECEIPT` / RPC 超时豁免，不删除底层诊断能力。
- [ ] 再运行上节两项测试，要求 exit 0。审查 diff 证明没有改无关职责或条款。提交最小守则变更。

## 4. 直接 prompt 消费者与预算

- [ ] 执行 `pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/Blueprint.generalized-workflow.test.ts -t FLY-2533`。若出现 domain fixture 不匹配，保存该失败；没有变化则不编辑 fixture。
- [ ] fixture 的 implement/qa `baselineRevision` 用第 2 节真实改前 SHA；`baseline` 为该 SHA 实际 composed prompt（protocol + 分隔符 + old domain），不以新文本回填旧基线。
- [ ] 仅这两个 entry 的 `platformMigration` 逐项记录旧验证行→新验证行、implement description 改词；按照现有 fixture 格式保留其他角色、全局 revision 与已有兼容规则。
- [ ] `rebaseNote` 记录 UTF-16/UTF-8 的 before/after 字符数及增长比。保持原 10% 上限；若新增条款超过预算，压缩本单措辞后重测，不能抬上限。
- [ ] 同一 FLY-2533 定向测试通过后提交 fixture 与证据；运行完整直接消费者文件仅在未覆盖的受影响用例存在时补充。

## 5. 本单实现的本机验收

按新规记录 base/head、命令、exit code、测试数与日志路径，区分设计阶段检查和实现阶段检查。

```bash
pnpm lint
pnpm --filter "flywheel-edge-worker..." build
pnpm --filter flywheel-edge-worker typecheck
node --test scripts/__tests__/package-gate.test.mjs
bash scripts/__tests__/fly2121-node-contract-and-setup.test.sh
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/Blueprint.generalized-workflow.test.ts -t FLY-2533
node scripts/sync-phase-protocols.mjs --check
```

Expected: exit 0；同步器报告 9 projections checked。这不是本机全量包测试。

- [ ] 先 `test -s` 三份 node，防止 grep 对缺文件假成功。负检查 `rg -n 'pnpm test:packages:run|PACKAGE_GATE_RECEIPT|onTaskUpdate' .flywheel/agents/nodes/{implement,qa,engineer}.md` 应 exit 1（零匹配）；exit 2 是命令错误，不能当通过。
- [ ] 正检查每份都有本机 lint、受影响 build/typecheck、owning-package/direct-consumer/new-shell 选择规则、no local full suite、full exact-head CI、红 job 处置；以上合同测试逐份断言而不是仅检查总命中数。
- [ ] 搜索每个改动文件的全路径/文件名/父目录与旧规则关键词。保留上述直接消费者；任何新增直接命中补入测试清单。文档/路径注册等非测试命中逐项解释排除理由。
- [ ] 所有新增 `scripts/__tests__/*.test.sh` 必跑；本方案只修改现有脚本，没有新 shell 测试文件。API/类型未改，不扩大为所有下游测试。
- [ ] managed block 不变时 `--check` 是同步证明；若出现漂移先定位是否既有或本单造成，不能静默 --write 冲掉他人改动。真实需要 canonical 修改则作为设计纠正处理。

## 6. CI、评审与交接

- [ ] 后继按自身注入协议获取有效 code review、提交/push/创建 PR，记录当前提交标识与本机证据。里程碑/进度提交须在最终头冻结之前完成。
- [ ] 实现阶段仅观察当前 HEAD 实际运行的 CI；任何红 job 都处理，不能用“本机定向绿”抵消；基础设施问题如实报告，仍不可宣称 CI 绿。
- [ ] 完整 CI 由拥有冻结头职责的 QA 发起，保持现有 `ci-full ensure` 合同：exit 8 为处理中，继续独立 QA；最终 PASS 前同一 HEAD 必须 exit 0；exit 1/2 按真实错误处置。普通实现头不能擅自请求 full CI。
- [ ] 完整证据包含 PR URL、最终 SHA、CI run URL/模式、全部应运行 job 与结论；`CI Scope OK`、祖先绿、缺失/取消/跳过所需 job 都不是全量 PASS。
- [ ] 后续任何提交使最终 SHA 改变，都必须重新确认当前 head 的证据。完成仅使用后继自己的注入 receipt/route，本计划不预造 execution/activation 身份。

## 7. 边界、回滚与验收映射

无数据库/接口变动；无需数据迁移、凭据、新状态或参数校验器。报告的派生文字全部 HTML escape，交互只用 textContent/value。已有 runner 冻结快照不改写，不重启服务；正常 merge 与 updater 部署仍分离。回滚只回退本单条款/合同/fixture 对应提交，重新验证投影，不回退其他分支工作。

| 用户要求 | 对应步骤与证据 |
| --- | --- |
| 本机 lint + affected build/typecheck + 定向/新增 shell | §3 精确条款，§2 合同，§5 本分支真实命令 |
| 去除 receipt 本机全量要求，保留红 job 处置 | §2 负断言、§3 角色动作、§6 CI evidence |
| 三份一致、投影/prebuild check 绿 | §0 文件存在性、§1 边界、§5 合同 + 9 投影检查 |
| 本单遵循新规，全量看 CI | §5 禁止本机全量；§6 冻结头 full CI 证据 |
| 不顺手改其他条款 | §1 修改白名单、diff 审查、保持 CI/平台协议/身份 |

本设计不声称解决宿主所有慢测试问题，也不承诺节省固定时间。当前设计产物已能评审；实现准入仍取决于真实基线处置，不能把这项限制隐去。
