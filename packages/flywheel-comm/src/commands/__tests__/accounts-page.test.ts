import { describe, expect, it, vi } from "vitest";
import { type AccountsPageDeps, runAccountsPage } from "../accounts-page.js";

function deps(over: Partial<AccountsPageDeps> = {}): AccountsPageDeps {
	return {
		env: { TEAMLEAD_API_TOKEN: "master-token" },
		fetchFn: vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => "<html>accounts</html>",
		})),
		publish: vi.fn(async () => 0),
		writeFile: vi.fn(),
		log: vi.fn(),
		errorLog: vi.fn(),
		exit: ((code: number) => {
			throw new Error(`exit ${code}`);
		}) as (code: number) => never,
		outDefault: "/tmp/accounts-page.html",
		...over,
	};
}

describe("flywheel-comm accounts-page", () => {
	it("fetches the protected on-demand HTML and publishes it in one command", async () => {
		const d = deps();
		await runAccountsPage(["--project", "flywheel", "--channel", "C1"], d);

		expect(d.fetchFn).toHaveBeenCalledWith(
			"http://localhost:9876/api/accounts-page.html?refresh=1",
			{ headers: { Authorization: "Bearer master-token" } },
		);
		expect(d.writeFile).toHaveBeenCalledWith(
			"/tmp/accounts-page.html",
			"<html>accounts</html>",
		);
		expect(d.publish).toHaveBeenCalledWith({
			htmlPath: "/tmp/accounts-page.html",
			project: "flywheel",
			channelId: "C1",
			title: "账号额度一览",
		});
	});

	it("can publish for an enclosing notification without delivering a second message", async () => {
		const d = deps();
		await runAccountsPage(["--project", "flywheel", "--publish-only"], d);

		// FLY-2688: the switch-notification path keeps its 5s budget — it renders
		// the stored Codex readings and never asks the Bridge to probe.
		expect(d.fetchFn).toHaveBeenCalledWith(
			"http://localhost:9876/api/accounts-page.html",
			expect.anything(),
		);

		expect(d.publish).toHaveBeenCalledWith({
			htmlPath: "/tmp/accounts-page.html",
			project: "flywheel",
			channelId: undefined,
			title: "账号额度一览",
			publishOnly: true,
		});
	});

	it("shares one bounded deadline across the notification fetch and publish", async () => {
		let fetchSignal: AbortSignal | undefined;
		let publishSignal: AbortSignal | undefined;
		const d = deps({
			fetchFn: vi.fn(async (_url, init) => {
				fetchSignal = (init as { signal?: AbortSignal }).signal;
				return {
					ok: true,
					status: 200,
					text: async () => "<html>accounts</html>",
				};
			}),
			publish: vi.fn(async (input) => {
				publishSignal = (input as { signal?: AbortSignal }).signal;
				return 0;
			}),
		});

		await runAccountsPage(
			["--project", "flywheel", "--publish-only", "--timeout-ms", "10000"],
			d,
		);

		expect(fetchSignal).toBeInstanceOf(AbortSignal);
		expect(publishSignal).toBe(fetchSignal);
	});

	it("reports a bounded fetch timeout instead of waiting for the alert parent timeout", async () => {
		const d = deps({
			fetchFn: vi.fn(
				(_url, init) =>
					new Promise((_resolve, reject) => {
						const signal = (init as { signal?: AbortSignal }).signal;
						signal?.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					}),
			),
		});

		await expect(runAccountsPage(["--timeout-ms", "1"], d)).rejects.toThrow(
			"exit 1",
		);
		expect(d.errorLog).toHaveBeenCalledWith("accounts-page: timeout");
		expect(d.publish).not.toHaveBeenCalled();
	});

	it("fails closed without the Bridge master token", async () => {
		const d = deps({ env: {} });
		await expect(runAccountsPage([], d)).rejects.toThrow("exit 1");
		expect(d.fetchFn).not.toHaveBeenCalled();
		expect(d.errorLog).toHaveBeenCalledWith(
			expect.stringContaining("TEAMLEAD_API_TOKEN"),
		);
	});

	it("does not publish a failed or empty Bridge response", async () => {
		const publish = vi.fn(async () => 0);
		const failed = deps({
			publish,
			fetchFn: async () => ({ ok: false, status: 503, text: async () => "" }),
		});
		await expect(runAccountsPage([], failed)).rejects.toThrow("exit 1");
		expect(publish).not.toHaveBeenCalled();

		const empty = deps({
			publish,
			fetchFn: async () => ({ ok: true, status: 200, text: async () => "" }),
		});
		await expect(runAccountsPage([], empty)).rejects.toThrow("exit 1");
		expect(publish).not.toHaveBeenCalled();
	});

	it("propagates publish-report failure", async () => {
		const d = deps({ publish: vi.fn(async () => 7) });
		await expect(runAccountsPage([], d)).rejects.toThrow("exit 7");
	});

	it("does not ask for a probe on a bounded call it could never outlive", async () => {
		const d = deps();
		await runAccountsPage(["--timeout-ms", "5000"], d);

		expect(d.fetchFn).toHaveBeenCalledWith(
			"http://localhost:9876/api/accounts-page.html",
			expect.anything(),
		);
	});
});
