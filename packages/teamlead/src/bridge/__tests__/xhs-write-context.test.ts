import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createXhsWriteContext } from "../xhs-write-context.js";

const state = vi.hoisted(() => ({
	projectRoot: "",
	backend: "claude-code",
	valid: true,
	generation: 1,
	uncertain: false,
	calls: [] as string[],
}));
vi.mock("flywheel-comm/lead-identity", () => ({
	resolveLeadIdentityRow: () => ({
		project: { projectRoot: state.projectRoot },
		identity: {
			identityDigest: "a".repeat(64),
			backend: state.backend,
			role: "dept",
		},
		lead: { codexCapabilityBundleVersion: 2, codexProfile: "full-access" },
	}),
}));
vi.mock("flywheel-comm/lead-lease", () => ({
	forwardedLeadAuthorizationEnv: (input: unknown, base: unknown) => ({
		...(base as object),
		request: input,
	}),
	validateClaudeLeadLeaseAuthorization: () => {
		state.calls.push("claude");
		return {
			valid: state.valid,
			generation: state.generation,
			leadKey: "project-lead",
			holderPid: 123,
			holderStart: "start",
		};
	},
	validateLeadCarrierAuthorization: () => {
		state.calls.push("codex");
		return {
			valid: state.valid,
			processIndeterminate: state.uncertain,
			carrier: { instanceDigest: "b".repeat(64), pid: 123, lstart: "start" },
		};
	},
}));
afterEach(() => {
	state.backend = "claude-code";
	state.valid = true;
	state.generation = 1;
	state.uncertain = false;
	state.calls = [];
});
const header = (extra = {}) =>
	Buffer.from(
		JSON.stringify({
			projectName: "project",
			leadId: "lead",
			identityDigest: "a".repeat(64),
			leaseClaim: { leaseKey: "project-lead", generation: 1 },
			...extra,
		}),
	).toString("base64");
it("pins Claude generation and holder attribution and rejects drift after creation", () => {
	const context = createXhsWriteContext(header(), {
		HOME: "/fixture",
		FLYWHEEL_PROJECTS_FILE: "/fixture/projects.json",
	});
	expect(context.scope).toMatchObject({ projectId: "project", leadId: "lead" });
	expect(context.scope.activationId).toMatch(/^claude-lease:[a-f0-9]{64}$/);
	context.assertCurrent();
	expect(state.calls).not.toContain("codex");
	state.generation++;
	expect(() => context.assertCurrent()).toThrow("xhs_identity_denied");
});
it("preserves Codex parent activation and refuses an indeterminate carrier", () => {
	state.backend = "codex-app-server";
	const value = header({
		leaseClaim: undefined,
		carrierClaim: "private-carrier",
		activationId: "12345678-1234-4234-8234-123456789012",
	});
	const context = createXhsWriteContext(value, { HOME: "/fixture" });
	expect(context.scope.activationId).toBe(
		"12345678-1234-4234-8234-123456789012",
	);
	expect(state.calls).not.toContain("claude");
	state.uncertain = true;
	expect(() => context.assertCurrent()).toThrow("xhs_identity_denied");
});
it("rejects mixed claims, wrong digest, arbitrary approval and malformed headers", () => {
	for (const value of [
		header({ carrierClaim: "mixed" }),
		header({ identityDigest: "c".repeat(64) }),
		header({ approved: true }),
		"bad",
		"a".repeat(8193),
	])
		expect(() => createXhsWriteContext(value, { HOME: "/fixture" })).toThrow(
			"xhs_identity_denied",
		);
	state.valid = false;
	expect(() => createXhsWriteContext(header(), { HOME: "/fixture" })).toThrow(
		"xhs_identity_denied",
	);
});

it("resolves media staging only from the pinned canonical project directory", () => {
	const root = realpathSync(mkdtempSync("/tmp/xhs-context-"));
	try {
		state.projectRoot = root;
		const context = createXhsWriteContext(header(), { HOME: "/fixture" });
		expect(context.projectRoot()).toBe(root);
		state.projectRoot = "/changed";
		expect(() => context.projectRoot()).toThrow("xhs_identity_denied");
		const alias = join(root, "alias");
		symlinkSync(root, alias);
		state.projectRoot = alias;
		expect(() =>
			createXhsWriteContext(header(), { HOME: "/fixture" }).projectRoot(),
		).toThrow("xhs_identity_denied");
		state.projectRoot = "relative";
		expect(() =>
			createXhsWriteContext(header(), { HOME: "/fixture" }).projectRoot(),
		).toThrow("xhs_identity_denied");
	} finally {
		state.projectRoot = "";
		rmSync(root, { recursive: true, force: true });
	}
});
