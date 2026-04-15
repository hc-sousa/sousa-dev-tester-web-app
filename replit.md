# Beta Tester Registration App

## Overview
A two-step beta tester registration flow built with Node.js, Express, and PostgreSQL.

## Tech Stack
- **Runtime:** Node.js
- **Framework:** Express
- **Database:** PostgreSQL (Replit built-in)
- **Frontend:** Server-rendered HTML with vanilla CSS/JS

## Project Structure
```
index.js          - Express server with all API routes
views/
  step1.html      - Step 1 quick sign-up form
  step2.html      - Step 2 detailed profile form (template with placeholders)
  success.html    - Thank you / success page
public/
  styles.css      - Shared stylesheet
```

## Database
- **Table:** `testers` (auto-created on startup via `initDatabase()`)
- **Step 1 columns:** id (serial PK), email (unique), birth_year, devices (JSONB), other_device_details
- **Step 2 columns:** testing_experience, device_models, occupation, bug_report_sample, nda_signed
- **Security column:** step2_token (UUID, nullified after Step 2 completion)
- **Timestamps:** created_at, updated_at

## Routes
- `GET /` — Step 1 form
- `POST /api/step1` — Save Step 1 data, redirect to Step 2 via token
- `GET /complete-profile?token=X` — Step 2 form with pre-filled data (token-based access)
- `POST /api/step2` — Update record with Step 2 data, redirect to success
- `GET /success` — Confirmation page

## Security
- Token-based Step 2 access (UUID, one-time use)
- Server-side device whitelist (Windows, Mac, iPhone, Android, Other)
- HTML escaping on all template values
- Safe JSON embedding via `<script type="application/json">` with `<` escaping
- Server-side validation for all required fields

## Running
The app runs on port 5000 via `node index.js`.
