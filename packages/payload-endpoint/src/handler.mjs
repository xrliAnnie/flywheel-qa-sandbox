// FLY-1062 PR3 · the gated distribution endpoint — pure request handler.
//
// handleRequest(request, {bucket, secrets, now, log}) is the SINGLE trusted
// write choke point for the distribution bucket (plan §0): customer reads go
// through entitlement views, every manifest change goes through one
// etag-CAS'd POST with full-invariant validation + capability diff
// classification, payload objects are immutable-once-written, and cleanup is
// guarded by the tombstone protocol. Deployed as a Cloudflare Worker
// (worker.mjs) and tested hermetically in node — same bytes both places.
//
// Security posture:
//   • customer auth failures are byte-identical 401s (no enumeration);
//   • payload 404s are byte-identical whether the version is unknown,
//     quarantined, expired, or out-of-entitlement;
//   • keys / key hashes / capability tokens never reach a log line or an
//     error body (log() receives route TEMPLATES, never raw paths).

import {
	isPayloadSemver,
	keyObjectKey,
	MANIFEST_KEY,
	payloadObjectKey,
} from "./manifest.mjs";
import { applyTransition, capabilityAllows } from "./transitions.mjs";
import { isEmptyInitialManifest, validateManifest } from "./validator.mjs";
import { manifestView, visibleEntries } from "./views.mjs";

const enc = new TextEncoder();

async function sha256Hex(text) {
	const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// constant-time hex comparison (we compare HASHES of tokens, so a timing
// leak would reveal nothing usable anyway — belt and braces).
function ctEqualHex(a, b) {
	if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
		return false;
	let r = 0;
	for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return r === 0;
}

function bearer(request) {
	const h = request.headers.get("authorization") || "";
	const m = /^Bearer\s+(.+)$/.exec(h);
	return m ? m[1] : null;
}

function json(status, body, headers = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

// byte-identical rejection shapes (anti-enumeration)
const customer401 = () => json(401, { error: "invalid or revoked key" });
const uniform404 = () => json(404, { error: "not found" });

function stripQuotes(etag) {
	return typeof etag === "string" ? etag.replace(/^"|"$/g, "") : etag;
}

async function readManifest(bucket) {
	const obj = await bucket.get(MANIFEST_KEY);
	if (!obj) return null;
	return { manifest: await obj.json(), etag: obj.etag, httpEtag: obj.httpEtag };
}

// capability <request, secrets> → "beta-publish" | "customer-release" |
// "ops-admin" | null. Worker secrets hold sha256(token) per capability.
async function capabilityOf(request, secrets) {
	const token = bearer(request);
	if (!token) return null;
	const presented = await sha256Hex(token);
	const table = [
		["beta-publish", secrets.betaPublishTokenSha256],
		["customer-release", secrets.customerReleaseTokenSha256],
		["ops-admin", secrets.opsAdminTokenSha256],
	];
	for (const [cap, hash] of table) {
		if (
			typeof hash === "string" &&
			hash &&
			ctEqualHex(presented, hash.toLowerCase())
		)
			return cap;
	}
	return null;
}

async function customerAuth(request, bucket) {
	const key = bearer(request);
	if (!key) return null;
	const obj = await bucket.get(keyObjectKey(await sha256Hex(key)));
	if (!obj) return null;
	let rec;
	try {
		rec = await obj.json();
	} catch {
		return null;
	}
	if (rec?.revoked !== false) return null;
	if (rec.entitlement !== "customer" && rec.entitlement !== "internal")
		return null;
	return rec;
}

// live claim: a reserved/prepared releaseOps record whose objectKey is
// EXACTLY this key (Codex R6: any live claim keeps the object — an abandoned
// claim's key may have been taken over by a new releaseId).
function hasLiveClaim(manifest, objectKey) {
	return Object.values(manifest.releaseOps ?? {}).some(
		(op) =>
			op &&
			(op.state === "reserved" || op.state === "prepared") &&
			op.objectKey === objectKey,
	);
}

export async function handleRequest(request, deps) {
	const { bucket, secrets, now } = deps;
	const log = deps.log ?? (() => {});
	const url = new URL(request.url);
	const path = url.pathname;
	const method = request.method;

	const respond = (route, res) => {
		log(`${method} ${route} ${res.status}`);
		return res;
	};

	try {
		// ── customer surface ─────────────────────────────────────────────────
		if (method === "GET" && path === "/manifest") {
			const rec = await customerAuth(request, bucket);
			if (!rec) return respond("/manifest", customer401());
			const cur = await readManifest(bucket);
			if (!cur)
				return respond("/manifest", json(503, { error: "not activated" }));
			const view = manifestView(cur.manifest, rec.entitlement);
			if (view.empty)
				return respond("/manifest", json(503, { error: "not activated" }));
			return respond("/manifest", json(200, view.view));
		}

		if (method === "GET" && /^\/payload\/[^/]+$/.test(path)) {
			const rec = await customerAuth(request, bucket);
			if (!rec) return respond("/payload/:ver", customer401());
			const cur = await readManifest(bucket);
			if (!cur) return respond("/payload/:ver", uniform404());
			const ver = decodeURIComponent(path.slice("/payload/".length));
			// fetch THROUGH the visible set (Codex R1#3) — never by URL-derived
			// object path; out-of-set = the same 404 bytes as unknown.
			const entry = visibleEntries(cur.manifest, rec.entitlement).get(ver);
			if (!entry) return respond("/payload/:ver", uniform404());
			const obj = await bucket.get(entry.key);
			if (!obj) return respond("/payload/:ver", uniform404());
			return respond(
				"/payload/:ver",
				new Response(obj.body, {
					status: 200,
					headers: { "content-type": "application/octet-stream" },
				}),
			);
		}

		// ── admin surface ────────────────────────────────────────────────────
		if (path.startsWith("/admin/")) {
			const cap = await capabilityOf(request, secrets);
			if (!cap)
				return respond("/admin/*", json(401, { error: "unauthorized" }));

			if (method === "GET" && path === "/admin/manifest") {
				const cur = await readManifest(bucket);
				if (!cur)
					return respond(
						"/admin/manifest",
						json(404, { error: "no manifest yet" }),
					);
				return respond(
					"/admin/manifest",
					json(200, cur.manifest, { etag: cur.httpEtag ?? `"${cur.etag}"` }),
				);
			}

			if (method === "POST" && path === "/admin/manifest") {
				const route = "/admin/manifest";
				let body;
				try {
					body = await request.json();
				} catch {
					return respond(
						route,
						json(400, { error: "body must be JSON {baseEtag, manifest}" }),
					);
				}
				if (!body || typeof body !== "object" || !("manifest" in body)) {
					return respond(
						route,
						json(400, { error: "body must be JSON {baseEtag, manifest}" }),
					);
				}
				const cur = await readManifest(bucket);
				if (!cur) {
					// conditional create (plan §B0-7): base must be null and the
					// initial state exactly the empty shape.
					if (body.baseEtag !== null) {
						return respond(
							route,
							json(412, { error: "no manifest exists; baseEtag must be null" }),
						);
					}
					if (!isEmptyInitialManifest(body.manifest)) {
						return respond(
							route,
							json(422, {
								error:
									"initial manifest must be the empty shape (dual null channels)",
							}),
						);
					}
					const created = await bucket.put(
						MANIFEST_KEY,
						JSON.stringify(body.manifest),
						{
							onlyIf: { etagDoesNotMatch: "*" },
						},
					);
					if (!created)
						return respond(route, json(412, { error: "etag mismatch" }));
					return respond(
						route,
						json(200, { ok: true, etag: created.httpEtag }),
					);
				}
				if (stripQuotes(body.baseEtag) !== cur.etag) {
					return respond(route, json(412, { error: "etag mismatch" }));
				}
				const {
					manifest: stamped,
					ops,
					errs,
				} = applyTransition(cur.manifest, body.manifest, now);
				if (errs.length) {
					return respond(
						route,
						json(422, { error: "illegal transition", violations: errs }),
					);
				}
				const refused = ops.filter((op) => !capabilityAllows(cap, op));
				if (refused.length) {
					return respond(
						route,
						json(403, {
							error: "capability does not allow this diff",
							refused: refused.map((op) => op.type),
						}),
					);
				}
				const violations = validateManifest(stamped);
				if (violations.length) {
					return respond(
						route,
						json(422, { error: "validation failed", violations }),
					);
				}
				// commit hard gate (plan §B0-2 invariant 6): a NEW version entry's
				// object must exist with byte-matching identity metadata.
				for (const op of ops) {
					if (op.type !== "addVersion") continue;
					const entry = stamped.versions[op.ver];
					const head = await bucket.head(entry.key);
					if (
						!head ||
						head.size !== entry.size ||
						head.customMetadata?.sha256 !== entry.sha256
					) {
						return respond(
							route,
							json(409, {
								error: `commit refused: object for ${op.ver} missing or metadata mismatch`,
							}),
						);
					}
				}
				const put = await bucket.put(MANIFEST_KEY, JSON.stringify(stamped), {
					onlyIf: { etagMatches: cur.etag },
				});
				if (!put) return respond(route, json(412, { error: "etag mismatch" }));
				return respond(route, json(200, { ok: true, etag: put.httpEtag }));
			}

			const payloadMatch = /^\/admin\/payload\/([^/]+)\/([0-9a-f]{64})$/.exec(
				path,
			);
			if (payloadMatch) {
				const route = "/admin/payload/:ver/:sha";
				const ver = decodeURIComponent(payloadMatch[1]);
				const sha = payloadMatch[2];
				if (!isPayloadSemver(ver)) {
					return respond(route, json(400, { error: "bad version" }));
				}
				const objectKey = payloadObjectKey(ver, sha);

				if (method === "GET") {
					if (cap !== "beta-publish" && cap !== "customer-release") {
						return respond(route, json(403, { error: "forbidden" }));
					}
					const obj = await bucket.get(objectKey);
					if (!obj) return respond(route, json(404, { error: "not found" }));
					return respond(
						route,
						new Response(obj.body, {
							status: 200,
							headers: { "content-type": "application/octet-stream" },
						}),
					);
				}

				if (method === "PUT") {
					if (cap !== "beta-publish" && cap !== "customer-release") {
						return respond(route, json(403, { error: "forbidden" }));
					}
					const cur = await readManifest(bucket);
					if (!cur)
						return respond(
							route,
							json(409, { error: "no manifest — nothing reserved" }),
						);
					if ((cur.manifest.tombstones ?? []).includes(objectKey)) {
						return respond(
							route,
							json(409, { error: "conflict: object key is tombstoned" }),
						);
					}
					// durable-claim gate (Codex R4#2): the tuple must already be
					// registered on a reserved/prepared op — every staging object is
					// discoverable from the manifest BEFORE its first byte lands.
					if (!hasLiveClaim(cur.manifest, objectKey)) {
						return respond(
							route,
							json(409, { error: "no live claim for this object" }),
						);
					}
					if (await bucket.head(objectKey)) {
						return respond(
							route,
							json(409, { error: "object already exists (immutable)" }),
						);
					}
					let put;
					try {
						put = await bucket.put(objectKey, request.body, {
							sha256: sha,
							onlyIf: { etagDoesNotMatch: "*" },
							customMetadata: { sha256: sha, ver },
						});
					} catch {
						return respond(
							route,
							json(400, { error: "payload sha256 mismatch" }),
						);
					}
					if (!put) {
						return respond(
							route,
							json(409, { error: "object already exists (immutable)" }),
						);
					}
					// post-check (Codex R5#2 + R6): the claim must STILL be live for
					// this exact objectKey (any live claim counts — an abandoned
					// reservation's key may have been taken over by a new releaseId).
					// If the world moved (abandon + tombstone raced past a slow PUT),
					// remove what we just wrote and report the conflict.
					const after = await readManifest(bucket);
					const tombstoned = (after?.manifest.tombstones ?? []).includes(
						objectKey,
					);
					if (
						!after ||
						tombstoned ||
						!hasLiveClaim(after.manifest, objectKey)
					) {
						await bucket.delete(objectKey);
						return respond(
							route,
							json(409, { error: "claim lost during upload; object removed" }),
						);
					}
					return respond(route, json(200, { ok: true }));
				}

				if (method === "DELETE") {
					if (cap !== "ops-admin")
						return respond(route, json(403, { error: "forbidden" }));
					const cur = await readManifest(bucket);
					// two-step delete (Codex R4#1): the tombstone CAS is the guard —
					// physical deletion is only reachable for tombstoned keys.
					if (!cur || !(cur.manifest.tombstones ?? []).includes(objectKey)) {
						return respond(
							route,
							json(409, { error: "refused: key not tombstoned" }),
						);
					}
					await bucket.delete(objectKey);
					return respond(route, json(200, { ok: true }));
				}
			}

			const keyMatch = /^\/admin\/key\/([0-9a-f]{64})(\/revoke)?$/.exec(path);
			if (keyMatch) {
				const route = keyMatch[2]
					? "/admin/key/:sha/revoke"
					: "/admin/key/:sha";
				if (cap !== "ops-admin")
					return respond(route, json(403, { error: "forbidden" }));
				const objectKey = keyObjectKey(keyMatch[1]);

				if (method === "PUT" && !keyMatch[2]) {
					let body;
					try {
						body = await request.json();
					} catch {
						return respond(
							route,
							json(400, { error: "body must be a JSON key record" }),
						);
					}
					if (
						!body ||
						typeof body.customerId !== "string" ||
						!body.customerId ||
						(body.entitlement !== "customer" &&
							body.entitlement !== "internal") ||
						body.revoked !== false ||
						(body.note !== undefined && typeof body.note !== "string")
					) {
						return respond(
							route,
							json(400, {
								error:
									"key record must be {customerId, entitlement, revoked:false}",
							}),
						);
					}
					// pre-activation guard (plan §B0-4): no key issuance while the
					// entitlement's channel has no published pointer.
					const cur = await readManifest(bucket);
					const pointer =
						body.entitlement === "customer"
							? "customer-release"
							: "internal-beta";
					if (!cur || cur.manifest.channels?.[pointer]?.latest == null) {
						return respond(
							route,
							json(409, {
								error:
									"refused: entitlement channel has no published release yet",
							}),
						);
					}
					const existing = await bucket.get(objectKey);
					let createdAt = now().toISOString();
					if (existing) {
						try {
							const prev = await existing.json();
							if (prev?.createdAt) createdAt = prev.createdAt;
						} catch {
							// unreadable previous record — replace it wholesale
						}
					}
					await bucket.put(
						objectKey,
						JSON.stringify({
							customerId: body.customerId,
							entitlement: body.entitlement,
							revoked: false,
							createdAt,
							note: body.note ?? "",
						}),
					);
					return respond(route, json(200, { ok: true }));
				}

				if (method === "POST" && keyMatch[2]) {
					const existing = await bucket.get(objectKey);
					if (!existing)
						return respond(route, json(404, { error: "no such key" }));
					let rec;
					try {
						rec = await existing.json();
					} catch {
						return respond(
							route,
							json(409, { error: "key record unreadable" }),
						);
					}
					rec.revoked = true;
					await bucket.put(objectKey, JSON.stringify(rec));
					return respond(route, json(200, { ok: true }));
				}
			}

			return respond("/admin/*", uniform404());
		}

		return respond(path.startsWith("/admin") ? "/admin/*" : "/*", uniform404());
	} catch {
		// never leak internals — a handler bug surfaces as an opaque 500.
		return json(500, { error: "internal error" });
	}
}
