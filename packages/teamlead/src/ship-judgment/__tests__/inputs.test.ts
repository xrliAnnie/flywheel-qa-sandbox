import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../contract.js";
import { ShipJudgmentInputs } from "../inputs.js";
import { bindingFixture, CHANNEL, HEAD, NOW } from "./binding-fixture.js";

function packet(bindingDigest: string) {
	return {
		questionId: "q",
		channelId: CHANNEL,
		bindingDigest,
		targets: [
			{
				repo_identity: "__main__",
				pr_number: 2399,
				head_sha: HEAD,
				diff_base_sha: "b".repeat(40),
			},
		],
		sources: [
			{ source_id: "plan", kind: "plan", revision: "blob:123", text: "需求一" },
		],
		files: [{ repo_identity: "__main__", path: "src/index.ts" }],
		requirements: [
			{ requirement_id: "R1", source_id: "plan", quote_start: 0, quote_end: 3 },
		],
		prompt: "Evaluate alignment and coverage.",
		model: {
			model: "claude-opus-5",
			effort: "high",
			configuration_digest: "c".repeat(64),
		},
	};
}

describe("frozen judgment input", () => {
	it("freezes one immutable semantic version and enqueues atomically, replaying identical material", async () => {
		const { store, db } = await bindingFixture();
		try {
			const inputs = new ShipJudgmentInputs(db, (q, c) =>
				store.readShipJudgmentBinding(q, c),
			);
			const binding = store.readShipJudgmentBinding("q", CHANNEL);
			const data = packet(canonicalDigest(binding));
			data.files.push({ repo_identity: "__main__", path: "src/second.ts" });
			const first = inputs.freeze(data, NOW);
			expect(first.status).toBe("created");
			if (first.status !== "created") throw new Error(first.status);
			expect(inputs.freeze(data, NOW)).toEqual({
				status: "existing",
				inputId: first.inputId,
			});
			data.files.reverse();
			expect(inputs.freeze(data, NOW)).toEqual({
				status: "existing",
				inputId: first.inputId,
			});
			data.sources[0]!.text = "调用者改写";
			expect(inputs.get(first.inputId)?.sources[0]?.text).toBe("需求一");
			expect(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM ship_judgment_job WHERE state='queued'",
					)
					.get(),
			).toEqual({ n: 1 });
			for (const text of ["需求二", "需求三"]) {
				data.sources[0]!.text = text;
				expect(inputs.freeze(data, NOW).status).toBe("created");
			}
			data.sources[0]!.text = "需求四";
			expect(inputs.freeze(data, NOW)).toEqual({ status: "card_budget" });
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_input").get(),
			).toEqual({ n: 3 });
		} finally {
			store.close();
		}
	});
	it("rechecks current binding before any insert and rejects incomplete target sets", async () => {
		const { store, db } = await bindingFixture();
		try {
			const inputs = new ShipJudgmentInputs(db, (q, c) =>
				store.readShipJudgmentBinding(q, c),
			);
			const data = packet(
				canonicalDigest(store.readShipJudgmentBinding("q", CHANNEL)),
			);
			data.targets[0]!.head_sha = "d".repeat(40);
			expect(inputs.freeze(data, NOW)).toEqual({ status: "binding_changed" });
			data.targets[0]!.head_sha = HEAD;
			db.prepare(
				"UPDATE workflow_gate_holder SET card_message_id='123456789012345680'",
			).run();
			expect(inputs.freeze(data, NOW)).toEqual({ status: "binding_changed" });
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_input").get(),
			).toEqual({ n: 0 });
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_job").get(),
			).toEqual({ n: 0 });
		} finally {
			store.close();
		}
	});
	it("rejects oversized, ambiguous, and fabricated requirement sources without truncation", async () => {
		const { store, db } = await bindingFixture();
		try {
			const inputs = new ShipJudgmentInputs(db, (q, c) =>
				store.readShipJudgmentBinding(q, c),
			);
			const data = packet(
				canonicalDigest(store.readShipJudgmentBinding("q", CHANNEL)),
			);
			expect(
				inputs.freeze({ ...data, prompt: "x".repeat(98_304) }, NOW),
			).toEqual({ status: "input_budget_exceeded" });
			expect(() =>
				inputs.freeze(
					{ ...data, sources: [...data.sources, ...data.sources] },
					NOW,
				),
			).toThrow(/duplicate_source/);
			expect(() =>
				inputs.freeze(
					{
						...data,
						requirements: [{ ...data.requirements[0], source_id: "invented" }],
					},
					NOW,
				),
			).toThrow(/requirement_source/);
			expect(() =>
				inputs.freeze(
					{
						...data,
						files: [{ repo_identity: "__main__", path: "../secret" }],
					},
					NOW,
				),
			).toThrow();
			expect(
				db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_input").get(),
			).toEqual({ n: 0 });
		} finally {
			store.close();
		}
	});
});
