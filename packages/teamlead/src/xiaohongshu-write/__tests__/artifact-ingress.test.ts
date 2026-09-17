import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createArtifactIngressHandler } from "../artifact-ingress.js";
import { XhsFrozenArtifactStore } from "../artifacts.js";
import { XhsAuthorityClient } from "../authority-client.js";
import { artifactSchema } from "../contracts.js";
import { fixture, NOW } from "./store-fixture.js";

it("imports only scoped bounded bytes after kernel peer proof and rejects altered metadata/content", async () => {
	const f = fixture(),
		root = mkdtempSync("/tmp/xhs-artifact-ingress-");
	const media = join(root, "media");
	mkdirSync(media, { mode: 0o700 });
	const helper = join(root, "peer");
	execFileSync("cc", [
		"-O2",
		fileURLToPath(
			new URL(
				"../../../../../scripts/xhs/xhs-peer-credentials.c",
				import.meta.url,
			),
		),
		"-o",
		helper,
	]);
	const artifacts = new XhsFrozenArtifactStore(media, f.store, {
		attachmentLimit: 1024,
		validate: async () => {},
	});
	let wrongPeer = false,
		scopes = 0,
		imports = 0;
	const peerHelper = {
		path: helper,
		sha256: createHash("sha256").update(readFileSync(helper)).digest("hex"),
	};
	const server = createServer((req, res) =>
		createArtifactIngressHandler({
			modelUid: process.getuid!() + (wrongPeer ? 1 : 0),
			peerHelper,
			scope: async (_uid, selection) => {
				scopes++;
				return {
					identity: { ...f.identity, requesterUid: process.getuid!() },
					activationId: selection.activationId,
				};
			},
			import: async (context, mime, stream) => {
				imports++;
				return artifacts.import(context.identity.projectId, mime, stream, NOW);
			},
		})(req, res),
	);
	const socketPath = join(root, "ingress.sock");
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const bytes = Buffer.from("89504e470d0a1a0a00000000", "hex");
	const metadata = {
		projectId: f.identity.projectId,
		leadId: f.identity.leadId,
		activationId: "activation",
		mimeType: "image/png",
		sizeBytes: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
	const call = (meta: unknown, body = bytes) =>
		new Promise<{ status: number; body: Record<string, unknown> }>(
			(resolve, reject) => {
				const req = request(
					{
						socketPath,
						method: "POST",
						path: "/v1/artifact/import",
						headers: {
							"content-type": "application/octet-stream",
							"x-flywheel-artifact": Buffer.from(JSON.stringify(meta)).toString(
								"base64",
							),
						},
					},
					(res) => {
						let text = "";
						res.on("data", (chunk) => {
							text += chunk;
						});
						res.on("end", () =>
							resolve({ status: res.statusCode!, body: JSON.parse(text) }),
						);
					},
				);
				req.on("error", reject);
				req.end(body);
			},
		);
	try {
		const result = await call(metadata);
		expect(result.status).toBe(200);
		expect(result.body).toEqual({
			artifactId: expect.any(String),
			mimeType: "image/png",
			sha256: metadata.sha256,
			sizeBytes: bytes.length,
		});
		expect(
			await artifacts.read(
				metadata.projectId,
				artifactSchema.parse(result.body),
			),
		).toEqual(bytes);
		const client = new XhsAuthorityClient({
			socketPath,
			authorityUid: process.getuid!(),
			peerHelper,
			scope: {
				projectId: metadata.projectId,
				leadId: metadata.leadId,
				activationId: metadata.activationId,
			},
			assertCurrent: () => {},
		});
		const uploaded = await client.importArtifact({
			data: bytes,
			mimeType: "image/png",
		});
		expect(await artifacts.read(metadata.projectId, uploaded)).toEqual(bytes);
		expect(uploaded).toEqual(result.body);
		const count = readdirSync(media).length;
		for (const bad of [
			{ ...metadata, sha256: "0".repeat(64) },
			{ ...metadata, sizeBytes: bytes.length - 1 },
			{ ...metadata, sizeBytes: bytes.length + 1 },
			{ ...metadata, path: "/tmp/model-path" },
			{ ...metadata, projectId: "other" },
			{ ...metadata, sizeBytes: 11 * 1024 * 1024 },
		]) {
			expect((await call(bad)).status).toBe(403);
			expect(readdirSync(media)).toHaveLength(count);
		}
		const before = { scopes, imports };
		wrongPeer = true;
		expect((await call(metadata)).status).toBe(403);
		expect({ scopes, imports }).toEqual(before);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		f.close();
		rmSync(root, { recursive: true, force: true });
	}
});
