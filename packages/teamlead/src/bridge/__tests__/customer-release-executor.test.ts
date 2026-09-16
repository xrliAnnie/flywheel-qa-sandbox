import { expect, it } from "vitest";
import { CustomerReleaseMailbox } from "../customer-release/executor.js";
import type {
	CustomerReadyAttempt,
	CustomerReleasePermit,
} from "../customer-release/types.js";

const attempt: CustomerReadyAttempt = {
	attemptId: "12345678-1234-1234-1234-123456789abc",
	cycleId: "cycle-1",
	projectId: "flywheel",
	audience: "payload",
	activationEpoch: 1,
	nonce: "a".repeat(64),
	baseEtag: "original",
	readyAt: 1000,
	readbackSha256: "b".repeat(64),
	fullBinding: {
		releaseId: "candidate",
		betaVersion: "1.2.3-beta.1",
		betaPayloadSha256: "c".repeat(64),
		releaseVersion: "1.2.3",
		releasePayloadSha256: "b".repeat(64),
		sourceCommit: "d".repeat(40),
	},
};
const permit: CustomerReleasePermit = {
	...attempt,
	decisionId: "decision-1",
	action: "commit",
	trigger: "silence_auto",
	actor: "system",
	verdictId: "verdict-1",
	evidenceRevision: 1,
	claimedAt: 1000,
	notAfter: 2000,
};
const options = {
	endpoint: "https://payload.example",
	token: "decision-secret",
	audience: "payload",
	activationEpoch: 1,
};
it("one-page pending poll confines credential to the pinned origin and does not follow redirects", async () => {
	const calls: [string, RequestInit][] = [];
	const mailbox = new CustomerReleaseMailbox({
		...options,
		fetch: async (url, init) => {
			calls.push([String(url), init!]);
			return Response.json({ attempts: [attempt], cursor: "next/page" });
		},
	});
	expect(await mailbox.pending("prior/page")).toEqual({
		attempts: [attempt],
		cursor: "next/page",
	});
	expect(calls).toHaveLength(1);
	expect(calls[0][0]).toBe(
		"https://payload.example/admin/release-attempts/pending?limit=1&cursor=prior%2Fpage",
	);
	expect(calls[0][1].redirect).toBe("error");
	expect(new Headers(calls[0][1].headers).get("authorization")).toBe(
		"Bearer decision-secret",
	);
});
it("permit replay sends exactly the same durable body, and transport errors never mint a replacement", async () => {
	const bodies: unknown[] = [];
	const mailbox = new CustomerReleaseMailbox({
		...options,
		fetch: async (_url, init) => {
			bodies.push(init?.body);
			if (bodies.length === 1) throw new Error("secret-containing error");
			return Response.json({ ok: true });
		},
	});
	await expect(mailbox.deliverPermit(permit)).rejects.toThrow(
		"customer release transport unavailable",
	);
	expect(bodies).toHaveLength(1);
	await mailbox.deliverPermit(permit);
	expect(bodies[0]).toBe(bodies[1]);
});
it("exact result identity is required and an absent result is not no_write", async () => {
	let result: unknown = null;
	const mailbox = new CustomerReleaseMailbox({
		...options,
		fetch: async () => Response.json({ attempt, permit, result }),
	});
	expect(await mailbox.observe(permit)).toBeNull();
	result = {
		attemptId: attempt.attemptId,
		decisionId: permit.decisionId,
		nonce: attempt.nonce,
		baseEtag: attempt.baseEtag,
		kind: "unknown",
	};
	expect(await mailbox.observe(permit)).toEqual(result);
	result = { ...(result as object), nonce: "e".repeat(64) };
	await expect(mailbox.observe(permit)).rejects.toThrow();
});
it("fence intent can only name the exact durable decision and never executes a fence with writer authority", async () => {
	const calls: [string, RequestInit][] = [];
	const mailbox = new CustomerReleaseMailbox({
		...options,
		fetch: async (url, init) => {
			calls.push([String(url), init!]);
			return Response.json({ ok: true });
		},
	});
	await mailbox.requestFence(permit, "founder_veto");
	expect(calls).toHaveLength(1);
	expect(calls[0][0]).toBe(
		`https://payload.example/admin/release-attempts/${attempt.attemptId}/fence-intent`,
	);
	expect(JSON.parse(String(calls[0][1].body))).toEqual({
		decisionId: permit.decisionId,
		nonce: permit.nonce,
		baseEtag: permit.baseEtag,
		fullBinding: permit.fullBinding,
		reason: "founder_veto",
	});
});
it("malformed, cross-epoch, oversized and repeated cursor pages fail closed", async () => {
	for (const body of [
		{ attempts: [attempt, attempt], cursor: null },
		{ attempts: [{ ...attempt, activationEpoch: 2 }], cursor: null },
		{ attempts: [{ ...attempt, audience: "other" }], cursor: null },
		{ attempts: [{ ...attempt, attemptId: "../escape" }], cursor: null },
		{ attempts: [attempt], cursor: "same" },
		{ attempts: [], cursor: null, hidden: true },
	]) {
		const mailbox = new CustomerReleaseMailbox({
			...options,
			fetch: async () => Response.json(body),
		});
		await expect(mailbox.pending("same")).rejects.toThrow();
	}
	const mailbox = new CustomerReleaseMailbox({
		...options,
		fetch: async () => new Response("x".repeat(4 * 1024 * 1024 + 1)),
	});
	await expect(mailbox.pending()).rejects.toThrow();
});
it("unsafe endpoint configuration fails before any credential-bearing fetch", () => {
	for (const endpoint of [
		"http://remote.example",
		"https://user:pass@payload.example",
		"https://payload.example/path",
		"https://payload.example?q=secret",
		"https://payload.example#fragment",
	]) {
		expect(
			() => new CustomerReleaseMailbox({ ...options, endpoint }),
		).toThrow();
	}
});

it("real endpoint reconciles a lost permit reply and terminal manifest across activation epochs", async () => {
	const {
		makeDeps,
		fixtureManifest,
		seedBucketForManifest,
		payloadKeyOf,
		request,
		TOKENS,
	} = await import("../../../../payload-endpoint/__tests__/harness.mjs");
	const { deriveVetoBinding } = await import(
		"../../../../payload-endpoint/src/manifest.mjs"
	);
	for (const fence of [false, true]) {
		const writer = "bridge-decision-fixture",
			executor = "executor-fixture";
		const ctx = makeDeps({
			tokens: {
				...TOKENS,
				releaseDecision: writer,
				autoReleaseExecutor: executor,
			},
		});
		ctx.deps.releaseControl = {
			projectId: "flywheel",
			audience: "payload",
			activationEpoch: 1,
			mode: "canary",
			enabled: true,
		};
		const manifest = fixtureManifest({ withRelease: false });
		manifest.releaseOps.candidate = {
			kind: "release",
			state: "prepared",
			ver: "1.55.0",
			betaVersion: "1.55.0-beta.1",
			sourceCommit: "c".repeat(40),
			sha256: "b".repeat(64),
			objectKey: payloadKeyOf("1.55.0", "b".repeat(64)),
			createdAt: "2026-07-01T00:00:00.000Z",
		};
		seedBucketForManifest(ctx.bucket, manifest);
		ctx.bucket.seed(manifest.releaseOps.candidate.objectKey, "fixture bytes", {
			sha256: "b".repeat(64),
			ver: "1.55.0",
		});
		const created = await request(ctx.deps, "POST", "/admin/release-attempts", {
			token: executor,
			body: {
				cycleId: "cycle-1",
				fullBinding: deriveVetoBinding(manifest, "candidate"),
				baseEtag: (await ctx.bucket.get("manifest.json")).etag,
				readbackSha256: "b".repeat(64),
			},
		});
		expect(created.status).toBe(201);
		const ready = await created.json();
		const persisted = {
			...permit,
			...ready,
			claimedAt: ctx.clock.now().getTime(),
			notAfter: ctx.clock.now().getTime() + 30000,
		};
		let drop = true;
		const transport: typeof fetch = async (url, init) => {
			const path = new URL(String(url));
			const response = await request(
				ctx.deps,
				init?.method ?? "GET",
				`${path.pathname}${path.search}`,
				{ headers: init?.headers, body: init?.body },
			);
			if (path.pathname.endsWith("/permit") && drop) {
				drop = false;
				throw new Error("lost response after persistence");
			}
			return response;
		};
		const mailbox = new CustomerReleaseMailbox({
			...options,
			token: writer,
			fetch: transport,
		});
		expect((await mailbox.pending()).attempts).toEqual([ready]);
		await expect(mailbox.deliverPermit(persisted)).rejects.toThrow();
		await mailbox.deliverPermit(persisted);
		expect(await mailbox.observe(persisted)).toBeNull();
		if (fence) await mailbox.requestFence(persisted, "founder_veto");
		const executed = await request(
			ctx.deps,
			"POST",
			`/admin/release-attempts/${ready.attemptId}/${fence ? "fence" : "execute"}`,
			{ token: executor, body: {} },
		);
		expect(executed.status).toBe(200);
		expect(await mailbox.observe(persisted)).toMatchObject({
			kind: fence ? "fenced" : "published",
			decisionId: persisted.decisionId,
		});
		const replay = new CustomerReleaseMailbox({
			...options,
			activationEpoch: 2,
			token: writer,
			fetch: transport,
		});
		expect(await replay.observe(persisted)).toMatchObject({
			kind: fence ? "fenced" : "published",
		});
	}
});

it("HTTP failure and mismatched persisted permit cannot become a successful observation", async () => {
	for (const response of [
		new Response("Bearer decision-secret", { status: 403 }),
		new Response("unavailable", { status: 503 }),
		Response.json({
			attempt,
			permit: { ...permit, notAfter: permit.notAfter + 1 },
			result: null,
		}),
		Response.json({
			attempt: { ...attempt, baseEtag: "different" },
			permit,
			result: null,
		}),
	]) {
		const mailbox = new CustomerReleaseMailbox({
			...options,
			fetch: async () => response,
		});
		await expect(mailbox.observe(permit)).rejects.toThrow(
			"customer release transport unavailable",
		);
	}
});
