import { test } from "node:test"
import assert from "node:assert/strict"
import {
  parseGitConfigRemotes,
  remoteToWebUrl,
  gitProviderOfWebUrl,
  repoSlugOfWebUrl,
  toRepoLinks,
} from "./git-remotes.ts"

// parseGitConfigRemotes -------------------------------------------------------

const SAMPLE_CONFIG = `
[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = git@github.com:acme/app.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
\tmerge = refs/heads/main
# a comment
; another comment
[remote "upstream"]
\turl = https://github.com/upstream/app.git
\tpushurl = git@github.com:acme/app.git
`

test("parseGitConfigRemotes: extracts fetch urls, skips branch sections and comments", () => {
  assert.deepEqual(parseGitConfigRemotes(SAMPLE_CONFIG), [
    { name: "origin", url: "git@github.com:acme/app.git" },
    { name: "upstream", url: "https://github.com/upstream/app.git" },
  ])
})

test("parseGitConfigRemotes: empty config and config without remotes", () => {
  assert.deepEqual(parseGitConfigRemotes(""), [])
  assert.deepEqual(parseGitConfigRemotes('[core]\n\tbare = false\n'), [])
})

test("parseGitConfigRemotes: section without url is skipped", () => {
  assert.deepEqual(parseGitConfigRemotes('[remote "empty"]\n\tfetch = +refs/heads/*:refs/remotes/empty/*\n'), [])
})

// remoteToWebUrl ---------------------------------------------------------------

test("remoteToWebUrl: scp-like SSH", () => {
  assert.equal(remoteToWebUrl("git@github.com:acme/app.git"), "https://github.com/acme/app")
  assert.equal(remoteToWebUrl("git@gitlab.company.com:group/sub/app.git"), "https://gitlab.company.com/group/sub/app")
})

test("remoteToWebUrl: ssh:// with optional port", () => {
  assert.equal(remoteToWebUrl("ssh://git@github.com/acme/app.git"), "https://github.com/acme/app")
  assert.equal(remoteToWebUrl("ssh://git@github.com:22/acme/app.git"), "https://github.com/acme/app")
})

test("remoteToWebUrl: https, strips .git and credentials", () => {
  assert.equal(remoteToWebUrl("https://github.com/acme/app.git"), "https://github.com/acme/app")
  assert.equal(remoteToWebUrl("https://user:token@github.com/acme/app"), "https://github.com/acme/app")
  assert.equal(remoteToWebUrl("http://git.company.com/acme/app/"), "https://git.company.com/acme/app")
})

test("remoteToWebUrl: git:// becomes https", () => {
  assert.equal(remoteToWebUrl("git://github.com/acme/app.git"), "https://github.com/acme/app")
})

test("remoteToWebUrl: local paths and file:// are not web links", () => {
  assert.equal(remoteToWebUrl("/srv/git/app.git"), null)
  assert.equal(remoteToWebUrl("file:///srv/git/app.git"), null)
  assert.equal(remoteToWebUrl("C:\\repos\\app"), null)
  assert.equal(remoteToWebUrl("../other"), null)
  assert.equal(remoteToWebUrl(""), null)
})

// gitProviderOfWebUrl ------------------------------------------------------------

test("gitProviderOfWebUrl: known hosts and self-hosted mirrors", () => {
  assert.equal(gitProviderOfWebUrl("https://github.com/a/b"), "github")
  assert.equal(gitProviderOfWebUrl("https://www.github.com/a/b"), "github")
  assert.equal(gitProviderOfWebUrl("https://gitlab.com/a/b"), "gitlab")
  assert.equal(gitProviderOfWebUrl("https://gitlab.company.com/g/a"), "gitlab")
  assert.equal(gitProviderOfWebUrl("https://bitbucket.org/a/b"), "bitbucket")
  assert.equal(gitProviderOfWebUrl("https://git.company.com/a/b"), "generic")
  assert.equal(gitProviderOfWebUrl("not a url"), "generic")
})

// repoSlugOfWebUrl ---------------------------------------------------------------

test("repoSlugOfWebUrl: owner/repo incl. nested groups", () => {
  assert.equal(repoSlugOfWebUrl("https://github.com/acme/app"), "acme/app")
  assert.equal(repoSlugOfWebUrl("https://gitlab.company.com/group/sub/app"), "group/sub/app")
})

// toRepoLinks ---------------------------------------------------------------------

test("toRepoLinks: composes webUrl/provider/slug, drops non-web remotes", () => {
  assert.deepEqual(
    toRepoLinks([
      { name: "origin", url: "git@github.com:acme/app.git" },
      { name: "local", url: "/srv/git/app.git" },
    ]),
    [{ name: "origin", url: "git@github.com:acme/app.git", webUrl: "https://github.com/acme/app", provider: "github", slug: "acme/app" }],
  )
})
