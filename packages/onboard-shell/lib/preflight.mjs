import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { settleInflight } from "./apply.mjs";
import { stripKeyFromEnv } from "./key.mjs";
import { readLedger } from "./ledger.mjs";
import { acquireLock } from "./lock.mjs";

export class LedgerCorrupt extends Error {
	constructor() {
		super("update ledger corrupt");
		this.code = "ledger_corrupt";
	}
}

export async function mutatorPreflight(
	cfg,
	{ unattended = false, env = process.env, ...options } = {},
) {
	const lock = acquireLock(cfg);
	try {
		if (unattended && fs.existsSync(path.join(cfg.stateDir, "auto-update.off")))
			return { lock, ledger: null, disabled: true };
		const stored = readLedger(cfg);
		if (stored.state === "corrupt") throw new LedgerCorrupt();
		const exec = options.exec ?? execFileSync;
		const childEnv = stripKeyFromEnv({ ...env });
		const settlement = await settleInflight(cfg, stored.ledger, {
			...options,
			exec: (command, args, opts) =>
				exec(command, args, { ...opts, env: childEnv }),
		});
		if (stored.ledger.applying !== null)
			throw new Error("settlement could not be persisted");
		return { lock, ledger: stored.ledger, settlement, disabled: false };
	} catch (error) {
		lock.release();
		throw error;
	}
}
