import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type PublishCodexMemorySeedInput,
	publishCodexMemorySeed,
} from "../../src/codex-memory-seed.js";

const input = JSON.parse(process.argv[2]) as PublishCodexMemorySeedInput;
const result = publishCodexMemorySeed(input);
process.stdout.write(
	JSON.stringify({
		manifest: readFileSync(join(result.directory, "manifest.json"), "utf8"),
		index: readFileSync(join(result.directory, "index.md"), "utf8"),
		catalog: readFileSync(join(result.directory, "catalog.md"), "utf8"),
	}),
);
