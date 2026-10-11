// Expo config — version is single-sourced from package.json per user request.
// app.json remains for static fields, but version/versionCode are overridden here
// so `npx expo prebuild` and `Constants.expoConfig` always reflect package.json.
const pkg = require("./package.json")
const appJson = require("./app.json")

module.exports = {
  expo: {
    ...appJson.expo,
    version: pkg.version,
    // Keep android.versionCode in sync via package.json if needed, but
    // currently versionCode lives in app.json and is checked by
    // scripts/check-version-parity.mjs. If you bump package.json version,
    // also bump app.json android.versionCode and run `npx expo prebuild --clean`.
  },
}
