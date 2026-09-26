import { describe, expect, it } from "vitest";
import {
	makeVoiceSelfFilterRequest,
	signVoiceSelfFilterResponse,
	verifyVoiceSelfFilterResponse,
} from "../../voice-self-filter-contract.js";

const secret = "fly2711-golden-vector-not-a-token";
const leadId = "fly2711-vector-lead";
const expectedBotUserId = "100000000000000005";
const nonce = "0123456789abcdef".repeat(4);
const runtimeId = "11111111-2222-4333-8444-555555555555";
const requestAuth =
	"d20dee69e6458bbf92cf9e78db928b861e4be659d2af568ffd01c2a46f85ca68";
const responseAuth =
	"acd7faf5ecb785834d36ffc2a423df4c63a6fe52cd96e72f16422f755c4ae581";

function vector() {
	const request = makeVoiceSelfFilterRequest(
		{ leadId, expectedBotUserId, nonce },
		secret,
	);
	const response = signVoiceSelfFilterResponse(
		{
			version: 1,
			leadId,
			botUserId: expectedBotUserId,
			runtimeId,
			nonce,
			ready: true,
			selfDropped: true,
			unknownDropped: true,
			otherPassed: true,
		},
		secret,
	);
	return { request, response };
}

describe("voice self-filter cross-repository golden vectors", () => {
	it("pins the request and response MAC serialization", () => {
		const { request, response } = vector();

		expect(request.auth).toBe(requestAuth);
		expect(response.auth).toBe(responseAuth);
		expect(verifyVoiceSelfFilterResponse(response, request, secret)).toEqual(
			response,
		);
	});

	it.each([
		["version", 2],
		["leadId", "different-lead"],
		["botUserId", "100000000000000006"],
		["runtimeId", "21111111-2222-4333-8444-555555555555"],
		["nonce", "abcdef0123456789".repeat(4)],
		["ready", false],
		["selfDropped", false],
		["unknownDropped", false],
		["otherPassed", false],
		["auth", `b${responseAuth.slice(1)}`],
	])("rejects a response with tampered %s", (field, value) => {
		const { request, response } = vector();

		expect(() =>
			verifyVoiceSelfFilterResponse(
				{ ...response, [field]: value },
				request,
				secret,
			),
		).toThrow("self_filter_unverified");
	});
});
