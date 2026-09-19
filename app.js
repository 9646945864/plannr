/* ============================================================
   PLANNR — app.js
   This file is intentionally commented in detail so you (the
   student building this) can explain every part of it for your
   Congressional App Challenge write-up.
   ============================================================ */

/* ---------- 1. CONFIG ---------- */

const DAY_START_HOUR = 7;   // calendar shows from 7:00am
const DAY_END_HOUR = 22;    // ...to 10:00pm
const SLOT_MINUTES = 30;    // scheduling works in 30-minute increments
const STORAGE_KEY = "plannr_tasks_v1";

/* ---------- 2. TASK DATA STRUCTURE ----------
   This is the "contract" every part of the app agrees on.
   A task looks like:
   {
     id: "t_172839...",
     title: "Study for chem test",
     durationMinutes: 180,
     deadline: "2026-09-24",       // ISO date string (no time)
     preferredTime: "evening",     // "morning" | "afternoon" | "evening" | null
     status: "scheduled",          // "scheduled" | "done" | "missed"
     scheduledStart: "2026-09-23T18:00:00" // ISO datetime, set by the scheduler
   }
------------------------------------------------- */

let tasks = loadTasks();
let currentWeekStart = getStartOfWeek(new Date());

/* ---------- 3. STORAGE (localStorage) ---------- */

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error("Could not load saved tasks:", err);
    return [];
  }
}

function saveTasks() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (err) {
    console.error("Could not save tasks:", err);
  }
}

/* ---------- 4. DATE HELPERS ---------- */

function getStartOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function formatDateISO(date) {
  // returns YYYY-MM-DD in local time (not UTC, to avoid off-by-one bugs)
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatWeekLabel(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const opts = { month: "short", day: "numeric" };
  return `${weekStart.toLocaleDateString(undefined, opts)} – ${weekEnd.toLocaleDateString(undefined, opts)}`;
}

/* ---------- 5. SCHEDULING LOGIC ----------
   This is YOUR algorithm, not the AI's. Gemini only extracts
   structured info from the sentence; this function decides
   WHERE the task actually goes.
------------------------------------------------- */

function preferredHourRange(preferredTime) {
  switch (preferredTime) {
    case "morning": return [7, 12];
    case "afternoon": return [12, 17];
    case "evening": return [17, 22];
    default: return [DAY_START_HOUR, DAY_END_HOUR];
  }
}

function findOpenSlot(task) {
  const deadline = task.deadline ? new Date(task.deadline + "T23:59:59") : addDays(new Date(), 14);
  const [prefStart, prefEnd] = preferredHourRange(task.preferredTime);
  const durationMs = task.durationMinutes * 60 * 1000;

  // search day by day, starting today, until the deadline
  let cursorDay = new Date();
  cursorDay.setHours(0, 0, 0, 0);

  while (cursorDay <= deadline) {
    const daySlots = buildDaySlotBounds(cursorDay, prefStart, prefEnd);

    for (let slotStart = daySlots.start; slotStart + durationMs <= daySlots.end; slotStart += SLOT_MINUTES * 60 * 1000) {
      const candidateStart = new Date(slotStart);
      const candidateEnd = new Date(slotStart + durationMs);

      if (candidateEnd > deadline) continue;
      if (isSlotFree(candidateStart, candidateEnd)) {
        return candidateStart.toISOString();
      }
    }
    cursorDay = addDays(cursorDay, 1);
  }

  return null; // no open slot found before deadline
}

function buildDaySlotBounds(day, prefStartHour, prefEndHour) {
  const start = new Date(day);
  start.setHours(Math.max(prefStartHour, DAY_START_HOUR), 0, 0, 0);
  const end = new Date(day);
  end.setHours(Math.min(prefEndHour, DAY_END_HOUR), 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

function isSlotFree(candidateStart, candidateEnd) {
  return tasks.every((t) => {
    if (t.status !== "scheduled" || !t.scheduledStart) return true;
    const existingStart = new Date(t.scheduledStart);
    const existingEnd = new Date(existingStart.getTime() + t.durationMinutes * 60 * 1000);
    return candidateEnd <= existingStart || candidateStart >= existingEnd;
  });
}

/* ---------- 6. GEMINI PARSING (via our own backend) ----------
   The browser never talks to Gemini directly — it calls our
   serverless function at /api/parse-task, which holds the real
   API key. See /api/parse-task.js.
------------------------------------------------- */

async function parseTaskWithAI(rawText) {
  const response = await fetch("/api/parse-task", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: rawText }),
  });

  if (!response.ok) {
    throw new Error(`Server responded with ${response.status}`);
  }

  const data = await response.json();
  return data; // expected: { title, durationMinutes, deadline, preferredTime }
}

/* ---------- 7. RENDERING ---------- */

function renderWeekLabel() {
  document.getElementById("week-label").textContent = formatWeekLabel(currentWeekStart);
}

function renderCalendar() {
  const grid = document.getElementById("calendar-grid");
  grid.innerHTML = "";

  const totalHours = DAY_END_HOUR - DAY_START_HOUR;
  grid.style.gridTemplateRows = `auto repeat(${totalHours}, var(--hour-height))`;

  // top-left empty corner
  const corner = document.createElement("div");
  corner.style.gridRow = "1";
  corner.style.gridColumn = "1";
  grid.appendChild(corner);

  const todayISO = formatDateISO(new Date());

  // day headers
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    const header = document.createElement("div");
    header.className = "day-header";
    if (formatDateISO(dayDate) === todayISO) header.classList.add("is-today");
    header.style.gridColumn = i + 2;
    header.innerHTML = `<span class="day-name">${dayDate.toLocaleDateString(undefined, { weekday: "short" })} ${dayDate.getDate()}</span>`;
    grid.appendChild(header);
  }

  // hour labels (left column)
  for (let h = 0; h < totalHours; h++) {
    const label = document.createElement("div");
    label.className = "hour-label";
    label.style.gridRow = h + 2;
    const hour = DAY_START_HOUR + h;
    const displayHour = hour % 12 === 0 ? 12 : hour % 12;
    const ampm = hour < 12 ? "am" : "pm";
    label.textContent = `${displayHour}${ampm}`;
    grid.appendChild(label);
  }

  // day columns
  for (let i = 0; i < 7; i++) {
    const col = document.createElement("div");
    col.className = "day-column";
    col.style.gridColumn = i + 2;
    col.style.gridRow = `2 / span ${totalHours}`;
    col.dataset.date = formatDateISO(addDays(currentWeekStart, i));
    grid.appendChild(col);
  }

  placeTasksOnGrid();
}

function placeTasksOnGrid() {
  const columns = document.querySelectorAll(".day-column");
  const columnsByDate = {};
  columns.forEach((col) => (columnsByDate[col.dataset.date] = col));

  tasks.forEach((task) => {
    if (!task.scheduledStart) return;
    const start = new Date(task.scheduledStart);
    const dateKey = formatDateISO(start);
    const col = columnsByDate[dateKey];
    if (!col) return; // not in the visible week

    const hourHeightPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour-height"));
    const startMinutesFromDayStart = (start.getHours() - DAY_START_HOUR) * 60 + start.getMinutes();
    const topPx = (startMinutesFromDayStart / 60) * hourHeightPx;
    const heightPx = (task.durationMinutes / 60) * hourHeightPx;

    const block = document.createElement("div");
    block.className = "task-block" + (task.status === "done" ? " is-done" : "");
    block.style.top = `${topPx}px`;
    block.style.height = `${Math.max(heightPx, 20)}px`;
    block.innerHTML = `
      <span class="task-title">${escapeHTML(task.title)}</span>
      <span class="task-time">${formatTimeShort(start)}</span>
    `;
    block.addEventListener("click", () => toggleTaskDone(task.id));
    col.appendChild(block);
  });
}

function formatTimeShort(date) {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function toggleTaskDone(taskId) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.status = task.status === "done" ? "scheduled" : "done";
  saveTasks();
  renderCalendar();
}

/* ---------- 8. ADDING A TASK (the main flow) ---------- */

function setStatus(message, isError = false) {
  const el = document.getElementById("status-line");
  el.textContent = message;
  el.classList.toggle("is-error", isError);
}

async function handleAddTask(event) {
  event.preventDefault();
  const input = document.getElementById("task-input");
  const submitBtn = document.getElementById("task-submit");
  const rawText = input.value.trim();
  if (!rawText) return;

  submitBtn.disabled = true;
  setStatus("Reading that…");

  try {
    const parsed = await parseTaskWithAI(rawText);

    const task = {
      id: "t_" + Date.now(),
      title: parsed.title || rawText,
      durationMinutes: parsed.durationMinutes || 60,
      deadline: parsed.deadline || null,
      preferredTime: parsed.preferredTime || null,
      status: "scheduled",
      scheduledStart: null,
    };

    const slot = findOpenSlot(task);
    if (!slot) {
      setStatus("Couldn't find an open slot before that deadline — try a different task or deadline.", true);
      submitBtn.disabled = false;
      return;
    }

    task.scheduledStart = slot;
    tasks.push(task);
    saveTasks();

    input.value = "";
    setStatus(`Scheduled for ${new Date(slot).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" })}.`);
    renderCalendar();
  } catch (err) {
    console.error(err);
    setStatus("Something went wrong reading that task. Try rephrasing it.", true);
  } finally {
    submitBtn.disabled = false;
  }
}

/* ---------- 9. WEEK NAVIGATION ---------- */

function handlePrevWeek() {
  currentWeekStart = addDays(currentWeekStart, -7);
  renderWeekLabel();
  renderCalendar();
}

function handleNextWeek() {
  currentWeekStart = addDays(currentWeekStart, 7);
  renderWeekLabel();
  renderCalendar();
}

/* ---------- 10. INIT ---------- */

document.getElementById("task-form").addEventListener("submit", handleAddTask);
document.getElementById("prev-week").addEventListener("click", handlePrevWeek);
document.getElementById("next-week").addEventListener("click", handleNextWeek);

renderWeekLabel();
renderCalendar();
