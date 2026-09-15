import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { QaAuthority } from "../evidence-ledger.js";
import { readClaimQaSource } from "../qa-source.js";

const target = {
	runId: "r",
	repoIdentity: "__main__",
	headSha: "a".repeat(40),
};
const token = "b".repeat(32),
	url = `https://reports.vercel.app/r/${token}/`;
const qa: QaAuthority = {
	verdict: "pass",
	reason: "evidence_complete",
	claimId: "1148",
	issuedAt: "2026-09-14T20:00:00.000Z",
	predicate: "qa_passed",
	summary: `QA report: [report](${url})`,
};

it("reads a claim's hosted report with exact target identity and a digest of retained bytes", () => {
	const body = "<h1>QA passed</h1>",
		readReportHtml = vi.fn(() => body);
	expect(
		readClaimQaSource(
			target,
			qa,
			{ readReportHtml },
			{ vercelProjectName: "reports" },
		),
	).toMatchObject({
		...target,
		body,
		format: "html",
		digest: createHash("sha256").update(body).digest("hex"),
		withdrawn: false,
	});
	expect(readReportHtml).toHaveBeenCalledWith(token);
});

it.each([
	"absent",
	"revoked",
	"wrong_host",
	"unretained",
	"oversized",
	"ambiguous",
])("does not invent a semantic report when %s", (scenario) => {
	const claim = { ...qa };
	if (scenario === "revoked") {
		claim.verdict = "fail";
		claim.reason = "qa_claim_revoked";
	}
	if (scenario === "wrong_host")
		claim.summary = url.replace("reports", "attacker");
	if (scenario === "ambiguous")
		claim.summary = `${url} ${url.replace(token, "c".repeat(32))}`;
	const readReportHtml = () => {
		if (scenario === "unretained") throw new Error("missing");
		return scenario === "oversized" ? "x".repeat(262145) : "report";
	};
	expect(
		readClaimQaSource(
			target,
			scenario === "absent" ? undefined : claim,
			{ readReportHtml },
			{ vercelProjectName: "reports" },
		),
	).toBeNull();
});

it("retains a valid QA FAIL report as semantic evidence", () => {
	expect(
		readClaimQaSource(
			target,
			{ ...qa, verdict: "fail", predicate: "qa_failed", reason: "qa_failed" },
			{ readReportHtml: () => "FAIL" },
			{ vercelProjectName: "reports" },
		),
	).toMatchObject({ body: "FAIL", withdrawn: false });
});

it("selects the explicitly labelled QA ship report when the claim also links product and preview pages", () => {
	const ship = token,
		product = "c".repeat(32),
		preview = "d".repeat(32);
	const claim = {
		...qa,
		summary: `QA PASS. Product page https://reports.vercel.app/r/${product}/ and preview https://reports.vercel.app/r/${preview}/ both 200. Ship report (publish-only, runner lacks delivery authority): https://reports.vercel.app/r/${ship}/`,
	};
	const readReportHtml = vi.fn((id: string) =>
		id === ship ? "QA evidence" : "wrong product page",
	);
	expect(
		readClaimQaSource(
			target,
			claim,
			{ readReportHtml },
			{ vercelProjectName: "reports" },
		),
	).toMatchObject({ reportToken: ship, body: "QA evidence" });
	expect(readReportHtml).toHaveBeenCalledTimes(1);
	expect(readReportHtml).toHaveBeenCalledWith(ship);
});
it("rejects two different explicitly labelled QA reports rather than choosing the first", () => {
	const claim = {
		...qa,
		summary: `QA report: ${url} Ship report: ${url.replace(token, "c".repeat(32))}`,
	};
	const readReportHtml = vi.fn(() => "ambiguous");
	expect(
		readClaimQaSource(
			target,
			claim,
			{ readReportHtml },
			{ vercelProjectName: "reports" },
		),
	).toBeNull();
	expect(readReportHtml).not.toHaveBeenCalled();
});
