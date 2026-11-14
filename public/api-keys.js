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
    const link = element('a', 'Open');
    // URLs are constructed by the server from random IDs, not arbitrary data.
    if (/^https:\/\/spine-link\.vercel\.app\/p\/agent-[a-f0-9]{32}$/.test(project.pageUrl)) {
      link.href = project.pageUrl;
      link.rel = 'noopener noreferrer';
      link.target = '_blank';
      destination.append(link);
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
  const result = await api('keys-list');
  printKeyList(Array.isArray(result.keys) ? result.keys : []);
  await refreshProjects();
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
googleToken = sessionToken();
if (googleToken) {
  manager.hidden = false;
  refresh().then(() => notice('Your API keys are ready.')).catch(e => {
    if (/Google|session|401/i.test(e.message || '')) {
      manager.hidden = true;
      signIn.hidden = false;
      googleToken = '';
    }
    notice(e.message || 'Could not load API keys.', true);
  });
} else {
  signIn.hidden = false;
  notice('Sign in with Google to manage your keys.');
}
