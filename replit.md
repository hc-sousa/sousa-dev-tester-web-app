# Beta Tester Registration App

## Overview
A two-step beta tester registration flow built with Node.js, Express, and PostgreSQL. Includes an admin dashboard and Docker Compose deployment config for Dokploy.

## Tech Stack
- **Runtime:** Node.js
- **Framework:** Express
- **Database:** PostgreSQL (Replit built-in / Dockerized for production)
- **Frontend:** Server-rendered HTML with vanilla CSS/JS

## Project Structure
```
index.js                - Express server with all API routes (registration + admin)
Dockerfile              - Production Docker image
docker-compose.yml      - Full stack deployment (app + PostgreSQL)
.dockerignore           - Files excluded from Docker build
.env.example            - Template for environment variables
views/
  step1.html            - Step 1 quick sign-up form
  step2.html            - Step 2 detailed profile form (template with placeholders)
  success.html          - Thank you / success page
  admin-login.html      - Admin login page
  admin-dashboard.html  - Admin dashboard with stats and tester table
public/
  styles.css            - Shared stylesheet
  admin.css             - Admin dashboard styles
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
- `GET /admin` — Admin login (blocked if ADMIN_PASSWORD env is blank)
- `POST /admin/login` — Authenticate with password
- `GET /admin/dashboard` — Stats + tester table (authenticated)
- `GET /admin/export` — CSV download of completed testers (authenticated)
- `GET /admin/logout` — Clear session and redirect to login

## Admin Dashboard
- Protected by `ADMIN_PASSWORD` env var — if blank or unset, the dashboard is completely inaccessible
- Session managed via HttpOnly cookie with a random token generated at server startup
- Shows: total sign-ups, completed profiles, pending step 2, NDA-willing count, device breakdown, experience breakdown
- Full tester table with email, birth year, devices, experience, occupation, NDA, status, sign-up date
- CSV export of all completed tester profiles

## Security
- Token-based Step 2 access (UUID, one-time use)
- Server-side device whitelist (Windows, Mac, iPhone, Android, Other)
- HTML escaping on all template values
- Safe JSON embedding via `<script type="application/json">` with `<` escaping
- Server-side validation for all required fields
- Admin auth via env-var password + HttpOnly session cookie

## Docker Deployment (Dokploy)
```bash
# 1. Copy .env.example to .env and set your values
cp .env.example .env

# 2. Run the full stack
docker compose up -d --build
```

### Environment Variables
| Variable | Default | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | `changeme` | PostgreSQL password |
| `ADMIN_PASSWORD` | *(blank)* | Admin dashboard password. Blank = dashboard disabled |
| `APP_PORT` | `5000` | Host port mapping |

## Running (Development)
The app runs on port 5000 via `node index.js`.
