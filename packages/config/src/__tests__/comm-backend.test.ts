import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCommBackend } from "../comm-backend.js";

describe("resolveCommBackend (FLY-168)", () => {
	const original = process.env.FLYWHEEL_COMM_BACKEND;

	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		if (original === undefined) delete process.env.FLYWHEEL_COMM_BACKEND;
		else process.env.FLYWHEEL_COMM_BACKEND = original;
		vi.restoreAllMocks();
	});

	it("defaults to mailbox when unset", () => {
		delete process.env.FLYWHEEL_COMM_BACKEND;
		expect(resolveCommBackend()).toBe("mailbox");
	});

	it("defaults to mailbox when empty string", () => {
		process.env.FLYWHEEL_COMM_BACKEND = "";
		expect(resolveCommBackend()).toBe("mailbox");
	});

	it("resolves explicit mailbox", () => {
		process.env.FLYWHEEL_COMM_BACKEND = "mailbox";
		expect(resolveCommBackend()).toBe("mailbox");
	});

	it("resolves commdb (rollback)", () => {
		process.env.FLYWHEEL_COMM_BACKEND = "commdb";
		expect(resolveCommBackend()).toBe("commdb");
	});

	it("is case-insensitive", () => {
		process.env.FLYWHEEL_COMM_BACKEND = "COMMDB";
		expect(resolveCommBackend()).toBe("commdb");
		process.env.FLYWHEEL_COMM_BACKEND = "Mailbox";
		expect(resolveCommBackend()).toBe("mailbox");
	});

	it("trims whitespace-padded commdb (the latent bug the shell already fixed)", () => {
		process.env.FLYWHEEL_COMM_BACKEND = "  commdb  ";
		expect(resolveCommBackend()).toBe("commdb");
	});

	it("trims whitespace-padded mailbox", () => {
		process.env.FLYWHEEL_COMM_BACKEND = "\tmailbox\n";
		expect(resolveCommBackend()).toBe("mailbox");
	});

	it("falls back to mailbox + warns on garbage", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.FLYWHEEL_COMM_BACKEND = "garbage";
		expect(resolveCommBackend()).toBe("mailbox");
		expect(warn).toHaveBeenCalledOnce();
	});
});
