import { isAbsolute, join } from "node:path";
import type { MigrationRestartOwner } from "./lead-backend-migration-owner.js";
export interface MigrationWindowContext extends MigrationRestartOwner {
	root: string;
	leaseId: string;
}
/** Validate transport input before any filesystem/process/control-plane operation.
 * Matching context is not authority; owner and admission probes are still mandatory.
 */
export function parseMigrationWindowContext(
	json: string,
	trusted: { home: string; root: string },
): MigrationWindowContext {
	const fail = (): never => {
		throw new Error("invalid migration window context");
	};
	if (Buffer.byteLength(json, "utf8") > 8192) return fail();
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return fail();
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		return fail();
	const row = value as Record<string, unknown>;
	const keys = [
		"home",
		"root",
		"restartPid",
		"restartStart",
		"lockDev",
		"lockIno",
		"leaseId",
		"restartScript",
		"updaterScript",
	];
	if (
		Object.keys(row).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(row, key))
	)
		return fail();
	for (const key of [
		"home",
		"root",
		"restartScript",
		"updaterScript",
		"restartStart",
		"leaseId",
	]) {
		const text = row[key];
		if (
			typeof text !== "string" ||
			!text.trim() ||
			[...text].some(
				(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
			)
		)
			return fail();
	}
	if (
		!isAbsolute(trusted.home) ||
		!isAbsolute(trusted.root) ||
		row.home !== trusted.home ||
		row.root !== trusted.root ||
		row.restartScript !== join(trusted.root, "scripts/restart-services.sh") ||
		row.updaterScript !== join(trusted.root, "scripts/update-flywheel.sh")
	)
		return fail();
	for (const key of ["restartPid", "lockDev", "lockIno"]) {
		if (
			typeof row[key] !== "number" ||
			!Number.isSafeInteger(row[key]) ||
			row[key] < (key === "lockDev" ? 0 : 1)
		)
			return fail();
	}
	if (
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
			row.leaseId as string,
		)
	)
		return fail();
	return structuredClone(row) as unknown as MigrationWindowContext;
}
