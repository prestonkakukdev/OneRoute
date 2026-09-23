import type { ChatMessage, ChatRequest, ContentPart, RequestFacts } from '../types.js';

const CHARS_PER_TOKEN = 3.6;
const IMAGE_TOKENS = 1100;
const FILE_TOKENS = 3000; // unknown size; a typical PDF page batch

export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

function parts(content: ChatMessage['content']): ContentPart[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

export function textOf(content: ChatMessage['content']): string {
  return parts(content)
    .map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

function countParts(messages: ChatMessage[], type: string): number {
  return messages.reduce((n, m) => n + parts(m.content).filter((p) => p.type === type).length, 0);
}

function messageTokens(m: ChatMessage): number {
  const p = parts(m.content);
  let tokens = estimateTokens(textOf(m.content)) + 4;
  tokens += p.filter((x) => x.type === 'image_url').length * IMAGE_TOKENS;
  tokens += p.filter((x) => x.type === 'file').length * FILE_TOKENS;
  // Assistant tool calls and tool results carry their payload outside `content`.
  if (m.tool_calls) tokens += estimateTokens(JSON.stringify(m.tool_calls));
  return tokens;
}

function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') return i;
  return -1;
}

export function extractFacts(req: ChatRequest): RequestFacts {
  const msgs = req.messages;
  const last = lastUserIndex(msgs);
  const toolTokens = req.tools?.length ? estimateTokens(JSON.stringify(req.tools)) : 0;
  const prefix = msgs.slice(0, Math.max(last, 0)).reduce((n, m) => n + messageTokens(m), 0) + toolTokens;
  const total = msgs.reduce((n, m) => n + messageTokens(m), 0) + toolTokens;
  const maxTokens = req.max_completion_tokens ?? req.max_tokens;
  return {
    inputTokens: total,
    prefixTokens: prefix,
    hasImages: countParts(msgs, 'image_url') > 0,
    hasFiles: countParts(msgs, 'file') > 0,
    hasAudio: countParts(msgs, 'input_audio') > 0,
    toolsPresent: (req.tools?.length ?? 0) > 0,
    jsonSchemaRequired: req.response_format?.type === 'json_schema',
    requestedMaxTokens: typeof maxTokens === 'number' ? maxTokens : undefined,
  };
}

// Keeps the start and end of long text; the middle of a pasted log or file is the least informative.
export function clip(text: string, head: number, tail = 0): string {
  if (text.length <= head + tail) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n...[${omitted} characters omitted]...\n${tail ? text.slice(-tail) : ''}`;
}

function toolName(t: unknown): string | undefined {
  const tool = t as { function?: { name?: string }; name?: string; type?: string };
  return tool.function?.name ?? tool.name ?? tool.type;
}

// The compact "state" Jev judges. Stays far below Jev's 32K-token window even for huge requests.
export function buildJevState(req: ChatRequest, facts: RequestFacts) {
  const msgs = req.messages;
  const last = lastUserIndex(msgs);
  const latest = last >= 0 ? textOf(msgs[last]!.content) : '';
  const earlierUsers = msgs
    .slice(0, Math.max(last, 0))
    .filter((m) => m.role === 'user')
    .slice(-3)
    .map((m) => clip(textOf(m.content), 1200));
  const lastAssistant = msgs
    .slice(0, Math.max(last, 0))
    .filter((m) => m.role === 'assistant')
    .at(-1);
  const system = msgs.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => textOf(m.content)).join('\n');

  return {
    latest_user_message: clip(latest, 12000, 6000),
    earlier_user_messages: earlierUsers,
    previous_assistant_reply: lastAssistant ? clip(textOf(lastAssistant.content), 1500) : null,
    system_prompt: system ? clip(system, 2000) : null,
    conversation_turns: msgs.filter((m) => m.role === 'user').length,
    attachments: {
      images: countParts(msgs, 'image_url'),
      files: countParts(msgs, 'file'),
      audio: countParts(msgs, 'input_audio'),
    },
    tools_available: (req.tools ?? []).map(toolName).filter(Boolean).slice(0, 30),
    structured_output_required: facts.jsonSchemaRequired,
    estimated_input_tokens: facts.inputTokens,
  };
}

export function latestUserText(req: ChatRequest): string {
  const last = lastUserIndex(req.messages);
  return last >= 0 ? textOf(req.messages[last]!.content) : '';
}
