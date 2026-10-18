// Sender : interface (vanilla JS, aucune dépendance).
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/login')) location.replace('/login.html');
  if (!res.ok) throw new Error(data.message || `Erreur ${res.status}`);
  return data;
};

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), type === 'error' ? 12000 : 4000);
}

const escapeHtml = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Boîte de dialogue intégrée à la page (remplace confirm/prompt du navigateur).
function ask(message, { input = false, value = '', ok = 'OK' } = {}) {
  return new Promise((resolve) => {
    const box = $('#dialog');
    $('#dialogMsg').textContent = message;
    const field = $('#dialogInput');
    field.classList.toggle('hidden', !input);
    field.value = value;
    $('#dialogOk').textContent = ok;
    box.classList.remove('hidden');
    (input ? field : $('#dialogOk')).focus();
    const close = (result) => {
      box.classList.add('hidden');
      $('#dialogOk').onclick = $('#dialogCancel').onclick = field.onkeydown = null;
      resolve(result);
    };
    $('#dialogOk').onclick = () => close(input ? field.value : true);
    $('#dialogCancel').onclick = () => close(input ? null : false);
    field.onkeydown = (e) => {
      if (e.key === 'Enter') close(field.value);
      if (e.key === 'Escape') close(null);
    };
  });
}
const askConfirm = (message, ok) => ask(message, { ok });
const askText = (message, value = '') => ask(message, { input: true, value });

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

// ---------- Navigation ----------
$$('.tab').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
    $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + b.dataset.view));
    if (b.dataset.view === 'history') loadHistory();
  })
);

// ---------- État persistant (brouillon) ----------
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('cvs.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cvs.' + k, JSON.stringify(v)); } catch {} },
};

let recipients = store.get('recipients', []);
let attachments = store.get('attachments', []); // [{id, name, size}] joints au mail en cours

// ---------- CSV ----------
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = [';', ',', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim()));
}

const ALIASES = {
  email: ['email', 'e-mail', 'mail', 'courriel', 'adresse', 'adresse email', 'adresse e-mail', 'adresse mail'],
  nom: ['nom', 'name', 'contact', 'nom complet', 'recruteur'],
  prenom: ['prenom', 'prénom', 'first name', 'firstname'],
  entreprise: ['entreprise', 'société', 'societe', 'company', 'organisation', 'employeur'],
  poste: ['poste', 'job', 'intitulé', 'intitule', 'offre', 'position'],
};
function normalizeHeader(h) {
  const k = h.trim().toLowerCase();
  for (const [canon, list] of Object.entries(ALIASES)) if (list.includes(k)) return canon;
  return k.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || 'col';
}

function importCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return toast('Fichier vide.', 'error');
  let headers = rows[0].map(normalizeHeader);
  let body = rows.slice(1);
  if (!headers.includes('email')) {
    // Pas d'en-tête reconnu : on cherche la colonne qui contient des e-mails.
    const idx = rows[0].findIndex((v) => EMAIL_RE.test(v.trim()));
    if (idx === -1) return toast('Aucune colonne « email » trouvée dans le CSV.', 'error');
    headers = rows[0].map((_, i) => (i === idx ? 'email' : 'col' + (i + 1)));
    body = rows;
  }
  let added = 0, invalid = 0, dup = 0;
  const existing = new Set(recipients.map((r) => r.email));
  for (const r of body) {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] || '').trim(); });
    obj.email = obj.email.toLowerCase();
    if (!EMAIL_RE.test(obj.email)) { invalid++; continue; }
    if (existing.has(obj.email)) { dup++; continue; }
    existing.add(obj.email);
    recipients.push({ ...obj, _on: true });
    added++;
  }
  saveRecipients();
  toast(`${added} destinataire(s) importé(s)` + (dup ? `, ${dup} doublon(s) ignoré(s)` : '') + (invalid ? `, ${invalid} adresse(s) invalide(s)` : '') + '.', 'ok');
}

$('#csvInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) importCsv(await f.text());
  e.target.value = '';
});
const drop = $('#csvDrop');
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) importCsv(await f.text());
});

$('#manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = $('#mEmail').value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return toast('Adresse e-mail invalide.', 'error');
  if (recipients.some((r) => r.email === email)) return toast('Cette adresse est déjà dans la liste.', 'error');
  recipients.push({ email, _on: true });
  e.target.reset();
  $('#mEmail').focus();
  saveRecipients();
});

const columns = () => {
  // Les autres colonnes (nom, entreprise…) n'apparaissent que si un CSV les apporte.
  const cols = new Set(['email']);
  recipients.forEach((r) => Object.keys(r).forEach((k) => k !== '_on' && cols.add(k)));
  return [...cols];
};

function saveRecipients() {
  store.set('recipients', recipients);
  renderRecipients();
}

function renderRecipients() {
  const cols = columns();
  const table = $('#recipientsTable');
  table.querySelector('thead').innerHTML =
    '<tr><th></th>' + cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('') + '<th></th></tr>';
  table.querySelector('tbody').innerHTML = recipients
    .map((r, i) =>
      `<tr class="${r._on ? '' : 'off'}"><td><input type="checkbox" data-i="${i}" ${r._on ? 'checked' : ''}></td>` +
      cols.map((c) => `<td contenteditable="true" data-i="${i}" data-c="${escapeHtml(c)}">${escapeHtml(r[c] || '')}</td>`).join('') +
      `<td><button class="link danger" data-del="${i}" title="Retirer">✕</button></td></tr>`)
    .join('');
  $('#noRecipients').classList.toggle('hidden', recipients.length > 0);
  const on = recipients.filter((r) => r._on).length;
  $('#recipientCount').textContent = on + (on !== recipients.length ? ' / ' + recipients.length : '');
  $('#sendAll').textContent = `Envoyer à ${on} destinataire${on > 1 ? 's' : ''}`;
  $('#varsInfo').innerHTML = 'Variables : ' + cols.map((c) => `<code>{{${escapeHtml(c)}}}</code>`).join(' ');
  $('#insertVar').innerHTML = '<option value="">{{ }} Variable</option>' + cols.map((c) => `<option>${escapeHtml(c)}</option>`).join('');
  renderPreviewRecipients();
}

$('#recipientsTable').addEventListener('change', (e) => {
  if (e.target.dataset.i != null && e.target.type === 'checkbox') {
    recipients[e.target.dataset.i]._on = e.target.checked;
    saveRecipients();
  }
});
$('#recipientsTable').addEventListener('click', (e) => {
  const del = e.target.dataset.del;
  if (del != null) { recipients.splice(+del, 1); saveRecipients(); }
});
$('#recipientsTable').addEventListener('focusout', (e) => {
  const { i, c } = e.target.dataset;
  if (i == null || !c) return;
  const v = e.target.textContent.trim();
  recipients[i][c] = c === 'email' ? v.toLowerCase() : v;
  store.set('recipients', recipients);
  if (c === 'email' && !EMAIL_RE.test(recipients[i].email)) toast('Attention : adresse invalide sur la ligne ' + (+i + 1), 'error');
});
$('#selectAll').addEventListener('click', () => {
  const all = recipients.every((r) => r._on);
  recipients.forEach((r) => (r._on = !all));
  saveRecipients();
});
$('#clearRecipients').addEventListener('click', async () => {
  if (recipients.length && (await askConfirm('Vider toute la liste des destinataires ?', 'Vider'))) { recipients = []; saveRecipients(); }
});

// ---------- Pièces jointes (dans l'écriture du mail) ----------
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' Mo' : Math.max(1, Math.round(n / 1024)) + ' Ko');
function renderAttachments() {
  store.set('attachments', attachments);
  $('#attachList').innerHTML = attachments
    .map((f) => `<li title="${escapeHtml(f.name)}">📎 <span class="name">${escapeHtml(f.name)}</span>
      <span class="muted">${fmtSize(f.size)}</span>
      <button data-detach="${escapeHtml(f.id)}" aria-label="Retirer ${escapeHtml(f.name)}">✕</button></li>`)
    .join('');
}
async function syncAttachments() {
  // Retire les fichiers qui n'existent plus côté serveur.
  try {
    const onServer = new Set((await api('/api/cv')).map((f) => f.id));
    attachments = attachments.filter((f) => onServer.has(f.id));
  } catch {}
  renderAttachments();
}
$('#attachBtn').addEventListener('click', (e) => { e.preventDefault(); $('#attachInput').click(); });
$('#attachInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  try {
    const before = new Set(attachments.map((f) => f.id));
    const list = await api('/api/cv', { method: 'POST', body: fd });
    const added = list.slice(-files.length).filter((f) => !before.has(f.id));
    attachments.push(...added);
    renderAttachments();
    toast(added.length > 1 ? `${added.length} fichiers joints.` : 'Fichier joint.', 'ok');
  } catch (err) { toast(err.message, 'error'); }
});
$('#attachList').addEventListener('click', async (e) => {
  const id = e.target.closest('[data-detach]')?.dataset.detach;
  if (!id) return;
  attachments = attachments.filter((f) => f.id !== id);
  renderAttachments();
  api('/api/cv/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
});

// ---------- Éditeur ----------
const editor = $('#editor');
const source = $('#htmlSource');
let mode = 'visual';

// Champs d'en-tête du mail (vides par défaut).
const HEADER_FIELDS = ['identitySelect', 'fromName', 'fromEmail', 'replyTo', 'cc', 'bcc', 'subject'];
editor.innerHTML = store.get('html', '');
HEADER_FIELDS.forEach((id) => { $('#' + id).value = store.get(id, ''); });

const getHtml = () => (mode === 'html' ? source.value : editor.innerHTML);
function setHtml(html) {
  editor.innerHTML = html;
  source.value = html;
  saveDraft();
}
function saveDraft() {
  store.set('html', getHtml());
  HEADER_FIELDS.forEach((id) => store.set(id, $('#' + id).value));
}
editor.addEventListener('input', () => {
  // Synchronise l'éditeur visuel vers la source HTML
  if (mode === 'visual') {
    source.value = formatHtml(editor.innerHTML);
  }
  saveDraft();
});

source.addEventListener('input', () => {
  // Synchronise la source HTML vers l'éditeur visuel
  if (mode === 'html') {
    editor.innerHTML = source.value;
  }
  saveDraft();
});
HEADER_FIELDS.forEach((id) => $('#' + id).addEventListener('input', saveDraft));

// ---------- Identités ----------
let identities = [];
const CUSTOM = '__custom';
const identityLabel = (i) => (i.name ? `${i.name} <${i.email}>` : i.email);
function renderIdentitySelect() {
  const sel = $('#identitySelect');
  const wanted = store.get('identitySelect', '');
  sel.innerHTML =
    '<option value="">Expéditeur par défaut (Réglages)</option>' +
    identities.map((i) => `<option value="${escapeHtml(i.id)}">${escapeHtml(identityLabel(i))}</option>`).join('') +
    `<option value="${CUSTOM}">Autre adresse…</option>`;
  sel.value = [...sel.options].some((o) => o.value === wanted) ? wanted : '';
  toggleCustomFrom();
}
function toggleCustomFrom() {
  $$('.custom-from').forEach((el) => el.classList.toggle('hidden', $('#identitySelect').value !== CUSTOM));
}
$('#identitySelect').addEventListener('change', () => {
  const i = identities.find((x) => x.id === $('#identitySelect').value);
  // Comme Thunderbird : l'identité apporte ses Répondre à / Cc / Cci.
  if (i) { $('#replyTo').value = i.replyTo || ''; $('#cc').value = i.cc || ''; $('#bcc').value = i.bcc || ''; }
  toggleCustomFrom();
  saveDraft();
});
function signatureHtml() {
  const i = identities.find((x) => x.id === $('#identitySelect').value);
  return i && i.signature ? `<div style="margin-top:20px">${i.signature}</div>` : '';
}
function currentSender() {
  const v = $('#identitySelect').value;
  const i = identities.find((x) => x.id === v);
  if (i) return { name: i.name, email: i.email };
  if (v === CUSTOM) return { name: $('#fromName').value.trim(), email: $('#fromEmail').value.trim() };
  return { name: settingsCache.fromName || '', email: settingsCache.fromEmail || settingsCache.user || '' };
}

function renderIdentityList() {
  $('#identityList').innerHTML = identities.length
    ? identities.map((i) => `<li><span class="who"><strong>${escapeHtml(i.name || i.email)}</strong> <span class="muted">&lt;${escapeHtml(i.email)}&gt;</span><br>
        <span class="muted small">${i.smtp ? 'Serveur : ' + escapeHtml(i.smtp.host) : 'Serveur principal'}${i.replyTo ? ' · Répondre à ' + escapeHtml(i.replyTo) : ''}</span></span>
        <span class="actions"><button class="link" data-edit="${escapeHtml(i.id)}">Modifier</button>
        <button class="link" data-test="${escapeHtml(i.id)}">Tester</button>
        <button class="link danger" data-remove="${escapeHtml(i.id)}">Supprimer</button></span></li>`).join('')
    : '<li class="muted">Aucune identité. Ajoutez-en une pour envoyer sous un autre nom ou une autre adresse.</li>';
}
async function loadIdentities(list) {
  identities = list || (await api('/api/identities'));
  renderIdentityList();
  renderIdentitySelect();
}
const idForm = $('#identityForm');
function openIdentityForm(i) {
  idForm.reset();
  idForm.elements.id.value = i ? i.id : '';
  if (i) for (const k of ['name', 'email', 'replyTo', 'cc', 'bcc']) idForm.elements[k].value = i[k] || '';
  $('#sigEditor').innerHTML = (i && i.signature) || '';
  const custom = !!(i && i.smtp);
  idForm.elements.smtpMode.value = custom ? 'custom' : 'default';
  if (custom) {
    idForm.elements.smtpHost.value = i.smtp.host;
    idForm.elements.smtpPort.value = i.smtp.port;
    idForm.elements.smtpSecure.checked = i.smtp.secure;
    idForm.elements.smtpUser.value = i.smtp.user || '';
    idForm.elements.smtpPass.value = i.smtp.pass || '';
  }
  $('#identitySmtp').classList.toggle('hidden', !custom);
  idForm.classList.remove('hidden');
  $('#addIdentity').classList.add('hidden');
  idForm.elements.name.focus();
}
function closeIdentityForm() {
  idForm.classList.add('hidden');
  $('#addIdentity').classList.remove('hidden');
}
$('#addIdentity').addEventListener('click', () => openIdentityForm(null));
$('#sigImage').addEventListener('click', () => $('#sigImageInput').click());
$('#sigImageInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('image', file);
  try {
    const { url } = await api('/api/images', { method: 'POST', body: fd });
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.style.cssText = 'max-width:180px;height:auto';
    $('#sigEditor').appendChild(img);
  } catch (err) { toast(err.message, 'error'); }
});
$('#cancelIdentity').addEventListener('click', closeIdentityForm);
idForm.addEventListener('change', (e) => {
  if (e.target.name === 'smtpMode') $('#identitySmtp').classList.toggle('hidden', idForm.elements.smtpMode.value !== 'custom');
});
idForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = idForm.elements;
  const body = { id: f.id.value || undefined, name: f.name.value, email: f.email.value, replyTo: f.replyTo.value, cc: f.cc.value, bcc: f.bcc.value, signature: $('#sigEditor').innerHTML.trim() === '<br>' ? '' : $('#sigEditor').innerHTML.trim() };
  if (f.smtpMode.value === 'custom') {
    if (!f.smtpHost.value.trim()) return toast('Indiquez le serveur SMTP de cette identité.', 'error');
    body.smtp = { host: f.smtpHost.value, port: f.smtpPort.value, secure: f.smtpSecure.checked, user: f.smtpUser.value, pass: f.smtpPass.value };
  }
  try {
    await loadIdentities(await api('/api/identities', { method: 'POST', body }));
    closeIdentityForm();
    toast('Identité enregistrée.', 'ok');
  } catch (err) { toast(err.message, 'error'); }
});
$('#identityList').addEventListener('click', async (e) => {
  const { edit, test, remove } = e.target.dataset;
  if (edit) openIdentityForm(identities.find((i) => i.id === edit));
  if (test) {
    try { toast((await api(`/api/identities/${test}/test`, { method: 'POST' })).message, 'ok'); }
    catch (err) { toast('Échec : ' + err.message, 'error'); }
  }
  if (remove && (await askConfirm('Supprimer cette identité ?', 'Supprimer'))) loadIdentities(await api('/api/identities/' + remove, { method: 'DELETE' }));
});

function setMode(m) {
  if (mode === 'html' && m !== 'html') editor.innerHTML = source.value;
  if (m === 'html') source.value = formatHtml(editor.innerHTML);
  mode = m === 'preview' ? (mode === 'html' ? 'html' : 'visual') : m;
  $$('.etab').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  editor.classList.toggle('hidden', m !== 'visual');
  source.classList.toggle('hidden', m !== 'html');
  $('#toolbar').classList.toggle('disabled', m !== 'visual');
  $('#previewPane').classList.toggle('hidden', m !== 'preview');
  if (m === 'preview') renderPreview();
}
$$('.etab').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// Indentation légère pour la vue HTML.
const formatHtml = (html) => html.replace(/>\s*(<(p|h\d|ul|ol|li|div|table|tr|br)\b)/gi, '>\n$1').trim();

$('#toolbar').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-cmd]');
  if (!btn) return;
  e.preventDefault();
  const cmd = btn.dataset.cmd;
  let arg = null;
  if (cmd === 'createLink') {
    arg = await askText('Adresse du lien (https://…, mailto:…) :', 'https://');
    if (!arg) return;
  }
  restoreSelection();
  document.execCommand(cmd, false, arg);
  saveDraft();
});
$('#toolbar').addEventListener('change', (e) => {
  const cmd = e.target.dataset.cmd;
  if (cmd) {
    editor.focus();
    document.execCommand(cmd, false, cmd === 'formatBlock' ? `<${e.target.value}>` : e.target.value);
    saveDraft();
  }
});
// Empêche les boutons de voler la sélection de l'éditeur.
$('#toolbar').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });

$('#insertVar').addEventListener('change', (e) => {
  if (!e.target.value) return;
  restoreSelection();
  document.execCommand('insertText', false, `{{${e.target.value}}}`);
  e.target.value = '';
  saveDraft();
});

// Mémorise la position du curseur pour insérer l'image au bon endroit
// (la boîte de sélection de fichier fait perdre la sélection).
let savedRange = null;
document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  if (sel.rangeCount && editor.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
});
function restoreSelection() {
  editor.focus();
  if (savedRange) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); }
}

function insertImage(url) {
  restoreSelection();
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.style.cssText = 'max-width:100%;height:auto';
  const sel = getSelection();
  if (sel.rangeCount && editor.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else editor.appendChild(img);
  saveDraft();
}
async function uploadImage(file) {
  const fd = new FormData();
  fd.append('image', file);
  try {
    const { url } = await api('/api/images', { method: 'POST', body: fd });
    insertImage(url);
  } catch (err) { toast(err.message, 'error'); }
}
$('#imgUploadBtn').addEventListener('click', (e) => { e.preventDefault(); $('#imgInput').click(); });
$('#imgInput').addEventListener('change', (e) => { if (e.target.files[0]) uploadImage(e.target.files[0]); e.target.value = ''; });
$('#imgUrlBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  const url = await askText("URL de l'image (https://…) :", 'https://');
  if (url) insertImage(url);
});
// Coller / glisser une image directement dans l'éditeur.
editor.addEventListener('paste', (e) => {
  const img = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (img) { e.preventDefault(); uploadImage(img); }
});
editor.addEventListener('drop', (e) => {
  const img = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
  if (img) { e.preventDefault(); uploadImage(img); }
});
// Double-clic sur une image : changer sa largeur.
editor.addEventListener('dblclick', async (e) => {
  if (e.target.tagName !== 'IMG') return;
  const w = await askText('Largeur de l\'image en pixels (vide = taille d\'origine) :', e.target.style.width.replace('px', ''));
  if (w === null) return;
  e.target.style.width = w ? `${parseInt(w, 10)}px` : '';
  saveDraft();
});

// ---------- Aperçu ----------
function fillVars(text, vars, html) {
  const lower = {};
  for (const [k, v] of Object.entries(vars || {})) lower[k.toLowerCase()] = v ?? '';
  return text.replace(/\{\{\s*([\w\-À-ÿ]+)\s*\}\}/g, (_, key) => {
    const v = lower[key.toLowerCase()];
    if (v === undefined || v === '') return html ? `<mark title="variable vide">{{${key}}}</mark>` : `{{${key}}}`;
    return html ? escapeHtml(v) : v;
  });
}
function renderPreviewRecipients() {
  const sel = $('#previewRecipient');
  const prev = sel.value;
  sel.innerHTML = recipients.length
    ? recipients.map((r, i) => `<option value="${i}">${escapeHtml(r.email)}${r.entreprise ? ' – ' + escapeHtml(r.entreprise) : ''}</option>`).join('')
    : '<option value="">(exemple)</option>';
  if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
}
function renderPreview() {
  const r = recipients[$('#previewRecipient').value] || { nom: 'Mme Dupont', entreprise: 'Exemple SA', poste: 'Développeur', email: 'rh@exemple.fr' };
  $('#previewSubject').textContent = fillVars($('#subject').value, r, false);
  const from = currentSender();
  $('#previewFrom').textContent = from.name ? `${from.name} <${from.email}>` : from.email || '(à configurer dans Réglages)';
  $('#previewFrame').srcdoc = `<base href="${location.origin}/"><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;margin:16px">${fillVars(getHtml() + signatureHtml(), r, true)}</body>`;
}
$('#previewRecipient').addEventListener('change', renderPreview);

// ---------- Modèles ----------
let templates = [];
async function loadTemplates(list) {
  templates = list || (await api('/api/templates'));
  const sel = $('#templateSelect');
  const cur = sel.value;
  sel.innerHTML = '<option value=""></option>' + templates.map((t) => `<option>${escapeHtml(t.name)}</option>`).join('');
  sel.value = templates.some((t) => t.name === cur) ? cur : '';
  $('#deleteTemplate').classList.toggle('hidden', !sel.value);
}
$('#templateSelect').addEventListener('change', (e) => {
  const t = templates.find((x) => x.name === e.target.value);
  $('#deleteTemplate').classList.toggle('hidden', !t);
  if (!t) return;
  HEADER_FIELDS.forEach((id) => { $('#' + id).value = t[id] || ''; });
  if (!$('#identitySelect').value) $('#identitySelect').value = '';
  toggleCustomFrom();
  setHtml(t.html);
  if (mode === 'html') source.value = formatHtml(t.html);
  toast(`Modèle « ${t.name} » chargé.`);
});
$('#saveTemplate').addEventListener('click', async () => {
  const name = await askText('Nom du modèle :', $('#templateSelect').value || '');
  if (!name) return;
  await loadTemplates(await api('/api/templates', { method: 'POST', body: { name, html: getHtml(), ...Object.fromEntries(HEADER_FIELDS.map((id) => [id, $('#' + id).value])) } }));
  $('#templateSelect').value = name;
  $('#deleteTemplate').classList.remove('hidden');
  toast('Modèle enregistré.', 'ok');
});
$('#deleteTemplate').addEventListener('click', async () => {
  const name = $('#templateSelect').value;
  if (name && (await askConfirm(`Supprimer le modèle « ${name} » ?`, 'Supprimer'))) {
    $('#templateSelect').value = '';
    loadTemplates(await api('/api/templates/' + encodeURIComponent(name), { method: 'DELETE' }));
  }
});

// ---------- Envoi ----------
let currentJob = null;
async function startSend(testTo) {
  saveDraft();
  const html = getHtml();
  const list = recipients.filter((r) => r._on).map(({ _on, ...r }) => r);
  if (!$('#subject').value.trim()) return toast("Renseignez l'objet du mail.", 'error');
  if (!testTo && !list.length) return toast('Aucun destinataire sélectionné.', 'error');
  if (!attachments.length && !(await askConfirm("Aucune pièce jointe. Envoyer quand même ?", 'Envoyer'))) return;
  if (!testTo && !(await askConfirm(`Envoyer ce mail à ${list.length} destinataire(s) ?`, 'Envoyer'))) return;
  try {
    const { jobId, total } = await api('/api/send', {
      method: 'POST',
      body: {
        subject: $('#subject').value, html, recipients: list, cvIds: attachments.map((f) => f.id), testTo: testTo || undefined,
        ...(identities.some((i) => i.id === $('#identitySelect').value)
          ? { identityId: $('#identitySelect').value }
          : $('#identitySelect').value === CUSTOM
            ? { fromName: $('#fromName').value.trim(), fromEmail: $('#fromEmail').value.trim() }
            : {}),
        replyTo: $('#replyTo').value.trim(), cc: $('#cc').value.trim(), bcc: $('#bcc').value.trim(),
        textOnly: $('#textOnly') && $('#textOnly').checked,
      },
    });
    currentJob = jobId;
    $('#progress').classList.remove('hidden');
    $('#jobResults').innerHTML = '';
    $('#sendAll').disabled = $('#sendTest').disabled = true;
    pollJob(jobId, total);
  } catch (err) { toast(err.message, 'error'); }
}
async function pollJob(id, total) {
  const job = await api('/api/jobs/' + id).catch(() => null);
  if (!job || id !== currentJob) return;
  const n = job.sent + job.failed;
  $('#progressBar').style.width = `${Math.round((n / total) * 100)}%`;
  $('#progressText').textContent = `${n} / ${total} traité(s) · ${job.sent} envoyé(s) · ${job.failed} échec(s)` + (job.done ? (job.cancelled ? ' · arrêté' : ' · terminé') : '…');
  $('#jobResults').innerHTML = job.results
    .map((r) => `<li class="${r.status === 'envoyé' ? 'ok' : 'error'}">${r.status === 'envoyé' ? '✓' : '✕'} ${escapeHtml(r.email)}${r.error ? ' – ' + escapeHtml(r.error) : ''}</li>`)
    .join('');
  $('#cancelJob').classList.toggle('hidden', job.done);
  if (job.done) {
    $('#sendAll').disabled = $('#sendTest').disabled = false;
    toast(job.failed ? `Terminé avec ${job.failed} échec(s).` : 'Envoi terminé.', job.failed ? 'error' : 'ok');
  } else setTimeout(() => pollJob(id, total), 1000);
}
$('#sendAll').addEventListener('click', () => startSend());
$('#sendTest').addEventListener('click', () => {
  const to = $('#testTo').value.trim();
  if (!EMAIL_RE.test(to)) return toast('Saisissez votre adresse pour le test.', 'error');
  store.set('testTo', to);
  startSend(to);
});
$('#cancelJob').addEventListener('click', () => currentJob && api(`/api/jobs/${currentJob}/cancel`, { method: 'POST' }));

// ---------- Historique ----------
let history = [];
async function loadHistory() {
  history = await api('/api/history');
  $('#historyTable tbody').innerHTML = history.length
    ? history.map((h) => `<tr><td>${new Date(h.at).toLocaleString('fr-FR')}</td><td>${escapeHtml(h.email)}</td>
        <td>${escapeHtml(h.entreprise)}</td><td>${escapeHtml(h.subject)}</td>
        <td class="${h.status === 'envoyé' ? 'ok' : 'error'}" title="${escapeHtml(h.error || '')}">${escapeHtml(h.status)}${h.dryRun ? ' (simulation)' : ''}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted center">Aucun envoi pour le moment.</td></tr>';
}
$('#clearHistory').addEventListener('click', async () => {
  if (await askConfirm("Effacer tout l'historique ?", 'Effacer')) { await api('/api/history', { method: 'DELETE' }); loadHistory(); }
});
$('#exportHistory').addEventListener('click', () => {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['date;email;entreprise;objet;statut;erreur', ...history.map((h) => [h.at, h.email, h.entreprise, h.subject, h.status, h.error].map(q).join(';'))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = 'historique-candidatures.csv';
  a.click();
});

// ---------- Réglages ----------
const PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  yahoo: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
};
const form = $('#settingsForm');
let settingsCache = {};
async function loadSettings() {
  const s = await api('/api/settings');
  settingsCache = s;
  for (const [k, v] of Object.entries(s)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
  }
  $('#dryBadge').classList.toggle('hidden', !s.dryRun);
  if (!$('#testTo').value) $('#testTo').value = store.get('testTo', '');
}
$$('[data-preset]').forEach((b) =>
  b.addEventListener('click', () => {
    const p = PRESETS[b.dataset.preset];
    form.elements.host.value = p.host;
    form.elements.port.value = p.port;
    form.elements.secure.checked = p.secure;
  })
);
const settingsBody = () => {
  const o = {};
  for (const el of form.elements) if (el.name) o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  return o;
};
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/settings', { method: 'POST', body: settingsBody() }); toast('Réglages enregistrés.', 'ok'); loadSettings(); }
  catch (err) { toast(err.message, 'error'); }
});
$('#testSmtp').addEventListener('click', async () => {
  try {
    await api('/api/settings', { method: 'POST', body: settingsBody() });
    const r = await api('/api/settings/test', { method: 'POST' });
    toast(r.message, 'ok');
  } catch (err) { toast('Échec : ' + err.message, 'error'); }
});

// ---------- Sauvegarde (export / import) ----------
$('#importBackup').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const r = await api('/api/import', { method: 'POST', body: JSON.parse(await file.text()) });
    await Promise.all([loadIdentities(), loadTemplates()]);
    toast(`Importé : ${r.templates} modèle(s) et ${r.identities} identité(s).`, 'ok');
  } catch (err) { toast('Import impossible : ' + err.message, 'error'); }
});

// ---------- Compte de connexion ----------
api('/api/me').then((me) => {
  if (!me.login) return;
  $('#logout').classList.remove('hidden');
  $('#accountCard').classList.remove('hidden');
  $('#accountForm').user.value = me.user;
}).catch(() => {});
$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.replace('/login.html');
});
$('#accountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/account', { method: 'POST', body: { current: f.current.value, user: f.user.value, pass: f.pass.value } });
    f.current.value = f.pass.value = '';
    toast('Identifiants modifiés.', 'ok');
  } catch (err) { toast(err.message, 'error'); }
});

// ---------- Démarrage ----------
renderRecipients();
syncAttachments();
loadIdentities();
loadTemplates();
loadSettings();
