import type Database from "better-sqlite3";

type PublishedState = {
	published_url: string | null;
	published_as_of: string | null;
	last_error: string | null;
	history_dirty: number;
};

/** Read-only compatibility view for legacy publication metadata on Epic snapshots. */
export class ShipJudgmentHistoryState {
	constructor(private readonly db: Database.Database) {}

	view() {
		const row = this.db
			.prepare(
				"SELECT published_url,published_as_of,last_error,history_dirty FROM ship_judgment_project_state WHERE project_name='flywheel'",
			)
			.get() as PublishedState | undefined;
		return {
			url: row?.published_url ?? null,
			asOf: row?.published_as_of ?? null,
			error: row?.last_error ?? null,
			dirty: row?.history_dirty === 1,
		};
	}
}
