/**
 * HTTP transport adapter for projected tools.
 *
 * The dynamic catch-all route at apps/operator/app/api/plugins/[...path]
 * (and any other catch-alls per agent-tools etc.) delegates to
 * `handleHttpToolRequest()`. This module is the pure routing logic —
 * isolated for testability without a Next.js / Hono runtime.
 *
 * Flow (per inbound HTTP request):
 *   1. Look up the tool by URL pathname via lookupByHttpPath.
 *   2. Verify request method is in tool.expose.http.methods (default POST).
 *   3. Build a UnifiedToolContext from request headers + URL query params:
 *        - bearer → resolveBearer → principal/tx (built-in tools)
 *        - X-Papercusp-* headers → spawn context (workspace, role, …)
 *        - urlSearchParams → fallback for the spawn context (parity with
 *          MCP transport's URL-param model)
 *   4. Validate input against tool.inputSchema (TODO: wire ajv when we
 *      build it; v1 trusts the route to validate or trusts the fn).
 *   5. Branch on the tool's expose.http content-type preference:
 *        - JSON (default): build sync response from dispatch result.
 *        - SSE (when tool.expose.mcp?.streaming and Accept includes
 *          text/event-stream): stream {progress, result} events.
 *   6. dispatchProjectedTool with the right deps.
 *   7. Shape result back to HTTP response.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */
import type { SseSink } from '@papercusp/sse';
import { type AgentRole, type DispatchProjectedDeps } from '@papercusp/tooldef';
import { type ProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';
/** Headers we read from inbound HTTP requests to populate the spawn ctx. */
export declare const PAPERCUSP_CONTEXT_HEADERS: {
    readonly workspace: 'x-papercusp-workspace';
    readonly harness: 'x-papercusp-harness';
    readonly role: 'x-papercusp-role';
    readonly feature: 'x-papercusp-feature';
    readonly chunk: 'x-papercusp-chunk';
    readonly run: 'x-papercusp-run';
    readonly spawn: 'x-papercusp-spawn';
    readonly parentSpawn: 'x-papercusp-parent-spawn';
    readonly client: 'x-papercusp-client';
};
/** Headers and URL params an HTTP caller can supply. */
export interface HttpRequestContextInput {
    /** Lowercased header map. */
    headers: Record<string, string | undefined>;
    /** Parsed URL query string (for parity with MCP URL-param transport). */
    searchParams: URLSearchParams;
}
/**
 * Build a partial UnifiedToolContext from HTTP request inputs. The
 * caller (route handler) layers in `log`, `signal`, `progress`, `tx`,
 * and `principal` from its own auth/PG path; this fn populates only the
 * spawn context fields that are derivable from headers/query.
 */
export declare function buildHttpSpawnContext(input: HttpRequestContextInput): {
    workspaceId?: string;
    harnessSlug?: string;
    role?: AgentRole;
    featureId?: string | null;
    chunkId?: string | null;
    runId?: string;
    spawnId?: string;
    parentSpawnId?: string | null;
    projectDir?: string;
    stateDir?: string;
    uiClientId?: string | null;
};
export interface HttpToolRequest {
    method: string;
    pathname: string;
    searchParams: URLSearchParams;
    headers: Record<string, string | undefined>;
    body: unknown;
}
export interface HttpToolResponse {
    status: number;
    body: Record<string, unknown> | {
        error: {
            code: string;
            message: string;
            meta?: Record<string, unknown>;
        };
    };
}
export type HttpToolResult = {
    kind: 'json';
    status: number;
    body: unknown;
} | {
    kind: 'stream';
    tool: ProjectedTool;
    ctx: UnifiedToolContext;
    input: unknown;
};
/**
 * Resolve a request to a ProjectedTool via lookupByHttpPath, build the
 * UnifiedToolContext, and dispatch.
 *
 * The host wires `extras` — a dependency surface giving us access to
 * bearer-auth resolution (for built-in tools), PG (for tx + quota +
 * recording), and a logger. The host also constructs the function-side
 * `progress` callback (no-op for non-streaming HTTP, SSE writer for
 * streaming).
 */
/**
 * The scope the host needs to pick a DB handle for one tool dispatch
 * (P-062 Phase 3). Passed to `HttpToolHostExtras.runScoped` so the host —
 * not this adapter — owns the admin-vs-workspace-scoped policy.
 */
export interface ToolScope {
    /** The resolved tool — the host may read a per-tool cross-workspace opt-out off it. */
    tool: ProjectedTool;
    /** Resolved auth principal, if any (bearer / device JWT). */
    principal: UnifiedToolContext['principal'];
    /** Spawn workspace id. `'*'` or undefined for superuser / unscoped calls. */
    workspaceId: string | undefined;
    /** True when admitted via `?superuser=1` — host should NOT workspace-scope these. */
    isSuperuser: boolean;
}
export interface HttpToolHostExtras {
    /** Resolves a bearer token to a principal + tx; null on auth failure. */
    resolvePrincipalAndTx?(bearer: string): Promise<{
        principal: NonNullable<UnifiedToolContext['principal']>;
        tx: UnifiedToolContext['tx'];
    } | null>;
    /**
     * Scoping seam (P-062 Phase 3). When present, the adapter runs the tool's
     * dispatch INSIDE this callback so the HOST — not this adapter — picks the
     * DB handle the tool sees as `ctx.tx`: a workspace-bound (RLS-subject)
     * handle for normal calls, or the admin (rolbypassrls) handle for superuser
     * calls and tools that declare themselves cross-workspace. The adapter
     * overrides `ctx.tx` with whatever `run` is given and stays policy-free.
     * When ABSENT, the adapter uses the static `ctx.tx` from
     * resolvePrincipalAndTx (legacy path). A host whose impl is
     * `runScoped: (_s, run) => run(adminTx)` is behavior-identical to the
     * pre-seam path — neutral by construction until the host opts to scope.
     */
    runScoped?<T>(scope: ToolScope, run: (tx: UnifiedToolContext['tx']) => Promise<T>): Promise<T>;
    /** Quota + invocation persistence. */
    deps: DispatchProjectedDeps;
    /** Per-tool logger; receives line + plugin/tool/ctx for routing. */
    log?(line: string, ctx: UnifiedToolContext): void;
    /** Progress writer — for non-streaming HTTP, this is no-op. */
    progress?(pct: number | undefined, msg: string | undefined, ctx: UnifiedToolContext): void;
    /**
     * Capability-gated subprocess helper. Plugin tools that need to shell
     * out (repomix, code2prompt, …) call `ctx.spawn(bin, argv, opts)`. The
     * host owns the impl so it can route through its capability check
     * + PATH resolution. Same shape used by the MCP transport.
     */
    spawn?: NonNullable<UnifiedToolContext['spawn']>;
    /** Secret resolver for plugin tools needing API keys (FIRECRAWL_API_KEY etc). */
    secret?: NonNullable<UnifiedToolContext['secret']>;
    /**
     * Resolve a harness slug + workspace id to project + state dirs. The
     * MCP transport already does this via the operator's
     * `resolveHarnessPaths`; HTTP needs the same resolver so plugin tools
     * (repomix, code2prompt, …) get a populated `ctx.projectDir`.
     */
    /**
     * Optional superuser admission check. Called when the request URL
     * has `?superuser=1`. Return true to admit (bypasses role + quota
     * gates). Return false to reject — the dispatcher returns 401
     * unauthorized rather than fall through to anonymous dispatch.
     *
     * Hosts typically check loopback origin + bearer-token equality.
     * See `apps/operator/lib/superuser-token.ts` for the operator impl.
     */
    validateSuperuser?(req: HttpToolRequest): boolean;
    resolveHarnessPaths?(harnessSlug: string, workspaceId: string): Promise<{
        projectDir: string;
        stateDir: string;
    }>;
}
export declare function handleHttpToolRequest(req: HttpToolRequest, extras: HttpToolHostExtras): Promise<HttpToolResponse>;
/**
 * Handle a streaming tool request — same flow as `handleHttpToolRequest`
 * but writes Server-Sent Events into the caller-supplied `SseSink`.
 *
 * Wire events the framework emits automatically:
 *   event: done    data: <ToolResult.content as JSON>  (on handler return)
 *   event: error   data: { code, message }             (on dispatch failure)
 *
 * Plus whatever the handler emits via `ctx.emit` and `ctx.progress`.
 *
 * The `ctx.emit` passed to the handler is wired here to fan each
 * call to a sink event. The legacy `ctx.progress` is reshaped as
 * a thin alias over `ctx.emit('progress', { progress, total, message? })`.
 *
 * Caller is responsible for opening the SSE response (via @papercusp/sse's
 * `sseResponse({ setup: (sink) => handleHttpToolRequestStreaming(...) })`).
 * This function closes the sink before returning.
 */
export declare function handleHttpToolRequestStreaming(req: HttpToolRequest, extras: HttpToolHostExtras, sink: SseSink): Promise<void>;
