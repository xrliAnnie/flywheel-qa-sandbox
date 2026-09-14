import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { emptyManifest } from "../../../packages/payload-endpoint/__tests__/harness.mjs";

const root = new URL("../../../", import.meta.url).pathname;
const execute = promisify(execFile);
const KEY = "customer-acceptance-fixture";
const t0 = "2026-09-01T00:00:00.000Z";
const days = (n) => new Date(Date.parse(t0) + n * 86400000).toISOString();
const packerSource = `#!/bin/bash
set -euo pipefail
repo=""; out=""
while [ "$#" -gt 0 ]; do case "$1" in --repo-root) repo="$2";shift 2;; --out) out="$2";shift 2;; *) shift;; esac; done
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -R "$repo/template/." "$stage/"
printf '{"name":"flywheel-onboard-payload","version":"%s","private":true}\\n' "$PO_RELEASE_VERSION" > "$stage/package.json"
printf '%s\\n' "$PO_RELEASE_VERSION" > "$stage/.flywheel-prebuilt"
mkdir -p "$out"
name="$(cd "$stage" && npm pack --pack-destination "$out" --ignore-scripts 2>/dev/null | tail -1)"
printf '%s/%s\\n' "$out" "$name"
`;

async function fixture(t) {
	const sandbox = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-e2e-")),
	);
	let server = null;
	let cleaned = false;
	const cleanup = async () => {
		if (cleaned) return;
		cleaned = true;
		if (server && server.exitCode === null && server.signalCode === null) {
			const stopped = new Promise((resolve) => server.once("close", resolve));
			server.kill();
			await stopped;
		}
		fs.rmSync(sandbox, { recursive: true, force: true });
	};
	t.after(cleanup);
	const repo = path.join(sandbox, "repo");
	const template = path.join(repo, "template");
	const env = {
		...process.env,
		npm_config_cache:
			process.env.npm_config_cache || path.join(sandbox, "npm-cache"),
	};
	// No inherited license or deployment settings may influence this isolated fixture.
	delete env.FLYWHEEL_LICENSE_KEY;
	delete env.FLYWHEEL_ALLOW_LICENSE_KEY_ENV;
	for (const dir of ["doc", "template/dist", "template/scripts/packaged"])
		fs.mkdirSync(path.join(repo, dir), { recursive: true });
	fs.writeFileSync(
		path.join(template, "dist/run-bridge.js"),
		"// fixture bridge\n",
	);
	fs.writeFileSync(
		path.join(template, "scripts/flywheel-onboard.sh"),
		"#!/bin/bash\nexit 0\n",
	);
	fs.writeFileSync(
		path.join(template, "scripts/packaged/create-compat-mirror.sh"),
		"#!/bin/bash\nexit 0\n",
	);
	fs.writeFileSync(
		path.join(template, "scripts/packaged/restart-packaged-services.sh"),
		`#!/bin/bash
set -eu
[ -z "\${FLYWHEEL_LICENSE_KEY:-}" ] || exit 90
ver="$(cat "$(dirname "$0")/../../.flywheel-prebuilt")"
printf '%s\\n' "$ver" >> "$FLYWHEEL_STATE_DIR/restarts.log"
[ ! -f "$FLYWHEEL_STATE_DIR/fail-$ver" ]
`,
	);
	const packer = path.join(sandbox, "packer.sh");
	fs.writeFileSync(packer, packerSource, { mode: 0o755 });
	const seed = path.join(sandbox, "seed.json");
	fs.writeFileSync(seed, JSON.stringify(emptyManifest()));
	const keylog = path.join(sandbox, "requests.log");
	server = spawn(
		process.execPath,
		[path.join(root, "packages/payload-endpoint/__tests__/serve.mjs")],
		{
			env: {
				...env,
				FW_TEST_BETA_TOKEN: "beta-fixture",
				FW_TEST_RELEASE_TOKEN: "release-fixture",
				FW_TEST_OPS_TOKEN: "ops-fixture",
				SERVE_SEED_MANIFEST: seed,
				SERVE_SEED_KEY: `${KEY}:customer`,
				STUB_KEYLOG: keylog,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let serverOutput = "";
	server.stdout.on("data", (b) => {
		serverOutput += b;
	});
	server.stderr.on("data", (b) => {
		serverOutput += b;
	});
	const port = await new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("fixture endpoint did not start")),
			10000,
		);
		server.stdout.on("data", () => {
			const match = /PORT (\d+)/.exec(serverOutput);
			if (match) {
				clearTimeout(timer);
				resolve(match[1]);
			}
		});
		server.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
	const endpoint = `http://127.0.0.1:${port}`;
	const baseEnv = {
		...env,
		FW_ENDPOINT: endpoint,
		FW_BETA_PUBLISH_TOKEN: "beta-fixture",
		FW_CUSTOMER_RELEASE_TOKEN: "release-fixture",
		FW_PACKER: packer,
	};
	const cmd = async (command, args, extra = {}) =>
		execute(command, args, {
			env: { ...baseEnv, ...extra },
			timeout: 60000,
			maxBuffer: 2 * 1024 * 1024,
		});
	const clock = async (iso) => {
		assert.equal(
			(
				await fetch(`${endpoint}/__test__/clock`, {
					method: "POST",
					body: JSON.stringify({ iso }),
				})
			).status,
			200,
		);
	};
	const manifest = async () => {
		const response = await fetch(`${endpoint}/admin/manifest`, {
			headers: { Authorization: "Bearer ops-fixture" },
		});
		assert.equal(response.status, 200);
		return response.json();
	};
	await clock(t0);
	await cmd("git", ["-C", repo, "init", "-q"]);
	const packed = await cmd("npm", [
		"pack",
		path.join(root, "packages/onboard-shell"),
		"--pack-destination",
		sandbox,
		"--ignore-scripts",
	]);
	const shellTar = path.join(sandbox, packed.stdout.trim().split("\n").at(-1));
	const shellPrefix = path.join(sandbox, "public-shell");
	await cmd("npm", [
		"install",
		"--prefix",
		shellPrefix,
		shellTar,
		"--no-audit",
		"--no-fund",
		"--ignore-scripts",
	]);
	const shellPkg = JSON.parse(
		fs.readFileSync(
			path.join(root, "packages/onboard-shell/package.json"),
			"utf8",
		),
	).name;
	const cli = path.join(
		shellPrefix,
		"node_modules",
		shellPkg,
		"bin/flywheel-onboard.js",
	);
	const customer = (name) => {
		const home = path.join(sandbox, name);
		const state = path.join(home, ".flywheel");
		fs.mkdirSync(state, { recursive: true });
		fs.writeFileSync(
			path.join(state, ".env"),
			`FLYWHEEL_LICENSE_KEY=${KEY}\n`,
			{ mode: 0o600 },
		);
		fs.writeFileSync(
			path.join(state, "auto-update.json"),
			JSON.stringify({
				schemaVersion: 1,
				checkEveryHours: 6,
				applyHour: new Date().getHours(),
				applyGraceHours: 2,
			}),
		);
		return { home, state };
	};
	const run = async (c, args, expected = 0) => {
		let result;
		try {
			result = {
				...(await cmd(process.execPath, [cli, ...args], {
					HOME: c.home,
					FLYWHEEL_STATE_DIR: c.state,
					FLYWHEEL_ONBOARD_ENDPOINT: endpoint,
				})),
				code: 0,
			};
		} catch (error) {
			result = { stdout: error.stdout, stderr: error.stderr, code: error.code };
		}
		assert.equal(result.code, expected, `${args.join(" ")}: ${result.stderr}`);
		assert.ok(!`${result.stdout}${result.stderr}`.includes(KEY));
		for (const file of ["update-ledger.json", "logs/auto-update.log"]) {
			const p = path.join(c.state, file);
			if (fs.existsSync(p))
				assert.ok(!fs.readFileSync(p, "utf8").includes(KEY));
		}
		return result;
	};
	const release = async (ver) => {
		fs.writeFileSync(path.join(repo, "doc/VERSION"), `v${ver}\n`);
		await cmd("git", ["-C", repo, "add", "-A"]);
		await cmd("git", [
			"-C",
			repo,
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"user.name=Fixture",
			"commit",
			"-qm",
			ver,
		]);
		await cmd(process.execPath, [
			path.join(root, "scripts/release/payload-release.mjs"),
			"--release-id",
			`beta-${ver}`,
			"--repo-root",
			repo,
		]);
		await cmd(process.execPath, [
			path.join(root, "scripts/release/payload-promote.mjs"),
			"prepare",
			"--release-id",
			`promote-${ver}`,
			"--beta",
			`${ver}-beta.1`,
			"--repo-root",
			repo,
		]);
		const sha = (await manifest()).releaseOps[`promote-${ver}`].sha256;
		await cmd(process.execPath, [
			path.join(root, "scripts/release/payload-promote.mjs"),
			"commit",
			"--release-id",
			`promote-${ver}`,
			"--expected-sha256",
			sha,
		]);
	};
	const withdraw = (ver, extra = [], ep = endpoint) =>
		cmd(
			process.execPath,
			[
				path.join(root, "scripts/release/payload-promote.mjs"),
				"withdraw",
				"--withdraw",
				ver,
				...extra,
			],
			{ FW_ENDPOINT: ep },
		);
	return {
		sandbox,
		repo,
		cmd,
		endpoint,
		clock,
		manifest,
		customer,
		run,
		release,
		withdraw,
		keylog,
		cleanup,
	};
}
const ledger = (c) =>
	JSON.parse(fs.readFileSync(path.join(c.state, "update-ledger.json"), "utf8"));
const current = (c) => {
	try {
		return fs
			.readFileSync(
				path.join(c.state, "runtime/current/.flywheel-prebuilt"),
				"utf8",
			)
			.trim();
	} catch {
		return null;
	}
};
const ticks = (c) => {
	try {
		return fs
			.readFileSync(path.join(c.state, "restarts.log"), "utf8")
			.trim()
			.split("\n");
	} catch {
		return [];
	}
};

// Six independent worlds keep central retention and customer history explicit.
test("E1 previous-good: withdraw auto restores locally without download and holds withdrawn version", async (t) => {
	const f = await fixture(t);
	try {
		await f.release("9.9.9");
		const c = f.customer("customer");
		await f.run(c, []);
		await f.release("9.9.10");
		await f.run(c, ["update", "--unattended"]);
		assert.equal(current(c), "9.9.10");
		await f.withdraw("9.9.10");
		fs.writeFileSync(f.keylog, "");
		// A withdrawn current bypasses the normal low-activity install window.
		fs.writeFileSync(
			path.join(c.state, "auto-update.json"),
			JSON.stringify({
				schemaVersion: 1,
				checkEveryHours: 6,
				applyHour: (new Date().getHours() + 6) % 24,
				applyGraceHours: 1,
			}),
		);
		await f.run(c, ["update", "--unattended"]);
		assert.equal(current(c), "9.9.9");
		assert.equal(ledger(c).holds["9.9.10"].reason, "withdrawn_observed");
		assert.ok(!fs.readFileSync(f.keylog, "utf8").includes("/payload/"));
		await f.run(c, ["update", "--unattended"]);
		assert.equal(current(c), "9.9.9");
		assert.equal((await f.manifest()).versions["9.9.10"].status, "quarantined");
	} finally {
		await f.cleanup();
	}
});

test("E2 expired previous-good: withdraw pauses, existing current stays, first installation fails cleanly", async (t) => {
	const f = await fixture(t);
	try {
		await f.release("9.9.9");
		const c = f.customer("customer");
		await f.run(c, []);
		await f.release("9.9.10");
		await f.run(c, ["update"]);
		await f.clock(days(31));
		const paused = await f.withdraw("9.9.10", ["--allow-pause"]);
		t.diagnostic(paused.stdout.trim());
		const central = await f.manifest();
		assert.equal(central.channels["customer-release"].latest, null);
		assert.equal(central.versions["9.9.9"].status, "expired");
		const count = ticks(c).length;
		await f.run(c, ["update", "--unattended"]);
		assert.equal(current(c), "9.9.10");
		assert.equal(ticks(c).length, count);
		assert.equal(ledger(c).lastRun.outcome, "paused");
		const fresh = f.customer("fresh");
		const result = await f.run(fresh, [], 1);
		assert.match(`${result.stdout}${result.stderr}`, /暂停/);
		assert.equal(current(fresh), null);
		assert.ok(
			!fs.existsSync(path.join(fresh.state, "runtime/versions")) ||
				fs.readdirSync(path.join(fresh.state, "runtime/versions")).length === 0,
		);
	} finally {
		await f.cleanup();
	}
});

test("E3 first release unhealthy: explicit degraded state, hold, no dangling current, central pause", async (t) => {
	const f = await fixture(t);
	try {
		await f.release("9.9.9");
		const c = f.customer("empty-runtime");
		fs.writeFileSync(path.join(c.state, "fail-9.9.9"), "");
		await f.run(c, ["update", "--unattended"], 1);
		assert.equal(current(c), null);
		assert.ok(!fs.existsSync(path.join(c.state, "runtime/current")));
		assert.equal(ledger(c).lastRun.outcome, "degraded");
		assert.equal(ledger(c).holds["9.9.9"].attempts, 1);
		await f.withdraw("9.9.9", ["--allow-pause"]);
		assert.equal(
			(await f.manifest()).channels["customer-release"].latest,
			null,
		);
	} finally {
		await f.cleanup();
	}
});

test("E4 update failure rolls back immediately, second allowed attempt fails, third is held", async (t) => {
	const f = await fixture(t);
	try {
		await f.release("9.9.9");
		const c = f.customer("customer");
		await f.run(c, []);
		await f.release("9.9.10");
		fs.writeFileSync(path.join(c.state, "fail-9.9.10"), "");
		await f.run(c, ["update", "--unattended"], 1);
		assert.equal(current(c), "9.9.9");
		assert.equal(ledger(c).lastRun.outcome, "rolled_back");
		assert.equal(ledger(c).holds["9.9.10"].attempts, 1);
		const state = ledger(c);
		state.holds["9.9.10"].at = new Date(Date.now() - 7200000).toISOString();
		fs.writeFileSync(
			path.join(c.state, "update-ledger.json"),
			JSON.stringify(state),
		);
		await f.run(c, ["update", "--unattended"], 1);
		assert.equal(ledger(c).holds["9.9.10"].attempts, 2);
		const count = ticks(c).length;
		await f.run(c, ["update", "--unattended"]);
		assert.equal(ledger(c).lastRun.outcome, "held");
		assert.equal(ticks(c).length, count);
		assert.equal(count, 4);
		assert.deepEqual(ticks(c), ["9.9.10", "9.9.9", "9.9.10", "9.9.9"]);
	} finally {
		await f.cleanup();
	}
});

test("E5 first successful update retains previous-good for local rollback and holds outgoing version", async (t) => {
	const f = await fixture(t);
	try {
		await f.release("9.9.9");
		const c = f.customer("customer");
		await f.run(c, []);
		await f.release("9.9.10");
		await f.run(c, ["update"]);
		assert.equal(current(c), "9.9.10");
		assert.equal(ledger(c).lastRun.outcome, "updated");
		const status = await f.run(c, ["auto-update", "status", "--json"]);
		t.diagnostic(status.stdout.trim());
		fs.writeFileSync(f.keylog, "");
		await f.run(c, ["rollback"]);
		assert.equal(current(c), "9.9.9");
		assert.equal(ledger(c).holds["9.9.10"].reason, "manual_rollback");
		assert.equal(fs.readFileSync(f.keylog, "utf8"), "");
	} finally {
		await f.cleanup();
	}
});

test("E6 withdraw crosses retention between GET and POST: retries against server time to deterministic pause", async (t) => {
	const f = await fixture(t);
	let proxy;
	try {
		await f.release("9.9.9");
		await f.release("9.9.10");
		await f.clock(days(27));
		let posts = 0;
		proxy = http.createServer(async (req, res) => {
			try {
				const chunks = [];
				for await (const b of req) chunks.push(b);
				if (
					req.method === "POST" &&
					req.url === "/admin/manifest" &&
					++posts === 1
				)
					await f.clock(days(31));
				const upstream = await fetch(`${f.endpoint}${req.url}`, {
					method: req.method,
					headers: {
						Authorization: req.headers.authorization,
						"Content-Type": "application/json",
					},
					body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
				});
				const headers = {};
				for (const name of ["content-type", "etag", "x-fw-server-time"])
					if (upstream.headers.has(name))
						headers[name] = upstream.headers.get(name);
				res.writeHead(upstream.status, headers);
				res.end(Buffer.from(await upstream.arrayBuffer()));
			} catch {
				res.writeHead(500);
				res.end();
			}
		});
		await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		await f.withdraw(
			"9.9.10",
			["--allow-pause"],
			`http://127.0.0.1:${proxy.address().port}`,
		);
		assert.equal(posts, 2);
		const central = await f.manifest();
		assert.equal(central.channels["customer-release"].latest, null);
		assert.equal(central.versions["9.9.9"].status, "expired");
		assert.equal(central.versions["9.9.10"].status, "quarantined");
	} finally {
		if (proxy) await new Promise((resolve) => proxy.close(resolve));
		await f.cleanup();
	}
});
