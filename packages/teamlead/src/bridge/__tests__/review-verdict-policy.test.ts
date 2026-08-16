import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	computeEffectiveVerdict,
	findingFingerprint,
	isNonBlockingSeverity,
	type ReviewFindingRulingSnapshot,
} from "../review-verdict-policy.js";

describe("FLY-1278 review verdict policy", () => {
	it.each([
		["MEDIUM", true],
		[" medium ", true],
		["LOW", true],
		["high", false],
		["Critical", false],
		[undefined, false],
	])("classifies severity %j fail-closed", (severity, expected) => {
		expect(isNonBlockingSeverity(severity)).toBe(expected);
	});

	it("downgrades an all-advisory CHANGES verdict but keeps real blockers closed", () => {
		const advisory = computeEffectiveVerdict({
			reviewerVerdict: "CHANGES_REQUESTED",
			findings: [{ severity: "MEDIUM", file: "a.ts", title: "optimize" }],
			reviewType: "code",
			rulings: [],
			enabled: true,
		});
		expect(advisory.effectiveVerdict).toBe("APPROVED");
		expect(advisory.advisories).toHaveLength(1);
		expect(advisory.findings[0]).toMatchObject({
			findingKey: findingFingerprint("a.ts", "optimize"),
		});

		for (const findings of [
			[{ severity: "HIGH", title: "auth bug" }],
			[{ severity: "unknown", title: "unclassified" }],
			[{ title: "missing severity" }],
			[],
		]) {
			const result = computeEffectiveVerdict({
				reviewerVerdict: "CHANGES_REQUESTED",
				findings,
				reviewType: "code",
				rulings: [],
				enabled: true,
			});
			expect(result.effectiveVerdict).toBe("CHANGES_REQUESTED");
		}
	});

	it("never tightens reviewer APPROVED and still relays MEDIUM/LOW advisories", () => {
		const result = computeEffectiveVerdict({
			reviewerVerdict: "APPROVED",
			findings: [
				{ severity: "MEDIUM", title: "performance" },
				{ severity: "LOW", title: "nit" },
				{ severity: "HIGH", title: "anomalous high" },
				{ title: "anomalous unknown" },
			],
			reviewType: "design",
			rulings: [],
			enabled: true,
		});

		expect(result.effectiveVerdict).toBe("APPROVED");
		expect(result.advisories.map((finding) => finding.title)).toEqual([
			"performance",
			"nit",
		]);
		expect(result.findings).toHaveLength(4);
	});

	it("matches settled findings by id, explicit dispute, or fingerprint and ignores revoked/wrong-type rulings", () => {
		const rulings: ReviewFindingRulingSnapshot[] = [
			ruling("stable-id", "code"),
			ruling(findingFingerprint("b.ts", "fingerprinted"), "code"),
			{ ...ruling("revoked-id", "code"), revokedAt: "2026-07-15" },
			ruling("design-only", "design"),
		];
		const result = computeEffectiveVerdict({
			reviewerVerdict: "CHANGES_REQUESTED",
			findings: [
				{ id: "stable-id", severity: "HIGH", title: "same issue" },
				{
					id: "new-reviewer-id",
					disputesRuling: "stable-id",
					severity: "HIGH",
					title: "new evidence",
				},
				{ severity: "MEDIUM", file: "b.ts", title: "fingerprinted" },
				{ id: "revoked-id", severity: "HIGH", title: "active again" },
				{ id: "design-only", severity: "HIGH", title: "wrong lane" },
			],
			reviewType: "code",
			rulings,
			enabled: true,
		});

		expect(result.settled).toHaveLength(3);
		expect(result.disputes).toHaveLength(2);
		expect(result.disputes.map((entry) => entry.kind).sort()).toEqual([
			"automatic",
			"explicit",
		]);
		expect(result.effectiveVerdict).toBe("CHANGES_REQUESTED");
	});

	it("policy-off is a complete verdict/classification bypass", () => {
		const finding = { id: "settled", severity: "MEDIUM", title: "advice" };
		const result = computeEffectiveVerdict({
			reviewerVerdict: "CHANGES_REQUESTED",
			findings: [finding],
			reviewType: "code",
			rulings: [ruling("settled", "code")],
			enabled: false,
		});

		expect(result.effectiveVerdict).toBe("CHANGES_REQUESTED");
		expect(result.findings).toEqual([finding]);
		expect(result.advisories).toEqual([]);
		expect(result.settled).toEqual([]);
		expect(result.disputes).toEqual([]);
	});
});

describe("FLY-1251 production R6-R9 replay", () => {
	const fixturePath = fileURLToPath(
		new URL(
			"../../../../../engineering/doc/FLY-1278-review-gate-convergence/fixtures/fly-1251-rounds-6-9.json",
			import.meta.url,
		),
	);
	const rows = JSON.parse(readFileSync(fixturePath, "utf8")) as Array<{
		round: number;
		verdict: "CHANGES_REQUESTED";
		findings_json: string;
	}>;

	it("converges every recorded MEDIUM-only round when enabled", () => {
		expect(rows.map((row) => row.round)).toEqual([6, 7, 8, 9]);
		for (const row of rows) {
			const findings = JSON.parse(row.findings_json);
			const result = computeEffectiveVerdict({
				reviewerVerdict: row.verdict,
				findings,
				reviewType: "code",
				rulings: [],
				enabled: true,
			});
			expect(result.effectiveVerdict, `round ${row.round}`).toBe("APPROVED");
			expect(result.advisories, `round ${row.round}`).toEqual(result.findings);
		}
	});

	it("reproduces the old non-converging sequence when disabled", () => {
		const verdicts = rows.map(
			(row) =>
				computeEffectiveVerdict({
					reviewerVerdict: row.verdict,
					findings: JSON.parse(row.findings_json),
					reviewType: "code",
					rulings: [],
					enabled: false,
				}).effectiveVerdict,
		);
		expect(verdicts).toEqual([
			"CHANGES_REQUESTED",
			"CHANGES_REQUESTED",
			"CHANGES_REQUESTED",
			"CHANGES_REQUESTED",
		]);
	});
});

function ruling(
	findingKey: string,
	reviewType: "design" | "code",
): ReviewFindingRulingSnapshot {
	return {
		rulingId: `ruling-${findingKey}`,
		findingKey,
		reviewType,
		disposition: "overruled",
		rationale: "Lead settled this finding",
		createdAt: "2026-07-15 00:00:00",
	};
}
