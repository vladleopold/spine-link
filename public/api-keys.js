// Personal API key manager: no key material is persisted in browser storage.
// Only the pre-existing unexpired Google session is used for authentication.
const $ = selector => document.querySelector(selector);
const state = $('#status');
const signIn = $('#sign-in');
const manager = $('#manager');
const list = $('#key-list');
const noKeys = $('#no-keys');
const projectsList = $('#project-list');
const noProjects = $('#no-projects');
const newKeyBox = $('#new-key');
const secretValue = $('#key-value');
let googleToken = '';

function notice(message, error = false) {
  state.textContent = message;
  state.dataset.error = error ? 'true' : 'false';
}
function sessionToken() {
  try {
    const session = JSON.parse(localStorage.getItem('spine-link-google-session') || 'null');
    if (!session?.accessToken || !session?.user?.email ||
        !Number.isFinite(session?.expiresAt) || session.expiresAt <= Date.now() + 60000) return '';
    return session.accessToken;
  } catch { return ''; }
}
async function api(action, rest = {}) {
  const res = await fetch('/api/agent-animation', {
    method:'POST',
    headers:{
      Authorization:'Bearer ' + googleToken,
      'Content-Type':'application/json',
      'Cache-Control':'no-store',
    },
    cache:'no-store',
    body: JSON.stringify({action, ...rest}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || ('API HTTP ' + res.status));
  return data;
}
function element(tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}
function printKeyList(keys) {
  list.replaceChildren();
  noKeys.hidden = keys.length !== 0;
  for (const record of keys) {
    const row = document.createElement('tr');
    const info = document.createElement('td');
    info.append(element('strong', record.name));
    const id = element('td', record.prefix, 'muted');
    const date = element('td', new Date(record.createdAt).toLocaleDateString(), 'muted');
    const action = document.createElement('td');
    if (record.revokedAt) {
      action.append(element('span', 'Revoked', 'muted'));
    } else {
      const revoke = element('button', 'Revoke', 'danger');
      revoke.type = 'button';
      revoke.addEventListener('click', async () => {
        if (!window.confirm('Revoke API key "' + record.name + '"? This immediately disables the connected server.')) return;
        revoke.disabled = true;
        try {
          await api('keys-revoke', {keyId:record.id});
          notice('Key revoked.');
          await refresh();
        } catch (e) {
          revoke.disabled = false;
          notice(e.message || 'Could not revoke this key.', true);
        }
      });
      action.append(revoke);
    }
    row.append(info, id, date, action);
    list.append(row);
  }
}
function renderProjects(projects) {
  projectsList.replaceChildren();
  noProjects.hidden = projects.length !== 0;
  for (const project of projects) {
    const row = document.createElement('tr');
    const name = element('td', project.title);
    const status = element('td', project.state);
    const created = element('td',
      Number.isFinite(Date.parse(project.createdAt))
        ? new Date(project.createdAt).toLocaleDateString() : '—', 'muted');
    const destination = document.createElement('td');
    destination.className = 'controls';
    const link = element('a', 'Open');
    // URLs are constructed by the server from random IDs, not arbitrary data.
    if (/^https:\/\/spine-link\.vercel\.app\/p\/agent-[a-f0-9]{32}$/.test(project.pageUrl)) {
      link.href = project.pageUrl;
      link.rel = 'noopener noreferrer';
      link.target = '_blank';
      destination.append(link);
    }
    // Existing authenticated upload endpoint deletes the index card and its
    // asset tree in one Git commit. Never trust a browser-supplied repo path:
    // it derives the target from an owner-authorized library index.
    if (/^agent-[a-f0-9]{32}$/.test(project.id) &&
        /^library_\d{2,4}$/.test(project.collection)) {
      const remove = element('button', 'Delete', 'danger');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Delete ' + project.title);
      remove.addEventListener('click', async () => {
        if (!window.confirm('Permanently delete "' + project.title +
            '" from your library AND server? This cannot be undone.')) return;
        remove.disabled = true;
        try {
          const response = await fetch('/api/github-upload', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + googleToken,
              'Content-Type': 'application/json',
            },
            cache: 'no-store',
            body: JSON.stringify({
              action: 'delete-entry', entryId: project.id,
              collectionBasePath: project.collection,
            }),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || result.ok !== true || result.deleted !== project.id) {
            throw new Error(result.error || ('Delete failed: HTTP ' + response.status));
          }
          await refreshProjects();
          notice(result.filesDeleted === true
            ? 'Project and server files permanently deleted.'
            : 'Project removed from library. Its asset folder was already absent.');
        } catch (error) {
          remove.disabled = false;
          notice(error.message || 'Could not delete this project.', true);
        }
      });
      destination.append(remove);
    }
    row.append(name, status, created, destination);
    projectsList.append(row);
  }
}
async function refreshProjects() {
  const result = await api('keys-projects');
  renderProjects(Array.isArray(result.projects) ? result.projects : []);
}
$('#refresh-projects').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await refreshProjects();
    notice('Your server projects are up to date.');
  } catch (error) {
    notice(error.message || 'Unable to load projects.', true);
  } finally {
    button.disabled = false;
  }
});
async function refresh() {
  // Key management must remain usable if GitHub collection discovery is slow
  // or an old project's index is temporarily unavailable.
  const result = await api('keys-list');
  printKeyList(Array.isArray(result.keys) ? result.keys : []);
}
function clearNewKey() {
  secretValue.value = '';
  newKeyBox.hidden = true;
}
$('#hide-key').addEventListener('click', clearNewKey);
$('#copy-key').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(secretValue.value);
    notice('Key copied. Store it in your server environment secrets.');
  } catch {
    secretValue.focus();
    secretValue.select();
    notice('Clipboard permission denied. Copy the selected value manually.', true);
  }
});
// Test the newly created key with the actual API authorization path. It stays
// in the one-time secret textarea and is never saved to localStorage.
$('#test-key').addEventListener('click', async event => {
  const button = event.currentTarget;
  if (!secretValue.value) return;
  button.disabled = true;
  try {
    const response = await fetch('/api/agent-animation', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + secretValue.value,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify({ action: 'ping' }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.authenticated !== true || result.keyType !== 'personal') {
      throw new Error(result.error || 'API key verification failed');
    }
    notice('Personal API key is valid and can authenticate. Store it on your server.');
  } catch (error) {
    notice(error.message || 'Could not verify this key.', true);
  } finally {
    button.disabled = false;
  }
});
$('#create-key').addEventListener('submit', async event => {
  event.preventDefault();
  const btn = $('#create-button');
  const name = $('#key-name').value.trim();
  if (name.length < 3 || name.length > 60) return;
  btn.disabled = true;
  clearNewKey();
  try {
    const created = await api('keys-create', {name});
    secretValue.value = created.key;
    newKeyBox.hidden = false;
    notice('Key created. Copy it now; it is not saved in your browser.');
    await refresh();
  } catch (e) {
    notice(e.message || 'Could not create an API key.', true);
  } finally {
    btn.disabled = false;
  }
});
window.addEventListener('pagehide', clearNewKey);
// If the user signs out or switches Google accounts in a different tab,
// do not leave a previously revealed personal key visible on screen.
window.addEventListener('storage', event => {
  if (event.key !== 'spine-link-google-session') return;
  const next = sessionToken();
  if (next === googleToken) return;
  clearNewKey();
  googleToken = '';
  manager.hidden = true;
  signIn.hidden = false;
  list.replaceChildren();
  projectsList.replaceChildren();
  notice('Google session changed. Sign in to view your personal API keys.');
});
googleToken = sessionToken();
if (googleToken) {
  manager.hidden = false;
  // The two data sources are independent: a slow/failed project scan must
  // never prevent the user from viewing, creating or revoking their keys.
  Promise.allSettled([refresh(), refreshProjects()]).then(([keys, projects]) => {
    if (!googleToken) return; // Google session changed during loading
    if (keys.status === 'rejected') {
      const error = keys.reason;
      if (/Google|session|401/i.test(error.message || '')) {
        manager.hidden = true;
        signIn.hidden = false;
        googleToken = '';
        clearNewKey();
      }
      notice(error.message || 'Could not load API keys.', true);
    } else if (projects.status === 'rejected') {
      notice('Keys are available, but server projects could not be loaded. Use Refresh to retry.', true);
    } else {
      notice('Your API keys and server projects are ready.');
    }
  });
} else {
  signIn.hidden = false;
  notice('Sign in with Google to manage your keys.');
}
