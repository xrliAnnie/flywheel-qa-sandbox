import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinearClient } from "@linear/sdk";
import { resolveLeadIdentityRow } from "flywheel-comm/lead-identity";
import { afterEach, expect, it, vi } from "vitest";
import {
	createLeadReportOwnerAuthorizer,
	createLeadReportPublishAuthorizer,
	createLeadReportPublishReceiptAuthorizer,
} from "../lead-capability-report.js";

const identity = vi.hoisted(() => ({ digest: "a".repeat(64), valid: true }));
vi.mock("flywheel-comm/lead-lease", () => ({
	forwardedLeadAuthorizationEnv: (_proof: unknown, env: unknown) => env,
	validateLeadCarrierAuthorization: () => ({
		valid: identity.valid,
		processIndeterminate: false,
	}),
}));
const roots: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	identity.valid = true;
	identity.digest = "a".repeat(64);
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lead-report-"));
	roots.push(root);
	mkdirSync(join(root, ".flywheel"));
	writeFileSync(
		join(root, ".flywheel/summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "test",
			setAt: "2026-09-10T00:00:00Z",
		}),
	);
	const projectsPath = join(root, "projects.json");
	const projects = [
		{
			projectName: "flywheel",
			projectRoot: root,
			linear: { team: "FLY", project: "Flywheel", label: "Tracked" },
			leads: [
				{
					agentId: "eng",
					summaryRole: "producer",
					backend: "codex-app-server",
					codexProfile: "full-access",
					codexCapabilityBundleVersion: 2,
					canSpawnRunners: false,
					botUserId: "12345678901234567",
					botTokenEnv: "BOT_TOKEN",
					chatChannel: "22345678901234567",
					match: { labels: ["Engineering"] },
				},
			],
		},
	];
	const save = () => writeFileSync(projectsPath, JSON.stringify(projects));
	save();
	identity.digest = resolveLeadIdentityRow({
		projectsPath,
		homeDir: root,
		projectName: "flywheel",
		leadId: "eng",
	}).identity.identityDigest;
	const issue = {
		team: Promise.resolve({ key: "FLY" }),
		project: Promise.resolve({ name: "Flywheel" }),
		labels: vi.fn(async () => ({
			nodes: [{ name: "Engineering" }, { name: "Tracked" }],
			pageInfo: { hasNextPage: false },
		})),
	};
	const client = { issue: vi.fn(async () => issue) };
	const authorize = createLeadReportPublishAuthorizer({
		projectsPath,
		homeDir: root,
		env: {},
		linearClient: client as unknown as LinearClient,
	});
	const body = {
		projectName: "flywheel",
		html: "<html>report</html>",
		title: "Report",
		capability: {
			schemaVersion: 1,
			operationId: "report.publish",
			requestId: "123e4567-e89b-42d3-a456-426614174000",
			leadId: "eng",
			identityDigest: identity.digest,
			carrierClaim: "claim",
			activationId: "activation",
			issueId: "FLY-1",
		},
	};
	return { authorize, body, client, issue, projects, save, root, projectsPath };
}
it("authorizes an exact current department issue and keeps a live commit guard", async () => {
	const f = fixture();
	const guard = await f.authorize(f.body);
	expect(() => guard()).not.toThrow();
	expect(f.client.issue).toHaveBeenCalledWith("FLY-1");
	identity.valid = false;
	expect(() => guard()).toThrow("report_scope_denied");
});
it("rejects scope drift while issue metadata is pending", async () => {
	const f = fixture();
	f.client.issue.mockImplementation(async () => {
		f.projects[0]!.linear.project = "Other";
		f.save();
		return f.issue;
	});
	await expect(f.authorize(f.body)).rejects.toThrow("report_scope_denied");
});
it("rejects malformed proof and foreign or incomplete issue labels", async () => {
	const f = fixture();
	await expect(
		f.authorize({
			...f.body,
			capability: { ...f.body.capability, operationId: "report.deliver" },
		}),
	).rejects.toThrow("report_scope_denied");
	expect(f.client.issue).not.toHaveBeenCalled();
	for (const labels of [
		{ nodes: [{ name: "Product" }], pageInfo: { hasNextPage: false } },
		{ nodes: [{ name: "Engineering" }], pageInfo: { hasNextPage: false } },
		{
			nodes: [{ name: "Engineering" }, { name: "Tracked" }],
			pageInfo: { hasNextPage: true },
		},
	]) {
		f.issue.labels.mockResolvedValue(labels);
		await expect(f.authorize(f.body)).rejects.toThrow("report_scope_denied");
	}
});

it("bounds a stalled issue lookup and expires a previously granted commit check", async () => {
	const f = fixture();
	vi.useFakeTimers();
	const guard = await f.authorize(f.body);
	await vi.advanceTimersByTimeAsync(15000);
	expect(() => guard()).toThrow("report_scope_denied");
	f.client.issue.mockImplementation(() => new Promise(() => {}));
	const stalled = f.authorize(f.body);
	const rejection = expect(stalled).rejects.toThrow("report_scope_denied");
	await vi.advanceTimersByTimeAsync(15000);
	await rejection;
});

it("requires persisted matching report ownership and rechecks it after asynchronous authorization", async () => {
	const f = fixture();
	const { ReportRegistry } = await import("../report-registry.js");
	const registry = new ReportRegistry(f.root);
	const staged = registry.stagePublish(
		"flywheel",
		"<html><head></head><body>report</body></html>",
		"Report",
		registry.hostingBinding(),
		f.body.capability,
	);
	await staged.commit();
	const authorize = createLeadReportOwnerAuthorizer({
		projectsPath: f.projectsPath,
		homeDir: f.root,
		env: {},
		linearClient: f.client as unknown as LinearClient,
		registry,
	});
	const request = {
		projectName: "flywheel",
		capability: {
			...f.body.capability,
			operationId: "report.verify",
			reportId: staged.entry.token,
		},
	};
	const result = await authorize(request);
	expect(result.report.token).toBe(staged.entry.token);
	expect(() => result.assertCurrent()).not.toThrow();
	await expect(
		authorize({
			...request,
			capability: { ...request.capability, leadId: "foreign" },
		}),
	).rejects.toThrow("report_scope_denied");
	await expect(
		authorize({
			...request,
			capability: { ...request.capability, issueId: "FLY-2" },
		}),
	).rejects.toThrow("report_scope_denied");
	const legacy = registry.stagePublish(
		"flywheel",
		"<html><head></head><body>legacy</body></html>",
		undefined,
		registry.hostingBinding(),
	);
	await legacy.commit();
	await expect(
		authorize({
			...request,
			capability: { ...request.capability, reportId: legacy.entry.token },
		}),
	).rejects.toThrow("report_scope_denied");
	identity.valid = false;
	expect(() => result.assertCurrent()).toThrow("report_scope_denied");
});

it("looks up upload receipts by exact owner/request without republishing", async () => {
	const f = fixture();
	const { ReportRegistry } = await import("../report-registry.js");
	const registry = new ReportRegistry(f.root);
	const lookup = createLeadReportPublishReceiptAuthorizer({
		projectsPath: f.projectsPath,
		homeDir: f.root,
		env: {},
		linearClient: f.client as unknown as LinearClient,
		registry,
	});
	const request = {
		projectName: f.body.projectName,
		capability: f.body.capability,
	};
	expect((await lookup(request)).report).toBeUndefined();
	const staged = registry.stagePublish(
		"flywheel",
		"<html><head></head><body>report</body></html>",
		"Report",
		registry.hostingBinding(),
		f.body.capability,
	);
	await staged.commit();
	const found = await lookup(request);
	expect(found.report?.token).toBe(staged.entry.token);
	expect(() => found.assertCurrent()).not.toThrow();
	expect(
		(
			await lookup({
				...request,
				capability: {
					...request.capability,
					requestId: "123e4567-e89b-42d3-a456-426614174001",
				},
			})
		).report,
	).toBeUndefined();
	await expect(
		lookup({
			...request,
			capability: { ...request.capability, leadId: "foreign" },
		}),
	).rejects.toThrow("report_scope_denied");
	await registry
		.stagePublish(
			"flywheel",
			"<html><head></head><body>duplicate</body></html>",
			"Report",
			registry.hostingBinding(),
			f.body.capability,
		)
		.commit();
	expect(() => found.assertCurrent()).toThrow("report_scope_denied");
	await expect(lookup(request)).rejects.toThrow("report_scope_denied");
});
