// Killed by the bench after authoritative synthetic rotation; no external service.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
(async () => {
	const {
		acquireCodexAccountLease,
		registerCodexCandidateWorkspace,
		markCodexCandidateProcess,
	} = await import(pathToFileURL(process.argv[2]).href);
	const profilesRoot = process.argv[3];
	const profilePath = path.join(profilesRoot, "school", "auth.json");
	const raw = fs.readFileSync(profilePath, "utf8");
	const auth = JSON.parse(raw);
	const digest = (value) =>
		crypto.createHash("sha256").update(value).digest("hex");
	const lease = acquireCodexAccountLease(profilesRoot, digest("school:school"));
	const home = fs.mkdtempSync(
		path.join(path.dirname(profilesRoot), "crash-refresh-"),
	);
	const finalAuth = path.join(home, "auth.json");
	fs.writeFileSync(finalAuth, raw, { mode: 0o600 });
	registerCodexCandidateWorkspace(lease, {
		authPath: finalAuth,
		originalAuthDigest: digest(raw),
	});
	const authority = JSON.parse(
		fs.readFileSync(auth.fixture.authorityPath, "utf8"),
	);
	if (authority.tokens.school !== auth.tokens.refresh_token)
		throw new Error("invalid_grant");
	authority.tokens.school += ":crashed";
	auth.tokens.refresh_token = authority.tokens.school;
	fs.writeFileSync(auth.fixture.authorityPath, JSON.stringify(authority));
	fs.writeFileSync(finalAuth, JSON.stringify(auth));
	markCodexCandidateProcess(lease, { state: "stopped", pid: process.pid });
	process.send({ rotated: true });
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
})().catch(() => process.exit(1));
