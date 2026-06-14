/**
 * FLY-245 Phase E — parent-runtime secret broker over a unix-domain socket +
 * action-secret env washing (plan §6, Codex R1#3).
 *
 * The security claims under test at the unit level:
 *   - action secrets never enter the app-server env (washed for EVERY Lead,
 *     read-only companions included);
 *   - secrets live only in the parent runtime's memory and travel ONLY over a
 *     connect()-gated unix socket (never a file, never argv);
 *   - the client fails CLOSED: dead socket, malformed payload, timeout — all
 *     reject, never "empty secrets".
 * (That the ww sandbox blocks the model's connect() to this socket is the §6
 * load-bearing assumption — verified on the real machine in Phase F QA.)
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fetchSecretsFromBroker,
	SecretBroker,
	washActionSecretEnv,
} from "../secret-broker.js";

describe("washActionSecretEnv (E)", () => {
	it("strips every key containing TOKEN / SECRET / KEY (case-insensitive)", () => {
		const washed = washActionSecretEnv({
			DISCORD_BOT_TOKEN: "t1",
			FLYWHEEL_API_TOKEN: "t2",
			GITHUB_TOKEN: "t3",
			MY_SECRET: "s1",
			Some_Api_Key: "k1",
			OPENAI_API_KEY: "k2",
			secret_thing: "s2",
		});
		expect(Object.keys(washed)).toHaveLength(0);
	});

	it("keeps non-secret runtime env (PATH/HOME/CODEX_HOME/FLYWHEEL ids)", () => {
		const washed = washActionSecretEnv({
			PATH: "/usr/bin",
			HOME: "/Users/x",
			CODEX_HOME: "/Users/x/.codex-lead",
			FLYWHEEL_LEAD_ID: "product-lead",
			FLYWHEEL_PROJECT_NAME: "geoforge3d",
			LANG: "en_US.UTF-8",
		});
		expect(washed).toEqual({
			PATH: "/usr/bin",
			HOME: "/Users/x",
			CODEX_HOME: "/Users/x/.codex-lead",
			FLYWHEEL_LEAD_ID: "product-lead",
			FLYWHEEL_PROJECT_NAME: "geoforge3d",
			LANG: "en_US.UTF-8",
		});
	});

	it("does not mutate the input env", () => {
		const input = { DISCORD_BOT_TOKEN: "t", PATH: "/usr/bin" };
		washActionSecretEnv(input);
		expect(input.DISCORD_BOT_TOKEN).toBe("t");
	});

	it("drops undefined values without crashing", () => {
		const washed = washActionSecretEnv({ FOO: undefined, BAR: "b" });
		expect(washed).toEqual({ BAR: "b" });
	});
});

describe("SecretBroker over unix socket (E)", () => {
	let dir: string;
	let broker: SecretBroker | undefined;

	const SECRETS = {
		DISCORD_BOT_TOKEN: "bot-token-xyz",
		FLYWHEEL_API_TOKEN: "api-token-abc",
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly245-broker-"));
	});

	afterEach(async () => {
		await broker?.close().catch(() => {});
		broker = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	it("gateway fetches the secrets over the socket (memory → socket → memory; no file)", async () => {
		const socketPath = join(dir, "broker.sock");
		broker = new SecretBroker({ socketPath, secrets: SECRETS });
		await broker.listen();
		const fetched = await fetchSecretsFromBroker(socketPath);
		expect(fetched).toEqual(SECRETS);
	});

	it("socket file is 0600 (same-user defense in depth; connect-gating is the real boundary)", async () => {
		const socketPath = join(dir, "broker.sock");
		broker = new SecretBroker({ socketPath, secrets: SECRETS });
		await broker.listen();
		const mode = statSync(socketPath).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("a stale socket file from a crashed previous run is replaced on listen", async () => {
		const socketPath = join(dir, "broker.sock");
		writeFileSync(socketPath, "stale");
		broker = new SecretBroker({ socketPath, secrets: SECRETS });
		await broker.listen();
		expect(await fetchSecretsFromBroker(socketPath)).toEqual(SECRETS);
	});

	it("serves multiple sequential fetches (gateway restart re-fetches)", async () => {
		const socketPath = join(dir, "broker.sock");
		broker = new SecretBroker({ socketPath, secrets: SECRETS });
		await broker.listen();
		expect(await fetchSecretsFromBroker(socketPath)).toEqual(SECRETS);
		expect(await fetchSecretsFromBroker(socketPath)).toEqual(SECRETS);
	});

	it("fetch from a non-existent socket rejects (fail-closed, never empty secrets)", async () => {
		await expect(
			fetchSecretsFromBroker(join(dir, "nope.sock"), { timeoutMs: 500 }),
		).rejects.toThrow();
	});

	it("fetch after broker close rejects", async () => {
		const socketPath = join(dir, "broker.sock");
		broker = new SecretBroker({ socketPath, secrets: SECRETS });
		await broker.listen();
		await broker.close();
		await expect(
			fetchSecretsFromBroker(socketPath, { timeoutMs: 500 }),
		).rejects.toThrow();
	});

	it("malformed broker payload rejects (fail-closed)", async () => {
		const socketPath = join(dir, "garbage.sock");
		const server = createServer((conn) => {
			conn.end("not json at all");
		});
		await new Promise<void>((res) => server.listen(socketPath, res));
		try {
			await expect(
				fetchSecretsFromBroker(socketPath, { timeoutMs: 500 }),
			).rejects.toThrow();
		} finally {
			await new Promise<void>((res) => server.close(() => res()));
		}
	});

	it("a silent server times out and rejects (never hangs the gateway startup)", async () => {
		const socketPath = join(dir, "silent.sock");
		const server = createServer(() => {
			/* accept and say nothing */
		});
		await new Promise<void>((res) => server.listen(socketPath, res));
		try {
			await expect(
				fetchSecretsFromBroker(socketPath, { timeoutMs: 300 }),
			).rejects.toThrow(/timeout/i);
		} finally {
			await new Promise<void>((res) => server.close(() => res()));
		}
	});

	it("non-string secret values are refused at construction (fail-closed boundary)", () => {
		expect(
			() =>
				new SecretBroker({
					socketPath: join(dir, "x.sock"),
					secrets: { OK: "v", BAD: 42 as unknown as string },
				}),
		).toThrow();
	});
});
