/**
 * Empty in the Bridge build. The one-time hosting migration replaces this
 * module in the gateway deployment with the original timestamps of migrated
 * links so the cutover cannot extend their 14-day lifetime.
 */
export const MIGRATED_REPORT_CREATED_AT: Readonly<Record<string, string>> =
	Object.freeze({});
