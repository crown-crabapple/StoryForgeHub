// Preferences, profiles and modules for the API (M07-J04). A profile is per-machine user config (never author data): choosing or saving one writes
// `<config>/profiles/<name>.json` through @storyforge/store and nothing in any library. The library and book layers are read from `library.md` / `book.md`.
import { MODULE_IDS, PREFERENCE_KEYS, moduleOfRoute, profileProblems, resolveModules, resolvePreferences } from '@storyforge/format';
import { DEFAULT_PROFILE, deleteProfile, isProfileName, listProfiles, readProfile, writeProfile } from '@storyforge/store';

/** The profile name a server run uses: `--profile <name>`, else `STORYFORGE_PROFILE`, else `default`. Throws an Error with a usable message for a bad name.
 * @param {string[]} argv @param {Record<string, string | undefined>} env */
export function profileNameFrom(argv, env) {
  let name;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile') {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error('--profile needs a value');
      name = argv[i + 1];
      i++;
    } else if (argv[i].startsWith('--profile=')) name = argv[i].slice('--profile='.length);
  }
  name ??= env.STORYFORGE_PROFILE || DEFAULT_PROFILE;
  if (!isProfileName(name)) throw new Error(`bad profile name: ${name} (lower-case letters, digits, hyphen or underscore; at most 40 characters)`);
  return name;
}

const NOT_FOUND = { status: 404, body: { error: 'not_found' } };
const badRequest = (message, code = 'BAD_ARGS') => ({ status: 400, body: { error: 'bad_request', code, message } });
/** The preference keys of a profile document (the layer the resolver sees). @param {any} profile */
const layerOf = (profile) => Object.fromEntries(PREFERENCE_KEYS.filter((k) => profile?.[k] !== undefined && profile[k] !== null).map((k) => [k, profile[k]]));

/** @param {any} state */
export const profileNameOf = (state) => state?.profile ?? DEFAULT_PROFILE;

/**
 * Which modules are on, for a book (by id or library-relative path), or for no book.
 * @param {any} repository @param {any} state @param {{ bookId?: string, bookPath?: string }} [which]
 * @returns {Promise<Record<string, { on: boolean, source: string, locked: boolean }> | null>} null for an unknown book
 */
export async function moduleStates(repository, state, which = {}) {
  const project = typeof repository.getPreferences === 'function' ? await repository.getPreferences(which) : { library: null, book: null };
  if (project === null) return null;
  const profile = await readProfile(profileNameOf(state));
  return resolveModules({ profile: layerOf(profile), library: project.library, book: project.book });
}

/** Is `moduleId` on? Unknown books count as on (the route itself answers 404). @param {any} repository @param {any} state @param {string} moduleId @param {{ bookId?: string, bookPath?: string }} [which] */
export async function moduleOn(repository, state, moduleId, which = {}) {
  const states = await moduleStates(repository, state, which);
  return states === null ? true : states[moduleId]?.on !== false;
}

/** The refusal for a write whose module is off. Nothing was written. @param {string} moduleId */
export const moduleOff = (moduleId) => ({
  status: 403,
  body: { error: 'MODULE_OFF', code: 'MODULE_OFF', module: moduleId, message: `the ${moduleId} module is turned off here; nothing was written` },
});

/**
 * Refuse a write route whose module is off (null = go ahead). Used for every write route, the uploads included.
 * @param {any} repository @param {any} state @param {{ route: string, bookId?: string }} match
 */
export async function checkModule(repository, state, match) {
  const id = moduleOfRoute(match.route);
  if (id === null) return null;
  return (await moduleOn(repository, state, id, match.bookId ? { bookId: match.bookId } : {})) ? null : moduleOff(id);
}

/** The gate the repository asks about receipts (a save records no receipt while the module is off for its book). @param {any} state */
export const receiptsGate = (repository, state) => (moduleId, { bookPath }) => moduleOn(repository, state, moduleId, { bookPath });

/** GET /api/preferences[?book=<id>]: every layer, the resolved values, where each came from, the modules and any warnings. @param {any} repository @param {any} state @param {URLSearchParams} params */
export async function handlePreferencesRead(repository, state, params) {
  const bookId = params.get('book');
  const project = await repository.getPreferences(bookId ? { bookId } : {});
  if (project === null) return NOT_FOUND;
  const name = profileNameOf(state);
  const profile = (await readProfile(name)) ?? {};
  const layers = { library: project.library, book: project.book, profile: layerOf(profile) };
  const { values, sources, order } = resolvePreferences(layers);
  const modules = resolveModules(layers);
  const warnings = [];
  if (!modules.receipts.on) warnings.push({ module: 'receipts', code: 'RECEIPTS_GAP', message: 'Receipts are off: nothing new is recorded, so the provenance chain gets a gap: changes made while they are off have no receipts of their own.' });
  if (!modules.ai.on) warnings.push({ module: 'ai', code: 'AI_OFF', message: 'AI is off: StoryForge will never call the AI transport.' });
  return {
    status: 200,
    body: {
      profile: { name, names: await ensureListed(name), customThemes: profile.customThemes ?? {}, layouts: profile.layouts ?? {} },
      layers,
      effective: values,
      sources,
      order,
      modules,
      warnings,
      moduleIds: MODULE_IDS,
    },
  };
}

/** The profile names that exist, plus the one in use (it may not be saved yet). @param {string} name */
async function ensureListed(name) {
  const names = await listProfiles();
  return names.includes(name) ? names : [...names, name].sort();
}

/**
 * The profile write routes: PUT /api/profile (profile-save), POST /api/profile/switch (profile-switch), DELETE /api/profiles/:name (profile-delete).
 * None of them touches a library: they write only the per-machine profile file.
 * @param {{ route: string, name?: string }} match @param {Record<string, any>} body @param {any} state
 */
export async function handleProfileWrite(match, body, state) {
  switch (match.route) {
    case 'profile-save': {
      const name = profileNameOf(state);
      const current = (await readProfile(name)) ?? {};
      const next = { ...current };
      for (const [key, value] of Object.entries(body)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      const problems = profileProblems(next);
      if (problems.length > 0) return { status: 400, body: { error: 'bad_request', code: 'BAD_PROFILE', message: `${problems[0].location}: ${problems[0].message}`, problems } };
      const r = await writeProfile(name, { schema: 'storyforge.profile/v1', ...next });
      return r.ok ? { status: 200, body: { ok: true, profile: name } } : badRequest(r.message, r.code);
    }
    case 'profile-switch': {
      if (typeof body.name !== 'string' || !isProfileName(body.name)) return badRequest('name must be a profile name (lower-case letters, digits, hyphen or underscore)');
      if (body.create !== undefined && typeof body.create !== 'boolean') return badRequest('create must be true or false');
      if (!(await listProfiles()).includes(body.name)) {
        if (body.create !== true && body.name !== DEFAULT_PROFILE) return NOT_FOUND;
        const r = await writeProfile(body.name, { schema: 'storyforge.profile/v1' });
        if (!r.ok) return badRequest(r.message, r.code);
      }
      state.profile = body.name;
      return { status: 200, body: { ok: true, profile: body.name } };
    }
    case 'profile-delete': {
      const name = match.name ?? '';
      if (name === profileNameOf(state)) return { status: 409, body: { error: 'conflict', code: 'PROFILE_IN_USE', message: 'switch to another profile before deleting this one' } };
      return (await deleteProfile(name)) ? { status: 200, body: { ok: true } } : NOT_FOUND;
    }
    default:
      return NOT_FOUND;
  }
}
