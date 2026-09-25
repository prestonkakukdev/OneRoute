import type { ChatMessage, ChatRequest, ContentPart, RequestFacts } from '../types.js';

const CHARS_PER_TOKEN = 3.6;
const IMAGE_TOKENS = 1100; // image of unknown size
const IMAGE_MAX_TOKENS = 1600; // providers downscale large images (~1.15 megapixels)
const PDF_PAGE_TOKENS = 1200; // text plus page image when read natively; less when parsed to text
const FILE_TOKENS = 3000; // file of unknown size

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

function dataUrlBytes(url: unknown, maxBytes = Infinity): Buffer | undefined {
  if (typeof url !== 'string') return undefined;
  const m = /^data:[^;,]*;base64,/.exec(url);
  if (!m) return undefined;
  const b64 = url.slice(m[0].length);
  return Buffer.from(Number.isFinite(maxBytes) ? b64.slice(0, Math.ceil((maxBytes * 4) / 3 / 4) * 4) : b64, 'base64');
}

// Width x height from a PNG, GIF, WebP or JPEG header.
export function imageSize(b: Buffer): { w: number; h: number } | undefined {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString('latin1', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length && b[i] === 0xff) {
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      // Start-of-frame markers (C0-CF except DHT C4, JPG C8, DAC CC) carry the dimensions.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return undefined;
}

export function imageTokens(url: unknown): number {
  const bytes = dataUrlBytes(url, 256 * 1024);
  const size = bytes && imageSize(bytes);
  if (!size || !size.w || !size.h) return IMAGE_TOKENS;
  // Providers bill roughly one token per ~750 pixels after downscaling large images.
  return Math.round(Math.max(100, Math.min(IMAGE_MAX_TOKENS, (size.w * size.h) / 750)));
}

// Page count of a PDF: page objects, or the page tree's /Count when pages sit in compressed object streams.
export function pdfPages(b: Buffer): number {
  const text = b.toString('latin1');
  const objects = text.match(/\/Type\s*\/Page(?![s\w])/g)?.length ?? 0;
  let count = 0;
  for (const m of text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) {
    count = Math.max(count, Number(m[1] ?? m[2]));
  }
  return Math.max(objects, count);
}

export interface Attachment {
  kind: 'image' | 'pdf' | 'file' | 'audio';
  name?: string;
  pages?: number;
  tokens: number;
}

function fileData(p: ContentPart): { name?: string; data?: string } {
  const f = (p as { file?: { filename?: unknown; file_data?: unknown } }).file;
  return { name: typeof f?.filename === 'string' ? f.filename : undefined, data: typeof f?.file_data === 'string' ? f.file_data : undefined };
}

// Files and images attached to a message, with an estimate of the tokens each adds to the prompt.
export function attachmentsOf(content: ChatMessage['content']): Attachment[] {
  const out: Attachment[] = [];
  for (const p of parts(content)) {
    if (p.type === 'image_url') {
      const iu = (p as { image_url?: { url?: unknown } | string }).image_url;
      out.push({ kind: 'image', tokens: imageTokens(typeof iu === 'string' ? iu : iu?.url) });
    } else if (p.type === 'file') {
      const { name, data } = fileData(p);
      const isPdf = /\.pdf$/i.test(name ?? '') || data?.startsWith('data:application/pdf');
      const bytes = isPdf ? dataUrlBytes(data) : undefined;
      const pages = bytes ? pdfPages(bytes) || Math.max(1, Math.round(bytes.length / 60_000)) : undefined;
      out.push({ kind: isPdf ? 'pdf' : 'file', name, pages, tokens: pages ? pages * PDF_PAGE_TOKENS : FILE_TOKENS });
    } else if (p.type === 'input_audio') out.push({ kind: 'audio', tokens: FILE_TOKENS });
  }
  return out;
}

function messageTokens(m: ChatMessage): number {
  let tokens = estimateTokens(textOf(m.content)) + 4;
  for (const a of attachmentsOf(m.content)) tokens += a.tokens;
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
  const attached = msgs.flatMap((m) => attachmentsOf(m.content));
  const pdfs = attached.filter((a) => a.kind === 'pdf');
  return {
    inputTokens: total,
    prefixTokens: prefix,
    hasImages: countParts(msgs, 'image_url') > 0,
    hasFiles: countParts(msgs, 'file') > 0,
    hasAudio: countParts(msgs, 'input_audio') > 0,
    toolsPresent: (req.tools?.length ?? 0) > 0,
    jsonSchemaRequired: req.response_format?.type === 'json_schema',
    requestedMaxTokens: typeof maxTokens === 'number' ? maxTokens : undefined,
    attachments: attached.length
      ? {
          images: attached.filter((a) => a.kind === 'image').length,
          pdfs: pdfs.length,
          pdfPages: pdfs.reduce((n, a) => n + (a.pages ?? 0), 0),
          files: attached.filter((a) => a.kind === 'file').length,
        }
      : undefined,
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
      // Attached to the latest message (names help: "Q3-report.pdf", "screenshot.png").
      latest: (last >= 0 ? attachmentsOf(msgs[last]!.content) : []).slice(0, 20).map(({ kind, name, pages }) => ({ kind, name, pages })),
      // Attached anywhere in the conversation.
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
