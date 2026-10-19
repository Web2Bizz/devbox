// Babel config — expo preset + `@`/`@app` aliases (mirrors tsconfig paths +
// metro extraNodeModules). Keeps expo-router/entry working; restart with
// `npx expo start --clear` after changes so the cache picks up the new resolver.
module.exports = function (api) {
  api.cache(true)
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      [
        "module-resolver",
        {
          root: ["."],
          alias: {
            "@": "./src",
            "@app": "./app",
          },
        },
      ],
    ],
  }
}
