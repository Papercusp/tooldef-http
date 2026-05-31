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
} from '@papercusp/tooldef';
import {
  handleHttpToolRequest,
  type HttpToolRequest,
  type HttpToolHostExtras,
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
