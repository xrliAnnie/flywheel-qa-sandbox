import { describe, expect, it, vi } from "vitest";
import { type FeatureFlagsDeps, runFeatureFlags } from "../feature-flags.js";

function baseDeps(over: Partial<FeatureFlagsDeps> = {}): FeatureFlagsDeps {
	return {
		env: {},
		fetchFn: async () => ({
			ok: true,
			status: 200,
			text: async () => "<html>flags</html>",
		}),
		publish: vi.fn(async () => 0),
		writeFile: vi.fn(),
		log: vi.fn(),
		errorLog: vi.fn(),
		exit: ((c: number) => {
			throw new Error(`exit ${c}`);
		}) as (c: number) => never,
		outDefault: "/tmp/ff-test.html",
		...over,
	};
}

describe("flywheel-comm feature-flags report", () => {
	it("bad subcommand → usage + exit 1", async () => {
		const deps = baseDeps();
		await expect(runFeatureFlags(["bogus"], deps)).rejects.toThrow("exit 1");
		expect(deps.errorLog).toHaveBeenCalledWith(
			expect.stringContaining("usage"),
		);
	});

	it("happy path: fetches loopback report → writes → publishes", async () => {
		const publish = vi.fn(async () => 0);
		const writeFile = vi.fn();
		const deps = baseDeps({
			env: { FLYWHEEL_BRIDGE_URL: "http://localhost:9876" },
			publish,
			writeFile,
		});
		await runFeatureFlags(
			["report", "--project", "flywheel", "--channel", "C1"],
			deps,
		);
		expect(writeFile).toHaveBeenCalledWith(
			"/tmp/ff-test.html",
			"<html>flags</html>",
		);
		expect(publish).toHaveBeenCalledWith({
			htmlPath: "/tmp/ff-test.html",
			project: "flywheel",
			channelId: "C1",
		});
	});

	it("targets the loopback flag-report endpoint (interactive=1 phone page)", async () => {
		const fetchFn = vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => "x",
		}));
		const deps = baseDeps({
			env: { FLYWHEEL_BRIDGE_URL: "http://localhost:9876/" },
			fetchFn,
		});
		await runFeatureFlags(["report"], deps);
		// The published report IS the interactive copy-paste page (nonce'd at serve
		// time by report-registry) — Annie's locked control model.
		expect(fetchFn).toHaveBeenCalledWith(
			"http://localhost:9876/api/fleet/flag-report.html?interactive=1",
		);
	});

	it("non-ok Bridge response → exit 1", async () => {
		const deps = baseDeps({
			fetchFn: async () => ({ ok: false, status: 503, text: async () => "" }),
		});
		await expect(runFeatureFlags(["report"], deps)).rejects.toThrow("exit 1");
		expect(deps.errorLog).toHaveBeenCalledWith(expect.stringContaining("503"));
	});

	it("publish failure exit code is propagated (does NOT exit 0)", async () => {
		const deps = baseDeps({
			publish: vi.fn(async () => 1), // publish/deliver failed
		});
		await expect(runFeatureFlags(["report"], deps)).rejects.toThrow("exit 1");
	});
});

describe("flywheel-comm feature-flags apply", () => {
	function httpMock(
		stage: { ok: boolean; status: number; body: unknown },
		apply: { ok: boolean; status: number; body: unknown },
	) {
		return vi.fn(async (url: string) => {
			const which = url.includes("/flag/stage") ? stage : apply;
			return {
				ok: which.ok,
				status: which.status,
				json: async () => which.body,
			};
		});
	}

	it("bad args (missing --name/--to) → exit 1", async () => {
		const deps = baseDeps();
		await expect(
			runFeatureFlags(["apply", "--to", "off"], deps),
		).rejects.toThrow("exit 1");
		await expect(
			runFeatureFlags(["apply", "--name", "x"], deps),
		).rejects.toThrow("exit 1");
	});

	it("happy: stage → apply, logs the apply body", async () => {
		const httpJson = httpMock(
			{
				ok: true,
				status: 200,
				body: { canonical: { kind: "flag" }, confirmToken: "t1" },
			},
			{ ok: true, status: 200, body: { ok: true } },
		);
		const deps = baseDeps({ httpJson });
		await runFeatureFlags(
			["apply", "--name", "auto_qa_killswitch", "--to", "off"],
			deps,
		);
		expect(httpJson).toHaveBeenCalledTimes(2);
		// stage POST carries the sparse {name, to}; apply POST carries {canonical, confirmToken}
		expect(httpJson.mock.calls[0]?.[0]).toContain("/api/fleet/flag/stage");
		expect(httpJson.mock.calls[1]?.[0]).toContain("/api/fleet/flag/apply");
		expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('"ok":true'));
	});

	it("stage failure → exit 1 (no apply)", async () => {
		const httpJson = httpMock(
			{ ok: false, status: 400, body: { error: "not direct-toggleable" } },
			{ ok: true, status: 200, body: { ok: true } },
		);
		const deps = baseDeps({ httpJson });
		await expect(
			runFeatureFlags(["apply", "--name", "x", "--to", "off"], deps),
		).rejects.toThrow("exit 1");
		expect(httpJson).toHaveBeenCalledTimes(1); // stage only
	});

	it("apply failure (denied) → exit 1", async () => {
		const httpJson = httpMock(
			{ ok: true, status: 200, body: { canonical: {}, confirmToken: "t" } },
			{ ok: false, status: 409, body: { error: "changed since review" } },
		);
		const deps = baseDeps({ httpJson });
		await expect(
			runFeatureFlags(["apply", "--name", "x", "--to", "off"], deps),
		).rejects.toThrow("exit 1");
	});
});
