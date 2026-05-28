type JsonRpcRequest = {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
};

type ClientSessionIdExtraction = {
  clientSessionId?: string;
  matchedPath: string;
};

type FetchTarget = Parameters<typeof fetch>[0];

const MAX_SESSION_PREFIX_LEN = 8;

function getSessionPrefix(sessionId: string | undefined): string {
  if (!sessionId) return '<none>';
  return sessionId.slice(0, MAX_SESSION_PREFIX_LEN);
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object') {
    return value as T;
  }
  return null;
}

function extractClientSessionId(response: unknown): ClientSessionIdExtraction {
  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const asString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value : undefined;

  const root = asRecord(response);
  if (!root) return { matchedPath: '<none>' };

  const direct = asString(asRecord(asRecord(root.result)?.session)?.clientSessionId);
  if (direct) {
    return { clientSessionId: direct, matchedPath: 'resp.result.session.clientSessionId' };
  }

  const wrappedResult = asString(
    asRecord(asRecord(asRecord(root.data)?.result)?.session)?.clientSessionId
  );
  if (wrappedResult) {
    return {
      clientSessionId: wrappedResult,
      matchedPath: 'resp.data.result.session.clientSessionId',
    };
  }

  const wrappedSession = asString(asRecord(asRecord(root.data)?.session)?.clientSessionId);
  if (wrappedSession) {
    return { clientSessionId: wrappedSession, matchedPath: 'resp.data.session.clientSessionId' };
  }

  const responseObj = asRecord(root.response);
  const parseCandidate = (value: unknown): Record<string, unknown> | undefined => {
    if (!value) return undefined;
    if (typeof value === 'string') return parseJson<Record<string, unknown>>(value) || undefined;
    return asRecord(value);
  };
  if (responseObj) {
    const parsedBody = parseCandidate(responseObj.body);
    const fromBody = asString(asRecord(asRecord(parsedBody?.result)?.session)?.clientSessionId);
    if (fromBody) {
      return {
        clientSessionId: fromBody,
        matchedPath: 'resp.response.body->parsed.result.session.clientSessionId',
      };
    }

    const parsedJson = parseCandidate(responseObj.json);
    const fromJson = asString(asRecord(asRecord(parsedJson?.result)?.session)?.clientSessionId);
    if (fromJson) {
      return {
        clientSessionId: fromJson,
        matchedPath: 'resp.response.json->parsed.result.session.clientSessionId',
      };
    }
  }

  return { matchedPath: '<none>' };
}

function buildInitFromRequest(request: JsonRpcRequest): JsonRpcRequest {
  return {
    jsonrpc: request.jsonrpc || '2.0',
    id: typeof request.id === 'number' || typeof request.id === 'string' ? request.id : 1,
    method: 'initialize',
    params: (request.params as Record<string, unknown>) || {},
  };
}

function buildDefaultInitializeTemplate(): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'agor-daemon', version: '1.0.0' },
    },
  };
}

function isMissingClientSessionError(response: JsonRpcResponse | null): boolean {
  const message = response?.error?.message?.toLowerCase() || '';
  return (
    message.includes('clientsessionid') &&
    (message.includes('required') || message.includes('missing') || message.includes('session'))
  );
}

function updateRequiredToolsFromListTools(
  response: JsonRpcResponse | null,
  requiredTools: Set<string>
): void {
  const tools = (response?.result?.tools as Array<Record<string, unknown>> | undefined) || [];
  for (const tool of tools) {
    const toolName = typeof tool.name === 'string' ? tool.name : undefined;
    const schema = tool.inputSchema as Record<string, unknown> | undefined;
    const required = Array.isArray(schema?.required) ? (schema.required as unknown[]) : [];
    if (toolName && required.includes('clientSessionId')) {
      requiredTools.add(toolName);
    }
  }
}

function logMcpCall(
  serverName: string,
  method: string,
  hasClientSessionId: boolean,
  sessionId: string | undefined
): void {
  console.log(
    `[MCP Adapter] server=${serverName} method=${method} clientSessionId=${hasClientSessionId ? 'yes' : 'no'} session=${getSessionPrefix(sessionId)}`
  );
}

export function createSessionAwareClientFetch(params: {
  serverName: string;
  requestInitHeaders: Record<string, string>;
  baseFetch: typeof fetch;
  getMcpSessionId: () => string | undefined;
  setMcpSessionId: (sessionId: string) => void;
  forceClientSessionIdInjection?: boolean;
}): typeof fetch & {
  preInitialize: (target: FetchTarget) => Promise<void>;
  getClientSessionId: () => string | undefined;
} {
  let clientSessionId: string | undefined;
  let initializeTemplate: JsonRpcRequest | undefined;
  let lastInitializeDiagnostic = '<not_initialized>';
  const toolsRequiringClientSessionId = new Set<string>();
  let serverRequiresClientSessionId = !!params.forceClientSessionIdInjection;

  const sendInitialize = async (target: FetchTarget, template: JsonRpcRequest): Promise<void> => {
    const mcpSessionId = params.getMcpSessionId();
    const headers: Record<string, string> = {
      ...params.requestInitHeaders,
      ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}),
    };
    const initPayload = buildInitFromRequest(template);

    const response = await params.baseFetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(initPayload),
    });
    const body = parseJson<unknown>(await response.text());
    const extraction = extractClientSessionId(body);
    lastInitializeDiagnostic = extraction.matchedPath;
    if (extraction.clientSessionId) {
      clientSessionId = extraction.clientSessionId;
      serverRequiresClientSessionId = true;
      console.log(
        `[MCP Adapter] server=${params.serverName} initialize clientSessionId captured=yes source=${extraction.matchedPath} session=${getSessionPrefix(clientSessionId)}`
      );
    } else {
      console.warn(
        `[MCP Adapter] server=${params.serverName} initialize clientSessionId captured=no source=${extraction.matchedPath}`
      );
    }
  };

  const preInitialize = async (target: FetchTarget): Promise<void> => {
    const template = initializeTemplate || buildDefaultInitializeTemplate();
    await sendInitialize(target, template);
  };

  const wrappedFetch = async (input: FetchTarget, init?: RequestInit) => {
    const requestBody = parseJson<JsonRpcRequest>(init?.body);
    const method = requestBody?.method;
    const paramsObj = (requestBody?.params as Record<string, unknown> | undefined) || {};
    const toolName = typeof paramsObj.name === 'string' ? paramsObj.name : undefined;

    if (method === 'initialize' && requestBody) {
      initializeTemplate = requestBody;
    }

    if (method === 'tools/call' && requestBody) {
      const args = (paramsObj.arguments as Record<string, unknown> | undefined) || {};
      const shouldInject =
        serverRequiresClientSessionId ||
        !!clientSessionId ||
        (toolName ? toolsRequiringClientSessionId.has(toolName) : false);
      if (shouldInject && !clientSessionId) {
        const template = initializeTemplate || buildDefaultInitializeTemplate();
        await sendInitialize(input, template);
      }
      if (shouldInject && !clientSessionId) {
        throw new Error(
          `MCP server "${params.serverName}" did not provide clientSessionId after initialize (matched=${lastInitializeDiagnostic}); blocking tools/call to avoid session race`
        );
      }
      if (shouldInject && clientSessionId) {
        // Always override model-provided placeholder IDs with adapter-managed session ID.
        paramsObj.arguments = { ...args, clientSessionId };
        requestBody.params = paramsObj;
        init = { ...init, body: JSON.stringify(requestBody) };
        console.log(
          `[MCP Adapter] server=${params.serverName} method=tools/call injected=yes tool=${toolName || '<unknown>'} session=${getSessionPrefix(clientSessionId)}`
        );
      }
    }

    const hasClientSessionId =
      method === 'tools/call'
        ? !!(
            (requestBody?.params as Record<string, unknown> | undefined)?.arguments as
              | Record<string, unknown>
              | undefined
          )?.clientSessionId
        : !!clientSessionId;
    logMcpCall(params.serverName, method || '<unknown>', hasClientSessionId, clientSessionId);

    const response = await params.baseFetch(input, init);

    const respMcpSessionId = response.headers.get('mcp-session-id');
    if (respMcpSessionId) {
      params.setMcpSessionId(respMcpSessionId);
    }

    if (!method) return response;

    const responseBody = parseJson<JsonRpcResponse>(await response.clone().text());

    if (method === 'initialize') {
      const extraction = extractClientSessionId(responseBody);
      lastInitializeDiagnostic = extraction.matchedPath;
      if (extraction.clientSessionId) {
        clientSessionId = extraction.clientSessionId;
        serverRequiresClientSessionId = true;
        console.log(
          `[MCP Adapter] server=${params.serverName} initialize clientSessionId captured=yes source=${extraction.matchedPath} session=${getSessionPrefix(clientSessionId)}`
        );
      } else {
        console.warn(
          `[MCP Adapter] server=${params.serverName} initialize clientSessionId captured=no source=${extraction.matchedPath}`
        );
      }
    } else if (method === 'tools/list') {
      updateRequiredToolsFromListTools(responseBody, toolsRequiringClientSessionId);
      if (toolsRequiringClientSessionId.size > 0) {
        serverRequiresClientSessionId = true;
      }
    } else if (method === 'tools/call' && isMissingClientSessionError(responseBody)) {
      serverRequiresClientSessionId = true;
      const template = initializeTemplate || buildDefaultInitializeTemplate();
      await sendInitialize(input, template);
      const retryBody = parseJson<JsonRpcRequest>(init?.body);
      const retryParams = (retryBody?.params as Record<string, unknown> | undefined) || {};
      const retryArgs = (retryParams.arguments as Record<string, unknown> | undefined) || {};
      if (clientSessionId) {
        retryParams.arguments = { ...retryArgs, clientSessionId };
        console.log(
          `[MCP Adapter] server=${params.serverName} method=tools/call injected=yes tool=${typeof retryParams.name === 'string' ? retryParams.name : '<unknown>'} session=${getSessionPrefix(clientSessionId)}`
        );
      }
      if (retryBody) {
        retryBody.params = retryParams;
      }
      const retryResponse = await params.baseFetch(input, {
        ...init,
        body: retryBody ? JSON.stringify(retryBody) : init?.body,
      });
      return retryResponse;
    }

    return response;
  };

  return Object.assign(wrappedFetch, {
    preInitialize,
    getClientSessionId: () => clientSessionId,
  });
}
