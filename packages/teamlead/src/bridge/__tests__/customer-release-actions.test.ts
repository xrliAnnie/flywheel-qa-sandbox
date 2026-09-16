import Database from "better-sqlite3";
import { payloadObjectKey } from "flywheel-release-contract";
import { afterEach, expect, it } from "vitest";
import { ReleaseCandidateActions } from "../customer-release/actions.js";
import {
	releaseCard,
	releaseMessageDigest,
} from "../customer-release/cards.js";
import type { VerifiedReleaseInteraction } from "../customer-release/interaction-gateway.js";
import type { ManualReleaseDelivery } from "../customer-release/manual.js";
import { CustomerReleaseStore } from "../customer-release/store.js";

const databases: Database.Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
const now = Date.parse("2026-09-15T15:00:00Z");
const target = {
	epoch: 1,
	founderId: "423456789012345678",
	applicationId: "223456789012345678",
	guildId: "623456789012345678",
	channelId: "123456789012345678",
	botUserId: "323456789012345678",
};
function fixture() {
	const db = new Database(":memory:");
	databases.push(db);
	const store = new CustomerReleaseStore(db);
	store.migrate();
	const sourceCommit = "a".repeat(40),
		hash = "b".repeat(64);
	const manifest = {
		versions: {
			"1.2.3-beta.1": {
				channel: "beta",
				status: "active",
				sourceCommit,
				sha256: "c".repeat(64),
			},
		},
		releaseOps: {
			r1: {
				kind: "release",
				state: "prepared",
				ver: "1.2.3",
				sourceCommit,
				sha256: hash,
				objectKey: payloadObjectKey("1.2.3", hash),
				betaVersion: "1.2.3-beta.1",
			},
		},
	};
	const cycle = store.reserve({
		projectId: "flywheel",
		slotDate: "2026-09-15",
		releaseId: "r1",
		activationEpoch: 1,
		policyRevision: "d".repeat(64),
		betaVersion: "1.2.3-beta.1",
		manifest,
		now,
	});
	db.prepare(
		"UPDATE customer_release_cycles SET state='preparing',revision=1 WHERE cycle_id=?",
	).run(cycle.cycleId);
	const input = {
		kind: "veto" as const,
		epoch: 1,
		nonce: "e".repeat(32),
		releaseVersion: "1.2.3",
		betaVersion: "1.2.3-beta.1",
		sourceCommit,
		payloadSha256: hash,
		timezone: "America/Los_Angeles",
		deadlineAt: now + 4 * 3600_000,
	};
	const card = releaseCard(input);
	const notice = {
		noticeId: input.nonce,
		messageDigest: releaseMessageDigest(card),
		channelId: target.channelId,
		applicationId: target.applicationId,
		botUserId: target.botUserId,
		founderId: target.founderId,
		noticeAt: now,
		deadlineAt: input.deadlineAt,
		claimNotAfter: now + 5 * 3600_000,
		minimumVetoMinutes: 120,
	};
	const proof = {
		workflowRunId: "1234",
		equivalenceVerified: true,
		readbackSha256: hash,
	};
	store.completePreparation(cycle.cycleId, 1, manifest, proof, notice, now);
	store.startNotice(cycle.cycleId, now);
	store.openWindow(
		cycle.cycleId,
		{
			...notice,
			messageId: "523456789012345678",
			verifiedAt: now,
			accessVerified: true,
			gatewayHealthy: true,
		},
		now,
	);
	const event: VerifiedReleaseInteraction = {
		interactionId: "723456789012345678",
		actorId: target.founderId,
		applicationId: target.applicationId,
		guildId: target.guildId,
		channelId: target.channelId,
		messageId: "523456789012345678",
		action: "veto",
		nonce: input.nonce,
		epoch: 1,
		content: card.content,
		components: card.components,
	};
	let delivery: ManualReleaseDelivery | null = null;
	const handler = new ReleaseCandidateActions({
		store,
		target: () => target,
		now: () => now + 1,
		manualDelivery: () => delivery,
	});
	return {
		db,
		store,
		cycle,
		handler,
		event,
		manifest,
		proof,
		input,
		setDelivery: (value: ManualReleaseDelivery | null) => {
			delivery = value;
		},
	};
}
it("authenticated nonce resolves the frozen full binding and atomically cancels before replying; restart/replay returns one receipt", () => {
	const f = fixture();
	expect(f.handler.commit(f.event)).toContain("已拦下");
	expect(f.store.get(f.cycle.cycleId)?.state).toBe("cancelled");
	const fresh = new ReleaseCandidateActions({
		store: new CustomerReleaseStore(f.db),
		target: () => target,
		now: () => now + 2,
		manualDelivery: () => null,
	});
	expect(fresh.commit(f.event)).toContain("已拦下");
	expect(
		f.db.prepare("SELECT count(*) AS n FROM customer_release_actions").get(),
	).toEqual({ n: 1 });
});
it.each([
	"nonce",
	"epoch",
	"guild",
	"actor",
	"message",
	"content",
	"component",
	"embed",
	"attachment",
])("rejects changed %s without accepting a veto", (kind) => {
	const f = fixture();
	const event = structuredClone(f.event);
	if (kind === "nonce") event.nonce = "f".repeat(32);
	if (kind === "epoch") event.epoch = 2;
	if (kind === "guild") event.guildId = target.channelId;
	if (kind === "actor") event.actorId = target.botUserId;
	if (kind === "message") event.messageId = event.interactionId;
	if (kind === "content") event.content += " changed";
	if (kind === "embed") event.embeds = [{ description: "spoof" }];
	if (kind === "attachment") event.attachments = [{ id: "spoof" }];
	if (kind === "component")
		(event.components[0] as any).components[0].label = "继续发布";
	expect(() => f.handler.commit(event)).toThrow();
	expect(f.store.get(f.cycle.cycleId)?.state).toBe("window_open");
	expect(
		f.db.prepare("SELECT count(*) AS n FROM customer_release_actions").get(),
	).toEqual({ n: 0 });
});
it("storage failure throws before a success reply and rolls back the cancellation", () => {
	const f = fixture();
	f.db.exec(
		"CREATE TRIGGER fail_action BEFORE INSERT ON customer_release_actions BEGIN SELECT RAISE(ABORT,'injected'); END",
	);
	expect(() => f.handler.commit(f.event)).toThrow("injected");
	expect(f.store.get(f.cycle.cycleId)?.state).toBe("window_open");
});
it("claim already won: records intervention and never claims the release was stopped", () => {
	const f = fixture();
	f.db
		.prepare(
			"UPDATE customer_release_cycles SET state='committing' WHERE cycle_id=?",
		)
		.run(f.cycle.cycleId);
	const reply = f.handler.commit(f.event);
	expect(reply).toContain("提交");
	expect(reply).not.toContain("已拦下");
	expect(f.store.get(f.cycle.cycleId)?.state).toBe("committing");
	expect(
		f.db
			.prepare("SELECT receipt_json AS receipt FROM customer_release_actions")
			.get(),
	).toMatchObject({
		receipt: expect.stringContaining('"result":"post_claim"'),
	});
});
it("manual go requires its own frozen card and fresh delivery proof; replay does not need a new probe", () => {
	const f = fixture();
	f.handler.commit(f.event);
	const nonce = "f".repeat(32),
		card = releaseCard({ ...f.input, kind: "go", nonce });
	const manifest = {
		...f.manifest,
		releaseOps: {
			...f.manifest.releaseOps,
			r2: { ...f.manifest.releaseOps.r1 },
		},
	};
	const fields = {
		activationEpoch: 1,
		policyRevision: "d".repeat(64),
		requestId: nonce,
		releaseId: "r2",
		channelId: target.channelId,
		applicationId: target.applicationId,
		botUserId: target.botUserId,
		founderId: target.founderId,
		messageDigest: releaseMessageDigest(card),
		expiresAt: now + 3600_000,
	};
	f.store.manual.prepare(f.cycle.cycleId, manifest, f.proof, fields, now);
	const event = {
		...f.event,
		interactionId: "823456789012345678",
		nonce,
		action: "go" as const,
		content: card.content,
		components: card.components,
	};
	expect(() => f.handler.commit(event)).toThrow();
	f.setDelivery({
		...fields,
		messageId: event.messageId,
		verifiedAt: now,
		accessVerified: true,
		gatewayHealthy: true,
	});
	expect(f.handler.commit(event)).toContain("已收到");
	expect(f.store.get(f.cycle.cycleId)?.state).toBe("manual_ready");
	f.setDelivery(null);
	expect(f.handler.commit(event)).toContain("已收到");
	expect(f.store.get(f.cycle.cycleId)?.windowOpenedAt).toBe(now);
});

it.each(["veto", "database_failure", "injected_embed"])(
	"Gateway-to-SQLite %s preserves commit-before-ACK",
	async (mode) => {
		const { EventEmitter } = await import("node:events");
		const { ReleaseInteractionGateway } = await import(
			"../customer-release/interaction-gateway.js"
		);
		class Socket extends EventEmitter {
			readyState = 1;
			send(_value: string) {}
			close() {
				this.readyState = 3;
			}
			frame(value: unknown) {
				this.emit("message", Buffer.from(JSON.stringify(value)), false);
			}
		}
		const socket = new Socket();
		let f: ReturnType<typeof fixture> | undefined;
		let acknowledgments = 0;
		const gateway = new ReleaseInteractionGateway({
			...target,
			token: "fixture-token",
			founderId: () => target.founderId,
			epoch: () => target.epoch,
			socket: () => socket as never,
			commit: (event) => f!.handler.commit(event),
			invalidate: (reason) => {
				f?.store.invalidateRuntime(reason, now + 2);
			},
			fetch: (async (url: string | URL | Request) => {
				const path = new URL(String(url)).pathname;
				if (path.endsWith("/callback")) {
					expect(f!.store.get(f!.cycle.cycleId)?.state).toBe("cancelled");
					expect(
						f!.db
							.prepare("SELECT count(*) AS n FROM customer_release_actions")
							.get(),
					).toEqual({ n: 1 });
					acknowledgments++;
					return new Response(null, { status: 204 });
				}
				return Response.json(
					path.endsWith("/users/@me")
						? { id: target.botUserId, bot: true }
						: path.endsWith("/applications/@me")
							? { id: target.applicationId, interactions_endpoint_url: null }
							: {
									url: "wss://gateway.discord.gg",
									session_start_limit: { remaining: 1, reset_after: 60000 },
								},
				);
			}) as typeof fetch,
		});
		try {
			await gateway.start();
			socket.frame({ op: 10, d: { heartbeat_interval: 60000 } });
			socket.frame({
				op: 0,
				s: 1,
				t: "READY",
				d: {
					user: { id: target.botUserId },
					application: { id: target.applicationId },
				},
			});
			socket.frame({ op: 11, d: null });
			f = fixture();
			if (mode === "database_failure")
				f.db.exec(
					"CREATE TRIGGER fail_gateway_action BEFORE INSERT ON customer_release_actions BEGIN SELECT RAISE(ABORT,'injected'); END",
				);
			socket.frame({
				op: 0,
				s: 2,
				t: "INTERACTION_CREATE",
				d: {
					id: f.event.interactionId,
					type: 3,
					version: 1,
					application_id: target.applicationId,
					guild_id: target.guildId,
					channel_id: target.channelId,
					token: "reply-secret",
					member: { user: { id: target.founderId, bot: false } },
					data: {
						component_type: 2,
						custom_id: `fwrel:veto:1:${f.event.nonce}`,
					},
					message: {
						id: f.event.messageId,
						author: { id: target.botUserId, bot: true },
						content: f.event.content,
						components: f.event.components,
						embeds: mode === "injected_embed" ? [{ description: "spoof" }] : [],
					},
				},
			});
			await Promise.resolve();
			expect(acknowledgments).toBe(mode === "veto" ? 1 : 0);
			expect(
				f.db
					.prepare("SELECT count(*) AS n FROM customer_release_actions")
					.get(),
			).toEqual({ n: mode === "veto" ? 1 : 0 });
		} finally {
			gateway.stop();
		}
	},
);
