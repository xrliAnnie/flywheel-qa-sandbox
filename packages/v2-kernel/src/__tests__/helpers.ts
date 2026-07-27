import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDatabase {
	dir: string;
	path: string;
	cleanup(): void;
}

export function makeTempDatabase(name = "flywheel-v2.db"): TempDatabase {
	const dir = mkdtempSync(join(tmpdir(), "flywheel-v2-kernel-"));
	return {
		dir,
		path: join(dir, name),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}
