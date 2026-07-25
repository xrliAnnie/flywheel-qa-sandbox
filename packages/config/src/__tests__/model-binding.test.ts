/**
 * FLY-1467: 默认 opus 档 fleet-wide 升级到 Opus 5。
 *
 * 这组测试锁定 Annie 的设计原则(2026-07-24 拍板)——
 * **配置只写档位,永不写版本号,版本只存在 model-registry 一处** ——
 * 以及为支撑它所做的「模型身份 ↔ 默认绑定分离」。
 *
 * 关键不变式:
 *  1. MODEL_IDS 只含固定身份(值永不改动)→ registry ID 恒唯一;
 *  2. 升级/回滚**唯一**要动的是 DEFAULT_OPUS_BINDINGS;
 *  3. registry 与 dispatch lookup 都由同一 bindings 经纯工厂构造,
 *     所以两种状态(Opus 5 / 回滚到 4.8)可在**同一次 build 内**注入测试。
 */

import { describe, expect, it } from "vitest";
import {
	assertValidModelRegistry,
	buildDispatchLookup,
	buildModelCatalog,
	buildModelRegistry,
	DEFAULT_OPUS,
	DEFAULT_OPUS_1M,
	DEFAULT_OPUS_BINDINGS,
	type DefaultOpusBindings,
	getModelRegistryEntry,
	isModelSelectable,
	isModelSelectionSupported,
	MODEL_IDS,
} from "../model-registry.js";

/** 回滚态 bindings —— 与生产态唯一的差别就是这两行。 */
const ROLLBACK_BINDINGS: DefaultOpusBindings = {
	opus: MODEL_IDS.OPUS_48,
	opus1m: MODEL_IDS.OPUS_48_1M,
};

describe("FLY-1467 身份层:MODEL_IDS 只含固定身份", () => {
	it("四个 Opus 身份常量的值是固定的", () => {
		expect(MODEL_IDS.OPUS_5).toBe("claude-opus-5");
		expect(MODEL_IDS.OPUS_5_1M).toBe("claude-opus-5[1m]");
		expect(MODEL_IDS.OPUS_48).toBe("claude-opus-4-8");
		expect(MODEL_IDS.OPUS_48_1M).toBe("claude-opus-4-8[1m]");
	});

	it("不得再有可变的默认成员(OPUS / OPUS_1M)", () => {
		// 这两个名字曾经既是身份又是默认,是 FLY-1467 之前回滚会撞
		// registry 重复 id 的根因。identity-only 不变式禁止它们回来。
		expect("OPUS" in MODEL_IDS).toBe(false);
		expect("OPUS_1M" in MODEL_IDS).toBe(false);
	});
});

describe("FLY-1467 绑定层:默认指向 Opus 5", () => {
	it("生产 binding 指向 Opus 5 / Opus 5 (1M)", () => {
		expect(DEFAULT_OPUS).toBe(MODEL_IDS.OPUS_5);
		expect(DEFAULT_OPUS_1M).toBe(MODEL_IDS.OPUS_5_1M);
	});

	it("DEFAULT_OPUS / DEFAULT_OPUS_1M 与 DEFAULT_OPUS_BINDINGS 一致(防漂移)", () => {
		expect(DEFAULT_OPUS).toBe(DEFAULT_OPUS_BINDINGS.opus);
		expect(DEFAULT_OPUS_1M).toBe(DEFAULT_OPUS_BINDINGS.opus1m);
	});
});

describe.each([
	[
		"生产态(Opus 5)",
		DEFAULT_OPUS_BINDINGS,
		MODEL_IDS.OPUS_5,
		MODEL_IDS.OPUS_5_1M,
	],
	[
		"回滚态(Opus 4.8)",
		ROLLBACK_BINDINGS,
		MODEL_IDS.OPUS_48,
		MODEL_IDS.OPUS_48_1M,
	],
] as const)("FLY-1467 双态:%s", (_label, bindings, boundOpus, boundOpus1m) => {
	const registry = buildModelRegistry(bindings);
	const lookup = buildDispatchLookup(bindings);

	it("registry 合法:ID 唯一、alias 不冲突", () => {
		// 回滚态曾经会因 legacy 条目与主条目同 id 而在 import 时抛错。
		expect(() => assertValidModelRegistry(registry)).not.toThrow();
	});

	it("registry 恒含四个 Opus 身份条目", () => {
		const ids = registry.map((e) => e.id);
		for (const id of [
			MODEL_IDS.OPUS_5,
			MODEL_IDS.OPUS_5_1M,
			MODEL_IDS.OPUS_48,
			MODEL_IDS.OPUS_48_1M,
		]) {
			expect(ids).toContain(id);
		}
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("opus / opus-1m alias 挂在被绑定的条目上", () => {
		expect(lookup.get("opus")).toBe(boundOpus);
		expect(lookup.get("opus-1m")).toBe(boundOpus1m);
	});

	it("被绑定的条目在 catalog 里可见(回滚态下真默认档不会消失)", () => {
		// R4-MEDIUM:selectable 按「是否被绑定」派生,不按「是不是 legacy」写死。
		const catalog = buildModelCatalog("lead", bindings);
		const ids = catalog.providers.flatMap((p) => p.models.map((m) => m.id));
		expect(ids).toContain(boundOpus);
	});
});

describe("FLY-1467 旧字面量向后兼容(dispatch 边界)", () => {
	const lookup = buildDispatchLookup(DEFAULT_OPUS_BINDINGS);

	it.each([MODEL_IDS.OPUS_48, MODEL_IDS.OPUS_48_1M])(
		"%s 仍被 dispatch lookup 原样接受",
		(legacyId) => {
			expect(lookup.get(legacyId)).toBe(legacyId);
		},
	);

	it("未知拼写仍 fail-loud", () => {
		expect(lookup.get("claude-opus-99-nonexistent")).toBeUndefined();
	});

	it("旧 4.8 条目仍可解析(token 报告 / 历史 current value 需要)", () => {
		expect(getModelRegistryEntry(MODEL_IDS.OPUS_48)?.id).toBe(
			MODEL_IDS.OPUS_48,
		);
	});
});

describe("FLY-1467 运行时可接受 ≠ 可被新选(R2/R4)", () => {
	it("legacy 4.8 保留 workflow 运行时 surface(已发布 revision 不能挂)", () => {
		expect(
			isModelSelectionSupported({
				surface: "workflow",
				model: MODEL_IDS.OPUS_48,
			}),
		).toBe(true);
	});

	it("legacy 4.8 默认不可被新选(决策 4 = 否)", () => {
		expect(
			isModelSelectable({ surface: "workflow", model: MODEL_IDS.OPUS_48 }),
		).toBe(false);
	});

	it("当前默认 Opus 5 既可接受也可被新选", () => {
		expect(
			isModelSelectionSupported({ surface: "workflow", model: DEFAULT_OPUS }),
		).toBe(true);
		expect(
			isModelSelectable({ surface: "workflow", model: DEFAULT_OPUS }),
		).toBe(true);
	});
});
