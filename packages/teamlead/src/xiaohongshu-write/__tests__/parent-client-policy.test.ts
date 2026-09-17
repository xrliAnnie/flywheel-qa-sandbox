import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	createParentXhsAuthorityClient,
	deriveAuthorityClientScope,
} from "../parent-client-policy.js";

const policy = {
	enabled: true,
	modelUid: 501,
	serviceUid: 450,
	serviceGid: 450,
	ingressGid: 451,
	registry: [{ projectId: "project-1", leadId: "lead-1" }],
};
const selection = {
	projectId: "project-1",
	leadId: "lead-1",
	activationId: "activation-1",
};
const actual = { uid: 501, groups: [20, 451] };
it("derives only a registered parent scope from actual model principal and disjoint groups", () => {
	expect(deriveAuthorityClientScope(policy, selection, actual)).toEqual(
		selection,
	);
	for (const change of [
		{ uid: 0 },
		{ uid: 450 },
		{ groups: [20] },
		{ groups: [20, 450, 451] },
	])
		expect(() =>
			deriveAuthorityClientScope(policy, selection, { ...actual, ...change }),
		).toThrow("authority_client_policy_unavailable");
	for (const change of [{ serviceUid: 501 }, { registry: [] }])
		expect(() =>
			deriveAuthorityClientScope({ ...policy, ...change }, selection, actual),
		).toThrow("authority_client_policy_unavailable");
	for (const change of [
		{ projectId: "other" },
		{ leadId: "other" },
		{ activationId: "" },
		{ approved: true },
	])
		expect(() =>
			deriveAuthorityClientScope(policy, { ...selection, ...change }, actual),
		).toThrow("authority_client_policy_unavailable");
});
it("preserves registered read transport scope when the founder write gate is disabled", () => {
	expect(
		deriveAuthorityClientScope(
			{ ...policy, enabled: false },
			selection,
			actual,
		),
	).toEqual(selection);
});
it("refuses model-owned policy before creating parent context or reading private files", () => {
	const root = mkdtempSync("/tmp/xhs-parent-policy-");
	try {
		const path = join(root, "policy.json");
		writeFileSync(
			path,
			JSON.stringify({ ...policy, permitKeyPath: "/not-readable/private-key" }),
		);
		expect(() =>
			createParentXhsAuthorityClient({
				policyPath: path,
				env: {},
				activationId: "activation-1",
			}),
		).toThrow("authority_client_policy_unavailable");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
