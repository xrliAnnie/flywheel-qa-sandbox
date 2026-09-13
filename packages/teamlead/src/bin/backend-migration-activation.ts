import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import Database from "better-sqlite3";
import {
	type BackendMigrationPlan,
	observeMigrationArtifact,
	observeMigrationRegistry,
} from "flywheel-comm/lead-backend-migration-runtime";
import {
	processTupleStateWithStart,
	readCarrierRuntimeAssertion,
} from "flywheel-comm/lead-lease";
import { deriveLeadSocketPath } from "../lead-address.js";
import {
	MigrationCarrierAbsentError,
	observeMigrationCarrier,
} from "./backend-migration-process.js";

/** Window basic-start proof only, not Discord/tool/TUI visual acceptance. */
export async function observeMigrationActivation(input: {
	home: string;
	root: string;
	uid: number;
	identityDigest: string;
	oldCarrier: { pid: number; start: string };
	assertWindow(): void;
}): Promise<string> {
	const fail = (): never => {
		throw Error("migration activation identity unproven");
	};
	input.assertWindow();
	if (
		!isAbsolute(input.home) ||
		!isAbsolute(input.root) ||
		!/^[a-f0-9]{64}$/.test(input.identityDigest) ||
		!Number.isSafeInteger(input.oldCarrier.pid) ||
		input.oldCarrier.pid <= 0 ||
		!input.oldCarrier.start
	)
		return fail();
	const oldDead = () => {
		if (
			processTupleStateWithStart(
				input.oldCarrier.pid,
				input.oldCarrier.start,
			) !== "dead"
		)
			fail();
	};
	oldDead();
	const carrier = await observeMigrationCarrier(input.uid);
	const runtime = join(
		input.root,
		"packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js",
	);
	// Generic codex-lead.sh preserves scripts/../dist in argv; the dedicated
	// launchers use the canonical spelling. Keep exact argv matching for both,
	// rather than normalizing a ps command string that might contain extra args.
	const genericRuntime = `${join(input.root, "packages/teamlead/scripts")}/../dist/lead-backends/codex/codex-lead-tui-runtime.js`;
	if (
		!["node", process.execPath].some((node) =>
			[runtime, genericRuntime].some(
				(path) => carrier.command === `${node} ${path}`,
			),
		)
	)
		return fail();
	const leadKey = "flywheel-flywheel-product-lead";
	const env = {
		FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR: join(
			input.home,
			".flywheel/state/carrier-assertions",
		),
	};
	const assertion = readCarrierRuntimeAssertion(env, leadKey);
	if (
		!assertion ||
		assertion.identityDigest !== input.identityDigest ||
		assertion.pid !== carrier.pid ||
		assertion.lstart !== carrier.start
	)
		return fail();
	const dbPath = join(input.home, ".flywheel/lead-lease.db");
	const stat = lstatSync(dbPath);
	if (!stat.isFile() || stat.isSymbolicLink()) return fail();
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		const query = db.prepare(
			"SELECT lead_key, identity_digest, generation, holder_pid, holder_start, supervisor_pid, supervisor_start FROM lead_lease WHERE project = ? AND lead_id = ?",
		);
		const rows = query.all("flywheel", "flywheel-product-lead") as Record<
			string,
			unknown
		>[];
		const row = rows[0];
		if (rows.length > 1 || (row && row.lead_key !== leadKey)) return fail();
		for (const prefix of ["holder", "supervisor"]) {
			if (!row) break;
			const pid = row[`${prefix}_pid`],
				start = row[`${prefix}_start`];
			if (pid === null && start === null) continue;
			if (
				typeof pid !== "number" ||
				!Number.isSafeInteger(pid) ||
				pid <= 0 ||
				typeof start !== "string" ||
				!start
			)
				return fail();
			const state = processTupleStateWithStart(pid, start);
			if (state === "sensor_error") return fail();
			if (
				state === "alive" &&
				(pid !== carrier.pid ||
					start !== carrier.start ||
					row.identity_digest !== input.identityDigest)
			)
				return fail();
		}
		// Lease-off carriers may leave only dead historical tuples; never reinterpret
		// a live different tuple as stale merely because the new assertion exists.
		input.assertWindow();
		oldDead();
		if (
			JSON.stringify(await observeMigrationCarrier(input.uid)) !==
				JSON.stringify(carrier) ||
			JSON.stringify(readCarrierRuntimeAssertion(env, leadKey)) !==
				JSON.stringify(assertion) ||
			JSON.stringify(query.all("flywheel", "flywheel-product-lead")) !==
				JSON.stringify(rows)
		)
			return fail();
		input.assertWindow();
		return createHash("sha256")
			.update(JSON.stringify({ carrier, assertion, lease: row }))
			.digest("hex");
	} finally {
		db.close();
	}
}

/** Source basic-start proof used both before stop and for preflight-failure
 * recovery replay. A missing plist is not an original restored plist. */
export async function observeMigrationSource(input: {
	home: string;
	uid: number;
	identityDigest: string;
	plan: BackendMigrationPlan;
	target: { manifest: string; plist: string };
	assertWindow(): void;
	assertStopped(): void;
}): Promise<{
	carrier: Awaited<ReturnType<typeof observeMigrationCarrier>>;
	proofSha: string;
} | null> {
	input.assertWindow();
	if (!isAbsolute(input.home) || !/^[a-f0-9]{64}$/.test(input.identityDigest))
		throw Error("invalid migration source identity");
	const files = () => {
		const registry = observeMigrationRegistry(input.home, input.plan);
		if (registry.state !== "pre") return null;
		for (const kind of ["manifest", "plist"] as const) {
			const current = observeMigrationArtifact(
				input.home,
				input.plan.expected,
				kind,
				input.target[kind],
				input.assertStopped,
			);
			if (
				current.state !== "pre" ||
				current.proofSha !==
					input.plan.expected[kind === "manifest" ? "manifestSha" : "plistSha"]
			)
				return null;
		}
		return registry.proofSha;
	};
	if (!files()) return null;
	let carrier: Awaited<ReturnType<typeof observeMigrationCarrier>>;
	try {
		carrier = await observeMigrationCarrier(input.uid);
	} catch (error) {
		if (error instanceof MigrationCarrierAbsentError) return null;
		throw error;
	}
	// The wrapper execs the foreground tmux server, preserving launchd's PID.
	// Match its exact per-Lead socket/config arguments, never the pre-exec shell.
	const stateDir = join(input.home, ".flywheel");
	const socket = deriveLeadSocketPath(
		"flywheel/flywheel-product-lead",
		stateDir,
	);
	const config = join(
		stateDir,
		"run/leads/flywheel-flywheel-product-lead/tmux.conf",
	);
	const suffix = ` -D -S ${socket} -f ${config}`;
	const binary = carrier.command.endsWith(suffix)
		? carrier.command.slice(0, -suffix.length)
		: "";
	if (
		!isAbsolute(binary) ||
		basename(binary) !== "tmux" ||
		/[\s\0]/.test(binary)
	)
		throw Error("migration source carrier mismatch");
	const path = join(input.home, ".flywheel/lead-lease.db"),
		stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw Error("invalid migration source lease database");
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		const query = db.prepare(
			"SELECT lead_key, identity_digest, generation, holder_pid, holder_start, supervisor_pid, supervisor_start FROM lead_lease WHERE project = ? AND lead_id = ?",
		);
		const rows = query.all("flywheel", "flywheel-product-lead") as Record<
			string,
			unknown
		>[];
		if (rows.length > 1) throw Error("migration source lease conflict");
		for (const row of rows) {
			if (row.lead_key !== "flywheel-flywheel-product-lead")
				throw Error("migration source lease key conflict");
			for (const prefix of ["holder", "supervisor"]) {
				const pid = row[`${prefix}_pid`],
					start = row[`${prefix}_start`];
				if (pid === null && start === null) continue;
				if (
					typeof pid !== "number" ||
					!Number.isSafeInteger(pid) ||
					pid <= 0 ||
					typeof start !== "string" ||
					!start
				)
					throw Error("migration source lease tuple invalid");
				const state = processTupleStateWithStart(pid, start);
				if (state === "sensor_error")
					throw Error("migration source lease probe failed");
				if (state === "alive") {
					const same = pid === carrier.pid && start === carrier.start;
					const supervised =
						prefix === "holder" &&
						row.supervisor_pid === carrier.pid &&
						row.supervisor_start === carrier.start;
					if (
						row.identity_digest !== input.identityDigest ||
						(!same && !supervised)
					)
						throw Error("migration source lease owner conflict");
				}
			}
		}
		input.assertWindow();
		const registrySha = files();
		if (
			!registrySha ||
			JSON.stringify(await observeMigrationCarrier(input.uid)) !==
				JSON.stringify(carrier) ||
			JSON.stringify(query.all("flywheel", "flywheel-product-lead")) !==
				JSON.stringify(rows)
		)
			throw Error("migration source changed while observing");
		input.assertWindow();
		return {
			carrier,
			proofSha: createHash("sha256")
				.update(
					JSON.stringify({
						carrier,
						registrySha,
						lease: rows,
						sourceArtifacts: input.plan.expected,
					}),
				)
				.digest("hex"),
		};
	} finally {
		db.close();
	}
}
