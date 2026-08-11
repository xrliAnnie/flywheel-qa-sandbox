import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	CodexDiscordRuntimeOwnership,
	type ProcessLockAcquire,
	type ProcessLockHandle,
} from "../CodexDiscordRuntimeOwnership.js";

function handle(): ProcessLockHandle {
	return { helperPid: 123, close: vi.fn(async () => {}) };
}

function harness(args: {
	acquire: ProcessLockAcquire;
	probe?: () => Promise<unknown>;
}) {
	const server = {
		listen: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
		pauseAccepting: vi.fn(),
		resumeIfBoundPathCurrent: vi.fn(() => false),
	};
	const gateway = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
	const owner = new CodexDiscordRuntimeOwnership({
		stateDir: "/state",
		leadId: "mufasa",
		authSecret: "secret",
		server,
		gateway,
		acquireLock: args.acquire,
		probe:
			args.probe ??
			(async () => {
				throw new Error("no live owner");
			}),
		autoRefresh: false,
		logger: { info: vi.fn(), warn: vi.fn() },
	});
	return { owner, server, gateway };
}

describe("CodexDiscordRuntimeOwnership", () => {
	it("elects exactly one winner across two competing runtime shapes", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "fly1574-runtime-owner-"));
		const make = () => {
			const server = {
				listen: vi.fn(async () => {}),
				close: vi.fn(async () => {}),
				pauseAccepting: vi.fn(),
				resumeIfBoundPathCurrent: vi.fn(() => false),
			};
			const gateway = {
				start: vi.fn(async () => {}),
				stop: vi.fn(async () => {}),
			};
			return {
				server,
				gateway,
				owner: new CodexDiscordRuntimeOwnership({
					stateDir,
					leadId: "mufasa",
					authSecret: "secret",
					server,
					gateway,
					probe: async () => ({ socketOwnerId: "winner" }),
					autoRefresh: false,
					logger: { info: vi.fn(), warn: vi.fn() },
				}),
			};
		};
		const tui = make();
		const headless = make();
		await Promise.all([tui.owner.start(), headless.owner.start()]);
		expect(
			[tui.owner, headless.owner].filter((owner) => owner.mailboxReady()),
		).toHaveLength(1);
		expect(
			tui.gateway.start.mock.calls.length +
				headless.gateway.start.mock.calls.length,
		).toBe(1);
		await Promise.all([tui.owner.stop(), headless.owner.stop()]);
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("starts the socket and gateway only after the same runtime holds both locks", async () => {
		const paths: string[] = [];
		const { owner, server, gateway } = harness({
			acquire: async (path) => {
				paths.push(path);
				return { status: "acquired", handle: handle() };
			},
		});
		await owner.start();
		expect(paths).toEqual([
			"/state/codex-mailbox-socket.lock",
			"/state/discord-inbound.lock",
		]);
		expect(server.listen).toHaveBeenCalledOnce();
		expect(gateway.start).toHaveBeenCalledOnce();
		expect(owner.mailboxReady()).toBe(true);
		await owner.stop();
	});

	it("stands by when a live socket owner answers the authenticated probe", async () => {
		const { owner, server, gateway } = harness({
			acquire: async () => ({ status: "conflict" }),
			probe: async () => ({ socketOwnerId: "other" }),
		});
		await owner.start();
		expect(server.listen).not.toHaveBeenCalled();
		expect(gateway.start).not.toHaveBeenCalled();
		await owner.stop();
	});

	it("fails stopped when neither lock ownership nor a live owner is proven", async () => {
		const { owner, server, gateway } = harness({
			acquire: async () => ({ status: "unavailable", error: "EACCES" }),
		});
		await owner.start();
		expect(server.listen).not.toHaveBeenCalled();
		expect(gateway.start).not.toHaveBeenCalled();
		expect(owner.mailboxReady()).toBe(false);
		await owner.stop();
	});

	it("fails stopped without unlinking a successor socket when its helper dies", async () => {
		let socketLost: ((error: string) => void) | undefined;
		const { owner, server, gateway } = harness({
			acquire: async (path, onLost) => {
				if (path.endsWith("codex-mailbox-socket.lock")) socketLost = onLost;
				return { status: "acquired", handle: handle() };
			},
		});
		await owner.start();
		server.close.mockClear();
		socketLost?.("helper crashed");
		await vi.waitFor(() =>
			expect(server.pauseAccepting).toHaveBeenCalledOnce(),
		);
		expect(server.close).not.toHaveBeenCalled();
		expect(gateway.stop).toHaveBeenCalledOnce();
		expect(owner.mailboxReady()).toBe(false);
		await owner.stop();
	});
});
