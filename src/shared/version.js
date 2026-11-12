// Plugin version, shared by the Host half and the browser bundle.
//
// Must equal `version` in package.json: scripts/build-client.mjs refuses to
// build when the two differ, and test/shared.test.mjs asserts the same. The
// Settings header shows it, the Host reports it in `status`, and the page
// compares the two to tell the user when a restart is still pending.
// This file is concatenated into the browser bundle: plain declarations only.

export const PLUGIN_VERSION = '0.5.0'
