import { readFile, writeFile } from "node:fs/promises"

const pkg = JSON.parse(await readFile("package.json", "utf8"))
const version = pkg.version

// Sync app.json
const appRaw = await readFile("app.json", "utf8")
const app = JSON.parse(appRaw)
if (app.expo.version !== version) {
  app.expo.version = version
  await writeFile("app.json", JSON.stringify(app, null, 2) + "\n")
  console.log(`app.json version -> ${version}`)
} else {
  console.log(`app.json version already ${version}`)
}

// Sync android/app/build.gradle versionName
let gradle = await readFile("android/app/build.gradle", "utf8")
const before = gradle
gradle = gradle.replace(/^\s*versionName\s+"[^"]*"/m, `        versionName "${version}"`)
if (gradle !== before) {
  await writeFile("android/app/build.gradle", gradle)
  console.log(`android/app/build.gradle versionName -> ${version}`)
} else {
  console.log(`android/app/build.gradle versionName already ${version}`)
}

console.log("Sync complete — run `npx expo prebuild --clean --platform android --no-install` if you changed versionCode, then `npm run check:versions`")
