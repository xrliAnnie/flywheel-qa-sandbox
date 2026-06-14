/**
 * FLY-245 Phase E — parent-runtime secret broker over a unix-domain socket +
 * action-secret env washing (plan §6, Codex R1#3).
 *
 * Threat model (precise — §6/§12.B): the workspace-write sandbox limits WRITES,
 * not READS. The model's exec shell can `cat` any file the Unix user can read,
 * and inherits whatever env the app-server carries — so an action secret that
 * touches a file, the app-server env, or argv is burned. What the sandbox DOES
 * block (real-machine threat experiment: tmux/AF_UNIX `Operation not
 * permitted` under ww) is `connect()` on unix-domain sockets. The broker
 * design leans entirely on that edge:
 *
 *   - the PARENT runtime (`codex-lead-runtime`, outside any sandbox) holds the
 *     action secrets in memory and listens on a unix socket;
 *   - the GATEWAY (app-server MCP child, also outside the exec sandbox)
 *     connects at startup and receives the secrets — memory to memory;
 *   - the MODEL's exec shell cannot connect() to ANY unix socket → it can
 *     read the socket *file* but reading a socket file yields nothing; the
 *     secrets are never in the file system, env, or argv at all.
 *
 * Fail-closed discipline: the fetch client rejects on a dead socket, a
 * malformed payload, or a timeout — never resolves to "no secrets". The §6
 * load-bearing assumption (connect() blocked for THIS socket, not just tmux's)
 * is verified on the real machine in Phase F QA; if it falsifies, the fallback
 * is the parent spawning the gateway directly with an inherited-fd secret pass.
 *
 * NOTE: unix socket paths have a small OS limit (~104 bytes on macOS) — the
 * Phase F wiring keeps the socket directly in the per-Lead state dir.
 */

import { existsSync, unlinkSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";

/** Env keys matching this carry action secrets and never reach the app-server. */
export const ACTION_SECRET_ENV_PATTERN = /TOKEN|SECRET|KEY/i;

/**
 * Return a copy of `env` with every `*TOKEN*` / `*SECRET*` / `*KEY*` key (and
 * every undefined value) removed. Applied to the app-server spawn env for ALL
 * Leads — read-only companions included (R1#3: an action secret has no business
 * in a companion's context either).
 */
export function washActionSecretEnv(
	env: NodeJS.ProcessEnv,
): Record<string, string> {
	const washed: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) continue;
		if (ACTION_SECRET_ENV_PATTERN.test(k)) continue;
		washed[k] = v;
	}
	return washed;
}

export interface SecretBrokerOptions {
	socketPath: string;
	secrets: Readonly<Record<string, string>>;
}

export class SecretBroker {
	readonly socketPath: string;
	private readonly payload: string;
	private server: Server | undefined;

	constructor(opts: SecretBrokerOptions) {
		if (!opts.socketPath) {
			throw new Error("SecretBroker: socketPath is required");
		}
		for (const [k, v] of Object.entries(opts.secrets)) {
			if (typeof v !== "string") {
				throw new Error(
					`SecretBroker: secret "${k}" is not a string (fail-closed)`,
				);
			}
		}
		this.socketPath = opts.socketPath;
		// Serialized once, held in memory only — never written to disk.
		this.payload = `${JSON.stringify(opts.secrets)}\n`;
	}

	/** Start listening. Replaces a stale socket file from a crashed previous
	 * run; the socket is chmod 0600 (defense in depth — the real boundary is
	 * that the sandboxed model cannot connect() at all). */
	async listen(): Promise<void> {
		if (this.server) return;
		if (existsSync(this.socketPath)) {
			unlinkSync(this.socketPath);
		}
		const server = createServer((conn) => {
			// connect() IS the request — reply and close.
			conn.end(this.payload);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.socketPath, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		await chmod(this.socketPath, 0o600);
		this.server = server;
	}

	async close(): Promise<void> {
		const server = this.server;
		if (!server) return;
		this.server = undefined;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		try {
			if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
		} catch {
			// best-effort socket-file cleanup
		}
	}
}

/**
 * Gateway-side fetch: connect, read the single JSON payload, parse. Rejects on
 * a dead socket / malformed payload / timeout — NEVER resolves to an empty
 * fallback (fail-closed: a gateway without secrets must refuse to start its
 * action surface, not limp along).
 */
export async function fetchSecretsFromBroker(
	socketPath: string,
	opts: { timeoutMs?: number } = {},
): Promise<Record<string, string>> {
	const timeoutMs = opts.timeoutMs ?? 5000;
	return new Promise<Record<string, string>>((resolve, reject) => {
		const chunks: string[] = [];
		const conn = createConnection(socketPath);
		conn.setEncoding("utf8");
		const timer = setTimeout(() => {
			conn.destroy();
			reject(new Error(`fetchSecretsFromBroker: timeout after ${timeoutMs}ms`));
		}, timeoutMs);
		conn.on("data", (c: string) => {
			chunks.push(c);
		});
		conn.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		conn.on("end", () => {
			clearTimeout(timer);
			try {
				const parsed: unknown = JSON.parse(chunks.join(""));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					reject(new Error("fetchSecretsFromBroker: malformed payload"));
					return;
				}
				for (const v of Object.values(parsed as Record<string, unknown>)) {
					if (typeof v !== "string") {
						reject(
							new Error("fetchSecretsFromBroker: non-string secret value"),
						);
						return;
					}
				}
				resolve(parsed as Record<string, string>);
			} catch (err) {
				reject(err as Error);
			}
		});
	});
}
