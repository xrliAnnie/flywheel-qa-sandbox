import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	parseLandMergeTicketComment,
	renderLandMergeTicketComment,
	signLandMergeTicket,
	verifyLandMergeTicket,
} from "../land-merge-ticket.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey
	.export({ type: "pkcs8", format: "pem" })
	.toString();
const publicKeyPem = publicKey
	.export({ type: "spki", format: "pem" })
	.toString();
const payload = {
	version: 1 as const,
	ticketId: `land-merge-ticket:${"1".repeat(64)}`,
	repoIdentity: "__main__",
	prNumber: 1191,
	rootGateId: "workflow-gate:founder-root",
	headSha: "a".repeat(40),
	operationGeneration: 2,
	nonce: "b".repeat(64),
	issuedAt: "2026-09-16T18:00:00.000Z",
	expiresAt: "2026-09-16T18:10:00.000Z",
};

describe("land merge ticket envelope", () => {
	it("round-trips a signed exact-head envelope", () => {
		const envelope = signLandMergeTicket({ payload, privateKeyPem });
		const parsed = parseLandMergeTicketComment(
			renderLandMergeTicketComment(envelope),
		);
		expect(parsed).toEqual(envelope);
		expect(
			verifyLandMergeTicket({
				envelope: parsed!,
				publicKeyPem,
				now: "2026-09-16T18:05:00.000Z",
			}),
		).toBe(true);
	});

	it("rejects copied signatures after changing the PR or exact head", () => {
		const envelope = signLandMergeTicket({ payload, privateKeyPem });
		for (const changed of [
			{ ...envelope, prNumber: 1222 },
			{ ...envelope, headSha: "c".repeat(40) },
		]) {
			expect(
				verifyLandMergeTicket({
					envelope: changed,
					publicKeyPem,
					now: "2026-09-16T18:05:00.000Z",
				}),
			).toBe(false);
		}
	});

	it("rejects expired and malformed structured comments", () => {
		const envelope = signLandMergeTicket({ payload, privateKeyPem });
		expect(
			verifyLandMergeTicket({
				envelope,
				publicKeyPem,
				now: "2026-09-16T18:10:00.001Z",
			}),
		).toBe(false);
		expect(parseLandMergeTicketComment(":cool:")).toBeUndefined();
		expect(
			parseLandMergeTicketComment(
				`:cool:\n<!-- flywheel-land-ticket-v1 not-base64-json -->`,
			),
		).toBeUndefined();
	});
});
