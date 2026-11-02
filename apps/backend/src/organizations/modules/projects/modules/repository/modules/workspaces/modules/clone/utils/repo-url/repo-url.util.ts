import { BadRequestException } from '@nestjs/common';

/**
 * Exact message shared by the DTO (400 bad_request) and the clone service
 * (400 REPO_URL_NOT_ALLOWED) so both boundaries answer the same wording.
 */
export const REPO_URL_ALLOWED_FORMS_MESSAGE =
  'repoUrl must be an allowed https://, ssh:// or git@ URL';

/** Built-in exact-match clone hosts; CLONE_ALLOWED_HOSTS extends this list. */
export const BASE_CLONE_HOSTS: ReadonlyArray<string> = [
  'github.com',
  'gitlab.com',
  'bitbucket.org',
];

/** Case-insensitive host portion of the scp-like form (`git@host:path`). */
const SCP_URL = /^git@([A-Za-z0-9.-]+):([^\s]+)$/;

const MAX_URL_LENGTH = 2048;
const CONTROL_OR_BACKSLASH = /[\\\u0000-\u001f\u007f]/;
const ENCODED_SEPARATOR = /%2e|%2f/i;
const WHITESPACE = /\s/;

export function rejectedRepoUrl(): BadRequestException {
  return new BadRequestException({
    code: 'REPO_URL_NOT_ALLOWED',
    message: REPO_URL_ALLOWED_FORMS_MESSAGE,
  });
}

/** Built-in hosts + validated AppEnv extras, exact match, lowercased. */
export function createAllowedCloneHosts(extra: ReadonlyArray<string>): Set<string> {
  const hosts = new Set(BASE_CLONE_HOSTS);
  for (const entry of extra) {
    const host = String(entry ?? '').trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * `git clone` argv with an explicit `--` so a hostile URL can never be parsed
 * as a git option (e.g. `-u@host:path`).
 */
export function buildGitCloneArgs(repoUrl: string, dest: string): Array<string> {
  return ['clone', '--recurse-submodules', '--', repoUrl, dest];
}

/** Canonical URL string: lowercase host/protocol, original (normalized) path. */
function canonicalRemoteUrl(parsed: URL, host: string): string {
  const userinfo = parsed.username ? `${parsed.username}@` : '';
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${userinfo}${host}${port}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function parseRemoteUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw rejectedRepoUrl();
  }
  if (parsed.protocol === 'https:') {
    // No userinfo on https: credentials belong in a credential helper, not a URL.
    if (parsed.username || parsed.password) throw rejectedRepoUrl();
  } else if (parsed.protocol === 'ssh:') {
    // Only the conventional `git` ssh user (and no password) is accepted.
    if (parsed.username !== 'git' || parsed.password) throw rejectedRepoUrl();
  } else {
    throw rejectedRepoUrl();
  }
  if (!parsed.hostname) throw rejectedRepoUrl();
  return parsed;
}

/**
 * Validate + normalize a clone source. The RETURNED string is what must reach
 * git: URL forms are canonically rebuilt with a lowercase host (dot-segments
 * resolved by the URL parser), the scp form is rebuilt as `git@<host>:<path>`
 * with the host lowercased and the path preserved (git paths are case-sensitive).
 *
 * Rejected: backslashes, control chars, whitespace, `%2e`/`%2f` anywhere,
 * any userinfo except `git@` on ssh/scp, scp `..` traversal, non-allowlisted
 * hosts (exact match, no suffix/trailing-dot tricks).
 */
export function normalizeRepoUrl(raw: unknown, allowedHosts: ReadonlySet<string>): string {
  const url = String(raw ?? '').trim();
  if (!url || url.length > MAX_URL_LENGTH) throw rejectedRepoUrl();
  if (CONTROL_OR_BACKSLASH.test(url) || ENCODED_SEPARATOR.test(url) || WHITESPACE.test(url)) {
    throw rejectedRepoUrl();
  }
  const scp = SCP_URL.exec(url);
  if (scp) {
    const host = scp[1].toLowerCase();
    const repoPath = scp[2];
    if (!allowedHosts.has(host) || repoPath.includes('..')) throw rejectedRepoUrl();
    return `git@${host}:${repoPath}`;
  }
  const parsed = parseRemoteUrl(url);
  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.has(host)) throw rejectedRepoUrl();
  return canonicalRemoteUrl(parsed, host);
}
