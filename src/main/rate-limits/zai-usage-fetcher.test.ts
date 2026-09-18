import { beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import { fetchZaiRateLimits } from './zai-usage-fetcher'

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

// Shape mirrors the live /api/monitor/usage/quota/limit payload: a `limits`
// array of percentage buckets whose window length is only recoverable from
// the reset timestamp (sub-daily = 5h session, multi-day = weekly).
const HOUR_MS = 3_600_000

describe('fetchZaiRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-16T12:00:00.000Z'))
    netFetchMock.mockReset()
  })

  it('reports unavailable when no API key is configured', async () => {
    const result = await fetchZaiRateLimits('')
    expect(result.status).toBe('unavailable')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('sends the bare API key first and parses session + weekly windows', async () => {
    const now = Date.now()
    netFetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        planType: 'pro',
        limits: [
          { type: 'CREDIT_LIMIT', percentage: 42, resetTime: now + 3 * HOUR_MS },
          { type: 'CREDIT_LIMIT', percentage: 17, resetTime: now + 96 * HOUR_MS },
          { type: 'TIME_LIMIT', usage: 5, limit: 100 }
        ]
      })
    )

    const result = await fetchZaiRateLimits(' key-123 ')
    expect(netFetchMock).toHaveBeenCalledOnce()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: vi.mock call args are untyped; this test supplies the (url, init) shape itself.
    const [, init] = netFetchMock.mock.calls[0] as [URL, RequestInit]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: init.headers is a plain record in this test's own (url, init) call shape.
    expect((init.headers as Record<string, string>).Authorization).toBe('key-123')
    expect(result.status).toBe('ok')
    expect(result.provider).toBe('zai')
    expect(result.planType).toBe('pro')
    expect(result.session?.usedPercent).toBe(42)
    expect(result.weekly?.usedPercent).toBe(17)
  })

  it('falls back to the Bearer form after a 401', async () => {
    const now = Date.now()
    netFetchMock.mockResolvedValueOnce(makeJsonResponse({}, 401)).mockResolvedValueOnce(
      makeJsonResponse({
        limits: [{ type: 'TOKENS_LIMIT', percentage: 9, resetTime: now + HOUR_MS }]
      })
    )

    const result = await fetchZaiRateLimits('key-123')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: vi.mock call args are untyped; this test supplies the (url, init) shape itself.
    const secondAuth = (netFetchMock.mock.calls[1][1] as RequestInit).headers as Record<
      string,
      string
    >
    expect(secondAuth.Authorization).toBe('Bearer key-123')
    expect(result.session?.usedPercent).toBe(9)
  })

  it('reports an error when every auth attempt is rejected', async () => {
    netFetchMock.mockResolvedValue(makeJsonResponse({}, 401))
    const result = await fetchZaiRateLimits('key-123')
    expect(result.status).toBe('error')
    expect(netFetchMock).toHaveBeenCalledTimes(2)
  })

  it('errors on a payload without quota windows', async () => {
    netFetchMock.mockResolvedValueOnce(makeJsonResponse({ limits: [] }))
    const result = await fetchZaiRateLimits('key-123')
    expect(result.status).toBe('error')
  })
})
