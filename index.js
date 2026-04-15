const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 5000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const ALLOWED_DEVICES = ['Windows', 'Mac', 'iPhone', 'Android', 'Other'];

const step2Template = fs.readFileSync(path.join(__dirname, 'views', 'step2.html'), 'utf8');

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

    if (!token || !testing_experience || !bug_report_sample || nda_signed !== 'on') {
      return res.status(400).send('Please fill in all required fields and agree to the NDA.');
    }

    const validExperience = ['Beginner', 'Hobbyist', 'Professional'];
    if (!validExperience.includes(testing_experience)) {
      return res.status(400).send('Invalid testing experience level.');
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
      [testing_experience, device_models || null, occupation || null, bug_report_sample, true, token]
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
