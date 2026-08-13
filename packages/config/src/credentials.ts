/** Normalize optional bearer inputs at injection and consumption boundaries. */
export function normalizeOptionalBearer(
	value: string | undefined,
): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}
