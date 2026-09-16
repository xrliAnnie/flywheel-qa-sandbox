import { createRequire } from "node:module";
import { CustomerReleaseStore } from "../../../packages/teamlead/src/bridge/customer-release/store.ts";

const require = createRequire(
	new URL("../../../packages/teamlead/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const db = new Database(process.argv[2]);
const store = new CustomerReleaseStore(db);
store.migrate();
process.send({ kind: "ready" });
process.once("message", (input) => {
	process.send({ kind: "attempting" }, () => {
		try {
			const cycle = store.reserve(input);
			process.send({ kind: "result", cycle }, () => process.disconnect());
		} catch (error) {
			process.send({ kind: "error", message: String(error) }, () =>
				process.disconnect(),
			);
			process.exitCode = 1;
		} finally {
			db.close();
		}
	});
});
