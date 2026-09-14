import type Database from "better-sqlite3";
import { z } from "zod";
import { historyRowSchema } from "./history-pages.js";
import { ShipJudgmentHistory } from "./history-query.js";
import { ShipJudgmentHistoryState } from "./history-state.js";
export const epicHistorySchema = z
	.object({
		rows: z.array(historyRowSchema).max(20),
		total: z.number().int().min(0),
		url: z
			.string()
			.url()
			.refine((value) => new URL(value).protocol === "https:")
			.nullable(),
		publishedAsOf: z.string().datetime().nullable(),
		error: z.string().nullable(),
		dirty: z.boolean(),
		readError: z.boolean(),
	})
	.strict();
export type EpicHistory = z.infer<typeof epicHistorySchema>;
/** Synchronous local snapshot; publishing is exclusively the independent history worker. */
export function readEpicHistory(
	db: Database.Database,
	asOf: string,
): EpicHistory {
	try {
		return db.transaction(() => {
			const published = new ShipJudgmentHistoryState(db).view();
			const base = {
				url: published.url,
				publishedAsOf: published.asOf,
				error: published.error,
				dirty: published.dirty,
			};
			try {
				const snapshot = new ShipJudgmentHistory(db).read(asOf);
				return epicHistorySchema.parse({
					...base,
					rows: snapshot.rows.slice(0, 20),
					total: snapshot.rows.length,
					readError: false,
				});
			} catch {
				return epicHistorySchema.parse({
					...base,
					rows: [],
					total: 0,
					readError: true,
				});
			}
		})();
	} catch {
		return {
			rows: [],
			total: 0,
			url: null,
			publishedAsOf: null,
			error: "history_state_unavailable",
			dirty: false,
			readError: true,
		};
	}
}
