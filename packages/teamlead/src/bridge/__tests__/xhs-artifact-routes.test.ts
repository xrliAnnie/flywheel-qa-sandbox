import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { XhsBridgeArtifactRegistry } from "../xhs-artifact-registry.js";
import { createXhsArtifactRouter } from "../xhs-artifact-routes.js";

const state = vi.hoisted(() => ({
	root: "",
	policyChecks: 0,
	current: true,
	policy: true,
	shutdown: false,
}));
vi.mock("../xhs-write-context.js", () => ({
	createXhsWriteContext: (header: unknown) => {
		if (header !== "identity") throw Error("private");
		return {
			scope: { projectId: "p", leadId: "l", activationId: "a" },
			projectRoot: () => state.root,
			assertCurrent: () => {
				if (!state.current) throw Error("private");
			},
		};
	},
}));
vi.mock("../../xiaohongshu-write/parent-client-policy.js", () => ({
	createBridgeXhsWriteClient: () => {
		state.policyChecks++;
		if (!state.policy) throw Error("private-policy");
		return {};
	},
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	state.current = true;
	state.policyChecks = 0;
	state.policy = true;
	state.shutdown = false;
});
async function setup() {
	state.root = realpathSync(mkdtempSync("/tmp/xhs-upload-route-"));
	const root = state.root;
	const registry = new XhsBridgeArtifactRegistry();
	const app = express();
	app.use(
		createXhsArtifactRouter({
			apiToken: "token",
			env: {},
			registry,
			shuttingDown: () => state.shutdown,
		}),
	);
	app.use(express.json());
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await registry.close();
		rmSync(root, { recursive: true, force: true });
	});
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lead/xiaohongshu/artifact`;
	const upload = async (
		body: Buffer,
		headers: Record<string, string> = {},
		suffix = "",
	) => {
		const response = await fetch(url + suffix, {
			method: "POST",
			headers: {
				authorization: "Bearer token",
				"x-flywheel-lead-context": "identity",
				"content-type": "image/png",
				...headers,
			},
			body,
		});
		return { status: response.status, body: await response.json() };
	};
	return { root, registry, upload, url };
}
it("registers binary image/video bytes and returns reusable scoped handles without paths", async () => {
	const s = await setup();
	for (const mime of ["image/png", "video/mp4"]) {
		const bytes = Buffer.from("controlled-media");
		const response = await s.upload(bytes, { "content-type": mime });
		expect(response.status).toBe(200);
		expect(Object.keys(response.body).sort()).toEqual([
			"handle",
			"mimeType",
			"sha256",
			"size",
		]);
		expect(response.body.mimeType).toBe(mime);
		expect(
			(
				await s.registry
					.forScope({ projectId: "p", leadId: "l", activationId: "a" })
					.read(response.body.handle)
			).data,
		).toEqual(bytes);
	}
});
it("denies bad auth/current/root policy and shutdown before staging", async () => {
	const s = await setup();
	expect(
		(await s.upload(Buffer.from("x"), { authorization: "wrong" })).status,
	).toBe(401);
	expect(
		(await s.upload(Buffer.from("x"), { "x-flywheel-lead-context": "bad" }))
			.status,
	).toBe(403);
	state.current = false;
	expect((await s.upload(Buffer.from("x"))).status).toBe(403);
	state.current = true;
	state.policy = false;
	expect((await s.upload(Buffer.from("x"))).status).toBe(403);
	state.policy = true;
	state.shutdown = true;
	expect((await s.upload(Buffer.from("x"))).status).toBe(403);
	expect(readdirSync(s.root)).toEqual([]);
});
it("rejects oversized, empty, compressed, unsupported and query-bearing uploads", async () => {
	const s = await setup();
	for (const [bytes, headers, suffix] of [
		[Buffer.alloc(10 * 1024 * 1024 + 1), {}, ""],
		[Buffer.alloc(0), {}, ""],
		[Buffer.from("x"), { "content-encoding": "gzip" }, ""],
		[Buffer.from("/private/path"), { "content-type": "application/json" }, ""],
		[Buffer.from("x"), {}, "?path=/private/path"],
	] as [Buffer, Record<string, string>, string][])
		expect((await s.upload(bytes, headers, suffix)).status).toBe(400);
	expect(readdirSync(s.root)).toEqual([]);
});

it("rechecks identity during a chunked upload before any staging", async () => {
	const s = await setup();
	let req!: ReturnType<typeof request>;
	const result = new Promise<number>((resolve) => {
		req = request(
			s.url,
			{
				method: "POST",
				headers: {
					authorization: "Bearer token",
					"content-type": "image/png",
					"x-flywheel-lead-context": "identity",
				},
			},
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode!));
			},
		);
		req.on("error", () => resolve(0));
		req.flushHeaders();
	});
	await vi.waitFor(() => expect(state.policyChecks).toBe(1));
	state.current = false;
	req.end("bytes");
	expect(await result).toBe(403);
	expect(readdirSync(s.root)).toEqual([]);
});

it("bounds concurrent streams and enforces the cap without Content-Length", async () => {
	const s = await setup();
	const pending = Array.from({ length: 4 }, () => {
		let req!: ReturnType<typeof request>;
		const done = new Promise<number>((resolve) => {
			req = request(
				s.url,
				{
					method: "POST",
					headers: {
						authorization: "Bearer token",
						"content-type": "image/png",
						"x-flywheel-lead-context": "identity",
					},
				},
				(res) => {
					res.resume();
					res.on("end", () => resolve(res.statusCode!));
				},
			);
			req.on("error", () => resolve(0));
			req.flushHeaders();
		});
		return { req, done };
	});
	await vi.waitFor(() => expect(state.policyChecks).toBe(4));
	expect((await s.upload(Buffer.from("x"))).status).toBe(503);
	pending[0]!.req.end(Buffer.alloc(10 * 1024 * 1024 + 1));
	expect(await pending[0]!.done).toBe(400);
	expect(readdirSync(s.root)).toEqual([]);
	for (const stream of pending.slice(1)) stream.req.end("bytes");
	expect(
		await Promise.all(pending.slice(1).map((stream) => stream.done)),
	).toEqual([200, 200, 200]);
	expect((await s.upload(Buffer.from("x"))).status).toBe(200);
});

// Sandbox ps is unavailable; keep real lock/filesystem behavior with an explicit
// start-time observation seam for this test process.
vi.mock("flywheel-config", async (original) => ({
	...(await original<typeof import("flywheel-config")>()),
	processStartTime: () => "fixture-bridge-start",
}));

it("returns fixed leftover-capacity denial and logs retained paths without exposing them in HTTP", async () => {
	const s = await setup();
	const paths = Array.from({ length: 8 }, () =>
		mkdtempSync(join(s.root, ".flywheel-xhs-artifact-")),
	);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(await s.upload(Buffer.from("x"))).toEqual({
			status: 503,
			body: { code: "staging_leftovers_exceeded" },
		});
		expect(warn).toHaveBeenCalledWith(
			"xhs_staging_leftovers_retained",
			expect.any(String),
		);
		const logged = JSON.parse(warn.mock.calls[0]![1] as string);
		expect(logged.paths.sort()).toEqual(paths.sort());
	} finally {
		warn.mockRestore();
	}
});
