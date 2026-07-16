import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type LeadLeaseMode = "off" | "audit_only" | "enforce";

export type LeadLeaseModeRead =
	| { mode: LeadLeaseMode; source: "environment" | "file" | "default" }
	| { mode: "enforce"; source: "corrupt_file"; error: string };

interface LeadLeaseModeDocument {
	mode: LeadLeaseMode;
	updated_at: string;
	updated_by: string;
}

function isLeadLeaseMode(value: unknown): value is LeadLeaseMode {
	return value === "off" || value === "audit_only" || value === "enforce";
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Independent control plane for FLY-1309. Keeping this outside lead-lease.db is
 * deliberate: deleting or rebuilding the lease store must never turn enforce
 * mode off as a side effect.
 */
export class LeadLeaseModeStore {
	constructor(
		private readonly filePath: string,
		private readonly env: Readonly<
			Record<string, string | undefined>
		> = process.env,
	) {}

	read(): LeadLeaseModeRead {
		const override = this.env.FLYWHEEL_LEAD_LEASE_MODE;
		if (override !== undefined) {
			if (isLeadLeaseMode(override)) {
				return { mode: override, source: "environment" };
			}
			return {
				mode: "enforce",
				source: "corrupt_file",
				error: `invalid FLYWHEEL_LEAD_LEASE_MODE: ${override}`,
			};
		}

		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { mode: "audit_only", source: "default" };
			}
			return {
				mode: "enforce",
				source: "corrupt_file",
				error: describeError(error),
			};
		}

		try {
			const parsed = JSON.parse(raw) as Partial<LeadLeaseModeDocument>;
			if (!isLeadLeaseMode(parsed.mode)) {
				throw new Error("mode must be off, audit_only, or enforce");
			}
			return { mode: parsed.mode, source: "file" };
		} catch (error) {
			return {
				mode: "enforce",
				source: "corrupt_file",
				error: describeError(error),
			};
		}
	}

	set(
		mode: LeadLeaseMode,
		updatedBy: string,
		now = new Date().toISOString(),
	): void {
		if (!isLeadLeaseMode(mode)) {
			throw new Error(`invalid lead lease mode: ${String(mode)}`);
		}
		mkdirSync(dirname(this.filePath), { recursive: true });
		const tempPath = join(
			dirname(this.filePath),
			`.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
		);
		const document: LeadLeaseModeDocument = {
			mode,
			updated_at: now,
			updated_by: updatedBy,
		};
		let fd: number | undefined;
		try {
			fd = openSync(tempPath, "wx", 0o600);
			writeFileSync(fd, `${JSON.stringify(document)}\n`, "utf8");
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			renameSync(tempPath, this.filePath);
		} catch (error) {
			if (fd !== undefined) closeSync(fd);
			try {
				unlinkSync(tempPath);
			} catch {
				// Best-effort cleanup; preserve the original write failure.
			}
			throw error;
		}
	}
}
