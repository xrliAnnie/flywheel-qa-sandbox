import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLeadIdentityRow } from "flywheel-comm/lead-identity";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { captureLeadCapabilityScope } from "../lead-capability-scope.js";

const T0 = "2026-09-25T20:00:00.000Z";
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

async function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "voice-cap-scope-")));
	roots.push(root);
	mkdirSync(join(root, ".flywheel"));
	writeFileSync(
		join(root, ".flywheel", "summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "test",
			setAt: T0,
		}),
	);
	const projectsPath = join(root, "projects.json");
	const projects = [
		{
			projectName: "flywheel",
			projectRoot: root,
			projectRepo: "acme/flywheel",
			leads: [
				{
					agentId: "eng",
					summaryRole: "producer",
					backend: "claude-code",
					chatChannel: "12345678901234567",
					match: { labels: ["Engineering"] },
					voiceBackground: {
						enabled: true,
						browser: "founder_chrome",
					},
				},
			],
		},
	];
	writeFileSync(projectsPath, JSON.stringify(projects));
	const identity = resolveLeadIdentityRow({
		projectsPath,
		homeDir: root,
		projectName: "flywheel",
		leadId: "eng",
	}).identity;
	const store = await StateStore.create(join(root, "teamlead.db"));
	store.reserveVoiceSession({
		sessionId: SESSION_ID,
		mode: "meeting",
		projectName: "flywheel",
		leadId: "eng",
		guildId: "100000000000000001",
		voiceBotUserId: "100000000000000002",
		voiceChannelId: "100000000000000003",
		requestedBy: "founder",
		credentialTier: "master",
		createdAt: T0,
	});
	store.updateVoiceProvisioning({
		sessionId: SESSION_ID,
		expectedStep: "reserved",
		nextStep: "done",
		nextState: "desired",
		updatedAt: T0,
	});
	const claim = store.claimVoiceSession({
		sessionId: SESSION_ID,
		daemonBootId: "voice-boot",
		now: T0,
		leaseTtlMs: 60_000,
	})!;
	return { root, projectsPath, projects, identity, store, claim };
}

describe("voice session capability scope", () => {
	it("keeps authorization across lease renewal but rejects expiration", async () => {
		const f = await fixture();
		let now = T0;
		try {
			const scope = captureLeadCapabilityScope({
				projectsPath: f.projectsPath,
				homeDir: f.root,
				projectName: "flywheel",
				leadId: "eng",
				identityDigest: f.identity.identityDigest,
				authority: {
					kind: "voice_session",
					sessionId: SESSION_ID,
					leaseFence: f.claim.leaseToken,
				},
				stateStore: f.store,
				now: () => now,
				denied: () => new Error("denied"),
			});
			now = "2026-09-25T20:00:30.000Z";
			expect(
				f.store.renewVoiceSession({
					sessionId: SESSION_ID,
					leaseToken: f.claim.leaseToken,
					now,
					leaseTtlMs: 60_000,
				}),
			).toBeDefined();
			expect(() => scope.assertSourceCurrent()).not.toThrow();
			now = "2026-09-25T20:01:31.000Z";
			expect(() => scope.assertSourceCurrent()).toThrow("denied");
		} finally {
			f.store.close();
		}
	});

	it("accepts a current Claude Lead voice lease and revokes on config drift", async () => {
		const f = await fixture();
		try {
			const scope = captureLeadCapabilityScope({
				projectsPath: f.projectsPath,
				homeDir: f.root,
				projectName: "flywheel",
				leadId: "eng",
				identityDigest: f.identity.identityDigest,
				authority: {
					kind: "voice_session",
					sessionId: SESSION_ID,
					leaseFence: f.claim.leaseToken,
				},
				stateStore: f.store,
				now: () => T0,
				denied: () => new Error("denied"),
			} as never);
			expect(scope.row.identity.backend).toBe("claude-code");
			f.projects[0]!.leads[0]!.voiceBackground.enabled = false;
			writeFileSync(f.projectsPath, JSON.stringify(f.projects));
			expect(() => scope.assertSourceCurrent()).toThrow("denied");
		} finally {
			f.store.close();
		}
	});

	it("rejects a stale voice lease without consulting a resident carrier", async () => {
		const f = await fixture();
		try {
			expect(() =>
				captureLeadCapabilityScope({
					projectsPath: f.projectsPath,
					homeDir: f.root,
					projectName: "flywheel",
					leadId: "eng",
					identityDigest: f.identity.identityDigest,
					authority: {
						kind: "voice_session",
						sessionId: SESSION_ID,
						leaseFence: "stale-fence",
					},
					stateStore: f.store,
					now: () => T0,
					denied: () => new Error("denied"),
				} as never),
			).toThrow("denied");
		} finally {
			f.store.close();
		}
	});
});
