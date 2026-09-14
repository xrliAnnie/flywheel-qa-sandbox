import { expect, it, vi } from "vitest";
import { runShipJudgment } from "../ship-judgment.js";

const args = [
	"report",
	"--project",
	"flywheel",
	"--from",
	"2026-09-01T00:00:00.000Z",
	"--to",
	"2026-09-11T00:00:00.000Z",
];
const env = {
	TEAMLEAD_API_TOKEN: "fixture",
	BRIDGE_URL: "http://127.0.0.1:9876",
};
it("uses one authenticated GET and preserves the server statistics envelope", async () => {
	const receipt = {
		schema_version: 1,
		policy: "ship-judgment-v1",
		source: "machine",
		report: {
			project: "flywheel",
			range: { from: args[4], to: args[6] },
			summary: { pairs: 0 },
		},
	};
	const fetchImpl = vi.fn<typeof fetch>(
		async () => new Response(JSON.stringify(receipt)),
	);
	const log = vi.fn();
	expect(await runShipJudgment(args, { env, fetchImpl, log })).toBe(0);
	expect(fetchImpl).toHaveBeenCalledOnce();
	const [url, init] = fetchImpl.mock.calls[0]!;
	expect(new URL(String(url)).pathname).toBe("/api/ship-judgment/report");
	expect(new URL(String(url)).searchParams.get("project")).toBe("flywheel");
	expect(init).toMatchObject({
		method: "GET",
		redirect: "error",
		headers: { Authorization: "Bearer fixture" },
	});
	expect(init?.body).toBeUndefined();
	expect(JSON.parse(log.mock.calls[0]![0])).toEqual(receipt);
});
it("rejects malformed or ambiguous options before network access", async () => {
	const fetchImpl = vi.fn(),
		log = vi.fn();
	for (const invalid of [
		[...args, "--project", "raya"],
		[...args, "--from", "bad"],
		[...args, "--body", "approved"],
		[...args, "--bridge-url", "https://example.com"],
		["report", "--project", "raya", ...args.slice(3)],
	]) {
		expect(await runShipJudgment(invalid, { env, fetchImpl, log })).toBe(1);
	}
	expect(fetchImpl).not.toHaveBeenCalled();
});
it.each(["http", "invalid", "throw"])(
	"fails explicitly without a local fallback: %s",
	async (kind) => {
		const log = vi.fn(),
			fetchImpl = vi.fn<typeof fetch>(async () => {
				if (kind === "throw") throw new Error("private credential");
				return new Response(JSON.stringify({ error: "private credential" }), {
					status: kind === "http" ? 503 : 200,
				});
			});
		expect(await runShipJudgment(args, { env, fetchImpl, log })).toBe(1);
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(JSON.stringify(log.mock.calls)).not.toContain("private credential");
	},
);

it.each(["question", "id"])(
	"reads audit records with --%s without issuing a write",
	async (selector) => {
		const receipt = {
			schema_version: 1,
			policy: "ship-judgment-v1",
			project: "flywheel",
			questionId: "q",
			...(selector === "id"
				? { record: { id: "fixture", source: "machine" } }
				: { records: [] }),
		};
		const fetchImpl = vi.fn<typeof fetch>(
				async () => new Response(JSON.stringify(receipt)),
			),
			log = vi.fn();
		const input = [
			"show",
			"--project",
			"flywheel",
			`--${selector}`,
			selector === "id" ? "fixture" : "q",
		];
		expect(await runShipJudgment(input, { env, fetchImpl, log })).toBe(0);
		expect(
			new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.get(selector),
		).toBe(input[4]);
		expect(fetchImpl.mock.calls[0]![1]?.method).toBe("GET");
		expect(JSON.parse(log.mock.calls[0]![0])).toEqual(receipt);
	},
);
