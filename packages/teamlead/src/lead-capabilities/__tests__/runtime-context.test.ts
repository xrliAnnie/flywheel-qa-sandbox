import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	identityEnvProjection,
	resolveLeadIdentity,
} from "flywheel-comm/lead-identity";
import { hashCarrierInstanceId } from "flywheel-comm/lead-lease";
import { afterEach, describe, expect, it } from "vitest";
import { createLeadCapabilityContext } from "../runtime-context.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "fly2519-context-"));
	dirs.push(home);
	mkdirSync(join(home, ".flywheel"));
	writeFileSync(
		join(home, ".flywheel", "summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "test",
			setAt: "2026-09-10T00:00:00Z",
		}),
	);
	const projectsPath = join(home, "projects.json");
	writeFileSync(
		projectsPath,
		JSON.stringify([
			{
				projectName: "demo",
				projectRoot: home,
				leads: [
					{
						agentId: "product-lead",
						summaryRole: "producer",
						backend: "codex-app-server",
						codexProfile: "full-access",
						canSpawnRunners: false,
						codexCapabilityBundleVersion: 2,
					},
				],
			},
		]),
	);
	const identity = resolveLeadIdentity({
		projectsPath,
		projectName: "demo",
		leadId: "product-lead",
		homeDir: home,
	});
	const env: NodeJS.ProcessEnv = {
		HOME: home,
		FLYWHEEL_PROJECTS_FILE: projectsPath,
		FLYWHEEL_CODEX_LEAD_PROFILE: "full-access",
		FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION: "2",
		...Object.fromEntries(
			identityEnvProjection(identity).map((line) => {
				const pos = line.indexOf("=");
				return [line.slice(0, pos), line.slice(pos + 1)];
			}),
		),
	};
	const mutate = (changes: Record<string, unknown>) => {
		const raw = JSON.parse(readFileSync(projectsPath, "utf8"));
		Object.assign(raw[0].leads[0], changes);
		writeFileSync(projectsPath, JSON.stringify(raw));
	};
	return { env, mutate, projectsPath };
}
describe("trusted capability runtime context", () => {
	it("binds v2 registry without requiring runner actions and refuses live revocation", () => {
		const f = fixture();
		const ctx = createLeadCapabilityContext(f.env);
		expect(ctx.assertCurrent().identity.leadId).toBe("product-lead");
		f.mutate({ codexCapabilityBundleVersion: undefined });
		expect(() => ctx.assertCurrent()).toThrow(/capability/);
	});
});

it("checks the exact current carrier beside registry evidence, without exposing its claim", () => {
	const f = fixture();
	const now = Date.now();
	const path = join(f.env.HOME!, "carrier.json");
	const claim = "synthetic-private-claim";
	const evidence = {
		schemaVersion: 1,
		collectedAt: new Date(now).toISOString(),
		leads: {
			"demo-product-lead": {
				leadKey: "demo-product-lead",
				backend: "codex-app-server",
				identityDigest: f.env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
				pid: 123,
				lstart: "synthetic-start",
				instanceDigest: hashCarrierInstanceId(claim),
			},
		},
	};
	f.env.FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE = path;
	f.env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID = claim;
	writeFileSync(path, JSON.stringify(evidence));
	const ctx = createLeadCapabilityContext(f.env);
	const deps = {
		now: () => now,
		processAliveWithStart: (pid: number, start: string) =>
			pid === 123 && start === "synthetic-start",
	};
	expect(ctx.assertActivationCurrent(deps).identity.leadId).toBe(
		"product-lead",
	);
	expect(JSON.stringify(ctx)).not.toContain(claim);
	evidence.leads["demo-product-lead"].instanceDigest =
		hashCarrierInstanceId("replacement-claim");
	writeFileSync(path, JSON.stringify(evidence));
	expect(() => ctx.assertActivationCurrent(deps)).toThrow(/carrier/);
});

it.each([undefined, "1", "true", "3"])(
	"rejects an unadopted marker %s",
	(marker) => {
		const f = fixture();
		f.env.FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION = marker;
		expect(() => createLeadCapabilityContext(f.env)).toThrow(/capability/);
	},
);
it.each([
	{ backend: "claude-code" },
	{ codexProfile: "companion" },
	{ external: true },
	{ summaryRole: "recipient" },
])("rejects current role/backend/profile drift %j", (change) => {
	const f = fixture();
	const ctx = createLeadCapabilityContext(f.env);
	f.mutate(change);
	expect(() => ctx.assertCurrent()).toThrow();
});
it("rejects forged canonical identity and absent carrier evidence", () => {
	const f = fixture();
	const ctx = createLeadCapabilityContext(f.env);
	expect(() => ctx.assertActivationCurrent()).toThrow(/carrier/);
	delete f.env.FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST;
	expect(() => createLeadCapabilityContext(f.env)).toThrow(/identity/);
	expect(ctx.assertCurrent().identity.leadId).toBe("product-lead");
});
it("requires the same resolved project root after registry edits", () => {
	const f = fixture();
	const ctx = createLeadCapabilityContext(f.env);
	const raw = JSON.parse(readFileSync(f.projectsPath, "utf8"));
	const other = join(f.env.HOME!, "other");
	mkdirSync(other);
	raw[0].projectRoot = other;
	writeFileSync(f.projectsPath, JSON.stringify(raw));
	expect(() => ctx.assertCurrent()).toThrow();
});
