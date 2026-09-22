import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestDiscordChat } from "flywheel-comm/discord-chat-ingest";
import { resolveLeadIdentityRow } from "flywheel-comm/lead-identity";
import type { LeadCarrierValidation } from "flywheel-comm/lead-lease";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { afterEach, expect, it, vi } from "vitest";
import { captureInboundAttachmentScope } from "../inbound-attachment-scope.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture(
	attachment: Record<string, unknown> = {
		attachmentId: "333333333333333333",
		name: "note.txt",
		type: "text/plain;charset=utf-8",
		sizeKb: 5 / 1024,
	},
	leadOverrides: Record<string, unknown> = {},
) {
	const root = mkdtempSync(join(tmpdir(), "inbound-attachment-scope-"));
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
	const projects = [
		{
			projectName: "flywheel",
			projectRoot: root,
			generalChannel: "999999999999999999",
			leads: [
				{
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
					...leadOverrides,
				},
			],
		},
	];
	const saveProjects = () =>
		writeFileSync(projectsPath, JSON.stringify(projects));
	saveProjects();
	const identity = resolveLeadIdentityRow({
		projectsPath,
		homeDir: root,
		projectName: "flywheel",
		leadId: "raya",
	}).identity;
	const commDbPath = join(root, "comm.db");
	const deliveryId = "chat:raya:444444444444444444";
	ingestDiscordChat({
		dbPath: commDbPath,
		leadId: "raya",
		chatId: "111111111111111111",
		originChannelId: "111111111111111111",
		messageId: "444444444444444444",
		authorId: "555555555555555555",
		authorName: "Founder",
		founderId: "555555555555555555",
		ts: "2026-09-18T12:00:00.000Z",
		msgKind: "guild",
		attachments: [attachment],
		text: "",
	});
	const carrier = {
		valid: true,
		processIndeterminate: false,
		instanceDigest: "c".repeat(64),
	};
	const validateCarrier = vi.fn(
		(): LeadCarrierValidation =>
			carrier.valid
				? {
						valid: true,
						disposition: "carrier_passthrough",
						leadKey: identity.leadKey,
						carrier: {
							leadKey: identity.leadKey,
							backend: "codex-app-server",
							identityDigest: identity.identityDigest,
							pid: 123,
							lstart: "start",
							instanceDigest: carrier.instanceDigest,
						},
						...(carrier.processIndeterminate
							? { processIndeterminate: true as const }
							: {}),
					}
				: { valid: false, reason: "carrier_evidence_stale" },
	);
	const authorizeChannel = vi.fn(async () => true as const);
	const options = {
		projectName: "flywheel",
		leadId: "raya",
		identityDigest: identity.identityDigest,
		carrierClaim: "raw-claim",
		deliveryId,
		attachmentId: "333333333333333333",
		projectsPath,
		homeDir: root,
		env: { RAYA_TOKEN: "BOT_TOKEN" },
		commDbPath: () => commDbPath,
		validateCarrier,
		authorizeChannel,
	};
	return {
		root,
		projects,
		projectsPath,
		saveProjects,
		identity,
		commDbPath,
		deliveryId,
		carrier,
		validateCarrier,
		authorizeChannel,
		options,
	};
}

it("binds a v1 carrier to its exact live mailbox receipt and source channel", async () => {
	const f = fixture();
	const scope = await captureInboundAttachmentScope(f.options);
	expect(scope.attachment).toEqual({
		attachmentId: "333333333333333333",
		name: "note.txt",
		type: "text/plain;charset=utf-8",
		sizeKb: 5 / 1024,
	});
	expect(scope.messageId).toBe("444444444444444444");
	expect(scope.originChannelId).toBe("111111111111111111");
	expect(scope.botToken).toBe("BOT_TOKEN");
	expect(scope.carrierInstanceDigest).toBe("c".repeat(64));
	expect(scope.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
	expect(f.authorizeChannel).toHaveBeenCalledWith(
		"flywheel",
		"raya",
		"111111111111111111",
	);
	await expect(scope.assertCurrent()).resolves.toBeUndefined();
});

it("binds the production-shaped Raya cos identity", async () => {
	const f = fixture(undefined, { chatChannel: "999999999999999999" });
	expect(f.identity.role).toBe("cos");
	await expect(captureInboundAttachmentScope(f.options)).resolves.toMatchObject(
		{
			messageId: "444444444444444444",
			originChannelId: "111111111111111111",
		},
	);
});

it.each([
	["companion", { companion: true, codexProfile: "companion" }],
	["write-capable", { codexProfile: "write-capable" }],
])(
	"allows a %s Codex carrier Lead to read its own attachment receipt",
	async (_profile, leadOverrides) => {
		const f = fixture(undefined, leadOverrides);
		await expect(
			captureInboundAttachmentScope(f.options),
		).resolves.toMatchObject({
			messageId: "444444444444444444",
			originChannelId: "111111111111111111",
		});
	},
);

it("rejects token-only, indeterminate, foreign, spoofed and stale carrier scope", async () => {
	const f = fixture();
	f.carrier.valid = false;
	await expect(captureInboundAttachmentScope(f.options)).rejects.toMatchObject({
		reason: "scope_denied",
	});
	f.carrier.valid = true;
	f.carrier.processIndeterminate = true;
	await expect(captureInboundAttachmentScope(f.options)).rejects.toMatchObject({
		reason: "scope_denied",
	});
	f.carrier.processIndeterminate = false;
	await expect(
		captureInboundAttachmentScope({ ...f.options, leadId: "foreign" }),
	).rejects.toMatchObject({ reason: "scope_denied" });
	await expect(
		captureInboundAttachmentScope({
			...f.options,
			identityDigest: "f".repeat(64),
		}),
	).rejects.toMatchObject({ reason: "scope_denied" });
	const scope = await captureInboundAttachmentScope(f.options);
	f.carrier.valid = false;
	await expect(scope.assertCurrent()).rejects.toMatchObject({
		reason: "carrier_expired",
	});
});

it("rejects dead receipts, foreign attachments, metadata failures, and route drift", async () => {
	const dead = fixture();
	const queue = new MailboxQueue(dead.commDbPath);
	queue.markDead(dead.deliveryId, "2026-09-18T12:01:00.000Z", "test");
	queue.close();
	await expect(
		captureInboundAttachmentScope(dead.options),
	).rejects.toMatchObject({
		reason: "scope_denied",
	});

	const foreign = fixture();
	await expect(
		captureInboundAttachmentScope({
			...foreign.options,
			attachmentId: "999999999999999999",
		}),
	).rejects.toMatchObject({ reason: "scope_denied" });

	const missing = fixture({
		name: "note.txt",
		type: "text/plain",
		sizeKb: 1,
	});
	await expect(
		captureInboundAttachmentScope(missing.options),
	).rejects.toMatchObject({ reason: "producer_identity_missing" });

	const drift = fixture();
	const scope = await captureInboundAttachmentScope(drift.options);
	drift.projects[0]!.generalChannel = "999999999999999999";
	drift.projects[0]!.leads[0]!.chatChannel = "999999999999999999";
	drift.saveProjects();
	await expect(scope.assertCurrent()).rejects.toMatchObject({
		reason: "scope_denied",
	});
});

it("never treats reply routing as source-channel authorization", async () => {
	const f = fixture();
	f.authorizeChannel.mockResolvedValueOnce(false);
	await expect(captureInboundAttachmentScope(f.options)).rejects.toMatchObject({
		reason: "scope_denied",
	});
	expect(f.authorizeChannel).toHaveBeenCalledWith(
		"flywheel",
		"raya",
		"111111111111111111",
	);
});

it("reports a transient thread-parent lookup as fetch unavailable", async () => {
	const f = fixture();
	f.authorizeChannel.mockResolvedValueOnce("unavailable");
	await expect(captureInboundAttachmentScope(f.options)).rejects.toMatchObject({
		reason: "fetch_unavailable",
	});
});
