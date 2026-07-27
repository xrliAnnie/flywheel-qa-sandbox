import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_V2_DB_PATH = join(
	homedir(),
	".flywheel",
	"flywheel-v2.db",
);
