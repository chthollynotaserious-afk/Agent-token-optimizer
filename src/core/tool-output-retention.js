/**
 * Tool Result Retention & On-Demand Recovery (P1)
 *
 * Inspired by context-compress & Headroom CCR, implemented with zero external dependencies:
 *   - Retains full original tool outputs locally (memory + optional disk persistence)
 *   - Returns a compact summary handle with original sha256 & line/char stats for context
 *   - Allows exact recovery via retrieve(refId, { startLine, endLine, query, maxChars })
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class ToolResultRetentionStore {
  constructor({
    dir = null,
    maxInlineChars = 2400,
    headChars = 700,
    tailChars = 500,
    maxEntries = 1000,
  } = {}) {
    this.dir = dir;
    this.maxInlineChars = maxInlineChars;
    this.headChars = headChars;
    this.tailChars = tailChars;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  retain({ toolName = 'tool', rawOutput, now = Date.now() }) {
    const text = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput ?? '', null, 2);
    if (text.length <= this.maxInlineChars) {
      return {
        retained: false,
        refId: null,
        inlineText: text,
        originalChars: text.length,
      };
    }

    const sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    const refId = `tr_${sha256.slice(0, 12)}`;
    const lines = text.split(/\r?\n/);

    const record = {
      refId,
      toolName,
      sha256,
      originalChars: text.length,
      lineCount: lines.length,
      createdAt: now,
      text,
    };

    if (!this.entries.has(refId) && this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
    this.entries.set(refId, record);

    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(path.join(this.dir, `${refId}.txt`), text, 'utf8');
      } catch {}
    }

    const head = text.slice(0, this.headChars).trimEnd();
    const tail = text.slice(-this.tailChars).trimStart();
    const inlineText = [
      `[Retained Tool Output: refId=${refId}, tool=${toolName}, chars=${text.length}, lines=${lines.length}, sha256=${sha256.slice(0, 10)}]`,
      '--- HEAD ---',
      head,
      '--- TAIL ---',
      tail,
      `[Use tool uao_retrieve_tool_output({ refId: "${refId}", startLine, endLine, query }) to inspect omitted middle lines.]`,
    ].join('\n');

    return {
      retained: true,
      refId,
      sha256,
      inlineText,
      originalChars: text.length,
      inlineChars: inlineText.length,
      lineCount: lines.length,
    };
  }

  _loadRaw(refId) {
    const cached = this.entries.get(refId);
    if (cached) return cached;
    if (this.dir) {
      const file = path.join(this.dir, `${refId}.txt`);
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8');
        const sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
        const record = {
          refId,
          toolName: 'disk',
          sha256,
          originalChars: text.length,
          lineCount: text.split(/\r?\n/).length,
          text,
        };
        this.entries.set(refId, record);
        return record;
      }
    }
    return null;
  }

  retrieve(refId, { startLine = null, endLine = null, query = null, contextLines = 2, maxChars = 6000 } = {}) {
    const record = this._loadRaw(refId);
    if (!record) return { found: false, refId, content: '', reason: 'not_found' };

    const lines = record.text.split(/\r?\n/);

    if (query) {
      const q = String(query).toLowerCase();
      const matchedLineNums = [];
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLowerCase().includes(q)) matchedLineNums.push(i);
      }
      if (matchedLineNums.length === 0) {
        return { found: true, refId, sha256: record.sha256, matches: 0, content: '' };
      }
      const pickedIndices = new Set();
      for (const idx of matchedLineNums) {
        const from = Math.max(0, idx - contextLines);
        const to = Math.min(lines.length - 1, idx + contextLines);
        for (let j = from; j <= to; j += 1) pickedIndices.add(j);
      }
      const snippet = [...pickedIndices]
        .sort((a, b) => a - b)
        .map((idx) => `${idx + 1}: ${lines[idx]}`)
        .join('\n')
        .slice(0, maxChars);
      return {
        found: true,
        refId,
        sha256: record.sha256,
        matches: matchedLineNums.length,
        content: snippet,
      };
    }

    if (startLine != null || endLine != null) {
      const from = Math.max(1, Number(startLine) || 1);
      const to = Math.min(lines.length, Number(endLine) || from + 100);
      const slice = lines
        .slice(from - 1, to)
        .map((line, offset) => `${from + offset}: ${line}`)
        .join('\n')
        .slice(0, maxChars);
      return {
        found: true,
        refId,
        sha256: record.sha256,
        startLine: from,
        endLine: to,
        totalLines: lines.length,
        content: slice,
      };
    }

    return {
      found: true,
      refId,
      sha256: record.sha256,
      totalLines: lines.length,
      content: record.text.slice(0, maxChars),
      truncated: record.text.length > maxChars,
    };
  }
}
