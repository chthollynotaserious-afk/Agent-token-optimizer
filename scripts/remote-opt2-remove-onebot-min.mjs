import fs from 'node:fs';
import yaml from 'js-yaml';

const patchPath = '/home/ubuntu/.dsh/profiles/web/cordis.patch.yml';
let content = fs.readFileSync(patchPath, 'utf8');
const eol = content.includes('\r\n') ? '\r\n' : '\n';

const normalized = content.replace(/\r?\n/g, '\n');

// Find the block containing mcp-onebot-min
const onebotRegex = /- insert:\s*\n\s*- id: mcp-onebot-min[\s\S]*?toolCallTimeoutMs: 120000\s*\n?/m;

if (!onebotRegex.test(normalized)) {
  console.error('[FAIL] Could not match mcp-onebot-min block via regex');
  process.exit(1);
}

const cleaned = normalized.replace(onebotRegex, '').replace(/\n\n\n+/g, '\n\n');

// Validate YAML syntax
const parsed = yaml.load(cleaned);
if (!Array.isArray(parsed)) {
  console.error('[FAIL] Parsed YAML is not an array!');
  process.exit(1);
}

// Convert back to original EOL and write
const finalContent = cleaned.replace(/\n/g, eol);
fs.writeFileSync(patchPath, finalContent, 'utf8');

console.log('[OK] Successfully removed mcp-onebot-min from cordis.patch.yml');
