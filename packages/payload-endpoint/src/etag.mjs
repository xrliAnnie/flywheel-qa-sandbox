export class EtagProtocolError extends Error {
	constructor() {
		super("invalid manifest ETag");
		this.name = "EtagProtocolError";
	}
}

export function normalizeEtag(value) {
	if (typeof value !== "string") throw new EtagProtocolError();
	const etag = value.trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
	if (!/^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(etag)) {
		throw new EtagProtocolError();
	}
	return etag;
}
