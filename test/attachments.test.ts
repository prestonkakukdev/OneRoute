import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { attachmentsOf, buildJevState, extractFacts, imageSize, pdfPages } from '../src/classifier/state.js';
import { Store } from '../src/db/store.js';
import { buildUpstreamBody } from '../src/gateway/execute.js';
import { rankCandidates } from '../src/router/optimizer.js';
import { DEFAULT_PREFERENCES } from '../src/router/router.js';
import type { ChatRequest } from '../src/types.js';
import { facts, makeTask } from './fixtures.js';

function png(w: number, h: number): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x89504e47, 0);
  header.writeUInt32BE(0x0d0a1a0a, 4);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(w, 16);
  header.writeUInt32BE(h, 20);
  return Buffer.concat([header, deflateSync(Buffer.alloc(10))]);
}
function jpeg(w: number, h: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]);
}
const pdf = (pages: number) =>
  Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Pages /Kids [] /Count ${pages} >> endobj\n` + Array.from({ length: pages }, (_, i) => `${i + 2} 0 obj << /Type /Page /Parent 1 0 R >> endobj`).join('\n'));
const dataUrl = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;

const withFiles: ChatRequest = {
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Summarise the report and describe the chart' },
        { type: 'file', file: { filename: 'q3-report.pdf', file_data: dataUrl('application/pdf', pdf(12)) } },
        { type: 'image_url', image_url: { url: dataUrl('image/png', png(800, 600)) } },
      ],
    },
  ],
};

describe('attachments', () => {
  it('reads image sizes and PDF page counts', () => {
    expect(imageSize(png(1920, 1080))).toEqual({ w: 1920, h: 1080 });
    expect(imageSize(jpeg(640, 480))).toEqual({ w: 640, h: 480 });
    expect(pdfPages(pdf(7))).toBe(7);
  });

  it('estimates prompt tokens from the actual files', () => {
    const [doc, img] = attachmentsOf(withFiles.messages[0]!.content);
    expect(doc).toMatchObject({ kind: 'pdf', name: 'q3-report.pdf', pages: 12 });
    expect(doc!.tokens).toBeGreaterThan(10_000);
    expect(img!.tokens).toBe(640); // 800 x 600 / 750
    const small = attachmentsOf([{ type: 'image_url', image_url: { url: dataUrl('image/png', png(4000, 3000)) } }])[0]!;
    expect(small.tokens).toBe(1600); // providers downscale large images
    const f = extractFacts(withFiles);
    expect(f).toMatchObject({ hasFiles: true, hasImages: true, attachments: { images: 1, pdfs: 1, pdfPages: 12, files: 0 } });
    expect(f.inputTokens).toBeGreaterThan(15_000);
  });

  it('tells Jev what is attached to the latest message', () => {
    const state = buildJevState(withFiles, extractFacts(withFiles));
    expect(state.attachments.latest).toEqual([
      { kind: 'pdf', name: 'q3-report.pdf', pages: 12 },
      { kind: 'image', name: undefined, pages: undefined },
    ]);
  });

  it('keeps models without native PDF input eligible, at a small penalty', () => {
    const store = new Store(':memory:');
    const models = store.listModels();
    const native = models.find((m) => m.inputModalities.includes('file'))!;
    const parsed = models.find((m) => !m.inputModalities.includes('file'))!;
    const task = makeTask({ type: 'extraction', difficulty: 2 });
    const f = facts({ hasFiles: true, inputTokens: 8000 });
    const { ranked, rejected } = rankCandidates({
      models: [native, parsed],
      task,
      facts: f,
      prefs: { mode: 'balanced', preferences: DEFAULT_PREFERENCES },
      useWeb: false,
      learning: { stats: new Map(), priorStrength: 10, exploration: 0 },
    });
    expect(rejected[parsed.id]).toBeUndefined();
    const penalty = (id: string) => ranked.find((c) => c.modelId === id)!.breakdown!.preference;
    expect(penalty(parsed.id)).toBeGreaterThan(penalty(native.id));
  });

  it('asks OpenRouter for free text extraction only when the model cannot read PDFs itself', () => {
    const store = new Store(':memory:');
    const models = store.listModels();
    const native = models.find((m) => m.inputModalities.includes('file'))!;
    const parsed = models.find((m) => !m.inputModalities.includes('file'))!;
    const decision = { useWeb: false, facts: extractFacts(withFiles) };
    expect(buildUpstreamBody(withFiles, native.id, 'low', native, decision).plugins).toBeUndefined();
    expect(buildUpstreamBody(withFiles, parsed.id, 'low', parsed, decision).plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }]);
    expect(buildUpstreamBody(withFiles, parsed.id, 'low', parsed, { ...decision, useWeb: true }).plugins).toEqual([
      { id: 'web' },
      { id: 'file-parser', pdf: { engine: 'cloudflare-ai' } },
    ]);
  });
});
