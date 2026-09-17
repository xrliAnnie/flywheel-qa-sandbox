import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createClaudeXhsBridgeClient } from "../claude-bridge-client.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
async function setup() {
	const state = {
		path: "/api/lead/xiaohongshu/write/cancel",
		calls: 0,
		body: "",
		header: "",
		status: 200,
		output: JSON.stringify({ state: "revoked" }),
	};
	const server = createServer(async (req, res) => {
		state.calls++;
		state.header = String(req.headers["x-flywheel-lead-context"]);
		expect(req.url).toBe(state.path);
		expect(req.headers.authorization).toBe("Bearer fixture-token");
		for await (const chunk of req) state.body += chunk.toString();
		res.writeHead(state.status, {
			"content-type": "application/json",
			location: "http://127.0.0.1:1/private",
		});
		res.end(state.output);
	});
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	cleanup.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const env = {
		BRIDGE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		TEAMLEAD_API_TOKEN: "fixture-token",
		FLYWHEEL_PROJECT_NAME: "project",
		FLYWHEEL_LEAD_ID: "lead",
		FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
		FLYWHEEL_LEAD_LEASE_KEY: "project-lead",
		FLYWHEEL_LEAD_GENERATION: "3",
	};
	return { state, env };
}
const input = () => ({
	requestId: randomUUID(),
	input: { proposalId: randomUUID() },
});
it("sends a fixed request and snapshots only the launch identity references", async () => {
	const s = await setup();
	const client = createClaudeXhsBridgeClient(s.env);
	s.env.FLYWHEEL_LEAD_GENERATION = "4";
	const body = input();
	expect(await client.call("cancel", body)).toEqual({ state: "revoked" });
	expect(JSON.parse(s.state.body)).toEqual(body);
	expect(JSON.parse(Buffer.from(s.state.header, "base64").toString())).toEqual({
		projectName: "project",
		leadId: "lead",
		identityDigest: "a".repeat(64),
		leaseClaim: { leaseKey: "project-lead", generation: 3 },
	});
});
it("refuses untrusted destinations, incomplete leases and extra approval before sending", async () => {
	const s = await setup();
	for (const patch of [
		{ BRIDGE_URL: "https://example.com" },
		{ BRIDGE_URL: "http://localhost/private" },
		{ BRIDGE_URL: "http://user:secret@localhost" },
		{ FLYWHEEL_LEAD_GENERATION: "0" },
		{ TEAMLEAD_API_TOKEN: "" },
	])
		expect(() => createClaudeXhsBridgeClient({ ...s.env, ...patch })).toThrow(
			"founder_write_gate_absent",
		);
	const client = createClaudeXhsBridgeClient(s.env);
	await expect(
		client.call("cancel", { ...input(), approved: true }),
	).rejects.toThrow("xhs_request_invalid");
	await expect(client.call("../execute", input())).rejects.toThrow(
		"xhs_request_invalid",
	);
	expect(s.state.calls).toBe(0);
});
it("suppresses malformed, oversized, secret-bearing and redirect responses without retry", async () => {
	const s = await setup();
	const client = createClaudeXhsBridgeClient(s.env);
	for (const output of [
		'{"state":"revoked","xsec_token":"secret"}',
		'{"state":"revoked","state":"revoked"}',
		"x".repeat(65537),
	]) {
		s.state.output = output;
		await expect(client.call("cancel", input())).rejects.toThrow(
			"xhs_result_unknown",
		);
	}
	s.state.status = 302;
	s.state.output = "private";
	await expect(client.call("cancel", input())).rejects.toThrow(
		"xhs_result_unknown",
	);
	expect(s.state.calls).toBe(4);
});

it("preserves only the fixed denial codes and cancels without sending", async () => {
	const s = await setup();
	const client = createClaudeXhsBridgeClient(s.env);
	s.state.status = 403;
	s.state.output = JSON.stringify({ code: "founder_write_gate_absent" });
	await expect(client.call("cancel", input())).rejects.toThrow(
		"founder_write_gate_absent",
	);
	s.state.output = JSON.stringify({
		code: "founder_write_gate_absent",
		secret: "private",
	});
	await expect(client.call("cancel", input())).rejects.toThrow(
		"xhs_result_unknown",
	);
	await expect(
		client.call("cancel", input(), AbortSignal.abort()),
	).rejects.toThrow("xhs_result_unknown");
	expect(s.state.calls).toBe(2);
});

it("uploads controlled bytes and verifies the returned handle descriptor", async () => {
	const s = await setup();
	const client = createClaudeXhsBridgeClient(s.env);
	s.state.path = "/api/lead/xiaohongshu/artifact";
	const data = Buffer.from("media");
	const artifact = {
		handle: randomUUID(),
		mimeType: "video/mp4",
		size: data.length,
		sha256: createHash("sha256").update(data).digest("hex"),
	};
	s.state.output = JSON.stringify(artifact);
	expect(await client.importArtifact(data, "video/mp4")).toEqual(artifact);
	expect(s.state.body).toBe("media");
	s.state.output = JSON.stringify({ ...artifact, sha256: "f".repeat(64) });
	await expect(client.importArtifact(data, "video/mp4")).rejects.toThrow(
		"xhs_result_unknown",
	);
	s.state.output = JSON.stringify({ ...artifact, relativePath: "/private" });
	await expect(client.importArtifact(data, "video/mp4")).rejects.toThrow(
		"xhs_result_unknown",
	);
	expect(s.state.calls).toBe(3);
});
it("rejects unsupported, empty and oversized media before transmission", async () => {
	const s = await setup();
	const client = createClaudeXhsBridgeClient(s.env);
	for (const [data, mime] of [
		[Buffer.from("x"), "text/html"],
		[Buffer.alloc(0), "image/png"],
		[Buffer.alloc(10 * 1024 * 1024 + 1), "video/mp4"],
	] as const)
		await expect(client.importArtifact(data, mime)).rejects.toThrow(
			"xhs_request_invalid",
		);
	expect(s.state.calls).toBe(0);
});

it("reads bounded content through fixed read paths while preserving authority handles", async () => {
	const s = await setup();
	const client = createClaudeXhsBridgeClient(s.env);
	s.state.path = "/api/lead/xiaohongshu/read/list_feeds";
	const result = {
		text: JSON.stringify({
			resourceHandle: randomUUID(),
			text: "x".repeat(100000),
		}),
	};
	s.state.output = JSON.stringify(result);
	expect(
		await client.read("list_feeds", { requestId: randomUUID(), input: {} }),
	).toEqual(result);
	await expect(
		client.read("user_profile", { requestId: randomUUID(), input: {} }),
	).rejects.toThrow("xhs_request_invalid");
	s.state.output = "x".repeat(262145);
	await expect(
		client.read("list_feeds", { requestId: randomUUID(), input: {} }),
	).rejects.toThrow("xhs_read_unavailable");
	expect(s.state.calls).toBe(2);
});
it("validates QR expiry and never accepts raw tokens as detail inputs", async () => {
	const s = await setup();
	const client = createClaudeXhsBridgeClient(s.env);
	s.state.path = "/api/lead/xiaohongshu/read/get_login_qrcode";
	const qr = {
		loggedIn: false,
		image:
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9S8AAAAASUVORK5CYII=",
		expiresAt: Date.now() + 60000,
	};
	s.state.output = JSON.stringify(qr);
	expect(
		await client.read("get_login_qrcode", {
			requestId: randomUUID(),
			input: {},
		}),
	).toEqual(qr);
	s.state.output = JSON.stringify({ ...qr, expiresAt: Date.now() - 1 });
	await expect(
		client.read("get_login_qrcode", { requestId: randomUUID(), input: {} }),
	).rejects.toThrow("xhs_read_unavailable");
	await expect(
		client.read("get_feed_detail", {
			requestId: randomUUID(),
			input: { feed_id: "f", xsec_token: "private" },
		}),
	).rejects.toThrow("xhs_request_invalid");
	expect(s.state.calls).toBe(2);
});
