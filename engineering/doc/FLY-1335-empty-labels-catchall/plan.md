# FLY-1335 空 labels 永不匹配 → general catch-all 失效 — 实施计划

Issue: FLY-1335 (https://linear.app/geoforge3d/issue/FLY-1335/bug-agentdispatcherlabelsmatch-空数组永不匹配-config-里-general-catch-all)
日期: 2026-07-18
基于: research.md

> **For agentic workers:** 按 task 顺序 TDD 执行(RED → GREEN → commit)。checkbox 用于跟踪。
> 本 plan 由 Design 阶段产出,Implement 阶段在**同一分支** `flywheel-FLY-1335` 上执行。
> Codex design review R1 三项反馈已折入(R1#1 既有真 config 合同对齐 = Task 3;R1#2 语义
> 文档矛盾修正 = Task 5;R1#3 RED 过滤命令 + spy 泄漏 = Task 4)。R2 三项已折入(R2#1
> vitest import 补 afterEach;R2#2 测试标题去 shipped-generic + Task 6 落实 grep 步骤;
> R2#3 Task 6 最终态 rebuild dist + 重跑 QA 脚本)。

**Goal:** 让 config 声称的 general catch-all 真正生效——label 未命中的 issue 落项目
`general-executor.md`(经既有 `default_agent` 机制),不再静默流向 shipped generic;
并用 fail-loud-ish 警告堵住「空 labels 当 wildcard」这类 config 幻觉。

**Architecture:** 方案 B+C-lite(brainstorm gate 已获 Tadashi 确认)。dispatcher 派发逻辑
**零代码改动**:`.flywheel/config.yaml` 声明 `default_agent: general` 走现成 Step 3a;
ConfigLoader 对「空 `match.labels` 且非 default_agent」的 agent 打 load 警告(FLY-159
warn-don't-throw 先例);真 config 合同测试(FLY-1059 designer-agent-dispatch 先例)钉死
新行为,**并把所有既有真 config 合同(designer / pm-prototype 测试 + qa-fly-901 QA 脚本)
一并接上 `config.default_agent`,不留「全绿但断言旧落点」的矛盾合同**(Codex R1#1)。

**红线(Lead gate 原话):其他项目零行为变化,测试盯死。**

**Tech Stack:** TypeScript, vitest, yaml (ConfigLoader), pnpm monorepo。

---

## File Map

| 动作 | 文件 | 职责 |
|------|------|------|
| Create | `packages/edge-worker/src/__tests__/general-catchall-dispatch.test.ts` | 真 config 合同回归测试(核心交付) |
| Modify | `.flywheel/config.yaml`(agents 块尾,~232-237 行) | 加 `default_agent: general` + 重写撒谎注释 |
| Modify | `packages/edge-worker/src/__tests__/designer-agent-dispatch.test.ts:30` | dispatcher 接上 `config.default_agent`(R1#1) |
| Modify | `packages/edge-worker/src/__tests__/pm-prototype-agent-dispatch.test.ts:38,115-140` | 接 default + miss 断言改落 general(R1#1) |
| Modify | `scripts/qa-fly-901-real-config-dispatch-e2e.mjs:50,106-114,195-200` | 接 default + miss 断言改落 general(R1#1) |
| Modify | `packages/config/src/ConfigLoader.ts`(default_agent 校验块后,~838 行) | C-lite 空 labels 警告 |
| Modify | `packages/config/src/__tests__/ConfigLoader.test.ts`(首行 import + agents 段 ~530 行后) | 警告触发/不触发测试(describe 包裹,R1#3;import 补 afterEach,R2#1) |
| Modify | `packages/config/src/types.ts`(~156-161 / ~625) | 空数组语义文档(措辞按 R1#2) |

不动:`AgentDispatcher.ts`(零改)、`agents/generic-executor.md`(FLY-1326 的地盘,排程约束)。

---

### Task 1: 真 config 合同测试(RED)

**Files:**
- Create: `packages/edge-worker/src/__tests__/general-catchall-dispatch.test.ts`

- [ ] **Step 1.1: 写测试文件**(镜像 designer-agent-dispatch.test.ts 的真 config 模式;
  关键差异:构造 dispatcher 时**必须**传 `config.default_agent`,镜像 run-infra.ts:862 接线,
  否则测不到 Step 3a = 空绿测)

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "flywheel-config";
import { ConfigLoader } from "flywheel-config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentDispatcher } from "../AgentDispatcher.js";

/**
 * FLY-1335: the `general` catch-all contract, driven against the REAL
 * `.flywheel/config.yaml` on this branch (real ConfigLoader + real
 * AgentDispatcher — no synthetic fixture), mirroring run-infra's wiring
 * (`new AgentDispatcher(agents, config.default_agent, repoRoot)`). An empty
 * `match.labels` never wins label matching — the "no label matched" fallback
 * is expressed by `default_agent`, and this suite pins that wiring so the
 * config can never silently regress to the shipped-generic fall-through again.
 */

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const CONFIG_PATH = path.join(REPO_ROOT, ".flywheel/config.yaml");

describe("general catch-all dispatch (FLY-1335, real .flywheel/config.yaml)", () => {
	let agents: Record<string, AgentConfig>;
	let defaultAgent: string | undefined;
	let dispatcher: AgentDispatcher;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeAll(async () => {
		// Spy BEFORE load: the real config must not trip the FLY-1335
		// empty-labels warning (general IS the declared default_agent).
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const loader = new ConfigLoader((p) => readFile(p, "utf-8"));
		const config = await loader.load(CONFIG_PATH);
		agents = config.agents ?? {};
		defaultAgent = config.default_agent;
		dispatcher = new AgentDispatcher(agents, defaultAgent, REPO_ROOT);
	});

	afterAll(() => {
		warnSpy.mockRestore();
	});

	it("config declares default_agent: general and the agent exists", () => {
		expect(defaultAgent).toBe("general");
		expect(agents.general).toBeDefined();
		expect(agents.general?.agent_file).toBe(
			".flywheel/agents/general-executor.md",
		);
	});

	it("unmatched label falls through to general via default_agent", () => {
		const r = dispatcher.dispatch({
			issueLabels: ["ops"],
			owningDept: "engineering",
		});
		expect(r.agentName).toBe("general");
		expect(r.matchMethod).toBe("default");
		expect(r.agentFileRoot).toBe("project");
		expect(r.agentConfig.agent_file).toBe(
			".flywheel/agents/general-executor.md",
		);
	});

	it("label-less issue falls through to general", () => {
		const r = dispatcher.dispatch({ issueLabels: [], owningDept: "engineering" });
		expect(r.agentName).toBe("general");
		expect(r.matchMethod).toBe("default");
	});

	it("owningDept=undefined also falls through to general", () => {
		const r = dispatcher.dispatch({ issueLabels: ["marketing"], owningDept: undefined });
		expect(r.agentName).toBe("general");
		expect(r.matchMethod).toBe("default");
	});

	it("matched labels still route by label — default_agent shadows nothing", () => {
		const r = dispatcher.dispatch({
			issueLabels: ["bug"],
			owningDept: "engineering",
		});
		expect(r.agentName).toBe("engineer");
		expect(r.matchMethod).toBe("label");
	});

	it('explicit agentName:"general" override path unchanged', () => {
		const r = dispatcher.dispatchByName("general");
		expect(r.agentName).toBe("general");
		expect(r.matchMethod).toBe("override");
		expect(r.agentFileRoot).toBe("project");
	});

	it('reserved agentName:"generic" still resolves to shipped-generic', () => {
		const r = dispatcher.dispatchByName("generic");
		expect(r.matchMethod).toBe("shipped-generic");
		expect(r.agentFileRoot).toBe("flywheel");
		expect(r.agentConfig.agent_file).toBe("agents/generic-executor.md");
	});

	it("loading the real config emits NO FLY-1335 empty-labels warning", () => {
		// Meaningful only alongside the ConfigLoader fixture test proving the
		// warning CAN fire (mutation partner — see ConfigLoader.test.ts).
		const fly1335Warnings = warnSpy.mock.calls.filter((args) =>
			String(args[0]).includes("match.labels is empty"),
		);
		expect(fly1335Warnings).toEqual([]);
	});
});
```

- [ ] **Step 1.2: 跑测试确认 RED**

Run: `pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/general-catchall-dispatch.test.ts`
Expected: FAIL —— `config declares default_agent` 断言挂(当前 `defaultAgent` 是
`undefined`);三条 fall-through 断言挂(当前返回 `shipped-generic`)。override/generic/
label 三条应当已绿(它们钉的是「不回归」面)。

- [ ] **Step 1.3: Commit(RED 测试单独入库,注明预期失败已验证)**

```bash
git add packages/edge-worker/src/__tests__/general-catchall-dispatch.test.ts
git commit -m "test: FLY-1335 real-config contract for general catch-all (RED)"
```

---

### Task 2: config.yaml 修复(合同测试转 GREEN)

**Files:**
- Modify: `.flywheel/config.yaml:232-237`(general 条目注释)+ agents 块后加顶层键

- [ ] **Step 2.1: 替换 general 条目注释并追加 default_agent**

现文(232-237 行):

```yaml
  # Top-level catch-all (no department). Used when the Lead passes agentName:"general"
  # or no executor label matches.
  general:
    agent_file: .flywheel/agents/general-executor.md
    match:
      labels: []
```

改为(并在 agents 块结束后、`# FLY-793 …` pipeline 注释块之前,插入顶层
`default_agent` 键):

```yaml
  # Top-level entry (no department). An empty labels array NEVER wins label
  # matching (FLY-1335 — empty is not a wildcard). This entry is reached two
  # ways: (1) the Lead passes agentName:"general" explicitly, or (2) via the
  # `default_agent` declaration below — any issue whose labels match no
  # executor above falls through to it (AgentDispatcher Step 3a).
  general:
    agent_file: .flywheel/agents/general-executor.md
    match:
      labels: []

# FLY-1335: the real catch-all wiring. Label dispatch that matches nothing in
# `agents` falls through to `general` (instead of the shipped
# agents/generic-executor.md). ConfigLoader validates the name exists.
default_agent: general
```

- [ ] **Step 2.2: 跑合同测试确认 GREEN**

Run: `pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/general-catchall-dispatch.test.ts`
Expected: PASS 全绿(8/8)。

- [ ] **Step 2.3: Commit**

```bash
git add .flywheel/config.yaml
git commit -m "fix: FLY-1335 declare default_agent: general — make the catch-all real"
```

---

### Task 3: 对齐既有真 config 合同(Codex R1#1 — 消灭矛盾合同)

pm-prototype 测试与 qa-fly-901 脚本硬编码 `undefined` default 并断言「miss →
shipped-generic」。config 修复后它们仍会全绿(硬编码使然),但断言的落点已不再是生产
行为——「全绿但互相矛盾的合同」直接违反红线。修法:三处真 config dispatcher 全部接上
`config.default_agent`(接上即是暴露陈旧断言的突变),再把 miss 断言改成新落点,
同时**保留各自原有的「不泄漏 / 非 alias」语义**。

**Files:**
- Modify: `packages/edge-worker/src/__tests__/designer-agent-dispatch.test.ts:30`
- Modify: `packages/edge-worker/src/__tests__/pm-prototype-agent-dispatch.test.ts:38,115-140`
- Modify: `scripts/qa-fly-901-real-config-dispatch-e2e.mjs:50,106-114,195-200`

- [ ] **Step 3.1: 三处 dispatcher 构造接上 default_agent**

designer-agent-dispatch.test.ts(beforeAll 内,~30 行):

```ts
		dispatcher = new AgentDispatcher(agents, config.default_agent, REPO_ROOT);
```

pm-prototype-agent-dispatch.test.ts(beforeAll 内,~38 行):

```ts
		dispatcher = new AgentDispatcher(agents, config.default_agent, REPO_ROOT);
```

qa-fly-901-real-config-dispatch-e2e.mjs(~50 行):

```js
const dispatcher = new AgentDispatcher(config.agents, config.default_agent, ROOT);
```

- [ ] **Step 3.2: 跑测试暴露陈旧断言(突变证据)**

Run: `pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/pm-prototype-agent-dispatch.test.ts src/__tests__/designer-agent-dispatch.test.ts`
Expected: pm-prototype 两条 miss 断言 FAIL(qa-from-product 与 poc 现在落 `general`/
`"default"`,不再是 `shipped-generic`);designer 套件仍 PASS(其断言全是 label 命中)。

- [ ] **Step 3.3: 更新 pm-prototype 的两条 miss 断言(保留原语义;标题同步去
  shipped-generic — R2#2)**

`poc` 测试标题(:127)改为:

```ts
	it("`poc` is NOT an alias — it appears in no agent's labels and falls to general via default_agent", () => {
```

`qa` from product scope(~115-125 行,原 `expect(fromProduct.matchMethod).toBe("shipped-generic")`):

```ts
		// qa is engineering-only (not dual-registered) → unreachable from product
		// scope; post-FLY-1335 the miss lands on the project catch-all, NOT on qa.
		const fromProduct = dispatcher.dispatch({
			issueLabels: ["qa"],
			owningDept: "product",
		});
		expect(fromProduct.agentName).not.toBe("qa");
		expect(fromProduct.agentName).toBe("general");
		expect(fromProduct.matchMethod).toBe("default");
```

`poc` 测试(~127-140 行,保留「无 agent 声明 poc label」循环,末段断言改为):

```ts
		const r = dispatcher.dispatch({
			issueLabels: ["poc"],
			owningDept: "product",
		});
		// poc is not an alias for prototype; post-FLY-1335 the miss lands on the
		// project catch-all instead of the shipped generic.
		expect(r.agentName).not.toBe("prototype");
		expect(r.agentName).toBe("general");
		expect(r.matchMethod).toBe("default");
```

- [ ] **Step 3.4: 更新 qa-fly-901 脚本的两条 miss 断言(同语义)**

S1b2 poc(~106-114 行):

```js
// 去黑话 (FLY-1089): `poc` is NOT an alias — post-FLY-1335 an unmatched label
// falls to the project catch-all (`general` via default_agent), not to prototype.
const rPoc = dispatcher.dispatch({
	issueLabels: ["poc"],
	owningDept: "product",
});
check(
	"S1b2: label 'poc' -> general via default_agent (not an alias for prototype)",
	rPoc.agentName === "general" &&
		rPoc.matchMethod === "default" &&
		rPoc.agentName !== "prototype",
	rPoc,
);
```

S3 no-leak(~195-200 行):

```js
// ── Scenario 3: no cross-dept leak for a dept NOT in product-designer.departments ──
const r3 = dispatcher.dispatch({ issueLabels: ["product"], owningDept: "ops" });
check(
	"S3: ops Lead (unlisted dept) + label 'product' -> no leak; falls to general via default_agent",
	r3.agentName !== "product-designer" &&
		r3.agentName !== "pm" &&
		r3.agentName === "general" &&
		r3.matchMethod === "default",
	r3,
);
```

- [ ] **Step 3.5: 验证(测试 + 脚本;脚本吃 dist,先 build)**

Run:
```bash
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/pm-prototype-agent-dispatch.test.ts src/__tests__/designer-agent-dispatch.test.ts
pnpm --filter flywheel-config build && pnpm --filter flywheel-edge-worker build
node scripts/qa-fly-901-real-config-dispatch-e2e.mjs
```
Expected: vitest 全绿;脚本全部 check PASS、exit 0。

- [ ] **Step 3.6: Commit**

```bash
git add packages/edge-worker/src/__tests__/designer-agent-dispatch.test.ts packages/edge-worker/src/__tests__/pm-prototype-agent-dispatch.test.ts scripts/qa-fly-901-real-config-dispatch-e2e.mjs
git commit -m "test: FLY-1335 wire default_agent into existing real-config contracts"
```

---

### Task 4: ConfigLoader C-lite 警告(先 RED 后实现;describe 包裹 = Codex R1#3)

**Files:**
- Modify: `packages/config/src/__tests__/ConfigLoader.test.ts`(agents 测试段,~530 行后)
- Modify: `packages/config/src/ConfigLoader.ts`(default_agent 校验块后,~838 行)

- [ ] **Step 4.1: 写 fixture 警告测试(describe 包裹 + afterEach 还原 spy)** ——
  插在 "throws when agent_file is missing" 之前,沿用文件内 `MINIMAL_CONFIG_YAML` +
  `readFile.mockResolvedValue` 模式。**先改首行 import 补 `afterEach`(R2#1,否则加载
  测试文件即报 afterEach is not defined,RED 证据跑不到断言)**:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
```

```ts
	// ─── FLY-1335: empty match.labels warning (empty array is NOT a wildcard) ───

	describe("FLY-1335 empty match.labels warning", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("warns when an agent has empty match.labels and is not default_agent", async () => {
			const warnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			const yaml = `${MINIMAL_CONFIG_YAML}
agents:
  general:
    agent_file: .flywheel/agents/general-executor.md
    match:
      labels: []
`;
			readFile.mockResolvedValue(yaml);
			const config = await loader.load("/p/config.yaml");
			// load succeeds — warn, don't throw (boot continuity, FLY-159 precedent)
			expect(config.agents!.general).toBeDefined();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringMatching(
					/agents\.general\.match\.labels is empty.*not a wildcard/i,
				),
			);
		});

		it("does NOT warn when the empty-labels agent IS the declared default_agent", async () => {
			const warnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			const yaml = `${MINIMAL_CONFIG_YAML}
agents:
  general:
    agent_file: .flywheel/agents/general-executor.md
    match:
      labels: []
default_agent: general
`;
			readFile.mockResolvedValue(yaml);
			const config = await loader.load("/p/config.yaml");
			expect(config.default_agent).toBe("general");
			const fly1335 = warnSpy.mock.calls.filter((args) =>
				String(args[0]).includes("match.labels is empty"),
			);
			expect(fly1335).toEqual([]);
		});

		it("does NOT warn for agents with non-empty labels", async () => {
			const warnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			const yaml = `${MINIMAL_CONFIG_YAML}
agents:
  backend:
    agent_file: .flywheel/agents/product/backend-executor.md
    match:
      labels: ["backend"]
`;
			readFile.mockResolvedValue(yaml);
			await loader.load("/p/config.yaml");
			const fly1335 = warnSpy.mock.calls.filter((args) =>
				String(args[0]).includes("match.labels is empty"),
			);
			expect(fly1335).toEqual([]);
		});
	});
```

(注意:外层 describe 的 `beforeEach` 会重建 `readFile`/`loader`,嵌套 describe 继承;
`afterEach` 的 `vi.restoreAllMocks()` 保证第一条预期失败时 spy 不泄漏到后续测试。)

- [ ] **Step 4.2: 跑测试确认 RED**

Run: `pnpm --filter flywheel-config exec vitest run src/__tests__/ConfigLoader.test.ts -t "FLY-1335"`
Expected: 第 1 条 FAIL(还没实现警告),第 2/3 条 PASS(它们此刻天然绿;第 1 条转绿后
即成为「无警告」断言的突变对照,证明其非空过)。

- [ ] **Step 4.3: 实现警告** —— `ConfigLoader.ts`,插在 `default_agent` 校验块
  (以 `throw new Error(\`default_agent "${defaultAgent}" not found in agents\`)` 结尾,
  ~838 行)**之后**:

```ts
		// FLY-1335: an empty match.labels array NEVER wins label matching
		// (AgentDispatcher.labelsMatch returns false on an empty array — empty is
		// NOT a wildcard). Such an agent is selected only by an explicit agentName
		// override, or — when its name is declared as `default_agent` — via the
		// Step-3a unmatched-label fallback. This warning fires for empty-labels
		// agents that are NOT the default_agent: they are name-only, and if the
		// author meant "catch-all", that intent silently doesn't work. Warn, don't
		// throw — boot continuity for existing configs (FLY-159 precedent);
		// name-only agents stay legitimate.
		if (agents && typeof agents === "object") {
			for (const [name, agentRaw] of Object.entries(agents)) {
				const match = (agentRaw as Record<string, unknown>).match as {
					labels: string[];
				};
				if (match.labels.length === 0 && name !== defaultAgent) {
					console.warn(
						`[ConfigLoader] agents.${name}.match.labels is empty — an empty array is NOT a wildcard; ` +
							`label dispatch will never select this agent (it is name-only). ` +
							`For a "no label matched" catch-all, declare default_agent: ${name} (FLY-1335).`,
					);
				}
			}
		}
```

(位置依赖:此处 `agents` 已过逐条校验——`match.labels` 保证是 string 数组;
`defaultAgent` 已声明于上方 `const defaultAgent = c.default_agent as string | undefined`。)

- [ ] **Step 4.4: 跑测试确认 GREEN + config 包全套**

Run: `pnpm --filter flywheel-config test`
Expected: PASS 全绿(含既有 checkpoint-floor 警告测试;新警告只对空 labels 触发,
既有 fixture 的 agents 全部带非空 labels,不受影响)。

- [ ] **Step 4.5: 跑合同测试确认「真 config 零警告」断言仍绿(现在有意义了)**

Run: `pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/general-catchall-dispatch.test.ts`
Expected: PASS(general 是 default_agent → 不触发;突变对照 = Step 4.1 第 1 条)。

- [ ] **Step 4.6: Commit**

```bash
git add packages/config/src/ConfigLoader.ts packages/config/src/__tests__/ConfigLoader.test.ts
git commit -m "feat: FLY-1335 warn on empty match.labels (empty is not a wildcard)"
```

---

### Task 5: 语义文档(types.ts;措辞按 Codex R1#2 消歧)

**Files:**
- Modify: `packages/config/src/types.ts:156-161`(match.labels)与 `:625`(default_agent)

- [ ] **Step 5.1: match.labels 文档补空数组语义**

现文:

```ts
		/**
		 * Linear labels that map to this agent (case-insensitive). Multiple entries =
		 * multi-alias (e.g. `["designer", "design", "ui", "ux"]` — any label hit matches).
		 */
		labels: string[];
```

改为:

```ts
		/**
		 * Linear labels that map to this agent (case-insensitive). Multiple entries =
		 * multi-alias (e.g. `["designer", "design", "ui", "ux"]` — any label hit matches).
		 *
		 * FLY-1335: an EMPTY array NEVER wins label matching (empty is not a
		 * wildcard). Such an agent is reachable via an explicit agentName override,
		 * and additionally via the Step-3a fallback when its name is declared as
		 * `default_agent`. To express a "no label matched" catch-all, declare the
		 * agent as `default_agent` — an empty labels array alone does nothing.
		 */
		labels: string[];
```

- [ ] **Step 5.2: default_agent 文档点名 catch-all 语义**

现文:

```ts
	/** Default agent name when no match. Falls back to generic prompt if undefined. */
	default_agent?: string;
```

改为:

```ts
	/**
	 * Default agent when no label matches — the mechanism for expressing an
	 * unmatched-label catch-all (an empty match.labels alone is name-only and
	 * never a wildcard; FLY-1335). Falls back to the shipped generic prompt
	 * when undefined.
	 */
	default_agent?: string;
```

- [ ] **Step 5.3: Commit**

```bash
git add packages/config/src/types.ts
git commit -m "docs: FLY-1335 spell out empty-labels semantics (name-only + default_agent fallback)"
```

---

### Task 6: 全仓验证

- [ ] **Step 6.1**: `pnpm lint` — Expected: clean(push 前全仓 lint,仓规;注意 Biome
  只管风格,TypeScript 编译正确性由 Step 6.4 的 build 兜)。
- [ ] **Step 6.2**: `pnpm --filter flywheel-edge-worker test && pnpm --filter flywheel-config test`
  — Expected: 全绿(含 AgentDispatcher.test.ts 既有套件——只要求套件全绿,不钉 case 数,
  避免数字漂移)。再跑 `pnpm --filter flywheel-teamlead test` 兜 run-infra 消费侧
  (预期无涉,红了先查根因;注意 MEMORY 教训:`pnpm -r test` 首挂即 bail,不能拿总 exit
  码证明目标包跑过——逐包跑)。
- [ ] **Step 6.3: 合同一致性 grep(R2#2 — 验收标准 #3 的实际执行步骤)**

Run:
```bash
rg -n "shipped-generic" \
  packages/edge-worker/src/__tests__/general-catchall-dispatch.test.ts \
  packages/edge-worker/src/__tests__/designer-agent-dispatch.test.ts \
  packages/edge-worker/src/__tests__/pm-prototype-agent-dispatch.test.ts \
  scripts/qa-fly-901-real-config-dispatch-e2e.mjs
```
Expected: 命中只允许两类——(a) `dispatchByName("generic")` 保留字断言(新合同测试的
`reserved agentName:"generic"` case),(b) 注释/历史说明文字。**不允许**任何仍对真
config 的 label-miss 派发断言 `matchMethod === "shipped-generic"` 的活代码。阳性对照:
保留字断言本身必须仍在命中列表里(证明 grep 真的跑了、尺子没坏)。

- [ ] **Step 6.4: 最终态 rebuild dist + 重跑 QA 脚本(R2#3 — Task 4 改了 ConfigLoader
  源码,Task 3.5 的 dist 已过期;这次运行证明最终提交态)**

Run:
```bash
pnpm --filter flywheel-config build && pnpm --filter flywheel-edge-worker build
node scripts/qa-fly-901-real-config-dispatch-e2e.mjs
```
Expected: build 零 TypeScript 错误(顺带充当新增 warning 源码的 tsc 编译验证);
脚本全部 check PASS、exit 0。

- [ ] **Step 6.5**: Push + PR(PR body 带 Linear issue 段 + 本 doc 文件夹;三段式流程下
  由 Implement 阶段按其 preamble 走 code review / QA / gate,不在本 plan 复述)。

---

## 验收标准(QA 阶段对照)

1. **主修复**:合同测试 8/8 绿——label 未命中(有未注册 label / 无 label / owningDept
   undefined)均落 `general`,`matchMethod:"default"`;shipped-generic 不再是 flywheel
   的 label-miss 落点。
2. **不回归**:显式 `agentName:"general"` / 保留字 `"generic"` / 已注册 label(如 bug →
   engineer)三条路径行为逐字不变;AgentDispatcher.test.ts 与 ConfigLoader 套件全绿。
3. **合同一致性(R1#1 + R2#2)**:全仓不再存在任何仍断言「flywheel 真 config 下
   label-miss → shipped-generic」的测试或 QA 脚本;designer / pm-prototype / qa-fly-901
   全部接上 `config.default_agent` 并断言新落点。执行步骤 = Step 6.3 的 rg 检查
   (允许清单:`dispatchByName("generic")` 保留字断言 + 注释;阳性对照 = 保留字断言
   必须仍命中)。
4. **红线**:其他项目零行为变化——代码 diff 里唯一行为分支是 console.warn(纯日志);
   `.flywheel/config.yaml` 是 flywheel 仓本地文件。
5. **警告有效**(突变对照):fixture 测试证明警告能响;真 config 零触发。

## 生效条件(ship 阶段注意)

- config 在 Bridge boot 时经 run-infra 读取(FLY-205 ship 教训:「补装项目 config 落地后
  必须再重启一次 Bridge」)。本修 merge 后需**一次 Bridge 重启**才对新 run 生效;归入
  下一个批量重启窗口即可,无独立重启诉求。
- 生效后的行为观察点:给一张无 executor label 的 FLY issue 走 label 派发,Runner 应拿到
  `.flywheel/agents/general-executor.md` 的 prompt(而非 Superpowers RPC 那份)。

## Out of Scope(明确不做)

- `agents/generic-executor.md` 内容改写 → FLY-1326 B/C 臂(排程:本单结论先行,1326 跟进;
  两单不并行动同一路径)。
- 空 labels 升级硬错误 → 需先审计全部生产项目 config 的 follow-up(run-infra rethrow 会
  fail-closed,不可盲升)。
- `labelsMatch` 语义改动(方案 A 已否决,gate 记录在案)。
