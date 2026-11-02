// The AI routes (M05-J04). Nothing here opens a connection itself: the one outbound call is @storyforge/ai's sendPackage / testConnection.
// With no active provider profile for a book every AI route answers 409 AI_NOT_CONFIGURED and nothing is sent. The key never appears in a response.
import { buildContext, createAiSettings, createContextStore, hostOf, localityOf, publicProfile, redact, sendPackage, testConnection } from '@storyforge/ai';
import { recordProvenance } from '@storyforge/core';

const MAX_FILES = 100;
const MAX_INSTRUCTION_CHARS = 20_000;

/** @param {number} status @param {string} code @param {string} message @param {Record<string, unknown>} [extra] */
const refuse = (status, code, message, extra = {}) => ({ status, body: { error: code, code, message, ...extra } });
const badRequest = (message, code = 'BAD_ARGS') => ({ status: 400, body: { error: 'bad_request', code, message } });
const NOT_FOUND = { status: 404, body: { error: 'not_found' } };
const notConfigured = () => refuse(409, 'AI_NOT_CONFIGURED', 'AI is not set up for this book (Settings, Set up AI); nothing was sent');

/** One AI service per server process: settings (profiles, session keys) and the stored context packages. */
export function createAiService(options = {}) {
  return { settings: createAiSettings(options.settings), contexts: createContextStore(options.contexts) };
}
/** @type {ReturnType<typeof createAiService> | null} used only when a caller has no server state (direct handler calls) */
let fallback = null;
/** @param {any} state */
function serviceOf(state) {
  if (state) return (state.ai ??= createAiService());
  return (fallback ??= createAiService());
}

/** A provenance event must never break the request it reports on. */
async function emit(event) {
  try {
    await recordProvenance(event);
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

/** GET /api/ai/profiles, GET /api/books/:b/ai/status. @returns {Promise<{ status: number, body: unknown }>} */
export async function handleAiRead(repository, state, route, bookId) {
  const { settings } = serviceOf(state);
  if (route === 'profiles') return { status: 200, body: { profiles: await settings.list(), configFile: settings.configPath() } };
  if (!(await repository.getBook(bookId))) return NOT_FOUND;
  const active = await settings.activeProfile(bookId);
  return { status: 200, body: { active: active ? publicProfile(active, (await settings.keyFor(active)) !== null) : null, records: await settings.recordsOn(bookId) } };
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
  switch (match.route) {
    case 'ai-profile-create': {
      const r = await settings.create(body);
      return r.ok ? { status: 201, body: { ok: true, profile: r.profile } } : badRequest(r.message, r.code);
    }
    case 'ai-profile-update': {
      const r = await settings.update(/** @type {string} */ (match.profileId), body);
      if (r.ok) return { status: 200, body: { ok: true, profile: r.profile } };
      return r.code === 'NOT_FOUND' ? NOT_FOUND : badRequest(r.message, r.code);
    }
    case 'ai-profile-delete': {
      const r = await settings.remove(/** @type {string} */ (match.profileId));
      return r.ok ? { status: 200, body: { ok: true } } : NOT_FOUND;
    }
    case 'ai-profile-test': {
      const profile = await settings.get(/** @type {string} */ (match.profileId));
      if (!profile) return NOT_FOUND;
      const r = await testConnection(profile, await settings.keyFor(profile));
      return r.ok ? { status: 200, body: { ok: true, reply: redact(r.reply, await settings.allKeys(), 200) } } : refuse(502, r.code, r.message);
    }
    default:
      break;
  }

  const bookId = /** @type {string} */ (match.bookId);
  if (!(await repository.getBook(bookId))) return NOT_FOUND;
  switch (match.route) {
    case 'ai-book-profile': {
      if (body.profileId !== null && typeof body.profileId !== 'string') return badRequest('expected { profileId: string | null }');
      const r = await settings.setBookProfile(bookId, body.profileId);
      return r.ok ? { status: 200, body: { ok: true, profileId: body.profileId } } : NOT_FOUND;
    }
    case 'ai-records': {
      if (typeof body.enabled !== 'boolean') return badRequest('expected { enabled: boolean }');
      await settings.setRecords(bookId, body.enabled);
      return { status: 200, body: { ok: true, enabled: body.enabled } };
    }
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
      return sendStored(repository, service, bookId, profile, body);
    case 'ai-apply':
      return applyStored(repository, service, bookId, body);
    case 'ai-discard':
      return discardStored(service, bookId, body);
    default:
      return NOT_FOUND;
  }
}

/** POST /api/books/:b/ai/context: build the exact request, send nothing. */
async function buildPackage(repository, { contexts }, bookId, profile, body) {
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
    },
  };
}

/** The stored package of a request, or the refusal to answer with. */
function storedContext({ contexts }, bookId, body) {
  const ctx = typeof body.contextId === 'string' ? contexts.get(body.contextId) : null;
  if (!ctx || ctx.bookId !== bookId) return { refusal: refuse(404, 'CONTEXT_NOT_FOUND', 'that preview is gone (they last 15 minutes); preview the context again') };
  return { ctx };
}

/** POST /api/books/:b/ai/send { contextId, confirmCloud?, includeContext? }: sends exactly the stored messages. */
async function sendStored(repository, service, bookId, active, body) {
  const { settings } = service;
  const { ctx, refusal } = storedContext(service, bookId, body);
  if (refusal) return refusal;
  if (body.confirmCloud !== undefined && typeof body.confirmCloud !== 'boolean') return badRequest('confirmCloud must be true or false');
  if (body.includeContext !== undefined && typeof body.includeContext !== 'boolean') return badRequest('includeContext must be true or false');
  if (active.id !== ctx.profileId) return notConfigured();
  if (active.model !== ctx.provider.model || active.baseUrl !== ctx.provider.baseUrl) {
    return refuse(409, 'CONTEXT_STALE', 'the provider settings changed after the preview; preview the context again');
  }
  const locality = localityOf(active.baseUrl);
  if (locality === 'cloud' && body.confirmCloud !== true) {
    return refuse(409, 'CLOUD_CONFIRM_REQUIRED', `this sends your text to ${hostOf(active.baseUrl)}; confirm to send`, { host: hostOf(active.baseUrl), tokens: ctx.messages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0) });
  }

  const key = await settings.keyFor(active);
  const r = await sendPackage(active, key, { model: ctx.model, messages: ctx.messages, settings: ctx.settings });
  if (!r.ok) return refuse(502, r.code, r.message, r.status !== undefined ? { providerStatus: r.status } : {});
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
  await emit({
    kind: rewrite ? 'ai.proposal' : 'ai.chat',
    bookId,
    ...(rewrite ? { sceneId: ctx.selection.sceneId, before: ctx.selection.text, after: replacement, range: { from: ctx.selection.from, to: ctx.selection.to } } : {}),
    contextSha256: ctx.contextSha256,
    provider,
    settings: ctx.settings,
  });

  let record = null;
  if (await settings.recordsOn(bookId)) {
    const saved = await repository.saveAiRecord(bookId, recordOf(ctx, { applied: false, includeContext: body.includeContext === true }), ctx.record ?? undefined);
    if (saved.ok) {
      ctx.record = { path: saved.path, id: saved.id, created: saved.created };
      ctx.includeContext = body.includeContext === true;
      record = { path: saved.path };
    }
  }
  return {
    status: 200,
    body: { ok: true, contextId: body.contextId, contextSha256: ctx.contextSha256, reply, ...(rewrite ? { replacement } : {}), model: r.model ?? ctx.model, usage: r.usage, record },
  };
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
  if (ctx.replacement === null) return refuse(409, 'NO_REPLY', 'nothing to apply: send the request first');
  if (ctx.applied) return refuse(409, 'ALREADY_APPLIED', 'this rewrite was already applied');
  const sel = ctx.selection;
  const r = await repository.applyAiRewrite(bookId, sel.sceneId, { baseSha256: sel.sha256, from: sel.from, to: sel.to, original: sel.text, replacement: ctx.replacement });
  if (!r.ok) {
    if (r.code === 'SCENE_CHANGED') return refuse(409, 'SCENE_CHANGED', r.message ?? 'the scene changed after the preview; nothing was written');
    if (r.code === 'NOT_FOUND') return NOT_FOUND;
    return refuse(r.code === 'CONFLICT' ? 409 : 400, r.code, r.message ?? 'the rewrite could not be applied');
  }
  ctx.applied = true;
  await emit({
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
async function discardStored(service, bookId, body) {
  const { ctx, refusal } = storedContext(service, bookId, body);
  if (refusal) return refusal;
  await emit({
    kind: 'ai.discard',
    bookId,
    ...(ctx.selection ? { sceneId: ctx.selection.sceneId, range: { from: ctx.selection.from, to: ctx.selection.to } } : {}),
    contextSha256: ctx.contextSha256,
    provider: { name: ctx.provider.name, model: ctx.provider.model, locality: ctx.provider.locality },
    settings: ctx.settings,
  });
  service.contexts.delete(body.contextId);
  return { status: 200, body: { ok: true } };
}
