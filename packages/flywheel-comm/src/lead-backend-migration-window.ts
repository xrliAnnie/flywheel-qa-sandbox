import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { installSqlTiming } from "flywheel-config";
/** Read-only admission fence. Caller separately proves the original authorized restart owner. */
export function assertMigrationAdmissionWindow(
	dbPath: string,
	input: { leaseId: string; restartPid: number; now: string },
	assertRestartOwner: () => void,
): string {
	assertRestartOwner();
	const now = Date.parse(input.now);
	if (
		!Number.isFinite(now) ||
		!Number.isSafeInteger(input.restartPid) ||
		input.restartPid <= 0 ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
			input.leaseId,
		)
	)
		throw new Error("invalid migration window identity");
	if (!isAbsolute(dbPath)) throw new Error("invalid migration state path");
	const stat = lstatSync(dbPath);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("invalid migration state database");
	const db = installSqlTiming(
		new Database(dbPath, { readonly: true, fileMustExist: true }),
		"teamlead",
	);
	try {
		const row = db
			.prepare(
				"SELECT lease_id, paused_until, set_by, reason, set_at FROM admission_pause WHERE id = 1",
			)
			.get() as
			| {
					lease_id: unknown;
					paused_until: unknown;
					set_by: unknown;
					reason: unknown;
					set_at: unknown;
			  }
			| undefined;
		const prefix = `restart-services:updater:pid=${input.restartPid}:started=`;
		if (
			!row ||
			row.lease_id !== input.leaseId ||
			row.set_by !== "bridge-admission-api" ||
			typeof row.reason !== "string" ||
			!row.reason.startsWith(prefix) ||
			typeof row.paused_until !== "string" ||
			typeof row.set_at !== "string"
		)
			throw new Error("migration does not own active admission pause");
		const until = Date.parse(row.paused_until),
			setAt = Date.parse(row.set_at),
			started = Date.parse(row.reason.slice(prefix.length));
		if (
			!Number.isFinite(until) ||
			!Number.isFinite(setAt) ||
			!Number.isFinite(started) ||
			until <= now ||
			setAt > now ||
			started > now
		)
			throw new Error("migration admission pause expired or invalid");
		assertRestartOwner();
		return createHash("sha256")
			.update(
				JSON.stringify({
					lease: row.lease_id,
					reason: row.reason,
					until: row.paused_until,
				}),
			)
			.digest("hex");
	} finally {
		db.close();
	}
}

/** Window-external fence: GET only, no nudge/resume or admission mutation.
 * Caller re-runs this immediately before committing verification evidence.
 */
export async function assertMigrationOutsideWindow(input: {
	restartLockExists(): boolean;
	bridgeUrl: string;
	token: string;
	request?: typeof fetch;
}): Promise<string> {
	const assertOutside = () => {
		if (input.restartLockExists())
			throw Error("migration verification requires a closed restart window");
	};
	assertOutside();
	const url = new URL(input.bridgeUrl);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		!input.token
	)
		throw Error("invalid migration admission endpoint");
	url.pathname = "/api/admission/pause";
	const response = await (input.request ?? fetch)(url.href, {
		method: "GET",
		headers: { Authorization: `Bearer ${input.token}` },
		signal: AbortSignal.timeout(5000),
		redirect: "error",
	});
	if (!response.ok || !response.body)
		throw Error("migration admission unavailable");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 16384) throw Error("migration admission response too large");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (value?.ok !== true || value?.admissionPause?.active !== false)
		throw Error("migration admission is active or unknown");
	assertOutside();
	return createHash("sha256")
		.update(JSON.stringify({ ok: true, admissionPause: { active: false } }))
		.digest("hex");
}
