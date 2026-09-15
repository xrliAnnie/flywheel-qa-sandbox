import { expect, it } from "vitest";
import { judgmentSummary } from "../../epic-page/audit-dictionary.js";
import { canonicalDigest } from "../contract.js";
import { readEpicJudgment } from "../epic-facts.js";
import {
	buildEvidenceLedger,
	EVIDENCE_POLICY_VERSION,
} from "../evidence-ledger.js";
import { renderHistoryPage } from "../history-pages.js";
import { ShipJudgmentHistory } from "../history-query.js";
import { bindingFixture, CHANNEL, NOW } from "./binding-fixture.js";
import { evidenceMaterials } from "./evidence-fixture.js";

it("carries three labels and precise missing evidence into Epic and history, without reference ID details", async () => {
	const { store, db } = await bindingFixture();
	try {
		const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
		const materials = evidenceMaterials(binding, NOW);
		delete materials.targets[0]!.qaAuthority;
		const evidence = buildEvidenceLedger(materials, binding);
		store.getShipJudgmentOpinions().offer(
			{
				questionId: "q",
				channelId: CHANNEL,
				bindingDigest: canonicalDigest(binding),
				inputId: null,
				reason: "evidence_only",
				mechanical: materials.mechanical,
				evidence,
			},
			Date.parse(NOW),
		);
		const value = readEpicJudgment(db, "flywheel", [binding.issueId]).value!;
		expect(value.policy_version).toBe(EVIDENCE_POLICY_VERSION);
		expect(value.points).toMatchObject({
			alignment: "通过",
			conflict: "通过",
			coverage: "缺 QA 判决",
			missing: ["③ QA 判决"],
		});
		const summary = judgmentSummary({
			value,
			observed_at: NOW,
			provenance: {
				kind: "statestore",
				table: "ship_judgment_opinion",
				key: { issue_id: binding.issueId },
			},
		});
		expect(summary).toContain("① 通过");
		expect(summary).toContain("③ 缺 QA 判决");
		const history = new ShipJudgmentHistory(db).read(NOW);
		expect(history.rows[0]!.summary).toContain("① 通过；② 通过；③ 缺 QA 判决");
		const html = renderHistoryPage(history.rows, {
			asOf: NOW,
			page: 1,
			pageCount: 1,
			total: 1,
			reportOrigin: "https://reports.vercel.app",
		});
		expect(html).toContain("③ 缺 QA 判决");
		for (const reference of ["design-r1", "code-r5", "1148"]) {
			expect(html).not.toContain(reference);
			expect(JSON.stringify(value.points)).not.toContain(reference);
		}
	} finally {
		store.close();
	}
});
