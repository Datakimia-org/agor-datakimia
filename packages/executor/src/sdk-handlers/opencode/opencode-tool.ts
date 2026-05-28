/**
 * OpenCode Tool Implementation
 *
 * Implements the ITool interface for OpenCode.ai integration.
 * OpenCode is an open-source terminal-based AI coding assistant supporting 75+ LLM providers.
 *
 * Current capabilities:
 * - ✅ Create new sessions
 * - ✅ Send prompts and receive responses
 * - ✅ Get session metadata and messages
 * - ✅ Real-time streaming support via SSE
 * - ✅ Agor MCP tools (via client.mcp.add())
 * - ✅ Worktree directory isolation (via x-opencode-directory header)
 * - ⏳ Session import (future: when OpenCode provides export API)
 */

import { generateId } from '@agor/core';
import type { Message, MessageID, SessionID, TaskID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import type { Part as OpenCodePart } from '@opencode-ai/sdk';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { getDaemonUrl } from '../../config.js';
import type {
  MCPServerRepository,
  SessionMCPServerRepository,
} from '../../db/feathers-repositories.js';
import type { NormalizedSdkResponse, RawSdkResponse } from '../../types/sdk-response.js';
import { enrichContentBlocks } from '../base/diff-enrichment.js';
import type {
  CreateSessionConfig,
  SessionHandle,
  SessionMetadata,
  StreamingCallbacks,
  TaskResult,
  ToolCapabilities,
} from '../base/index.js';
import { getMcpServersForSession } from '../base/mcp-scoping.js';
import type { ITool } from '../base/tool.interface.js';

export interface OpenCodeConfig {
  enabled: boolean;
  serverUrl: string;
}

/**
 * Session context for an Agor session mapped to OpenCode
 */
interface SessionContext {
  opencodeSessionId: string;
  model?: string;
  provider?: string;
  /** Worktree directory path for project-scoped operations */
  worktreePath?: string;
  /** MCP token for Agor MCP server injection */
  mcpToken?: string;
}

type ClientSessionIdExtraction = {
  clientSessionId?: string;
  matchedPath: string;
};

/**
 * Service interface for creating messages via FeathersJS
 */
export interface MessagesService {
  create(data: Partial<Message>): Promise<Message>;
}

/**
 * Service interface for updating tasks via FeathersJS
 */
export interface TasksService {
  patch(id: string, data: Partial<{ status: string }>): Promise<unknown>;
}

export class OpenCodeTool implements ITool {
  readonly toolType = 'opencode' as const;
  readonly name = 'OpenCode';

  /** Default client (no directory override) */
  private client: ReturnType<typeof createOpencodeClient> | null = null;
  /** Directory-scoped clients keyed by worktree path */
  private directoryClients: Map<string, ReturnType<typeof createOpencodeClient>> = new Map();
  private config: OpenCodeConfig;
  private messagesService?: MessagesService;
  private sessionContexts: Map<string, SessionContext> = new Map(); // Agor session ID → session context
  /** Tracks which sessions have had MCP servers injected (hash-based) */
  private injectedMcpHash: Map<string, string> = new Map();
  /** Tracks eager MCP initialization per agor session + mcp server name */
  private eagerMcpInit: Set<string> = new Set();
  /** Stores clientSessionId by agor session + mcp server name */
  private mcpClientSessionIds: Map<string, string> = new Map();
  /** Servers that must have clientSessionId for each session */
  private sessionAwareServersBySession: Map<string, Set<string>> = new Map();
  /** MCP repository dependencies for resolving user-defined MCP servers */
  private sessionMCPRepo?: SessionMCPServerRepository;
  private mcpServerRepo?: MCPServerRepository;

  private getApiError(response: unknown): unknown | undefined {
    if (!response || typeof response !== 'object' || !('error' in response)) {
      return undefined;
    }

    const errorValue = (response as { error?: unknown }).error;
    return errorValue == null ? undefined : errorValue;
  }

  private getApiData<T>(response: unknown): T | undefined {
    if (!response || typeof response !== 'object' || !('data' in response)) {
      return undefined;
    }

    return (response as { data?: T }).data;
  }

  private shouldForceSessionAwareMcp(serverName: string): boolean {
    const normalized = serverName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const configured = (process.env.AGOR_FORCE_SESSION_AWARE_MCP_SERVERS || 'datakimia_portal_mcp')
      .split(',')
      .map((entry) =>
        entry
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .trim()
      )
      .filter((entry) => entry.length > 0);
    return configured.includes(normalized);
  }

  private getMcpInitKey(sessionId: string, mcpName: string): string {
    return `${sessionId}:${mcpName}`;
  }

  private summarizeResponseShape(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return typeof payload;
    const root = payload as Record<string, unknown>;
    const topKeys = Object.keys(root).slice(0, 8);
    const result =
      root.result && typeof root.result === 'object'
        ? (root.result as Record<string, unknown>)
        : undefined;
    const data =
      root.data && typeof root.data === 'object'
        ? (root.data as Record<string, unknown>)
        : undefined;
    return JSON.stringify({
      keys: topKeys,
      hasResult: !!result,
      hasData: !!data,
      resultKeys: result ? Object.keys(result).slice(0, 6) : [],
      dataKeys: data ? Object.keys(data).slice(0, 6) : [],
      hasResultSession: !!result?.session,
      hasDataSession: !!data?.session,
    });
  }

  private async extractClientSessionId(payload: unknown): Promise<ClientSessionIdExtraction> {
    const root =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined;
    if (!root) return { matchedPath: '<none>' };

    const asRecord = (value: unknown): Record<string, unknown> | undefined =>
      value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

    const getString = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim().length > 0 ? value : undefined;

    const fromResultSession = getString(asRecord(asRecord(root.result)?.session)?.clientSessionId);
    if (fromResultSession) {
      return {
        clientSessionId: fromResultSession,
        matchedPath: 'resp.result.session.clientSessionId',
      };
    }

    const fromDataResultSession = getString(
      asRecord(asRecord(asRecord(root.data)?.result)?.session)?.clientSessionId
    );
    if (fromDataResultSession) {
      return {
        clientSessionId: fromDataResultSession,
        matchedPath: 'resp.data.result.session.clientSessionId',
      };
    }

    const fromDataSession = getString(asRecord(asRecord(root.data)?.session)?.clientSessionId);
    if (fromDataSession) {
      return {
        clientSessionId: fromDataSession,
        matchedPath: 'resp.data.session.clientSessionId',
      };
    }

    const responseRecord = asRecord(root.response);
    if (responseRecord) {
      const parseResponsePayload = (value: unknown): Record<string, unknown> | undefined => {
        if (!value) return undefined;
        if (typeof value === 'string') {
          try {
            const parsed = JSON.parse(value);
            return asRecord(parsed);
          } catch {
            return undefined;
          }
        }
        return asRecord(value);
      };

      const responseBody = parseResponsePayload(responseRecord.body);
      const fromResponseBody = getString(
        asRecord(asRecord(responseBody?.result)?.session)?.clientSessionId
      );
      if (fromResponseBody) {
        return {
          clientSessionId: fromResponseBody,
          matchedPath: 'resp.response.body->parsed.result.session.clientSessionId',
        };
      }

      const responseJson = parseResponsePayload(responseRecord.json);
      const fromResponseJson = getString(
        asRecord(asRecord(responseJson?.result)?.session)?.clientSessionId
      );
      if (fromResponseJson) {
        return {
          clientSessionId: fromResponseJson,
          matchedPath: 'resp.response.json->parsed.result.session.clientSessionId',
        };
      }

      const responseJsonFn = responseRecord.json;
      if (typeof responseJsonFn === 'function') {
        try {
          const parsedFromJsonFn = parseResponsePayload(await responseJsonFn.call(responseRecord));
          const fromResponseJsonFn = getString(
            asRecord(asRecord(parsedFromJsonFn?.result)?.session)?.clientSessionId
          );
          if (fromResponseJsonFn) {
            return {
              clientSessionId: fromResponseJsonFn,
              matchedPath: 'resp.response.json()->parsed.result.session.clientSessionId',
            };
          }
        } catch {
          // Keep strict blocking behavior if extraction still fails.
        }
      }

      const responseTextFn = responseRecord.text;
      if (typeof responseTextFn === 'function') {
        try {
          const parsedFromTextFn = parseResponsePayload(await responseTextFn.call(responseRecord));
          const fromResponseTextFn = getString(
            asRecord(asRecord(parsedFromTextFn?.result)?.session)?.clientSessionId
          );
          if (fromResponseTextFn) {
            return {
              clientSessionId: fromResponseTextFn,
              matchedPath: 'resp.response.text()->parsed.result.session.clientSessionId',
            };
          }
        } catch {
          // Keep strict blocking behavior if extraction still fails.
        }
      }
    }

    return { matchedPath: '<none>' };
  }

  private async eagerInitializeMcpServer(
    sessionId: string,
    client: ReturnType<typeof createOpencodeClient>,
    mcpName: string,
    worktreePath?: string
  ): Promise<void> {
    const key = this.getMcpInitKey(sessionId, mcpName);
    if (this.eagerMcpInit.has(key)) return;

    try {
      const connectResult = await (
        client.mcp as unknown as {
          connect: (params: { name: string; directory?: string }) => Promise<unknown>;
        }
      ).connect({
        name: mcpName,
        directory: worktreePath,
      });
      const extraction = await this.extractClientSessionId(connectResult);
      const clientSessionId = extraction.clientSessionId;
      if (clientSessionId) {
        this.mcpClientSessionIds.set(key, clientSessionId);
        this.eagerMcpInit.add(key);
        console.log(
          `[OpenCodeTool][MCP] initialize complete server=${mcpName} session=${clientSessionId.slice(0, 8)} source=${extraction.matchedPath}`
        );
        return;
      }
      console.warn(
        `[OpenCodeTool][MCP] initialize returned no clientSessionId server=${mcpName} source=${extraction.matchedPath} shape=${this.summarizeResponseShape(connectResult)}`
      );
    } catch (error) {
      console.warn(`[OpenCodeTool][MCP] eager initialize failed for "${mcpName}":`, error);
    }
  }

  private markSessionAwareServer(sessionId: string, mcpName: string): void {
    const current = this.sessionAwareServersBySession.get(sessionId) || new Set<string>();
    current.add(mcpName);
    this.sessionAwareServersBySession.set(sessionId, current);
  }

  private async ensureSessionAwareMcpReady(
    sessionId: string,
    client: ReturnType<typeof createOpencodeClient>,
    worktreePath?: string
  ): Promise<void> {
    const required = this.sessionAwareServersBySession.get(sessionId);
    if (!required || required.size === 0) return;
    for (const mcpName of required) {
      const key = this.getMcpInitKey(sessionId, mcpName);
      if (!this.mcpClientSessionIds.get(key)) {
        await this.eagerInitializeMcpServer(sessionId, client, mcpName, worktreePath);
      }
      if (!this.mcpClientSessionIds.get(key)) {
        // Temporary operational fallback: do not hard-block datakimia_portal_mcp prompts
        // when eager initialize returns wrapper shapes we cannot parse yet.
        if (this.shouldForceSessionAwareMcp(mcpName)) {
          console.warn(
            `[OpenCodeTool][MCP] eager initialize missing clientSessionId server=${mcpName}; continuing prompt and relying on runtime tools/call session injection`
          );
          continue;
        }
        throw new Error(
          `MCP server "${mcpName}" did not provide clientSessionId during eager initialize; blocking prompt to avoid tools/call race`
        );
      }
    }
  }

  constructor(
    config: OpenCodeConfig,
    messagesService?: MessagesService,
    sessionMCPRepo?: SessionMCPServerRepository,
    mcpServerRepo?: MCPServerRepository
  ) {
    this.config = config;
    this.messagesService = messagesService;
    this.sessionMCPRepo = sessionMCPRepo;
    this.mcpServerRepo = mcpServerRepo;
  }

  /**
   * Set session context (OpenCode session ID, model, provider, worktree path, and MCP token) for an Agor session
   * Must be called before executeTask
   *
   * @param agorSessionId - Agor session ID
   * @param opencodeSessionId - OpenCode session ID
   * @param model - Model identifier (e.g., 'gpt-4o', 'claude-sonnet-4-6')
   * @param provider - Provider ID (e.g., 'openai', 'opencode'). If omitted, uses legacy mapping.
   * @param worktreePath - Worktree directory path for project-scoped operations
   * @param mcpToken - MCP token for Agor MCP server injection
   */
  setSessionContext(
    agorSessionId: string,
    opencodeSessionId: string,
    model?: string,
    provider?: string,
    worktreePath?: string,
    mcpToken?: string
  ): void {
    this.sessionContexts.set(agorSessionId, {
      opencodeSessionId,
      model,
      provider,
      worktreePath,
      mcpToken,
    });
  }

  /**
   * Get session context for an Agor session
   */
  private getSessionContext(agorSessionId: string): SessionContext | undefined {
    return this.sessionContexts.get(agorSessionId);
  }

  /**
   * Get a client for the default (no directory override) connection.
   * Backward-compatible wrapper around getClientForDirectory.
   */
  private getClient(): ReturnType<typeof createOpencodeClient> {
    return this.getClientForDirectory(undefined);
  }

  /**
   * Get or create a directory-scoped client.
   * If no directory is provided, returns the default client (lazy-initialized).
   * If a directory is provided, returns a cached client scoped to that directory.
   */
  private getClientForDirectory(
    directory: string | undefined
  ): ReturnType<typeof createOpencodeClient> {
    if (!directory) {
      if (!this.client) {
        this.client = createOpencodeClient({
          baseUrl: this.config.serverUrl,
        });
      }
      return this.client;
    }

    const cached = this.directoryClients.get(directory);
    if (cached) {
      return cached;
    }

    const client = createOpencodeClient({
      baseUrl: this.config.serverUrl,
      directory,
    });
    this.directoryClients.set(directory, client);
    return client;
  }

  /**
   * Inject MCP servers into OpenCode for the given session.
   *
   * Strategy: Use a session-specific MCP name (`agor_<shortId>`) to avoid conflicts with
   * stale entries that may be cached in OpenCode's memory from previous sessions.
   * The handler clears the `mcp` section in opencode.json to prevent stale entries from
   * being loaded at server startup, and we inject fresh entries via mcp.add() each time.
   *
   * For user-defined MCP servers: uses a hash to avoid redundant re-injection.
   */
  private async ensureMcpServers(
    sessionId: string,
    client: ReturnType<typeof createOpencodeClient>,
    mcpToken?: string,
    worktreePath?: string
  ): Promise<void> {
    if (mcpToken) {
      // Use session-specific MCP name to avoid conflicts with stale entries
      const shortId = sessionId.substring(0, 8);
      const mcpName = `agor_${shortId}`;

      try {
        const daemonUrl = await getDaemonUrl();
        const mcpUrl = `${daemonUrl}/mcp?sessionToken=${encodeURIComponent(mcpToken)}`;

        const mcpResult = await client.mcp.add({
          body: {
            name: mcpName,
            config: {
              type: 'remote' as const,
              url: mcpUrl,
              enabled: true,
            },
          },
          query: worktreePath ? { directory: worktreePath } : undefined,
        });
        console.log(
          `[OpenCodeTool] Injected Agor MCP as "${mcpName}" for session ${shortId}`,
          mcpResult.data ? `status: ${JSON.stringify(mcpResult.data)}` : ''
        );
        if (this.shouldForceSessionAwareMcp(mcpName)) {
          this.markSessionAwareServer(sessionId, mcpName);
          await this.eagerInitializeMcpServer(sessionId, client, mcpName, worktreePath);
        }
      } catch (error) {
        console.warn(`[OpenCodeTool] Failed to inject Agor MCP server "${mcpName}":`, error);
      }
    }

    // Inject user-defined MCP servers (use hash to avoid redundant re-injection)
    const configHash = `${mcpToken ?? ''}:${sessionId}`;
    if (this.injectedMcpHash.get(sessionId) === configHash) {
      return;
    }

    if (this.sessionMCPRepo && this.mcpServerRepo) {
      try {
        const servers = await getMcpServersForSession(sessionId as SessionID, {
          sessionMCPRepo: this.sessionMCPRepo,
          mcpServerRepo: this.mcpServerRepo,
        });

        for (const { server } of servers) {
          const sanitizedName = server.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');

          try {
            if (server.transport === 'stdio') {
              await client.mcp.add({
                body: {
                  name: sanitizedName,
                  config: {
                    type: 'local' as const,
                    command: [server.command!, ...(server.args || [])],
                    environment: (server.env as Record<string, string>) ?? {},
                    enabled: true,
                  },
                },
                query: worktreePath ? { directory: worktreePath } : undefined,
              });
            } else if (server.transport === 'http' || server.transport === 'sse') {
              const headers: Record<string, string> = {};
              if (server.auth?.token) {
                headers.Authorization = `Bearer ${server.auth.token}`;
              }
              await client.mcp.add({
                body: {
                  name: sanitizedName,
                  config: {
                    type: 'remote' as const,
                    url: server.url!,
                    enabled: true,
                    headers: Object.keys(headers).length > 0 ? headers : undefined,
                  },
                },
                query: worktreePath ? { directory: worktreePath } : undefined,
              });
              if (this.shouldForceSessionAwareMcp(sanitizedName)) {
                this.markSessionAwareServer(sessionId, sanitizedName);
                await this.eagerInitializeMcpServer(sessionId, client, sanitizedName, worktreePath);
              }
            }
            console.log(`[OpenCodeTool] Injected MCP server: ${sanitizedName}`);
          } catch (error) {
            console.warn(`[OpenCodeTool] Failed to inject MCP server "${sanitizedName}":`, error);
          }
        }
      } catch (error) {
        console.warn('[OpenCodeTool] Failed to resolve MCP servers for session:', error);
      }
    }

    this.injectedMcpHash.set(sessionId, configHash);
  }

  /**
   * Get tool capabilities
   */
  getCapabilities(): ToolCapabilities {
    return {
      supportsSessionImport: false, // Future: add when OpenCode provides export API
      supportsSessionCreate: true,
      supportsLiveExecution: true,
      supportsSessionFork: false, // Not currently supported
      supportsChildSpawn: true, // Supported via Agor MCP tools
      supportsGitState: false, // OpenCode doesn't track git state
      supportsStreaming: true, // Supports SSE streaming
    };
  }

  /**
   * Check if OpenCode server is installed and accessible
   */
  async checkInstalled(): Promise<boolean> {
    try {
      const client = this.getClient();
      // Try to list sessions as health check
      await client.session.list();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new OpenCode session
   */
  async createSession?(config: CreateSessionConfig): Promise<SessionHandle> {
    // Use directory-scoped client if workingDirectory is provided (worktree path)
    const client = this.getClientForDirectory(config.workingDirectory);

    try {
      // Note: OpenCode SDK session.create doesn't support model parameter
      // Model is specified per-message in prompt() calls
      const response = await client.session.create({
        body: {
          title: String(config.title || 'Agor Session'),
        },
        // Explicitly pass directory as query param (in addition to SDK header)
        // to ensure the session is created in the correct worktree directory
        query: config.workingDirectory ? { directory: config.workingDirectory } : undefined,
      });

      const apiError = this.getApiError(response);
      if (apiError) {
        throw new Error(`OpenCode API error: ${JSON.stringify(apiError)}`);
      }

      const responseData = this.getApiData<{ id?: string }>(response);
      if (!responseData?.id) {
        throw new Error('OpenCode API error: missing session id in createSession response');
      }

      return {
        sessionId: responseData.id,
        toolType: 'opencode',
      };
    } catch (error) {
      throw new Error(
        `Failed to create OpenCode session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Execute task (send prompt) in OpenCode session WITH STREAMING
   *
   * Subscribes to OpenCode event stream, sends prompt, and streams response parts in real-time.
   * Handles reasoning, text, tool execution, and file edits as they arrive.
   * CONTRACT: Must call messagesService.create() with complete message
   *
   * NOTE: Must call setSessionContext() before this method to set OpenCode session ID and model
   *
   * @param sessionId - Agor session ID (for message creation)
   * @param prompt - User prompt
   * @param taskId - Task ID
   * @param streamingCallbacks - Optional streaming callbacks for real-time UI updates
   * @param messageIndex - Index for the assistant message (handler creates user message first)
   */
  async executeTask?(
    sessionId: string,
    prompt: string,
    taskId?: string,
    streamingCallbacks?: StreamingCallbacks,
    messageIndex?: number
  ): Promise<TaskResult> {
    try {
      // Get session context (OpenCode session ID, model, provider)
      const context = this.getSessionContext(sessionId);

      console.log('[OpenCodeTool] executeTask called:', {
        sessionId,
        opencodeSessionId: context?.opencodeSessionId,
        taskId,
        promptLength: prompt.length,
        model: context?.model,
        provider: context?.provider,
        worktreePath: context?.worktreePath,
        streaming: !!streamingCallbacks,
      });

      if (!context?.opencodeSessionId) {
        throw new Error(
          `OpenCode session ID not found for Agor session ${sessionId}. Call setSessionContext() first.`
        );
      }
      console.log('[OpenCodeTool] Using OpenCode session:', context.opencodeSessionId);

      if (context.model) {
        console.log('[OpenCodeTool] Using model:', context.model);
      }
      if (context.provider) {
        console.log('[OpenCodeTool] Using provider:', context.provider);
      }

      // Get the directory-scoped client
      const worktreePath = context.worktreePath;
      const client = this.getClientForDirectory(worktreePath);

      // Inject MCP servers (uses session-specific name to avoid stale entry conflicts)
      await this.ensureMcpServers(sessionId, client, context.mcpToken, worktreePath);
      await this.ensureSessionAwareMcpReady(sessionId, client, worktreePath);
      const sessionScopedMcpIds = Array.from(this.mcpClientSessionIds.entries()).filter(([key]) =>
        key.startsWith(`${sessionId}:`)
      );
      if (sessionScopedMcpIds.length > 0) {
        for (const [key, clientSessionId] of sessionScopedMcpIds) {
          const serverName = key.split(':').slice(1).join(':');
          console.log(
            `[OpenCodeTool][MCP] first tools/call guard server=${serverName} clientSessionId=yes session=${clientSessionId.slice(0, 8)}`
          );
        }
      }

      // Prepare prompt options
      const promptOptions: {
        path: { id: string };
        body: {
          parts: Array<{ type: 'text'; text: string }>;
          model?: { providerID: string; modelID: string };
        };
        query?: { directory?: string };
      } = {
        path: { id: context.opencodeSessionId },
        body: {
          parts: [{ type: 'text', text: prompt }],
        },
        // Explicitly pass directory as query param to ensure correct worktree scoping
        query: worktreePath ? { directory: worktreePath } : undefined,
      };

      // Include model if provided
      if (context.model && context.provider) {
        console.log(
          '[OpenCodeTool] Sending prompt with model:',
          JSON.stringify({ providerID: context.provider, modelID: context.model })
        );
        promptOptions.body.model = { providerID: context.provider, modelID: context.model };
      }

      // If no streaming callbacks, use non-streaming path
      if (!streamingCallbacks) {
        console.log('[OpenCodeTool] No streaming callbacks, using non-streaming execution');
        return await this.executeTaskNonStreaming(
          client,
          sessionId,
          taskId,
          promptOptions,
          context.opencodeSessionId,
          messageIndex
        );
      }

      // STREAMING PATH: Subscribe to events and stream response parts
      console.log('[OpenCodeTool] Starting streaming execution...');

      // Track accumulated parts by part ID
      const partContents = new Map<string, string>();
      const partTypes = new Map<string, string>();
      const allParts: Array<{ id: string; type: string; data: unknown }> = []; // Store all parts for later processing
      let currentTextMessageId: string | null = null;
      let currentReasoningMessageId: string | null = null;

      // IMPORTANT: Subscribe to event stream BEFORE sending prompt
      // Events are emitted in real-time as prompt executes
      console.log('[OpenCodeTool] Subscribing to event stream...');
      const eventStream = await client.event.subscribe({
        // Pass directory to scope event stream to correct worktree
        query: worktreePath ? { directory: worktreePath } : undefined,
      });
      console.log('[OpenCodeTool] Event stream ready, sending prompt...');

      // Start prompt in background (don't await yet)
      const promptPromise = client.session.prompt(promptOptions);
      console.log('[OpenCodeTool] Prompt sent, waiting for events...');

      // Process events as they arrive
      let _responseCompleted = false;
      let assistantMessageId: string | undefined;
      const assistantMessageIds = new Set<string>();
      const metadata: {
        messageId?: string;
        parentMessageId?: string;
        cost?: number;
        tokens?: {
          input: number;
          output: number;
          reasoning: number;
          cache: { read: number; write: number };
        };
      } = {};

      try {
        console.log('[OpenCodeTool] Listening for events...');

        for await (const event of eventStream.stream) {
          // Log event type (skip noisy heartbeats)
          const eventType = event.type as string;
          if (eventType !== 'server.heartbeat') {
            console.log('[OpenCodeTool] Event:', eventType);
          }

          // Check if this event is for our session
          if ('properties' in event) {
            // Handle permission.asked / permission.updated events BEFORE processing messages.
            // When OpenCode needs permission (e.g., external_directory access), it emits this
            // event and waits for a response. Without auto-granting, the session hangs forever.
            if (
              (eventType === 'permission.asked' || eventType === 'permission.updated') &&
              'id' in event.properties &&
              'sessionID' in event.properties &&
              event.properties.sessionID === context.opencodeSessionId
            ) {
              const permId = event.properties.id as string;
              const permType = (
                'type' in event.properties ? event.properties.type : 'unknown'
              ) as string;
              console.log(
                `[OpenCodeTool] Auto-granting permission: id=${permId}, type=${permType}`
              );
              try {
                await client.postSessionIdPermissionsPermissionId({
                  path: {
                    id: context.opencodeSessionId,
                    permissionID: permId,
                  },
                  body: { response: 'always' },
                  query: worktreePath ? { directory: worktreePath } : undefined,
                });
                console.log(`[OpenCodeTool] Permission auto-granted (always): id=${permId}`);
              } catch (permErr) {
                console.error('[OpenCodeTool] Failed to auto-grant permission:', permErr);
              }
              continue;
            }

            // First, identify the assistant message when it's created
            if (
              event.type === 'message.updated' &&
              'info' in event.properties &&
              event.properties.info.sessionID === context.opencodeSessionId &&
              event.properties.info.role === 'assistant'
            ) {
              assistantMessageIds.add(event.properties.info.id);
              if (!assistantMessageId) {
                assistantMessageId = event.properties.info.id;
                console.log('[OpenCodeTool] Assistant message identified:', assistantMessageId);

                // Capture metadata
                metadata.messageId = event.properties.info.id;
                if (event.properties.info.parentID) {
                  metadata.parentMessageId = event.properties.info.parentID;
                }
              }
            }

            // Handle message.part.updated events - these contain the streaming updates
            // ONLY process parts from the assistant message, not the user message!
            if (event.type === 'message.part.updated' && 'part' in event.properties) {
              const part = event.properties.part;

              // Skip if this part is not from the assistant message
              if (!assistantMessageIds.has(part.messageID)) {
                console.log(
                  '[OpenCodeTool] Skipping part from non-assistant message:',
                  part.messageID
                );
                continue;
              }

              // Store this part for later processing (building final message)
              const existingPartIndex = allParts.findIndex((p) => p.id === part.id);
              if (existingPartIndex >= 0) {
                allParts[existingPartIndex] = { id: part.id, type: part.type, data: part };
              } else {
                allParts.push({ id: part.id, type: part.type, data: part });
              }

              // OpenCode sends full text each time, not deltas
              // We need to calculate the delta ourselves
              const newText =
                'text' in part &&
                typeof (part as OpenCodePart & { text?: string }).text === 'string'
                  ? (part as OpenCodePart & { text: string }).text
                  : undefined;

              if (newText) {
                // Get previous text for this part
                const previousText = partContents.get(part.id) || '';

                // Calculate delta (new characters added)
                const delta = newText.substring(previousText.length);

                // Update stored content
                partContents.set(part.id, newText);
                partTypes.set(part.id, part.type);

                console.log(
                  '[OpenCodeTool] Part update:',
                  part.type,
                  'delta length:',
                  delta.length,
                  'total length:',
                  newText.length
                );

                // Stream delta to UI based on part type
                if (delta.length > 0) {
                  if (part.type === 'reasoning') {
                    // Stream reasoning chunks
                    if (!currentReasoningMessageId) {
                      currentReasoningMessageId = generateId();
                      streamingCallbacks.onThinkingStart?.(
                        currentReasoningMessageId as MessageID,
                        {}
                      );
                    }
                    streamingCallbacks.onThinkingChunk?.(
                      currentReasoningMessageId as MessageID,
                      delta
                    );
                  } else if (part.type === 'text') {
                    // Stream text chunks
                    if (!currentTextMessageId) {
                      currentTextMessageId = generateId();
                      streamingCallbacks.onStreamStart(currentTextMessageId as MessageID, {
                        session_id: sessionId as SessionID,
                        task_id: taskId as TaskID | undefined,
                        role: 'assistant',
                        timestamp: new Date().toISOString(),
                      });
                    }
                    streamingCallbacks.onStreamChunk(currentTextMessageId as MessageID, delta);
                  } else if (part.type === 'tool') {
                    // Tool execution - log full details
                    console.log('[OpenCodeTool] ========== TOOL PART ==========');
                    console.log('[OpenCodeTool] Tool part ID:', part.id);
                    console.log('[OpenCodeTool] Tool part data:', JSON.stringify(part, null, 2));
                    console.log('[OpenCodeTool] ================================');
                  }
                }
              } else if (part.type === 'tool') {
                // Tool parts without text field - log full structure
                console.log('[OpenCodeTool] ========== TOOL PART (no text) ==========');
                console.log('[OpenCodeTool] Tool part ID:', part.id);
                console.log('[OpenCodeTool] Tool part data:', JSON.stringify(part, null, 2));
                console.log('[OpenCodeTool] ===================================');
              }
            }

            // Check for session idle status - indicates response is complete
            if (event.type === 'session.status' && event.properties.status.type === 'idle') {
              console.log('[OpenCodeTool] Session became idle, response complete');
              _responseCompleted = true;
              break; // Exit event loop
            }
          }
        }
      } finally {
        // Clean up event stream
        console.log('[OpenCodeTool] Closing event stream...');
        // Note: The SDK's async generator should clean up automatically when we break/return
      }

      // Wait for prompt to complete
      console.log('[OpenCodeTool] Waiting for prompt response...');
      const response = await promptPromise;

      const apiError = this.getApiError(response);
      if (apiError) {
        throw new Error(`OpenCode API error: ${JSON.stringify(apiError)}`);
      }

      const responseData = this.getApiData<{
        parts?: OpenCodePart[];
        info?: unknown;
      }>(response);
      if (!responseData) {
        throw new Error('OpenCode API error: missing response data');
      }

      console.log('[OpenCodeTool] ========== FINAL RESPONSE ==========');
      console.log('[OpenCodeTool] Response data:', JSON.stringify(responseData, null, 2));
      console.log('[OpenCodeTool] ===================================');

      // Check for error in response
      let hasError = false;
      let errorMessage = '';
      const responseInfo = (responseData.info ?? undefined) as
        | {
            error?: { data?: { message?: string }; message?: string };
          }
        | undefined;
      if (responseInfo?.error) {
        const errorInfo = responseInfo.error;
        errorMessage =
          errorInfo.data?.message || errorInfo.message || 'Unknown error from OpenCode';
        console.error('[OpenCodeTool] OpenCode returned error:', errorMessage);
        hasError = true;

        // Stream the error message to the user as assistant response
        if (!currentTextMessageId) {
          currentTextMessageId = generateId();
          streamingCallbacks.onStreamStart(currentTextMessageId as MessageID, {
            session_id: sessionId as SessionID,
            task_id: taskId as TaskID | undefined,
            role: 'assistant',
            timestamp: new Date().toISOString(),
          });
        }

        // Format error message for display
        const formattedError = `❌ **OpenCode Error**\n\n${errorMessage}`;
        streamingCallbacks.onStreamChunk(currentTextMessageId as MessageID, formattedError);
      }

      // End streaming notifications
      if (currentReasoningMessageId) {
        streamingCallbacks.onThinkingEnd?.(currentReasoningMessageId as MessageID);
      }
      if (currentTextMessageId) {
        streamingCallbacks.onStreamEnd(currentTextMessageId as MessageID);
      }

      // Extract final text from parts (or use error message if error occurred)
      let responseText = '';
      const textParts: string[] = [];

      if (hasError) {
        // Use the error message as the response text
        responseText = `❌ **OpenCode Error**\n\n${errorMessage}`;
      } else {
        // Only extract text from parts if no error occurred
        for (const part of responseData.parts || []) {
          // Collect text from reasoning and text parts
          // TextPart and ReasoningPart both have a .text property
          if (
            (part.type === 'reasoning' || part.type === 'text') &&
            'text' in part &&
            typeof part.text === 'string'
          ) {
            textParts.push(part.text);
          }

          // Extract metadata from step-finish part
          if (part.type === 'step-finish') {
            metadata.cost = part.cost;
            metadata.tokens = {
              input: part.tokens.input,
              output: part.tokens.output,
              reasoning: part.tokens.reasoning,
              cache: {
                read: part.tokens.cache.read,
                write: part.tokens.cache.write,
              },
            };
          }
        }

        responseText = textParts.join('\n');
        console.log('[OpenCodeTool] Final text length:', responseText.length);

        // Fallback: if no text found, return message
        if (!responseText) {
          responseText = 'No response text received from OpenCode';
        }
      }

      // Create assistant message in Agor database with OpenCode metadata
      if (!this.messagesService) {
        throw new Error('Messages service not available');
      }

      // Use provided index or default to 0
      // Handler should create user message first with index N, then pass N+1 here
      const assistantIndex = messageIndex ?? 0;

      // Build content blocks from all parts
      const contentBlocks: Array<{
        type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
        [key: string]: unknown;
      }> = [];
      const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

      // Process parts from final response (not from streaming cache)
      // The final response contains ALL parts, including ones that weren't streamed
      const finalParts = responseData.parts || [];
      console.log(
        '[OpenCodeTool] Building message content from',
        finalParts.length,
        'parts in final response'
      );
      console.log('[OpenCodeTool] Part types:', finalParts.map((p) => p.type).join(', '));
      for (const part of finalParts) {
        console.log('[OpenCodeTool] Processing part type:', part.type);

        if (part.type === 'reasoning' && part.text) {
          console.log('[OpenCodeTool] Adding reasoning block, text length:', part.text.length);
          contentBlocks.push({
            type: 'thinking',
            text: part.text,
          });
        } else if (part.type === 'reasoning') {
          console.log('[OpenCodeTool] Skipping reasoning part - no text field or empty text');
        }

        if (part.type === 'text' && part.text) {
          contentBlocks.push({
            type: 'text',
            text: part.text,
          });
        } else if (part.type === 'tool') {
          // Tool use block - extract tool info
          // OpenCode structure: { tool: string, callID: string, state: { input: {...}, output: "..." } }
          console.log('[OpenCodeTool] Processing tool part:', JSON.stringify(part, null, 2));

          const toolName = part.tool || 'unknown';
          const toolInput = (part.state as { input?: Record<string, unknown> })?.input || {};
          const toolCallId = part.callID || part.id;

          // Add tool_use block
          contentBlocks.push({
            type: 'tool_use',
            id: toolCallId,
            name: toolName,
            input: toolInput,
          });

          // Add to tool_uses array
          toolUses.push({
            id: toolCallId,
            name: toolName,
            input: toolInput,
          });

          // If tool has completed with output, add tool_result block
          const toolState = part.state as { status?: string; output?: unknown } | undefined;
          if (toolState?.status === 'completed' && toolState.output) {
            contentBlocks.push({
              type: 'tool_result',
              tool_use_id: toolCallId,
              content: toolState.output,
            });
          }
        }
      }

      // If no content blocks were created (error case), add the error text
      if (contentBlocks.length === 0 && responseText) {
        contentBlocks.push({
          type: 'text',
          text: responseText,
        });
      }

      console.log(
        '[OpenCodeTool] Created',
        contentBlocks.length,
        'content blocks,',
        toolUses.length,
        'tool uses'
      );

      // Best-effort diff enrichment for Edit/Write tool results
      enrichContentBlocks(contentBlocks);

      const message = await this.messagesService.create({
        message_id: (currentTextMessageId || generateId()) as MessageID,
        session_id: sessionId as SessionID,
        task_id: taskId as TaskID | undefined,
        type: 'assistant' as const,
        role: MessageRole.ASSISTANT,
        index: assistantIndex,
        timestamp: new Date().toISOString(),
        content_preview: responseText.substring(0, 200),
        content: contentBlocks,
        tool_uses: toolUses.length > 0 ? toolUses : undefined,
        // Store OpenCode metadata
        metadata:
          Object.keys(metadata).length > 0
            ? {
                opencode: metadata,
              }
            : undefined,
      });

      console.log('[OpenCodeTool] Message created:', message.message_id);

      return {
        taskId: taskId || '',
        status: hasError ? 'failed' : 'completed',
        messages: [],
        completedAt: new Date(),
      };
    } catch (error) {
      console.error('[OpenCodeTool] executeTask failed:', error);
      const errorObj = error instanceof Error ? error : new Error(String(error));
      return {
        taskId: taskId || '',
        status: 'failed',
        messages: [],
        error: errorObj,
        completedAt: new Date(),
      };
    }
  }

  /**
   * Non-streaming execution path (fallback when no callbacks provided)
   */
  private async executeTaskNonStreaming(
    client: ReturnType<typeof createOpencodeClient>,
    sessionId: string,
    taskId: string | undefined,
    promptOptions: {
      path: { id: string };
      body: {
        parts: Array<{ type: 'text'; text: string }>;
        model?: { providerID: string; modelID: string };
      };
      query?: { directory?: string };
    },
    opencodeSessionId: string,
    messageIndex?: number
  ): Promise<TaskResult> {
    const response = await client.session.prompt(promptOptions);

    const apiError = this.getApiError(response);
    if (apiError) {
      throw new Error(`OpenCode API error: ${JSON.stringify(apiError)}`);
    }

    const responseData = this.getApiData<{
      parts?: OpenCodePart[];
      info?: {
        id?: string;
        parentID?: string;
      };
    }>(response);
    if (!responseData) {
      throw new Error('OpenCode API error: missing response data');
    }

    console.log('[OpenCodeTool] Response received, parts count:', responseData.parts?.length || 0);
    console.log(
      '[OpenCodeTool] Part types:',
      responseData.parts?.map((p) => p.type).join(', ') || 'none'
    );

    // Extract text and metadata from response
    let responseText = '';
    const metadata: {
      messageId?: string;
      parentMessageId?: string;
      cost?: number;
      tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number };
      };
    } = {};

    // Extract metadata from 'info' field
    if (responseData.info) {
      if (responseData.info.id) {
        metadata.messageId = responseData.info.id;
      }
      if (responseData.info.parentID) {
        metadata.parentMessageId = responseData.info.parentID;
      }
    }

    // Extract text and token/cost metadata from 'parts' array
    if (responseData.parts && Array.isArray(responseData.parts)) {
      // Extract text from all parts that have text content (text, reasoning, etc.)
      const textParts: string[] = [];
      for (const part of responseData.parts) {
        // TextPart and ReasoningPart both have a .text property
        if (
          (part.type === 'text' || part.type === 'reasoning') &&
          'text' in part &&
          typeof part.text === 'string'
        ) {
          textParts.push(part.text);
        }
      }
      responseText = textParts.join('\n');
      console.log('[OpenCodeTool] Extracted', textParts.length, 'text parts');

      // Extract metadata from step-finish part
      const stepFinish = responseData.parts.find((part) => part.type === 'step-finish');
      if (stepFinish && stepFinish.type === 'step-finish') {
        metadata.cost = stepFinish.cost;
        metadata.tokens = {
          input: stepFinish.tokens.input,
          output: stepFinish.tokens.output,
          reasoning: stepFinish.tokens.reasoning,
          cache: {
            read: stepFinish.tokens.cache.read,
            write: stepFinish.tokens.cache.write,
          },
        };
      }
    }

    // Fallback: if no text found, return empty
    if (!responseText) {
      responseText = 'No response text received from OpenCode';
    }

    console.log('[OpenCodeTool] Response text:', responseText.substring(0, 100));
    if (metadata.tokens) {
      console.log('[OpenCodeTool] Response metadata:', metadata);
    }

    // Create assistant message in Agor database with OpenCode metadata
    if (!this.messagesService) {
      throw new Error('Messages service not available');
    }

    // Use provided index or default to 0
    const assistantIndex = messageIndex ?? 0;

    const message = await this.messagesService.create({
      message_id: generateId() as MessageID,
      session_id: sessionId as SessionID,
      task_id: taskId as TaskID | undefined,
      type: 'assistant' as const,
      role: MessageRole.ASSISTANT,
      index: assistantIndex,
      timestamp: new Date().toISOString(),
      content_preview: responseText.substring(0, 200),
      content: [
        {
          type: 'text',
          text: responseText,
        },
      ],
      // Store OpenCode metadata
      metadata:
        Object.keys(metadata).length > 0
          ? {
              opencode: metadata,
            }
          : undefined,
    });

    console.log('[OpenCodeTool] Message created:', message);

    return {
      taskId: taskId || '',
      status: 'completed',
      messages: [],
      completedAt: new Date(),
    };
  }

  /**
   * Get session metadata
   */
  async getSessionMetadata?(sessionId: string): Promise<SessionMetadata> {
    const client = this.getClient();

    try {
      const response = await client.session.get({
        path: { id: sessionId },
      });

      const apiError = this.getApiError(response);
      if (apiError) {
        throw new Error(`OpenCode API error: ${JSON.stringify(apiError)}`);
      }

      const responseData = this.getApiData<{
        time?: { created?: string; updated?: string };
      }>(response);
      if (!responseData?.time?.created || !responseData.time.updated) {
        throw new Error('OpenCode API error: missing session timestamps');
      }

      return {
        sessionId,
        toolType: 'opencode' as const,
        status: 'active',
        createdAt: new Date(responseData.time.created),
        lastUpdatedAt: new Date(responseData.time.updated),
      };
    } catch (error) {
      throw new Error(
        `Failed to get session metadata: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get session messages
   */
  async getSessionMessages?(sessionId: string): Promise<Message[]> {
    const client = this.getClient();

    try {
      // TODO: Implement proper message fetching from OpenCode
      // For now, return empty array since OpenCode messages are streamed directly
      const response = await client.session.messages({
        path: { id: sessionId },
      });

      const apiError = this.getApiError(response);
      if (apiError) {
        console.error('Failed to get messages:', apiError);
        return [];
      }

      return [];
    } catch (error) {
      console.error('Failed to get session messages:', error);
      // Don't throw - return empty array as fallback
      return [];
    }
  }

  /**
   * List all available sessions
   */
  async listSessions?(): Promise<SessionMetadata[]> {
    const client = this.getClient();

    try {
      const response = await client.session.list();

      const apiError = this.getApiError(response);
      if (apiError) {
        throw new Error(`OpenCode API error: ${JSON.stringify(apiError)}`);
      }

      const responseData =
        this.getApiData<Array<{ id: string; time: { created: string; updated: string } }>>(
          response
        );
      const sessions = Array.isArray(responseData) ? responseData : [];

      return sessions.map((session) => ({
        sessionId: session.id,
        toolType: 'opencode' as const,
        status: 'active' as const,
        createdAt: new Date(session.time.created),
        lastUpdatedAt: new Date(session.time.updated),
      }));
    } catch (error) {
      throw new Error(
        `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ============================================================
  // Token Accounting (NEW)
  // ============================================================

  /**
   * Normalize OpenCode SDK response to common format
   *
   * @deprecated This method is deprecated - use normalizeRawSdkResponse() from utils/sdk-normalizer instead
   * This stub remains for API compatibility but should not be used.
   */
  normalizedSdkResponse(_rawResponse: RawSdkResponse): NormalizedSdkResponse {
    throw new Error(
      'normalizedSdkResponse() is deprecated - use normalizeRawSdkResponse() from utils/sdk-normalizer instead'
    );
  }
}
