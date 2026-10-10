// CV Sender : serveur local d'envoi de candidatures par e-mail (SMTP).
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
// En ligne (Render, Docker…), on écoute sur toutes les interfaces ; en local, seulement sur la machine.
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const DRY_RUN = (process.env.DRY_RUN || '').trim() === '1';

// STORAGE_DIR permet de pointer vers un disque persistant une fois déployé.
const STORAGE_DIR = process.env.STORAGE_DIR || __dirname;
const DATA_DIR = path.join(STORAGE_DIR, 'data');
const IMG_DIR = path.join(STORAGE_DIR, 'uploads', 'images');
const CV_DIR = path.join(STORAGE_DIR, 'uploads', 'cv');
const OUTBOX_DIR = path.join(DATA_DIR, 'outbox');
for (const d of [DATA_DIR, IMG_DIR, CV_DIR, OUTBOX_DIR]) fs.mkdirSync(d, { recursive: true });

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const IDENTITIES_FILE = path.join(DATA_DIR, 'identities.json');

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));

// Valeurs par défaut, surchargées par les variables d'environnement (utile en ligne,
// où le disque peut être effacé à chaque redémarrage) puis par l'onglet « Réglages ».
const env = process.env;
const DEFAULT_SETTINGS = {
  host: env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(env.SMTP_PORT) || 465,
  secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : true,
  user: env.SMTP_USER || '',
  pass: env.SMTP_PASS || '',
  fromName: env.FROM_NAME || '',
  fromEmail: env.FROM_EMAIL || '',
  replyTo: env.REPLY_TO || '',
  delaySeconds: env.DELAY_SECONDS ? Number(env.DELAY_SECONDS) : 8,
};
const getSettings = () => ({ ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) });

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !APP_PASSWORD) {
  console.error("Refus de démarrer : l'application est accessible depuis Internet sans mot de passe.\n" +
    "Définissez la variable d'environnement APP_PASSWORD.");
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.get('/healthz', (req, res) => res.send('ok'));

// Protection par mot de passe (identifiant libre) dès que APP_PASSWORD est défini.
if (APP_PASSWORD) {
  const expected = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const pass = Buffer.from(encoded, 'base64').toString('utf8').split(':').slice(1).join(':');
      const given = crypto.createHash('sha256').update(pass).digest();
      if (crypto.timingSafeEqual(given, expected)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="CV Sender", charset="UTF-8"').status(401).send('Mot de passe requis.');
  });
}

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(IMG_DIR));

// ---------- Réglages SMTP ----------
app.get('/api/settings', (req, res) => {
  const s = getSettings();
  res.json({ ...s, pass: s.pass ? '********' : '', dryRun: DRY_RUN });
});

app.post('/api/settings', (req, res) => {
  const current = getSettings();
  const b = req.body || {};
  const next = {
    host: String(b.host || '').trim(),
    port: Number(b.port) || 465,
    secure: !!b.secure,
    user: String(b.user || '').trim(),
    // "********" = mot de passe inchangé
    pass: b.pass && b.pass !== '********' ? String(b.pass) : current.pass,
    fromName: String(b.fromName || '').trim(),
    fromEmail: String(b.fromEmail || '').trim(),
    replyTo: String(b.replyTo || '').trim(),
    delaySeconds: Math.max(0, Number(b.delaySeconds) || 0),
  };
  writeJson(SETTINGS_FILE, next);
  res.json({ ok: true });
});

function createTransport(s) {
  if (DRY_RUN) return nodemailer.createTransport({ streamTransport: true, buffer: true });
  return nodemailer.createTransport({
    host: s.host, port: s.port, secure: s.secure,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
  });
}

// ---------- Identités (comme dans Thunderbird) ----------
// Chaque identité a un nom affiché, une adresse, des Répondre à / Cc / Cci par défaut,
// et soit le serveur principal, soit son propre serveur d'envoi.
const readIdentities = () => readJson(IDENTITIES_FILE, []);
const publicIdentity = (i) => ({ ...i, smtp: i.smtp ? { ...i.smtp, pass: i.smtp.pass ? '********' : '' } : null });

app.get('/api/identities', (req, res) => res.json(readIdentities().map(publicIdentity)));

app.post('/api/identities', (req, res) => {
  const b = req.body || {};
  const str = (v) => String(v || '').replace(/[\r\n]+/g, ' ').trim();
  const list = readIdentities();
  const existing = list.find((i) => i.id === b.id);
  const identity = {
    id: existing ? existing.id : crypto.randomBytes(6).toString('hex'),
    name: str(b.name),
    email: str(b.email),
    replyTo: str(b.replyTo),
    cc: str(b.cc),
    bcc: str(b.bcc),
    smtp: null,
  };
  if (!EMAIL_RE.test(identity.email)) return res.status(400).json({ message: `Adresse invalide : « ${identity.email} ». Elle doit être de la forme nom@domaine.fr` });
  if (b.smtp && b.smtp.host) {
    const old = existing && existing.smtp ? existing.smtp : {};
    identity.smtp = {
      host: str(b.smtp.host),
      port: Number(b.smtp.port) || 465,
      secure: !!b.smtp.secure,
      user: str(b.smtp.user),
      pass: b.smtp.pass && b.smtp.pass !== '********' ? String(b.smtp.pass) : old.pass || '',
    };
  }
  const next = existing ? list.map((i) => (i.id === identity.id ? identity : i)) : [...list, identity];
  writeJson(IDENTITIES_FILE, next);
  res.json(next.map(publicIdentity));
});

app.delete('/api/identities/:id', (req, res) => {
  const next = readIdentities().filter((i) => i.id !== req.params.id);
  writeJson(IDENTITIES_FILE, next);
  res.json(next.map(publicIdentity));
});

app.post('/api/identities/:id/test', async (req, res) => {
  const identity = readIdentities().find((i) => i.id === req.params.id);
  if (!identity) return res.status(404).json({ message: 'Identité introuvable.' });
  try {
    if (DRY_RUN) return res.json({ ok: true, message: 'Mode simulation : aucune connexion SMTP réelle.' });
    await createTransport(identity.smtp || getSettings()).verify();
    res.json({ ok: true, message: 'Connexion réussie pour ' + identity.email + '.' });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

app.post('/api/settings/test', async (req, res) => {
  try {
    if (DRY_RUN) return res.json({ ok: true, message: 'Mode simulation : aucune connexion SMTP réelle.' });
    await createTransport(getSettings()).verify();
    res.json({ ok: true, message: 'Connexion SMTP réussie.' });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// ---------- Images de l'éditeur ----------
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: IMG_DIR,
    filename: (req, file, cb) =>
      cb(null, crypto.randomBytes(8).toString('hex') + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

app.post('/api/images', imageUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Image invalide (max 5 Mo).' });
  res.json({ url: '/images/' + req.file.filename });
});

// ---------- CV / pièces jointes ----------
const cvUpload = multer({
  storage: multer.diskStorage({
    destination: CV_DIR,
    filename: (req, file, cb) => {
      const name = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[\\/:*?"<>|]/g, '_');
      cb(null, Date.now() + '__' + name);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const listCvs = () =>
  fs.readdirSync(CV_DIR).map((id) => ({
    id,
    name: id.replace(/^\d+__/, ''),
    size: fs.statSync(path.join(CV_DIR, id)).size,
  }));

app.get('/api/cv', (req, res) => res.json(listCvs()));
app.post('/api/cv', cvUpload.array('files', 10), (req, res) => res.json(listCvs()));
app.delete('/api/cv/:id', (req, res) => {
  const file = path.join(CV_DIR, path.basename(req.params.id));
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json(listCvs());
});

// ---------- Modèles de mail ----------
app.get('/api/templates', (req, res) => res.json(readJson(TEMPLATES_FILE, [])));
app.post('/api/templates', (req, res) => {
  const { name, html } = req.body || {};
  if (!name) return res.status(400).json({ message: 'Nom du modèle requis.' });
  const list = readJson(TEMPLATES_FILE, []).filter((t) => t.name !== name);
  const fields = Object.fromEntries(['subject', 'identitySelect', 'fromName', 'fromEmail', 'replyTo', 'cc', 'bcc'].map((k) => [k, String(req.body[k] || '')]));
  list.push({ name, ...fields, html: html || '', updatedAt: new Date().toISOString() });
  writeJson(TEMPLATES_FILE, list);
  res.json(list);
});
app.delete('/api/templates/:name', (req, res) => {
  const list = readJson(TEMPLATES_FILE, []).filter((t) => t.name !== req.params.name);
  writeJson(TEMPLATES_FILE, list);
  res.json(list);
});

// ---------- Historique ----------
app.get('/api/history', (req, res) => res.json(readJson(HISTORY_FILE, []).slice(-1000).reverse()));
app.delete('/api/history', (req, res) => { writeJson(HISTORY_FILE, []); res.json([]); });

// ---------- Construction du message ----------
const escapeHtml = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Remplace {{variable}} par la valeur du destinataire (insensible à la casse).
function fillVars(text, vars, html) {
  const lower = {};
  for (const [k, v] of Object.entries(vars || {})) lower[k.trim().toLowerCase()] = v ?? '';
  return text.replace(/\{\{\s*([\w\-À-ÿ]+)\s*\}\}/g, (_, key) => {
    const v = lower[key.toLowerCase()] ?? '';
    return html ? escapeHtml(v) : String(v);
  });
}

// Convertit les images locales et base64 en pièces jointes inline (cid),
// sinon elles ne s'afficheraient pas chez le destinataire.
function inlineImages(html) {
  const attachments = [];
  const seen = new Map();
  let out = html.replace(/(<img\b[^>]*?\bsrc=)(["'])([^"']+)\2/gi, (m, pre, q, src) => {
    if (seen.has(src)) return `${pre}${q}cid:${seen.get(src)}${q}`;
    const cid = crypto.randomBytes(6).toString('hex') + '@cv-sender';
    const local = src.match(/^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)?\/images\/([\w.\-]+)$/);
    const data = src.match(/^data:(image\/[\w+.\-]+);base64,(.+)$/);
    if (local) {
      const file = path.join(IMG_DIR, path.basename(local[1]));
      if (!fs.existsSync(file)) return m;
      attachments.push({ filename: local[1], path: file, cid });
    } else if (data) {
      const ext = data[1].split('/')[1].replace('jpeg', 'jpg').replace(/\+.*/, '');
      attachments.push({ filename: `image.${ext}`, content: Buffer.from(data[2], 'base64'), contentType: data[1], cid });
    } else {
      return m; // URL externe : laissée telle quelle
    }
    seen.set(src, cid);
    return `${pre}${q}cid:${cid}${q}`;
  });
  return { html: out, attachments };
}

function htmlToText(html) {
  return html
    .replace(/<(br|\/p|\/div|\/h\d|\/li)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildMessage(s, { subject, html, vars, to, cvIds, cc, bcc }) {
  const filled = fillVars(html, vars, true);
  const wrapped = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${filled}</body></html>`;
  const { html: finalHtml, attachments } = inlineImages(wrapped);
  for (const id of cvIds || []) {
    const file = path.join(CV_DIR, path.basename(id));
    if (fs.existsSync(file)) attachments.push({ filename: id.replace(/^\d+__/, ''), path: file });
  }
  const from = s.fromName ? { name: s.fromName, address: s.fromEmail || s.user } : s.fromEmail || s.user;
  return {
    from, to,
    replyTo: s.replyTo || undefined,
    cc: cc && cc.length ? cc : undefined,
    bcc: bcc && bcc.length ? bcc : undefined,
    subject: fillVars(subject, vars, false),
    html: finalHtml,
    text: htmlToText(filled),
    attachments,
  };
}

// ---------- Envoi (tâche en arrière-plan + suivi) ----------
const jobs = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.post('/api/send', (req, res) => {
  const settings = getSettings();
  const { subject, html, recipients, cvIds, testTo } = req.body || {};
  if (!subject || !html) return res.status(400).json({ message: 'Objet et contenu requis.' });

  // En-têtes propres à ce mail ; vides = valeurs des Réglages.
  const clean = (v) => String(v || '').replace(/[\r\n]+/g, ' ').trim();
  const splitList = (v) => clean(v).split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  const identity = req.body.identityId ? readIdentities().find((i) => i.id === req.body.identityId) : null;
  if (req.body.identityId && !identity) return res.status(400).json({ message: 'Identité introuvable. Rechargez la page.' });
  const fromName = identity ? identity.name : clean(req.body.fromName);
  const fromEmail = identity ? identity.email : clean(req.body.fromEmail);
  const replyTo = clean(req.body.replyTo);
  const cc = testTo ? [] : splitList(req.body.cc);
  const bcc = testTo ? [] : splitList(req.body.bcc);
  for (const [label, value] of [['De', fromEmail], ['Répondre à', replyTo], ...cc.map((v) => ['Cc', v]), ...bcc.map((v) => ['Cci', v])]) {
    if (value && !EMAIL_RE.test(value)) return res.status(400).json({ message: `Adresse « ${label} » invalide : ${value}` });
  }
  const s = {
    ...settings,
    // Serveur propre à l'identité, sinon le serveur principal.
    ...(identity && identity.smtp ? identity.smtp : {}),
    fromName: fromName || settings.fromName,
    fromEmail: fromEmail || settings.fromEmail,
    replyTo: replyTo || settings.replyTo,
  };
  if (!DRY_RUN && (!s.host || !(s.fromEmail || s.user)))
    return res.status(400).json({ message: 'Configurez d\'abord le SMTP dans « Réglages ».' });

  let list = Array.isArray(recipients) ? recipients : [];
  // Envoi de test : un seul message, à soi-même, avec les variables du 1er destinataire.
  if (testTo) list = [{ ...(list[0] || {}), email: testTo, __test: true }];

  const uniq = new Map();
  for (const r of list) {
    const email = String(r.email || '').trim().toLowerCase();
    if (EMAIL_RE.test(email) && !uniq.has(email)) uniq.set(email, { ...r, email });
  }
  if (!uniq.size) return res.status(400).json({ message: 'Aucune adresse e-mail valide.' });

  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id, total: uniq.size, sent: 0, failed: 0, done: false, cancelled: false,
    results: [], startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  res.json({ jobId: id, total: job.total });

  (async () => {
    const transport = createTransport(s);
    let i = 0;
    for (const r of uniq.values()) {
      if (job.cancelled) break;
      if (i++ > 0 && s.delaySeconds && !testTo) await sleep(s.delaySeconds * 1000);
      if (job.cancelled) break;
      const entry = { email: r.email, entreprise: r.entreprise || r.company || '', at: new Date().toISOString() };
      try {
        const info = await transport.sendMail(buildMessage(s, { subject, html, vars: r, to: r.email, cvIds, cc, bcc }));
        if (DRY_RUN) {
          // Simulation : le mail est enregistré en .eml (ouvrable dans Thunderbird/Outlook) au lieu d'être envoyé.
          const file = path.join(OUTBOX_DIR, `${Date.now()}_${r.email.replace(/[^\w.@-]/g, '_')}.eml`);
          fs.writeFileSync(file, info.message);
          console.log(`[simulation] ${r.email} -> ${path.relative(__dirname, file)}`);
        }
        entry.status = 'envoyé';
        entry.messageId = info.messageId;
        job.sent++;
      } catch (e) {
        entry.status = 'échec';
        entry.error = e.message;
        job.failed++;
      }
      job.results.push(entry);
      if (!r.__test) {
        const history = readJson(HISTORY_FILE, []);
        history.push({ ...entry, subject: fillVars(subject, r, false), dryRun: DRY_RUN || undefined });
        writeJson(HISTORY_FILE, history);
      }
    }
    job.done = true;
  })();
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ message: 'Tâche introuvable.' });
  res.json(job);
});
app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (job) job.cancelled = true;
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  res.status(400).json({ message: err.message || 'Erreur' });
});

app.listen(PORT, HOST, () => {
  console.log(`CV Sender démarré : http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${DRY_RUN ? '  (mode simulation, aucun mail réel)' : ''}`);
});
