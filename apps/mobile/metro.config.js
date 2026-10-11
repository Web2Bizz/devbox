// Metro bundler config - Sentry removed, use default Expo config.
// @web2bizz/ui-native: resolves to packages/uikit (renamed from `@opencode-ai/uikit`,
// задел под @web2bizz/ui как будущий ре-экспорт).
// Variant B (tsconfig paths + extraNodeModules) is the primary working resolve —
// works immediately without reinstall. Variant A (npm workspaces + file: dep in
// root package.json) is declared in parallel; once `npm install` materializes
// node_modules/@web2bizz/ui-native, watchFolders keeps Metro watching it.
const path = require("path")
const { getDefaultConfig } = require("expo/metro-config")

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname)

config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "packages")]
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  "@web2bizz/ui-native": path.resolve(__dirname, "packages/uikit"),
  // TODO: deprecated alias @opencode-ai/uikit — удалить через 1 релиз.
  "@opencode-ai/uikit": path.resolve(__dirname, "packages/uikit"),
}

module.exports = config
