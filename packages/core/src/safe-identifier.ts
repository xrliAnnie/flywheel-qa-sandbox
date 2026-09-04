/**
 * Shared grammar for identifiers that become filesystem path components.
 * Length constraints remain the responsibility of each consuming surface.
 */
export const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
