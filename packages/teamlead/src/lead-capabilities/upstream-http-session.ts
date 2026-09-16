import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	assertUpstreamToolsPinned,
	type UpstreamToolBaseline,
} from "./upstream-baseline.js";

const denied = () => new Error("upstream_http_unavailable");
/** Trusted parent transport; only the two pinned HTTP upstream coordinates are supported. */
export async function openPinnedHttpMcpSession(options: {
	baseline: UpstreamToolBaseline;
	headers?: Record<string, string>;
	assertCurrent(): void;
	fetchImpl?: typeof fetch;
}) {
	const endpoint =
		options.baseline.serverId === "context7"
			? "https://mcp.context7.com/mcp"
			: options.baseline.serverId === "xiaohongshu-mcp"
				? "http://127.0.0.1:18060/mcp"
				: undefined;
	if (!endpoint) throw denied();
	const lifetime = new AbortController(),
		client = new Client(
			{ name: "flywheel-lead", version: "2" },
			{ capabilities: {} },
		);
	let closed = false,
		closing: Promise<void> | undefined;
	function current() {
		if (closed) throw denied();
		options.assertCurrent();
	}
	const active = new Set<Promise<void>>();
	const fetchImpl = options.fetchImpl ?? fetch;
	const boundedFetch: typeof fetch = async (input, init) => {
		current();
		const url = input instanceof Request ? input.url : String(input);
		if (url !== endpoint) throw denied();
		const budget = new AbortController(),
			signal = AbortSignal.any([
				lifetime.signal,
				budget.signal,
				...(init?.signal ? [init.signal] : []),
			]);
		const timer = setTimeout(() => budget.abort(), 15000);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let responseBody: ReadableStream<Uint8Array> | null = null;
		let received = false;
		let finish!: () => void;
		const settled = new Promise<void>((resolve) => {
			finish = resolve;
		});
		active.add(settled);
		const cancelBody = () =>
			(reader ? reader.cancel() : responseBody?.cancel())?.catch(() => {});
		const abort = () => {
			if (received) void Promise.resolve(cancelBody()).finally(cleanup);
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			active.delete(settled);
			finish();
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			const response = await fetchImpl(input, {
				...init,
				redirect: "error",
				signal,
			});
			responseBody = response.body;
			received = true;
			signal.throwIfAborted();
			current();
			const length = response.headers.get("content-length");
			if (
				(response.status >= 300 && response.status < 400) ||
				(length !== null && (!/^\d+$/.test(length) || Number(length) > 262144))
			) {
				await response.body?.cancel();
				throw denied();
			}
			if (!response.body) {
				cleanup();
				return response;
			}
			reader = response.body.getReader();
			let size = 0;
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						signal.throwIfAborted();
						current();
						const item = await reader!.read();
						signal.throwIfAborted();
						current();
						if (item.done) {
							cleanup();
							controller.close();
							return;
						}
						size += item.value.byteLength;
						if (size > 262144) throw denied();
						controller.enqueue(item.value);
					} catch (error) {
						await cancelBody();
						cleanup();
						controller.error(error);
					}
				},
				async cancel() {
					await cancelBody();
					cleanup();
				},
			});
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} catch (error) {
			await cancelBody();
			cleanup();
			throw error;
		}
	};
	const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
		fetch: boundedFetch,
		requestInit: {
			redirect: "error",
			headers: options.headers ?? {},
		},
	});
	const close = () => {
		if (closing) return closing;
		closed = true;
		lifetime.abort();
		closing = (async () => {
			try {
				await client.close();
			} finally {
				try {
					await transport.close();
				} finally {
					await Promise.allSettled([...active]);
				}
			}
		})();
		return closing;
	};
	try {
		current();
		await client.connect(transport, { timeout: 15000 });
		current();
		const tools = await client.listTools(undefined, {
			signal: lifetime.signal,
			timeout: 15000,
		});
		current();
		if (tools.nextCursor) throw new Error("baseline_drift");
		const pin = assertUpstreamToolsPinned(options.baseline, {
			serverId: options.baseline.serverId,
			version: client.getServerVersion()?.version ?? "",
			tools: tools.tools,
		});
		return { client, integration: pin.integration, current, close };
	} catch (error) {
		await close();
		throw error instanceof Error && error.message === "baseline_drift"
			? error
			: denied();
	}
}
