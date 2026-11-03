// The AI routes (M05-J04, M08-J03). Nothing here opens a connection itself: the outbound calls are @storyforge/ai's sendPackage / streamPackage / testConnection / discoverCapabilities / generateImage.
// With no active provider profile for a book every AI route answers 409 AI_NOT_CONFIGURED and nothing is sent. The key never appears in a response.
import { IMAGE_KIND, KeystoreError, MAX_PROMPT_CHARS, buildContext, createAiSettings, createContextStore, discoverCapabilities, generateImage, hostOf, localityOf, publicProfile, redact, sendPackage, streamPackage, testConnection } from '@storyforge/ai';
import { createHash } from 'node:crypto';
import { promptText, recordProvenance } from '@storyforge/core';
import { resolvePromptRun } from './prompt-run.mjs';

const MAX_FILES = 100;
const MAX_INSTRUCTION_CHARS = 20_000;

/** @param {number} status @param {string} code @param {string} message @param {Record<string, unknown>} [extra] */
const refuse = (status, code, message, extra = {}) => ({ status, body: { error: code, code, message, ...extra } });
const badRequest = (message, code = 'BAD_ARGS') => ({ status: 400, body: { error: 'bad_request', code, message } });
const NOT_FOUND = { status: 404, body: { error: 'not_found' } };
const notConfigured = () => refuse(409, 'AI_NOT_CONFIGURED', 'AI is not set up for this book (Settings, Set up AI); nothing was sent');
const MAX_COVER_PROMPT = MAX_PROMPT_CHARS;

/** The refusal for a key store that cannot give a key back: a clear message, never a crash and never an empty key. @param {unknown} e */
function keystoreRefusal(e) {
  if (e instanceof KeystoreError) {
    return e.code === 'LOCKED'
      ? refuse(409, 'KEYS_LOCKED', e.message.startsWith('cannot unlock') ? e.message : `cannot unlock stored keys: ${e.message}`)
      : refuse(e.code === 'BAD_ARGS' ? 400 : 503, e.code === 'BAD_ARGS' ? 'BAD_ARGS' : 'KEY_STORE_FAILED', e.message);
  }
  throw e;
}

/** The key of a profile for the one request that sends it: `{ key }`, or `{ refusal }` when the stored key cannot be unlocked. */
async function keyFor(settings, profile) {
  try {
    return { key: await settings.keyFor(profile) };
  } catch (e) {
    return { refusal: keystoreRefusal(e) };
  }
}

/** What Settings and the dialogs may know about a profile: never the key. @param {any} p */
const summary = (p) => ({ id: p.id, name: p.name, model: p.model, host: hostOf(p.baseUrl), locality: localityOf(p.baseUrl) });

/** One AI service per server process: settings (profiles, session keys) and the stored context packages. */
export function createAiService(options = {}) {
  /** @type {Map<string, any>} the last discovery result per profile (models, streaming, usage), kept in memory only */
  const discovery = new Map();
  return { settings: createAiSettings(options.settings), contexts: createContextStore(options.contexts), discovery };
}
/** @type {ReturnType<typeof createAiService> | null} used only when a caller has no server state (direct handler calls) */
let fallback = null;
/** @param {any} state */
function serviceOf(state) {
  if (state) return (state.ai ??= createAiService());
  return (fallback ??= createAiService());
}

/** A provenance event must never break the request it reports on. The repository writes its receipt (M05-J07); a repository without that falls back to the hook. */
async function emit(repository, event) {
  try {
    if (typeof repository.recordProvenance === 'function') await repository.recordProvenance(event);
    else await recordProvenance(event);
  } catch {
    // the hook is advisory
  }
}

/** Book-relative path the context may read: a Markdown file inside the book, nothing hidden, nothing in provenance/. @param {unknown} p @returns {string | null} */
function safeBookPath(p) {
  if (typeof p !== 'string' || p === '' || p.length > 300 || !/\.md$/i.test(p) || p.includes('\\') || p.includes('\0') || /^[A-Za-z]:/.test(p)) return null;
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return null;
  if (segs[0] === 'provenance') return null;
  return p;
}

// ------------------------------------------------------------------ reads

/** The default cover prompt: from the book's title, genre and logline. The author edits it before anything is sent. */
function coverPrompt(book) {
  const genre = Array.isArray(book.genre) && book.genre.length > 0 ? ` ${book.genre.join(', ')}` : '';
  const blurb = typeof book.blurb === 'string' && book.blurb.trim() !== '' ? ` ${book.blurb.trim()}` : '';
  return `A book cover illustration for the${genre} novel "${book.title}".${blurb} No lettering or text in the picture.`.slice(0, MAX_COVER_PROMPT);
}

/**
 * GET /api/ai/profiles, GET /api/books/:b/ai/status, and (M08-J03) GET /api/books/:b/ai/cover, /ai/cover-draft?name=, /ai/stream?context=&from=.
 * @param {URLSearchParams} [params]
 * @returns {Promise<{ status: number, body: unknown, raw?: any }>}
 */
export async function handleAiRead(repository, state, route, bookId, params = new URLSearchParams()) {
  const service = serviceOf(state);
  const { settings } = service;
  if (route === 'profiles') {
    const profiles = (await settings.list()).map((p) => ({ ...p, capabilities: service.discovery.get(p.id) ?? null }));
    return { status: 200, body: { profiles, configFile: settings.configPath(), keystore: await settings.keystoreStatus() } };
  }
  const book = await repository.getBook(bookId);
  if (!book) return NOT_FOUND;
  if (route === 'status') {
    const active = await settings.activeProfile(bookId);
    const image = await settings.activeImageProfile(bookId);
    return {
      status: 200,
      body: {
        active: active ? publicProfile(active, await settings.hasKey(active)) : null,
        image: image ? publicProfile(image, await settings.hasKey(image)) : null,
        records: await settings.recordsOn(bookId),
        usage: await settings.usageTracked(bookId),
      },
    };
  }
  // everything below is part of the ai module: with it off the answer is 403, as for a write
  if (state?.moduleOn && !(await state.moduleOn(repository, 'ai', { bookId }))) return { status: 403, body: { error: 'MODULE_OFF', code: 'MODULE_OFF', module: 'ai', message: 'the ai module is turned off here' } };
  if (route === 'cover') {
    const image = await settings.activeImageProfile(bookId);
    const drafts = await repository.listCoverDrafts(bookId);
    return {
      status: 200,
      body: { available: image !== null, provider: image ? summary(image) : null, prompt: coverPrompt(book), maxPromptChars: MAX_COVER_PROMPT, drafts: drafts.ok ? drafts.drafts : [] },
    };
  }
  if (route === 'cover-draft') {
    const bytes = await repository.readCoverDraft(bookId, params.get('name') ?? '');
    if (!bytes) return NOT_FOUND;
    return { status: 200, body: null, raw: { bytes, headers: { 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable', 'content-security-policy': "default-src 'none'; sandbox" } } };
  }
  if (route === 'stream') {
    const ctx = service.contexts.get(params.get('context') ?? '');
    if (!ctx || ctx.bookId !== bookId || !ctx.stream) return refuse(404, 'CONTEXT_NOT_FOUND', 'no such request is running');
    const from = Math.max(0, Number.parseInt(params.get('from') ?? '0', 10) || 0);
    const job = ctx.stream;
    return {
      status: 200,
      body: { state: job.state, text: job.text.slice(from), length: job.text.length, ...(job.state === 'done' ? { result: job.result } : {}), ...(job.state === 'error' ? { error: job.error } : {}) },
    };
  }
  return NOT_FOUND;
}

// ------------------------------------------------------------------ writes

/**
 * @param {any} repository
 * @param {{ route: string, bookId?: string, profileId?: string }} match
 * @param {Record<string, any>} body
 * @param {any} state
 */
export async function handleAiWrite(repository, match, body, state) {
  const service = serviceOf(state);
  const { settings } = service;
  try {
    return await writeRoute(repository, match, body, state, service, settings);
  } catch (e) {
    return keystoreRefusal(e);
  }
}

async function writeRoute(repository, match, body, state, service, settings) {
  switch (match.route) {
    case 'ai-profile-create': {
      const r = await settings.create(body);
      return r.ok ? { status: 201, body: { ok: true, profile: r.profile } } : badRequest(r.message, r.code);
    }
    case 'ai-profile-update': {
      const r = await settings.update(/** @type {string} */ (match.profileId), body);
      service.discovery.delete(match.profileId); // what was found out about the old address or model no longer holds
      if (r.ok) return { status: 200, body: { ok: true, profile: r.profile } };
      return r.code === 'NOT_FOUND' ? NOT_FOUND : badRequest(r.message, r.code);
    }
    case 'ai-profile-delete': {
      const r = await settings.remove(/** @type {string} */ (match.profileId));
      service.discovery.delete(match.profileId);
      return r.ok ? { status: 200, body: { ok: true } } : NOT_FOUND;
    }
    case 'ai-profile-secure': {
      // "Move key to secure storage": the key goes into the key store and the plain copy in the settings file is deleted
      const r = await settings.moveKeyToSecure(/** @type {string} */ (match.profileId));
      if (r.ok) return { status: 200, body: { ok: true, profile: r.profile } };
      return r.code === 'NOT_FOUND' ? NOT_FOUND : badRequest(r.message, r.code);
    }
    case 'ai-profile-test': {
      const profile = await settings.get(/** @type {string} */ (match.profileId));
      if (!profile) return NOT_FOUND;
      if (profile.kind === IMAGE_KIND) return badRequest('an image provider has no chat to test; use "Test connection" to list its models', 'NOT_A_CHAT_PROFILE');
      const k = await keyFor(settings, profile);
      if (k.refusal) return k.refusal;
      const r = await testConnection(profile, k.key);
      return r.ok ? { status: 200, body: { ok: true, reply: redact(r.reply, await settings.allKeys(), 200), tokens: r.tokens, usageReported: !r.tokens.estimated } } : refuse(502, r.code, r.message);
    }
    case 'ai-profile-discover': {
      // "Test connection": lists the models (GET only) and, for a chat provider, streams the one fixed test message to learn whether streaming and usage are reported
      const profile = await settings.get(/** @type {string} */ (match.profileId));
      if (!profile) return NOT_FOUND;
      if (localityOf(profile.baseUrl) === 'cloud' && body.confirmCloud !== true) {
        return refuse(409, 'CLOUD_CONFIRM_REQUIRED', `this contacts ${hostOf(profile.baseUrl)}, which is not on this computer; confirm to continue`, { host: hostOf(profile.baseUrl) });
      }
      const k = await keyFor(settings, profile);
      if (k.refusal) return k.refusal;
      const r = await discoverCapabilities(profile, k.key, { probe: profile.kind !== IMAGE_KIND });
      if (!r.ok) return refuse(502, r.code, r.message);
      service.discovery.set(profile.id, r);
      return { status: 200, body: { ok: true, ...r } };
    }
    default:
      break;
  }

  const bookId = /** @type {string} */ (match.bookId);
  if (!(await repository.getBook(bookId))) return NOT_FOUND;
  switch (match.route) {
    case 'ai-book-profile': {
      if (body.profileId !== null && typeof body.profileId !== 'string') return badRequest('expected { profileId: string | null }');
      if (body.kind !== undefined && body.kind !== 'chat' && body.kind !== 'image') return badRequest("kind must be 'chat' or 'image'");
      const r = await settings.setBookProfile(bookId, body.profileId, body.kind === 'image' ? 'image' : 'chat');
      return r.ok ? { status: 200, body: { ok: true, profileId: body.profileId } } : NOT_FOUND;
    }
    case 'ai-records': {
      // `enabled`: save each chat and rewrite as a file; `usage`: keep the token table activity/ai-usage.md (either one turns the table on)
      if (body.usage !== undefined) {
        if (typeof body.usage !== 'boolean') return badRequest('usage must be true or false');
        await settings.setUsage(bookId, body.usage);
        if (body.enabled === undefined) return { status: 200, body: { ok: true, usage: body.usage } };
      }
      if (typeof body.enabled !== 'boolean') return badRequest('expected { enabled: boolean }');
      await settings.setRecords(bookId, body.enabled);
      return { status: 200, body: { ok: true, enabled: body.enabled } };
    }
    case 'ai-cover-use': {
      const r = await repository.useCoverDraft(bookId, body.name);
      if (r.ok) return { status: 200, body: { ok: true, cover: r.cover } };
      return r.code === 'NOT_FOUND' ? NOT_FOUND : r.code === 'CONFLICT' ? refuse(409, 'CONFLICT', 'book.md changed while you were choosing; try again') : badRequest(r.message ?? 'not a cover draft', r.code);
    }
    case 'ai-cover-delete': {
      const r = await repository.deleteCoverDraft(bookId, body.name);
      if (r.ok) return { status: 200, body: { ok: true, opId: r.opId } };
      return r.code === 'NOT_FOUND' ? NOT_FOUND : r.code === 'IN_USE' ? refuse(409, 'IN_USE', r.message) : badRequest(r.message ?? 'not a cover draft', r.code);
    }
    case 'ai-cover-generate':
      return generateCover(repository, service, bookId, body);
    case 'ai-cancel':
      return cancelStream(service, bookId, body);
    default:
      break;
  }

  // everything below is an AI action: it needs an active profile for this book
  const profile = await settings.activeProfile(bookId);
  if (!profile) return notConfigured();
  switch (match.route) {
    case 'ai-context':
      return buildPackage(repository, service, bookId, profile, body);
    case 'ai-send':
      return sendStored(repository, service, bookId, profile, body, state);
    case 'ai-apply':
      return applyStored(repository, service, bookId, body);
    case 'ai-discard':
      return discardStored(repository, service, bookId, body);
    default:
      return NOT_FOUND;
  }
}

/**
 * POST /api/books/:b/ai/context: build the exact request, send nothing.
 * With `prompt` (M07-J04: { slug } or { workflow, step }, plus `inputs` and `previous`) the instruction, the task, the files and the selection come from the library's
 * prompt component and the inputs the author chose; the answer then also lists each `sources` entry. Everything else is the same preview, and nothing is sent until /ai/send.
 */
async function buildPackage(repository, { contexts }, bookId, profile, body) {
  let promptInfo = null;
  let sources = null;
  if (body.prompt !== undefined) {
    const run = await resolvePromptRun(repository, bookId, body.prompt);
    if (!run.ok) return refuse(run.status, run.code, run.message);
    body = { ...body, task: run.task, instruction: run.instruction, files: run.files, selection: run.selection };
    promptInfo = run.prompt;
    sources = run.sources;
  }
  if (body.task !== 'chat' && body.task !== 'rewrite') return badRequest("task must be 'chat' or 'rewrite'");
  if (typeof body.instruction !== 'string' || body.instruction.trim() === '' || body.instruction.length > MAX_INSTRUCTION_CHARS) {
    return badRequest(`instruction is required (up to ${MAX_INSTRUCTION_CHARS} characters)`);
  }
  if (!Array.isArray(body.files) || body.files.length > MAX_FILES) return badRequest(`files must be a list of up to ${MAX_FILES} book-relative paths`);
  const paths = [];
  for (const raw of body.files) {
    const p = safeBookPath(raw);
    if (p === null) return badRequest(`not a file the context may read: ${typeof raw === 'string' ? raw.slice(0, 120) : String(raw)}`, 'BAD_PATH');
    if (!paths.includes(p)) paths.push(p);
  }
  /** @type {{ path: string, text: string, sha256: string, bytes: number }[]} */
  const files = [];
  for (const p of paths) {
    const f = await repository.getRawFile(bookId, p);
    if (!f) return badRequest(`not a file of this book: ${p}`, 'BAD_PATH');
    files.push({ path: p, text: f.body, sha256: f.sha256, bytes: Buffer.byteLength(f.body, 'utf8') });
  }

  let selection = null;
  if (body.task === 'rewrite') {
    const s = body.selection;
    if (s === null || typeof s !== 'object' || typeof s.sceneId !== 'string' || !Number.isInteger(s.from) || !Number.isInteger(s.to)) {
      return badRequest('a rewrite needs selection: { sceneId, from, to }');
    }
    const r = await repository.readAiSelection(bookId, s.sceneId, { from: s.from, to: s.to });
    if (!r.ok) return r.code === 'NOT_FOUND' ? NOT_FOUND : badRequest(r.message ?? 'bad selection', r.code);
    selection = { sceneId: s.sceneId, from: s.from, to: s.to, text: r.text, sha256: r.sha256, path: r.path };
  }

  const locality = localityOf(profile.baseUrl);
  const built = buildContext({ task: body.task, instruction: body.instruction, ...(selection ? { selectionText: selection.text } : {}), files }, { ...profile, locality });
  if (!built.ok) return badRequest(built.message, built.code);
  const pkg = built.package;
  const contextId = contexts.put({
    bookId,
    profileId: profile.id,
    task: body.task,
    instruction: body.instruction,
    selection,
    files: pkg.files.filter((f) => f.included !== 'omitted').map((f) => ({ path: f.path, sha256: f.sha256 })),
    messages: pkg.messages,
    model: profile.model,
    settings: pkg.settings,
    provider: pkg.provider,
    contextSha256: pkg.contextSha256,
    reply: null,
    replacement: null,
    applied: false,
    record: null,
  });
  return {
    status: 200,
    body: {
      contextId,
      messages: pkg.messages,
      files: pkg.files,
      tokens: pkg.tokens,
      provider: pkg.provider,
      contextSha256: pkg.contextSha256,
      ...(selection ? { selection: { sceneId: selection.sceneId, from: selection.from, to: selection.to, text: selection.text } } : {}),
      ...(promptInfo ? { prompt: promptInfo, sources } : {}),
    },
  };
}

/** The stored package of a request, or the refusal to answer with. */
function storedContext({ contexts }, bookId, body) {
  const ctx = typeof body.contextId === 'string' ? contexts.get(body.contextId) : null;
  if (!ctx || ctx.bookId !== bookId) return { refusal: refuse(404, 'CONTEXT_NOT_FOUND', 'that preview is gone (they last 15 minutes); preview the context again') };
  return { ctx };
}

/** POST /api/books/:b/ai/cancel { contextId }: stop a running streamed send. Whatever had arrived is thrown away; nothing is applied, suggested or recorded. */
function cancelStream(service, bookId, body) {
  const { ctx, refusal } = storedContext(service, bookId, body);
  if (refusal) return refusal;
  const job = ctx.stream;
  if (!job || job.state !== 'running') return { status: 200, body: { ok: true, cancelled: false } };
  job.state = 'cancelled';
  job.text = '';
  job.abort.abort();
  return { status: 200, body: { ok: true, cancelled: true } };
}

/**
 * POST /api/books/:b/ai/send { contextId, confirmCloud?, includeContext?, keepPrompt?, stream? }: sends exactly the stored messages.
 * With `stream: true` the answer is 202 at once and the reply is read from GET /ai/stream; it is only ever used (suggestion, record, apply) when the stream completed.
 */
async function sendStored(repository, service, bookId, active, body, state) {
  const { settings } = service;
  const { ctx, refusal } = storedContext(service, bookId, body);
  if (refusal) return refusal;
  if (body.confirmCloud !== undefined && typeof body.confirmCloud !== 'boolean') return badRequest('confirmCloud must be true or false');
  if (body.includeContext !== undefined && typeof body.includeContext !== 'boolean') return badRequest('includeContext must be true or false');
  if (body.keepPrompt !== undefined && typeof body.keepPrompt !== 'boolean') return badRequest('keepPrompt must be true or false');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') return badRequest('stream must be true or false');
  if (active.id !== ctx.profileId) return notConfigured();
  if (active.model !== ctx.provider.model || active.baseUrl !== ctx.provider.baseUrl) {
    return refuse(409, 'CONTEXT_STALE', 'the provider settings changed after the preview; preview the context again');
  }
  const locality = localityOf(active.baseUrl);
  if (locality === 'cloud' && body.confirmCloud !== true) {
    return refuse(409, 'CLOUD_CONFIRM_REQUIRED', `this sends your text to ${hostOf(active.baseUrl)}; confirm to send`, { host: hostOf(active.baseUrl), tokens: ctx.messages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0) });
  }
  if (ctx.stream?.state === 'running') return refuse(409, 'STREAM_RUNNING', 'this request is already being sent; cancel it first');

  const k = await keyFor(settings, active);
  if (k.refusal) return k.refusal;
  const key = k.key;
  const stored = { model: ctx.model, messages: ctx.messages, settings: ctx.settings };

  if (body.stream === true) {
    const job = { state: 'running', text: '', abort: new AbortController(), result: null, error: null };
    ctx.stream = job;
    void streamPackage(active, key, stored, { signal: job.abort.signal, onDelta: (t) => { if (job.state === 'running') job.text += t; } }).then(async (r) => {
      if (job.state !== 'running') return; // cancelled: nothing of it is kept
      if (!r.ok) {
        job.state = 'error';
        job.text = '';
        job.error = { code: r.code, message: r.message };
        return;
      }
      try {
        const done = await finishSend(repository, service, bookId, ctx, active, key, r, body, state);
        if (job.state !== 'running') return;
        if (done.status === 200) {
          job.result = done.body;
          job.state = 'done';
        } else {
          job.state = 'error';
          job.text = '';
          job.error = { code: done.body.code, message: done.body.message };
        }
      } catch {
        job.state = 'error';
        job.text = '';
        job.error = { code: 'INTERNAL', message: 'the reply could not be saved' };
      }
    });
    return { status: 202, body: { ok: true, streaming: true, contextId: body.contextId } };
  }

  const r = await sendPackage(active, key, stored);
  if (!r.ok) return refuse(502, r.code, r.message, r.status !== undefined ? { providerStatus: r.status } : {});
  return finishSend(repository, service, bookId, ctx, active, key, r, body, state);
}

/** A completed reply (whole or streamed): its receipt, its suggestion (rewrite), the record and the usage row; then the answer to the author. */
async function finishSend(repository, service, bookId, ctx, active, key, r, body, state) {
  const { settings } = service;
  const reply = redact(r.reply, [key], Infinity);
  const rewrite = ctx.task === 'rewrite';
  const core = rewrite ? reply.replace(/^\s+|\s+$/g, '') : null;
  if (rewrite && core === '') return refuse(502, 'BAD_RESPONSE', 'the provider answered without any text');
  // The selection keeps its own surrounding whitespace (a line-wise selection ends with the paragraph break); only its text is replaced.
  const original = ctx.selection?.text ?? '';
  const replacement = !rewrite ? null : original.trim() === '' ? core : `${/^\s*/.exec(original)[0]}${core}${/\s*$/.exec(original)[0]}`;
  ctx.reply = reply;
  ctx.replacement = replacement;

  const provider = { name: ctx.provider.name, model: ctx.provider.model, locality: ctx.provider.locality };
  // M05-J07: the receipt keeps hashes; the full prompt only when the author ticked "Keep the full prompt in the receipt" for this send (keys are redacted)
  await emit(repository, {
    kind: rewrite ? 'ai.proposal' : 'ai.chat',
    bookId,
    ...(rewrite ? { sceneId: ctx.selection.sceneId, before: ctx.selection.text, after: replacement, range: { from: ctx.selection.from, to: ctx.selection.to } } : { files: ctx.files.map((f) => f.sha256) }),
    contextSha256: ctx.contextSha256,
    provider,
    settings: ctx.settings,
    promptSha256: createHash('sha256').update(ctx.instruction, 'utf8').digest('hex'),
    ...(body.keepPrompt === true ? { fullPrompt: redact(promptText(ctx.messages), await settings.allKeys(), Infinity) } : {}),
  });

  // M05-J06: a rewrite is held as a pending suggestion in the book (nothing is written to the scene). If the scene changed since the preview, or the reply
  // equals the selection, no suggestion is made and Apply keeps its J04 behaviour (SCENE_CHANGED / writing the range).
  let suggestion = null;
  if (rewrite) {
    // sending the same preview again replaces its earlier proposal (that one is declined)
    if (ctx.suggestion && !ctx.applied) await repository.decideSuggestion(bookId, ctx.suggestion.id, { decision: 'decline' });
    ctx.suggestion = null;
    // M07-J04: with the suggestions module off nothing is written to the book; the reply is shown and Apply keeps its range-writing behaviour
    const made = state?.moduleOn && !(await state.moduleOn(repository, 'suggestions', { bookId })) ? { ok: false } : await repository.createSuggestion(bookId, {
      target: ctx.selection.sceneId,
      proposedRange: { from: ctx.selection.from, to: ctx.selection.to, replacement },
      source: 'ai',
      mode: 'suggest',
      // (the instruction text is not copied into the suggestion document: prompts stay out of the book unless the author keeps them in the receipt)
      rationale: `Suggested by an AI rewrite (${ctx.provider.name}, ${ctx.provider.model}). Nothing in the scene changes until you accept a change.`,
      ai: { provider: ctx.provider.name, model: ctx.provider.model, locality: ctx.provider.locality, context_sha256: ctx.contextSha256 },
      expectSha256: ctx.selection.sha256,
    });
    if (made.ok) ctx.suggestion = { id: made.id, path: made.path };
    suggestion = ctx.suggestion;
  }

  let record = null;
  if (await settings.recordsOn(bookId)) {
    const saved = await repository.saveAiRecord(bookId, recordOf(ctx, { applied: false, includeContext: body.includeContext === true }), ctx.record ?? undefined);
    if (saved.ok) {
      ctx.record = { path: saved.path, id: saved.id, created: saved.created };
      ctx.includeContext = body.includeContext === true;
      record = { path: saved.path };
    }
  }
  // M08-J03: the tokens of this request (the provider's own count, or an estimate marked as such), and the book's daily table when that is on
  const tokens = r.tokens;
  if (await settings.usageOn(bookId)) {
    await Promise.resolve(repository.recordAiUsage?.(bookId, { profile: active.name, locality: ctx.provider.locality, promptTokens: tokens.promptTokens, completionTokens: tokens.completionTokens, estimated: tokens.estimated })).catch(() => {}); // advisory, like a receipt
  }
  return {
    status: 200,
    body: { ok: true, contextId: body.contextId, contextSha256: ctx.contextSha256, reply, ...(rewrite ? { replacement, suggestion } : {}), model: r.model ?? ctx.model, usage: r.usage, tokens, record },
  };
}

/**
 * POST /api/books/:b/ai/cover-generate { prompt, consent: true, host }: ask the book's image provider for a cover draft.
 * Nothing is sent without `consent: true` and the provider host the author was shown; exactly `prompt` is sent, and nothing else about the book.
 */
async function generateCover(repository, service, bookId, body) {
  const { settings } = service;
  const image = await settings.activeImageProfile(bookId);
  if (!image) return notConfigured();
  if (typeof body.prompt !== 'string' || body.prompt.trim() === '' || body.prompt.length > MAX_COVER_PROMPT) return badRequest(`prompt is required (up to ${MAX_COVER_PROMPT} characters)`);
  if (body.consent !== true) return refuse(409, 'CONSENT_REQUIRED', 'confirm what will be sent before a cover is generated; nothing was sent');
  if (body.host !== hostOf(image.baseUrl)) return refuse(409, 'CONSENT_STALE', 'the image provider changed after the confirmation; confirm again; nothing was sent');
  const k = await keyFor(settings, image);
  if (k.refusal) return k.refusal;
  const r = await generateImage(image, k.key, body.prompt, { timeoutMs: 180_000 });
  if (!r.ok) return refuse(502, r.code, r.message, r.status !== undefined ? { providerStatus: r.status } : {});
  const locality = localityOf(image.baseUrl);
  const saved = await repository.saveCoverDraft(bookId, { bytes: r.bytes, prompt: body.prompt, provider: image.name, model: r.model, locality });
  if (!saved.ok) return refuse(500, saved.code, saved.message ?? 'the draft could not be saved');
  await emit(repository, {
    kind: 'ai.generation',
    bookId,
    asset: { id: saved.id, path: saved.path, sha256: saved.sha256 },
    provider: { name: image.name, model: r.model, locality },
    promptSha256: createHash('sha256').update(body.prompt, 'utf8').digest('hex'),
  });
  return { status: 201, body: { ok: true, draft: { name: saved.name, path: saved.path, created: saved.created, prompt: body.prompt, provider: image.name, model: r.model, locality, sha256: saved.sha256, isCover: false } } };
}

/** The record file content for a stored context. */
function recordOf(ctx, { applied, includeContext }) {
  return {
    task: ctx.task,
    provider: ctx.provider.name,
    model: ctx.model,
    locality: ctx.provider.locality,
    contextSha256: ctx.contextSha256,
    files: ctx.files,
    applied,
    instruction: ctx.instruction,
    reply: ctx.reply ?? '',
    ...(ctx.selection ? { selectedText: ctx.selection.text } : {}),
    ...(includeContext ? { contextMessages: ctx.messages } : {}),
  };
}

/** POST /api/books/:b/ai/apply { contextId }: write the stored replacement into the selected range (only on this explicit action). */
async function applyStored(repository, service, bookId, body) {
  const { settings } = service;
  const { ctx, refusal } = storedContext(service, bookId, body);
  if (refusal) return refusal;
  if (ctx.task !== 'rewrite') return badRequest('only a rewrite can be applied', 'NOT_A_REWRITE');
  if (ctx.stream?.state === 'running') return refuse(409, 'STREAM_RUNNING', 'the reply is still arriving; nothing is applied until it is complete');
  if (ctx.replacement === null) return refuse(409, 'NO_REPLY', 'nothing to apply: send the request first');
  if (ctx.applied) return refuse(409, 'ALREADY_APPLIED', 'this rewrite was already applied');
  const sel = ctx.selection;
  // With a pending suggestion, Apply is "accept all hunks" (M05-J06); without one it writes the range as in J04.
  /** @type {any} */
  let r;
  if (ctx.suggestion) {
    const d = await repository.decideSuggestion(bookId, ctx.suggestion.id, { decision: 'accept' });
    if (!d.ok && d.code === 'SUGGESTION_STALE') return refuse(409, 'SCENE_CHANGED', 'the scene changed after the preview; nothing was written');
    if (!d.ok && d.code === 'ALREADY_DECIDED') return refuse(409, 'ALREADY_APPLIED', 'this rewrite was already decided in Suggestions');
    r = d.ok ? { ok: true, sha256: d.sha256, opId: d.opId } : d;
  } else {
    r = await repository.applyAiRewrite(bookId, sel.sceneId, { baseSha256: sel.sha256, from: sel.from, to: sel.to, original: sel.text, replacement: ctx.replacement });
  }
  if (!r.ok) {
    if (r.code === 'SCENE_CHANGED') return refuse(409, 'SCENE_CHANGED', r.message ?? 'the scene changed after the preview; nothing was written');
    if (r.code === 'NOT_FOUND') return NOT_FOUND;
    return refuse(r.code === 'CONFLICT' ? 409 : 400, r.code, r.message ?? 'the rewrite could not be applied');
  }
  ctx.applied = true;
  await emit(repository, {
    kind: 'ai.apply',
    bookId,
    sceneId: sel.sceneId,
    contextSha256: ctx.contextSha256,
    provider: { name: ctx.provider.name, model: ctx.provider.model, locality: ctx.provider.locality },
    settings: ctx.settings,
    before: sel.text,
    after: ctx.replacement,
    range: { from: sel.from, to: sel.to },
  });
  if (ctx.record && (await settings.recordsOn(bookId))) {
    await repository.saveAiRecord(bookId, recordOf(ctx, { applied: true, includeContext: ctx.includeContext === true }), ctx.record);
  }
  return { status: 200, body: { ok: true, sha256: r.sha256, opId: r.opId, undo: r.opId ? { opId: r.opId } : null } };
}

/** POST /api/books/:b/ai/discard { contextId }: nothing is written; the package is dropped. */
async function discardStored(repository, service, bookId, body) {
  const { ctx, refusal } = storedContext(service, bookId, body);
  if (refusal) return refusal;
  if (ctx.stream?.state === 'running') {
    ctx.stream.state = 'cancelled';
    ctx.stream.text = '';
    ctx.stream.abort.abort();
  }
  await emit(repository, {
    kind: 'ai.discard',
    bookId,
    ...(ctx.selection ? { sceneId: ctx.selection.sceneId, range: { from: ctx.selection.from, to: ctx.selection.to } } : {}),
    contextSha256: ctx.contextSha256,
    provider: { name: ctx.provider.name, model: ctx.provider.model, locality: ctx.provider.locality },
    settings: ctx.settings,
  });
  // the pending suggestion this preview made is declined (only the suggestion file changes; the scene is never touched)
  if (ctx.suggestion && !ctx.applied) await repository.decideSuggestion(ctx.bookId, ctx.suggestion.id, { decision: 'decline' });
  service.contexts.delete(body.contextId);
  return { status: 200, body: { ok: true } };
}
