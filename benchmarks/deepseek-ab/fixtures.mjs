/**
 * Frozen, Synthetic Denia-Style Fixture Pack for UAO x DeepSeek A/B Benchmark.
 * Contains zero private production data or real credentials.
 */

import crypto from 'node:crypto';

const STATIC_SYSTEM_PREFIX = [
  'You are Denia-Bench, a synthetic test assistant for reproducible API benchmarking.',
  'Follow instructions precisely, keep answers concise, and return deterministic structured answers when asked.',
  'Context Policy: Never fabricate tool outputs; cite exact values from the conversation.',
].join('\n') + '\n' + 'Rule-Anchor: Maintain consistent prefix stability across turns. '.repeat(24);

export const FIXTURE_VERSION = '2026-11-16-v1';

export function buildFixtures({ smoke = false } = {}) {
  const s1Turns = smoke ? 4 : 20;
  const s2Turns = smoke ? 6 : 60;
  const s3Turns = smoke ? 8 : 100;

  return [
    {
      id: 'S0_NEG_CONTROL',
      name: 'Negative control (no optimization expected)',
      description: 'Single-turn short prompt where UAO should preserve request verbatim.',
      stream: false,
      temperature: 0,
      maxTokens: 64,
      expectedSubstr: 'ACK_S0',
      steps: [
        {
          step: 1,
          kind: 'chat',
          messages: [
            { role: 'system', content: 'Reply with exact token ACK_S0 only.' },
            { role: 'user', content: 'Confirm readiness.' },
          ],
        },
      ],
    },
    {
      id: 'S1',
      name: `Short ordinary dialogue (${s1Turns} turns)`,
      description: 'Baseline overhead and normal token accounting.',
      stream: true,
      temperature: 0,
      maxTokens: 64,
      expectedSubstr: 'OK',
      steps: Array.from({ length: s1Turns }, (_, idx) => ({
        step: idx + 1,
        kind: 'chat',
        messages: [
          { role: 'system', content: STATIC_SYSTEM_PREFIX },
          { role: 'user', content: `Turn ${idx + 1}: reply with OK-${idx + 1}.` },
        ],
      })),
    },
    {
      id: 'S2',
      name: `Medium conversation (${s2Turns} turns, stable prefix)`,
      description: 'Context growth and repeated-prefix cache behavior.',
      stream: false,
      temperature: 0,
      maxTokens: 48,
      expectedSubstr: 'STEP',
      steps: Array.from({ length: s2Turns }, (_, idx) => ({
        step: idx + 1,
        kind: 'chat',
        messages: [
          { role: 'system', content: STATIC_SYSTEM_PREFIX },
          { role: 'user', content: `Checkpoint ${idx + 1}: acknowledge STEP-${idx + 1}.` },
        ],
      })),
    },
    {
      id: 'S3',
      name: `Long conversation (${s3Turns} turns, dynamic field sensitivity)`,
      description: 'Long-context cost, lifecycle behavior, and dynamic-prefix cache sensitivity.',
      stream: false,
      temperature: 0,
      maxTokens: 48,
      expectedSubstr: 'LONG',
      steps: Array.from({ length: s3Turns }, (_, idx) => ({
        step: idx + 1,
        kind: 'chat',
        messages: [
          { role: 'system', content: STATIC_SYSTEM_PREFIX },
          { role: 'user', content: `DynamicNonce=${idx % 3}: reply LONG-${idx + 1}.` },
        ],
      })),
    },
    {
      id: 'S4',
      name: 'Repeated/no-op wakeups',
      description: 'Fixed event set testing invocation suppression & urgent bypass.',
      stream: false,
      temperature: 0,
      maxTokens: 32,
      expectedSubstr: 'URGENT',
      steps: [
        { step: 1, kind: 'wake', priority: 'low', eventId: 'heartbeat_1', duplicate: false, messages: [{ role: 'user', content: 'Heartbeat ping 1' }] },
        { step: 2, kind: 'wake', priority: 'low', eventId: 'heartbeat_1', duplicate: true, messages: [{ role: 'user', content: 'Heartbeat ping 1' }] },
        { step: 3, kind: 'wake', priority: 'low', eventId: 'heartbeat_2', duplicate: false, messages: [{ role: 'user', content: 'Heartbeat ping 2' }] },
        { step: 4, kind: 'wake', priority: 'urgent', eventId: 'user_direct_1', duplicate: false, messages: [{ role: 'user', content: 'URGENT: reply URGENT-OK' }] },
      ],
    },
    {
      id: 'S5',
      name: 'Tool round trips',
      description: 'Fixed tool-call script measuring schema governance and tool-output retention.',
      stream: false,
      temperature: 0,
      maxTokens: 64,
      expectedSubstr: 'TOOL_DONE',
      tools: [
        { type: 'function', function: { name: 'read_status', description: 'Read status', parameters: { type: 'object', properties: { id: { type: 'string' } } } } },
        { type: 'function', function: { name: 'unused_legacy_op', description: 'Unused tool', parameters: { type: 'object', properties: {} } } },
      ],
      steps: [
        {
          step: 1,
          kind: 'chat',
          messages: [
            { role: 'system', content: STATIC_SYSTEM_PREFIX },
            { role: 'tool', tool_call_id: 'call_1', content: 'LOG_LINE '.repeat(400) + '\nFINAL_STATUS=42' },
            { role: 'user', content: 'Summarize FINAL_STATUS and reply TOOL_DONE.' },
          ],
        },
      ],
    },
    {
      id: 'S6',
      name: 'Context handoff / recovery',
      description: 'Controlled interruption verifying handoff preservation.',
      stream: false,
      temperature: 0,
      maxTokens: 64,
      expectedSubstr: 'HANDOFF',
      steps: [
        {
          step: 1,
          kind: 'chat',
          messages: [
            { role: 'system', content: STATIC_SYSTEM_PREFIX },
            { role: 'user', content: 'Remember token KEY_ALPHA=99 and reply HANDOFF_1.' },
          ],
        },
        {
          step: 2,
          kind: 'chat',
          messages: [
            { role: 'system', content: STATIC_SYSTEM_PREFIX },
            { role: 'user', content: 'Confirm KEY_ALPHA=99 and reply HANDOFF_2.' },
          ],
        },
      ],
    },
    {
      id: 'S7',
      name: 'Failure cases (429 / 5xx)',
      description: 'Verify upstream error status preservation and safe fallback without corrupted state.',
      stream: false,
      temperature: 0,
      maxTokens: 32,
      expectErrorInMock: true,
      steps: [
        {
          step: 1,
          kind: 'failure_probe',
          forceStatus: 429,
          messages: [{ role: 'user', content: 'Trigger 429 check' }],
        },
      ],
    },
  ];
}

export function buildFixtureManifest(fixtures) {
  const scenarios = fixtures.map((f) => ({
    id: f.id,
    name: f.name,
    stepCount: f.steps.length,
    stream: Boolean(f.stream),
    sha256: crypto.createHash('sha256').update(JSON.stringify(f)).digest('hex'),
  }));
  return {
    fixtureVersion: FIXTURE_VERSION,
    scenarioCount: scenarios.length,
    manifestHash: crypto.createHash('sha256').update(JSON.stringify(scenarios)).digest('hex'),
    scenarios,
  };
}
