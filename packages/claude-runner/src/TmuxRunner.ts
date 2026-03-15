/**
 * @deprecated Use TmuxAdapter instead (GEO-157).
 * This file is a compatibility shim. TrustPromptHandler imports ExecFileFn from here.
 * Will be removed in Wave 6.
 */
export { TmuxAdapter as TmuxRunner } from "./TmuxAdapter.js";
export type { ExecFileFn } from "./TmuxAdapter.js";
