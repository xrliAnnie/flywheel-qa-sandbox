/**
 * CodexAdapter stub tests.
 *
 * Per plan v1.27.1 §2.0.5: stub MUST be instantiable (compile-time
 * interface assertion) but EVERY method MUST throw `not implemented`. This
 * makes accidental production activation fail loud.
 */

import { describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "../CodexAdapter.js";
import type { ILogger } from "../../types.js";

const noopLogger: ILogger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

describe("CodexAdapter (stub)", () => {
	it("is instantiable without throwing", () => {
		expect(() => new CodexAdapter()).not.toThrow();
	});

	it("vendorId() returns 'codex' (only safe method)", () => {
		const a = new CodexAdapter();
		expect(a.vendorId()).toBe("codex");
	});

	it("capabilities() throws not-implemented", () => {
		const a = new CodexAdapter();
		expect(() => a.capabilities()).toThrow(/not implemented yet/);
	});

	it("getInboxPath throws", () => {
		expect(() =>
			new CodexAdapter().getInboxPath("lead", "agent"),
		).toThrow(/not implemented yet/);
	});

	it("getStateDir throws", () => {
		expect(() => new CodexAdapter().getStateDir()).toThrow(
			/not implemented yet/,
		);
	});

	it("write throws", async () => {
		await expect(
			new CodexAdapter().write({
				leadName: "lead",
				recipient: "agent",
				payload: { from: "x", to: "y", content: "z" },
			}),
		).rejects.toThrow(/not implemented yet/);
	});

	it("verifyLastWrite throws", async () => {
		await expect(
			new CodexAdapter().verifyLastWrite({
				leadName: "lead",
				recipient: "agent",
				expected: { from: "x", to: "y", content: "z" },
			}),
		).rejects.toThrow(/not implemented yet/);
	});

	it("readUnread throws", async () => {
		await expect(
			new CodexAdapter().readUnread({
				leadName: "lead",
				agentName: "agent",
			}),
		).rejects.toThrow(/not implemented yet/);
	});

	it("ack throws", async () => {
		await expect(
			new CodexAdapter().ack({
				leadName: "lead",
				agentName: "agent",
				messageIds: [],
			}),
		).rejects.toThrow(/not implemented yet/);
	});

	it("dedupeKey throws", () => {
		expect(() =>
			new CodexAdapter().dedupeKey({
				id: "x",
				from: "a",
				to: "b",
				content: "c",
				ts: 0,
				read: false,
			}),
		).toThrow(/not implemented yet/);
	});

	it("createReceiver throws", () => {
		expect(() =>
			new CodexAdapter().createReceiver({
				leadName: "lead",
				runnerName: "r",
				teamName: "t",
			}),
		).toThrow(/not implemented yet/);
	});

	it("buildRunnerSpawnConfig throws", () => {
		expect(() =>
			new CodexAdapter().buildRunnerSpawnConfig({
				leadName: "lead",
				runnerName: "r",
				teamName: "t",
			}),
		).toThrow(/not implemented yet/);
	});

	it("buildLeadSpawnConfig throws", () => {
		expect(() =>
			new CodexAdapter().buildLeadSpawnConfig({
				leadName: "lead",
				teamName: "t",
			}),
		).toThrow(/not implemented yet/);
	});

	it("preflight throws", async () => {
		await expect(
			new CodexAdapter().preflight({ logger: noopLogger }),
		).rejects.toThrow(/not implemented yet/);
	});
});
