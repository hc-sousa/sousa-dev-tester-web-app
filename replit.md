# Beta Tester Registration App

## Overview
A two-step beta tester registration flow built with Node.js, Express, and PostgreSQL. Includes an admin dashboard, tester portal with task management and earnings tracking, and Docker Compose deployment config for Dokploy.

## Tech Stack
- **Runtime:** Node.js
- **Framework:** Express
- **Database:** PostgreSQL (Replit built-in / Dockerized for production)
- **Frontend:** Server-rendered HTML with vanilla CSS/JS, Poppins font
- **File Uploads:** multer (10MB image limit)

## Project Structure
```
index.js                - Express server with all routes (~1300 lines)
Dockerfile              - Production Docker image
docker-compose.yml      - Full stack deployment (app + PostgreSQL)
.dockerignore           - Files excluded from Docker build
.env.example            - Template for environment variables
uploads/                - User-uploaded screenshots (gitignored)
views/
  step1.html            - Step 1 quick sign-up form
  step2.html            - Step 2 detailed profile form
  success.html          - Thank you / success page
  admin-login.html      - Admin login page
  admin-dashboard.html  - Admin dashboard with stats, tester table, nav tabs
  admin-tasks.html      - Admin task list with create modal
  admin-task-detail.html - Admin task detail (subtasks, assignments, edit)
  admin-reviews.html    - Admin submission review queue
  tester-login.html     - Tester email login page
  portal-dashboard.html - Tester portal with earnings + task list
  portal-task.html      - Task detail with subtask submissions
  portal-getpaid.html   - Payment instructions page
public/
  styles.css            - Shared / registration stylesheet
  admin.css             - Admin dashboard + task/review styles
  portal.css            - Tester portal styles
```

## Database Tables
All tables auto-created on startup via `initDatabase()`:

### testers
- id (serial PK), email (unique), birth_year, devices (JSONB), other_device_details
- testing_experience, device_models, occupation, bug_report_sample, nda_signed
- step2_token (UUID, nullified after Step 2), created_at, updated_at

### tasks
- id (serial PK), title, description, markdown_content, status (active/archived)
- created_at, updated_at

### subtasks
- id (serial PK), task_id (FK→tasks), title, description, sort_order, compensation (decimal)

### task_assignments
- id (serial PK), task_id (FK→tasks), tester_id (FK→testers), assigned_at
- UNIQUE(task_id, tester_id)

### submissions
- id (serial PK), subtask_id (FK→subtasks), tester_id (FK→testers)
- workflow_text, screenshot_path, status (submitted/in_review/accepted/rejected)
- admin_notes, created_at, updated_at
- UNIQUE(subtask_id, tester_id)

## Routes

### Registration
- `GET /` — Step 1 form
- `POST /api/step1` — Save Step 1 data, redirect to Step 2
- `GET /complete-profile?token=X` — Step 2 form (token-based)
- `POST /api/step2` — Complete profile, redirect to success
- `GET /success` — Confirmation page

### Tester Portal
- `GET /login` — Tester email login page
- `POST /login` — Authenticate via email lookup (completed registrations only)
- `GET /logout` — Clear tester session
- `GET /portal` — Dashboard with earnings + assigned task list
- `GET /portal/task/:id` — Task detail with subtask submissions
- `POST /portal/task/:taskId/submit/:subtaskId` — Submit/resubmit work (multipart)
- `POST /portal/task/:taskId/remove/:subtaskId` — Remove submission
- `GET /portal/getpaid` — Payment instructions

### Admin
- `GET /admin` — Admin login
- `POST /admin/login` — Authenticate with ADMIN_PASSWORD
- `GET /admin/dashboard` — KPI stats + tester table
- `GET /admin/export` — CSV download
- `POST /admin/tester/:id/update` — Edit tester
- `POST /admin/tester/:id/delete` — Delete tester
- `GET /admin/tasks` — Task list
- `POST /admin/tasks/create` — Create task from markdown
- `GET /admin/tasks/:id` — Task detail (subtasks, assignments)
- `POST /admin/tasks/:id/update` — Edit task + re-parse subtasks
- `POST /admin/tasks/:id/delete` — Delete task
- `POST /admin/tasks/:id/assign` — Assign tester to task
- `POST /admin/tasks/:id/unassign` — Remove tester from task
- `GET /admin/reviews` — Submission review queue
- `POST /admin/reviews/:id/update` — Update submission status/notes
- `GET /admin/logout` — Clear admin session

## Key Features
- **Markdown→Subtasks:** `## Section Title [$10]` syntax auto-parsed into subtasks with compensation
- **Tester Auth:** Email-only lookup, session cookie (7-day), Map-based sessions
- **Earnings Tracking:** Confirmed (accepted) + On Hold (submitted/in_review) totals
- **Submission Workflow:** submitted → in_review → accepted/rejected; testers can remove or resubmit
- **Admin Tabs:** Testers | Tasks | Reviews navigation

## Security
- Token-based Step 2 access (UUID, one-time use)
- Server-side device whitelist
- HTML escaping on all template values
- Admin auth via env-var password + HttpOnly session cookie
- Tester auth via email lookup + HttpOnly session cookie

## Environment Variables
| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | *(required)* | PostgreSQL connection string |
| `ADMIN_PASSWORD` | *(blank)* | Admin dashboard password. Blank = dashboard disabled |
| `APP_PORT` | `5000` | Host port mapping (Docker) |
| `POSTGRES_PASSWORD` | `changeme` | PostgreSQL password (Docker) |

## GitHub
- **Repo:** https://github.com/hc-sousa/sousa-dev-tester-web-app
- **Branch:** dev

## Running (Development)
The app runs on port 5000 via `node index.js`.
Templates are loaded at startup via `fs.readFileSync` — server restart required after editing views.
