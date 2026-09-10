// A real isolated worker process backed by a strict synthetic refresh authority.
const fs = require("node:fs");
const authPath = process.argv[2];
process.on("message", (message) => {
	try {
		const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
		const state = JSON.parse(
			fs.readFileSync(auth.fixture.authorityPath, "utf8"),
		);
		if (state.tokens[auth.fixture.profile] !== auth.tokens.refresh_token)
			throw new Error("invalid_grant");
		if (message === "refresh") {
			state.tokens[auth.fixture.profile] += ":next";
			auth.tokens.refresh_token = state.tokens[auth.fixture.profile];
			fs.writeFileSync(auth.fixture.authorityPath, JSON.stringify(state));
			fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
		}
		process.send({ ok: true, profile: auth.fixture.profile });
	} catch {
		process.send({ ok: false });
	}
});
process.send({ ready: true });
