// OpenCode V2 plugin entrypoint.
//
// A configured plugin entry must be a package DIRECTORY, and for absolute path
// entries the host resolves it as `<dir>/server.*` falling back to
// `<dir>/index.*` — it does NOT consult this package's `exports` map (that path
// is only taken for npm-installed packages, which are resolved by name). This
// file is the shim the host expects at the package root; the plugin itself
// lives in dist/plugin.js, next to the provider in dist/index.js.
export { default } from "./dist/plugin.js"
