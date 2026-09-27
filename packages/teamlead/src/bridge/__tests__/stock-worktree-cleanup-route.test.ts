import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createLifecycleRouter,
	type LifecycleRoutesDeps,
} from "../lifecycle-routes.js";

async function post(
	server: Server,
	body: unknown,
	header?: string,
	path = "/api/lifecycle/land/cleanup/preview",
): Promise<{ status: number; body: Record<string, unknown> }> {
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("server_not_bound");
	const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(header ? { "x-flywheel-lead-context": header } : {}),
		},
		body: JSON.stringify(body),
	});
	return {
		status: response.status,
		body: (await response.json()) as Record<string, unknown>,
	};
}

describe("stock worktree cleanup HTTP authority", () => {
	let server: Server | undefined;
	afterEach(() => server?.close());

	function serve(overrides: Partial<LifecycleRoutesDeps>): Server {
		const deps: LifecycleRoutesDeps = {
			store: {} as LifecycleRoutesDeps["store"],
			projects: [{ projectName: "flywheel", projectRoot: "/srv/flywheel" }],
			worktreeManager: {} as LifecycleRoutesDeps["worktreeManager"],
			withRepoLock: async (_repo, fn) => fn(),
			parkFn: vi.fn(),
			unparkFn: vi.fn(),
			applySnapshotCloseoutFn: vi.fn(),
			apiTokenConfigured: true,
			...overrides,
		};
		const app = express();
		app.use(express.json());
		app.use("/api/lifecycle", createLifecycleRouter(deps));
		server = createServer(app);
		server.listen(0);
		return server;
	}

	it("rejects a runner or missing private carrier before preview has side effects", async () => {
		const preview = vi.fn();
		serve({
			authorizeRecloseHttp: () => {
				throw new Error("runner_credential_refused");
			},
			stockCleanup: { preview },
		});

		const response = await post(server!, { project: "flywheel" });
		expect(response.status).toBe(403);
		expect(preview).not.toHaveBeenCalled();
	});

	it("rejects cross-project Lead authority before enumeration", async () => {
		const preview = vi.fn();
		serve({
			authorizeRecloseHttp: () => ({
				actor: "lead:eng",
				projectName: "other",
				leadId: "eng",
				assertCurrent: vi.fn(),
			}),
			stockCleanup: { preview },
		});

		const response = await post(
			server!,
			{ project: "flywheel" },
			"private-context",
		);
		expect(response.status).toBe(403);
		expect(response.body).toEqual({ error: "cleanup_lead_scope_mismatch" });
		expect(preview).not.toHaveBeenCalled();
	});

	it("checks carrier freshness before and after the read-only preview", async () => {
		const assertCurrent = vi.fn();
		const preview = vi.fn(async () => ({
			manifest: { schemaVersion: 1, projectName: "flywheel", targets: [] },
			manifestJson: "fixture",
			manifestDigest: "a".repeat(64),
		}));
		serve({
			authorizeRecloseHttp: () => ({
				actor: "lead:eng",
				projectName: "flywheel",
				leadId: "eng",
				assertCurrent,
			}),
			stockCleanup: { preview },
		});

		const response = await post(
			server!,
			{ project: "flywheel" },
			"private-context",
		);
		expect(response.status).toBe(200);
		expect(preview).toHaveBeenCalledWith({
			projectName: "flywheel",
			actor: "lead:eng",
			authorityCheck: assertCurrent,
		});
		expect(assertCurrent).toHaveBeenCalledTimes(2);
		expect(response.body).toMatchObject({ manifestDigest: "a".repeat(64) });
	});

	it("keeps execute fail-closed while the shared body provider is unavailable", async () => {
		const preview = vi.fn();
		const assertCurrent = vi.fn();
		serve({
			authorizeRecloseHttp: () => ({
				actor: "lead:eng",
				projectName: "flywheel",
				leadId: "eng",
				assertCurrent,
			}),
			stockCleanup: { preview },
		});
		const response = await post(
			server!,
			{
				project: "flywheel",
				requestId: "11111111-1111-4111-8111-111111111111",
				manifestJson: "{}",
				manifestDigest: "a".repeat(64),
			},
			"private-context",
			"/api/lifecycle/land/cleanup/execute",
		);
		expect(response).toEqual({
			status: 503,
			body: { error: "stock_cleanup_execute_disabled" },
		});
		expect(assertCurrent).toHaveBeenCalledOnce();
		expect(preview).not.toHaveBeenCalled();
	});

	it("passes the exact authenticated execute tuple to the server-side executor", async () => {
		const assertCurrent = vi.fn();
		const execute = vi.fn(async () => ({ status: "applied", items: [] }));
		serve({
			authorizeRecloseHttp: () => ({
				actor: "lead:eng",
				projectName: "flywheel",
				leadId: "eng",
				assertCurrent,
			}),
			stockCleanup: { preview: vi.fn(), execute },
		});
		const tuple = {
			project: "flywheel",
			requestId: "11111111-1111-4111-8111-111111111111",
			manifestJson: "{}",
			manifestDigest: "a".repeat(64),
		};
		const response = await post(
			server!,
			tuple,
			"private-context",
			"/api/lifecycle/land/cleanup/execute",
		);

		expect(response).toMatchObject({
			status: 200,
			body: { status: "applied" },
		});
		expect(execute).toHaveBeenCalledWith({
			projectName: "flywheel",
			actor: "lead:eng",
			requestId: tuple.requestId,
			manifestJson: tuple.manifestJson,
			manifestDigest: tuple.manifestDigest,
			authorityCheck: assertCurrent,
		});
		expect(assertCurrent).toHaveBeenCalledTimes(2);
	});
});
