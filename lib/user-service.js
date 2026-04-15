/**
 * lib/user-service.js  –  Smart Bookmark
 *
 * Manages the current user session (anonymous or authenticated).
 * Persists to chrome.storage.local so the state survives SW restarts.
 *
 * Phase 1: anonymous / free-plan only.
 * Phase 2: replace fetchUserFromApi() stub with a real API call.
 */

// ── Plan enum ─────────────────────────────────────────────────────────────────
/** @readonly @enum {string} */
export const PLAN = Object.freeze({
  FREE: 'free',
  PAID:  'paid',
});

/** Maximum bookmarks indexed for free-plan users. */
export const FREE_PLAN_LIMIT = 100;

// ── User shape ────────────────────────────────────────────────────────────────
/**
 * @typedef {Object} User
 * @property {string|null}  email             – user e-mail (null = anonymous)
 * @property {string}       subscription_plan – one of PLAN values
 * @property {string|null}  valid_until       – ISO-8601 expiry date; null = never expires
 * @property {number|null}  fetched_at        – ms timestamp of last API sync
 */

/** Default state for an unauthenticated / free user. */
const ANONYMOUS_USER = Object.freeze({
  email:             null,
  subscription_plan: PLAN.FREE,
  valid_until:       null,
  fetched_at:        null,
});

const STORAGE_KEY = 'bss_user';

/** In-memory cache – avoids redundant storage reads within the same SW lifetime. */
let _cache = null;

// ── Core CRUD ─────────────────────────────────────────────────────────────────

/**
 * Returns the current user, loading from storage on the first call.
 * Always resolves – falls back to ANONYMOUS_USER on any error.
 * @returns {Promise<User>}
 */
export async function getUser() {
  if (_cache) return _cache;
  try {
    const { [STORAGE_KEY]: stored } = await chrome.storage.local.get(STORAGE_KEY);
    _cache = stored ? { ...ANONYMOUS_USER, ...stored } : { ...ANONYMOUS_USER };
  } catch {
    _cache = { ...ANONYMOUS_USER };
  }
  return _cache;
}

/**
 * Persists a (partial) user object, merged with ANONYMOUS_USER defaults.
 * @param {Partial<User>} partial
 * @returns {Promise<User>}
 */
export async function setUser(partial) {
  _cache = { ...ANONYMOUS_USER, ...partial, fetched_at: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEY]: _cache });
  return _cache;
}

/**
 * Resets to the anonymous user and removes any persisted data.
 * @returns {Promise<User>}
 */
export async function clearUser() {
  _cache = { ...ANONYMOUS_USER };
  await chrome.storage.local.remove(STORAGE_KEY);
  return _cache;
}

// ── Plan helpers ──────────────────────────────────────────────────────────────

/**
 * Returns true when the user's subscription is currently active.
 * The free plan never expires.
 * @param {User} user
 * @returns {boolean}
 */
export function isPlanActive(user) {
  if (user.subscription_plan === PLAN.FREE) return true;
  return new Date(user.valid_until) >= new Date();
}

// ── API integration (stub – Phase 2) ─────────────────────────────────────────

/**
 * Fetches the authenticated user from the remote API and persists the result.
 * Replace the body with a real fetch() call in Phase 2.
 *
 * @param {string} token  – Bearer token obtained from the auth flow
 * @returns {Promise<User>}
 */
export async function fetchUserFromApi(_token) {
  // TODO (Phase 2): configure API_BASE and uncomment:
  //
  // const resp = await fetch('https://api.yourdomain.com/v1/me', {
  //   headers: {
  //     Authorization : `Bearer ${_token}`,
  //     'Content-Type': 'application/json',
  //   },
  // });
  // if (!resp.ok) throw new Error(`fetchUserFromApi: HTTP ${resp.status}`);
  // return setUser(await resp.json());

  throw new Error('fetchUserFromApi: API not configured yet');
}
