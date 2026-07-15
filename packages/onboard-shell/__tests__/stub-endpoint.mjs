// FLY-1062 PR2 · hermetic stub of the gated hosting endpoint. Serves a fixture
// payload tarball + manifest with configurable behaviour so the shell's
// key-exchange / sha256 / 401 / rotation paths can be exercised without any
// real network or hosting. Prints "PORT <n>" on its first stdout line so a
// bash test can capture the port, then serves until killed.
//
// Env config:
//   STUB_PAYLOAD_FILE  path to the fixture payload tarball
//   STUB_VER           the version string (manifest.latest)
//   STUB_SHA           advertised sha256 (manifest); use the REAL sha for the
//                      happy path, a wrong one to exercise the checksum guard
//   STUB_MODE          normal | unauthorized | corrupt
//                        unauthorized → every request 401 (invalid/revoked key)
//                        corrupt      → payload body flips one byte (sha fails)
//   STUB_EXPECT_KEY    if set, requests whose Bearer token != this get 401
//   STUB_KEYLOG        if set, append each received Authorization header to it
//                      (lets a test PROVE the key travelled only in the header)

import fs from "node:fs";
import http from "node:http";

const PAYLOAD = process.env.STUB_PAYLOAD_FILE;
const VER = process.env.STUB_VER || "1.0.0";
const SHA = process.env.STUB_SHA || "";
const MODE = process.env.STUB_MODE || "normal";
const EXPECT_KEY = process.env.STUB_EXPECT_KEY || "";
const KEYLOG = process.env.STUB_KEYLOG || "";

function bearer(req) {
	const h = req.headers.authorization || "";
	const m = /^Bearer\s+(.+)$/.exec(h);
	return m ? m[1] : "";
}

const server = http.createServer((req, res) => {
	const key = bearer(req);
	if (KEYLOG) {
		try {
			fs.appendFileSync(
				KEYLOG,
				`${req.url}\tauth=${req.headers.authorization || ""}\n`,
			);
		} catch {}
	}
	if (MODE === "unauthorized" || (EXPECT_KEY && key !== EXPECT_KEY)) {
		res.writeHead(401, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "invalid or revoked key" }));
		return;
	}
	if (req.url === "/manifest") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({ latest: VER, versions: [{ ver: VER, sha256: SHA }] }),
		);
		return;
	}
	if (req.url.startsWith("/payload/")) {
		let buf = fs.readFileSync(PAYLOAD);
		if (MODE === "corrupt") {
			buf = Buffer.from(buf);
			buf[0] = buf[0] ^ 0xff; // flip a byte → sha256 no longer matches
		}
		res.writeHead(200, { "content-type": "application/octet-stream" });
		res.end(buf);
		return;
	}
	res.writeHead(404);
	res.end("not found");
});

server.listen(0, "127.0.0.1", () => {
	const { port } = server.address();
	process.stdout.write(`PORT ${port}\n`);
});
