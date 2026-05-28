import { describe, expect, it, vi } from 'vitest';
import { createSessionAwareClientFetch } from './session-aware-client-fetch.js';

function jsonResponse(payload: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(headers || {}),
    },
  });
}

describe('createSessionAwareClientFetch', () => {
  it('stores initialize clientSessionId and injects it into tools/call', async () => {
    const requests: Array<{ method?: string; body?: Record<string, unknown> }> = [];
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      requests.push({ method: body?.method as string | undefined, body });

      if (body?.method === 'initialize') {
        return jsonResponse({ result: { session: { clientSessionId: 'client-session-1234' } } });
      }
      if (body?.method === 'tools/call') {
        return jsonResponse({ result: { ok: true } });
      }
      return jsonResponse({ result: {} });
    });

    const wrapped = createSessionAwareClientFetch({
      serverName: 'datakimia-portal-mcp',
      requestInitHeaders: { Accept: 'application/json' },
      baseFetch,
      getMcpSessionId: () => undefined,
      setMcpSessionId: () => {},
    });

    await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'navigate_to_page', arguments: { url: 'https://example.com' } },
      }),
    });

    expect(requests[1].method).toBe('tools/call');
    expect(
      ((requests[1].body?.params as Record<string, unknown>).arguments as Record<string, unknown>)
        .clientSessionId
    ).toBe('client-session-1234');
  });

  it('overrides model-provided clientSessionId with initialize session id', async () => {
    const requests: Array<{ method?: string; body?: Record<string, unknown> }> = [];
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      requests.push({ method: body?.method as string | undefined, body });

      if (body?.method === 'initialize') {
        return jsonResponse({ result: { session: { clientSessionId: 'client-session-real' } } });
      }
      if (body?.method === 'tools/call') {
        return jsonResponse({ result: { ok: true } });
      }
      return jsonResponse({ result: {} });
    });

    const wrapped = createSessionAwareClientFetch({
      serverName: 'datakimia-portal-mcp',
      requestInitHeaders: { Accept: 'application/json' },
      baseFetch,
      getMcpSessionId: () => undefined,
      setMcpSessionId: () => {},
    });

    await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'navigate_to_page',
          arguments: { url: 'https://example.com', clientSessionId: 'test_session_id' },
        },
      }),
    });

    expect(requests[1].method).toBe('tools/call');
    expect(
      ((requests[1].body?.params as Record<string, unknown>).arguments as Record<string, unknown>)
        .clientSessionId
    ).toBe('client-session-real');
  });

  it('reinitializes once and retries tools/call on missing-session error', async () => {
    let toolCallAttempt = 0;
    const methods: string[] = [];
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      const method = body?.method as string | undefined;
      methods.push(method || '<unknown>');

      if (method === 'initialize') {
        return jsonResponse({ result: { session: { clientSessionId: 'client-session-reinit' } } });
      }
      if (method === 'tools/call') {
        toolCallAttempt++;
        if (toolCallAttempt === 1) {
          return jsonResponse({
            error: { code: -32603, message: 'clientSessionId is required' },
          });
        }
        const args = ((body?.params as Record<string, unknown>).arguments || {}) as Record<
          string,
          unknown
        >;
        return jsonResponse({
          result: { ok: true, receivedClientSessionId: args.clientSessionId },
        });
      }
      return jsonResponse({ result: {} });
    });

    const wrapped = createSessionAwareClientFetch({
      serverName: 'datakimia-portal-mcp',
      requestInitHeaders: { Accept: 'application/json' },
      baseFetch,
      getMcpSessionId: () => undefined,
      setMcpSessionId: () => {},
    });

    await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });

    const response = await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'navigate_to_page', arguments: { url: 'https://example.com' } },
      }),
    });

    const payload = await response.json();
    expect(payload.result.ok).toBe(true);
    expect(payload.result.receivedClientSessionId).toBe('client-session-reinit');
    expect(methods).toEqual(['initialize', 'tools/call', 'initialize', 'tools/call']);
  });

  it('retries tools/call with default initialize template when no initialize request was captured', async () => {
    let toolCallAttempt = 0;
    const methods: string[] = [];
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      const method = body?.method as string | undefined;
      methods.push(method || '<unknown>');

      if (method === 'initialize') {
        return jsonResponse({
          result: { session: { clientSessionId: 'default-template-session' } },
        });
      }
      if (method === 'tools/call') {
        toolCallAttempt++;
        if (toolCallAttempt === 1) {
          return jsonResponse({
            error: { code: -32603, message: 'clientSessionId is required' },
          });
        }
        const args = ((body?.params as Record<string, unknown>).arguments || {}) as Record<
          string,
          unknown
        >;
        return jsonResponse({
          result: { ok: true, receivedClientSessionId: args.clientSessionId },
        });
      }
      return jsonResponse({ result: {} });
    });

    const wrapped = createSessionAwareClientFetch({
      serverName: 'datakimia-portal-mcp',
      requestInitHeaders: { Accept: 'application/json' },
      baseFetch,
      getMcpSessionId: () => undefined,
      setMcpSessionId: () => {},
      forceClientSessionIdInjection: true,
    });

    const response = await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'navigate_to_page', arguments: { url: 'https://example.com' } },
      }),
    });

    const payload = await response.json();
    expect(payload.result.ok).toBe(true);
    expect(payload.result.receivedClientSessionId).toBe('default-template-session');
    expect(methods).toEqual(['initialize', 'tools/call', 'initialize', 'tools/call']);
  });

  it('does not inject clientSessionId for non-session servers', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      requestBodies.push(body);
      if (body.method === 'initialize') {
        return jsonResponse({ result: {} });
      }
      if (body.method === 'tools/list') {
        return jsonResponse({
          result: {
            tools: [{ name: 'plain_tool', inputSchema: { type: 'object', properties: {} } }],
          },
        });
      }
      return jsonResponse({ result: { ok: true } });
    });

    const wrapped = createSessionAwareClientFetch({
      serverName: 'plain-mcp',
      requestInitHeaders: { Accept: 'application/json' },
      baseFetch,
      getMcpSessionId: () => undefined,
      setMcpSessionId: () => {},
    });

    await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'plain_tool', arguments: { q: 'x' } },
      }),
    });

    const toolCall = requestBodies[2];
    expect(
      ((toolCall.params as Record<string, unknown>).arguments as Record<string, unknown>)
        .clientSessionId
    ).toBeUndefined();
  });

  it('auto-initializes before first tools/call when session id is required', async () => {
    const methods: string[] = [];
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      const method = body?.method as string | undefined;
      methods.push(method || '<unknown>');

      if (method === 'tools/list') {
        return jsonResponse({
          result: {
            tools: [
              {
                name: 'needs_session',
                inputSchema: {
                  type: 'object',
                  properties: { q: { type: 'string' } },
                  required: ['clientSessionId'],
                },
              },
            ],
          },
        });
      }
      if (method === 'initialize') {
        return jsonResponse({ result: { session: { clientSessionId: 'auto-session-1' } } });
      }
      if (method === 'tools/call') {
        const args = ((body?.params as Record<string, unknown>).arguments || {}) as Record<
          string,
          unknown
        >;
        return jsonResponse({
          result: { ok: true, receivedClientSessionId: args.clientSessionId },
        });
      }
      return jsonResponse({ result: {} });
    });

    const wrapped = createSessionAwareClientFetch({
      serverName: 'datakimia-portal-mcp',
      requestInitHeaders: { Accept: 'application/json' },
      baseFetch,
      getMcpSessionId: () => undefined,
      setMcpSessionId: () => {},
    });

    await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const response = await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'needs_session', arguments: { q: 'x' } },
      }),
    });

    const payload = await response.json();
    expect(payload.result.ok).toBe(true);
    expect(payload.result.receivedClientSessionId).toBe('auto-session-1');
    expect(methods).toEqual(['tools/list', 'initialize', 'tools/call']);
  });

  it('supports eager preInitialize before first tools/call', async () => {
    const methods: string[] = [];
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      const method = body?.method as string | undefined;
      methods.push(method || '<unknown>');
      if (method === 'initialize') {
        return jsonResponse({ result: { session: { clientSessionId: 'eager-session-1' } } });
      }
      if (method === 'tools/call') {
        const args = ((body?.params as Record<string, unknown>).arguments || {}) as Record<
          string,
          unknown
        >;
        return jsonResponse({ result: { receivedClientSessionId: args.clientSessionId } });
      }
      return jsonResponse({ result: {} });
    });

    const wrapped = createSessionAwareClientFetch({
      serverName: 'datakimia_portal_mcp',
      requestInitHeaders: { Accept: 'application/json' },
      baseFetch,
      getMcpSessionId: () => undefined,
      setMcpSessionId: () => {},
      forceClientSessionIdInjection: true,
    });

    await wrapped.preInitialize('https://example.com/mcp');
    const response = await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'navigate_to_page',
          arguments: { url: 'https://example.com', clientSessionId: 'placeholder' },
        },
      }),
    });
    const payload = await response.json();

    expect(methods).toEqual(['initialize', 'tools/call']);
    expect(payload.result.receivedClientSessionId).toBe('eager-session-1');
  });

  it('extracts clientSessionId from data.result.session in eager preInitialize', async () => {
    const methods: string[] = [];
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      const method = body?.method as string | undefined;
      methods.push(method || '<unknown>');
      if (method === 'initialize') {
        return jsonResponse({
          data: { result: { session: { clientSessionId: 'wrapped-session-id' } } },
          request: {},
          response: {},
        });
      }
      if (method === 'tools/call') {
        const args = ((body?.params as Record<string, unknown>).arguments || {}) as Record<
          string,
          unknown
        >;
        return jsonResponse({ result: { receivedClientSessionId: args.clientSessionId } });
      }
      return jsonResponse({ result: {} });
    });

    const wrapped = createSessionAwareClientFetch({
      serverName: 'datakimia_portal_mcp',
      requestInitHeaders: { Accept: 'application/json' },
      baseFetch,
      getMcpSessionId: () => undefined,
      setMcpSessionId: () => {},
      forceClientSessionIdInjection: true,
    });

    await wrapped.preInitialize('https://example.com/mcp');
    const response = await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'reset_session', arguments: { q: 'x', clientSessionId: 'placeholder' } },
      }),
    });
    const payload = await response.json();

    expect(methods).toEqual(['initialize', 'tools/call']);
    expect(payload.result.receivedClientSessionId).toBe('wrapped-session-id');
  });

  it('extracts clientSessionId from data.session', async () => {
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      if (body?.method === 'initialize') {
        return jsonResponse({ data: { session: { clientSessionId: 'data-session-id' } } });
      }
      if (body?.method === 'tools/call') {
        const args = ((body?.params as Record<string, unknown>).arguments || {}) as Record<
          string,
          unknown
        >;
        return jsonResponse({ result: { receivedClientSessionId: args.clientSessionId } });
      }
      return jsonResponse({ result: {} });
    });

    const wrapped = createSessionAwareClientFetch({
      serverName: 'datakimia_portal_mcp',
      requestInitHeaders: { Accept: 'application/json' },
      baseFetch,
      getMcpSessionId: () => undefined,
      setMcpSessionId: () => {},
      forceClientSessionIdInjection: true,
    });

    await wrapped.preInitialize('https://example.com/mcp');
    const response = await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'reset_session', arguments: { q: 'x' } },
      }),
    });
    const payload = await response.json();
    expect(payload.result.receivedClientSessionId).toBe('data-session-id');
  });

  it('extracts clientSessionId from parsed response.body', async () => {
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      if (body?.method === 'initialize') {
        return jsonResponse({
          data: {},
          response: {
            body: JSON.stringify({ result: { session: { clientSessionId: 'body-session-id' } } }),
          },
        });
      }
      if (body?.method === 'tools/call') {
        const args = ((body?.params as Record<string, unknown>).arguments || {}) as Record<
          string,
          unknown
        >;
        return jsonResponse({ result: { receivedClientSessionId: args.clientSessionId } });
      }
      return jsonResponse({ result: {} });
    });

    const wrapped = createSessionAwareClientFetch({
      serverName: 'datakimia_portal_mcp',
      requestInitHeaders: { Accept: 'application/json' },
      baseFetch,
      getMcpSessionId: () => undefined,
      setMcpSessionId: () => {},
      forceClientSessionIdInjection: true,
    });

    await wrapped.preInitialize('https://example.com/mcp');
    const response = await wrapped('https://example.com/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'reset_session', arguments: { q: 'x' } },
      }),
    });
    const payload = await response.json();
    expect(payload.result.receivedClientSessionId).toBe('body-session-id');
  });

  it('blocks tools/call when required session id is still missing after initialize', async () => {
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      if (body?.method === 'initialize') {
        return jsonResponse({ data: { status: 'ok' }, request: {}, response: {} });
      }
      return jsonResponse({ result: { ok: true } });
    });

    const wrapped = createSessionAwareClientFetch({
      serverName: 'datakimia_portal_mcp',
      requestInitHeaders: { Accept: 'application/json' },
      baseFetch,
      getMcpSessionId: () => undefined,
      setMcpSessionId: () => {},
      forceClientSessionIdInjection: true,
    });

    await expect(
      wrapped('https://example.com/mcp', {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'reset_session', arguments: {} },
        }),
      })
    ).rejects.toThrow(/did not provide clientSessionId/);
  });
});
