import { describe, expect, it } from "vitest";
import { resolveIdentity } from "../identity.js";
import {
	type DeliveryEnvelopeLike,
	type HostPort,
	MailboxService,
	type MailboxStatusShape,
} from "../service.js";

function envelope(
	kind: string,
	payload: unknown,
	uid = "m1",
): DeliveryEnvelopeLike {
	return {
		v: 1,
		message: {
			messageUid: uid,
			payload: typeof payload === "string" ? payload : JSON.stringify(payload),
			kind,
			sourceKind: "test",
			seq: 7,
		},
		handle: { attemptUid: `${uid}#1`, messageUid: uid, agent: {} },
		authorization: { capabilityId: `cap-${uid}`, token: "t" },
		deliveryActionId: `mailbox-delivery:pa1:${uid}#1`,
		protocol: {},
	};
}

interface Call {
	verb: string;
	input?: unknown;
}

function makeHost(script: Array<DeliveryEnvelopeLike | "empty">): {
	host: HostPort;
	calls: Call[];
	enqueueResults: Array<{ status: string; reason?: string } | Error>;
} {
	const calls: Call[] = [];
	const enqueueResults: Array<{ status: string; reason?: string } | Error> = [];
	const host: HostPort = {
		async next() {
			calls.push({ verb: "next" });
			return script.shift() ?? "empty";
		},
		async submit(input) {
			calls.push({ verb: "submit", input });
			return { status: "succeeded" };
		},
		async enqueue(input) {
			calls.push({ verb: "enqueue", input });
			const scripted = enqueueResults.shift();
			if (scripted instanceof Error) throw scripted;
			return scripted ?? { status: "enqueued" };
		},
		async ask(input) {
			calls.push({ verb: "ask", input });
			return { uid: "ask-uid" };
		},
		async mailboxStatus() {
			calls.push({ verb: "status" });
			const status: MailboxStatusShape = {
				v: 1,
				recipient: "me",
				pendingTotal: 3,
				inProgressTotal: 0,
				maxPendingSeq: 42,
				kinds: [
					{
						kind: "issue_opened",
						askKind: null,
						count: 1,
						oldestSeq: 1,
						oldestCreatedAt: "t",
					},
					{
						kind: "runner_ask",
						askKind: "ask",
						count: 1,
						oldestSeq: 2,
						oldestCreatedAt: "t",
					},
					{
						kind: "runner_ask",
						askKind: "progress",
						count: 1,
						oldestSeq: 3,
						oldestCreatedAt: "t",
					},
				],
				pendingUids: ["a", "b", "c"],
				pendingUidsTruncated: false,
			};
			return status;
		},
		selfId: () => "me",
	};
	return { host, calls, enqueueResults };
}

describe("identity schema (§2.6)", () => {
	it("is mutually exclusive and fail-stop", () => {
		expect(resolveIdentity({ FLYWHEEL_V2_SESSION_REF: "v2dag:x" })).toEqual({
			mode: "runner",
			sessionRef: "v2dag:x",
		});
		expect(
			resolveIdentity({
				FLYWHEEL_V2_LEAD_AGENT_ID: "lead-a",
				FLYWHEEL_V2_LEAD_CREDENTIAL_FILE: "/tmp/cred.json",
			}),
		).toEqual({
			mode: "lead",
			agentId: "lead-a",
			credentialFile: "/tmp/cred.json",
		});
		expect(() =>
			resolveIdentity({
				FLYWHEEL_V2_SESSION_REF: "v2dag:x",
				FLYWHEEL_V2_LEAD_AGENT_ID: "lead-a",
			}),
		).toThrow(/mutually exclusive/);
		expect(() =>
			resolveIdentity({ FLYWHEEL_V2_LEAD_AGENT_ID: "lead-a" }),
		).toThrow(/incomplete/);
		expect(() => resolveIdentity({})).toThrow(/incomplete/);
	});
});

describe("FYI deferred ack (§2.2)", () => {
	it("returns the FYI without settling, then acks it on the NEXT tool call", async () => {
		const { host, calls } = makeHost([
			envelope("issue_opened", { v: 1 }, "fyi-1"),
			"empty",
		]);
		const service = new MailboxService(host);
		const first = await service.next();
		expect(first).toMatchObject({ status: "letter", chapter: "fyi" });
		// No submit yet — the crash window keeps the letter redeliverable.
		expect(calls.filter((c) => c.verb === "submit")).toHaveLength(0);
		const second = await service.next();
		expect(second).toEqual({ status: "empty" });
		const submits = calls.filter((c) => c.verb === "submit");
		expect(submits).toHaveLength(1);
		expect(submits[0]?.input).toMatchObject({
			attemptUid: "fyi-1#1",
			effects: [],
		});
	});

	it("acks a pending FYI before any other tool acts", async () => {
		const { host, calls } = makeHost([envelope("pr_ready", { v: 1 }, "fyi-2")]);
		const service = new MailboxService(host);
		await service.next();
		await service.status();
		expect(calls.map((c) => c.verb)).toEqual(["next", "submit", "status"]);
	});
});

describe("actionable settle (§2.4)", () => {
	const ask = envelope(
		"runner_ask",
		{
			v: 1,
			session_ref: "v2dag:asker",
			issue_id: "FLY-1",
			ask_kind: "ask",
			uid: "q-1",
			body: "which port?",
		},
		"ask-1",
	);

	it("holds the letter until settle and re-surfaces it on repeated next", async () => {
		const { host, calls } = makeHost([structuredClone(ask)]);
		const service = new MailboxService(host);
		const first = await service.next();
		expect(first).toMatchObject({ status: "letter", chapter: "actionable" });
		const again = await service.next();
		expect(again.note).toContain("仍未办结");
		// Only ONE host pull happened — no self-inflicted lost-handoff.
		expect(calls.filter((c) => c.verb === "next")).toHaveLength(1);
	});

	it("settle(reply) derives the route from the envelope and enqueues before settling", async () => {
		const { host, calls } = makeHost([structuredClone(ask)]);
		const service = new MailboxService(host);
		await service.next();
		const result = await service.settle({ reply: { body: "port 8080" } });
		expect(result).toEqual({ settled: "ask-1", replyEnqueued: true });
		const verbs = calls.map((c) => c.verb);
		expect(verbs.indexOf("enqueue")).toBeLessThan(verbs.indexOf("submit"));
		const enqueue = calls.find((c) => c.verb === "enqueue")?.input as Record<
			string,
			unknown
		>;
		expect(enqueue).toMatchObject({
			sourceKind: "mailbox_reply",
			sourceId: "mailbox_reply:ask-1",
			toAgent: "v2dag:asker",
			kind: "ask_response",
		});
		expect(JSON.parse(enqueue.payload as string)).toMatchObject({
			uid: "q-1",
			body: "port 8080",
			answered_by: "me",
		});
	});

	it("treats a byte-identical duplicate reply as success (takeover replay)", async () => {
		const { host, enqueueResults } = makeHost([structuredClone(ask)]);
		enqueueResults.push({ status: "duplicate" });
		const service = new MailboxService(host);
		await service.next();
		await expect(
			service.settle({ reply: { body: "port 8080" } }),
		).resolves.toMatchObject({ replyEnqueued: true });
	});

	it("refuses settle(reply) on a non-answerable letter", async () => {
		const { host } = makeHost([envelope("ask_response", { v: 1 }, "r-1")]);
		const service = new MailboxService(host);
		await service.next(); // fyi chapter — auto-ack path
		await expect(service.settle({ reply: { body: "x" } })).rejects.toThrow(
			/no outstanding letter/,
		);
	});

	it("never auto-acks an unknown kind and refuses ordinary settlement (R3-F2)", async () => {
		const { host, calls } = makeHost([
			envelope("brand_new_kind", { v: 1 }, "u-1"),
			"empty",
		]);
		const service = new MailboxService(host);
		const first = await service.next();
		expect(first.chapter).toBe("unknown");
		expect(first.note).toContain("不会自动办结");
		// A further next re-surfaces it instead of pulling past it or acking.
		const again = await service.next();
		expect(again.note).toContain("仍未办结");
		expect(calls.filter((c) => c.verb === "submit")).toHaveLength(0);
		// Ordinary settlement is refused — unclassified protocol input stays the
		// visible debt; only the ledger side can clear it.
		await expect(service.settle()).rejects.toThrow(/cannot be classified/);
		expect(calls.filter((c) => c.verb === "submit")).toHaveLength(0);
	});

	it("refuses a bare settle on an answer-requiring ask, allows it after a proven conflict (R3-F2)", async () => {
		const { host, enqueueResults, calls } = makeHost([structuredClone(ask)]);
		const service = new MailboxService(host);
		await service.next();
		await expect(service.settle()).rejects.toThrow(/requires an answer/);
		// A byte-different reply conflict = durable proof a canonical reply exists.
		enqueueResults.push(new Error("CanonicalConflict: mailbox_reply:ask-1"));
		await expect(
			service.settle({ reply: { body: "different answer" } }),
		).rejects.toThrow(/durably exists/);
		// Now — and only now — settle without reply closes the debt.
		await expect(service.settle()).resolves.toMatchObject({
			settled: "ask-1",
		});
		expect(calls.filter((c) => c.verb === "submit")).toHaveLength(1);
	});

	it("serializes concurrent tool calls — a second next cannot reach the host mid-flight (R3-F1)", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const order: string[] = [];
		const { host } = makeHost([]);
		const slowHost = {
			...host,
			next: async () => {
				order.push("enter");
				await gate;
				order.push("exit");
				return "empty" as const;
			},
		};
		const service = new MailboxService(slowHost);
		const first = service.next();
		const second = service.next();
		await new Promise((resolve) => setTimeout(resolve, 20));
		// Only ONE host call has entered while the first is in flight.
		expect(order).toEqual(["enter"]);
		release();
		await first;
		await second;
		expect(order).toEqual(["enter", "exit", "enter", "exit"]);
	});
});

describe("lead credential generation safety (R3-F4)", () => {
	it("caches the startup credential and never adopts a rewritten file", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const { createHostPort } = await import("../host-port.js");
		const dir = mkdtempSync(join(tmpdir(), "fly1547-cred-"));
		const file = join(dir, "cred.json");
		writeFileSync(file, JSON.stringify({ credentialId: "gen-1", token: "t1" }));
		const requests: Array<{ action: string; payload: unknown }> = [];
		const fakeClient = {
			request: async (action: string, payload: unknown) => {
				requests.push({ action, payload });
				return { v: 1, kinds: [], pendingUids: [] };
			},
			submitProposalWithRetry: async () => ({}),
		};
		const port = createHostPort(fakeClient as never, {
			mode: "lead",
			agentId: "lead-x",
			credentialFile: file,
		});
		await port.mailboxStatus();
		// Takeover rewrites the file for the NEW child…
		writeFileSync(file, JSON.stringify({ credentialId: "gen-2", token: "t2" }));
		await port.mailboxStatus();
		// …but THIS child keeps presenting its own generation's bearer.
		const presented = requests.map(
			(r) =>
				(r.payload as { deliveryCredential: { credentialId: string } })
					.deliveryCredential.credentialId,
		);
		expect(presented).toEqual(["gen-1", "gen-1"]);
	});
});

describe("send / status (§2.4, §2.3)", () => {
	it("requires a caller dedupe key and namespaces it by sender", async () => {
		const { host, calls } = makeHost([]);
		const service = new MailboxService(host);
		await expect(
			service.send({
				to: "lead-a",
				kind: "instruction",
				body: "b",
				dedupeKey: " ",
			}),
		).rejects.toThrow(/dedupe_key/);
		await expect(
			service.send({
				to: "lead-a",
				kind: "made_up_kind",
				body: "b",
				dedupeKey: "k0",
			}),
		).rejects.toThrow(/send vocabulary/);
		await service.send({
			to: "lead-a",
			kind: "instruction",
			body: "b",
			dedupeKey: "k1",
		});
		expect(calls.find((c) => c.verb === "enqueue")?.input).toMatchObject({
			sourceId: "mcp_send:me:k1",
		});
	});

	it("derives chapter counts from the shared disposition", async () => {
		const { host } = makeHost([]);
		const service = new MailboxService(host);
		const status = await service.status();
		// issue_opened (fyi) + runner_ask/progress (fyi) vs runner_ask/ask.
		expect(status.chapters).toEqual({ fyi: 2, actionable: 1, unknown: 0 });
	});
});
