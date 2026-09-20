# FLY-2753 本机定向测试守则 — 实施计划
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: research.md

**Goal:** 修复当前 sandbox 真实工程师、QA、通用实现入口的本机全量要求，保留 lint、受影响 build/typecheck、定向测试；以最终提交完整 CI 为全量证据。

**Architecture:** 共同验证文本一份来源、三个真实角色投影、一个限定路径同步器。teamlead prebuild 执行同步 --check；同包定向合同测试纳入既有 CI。不改运行时/registry/CI workflow，不引入现代节点迁移。

**执行:** 后继实现节点依注入 TURN、身份、review、PR 与 completion route 逐项执行本计划，可用 superpowers:executing-plans。设计节点不实现或派发后继。

## 基线及职责映射

当前可写仓库 `xrliAnnie/flywheel-qa-sandbox`、起点 `1855f7a1a`。现代 `.flywheel/agents/nodes` 不存在；该路径不是本计划修改目标。`.flywheel/config.yaml` 登记的 engineer 负责实现，general 是实现 fallback，qa 负责独立验证。

R1 的两项 HIGH 已接受：不再指向缺失文件、不再重复另一工作树已实现的任务。所有下列 Modify 文件均真实存在，Create 项明确为本单新增。具体适配建议已以 question `34f519e9-2a68-4542-a60c-e74cca1e4489` 报 Lead；无答时按非阻塞规则继续本计划审核，Lead 新指令优先。原始目标不变，目录映射与同步器缺失由这份明确适配处理。

## 文件白名单

| 操作 | 路径 | 最小变动 |
| --- | --- | --- |
| Modify | `.flywheel/agents/engineering/engineer-executor.md` | 验证第 5 步和 description 的 full-repo 词；插入共同块与作者红 job 动作 |
| Modify | `.flywheel/agents/engineering/qa-executor.md` | 验证第 3 步；保留真实行为测试，插入共同块与 QA 红 job 动作 |
| Modify | `.flywheel/agents/general-executor.md` | code-shaped 路由括号里的全量摘要；插入共同块与作者红 job 动作，其他 routing 不变 |
| Create | `scripts/lib/local-verification-policy.md` | 下节共同文本唯一来源 |
| Create | `scripts/sync-phase-protocols.mjs` | 本仓适配：只同步上述本机验证块，不假装存在九个现代 phase projections |
| Modify | `packages/teamlead/package.json` | 新增 prebuild `node ../../scripts/sync-phase-protocols.mjs --check` |
| Create | `packages/teamlead/src/__tests__/local-verification-policy.test.ts` | 真实文本语义、投影、负例、prebuild 连接的定向测试 |
| Create | 本目录 `implementation.md` | 真实 RED/GREEN、选择理由、命令与 CI 边界 |

不改 `.flywheel/config.yaml`、现有 build/test 命令、CI 工作流、其他守则条款；不创建现代 prompt fixture、不调整任何已有预算或角色身份。没有新增 shell test；若实现中新增 scripts/__tests__/*.test.sh，则全部照跑。

## 1. 精确共同规则与角色动作

将下列内容完整写入 canonical 文件，结尾一个换行：

```markdown
**Local targeted verification** — This rule overrides skill defaults that require local full-repo build/tests. Run `pnpm lint`. Build each affected package and required dependencies with `pnpm --filter "<pkg>..." build`; run available typechecks for affected packages, and typecheck affected dependents when exports, APIs, or types change. Select targeted tests from changed files' owning package and test files that directly depend on those changes. Discover consumers with `git grep -lF` using each changed file's full path, file name, and parent directory; document every excluded match. For changed TypeScript, also run the owning package's `vitest related <files> --run`; explicitly select tests for deleted files, dynamic imports, and re-exports when discovery cannot resolve them. Run all retained direct tests and every new `scripts/__tests__/*.test.sh`. There is no local full package suite. Only full exact-head CI for the final commit is full-suite evidence; scoped CI, ancestor results, and local targeted passes are not substitutes. Record selected tests, commands, results, final commit SHA, and CI run links.
```

三个投影标记固定为以下完整独立行，不复用现代协议标记：

```markdown
<!-- FLYWHEEL_LOCAL_VERIFICATION:BEGIN -->
共同规则的逐字内容
<!-- FLYWHEEL_LOCAL_VERIFICATION:END -->
```

角色动作必须与共同块紧邻，测试按完整连续句断言：

- engineer/general：`Fix every red current-HEAD CI job before claiming verification complete.`
- qa：`Any red current-HEAD CI job means FAIL; hand the failure to the author and verify the corrected head.`

删改原句的明确边界：engineer 只替换第 5 步；qa 第 3 步删除 `the package's own tests where relevant: pnpm test:packages:run`，保留真实行为验证为独立前导句；general 原路由括号改为 `TDD, local targeted verification below, codex:rescue review, PR`，后加投影与作者动作。其他行逐字保留。engineer description 的 `full-repo gates` 改为 `targeted local gates`。

本仓不存在 `PACKAGE_GATE_RECEIPT` 强制要求，验收防止重新引入即可；不存在待删除 RPC 超时豁免，不禁止普通诊断词 `onTaskUpdate`。

## 2. RED：新增直接合同测试

- [ ] 记录当前 HEAD 和三个真实文件存在性；用 `git diff --name-status <base>...HEAD` 建立范围。
- [ ] 新建上表 Vitest 文件；直接使用 node fs/path/os/child_process 与 Vitest，不调用服务或生产 DB。
- [ ] 第一项用例读取三个真实手册，断言无旧全量要求且包含新规则。当前基线会因 engineer/qa 的 `pnpm test:packages:run` 和 general 的 `pnpm -r build` 失败。以该真实文本失败作为 RED，不用缺文件 ENOENT 冒充。

核心断言代码（使用 `fileURLToPath(new URL("../../../../", import.meta.url))` 定位根目录）：

```ts
const roles = [
  ".flywheel/agents/engineering/engineer-executor.md",
  ".flywheel/agents/engineering/qa-executor.md",
  ".flywheel/agents/general-executor.md",
];
const required = ["pnpm lint", 'pnpm --filter "<pkg>..." build',
  "available typechecks for affected packages", "owning package",
  "test files that directly depend", "git grep -lF",
  "full path, file name, and parent directory", "document every excluded match",
  "vitest related", "deleted files, dynamic imports, and re-exports",
  "scripts/__tests__/*.test.sh", "no local full package suite",
  "full exact-head CI for the final commit", "skill defaults"];
for (const role of roles) {
  const text = readFileSync(join(root, role), "utf8");
  expect(text, role).not.toMatch(/pnpm test:packages:run|pnpm -r build|PACKAGE_GATE_RECEIPT/);
  for (const value of required) expect(text, role).toContain(value);
  expect(text, role).toContain(role.includes("qa-executor")
    ? "Any red current-HEAD CI job means FAIL; hand the failure to the author and verify the corrected head."
    : "Fix every red current-HEAD CI job before claiming verification complete.");
}
```

- [ ] 再加入下节负例矩阵，各例在 `mkdtempSync(join(tmpdir(), "fly2753-policy-"))` 下构造最小 repo，复制待测真实同步脚本，不读取或写入生产位置；finally 删除测试临时目录。
- [ ] 运行 `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/local-verification-policy.test.ts`，记录第一项真实文本 RED。提交测试锚点；脚本类用例缺新增文件的失败另列为尚未实现，不混同 RED。

## 3. GREEN：最小同步器与真实投影

同步器实现约束和完整算法如下，不接受路径参数、root override、环境重定向或网络输入：

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const source = "scripts/lib/local-verification-policy.md";
const targets = [
  ".flywheel/agents/engineering/engineer-executor.md",
  ".flywheel/agents/engineering/qa-executor.md",
  ".flywheel/agents/general-executor.md",
];
const begin = "<!-- FLYWHEEL_LOCAL_VERIFICATION:BEGIN -->";
const end = "<!-- FLYWHEEL_LOCAL_VERIFICATION:END -->";
try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !["--check", "--write"].includes(args[0])))
    throw new Error("usage: sync-phase-protocols.mjs [--check|--write]");
  const raw = readFileSync(resolve(root, source), "utf8");
  if (!raw.trim() || raw.includes("FLYWHEEL_LOCAL_VERIFICATION:"))
    throw new Error("invalid local verification source");
  const expected = begin + "\n" + raw.replace(/\n+$/, "") + "\n" + end;
  const updates = [];
  for (const path of targets) {
    const text = readFileSync(resolve(root, path), "utf8");
    const start = text.indexOf(begin), finish = text.indexOf(end);
    if ([...text.matchAll(/FLYWHEEL_LOCAL_VERIFICATION:/g)].length !== 2 ||
        start < 0 || finish < start + begin.length ||
        (start > 0 && text[start - 1] !== "\n") ||
        text[start + begin.length] !== "\n" || text[finish - 1] !== "\n" ||
        (finish + end.length < text.length && text[finish + end.length] !== "\n"))
      throw new Error(`${path}: expected one paired standalone local verification block`);
    const actual = text.slice(start, finish + end.length);
    if (actual !== expected) updates.push({path,
      content: text.slice(0, start) + expected + text.slice(finish + end.length)});
  }
  if (args[0] === "--write") {
    for (const update of updates) writeFileSync(resolve(root, update.path), update.content);
  } else if (updates.length) throw new Error(`local verification projection drift: ${updates.map(x => x.path).join(", ")}`);
  console.log(`local verification: 3 projections ${args[0] === "--write" ? "synchronized" : "checked"}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
```

该实现先校验所有输入再写；磁盘写入失败可能已写部分文件，不能宣称跨文件事务。此时保留实际 diff、修复原因后重跑，并要求 --check 全绿，不自动回滚覆盖他人工作。

- [ ] 创建 canonical 和脚本；在三份守则手动做 §1 的精确迁移并插入合法 marker，执行 `node scripts/sync-phase-protocols.mjs --write`。
- [ ] 在 `packages/teamlead/package.json` 的 scripts 新增 `"prebuild": "node ../../scripts/sync-phase-protocols.mjs --check"`；现有 build 完全不变。
- [ ] 运行以下测试矩阵并记录 GREEN；使用断言定位具体失败原因，不使用固定 PASS 文本假装检测。

| 用例 | 输入/操作 | 必须证明 |
| --- | --- | --- |
| 真实合同 | 三份实际文件 | §2 所有正/负断言通过，角色动作连续句存在 |
| 精确同步 | source 与三个块相同 | 默认/--check exit 0，三个文件字节不变 |
| 检查漂移 | fixture QA 块替换一词 | --check 非零，stderr 指出 QA，零写入 |
| 修复及幂等 | 对漂移 fixture --write 两次 | 第一次修回 source；前后块外字节相同，第二次零 diff |
| 非法结构 | 缺 begin/end、重复块、逆序块、marker 不是独立行 | check/write 均非零、零写入 |
| 全部先验 | 第一个目标漂移、第三个缺 end | --write 非零且第一个仍未改 |
| 无源/空源/非法源 | source 删除、空白、包含 marker | 非零且三个文件未写 |
| 缺目标 | 删除任一 fixture target | 非零且其他目标未写 |
| 非法参数 | --unknown 或两个参数 | 非零且零写入 |
| cwd 独立 | 从 fixture 的 packages/teamlead 调用绝对 script | 正常检查，根定位来自 script |
| prebuild 连接 | 读真实 package.json 并在 fixture package 使用同一 prebuild 命令 | 精确包含 --check；漂移 fixture 执行 prebuild 非零 |
| 本机职责回归 | 在 fixture 三个块分别删 lint/typecheck/删除文件覆盖/全量 CI 句或新增旧全量词 | 使用同一语义断言逐例失败，不依赖跨文件贪婪匹配 |

- [ ] 定向测试 GREEN 后提交新增 source/script、三份守则及 prebuild。不要更改原有 snapshot 或把 `3 projections` 说成现代的 `9 projections`。

## 4. 本机定向验收与消费者

```bash
pnpm lint
node scripts/sync-phase-protocols.mjs --check
pnpm --filter "flywheel-teamlead..." build
pnpm --filter flywheel-teamlead typecheck
pnpm --filter flywheel-teamlead exec vitest run src/__tests__/local-verification-policy.test.ts
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/AgentDispatcher.test.ts
```

构建选择依据：变更了 teamlead prebuild/test，构建 teamlead 及依赖以满足 dist 引用；不运行全仓 build。edge-worker 的 AgentDispatcher 测试直接覆盖当前三角色配置路径且构建已覆盖依赖。该文件可能包含其他 dispatch 用例，仍是直接相关单文件而非包全量。

- [ ] 对三份真实文件先 `test -s` 再负 grep，`pnpm test:packages:run|pnpm -r build|PACKAGE_GATE_RECEIPT` 零匹配。grep exit 1 表示零匹配，exit 2 不是通过。
- [ ] 正向语义与连续 CI 角色动作由合同逐文件校验；source 与三个投影由同步器独立证明；prebuild 漂移负例证明检查实际被接入。
- [ ] 用改动文件全路径、文件名、父目录搜索所有直接消费者；任何新增直接消费测试都补跑，排除项在 implementation.md 逐项写原因。shell 新文件若有全部跑。
- [ ] 记录旧句→新句 diff，确认不涉及 registry、原有 review/真实行为/ship 条款；不本机运行 `pnpm test:packages:run` 或 `pnpm -r build`。

## 5. 最终提交的远端全量证据

本仓 CI 没有现代 `CI OK` / `CI Scope OK` 汇总，也没有 scoped CI classifier。不得以不存在的 job 名做验收。使用现有完整 `CI` workflow：Build & Test 的完整包测试和 payload-distribution 均成功，并检查当前 workflow 实际 job 列表中的任何其他 job。

- [ ] 后继实现者按注入要求完成 code review、commit/push、PR；所有进度/里程碑提交在最终头冻结前完成。
- [ ] `gh pr view "$PR_NUMBER" --json headRefOid,statusCheckRollup` 取得实际头；`gh run list --workflow ci.yml --commit "$HEAD" --json headSha,status,conclusion,databaseId,url` 找对应运行，再 `gh run view "$RUN_ID" --json headSha,status,conclusion,jobs,url` 验证完整结果。
- [ ] 留存 final SHA、运行 URL、headSha 与全部 job 的状态/结论。所需 job 缺失、skipped、cancelled、pending、失败都不是 PASS；只看顶层一个绿色不足以证明完整套件执行。
- [ ] 任何当前头 CI job 红都定位处理；QA FAIL/交作者，不以 host-pressure 或本机定向绿豁免。任何新提交都重新验证新头。
- [ ] 若控制器另有 frozen-head `ci-full ensure` 注入合同，保留该职责与 exit-code 规则；不能把 external 现代工具的成功当 sandbox 完整 workflow 已绿。没有这种注入时不创造新 full-CI 请求流程。
- [ ] 完成只用后继自身注入 receipt/route；设计阶段不申请 ship、不 merge、不派后继、不部署。

## 回滚、迁移与验收映射

初次 migration 只替换三份已有验证条款；同一 source 避免未来漂移。旧会话冻结快照不变，零数据库/权限/凭据/状态迁移。正常部署由独立 updater 执行。回滚应一起回退 source/script/prebuild/投影/test 的本单提交，防止悬挂引用；保留真实 diff，不重置他人提交。

| 原需求 | 当前仓库落实及证据 |
| --- | --- |
| 实现/QA/工程师本机仅定向 | engineer 承担实现，qa 独立验证，general 路由实现；三份共同条款及真实文本 RED/GREEN |
| receipt 本机全量要求去除，红 job 保留 | 本仓 receipt 原无；负断言防回归，作者/QA 连续动作句正断言 |
| 投影同步、prebuild --check | 新增真实三投影同步器、source、teamlead prebuild；漂移/幂等/零写入负例 |
| 本单按新规运行，完整证据看 CI | §4 本机命令与 §5 最终 head 完整 CI，未虚构 modern job 名 |
| 不顺手改其他条款 | 白名单、块外字节保持测试、registry/权限/部署不变 |

## R1 findings 处置

- `plan-targets-absent-in-repo` / `plan-restates-already-shipped-work`：改为当前真实三文件，新增项明确 Create；旧全量文字真实存在，有可执行 RED 和明确交付物。
- `net-new-clauses-unasserted`：typecheck 与 deleted/dynamic/re-export 精确子句进入 required 列表和负例。
- `rebaseline-defeats-growth-budget`：取消所有现代 fixture 重锚步骤；不移动已有预算基线。
- `weak-regex-assertions`：按连续完整角色动作句断言，不用跨文件 greedy regex。
- `ontaskupdate-ban-unjustified`：移除无根据全文件词禁令；不声称删除当前不存在的 RPC 条款。
