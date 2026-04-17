require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const port = Number(process.env.PORT) || 5000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// pg Pool emits 'error' on idle clients; without a listener Node exits the process.
pool.on('error', (err) => {
  console.warn('[pg] pool error (ignored):', err.code || err.message);
});

const ALLOWED_DEVICES = ['Windows', 'Mac', 'iPhone', 'Android', 'Other'];

const step2Template = fs.readFileSync(path.join(__dirname, 'views', 'step2.html'), 'utf8');
const adminLoginTemplate = fs.readFileSync(path.join(__dirname, 'views', 'admin-login.html'), 'utf8');
const adminDashTemplate = fs.readFileSync(path.join(__dirname, 'views', 'admin-dashboard.html'), 'utf8');
const testerLoginTemplate = fs.readFileSync(path.join(__dirname, 'views', 'tester-login.html'), 'utf8');
const portalDashTemplate = fs.readFileSync(path.join(__dirname, 'views', 'portal-dashboard.html'), 'utf8');
const portalTaskTemplate = fs.readFileSync(path.join(__dirname, 'views', 'portal-task.html'), 'utf8');
const portalGetPaidTemplate = fs.readFileSync(path.join(__dirname, 'views', 'portal-getpaid.html'), 'utf8');
const adminTasksTemplate = fs.readFileSync(path.join(__dirname, 'views', 'admin-tasks.html'), 'utf8');
const adminTaskDetailTemplate = fs.readFileSync(path.join(__dirname, 'views', 'admin-task-detail.html'), 'utf8');
const adminReviewsTemplate = fs.readFileSync(path.join(__dirname, 'views', 'admin-reviews.html'), 'utf8');

const adminSessions = new Set();
const testerSessions = new Map();

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  }
});

function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.add(token);
  return token;
}

function createTesterSession(testerId) {
  const token = crypto.randomBytes(32).toString('hex');
  testerSessions.set(token, testerId);
  return token;
}

function isAdminEnabled() {
  const pw = process.env.ADMIN_PASSWORD;
  return typeof pw === 'string' && pw.trim().length > 0;
}

function isAdminAuthenticated(req) {
  if (!isAdminEnabled()) return false;
  const cookies = parseCookies(req);
  return cookies['admin_token'] && adminSessions.has(cookies['admin_token']);
}

function getTesterFromSession(req) {
  const cookies = parseCookies(req);
  const token = cookies['tester_token'];
  if (!token) return null;
  return testerSessions.get(token) || null;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const result = {};
  header.split(';').forEach(pair => {
    const [key, ...rest] = pair.split('=');
    if (key) result[key.trim()] = decodeURIComponent(rest.join('=').trim());
  });
  return result;
}

let databaseReady = false;

function respondDbUnavailable(res) {
  res.status(503).type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Database unavailable</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8f9fa">
  <div style="text-align:center;max-width:420px;padding:2rem">
    <h2 style="color:#64748b">Database unavailable</h2>
    <p style="color:#475569">This action needs PostgreSQL. Set <code>DATABASE_URL</code> and ensure the server is running, then restart the app.</p>
    <a href="/" style="color:#4f46e5">Back to home</a>
  </div>
</body></html>`);
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS testers (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      birth_year INTEGER NOT NULL,
      devices JSONB NOT NULL DEFAULT '[]',
      other_device_details VARCHAR(255),
      testing_experience VARCHAR(50),
      device_models VARCHAR(255),
      occupation VARCHAR(255),
      bug_report_sample TEXT,
      nda_signed BOOLEAN DEFAULT FALSE,
      step2_token VARCHAR(64),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      markdown_content TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS subtasks (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      sort_order INTEGER DEFAULT 0,
      compensation DECIMAL(10,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_assignments (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      tester_id INTEGER NOT NULL REFERENCES testers(id) ON DELETE CASCADE,
      assigned_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(task_id, tester_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      subtask_id INTEGER NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
      tester_id INTEGER NOT NULL REFERENCES testers(id) ON DELETE CASCADE,
      workflow_text TEXT,
      screenshot_path VARCHAR(500),
      status VARCHAR(20) DEFAULT 'submitted',
      admin_notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(subtask_id, tester_id)
    )
  `);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function parseMarkdownToSubtasks(markdown) {
  const lines = markdown.split('\n');
  const subtasks = [];
  let current = null;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)(?:\s*\[\$(\d+(?:\.\d{1,2})?)\])?\s*$/);
    if (headingMatch) {
      if (current) subtasks.push(current);
      current = {
        title: headingMatch[1].trim(),
        description: '',
        compensation: parseFloat(headingMatch[2] || '0')
      };
    } else if (current) {
      current.description += line + '\n';
    }
  }
  if (current) subtasks.push(current);

  subtasks.forEach(s => { s.description = s.description.trim(); });
  return subtasks;
}

function simpleMarkdownToHtml(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/`(.+?)`/g, '<code>$1</code>');
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  return '<p>' + html + '</p>';
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(uploadsDir));

const SITE_URL = (process.env.SITE_URL || 'https://sousadev.com').replace(/\/+$/, '');

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Allow: /',
      'Allow: /join',
      'Disallow: /complete-profile',
      'Disallow: /success',
      'Disallow: /login',
      'Disallow: /logout',
      'Disallow: /portal',
      'Disallow: /uploads',
      'Disallow: /admin',
      'Disallow: /admin/',
      'Disallow: /api/',
      '',
      `Sitemap: ${SITE_URL}/sitemap.xml`,
      '',
    ].join('\n')
  );
});

app.get('/sitemap.xml', (req, res) => {
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${SITE_URL}/`,     changefreq: 'weekly',  priority: '1.0' },
    { loc: `${SITE_URL}/join`, changefreq: 'monthly', priority: '0.8' },
  ];
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(
        (u) =>
          `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
      )
      .join('\n') +
    `\n</urlset>\n`;
  res.type('application/xml').send(body);
});

app.get('/join', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'step1.html'));
});

app.post('/api/step1', async (req, res) => {
  if (!databaseReady) return respondDbUnavailable(res);
  try {
    const { email, birth_year, devices, other_device_details } = req.body;

    if (!email || !birth_year) {
      return res.status(400).send('Email and year of birth are required.');
    }

    const year = parseInt(birth_year);
    if (isNaN(year) || year < 1920 || year > 2010) {
      return res.status(400).send('Please enter a valid year of birth.');
    }

    const rawDevices = Array.isArray(devices) ? devices : devices ? [devices] : [];
    const deviceArray = rawDevices.filter(d => ALLOWED_DEVICES.includes(d));
    if (deviceArray.length === 0) {
      return res.status(400).send('Please select at least one device.');
    }

    const token = uuidv4();
    const result = await pool.query(
      `INSERT INTO testers (email, birth_year, devices, other_device_details, step2_token)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [email.trim().toLowerCase(), year, JSON.stringify(deviceArray), other_device_details || null, token]
    );
    res.redirect(`/complete-profile?token=${token}`);
  } catch (err) {
    if (err.code === '23505') {
      res.status(400).send(`
        <html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8f9fa">
          <div style="text-align:center;max-width:400px;padding:2rem">
            <h2 style="color:#dc3545">Email Already Registered</h2>
            <p>This email address has already been used to sign up.</p>
            <a href="/join" style="color:#4f46e5">Go back</a>
          </div>
        </body></html>
      `);
      return;
    }
    console.error('Step 1 error:', err);
    res.status(500).send('Something went wrong. Please try again.');
  }
});

app.get('/complete-profile', async (req, res) => {
  if (!databaseReady) return respondDbUnavailable(res);
  const { token } = req.query;
  if (!token) return res.redirect('/join');

  try {
    const result = await pool.query('SELECT * FROM testers WHERE step2_token = $1', [token]);
    if (result.rows.length === 0) return res.redirect('/join');

    const tester = result.rows[0];
    const devices = typeof tester.devices === 'string' ? JSON.parse(tester.devices) : tester.devices;

    const safeData = JSON.stringify({
      devices: devices,
      otherDetails: tester.other_device_details || ''
    });

    let html = step2Template;
    html = html.replace('{{TOKEN}}', escapeHtml(token));
    html = html.replace('{{EMAIL}}', escapeHtml(tester.email));
    html = html.replace('{{BIRTH_YEAR}}', escapeHtml(String(tester.birth_year)));
    html = html.replace('{{SAFE_DATA_JSON}}', safeData.replace(/</g, '\\u003c'));

    res.send(html);
  } catch (err) {
    console.error('Fetch profile error:', err);
    res.status(500).send('Something went wrong. Please try again.');
  }
});

app.post('/api/step2', async (req, res) => {
  if (!databaseReady) return respondDbUnavailable(res);
  try {
    const { token, testing_experience, device_models, occupation, bug_report_sample, nda_signed } = req.body;

    const validExperience = ['Beginner', 'Hobbyist', 'Professional'];
    const validNda = ['yes', 'no'];

    if (!token || !testing_experience || !validExperience.includes(testing_experience)) {
      return res.status(400).send('Please select a valid testing experience level.');
    }

    if (!nda_signed || !validNda.includes(nda_signed)) {
      return res.status(400).send('Please answer the NDA question.');
    }

    const result = await pool.query(
      `UPDATE testers SET
        testing_experience = $1,
        device_models = $2,
        occupation = $3,
        bug_report_sample = $4,
        nda_signed = $5,
        step2_token = NULL,
        updated_at = NOW()
       WHERE step2_token = $6`,
      [testing_experience, device_models || null, occupation || null, bug_report_sample || null, nda_signed === 'yes', token]
    );

    if (result.rowCount === 0) {
      return res.status(404).send('Invalid or expired link. Please sign up again.');
    }

    res.redirect('/success');
  } catch (err) {
    console.error('Step 2 error:', err);
    res.status(500).send('Something went wrong. Please try again.');
  }
});

app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'success.html'));
});

// ── Tester Login ──
app.get('/login', (req, res) => {
  const testerId = getTesterFromSession(req);
  if (testerId) return res.redirect('/portal');
  let html = testerLoginTemplate;
  html = html.replace('{{ERROR_CLASS}}', '');
  html = html.replace('{{ERROR_MSG}}', '');
  res.send(html);
});

app.post('/login', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    let html = testerLoginTemplate;
    html = html.replace('{{ERROR_CLASS}}', 'visible');
    html = html.replace('{{ERROR_MSG}}', 'Please enter your email address.');
    return res.send(html);
  }

  try {
    const result = await pool.query(
      'SELECT id FROM testers WHERE email = $1 AND step2_token IS NULL AND testing_experience IS NOT NULL',
      [email.trim().toLowerCase()]
    );

    if (result.rows.length === 0) {
      let html = testerLoginTemplate;
      html = html.replace('{{ERROR_CLASS}}', 'visible');
      html = html.replace('{{ERROR_MSG}}', 'No completed account found with this email. Please sign up first.');
      return res.send(html);
    }

    const testerId = result.rows[0].id;
    const sessionToken = createTesterSession(testerId);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `tester_token=${sessionToken}; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800${secure}`);
    res.redirect('/portal');
  } catch (err) {
    console.error('Tester login error:', err);
    res.status(500).send('Something went wrong. Please try again.');
  }
});

app.get('/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies['tester_token']) {
    testerSessions.delete(cookies['tester_token']);
  }
  res.setHeader('Set-Cookie', 'tester_token=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
  res.redirect('/');
});

// ── Tester Portal ──
app.get('/portal', async (req, res) => {
  const testerId = getTesterFromSession(req);
  if (!testerId) return res.redirect('/login');

  try {
    const [testerRes, tasksRes, earningsRes] = await Promise.all([
      pool.query('SELECT email FROM testers WHERE id = $1', [testerId]),
      pool.query(`
        SELECT t.id, t.title, t.description, t.status,
               COUNT(st.id)::int AS total_subtasks,
               COUNT(sub.id) FILTER (WHERE sub.status = 'accepted')::int AS accepted_count,
               COUNT(sub.id) FILTER (WHERE sub.status IN ('submitted','in_review'))::int AS pending_count,
               COUNT(sub.id) FILTER (WHERE sub.status = 'rejected')::int AS rejected_count
        FROM task_assignments ta
        JOIN tasks t ON t.id = ta.task_id
        LEFT JOIN subtasks st ON st.task_id = t.id
        LEFT JOIN submissions sub ON sub.subtask_id = st.id AND sub.tester_id = $1
        WHERE ta.tester_id = $1
        GROUP BY t.id
        ORDER BY t.created_at DESC
      `, [testerId]),
      pool.query(`
        SELECT
          COALESCE(SUM(st.compensation) FILTER (WHERE sub.status = 'accepted'), 0) AS confirmed,
          COALESCE(SUM(st.compensation) FILTER (WHERE sub.status IN ('submitted','in_review')), 0) AS on_hold
        FROM submissions sub
        JOIN subtasks st ON st.id = sub.subtask_id
        WHERE sub.tester_id = $1
      `, [testerId])
    ]);

    const tester = testerRes.rows[0];
    if (!tester) return res.redirect('/login');

    const earnings = earningsRes.rows[0];
    const confirmed = parseFloat(earnings.confirmed || 0).toFixed(2);
    const onHold = parseFloat(earnings.on_hold || 0).toFixed(2);
    const totalEarnings = (parseFloat(confirmed) + parseFloat(onHold)).toFixed(2);

    const taskCards = tasksRes.rows.map(t => {
      const progress = t.total_subtasks > 0
        ? Math.round((t.accepted_count / t.total_subtasks) * 100)
        : 0;
      const submitted = t.pending_count + t.accepted_count + t.rejected_count;
      return `
        <a href="/portal/task/${t.id}" class="portal-task-card">
          <div class="portal-task-card-header">
            <h3>${escapeHtml(t.title)}</h3>
            <span class="portal-task-status portal-task-status--${t.status}">${t.status}</span>
          </div>
          <p class="portal-task-desc">${escapeHtml(t.description || '')}</p>
          <div class="portal-task-progress">
            <div class="portal-task-progress-bar">
              <div class="portal-task-progress-fill" style="width:${progress}%"></div>
            </div>
            <span class="portal-task-progress-text">${t.accepted_count}/${t.total_subtasks} completed</span>
          </div>
          <div class="portal-task-stats">
            <span class="portal-stat portal-stat--pending">${t.pending_count} in review</span>
            <span class="portal-stat portal-stat--done">${t.accepted_count} accepted</span>
            ${t.rejected_count > 0 ? `<span class="portal-stat portal-stat--rejected">${t.rejected_count} rejected</span>` : ''}
          </div>
        </a>`;
    }).join('');

    let html = portalDashTemplate;
    html = html.replace(/\{\{EMAIL\}\}/g, escapeHtml(tester.email));
    html = html.replace('{{CONFIRMED_EARNINGS}}', confirmed);
    html = html.replace('{{ON_HOLD_EARNINGS}}', onHold);
    html = html.replace('{{TOTAL_EARNINGS}}', totalEarnings);
    html = html.replace('{{TASK_CARDS}}', taskCards || '<div class="portal-empty">No tasks assigned to you yet.</div>');
    html = html.replace('{{TASK_COUNT}}', tasksRes.rows.length);

    res.send(html);
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).send('Failed to load portal.');
  }
});

app.get('/portal/task/:id', async (req, res) => {
  const testerId = getTesterFromSession(req);
  if (!testerId) return res.redirect('/login');

  const taskId = parseInt(req.params.id);
  if (isNaN(taskId)) return res.status(400).send('Invalid task.');

  try {
    const assignCheck = await pool.query(
      'SELECT 1 FROM task_assignments WHERE task_id = $1 AND tester_id = $2',
      [taskId, testerId]
    );
    if (assignCheck.rows.length === 0) return res.redirect('/portal');

    const [taskRes, subtasksRes] = await Promise.all([
      pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]),
      pool.query(`
        SELECT st.*, sub.id AS submission_id, sub.workflow_text, sub.screenshot_path,
               sub.status AS submission_status, sub.admin_notes, sub.updated_at AS submission_updated
        FROM subtasks st
        LEFT JOIN submissions sub ON sub.subtask_id = st.id AND sub.tester_id = $1
        WHERE st.task_id = $2
        ORDER BY st.sort_order
      `, [testerId, taskId])
    ]);

    if (taskRes.rows.length === 0) return res.redirect('/portal');
    const task = taskRes.rows[0];

    const totalComp = subtasksRes.rows.reduce((sum, s) => sum + parseFloat(s.compensation || 0), 0);

    const subtasksHtml = subtasksRes.rows.map((st, idx) => {
      const hasSubmission = !!st.submission_id;
      const status = st.submission_status || 'not_started';
      const statusLabel = {
        'not_started': 'Not Started',
        'submitted': 'Submitted',
        'in_review': 'In Review',
        'accepted': 'Accepted',
        'rejected': 'Rejected'
      }[status] || status;
      const statusClass = status.replace('_', '-');

      let submissionContent = '';
      if (hasSubmission) {
        submissionContent = `
          <div class="sub-submission">
            <div class="sub-submission-header">
              <span class="sub-status sub-status--${statusClass}">${statusLabel}</span>
              ${status === 'accepted' ? `<span class="sub-earned">+$${parseFloat(st.compensation).toFixed(2)}</span>` : ''}
            </div>
            ${st.workflow_text ? `<div class="sub-workflow"><strong>Your workflow:</strong><p>${escapeHtml(st.workflow_text)}</p></div>` : ''}
            ${st.screenshot_path ? `<div class="sub-screenshot"><strong>Screenshot:</strong><br><a href="/uploads/${escapeHtml(st.screenshot_path)}" target="_blank"><img src="/uploads/${escapeHtml(st.screenshot_path)}" alt="Screenshot"></a></div>` : ''}
            ${st.admin_notes ? `<div class="sub-notes"><strong>Admin notes:</strong><p>${escapeHtml(st.admin_notes)}</p></div>` : ''}
            ${status === 'rejected' ? `
              <form action="/portal/task/${task.id}/submit/${st.id}" method="POST" enctype="multipart/form-data" class="sub-form">
                <div class="sub-form-group">
                  <label>Update your workflow description</label>
                  <textarea name="workflow_text" rows="4" placeholder="Describe the steps you took...">${escapeHtml(st.workflow_text || '')}</textarea>
                </div>
                <div class="sub-form-group">
                  <label>Update screenshot</label>
                  <input type="file" name="screenshot" accept="image/*">
                </div>
                <button type="submit" class="btn-submit-subtask">Resubmit</button>
              </form>
            ` : ''}
            ${(status === 'submitted' || status === 'in_review') ? `
              <form action="/portal/task/${task.id}/remove/${st.id}" method="POST" class="sub-remove-form">
                <button type="submit" class="btn-remove-submission" onclick="return confirm('Remove this submission?')">Remove Submission</button>
              </form>
            ` : ''}
          </div>`;
      } else {
        submissionContent = `
          <form action="/portal/task/${task.id}/submit/${st.id}" method="POST" enctype="multipart/form-data" class="sub-form">
            <div class="sub-form-group">
              <label>Describe your testing workflow</label>
              <textarea name="workflow_text" rows="4" required placeholder="Describe the steps you took to test this section..."></textarea>
            </div>
            <div class="sub-form-group">
              <label>Upload a screenshot <span class="optional">(optional)</span></label>
              <input type="file" name="screenshot" accept="image/*">
            </div>
            <button type="submit" class="btn-submit-subtask">Submit</button>
          </form>`;
      }

      return `
        <div class="subtask-card" id="subtask-${st.id}">
          <div class="subtask-header">
            <div class="subtask-number">${idx + 1}</div>
            <div class="subtask-info">
              <h3>${escapeHtml(st.title)}</h3>
              <span class="subtask-comp">$${parseFloat(st.compensation).toFixed(2)}</span>
            </div>
          </div>
          ${st.description ? `<div class="subtask-desc">${simpleMarkdownToHtml(st.description)}</div>` : ''}
          ${submissionContent}
        </div>`;
    }).join('');

    let html = portalTaskTemplate;
    html = html.replace(/\{\{TASK_ID\}\}/g, task.id);
    html = html.replace(/\{\{TASK_TITLE\}\}/g, escapeHtml(task.title));
    html = html.replace(/\{\{TASK_DESC\}\}/g, escapeHtml(task.description || ''));
    html = html.replace(/\{\{TOTAL_COMP\}\}/g, totalComp.toFixed(2));
    html = html.replace(/\{\{SUBTASK_COUNT\}\}/g, subtasksRes.rows.length);
    html = html.replace('{{SUBTASKS_HTML}}', subtasksHtml);

    res.send(html);
  } catch (err) {
    console.error('Task detail error:', err);
    res.status(500).send('Failed to load task.');
  }
});

app.post('/portal/task/:taskId/submit/:subtaskId', upload.single('screenshot'), async (req, res) => {
  const testerId = getTesterFromSession(req);
  if (!testerId) return res.redirect('/login');

  const taskId = parseInt(req.params.taskId);
  const subtaskId = parseInt(req.params.subtaskId);
  if (isNaN(taskId) || isNaN(subtaskId)) return res.status(400).send('Invalid IDs.');

  try {
    const assignCheck = await pool.query(
      'SELECT 1 FROM task_assignments WHERE task_id = $1 AND tester_id = $2',
      [taskId, testerId]
    );
    if (assignCheck.rows.length === 0) return res.redirect('/portal');

    const stCheck = await pool.query('SELECT 1 FROM subtasks WHERE id = $1 AND task_id = $2', [subtaskId, taskId]);
    if (stCheck.rows.length === 0) return res.status(404).send('Subtask not found.');

    const { workflow_text } = req.body;
    const screenshotPath = req.file ? req.file.filename : null;

    const existing = await pool.query(
      'SELECT id, screenshot_path, status FROM submissions WHERE subtask_id = $1 AND tester_id = $2',
      [subtaskId, testerId]
    );

    if (existing.rows.length > 0) {
      const old = existing.rows[0];
      if (old.status === 'accepted') {
        return res.status(400).send('This submission has already been accepted and cannot be changed.');
      }
      if (old.status === 'in_review') {
        return res.status(400).send('This submission is currently in review and cannot be changed.');
      }
      const updateScreenshot = screenshotPath || old.screenshot_path;
      await pool.query(
        `UPDATE submissions SET workflow_text = $1, screenshot_path = $2, status = 'in_review', admin_notes = NULL, updated_at = NOW()
         WHERE id = $3`,
        [workflow_text || null, updateScreenshot, old.id]
      );
    } else {
      await pool.query(
        `INSERT INTO submissions (subtask_id, tester_id, workflow_text, screenshot_path, status)
         VALUES ($1, $2, $3, $4, 'in_review')`,
        [subtaskId, testerId, workflow_text || null, screenshotPath]
      );
    }

    res.redirect(`/portal/task/${taskId}#subtask-${subtaskId}`);
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).send('Failed to submit.');
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).send('File too large. Maximum size is 10MB.');
    }
    return res.status(400).send('File upload error: ' + err.message);
  }
  if (err && err.message === 'Only image files are allowed.') {
    return res.status(400).send('Only image files (PNG, JPG, GIF, WebP) are allowed.');
  }
  next(err);
});

app.post('/portal/task/:taskId/remove/:subtaskId', async (req, res) => {
  const testerId = getTesterFromSession(req);
  if (!testerId) return res.redirect('/login');

  const taskId = parseInt(req.params.taskId);
  const subtaskId = parseInt(req.params.subtaskId);

  try {
    await pool.query(
      `DELETE FROM submissions WHERE subtask_id = $1 AND tester_id = $2 AND status IN ('submitted','in_review')`,
      [subtaskId, testerId]
    );
    res.redirect(`/portal/task/${taskId}`);
  } catch (err) {
    console.error('Remove submission error:', err);
    res.status(500).send('Failed to remove submission.');
  }
});

app.get('/portal/get-paid', async (req, res) => {
  const testerId = getTesterFromSession(req);
  if (!testerId) return res.redirect('/login');

  try {
    const [testerRes, earningsRes] = await Promise.all([
      pool.query('SELECT email FROM testers WHERE id = $1', [testerId]),
      pool.query(`
        SELECT
          COALESCE(SUM(st.compensation) FILTER (WHERE sub.status = 'accepted'), 0) AS confirmed,
          COALESCE(SUM(st.compensation) FILTER (WHERE sub.status IN ('submitted','in_review')), 0) AS on_hold
        FROM submissions sub
        JOIN subtasks st ON st.id = sub.subtask_id
        WHERE sub.tester_id = $1
      `, [testerId])
    ]);

    const earnings = earningsRes.rows[0];
    let html = portalGetPaidTemplate;
    html = html.replace(/\{\{EMAIL\}\}/g, escapeHtml(testerRes.rows[0]?.email || ''));
    html = html.replace('{{CONFIRMED_EARNINGS}}', parseFloat(earnings.confirmed || 0).toFixed(2));
    html = html.replace('{{ON_HOLD_EARNINGS}}', parseFloat(earnings.on_hold || 0).toFixed(2));
    res.send(html);
  } catch (err) {
    console.error('Get paid error:', err);
    res.status(500).send('Failed to load page.');
  }
});

// ── Admin Routes ──
app.get('/admin', (req, res) => {
  if (!isAdminEnabled()) {
    return res.status(403).send(`
      <html><body style="font-family:'Poppins',system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#060a10;color:#e2e8f0">
        <div style="text-align:center;max-width:420px;padding:2rem">
          <h2 style="color:#f87171">Admin Disabled</h2>
          <p style="color:#94a3b8">The admin dashboard is not available. The <code>ADMIN_PASSWORD</code> environment variable must be set to enable access.</p>
          <a href="/" style="color:#10B43C">Back to home</a>
        </div>
      </body></html>
    `);
  }
  if (isAdminAuthenticated(req)) {
    return res.redirect('/admin/dashboard');
  }
  let html = adminLoginTemplate;
  html = html.replace('{{ERROR_CLASS}}', '');
  html = html.replace('{{ERROR_MSG}}', '');
  res.send(html);
});

app.post('/admin/login', (req, res) => {
  if (!isAdminEnabled()) return res.redirect('/admin');

  const { password } = req.body;
  if (password && password === process.env.ADMIN_PASSWORD.trim()) {
    const sessionToken = createAdminSession();
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `admin_token=${sessionToken}; HttpOnly; Path=/admin; SameSite=Strict; Max-Age=86400${secure}`);
    return res.redirect('/admin/dashboard');
  }

  let html = adminLoginTemplate;
  html = html.replace('{{ERROR_CLASS}}', 'visible');
  html = html.replace('{{ERROR_MSG}}', 'Incorrect password. Please try again.');
  res.send(html);
});

app.get('/admin/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies['admin_token']) {
    adminSessions.delete(cookies['admin_token']);
  }
  res.setHeader('Set-Cookie', 'admin_token=; HttpOnly; Path=/admin; SameSite=Strict; Max-Age=0');
  res.redirect('/admin');
});

app.get('/admin/dashboard', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/admin');
  if (!databaseReady) return respondDbUnavailable(res);

  try {
    const [totals, deviceStats, expStats, testers] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE step2_token IS NULL AND testing_experience IS NOT NULL)::int AS complete,
          COUNT(*) FILTER (WHERE step2_token IS NOT NULL)::int AS pending,
          COUNT(*) FILTER (WHERE nda_signed = true)::int AS nda_yes
        FROM testers
      `),
      pool.query(`
        SELECT device, COUNT(*)::int AS cnt
        FROM testers, jsonb_array_elements_text(devices) AS device
        GROUP BY device ORDER BY cnt DESC
      `),
      pool.query(`
        SELECT testing_experience AS level, COUNT(*)::int AS cnt
        FROM testers WHERE testing_experience IS NOT NULL
        GROUP BY testing_experience ORDER BY cnt DESC
      `),
      pool.query(`
        SELECT id, email, birth_year, devices, other_device_details,
               testing_experience, device_models, occupation,
               bug_report_sample, nda_signed, step2_token, created_at
        FROM testers ORDER BY created_at DESC
      `)
    ]);

    const s = totals.rows[0];
    const total = s.total || 1;
    const pct = (n) => Math.round((n / total) * 100);
    const completePct = pct(s.complete);
    const pendingPct  = pct(s.pending);
    const ndaPct      = pct(s.nda_yes);

    const deviceMax = deviceStats.rows[0]?.cnt || 1;
    const deviceHtml = deviceStats.rows.map(r => {
      const barPct = Math.round((r.cnt / deviceMax) * 100);
      return `<div class="breakdown-row">
        <span class="breakdown-label">${escapeHtml(r.device)}</span>
        <div class="breakdown-bar-wrap"><div class="breakdown-bar-fill" style="width:${barPct}%"></div></div>
        <span class="breakdown-count">${r.cnt}</span>
      </div>`;
    }).join('') || '<span class="breakdown-empty">No data yet</span>';

    const expMax = expStats.rows[0]?.cnt || 1;
    const expHtml = expStats.rows.map(r => {
      const barPct = Math.round((r.cnt / expMax) * 100);
      return `<div class="breakdown-row">
        <span class="breakdown-label">${escapeHtml(r.level)}</span>
        <div class="breakdown-bar-wrap"><div class="breakdown-bar-fill" style="width:${barPct}%"></div></div>
        <span class="breakdown-count">${r.cnt}</span>
      </div>`;
    }).join('') || '<span class="breakdown-empty">No data yet</span>';

    const rowsHtml = testers.rows.map(t => {
      const devices = (typeof t.devices === 'string' ? JSON.parse(t.devices) : t.devices) || [];
      const isComplete = !t.step2_token && t.testing_experience;
      const statusBadge = isComplete
        ? '<span class="badge badge-complete">Complete</span>'
        : '<span class="badge badge-pending">Pending</span>';
      const ndaBadge = t.nda_signed
        ? '<span class="badge badge-nda-yes">Yes</span>'
        : '<span class="badge-nda-no">No</span>';
      const date = new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      const initial = (t.email || '?')[0].toUpperCase();
      const deviceTags = devices.map(d => `<span class="device-tag">${escapeHtml(d)}</span>`).join('');

      const testerJson = JSON.stringify({
        id: t.id,
        email: t.email,
        birth_year: t.birth_year,
        devices: devices,
        other_device_details: t.other_device_details || '',
        testing_experience: t.testing_experience || '',
        device_models: t.device_models || '',
        occupation: t.occupation || '',
        bug_report_sample: t.bug_report_sample || '',
        nda_signed: t.nda_signed
      }).replace(/"/g, '&quot;');

      return `<tr>
        <td>
          <div class="td-email">
            <div class="email-avatar">${initial}</div>
            <span class="td-email-text">${escapeHtml(t.email)}</span>
          </div>
        </td>
        <td>${t.birth_year}</td>
        <td><div class="device-tags">${deviceTags}</div></td>
        <td>${escapeHtml(t.testing_experience || '-')}</td>
        <td>${escapeHtml(t.occupation || '-')}</td>
        <td>${ndaBadge}</td>
        <td>${statusBadge}</td>
        <td>${date}</td>
        <td>
          <div class="td-actions">
            <button class="btn-action btn-action--edit" title="Edit" onclick="openEditModal(this)" data-tester="${testerJson}">✏️</button>
            <button class="btn-action btn-action--delete" title="Delete" onclick="openDeleteModal(this)" data-id="${t.id}" data-email="${escapeHtml(t.email)}">🗑️</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    let html = adminDashTemplate;
    html = html.replace(/\{\{TOTAL\}\}/g, s.total);
    html = html.replace(/\{\{COMPLETE\}\}/g, s.complete);
    html = html.replace(/\{\{COMPLETE_PCT\}\}/g, completePct);
    html = html.replace(/\{\{PENDING\}\}/g, s.pending);
    html = html.replace(/\{\{PENDING_PCT\}\}/g, pendingPct);
    html = html.replace(/\{\{NDA_YES\}\}/g, s.nda_yes);
    html = html.replace(/\{\{NDA_PCT\}\}/g, ndaPct);
    html = html.replace('{{DEVICE_STATS}}', deviceHtml);
    html = html.replace('{{EXPERIENCE_STATS}}', expHtml);
    html = html.replace('{{TABLE_ROWS}}', rowsHtml);

    res.send(html);
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Failed to load dashboard.');
  }
});

app.get('/admin/export', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/admin');
  if (!databaseReady) return respondDbUnavailable(res);

  try {
    const result = await pool.query(`
      SELECT email, birth_year, devices, other_device_details,
             testing_experience, device_models, occupation,
             bug_report_sample, nda_signed, created_at, updated_at
      FROM testers WHERE step2_token IS NULL AND testing_experience IS NOT NULL
      ORDER BY created_at DESC
    `);

    const headers = ['Email', 'Birth Year', 'Devices', 'Other Device Details',
                     'Experience', 'Device Models', 'Occupation',
                     'Bug Report Sample', 'NDA Willing', 'Signed Up', 'Updated'];

    const csvEscape = (val) => {
      if (val === null || val === undefined) return '';
      let str = String(val);
      if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
      }
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes("'")) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    let csv = headers.join(',') + '\n';
    for (const row of result.rows) {
      const devices = (typeof row.devices === 'string' ? JSON.parse(row.devices) : row.devices) || [];
      csv += [
        csvEscape(row.email),
        row.birth_year,
        csvEscape(devices.join('; ')),
        csvEscape(row.other_device_details),
        csvEscape(row.testing_experience),
        csvEscape(row.device_models),
        csvEscape(row.occupation),
        csvEscape(row.bug_report_sample),
        row.nda_signed ? 'Yes' : 'No',
        new Date(row.created_at).toISOString(),
        new Date(row.updated_at).toISOString()
      ].join(',') + '\n';
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="beta-testers.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).send('Failed to export data.');
  }
});

app.post('/admin/tester/:id/update', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/admin');
  if (!databaseReady) return respondDbUnavailable(res);

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).send('Invalid ID.');

  try {
    const { email, birth_year, devices, other_device_details, testing_experience,
            device_models, occupation, bug_report_sample, nda_signed } = req.body;

    if (!email || !birth_year) return res.status(400).send('Email and birth year are required.');
    const year = parseInt(birth_year);
    if (isNaN(year) || year < 1920 || year > 2010) return res.status(400).send('Invalid birth year.');

    const rawDevices = Array.isArray(devices) ? devices : devices ? [devices] : [];
    const deviceArray = rawDevices.filter(d => ALLOWED_DEVICES.includes(d));

    const ndaBool = nda_signed === 'yes' ? true : nda_signed === 'no' ? false : null;

    const result = await pool.query(
      `UPDATE testers SET
        email = $1,
        birth_year = $2,
        devices = $3,
        other_device_details = $4,
        testing_experience = $5,
        device_models = $6,
        occupation = $7,
        bug_report_sample = $8,
        nda_signed = $9,
        updated_at = NOW()
       WHERE id = $10`,
      [
        email.trim().toLowerCase(), year, JSON.stringify(deviceArray),
        other_device_details || null, testing_experience || null,
        device_models || null, occupation || null,
        bug_report_sample || null, ndaBool, id
      ]
    );

    if (result.rowCount === 0) return res.status(404).send('Tester not found.');
    res.redirect('/admin/dashboard?success=updated');
  } catch (err) {
    if (err.code === '23505') {
      return res.redirect('/admin/dashboard?error=duplicate_email');
    }
    console.error('Update tester error:', err);
    res.status(500).send('Failed to update tester.');
  }
});

app.post('/admin/tester/:id/delete', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/admin');
  if (!databaseReady) return respondDbUnavailable(res);

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).send('Invalid ID.');

  try {
    const result = await pool.query('DELETE FROM testers WHERE id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).send('Tester not found.');
    res.redirect('/admin/dashboard?success=deleted');
  } catch (err) {
    console.error('Delete tester error:', err);
    res.status(500).send('Failed to delete tester.');
  }
});

// ── Admin Tasks ──
app.get('/admin/tasks', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/admin');

  try {
    const tasksRes = await pool.query(`
      SELECT t.*,
             COALESCE(sc.subtask_count, 0)::int AS subtask_count,
             COUNT(DISTINCT ta.tester_id)::int AS tester_count,
             COALESCE(sc.total_compensation, 0) AS total_compensation
      FROM tasks t
      LEFT JOIN (
        SELECT task_id, COUNT(*)::int AS subtask_count, SUM(compensation) AS total_compensation
        FROM subtasks GROUP BY task_id
      ) sc ON sc.task_id = t.id
      LEFT JOIN task_assignments ta ON ta.task_id = t.id
      GROUP BY t.id, sc.subtask_count, sc.total_compensation
      ORDER BY t.created_at DESC
    `);

    const taskRows = tasksRes.rows.map(t => {
      const date = new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      return `
        <tr>
          <td><a href="/admin/tasks/${t.id}" class="task-link">${escapeHtml(t.title)}</a></td>
          <td>${t.subtask_count}</td>
          <td>${t.tester_count}</td>
          <td>$${parseFloat(t.total_compensation).toFixed(2)}</td>
          <td><span class="badge badge-${t.status === 'active' ? 'complete' : 'pending'}">${t.status}</span></td>
          <td>${date}</td>
          <td>
            <div class="td-actions">
              <a href="/admin/tasks/${t.id}" class="btn-action btn-action--edit" title="View/Edit">✏️</a>
              <form method="POST" action="/admin/tasks/${t.id}/delete" style="margin:0">
                <button type="submit" class="btn-action btn-action--delete" title="Delete" onclick="return confirm('Delete this task and all its data?')">🗑️</button>
              </form>
            </div>
          </td>
        </tr>`;
    }).join('');

    let html = adminTasksTemplate;
    html = html.replace('{{TASK_ROWS}}', taskRows || '<tr><td colspan="7" class="table-empty" style="display:table-cell">No tasks created yet.</td></tr>');
    html = html.replace('{{TASK_COUNT}}', tasksRes.rows.length);

    res.send(html);
  } catch (err) {
    console.error('Admin tasks error:', err);
    res.status(500).send('Failed to load tasks.');
  }
});

app.post('/admin/tasks/create', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/admin');

  const { title, description, markdown_content } = req.body;
  if (!title || !markdown_content) return res.status(400).send('Title and markdown content are required.');

  try {
    const taskRes = await pool.query(
      'INSERT INTO tasks (title, description, markdown_content) VALUES ($1, $2, $3) RETURNING id',
      [title.trim(), description || null, markdown_content]
    );
    const taskId = taskRes.rows[0].id;

    const subtasks = parseMarkdownToSubtasks(markdown_content);
    for (let i = 0; i < subtasks.length; i++) {
      await pool.query(
        'INSERT INTO subtasks (task_id, title, description, sort_order, compensation) VALUES ($1, $2, $3, $4, $5)',
        [taskId, subtasks[i].title, subtasks[i].description, i, subtasks[i].compensation]
      );
    }

    res.redirect(`/admin/tasks/${taskId}?success=created`);
  } catch (err) {
    console.error('Create task error:', err);
    res.status(500).send('Failed to create task.');
  }
});

app.get('/admin/tasks/:id', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/admin');

  const taskId = parseInt(req.params.id);
  if (isNaN(taskId)) return res.status(400).send('Invalid task ID.');

  try {
    const [taskRes, subtasksRes, assignmentsRes, allTestersRes] = await Promise.all([
      pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]),
      pool.query('SELECT * FROM subtasks WHERE task_id = $1 ORDER BY sort_order', [taskId]),
      pool.query(`
        SELECT ta.*, t.email
        FROM task_assignments ta
        JOIN testers t ON t.id = ta.tester_id
        WHERE ta.task_id = $1
        ORDER BY ta.assigned_at DESC
      `, [taskId]),
      pool.query(`SELECT id, email FROM testers WHERE step2_token IS NULL AND testing_experience IS NOT NULL ORDER BY email`)
    ]);

    if (taskRes.rows.length === 0) return res.redirect('/admin/tasks');
    const task = taskRes.rows[0];

    const assignedIds = new Set(assignmentsRes.rows.map(a => a.tester_id));
    const totalComp = subtasksRes.rows.reduce((sum, s) => sum + parseFloat(s.compensation || 0), 0);

    const subtasksHtml = subtasksRes.rows.map((st, idx) => `
      <div class="admin-subtask-row">
        <span class="admin-subtask-num">${idx + 1}</span>
        <span class="admin-subtask-title">${escapeHtml(st.title)}</span>
        <span class="admin-subtask-comp">$${parseFloat(st.compensation).toFixed(2)}</span>
      </div>
    `).join('');

    const assignedHtml = assignmentsRes.rows.map(a => `
      <div class="assigned-tester">
        <div class="email-avatar">${(a.email[0] || '?').toUpperCase()}</div>
        <span>${escapeHtml(a.email)}</span>
        <form method="POST" action="/admin/tasks/${taskId}/unassign" style="margin:0">
          <input type="hidden" name="tester_id" value="${a.tester_id}">
          <button type="submit" class="btn-unassign" title="Remove">×</button>
        </form>
      </div>
    `).join('');

    const unassignedOptions = allTestersRes.rows
      .filter(t => !assignedIds.has(t.id))
      .map(t => `<option value="${t.id}">${escapeHtml(t.email)}</option>`)
      .join('');

    let html = adminTaskDetailTemplate;
    html = html.replace(/\{\{TASK_ID\}\}/g, task.id);
    html = html.replace(/\{\{TASK_TITLE\}\}/g, escapeHtml(task.title));
    html = html.replace(/\{\{TASK_DESC\}\}/g, escapeHtml(task.description || ''));
    html = html.replace(/\{\{TASK_MARKDOWN\}\}/g, escapeHtml(task.markdown_content));
    html = html.replace(/\{\{TASK_STATUS\}\}/g, task.status);
    html = html.replace(/\{\{TOTAL_COMP\}\}/g, totalComp.toFixed(2));
    html = html.replace(/\{\{SUBTASK_COUNT\}\}/g, subtasksRes.rows.length);
    html = html.replace('{{SUBTASKS_HTML}}', subtasksHtml || '<p class="text-muted">No subtasks parsed from markdown.</p>');
    html = html.replace('{{ASSIGNED_HTML}}', assignedHtml || '<p class="text-muted">No testers assigned yet.</p>');
    html = html.replace('{{UNASSIGNED_OPTIONS}}', unassignedOptions);
    html = html.replace(/\{\{ASSIGNED_COUNT\}\}/g, assignmentsRes.rows.length);

    res.send(html);
  } catch (err) {
    console.error('Task detail error:', err);
    res.status(500).send('Failed to load task.');
  }
});

app.post('/admin/tasks/:id/update', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/admin');

  const taskId = parseInt(req.params.id);
  if (isNaN(taskId)) return res.status(400).send('Invalid task ID.');

  const { title, description, markdown_content, status } = req.body;
  if (!title || !markdown_content) return res.status(400).send('Title and markdown are required.');

  try {
    await pool.query(
      'UPDATE tasks SET title=$1, description=$2, markdown_content=$3, status=$4, updated_at=NOW() WHERE id=$5',
      [title.trim(), description || null, markdown_content, status || 'active', taskId]
    );

    await pool.query('DELETE FROM subtasks WHERE task_id = $1 AND id NOT IN (SELECT subtask_id FROM submissions)', [taskId]);

    const existingSubtasks = await pool.query('SELECT id, title FROM subtasks WHERE task_id = $1', [taskId]);
    const existingTitles = new Map(existingSubtasks.rows.map(s => [s.title, s.id]));

    const parsed = parseMarkdownToSubtasks(markdown_content);
    for (let i = 0; i < parsed.length; i++) {
      if (existingTitles.has(parsed[i].title)) {
        await pool.query(
          'UPDATE subtasks SET description=$1, sort_order=$2, compensation=$3 WHERE id=$4',
          [parsed[i].description, i, parsed[i].compensation, existingTitles.get(parsed[i].title)]
        );
      } else {
        await pool.query(
          'INSERT INTO subtasks (task_id, title, description, sort_order, compensation) VALUES ($1,$2,$3,$4,$5)',
          [taskId, parsed[i].title, parsed[i].description, i, parsed[i].compensation]
        );
      }
    }

    res.redirect(`/admin/tasks/${taskId}?success=updated`);
  } catch (err) {
    console.error('Update task error:', err);
    res.status(500).send('Failed to update task.');
  }
});

app.post('/admin/tasks/:id/delete', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/admin');

  const taskId = parseInt(req.params.id);
  if (isNaN(taskId)) return res.status(400).send('Invalid ID.');

  try {
    await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
    res.redirect('/admin/tasks?success=deleted');
  } catch (err) {
    console.error('Delete task error:', err);
    res.status(500).send('Failed to delete task.');
  }
});

app.post('/admin/tasks/:id/assign', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/admin');

  const taskId = parseInt(req.params.id);
  const testerId = parseInt(req.body.tester_id);
  if (isNaN(taskId) || isNaN(testerId)) return res.status(400).send('Invalid IDs.');

  try {
    await pool.query(
      'INSERT INTO task_assignments (task_id, tester_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [taskId, testerId]
    );
    res.redirect(`/admin/tasks/${taskId}?success=assigned`);
  } catch (err) {
    console.error('Assign error:', err);
    res.status(500).send('Failed to assign tester.');
  }
});

app.post('/admin/tasks/:id/unassign', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/admin');

  const taskId = parseInt(req.params.id);
  const testerId = parseInt(req.body.tester_id);

  try {
    await pool.query('DELETE FROM task_assignments WHERE task_id = $1 AND tester_id = $2', [taskId, testerId]);
    res.redirect(`/admin/tasks/${taskId}?success=unassigned`);
  } catch (err) {
    console.error('Unassign error:', err);
    res.status(500).send('Failed to unassign tester.');
  }
});

// ── Admin Reviews ──
app.get('/admin/reviews', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/admin');

  try {
    const submissionsRes = await pool.query(`
      SELECT sub.*, st.title AS subtask_title, st.compensation,
             t.title AS task_title, t.id AS task_id,
             te.email AS tester_email
      FROM submissions sub
      JOIN subtasks st ON st.id = sub.subtask_id
      JOIN tasks t ON t.id = st.task_id
      JOIN testers te ON te.id = sub.tester_id
      ORDER BY
        CASE sub.status WHEN 'submitted' THEN 0 WHEN 'in_review' THEN 1 WHEN 'rejected' THEN 2 WHEN 'accepted' THEN 3 END,
        sub.updated_at DESC
    `);

    const rows = submissionsRes.rows.map(sub => {
      const statusClass = sub.status.replace('_', '-');
      const date = new Date(sub.updated_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      return `
        <tr>
          <td>${escapeHtml(sub.tester_email)}</td>
          <td><a href="/admin/tasks/${sub.task_id}" class="task-link">${escapeHtml(sub.task_title)}</a></td>
          <td>${escapeHtml(sub.subtask_title)}</td>
          <td>$${parseFloat(sub.compensation).toFixed(2)}</td>
          <td><span class="badge badge-${statusClass}">${sub.status.replace('_', ' ')}</span></td>
          <td>${date}</td>
          <td>
            <div class="td-actions">
              <button class="btn-action btn-action--edit" title="Review" onclick="openReviewModal(${sub.id}, '${escapeHtml(sub.tester_email).replace(/'/g, "\\'")}', '${escapeHtml(sub.subtask_title).replace(/'/g, "\\'")}', '${escapeHtml(sub.workflow_text || '').replace(/'/g, "\\'").replace(/\n/g, '\\n')}', '${sub.screenshot_path ? '/uploads/' + escapeHtml(sub.screenshot_path) : ''}', '${sub.status}', '${escapeHtml(sub.admin_notes || '').replace(/'/g, "\\'").replace(/\n/g, '\\n')}')">📋</button>
            </div>
          </td>
        </tr>`;
    }).join('');

    const pendingCount = submissionsRes.rows.filter(s => s.status === 'submitted' || s.status === 'in_review').length;

    let html = adminReviewsTemplate;
    html = html.replace('{{REVIEW_ROWS}}', rows || '<tr><td colspan="7" class="table-empty" style="display:table-cell">No submissions to review.</td></tr>');
    html = html.replace('{{TOTAL_SUBMISSIONS}}', submissionsRes.rows.length);
    html = html.replace('{{PENDING_COUNT}}', pendingCount);

    res.send(html);
  } catch (err) {
    console.error('Reviews error:', err);
    res.status(500).send('Failed to load reviews.');
  }
});

app.post('/admin/reviews/:id/update', async (req, res) => {
  if (!isAdminAuthenticated(req)) return res.redirect('/admin');

  const subId = parseInt(req.params.id);
  if (isNaN(subId)) return res.status(400).send('Invalid ID.');

  const { status, admin_notes } = req.body;
  const validStatuses = ['submitted', 'in_review', 'accepted', 'rejected'];
  if (!validStatuses.includes(status)) return res.status(400).send('Invalid status.');

  try {
    await pool.query(
      'UPDATE submissions SET status = $1, admin_notes = $2, updated_at = NOW() WHERE id = $3',
      [status, admin_notes || null, subId]
    );
    res.redirect('/admin/reviews?success=updated');
  } catch (err) {
    console.error('Review update error:', err);
    res.status(500).send('Failed to update review.');
  }
});

function logDbInitFailure(err) {
  let detail = err && err.message;
  if (!detail && err && err.errors && err.errors[0]) {
    const e = err.errors[0];
    detail = e.code === 'ECONNREFUSED'
      ? `connection refused (${e.address || 'host'}:${e.port || '?'})`
      : e.message || String(e);
  }
  if (!detail) detail = String(err);
  console.warn(
    `Database unavailable: serving static pages only (${detail}). Set DATABASE_URL / start Postgres and restart for full features.`
  );
}

(async function start() {
  try {
    await initDatabase();
    databaseReady = true;
    console.log('Database connected.');
  } catch (err) {
    logDbInitFailure(err);
  }

  const server = app.listen(port, '0.0.0.0', () => {
    server.off('error', onListenError);
    console.log(`Server running on port ${port}`);
  });
  function onListenError(err) {
    const hint =
      err.code === 'EADDRINUSE'
        ? ' Port in use: on macOS, AirPlay Receiver often binds :5000; try PORT=3000 npm start or disable AirPlay in System Settings → General → AirDrop & Handoff.'
        : '';
    console.error(`Failed to listen on ${port}:`, err.message || err, hint);
    process.exit(1);
  }
  server.on('error', onListenError);
})();
