import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { createXhsBridgeWriteService } from "../xhs-write-service.js";

const state = vi.hoisted(() => ({
	root: "",
	calls: 0,
	delay: null as null | Promise<void>,
}));
vi.mock("../xhs-write-context.js", () => ({
	createXhsWriteContext: () => ({
		scope: { projectId: "p", leadId: "l", activationId: "a" },
		projectRoot: () => state.root,
		assertCurrent() {},
	}),
}));
vi.mock("../../xiaohongshu-write/parent-client-policy.js", () => ({
	createBridgeXhsWriteClient: () => ({
		async importArtifact(input: { data: Buffer; mimeType: string }) {
			return {
				artifactId: randomUUID(),
				sha256: createHash("sha256").update(input.data).digest("hex"),
				sizeBytes: input.data.length,
				mimeType: input.mimeType,
			};
		},
		async call(action: string) {
			state.calls++;
			await state.delay;
			if (action === "list_feeds") return { text: "observed" };
			return {
				proposalId: randomUUID(),
				contentDigest: "a".repeat(64),
				expiresAt: Date.now() + 10000,
				state: "awaiting_approval",
				cardRef: null,
			};
		},
	}),
}));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
	state.calls = 0;
	state.delay = null;
});
async function setup(fullStack = false) {
	const root = realpathSync(mkdtempSync("/tmp/xhs-service-"));
	state.root = root;
	const service = createXhsBridgeWriteService({ apiToken: "token", env: {} });
	let app = express();
	let closeStore = () => {};
	if (fullStack) {
		const { createBridgeApp } = await import("../plugin.js");
		const { StateStore } = await import("../../StateStore.js");
		const store = await StateStore.create(":memory:");
		closeStore = () => store.close();
		const args: Parameters<typeof createBridgeApp> = [
			store,
			[],
			{
				host: "127.0.0.1",
				port: 0,
				dbPath: ":memory:",
				notificationChannel: "test-channel",
				defaultLeadAgentId: "lead",
				stuckThresholdMinutes: 15,
				stuckCheckIntervalMs: 300000,
				orphanThresholdMinutes: 60,
			} as Parameters<typeof createBridgeApp>[2],
		];
		args[16] = { xhsWriteService: service };
		app = createBridgeApp(...args);
	} else {
		app.use(service.router);
		app.use(express.json());
	}
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	cleanup.push(async () => {
		await service.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		closeStore();
		rmSync(root, { recursive: true, force: true });
	});
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lead/xiaohongshu/`;
	const upload = () =>
		fetch(`${base}artifact`, {
			method: "POST",
			headers: { authorization: "Bearer token", "content-type": "image/png" },
			body: Buffer.from("media"),
		});
	const prepare = (handle: string) =>
		fetch(`${base}write/prepare`, {
			method: "POST",
			headers: {
				authorization: "Bearer token",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				requestId: randomUUID(),
				input: {
					operationId: "xiaohongshu.publish_content",
					accountSelector: "account",
					payload: { title: "t", content: "c" },
					artifactHandles: [handle],
				},
			}),
		});
	const read = () =>
		fetch(`${base}read/list_feeds`, {
			method: "POST",
			headers: {
				authorization: "Bearer token",
				"content-type": "application/json",
			},
			body: JSON.stringify({ requestId: randomUUID(), input: {} }),
		});
	return { root, service, upload, prepare, read };
}
it("shares uploaded handles with prepare and cleans owned media on close", async () => {
	const s = await setup();
	const uploaded = await s.upload();
	expect(uploaded.status).toBe(200);
	const artifact = await uploaded.json();
	expect((await s.prepare(artifact.handle)).status).toBe(200);
	expect(state.calls).toBe(1);
	expect(readdirSync(s.root)).toContain(".flywheel-xhs-staging-owner");
	expect(
		readdirSync(s.root).filter((name) =>
			name.startsWith(".flywheel-xhs-artifact-"),
		),
	).toHaveLength(1);
	await s.service.close();
	await s.service.close();
	expect(readdirSync(s.root)).toEqual([]);
	expect((await s.upload()).status).toBe(503);
	const unavailable = await s.read();
	expect(unavailable.status).toBe(503);
	expect(await unavailable.json()).toEqual({ code: "xhs_read_unavailable" });
});
it("drains actual async work even after its HTTP response closes before cleanup", async () => {
	const s = await setup();
	const artifact = await (await s.upload()).json();
	let release!: () => void;
	state.delay = new Promise<void>((resolve) => {
		release = resolve;
	});
	const result = s.prepare(artifact.handle).catch(() => null);
	await vi.waitFor(() => expect(state.calls).toBe(1));
	let closed = false;
	const closing = s.service.close().then(() => {
		closed = true;
	});
	try {
		await result;
		expect(closed).toBe(false);
		expect(readdirSync(s.root)).toContain(".flywheel-xhs-staging-owner");
		expect(
			readdirSync(s.root).filter((name) =>
				name.startsWith(".flywheel-xhs-artifact-"),
			),
		).toHaveLength(1);
	} finally {
		release();
		await closing;
	}
	expect(readdirSync(s.root)).toEqual([]);
});

it("mounts the real Bridge stack ahead of global body parsing", async () => {
	const s = await setup(true);
	const uploaded = await s.upload();
	expect(uploaded.status).toBe(200);
	const artifact = await uploaded.json();
	expect((await s.prepare(artifact.handle)).status).toBe(200);
	expect((await s.read()).status).toBe(200);
	expect(state.calls).toBe(2);
}, 20000);

// Sandbox ps is unavailable; keep real lock/filesystem behavior with an explicit
// start-time observation seam for this test process.
vi.mock("flywheel-config", async (original) => ({
	...(await original<typeof import("flywheel-config")>()),
	processStartTime: () => "fixture-bridge-start",
}));
