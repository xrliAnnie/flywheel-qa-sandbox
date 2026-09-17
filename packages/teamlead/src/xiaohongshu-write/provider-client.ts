import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { Agent, request } from "node:http";
import { createConnection } from "node:net";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { canonical, contentDigest, parseStrictJson } from "./canonical.js";
import {
	type FrozenArtifact,
	type FrozenWrite,
	freezeWrite,
} from "./contracts.js";
import { loginProjectionSchema } from "./login-contract.js";
import { createNativePeerReader } from "./native-peer.js";
import { dispatchPermitSchema } from "./permit.js";
import {
	type PrivateReadOperation,
	privateReadData,
	privateReadInputs,
	privateReadOperation,
} from "./provider-read-contract.js";

const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const accountStatusSchema = z
	.object({
		account: z
			.object({
				providerInstanceId: id,
				accountUserId: id,
				accountEpoch: integer,
				providerGeneration: id,
			})
			.strict(),
		upstream: z
			.object({
				binarySha256: digest,
				toolSchemaDigest: digest,
				guardProtocol: z.literal(1),
			})
			.strict(),
		loggedIn: z.boolean(),
	})
	.strict();
export type ProviderAccountStatus = z.infer<typeof accountStatusSchema>;
const readBindingSchema = accountStatusSchema.omit({ loggedIn: true });
const feedsSchema = readBindingSchema.extend({
	data: z
		.object({
			feeds: z.array(z.record(z.string(), z.unknown())).max(1000).nullable(),
			count: z.number().int().min(0).max(1000),
		})
		.strict(),
});
export type ProviderFeeds = z.infer<typeof feedsSchema>;
const leaseSchema = z
	.object({
		leaseId: id,
		accountUserId: id,
		accountEpoch: integer,
		providerGeneration: id,
		contentDigest: digest,
		leaseExpiresAt: integer,
	})
	.strict();
const statusSchema = z
	.object({ state: z.enum(["succeeded", "failed", "unknown", "denied"]) })
	.strict();
const statusQuery = z
	.object({ receiptId: id, attemptId: id, contentDigest: digest })
	.strict();
export type ProviderLease = z.infer<typeof leaseSchema>;
export type ProviderResult = z.infer<typeof statusSchema>["state"];
export type ProviderMediaSource = (
	artifact: FrozenArtifact,
	signal: AbortSignal,
) => AsyncIterable<Uint8Array>;
const unavailable = (): never => {
	throw Error("private_provider_unavailable");
};

/** Authority-private transport. Startup proves socket ancestry and the helper's
 * root ownership. Each new connection proves the actual peer before any HTTP
 * bytes (including permits or media) are sent. There is no network fallback. */
export class XhsProviderClient {
	private readonly socketPath: string;
	private readonly uid: number;
	private readonly peer: ReturnType<typeof createNativePeerReader>;
	private readonly now: () => number;
	constructor(options: {
		socketPath: string;
		providerUid: number;
		peerHelper: { path: string; sha256: string };
		now?: () => number;
	}) {
		if (
			!isAbsolute(options.socketPath) ||
			normalize(options.socketPath) !== options.socketPath ||
			options.socketPath.includes("\0") ||
			!Number.isSafeInteger(options.providerUid) ||
			options.providerUid < 0
		)
			unavailable();
		this.socketPath = options.socketPath;
		this.uid = options.providerUid;
		this.peer = createNativePeerReader(options.peerHelper);
		this.now = options.now ?? Date.now;
	}
	private async send(
		path: string,
		headers: Record<string, string>,
		body: (signal: AbortSignal) => AsyncIterable<Uint8Array>,
		signal?: AbortSignal,
		responseLimit = 8192,
	): Promise<unknown> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 120000);
		const cancel = () => controller.abort();
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) controller.abort();
		const socket = createConnection({ path: this.socketPath });
		const stop = () => socket.destroy(Error("private_provider_unavailable"));
		controller.signal.addEventListener("abort", stop, { once: true });
		socket.on("error", () => {});
		const agent = new Agent({ keepAlive: false, maxSockets: 1 });
		agent.createConnection = () => socket;
		try {
			await once(socket, "connect", { signal: controller.signal });
			if (
				(await this.peer(socket, controller.signal)) !== this.uid ||
				controller.signal.aborted ||
				socket.destroyed
			)
				unavailable();
			return await new Promise<unknown>((resolve, reject) => {
				controller.signal.addEventListener(
					"abort",
					() => reject(Error("private_provider_unavailable")),
					{ once: true },
				);
				if (controller.signal.aborted) {
					reject(Error("private_provider_unavailable"));
					return;
				}
				let uploaded = false;
				let received = false;
				let response: unknown;
				const done = () => {
					if (uploaded && received) resolve(response);
				};
				const req = request(
					{
						method: "POST",
						path,
						host: "localhost",
						agent,
						headers: { ...headers, connection: "close" },
						signal: controller.signal,
					},
					async (res) => {
						try {
							if (res.statusCode !== 200) throw Error();
							const chunks: Buffer[] = [];
							let size = 0;
							for await (const chunk of res) {
								const data = Buffer.from(chunk);
								size += data.length;
								if (size > responseLimit) throw Error();
								chunks.push(data);
							}
							response = parseStrictJson(
								new TextDecoder("utf-8", { fatal: true }).decode(
									Buffer.concat(chunks),
								),
							);
							received = true;
							done();
						} catch {
							res.destroy();
							reject(Error("private_provider_unavailable"));
						}
					},
				);
				req.once("error", reject);
				req.once("finish", () => {
					uploaded = true;
					done();
				});
				void (async () => {
					try {
						for await (const chunk of body(controller.signal)) {
							if (controller.signal.aborted || req.destroyed) throw Error();
							if (!req.write(chunk))
								await once(req, "drain", { signal: controller.signal });
						}
						req.end();
					} catch {
						req.destroy();
						reject(Error("private_provider_unavailable"));
					}
				})();
			});
		} catch {
			return unavailable();
		} finally {
			controller.abort();
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			controller.signal.removeEventListener("abort", stop);
			socket.destroy();
			agent.destroy();
		}
	}
	async prepare(
		input: FrozenWrite,
		media: ProviderMediaSource,
		signal?: AbortSignal,
	): Promise<ProviderLease> {
		try {
			const frozen = freezeWrite(structuredClone(input), this.now());
			// Freezing happened before founder review; this hop may validate but
			// must never normalize or expand the approved content again.
			if (canonical(frozen) !== canonical(input)) unavailable();
			const expectedDigest = contentDigest(frozen);
			const boundary = `xhs-${randomBytes(24).toString("hex")}`;
			async function* body(cancelled: AbortSignal) {
				yield Buffer.from(
					`--${boundary}\r\nContent-Disposition: form-data; name="frozen"\r\nContent-Type: application/json\r\n\r\n${canonical(frozen)}\r\n`,
				);
				for (const artifact of frozen.media) {
					yield Buffer.from(
						`--${boundary}\r\nContent-Disposition: form-data; name="media"\r\nContent-Type: application/octet-stream\r\n\r\n`,
					);
					const hash = createHash("sha256");
					let size = 0;
					for await (const chunk of media(
						structuredClone(artifact),
						cancelled,
					)) {
						const bytes = Buffer.from(chunk);
						size += bytes.length;
						if (size > artifact.sizeBytes) unavailable();
						hash.update(bytes);
						yield bytes;
					}
					if (
						size !== artifact.sizeBytes ||
						hash.digest("hex") !== artifact.sha256
					)
						unavailable();
					yield Buffer.from("\r\n");
				}
				yield Buffer.from(`--${boundary}--\r\n`);
			}
			const lease = leaseSchema.parse(
				await this.send(
					"/v1/prepare",
					{
						"content-type": `multipart/form-data; boundary=${boundary}`,
						"x-content-digest": expectedDigest,
					},
					body,
					signal,
				),
			);
			if (
				lease.contentDigest !== expectedDigest ||
				lease.accountUserId !== frozen.account.accountUserId ||
				lease.accountEpoch !== frozen.account.accountEpoch ||
				lease.providerGeneration !== frozen.account.providerGeneration ||
				lease.leaseExpiresAt <= this.now() ||
				lease.leaseExpiresAt > this.now() + 120000
			)
				unavailable();
			return lease;
		} catch {
			return unavailable();
		}
	}
	/** Only the private provider may supply this account observation. A false
	 * loggedIn value is a status result, never proof suitable for freezing writes. */
	async account(signal?: AbortSignal): Promise<ProviderAccountStatus> {
		try {
			async function* body() {
				yield Buffer.from("{}");
			}
			return accountStatusSchema.parse(
				await this.send(
					"/v1/account",
					{ "content-type": "application/json" },
					body,
					signal,
				),
			);
		} catch {
			return unavailable();
		}
	}
	async loginQR(
		expected: z.infer<typeof readBindingSchema>,
		signal?: AbortSignal,
	): Promise<
		z.infer<typeof readBindingSchema> & z.infer<typeof loginProjectionSchema>
	> {
		try {
			const binding = readBindingSchema.parse(expected);
			async function* body() {
				yield Buffer.from("{}");
			}
			const result = accountStatusSchema
				.extend({
					image: z.string().max(524310),
					expiresAt: z
						.number()
						.int()
						.nonnegative()
						.max(Number.MAX_SAFE_INTEGER),
				})
				.parse(
					await this.send(
						"/v1/read/get_login_qrcode",
						{ "content-type": "application/json" },
						body,
						signal,
						540000,
					),
				);
			const projection = loginProjectionSchema.parse({
				image: result.image,
				loggedIn: result.loggedIn,
				expiresAt: result.expiresAt,
			});
			if (
				canonical(result.upstream) !== canonical(binding.upstream) ||
				result.account.accountEpoch < binding.account.accountEpoch ||
				canonical({
					...result.account,
					accountEpoch: binding.account.accountEpoch,
				}) !== canonical(binding.account) ||
				(!projection.loggedIn &&
					(projection.expiresAt <= this.now() ||
						projection.expiresAt > this.now() + 240000))
			)
				unavailable();
			signal?.throwIfAborted();
			return {
				account: result.account,
				upstream: result.upstream,
				...projection,
			};
		} catch {
			return unavailable();
		}
	}

	/** Private raw read, including tokens for the authority's handle projection.
	 * Pin the expected account/epoch/provider before awaiting any transport. */
	async readFeeds(
		expected: z.infer<typeof readBindingSchema>,
		signal?: AbortSignal,
	): Promise<ProviderFeeds> {
		return feedsSchema.parse(
			await this.read("list_feeds", {}, expected, signal),
		);
	}
	async read(
		action: PrivateReadOperation,
		input: unknown,
		expected: z.infer<typeof readBindingSchema>,
		signal?: AbortSignal,
	): Promise<z.infer<typeof readBindingSchema> & { data: unknown }> {
		try {
			const operation = privateReadOperation.parse(action);
			const normalized = privateReadInputs[operation].parse(input);
			const binding = readBindingSchema.parse(expected);
			const bytes = Buffer.from(canonical(normalized));
			if (bytes.length > 65536) unavailable();
			async function* body() {
				yield bytes;
			}
			const result = readBindingSchema
				.extend({ data: privateReadData[operation] })
				.parse(
					await this.send(
						`/v1/read/${operation}`,
						{ "content-type": "application/json" },
						body,
						signal,
						256 * 1024,
					),
				);
			if (
				canonical(result.account) !== canonical(binding.account) ||
				canonical(result.upstream) !== canonical(binding.upstream) ||
				Buffer.byteLength(JSON.stringify(result.data)) > 196608 ||
				signal?.aborted
			)
				unavailable();
			if (operation === "get_feed_detail") {
				const detail = privateReadData.get_feed_detail.parse(result.data);
				const requested =
					privateReadInputs.get_feed_detail.parse(normalized).feed_id;
				if (
					detail.feed_id !== requested ||
					detail.data.note.noteId !== requested
				)
					unavailable();
			}
			return result;
		} catch {
			return unavailable();
		}
	}
	private async json(
		path: string,
		input: unknown,
		signal?: AbortSignal,
	): Promise<ProviderResult> {
		const bytes = Buffer.from(canonical(input));
		if (bytes.length > 8192) unavailable();
		async function* body() {
			yield bytes;
		}
		return statusSchema.parse(
			await this.send(
				path,
				{ "content-type": "application/json" },
				body,
				signal,
			),
		).state;
	}
	async commit(
		leaseId: string,
		signed: { permitJson: string; signature: string },
		signal?: AbortSignal,
	): Promise<ProviderResult> {
		try {
			const permit = dispatchPermitSchema.parse(
				parseStrictJson(signed.permitJson),
			);
			if (
				permit.leaseId !== leaseId ||
				!/^[a-f0-9]{64}$/.test(signed.signature)
			)
				unavailable();
			return await this.json(
				"/v1/commit",
				{ leaseId, permit, signature: signed.signature },
				signal,
			);
		} catch {
			return "unknown";
		} // One send attempt only; status is the recovery path.
	}
	async status(
		input: z.infer<typeof statusQuery>,
		signal?: AbortSignal,
	): Promise<ProviderResult> {
		try {
			return await this.json("/v1/status", statusQuery.parse(input), signal);
		} catch {
			return unavailable();
		}
	}
}
