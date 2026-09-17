import { createHash } from "node:crypto";
import { once } from "node:events";
import { Agent, request } from "node:http";
import { createConnection, type Socket } from "node:net";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { parseStrictJson } from "./canonical.js";
import { artifactSchema } from "./contracts.js";
import {
	loginProjectionSchema,
	loginReadOperation,
	loginStatusSchema,
} from "./login-contract.js";
import { createNativePeerReader } from "./native-peer.js";
import {
	notificationInputs,
	notificationResponses,
} from "./notification-contract.js";
import {
	publicReadInputs,
	publicReadOperation,
} from "./provider-read-contract.js";

const uploadSchema = z
	.object({
		data: z
			.instanceof(Buffer)
			.refine((data) => data.length > 0 && data.length <= 10 * 1024 * 1024),
		mimeType: artifactSchema.shape.mimeType,
	})
	.strict();
const actionSchema = z.enum([
	"import_artifact",
	"notifications",
	"notification_ack",
	"prepare",
	"execute",
	"status",
	"cancel",
	...publicReadOperation.options,
	...loginReadOperation.options,
]);
const scopeSchema = z
	.object({
		projectId: z.string().min(1).max(256),
		leadId: z.string().min(1).max(256),
		activationId: z.string().min(1).max(256),
	})
	.strict();
const state = z.enum([
	"preparing",
	"awaiting_delivery",
	"awaiting_approval",
	"approved",
	"rejected",
	"revoked",
	"expired",
	"superseded",
	"consumed",
]);
const attempt = z
	.object({
		attemptId: z.string().uuid(),
		state: z.enum([
			"claimed",
			"dispatch-admitted",
			"dispatched",
			"succeeded",
			"succeeded-noop",
			"failed",
			"unknown",
		]),
	})
	.strict();
const proposal = {
	proposalId: z.string().uuid(),
	contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
	state,
	expiresAt: z.number().int().nonnegative(),
};
const snowflake = z.string().regex(/^[1-9][0-9]{16,19}$/);
const readResponse = z
	.object({
		text: z
			.string()
			.max(196608)
			.refine((value) => Buffer.byteLength(value) <= 196608),
	})
	.strict();
export const authorityResponseSchemas = {
	...notificationResponses,
	import_artifact: artifactSchema,
	check_login_status: loginStatusSchema,
	get_login_qrcode: loginProjectionSchema,
	list_feeds: readResponse,
	get_feed_detail: readResponse,
	search_feeds: readResponse,
	list_saved_content: readResponse,
	list_collections: readResponse,
	get_collection_content: readResponse,
	prepare: z
		.object({
			...proposal,
			cardRef: z
				.object({
					guildId: snowflake,
					channelId: snowflake,
					messageId: snowflake,
				})
				.strict()
				.nullable(),
		})
		.strict(),
	execute: z.union([
		attempt.extend({ kind: z.literal("attempt") }).strict(),
		z
			.object({
				kind: z.literal("denied"),
				code: z.enum([
					"founder_receipt_invalid",
					"founder_content_digest_mismatch",
					"founder_receipt_revoked",
					"founder_receipt_expired",
					"write_gate_closed",
					"write_scope_changed",
					"private_provider_unavailable",
					"write_executor_unavailable",
				]),
			})
			.strict(),
	]),
	status: z.object({ ...proposal, attempt: attempt.nullable() }).strict(),
	cancel: z
		.object({ state: z.union([state, z.enum(["already_started", "denied"])]) })
		.strict(),
};
/** Parent-only transport. Startup must verify root-owned socket/helper policy.
 * assertCurrent is the 2519 parent carrier check, never model-supplied approval.
 * Errors after dispatch are uncertain: callers must query status, never retry writes. */
export class XhsAuthorityClient {
	private readonly scope: z.infer<typeof scopeSchema>;
	private readonly peer: ReturnType<typeof createNativePeerReader>;
	private readonly socketPath: string;
	private readonly uid: number;
	private readonly current: () => void | Promise<void>;
	constructor(options: {
		socketPath: string;
		authorityUid: number;
		peerHelper: { path: string; sha256: string };
		scope: z.infer<typeof scopeSchema>;
		assertCurrent: () => void | Promise<void>;
	}) {
		if (
			!isAbsolute(options.socketPath) ||
			normalize(options.socketPath) !== options.socketPath ||
			options.socketPath.includes("\0") ||
			!Number.isSafeInteger(options.authorityUid) ||
			options.authorityUid < 0
		)
			throw Error("authority_request_unavailable");
		this.scope = scopeSchema.parse(structuredClone(options.scope));
		this.socketPath = options.socketPath;
		this.uid = options.authorityUid;
		this.peer = createNativePeerReader(options.peerHelper);
		this.current = options.assertCurrent;
	}
	async importArtifact(input: unknown, signal?: AbortSignal) {
		return artifactSchema.parse(
			await this.call("import_artifact", input, signal),
		);
	}
	async call(
		action: z.infer<typeof actionSchema>,
		input: unknown,
		signal?: AbortSignal,
	) {
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		const timer = setTimeout(abort, 180000);
		let socket: Socket | undefined, agent: Agent | undefined;
		const check = () => {
			if (controller.signal.aborted) throw Error();
		};
		try {
			const operation = actionSchema.parse(action);
			const parsedUpload =
				operation === "import_artifact" ? uploadSchema.parse(input) : null;
			const upload = parsedUpload
				? {
						data: Buffer.from(parsedUpload.data),
						mimeType: parsedUpload.mimeType,
					}
				: null;
			const metadata = upload
				? {
						...this.scope,
						mimeType: upload.mimeType,
						sizeBytes: upload.data.length,
						sha256: createHash("sha256").update(upload.data).digest("hex"),
					}
				: null;
			const uploadHeader = metadata
				? Buffer.from(JSON.stringify(metadata)).toString("base64")
				: null;
			if (uploadHeader && uploadHeader.length > 4096) throw Error();
			const read = publicReadOperation.safeParse(operation);
			const login = loginReadOperation.safeParse(operation);
			const notification =
				operation === "notifications" || operation === "notification_ack";
			const normalized = notification
				? notificationInputs[operation].parse(input)
				: login.success
					? z.object({}).strict().parse(input)
					: read.success
						? publicReadInputs[read.data].parse(input)
						: input;
			const responseSchema =
				operation === "status" &&
				z
					.object({
						prepareRequestId: z.string().min(1).max(256),
					})
					.strict()
					.safeParse(input).success
					? authorityResponseSchemas.prepare
					: authorityResponseSchemas[operation];
			await this.current();
			check();
			const body = upload
				? upload.data
				: JSON.stringify({ ...this.scope, input: normalized });
			if (!upload && Buffer.byteLength(body) > 256 * 1024) throw Error();
			socket = createConnection({ path: this.socketPath });
			socket.on("error", () => {});
			controller.signal.addEventListener("abort", () => socket?.destroy(), {
				once: true,
			});
			await once(socket, "connect", { signal: controller.signal });
			if ((await this.peer(socket, controller.signal)) !== this.uid)
				throw Error();
			await this.current();
			check();
			if (socket.destroyed) throw Error();
			agent = new Agent({ keepAlive: false, maxSockets: 1 });
			const verified = socket;
			agent.createConnection = () => verified;
			const result = await new Promise<unknown>((resolve, reject) => {
				const req = request(
					{
						host: "localhost",
						path: upload
							? "/v1/artifact/import"
							: notification
								? operation === "notifications"
									? "/v1/notification/list"
									: "/v1/notification/ack"
								: read.success || login.success
									? `/v1/read/${operation}`
									: `/v1/write/${operation}`,
						method: "POST",
						agent,
						signal: controller.signal,
						headers: {
							"content-type": upload
								? "application/octet-stream"
								: "application/json",
							...(uploadHeader ? { "x-flywheel-artifact": uploadHeader } : {}),
							"content-length": Buffer.byteLength(body),
							connection: "close",
						},
					},
					async (res) => {
						try {
							if (res.statusCode !== 200) throw Error();
							let size = 0;
							const chunks: Buffer[] = [];
							for await (const chunk of res) {
								const bytes = Buffer.from(chunk);
								size += bytes.length;
								if (
									size >
									(upload
										? 1024
										: login.success
											? 540000
											: read.success
												? 256 * 1024
												: 65536)
								)
									throw Error();
								chunks.push(bytes);
							}
							resolve(
								parseStrictJson(
									new TextDecoder("utf-8", { fatal: true }).decode(
										Buffer.concat(chunks),
									),
								),
							);
						} catch {
							reject(Error("authority_request_unavailable"));
						}
					},
				);
				req.once("error", reject);
				req.end(body);
			});
			await this.current();
			check();
			const projected = responseSchema.parse(result);
			if (metadata) {
				const artifact = artifactSchema.parse(projected);
				if (
					artifact.sha256 !== metadata.sha256 ||
					artifact.mimeType !== metadata.mimeType ||
					artifact.sizeBytes !== metadata.sizeBytes
				)
					throw Error();
				return artifact;
			}
			if (operation === "get_login_qrcode") {
				const qr = loginProjectionSchema.parse(projected);
				if (
					!qr.loggedIn &&
					(qr.expiresAt <= Date.now() || qr.expiresAt > Date.now() + 240000)
				)
					throw Error();
				return qr;
			}
			return projected;
		} catch {
			throw Error("authority_request_unavailable");
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			agent?.destroy();
			socket?.destroy();
		}
	}
}
