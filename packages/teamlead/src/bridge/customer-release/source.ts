import { createHash } from "node:crypto";
import {
	type BetaCandidate,
	deriveBetaCandidate,
	deriveVetoBinding,
	type Manifest,
	validateManifest,
} from "flywheel-release-contract";

function valid(value: unknown): asserts value {
	if (!value) throw new Error("customer release source evidence unavailable");
}
/** Selection is only for an unreserved cycle. The store freezes this identity
 * and subsequent reads verify it instead of selecting a newer beta. */
export function selectCustomerBeta(
	manifest: Manifest,
	deployedSha: string | null,
): BetaCandidate | null {
	valid(typeof deployedSha === "string" && /^[a-f0-9]{40}$/.test(deployedSha));
	let selected: BetaCandidate | null = null;
	for (const [version, entry] of Object.entries(manifest.versions)) {
		if (
			entry.channel !== "beta" ||
			entry.status !== "active" ||
			entry.sourceCommit !== deployedSha
		)
			continue;
		const candidate = deriveBetaCandidate(manifest, version);
		valid(Number.isSafeInteger(candidate.betaN));
		// One deployed tree has one base version. Conflicting lineage is unknown.
		valid(!selected || selected.baseVersion === candidate.baseVersion);
		if (!selected || candidate.betaN > selected.betaN) selected = candidate;
	}
	return selected;
}
interface Options {
	endpoint: string;
	decisionToken: string;
	payloadReadToken: string;
	fetch?: typeof fetch;
	now?: () => number;
}
export class CustomerReleaseSource {
	private readonly endpoint: string;
	private readonly fetcher: typeof fetch;
	private readonly now: () => number;
	constructor(private readonly options: Options) {
		const url = new URL(options.endpoint);
		valid(
			(url.protocol === "https:" ||
				(url.protocol === "http:" &&
					["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
				!url.username &&
				!url.password &&
				url.pathname === "/" &&
				!url.search &&
				!url.hash,
		);
		valid(
			options.decisionToken &&
				options.payloadReadToken &&
				!/[\r\n]/.test(options.decisionToken + options.payloadReadToken) &&
				options.decisionToken !== options.payloadReadToken,
		);
		this.endpoint = url.origin;
		this.fetcher = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
	}
	private async request(
		path: string,
		token: string,
		signal: AbortSignal | undefined,
		timeout: number,
	) {
		const response = await this.fetcher(this.endpoint + path, {
			method: "GET",
			redirect: "error",
			headers: { authorization: `Bearer ${token}` },
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
				: AbortSignal.timeout(timeout),
		});
		if (response.status !== 200 || response.redirected || !response.body) {
			await response.body?.cancel();
			throw new Error("customer release source read failed");
		}
		return response;
	}
	private async consume(
		response: Response,
		limit: number,
		onChunk: (chunk: Uint8Array) => void,
	) {
		const reader = response.body!.getReader();
		let total = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				total += chunk.value.byteLength;
				if (total > limit) {
					await reader.cancel();
					throw new Error("customer release source exceeds bound");
				}
				onChunk(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		return total;
	}
	async manifest(
		signal?: AbortSignal,
	): Promise<{ manifest: Manifest; etag: string; observedAt: number }> {
		const started = this.now();
		valid(Number.isSafeInteger(started) && started >= 0);
		const response = await this.request(
			"/admin/manifest",
			this.options.decisionToken,
			signal,
			15000,
		);
		const etag = response.headers.get("etag"),
			server = response.headers.get("x-fw-server-time");
		if (!etag || !/^"[\x21\x23-\x7e]{1,126}"$/.test(etag) || !server) {
			await response.body?.cancel();
			throw new Error("customer release manifest headers invalid");
		}
		const chunks: Uint8Array[] = [];
		await this.consume(response, 4 * 1024 * 1024, (chunk) =>
			chunks.push(chunk),
		);
		const now = this.now(),
			serverTime = Date.parse(server);
		valid(
			now >= started &&
				now - started <= 30000 &&
				Number.isFinite(serverTime) &&
				serverTime >= started - 5000 &&
				serverTime <= now + 5000,
		);
		const manifest = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
		);
		valid(validateManifest(manifest).length === 0);
		return { manifest: manifest as Manifest, etag, observedAt: started };
	}
	async prepared(
		manifest: Manifest,
		releaseId: string,
		candidate: BetaCandidate,
		signal?: AbortSignal,
	) {
		valid(validateManifest(manifest).length === 0);
		const binding = deriveVetoBinding(manifest, releaseId);
		valid(
			binding.betaVersion === candidate.betaVersion &&
				binding.sourceCommit === candidate.sourceCommit &&
				binding.betaPayloadSha256 === candidate.betaPayloadSha256 &&
				binding.releaseVersion === candidate.baseVersion,
		);
		const response = await this.request(
			`/admin/payload/${encodeURIComponent(binding.releaseVersion)}/${binding.releasePayloadSha256}`,
			this.options.payloadReadToken,
			signal,
			120000,
		);
		const length = response.headers.get("content-length");
		const expected =
			length === null
				? null
				: /^(0|[1-9]\d{0,10})$/.test(length)
					? Number(length)
					: NaN;
		if (
			expected !== null &&
			(!Number.isSafeInteger(expected) ||
				expected <= 0 ||
				expected > 2 * 1024 ** 3)
		) {
			await response.body?.cancel();
			throw new Error("customer release payload size invalid");
		}
		const hash = createHash("sha256");
		// Endpoint streams may omit Content-Length. The absolute streaming bound
		// and final SHA256 still prove the complete immutable object.
		const actual = await this.consume(
			response,
			expected ?? 2 * 1024 ** 3,
			(chunk) => {
				hash.update(chunk);
			},
		);
		const readbackSha256 = hash.digest("hex");
		valid(
			actual > 0 &&
				(expected === null || actual === expected) &&
				readbackSha256 === binding.releasePayloadSha256,
		);
		return { binding, readbackSha256 };
	}
}
