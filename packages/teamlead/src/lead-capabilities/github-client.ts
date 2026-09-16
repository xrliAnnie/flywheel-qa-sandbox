import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { Octokit } from "@octokit/rest";

const unavailable = () => new Error("github_provider_unavailable");
const credentials = () => new Error("github_credentials_unavailable");
/** Lazy credentials do not couple later registry activation to a Bridge restart. */
export function createLazyLeadGithubClient(
	env: NodeJS.ProcessEnv,
	fetchImpl?: typeof fetch,
) {
	const frozen = Object.freeze({ ...env });
	let session:
		| { client: Octokit; secrets: readonly string[]; close(): Promise<void> }
		| undefined;
	let closed = false;
	return {
		get: (): { client: Octokit; secrets: readonly string[] } => {
			if (closed) throw unavailable();
			if (!session) {
				const token = resolveLeadGithubToken(frozen);
				session = {
					...createLeadGithubClient({ token, fetchImpl }),
					secrets: Object.freeze([token]),
				};
			}
			return session;
		},
		close: async () => {
			closed = true;
			await session?.close();
		},
	};
}
/** Parent-only existing gh credential source; no model command or hostname is accepted. */
export function resolveLeadGithubToken(env: NodeJS.ProcessEnv): string {
	try {
		let token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
		if (token === undefined) {
			const home = env.HOME ?? homedir(),
				config = env.GH_CONFIG_DIR;
			if (!isAbsolute(home) || (config !== undefined && !isAbsolute(config)))
				throw credentials();
			token = execFileSync(
				"/opt/homebrew/bin/gh",
				["auth", "token", "--hostname", "github.com"],
				{
					encoding: "utf8",
					timeout: 15000,
					maxBuffer: 8192,
					stdio: ["ignore", "pipe", "pipe"],
					env: {
						HOME: home,
						PATH: "/usr/bin:/bin",
						LANG: "en_US.UTF-8",
						GH_PROMPT_DISABLED: "1",
						...(config ? { GH_CONFIG_DIR: config } : {}),
					},
				},
			).replace(/\r?\n$/, "");
		}
		if (
			!token ||
			token.length > 8192 ||
			/\s/.test(token) ||
			[...token].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
		)
			throw credentials();
		return token;
	} catch {
		throw credentials();
	}
}
/** Actual parent SDK with no retry plugin, fixed authenticated origin and bounded request lifecycle. */
export function createLeadGithubClient(options: {
	token: string;
	fetchImpl?: typeof fetch;
}): { client: Octokit; close(): Promise<void> } {
	const token = resolveLeadGithubToken({ GH_TOKEN: options.token }),
		fetchImpl = options.fetchImpl ?? fetch;
	const lifetime = new AbortController(),
		active = new Set<Promise<Response>>();
	let closed = false;
	const boundedFetch: typeof fetch = async (input, init) => {
		if (closed) throw unavailable();
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== "https://api.github.com" || url.username || url.password)
			throw unavailable();
		const perform = async () => {
			const timeout = new AbortController(),
				signal = AbortSignal.any([
					lifetime.signal,
					timeout.signal,
					...(init?.signal ? [init.signal] : []),
				]);
			const timer = setTimeout(() => timeout.abort(), 15000);
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
				response: Response | undefined;
			let rejectAbort!: (error: Error) => void;
			const aborted = new Promise<never>((_, reject) => {
				rejectAbort = reject;
			});
			const abort = () => {
				rejectAbort(unavailable());
				void reader?.cancel().catch(() => {});
			};
			signal.addEventListener("abort", abort, { once: true });
			try {
				signal.throwIfAborted();
				const fetched = fetchImpl(input, {
					...init,
					redirect: "manual",
					signal,
				});
				void fetched.then(
					(r) => {
						if (signal.aborted) void r.body?.cancel().catch(() => {});
					},
					() => {},
				);
				response = await Promise.race([fetched, aborted]);
				signal.throwIfAborted();
				const length = response.headers.get("content-length");
				if (
					length !== null &&
					(!/^\d+$/.test(length) || Number(length) > 4194304)
				)
					throw unavailable();
				if (
					response.status >= 300 &&
					response.status < 400 &&
					!(
						response.status === 302 &&
						/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/[1-9][0-9]*\/logs$/.test(
							url.pathname,
						)
					)
				)
					throw unavailable();
				const chunks: Uint8Array[] = [];
				let size = 0;
				if (response.body) {
					reader = response.body.getReader();
					for (;;) {
						const item = await Promise.race([reader.read(), aborted]);
						signal.throwIfAborted();
						if (item.done) break;
						size += item.value.byteLength;
						if (size > 4194304) throw unavailable();
						chunks.push(item.value);
					}
				}
				signal.throwIfAborted();
				if (closed) throw unavailable();
				return new Response(
					response.body === null ? null : Buffer.concat(chunks),
					{
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					},
				);
			} catch {
				try {
					await (reader ? reader.cancel() : response?.body?.cancel());
				} catch {}
				throw unavailable();
			} finally {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
			}
		};
		const task = perform();
		active.add(task);
		try {
			return await task;
		} finally {
			active.delete(task);
		}
	};
	const client = new Octokit({
		auth: token,
		baseUrl: "https://api.github.com",
		request: { fetch: boundedFetch },
		log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
	});
	return {
		client,
		close: async () => {
			closed = true;
			lifetime.abort();
			await Promise.allSettled([...active]);
		},
	};
}
