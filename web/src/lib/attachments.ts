// Files attached to a message: images and PDFs go as data URLs, text/code files inline as text.

export type Attachment =
  | { kind: 'image'; name: string; size: number; dataUrl: string; detail?: string }
  | { kind: 'pdf'; name: string; size: number; dataUrl: string; pages?: number }
  | { kind: 'text'; name: string; size: number; text: string };

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

export const MAX_ATTACHMENTS = 10;
export const MAX_REQUEST_BYTES = 30 * 1024 * 1024; // the server accepts 32 MB per request
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const IMAGE_MAX_EDGE = 2048; // providers downscale beyond this anyway
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const readDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('unreadable image'));
    img.src = src;
  });

// Large photos are scaled down before sending: smaller uploads, same result (providers downscale anyway).
async function prepareImage(file: File) {
  const dataUrl = await readDataUrl(file);
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.width, img.height));
  if (scale === 1 && file.size <= 4 * 1024 * 1024 && file.type !== 'image/gif') return { dataUrl, w: img.width, h: img.height };
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const type = file.type === 'image/png' && file.size < 4 * 1024 * 1024 ? 'image/png' : 'image/jpeg';
  return { dataUrl: canvas.toDataURL(type, 0.9), w: canvas.width, h: canvas.height };
}

// Page objects, or the page tree's /Count when pages sit in compressed object streams.
function countPdfPages(buffer: ArrayBuffer): number | undefined {
  const text = new TextDecoder('latin1').decode(buffer);
  const objects = (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  let count = 0;
  for (const m of text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) {
    count = Math.max(count, Number(m[1] ?? m[2]));
  }
  return Math.max(objects, count) || undefined;
}

const looksBinary = (s: string) => s.slice(0, 8000).includes('\u0000');

export async function prepareFiles(files: File[], existing: number): Promise<{ added: Attachment[]; errors: string[] }> {
  const added: Attachment[] = [];
  const errors: string[] = [];
  for (const file of files) {
    if (existing + added.length >= MAX_ATTACHMENTS) {
      errors.push(`Up to ${MAX_ATTACHMENTS} attachments per message.`);
      break;
    }
    try {
      if (IMAGE_TYPES.includes(file.type)) {
        const { dataUrl, w, h } = await prepareImage(file);
        added.push({ kind: 'image', name: file.name || 'pasted image', size: Math.round(dataUrl.length * 0.75), dataUrl, detail: `${w}×${h}` });
      } else if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        if (file.size > MAX_PDF_BYTES) {
          errors.push(`${file.name} is larger than 20 MB.`);
          continue;
        }
        added.push({ kind: 'pdf', name: file.name, size: file.size, dataUrl: await readDataUrl(file), pages: countPdfPages(await file.arrayBuffer()) });
      } else if (file.type.startsWith('image/')) {
        errors.push(`${file.name}: only PNG, JPEG, WebP and GIF images are supported.`);
      } else {
        if (file.size > MAX_TEXT_BYTES) {
          errors.push(`${file.name} is larger than 1 MB of text.`);
          continue;
        }
        const text = await file.text();
        if (looksBinary(text)) {
          errors.push(`${file.name}: not a text file (supported: images, PDFs, code and text files).`);
          continue;
        }
        added.push({ kind: 'text', name: file.name, size: file.size, text });
      }
    } catch (err) {
      errors.push(`${file.name}: ${(err as Error).message}`);
    }
  }
  return { added, errors };
}

// OpenAI-style content parts; text files inline so every model can read them.
export function buildContent(text: string, files: Attachment[]): string | ContentPart[] {
  if (!files.length) return text;
  const parts: ContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const f of files) {
    if (f.kind === 'image') parts.push({ type: 'image_url', image_url: { url: f.dataUrl } });
    else if (f.kind === 'pdf') parts.push({ type: 'file', file: { filename: f.name, file_data: f.dataUrl } });
    else parts.push({ type: 'text', text: `<file name="${f.name.replace(/"/g, "'")}">\n${f.text}\n</file>` });
  }
  return parts;
}
