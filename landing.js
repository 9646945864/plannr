/* ============================================================
   PLANNR — landing.js
   Handles the marketing/landing page only (index.html):
   scroll-to-preview button, a decorative (non-interactive)
   calendar preview, and the demo sign-in redirect into app.html.
   ============================================================ */

const PREVIEW_TASKS = [
  { day: 1, startHour: 9, durationHours: 1.5, title: "Chem lecture" },
  { day: 1, startHour: 18, durationHours: 2, title: "Study for test" },
  { day: 2, startHour: 14, durationHours: 1, title: "Club meeting" },
  { day: 3, startHour: 10, durationHours: 2, title: "Essay draft" },
  { day: 4, startHour: 16, durationHours: 1, title: "Practice SATs" },
  { day: 5, startHour: 19, durationHours: 1.5, title: "Volunteer hours" },
];

const PREVIEW_START_HOUR = 7;
const PREVIEW_END_HOUR = 22;

function renderPreviewCalendar() {
  const container = document.getElementById("preview-calendar");
  if (!container) return;

  const totalHours = PREVIEW_END_HOUR - PREVIEW_START_HOUR;
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  let html = '<div class="preview-grid">';
  for (let d = 0; d < 7; d++) {
    html += `<div class="preview-col">
      <div class="preview-day-label">${dayNames[d]}</div>
      <div class="preview-col-body" style="height:${totalHours * 18}px;">`;

    PREVIEW_TASKS.filter((t) => t.day === d).forEach((t) => {
      const top = (t.startHour - PREVIEW_START_HOUR) * 18;
      const height = t.durationHours * 18;
      html += `<div class="preview-task" style="top:${top}px;height:${height}px;">${t.title}</div>`;
    });

    html += `</div></div>`;
  }
  html += "</div>";

  container.innerHTML = html;
}

function setupScrollCue() {
  const cue = document.getElementById("scroll-cue");
  if (!cue) return;
  cue.addEventListener("click", () => {
    document.querySelector(".preview-section")?.scrollIntoView({ behavior: "smooth" });
  });
}

function setupSignIn() {
  const form = document.getElementById("signin-form");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    // Demo-only: no real auth yet. This is where a real backend
    // check would go before redirecting.
    window.location.href = "app.html";
  });
}

renderPreviewCalendar();
setupScrollCue();
setupSignIn();
