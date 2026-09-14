import { expect, it } from "vitest";
import { bindingFixture, NOW } from "./binding-fixture.js";

it("reads a bounded Epic preview and retains the last publication when history reads fail", async () => {
	const { store, db } = await bindingFixture();
	try {
		const before = db.prepare("SELECT total_changes() AS n").get();
		const preview = store.getEpicShipJudgmentHistory(NOW);
		expect(preview).toMatchObject({
			total: 1,
			rows: [{ questionId: "q" }],
			url: null,
			readError: false,
		});
		expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
		db.prepare(
			"INSERT INTO ship_judgment_project_state(project_name,published_url,published_as_of,last_error) VALUES('flywheel',?,?,?) ON CONFLICT(project_name) DO UPDATE SET published_url=excluded.published_url,published_as_of=excluded.published_as_of,last_error=excluded.last_error",
		).run("https://reports.example/r/old", NOW, "history_round_failed");
		db.exec("DROP TABLE ship_judgment_opinion");
		expect(store.getEpicShipJudgmentHistory(NOW)).toMatchObject({
			total: 0,
			rows: [],
			url: "https://reports.example/r/old",
			publishedAsOf: NOW,
			error: "history_round_failed",
			readError: true,
		});
		db.exec("DROP TABLE ship_judgment_project_state");
		expect(store.getEpicShipJudgmentHistory(NOW)).toMatchObject({
			rows: [],
			url: null,
			error: "history_state_unavailable",
			readError: true,
		});
	} finally {
		store.close();
	}
});
