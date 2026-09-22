import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { shadowDeclare } from "../shadow-declare.js";

const DECLARATION = "11111111-1111-4111-8111-111111111111";
const QUESTION = "question-shadow-1";
const LEAD = "flywheel-eng-lead";
const PROJECT = "flywheel";
const DIGEST = "b".repeat(64);
const BOT_TOKEN = "lead-only-bot-token";
const LEASE_CLAIM = {
	leaseKey: "flywheel/flywheel-eng-lead",
	generation: 9,
	identityDigest: DIGEST,
};

function output() {
	return { stdout: vi.fn(), stderr: vi.fn() };
}

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		BRIDGE_URL: "http://127.0.0.1:9876/",
		TEAMLEAD_API_TOKEN: " master-token ",
		FLYWHEEL_LEAD_ID: LEAD,
		FLYWHEEL_PROJECT_NAME: PROJECT,
		DISCORD_BOT_TOKEN: BOT_TOKEN,
		...extra,
	};
}

function leaseAuthorization() {
	return {
		disposition: "lease_validated" as const,
		identityDigest: DIGEST,
		leaseClaim: LEASE_CLAIM,
	};
}

describe("shadow-declare", () => {
	it("returns usage failure when the formal Lead Bridge environment is missing", async () => {
		const io = output();
		const authorize = vi.fn(() => leaseAuthorization());
		const exitCode = await shadowDeclare({
			question: QUESTION,
			declaredClass: "pure_docs",
			env: {
				FLYWHEEL_LEAD_ID: LEAD,
				FLYWHEEL_PROJECT_NAME: PROJECT,
				DISCORD_BOT_TOKEN: BOT_TOKEN,
			},
			uuid: () => DECLARATION,
			authorize,
			...io,
		});
		expect(exitCode).toBe(1);
		expect(io.stdout).toHaveBeenCalledWith(`declaration_id=${DECLARATION}`);
		expect(io.stderr).toHaveBeenCalledWith(
			expect.stringContaining("BRIDGE_URL and TEAMLEAD_API_TOKEN"),
		);
		expect(authorize).not.toHaveBeenCalled();
	});

	it("posts a Lead-HMAC declaration after a validated Claude lease", async () => {
		const io = output();
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					ok: true,
					status: "created",
					declaration: { declaration_id: DECLARATION },
				}),
				{ status: 201, headers: { "content-type": "application/json" } },
			),
		);
		const authorize = vi.fn(() => leaseAuthorization());
		const exitCode = await shadowDeclare({
			question: QUESTION,
			declaredClass: "pure_docs",
			declarationId: DECLARATION,
			env: env(),
			fetchImpl,
			authorize,
			...io,
		});
		expect(exitCode).toBe(0);
		expect(authorize).toHaveBeenCalledWith({
			claimedLeadId: LEAD,
			env: expect.any(Object),
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			"http://127.0.0.1:9876/api/workflow/shadow-declaration",
			expect.objectContaining({
				method: "POST",
				headers: {
					Authorization: "Bearer master-token",
					"Content-Type": "application/json",
				},
			}),
		);
		const body = JSON.parse(
			(fetchImpl.mock.calls[0]![1] as RequestInit).body as string,
		);
		const canonical = JSON.stringify([
			"flywheel-shadow-declare-v1",
			DECLARATION,
			QUESTION,
			"pure_docs",
			LEAD,
			PROJECT,
		]);
		expect(body).toEqual({
			declaration_id: DECLARATION,
			question_id: QUESTION,
			declared_class: "pure_docs",
			lead_id: LEAD,
			project_name: PROJECT,
			identity_digest: DIGEST,
			proof_method: "lead_hmac",
			lease_claim: {
				lease_key: LEASE_CLAIM.leaseKey,
				generation: LEASE_CLAIM.generation,
			},
			hmac_sha256: createHmac("sha256", BOT_TOKEN)
				.update(canonical)
				.digest("hex"),
		});
	});

	it("rejects a non-loopback Lead-HMAC destination without sending the proof", async () => {
		const io = output();
		const fetchImpl = vi.fn();
		const exitCode = await shadowDeclare({
			question: QUESTION,
			declaredClass: "pure_docs",
			declarationId: DECLARATION,
			env: env({ BRIDGE_URL: "https://bridge.example.test" }),
			fetchImpl,
			authorize: () => leaseAuthorization(),
			...io,
		});
		expect(exitCode).toBe(2);
		expect(io.stderr).toHaveBeenCalledWith(
			expect.stringMatching(/request failed.*loopback/i),
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("uses the loopback carrier proof without mixing lease or HMAC fields", async () => {
		const io = output();
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true, status: "replayed" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const exitCode = await shadowDeclare({
			question: QUESTION,
			declaredClass: "other_code",
			declarationId: DECLARATION,
			env: env({ DISCORD_BOT_TOKEN: undefined }),
			fetchImpl,
			authorize: () => ({
				disposition: "carrier_passthrough",
				identityDigest: DIGEST,
				carrierClaim: "carrier-secret",
			}),
			...io,
		});
		expect(exitCode).toBe(0);
		const body = JSON.parse(
			(fetchImpl.mock.calls[0]![1] as RequestInit).body as string,
		);
		expect(body).toEqual({
			declaration_id: DECLARATION,
			question_id: QUESTION,
			declared_class: "other_code",
			lead_id: LEAD,
			project_name: PROJECT,
			identity_digest: DIGEST,
			proof_method: "carrier_passthrough",
			carrierClaim: "carrier-secret",
		});
	});

	it("rejects the retired message-ref flow before authorization or network access", async () => {
		const io = output();
		const fetchImpl = vi.fn();
		const authorize = vi.fn(() => leaseAuthorization());
		const exitCode = await shadowDeclare({
			question: QUESTION,
			declaredClass: "pure_docs",
			messageRef: "12345678901234567/22345678901234567",
			env: env(),
			uuid: () => DECLARATION,
			fetchImpl,
			authorize,
			...io,
		});
		expect(exitCode).toBe(1);
		expect(io.stderr).toHaveBeenCalledWith(
			expect.stringMatching(/--message-ref.*retired.*do not post.*Discord/i),
		);
		expect(authorize).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each(["off", "unprotected", "audit_allowed"] as const)(
		"rejects the weak %s authorization disposition",
		async (disposition) => {
			const io = output();
			const fetchImpl = vi.fn();
			const exitCode = await shadowDeclare({
				question: QUESTION,
				declaredClass: "pure_docs",
				declarationId: DECLARATION,
				env: env(),
				fetchImpl,
				authorize: () => ({ disposition, identityDigest: DIGEST }),
				...io,
			});
			expect(exitCode).toBe(1);
			expect(io.stderr).toHaveBeenCalledWith(
				expect.stringContaining(`authorization ${disposition}`),
			);
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it("reports local Lead authorization failure without making a request", async () => {
		const io = output();
		const fetchImpl = vi.fn();
		const exitCode = await shadowDeclare({
			question: QUESTION,
			declaredClass: "pure_docs",
			declarationId: DECLARATION,
			env: env(),
			fetchImpl,
			authorize: () => {
				throw new Error("lease is stale");
			},
			...io,
		});
		expect(exitCode).toBe(1);
		expect(io.stderr).toHaveBeenCalledWith(
			"shadow-declare: Lead authorization failed: lease is stale",
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("reports a Bridge-side HMAC rejection separately from local authorization", async () => {
		const io = output();
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: false, reason: "lead_hmac_invalid" }), {
				status: 403,
				headers: { "content-type": "application/json" },
			}),
		);
		const exitCode = await shadowDeclare({
			question: QUESTION,
			declaredClass: "pure_docs",
			declarationId: DECLARATION,
			env: env(),
			fetchImpl,
			authorize: () => leaseAuthorization(),
			...io,
		});
		expect(exitCode).toBe(2);
		expect(io.stderr).toHaveBeenCalledWith(
			"shadow-declare: Bridge rejected (403): lead_hmac_invalid",
		);
	});

	it("returns Bridge rejection and prints the retry id to stdout", async () => {
		const io = output();
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ ok: false, reason: "declaration_conflict" }),
					{ status: 409, headers: { "content-type": "application/json" } },
				),
			);
		const exitCode = await shadowDeclare({
			question: QUESTION,
			declaredClass: "pure_docs",
			declarationId: DECLARATION,
			env: env(),
			fetchImpl,
			authorize: () => leaseAuthorization(),
			...io,
		});
		expect(exitCode).toBe(2);
		expect(io.stdout).toHaveBeenCalledWith(`declaration_id=${DECLARATION}`);
		expect(io.stderr).toHaveBeenCalledWith(
			"shadow-declare: Bridge rejected (409): declaration_conflict",
		);
	});

	it.each([
		[{ question: "", declaredClass: "pure_docs" }, "--question"],
		[{ question: QUESTION, declaredClass: "maybe" }, "--class"],
		[
			{
				question: QUESTION,
				declaredClass: "pure_docs",
				declarationId: "bad",
			},
			"--declaration-id",
		],
	] as const)(
		"rejects invalid usage without a request",
		async (input, diagnostic) => {
			const io = output();
			const fetchImpl = vi.fn();
			const exitCode = await shadowDeclare({
				...input,
				env: env(),
				uuid: () => DECLARATION,
				fetchImpl,
				authorize: () => leaseAuthorization(),
				...io,
			});
			expect(exitCode).toBe(1);
			expect(io.stderr).toHaveBeenCalledWith(
				expect.stringContaining(diagnostic),
			);
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);
});
