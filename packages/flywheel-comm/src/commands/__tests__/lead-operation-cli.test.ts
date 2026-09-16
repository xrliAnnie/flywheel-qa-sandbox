import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const request = {
	schemaVersion: 1,
	operationId: "discord.thread.read",
	requestId: "33333333-3333-4333-8333-333333333333",
	input: { threadId: "123" },
};
function run(socketPath: string) {
	const compiled = process.env.FLYWHEEL_LEAD_OPERATION_TEST_COMPILED_CLI;
	const args = compiled
		? [resolve(compiled)]
		: ["--import", "tsx", resolve("src/index.ts")];
	return new Promise<{ code: number | null; out: string; err: string }>(
		(resolveResult, reject) => {
			const child = spawn(
				process.execPath,
				[...args, "lead-operation", "--request-file", "-"],
				{
					env: {
						PATH: process.env.PATH,
						HOME: process.env.HOME,
						FLYWHEEL_LEAD_CAPABILITY_SOCKET: socketPath,
					},
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			let out = "",
				err = "";
			child.stdout.on("data", (b) => {
				out += b;
			});
			child.stderr.on("data", (b) => {
				err += b;
			});
			child.on("error", reject);
			child.on("close", (code) => resolveResult({ code, out, err }));
			child.stdin.end(JSON.stringify(request));
		},
	);
}
it.each([false, true])(
	"real CLI communicates once over socket without CommDB/actor; lostReply=%s",
	async (lostReply) => {
		const dir = mkdtempSync("/tmp/lead-op-cli-");
		dirs.push(dir);
		const path = join(dir, "b.sock");
		let calls = 0;
		const observed: unknown[] = [];
		const server = createServer((socket) => {
			calls++;
			let data = "";
			socket.on("data", (bytes) => {
				data += bytes.toString();
				if (data.includes("\n")) {
					observed.push(JSON.parse(data));
					socket.end(
						lostReply
							? ""
							: `${JSON.stringify({ requestId: request.requestId, status: "succeeded", resourceRefs: ["message:123"], data: { count: 1 } })}\n`,
					);
				}
			});
		});
		await new Promise<void>((ok, no) => {
			server.once("error", no);
			server.listen(path, ok);
		});
		try {
			const result = await run(path);
			expect(result.err).toBe("");
			expect(result.code).toBe(lostReply ? 5 : 0);
			expect(JSON.parse(result.out)).toMatchObject({
				requestId: request.requestId,
				status: lostReply ? "unknown" : "succeeded",
			});
			expect(observed).toEqual([request]);
			expect(calls).toBe(1);
		} finally {
			await new Promise<void>((ok, no) =>
				server.close((err) => (err ? no(err) : ok())),
			);
		}
	},
	15000,
);
