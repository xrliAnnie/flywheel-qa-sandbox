import { describe, expect, it, vi } from "vitest";
import {
	assertLoopbackCarrierUrl,
	isAllowedLoopbackHostname,
	postCarrierClaim,
} from "../lead-lease.js";

describe("FLY-1309 raw carrier capability loopback guard", () => {
	it.each(["127.0.0.1", "localhost", "::1"])(
		"accepts the exact shared loopback hostname %s",
		(hostname) => {
			expect(isAllowedLoopbackHostname(hostname)).toBe(true);
		},
	);

	it.each([
		"127.0.0.2",
		"127.1.2.3",
		"localhost.evil",
		"evil-localhost",
		"::2",
		"0:0:0:0:0:0:0:1",
		"example.com",
	])("rejects the non-contract hostname %s", (hostname) => {
		expect(isAllowedLoopbackHostname(hostname)).toBe(false);
	});

	it.each([
		"ftp://127.0.0.1:9876/x",
		"http://user:password@127.0.0.1:9876/x",
		"http://127.0.0.2:9876/x",
		"http://localhost.evil:9876/x",
		"http://[::2]:9876/x",
		"https://example.com/x",
	])("refuses an unsafe raw-capability destination %s", (url) => {
		expect(() => assertLoopbackCarrierUrl(url)).toThrow(
			/loopback|userinfo|protocol/i,
		);
	});

	it.each([
		"http://127.0.0.1:9876/x",
		"https://localhost:9876/x",
		"http://[::1]:9876/x",
	])("allows a safe raw-capability destination %s", (url) => {
		expect(assertLoopbackCarrierUrl(url).href).toBe(url);
	});

	it("posts the raw claim only through the guard and disables redirects", async () => {
		const fetchImpl = vi.fn(
			async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);
		await postCarrierClaim({
			url: "http://127.0.0.1:9876/api/founder-consent/runner-gate-response",
			carrierClaim: "raw-secret-capability",
			body: { questionId: "q1" },
			headers: { Authorization: "Bearer token" },
			fetchImpl: fetchImpl as typeof fetch,
		});

		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe(
			"http://127.0.0.1:9876/api/founder-consent/runner-gate-response",
		);
		expect(init).toMatchObject({ method: "POST", redirect: "error" });
		expect(JSON.parse(String(init?.body))).toEqual({
			questionId: "q1",
			carrierClaim: "raw-secret-capability",
		});
	});

	it("rejects before fetch when the raw claim destination is external", async () => {
		const fetchImpl = vi.fn();
		await expect(
			postCarrierClaim({
				url: "https://localhost.evil/steal",
				carrierClaim: "raw-secret-capability",
				body: {},
				fetchImpl: fetchImpl as typeof fetch,
			}),
		).rejects.toThrow(/loopback/i);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
