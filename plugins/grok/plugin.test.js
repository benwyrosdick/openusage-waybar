import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const AUTH_PATH = "~/.grok/auth.json"
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const ENTRY_KEY = "https://auth.x.ai::" + CLIENT_ID

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

function makeAuth(overrides = {}) {
  const entry = Object.assign(
    {
      key: "access-token",
      refresh_token: "refresh-token",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      oidc_client_id: CLIENT_ID,
    },
    overrides
  )
  return { [ENTRY_KEY]: entry }
}

const CREDITS_WEEKLY = {
  config: {
    creditUsagePercent: 16.0,
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-07-09T00:45:09.396485+00:00",
      end: "2026-07-16T00:45:09.396485+00:00",
    },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    isUnifiedBillingUser: true,
  },
}

const CREDITS_WITH_CAP = {
  config: {
    creditUsagePercent: 42.5,
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: "2026-07-09T00:45:09.396485+00:00",
      end: "2026-07-16T00:45:09.396485+00:00",
    },
    onDemandCap: { val: 2500 },
    isUnifiedBillingUser: true,
  },
}

const CREDITS_MONTHLY = {
  config: {
    creditUsagePercent: 10,
    currentPeriod: {
      type: "USAGE_PERIOD_TYPE_MONTHLY",
      start: "2026-07-01T00:00:00Z",
      end: "2026-08-01T00:00:00Z",
    },
    onDemandCap: { val: 100 },
  },
}

const SETTINGS = { subscription_tier_display: "SuperGrok" }

function mockHttp(ctx, opts = {}) {
  const credits = opts.credits !== undefined ? opts.credits : CREDITS_WEEKLY
  const settings = opts.settings !== undefined ? opts.settings : SETTINGS
  const refreshBody = opts.refreshBody
  const creditsStatus = opts.creditsStatus || 200
  const refreshStatus = opts.refreshStatus || 200

  ctx.host.http.request.mockImplementation((req) => {
    const url = String(req.url)
    if (url.includes("/oauth2/token")) {
      if (opts.refreshThrow) throw new Error("network")
      return {
        status: refreshStatus,
        bodyText:
          refreshBody !== undefined
            ? refreshBody
            : JSON.stringify({
                access_token: "new-access-token",
                refresh_token: "new-refresh-token",
                expires_in: 3600,
              }),
      }
    }
    if (url.includes("billing")) {
      if (opts.creditsThrow) throw new Error("ECONNREFUSED")
      if (typeof credits === "string") {
        return { status: creditsStatus, bodyText: credits }
      }
      return { status: creditsStatus, bodyText: JSON.stringify(credits) }
    }
    if (url.includes("settings")) {
      if (opts.settingsThrow) throw new Error("timeout")
      if (opts.settingsStatus) {
        return { status: opts.settingsStatus, bodyText: JSON.stringify(settings || {}) }
      }
      return { status: 200, bodyText: JSON.stringify(settings || {}) }
    }
    return { status: 500, bodyText: "" }
  })
}

describe("grok plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("throws when auth file is missing", async () => {
    const ctx = makeCtx()
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Not logged in")
  })

  it("throws when auth has no access token", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify({ [ENTRY_KEY]: { refresh_token: "r" } }))
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Not logged in")
  })

  it("renders weekly usage and disabled extra usage", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify(makeAuth()))
    mockHttp(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("SuperGrok")
    const weekly = result.lines.find((l) => l.label === "Weekly")
    expect(weekly).toBeTruthy()
    expect(weekly.type).toBe("progress")
    expect(weekly.used).toBe(16)
    expect(weekly.limit).toBe(100)
    expect(weekly.format).toEqual({ kind: "percent" })
    expect(weekly.resetsAt).toBe(new Date("2026-07-16T00:45:09.396485+00:00").toISOString())
    expect(weekly.periodDurationMs).toBe(7 * 24 * 60 * 60 * 1000)

    const extra = result.lines.find((l) => l.label === "Extra Usage")
    expect(extra).toBeTruthy()
    expect(extra.type).toBe("badge")
    expect(extra.text).toBe("Disabled")
    expect(extra.color).toBe("#a3a3a3")
  })

  it("shows pay-as-you-go cap when enabled", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify(makeAuth()))
    mockHttp(ctx, { credits: CREDITS_WITH_CAP })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    const extra = result.lines.find((l) => l.label === "Extra Usage")
    expect(extra.text).toBe("2500 cap")
    expect(extra.color).toBe("#22c55e")
    expect(result.lines.find((l) => l.label === "Weekly").used).toBe(42.5)
  })

  it("omits weekly when period is not weekly", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify(makeAuth()))
    mockHttp(ctx, { credits: CREDITS_MONTHLY })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((l) => l.label === "Weekly")).toBeUndefined()
    const extra = result.lines.find((l) => l.label === "Extra Usage")
    expect(extra.text).toBe("100 cap")
  })

  it("treats missing creditUsagePercent as 0%", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify(makeAuth()))
    const body = {
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-09T00:00:00Z",
          end: "2026-07-16T00:00:00Z",
        },
      },
    }
    mockHttp(ctx, { credits: body })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((l) => l.label === "Weekly").used).toBe(0)
  })

  it("refreshes expired token and persists new credentials", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(
      AUTH_PATH,
      JSON.stringify(
        makeAuth({
          key: "old-token",
          expires_at: new Date(Date.now() - 1000).toISOString(),
        })
      )
    )
    mockHttp(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((l) => l.label === "Weekly")).toBeTruthy()

    const persisted = JSON.parse(ctx.host.fs.readText(AUTH_PATH))
    expect(persisted[ENTRY_KEY].key).toBe("new-access-token")
    expect(persisted[ENTRY_KEY].refresh_token).toBe("new-refresh-token")
  })

  it("retries billing once on 401 by refreshing token", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify(makeAuth()))

    let billingCalls = 0
    ctx.host.http.request.mockImplementation((req) => {
      const url = String(req.url)
      if (url.includes("/oauth2/token")) {
        return {
          status: 200,
          bodyText: JSON.stringify({
            access_token: "token-2",
            refresh_token: "refresh-2",
            expires_in: 3600,
          }),
        }
      }
      if (url.includes("billing")) {
        billingCalls += 1
        if (billingCalls === 1) return { status: 401, bodyText: "" }
        return { status: 200, bodyText: JSON.stringify(CREDITS_WEEKLY) }
      }
      if (url.includes("settings")) {
        return { status: 200, bodyText: JSON.stringify(SETTINGS) }
      }
      return { status: 500, bodyText: "" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(billingCalls).toBe(2)
    expect(result.lines.find((l) => l.label === "Weekly")).toBeTruthy()
  })

  it("throws session expired when refresh is unauthorized", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(
      AUTH_PATH,
      JSON.stringify(makeAuth({ expires_at: new Date(Date.now() - 1000).toISOString() }))
    )
    mockHttp(ctx, { refreshStatus: 401 })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Session expired")
  })

  it("throws on invalid billing payload", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify(makeAuth()))
    mockHttp(ctx, { credits: "not-json" })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Usage response invalid")
  })

  it("throws on HTTP 500 from billing", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify(makeAuth()))
    mockHttp(ctx, { creditsStatus: 500, credits: {} })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("HTTP 500")
  })

  it("throws on network exception", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify(makeAuth()))
    mockHttp(ctx, { creditsThrow: true })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Usage request failed. Check your connection.")
  })

  it("uses GROK_HOME auth path when set", async () => {
    const ctx = makeCtx()
    ctx.host.env.get.mockImplementation((name) => (name === "GROK_HOME" ? "/tmp/grok-home" : null))
    ctx.host.fs.writeText("/tmp/grok-home/auth.json", JSON.stringify(makeAuth()))
    mockHttp(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines.find((l) => l.label === "Weekly")).toBeTruthy()
  })

  it("continues when settings fetch fails", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify(makeAuth()))
    mockHttp(ctx, { settingsThrow: true })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.plan).toBeNull()
    expect(result.lines.find((l) => l.label === "Weekly")).toBeTruthy()
  })

  it("sends X-XAI-Token-Auth header on billing request", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(AUTH_PATH, JSON.stringify(makeAuth()))
    mockHttp(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const billingCall = ctx.host.http.request.mock.calls.find((c) =>
      String(c[0].url).includes("billing")
    )
    expect(billingCall[0].headers["X-XAI-Token-Auth"]).toBe("xai-grok-cli")
    expect(billingCall[0].headers.Authorization).toBe("Bearer access-token")
  })

  it("treats malformed auth file as not logged in", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText(AUTH_PATH, "{")
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Not logged in")
  })
})
