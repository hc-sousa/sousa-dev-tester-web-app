const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 5000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const ALLOWED_DEVICES = ['Windows', 'Mac', 'iPhone', 'Android', 'Other'];

const step2Template = fs.readFileSync(path.join(__dirname, 'views', 'step2.html'), 'utf8');
const adminLoginTemplate = fs.readFileSync(path.join(__dirname, 'views', 'admin-login.html'), 'utf8');
const adminDashTemplate = fs.readFileSync(path.join(__dirname, 'views', 'admin-dashboard.html'), 'utf8');

const adminSessions = new Set();

function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.add(token);
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

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const result = {};
  header.split(';').forEach(pair => {
    const [key, ...rest] = pair.split('=');
    if (key) result[key.trim()] = decodeURIComponent(rest.join('=').trim());
  });
  return result;
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

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'step1.html'));
});

app.post('/api/step1', async (req, res) => {
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
      [email.trim(), year, JSON.stringify(deviceArray), other_device_details || null, token]
    );
    res.redirect(`/complete-profile?token=${token}`);
  } catch (err) {
    if (err.code === '23505') {
      res.status(400).send(`
        <html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8f9fa">
          <div style="text-align:center;max-width:400px;padding:2rem">
            <h2 style="color:#dc3545">Email Already Registered</h2>
            <p>This email address has already been used to sign up.</p>
            <a href="/" style="color:#4f46e5">Go back</a>
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
  const { token } = req.query;
  if (!token) return res.redirect('/');

  try {
    const result = await pool.query('SELECT * FROM testers WHERE step2_token = $1', [token]);
    if (result.rows.length === 0) return res.redirect('/');

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
        SELECT email, birth_year, devices, testing_experience, occupation,
               nda_signed, step2_token, created_at
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

      return `<tr>
        <td>
          <div class="td-email">
            <div class="email-avatar">${initial}</div>
            <span class="td-email-text">${escapeHtml(t.email)}</span>
          </div>
        </td>
        <td>${t.birth_year}</td>
        <td><div class="device-tags">${deviceTags}</div></td>
        <td>${escapeHtml(t.testing_experience || '—')}</td>
        <td>${escapeHtml(t.occupation || '—')}</td>
        <td>${ndaBadge}</td>
        <td>${statusBadge}</td>
        <td>${date}</td>
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

initDatabase()
  .then(() => {
    app.listen(port, '0.0.0.0', () => {
      console.log(`Server running on port ${port}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
