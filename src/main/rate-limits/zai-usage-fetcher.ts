import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const ZAI_BASE_URL = 'https://api.z.ai'
const ZAI_QUOTA_LIMIT_PATH = '/api/monitor/usage/quota/limit'
const API_TIMEOUT_MS = 15_000
const SESSION_WINDOW_MAX_HOURS = 12

type ZaiQuotaLimitEntry = {
  type?: string
  percentage?: number
  currentValue?: number
  usage?: number
  limit?: number
  resetTime?: number
  nextResetTime?: number
  resetTimestamp?: number
}

type ZaiQuotaLimitResponse = {
  planType?: string
  plan_type?: string
  limits?: ZaiQuotaLimitEntry[]
}

function makeWindow(
  usedPercent: number,
  resetsAt: number | null,
  windowMinutes: number
): RateLimitWindow | null {
  if (!Number.isFinite(usedPercent)) {
    return null
  }
  return {
    usedPercent,
    windowMinutes,
    resetsAt: resetsAt ?? Date.now() + windowMinutes * 60_000,
    resetDescription: null
  }
}

function entryResetMs(entry: ZaiQuotaLimitEntry): number | null {
  for (const candidate of [entry.resetTime, entry.nextResetTime, entry.resetTimestamp]) {
    if (typeof candidate === 'number' && candidate > 0) {
      // Epoch-ms per the observed API contract; seconds-scaled values are normalized.
      return candidate > 1e12 ? candidate : candidate * 1000
    }
  }
  return null
}

function entryUsedPercent(entry: ZaiQuotaLimitEntry): number | null {
  if (typeof entry.percentage === 'number') {
    return entry.percentage
  }
  if (typeof entry.usage === 'number' && typeof entry.limit === 'number' && entry.limit > 0) {
    return (entry.usage / entry.limit) * 100
  }
  return null
}

/** Why: the endpoint returns quota buckets of mixed window lengths with no explicit meter field. */
function classifyQuotaEntries(
  entries: ZaiQuotaLimitEntry[],
  now: number
): {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
} {
  let session: RateLimitWindow | null = null
  let weekly: RateLimitWindow | null = null
  for (const entry of entries) {
    const type = entry.type ?? ''
    if (type !== 'CREDIT_LIMIT' && type !== 'TOKENS_LIMIT') {
      continue
    }
    const usedPercent = entryUsedPercent(entry)
    if (usedPercent === null) {
      continue
    }
    const resetMs = entryResetMs(entry)
    const hoursToReset = resetMs !== null ? (resetMs - now) / 3_600_000 : 5
    const isSessionWindow = hoursToReset < SESSION_WINDOW_MAX_HOURS
    const window = makeWindow(usedPercent, resetMs, isSessionWindow ? 300 : 10_080)
    if (isSessionWindow) {
      session ??= window
    } else {
      weekly ??= window
    }
  }
  return { session, weekly }
}

function makeZaiError(error: string, status: 'error' | 'unavailable'): ProviderRateLimits {
  return {
    provider: 'zai',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status
  }
}

/**
 * Why: the Z.ai quota endpoint only accepts the bare API key in the Authorization
 * header on the first attempt — a "Bearer" prefix is rejected — but 401 falls back
 * to the standard Bearer form for forward compatibility.
 */
export async function fetchZaiRateLimits(apiKey: string): Promise<ProviderRateLimits> {
  const trimmedKey = apiKey.trim()
  if (!trimmedKey) {
    return makeZaiError('Z.ai API key not configured', 'unavailable')
  }

  const quotaUrl = new URL(ZAI_QUOTA_LIMIT_PATH, ZAI_BASE_URL)
  // Why: SSRF fence — the URL is built from constants, but the check keeps the
  // contract explicit if the base URL ever becomes configurable.
  if (quotaUrl.protocol !== 'https:' || quotaUrl.hostname !== 'api.z.ai') {
    return makeZaiError('Refusing non-public Z.ai endpoint', 'error')
  }

  const authAttempts = [trimmedKey, `Bearer ${trimmedKey}`]
  let lastStatus: number | null = null
  for (const authorization of authAttempts) {
    let response: Response
    try {
      response = await net.fetch(quotaUrl.toString(), {
        method: 'GET',
        headers: {
          Authorization: authorization,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      })
    } catch (error) {
      return makeZaiError(error instanceof Error ? error.message : 'Unknown error', 'error')
    }

    if (response.status === 401) {
      lastStatus = response.status
      continue
    }
    if (!response.ok) {
      return makeZaiError(`Quota fetch failed (${response.status})`, 'error')
    }

    let payload: ZaiQuotaLimitResponse
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: response.json() returns any; the payload shape is validated field-by-field below before use.
      const body = (await response.json()) as ZaiQuotaLimitResponse & {
        data?: ZaiQuotaLimitResponse
      }
      // The endpoint wraps the payload in `data` on some deployments.
      payload = body.data ?? body
    } catch (error) {
      return makeZaiError(error instanceof Error ? error.message : 'Invalid JSON response', 'error')
    }

    const entries = Array.isArray(payload.limits) ? payload.limits : []
    if (entries.length === 0) {
      return makeZaiError('Quota response contained no limit windows', 'error')
    }
    const { session, weekly } = classifyQuotaEntries(entries, Date.now())
    if (!session && !weekly) {
      return makeZaiError('Could not parse quota windows from response', 'error')
    }
    return {
      provider: 'zai',
      session,
      weekly,
      planType: payload.planType ?? payload.plan_type ?? null,
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
  }

  return makeZaiError(`Z.ai rejected the API key (HTTP ${lastStatus})`, 'error')
}
