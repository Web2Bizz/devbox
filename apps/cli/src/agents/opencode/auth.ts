// agents/opencode/auth — auth.json key resolution + diagnostics (no values logged).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MISSING_KEY_MESSAGE } from "./constants.js";

/** Auth file path ($HOME/.local/share/opencode/auth.json, XDG_DATA_HOME override). */
export function opencodeAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.XDG_DATA_HOME ?? "").trim();
  const dataDir = override || path.join(os.homedir(), ".local", "share");
  return path.join(dataDir, "opencode", "auth.json");
}

/**
 * Key file diagnostics WITHOUT the value (safe for errorBox/logs).
 * Probes the same-uid read before any fetch: stat perms/owner + trial
 * read (only len, never the key). EACCES/parse → exists=false + reason.
 */
export type OpencodeKeyInfo = {
  path: string;
  exists: boolean;
  /** Key length only (never the value). 0 when missing/unreadable. */
  keyLen: number;
  /** Octal perms like "600" (empty when unknown). */
  modeOct: string;
  /** File owner uid (-1 when unknown). */
  uid: number;
  /** True when file uid matches current process uid. */
  sameUid: boolean;
  reason?: string;
};

export function getOpencodeKeyInfo(env: NodeJS.ProcessEnv = process.env): OpencodeKeyInfo {
  const authPath = opencodeAuthPath(env);
  const base: OpencodeKeyInfo = {
    path: authPath,
    exists: false,
    keyLen: 0,
    modeOct: "",
    uid: -1,
    sameUid: false,
  };
  let stat: { mode: number; uid: number } | null = null;
  try {
    const st = fs.statSync(authPath);
    stat = { mode: st.mode, uid: typeof st.uid === "number" ? st.uid : -1 };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    return { ...base, reason: code === "EACCES" ? `EACCES uid=${process.getuid?.() ?? -1}` : code };
  }
  const modeOct = stat ? (stat.mode & 0o777).toString(8) : "";
  const uid = stat?.uid ?? -1;
  const ownUid = typeof process.getuid === "function" ? process.getuid() : -1;
  const sameUid = ownUid === -1 || uid === -1 ? true : uid === ownUid;
  let raw = "";
  try {
    raw = fs.readFileSync(authPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    return { ...base, modeOct, uid, sameUid, reason: code };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ...base, modeOct, uid, sameUid, reason: "parse-error" };
  }
  const record = (parsed ?? {}) as Record<string, { key?: unknown } | undefined>;
  const candidate = record?.["opencode-go"]?.key ?? record?.opencode?.key ?? "";
  if (typeof candidate === "string" && candidate.trim()) {
    return { path: authPath, exists: true, keyLen: candidate.trim().length, modeOct, uid, sameUid };
  }
  return { ...base, modeOct, uid, sameUid, reason: "empty-key" };
}

/** One-line key_source for errorBox (no value, only len + file attrs). */
export function formatKeySource(info: OpencodeKeyInfo): string {
  const perms = info.modeOct || "?";
  const uid = info.uid === -1 ? "?" : String(info.uid);
  return `key_source=auth.json path=${info.path} perms=${perms} uid=${uid} uid_match=${info.sameUid ? "yes" : "no"} key_len=${info.keyLen}`;
}

/**
 * Resolve the cloud key or throw fail-fast (never returns empty, never logs
 * the value). Chat REQUIRES this key — the Go subscription is billed by key
 * (same key as /connect, auth.json ONLY — env key vars are never read).
 * env is used ONLY for XDG_DATA_HOME path override, never for the key value.
 * Signature getOpencodeKey(env?) kept for CLI compat; key vars ignored.
 * Probes same-uid read first (stat perms/owner + trial read, len only):
 * EACCES/parse → missing with path.
 */
export function getOpencodeKey(env: NodeJS.ProcessEnv = process.env): string {
  const authPath = opencodeAuthPath(env);
  try {
    fs.statSync(authPath);
  } catch {
    throw new Error(`${MISSING_KEY_MESSAGE} path=${authPath}`);
  }
  let raw = "";
  try {
    raw = fs.readFileSync(authPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "read-error";
    throw new Error(`${MISSING_KEY_MESSAGE} path=${authPath} reason=${code}`);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${MISSING_KEY_MESSAGE} path=${authPath} reason=parse-error`);
  }
  const record = (parsed ?? {}) as Record<string, { key?: unknown } | undefined>;
  const candidate = record?.["opencode-go"]?.key ?? record?.opencode?.key ?? "";
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  throw new Error(`${MISSING_KEY_MESSAGE} path=${authPath} reason=empty-key`);
}

/** True when a cloud key resolves (auth.json only), false otherwise (no throw). */
export function hasOpencodeKey(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return getOpencodeKey(env).length > 0;
  } catch {
    return false;
  }
}
