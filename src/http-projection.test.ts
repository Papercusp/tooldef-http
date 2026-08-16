/**
 * Standalone smoke test for the HTTP adapter — imports ONLY @papercusp/tooldef
 * + this package (no agent-mcp, no host policies). Proves the adapter routes +
 * dispatches with an empty DI surface. The Papercusp-integration coverage
 * (superuser admission, bearer auth, quota 429) lives in
 * @papercusp/agent-mcp's http-projection.test.ts, which supplies the host policies.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerProjectedTool,
  _resetProjectionRegistryForTests,
  type ProjectedTool,
  type UnifiedToolContext,
} from '@papercusp/tooldef';
import {
  handleHttpToolRequest,
  type HttpToolRequest,
  type HttpToolHostExtras,
  type ToolScope,
} from './http-projection';

const makeTool = (over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'fixture',
  description: 'fixture tool',
  inputSchema: { type: 'object' },
  capabilities: [],
  expose: { mcp: { name: 'fix.tool' }, http: { path: '/api/plugins/fixture/tool' } },
  fn: async (input) => ({ content: [{ type: 'text', text: `echo:${JSON.stringify(input)}` }] }),
  ...over,
});

const REQ = (over: Partial<HttpToolRequest> = {}): HttpToolRequest => ({
  method: 'POST',
  pathname: '/api/plugins/fixture/tool',
  searchParams: new URLSearchParams(),
  headers: {},
  body: { x: 1 },
  ...over,
});

const EXTRAS = (over: Partial<HttpToolHostExtras> = {}): HttpToolHostExtras => ({ deps: {}, ...over });

afterEach(() => _resetProjectionRegistryForTests());

describe('handleHttpToolRequest (standalone — no host policies)', () => {
  it('dispatches a tool and returns 200 + content', async () => {
    registerProjectedTool(makeTool());
    const res = await handleHttpToolRequest(REQ(), EXTRAS());
    expect(res.status).toBe(200);
    expect((res.body as { content: Array<{ text: string }> }).content[0].text).toContain('echo:');
  });

  it('returns 404 for an unknown path', async () => {
    const res = await handleHttpToolRequest(REQ({ pathname: '/api/nope' }), EXTRAS());
    expect(res.status).toBe(404);
  });

  it('returns 405 for a disallowed method', async () => {
    registerProjectedTool(makeTool());
    const res = await handleHttpToolRequest(REQ({ method: 'DELETE' }), EXTRAS());
    expect(res.status).toBe(405);
  });
});

describe('runScoped scoping seam (P-062 Phase 3)', () => {
  // A tool that records the ctx.tx it was dispatched with, so we can assert
  // which DB handle the seam routed to the handler.
  const txRecorderTool = (sink: { tx?: unknown }): ProjectedTool =>
    makeTool({
      fn: async (_input, ctx) => {
        sink.tx = (ctx as { tx?: unknown }).tx;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

  it('runs dispatch inside runScoped, and the tx it yields becomes ctx.tx', async () => {
    const SENTINEL = { marker: 'scoped-tx' } as unknown;
    const sink: { tx?: unknown } = {};
    registerProjectedTool(txRecorderTool(sink));
    let scopedCalled = false;
    const res = await handleHttpToolRequest(
      REQ(),
      EXTRAS({
        runScoped: async (_scope, run) => {
          scopedCalled = true;
          return run(SENTINEL as UnifiedToolContext['tx']);
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(scopedCalled).toBe(true);
    expect(sink.tx).toBe(SENTINEL);
  });

  it('falls back to the static resolvePrincipalAndTx tx when runScoped is absent', async () => {
    const STATIC = { marker: 'static-tx' } as unknown;
    const sink: { tx?: unknown } = {};
    registerProjectedTool(txRecorderTool(sink));
    const res = await handleHttpToolRequest(
      REQ({ headers: { authorization: 'Bearer x' } }),
      EXTRAS({
        resolvePrincipalAndTx: async () => ({
          principal: { slug: 's', workspaceId: 'w', capabilities: new Set<string>() },
          tx: STATIC as UnifiedToolContext['tx'],
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(sink.tx).toBe(STATIC);
  });

  it('passes the resolved scope (tool, workspaceId, isSuperuser) to runScoped', async () => {
    let scope: ToolScope | undefined;
    registerProjectedTool(makeTool());
    await handleHttpToolRequest(
      REQ({ searchParams: new URLSearchParams('workspace=ws-42') }),
      EXTRAS({
        runScoped: async (s, run) => { scope = s; return run(undefined); },
      }),
    );
    expect(scope?.workspaceId).toBe('ws-42');
    expect(scope?.tool.expose.mcp?.name).toBe('fix.tool');
    expect(scope?.isSuperuser).toBe(false);
  });
});
