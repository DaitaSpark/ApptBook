// Supabase's HTTPS REST/Auth interfaces; only the public key is sent to browsers.
let config;
let session;
let refreshing;
const storageKey = 'jrco-admin-session';
export async function settings() {
  if (!config) {
    const response = await fetch('/config.json', {cache: 'no-store'});
    if (!response.ok) throw new Error('Unable to load app settings. Please reload.');
    config = await response.json();
  }
  return config;
}
function storeSession(value) {
  session = value ? {...value, expires_at: Date.now() + (value.expires_in || 3600) * 1000} : null;
  if (session) sessionStorage.setItem(storageKey, JSON.stringify(session));
  else sessionStorage.removeItem(storageKey);
}
export function currentSession() {
  if (session === undefined) {
    try { session = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); }
    catch { session = null; sessionStorage.removeItem(storageKey); }
  }
  return session;
}
async function call(path, body, token) {
  const cfg = await settings();
  if (!cfg.url || !cfg.publishableKey) throw new Error('Supabase is not connected yet. Configure the project URL and publishable key.');
  let response;
  try {
    response = await fetch(`${cfg.url}${path}`, {method: 'POST', headers: {
      apikey: cfg.publishableKey, 'Content-Type': 'application/json',
      ...(token ? {Authorization: `Bearer ${token}`} : {})}, body: JSON.stringify(body)});
  } catch { throw new Error('Unable to reach the booking service. Check your connection and try again.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.msg || data.error_description || data.message || 'The request could not be completed.');
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}
async function accessToken() {
  const saved = currentSession();
  if (!saved) throw new Error('Sign in to manage appointments.');
  if (saved.expires_at > Date.now() + 60000) return saved.access_token;
  if (!refreshing) refreshing = call('/auth/v1/token?grant_type=refresh_token', {refresh_token: saved.refresh_token})
    .then(value => { storeSession(value); return value.access_token; })
    .catch(error => { storeSession(null); throw error; }).finally(() => { refreshing = null; });
  return refreshing;
}
export async function signIn(email, password) {
  storeSession(await call('/auth/v1/token?grant_type=password', {email, password}));
}
export async function signOut() {
  const saved = currentSession();
  storeSession(null);
  if (saved) await call('/auth/v1/logout?scope=local', {}, saved.access_token).catch(() => {});
}
export async function rpc(name, body = {}, admin = false) {
  if ((await settings()).preview) throw new Error('Local preview is read-only. Connect Supabase to save changes.');
  const token = admin ? await accessToken() : undefined;
  try { return await call(`/rest/v1/rpc/${name}`, body, token); }
  catch (error) {
    if (admin && error.status === 401 && currentSession()) {
      session.expires_at = 0;
      return call(`/rest/v1/rpc/${name}`, body, await accessToken());
    }
    throw error;
  }
}
export const el = id => document.getElementById(id);
export function notify(text, error = false) {
  const target = el('message');
  target.textContent = text;
  target.className = `notice${error ? ' error' : ''}`;
  target.hidden = !text;
}
export const eastern = (value, options = {}) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', ...options}).format(new Date(value));
export function localTimestamp(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'}).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
export function option(value, label) { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; }
