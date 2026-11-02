// The autosave / conflict / offline state machine for one open scene. Pure logic: no DOM, and the clock,
// timers, fetch and draft store are all injected, so it runs under `node --test` with fakes.
//
//   clean -> (edit) dirty -> (1500 ms after the last change, blur, Ctrl+S, leaving) saving
//   saving -> saved (new base sha) | conflict (409) | offline (network error or 5xx) | error (any other refusal)
//   offline: retry 2, 4, 8, 16, 30, 30... s, buffer kept, editing continues
//   conflict: autosave stops until the author chooses (keepMine / adoptDisk / restore); nothing is merged
//
// Text is always the serialised buffer (see buffer.js `serialise`), compared and sent as a whole string.

export const DEBOUNCE_MS = 1500;
export const DRAFT_MS = 500;
export const BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];
export const FLUSH_WAIT_MS = 3000;

/**
 * @typedef {'clean' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'offline' | 'error'} SaveState
 * @typedef {{
 *   state: SaveState, baseSha256: string | null, text: string, savedText: string, savedAt: string | null,
 *   attempt: number, retryInMs: number | null, conflict: { currentSha256: string | null, currentText: string | null } | null,
 *   error: { status: number, code: string | null } | null,
 * }} SaveSnapshot
 * @typedef {{ setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (id: any) => void }} Timers
 * @typedef {ReturnType<typeof import('./draft-store.js').createDraftStore>} DraftStore
 */

/** Is a save pending or failing in this state? @param {SaveState} state */
export const isUnsaved = (state) => state === 'dirty' || state === 'saving' || state === 'offline' || state === 'conflict' || state === 'error';

/** The draft to offer on opening a scene: one whose text differs from the file's. @param {{ text: string } | null} draft @param {string} fileText */
export const draftOffer = (draft, fileText) => (draft && typeof draft.text === 'string' && draft.text !== fileText ? draft : null);

/** Ignore the result of a promise-returning call that might not return a promise (fake stores). */
const quiet = (p) => {
  if (p && typeof p.catch === 'function') p.catch(() => {});
};

/**
 * @param {{
 *   bookId: string, sceneId: string, text: string, sha256: string | null,
 *   fetch?: typeof fetch, drafts?: DraftStore | null, timers?: Timers, now?: () => number,
 *   onChange?: (snapshot: SaveSnapshot) => void,
 * }} options  `text`/`sha256`: the scene body and file hash as loaded.
 */
export function createSaveController(options) {
  const { bookId, sceneId } = options;
  const fetchImpl = options.fetch ?? ((...a) => globalThis.fetch(...a));
  const drafts = options.drafts ?? null;
  // late-bound, so fake timers installed after creation still apply
  const timers = options.timers ?? { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  const now = options.now ?? (() => Date.now());
  const key = `${bookId}/${sceneId}`;
  const sceneUrl = `/api/books/${encodeURIComponent(bookId)}/scenes/${encodeURIComponent(sceneId)}`;

  /** @type {SaveSnapshot} */
  const s = {
    state: 'clean',
    baseSha256: options.sha256,
    text: options.text,
    savedText: options.text,
    savedAt: null,
    attempt: 0,
    retryInMs: null,
    conflict: null,
    error: null,
  };
  let disposed = false;
  let debounceTimer = null;
  let retryTimer = null;
  let draftTimer = null;
  /** @type {Promise<void> | null} */
  let inflight = null;
  const listeners = new Set(options.onChange ? [options.onChange] : []);

  const snapshot = () => ({ ...s, conflict: s.conflict ? { ...s.conflict } : null, error: s.error ? { ...s.error } : null });
  const emit = () => {
    const snap = snapshot();
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch {
        // a listener must not break saving
      }
    }
  };
  const set = (patch) => {
    Object.assign(s, patch);
    emit();
  };
  const cancel = (id) => {
    if (id !== null) timers.clearTimeout(id);
    return null;
  };
  const isoNow = () => new Date(now()).toISOString();
  const restState = () => (s.savedAt ? 'saved' : 'clean');

  // ---- draft mirror
  const mirrorNow = () => {
    draftTimer = cancel(draftTimer);
    if (drafts && s.text !== s.savedText) quiet(drafts.put(key, s.text, s.baseSha256));
  };
  const scheduleMirror = () => {
    if (!drafts) return;
    draftTimer = cancel(draftTimer);
    draftTimer = timers.setTimeout(() => {
      draftTimer = null;
      mirrorNow();
    }, DRAFT_MS);
  };
  const clearDraft = () => {
    draftTimer = cancel(draftTimer);
    if (drafts) quiet(drafts.clear(key));
  };

  const scheduleSave = () => {
    debounceTimer = cancel(debounceTimer);
    debounceTimer = timers.setTimeout(() => {
      debounceTimer = null;
      void attempt();
    }, DEBOUNCE_MS);
  };

  /** One save of the current buffer. */
  function attempt() {
    if (inflight) return inflight;
    if (disposed || s.state === 'conflict') return Promise.resolve();
    debounceTimer = cancel(debounceTimer);
    retryTimer = cancel(retryTimer);
    const sent = s.text;
    if (sent === s.savedText) {
      set({ state: restState(), retryInMs: null, attempt: 0, error: null });
      return Promise.resolve();
    }
    set({ state: 'saving', retryInMs: null });
    inflight = (async () => {
      let status = null;
      let json = null;
      try {
        const res = await fetchImpl(`${sceneUrl}/body`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-storyforge': '1', accept: 'application/json' },
          body: JSON.stringify({ body: sent, base_sha256: s.baseSha256 }),
        });
        status = res.status;
        json = await res.json().catch(() => null);
      } catch {
        // no answer at all: status stays null (offline)
      }
      inflight = null;
      if (disposed) return;
      if (status === 200 && typeof json?.sha256 === 'string') {
        s.baseSha256 = json.sha256;
        s.savedText = sent;
        s.savedAt = isoNow();
        s.attempt = 0;
        s.error = null;
        if (s.text === sent) {
          clearDraft();
          set({ state: 'saved' });
        } else {
          set({ state: 'dirty' });
          scheduleSave();
          scheduleMirror();
        }
      } else if (status === 409) {
        mirrorNow();
        set({ state: 'conflict', conflict: { currentSha256: json?.current?.sha256 ?? null, currentText: typeof json?.current?.body === 'string' ? json.current.body : null } });
      } else if (status === null || status >= 500) {
        mirrorNow();
        const attemptNo = s.attempt + 1;
        const wait = BACKOFF_MS[Math.min(attemptNo - 1, BACKOFF_MS.length - 1)];
        set({ state: 'offline', attempt: attemptNo, retryInMs: wait });
        retryTimer = timers.setTimeout(() => {
          retryTimer = null;
          void attempt();
        }, wait);
      } else {
        mirrorNow();
        set({ state: 'error', error: { status, code: json?.error ?? null } });
      }
    })();
    return inflight;
  }

  const fetchCurrent = async () => {
    try {
      const res = await fetchImpl(sceneUrl, { headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      const j = await res.json();
      return typeof j?.sha256 === 'string' && typeof j?.body === 'string' ? { sha256: j.sha256, text: j.body } : null;
    } catch {
      return null;
    }
  };

  return {
    /** @returns {SaveSnapshot} */
    snapshot,
    /** @param {(snapshot: SaveSnapshot) => void} fn @returns {() => void} */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** The buffer changed. @param {string} text the whole serialised buffer */
    edit(text) {
      if (disposed || text === s.text) return;
      s.text = text;
      if (s.state === 'conflict' || s.state === 'saving' || s.state === 'offline') {
        scheduleMirror();
        emit();
        return;
      }
      if (text === s.savedText) {
        debounceTimer = cancel(debounceTimer);
        clearDraft();
        set({ state: restState(), error: null });
        return;
      }
      set({ state: 'dirty', error: null });
      scheduleSave();
      scheduleMirror();
    },

    /** The editor lost focus: save now if there is something to save. */
    blur() {
      if (s.state === 'dirty' || s.state === 'error') return attempt();
      return Promise.resolve();
    },

    /** Save now (Ctrl+S, "retry now"). Does nothing while in conflict. */
    saveNow() {
      if (s.state === 'conflict') return Promise.resolve();
      return attempt();
    },

    /**
     * Leaving the scene: save, but wait at most `waitMs` (3 s). If it did not finish the draft is kept.
     * @returns {Promise<{ saved: boolean }>}
     */
    async flush(waitMs = FLUSH_WAIT_MS) {
      if (!isUnsaved(s.state)) return { saved: true };
      mirrorNow();
      if (s.state === 'conflict') return { saved: false };
      let timer;
      const timeout = new Promise((resolve) => {
        timer = timers.setTimeout(() => resolve('timeout'), waitMs);
      });
      const result = await Promise.race([attempt().then(() => 'done'), timeout]);
      timers.clearTimeout(timer);
      if (result === 'timeout' || s.state !== 'saved') {
        mirrorNow();
        return { saved: false };
      }
      return { saved: true };
    },

    /** Should closing the page ask first? Only when a save is pending or failing. */
    needsPrompt: () => isUnsaved(s.state),

    /** The page is closing: put the buffer into the synchronous draft mirror. */
    mirrorForUnload() {
      if (drafts && s.text !== s.savedText) {
        try {
          drafts.putNow(key, s.text, s.baseSha256);
        } catch {
          // nothing more can be done
        }
      }
    },

    /**
     * Something suggests the file changed outside (the book's reconcile time moved). Asks the server what is on
     * disk; if it differs from our base: a clean buffer is replaced (`reload`), a dirty one goes to conflict.
     * @returns {Promise<{ action: 'ignored' } | { action: 'reload', text: string, sha256: string } | { action: 'conflict' }>}
     */
    async checkDisk() {
      if (disposed || s.state === 'saving') return { action: 'ignored' };
      const baseAtStart = s.baseSha256;
      const disk = await fetchCurrent();
      if (!disk || disposed || s.state === 'saving' || s.baseSha256 !== baseAtStart) return { action: 'ignored' };
      if (s.state === 'conflict') {
        if (s.conflict?.currentSha256 !== disk.sha256) set({ conflict: { currentSha256: disk.sha256, currentText: disk.text } });
        return { action: 'ignored' };
      }
      if (disk.sha256 === s.baseSha256) return { action: 'ignored' };
      debounceTimer = cancel(debounceTimer);
      retryTimer = cancel(retryTimer);
      if (s.text === s.savedText) {
        set({ baseSha256: disk.sha256, savedText: disk.text, text: disk.text, state: 'clean', attempt: 0, retryInMs: null, error: null });
        return { action: 'reload', text: disk.text, sha256: disk.sha256 };
      }
      mirrorNow();
      set({ state: 'conflict', retryInMs: null, conflict: { currentSha256: disk.sha256, currentText: disk.text } });
      return { action: 'conflict' };
    },

    /**
     * Conflict choice "Keep mine": save the buffer over the file, using the disk's current hash as the base.
     * The caller must have asked the author to confirm. @returns {Promise<void>}
     */
    async keepMine() {
      if (s.state !== 'conflict') return;
      let sha = s.conflict?.currentSha256 ?? null;
      if (!sha) sha = (await fetchCurrent())?.sha256 ?? null;
      if (!sha || disposed) return;
      s.baseSha256 = sha;
      set({ state: 'dirty', conflict: null });
      await attempt();
    },

    /**
     * Conflict choice "Use the file's version" (also: reload from disk). The buffer is first moved to the
     * discarded-drafts list (kept 7 days) unless `preserve` is false (its text already lives elsewhere).
     * @returns {Promise<{ ok: true, text: string, sha256: string } | { ok: false }>}
     */
    async adoptDisk({ preserve = true } = {}) {
      let disk = s.conflict?.currentSha256 && typeof s.conflict.currentText === 'string' ? { sha256: s.conflict.currentSha256, text: s.conflict.currentText } : null;
      if (!disk) disk = await fetchCurrent();
      if (!disk || disposed) return { ok: false };
      const hadUnsaved = s.text !== s.savedText;
      debounceTimer = cancel(debounceTimer);
      retryTimer = cancel(retryTimer);
      draftTimer = cancel(draftTimer);
      if (drafts) {
        try {
          if (preserve && hadUnsaved) await drafts.discard(key, { text: s.text, baseSha256: s.baseSha256 });
          else await drafts.clear(key);
        } catch {
          // the store never throws; a fake might
        }
      }
      set({ baseSha256: disk.sha256, savedText: disk.text, text: disk.text, state: 'clean', conflict: null, attempt: 0, retryInMs: null, error: null });
      return { ok: true, text: disk.text, sha256: disk.sha256 };
    },

    /**
     * "Restore" on the unsaved-changes banner: the draft becomes the buffer. If the file is still the version the
     * draft was made from, the state is dirty (and autosave follows); otherwise it goes through the conflict flow.
     * @param {{ text: string, base_sha256: string | null }} draft
     * @returns {'dirty' | 'conflict'}
     */
    restoreDraft(draft) {
      s.text = draft.text;
      if (draft.base_sha256 === s.baseSha256) {
        set({ state: 'dirty', error: null });
        scheduleSave();
        scheduleMirror();
        return 'dirty';
      }
      mirrorNow();
      set({ state: 'conflict', conflict: { currentSha256: s.baseSha256, currentText: s.savedText } });
      return 'conflict';
    },

    /** Stop timers (the editor is closing). The draft stays in the store while anything is unsaved. */
    dispose() {
      disposed = true;
      debounceTimer = cancel(debounceTimer);
      retryTimer = cancel(retryTimer);
      draftTimer = cancel(draftTimer);
      listeners.clear();
    },
  };
}
