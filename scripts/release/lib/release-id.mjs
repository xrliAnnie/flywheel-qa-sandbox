export const RELEASE_ID_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$";

const RELEASE_ID_RE = new RegExp(RELEASE_ID_SOURCE);

export function isReleaseId(value) {
	return typeof value === "string" && RELEASE_ID_RE.test(value);
}
