/**
 * Zero-Dependency Local HTTP Proxy Mode (P2)
 *
 * Exposes:
 *   - POST /v1/chat/completions (OpenAI / DeepSeek / LiteLLM compatible, JSON + SSE)
 *   - POST /v1/messages         (Anthropic Messages API compatible, JSON + SSE)
 *   - GET  /health
 *   - GET  /metrics
 */

import http from 'node:http';
import { UniversalAgentOptimizer } from '../core/optimizer.js';
import { OpenAICompatibleAdapter } from '../adapters/openai-compatible.js';
import { AnthropicAdapter } from '../adapters/anthropic.js';

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

function extractUsageFromSseBuffer(buffer) {
  let latestUsage = null;
  let latestModel = null;
  const lines = buffer.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed.model) latestModel = parsed.model;
      if (parsed.usage && typeof parsed.usage === 'object') {
        latestUsage = parsed.usage;
      } else if (parsed.message?.usage && typeof parsed.message.usage === 'object') {
        latestUsage = parsed.message.usage;
      }
    } catch {
      // ignore partial or non-JSON SSE lines
    }
  }
  return { usage: latestUsage, model: latestModel };
}

export function createProxyServer({
  optimizer = null,
  upstreamBaseUrl,
  provider = 'openai',
  fetchImpl = globalThis.fetch,
  passthrough = false,
  timeoutMs = 60_000,
} = {}) {
  if (!upstreamBaseUrl) throw new Error('createProxyServer: upstreamBaseUrl is required');
  const activeOptimizer = optimizer || new UniversalAgentOptimizer();

  const upstream = upstreamBaseUrl.replace(/\/$/, '');
  const openaiAdapter = new OpenAICompatibleAdapter({ optimizer: activeOptimizer, provider });
  const anthropicAdapter = new AnthropicAdapter({ optimizer: activeOptimizer });

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && urlPath === '/health') {
      return sendJson(res, 200, { ok: true, mode: passthrough ? 'passthrough' : 'proxy', provider });
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
        const reqPassthrough = passthrough || req.headers['x-uao-passthrough'] === 'true';

        const isAnthropic = urlPath === '/v1/messages';
        const adapter = isAnthropic ? anthropicAdapter : openaiAdapter;
        const meta = { agentId, sessionId, conversationKey, scene, provider: isAnthropic ? 'anthropic' : provider };

        let payload = body;
        let prepared = null;
        if (!reqPassthrough) {
          const transformed = await adapter.transformRequest(body, meta);
          payload = transformed.payload;
          prepared = transformed.prepared;
        }

        const forwardHeaders = { 'content-type': 'application/json' };
        if (req.headers.authorization) forwardHeaders.authorization = req.headers.authorization;
        if (req.headers['x-api-key']) forwardHeaders['x-api-key'] = req.headers['x-api-key'];
        if (req.headers['anthropic-version']) forwardHeaders['anthropic-version'] = req.headers['anthropic-version'];

        const signal = timeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
          ? AbortSignal.timeout(timeoutMs)
          : undefined;

        const upstreamRes = await fetchImpl(`${upstream}${urlPath}`, {
          method: 'POST',
          headers: forwardHeaders,
          body: JSON.stringify(payload),
          ...(signal ? { signal } : {}),
        });

        const contentType = upstreamRes.headers?.get?.('content-type') || 'application/json; charset=utf-8';
        const isSse = contentType.includes('text/event-stream');

        const responseHeaders = {
          'content-type': contentType,
          'x-uao-session-id': prepared?.sessionId || sessionId,
          'x-uao-cache-intact': String(prepared?.cacheCheck?.prefixIntact ?? true),
          'x-uao-passthrough': String(reqPassthrough),
        };

        if (isSse && upstreamRes.body && typeof upstreamRes.body.getReader === 'function') {
          res.writeHead(upstreamRes.status, responseHeaders);
          const reader = upstreamRes.body.getReader();
          const decoder = new TextDecoder();
          let sseText = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              res.write(value);
              sseText += decoder.decode(value, { stream: true });
            }
          }
          res.end();

          if (!reqPassthrough && upstreamRes.ok) {
            const { usage, model } = extractUsageFromSseBuffer(sseText);
            if (usage) {
              await adapter.recordResponse(meta, { model: model || payload.model, usage }, prepared);
            }
          }
          return;
        }

        const rawText = await upstreamRes.text();
        let responseJson = null;
        try {
          responseJson = rawText ? JSON.parse(rawText) : null;
        } catch {
          responseJson = null;
        }

        if (!reqPassthrough && upstreamRes.ok && responseJson) {
          await adapter.recordResponse(meta, responseJson, prepared);
        }

        res.writeHead(upstreamRes.status, responseHeaders);
        res.end(rawText);
      } catch (err) {
        const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        sendJson(res, isTimeout ? 504 : 502, {
          error: isTimeout ? 'proxy_timeout' : 'proxy_error',
          message: err?.message || String(err),
        });
      }
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  });

  return server;
}
