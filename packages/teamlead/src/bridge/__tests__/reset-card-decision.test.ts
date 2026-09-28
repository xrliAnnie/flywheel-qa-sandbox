import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	OTHER_PROPOSAL_ID,
	sampleConsent,
	sampleProposal,
} from "../../__tests__/reset-card-test-fixtures.js";
import {
	makeResetCardFiles,
	type ProposalStatus,
	type ResetCardConsent,
	type ResetCardFiles,
	type ResetCardProposal,
} from "../../account-heal/reset-card-files.js";
import {
	activeClaudeMaxPct,
	buildResetCardDecision,
	DEFAULT_RESET_CARD_ASK_PCT,
	loadResetCardDecision,
	type ResetCardDecisionContext,
} from "../reset-card-decision.js";

const LIVE: ResetCardDecisionContext = {
	askPct: DEFAULT_RESET_CARD_ASK_PCT,
	activeAccount: "personal",
	activeGeneration: 7,
	activeMaxPct: 88,
};

function build(
	proposal: ResetCardProposal = sampleProposal(),
	consent: ResetCardConsent | null = null,
	context: Partial<ResetCardDecisionContext> = {},
) {
	return buildResetCardDecision(proposal, consent, { ...LIVE, ...context });
}

function stubFiles(
	proposal: ReturnType<ResetCardFiles["readProposal"]> | (() => never),
	consent: ReturnType<ResetCardFiles["readConsent"]> | (() => never) = {
		status: "absent",
	},
): Pick<ResetCardFiles, "readProposal" | "readConsent"> {
	return {
		readProposal: () =>
			typeof proposal === "function" ? proposal() : proposal,
		readConsent: () => (typeof consent === "function" ? consent() : consent),
	};
}

describe("FLY-2896 §5.8 — buildResetCardDecision", () => {
	it("shows the live active percentage and the proposal's two names", () => {
		const decision = build();
		expect(decision).toEqual({
			proposalId: sampleProposal().proposalId,
			active: "personal",
			activePct: 88,
			target: "business",
			state: { kind: "not_posted" },
			chip: "awaiting",
		});
	});

	it.each([
		["pending_post", { kind: "not_posted" }, "awaiting"],
		[
			"posted",
			{ kind: "posted", postedAt: "2026-09-25T23:05:10.000Z" },
			"awaiting",
		],
		["approved", { kind: "approved" }, "approved"],
		["rejected", { kind: "rejected" }, null],
		["expired", { kind: "expired" }, null],
		["post_failed", { kind: "post_failed", reason: "discord_403" }, null],
		["superseded", { kind: "not_posted" }, "awaiting"],
	] as const)("awaiting_consent + consent %s → %o", (state, expected, chip) => {
		const consent = sampleConsent(sampleProposal(), {
			state,
			reason: state === "post_failed" ? "discord_403" : null,
		});
		const decision = build(sampleProposal(), consent);
		expect(decision?.state).toEqual(expected);
		expect(decision?.chip).toBe(chip);
	});

	it("ignores a consent written for another proposal or another digest", () => {
		const proposal = sampleProposal();
		const other = sampleConsent(proposal, { proposalId: OTHER_PROPOSAL_ID });
		expect(build(proposal, other)?.state).toEqual({ kind: "not_posted" });
		const forged = sampleConsent(proposal, { digest: "f".repeat(64) });
		expect(build(proposal, forged)?.state).toEqual({ kind: "not_posted" });
	});

	it.each([
		"executing",
		"redeem_unconfirmed",
		"grant_already_used",
		"redeem_confirmed",
		"recovered_without_proven_redeem",
		"switching",
		"switch_committed",
		"settled",
	] as const)("proposal %s → in_progress without a chip", (status) => {
		const approved = sampleConsent(sampleProposal(), { state: "approved" });
		const decision = build(sampleProposal({ status }), approved);
		expect(decision?.state).toEqual({ kind: "in_progress" });
		expect(decision?.chip).toBeNull();
	});

	it.each([
		["rejected", { kind: "rejected" }],
		["expired", { kind: "expired" }],
		["cancelled", { kind: "cancelled" }],
		["failed", { kind: "failed" }],
		["redeemed_switch_failed", { kind: "failed" }],
		["switched_unverified", { kind: "failed" }],
		["redeem_ambiguous", { kind: "ambiguous" }],
	] as const satisfies ReadonlyArray<readonly [ProposalStatus, unknown]>)(
		"terminal proposal %s → %o without a chip",
		(status, expected) => {
			const decision = build(sampleProposal({ status }));
			expect(decision?.state).toEqual(expected);
			expect(decision?.chip).toBeNull();
		},
	);

	it("carries the post_failed reason from the proposal, then the consent", () => {
		expect(
			build(
				sampleProposal({ status: "post_failed", statusReason: "channel_gone" }),
			)?.state,
		).toEqual({ kind: "post_failed", reason: "channel_gone" });
		const proposal = sampleProposal({ status: "post_failed" });
		expect(
			build(
				proposal,
				sampleConsent(proposal, { state: "post_failed", reason: "http_403" }),
			)?.state,
		).toEqual({ kind: "post_failed", reason: "http_403" });
		expect(build(proposal)?.state).toEqual({
			kind: "post_failed",
			reason: null,
		});
	});

	it("shows nothing once the card switched", () => {
		expect(build(sampleProposal({ status: "switched" }))).toBeNull();
	});

	it("shows nothing for another active account or another generation", () => {
		expect(
			build(sampleProposal(), null, { activeAccount: "business" }),
		).toBeNull();
		expect(build(sampleProposal(), null, { activeAccount: null })).toBeNull();
		expect(build(sampleProposal(), null, { activeGeneration: 8 })).toBeNull();
		expect(
			build(sampleProposal(), null, { activeGeneration: null }),
		).toBeNull();
	});

	it("shows nothing when the live active dropped back under askPct", () => {
		expect(build(sampleProposal(), null, { activeMaxPct: 84.9 })).toBeNull();
		expect(build(sampleProposal(), null, { activeMaxPct: 85 })).not.toBeNull();
		expect(build(sampleProposal(), null, { activeMaxPct: null })).toBeNull();
		expect(
			build(sampleProposal(), null, { activeMaxPct: 99, askPct: Number.NaN }),
		).toBeNull();
	});
});

describe("FLY-2896 §5.8 — loadResetCardDecision never throws", () => {
	const proposal = sampleProposal();

	it("returns null for an absent or invalid proposal", () => {
		expect(
			loadResetCardDecision({
				...LIVE,
				files: stubFiles({ status: "absent" }),
			}),
		).toBeNull();
		expect(
			loadResetCardDecision({
				...LIVE,
				files: stubFiles({ status: "invalid", reason: "digest_mismatch" }),
			}),
		).toBeNull();
	});

	it("returns null for an invalid consent even with a good proposal", () => {
		expect(
			loadResetCardDecision({
				...LIVE,
				files: stubFiles(
					{ status: "ok", value: proposal },
					{ status: "invalid", reason: "not_file" },
				),
			}),
		).toBeNull();
	});

	it("returns null when either reader throws", () => {
		const boom = () => {
			throw new Error("EACCES");
		};
		expect(
			loadResetCardDecision({ ...LIVE, files: stubFiles(boom) }),
		).toBeNull();
		expect(
			loadResetCardDecision({
				...LIVE,
				files: stubFiles({ status: "ok", value: proposal }, boom),
			}),
		).toBeNull();
	});

	it("treats an absent consent as not yet posted", () => {
		expect(
			loadResetCardDecision({
				...LIVE,
				files: stubFiles({ status: "ok", value: proposal }),
			}),
		).toMatchObject({ state: { kind: "not_posted" }, chip: "awaiting" });
	});

	describe("against the real file contract", () => {
		let dir: string;
		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		it("reads what the daemon and the Bridge wrote", () => {
			dir = mkdtempSync(join(tmpdir(), "fly2896-page-"));
			const files = makeResetCardFiles(dir);
			files.writeProposal(proposal);
			expect(loadResetCardDecision({ ...LIVE, files })).toMatchObject({
				state: { kind: "not_posted" },
			});
			files.writeConsent(sampleConsent(proposal, { state: "posted" }));
			expect(loadResetCardDecision({ ...LIVE, files })).toMatchObject({
				state: { kind: "posted", postedAt: "2026-09-25T23:05:10.000Z" },
				chip: "awaiting",
			});
		});
	});
});

describe("FLY-2896 §5.8 — activeClaudeMaxPct", () => {
	it("takes the larger live window of the single active account", () => {
		expect(
			activeClaudeMaxPct([
				{ active: false, fiveHPct: 100, sevenDPct: 100 },
				{ active: true, fiveHPct: 41, sevenDPct: 88 },
			]),
		).toBe(88);
		expect(
			activeClaudeMaxPct([{ active: true, fiveHPct: null, sevenDPct: 12 }]),
		).toBe(12);
	});

	it("is null without an active account or without any reading", () => {
		expect(activeClaudeMaxPct([])).toBeNull();
		expect(
			activeClaudeMaxPct([{ active: false, fiveHPct: 90, sevenDPct: 90 }]),
		).toBeNull();
		expect(
			activeClaudeMaxPct([{ active: true, fiveHPct: null, sevenDPct: null }]),
		).toBeNull();
	});
});
