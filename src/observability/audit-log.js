/**
 * AuditLog: structured decision & security audit trail (invocation gates, fallbacks,
 * rotation transactions, tool governance, and ACL denials).
 */
import fs from 'node:fs';
import path from 'node:path';

export class AuditLog {
  constructor({ file = null, maxMemoryEntries = 2000 } = {}) {
    this.file = file;
    this.maxMemoryEntries = maxMemoryEntries;
    this.entries = [];
  }

  log(category, action, details = {}) {
    const entry = {
      ts: Date.now(),
      category,
      action,
      ...details,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxMemoryEntries) {
      this.entries.shift();
    }
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch {}
    }
    return entry;
  }

  query({ category = null, limit = 100 } = {}) {
    const filtered = category
      ? this.entries.filter((e) => e.category === category)
      : this.entries;
    return filtered.slice(-limit);
  }
}
