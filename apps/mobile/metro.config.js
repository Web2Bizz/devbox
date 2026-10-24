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

config.watchFolders = [
  ...(config.watchFolders ?? []),
  path.resolve(__dirname, "packages"),
  // @rush-code/contracts lives OUTSIDE the mobile root (../../packages/contracts,
  // file: dep) — watch it so Metro picks up wire-contract changes without a
  // cache clear. Installed via `npm install --legacy-peer-deps` from
  // apps/mobile (standalone npm project, not a bun workspace).
  path.resolve(__dirname, "../../packages/contracts"),
]
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  "@web2bizz/ui-native": path.resolve(__dirname, "packages/uikit"),
  // TODO: deprecated alias @opencode-ai/uikit — удалить через 1 релиз.
  "@opencode-ai/uikit": path.resolve(__dirname, "packages/uikit"),
  // `@` → src, `@app` → app (mirrors tsconfig paths + babel module-resolver).
  "@": path.resolve(__dirname, "src"),
  "@app": path.resolve(__dirname, "app"),
  "@/utils": path.resolve(__dirname, "src/shared/utils"),
  "@/api": path.resolve(__dirname, "src/shared/api"),
  "@/stores": path.resolve(__dirname, "src/shared/stores"),
  "@/shared": path.resolve(__dirname, "src/shared"),
}

module.exports = config
