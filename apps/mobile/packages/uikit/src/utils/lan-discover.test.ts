import { test } from "node:test"
import assert from "node:assert/strict"
import {
  hostsInSubnet24,
  isPrivateLanIpv4,
  probeServer,
  scanLanHosts,
  type LanCandidate,
} from "./lan-discover.ts"

test("only RFC1918 IPv4 counts as LAN", () => {
  assert.equal(isPrivateLanIpv4("192.168.1.5"), true)
  assert.equal(isPrivateLanIpv4("10.0.0.1"), true)
  assert.equal(isPrivateLanIpv4("172.16.0.1"), true)
  assert.equal(isPrivateLanIpv4("172.31.255.254"), true)
  assert.equal(isPrivateLanIpv4("8.8.8.8"), false)
  assert.equal(isPrivateLanIpv4("172.15.0.1"), false)
  assert.equal(isPrivateLanIpv4("172.32.0.1"), false)
  assert.equal(isPrivateLanIpv4("127.0.0.1"), false)
  assert.equal(isPrivateLanIpv4("::1"), false)
  assert.equal(isPrivateLanIpv4("not-an-ip"), false)
  assert.equal(isPrivateLanIpv4("192.168.1"), false)
  assert.equal(isPrivateLanIpv4("256.1.1.1"), false)
  assert.equal(isPrivateLanIpv4("192.168.01.5"), false)
  assert.equal(isPrivateLanIpv4(""), false)
})

test("subnet enumeration covers .1-.254 minus self, refuses off-LAN", () => {
  const hosts = hostsInSubnet24("192.168.1.5")
  assert.equal(hosts.length, 253)
  assert.equal(hosts[0], "192.168.1.1")
  assert.equal(hosts[hosts.length - 1], "192.168.1.254")
  assert.ok(!hosts.includes("192.168.1.5"))
  assert.ok(hosts.includes("192.168.1.4") && hosts.includes("192.168.1.6"))
  assert.deepEqual(hostsInSubnet24("8.8.8.8"), [])
  assert.deepEqual(hostsInSubnet24("garbage"), [])
})

const okFetch = (version = "1.2.3") =>
  (async () => ({ ok: true, status: 200, json: async () => ({ healthy: true, version }) })) as any

test("probe hits healthy, auth-gated, and misses", async () => {
  const hit = await probeServer("192.168.1.23", 4096, { fetchImpl: okFetch(), timeoutMs: 500 })
  assert.deepEqual(hit, {
    url: "http://192.168.1.23:4096",
    host: "192.168.1.23",
    port: 4096,
    version: "1.2.3",
    authRequired: false,
  })

  const authed = await probeServer("h", 4096, {
    fetchImpl: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as any,
    timeoutMs: 500,
  })
  assert.equal(authed?.authRequired, true)
  assert.equal(authed?.version, undefined)

  const miss = await probeServer("h", 4096, {
    fetchImpl: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any,
    timeoutMs: 500,
  })
  assert.equal(miss, null)

  const down = await probeServer("h", 4096, {
    fetchImpl: (async () => {
      throw new Error("refused")
    }) as any,
    timeoutMs: 500,
  })
  assert.equal(down, null)
})

test("probe times out instead of hanging", async () => {
  const hanging = ((_: string, init?: { signal?: AbortSignal }) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
    })) as any
  const started = Date.now()
  const res = await probeServer("h", 4096, { fetchImpl: hanging, timeoutMs: 50 })
  assert.equal(res, null)
  assert.ok(Date.now() - started < 1000, "probe must give up on timeout")
})

test("sweep finds only answering hosts, streams progress", async () => {
  const live = new Set(["192.168.7.2", "192.168.7.9"])
  const seen: LanCandidate[] = []
  const progress: Array<[number, number]> = []
  let inFlight = 0
  let maxInFlight = 0
  const found = await scanLanHosts(["192.168.7.1", "192.168.7.2", "192.168.7.3", "192.168.7.9"], 4096, {
    concurrency: 2,
    timeoutMs: 500,
    fetchImpl: (async (url: string) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      const host = new URL(url).hostname
      if (live.has(host)) return { ok: true, status: 200, json: async () => ({ version: "v" }) }
      throw new Error("refused")
    }) as any,
    onCandidate: (c) => seen.push(c),
    onProgress: (s, t) => progress.push([s, t]),
  })
  assert.deepEqual(
    found.map((c) => c.host).sort(),
    ["192.168.7.2", "192.168.7.9"],
  )
  assert.equal(seen.length, 2)
  assert.deepEqual(progress[progress.length - 1], [4, 4])
  assert.ok(maxInFlight <= 2, `concurrency bound respected, saw ${maxInFlight}`)
})

test("pre-aborted sweep probes nothing", async () => {
  let calls = 0
  const controller = new AbortController()
  controller.abort()
  const found = await scanLanHosts(["192.168.7.1"], 4096, {
    signal: controller.signal,
    timeoutMs: 500,
    fetchImpl: (async () => {
      calls++
      return { ok: true, status: 200, json: async () => ({}) }
    }) as any,
  })
  assert.deepEqual(found, [])
  assert.equal(calls, 0)
})
