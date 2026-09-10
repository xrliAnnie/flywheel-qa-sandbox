#!/usr/bin/env node
// Synthetic protocol peer only. It never contacts a provider or loads real auth.
const fs = require("node:fs");
const path = require("node:path");
const authPath = path.join(process.env.CODEX_HOME, "auth.json");
const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
const fixture = auth.fixture;
if (!fixture || !path.isAbsolute(fixture.authorityPath)) process.exit(90);
const record = (kind) =>
	fs.appendFileSync(
		fixture.journalPath,
		`${JSON.stringify({ kind, profile: fixture.profile, at: Date.now() })}\n`,
	);
const authority = () =>
	JSON.parse(fs.readFileSync(fixture.authorityPath, "utf8"));
if (process.argv[2] === "app-server") {
	const lines = require("node:readline").createInterface({
		input: process.stdin,
	});
	lines.on("line", (line) => {
		const request = JSON.parse(line);
		if (!request.id) return;
		let result = {};
		if (request.method === "account/read")
			result = {
				account: { type: "chatgpt", email: `${fixture.profile}@example.test` },
			};
		if (request.method === "account/rateLimits/read") {
			record("quota_read");
			const state = authority();
			const used =
				state.scenario === "exhausted" || fixture.profile === "business"
					? 100
					: 20;
			result = {
				rateLimitsByLimitId: {
					codex: {
						primary: {
							usedPercent: used,
							resetsAt:
								Math.floor(Date.now() / 1000) +
								(fixture.profile === "school" ? 120 : 240),
						},
						secondary: null,
					},
				},
			};
		}
		process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
	});
} else if (process.argv[2] === "exec") {
	record("probe");
	const state = authority();
	if (state.tokens[fixture.profile] !== auth.tokens.refresh_token) {
		process.stdout.write(
			`${JSON.stringify({ type: "error", message: "invalid_grant" })}\n`,
		);
		process.exitCode = 1;
	} else if (state.scenario === "probe_failed") {
		process.stdout.write(
			JSON.stringify({ type: "error", message: "synthetic probe failure" }) +
				"\n",
		);
		process.exitCode = 1;
	} else {
		state.tokens[fixture.profile] += ":next";
		auth.tokens.refresh_token = state.tokens[fixture.profile];
		fs.writeFileSync(fixture.authorityPath, JSON.stringify(state));
		fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
		fs.writeFileSync(
			process.argv[process.argv.indexOf("--output-last-message") + 1],
			"ok",
			{ mode: 0o600 },
		);
		process.stdout.write(
			`${JSON.stringify({
				type: "item.completed",
				item: { type: "agent_message", text: "ok" },
			})}\n`,
		);
		record("probe_ok");
	}
} else process.exit(91);
