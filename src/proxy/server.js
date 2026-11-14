/**
 * Zero-Dependency Local HTTP Proxy Mode (P2)
 *
 * Exposes:
 *   - POST /v1/chat/completions (OpenAI / DeepSeek / LiteLLM compatible)
 *   - POST /v1/messages         (Anthropic Messages API compatible)
 *   - GET  /health
 *   - GET  /metrics
 */

import http from 'node:http';
import { UniversalAgentOptimizer } from '../core/optimizer.js';
import { OpenAICompatibleAdapter } from '../adapters/openai-compatible.js';
import { AnthropicAdapter } from '../adapters/anthropic.js';
import { runBuiltinToolLoop } from '../core/builtin-tools.js';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function createProxyServer({
  optimizer = null,
  upstreamBaseUrl,
  provider = 'openai',
  fetchImpl = globalThis.fetch,
  autoExecuteBuiltinTools = true,
  maxBuiltinToolRounds = 4,
} = {}) {
  if (!upstreamBaseUrl) throw new Error('createProxyServer: upstreamBaseUrl is required');
  const activeOptimizer = optimizer || new UniversalAgentOptimizer();

  const upstream = upstreamBaseUrl.replace(/\/$/, '');
  const openaiAdapter = new OpenAICompatibleAdapter({ optimizer: activeOptimizer, provider });
  const anthropicAdapter = new AnthropicAdapter({ optimizer: activeOptimizer });

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && urlPath === '/health') {
      return sendJson(res, 200, { ok: true, mode: 'proxy', provider });
    }

    if (req.method === 'GET' && urlPath === '/metrics') {
      return sendJson(res, 200, { ok: true, metrics: activeOptimizer.getMetrics() });
    }

    if (req.method === 'POST' && (urlPath === '/v1/chat/completions' || urlPath === '/v1/messages')) {
      try {
        const body = await readJsonBody(req);
        const sessionId = String(req.headers['x-session-id'] || 'proxy-default');
        const conversationKey = String(req.headers['x-conversation-key'] || sessionId);
        const scene = String(req.headers['x-agent-scene'] || 'default');
        const agentId = String(req.headers['x-agent-id'] || 'proxy-client');

        const isAnthropic = urlPath === '/v1/messages';
        const adapter = isAnthropic ? anthropicAdapter : openaiAdapter;
        const autoToolsHeader = req.headers['x-uao-auto-tools'];
        const meta = {
          agentId,
          sessionId,
          conversationKey,
          scope: String(req.headers['x-agent-scope'] || conversationKey),
          tenantId: req.headers['x-tenant-id'] ? String(req.headers['x-tenant-id']) : null,
          scene,
          provider: isAnthropic ? 'anthropic' : provider,
          toolFormat: isAnthropic ? 'anthropic' : 'openai',
          ...(autoToolsHeader === 'true' ? { autoBuiltinTools: true } : {}),
          ...(autoToolsHeader === 'false' ? { autoBuiltinTools: false } : {}),
        };

        const { payload, prepared } = await adapter.transformRequest(body, meta);

        const forwardHeaders = { 'content-type': 'application/json' };
        if (req.headers.authorization) forwardHeaders.authorization = req.headers.authorization;
        if (req.headers['x-api-key']) forwardHeaders['x-api-key'] = req.headers['x-api-key'];
        if (req.headers['anthropic-version']) forwardHeaders['anthropic-version'] = req.headers['anthropic-version'];

        let lastUpstreamStatus = 200;
        let finalJson = null;
        let builtinToolRounds = 0;

        const callUpstream = async (currentPayload) => {
          const upstreamRes = await fetchImpl(`${upstream}${urlPath}`, {
            method: 'POST',
            headers: forwardHeaders,
            body: JSON.stringify(currentPayload),
          });
          lastUpstreamStatus = upstreamRes.status;
          const json = await upstreamRes.json();
          if (!upstreamRes.ok) {
            return { ok: false, json };
          }
          return { ok: true, json };
        };

        if (autoExecuteBuiltinTools) {
          let aborted = false;
          const loopRes = await runBuiltinToolLoop({
            optimizer: activeOptimizer,
            initialPayload: payload,
            meta,
            maxRounds: maxBuiltinToolRounds,
            invokeUpstream: async (currentPayload) => {
              const out = await callUpstream(currentPayload);
              if (!out.ok) {
                aborted = true;
                return { __uaoAbort: true, json: out.json };
              }
              return out.json;
            },
            onResponse: async (resJson, _p, round) => {
              if (!aborted && !resJson?.__uaoAbort) {
                await adapter.recordResponse(meta, resJson, round === 0 ? prepared : null);
              }
            },
          });
          finalJson = aborted ? loopRes.response?.json : loopRes.response;
          builtinToolRounds = loopRes.rounds;
        } else {
          const out = await callUpstream(payload);
          finalJson = out.json;
          if (out.ok) {
            await adapter.recordResponse(meta, finalJson, prepared);
          }
        }

        res.writeHead(lastUpstreamStatus, {
          'content-type': 'application/json; charset=utf-8',
          'x-uao-session-id': prepared.sessionId,
          'x-uao-cache-intact': String(prepared.cacheCheck.prefixIntact),
          ...(builtinToolRounds > 0 ? { 'x-uao-builtin-tool-rounds': String(builtinToolRounds) } : {}),
        });
        res.end(JSON.stringify(finalJson));
      } catch (err) {
        sendJson(res, 502, { error: 'proxy_error', message: err?.message || String(err) });
      }
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  });

  return server;
}
