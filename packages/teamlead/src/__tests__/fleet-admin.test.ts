import { describe, expect, it } from "vitest";
import {
	buildCanonicalRequest,
	ConfirmTokenStore,
	type ConsoleChange,
	canonicalRequestSha,
	newBatchId,
} from "../bridge/fleet-admin.js";

const fromByKey = new Map<string, string | null>([
	["geo-peter", "claude-fable-5"],
	["geo-oliver", null],
]);

describe("fleet-admin — canonical request (FLY-247 inc2a §2.2)", () => {
	it("builds the exact from→to from current models", () => {
		const changes: ConsoleChange[] = [
			{ key: "geo-peter", toModel: null },
			{ key: "geo-oliver", toModel: "claude-fable-5" },
		];
		const req = buildCanonicalRequest("b-1", "sha123", fromByKey, changes);
		expect(req.changes[0]).toEqual({
			key: "geo-peter",
			from: { model: "claude-fable-5" },
			to: { model: null },
		});
		expect(req.changes[1]!.from.model).toBeNull();
	});

	it("rejects unsafe batchId / key / duplicate / unknown key", () => {
		const ch: ConsoleChange[] = [{ key: "geo-peter", toModel: null }];
		expect(() => buildCanonicalRequest("../evil", "s", fromByKey, ch)).toThrow(
			/batchId/,
		);
		expect(() =>
			buildCanonicalRequest("b", "s", fromByKey, [
				{ key: "../x", toModel: null },
			]),
		).toThrow(/key/);
		expect(() =>
			buildCanonicalRequest("b", "s", fromByKey, [
				{ key: "geo-peter", toModel: null },
				{ key: "geo-peter", toModel: "claude-fable-5" },
			]),
		).toThrow(/duplicate/);
		expect(() =>
			buildCanonicalRequest("b", "s", fromByKey, [
				{ key: "geo-ghost", toModel: null },
			]),
		).toThrow(/unknown key/);
	});

	it("canonicalRequestSha is stable regardless of object key order", () => {
		const a = buildCanonicalRequest("b-1", "s", fromByKey, [
			{ key: "geo-peter", toModel: null },
		]);
		// Same logical request, re-built — SHA must match.
		const b = buildCanonicalRequest("b-1", "s", fromByKey, [
			{ key: "geo-peter", toModel: null },
		]);
		expect(canonicalRequestSha(a)).toBe(canonicalRequestSha(b));
	});

	it("SHA changes when from→to changes (founder reviewed a different transition)", () => {
		const a = buildCanonicalRequest("b-1", "s", fromByKey, [
			{ key: "geo-oliver", toModel: "claude-fable-5" },
		]);
		const b = buildCanonicalRequest("b-1", "s", fromByKey, [
			{ key: "geo-oliver", toModel: null },
		]);
		expect(canonicalRequestSha(a)).not.toBe(canonicalRequestSha(b));
	});

	it("newBatchId is grammar-safe", () => {
		expect(newBatchId()).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
	});
});

describe("fleet-admin — ConfirmTokenStore (single-use, SHA-bound, TTL)", () => {
	it("issues + verifies a matching token once", () => {
		const s = new ConfirmTokenStore();
		const t = s.issue("req-sha");
		expect(s.verifyAndConsume(t, "req-sha")).toEqual({ ok: true });
	});

	it("is single-use — a replay fails even with the right SHA", () => {
		const s = new ConfirmTokenStore();
		const t = s.issue("req-sha");
		expect(s.verifyAndConsume(t, "req-sha").ok).toBe(true);
		expect(s.verifyAndConsume(t, "req-sha")).toEqual({
			ok: false,
			reason: "unknown or already-used token",
		});
	});

	it("rejects a token whose request SHA differs (swapped transition)", () => {
		const s = new ConfirmTokenStore();
		const t = s.issue("req-sha-A");
		expect(s.verifyAndConsume(t, "req-sha-B")).toEqual({
			ok: false,
			reason: "token does not match this request",
		});
	});

	it("rejects an expired token (and still consumes it)", () => {
		let clock = 1000;
		const s = new ConfirmTokenStore(60_000, () => clock);
		const t = s.issue("req-sha");
		clock += 60_001;
		expect(s.verifyAndConsume(t, "req-sha")).toEqual({
			ok: false,
			reason: "token expired",
		});
		// consumed even though expired
		expect(s.verifyAndConsume(t, "req-sha").reason).toMatch(/already-used/);
	});

	it("rejects an unknown/forged token", () => {
		const s = new ConfirmTokenStore();
		expect(s.verifyAndConsume("forged", "req-sha").ok).toBe(false);
	});
});
