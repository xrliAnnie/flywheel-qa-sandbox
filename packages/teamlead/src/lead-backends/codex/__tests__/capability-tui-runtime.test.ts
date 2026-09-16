import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCapabilityTuiRuntime } from "../capability-tui-runtime.js";
import type { CodexLeadTuiRuntimeConfig } from "../codex-lead-tui-runtime.js";
import type { SqliteJournalStore } from "../SqliteJournalStore.js";

it("stops while socket startup is pending and closes the real journal after parent cleanup", async () => {
	const root = mkdtempSync(join(tmpdir(), "tui-stop-"));
	let journal!: SqliteJournalStore;
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const closeParent = vi.fn(async () => {
		expect(journal.getById("absent")).toBeUndefined();
	});
	const generationStart = vi.fn();
	const runtime = createCapabilityTuiRuntime(
		{
			capabilityBundleVersion: 2,
			carrierInstanceId: "claim",
			journalDbPath: join(root, "journal.db"),
			projectName: "demo",
			leadId: "lead",
		} as CodexLeadTuiRuntimeConfig,
		{},
		{ info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		{
			parent: (async (input: { journal: SqliteJournalStore }) => {
				journal = input.journal;
				return { assertCurrent: async () => {}, close: closeParent };
			}) as never,
			server: (async ({ signal }: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
					entered();
				})) as never,
			generation: (() => () => ({
				start: generationStart,
				stop: async () => {},
				onConnectionLost: () => () => {},
			})) as never,
			killWindow: vi.fn(),
		},
	);
	const outcome = expect(runtime.start()).rejects.toThrow(
		"capability_tui_stopped",
	);
	try {
		await ready;
		await runtime.stop();
		await outcome;
		expect(generationStart).not.toHaveBeenCalled();
		expect(closeParent).toHaveBeenCalledOnce();
		expect(() => journal.getById("absent")).toThrow();
	} finally {
		await runtime.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

it.each(["success", "parent", "server", "generation"])(
	"owns cleanup across %s",
	async (failure) => {
		const root = mkdtempSync(join(tmpdir(), "tui-owner-"));
		const order: string[] = [];
		let journal!: SqliteJournalStore;
		const parent = {
			assertCurrent: async () => {},
			close: vi.fn(async () => {
				order.push("parent-close");
			}),
		};
		const server = {
			socketPath: "/tmp/owned.sock",
			receipt: { transport: "app_server_socket" },
			assertCurrent: async () => {},
			close: vi.fn(async () => {
				order.push("server-close");
			}),
		};
		const killWindow = vi.fn();
		const runtime = createCapabilityTuiRuntime(
			{
				capabilityBundleVersion: 2,
				carrierInstanceId: "claim",
				journalDbPath: join(root, "journal.db"),
				projectName: "demo",
				leadId: "lead",
			} as CodexLeadTuiRuntimeConfig,
			{},
			{ info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			{
				parent: (async (input: { journal: SqliteJournalStore }) => {
					journal = input.journal;
					const originalClose = journal.close.bind(journal);
					vi.spyOn(journal, "close").mockImplementation(() => {
						order.push("journal-close");
						originalClose();
					});
					if (failure === "parent") throw new Error("parent-failed");
					return parent;
				}) as never,
				server: (async () => {
					if (failure === "server") throw new Error("server-failed");
					return server;
				}) as never,
				generation: ((
					_config: unknown,
					_logger: unknown,
					deps: {
						onWindowOwned(): void;
						capabilitySession: {
							parent: unknown;
							journal: unknown;
							socket: { path: string };
						};
					},
				) => {
					expect(deps.capabilitySession.parent).toBe(parent);
					expect(deps.capabilitySession.journal).toBe(journal);
					return () => ({
						start: async () => {
							expect(deps.capabilitySession.socket.path).toBe(
								server.socketPath,
							);
							if (failure === "generation")
								throw new Error("generation-failed");
							deps.onWindowOwned();
						},
						stop: async () => {
							order.push("generation-close");
						},
						onConnectionLost: () => () => {},
					});
				}) as never,
				killWindow,
			},
		);
		try {
			if (failure === "success") await runtime.start();
			else await expect(runtime.start()).rejects.toThrow(`${failure}-failed`);
			await runtime.stop();
			await runtime.stop();
			expect(order).toEqual([
				...(failure === "success" || failure === "generation"
					? ["generation-close", "server-close"]
					: []),
				...(failure !== "parent" ? ["parent-close"] : []),
				"journal-close",
			]);
			expect(killWindow).toHaveBeenCalledTimes(failure === "success" ? 1 : 0);
		} finally {
			vi.mocked(journal.close).mockRestore();
			journal.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
