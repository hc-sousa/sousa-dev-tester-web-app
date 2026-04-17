# Sample task content (admin → Tasks)

Use this shape when you **create** or **edit** a task in the admin dashboard. The **title** and **short description** are filled in the form separately; paste everything below the horizontal rule into the **Markdown content** field.

---

## How subtasks are parsed

| Rule | Detail |
|------|--------|
| Headings | Each subtask **must** start with a level-2 heading: `## Subtask title` |
| Pay | Optional USD amount in brackets: `## Do the thing [$15]` or `## Quick check [$7.50]`. Omit `[$…]` for **$0.00**. |
| Body | Everything under a `##` line until the next `##` becomes that subtask’s instructions (shown to testers). |
| Formatting in body | Testers see basic formatting: `**bold**`, `*italic*`, `` `code` ``, and `-` bullet lists. |
| Don’t use | `###` headings for subtasks — only `##` is parsed as a subtask boundary. |

---

## Copy-paste template (replace placeholders)

```markdown
## Smoke test — install & launch [$10]

Confirm the app installs and opens without crashing.

- Use a **clean install** (or note if you reused an existing install).
- List your **OS version** and **device model** in the workflow text when you submit.

---

## Core flow — primary user journey [$15]

Walk through the main path a new user would take (e.g. sign up → first action → success).

- Call out any **blockers** or confusing copy.
- If something fails, capture it in the screenshot and describe steps to reproduce.

---

## Edge case — offline or slow network [$12]

*(Optional section — delete if not in scope.)*

Try airplane mode or throttled connection if you can. Note whether errors are clear and recoverable.

---

## Regression spot-check [$8]

Pick one area that changed recently (you’ll get hints in the task description). Confirm it still works end-to-end.
```

---

## Minimal example (two subtasks)

```markdown
## Sign-up funnel [$10]

Go through registration with a test email. Report any validation issues or broken links.

## Settings screen [$5]

Open settings, change one non-destructive option, confirm it saves after refresh.
```

---

## Tips

- **One tester submission per subtask** — split work so each `##` is a single billable unit.
- **Titles stay short** — the line after `##` is the subtask name in lists and reviews.
- **Editing tasks** — changing markdown re-parses subtasks; rows that already have submissions are kept when titles match updates (see admin hint on the task edit page).
