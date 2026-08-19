# Design: FLY-1883 — post-ship-finalization.test.ts fetch stub 不还原(测试卫生)

**Issue**: FLY-1883 · https://linear.app/xrli/issue/FLY-1883
**日期**: 2026-08-18
**基于**: FLY-1833 QA attempt-3 发现的 follow-up(裁定不动已验 head);worktree @ `2df1fd06b`

---

## 1. 一句话

`packages/teamlead/src/__tests__/post-ship-finalization.test.ts` 在 `beforeEach` 里 `vi.stubGlobal("fetch", …)` 但从不还原;修法 = 该文件补 `afterEach` unstub(点修)+ teamlead `vitest.config.ts` 开 `unstubGlobals: true`(类修,需先迁移 3 个顶层 stub 文件)+ 把验收配对固化为 CI 回归步骤。

## 2. 实测机制(本 design 节点在真文件上复现,非转述)

环境:worktree `flywheel-FLY-1883` @ `2df1fd06b`,vitest 3.2.4,node v25.6.1,`packages/teamlead` 下执行。

| # | 命令 | 结果 |
|---|------|------|
| E0 | `vitest run post-ship… lifecycle-routes…`(默认隔离) | 2 files / **56 全绿** |
| E1 | 同配对 + `--no-isolate --fileParallelism=false` | lifecycle-routes **15/15 全红**(fetch resolve undefined) |
| E2 | 同配对 + 默认隔离 + `--maxWorkers=1 --fileParallelism=false` | **全绿**(单 worker 串行也不污染) |
| E5 | 仅 Fix B,4 个 stub 文件默认跑 | ChatThreadCreator / attach-pin / thread-validator **3 files 64/84 tests 红**;fly892 绿 |
| E6 | Fix B + 3 文件迁移,全部 7 个 stub 文件 + 配对 | **166/166 绿** |
| E7 | 未修代码 + **钉序 hygiene config**(见 §4 Fix C)+ `--no-cache`,连跑 ×2 | **两次均确定性 15 红**(RED 基线可复跑) |
| E3′ | 仅 Fix A + 钉序 hygiene config,连跑 ×2 | **两次均 56/56 绿** |
| E4′ | 仅 Fix B + 钉序 hygiene config,连跑 ×2 | **两次均 56/56 绿** |

> **证据更正(独立评审 B1 之后)**:初版 E3/E4 用裸 `--no-isolate --fileParallelism=false` 取证,而 vitest 的文件顺序按 results cache(failed-first)与文件大小排序、**不按 CLI 参数序** —— E1 跑红之后 cache 会把受害文件翻到污染源之前,同命令第二次必绿(评审实测 RED→GREEN)。初版 E3/E4 的绿因此不构成修复证据,已作废;上表 E3′/E4′ 为钉序 + `--no-cache` 条件下重取,每项连跑两次消除顺序侥幸。

**对 issue 断言的一处修正(诚实边界,finding 世界:[本分支 = 生产 main 同代码])**:vitest 3.2.4 默认 `isolate: true`,每个测试文件独占 fresh fork —— E0/E2 证明即使单 worker 串行也不串场。因此「当前 CI 绿纯靠分片顺序侥幸/重排 shard 可能弄红」在当前 CI 配置(`vitest run --shard=N/3`,无 isolation flag,ci.yml:115-119)下**不成立**:CI 目前被 `isolate: true` 结构性保护,shard 顺序无关。真实暴露面 = 任何 worker 复用运行:本地/agent 提速常用的 `--no-isolate`;以及未来为 CI 提速 flip `isolate: false` —— 这个 700+ 文件套件正处在 15-min ceiling 压力下(FLY-1866/FLY-1870 都在磨 CI 成本),该 flip 是现实可能,届时此雷必炸。潜伏结论、修法、验收均不变;只是威胁模型措辞更正。QA 原复现(「同一 worker」)与 E1 一致。

## 3. 根因与全类 census

`packages/teamlead` 内 `vi.stubGlobal` 共 8 处 / 7 文件:

| 文件 | 安装位置 | 自身 unstub | 泄漏? |
|------|---------|------------|-------|
| post-ship-finalization.test.ts:435 | beforeEach | 无 | **是**(本 issue 主角) |
| ChatThreadCreator.test.ts:10 | 模块顶层 | 无(`restoreAllMocks` 不管 stubGlobal) | **是** |
| ChatThreadCreator.attach-pin.test.ts:12 | 模块顶层 | 无 | **是** |
| thread-validator.test.ts:8 | 模块顶层 | 无 | **是** |
| fly892-pipeline-header.test.ts:98 | beforeEach | 无 | **是** |
| management-console-dom.test.ts:178 | beforeEach | afterEach `unstubAllGlobals` | 否(现成正确惯用法) |
| vercel-deploy.test.ts:28,112 | beforeEach | afterEach `unstubAllGlobals` | 否 |

同类泄漏不止 issue 点名的一处 —— **5 个文件都在漏**。这是「一行点修」之外必须上 config 类修的理由。
(3 个顶层 stub 文件均无 `beforeAll` 依赖,已核 —— 迁移安全。)

## 4. 方案

### Fix A — 点修(issue 的「一行 unstub」)

`post-ship-finalization.test.ts`:
- 第 1 行 import 加 `afterEach`;
- `describe("runPostShipFinalization")` 的 `beforeEach`(结束于 L436)之后加:

```ts
afterEach(() => {
	vi.unstubAllGlobals();
});
```

与 management-console-dom / vercel-deploy 现行惯用法一致。

### Fix B — 类修(评估结论:**开**,且必须带 3 文件迁移)

`packages/teamlead/vitest.config.ts`:

```ts
test: {
	watch: false,
	globals: true,
	unstubGlobals: true, // FLY-1883: auto-restore leaked global stubs before every test
	environment: "node",
	…
}
```

语义(评审按 vitest 3.2.4 源码核实):unstub 发生在 `onBeforeTryTask` —— **每个 test attempt 前、beforeEach hooks 之前**。E4′ 证明它单独就治好跨文件污染(File B 第一个 test 前即还原)。

> **future-facing 警示(评审 A3)**:同一语义意味着 **`beforeAll` 里装的 stubGlobal 会在首个 test 前被抹掉**。当前 census 无此形态,但开了本 config 后,新文件作者若在 beforeAll 装 stub 会莫名失效 —— 装 stub 一律放 `beforeEach`。另:`unstubGlobals` 只管 `stubGlobal`,**不影响 `stubEnv`**(teamlead 内多处在用 stubEnv,不受本改动影响)。

**前置迁移(E5 证明不做必红,3 文件共 84 tests 中 64 挂)**:3 个顶层 stub 文件把

```ts
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
```

改为

```ts
const mockFetch = vi.fn();
beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
});
```

(文件顶层 `beforeEach` 覆盖该文件全部 describe。)fly892 的 beforeEach 安装形态与 config 天然兼容,无需动。

### Fix C — 验收固化(issue:复现转回归测试;形态按独立评审 B1 修订)

**为什么不能裸跑配对**:vitest 的文件执行顺序由 `BaseSequencer.sort()` 决定 —— 有 results cache 时 failed-first / 长时优先,否则按**文件大小降序**;与 CLI 参数顺序无关,`--fileParallelism=false` 只串行化不改排序。裸配对第一次红之后,cache 把受害文件翻到污染源之前,回归从此**静默空转**(评审实测同命令 RED→GREEN);即便 CI fresh runner 无 cache,今天 polluter-first 也只是两文件大小(42807B > 16428B)的巧合。因此顺序必须显式钉死:

1. 新增 `packages/teamlead/vitest.stub-hygiene.config.ts`(E7/E3′/E4′ 即用此文件实测,内容照抄):

```ts
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import baseConfig from "./vitest.config";

// FLY-1883: worker-reuse pairing regression. The polluter file MUST run before
// the victim file — vitest's default sequencer orders by results cache
// (failed-first) and file size, NOT CLI order, which silently inverts the pair
// and turns this regression into a no-op. Pin the order explicitly.
class StubHygieneSequencer extends BaseSequencer {
	async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
		const rank = (spec: TestSpecification) =>
			spec.moduleId.includes("post-ship-finalization") ? 0 : 1;
		return [...files].sort((a, b) => rank(a) - rank(b));
	}
}

export default defineConfig({
	...baseConfig,
	test: {
		...baseConfig.test,
		// Same-worker sequential execution: the leak only manifests when the
		// victim file reuses the polluter's process.
		isolate: false,
		fileParallelism: false,
		// The results cache reorders failed files first, flipping the victim
		// ahead of the polluter on the second run — pin order via sequencer
		// (cache-independent) and run with --no-cache as belt-and-suspenders.
		sequence: { sequencer: StubHygieneSequencer },
	},
});
```

2. `packages/teamlead/package.json` scripts 加(`--no-cache` 双保险:sequencer 已不读 cache,此 flag 防未来 sequencer 被改回默认;CLI **无** `--unstubGlobals` flag,评审实测 CACError,故 config 文件是唯一载体):

```json
"test:stub-hygiene": "vitest run --config vitest.stub-hygiene.config.ts --no-cache src/__tests__/post-ship-finalization.test.ts src/bridge/__tests__/lifecycle-routes.test.ts"
```

3. `.github/workflows/ci.yml` `unit-tests` job 加一步,**位置在 `Run matrix tests` 步之后**(依赖同 job 已有的 `pnpm build` 产物),gate 在单个 shard 避免 ×3 重复:

```yaml
- name: FLY-1883 stub-hygiene pairing (worker reuse)
  if: matrix.name == 'teamlead 1 of 3'
  run: pnpm --filter flywheel-teamlead test:stub-hygiene
```

本地实测该配对 ~8-9s(host M-series;CI 预算按 <60s 估,unit-tests 15-min ceiling 内无压力)。

⚠️ **ci-structure 守卫接线(评审 A1 核正)**:实核 `scripts/__tests__/ci-structure.test.sh` 对 unit-tests job 的现有断言(matrix 精确相等 / 恰一个 matrix.cmd 执行步且不带 `if` / 无 mkdir 步 / timeout ≥15),上述**独立** step 一条都不撞 —— 但这恰是问题:**没有任何守卫防止 Fix C 步骤将来被删**。implement 必须把该 step 纳入 ci-structure 的期望集(新增断言:unit-tests job 必须存在名为 `FLY-1883 stub-hygiene pairing` 且 `if: matrix.name == 'teamlead 1 of 3'` 的 step),一举补上「谁守 Fix C」。

**冗余设计**:Fix A 或 Fix B 任一在位,配对都绿(E3′/E4′ 各自独立、钉序条件下证过);Fix C 守住两者被误删,ci-structure 新断言守住 Fix C 被误删。

## 5. 取舍与否决项

- **只做 Fix A**(否决):census 显示同类还有 4 处在漏,且对未来新文件零纪律保障。
- **只做 Fix B、不迁移 3 文件**(否决):E5 实测 64 tests 立即红,CI 直接挡。
- **grep 静态守卫「stubGlobal 必配 unstub」**(否决):近似检查 ≠ 属性本身(注释/字符串/间接调用都会骗过);行为级配对回归才是事实层面的门。
- **回归放 scripts/__tests__ shell shard**(否决):该 shard 无 `pnpm build` 产物保障,vitest 配对会死在依赖解析;且需改 ci-shell-suite-enumeration、挤 FLY-1870 shard 预算。unit-tests job 里 build 现成。
- **裸配对命令、依赖 CLI 参数序或文件大小序**(否决,评审 B1):CLI 参数序根本不生效;大小序是今天的巧合,倒挂后回归静默空转零信号;results cache 更会在第一次红之后主动翻转顺序。顺序必须由专用 sequencer 显式钉死。
- **repo 全包开 `unstubGlobals`**(超范围,不做):本 issue 范围 = teamlead 配对 + teamlead config;其他包同类问题留 follow-up 单独评估(census 未做)。

## 6. 诚实边界

- 只治 **fetch stub(全局替身)这一类**跨文件泄漏;env 变量、模块级单例等其他共享态泄漏不在本单。
- **未做全套件 `--no-isolate` 扫描**(host 负载纪律 + issue 未要求)。若未来真要 flip `isolate: false` 提速,需专项扫描,本单不背书那次 flip 的安全性。
- CI 当前不受此 bug 影响(E0/E2 实证);本修的现实价值 = 本地/agent 提速运行的正确性 + 未来 isolate flip 的前置排雷 + 测试卫生基线。
- 其他包(edge-worker / comm / …)的 stubGlobal census 未做。

## 7. 验收(implement 节点照抄)

1. **RED 先行且必须可复跑**:先落 `vitest.stub-hygiene.config.ts` + `test:stub-hygiene` 脚本,在未修代码上**连跑两次**,两次都必须红(红形态 = lifecycle-routes 15/15 fetch resolve undefined;E7 已证)。只红一次、第二次绿 = 顺序没钉住,回归无效。
2. 落 Fix A+B+迁移后同命令**连跑两次全绿**(= issue 验收「同 worker 配对必须绿」;E3′/E4′ 已分别证过单层有效)。
3. 7 个 stub 相关文件 + 配对,默认隔离 **166/166 绿**(E6 基线,精确文件清单见 §3)。
4. CI 步骤落地(位置:unit-tests job `Run matrix tests` 之后,`if: matrix.name == 'teamlead 1 of 3'`),且 **ci-structure.test.sh 新增断言钉住该 step 的存在**(评审 A1;现有断言不覆盖它)、守卫全绿。
5. 全仓 gate:`pnpm lint` + `pnpm -r build` + 定向 teamlead 影响面(全量套件按 host 纪律留 CI)。

## 8. 独立设计评审记录(替代 Codex 通道)

- **通道**:Codex design review 当晚全号打满(Lead 指令 98a9be8a 认可的 sanctioned skip),按 Lead 硬要求改用**独立上下文 Claude 交叉评审**(与作者零共享上下文的 general-purpose agent,对照真实代码库逐条核查 + 实跑取证)。
- **R1 结论:CHANGES_REQUESTED** —— blocking ×1 + advisory ×4,全部折入本稿:
  - **[B1] blocking**:配对回归文件顺序未钉死。评审实测同命令连跑 RED→GREEN(results cache failed-first 翻转受害文件到污染源之前),并核出 vitest `BaseSequencer` 排序与 CLI 参数序无关、无 cache 时按文件大小降序。**处置**:Fix C 重设计为专用 sequencer config + `--no-cache`(§4);初版 E3/E4 证据作废,E7/E3′/E4′ 钉序重取(§2)。
  - **[A1]**:「改 CI 必撞 ci-structure 守卫」经实核为过宽 —— 新增独立 step 不撞任何现有断言;真问题是 Fix C 自身无守卫。**处置**:§4/§7.4 改为要求把新 step 纳入 ci-structure 期望集。
  - **[A2]**:E5 计数歧义。**处置**:改写为 64/84。
  - **[A3]**:`unstubGlobals` 会抹掉 beforeAll 里装的 stub(unstub 在 beforeEach 之前执行),新文件作者易踩。**处置**:§4 Fix B 加 future-facing 警示,并注明 stubEnv 不受影响。
  - **[A4]**:CI step 插入位置未写明。**处置**:§4/§7.4 写明在 `Run matrix tests` 之后。
- 评审事实核查表 17 项:13 CONFIRMED、2 REFUTED(A1 的守卫声称 + 顺序稳定假设)、2 UNVERIFIED(初版 E3/E4,已由 E3′/E4′ 钉序重取取代)。
- **R2 结论:APPROVED**。B1 处置获评审独立复验:评审逐字照抄 §4 的 sequencer 跑未修代码配对,连跑 ×2 均 15 红(E7 独立重放);并做**阳性对照** —— 仅反转 rank(受害文件先跑)→ 56/56 全绿,双向证明顺序确由 sequencer 控制而非文件大小巧合。`BaseSequencer`/`TestSpecification` 的 import 与类型形态经 vitest 3.2.4 dist 静态核实。E3′/E4′ 因评审约束(不改源码)未独立重放,评审判定残余风险可忽略:治愈机制已按源码确认 + 取证仪器已端到端验证 + §7.1-7.2 两连跑纪律会在 implement 节点用同一仪器重证。
- R2 non-blocking:[N1] 本节核查表计数勘误(已按 13/2/2 修正);[N2] `...baseConfig.test` spread optional 字段 TS 合法,implement 时若 strict 报错按报错微调;[N3] 建议 implement 时在 hygiene config 头注保留指向本文件 §4 的「为什么不能裸跑配对」说明(可选)。
