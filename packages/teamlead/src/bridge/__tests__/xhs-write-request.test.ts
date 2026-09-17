import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { parseXhsWriteRequest } from "../xhs-write-request.js";

const prefix = "/api/lead/xiaohongshu/write/";
const requestId = randomUUID(),
	proposalId = randomUUID(),
	receiptId = randomUUID();
it("accepts fixed operation inputs and rejects raw provider or authorization fields", () => {
	const input = {
		operationId: "xiaohongshu.like_feed",
		proposalId,
		receiptId,
		expectedContentDigest: "a".repeat(64),
	};
	expect(
		parseXhsWriteRequest(
			`${prefix}execute`,
			JSON.stringify({ requestId, input }),
		),
	).toEqual({ action: "execute", requestId, input });
	for (const extra of [
		{ approved: true },
		{ actor: "founder" },
		{ content: "changed" },
		{ xsec_token: "private" },
		{ permit: "forged" },
	]) {
		expect(() =>
			parseXhsWriteRequest(
				`${prefix}execute`,
				JSON.stringify({ requestId, input: { ...input, ...extra } }),
			),
		).toThrow("xhs_request_invalid");
	}
	for (const action of [
		"mint",
		"consume",
		"sign",
		"execute?approved=true",
		"../execute",
		"publish_content",
	])
		expect(() =>
			parseXhsWriteRequest(
				prefix + action,
				JSON.stringify({ requestId, input }),
			),
		).toThrow("xhs_request_invalid");
});
it("keeps prepare on controlled artifact/resource handles and status/cancel proposal-only", () => {
	const input = {
		operationId: "xiaohongshu.publish_content",
		accountSelector: "account",
		payload: { title: "Hello", content: "text" },
		artifactHandles: ["artifact-1"],
	};
	expect(
		parseXhsWriteRequest(
			`${prefix}prepare`,
			JSON.stringify({ requestId, input }),
		),
	).toMatchObject({ action: "prepare", input });
	expect(() =>
		parseXhsWriteRequest(
			`${prefix}prepare`,
			JSON.stringify({
				requestId,
				input: { ...input, artifactIds: ["private-id"] },
			}),
		),
	).toThrow();
	for (const action of ["status", "cancel"]) {
		expect(
			parseXhsWriteRequest(
				prefix + action,
				JSON.stringify({ requestId, input: { proposalId } }),
			),
		).toMatchObject({ action, input: { proposalId } });
		expect(() =>
			parseXhsWriteRequest(
				prefix + action,
				JSON.stringify({ requestId, input: { proposalId, receiptId } }),
			),
		).toThrow();
	}
});
it("rejects duplicate JSON keys, over-limit bytes, scope injection and extra envelopes", () => {
	const raw = JSON.stringify({ requestId, input: { proposalId } });
	for (const body of [
		raw.replace('"input":', '"requestId":"duplicate","input":'),
		" ".repeat(262145),
		JSON.stringify({
			requestId,
			input: { proposalId },
			activationId: "forged",
		}),
		JSON.stringify({
			requestId,
			input: { proposalId },
			url: "http://localhost",
		}),
	])
		expect(() => parseXhsWriteRequest(`${prefix}status`, body)).toThrow(
			"xhs_request_invalid",
		);
});
