import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeAtomic } from "flywheel-comm/lead-registry-file-io";
import { makeLeadBuildIdentity } from "../lead-runtime-build.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
	cwd: root,
	encoding: "utf8",
}).trim();
writeAtomic(
	join(root, "packages/teamlead/dist/build-identity.json"),
	`${JSON.stringify(makeLeadBuildIdentity(root, sha))}\n`,
);
