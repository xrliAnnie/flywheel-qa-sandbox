import { BoundedStdioTransport } from "./bounded-stdio-transport.js";
import type { pinGbrainHost } from "./gbrain-host.js";

type Pin = Pick<ReturnType<typeof pinGbrainHost>, "launch" | "assertCurrent">;
/** Same pinned host process as Claude, owned by this parent session. */
export class GbrainStdioTransport extends BoundedStdioTransport {
	private readonly diagnostic: {
		migrationsApplied: number;
		stdoutBytes: number;
		stderrBytes: number;
		errorKinds: string[];
	};
	constructor(private readonly pin: Pin) {
		const diagnostic = {
				migrationsApplied: 0,
				stdoutBytes: 0,
				stderrBytes: 0,
				errorKinds: [] as string[],
			},
			tails = { stdout: "", stderr: "" };
		super(pin.launch, {
			errorCode: "gbrain_session_lost",
			observe: (stream, chunk) => {
				diagnostic[stream === "stdout" ? "stdoutBytes" : "stderrBytes"] +=
					chunk.length;
				// Match across chunk boundaries; retain only a bounded suffix and public count.
				const text = tails[stream] + chunk.toString("utf8");
				for (const [name, pattern] of Object.entries({
					connection_refused: /ECONNREFUSED/,
					timeout: /ETIMEDOUT|CONNECT_TIMEOUT/,
					dns: /ENOTFOUND|EAI_AGAIN/,
					permission: /EACCES|EPERM|Operation not permitted/,
					module_missing: /Cannot find (?:module|package)/,
					config_invalid: /Failed to parse|Invalid TOML/,
					authentication: /password authentication failed|28P01/,
					tls: /CERT_|certificate verify/,
				}))
					if (pattern.test(text) && !diagnostic.errorKinds.includes(name))
						diagnostic.errorKinds.push(name);
				const matches = [...text.matchAll(/Migration [0-9]+ applied/g)];
				diagnostic.migrationsApplied += matches.length;
				const last = matches.at(-1);
				tails[stream] = text
					.slice(last ? last.index! + last[0].length : 0)
					.slice(-64);
			},
		});
		this.diagnostic = diagnostic;
	}
	get evidence() {
		return { ...this.diagnostic, errorKinds: [...this.diagnostic.errorKinds] };
	}
	override async start() {
		this.pin.assertCurrent();
		await super.start();
	}
}
