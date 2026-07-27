import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import { ACTIVATIONS_PROCESSING_ATTEMPTS_DDL } from "../migrations/0003-activations-processing-attempts.js";
import { MAILBOX_INDEX_FAMILY_DDL } from "../migrations/0004-mailbox-index-family.js";
import { runMigrations } from "../migrator.js";
import { CANDIDATE_SQL, DETECTOR_SQL } from "../sql/candidates.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";

const DESIGN_V8_PATH = fileURLToPath(
	new URL(
		"../../../../doc/engineer/plan/v2/design-chain/design-v8.md",
		import.meta.url,
	),
);
const DESIGN_V9_PATH = fileURLToPath(
	new URL(
		"../../../../doc/engineer/plan/v2/design-chain/design-v9.md",
		import.meta.url,
	),
);
const DESIGN_V10_PATH = fileURLToPath(
	new URL(
		"../../../../doc/engineer/plan/v2/design-chain/design-v10.md",
		import.meta.url,
	),
);

function sqlBlockAfter(document: string, marker: string): string {
	const markerOffset = document.indexOf(marker);
	if (markerOffset < 0) {
		throw new Error(`missing design marker: ${marker}`);
	}
	const tail = document.slice(markerOffset);
	const match = tail.match(/```sql\n([\s\S]*?)\n```/);
	if (!match?.[1]) {
		throw new Error(`missing SQL block after: ${marker}`);
	}
	return match[1];
}

describe("canonical candidate SQL and query plans", () => {
	let temp: TempDatabase | undefined;

	afterEach(() => {
		temp?.cleanup();
		temp = undefined;
	});

	it("keeps all four candidate SELECTs and the detector byte-identical to the design chain", () => {
		const designV10 = readFileSync(DESIGN_V10_PATH, "utf8");
		const candidateBlock = sqlBlockAfter(
			designV10,
			"四条候选 SQL(原样入迁移与 query-plan 测试",
		);
		expect(candidateBlock).toBe(
			[
				CANDIDATE_SQL.F1,
				CANDIDATE_SQL.F2,
				CANDIDATE_SQL.N1,
				CANDIDATE_SQL.N2,
			].join("\n"),
		);

		const designV8 = readFileSync(DESIGN_V8_PATH, "utf8");
		expect(sqlBlockAfter(designV8, "**detector exact SQL**")).toBe(
			DETECTOR_SQL,
		);
	});

	it("keeps the seven-index family byte-identical to design SQL", () => {
		const designV9 = readFileSync(DESIGN_V9_PATH, "utf8");
		const archived = sqlBlockAfter(designV9, "**七个 partial index**")
			.split("\n")
			.filter((line) => !line.startsWith("--"))
			.join("\n");
		expect(MAILBOX_INDEX_FAMILY_DDL).toBe(archived);
	});

	it("limits the v9 two-table DDL delta to the two NOT NULL primary-key corrections", () => {
		const designV9 = readFileSync(DESIGN_V9_PATH, "utf8");
		const activations = sqlBlockAfter(
			designV9,
			"### 1.6 activations(可执行 DDL)",
		).replace("id TEXT PRIMARY KEY,", "id TEXT PRIMARY KEY NOT NULL,");
		const processingAttempts = sqlBlockAfter(
			designV9,
			"### 1.2d processing_attempts",
		).replace(
			"attempt_uid TEXT PRIMARY KEY,",
			"attempt_uid TEXT PRIMARY KEY NOT NULL,",
		);
		expect(ACTIVATIONS_PROCESSING_ATTEMPTS_DDL).toBe(
			`${activations}\n\n${processingAttempts}`,
		);
	});

	it.each([
		["F1", CANDIDATE_SQL.F1, "mailbox_pending_immediate_f"],
		["F2", CANDIDATE_SQL.F2, "mailbox_pending_scheduled_f"],
		["N1", CANDIDATE_SQL.N1, "mailbox_pending_immediate_nf"],
		["N2", CANDIDATE_SQL.N2, "mailbox_pending_scheduled_nf"],
		["detector", DETECTOR_SQL, "mailbox_pending_age"],
	])(
		"uses the required index without a temporary sort for %s",
		(_name, sql, expectedIndex) => {
			temp = makeTempDatabase();
			const db = openKernelDb({ path: temp.path });
			try {
				runMigrations(db);
				const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({
					agent: "runner-1",
					now: "2026-07-27T00:00:00.000Z",
					cutoff: "2026-07-27T00:00:00.000Z",
				}) as { detail: string }[];
				const details = plan.map((row) => row.detail);
				expect(
					details.some(
						(detail) =>
							detail.includes("SEARCH") && detail.includes(expectedIndex),
					),
					details.join("\n"),
				).toBe(true);
				expect(
					details.some((detail) => detail.includes("USE TEMP B-TREE")),
					details.join("\n"),
				).toBe(false);
			} finally {
				db.close();
			}
		},
	);
});
