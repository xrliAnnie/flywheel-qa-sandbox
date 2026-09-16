import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeadCapabilitySocket } from "../broker-socket.js";

const dirs: string[] = [];
const servers: LeadCapabilitySocket[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function socketPath() {
	const dir = mkdtempSync("/tmp/lead-uds-");
	dirs.push(dir);
	chmodSync(dir, 0o700);
	return join(dir, "operations.sock");
}
function exchange(path: string, frame: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		let result = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(frame));
		socket.on("data", (chunk) => {
			result += chunk;
		});
		socket.on("end", () => resolve(result));
		socket.on("error", reject);
	});
}
function heldExchange(path: string, frame: string) {
	const socket = createConnection({ path, allowHalfOpen: true });
	const response = new Promise<string>((resolve, reject) => {
		let result = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(frame));
		socket.on("data", (chunk) => {
			result += chunk;
			if (result.includes("\n")) resolve(result);
		});
		socket.on("error", reject);
	});
	return { socket, response };
}
describe("result-only broker socket framing", () => {
	it("runs one typed request, returns only engine result, and survives client reconnection", async () => {
		const path = socketPath();
		const dispatch = vi.fn(async () => ({
			status: "rejected",
			errorCode: "operation_unknown",
			resourceRefs: [],
		}));
		const server = new LeadCapabilitySocket({ socketPath: path, dispatch });
		servers.push(server);
		await server.listen();
		expect(
			JSON.parse(await exchange(path, '{"operationId":"get-secret"}\n'))
				.errorCode,
		).toBe("operation_unknown");
		await exchange(path, "{}\n");
		expect(dispatch).toHaveBeenCalledTimes(2);
	});
	it("rejects malformed, multiple and oversized frames before dispatch", async () => {
		const path = socketPath(),
			dispatch = vi.fn(async () => ({}));
		const server = new LeadCapabilitySocket({ socketPath: path, dispatch });
		servers.push(server);
		await server.listen();
		for (const frame of ["oops\n", "{}\n{}\n", `"${"x".repeat(65537)}"\n`]) {
			expect(JSON.parse(await exchange(path, frame)).status).toBe("rejected");
		}
		expect(dispatch).not.toHaveBeenCalled();
	});
	it("never unlinks an existing path or exports exception messages", async () => {
		const path = socketPath();
		writeFileSync(path, "existing");
		const server = new LeadCapabilitySocket({
			socketPath: path,
			dispatch: async () => {
				throw new Error("SECRET");
			},
		});
		await expect(server.listen()).rejects.toThrow();
		expect(readFileSync(path, "utf8")).toBe("existing");
		const clean = socketPath();
		const running = new LeadCapabilitySocket({
			socketPath: clean,
			dispatch: async () => {
				throw new Error("SECRET");
			},
		});
		servers.push(running);
		await running.listen();
		expect(await exchange(clean, "{}\n")).not.toContain("SECRET");
	});
	it("releases replied connections even when clients keep their write side open", async () => {
		const path = socketPath(),
			dispatch = vi.fn(async () => ({ status: "succeeded" })),
			server = new LeadCapabilitySocket({ socketPath: path, dispatch });
		servers.push(server);
		await server.listen();
		const held = Array.from({ length: 32 }, () => heldExchange(path, "{}\n"));
		try {
			await Promise.all(held.map(({ response }) => response));
			const next = await Promise.race([
				exchange(path, "{}\n"),
				new Promise<string>((_, reject) =>
					setTimeout(
						() => reject(new Error("broker slot was not released")),
						1000,
					),
				),
			]);
			expect(JSON.parse(next).status).toBe("succeeded");
			expect(dispatch).toHaveBeenCalledTimes(33);
		} finally {
			for (const { socket } of held) socket.destroy();
		}
	});
});

it("keeps real Git socket/client alive past16s while ordinary requests retain their timeout", async () => {
	const { requestLeadOperation } = await import(
		"flywheel-comm/lead-operation-client"
	);
	const path = socketPath(),
		server = new LeadCapabilitySocket({
			socketPath: path,
			dispatch: async (raw) => {
				await new Promise((resolve) => setTimeout(resolve, 17000));
				return {
					requestId: (raw as { requestId: string }).requestId,
					status: "succeeded",
					resourceRefs: [],
				};
			},
		});
	servers.push(server);
	await server.listen();
	const base = {
		schemaVersion: 1 as const,
		requestId: "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		input: {},
	};
	const git = requestLeadOperation(path, {
		...base,
		operationId: "git.feature.push",
	});
	const ordinary = requestLeadOperation(path, {
		...base,
		operationId: "discord.thread.read",
	}).then(
		(result) => result.status,
		() => "timeout",
	);
	expect(await ordinary).not.toBe("succeeded");
	expect((await git).status).toBe("succeeded");
}, 25000);
