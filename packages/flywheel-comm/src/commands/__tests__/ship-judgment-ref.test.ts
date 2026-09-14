import { expect, it, vi } from "vitest";
import { runShipJudgmentRef } from "../ship-judgment-ref.js";

const args = [
	"--message-ref",
	"123456789012345679/123456789012345691",
	"--clarification-id",
	"123456789012345692",
];
const env = {
	FLYWHEEL_LEAD_ID: "lead",
	FLYWHEEL_PROJECT_NAME: "flywheel",
	TEAMLEAD_API_TOKEN: "fixture",
	BRIDGE_URL: "http://127.0.0.1:9876",
};
it("sends only a reference and authenticated Lead identity, without a local write fallback", async () => {
	const fetchImpl = vi.fn<typeof fetch>(
		async () =>
			new Response(JSON.stringify({ status: "recorded_or_existing" })),
	);
	const authorize = vi.fn(() => ({
		identityDigest: "a".repeat(64),
		carrierClaim: "fixture-claim",
	}));
	const log = vi.fn();
	expect(
		await runShipJudgmentRef(args, { env, authorize, fetchImpl, log }),
	).toBe(0);
	expect(fetchImpl).toHaveBeenCalledOnce();
	const [url, init] = fetchImpl.mock.calls[0]!;
	expect(url).toBe("http://127.0.0.1:9876/api/ship-judgment/reference");
	expect(init).toMatchObject({
		method: "POST",
		redirect: "error",
		headers: { Authorization: "Bearer fixture" },
	});
	expect(JSON.parse(init!.body as string)).toEqual({
		threadId: "123456789012345679",
		messageId: "123456789012345691",
		replyToMessageId: "123456789012345692",
		leadAuth: {
			leadId: "lead",
			projectName: "flywheel",
			identityDigest: "a".repeat(64),
			carrierClaim: "fixture-claim",
		},
	});
	expect(log).toHaveBeenCalledWith('{"status":"recorded_or_existing"}');
});
it("rejects invalid inputs, remote targets and failed authorization before POST", async () => {
	const fetchImpl = vi.fn(),
		log = vi.fn(),
		authorize = vi.fn(() => {
			throw new Error("private credential");
		});
	for (const input of [
		[...args, "--text", "通过"],
		[...args, "--message-ref", "123456789012345679/123456789012345691"],
		[...args, "--bridge-url", "https://example.com"],
		args,
	])
		expect(
			await runShipJudgmentRef(input, { env, authorize, fetchImpl, log }),
		).toBe(1);
	expect(fetchImpl).not.toHaveBeenCalled();
	expect(JSON.stringify(log.mock.calls)).not.toContain("private credential");
});

it.each(["unavailable", "lost", "invalid_receipt"])(
	"returns failure without retrying when %s",
	async (kind) => {
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			if (kind === "lost") throw new Error("fixture secret from transport");
			return new Response(
				JSON.stringify(
					kind === "invalid_receipt" ? { ok: true } : { error: "unavailable" },
				),
				{ status: kind === "unavailable" ? 503 : 200 },
			);
		});
		const log = vi.fn();
		expect(
			await runShipJudgmentRef(args, {
				env,
				authorize: () => ({ identityDigest: "a".repeat(64) }),
				fetchImpl,
				log,
			}),
		).toBe(1);
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(fetchImpl.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.stringify(log.mock.calls)).not.toContain("fixture secret");
	},
);
