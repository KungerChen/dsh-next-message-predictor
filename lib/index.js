// Package main entry: the Host half. The implementation lives in src/host so
// the browser bundle build can share src/shared without a bundler.
export { apply, default, inject } from '../src/host/index.js'

/** Plugin version (equals `version` in package.json). */
export { PLUGIN_VERSION as VERSION } from '../src/shared/version.js'
