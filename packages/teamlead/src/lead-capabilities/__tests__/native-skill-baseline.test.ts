import { describe, expect, it } from "vitest";
import {
	PINNED_NATIVE_CODEX_SKILLS,
	resolvePinnedNativeSkillBaseline,
} from "../native-skill-baseline.js";

const ORIGIN_ROOT =
	"/Users/xiaorongli/.codex-259-qa/packages/native-skill-baselines";

describe("version-keyed native Codex skill baselines", () => {
	it("pins the target release while retaining exact transition and rollback versions", () => {
		expect(PINNED_NATIVE_CODEX_SKILLS.codexVersion).toBe("0.156.0");
		expect(resolvePinnedNativeSkillBaseline("0.153.2")).toMatchObject({
			codexVersion: "0.153.2",
			origin: { root: `${ORIGIN_ROOT}/0.153.2/skills/.system` },
		});
		expect(resolvePinnedNativeSkillBaseline("0.154.0")).toMatchObject({
			codexVersion: "0.154.0",
			origin: { root: `${ORIGIN_ROOT}/0.154.0/skills/.system` },
		});
		expect(resolvePinnedNativeSkillBaseline("0.156.0")).toMatchObject({
			codexVersion: "0.156.0",
			origin: { root: `${ORIGIN_ROOT}/0.156.0/skills/.system` },
		});
	});

	it("binds 0.153.2 to the old tree and 0.154.0/0.156.0 to the measured new tree", () => {
		const sourceHash = (version: string, name: string) =>
			resolvePinnedNativeSkillBaseline(version).sources.find(
				(source) => source.name === name,
			)?.sha256;

		expect(sourceHash("0.153.2", "openai-docs")).toBe(
			"7cb8fa1b2a0c635b5c61ffe1da7b8594a7ea0fce5b71e8d523e2025d88b2a05e",
		);
		expect(sourceHash("0.154.0", "openai-docs")).toBe(
			"aa6829e21df2223167c85d2e49b6337a7345c84c1033f1ec10182c7882b36d45",
		);
		expect(sourceHash("0.156.0", "openai-docs")).toBe(
			sourceHash("0.154.0", "openai-docs"),
		);
	});

	it("fails closed for every unreviewed version", () => {
		for (const version of [
			"",
			"0.153.3",
			"0.155.0",
			"0.157.0",
			"constructor",
			"toString",
			"__proto__",
		]) {
			expect(() => resolvePinnedNativeSkillBaseline(version)).toThrow(
				"baseline_drift",
			);
		}
	});
});
