// Single source of truth for the user-visible app version — package.json.
//
// Every runtime reader (settings screen via update-check, diagnostics
// reports, waitlist mailto) imports APP_VERSION from here instead of
// requiring package.json itself, so a version bump in package.json (plus
// `node scripts/sync-version.mjs` for the native shells) propagates
// everywhere with no code edits.
import pkg from "../../package.json"

export const APP_VERSION: string = (pkg as { version?: string }).version ?? "unknown"
