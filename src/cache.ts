import { createHash } from 'node:crypto';
import { config } from './config.js';
import type { ChatMessage, RequestFacts } from './types.js';

export const CACHE_MIN_TOKENS = 1024;
// One-off requests this large are worth caching even without a known conversation.
const CACHE_ONE_OFF_MIN_TOKENS = 4096;

// Whether (and for how long) to write a prompt cache: from the first turn of a conversation the client
// identified (so turn 2 can reuse it), from the second turn of any conversation, and for one-off requests only
// when they are large.
export function cachePlan(facts: RequestFacts, explicitSession: boolean): { write: boolean; ttl: '5m' | '1h' } {
  const conversation = explicitSession || facts.prefixTokens > 0;
  const write = facts.inputTokens >= CACHE_MIN_TOKENS && (conversation || facts.inputTokens >= CACHE_ONE_OFF_MIN_TOKENS);
  return { write, ttl: conversation ? config.sessionCacheTtl : '5m' };
}

// A stable id for a conversation whose client sends no session id: the system prompt plus the first user
// message (plus a hash of the caller's key, so different users never share one). Turn 1 and every later
// turn of the same conversation produce the same id, which lets the router keep the conversation on one
// model and reuse its prompt cache.
export function conversationId(messages: ChatMessage[], caller = ''): string | undefined {
  const text = (m: ChatMessage | undefined) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''));
  const system = messages.filter((m) => m.role === 'system' || m.role === 'developer').map(text).join('\n');
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return undefined;
  const hash = createHash('sha256').update(caller).update('\0').update(system).update('\0').update(text(firstUser)).digest('hex');
  return `conv_${hash.slice(0, 24)}`;
}
