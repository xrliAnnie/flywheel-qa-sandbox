import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { leadOperationTimeoutMs } from "flywheel-comm/lead-operation-client";
import { assertFeaturePushBranch } from "../lead-backends/codex/gateway/GitPushRunner.js";

export interface GitPushTransportOptions {
	owner: string;
	repo: string;
	branch: string;
	expectedHead: string;
	token: () => string;
	signal: AbortSignal;
	assertCurrent: () => Promise<void>;
	assertCurrentSync: () => void;
	fetchImpl?: typeof fetch;
}
const MAX_REQUEST = 16 * 1024 * 1024;
const MAX_RESPONSE = 1024 * 1024;
function denied(): never {
	throw new Error("git_push_transport_denied");
}
async function bounded(response: Response): Promise<Buffer> {
	if (!response.ok || !response.body) denied();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.length;
			if (size > MAX_RESPONSE) denied();
			chunks.push(part.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks);
}
function packets(body: Buffer): { lines: Buffer[]; offset: number } {
	const lines: Buffer[] = [];
	let offset = 0;
	while (offset + 4 <= body.length) {
		const raw = body.subarray(offset, offset + 4).toString("ascii");
		if (!/^[a-f0-9]{4}$/.test(raw)) denied();
		const length = Number.parseInt(raw, 16);
		offset += 4;
		if (length === 0) return { lines, offset };
		if (length < 4 || length > 65520 || offset + length - 4 > body.length)
			denied();
		lines.push(body.subarray(offset, offset + length - 4));
		offset += length - 4;
	}
	return denied();
}
export async function createGitPushTransport(options: GitPushTransportOptions) {
	if (
		!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(options.owner) ||
		!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(options.repo) ||
		!/^[a-f0-9]{40}$/.test(options.expectedHead)
	)
		denied();
	assertFeaturePushBranch(options.branch);
	const prefix = `/${randomBytes(32).toString("hex")}/repo.git`;
	const upstream = `https://github.com/${options.owner}/${options.repo}.git`;
	const controller = new AbortController();
	const abort = () => controller.abort();
	options.signal.addEventListener("abort", abort, { once: true });
	if (options.signal.aborted) abort();
	const timer = setTimeout(abort, leadOperationTimeoutMs("git.feature.push"));
	timer.unref();
	let dispatched = false;
	async function request(write: boolean, body?: Buffer) {
		await options.assertCurrent();
		if (controller.signal.aborted) denied();
		const token = options.token();
		if (!token || /[\r\n]/.test(token)) denied();
		options.assertCurrentSync();
		const response = await (options.fetchImpl ?? fetch)(
			`${upstream}${write ? "/git-receive-pack" : "/info/refs?service=git-receive-pack"}`,
			{
				method: write ? "POST" : "GET",
				redirect: "error",
				signal: controller.signal,
				headers: {
					authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
					...(write
						? { "content-type": "application/x-git-receive-pack-request" }
						: {}),
				},
				...(body ? { body: new Uint8Array(body) } : {}),
			},
		);
		const data = await bounded(response);
		await options.assertCurrent();
		options.assertCurrentSync();
		return data;
	}
	const server = createServer({ maxHeaderSize: 8192 }, async (req, res) => {
		try {
			if (
				req.headers.authorization ||
				req.headers.cookie ||
				req.headers["content-encoding"]
			)
				denied();
			let data: Buffer;
			let type: string;
			if (
				req.method === "GET" &&
				req.url === `${prefix}/info/refs?service=git-receive-pack`
			) {
				data = await request(false);
				type = "application/x-git-receive-pack-advertisement";
			} else if (
				req.method === "POST" &&
				req.url === `${prefix}/git-receive-pack`
			) {
				if (dispatched) denied();
				const chunks: Buffer[] = [];
				let size = 0;
				for await (const chunk of req) {
					size += chunk.length;
					if (size > MAX_REQUEST) denied();
					chunks.push(Buffer.from(chunk));
				}
				const body = Buffer.concat(chunks);
				const commands = packets(body);
				if (commands.lines.length !== 1) denied();
				const command = commands.lines[0]!.toString("utf8").split("\0")[0]!;
				if (
					!new RegExp(
						`^[a-f0-9]{40} ${options.expectedHead} refs/heads/${options.branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
					).test(command)
				)
					denied();
				if (dispatched) denied();
				dispatched = true;
				data = await request(true, body);
				type = "application/x-git-receive-pack-result";
			} else denied();
			res.writeHead(200, {
				"content-type": type,
				"content-length": data.length,
			});
			res.end(data);
		} catch {
			res.writeHead(502, { "content-type": "text/plain" });
			res.end("git_push_transport_failed");
		}
	});
	server.requestTimeout = leadOperationTimeoutMs("git.feature.push");
	server.headersTimeout = 15000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") denied();
	return {
		remoteUrl: `http://127.0.0.1:${address.port}${prefix}`,
		readHead: async () => {
			const data = await request(false);
			const service = packets(data);
			const refs = packets(data.subarray(service.offset));
			for (const line of refs.lines) {
				const match = /^([a-f0-9]{40}) ([^\0\n]+)(?:\0|\n|$)/.exec(
					line.toString("utf8"),
				);
				if (match?.[2] === `refs/heads/${options.branch}`) return match[1];
			}
			return undefined;
		},
		close: async () => {
			clearTimeout(timer);
			options.signal.removeEventListener("abort", abort);
			abort();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
