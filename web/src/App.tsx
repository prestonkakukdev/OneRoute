import { AnimatePresence, motion } from 'framer-motion';
import {
  GlobeIcon,
  PaperclipIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  RouteIcon,
  SlidersHorizontalIcon,
  SquarePenIcon,
  TelescopeIcon,
} from 'lucide-react';
import * as React from 'react';
import { AttachmentTile } from '@/components/attachment-tile';
import { ChatSidebar } from '@/components/chat-sidebar';
import { Chip } from '@/components/chip';
import { Inspector } from '@/components/inspector';
import { AssistantMessage, type Turn, UserMessage } from '@/components/messages';
import { PreferencesDialog, weightWord } from '@/components/preferences-dialog';
import {
  AiPromptInput,
  type AiModel,
  type AiPromptActiveTool,
  type AiPromptSendStatus,
  PromptMenuItem,
  PromptMenuLabel,
  PromptMenuSeparator,
  PromptToolbarButton,
} from '@/components/ui/ai-prompt-input';
import { type ChatMessage, type ChatSummary, chats, type Mode, type Preferences, sendFeedback, streamChat, type WebSetting } from '@/lib/api';
import { type Attachment, buildContent, MAX_REQUEST_BYTES, prepareFiles } from '@/lib/attachments';
import { storage } from '@/lib/storage';
import { cn } from '@/lib/utils';

// Routing modes shown in the composer's model selector.
const MODES: AiModel[] = [
  { id: 'cheap', label: 'Cheap', description: 'Minimises cost. Uses strong models only when cheaper ones would likely fail. Waiting time barely counts.' },
  { id: 'balanced', label: 'Balanced', description: 'Weighs answer quality against cost and speed. Fast, well-liked models for simple requests, frontier models for hard ones.' },
  { id: 'best', label: 'Best', description: 'Maximises answer quality and raises reasoning effort freely. Cost matters little.' },
];

const PLACEHOLDERS = ['Ask anything…', 'Prove a theorem…', 'Debug this stack trace…', 'Write a short story…', 'Summarise this contract…', 'What changed in AI this week?'];

const SUGGESTIONS = [
  "hey! how's it going?",
  'Prove there are infinitely many primes p ≡ 3 (mod 4).',
  'Why does my useEffect loop forever?',
  'Write a 600-word short story about a lighthouse keeper.',
  'What did Anthropic announce this week?',
];

const newId = () => crypto.randomUUID();

// The model-facing conversation, rebuilt from saved turns (answered turns only; web sources kept, so
// follow-ups know where facts came from).
function historyFrom(turns: Turn[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const t of turns) {
    if (!t.answer) continue;
    const sources = t.done?.sources ?? [];
    const sourcesText = sources.length ? `\n\nSources (web search):\n${sources.map((s) => `- ${s.title}: ${s.url}`).join('\n')}` : '';
    out.push({ role: 'user', content: buildContent(t.text ?? t.prompt, t.attachments ?? []) });
    out.push({ role: 'assistant', content: t.answer + sourcesText });
  }
  return out;
}

const chatIdFromUrl = () => new URLSearchParams(location.search).get('c') ?? undefined;
function setChatInUrl(id?: string) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('c', id);
  else url.searchParams.delete('c');
  history.replaceState(null, '', url);
}

// Inspector width follows the window (360-500px); on narrow windows it sits below the chat instead.
function useInspectorWidth() {
  const calc = () => (window.innerWidth < 1024 ? window.innerWidth : Math.round(Math.min(500, Math.max(360, window.innerWidth * 0.34))));
  const [w, setW] = React.useState(calc);
  React.useEffect(() => {
    const onResize = () => setW(calc());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}

function PanelToggle({ open, side, onClick }: { open: boolean; side: 'left' | 'right'; onClick: () => void }) {
  const Icon = side === 'left' ? (open ? PanelLeftCloseIcon : PanelLeftOpenIcon) : open ? PanelRightCloseIcon : PanelRightOpenIcon;
  const what = side === 'left' ? 'chats' : 'routing details';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${open ? 'Hide' : 'Show'} ${what}`}
      aria-expanded={open}
      title={`${open ? 'Hide' : 'Show'} ${what}`}
      className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-9 cursor-pointer items-center justify-center rounded-xl transition-colors active:scale-[0.96]"
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

function prefBits(p: Preferences): string[] {
  const bits: string[] = [];
  if (p.qualityWeight && p.qualityWeight !== 1) bits.push(`quality: ${weightWord(p.qualityWeight).toLowerCase()}`);
  if (p.costWeight && p.costWeight !== 1) bits.push(`cost: ${weightWord(p.costWeight).toLowerCase()}`);
  if (p.speedWeight && p.speedWeight !== 1) bits.push(`speed: ${weightWord(p.speedWeight).toLowerCase()}`);
  if (p.openWeights && p.openWeights !== 'any') bits.push(`open: ${p.openWeights}`);
  if (p.preferProviders?.length) bits.push(`prefer ${p.preferProviders.join('/')}`);
  if (p.avoidProviders?.length) bits.push(`avoid ${p.avoidProviders.join('/')}`);
  if (p.minQuality) bits.push(`min ${p.minQuality}`);
  return bits;
}

function WebSegment({ value, onChange }: { value: WebSetting; onChange: (v: WebSetting) => void }) {
  const opts: [WebSetting, string][] = [
    ['auto', 'Auto'],
    ['on', 'Always'],
    ['off', 'Never'],
  ];
  return (
    <div className="bg-muted mx-2.5 mt-0.5 mb-1.5 flex gap-0.5 rounded-[10px] p-0.5" role="radiogroup" aria-label="Web search">
      {opts.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            'flex-1 cursor-pointer rounded-lg py-1 text-xs font-medium transition-colors duration-150',
            value === v ? 'bg-popover text-foreground shadow-[inset_0_0_0_1px_rgba(123,123,123,0.12)]' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [mode, setMode] = React.useState<Mode>(() => storage.get('mode', 'balanced'));
  const [prefs, setPrefs] = React.useState<Preferences>(() => {
    const { web: _web, ...rest } = storage.get<Preferences & { web?: WebSetting }>('prefs', {});
    return rest;
  });
  const [web, setWeb] = React.useState<WebSetting>(() => storage.get<{ web?: WebSetting }>('prefs', {}).web ?? storage.get('web', 'auto'));
  const [dryRun, setDryRun] = React.useState(() => storage.get('dryRun', false));
  const [escalation, setEscalation] = React.useState(() => storage.get('escalation', true));
  const [gatewayKey, setGatewayKey] = React.useState(() => storage.get('key', ''));
  const [prefsOpen, setPrefsOpen] = React.useState(false);

  const [sidebarOpen, setSidebarOpen] = React.useState(() => storage.get('sidebar', window.innerWidth >= 1100));
  const [inspectorOpen, setInspectorOpen] = React.useState(() => storage.get('inspector', true));
  const inspectorWidth = useInspectorWidth();
  const [chatList, setChatList] = React.useState<ChatSummary[]>([]);
  const [chatError, setChatError] = React.useState<string>();

  const [sessionId, setSessionId] = React.useState(() => chatIdFromUrl() ?? newId());
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [selectedId, setSelectedId] = React.useState<string>();
  const [status, setStatus] = React.useState<AiPromptSendStatus>('idle');
  const [value, setValue] = React.useState('');
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const [attachError, setAttachError] = React.useState('');
  const [dragging, setDragging] = React.useState(false);

  const history = React.useRef<ChatMessage[]>([]);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => storage.set('mode', mode), [mode]);
  React.useEffect(() => storage.set('prefs', { ...prefs, web }), [prefs, web]);
  React.useEffect(() => storage.set('dryRun', dryRun), [dryRun]);
  React.useEffect(() => storage.set('escalation', escalation), [escalation]);
  React.useEffect(() => storage.set('sidebar', sidebarOpen), [sidebarOpen]);
  React.useEffect(() => storage.set('inspector', inspectorOpen), [inspectorOpen]);

  const refreshChats = React.useCallback(async () => {
    try {
      setChatList(await chats.list());
      setChatError(undefined);
    } catch (err) {
      setChatError(`Could not load chats: ${(err as Error).message}`);
    }
  }, []);

  const saveTurn = React.useCallback(
    async (chatId: string, turn: Turn, title: string) => {
      try {
        await chats.saveTurn(chatId, turn, title);
        void refreshChats();
      } catch (err) {
        setChatError(`Could not save this chat: ${(err as Error).message}`);
      }
    },
    [refreshChats],
  );

  const openChat = React.useCallback(async (id: string) => {
    try {
      const chat = await chats.get<Turn>(id);
      history.current = historyFrom(chat.turns);
      setSessionId(id);
      setTurns(chat.turns);
      setSelectedId(chat.turns.at(-1)?.id);
      setAttachments([]);
      setAttachError('');
      setChatInUrl(id);
      requestAnimationFrame(() => scroller.current && (scroller.current.scrollTop = scroller.current.scrollHeight));
    } catch (err) {
      setChatInUrl(undefined);
      setChatError(`Could not open that chat: ${(err as Error).message}`);
    }
  }, []);

  // Reopen the chat in the address bar (so a refresh keeps your place) and load the list.
  React.useEffect(() => {
    const id = chatIdFromUrl();
    if (id) void openChat(id);
    void refreshChats();
  }, [openChat, refreshChats]);

  const updateTurn = React.useCallback((id: string, patch: (t: Turn) => Partial<Turn>) => {
    setTurns((all) => all.map((t) => (t.id === id ? { ...t, ...patch(t) } : t)));
  }, []);

  const nearBottom = () => {
    const el = scroller.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const scrollToBottom = () => requestAnimationFrame(() => scroller.current && (scroller.current.scrollTop = scroller.current.scrollHeight));

  const addFiles = React.useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const { added, errors } = await prepareFiles(files, attachments.length);
      setAttachments((a) => [...a, ...added]);
      setAttachError(errors.join(' '));
    },
    [attachments.length],
  );

  // Files dropped anywhere on the window.
  React.useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => hasFiles(e) && (depth++, setDragging(true));
    const leave = () => --depth <= 0 && ((depth = 0), setDragging(false));
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void addFiles([...e.dataTransfer.files]);
      inputRef.current?.focus();
    };
    document.addEventListener('dragenter', enter);
    document.addEventListener('dragleave', leave);
    document.addEventListener('dragover', over);
    document.addEventListener('drop', drop);
    return () => {
      document.removeEventListener('dragenter', enter);
      document.removeEventListener('dragleave', leave);
      document.removeEventListener('dragover', over);
      document.removeEventListener('drop', drop);
    };
  }, [addFiles]);

  const newChat = () => {
    setSessionId(newId());
    setChatInUrl(undefined);
    setTurns([]);
    setSelectedId(undefined);
    setAttachments([]);
    setAttachError('');
    history.current = [];
    inputRef.current?.focus();
  };

  const send = async (text: string) => {
    if (status === 'loading' || (!text && !attachments.length)) return;
    const files = attachments;
    const content = buildContent(text, files);
    if (JSON.stringify(history.current).length + JSON.stringify(content).length > MAX_REQUEST_BYTES) {
      setAttachError('This conversation is too large to send (attachments are re-sent every turn). Remove an attachment or start a new chat.');
      return;
    }
    setValue('');
    setAttachments([]);
    setAttachError('');
    setStatus('loading');

    const id = newId();
    const chatId = sessionId;
    const title = turns[0]?.prompt ?? (text || files.map((f) => f.name).join(', '));
    let turn: Turn = { id, text, prompt: text || files.map((f) => f.name).join(', '), attachments: files, why: [], answer: '', thinking: false, dryRun };
    // A local copy of the turn follows every update, so the finished turn can be saved.
    const patchTurn = (patch: Partial<Turn>) => {
      turn = { ...turn, ...patch };
      updateTurn(id, () => patch);
    };
    setTurns((all) => [...all, turn]);
    setChatInUrl(chatId);
    setSelectedId(id);
    history.current = [...history.current, { role: 'user', content }];
    scrollToBottom();

    // Deltas are batched into one render per frame.
    let pending = '';
    let frame = 0;
    const flush = () => {
      frame = 0;
      const stick = nearBottom();
      const chunk = pending;
      pending = '';
      updateTurn(id, (t) => ({ answer: t.answer + chunk }));
      if (stick) scrollToBottom();
    };

    let answer = '';
    let sources: { url: string; title: string }[] = [];
    try {
      await streamChat(
        { messages: history.current, mode, preferences: prefs, web, escalation: escalation ? 'auto' : 'off', sessionId, dryRun },
        (e) => {
          if (e.event === 'delta') {
            answer += e.data.text;
            pending += e.data.text;
            if (!frame) frame = requestAnimationFrame(flush);
            return;
          }
          if (e.event === 'decision') patchTurn({ decision: e.data.decision, why: e.data.why });
          else if (e.event === 'thinking') patchTurn({ thinking: true });
          else if (e.event === 'done') {
            sources = e.data.sources ?? [];
            patchTurn({ done: e.data });
          } else if (e.event === 'error') {
            const hint = e.data.status === 402 ? '\n\nOpenRouter needs credits for real answers. Turn on "Route only" in the + menu to keep testing routing for free.' : '';
            patchTurn({ error: e.data.message + hint });
          }
        },
      );
    } catch (err) {
      patchTurn({ error: (err as Error).message });
    }
    if (frame) {
      cancelAnimationFrame(frame);
      flush();
    }
    turn = { ...turn, answer };
    void saveTurn(chatId, turn, title);
    // Web sources stay in the conversation, so follow-ups know where facts came from.
    const sourcesText = sources.length ? `\n\nSources (web search):\n${sources.map((s) => `- ${s.title}: ${s.url}`).join('\n')}` : '';
    if (answer) {
      history.current = [...history.current, { role: 'assistant', content: answer + sourcesText }];
      setStatus('success');
      window.setTimeout(() => setStatus('idle'), 900);
    } else {
      history.current = history.current.slice(0, -1);
      setStatus('idle');
    }
    inputRef.current?.focus();
  };

  const feedback = async (t: Turn, success: boolean, note: string) => {
    if (!t.decision) return;
    const ok = await sendFeedback(t.decision.requestId, success, note || undefined);
    const feedbackText = ok ? (success ? 'Recorded 👍' : 'Recorded 👎') : 'Could not record feedback';
    updateTurn(t.id, () => ({ feedback: feedbackText }));
    if (ok) void saveTurn(sessionId, { ...t, feedback: feedbackText }, turns[0]?.prompt ?? t.prompt);
  };

  const activeTools: AiPromptActiveTool[] = [];
  if (web === 'off') activeTools.push({ key: 'web-off', label: 'Web search off', icon: <GlobeIcon aria-hidden />, onRemove: () => setWeb('auto') });
  if (dryRun) activeTools.push({ key: 'route-only', label: 'Route only', icon: <RouteIcon aria-hidden />, onRemove: () => setDryRun(false) });
  if (!escalation) activeTools.push({ key: 'no-esc', label: 'No escalation', icon: <TelescopeIcon aria-hidden />, onRemove: () => setEscalation(true) });
  const bits = prefBits(prefs);
  if (bits.length) activeTools.push({ key: 'prefs', label: bits.join(' · '), icon: <SlidersHorizontalIcon aria-hidden />, onRemove: () => setPrefs({}) });

  const userTurns = turns.length;
  const selected = turns.find((t) => t.id === selectedId);

  return (
    <div className="grid h-full grid-rows-[auto_1fr]">
      <header className="app-header flex items-center gap-2.5 border-b py-2 pr-3 pl-2.5">
        <PanelToggle side="left" open={sidebarOpen} onClick={() => setSidebarOpen((v) => !v)} />
        <div className="flex size-5.5 items-center justify-center rounded-[7px] bg-linear-to-b from-[#f7f7f7] to-white text-black">
          <RouteIcon className="size-3.5" aria-hidden />
        </div>
        <h1 className="text-sm font-semibold tracking-tight">Model Router</h1>
        <Chip tone="soft">{userTurns ? `${userTurns} turn${userTurns > 1 ? 's' : ''}` : 'new session'}</Chip>
        <div className="flex-1" />
        <button
          type="button"
          onClick={newChat}
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-9 cursor-pointer items-center gap-2 rounded-xl px-3 text-[13px] font-medium transition-colors active:scale-[0.96]"
        >
          <SquarePenIcon className="size-4" aria-hidden />
          New chat
        </button>
        <PanelToggle side="right" open={inspectorOpen} onClick={() => setInspectorOpen((v) => !v)} />
      </header>

      <div className="flex min-h-0 max-lg:flex-col">
        <ChatSidebar
          open={sidebarOpen}
          chats={chatList}
          activeId={sessionId}
          error={chatError}
          onClose={() => setSidebarOpen(false)}
          onNew={() => {
            newChat();
            if (window.innerWidth < 1024) setSidebarOpen(false);
          }}
          onOpen={(id) => {
            void openChat(id);
            if (window.innerWidth < 1024) setSidebarOpen(false);
          }}
          onRename={async (id, title) => {
            await chats.rename(id, title).catch((err: Error) => setChatError(`Could not rename: ${err.message}`));
            void refreshChats();
          }}
          onDelete={async (id) => {
            await chats.remove(id).catch((err: Error) => setChatError(`Could not delete: ${err.message}`));
            if (id === sessionId) newChat();
            void refreshChats();
          }}
        />
        <section className="grid min-h-0 min-w-0 flex-1 grid-rows-[1fr_auto]">
          <div ref={scroller} className="min-h-0 overflow-y-auto px-6 pt-7 pb-3 max-lg:px-4">
            <div className="mx-auto flex max-w-190 flex-col gap-5.5">
              {turns.length === 0 ? (
                <motion.div
                  initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  transition={{ duration: 0.35, ease: [0.2, 0, 0, 1] }}
                  className="mx-auto mt-[12vh] max-w-130 text-center"
                >
                  <h2 className="mb-2 text-[22px] font-semibold tracking-tight">What should the router handle?</h2>
                  <p className="text-muted-foreground">
                    Every answer shows the model and effort that were picked. Click an answer to see Jev's reading of the request and why that model won.
                  </p>
                  <div className="mt-5.5 flex flex-wrap justify-center gap-2">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => void send(s)}
                        className="bg-muted text-muted-foreground hover:text-foreground cursor-pointer rounded-full px-3 py-1.5 text-[13px] shadow-[inset_0_0_0_1px_rgba(123,123,123,0.12)] transition-[color,transform] duration-150 hover:-translate-y-px"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </motion.div>
              ) : (
                turns.map((t) => (
                  <React.Fragment key={t.id}>
                    <UserMessage turn={t} />
                    <AssistantMessage turn={t} selected={t.id === selectedId} onSelect={() => setSelectedId(t.id)} />
                  </React.Fragment>
                ))
              )}
            </div>
          </div>

          <div className="mx-auto w-full max-w-200 px-6 pt-2 pb-5.5 max-lg:px-4 max-lg:pb-4">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void addFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
            <AiPromptInput
              ref={inputRef}
              value={value}
              onChange={setValue}
              onSubmit={(text) => void send(text)}
              status={status}
              placeholders={PLACEHOLDERS}
              models={MODES}
              modelSelection={{ id: mode }}
              onModelSelectionChange={(s) => setMode(s.id as Mode)}
              webSearch={web === 'on'}
              onWebSearchChange={(on) => setWeb(on ? 'on' : 'auto')}
              activeTools={activeTools}
              canSubmit={attachments.length > 0}
              onPasteFiles={(files) => void addFiles(files)}
              showMic={false}
              showVoice={false}
              maxLength={20000}
              aria-label="Message"
              className={cn(dragging && 'ring-foreground ring-2')}
              beforeInput={
                attachments.length || attachError ? (
                  <div className="mb-2.5 px-0.5">
                    {attachments.length ? (
                      <div className="flex flex-wrap gap-2">
                        {attachments.map((f, i) => (
                          <AttachmentTile
                            key={`${f.name}-${i}`}
                            file={f}
                            onRemove={() => {
                              setAttachments((a) => a.filter((_, j) => j !== i));
                              setAttachError('');
                            }}
                          />
                        ))}
                      </div>
                    ) : null}
                    {attachError ? (
                      <div role="alert" className="text-bad mt-2 text-xs">
                        {attachError}
                      </div>
                    ) : null}
                  </div>
                ) : null
              }
              toolbarStart={
                <PromptToolbarButton aria-label="Attach files" title="Attach images, PDFs or text files" onClick={() => fileInput.current?.click()}>
                  <PaperclipIcon aria-hidden />
                </PromptToolbarButton>
              }
              actionsMenu={(close) => (
                <>
                  <PromptMenuItem
                    icon={<PaperclipIcon />}
                    label="Attach files"
                    description="Images, PDFs, code and text files"
                    onSelect={() => {
                      close();
                      fileInput.current?.click();
                    }}
                  />
                  <PromptMenuSeparator />
                  <PromptMenuLabel>Web search</PromptMenuLabel>
                  <WebSegment value={web} onChange={setWeb} />
                  <PromptMenuItem icon={<RouteIcon />} label="Route only" description="Show the decision, don't call a model" checked={dryRun} onSelect={() => setDryRun((v) => !v)} />
                  <PromptMenuItem icon={<TelescopeIcon />} label="Escalation" description="Ask a second LLM when Jev is unsure" checked={escalation} onSelect={() => setEscalation((v) => !v)} />
                  <PromptMenuSeparator />
                  <PromptMenuItem
                    icon={<SlidersHorizontalIcon />}
                    label="Preferences…"
                    onSelect={() => {
                      close();
                      setPrefsOpen(true);
                    }}
                  />
                  <PromptMenuItem
                    icon={<SquarePenIcon />}
                    label="New chat"
                    onSelect={() => {
                      close();
                      newChat();
                    }}
                  />
                </>
              )}
            />
            <div className="text-muted-foreground/70 mt-2 text-center text-[11.5px]">
              Enter to send · Shift+Enter for a new line · drop or paste images, PDFs and text files
            </div>
          </div>
        </section>

        <AnimatePresence initial={false}>
          {inspectorOpen ? (
            <motion.aside
              key="inspector"
              aria-label="Routing details"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: inspectorWidth, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
              className="min-h-0 shrink-0 overflow-hidden border-l max-lg:max-h-[45vh] max-lg:border-t max-lg:border-l-0"
            >
              <div className="flex h-full flex-col gap-3 overflow-y-auto px-4.5 pt-4.5 pb-7" style={{ width: inspectorWidth }}>
                <Inspector turn={selected} onFeedback={feedback} />
              </div>
            </motion.aside>
          ) : null}
        </AnimatePresence>
      </div>

      <PreferencesDialog
        open={prefsOpen}
        prefs={prefs}
        gatewayKey={gatewayKey}
        onClose={() => setPrefsOpen(false)}
        onSave={(p, key) => {
          setPrefs(p);
          setGatewayKey(key);
          storage.set('key', key);
          setPrefsOpen(false);
        }}
      />
    </div>
  );
}
