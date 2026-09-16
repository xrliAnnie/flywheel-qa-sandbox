import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinearClient } from "@linear/sdk";
import express from "express";
import {
	identityEnvProjection,
	resolveLeadIdentityRow,
} from "flywheel-comm/lead-identity";
import { hashCarrierInstanceId } from "flywheel-comm/lead-lease";
import { expect, it, vi } from "vitest";
import { createLeadCapabilityDiscordRouter } from "../../bridge/lead-capability-discord.js";
import { CodexOutboundSender } from "../../lead-backends/codex/CodexOutboundSender.js";
import { LeadJournal } from "../../lead-backends/codex/LeadJournal.js";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { SqliteOutboundDedupStore } from "../../lead-backends/codex/SqliteOutboundDedupStore.js";
import { StateStore } from "../../StateStore.js";
import { createAutomaticOutboundTransport } from "../automatic-outbound.js";
import { LeadCapabilityBroker } from "../broker.js";
import { createBridgeDiscordHandlers } from "../handlers/bridge-discord.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFileSync: (file: string, ...args: unknown[]) =>
			file === "ps"
				? "fixture-start\n"
				: (actual.execFileSync as (...args: unknown[]) => unknown)(
						file,
						...args,
					),
	};
});
async function fixture(reply = false, lostDiscord = false) {
	const home = mkdtempSync(join(tmpdir(), "bridge-adapter-")),
		projectsPath = join(home, "projects.json");
	mkdirSync(join(home, ".flywheel"));
	writeFileSync(
		join(home, ".flywheel/summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "founder",
			setAt: "2026-08-28T00:00:00.000Z",
		}),
	);
	const projects = [
		{
			projectName: "flywheel",
			projectRoot: home,
			linear: { team: "FLY", project: "Flywheel" },
			leads: [
				{
					agentId: "eng",
					summaryRole: "producer",
					backend: "codex-app-server",
					codexProfile: "full-access",
					codexCapabilityBundleVersion: 2,
					canSpawnRunners: false,
					botTokenEnv: "BOT_TOKEN",
					botUserId: "12345678901234567",
					chatChannel: "22345678901234567",
					match: { labels: ["Engineering"] },
				},
			],
		},
	];
	writeFileSync(projectsPath, JSON.stringify(projects));
	const row = resolveLeadIdentityRow({
		projectsPath,
		homeDir: home,
		projectName: "flywheel",
		leadId: "eng",
	});
	const claim = "PARENT_CLAIM_CANARY",
		carrierPath = join(home, "carrier.json");
	const carrier = {
		schemaVersion: 1,
		collectedAt: new Date().toISOString(),
		leads: {
			[row.identity.leadKey]: {
				leadKey: row.identity.leadKey,
				backend: "codex-app-server",
				identityDigest: row.identity.identityDigest,
				pid: process.pid,
				lstart: execFileSync(
					"ps",
					["-o", "lstart=", "-p", String(process.pid)],
					{ encoding: "utf8" },
				).trim(),
				instanceDigest: hashCarrierInstanceId(claim),
			},
		},
	};
	writeFileSync(carrierPath, JSON.stringify(carrier));
	const env: NodeJS.ProcessEnv = {
		HOME: home,
		FLYWHEEL_PROJECTS_FILE: projectsPath,
		FLYWHEEL_CODEX_LEAD_PROFILE: "full-access",
		FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION: "2",
		FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE: carrierPath,
		FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: claim,
		FLYWHEEL_API_TOKEN: "BRIDGE_TOKEN_CANARY",
		...Object.fromEntries(
			identityEnvProjection(row.identity).map((line) => {
				const index = line.indexOf("=");
				return [line.slice(0, index), line.slice(index + 1)];
			}),
		),
	};
	const bridgeStore = await StateStore.create(":memory:");
	bridgeStore.registerChatThreadConditional(
		"32345678901234567",
		"22345678901234567",
		"FLY-1",
		"eng",
	);
	const linearClient = {
		issue: async () => ({
			identifier: "FLY-1",
			team: Promise.resolve({ key: "FLY" }),
			project: Promise.resolve({ name: "Flywheel" }),
			labels: async () => ({
				nodes: [{ name: "Engineering" }],
				pageInfo: { hasNextPage: false },
			}),
		}),
	} as unknown as LinearClient;
	let writes = 0,
		requests = 0;
	const realFetch = globalThis.fetch;
	const spy = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (url, init) => {
			if (!String(url).startsWith("https://discord.com/"))
				return realFetch(url, init);
			if (reply && init?.method === "POST") {
				writes++;
				if (lostDiscord) throw new Error("discord_response_lost");
				return Response.json({ id: "42345678901234567" });
			}
			if (init?.method === "PATCH") {
				writes++;
				return new Response(null, { status: 204 });
			}
			return new Response(
				JSON.stringify(
					String(url).includes("/messages/")
						? {
								id: "42345678901234567",
								channel_id: "32345678901234567",
								content: "old",
								timestamp: new Date().toISOString(),
								author: { id: "12345678901234567", bot: true },
							}
						: {
								id: "32345678901234567",
								parent_id: "22345678901234567",
								type: 11,
							},
				),
				{ status: 200 },
			);
		});
	const outboundDedupStore = new SqliteOutboundDedupStore(
		join(home, "dedup.db"),
	);
	if (!reply) {
		const seed = new CodexOutboundSender({
			bridgeUrl: "http://fixture",
			apiToken: "fixture",
			projectName: "flywheel",
			leadId: "eng",
			channelId: "32345678901234567",
			dbPath: join(home, "outbox.db"),
			post: async () => ({
				status: 200,
				body: JSON.stringify({
					status: "sent",
					messageId: "42345678901234567",
				}),
			}),
		});
		try {
			const id = await seed.enqueue({
				leadId: "eng",
				text: "original Lead reply",
				idempotencyKey: "fixture-owned-send",
			});
			await seed.deliverWithResult(id);
		} finally {
			seed.close();
		}
	}
	const app = express();
	app.use(express.json({ limit: "64kb" }));
	app.use(
		"/api/lead-capabilities/discord",
		(_req, _res, next) => {
			requests++;
			next();
		},
		createLeadCapabilityDiscordRouter({
			apiToken: env.FLYWHEEL_API_TOKEN!,
			store: bridgeStore,
			projectsPath,
			homeDir: home,
			env: { ...env, BOT_TOKEN: "DISCORD_TOKEN_CANARY" },
			linearClient,
			outboundDedupStore,
			operationReceipts: outboundDedupStore.operationReceipts,
			outboundDbPath: join(home, "outbox.db"),
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	env.FLYWHEEL_BRIDGE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const journalPath = join(home, "parent.sqlite");
	let journal = new SqliteJournalStore(journalPath);
	const build = (
		fetchImpl: typeof fetch = realFetch,
		deliveryContext?: string,
	) =>
		new LeadCapabilityBroker({
			projectName: "flywheel",
			leadId: "eng",
			activationId: "activation-1",
			receipts: journal.operationReceipts,
			...(deliveryContext
				? {
						deliveryContext: () => ({
							id: deliveryContext,
							assertCurrent: () => {},
						}),
					}
				: {}),
			allowedOperationIds: () =>
				new Set([reply ? "discord.thread.reply" : "discord.message.edit"]),
			assertCurrent: async () => {},
			handlers: createBridgeDiscordHandlers({
				env,
				activationId: "activation-1",
				fetchImpl,
			}),
			secrets: ["BRIDGE_TOKEN_CANARY", claim],
		});
	const request = {
		schemaVersion: 1,
		operationId: reply ? "discord.thread.reply" : "discord.message.edit",
		requestId: randomUUID(),
		input: {
			threadId: "32345678901234567",
			...(reply ? {} : { messageId: "42345678901234567" }),
			text: "updated",
		},
	};
	return {
		env,
		projects,
		projectsPath,
		carrier,
		carrierPath,
		build,
		request,
		realFetch,
		stats: () => ({ writes, requests }),
		journal: () => journal,
		restart: () => {
			journal.close();
			journal = new SqliteJournalStore(journalPath);
		},
		seedDispatched: () => {
			const input = Object.fromEntries(
				Object.entries(request.input).sort(([a], [b]) => a.localeCompare(b)),
			);
			const record = {
				projectName: "flywheel",
				leadId: "eng",
				operationId: request.operationId,
				requestId: request.requestId,
				activationId: "activation-1",
				inputDigest: createHash("sha256")
					.update(JSON.stringify(input))
					.digest("hex"),
				now: Date.now(),
			};
			journal.operationReceipts.prepare(record);
			journal.operationReceipts.transition({
				...record,
				from: "prepared",
				to: "dispatched",
			});
		},
		receipt: () =>
			journal.operationReceipts.get({
				projectName: "flywheel",
				leadId: "eng",
				operationId: request.operationId,
				requestId: request.requestId,
			}),
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			spy.mockRestore();
			bridgeStore.close();
			outboundDedupStore?.close();
			journal.close();
			rmSync(home, { recursive: true, force: true });
		},
	};
}
it("dispatches once through the real Bridge router after the parent receipt is durable", async () => {
	const f = await fixture();
	try {
		const broker = f.build(async (url, init) => {
			expect(f.receipt()?.state).toBe("dispatched");
			return f.realFetch(url, init);
		});
		expect(await broker.execute(f.request)).toMatchObject({
			status: "succeeded",
			data: { messageId: "42345678901234567" },
		});
		expect((await broker.execute(f.request)).status).toBe("succeeded");
		expect(f.stats()).toEqual({ writes: 1, requests: 1 });
	} finally {
		await f.close();
	}
});
it.each([false, true])(
	"parent restart reconciles a lost response without repeating a Discord write; lost=%s",
	async (lost) => {
		const f = await fixture();
		try {
			const broker = f.build(async (url, init) => {
				const response = await f.realFetch(url, init);
				if (lost) {
					await response.text();
					throw new Error("PRIVATE_PROVIDER_ERROR");
				}
				return response;
			});
			expect((await broker.execute(f.request)).status).toBe(
				lost ? "unknown" : "succeeded",
			);
			expect(f.stats()).toEqual({ writes: 1, requests: 1 });
			f.restart();
			const restarted = f.build();
			expect((await restarted.execute(f.request)).status).toBe("succeeded");
			expect(f.stats()).toEqual({ writes: 1, requests: lost ? 2 : 1 });
			const conflict = await restarted.execute({
				...f.request,
				input: { ...f.request.input, text: "changed" },
			});
			expect(conflict.errorCode).toBe("input_digest_conflict");
			expect(f.stats()).toEqual({ writes: 1, requests: lost ? 2 : 1 });
		} finally {
			await f.close();
		}
	},
);
it.each(["uuid", "input", "carrier", "activation", "registry"])(
	"denies %s before any Bridge request",
	async (mode) => {
		const f = await fixture();
		try {
			const handlers = createBridgeDiscordHandlers({
				env: f.env,
				activationId: "activation-1",
				fetchImpl: f.realFetch,
			});
			const context = {
				projectName: "flywheel",
				leadId: "eng",
				activationId: mode === "activation" ? "foreign" : "activation-1",
				requestId: mode === "uuid" ? "bad" : f.request.requestId,
				signal: new AbortController().signal,
				assertCurrent: async () => {},
			};
			if (mode === "carrier") {
				f.carrier.leads[Object.keys(f.carrier.leads)[0]!]!.instanceDigest =
					hashCarrierInstanceId("replacement");
				writeFileSync(f.carrierPath, JSON.stringify(f.carrier));
			}
			if (mode === "registry") {
				f.projects[0]!.leads[0]!.codexCapabilityBundleVersion = 1;
				writeFileSync(f.projectsPath, JSON.stringify(f.projects));
			}
			await expect(
				handlers.get("discord.message.edit")!.authorize(
					{
						...f.request.input,
						...(mode === "input" ? { projectName: "foreign" } : {}),
					},
					context,
				),
			).rejects.toThrow();
			expect(f.stats()).toEqual({ writes: 0, requests: 0 });
		} finally {
			await f.close();
		}
	},
);
it.each([
	"wrong-id",
	"oversized",
	"redirect",
	"bad-json",
	"secret",
	"unknown",
	"rejected",
])("bounds and validates provider result %s without retries", async (mode) => {
	const f = await fixture();
	try {
		const fetchImpl = vi.fn(async () => {
			if (mode === "oversized") return new Response("x".repeat(262145));
			if (mode === "redirect")
				return new Response(null, {
					status: 302,
					headers: { location: "https://evil.test" },
				});
			if (mode === "bad-json") return new Response("PRIVATE_ERROR");
			return new Response(
				JSON.stringify({
					requestId: mode === "wrong-id" ? randomUUID() : f.request.requestId,
					status:
						mode === "unknown"
							? "unknown"
							: mode === "rejected"
								? "rejected"
								: "succeeded",
					resourceRefs: ["discord-message:42345678901234567"],
					data: {
						messageId:
							mode === "secret" ? "BRIDGE_TOKEN_CANARY" : "42345678901234567",
						receiptId: "receipt",
						observedAt: new Date().toISOString(),
					},
				}),
			);
		});
		const result = await f.build(fetchImpl).execute(f.request);
		expect(result.status).toBe(mode === "rejected" ? "rejected" : "unknown");
		expect(JSON.stringify(result)).not.toContain("CANARY");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	} finally {
		await f.close();
	}
});
it("enforces the 15-second adapter deadline and aborts stalled provider fetch", async () => {
	const f = await fixture();
	try {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const fetchImpl = vi.fn(async (_url, init) => {
			signal = init?.signal as AbortSignal;
			return await new Promise<Response>(() => {});
		});
		const h = createBridgeDiscordHandlers({
			env: f.env,
			activationId: "activation-1",
			fetchImpl,
		}).get("discord.message.edit")!;
		const pending = h.execute(f.request.input, {
			projectName: "flywheel",
			leadId: "eng",
			activationId: "activation-1",
			requestId: f.request.requestId,
			signal: new AbortController().signal,
			assertCurrent: async () => {},
		});
		await vi.advanceTimersByTimeAsync(15000);
		expect(await pending).toEqual({ status: "unknown" });
		expect(signal?.aborted).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
		await f.close();
	}
});
it("cancels an oversized unread response body", async () => {
	const f = await fixture();
	try {
		const cancel = vi.fn();
		const result = await f
			.build(
				async () =>
					new Response(new ReadableStream({ cancel }), {
						headers: { "content-length": "262145" },
					}),
			)
			.execute(f.request);
		expect(result.status).toBe("unknown");
		expect(cancel).toHaveBeenCalledTimes(1);
	} finally {
		await f.close();
	}
});

it("retains a crash-boundary dispatched receipt after parent restart without HTTP replay", async () => {
	const f = await fixture();
	try {
		f.seedDispatched();
		f.restart();
		expect((await f.build().execute(f.request)).status).toBe("pending");
		expect(f.stats()).toEqual({ writes: 0, requests: 0 });
		expect(
			(
				await f.build().execute({
					...f.request,
					input: { ...f.request.input, text: "different" },
				})
			).errorCode,
		).toBe("input_digest_conflict");
		expect(f.stats()).toEqual({ writes: 0, requests: 0 });
	} finally {
		await f.close();
	}
});
it("cancels a stalled response stream at the deadline", async () => {
	const f = await fixture();
	try {
		vi.useFakeTimers();
		const cancel = vi.fn();
		const h = createBridgeDiscordHandlers({
			env: f.env,
			activationId: "activation-1",
			fetchImpl: async () => new Response(new ReadableStream({ cancel })),
		}).get("discord.message.edit")!;
		const pending = h.execute(f.request.input, {
			projectName: "flywheel",
			leadId: "eng",
			activationId: "activation-1",
			requestId: f.request.requestId,
			signal: new AbortController().signal,
			assertCurrent: async () => {},
		});
		await vi.advanceTimersByTimeAsync(15000);
		expect(await pending).toEqual({ status: "unknown" });
		expect(cancel).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
		await f.close();
	}
});
it("captures trusted Bridge credentials and origin independently of later env mutation", async () => {
	const f = await fixture();
	try {
		const broker = f.build();
		f.env.FLYWHEEL_BRIDGE_URL = "https://evil.test";
		f.env.FLYWHEEL_API_TOKEN = "replacement";
		expect((await broker.execute(f.request)).status).toBe("succeeded");
		expect(f.stats()).toEqual({ writes: 1, requests: 1 });
	} finally {
		await f.close();
	}
});
it("rechecks the carrier after a provider await and retains an uncertain write", async () => {
	const f = await fixture();
	try {
		const broker = f.build(async (url, init) => {
			const response = await f.realFetch(url, init);
			f.carrier.leads[Object.keys(f.carrier.leads)[0]!]!.instanceDigest =
				hashCarrierInstanceId("replacement");
			writeFileSync(f.carrierPath, JSON.stringify(f.carrier));
			return response;
		});
		expect((await broker.execute(f.request)).status).toBe("unknown");
		expect(f.stats()).toEqual({ writes: 1, requests: 1 });
	} finally {
		await f.close();
	}
});
it("reduces parent guard errors to a stable adapter error", async () => {
	const f = await fixture();
	try {
		const h = createBridgeDiscordHandlers({
			env: f.env,
			activationId: "activation-1",
		}).get("discord.message.edit")!;
		await expect(
			h.authorize(f.request.input, {
				projectName: "flywheel",
				leadId: "eng",
				activationId: "activation-1",
				requestId: f.request.requestId,
				signal: new AbortController().signal,
				assertCurrent: async () => {
					throw new Error("PRIVATE_GUARD_CANARY");
				},
			}),
		).rejects.toThrow("bridge_discord_scope_denied");
		expect(f.stats()).toEqual({ writes: 0, requests: 0 });
	} finally {
		await f.close();
	}
});

it.each([false, true])(
	"typed reply keeps durable parent outcome across restart; lost=%s",
	async (lost) => {
		const f = await fixture(true);
		try {
			const broker = f.build(async (url, init) => {
				const response = await f.realFetch(url, init);
				if (lost) {
					await response.text();
					throw new Error("lost_reply_response");
				}
				return response;
			});
			expect((await broker.execute(f.request)).status).toBe(
				lost ? "unknown" : "succeeded",
			);
			await broker.close();
			f.restart();
			const restarted = f.build();
			expect((await restarted.execute(f.request)).status).toBe("succeeded");
			expect(f.stats()).toEqual({ writes: 1, requests: lost ? 2 : 1 });
			await restarted.close();
		} finally {
			await f.close();
		}
	},
);

it("carries the parent context through actual typed Bridge delivery across different request keys", async () => {
	const f = await fixture(true);
	try {
		const request = {
			...f.request,
			input: { ...f.request.input, eventId: "same-business-event" },
		};
		const first = f.build(undefined, "journal-entry-1");
		expect((await first.execute(request)).status).toBe("succeeded");
		await first.close();
		f.restart();
		const second = f.build(undefined, "journal-entry-1");
		expect(
			(await second.execute({ ...request, requestId: randomUUID() })).status,
		).toBe("succeeded");
		expect(f.stats()).toEqual({ writes: 1, requests: 2 });
		await second.close();
		const third = f.build(undefined, "journal-entry-2");
		expect(
			(await third.execute({ ...request, requestId: randomUUID() })).status,
		).toBe("succeeded");
		expect(f.stats()).toEqual({ writes: 2, requests: 3 });
		await third.close();
	} finally {
		await f.close();
	}
});

it("deduplicates a typed reply and authenticated automatic output in the same journal context", async () => {
	const f = await fixture(true);
	try {
		const broker = f.build(undefined, "journal-auto");
		expect((await broker.execute(f.request)).status).toBe("succeeded");
		await broker.close();
		const response = await f.realFetch(
			`${f.env.FLYWHEEL_BRIDGE_URL}/api/lead-capabilities/discord`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${f.env.FLYWHEEL_API_TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					schemaVersion: 1,
					operationId: "discord.output.deliver",
					requestId: randomUUID(),
					projectName: "flywheel",
					leadId: "eng",
					identityDigest: f.env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
					carrierClaim: f.env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID,
					activationId: "activation-1",
					deliveryContext: "journal-auto",
					input: {
						channelId: f.request.input.threadId,
						text: f.request.input.text,
						idempotencyKey: "journal-auto:out",
						nonce: "automatic-nonce",
					},
				}),
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: "succeeded",
			data: { status: "deduped" },
		});
		expect(f.stats().writes).toBe(1);
	} finally {
		await f.close();
	}
});

it.each(["carrier", "lead", "context", "input"])(
	"automatic output rejects invalid %s before sending",
	async (kind) => {
		const f = await fixture(true);
		try {
			const body: Record<string, unknown> = {
				schemaVersion: 1,
				operationId: "discord.output.deliver",
				requestId: randomUUID(),
				projectName: "flywheel",
				leadId: "eng",
				identityDigest: f.env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
				carrierClaim: f.env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID,
				activationId: "activation-1",
				deliveryContext: "journal-auto",
				input: {
					channelId: "22345678901234567",
					text: "automatic reply",
					idempotencyKey: "journal-auto:out",
					nonce: "automatic-nonce",
				},
			};
			if (kind === "carrier") body.carrierClaim = "foreign";
			if (kind === "lead") body.leadId = "foreign";
			if (kind === "context") delete body.deliveryContext;
			if (kind === "input")
				body.input = {
					...(body.input as object),
					deliveryContext: "model-forged",
				};
			const response = await f.realFetch(
				`${f.env.FLYWHEEL_BRIDGE_URL}/api/lead-capabilities/discord`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${f.env.FLYWHEEL_API_TOKEN}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				},
			);
			expect([400, 403]).toContain(response.status);
			expect(f.stats().writes).toBe(0);
		} finally {
			await f.close();
		}
	},
);

it("keeps uncertain automatic output unknown across different request keys without another Discord write", async () => {
	const f = await fixture(true, true);
	try {
		for (let i = 0; i < 2; i++) {
			const response = await f.realFetch(
				`${f.env.FLYWHEEL_BRIDGE_URL}/api/lead-capabilities/discord`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${f.env.FLYWHEEL_API_TOKEN}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						schemaVersion: 1,
						operationId: "discord.output.deliver",
						requestId: randomUUID(),
						projectName: "flywheel",
						leadId: "eng",
						identityDigest: f.env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
						carrierClaim: f.env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID,
						activationId: "activation-1",
						deliveryContext: "journal-unknown",
						input: {
							channelId: "22345678901234567",
							text: "reply",
							idempotencyKey: `request-${i}`,
							nonce: `nonce-${i}`,
						},
					}),
				},
			);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				status: "unknown",
				data: { status: "ambiguous" },
			});
		}
		expect(f.stats().writes).toBe(1);
	} finally {
		await f.close();
	}
});

it("authorizes automatic startup output without a journal context or Discord write", async () => {
	const f = await fixture(true);
	try {
		const response = await f.realFetch(
			`${f.env.FLYWHEEL_BRIDGE_URL}/api/lead-capabilities/discord`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${f.env.FLYWHEEL_API_TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					schemaVersion: 1,
					operationId: "discord.output.authorize",
					requestId: randomUUID(),
					projectName: "flywheel",
					leadId: "eng",
					identityDigest: f.env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
					carrierClaim: f.env.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID,
					activationId: "activation-1",
					input: { channelId: "22345678901234567" },
				}),
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: "succeeded",
			data: { status: "authorized" },
		});
		expect(f.stats().writes).toBe(0);
	} finally {
		await f.close();
	}
});

it("sends persisted automatic output through the parent adapter and rejects changed output before HTTP", async () => {
	const f = await fixture(true);
	try {
		const journal = new LeadJournal({ store: f.journal() });
		const { entry } = journal.accept({
			idempotencyKey: "automatic-input",
			source: "discord",
			payload: "input",
		});
		journal.toDispatching(entry.id, "corr");
		journal.toDispatched(entry.id, "turn");
		journal.toModelCompleted(entry.id, "actual output");
		const post = createAutomaticOutboundTransport({
			env: f.env,
			activationId: "activation-1",
			journal: f.journal(),
			assertCurrent: async () => {},
			fetchImpl: f.realFetch,
		});
		const request = {
			url: "https://untrusted.invalid",
			headers: { authorization: "untrusted" },
			deliveryContext: entry.id,
			body: JSON.stringify({
				projectName: "flywheel",
				leadId: "eng",
				channelId: "22345678901234567",
				text: "actual output",
				idempotencyKey: `${entry.id}:out`,
				nonce: "nonce",
			}),
		};
		const probe = await post({
			url: "ignored",
			headers: {},
			body: JSON.stringify({
				projectName: "flywheel",
				leadId: "eng",
				channelId: "22345678901234567",
				probe: true,
			}),
		});
		expect(JSON.parse(probe.body)).toEqual({ status: "authorized" });
		expect(f.stats().writes).toBe(0);
		const result = await post(request);
		expect(result.status).toBe(200);
		expect(JSON.parse(result.body)).toMatchObject({ status: "sent" });
		expect(f.stats().writes).toBe(1);
		await expect(
			post({
				...request,
				body: request.body.replace("actual output", "forged output"),
			}),
		).rejects.toThrow();
		expect(f.stats()).toEqual({ writes: 1, requests: 2 });
	} finally {
		await f.close();
	}
});

it.each(["wrong-id", "oversized", "secret", "timeout"])(
	"automatic parent transport rejects %s without retries",
	async (mode) => {
		const f = await fixture(true);
		try {
			const fetcher = vi.fn(
				async (_url: unknown, init?: RequestInit): Promise<Response> => {
					if (mode === "timeout") return new Promise(() => {});
					if (mode === "oversized") return new Response("x".repeat(8193));
					const sent = JSON.parse(init!.body as string);
					return Response.json({
						requestId: mode === "wrong-id" ? randomUUID() : sent.requestId,
						status: "succeeded",
						resourceRefs: [],
						data: {
							status: "authorized",
							...(mode === "secret"
								? { reason: f.env.FLYWHEEL_API_TOKEN }
								: {}),
						},
					});
				},
			);
			const post = createAutomaticOutboundTransport({
				env: f.env,
				activationId: "activation-1",
				journal: f.journal(),
				assertCurrent: async () => {},
				fetchImpl: fetcher as typeof fetch,
			});
			if (mode === "timeout") vi.useFakeTimers();
			const result = post({
				url: "ignored",
				headers: {},
				body: JSON.stringify({
					projectName: "flywheel",
					leadId: "eng",
					channelId: "22345678901234567",
					probe: true,
				}),
			});
			const rejected = expect(result).rejects.toThrow(
				"automatic_outbound_unverified",
			);
			if (mode === "timeout") await vi.advanceTimersByTimeAsync(15001);
			await rejected;
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(f.stats().writes).toBe(0);
		} finally {
			vi.useRealTimers();
			await f.close();
		}
	},
);

it("receipt-only retry stays unknown when the original request never reached Bridge", async () => {
	const f = await fixture(true);
	try {
		const broker = f.build(async () => {
			throw new Error("connection_lost");
		});
		expect((await broker.execute(f.request)).status).toBe("unknown");
		f.restart();
		const restarted = f.build();
		expect((await restarted.execute(f.request)).status).toBe("unknown");
		expect(f.stats()).toEqual({ writes: 0, requests: 1 });
	} finally {
		await f.close();
	}
});
