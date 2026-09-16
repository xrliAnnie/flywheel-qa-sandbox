import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	type BrowserEgressAddress,
	type BrowserEgressPolicy,
	resolveBrowserEgressTarget,
} from "./browser-egress.js";

export { BROWSER_TOOL_SCHEMAS } from "./browser-schemas.js";

import { BROWSER_TOOL_SCHEMAS } from "./browser-schemas.js";
export interface PreparedBrowserCall {
	name: string;
	arguments: Record<string, unknown>;
	artifact?: { handle: string; path: string; mimeType: string };
}
const denied = () => new Error("browser_tool_denied");
export class BrowserToolPolicy {
	private readonly artifactRoot: string;
	constructor(
		private readonly options: {
			artifactRoot: string;
			assertCurrent(): void;
			egress?: () => BrowserEgressPolicy;
			lookup?: (hostname: string) => Promise<BrowserEgressAddress[]>;
		},
	) {
		const root = options.artifactRoot,
			stat = lstatSync(root);
		if (
			!isAbsolute(root) ||
			realpathSync(root) !== root ||
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			(stat.mode & 0o077) !== 0 ||
			stat.uid !== process.getuid?.()
		)
			throw denied();
		this.artifactRoot = root;
	}
	async prepare(
		name: string,
		raw: unknown,
		signal?: AbortSignal,
	): Promise<PreparedBrowserCall> {
		try {
			this.options.assertCurrent();
			if (signal?.aborted) throw denied();
			const schema = Object.hasOwn(BROWSER_TOOL_SCHEMAS, name)
				? BROWSER_TOOL_SCHEMAS[name]
				: undefined;
			if (!schema) throw denied();
			const encoded = JSON.stringify(raw);
			if (!encoded || Buffer.byteLength(encoded) > 65536) throw denied();
			const args = schema.parse(raw);
			if (name === "navigate_page") {
				const type = args.type ?? "url";
				if (type === "url" ? !args.url : args.url !== undefined) throw denied();
			}
			if (
				name === "new_page" ||
				(name === "navigate_page" && args.url !== undefined)
			) {
				const target = await resolveBrowserEgressTarget(args.url as string, {
					policy: this.options.egress?.(),
					lookup: this.options.lookup,
					signal,
				});
				args.url = target.url;
			}
			this.options.assertCurrent();
			if (signal?.aborted) throw denied();
			if (name === "take_screenshot") {
				if (args.uid && args.fullPage) throw denied();
				const handle = randomUUID(),
					format = (args.format as string | undefined) ?? "png";
				const artifact = {
					handle,
					path: join(this.artifactRoot, `${handle}.${format}`),
					mimeType: `image/${format}`,
				};
				return {
					name,
					arguments: { ...args, filePath: artifact.path },
					artifact,
				};
			}
			return { name, arguments: args };
		} catch {
			throw denied();
		}
	}
}
