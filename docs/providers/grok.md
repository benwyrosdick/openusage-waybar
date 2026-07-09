# Grok

Tracks Grok subscription usage via the same billing endpoint the Grok CLI uses.

> Reverse-engineered, undocumented API. May change without notice.

## Overview

- **Protocol:** REST (JSON)
- **Billing URL:** `https://cli-chat-proxy.grok.com/v1/billing?format=credits`
- **Settings URL:** `https://cli-chat-proxy.grok.com/v1/settings`
- **Auth:** OIDC tokens from Grok CLI (`~/.grok/auth.json`)
- **Token refresh:** `https://auth.x.ai/oauth2/token`
- **Client ID:** `b1a00492-073a-47ea-816f-4c329264a828`

## Authentication

### Credential Source

Sign in once with the Grok CLI (`grok login`). The plugin reads `~/.grok/auth.json` (or `$GROK_HOME/auth.json` when set).

Auth file shape (map of issuer::client_id → entry):

```json
{
  "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
    "key": "<access_token>",
    "refresh_token": "<refresh_token>",
    "expires_at": "2026-07-09T18:59:13.323266261Z",
    "oidc_client_id": "b1a00492-073a-47ea-816f-4c329264a828"
  }
}
```

Access tokens refresh automatically before expiry; rotated tokens are written back to the auth file.

### Request Headers

| Header | Value |
|---|---|
| Authorization | `Bearer <access_token>` |
| X-XAI-Token-Auth | `xai-grok-cli` |
| Accept | `application/json` |

## Data Source

### GET /v1/billing?format=credits

Returns the shared weekly usage pool and pay-as-you-go cap (proto-JSON; zero fields may be omitted).

#### Example Response

```json
{
  "config": {
    "creditUsagePercent": 16.0,
    "currentPeriod": {
      "type": "USAGE_PERIOD_TYPE_WEEKLY",
      "start": "2026-07-09T00:45:09.396485+00:00",
      "end": "2026-07-16T00:45:09.396485+00:00"
    },
    "onDemandCap": { "val": 0 },
    "isUnifiedBillingUser": true
  }
}
```

### GET /v1/settings

Used only for the plan name (`subscription_tier_display`). Failure does not fail the probe.

## Displayed Lines

| Line | Scope | Condition | Description |
|------|-------|-----------|-------------|
| Weekly | overview | `currentPeriod.type` is weekly | Shared weekly pool usage percent |
| Extra Usage | overview | always | Pay-as-you-go cap (`2500 cap`) or `Disabled` |

Weekly progress includes:

- `resetsAt` — period end ISO timestamp
- `periodDurationMs` — end − start

Accounts not yet on unified weekly billing omit the Weekly line (Extra Usage still shows).

## Plan Detection

From settings `subscription_tier_display` (e.g. `SuperGrok`). Optional; null when settings fail.

## Errors

| Condition | Message |
|-----------|---------|
| Missing / invalid auth | "Not logged in. Run `grok login` to authenticate." |
| 401/403 after refresh | "Session expired. Run `grok login` to authenticate." |
| Non-2xx billing | "Usage request failed (HTTP {status}). Try again later." |
| Unparseable billing | "Usage response invalid. Try again later." |
| Network error | "Usage request failed. Check your connection." |
