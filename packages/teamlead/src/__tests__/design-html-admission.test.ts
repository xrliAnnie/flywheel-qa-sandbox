import { describe, expect, it } from "vitest";
import {
	DESIGN_HTML_EVIDENCE_ERROR,
	validateDesignHtmlCompletion,
} from "../bridge/design-html-admission.js";

const headSha = "0123456789abcdef0123456789abcdef01234567";
const validPayload = {
	evidence: { headSha },
	designHtmlEvidence: {
		version: 1,
		issueIdentifier: "FLY-1404",
		paths: ["engineering/doc/FLY-1404-design-html/founder-design.html"],
		headSha,
	},
};

describe("design HTML completion admission", () => {
	it("accepts a committed, issue-scoped attestation for any design-node completion", () => {
		expect(
			validateDesignHtmlCompletion({
				route: "phase_design_complete",
				payload: validPayload,
				authoritativeIssueIdentifier: "FLY-1404",
			}),
		).toEqual({ ok: true, required: true });
	});

	it.each([
		["missing", { evidence: { headSha } }],
		["malformed", { ...validPayload, designHtmlEvidence: { version: 1 } }],
		[
			"wrong issue",
			{
				...validPayload,
				designHtmlEvidence: {
					...validPayload.designHtmlEvidence,
					issueIdentifier: "FLY-1405",
					paths: ["engineering/doc/FLY-1405-design/founder.html"],
				},
			},
		],
		[
			"prefix collision",
			{
				...validPayload,
				designHtmlEvidence: {
					...validPayload.designHtmlEvidence,
					paths: ["engineering/doc/FLY-14040-design/founder.html"],
				},
			},
		],
		[
			"head mismatch",
			{
				...validPayload,
				evidence: {
					headSha: "abcdef0123456789abcdef0123456789abcdef01",
				},
			},
		],
	] as const)("fails closed for %s evidence", (_label, payload) => {
		const result = validateDesignHtmlCompletion({
			route: "phase_design_complete",
			payload,
			authoritativeIssueIdentifier: "FLY-1404",
		});
		expect(result).toMatchObject({
			ok: false,
			code: DESIGN_HTML_EVIDENCE_ERROR,
		});
	});

	it("does not gate workflows without a design-node completion", () => {
		expect(
			validateDesignHtmlCompletion({
				route: "no_code",
				payload: {},
				authoritativeIssueIdentifier: "FLY-1404",
			}),
		).toEqual({ ok: true, required: false });
	});

	it("FLY-1981 has no internal missing-attestation escape hatch", () => {
		expect(
			validateDesignHtmlCompletion({
				route: "phase_design_complete",
				payload: {},
				authoritativeIssueIdentifier: "FLY-1404",
				gateDisabled: true,
			} as Parameters<typeof validateDesignHtmlCompletion>[0]),
		).toMatchObject({ ok: false, code: DESIGN_HTML_EVIDENCE_ERROR });
	});
});
