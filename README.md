# Plannr

An AI-assisted weekly planner. Type a task in plain language — like
"Study for chem test Thursday, need 3 hours, prefer evenings" — and
Plannr finds an open slot for it on your calendar.

## How it works

1. **You type a task** in the input bar.
2. **The Gemini API parses it** into structured data (title, duration,
   deadline, preferred time of day). This happens through a small
   serverless function (`/api/parse-task.js`) so the API key never
   reaches the browser.
3. **Plannr's own scheduling logic** (`js/app.js` — `findOpenSlot`) —
   written from scratch, no AI involved — searches the week for the
   first open slot that fits the task's duration, deadline, and time
   preference.
4. **The calendar renders** the task in that slot. Tasks persist in
   the browser via `localStorage`.

## What's AI and what isn't

This project uses the Gemini API as one tool, not as a way to generate
the whole app. Specifically:

- **AI-assisted:** turning a plain-language sentence into structured
  data (title/duration/deadline/preference).
- **Not AI — built by hand:** the scheduling algorithm, the calendar
  rendering, the data storage, and the UI/UX design.

## Project structure

```
plannr/
├── index.html          # page shell
├── css/style.css        # all styling
├── js/app.js             # scheduling logic, rendering, storage, API calls
├── api/parse-task.js     # serverless function that calls Gemini securely
└── README.md
```

## Setup

1. Get a free Gemini API key at https://aistudio.google.com/apikey
2. In your Vercel project settings, add an environment variable:
   `GEMINI_API_KEY` = your key
3. Push to GitHub — Vercel auto-deploys on every push.

## Roadmap / stretch goal

- Auto-reschedule tasks that get missed (deadline passed, not marked
  done) instead of requiring the user to manually move them.
