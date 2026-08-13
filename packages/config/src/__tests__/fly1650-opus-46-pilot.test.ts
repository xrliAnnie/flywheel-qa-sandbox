/**
 * FLY-1650: runner 侧 Opus 4.6 试点 —— 模型注册表加 `claude-opus-4-6`
 * (含 `[1m]` 变体),作为受控菜单里多出来的一个可选项。
 *
 * 唯一的硬约束:**Opus 4.6 不支持 `xhigh`**。`xhigh` 是 Opus 4.7 才引入的
 * 档位,4.6 只认 low/medium/high/max。所以档位表必须按模型 id 收窄,而且
 * 三条构造路径 —— 内建条目、binding 接管后的条目、models.json overlay ——
 * 拿到的表必须一致,否则某一条路径会把 xhigh 透传上去换回一个 400。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getModelConfigSnapshot,
	resetModelConfigCacheForTests,
	resolveAllowedEffort,
	resolveLeadLaunchSelection,
} from "../model-config.js";
import {
	assertValidModelRegistry,
	buildDispatchLookup,
	buildModelCatalog,
	buildModelRegistry,
	DEFAULT_OPUS_BINDINGS,
	type DefaultOpusBindings,
	getModelRegistryEntry,
	isModelSelectable,
	isModelSelectionSupported,
	MODEL_IDS,
	MODEL_REGISTRY,
} from "../model-registry.js";

const OPUS_46 = "claude-opus-4-6";
const OPUS_46_1M = "claude-opus-4-6[1m]";
/** 4.6 的完整档位面 —— 与 ROLE_EFFORT_LEVELS 的差别只有少掉 xhigh。 */
const EFFORTS_WITHOUT_XHIGH = ["low", "medium", "high", "max"];

describe("FLY-1650 身份层:注册表收录 Opus 4.6", () => {
	it("MODEL_IDS 暴露 4.6 的两个固定身份", () => {
		expect(MODEL_IDS.OPUS_46).toBe(OPUS_46);
		expect(MODEL_IDS.OPUS_46_1M).toBe(OPUS_46_1M);
	});

	it("注册表含两个 4.6 条目且整体仍合法(无重复 id / alias 冲突)", () => {
		expect(() => assertValidModelRegistry(MODEL_REGISTRY)).not.toThrow();
		const ids = MODEL_REGISTRY.map((entry) => entry.id);
		expect(ids).toContain(OPUS_46);
		expect(ids).toContain(OPUS_46_1M);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("按 id 和 alias 都能解析到同一条目", () => {
		expect(getModelRegistryEntry(OPUS_46)?.id).toBe(OPUS_46);
		expect(getModelRegistryEntry("opus-4-6")?.id).toBe(OPUS_46);
		expect(getModelRegistryEntry(OPUS_46_1M)?.id).toBe(OPUS_46_1M);
		expect(getModelRegistryEntry("opus-4-6-1m")?.id).toBe(OPUS_46_1M);
		expect(getModelRegistryEntry("opus-4-6[1m]")?.id).toBe(OPUS_46_1M);
	});

	it("挂在 runner 面上(phases.qa 的最低要求),并带可读 label", () => {
		for (const id of [OPUS_46, OPUS_46_1M]) {
			expect(getModelRegistryEntry(id)?.surfaces).toContain("runner");
		}
		expect(getModelRegistryEntry(OPUS_46)?.label).toBe("Opus 4.6");
		expect(getModelRegistryEntry(OPUS_46_1M)?.label).toBe("Opus 4.6 (1M)");
	});

	it("试点只在 runner 侧:4.6 不挂 lead 面,Lead 菜单一行不变", () => {
		// founder 明确「Lead 暂不换」。不挂 lead 面 = fleet console 的 Lead
		// 下拉不多出选项,把 Lead 设成 4.6 也会 fail-loud 而非静默接受。
		for (const id of [OPUS_46, OPUS_46_1M]) {
			expect(getModelRegistryEntry(id)?.surfaces).not.toContain("lead");
			expect(isModelSelectionSupported({ surface: "lead", model: id })).toBe(
				false,
			);
			expect(isModelSelectable({ surface: "lead", model: id })).toBe(false);
		}
		const leadIds = buildModelCatalog("lead").providers.flatMap((provider) =>
			provider.models.map((model) => model.id),
		);
		expect(leadIds).not.toContain(OPUS_46);
		expect(leadIds).not.toContain(OPUS_46_1M);

		// 反向对照:runner 面上确实看得见,否则上面的断言可能只是「没注册」。
		const runnerIds = buildModelCatalog("runner").providers.flatMap(
			(provider) => provider.models.map((model) => model.id),
		);
		expect(runnerIds).toContain(OPUS_46);
		expect(runnerIds).toContain(OPUS_46_1M);
	});

	it("dispatch lookup 认 4.6 的 id 与 alias", () => {
		const lookup = buildDispatchLookup(DEFAULT_OPUS_BINDINGS);
		expect(lookup.get(OPUS_46)).toBe(OPUS_46);
		expect(lookup.get("opus-4-6")).toBe(OPUS_46);
		expect(lookup.get(OPUS_46_1M)).toBe(OPUS_46_1M);
	});
});

describe("FLY-1650 档位层:4.6 的 xhigh 必须被排除", () => {
	it.each([OPUS_46, OPUS_46_1M])("%s 的可选档位面都不含 xhigh", (id) => {
		const entry = getModelRegistryEntry(id);
		for (const surface of ["runner", "workflow"] as const) {
			expect(entry?.effortsBySurface[surface]).toEqual(EFFORTS_WITHOUT_XHIGH);
		}
		expect(entry?.effortsBySurface.cron).toEqual([]);
	});

	it.each([OPUS_46, OPUS_46_1M])(
		"%s 请求 xhigh 被明确拒绝,合法档位照常放行",
		(model) => {
			expect(
				isModelSelectionSupported({
					surface: "runner",
					model,
					effort: "xhigh",
				}),
			).toBe(false);
			for (const effort of EFFORTS_WITHOUT_XHIGH) {
				expect(
					isModelSelectionSupported({ surface: "runner", model, effort }),
				).toBe(true);
			}
		},
	);

	it("其余模型的 xhigh 一律不受影响(收窄只按 id,不是全局降级)", () => {
		for (const id of [
			MODEL_IDS.OPUS_5,
			MODEL_IDS.OPUS_5_1M,
			MODEL_IDS.OPUS_48,
			MODEL_IDS.FABLE,
			MODEL_IDS.SONNET_5,
		]) {
			expect(getModelRegistryEntry(id)?.effortsBySurface.runner).toContain(
				"xhigh",
			);
		}
	});

	it("即使将来把 opus 档绑到 4.6,registry 不撞车且档位仍不含 xhigh", () => {
		// FLY-1467 的设计是「升级/回滚唯一要动 DEFAULT_OPUS_BINDINGS」。
		// 那条路径必须不能让 4.6 拿回 xhigh,也不能因重复 id 在 import 时抛错。
		const bindings: DefaultOpusBindings = {
			opus: MODEL_IDS.OPUS_46,
			opus1m: MODEL_IDS.OPUS_46_1M,
		};
		const registry = buildModelRegistry(bindings);
		expect(() => assertValidModelRegistry(registry)).not.toThrow();

		const bound = registry.find((entry) => entry.id === OPUS_46);
		expect(bound?.aliases).toContain("opus");
		expect(bound?.effortsBySurface.runner).toEqual(EFFORTS_WITHOUT_XHIGH);
		expect(buildDispatchLookup(bindings).get("opus")).toBe(OPUS_46);
	});
});

/**
 * Codex R1 HIGH/MEDIUM:光有注册表元数据不算「拒绝」—— effort 来自与 model
 * **不同**的来源(`roles.runner.effort`、workflow 节点、Lead 启动参数),在
 * 最终 spawn 那一段是被原样 append 上去的。所以收口必须落在**优先级解析完
 * 之后**的那个 seam 上,否则 4.6 + xhigh 照样透传成 400。
 */
describe("FLY-1650 收口层:resolveAllowedEffort(最终 seam)", () => {
	it("4.6 + xhigh → 丢弃并出声,不透传", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(
			resolveAllowedEffort(OPUS_46_1M, "xhigh", { surface: "runner" }),
		).toBeNull();
		expect(warn.mock.calls.flat().join(" ")).toMatch(/xhigh/);
		warn.mockRestore();
	});

	it("4.6 + 合法档位 → 原样放行", () => {
		for (const effort of EFFORTS_WITHOUT_XHIGH) {
			expect(resolveAllowedEffort(OPUS_46, effort, { surface: "runner" })).toBe(
				effort,
			);
		}
	});

	it("其它模型不受影响 —— Opus 5 / Fable 的 xhigh 照常放行", () => {
		for (const model of [MODEL_IDS.OPUS_5_1M, MODEL_IDS.FABLE]) {
			expect(resolveAllowedEffort(model, "xhigh", { surface: "runner" })).toBe(
				"xhigh",
			);
		}
	});

	it("只收窄、不新增门:未知模型 / 无 model / 无 effort 一律保持原状", () => {
		// 这里是字节兼容的关键 —— 收口不能把「注册表不认识」变成「不许有 effort」。
		expect(
			resolveAllowedEffort("claude-not-a-model", "xhigh", {
				surface: "runner",
			}),
		).toBe("xhigh");
		expect(
			resolveAllowedEffort(undefined, "xhigh", { surface: "runner" }),
		).toBe("xhigh");
		expect(
			resolveAllowedEffort(OPUS_46, undefined, { surface: "runner" }),
		).toBe(null);
		expect(resolveAllowedEffort(OPUS_46, "   ", { surface: "runner" })).toBe(
			null,
		);
	});

	it("Lead 启动也走同一收口(4.6 一旦成为默认 opus 档时的那条路)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Lead 面对 4.6 本就不可用 → 走既有的可用性兜底换成 Fable,
		// 而 Fable 支持 xhigh,所以 effort 保留。
		const substituted = resolveLeadLaunchSelection(OPUS_46, "xhigh");
		expect(substituted.model).toBe(MODEL_IDS.FABLE);
		expect(substituted.effort).toBe("xhigh");

		// 正常 Lead 模型 + 合法 effort:逐字不变。
		const normal = resolveLeadLaunchSelection(MODEL_IDS.OPUS_5, "xhigh");
		expect(normal).toEqual({
			model: MODEL_IDS.OPUS_5,
			effort: "xhigh",
			substituted: false,
			reason: "configured",
		});
		warn.mockRestore();
	});
});

describe("FLY-1650 配置层:Opus 4.6 overlay 档位收窄", () => {
	let root: string;
	let configPath: string;
	let previousPath: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly1650-opus46-"));
		configPath = join(root, "models.json");
		previousPath = process.env.FLYWHEEL_MODELS_CONFIG;
		process.env.FLYWHEEL_MODELS_CONFIG = configPath;
		resetModelConfigCacheForTests();
	});

	afterEach(() => {
		if (previousPath === undefined) {
			delete process.env.FLYWHEEL_MODELS_CONFIG;
		} else {
			process.env.FLYWHEEL_MODELS_CONFIG = previousPath;
		}
		resetModelConfigCacheForTests();
		rmSync(root, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function writeConfig(config: unknown): void {
		writeFileSync(configPath, JSON.stringify(config));
		resetModelConfigCacheForTests();
	}

	it("overlay 声明成 codex vendor 也拿不回 xhigh(Codex R1 MEDIUM)", () => {
		// codex-runner 那条特例分支原来直接写死 ["xhigh"],绕过了按 id 的收窄。
		vi.spyOn(console, "warn").mockImplementation(() => {});
		writeConfig({
			version: 1,
			models: [
				{
					id: OPUS_46,
					label: "Opus 4.6",
					provider: "anthropic",
					runtimeVendor: "codex",
					aliases: [],
				},
			],
		});

		const runner =
			getModelConfigSnapshot().getModelRegistryEntry(OPUS_46)?.effortsBySurface
				.runner;
		expect(runner).not.toContain("xhigh");
	});

	it("overlay 让 4.6 上了 lead 面时,Lead 启动仍丢掉 xhigh(Codex R1 MEDIUM)", () => {
		// overlay 不带 surfaces ⇒ 拿默认四个受管面(含 lead),这是今天就能写出来
		// 的配置。此时 Lead 能解析到 4.6,收口必须在 effort 上兜住。
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		writeConfig({
			version: 1,
			models: [
				{
					id: OPUS_46,
					label: "Opus 4.6",
					provider: "anthropic",
					runtimeVendor: "claude",
					aliases: [],
				},
			],
		});

		const snapshot = getModelConfigSnapshot();
		expect(snapshot.getModelRegistryEntry(OPUS_46)?.surfaces).toContain("lead");

		const selection = resolveLeadLaunchSelection(OPUS_46, "xhigh", snapshot);
		expect(selection.model).toBe(OPUS_46);
		expect(selection.effort).toBeNull();
		expect(warn.mock.calls.flat().join(" ")).toMatch(/xhigh/);

		// 对照:同一 snapshot 下合法档位原样保留,证明不是把 effort 一律清空。
		expect(resolveLeadLaunchSelection(OPUS_46, "high", snapshot).effort).toBe(
			"high",
		);
	});

	it("models.json overlay 重新声明 4.6 也拿不回 xhigh", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		writeConfig({
			version: 1,
			models: [
				{
					id: OPUS_46_1M,
					label: "Opus 4.6 (1M)",
					provider: "anthropic",
					runtimeVendor: "claude",
					aliases: [],
				},
			],
		});

		const snapshot = getModelConfigSnapshot();
		expect(
			snapshot.getModelRegistryEntry(OPUS_46_1M)?.effortsBySurface.runner,
		).toEqual(EFFORTS_WITHOUT_XHIGH);
	});
});
