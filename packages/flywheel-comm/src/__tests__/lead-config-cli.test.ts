import { expect, it } from "vitest";
import { runLeadConfig } from "../commands/lead-config.js";

const op = "11111111-1111-4111-8111-111111111111";
const args = [
	"set",
	"--project",
	"raya",
	"--lead",
	"raya",
	"--effort",
	"high",
	"--reason",
	"hot change",
	"--operation-id",
	op,
];
function fixture(status = "applied") {
	let currentOp = op;
	const calls: Array<{ url: string; body: unknown; init: RequestInit }> = [];
	const logs: string[] = [],
		errors: string[] = [];
	const deps = {
		env: {},
		log: (s: string) => logs.push(s),
		error: (s: string) => errors.push(s),
		fetch: async (url: string, init: RequestInit) => {
			const body = init.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ url, body, init });
			if (url.endsWith("/stage")) currentOp = body.operationId;
			if (url.endsWith("/stage"))
				return Response.json({
					canonical: { intent: { operationId: body.operationId } },
					requestDigest: "a".repeat(64),
					confirmToken: "token",
				});
			return Response.json({
				operation: { input: { operationId: currentOp }, status },
				effectiveStatus: status,
			});
		},
	};
	return { deps, calls, logs, errors };
}
it("sends an explicit target/patch and outputs the recovery ID before apply", async () => {
	const f = fixture();
	expect(await runLeadConfig(args, f.deps)).toBe(0);
	expect(f.calls[0]!.body).toEqual({
		operationId: op,
		projectName: "raya",
		leadId: "raya",
		effort: "high",
		reason: "hot change",
	});
	expect(f.calls[0]!.init.redirect).toBe("error");
	expect(JSON.parse(f.logs[0]!).operationId).toBe(op);
	expect(f.calls[1]!.url).toMatch(/\/api\/lead-config\/apply$/);
});
it.each(["pending_runtime", "unavailable", "drifted"])(
	"does not claim hot success for %s",
	async (status) => {
		const f = fixture(status);
		expect(await runLeadConfig(args, f.deps)).toBe(2);
	},
);
it("queries status without staging another write", async () => {
	const f = fixture("pending_runtime");
	expect(await runLeadConfig(["status", "--operation-id", op], f.deps)).toBe(2);
	expect(f.calls).toHaveLength(1);
	expect(f.calls[0]!.init.method).toBe("GET");
});
it("rolls back by referencing the old operation while creating a new one", async () => {
	const f = fixture();
	await runLeadConfig(
		["rollback", "--operation-id", op, "--reason", "restore prior"],
		f.deps,
	);
	const body = f.calls[0]!.body as Record<string, string>;
	expect(body.rollbackOperationId).toBe(op);
	expect(body.operationId).not.toBe(op);
});
it.each([
	[...args, "--actor", "founder"],
	[...args, "--bridge-url", "https://example.com"],
	["set", "--project", "raya", "--lead", "raya", "--reason", "test"],
])("rejects unsupported input before network calls", async (input) => {
	const f = fixture();
	expect(await runLeadConfig(input, f.deps)).toBe(1);
	expect(f.calls).toHaveLength(0);
});
it("does not re-stage after an uncertain apply response", async () => {
	const f = fixture();
	const original = f.deps.fetch;
	f.deps.fetch = async (url, init) => {
		if (url.endsWith("/apply")) throw new Error("response lost");
		return original(url, init);
	};
	expect(await runLeadConfig(args, f.deps)).toBe(1);
	expect(f.calls).toHaveLength(1);
	expect(f.errors.join(" ")).toContain(
		`lead-config status --operation-id ${op}`,
	);
});
