(function () {
  const AUTH_FILE = "auth.json"
  const DEFAULT_AUTH_DIR = "~/.grok"
  const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
  const REFRESH_URL = "https://auth.x.ai/oauth2/token"
  const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
  const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings"
  const TOKEN_AUTH_HEADER = "xai-grok-cli"
  const REFRESH_BUFFER_MS = 5 * 60 * 1000
  const WEEKLY_PERIOD_TYPE = "USAGE_PERIOD_TYPE_WEEKLY"
  const LOGIN_HINT = "Run `grok login` to authenticate."

  function joinPath(base, leaf) {
    return String(base).replace(/[\\/]+$/, "") + "/" + leaf
  }

  function readNumber(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  function clampPercent(value) {
    const n = readNumber(value)
    if (n === null) return null
    return Math.round(Math.max(0, Math.min(100, n)) * 10) / 10
  }

  function trimmed(value) {
    if (typeof value !== "string") return null
    const t = value.trim()
    return t || null
  }

  function authPath(ctx) {
    let home = null
    if (ctx.host.env && typeof ctx.host.env.get === "function") {
      try {
        const value = ctx.host.env.get("GROK_HOME")
        if (typeof value === "string" && value.trim()) home = value.trim()
      } catch (e) {
        ctx.host.log.warn("GROK_HOME read failed: " + String(e))
      }
    }
    return joinPath(home || DEFAULT_AUTH_DIR, AUTH_FILE)
  }

  function loadCandidates(ctx) {
    const path = authPath(ctx)
    if (!ctx.host.fs.exists(path)) {
      ctx.host.log.warn("auth file not found: " + path)
      return null
    }
    let auth
    try {
      auth = ctx.util.tryParseJson(ctx.host.fs.readText(path))
    } catch (e) {
      ctx.host.log.warn("auth read failed: " + String(e))
      return null
    }
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
      ctx.host.log.warn("auth file is not a valid object")
      return null
    }

    const candidates = []
    const keys = Object.keys(auth)
    for (let i = 0; i < keys.length; i += 1) {
      const entryKey = keys[i]
      const entry = auth[entryKey]
      if (!entry || typeof entry !== "object") continue
      const token = trimmed(entry.key)
      if (!token) continue
      candidates.push({ path, auth, entryKey, entry, token })
    }
    return candidates.length ? candidates : null
  }

  function entryRefreshToken(entry) {
    return trimmed(entry && entry.refresh_token) || trimmed(entry && entry.refresh)
  }

  function entryClientId(entryKey, entry) {
    const fromEntry = trimmed(entry && entry.oidc_client_id)
    if (fromEntry) return fromEntry
    const parts = String(entryKey || "").split("::")
    if (parts.length > 1) {
      const last = trimmed(parts[parts.length - 1])
      if (last) return last
    }
    return DEFAULT_CLIENT_ID
  }

  function tokenExpiresAtMs(ctx, token) {
    const payload = ctx.jwt.decodePayload(token)
    if (!payload || typeof payload.exp !== "number") return null
    return payload.exp * 1000
  }

  function entryExpiresAtMs(ctx, entry) {
    const raw = trimmed(entry && entry.expires_at) || trimmed(entry && entry.expires)
    return raw ? ctx.util.parseDateMs(raw) : null
  }

  function needsRefresh(ctx, entry, token, nowMs) {
    const entryExp = entryExpiresAtMs(ctx, entry)
    const tokenExp = tokenExpiresAtMs(ctx, token)
    const entryNeeds =
      entryExp !== null &&
      ctx.util.needsRefreshByExpiry({ nowMs, expiresAtMs: entryExp, bufferMs: REFRESH_BUFFER_MS })
    const tokenNeeds =
      tokenExp !== null &&
      ctx.util.needsRefreshByExpiry({ nowMs, expiresAtMs: tokenExp, bufferMs: REFRESH_BUFFER_MS })
    return entryNeeds || tokenNeeds
  }

  function isExpired(ctx, entry, token, nowMs) {
    const tokenExp = tokenExpiresAtMs(ctx, token)
    const exp = tokenExp !== null ? tokenExp : entryExpiresAtMs(ctx, entry)
    return exp !== null && nowMs >= exp
  }

  function saveAuthEntry(ctx, state) {
    try {
      let authObject = state.auth
      if (ctx.host.fs.exists(state.path)) {
        const parsed = ctx.util.tryParseJson(ctx.host.fs.readText(state.path))
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("auth file unreadable")
        }
        authObject = parsed
      }
      const entryObject =
        authObject[state.entryKey] && typeof authObject[state.entryKey] === "object"
          ? Object.assign({}, authObject[state.entryKey])
          : {}
      entryObject.key = state.entry.key
      if (state.entry.refresh_token) entryObject.refresh_token = state.entry.refresh_token
      if (state.entry.id_token) entryObject.id_token = state.entry.id_token
      if (state.entry.expires_at) entryObject.expires_at = state.entry.expires_at
      authObject[state.entryKey] = entryObject
      ctx.host.fs.writeText(state.path, JSON.stringify(authObject, null, 2))
    } catch (e) {
      ctx.host.log.warn("failed to persist auth: " + String(e))
    }
  }

  function refreshAccessToken(ctx, state) {
    const refreshToken = entryRefreshToken(state.entry)
    if (!refreshToken) {
      ctx.host.log.warn("refresh skipped: no refresh token")
      return null
    }

    ctx.host.log.info("attempting token refresh")
    let resp
    try {
      resp = ctx.util.request({
        method: "POST",
        url: REFRESH_URL,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        bodyText:
          "grant_type=refresh_token" +
          "&client_id=" +
          encodeURIComponent(entryClientId(state.entryKey, state.entry)) +
          "&refresh_token=" +
          encodeURIComponent(refreshToken),
        timeoutMs: 15000,
      })
    } catch (e) {
      ctx.host.log.error("refresh exception: " + String(e))
      return null
    }

    if (ctx.util.isAuthStatus(resp.status)) throw "Session expired. " + LOGIN_HINT
    if (resp.status < 200 || resp.status >= 300) {
      ctx.host.log.warn("refresh returned unexpected status: " + resp.status)
      return null
    }

    const body = ctx.util.tryParseJson(resp.bodyText)
    if (!body || !body.access_token) {
      ctx.host.log.warn("refresh response missing access_token")
      return null
    }

    state.entry.key = body.access_token
    state.token = body.access_token
    if (body.refresh_token) state.entry.refresh_token = body.refresh_token
    if (body.id_token) state.entry.id_token = body.id_token

    if (typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0) {
      state.entry.expires_at = new Date(Date.now() + body.expires_in * 1000).toISOString()
    } else {
      const tokenExp = tokenExpiresAtMs(ctx, body.access_token)
      state.entry.expires_at = new Date(
        tokenExp !== null ? tokenExp : Date.now() + 60 * 60 * 1000
      ).toISOString()
    }

    saveAuthEntry(ctx, state)
    return state.token
  }

  function authHeaders(accessToken) {
    return {
      Authorization: "Bearer " + String(accessToken).trim(),
      "X-XAI-Token-Auth": TOKEN_AUTH_HEADER,
      Accept: "application/json",
      "User-Agent": "OpenUsage",
    }
  }

  function fetchCreditsConfig(ctx, accessToken) {
    return ctx.util.request({
      method: "GET",
      url: CREDITS_URL,
      headers: authHeaders(accessToken),
      timeoutMs: 10000,
    })
  }

  function fetchPlan(ctx, accessToken) {
    try {
      const resp = ctx.util.request({
        method: "GET",
        url: SETTINGS_URL,
        headers: authHeaders(accessToken),
        timeoutMs: 10000,
      })
      if (resp.status < 200 || resp.status >= 300) {
        ctx.host.log.warn("settings request failed: HTTP " + resp.status)
        return null
      }
      const settings = ctx.util.tryParseJson(resp.bodyText)
      return settings && typeof settings === "object"
        ? trimmed(settings.subscription_tier_display)
        : null
    } catch (e) {
      ctx.host.log.warn("settings request exception: " + String(e))
      return null
    }
  }

  function formatUnits(value) {
    if (Math.round(value) === value) return String(Math.round(value))
    return String(value)
  }

  function parseCreditsConfig(ctx, data) {
    if (!data || typeof data !== "object") return null
    const config = data.config
    if (!config || typeof config !== "object") return null
    const period = config.currentPeriod
    if (!period || typeof period !== "object") return null

    const periodType = trimmed(period.type)
    if (!periodType) return null
    const startMs = ctx.util.parseDateMs(period.start)
    const endMs = ctx.util.parseDateMs(period.end)
    if (startMs === null || endMs === null || endMs <= startMs) return null

    // proto-JSON omits zero-valued fields
    let usedPercent = 0
    if (config.creditUsagePercent !== undefined && config.creditUsagePercent !== null) {
      usedPercent = readNumber(config.creditUsagePercent)
      if (usedPercent === null) return null
    }

    let onDemandCap = 0
    if (config.onDemandCap !== undefined && config.onDemandCap !== null) {
      if (typeof config.onDemandCap !== "object") return null
      const cap = readNumber(config.onDemandCap.val)
      if (cap === null) return null
      onDemandCap = cap
    }

    return {
      periodType,
      usedPercent,
      periodEnd: endMs,
      periodDurationMs: Math.round(endMs - startMs),
      onDemandCap,
    }
  }

  function buildLines(ctx, credits) {
    const lines = []
    if (credits.periodType === WEEKLY_PERIOD_TYPE) {
      const used = clampPercent(credits.usedPercent)
      if (used !== null) {
        lines.push(
          ctx.line.progress({
            label: "Weekly",
            used,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: new Date(credits.periodEnd).toISOString(),
            periodDurationMs: credits.periodDurationMs,
          })
        )
      }
    }

    const cap = credits.onDemandCap
    lines.push(
      ctx.line.badge({
        label: "Extra Usage",
        text: cap > 0 ? formatUnits(cap) + " cap" : "Disabled",
        color: cap > 0 ? "#22c55e" : "#a3a3a3",
      })
    )
    return lines
  }

  function probeWithToken(ctx, state, accessToken) {
    let didRefresh = false
    let token = accessToken
    let resp
    try {
      resp = ctx.util.retryOnceOnAuth({
        request: function (t) {
          return fetchCreditsConfig(ctx, t || token)
        },
        refresh: function () {
          didRefresh = true
          const refreshed = refreshAccessToken(ctx, state)
          if (refreshed) token = refreshed
          return refreshed
        },
      })
    } catch (e) {
      if (typeof e === "string") throw e
      if (didRefresh) throw "Usage request failed after refresh. Try again."
      throw "Usage request failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(resp.status)) throw "Session expired. " + LOGIN_HINT
    if (resp.status < 200 || resp.status >= 300) {
      throw "Usage request failed (HTTP " + String(resp.status) + "). Try again later."
    }

    const credits = parseCreditsConfig(ctx, ctx.util.tryParseJson(resp.bodyText))
    if (!credits) throw "Usage response invalid. Try again later."

    const lines = buildLines(ctx, credits)
    if (!lines.length) {
      lines.push(ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" }))
    }
    return { plan: fetchPlan(ctx, token), lines }
  }

  function probe(ctx) {
    const candidates = loadCandidates(ctx)
    if (!candidates) throw "Not logged in. " + LOGIN_HINT

    const nowMs = Date.now()
    let sawExpired = false

    for (let i = 0; i < candidates.length; i += 1) {
      const state = candidates[i]
      let accessToken = state.token

      if (needsRefresh(ctx, state.entry, accessToken, nowMs)) {
        const refreshed = refreshAccessToken(ctx, state)
        if (refreshed) return probeWithToken(ctx, state, refreshed)
        if (isExpired(ctx, state.entry, accessToken, nowMs)) {
          sawExpired = true
          continue
        }
      }

      return probeWithToken(ctx, state, accessToken)
    }

    if (sawExpired) throw "Session expired. " + LOGIN_HINT
    throw "Auth invalid. " + LOGIN_HINT
  }

  globalThis.__openusage_plugin = { id: "grok", probe }
})()
