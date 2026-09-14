// Separate process for durable SIGKILL boundaries; all paths are temp fixtures.
import fs from "node:fs";
import path from "node:path";
import { applyVersion, settleInflight } from "../../lib/apply.mjs";
import { runInstallVersion } from "../../lib/install-version.mjs";
import { readLedger } from "../../lib/ledger.mjs";
import { mutatorPreflight } from "../../lib/preflight.mjs";

const [rawCfg, mode, point, failure = "target"] = process.argv.slice(2);
const cfg = JSON.parse(rawCfg);
const target = path.join(cfg.versionsDir, "1.2.4", "node_modules/payload");
const old = path.join(cfg.versionsDir, "1.2.3", "node_modules/payload");
const kill = () => process.kill(process.pid, "SIGKILL");
let writes = 0;
const options = {
	now: () => "2026-09-13T04:00:00.000Z",
	checkpoint(name) {
		if (name === point) kill();
	},
	exec(command, args) {
		if (command === "npm") {
			fs.cpSync(path.join(cfg.stateDir, "template"), target, {
				recursive: true,
			});
			return;
		}
		if (!args[0].endsWith("restart-packaged-services.sh")) return;
		const version = args[0].startsWith(target) ? "target" : "old";
		fs.appendFileSync(path.join(cfg.stateDir, "restarts.log"), `${version}\n`);
		if (version === "target" && point === "restart_failed") kill();
		if ((version === "target" && failure !== "none") || failure === "both")
			throw new Error("unhealthy");
	},
	fsImpl: {
		...fs,
		renameSync(...args) {
			writes++;
			if ((failure === "receipt" || failure === "both") && writes === 3)
				throw new Error("receipt disk failure");
			fs.renameSync(...args);
		},
		rmSync(file, opts) {
			if (
				point === "partial_cleanup" &&
				file === path.join(cfg.versionsDir, "1.2.4")
			) {
				fs.rmSync(path.join(target, "dist"), { recursive: true, force: true });
				kill();
			}
			fs.rmSync(file, opts);
		},
	},
};
if (mode === "apply") {
	const ctx = await mutatorPreflight(cfg);
	try {
		await applyVersion(cfg, ctx.ledger, {
			...options,
			ver: "1.2.4",
			fromVer: "1.2.3",
			fromPkgRoot: old,
			loadTarball: async () => "fixture.tgz",
		});
	} finally {
		ctx.lock.release();
	}
} else if (mode === "install") {
	await runInstallVersion(cfg, "1.2.4", {
		...options,
		io: { out() {}, err() {} },
		fetchImpl: async () =>
			new Response(
				JSON.stringify({
					latest: "1.2.4",
					versions: [{ ver: "1.2.4", sha256: "a".repeat(64) }],
				}),
			),
	});
} else {
	await settleInflight(cfg, readLedger(cfg).ledger, options);
}
