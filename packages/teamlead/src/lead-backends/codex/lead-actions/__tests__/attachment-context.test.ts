import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLeadIdentityRow } from "flywheel-comm/lead-identity";
import { afterEach, expect, it } from "vitest";
import { resolveLeadAttachmentContext } from "../attachment-context.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture(overrides: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), "attachment-context-"));
	roots.push(root);
	mkdirSync(join(root, ".flywheel"));
	writeFileSync(
		join(root, ".flywheel/summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "test",
			setAt: "2026-09-18T00:00:00.000Z",
		}),
	);
	const projectsPath = join(root, "projects.json");
	const lead = {
		agentId: "raya",
		summaryRole: "producer",
		department: "engineering",
		backend: "codex-app-server",
		codexProfile: "full-access",
		canSpawnRunners: false,
		botUserId: "222222222222222222",
		botTokenEnv: "RAYA_TOKEN",
		chatChannel: "111111111111111111",
		match: { labels: ["Engineering"] },
		...overrides,
	};
	writeFileSync(
		projectsPath,
		JSON.stringify([
			{
				projectName: "raya",
				projectRoot: root,
				generalChannel: "999999999999999999",
				leads: [lead],
			},
		]),
	);
	const identity = resolveLeadIdentityRow({
		projectsPath,
		homeDir: root,
		projectName: "raya",
		leadId: "raya",
	}).identity;
	return { root, projectsPath, identity };
}

it("resolves the canonical v1 full-access Bridge identity", () => {
	const f = fixture();
	expect(
		resolveLeadAttachmentContext({
			projectsPath: f.projectsPath,
			homeDir: f.root,
			projectName: "raya",
			leadId: "raya",
			identityDigest: f.identity.identityDigest,
			outboundMode: "bridge",
		}),
	).toEqual({
		projectsPath: f.projectsPath,
		projectName: "raya",
		leadId: "raya",
		identityDigest: f.identity.identityDigest,
	});
});

it("resolves the canonical Raya cos identity when chat equals general", () => {
	const f = fixture({ chatChannel: "999999999999999999" });
	expect(f.identity.role).toBe("cos");
	expect(
		resolveLeadAttachmentContext({
			projectsPath: f.projectsPath,
			homeDir: f.root,
			projectName: "raya",
			leadId: "raya",
			identityDigest: f.identity.identityDigest,
			outboundMode: "bridge",
		}),
	).toEqual({
		projectsPath: f.projectsPath,
		projectName: "raya",
		leadId: "raya",
		identityDigest: f.identity.identityDigest,
	});
});

it("keeps direct transport explicitly unavailable without reading authority", () => {
	expect(
		resolveLeadAttachmentContext({
			projectsPath: "/missing/projects.json",
			homeDir: "/missing",
			projectName: "raya",
			leadId: "raya",
			identityDigest: "a".repeat(64),
			outboundMode: "direct",
		}),
	).toBeUndefined();
});

it.each([
	["companion", { codexProfile: "companion", companion: true }],
	["write-capable", { codexProfile: "write-capable" }],
])("resolves a %s Codex carrier Lead", (_profile, overrides) => {
	const f = fixture(overrides);
	expect(
		resolveLeadAttachmentContext({
			projectsPath: f.projectsPath,
			homeDir: f.root,
			projectName: "raya",
			leadId: "raya",
			identityDigest: f.identity.identityDigest,
			outboundMode: "bridge",
		}),
	).toEqual({
		projectsPath: f.projectsPath,
		projectName: "raya",
		leadId: "raya",
		identityDigest: f.identity.identityDigest,
	});
});

it("rejects a v2 bundle instead of widening the v1 attachment transport", () => {
	const f = fixture({ codexCapabilityBundleVersion: 2 });
	expect(() =>
		resolveLeadAttachmentContext({
			projectsPath: f.projectsPath,
			homeDir: f.root,
			projectName: "raya",
			leadId: "raya",
			identityDigest: f.identity.identityDigest,
			outboundMode: "bridge",
		}),
	).toThrow("attachment_context_denied");
});

it("rejects a spoofed identity digest", () => {
	const f = fixture();
	expect(() =>
		resolveLeadAttachmentContext({
			projectsPath: f.projectsPath,
			homeDir: f.root,
			projectName: "raya",
			leadId: "raya",
			identityDigest: "f".repeat(64),
			outboundMode: "bridge",
		}),
	).toThrow("attachment_context_denied");
});
