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

/** A NON-retryable (structural/config) error — distinguished from transient
 * (empty / refused / timeout) so the retry loop fails fast on a misconfig. */
function permanent(message: string): Error & { permanent: true } {
	return Object.assign(new Error(message), { permanent: true as const });
}

/**
 * ONE connect→read→parse attempt. Rejects on a dead socket / EMPTY payload /
 * malformed payload / timeout — NEVER resolves to an empty fallback (fail-closed:
 * a gateway without secrets must refuse to start its action surface).
 *
 * FLY-350 race fix: an EMPTY/whitespace read is rejected with an explicit
 * `EMPTY_PAYLOAD` error (NOT a raw `JSON.parse("")` → "Unexpected end of JSON
 * input" crash). codex 0.141 ephemerally re-spawns an MCP child per built_tools
 * call; a respawn that races the broker (connection accepted but the payload not
 * yet/ever delivered, e.g. during a transient unavailability) must surface a
 * clear, RETRYABLE error rather than crash the child opaquely.
 */
function fetchSecretsOnce(
	socketPath: string,
	timeoutMs: number,
): Promise<Record<string, string>> {
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
			const raw = chunks.join("");
			// FLY-350: explicit empty/whitespace guard BEFORE JSON.parse — never let
			// an empty read become an opaque "Unexpected end of JSON input" crash.
			if (raw.trim().length === 0) {
				reject(
					new Error(
						"fetchSecretsFromBroker: EMPTY_PAYLOAD (broker sent no data)",
					),
				);
				return;
			}
			try {
				const parsed: unknown = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					reject(permanent("fetchSecretsFromBroker: malformed payload"));
					return;
				}
				for (const v of Object.values(parsed as Record<string, unknown>)) {
					if (typeof v !== "string") {
						reject(
							permanent("fetchSecretsFromBroker: non-string secret value"),
						);
						return;
					}
				}
				resolve(parsed as Record<string, string>);
			} catch (err) {
				// A non-empty body that won't JSON.parse is a structural/config error
				// (LOW-5): permanent — retrying the same garbage is pointless + noisy.
				reject(permanent(`fetchSecretsFromBroker: ${(err as Error).message}`));
			}
		});
	});
}

/**
 * Gateway-side fetch: connect, read the single JSON payload, parse. Rejects on
 * a dead socket / EMPTY / malformed payload / timeout — NEVER resolves to an
 * empty fallback (fail-closed).
 *
 * FLY-350 race fix: RETRIES a transient failure (empty payload / connection
 * refused / timeout) with a short backoff. The broker is a single parent-runtime
 * listener serving EVERY ephemeral MCP (re)spawn; a respawn can momentarily race
 * the listener (e.g. between accept and write under load, or a brief
 * unavailability). A bounded retry turns those transients into success instead of
 * a fatal child crash. A persistently-down broker still fails closed after the
 * attempts are exhausted (the error names the last cause).
 */
export async function fetchSecretsFromBroker(
	socketPath: string,
	opts: { timeoutMs?: number; retries?: number; retryDelayMs?: number } = {},
): Promise<Record<string, string>> {
	const timeoutMs = opts.timeoutMs ?? 5000;
	// Default 4 attempts (1 + 3 retries) over ~600ms — generous enough for a
	// respawn racing the listener, bounded so a truly-down broker fails fast.
	const retries = opts.retries ?? 3;
	const retryDelayMs = opts.retryDelayMs ?? 200;
	let lastErr: Error | undefined;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await fetchSecretsOnce(socketPath, timeoutMs);
		} catch (err) {
			lastErr = err as Error;
			// LOW-5: a permanent (malformed/non-string) error won't fix on retry —
			// fail fast rather than retry the same garbage N times.
			if ((err as { permanent?: boolean }).permanent) throw lastErr;
			if (attempt < retries) {
				await new Promise((r) => setTimeout(r, retryDelayMs));
			}
		}
	}
	throw new Error(
		`fetchSecretsFromBroker: failed after ${retries + 1} attempt(s): ${lastErr?.message ?? "unknown"}`,
	);
}
