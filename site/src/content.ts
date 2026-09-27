// Everything the landing page says, in one place.

export const GITHUB_URL = 'https://github.com/prestonkakukdev/OneRoute';
export const QUICK_START_URL = `${GITHUB_URL}#quick-start`;
export const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;

export const NAV = [
  { label: 'GitHub', href: GITHUB_URL, external: true },
  { label: 'Pricing', href: '#pricing' },
  { label: 'API', href: '#api' },
  { label: 'About', href: '#about' },
  { label: 'License', href: LICENSE_URL, external: true },
];

// `estimate: true` marks targets that aren't measured yet (shown with an asterisk and a footnote).
// Replace them with benchmark results once the grading run is done.
export const STATS = [
  { value: '70%', label: 'lower cost than sending everything to a frontier model', estimate: true },
  { value: '98%', label: 'of frontier answer quality on everyday work', estimate: true },
  { value: '0.5s', label: 'to read a request and choose a model', estimate: false },
  { value: '109', label: 'models from 23 providers, every reasoning effort', estimate: false },
];
export const STATS_FOOTNOTE = 'Targets from early internal testing. Published benchmarks are on the way.';

export const STEPS = [
  { n: '01', title: 'Read', body: 'Jev answers twenty questions about the request in one fast call.' },
  { n: '02', title: 'Score', body: 'Every model, at every reasoning effort, on 16 benchmarked capabilities.' },
  { n: '03', title: 'Decide', body: 'Plain code picks the best trade-off, and says why.' },
  { n: '04', title: 'Learn', body: 'Real answers and your feedback sharpen every estimate.' },
];

export const COMPARISON = {
  columns: ['OneRoute', 'Preference-based routers', 'One frontier model'],
  rows: [
    { label: 'Chooses the reasoning effort, not just the model', values: [true, false, false] },
    { label: 'Scored per capability on independent benchmarks', values: [true, false, false] },
    { label: 'Explains every decision', values: [true, false, null] },
    { label: 'Cost and speed estimates from real usage', values: [true, false, false] },
    { label: 'Learns from your own feedback', values: [true, 'partly', false] },
    { label: 'Open source and self-hostable', values: [true, false, false] },
  ] as { label: string; values: (boolean | string | null)[] }[],
  note: 'Preference-based routers learn which model people tended to prefer for similar prompts. OneRoute reasons about what this request needs.',
};

export const API_EXAMPLES = {
  curl: `curl http://localhost:8787/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "auto",
    "messages": [{ "role": "user", "content": "Find the race condition in this worker pool" }]
  }'`,
  typescript: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8787/v1",
  apiKey: "unused",
});

const res = await client.chat.completions.create({
  model: "auto:cheap", // or "auto", "auto:best"
  messages: [{ role: "user", content: "Summarise this contract" }],
});`,
  python: `from openai import OpenAI

client = OpenAI(base_url="http://localhost:8787/v1", api_key="unused")

res = client.chat.completions.create(
    model="auto:best",
    messages=[{"role": "user", "content": "Prove there are infinitely many primes"}],
)`,
};

export const API_POINTS = [
  { title: 'OpenAI-compatible', body: 'Change the base URL, set the model to auto. Streaming, tools and files work as before.' },
  { title: 'Three modes', body: 'auto:cheap, auto:balanced and auto:best set the trade-off for each request.' },
  { title: 'Every decision on record', body: 'Each response carries the model, the effort, the cost and why it won.' },
];

export const PLANS = [
  {
    title: 'Self-hosted',
    subtitle: 'Free · open source',
    description: 'Run OneRoute on your own machine with your own keys. You pay model providers directly, at their prices.',
    highlights: ['Apache 2.0', 'Your own keys', 'Chat app + API', 'No markup'],
    action: 'Get the code',
    href: QUICK_START_URL,
  },
  {
    title: 'OneRoute Cloud',
    subtitle: 'Coming soon',
    description: 'Hosted routing with one key and one bill, nothing to install. Pricing will be announced at launch.',
    highlights: ['One API key', 'No setup', 'Usage dashboard', 'Team accounts'],
    action: 'Follow on GitHub',
    href: GITHUB_URL,
  },
];
