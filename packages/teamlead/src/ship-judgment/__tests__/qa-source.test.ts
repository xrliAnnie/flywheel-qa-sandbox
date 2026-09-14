import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type QaEvidenceRow, readHostedQaSource } from "../qa-source.js";

describe("frozen hosted QA source", () => {
	it("reads only the newest exact target record and checks retained bytes, never falling back to an older PASS", () => {
		const body = "<h1>QA</h1><p>case A: FAIL</p>";
		const row: QaEvidenceRow = {
			record_id: "r1",
			recorded_at: "2026-09-10T00:00:00Z",
			run_id: "run",
			target_repo_identity: "repo",
			head_sha: "a".repeat(40),
			record_url: `https://fw-reports-test.vercel.app/r/${"b".repeat(32)}/`,
			record_url_kind: "hosted_report",
			record_status: "satisfied",
			record_digest: createHash("sha256").update(body).digest("hex"),
			record_bytes: Buffer.byteLength(body),
		};
		const readReportHtml = vi.fn(() => body);
		const request = {
			runId: "run",
			repoIdentity: "repo",
			headSha: row.head_sha,
		};
		const options = { vercelProjectName: "fw-reports-test" };
		expect(
			readHostedQaSource(request, [row], { readReportHtml }, options),
		).toMatchObject({
			body,
			digest: row.record_digest,
			revision: "r1",
			withdrawn: false,
		});
		expect(readReportHtml).toHaveBeenCalledWith("b".repeat(32));
		const newer = {
			...row,
			record_id: "r2",
			recorded_at: "2026-09-10T00:01:00Z",
			record_status: "unsatisfied" as const,
		};
		expect(
			readHostedQaSource(request, [newer, row], { readReportHtml }, options),
		).toBeNull();
		for (const changed of [
			{ run_id: "other" },
			{ head_sha: "c".repeat(40) },
			{ target_repo_identity: "other" },
			{ record_digest: "d".repeat(64) },
			{ record_bytes: 1 },
			{ record_url: row.record_url.replace("fw-reports-test", "attacker") },
		])
			expect(
				readHostedQaSource(
					request,
					[{ ...row, ...changed }],
					{ readReportHtml },
					options,
				),
			).toBeNull();
		expect(
			readHostedQaSource(
				request,
				[row],
				{
					readReportHtml: () => {
						throw new Error("missing");
					},
				},
				options,
			),
		).toBeNull();
	});
});
