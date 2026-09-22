import { createHmac } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import type {
	AutoMergeShadowDeclarationRow,
	StateStore,
	WorkflowGateHolderRow,
} from "../../StateStore.js";
import { createAutoMergeShadowRouter } from "../auto-merge-shadow-route.js";

const QUESTION = "question-shadow-1";
const LEAD = "flywheel-eng-lead";
const PROJECT = "flywheel";
const DECLARATION = "11111111-1111-4111-8111-111111111111";
const DIGEST = "b".repeat(64);
const BOT_TOKEN = "lead-token";
const CREATED_AT = "2026-09-08T12:00:00.000Z";
const NOW = "2026-09-08T12:02:00.000Z";
const LEASE_CLAIM = {
	lease_key: "flywheel/flywheel-eng-lead",
	generation: 9,
};

const holder = {
	run_id: "run-shadow-1",
	gate_node_id: "founder_gate",
	source_execution_id: "qa-shadow-1",
	question_id: QUESTION,
	authority_mode: "land",
	subject_kind: "git_head",
	created_at: CREATED_AT,
} as WorkflowGateHolderRow;

const projects = [
	{
		projectName: PROJECT,
		projectRoot: "/repo",
		leads: [
			{
				agentId: LEAD,
				chatChannel: "12345678901234567",
				botToken: BOT_TOKEN,
				match: { labels: ["Engineering"] },
			},
		],
	},
] as ProjectEntry[];

function canonical(declaredClass = "pure_docs"): string {
	return JSON.stringify([
		"flywheel-shadow-declare-v1",
		DECLARATION,
		QUESTION,
		declaredClass,
		LEAD,
		PROJECT,
	]);
}

function hmac(declaredClass = "pure_docs"): string {
	return createHmac("sha256", BOT_TOKEN)
		.update(canonical(declaredClass))
		.digest("hex");
}

function declarationRow(
	overrides: Record<string, unknown> = {},
): AutoMergeShadowDeclarationRow {
	return {
		declaration_id: DECLARATION,
		question_id: QUESTION,
		run_id: "run-shadow-1",
		declared_class: "pure_docs",
		declared_by: LEAD,
		discord_channel_id: null,
		discord_message_id: null,
		discord_author_user_id: null,
		message_ts: null,
		evidence_kind: "lead_authenticated",
		lead_identity_digest: DIGEST,
		lead_auth_method: "lead_hmac",
		declaration_seq: 1,
		declared_at: NOW,
		...overrides,
	} as unknown as AutoMergeShadowDeclarationRow;
}

function validHmacBody() {
	return {
		declaration_id: DECLARATION,
		question_id: QUESTION,
		declared_class: "pure_docs",
		lead_id: LEAD,
		project_name: PROJECT,
		identity_digest: DIGEST,
		proof_method: "lead_hmac",
		lease_claim: LEASE_CLAIM,
		hmac_sha256: hmac(),
	};
}

function validCarrierBody() {
	return {
		declaration_id: DECLARATION,
		question_id: QUESTION,
		declared_class: "pure_docs",
		lead_id: LEAD,
		project_name: PROJECT,
		identity_digest: DIGEST,
		proof_method: "carrier_passthrough",
		carrierClaim: "carrier-secret",
	};
}

type Authorization = {
	disposition: string;
	identityDigest?: string;
};

interface FixtureOptions {
	holder?: WorkflowGateHolderRow | undefined;
	holders?: WorkflowGateHolderRow[];
	labels?: string[];
	existing?: AutoMergeShadowDeclarationRow[];
	authorization?: Authorization;
	recordResult?: ReturnType<StateStore["recordAutoMergeShadowDeclaration"]>;
	now?: string;
}

const servers: Server[] = [];

async function fixture(options: FixtureOptions = {}) {
	const currentHolder = Object.hasOwn(options, "holder")
		? options.holder
		: holder;
	let holderReads = 0;
	const record = vi.fn().mockReturnValue(
		options.recordResult ?? {
			ok: true,
			status: "created",
			row: declarationRow(),
		},
	);
	const store = {
		getWorkflowGateHolderByQuestionId: () =>
			options.holders?.[Math.min(holderReads++, options.holders.length - 1)] ??
			currentHolder,
		listAutoMergeShadowDeclarations: () => options.existing ?? [],
		getWorkflowRun: () => ({ project_name: PROJECT }),
		getSession: () => ({ execution_id: "qa-shadow-1" }),
		getSessionLabels: () => options.labels ?? ["Engineering"],
		recordAutoMergeShadowDeclaration: record,
	} as unknown as StateStore;
	const authorize = vi.fn((input: { proofMethod: string }) =>
		Promise.resolve(
			options.authorization ?? {
				disposition:
					input.proofMethod === "lead_hmac"
						? "lease_validated"
						: "carrier_passthrough",
				identityDigest: DIGEST,
			},
		),
	);
	const app = express();
	app.use(express.json());
	app.use(
		"/api/workflow",
		createAutoMergeShadowRouter({
			store,
			projects,
			authorize,
			now: () => options.now ?? NOW,
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	servers.push(server);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address() as AddressInfo;
	return {
		port: address.port,
		holderReads: () => holderReads,
		authorize,
		record,
		post: (body: unknown) =>
			fetch(
				`http://127.0.0.1:${address.port}/api/workflow/shadow-declaration`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
			),
	};
}

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					),
			),
	);
});

describe("auto-merge shadow declaration route", () => {
	it("creates a direct declaration from a label-matched Lead HMAC", async () => {
		const fx = await fixture();
		const response = await fx.post(validHmacBody());
		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			status: "created",
		});
		expect(fx.authorize).toHaveBeenCalledWith({
			leadId: LEAD,
			projectName: PROJECT,
			identityDigest: DIGEST,
			proofMethod: "lead_hmac",
			leaseClaim: {
				leaseKey: LEASE_CLAIM.lease_key,
				generation: LEASE_CLAIM.generation,
			},
		});
		expect(fx.record).toHaveBeenCalledWith({
			declarationId: DECLARATION,
			questionId: QUESTION,
			runId: "run-shadow-1",
			declaredClass: "pure_docs",
			declaredBy: LEAD,
			evidenceKind: "lead_authenticated",
			leadIdentityDigest: DIGEST,
			leadAuthMethod: "lead_hmac",
			declaredAt: NOW,
		});
	});

	it("creates a direct declaration from an exclusive carrier proof", async () => {
		const fx = await fixture();
		const response = await fx.post(validCarrierBody());
		expect(response.status).toBe(201);
		expect(fx.authorize).toHaveBeenCalledWith({
			leadId: LEAD,
			projectName: PROJECT,
			identityDigest: DIGEST,
			proofMethod: "carrier_passthrough",
			carrierClaim: "carrier-secret",
		});
		expect(fx.record).toHaveBeenCalledWith(
			expect.objectContaining({
				evidenceKind: "lead_authenticated",
				leadAuthMethod: "carrier_passthrough",
			}),
		);
	});

	it.each([
		[{ ...validHmacBody(), hmac_sha256: undefined }, "proof_shape"],
		[{ ...validHmacBody(), hmac_sha256: "0".repeat(64) }, "lead_hmac_invalid"],
		[{ ...validCarrierBody(), lease_claim: LEASE_CLAIM }, "proof_shape"],
		[{ ...validCarrierBody(), hmac_sha256: hmac() }, "proof_shape"],
		[{ ...validHmacBody(), message_ref: "1/2" }, "unexpected_key"],
	] as const)(
		"rejects missing, forged, or mixed proof with %s",
		async (body, reason) => {
			const fx = await fixture();
			const response = await fx.post(body);
			expect(response.status).toBe(reason === "lead_hmac_invalid" ? 403 : 400);
			await expect(response.json()).resolves.toEqual({ ok: false, reason });
			expect(fx.record).not.toHaveBeenCalled();
		},
	);

	it.each([
		[{ ...validHmacBody(), lead_id: "other-lead" }, "lead_mismatch"],
		[{ ...validHmacBody(), project_name: "other" }, "project_mismatch"],
		[{ ...validHmacBody(), identity_digest: "bad" }, "identity_digest_invalid"],
		[{ ...validHmacBody(), declared_class: "maybe" }, "declared_class_invalid"],
	] as const)(
		"rejects a mismatched declaration actor with %s",
		async (body, reason) => {
			const fx = await fixture();
			const response = await fx.post(body);
			expect([400, 403]).toContain(response.status);
			await expect(response.json()).resolves.toEqual({ ok: false, reason });
			expect(fx.record).not.toHaveBeenCalled();
		},
	);

	it("rejects an authorization disposition that does not match the proof", async () => {
		const fx = await fixture({
			authorization: { disposition: "audit_allowed", identityDigest: DIGEST },
		});
		const response = await fx.post(validHmacBody());
		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "lead_authorization_invalid",
		});
		expect(fx.record).not.toHaveBeenCalled();
	});

	it("authenticates an exact replay and rejects proof-aware conflicts", async () => {
		const replay = await fixture({ existing: [declarationRow()] });
		const replayResponse = await replay.post(validHmacBody());
		expect(replayResponse.status).toBe(200);
		await expect(replayResponse.json()).resolves.toMatchObject({
			ok: true,
			status: "replayed",
		});
		expect(replay.authorize).toHaveBeenCalledOnce();
		expect(replay.record).not.toHaveBeenCalled();

		const conflict = await fixture({
			existing: [declarationRow({ lead_identity_digest: "c".repeat(64) })],
		});
		const conflictResponse = await conflict.post(validHmacBody());
		expect(conflictResponse.status).toBe(409);
		await expect(conflictResponse.json()).resolves.toEqual({
			ok: false,
			reason: "declaration_conflict",
		});
	});

	it.each([
		[{}, 404, "question_unknown"],
		[
			{
				holder: { ...holder, gate_node_id: "review" } as WorkflowGateHolderRow,
			},
			422,
			"not_a_ship_gate",
		],
		[{ labels: [] }, 503, "lead_identity_unavailable"],
		[{ now: "not-a-time" }, 503, "server_time_invalid"],
		[{ now: "2026-09-08T12:02:00Z" }, 503, "server_time_invalid"],
		[{ now: "2026-09-08T11:59:59.999Z" }, 503, "server_time_predates_card"],
	] as const)(
		"fails closed for invalid holder, identity, or time",
		async (options, status, reason) => {
			const normalized =
				Object.keys(options).length === 0 ? { holder: undefined } : options;
			const fx = await fixture(normalized);
			const response = await fx.post(validHmacBody());
			expect(response.status).toBe(status);
			await expect(response.json()).resolves.toEqual({ ok: false, reason });
			expect(fx.record).not.toHaveBeenCalled();
		},
	);

	it("rejects a non-loopback host before proof validation", async () => {
		const fx = await fixture();
		const hostResponse = await new Promise<{ status: number; body: unknown }>(
			(resolve, reject) => {
				const request = httpRequest(
					{
						hostname: "127.0.0.1",
						port: fx.port,
						path: "/api/workflow/shadow-declaration",
						method: "POST",
						headers: {
							host: "example.com",
							"content-type": "application/json",
						},
					},
					(response) => {
						let body = "";
						response.setEncoding("utf8");
						response.on("data", (chunk) => {
							body += chunk;
						});
						response.on("end", () =>
							resolve({
								status: response.statusCode ?? 0,
								body: JSON.parse(body),
							}),
						);
					},
				);
				request.on("error", reject);
				request.end(JSON.stringify(validHmacBody()));
			},
		);
		expect(hostResponse.status).toBe(403);
		expect(hostResponse.body).toMatchObject({ reason: "non_loopback_host" });
	});

	it("re-reads the holder before the immutable write", async () => {
		const changed = { ...holder, created_at: NOW } as WorkflowGateHolderRow;
		const fx = await fixture({ holders: [holder, changed] });
		const response = await fx.post(validHmacBody());
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			reason: "holder_changed",
		});
		expect(fx.holderReads()).toBeGreaterThanOrEqual(2);
		expect(fx.record).not.toHaveBeenCalled();
	});

	it.each([
		[{ ok: false, reason: "declaration_conflict" }, 409],
		[{ ok: false, reason: "question_unknown" }, 404],
		[{ ok: false, reason: "invalid_declaration" }, 400],
	] as const)(
		"maps transactional rejection %s",
		async (recordResult, status) => {
			const fx = await fixture({ recordResult });
			const response = await fx.post(validHmacBody());
			expect(response.status).toBe(status);
			await expect(response.json()).resolves.toEqual(recordResult);
		},
	);
});
