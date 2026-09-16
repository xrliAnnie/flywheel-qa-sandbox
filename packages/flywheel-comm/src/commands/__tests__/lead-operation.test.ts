import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLeadOperationCommand } from "../lead-operation.js";

const request = {
	schemaVersion: 1 as const,
	operationId: "discord.thread.read",
	requestId: "22222222-2222-4222-8222-222222222222",
	input: { threadId: "abc" },
};
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "lead-op-"));
	dirs.push(dir);
	return dir;
}
function deps(text = JSON.stringify(request)) {
	const out: string[] = [],
		err: string[] = [];
	const requestClient = vi.fn(async () => ({
		requestId: request.requestId,
		status: "succeeded" as const,
		resourceRefs: ["message:1"],
	}));
	return {
		out,
		err,
		requestClient,
		env: {
			FLYWHEEL_LEAD_CAPABILITY_SOCKET: "/tmp/broker.sock",
			TEAMLEAD_API_TOKEN: "CANARY",
		},
		stdin: Readable.from([text]),
		stdout: (s: string) => out.push(s),
		stderr: (s: string) => err.push(s),
	};
}
describe("lead-operation", () => {
	it("reads a bounded exact file envelope, preserving requestId and using only the env socket", async () => {
		const path = join(fixture(), "request.json");
		writeFileSync(path, JSON.stringify(request));
		const d = deps();
		expect(await runLeadOperationCommand(["--request-file", path], d)).toBe(0);
		expect(d.requestClient).toHaveBeenCalledExactlyOnceWith(
			"/tmp/broker.sock",
			request,
		);
		expect(JSON.parse(d.out[0])).toEqual({
			requestId: request.requestId,
			status: "succeeded",
			resourceRefs: ["message:1"],
		});
	});
	it("accepts stdin without a CommDB or actor", async () => {
		const d = deps();
		expect(await runLeadOperationCommand(["--request-file", "-"], d)).toBe(0);
		expect(d.requestClient).toHaveBeenCalledOnce();
	});
	it.each([
		"{CANARY",
		JSON.stringify({ ...request, token: "CANARY" }),
		"x".repeat(65537),
	])(
		"rejects malformed/extra/oversized input before dispatch",
		async (text) => {
			const d = deps(text);
			expect(await runLeadOperationCommand(["--request-file", "-"], d)).toBe(2);
			expect(d.requestClient).not.toHaveBeenCalled();
			expect(d.err.join("")).not.toContain("CANARY");
		},
	);
	it("bounds file input and rejects relative paths", async () => {
		const path = join(fixture(), "request.json");
		writeFileSync(path, "x".repeat(65537));
		for (const p of [path, "relative.json"]) {
			const d = deps();
			expect(await runLeadOperationCommand(["--request-file", p], d)).toBe(2);
			expect(d.requestClient).not.toHaveBeenCalled();
		}
	});
	it("does not accept URL/token/socket options or reflect their values", async () => {
		for (const option of ["--url", "--token", "--socket", "--headers"]) {
			const d = deps();
			expect(
				await runLeadOperationCommand(
					["--request-file", "-", option, "CANARY"],
					d,
				),
			).toBe(2);
			expect(d.requestClient).not.toHaveBeenCalled();
			expect(d.err.join("")).not.toContain("CANARY");
		}
	});
	it("rejects missing socket without an HTTP fallback", async () => {
		const d = deps();
		expect(
			await runLeadOperationCommand(["--request-file", "-"], {
				...d,
				env: { BRIDGE_URL: "http://CANARY" },
			}),
		).toBe(2);
		expect(d.requestClient).not.toHaveBeenCalled();
		expect(d.err.join("")).toContain("broker_socket_missing");
	});
	it.each([
		["rejected", 3],
		["pending", 4],
		["unknown", 5],
	] as const)(
		"returns nonzero for %s and preserves status",
		async (status, code) => {
			const d = deps();
			const requestClient = vi.fn(async () => ({
				requestId: request.requestId,
				status,
				resourceRefs: [],
			}));
			expect(
				await runLeadOperationCommand(["--request-file", "-"], {
					...d,
					requestClient,
				}),
			).toBe(code);
			expect(JSON.parse(d.out[0]).status).toBe(status);
		},
	);
	it("lost reply is unknown with the same requestId and no automatic retry", async () => {
		const d = deps();
		d.requestClient.mockRejectedValue(new Error("broker_response_incomplete"));
		expect(await runLeadOperationCommand(["--request-file", "-"], d)).toBe(5);
		expect(d.requestClient).toHaveBeenCalledOnce();
		expect(JSON.parse(d.out[0])).toEqual({
			requestId: request.requestId,
			status: "unknown",
			resourceRefs: [],
			errorCode: "broker_response_incomplete",
		});
	});
	it("never emits arbitrary underlying exceptions", async () => {
		const d = deps();
		d.requestClient.mockRejectedValue(new Error("CANARY"));
		expect(await runLeadOperationCommand(["--request-file", "-"], d)).toBe(5);
		expect([...d.out, ...d.err].join("")).not.toContain("CANARY");
	});
	it("help requires no socket and documents stable replay IDs", async () => {
		const d = deps();
		expect(await runLeadOperationCommand(["--help"], { ...d, env: {} })).toBe(
			0,
		);
		expect(d.out.join("")).toContain("requestId");
		expect(d.requestClient).not.toHaveBeenCalled();
	});
});

it("rejects a FIFO request path without waiting for a writer", async () => {
	const path = join(fixture(), "request.fifo");
	execFileSync("mkfifo", [path]);
	const d = deps();
	const pending = runLeadOperationCommand(["--request-file", path], d);
	const prompt = await Promise.race([
		pending.then(() => true),
		new Promise<boolean>((ok) => setTimeout(() => ok(false), 250)),
	]);
	// Unblock the pre-fix implementation before asserting, so a red test cannot leak IO.
	if (!prompt) {
		const writer = await open(path, "w");
		await writer.close();
	}
	expect(await pending).toBe(2);
	expect(d.requestClient).not.toHaveBeenCalled();
	expect(prompt).toBe(true);
});
