import { AsyncLocalStorage } from "node:async_hooks";
import { type LinearRequest, LinearSdk } from "@linear/sdk";
import { print } from "graphql";

const unavailable = () => new Error("linear_provider_unavailable");
/** Actual typed SDK with a parent-owned transport. No model URL, retries or global fetch replacement. */
export function createLeadLinearClient(options: {
	token: string;
	fetchImpl?: typeof fetch;
}) {
	const token = options.token;
	if (
		!token ||
		token.length > 8192 ||
		/\s/.test(token) ||
		[...token].some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		)
	)
		throw new Error("linear_credentials_unavailable");
	const fetchImpl = options.fetchImpl ?? fetch;
	const operation = new AsyncLocalStorage<AbortSignal>();
	const lifetime = new AbortController();
	const active = new Set<Promise<unknown>>();
	let closed = false;
	const request: LinearRequest = async (document, variables) => {
		const outer = operation.getStore();
		if (closed || !outer || outer.aborted) throw unavailable();
		const perform = async () => {
			const timeout = new AbortController();
			const signal = AbortSignal.any([outer, lifetime.signal, timeout.signal]);
			const timer = setTimeout(() => timeout.abort(), 15000);
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
			let response: Response | undefined;
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
				const body = JSON.stringify({ query: print(document), variables });
				if (Buffer.byteLength(body) > 1024 * 1024) throw unavailable();
				const fetched = fetchImpl("https://api.linear.app/graphql", {
					method: "POST",
					redirect: "manual",
					signal,
					headers: { authorization: token, "content-type": "application/json" },
					body,
				});
				void fetched.then(
					(result) => {
						if (signal.aborted) void result.body?.cancel().catch(() => {});
					},
					() => {},
				);
				response = await Promise.race([fetched, aborted]);
				signal.throwIfAborted();
				if (!response.ok) throw unavailable();
				const length = response.headers.get("content-length");
				if (
					length !== null &&
					(!/^\d+$/.test(length) || Number(length) > 4 * 1024 * 1024)
				)
					throw unavailable();
				reader = response.body?.getReader();
				const chunks: Uint8Array[] = [];
				let size = 0;
				if (reader)
					for (;;) {
						const item = await Promise.race([reader.read(), aborted]);
						signal.throwIfAborted();
						if (item.done) break;
						size += item.value.byteLength;
						if (size > 4 * 1024 * 1024) throw unavailable();
						chunks.push(item.value);
					}
				const result = JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(
						Buffer.concat(chunks),
					),
				);
				if (
					!result ||
					typeof result !== "object" ||
					result.errors ||
					!result.data ||
					typeof result.data !== "object" ||
					Array.isArray(result.data)
				)
					throw unavailable();
				signal.throwIfAborted();
				return result.data;
			} catch {
				// Cleanup must not let an uncooperative stream delay cancellation/shutdown.
				void (reader ? reader.cancel() : response?.body?.cancel())?.catch(
					() => {},
				);
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
	return {
		client: new LinearSdk(request),
		withSignal: async <T>(
			signal: AbortSignal,
			run: () => Promise<T>,
		): Promise<T> => {
			if (closed || signal.aborted) throw unavailable();
			return operation.run(signal, run);
		},
		close: async () => {
			closed = true;
			lifetime.abort();
			await Promise.allSettled([...active]);
		},
	};
}
