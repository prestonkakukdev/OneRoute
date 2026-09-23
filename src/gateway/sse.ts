// Incremental parser for OpenAI-style server-sent events ("data: {...}" lines).
export class SseLineParser {
  private buffer = '';
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): unknown[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.flatMap((line) => parseLine(line));
  }

  flush(): unknown[] {
    const rest = this.buffer;
    this.buffer = '';
    return parseLine(rest);
  }
}

function parseLine(line: string): unknown[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return [];
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return [];
  try {
    return [JSON.parse(data)];
  } catch {
    return [];
  }
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const parser = new SseLineParser();
  for await (const chunk of body) yield* parser.push(chunk);
  yield* parser.flush();
}
