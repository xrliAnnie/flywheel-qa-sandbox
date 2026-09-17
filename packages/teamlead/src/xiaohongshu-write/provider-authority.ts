import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { canonical, parseStrictJson } from "./canonical.js";
import type { FrozenWrite } from "./contracts.js";
import { createNativePeerReader } from "./native-peer.js";
import { dispatchPermitSchema } from "./permit.js";
import type { WriteIdentity, XhsWriteStore } from "./store.js";

export type ProviderDispatchScope = {
	identity: WriteIdentity;
	activationId: string;
	keyId: string;
};
type Options = {
	store: XhsWriteStore;
	providerUid: number;
	peerHelper: { path: string; sha256: string };
	scope: (
		proposalId: string,
		signal: AbortSignal,
	) => Promise<ProviderDispatchScope | null>;
	token: (
		context: { frozen: FrozenWrite; activationId: string },
		signal: AbortSignal,
	) => Promise<string | null>;
	now?: () => number;
};
const tokenRequest = z
	.object({
		permit: dispatchPermitSchema,
		account: z.unknown(),
		target: z.unknown(),
	})
	.strict();
/** Mount only on the authority private Unix listener. Policy/activation and
 * resource resolvers are trusted lifecycle adapters, never request parameters. */
export function createProviderAuthorityHandler(options: Options) {
	const providerUid = options.providerUid;
	const readPeer = createNativePeerReader(options.peerHelper),
		now = options.now ?? Date.now;
	return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort();
			req.destroy();
		}, 5000);
		const abort = () => controller.abort();
		req.once("aborted", abort);
		res.once("close", abort);
		const reply = (status: number, body: unknown) => {
			res.writeHead(status, {
				"content-type": "application/json",
				"cache-control": "no-store",
			});
			res.end(JSON.stringify(body));
		};
		const check = () => {
			if (controller.signal.aborted || req.socket.destroyed) throw Error();
		};
		try {
			if ((await readPeer(req.socket, controller.signal)) !== providerUid)
				throw Error();
			check();
			if (
				req.method !== "POST" ||
				![
					"/internal/v1/provider-admission",
					"/internal/v1/provider-token",
				].includes(req.url ?? "")
			)
				throw Error();
			let size = 0;
			const chunks: Buffer[] = [];
			for await (const chunk of req) {
				const data = Buffer.from(chunk);
				size += data.length;
				if (size > 8192) throw Error();
				chunks.push(data);
			}
			const input = parseStrictJson(Buffer.concat(chunks).toString("utf8"));
			const request =
				req.url === "/internal/v1/provider-token"
					? tokenRequest.parse(input)
					: null;
			const permit = dispatchPermitSchema.parse(
				request ? request.permit : input,
			);
			const scope = structuredClone(
				await options.scope(permit.proposalId, controller.signal),
			);
			check();
			if (!scope) throw Error();
			const permitDigest = createHash("sha256")
				.update(canonical(permit))
				.digest("hex");
			if (!request) {
				if (
					!options.store.admitDispatch(
						permit,
						scope.identity,
						scope.activationId,
						scope.keyId,
						now,
					)
				)
					throw Error();
				reply(200, { admitted: true, permitDigest });
				return;
			}
			const frozen = options.store.dispatchContext(
				permit,
				scope.identity,
				scope.activationId,
				scope.keyId,
				now,
			);
			if (
				!frozen ||
				!frozen.target ||
				canonical(request.account) !== canonical(frozen.account) ||
				canonical(request.target) !== canonical(frozen.target)
			)
				throw Error();
			const token = await options.token(
				{ frozen: structuredClone(frozen), activationId: scope.activationId },
				controller.signal,
			);
			check();
			const current = await options.scope(permit.proposalId, controller.signal);
			check();
			if (
				!current ||
				canonical(current) !== canonical(scope) ||
				!options.store.dispatchContext(
					permit,
					current.identity,
					current.activationId,
					current.keyId,
					now,
				) ||
				typeof token !== "string" ||
				token.length === 0 ||
				Buffer.byteLength(token) > 4096 ||
				/[\0\r\n]/.test(token)
			)
				throw Error();
			reply(200, {
				permitDigest,
				account: frozen.account,
				target: frozen.target,
				token,
			});
		} catch {
			if (!res.headersSent && !res.destroyed)
				reply(403, { code: "private_provider_denied" });
		} finally {
			clearTimeout(timer);
			req.off("aborted", abort);
			res.off("close", abort);
		}
	};
}
