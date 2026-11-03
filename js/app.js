/* ============================================================
   PLANNR — app.js

   Core
   - Calendar (week + day views), drag to move / resize
   - AI commands: create, reschedule, delete, complete, replan,
     questions about your calendar, "clear my Friday"
   - Long tasks split into sessions, repeating events
   - Smart replan + undo, proactive insights, deadline progress
   - Edit / delete popup with undo toast

   Personal
   - Settings: working hours, blocked times, buffers, focus time,
     daily limit, theme, default view (synced to your account)
   - Learns when you actually finish things

   Extras
   - Syllabus import (AI finds dates, schedules prep time)
   - .ics import / export
   - Voice input, reminders, keyboard shortcuts

   Extra UI (toolbar, dashboard, settings, import) is created by
   this file, so app.html needs no changes. It does need the
   matching CSS for the new elements.
   ============================================================ */


/* ---------- 1. CONFIG ---------- */

const SUPABASE_URL = "https://tlimbaewebfyibhxdcbk.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Wkqp70DOPk_vDZNChqLi_g_70dmrgay";

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);

const SLOT_MINUTES = 30;

const STORAGE_KEY = "plannr_tasks_v1";
const SETTINGS_KEY = "plannr_settings_v1";
const MISSED_DISMISS_KEY = "plannr_missed_dismissed";

// Features this client asks the server to enable.
const AI_FEATURES = ["split", "recurrence", "query"];


/* ---------- 2. SMALL UTILITIES ---------- */

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const snapTo = (n, step) => Math.round(n / step) * step;

function makeId() {
  if (window.crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseHM(str) {
  const [h, m] = String(str).split(":").map(Number);

  return h * 60 + m;
}

function escapeHTML(str) {
  const div = document.createElement("div");

  div.textContent = String(str ?? "");

  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtHour(h) {
  return `${h % 12 || 12}${h < 12 || h === 24 ? "am" : "pm"}`;
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);

  if (!h) return `${m} min`;
  if (!m) return `${h} hour${h === 1 ? "" : "s"}`;

  return `${h}h ${m}m`;
}

function baseTitle(title) {
  return String(title || "").replace(/\s*\(\d+\/\d+\)\s*$/, "");
}


/* ---------- 3. SETTINGS ---------- */

const DEFAULT_SETTINGS = {
  dayStartHour: 7,
  dayEndHour: 22,
  bufferMinutes: 0,
  focusTime: null,
  maxHoursPerDay: 8,
  blocked: [],
  learn: true,
  reminders: false,
  reminderMinutes: 10,
  theme: "dark",
  view: "auto"
};

function sanitizeSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};

  const intIn = (v, min, max, fallback) => {
    const n = Math.round(Number(v));

    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  };

  const start = intIn(src.dayStartHour, 0, 22, DEFAULT_SETTINGS.dayStartHour);
  const end = intIn(
    src.dayEndHour,
    start + 1,
    24,
    Math.max(start + 1, DEFAULT_SETTINGS.dayEndHour)
  );

  const timeOK = (v) =>
    typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

  const blocked = (Array.isArray(src.blocked) ? src.blocked : [])
    .map((b) => {
      if (!b || typeof b !== "object") return null;

      const days = (Array.isArray(b.days) ? b.days : [])
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);

      if (
        !days.length ||
        !timeOK(b.start) ||
        !timeOK(b.end) ||
        parseHM(b.end) <= parseHM(b.start)
      ) {
        return null;
      }

      return {
        id: typeof b.id === "string" && b.id ? b.id.slice(0, 60) : makeId(),
        label: String(b.label || "Busy").slice(0, 40),
        days: [...new Set(days)].sort(),
        start: b.start,
        end: b.end
      };
    })
    .filter(Boolean)
    .slice(0, 12);

  return {
    dayStartHour: start,
    dayEndHour: end,
    bufferMinutes: [0, 5, 10, 15, 30].includes(Number(src.bufferMinutes))
      ? Number(src.bufferMinutes)
      : 0,
    focusTime: ["morning", "afternoon", "evening"].includes(src.focusTime)
      ? src.focusTime
      : null,
    maxHoursPerDay: intIn(src.maxHoursPerDay, 2, 14, 8),
    blocked,
    learn: src.learn !== false,
    reminders: src.reminders === true,
    reminderMinutes: [5, 10, 15, 30].includes(Number(src.reminderMinutes))
      ? Number(src.reminderMinutes)
      : 10,
    theme: ["dark", "light", "system"].includes(src.theme) ? src.theme : "dark",
    view: ["auto", "week", "day"].includes(src.view) ? src.view : "auto"
  };
}

function loadSettingsLocal() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);

    return sanitizeSettings(raw ? JSON.parse(raw) : {});
  } catch {
    return sanitizeSettings({});
  }
}

async function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage can be unavailable; ignore */
  }

  try {
    const { error } = await supabaseClient.auth.updateUser({
      data: { plannr_settings: settings }
    });

    if (error) {
      console.error("Could not sync settings:", error);
    }
  } catch (err) {
    console.error("Could not sync settings:", err);
  }
}

function applyTheme() {
  const wanted =
    settings.theme === "system"
      ? window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : settings.theme;

  document.documentElement.dataset.theme = wanted;
}

function applySettings() {
  DAY_START_HOUR = settings.dayStartHour;
  DAY_END_HOUR = settings.dayEndHour;

  applyTheme();
}


/* ---------- 4. STATE ---------- */

// Visible hours come from settings.
let DAY_START_HOUR = DEFAULT_SETTINGS.dayStartHour;
let DAY_END_HOUR = DEFAULT_SETTINGS.dayEndHour;

let settings = loadSettingsLocal();

applySettings();

let tasks = loadTasks();

function computeViewDays() {
  if (settings.view === "week") return 7;
  if (settings.view === "day") return 1;

  return window.innerWidth < 720 ? 1 : 7;
}

let viewDays = computeViewDays();

// First day shown in the calendar.
let viewStart =
  viewDays === 7 ? getStartOfWeek(new Date()) : startOfDay(new Date());

function focusDate(date) {
  viewStart = viewDays === 7 ? getStartOfWeek(date) : startOfDay(date);
}


/* ---------- 5. STORAGE ---------- */

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error("Could not load saved tasks:", err);
    return [];
  }
}

// Saves run one at a time so rapid actions can't interleave.
let saveChain = Promise.resolve();

function saveTasks() {
  saveChain = saveChain.then(syncTasksNow).catch(console.error);
  return saveChain;
}

async function syncTasksNow() {
  try {
    // Keep the local backup
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));

    const {
      data: { user },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      console.error("No signed-in user:", userError);
      return;
    }

    // Tasks currently stored for this user
    const { data: existingTasks, error: fetchError } = await supabaseClient
      .from("tasks")
      .select("id")
      .eq("user_id", user.id);

    if (fetchError) {
      console.error("Could not check existing Supabase tasks:", fetchError);
      return;
    }

    // Tasks that were deleted in Plannr
    const currentIds = new Set(tasks.map((task) => task.id));

    const deletedIds = (existingTasks || [])
      .filter((task) => !currentIds.has(task.id))
      .map((task) => task.id);

    if (deletedIds.length > 0) {
      const { error: deleteError } = await supabaseClient
        .from("tasks")
        .delete()
        .eq("user_id", user.id)
        .in("id", deletedIds);

      if (deleteError) {
        console.error("Could not delete tasks from Supabase:", deleteError);
        return;
      }
    }

    // Save the tasks that still exist
    if (tasks.length > 0) {
      const rows = tasks.map((task) => ({
        id: task.id,
        user_id: user.id,
        title: task.title,
        duration_minutes: task.durationMinutes || 60,
        scheduled_start: task.scheduledStart
          ? new Date(task.scheduledStart).toISOString()
          : null,
        deadline: task.deadline || null,
        preferred_time: task.preferredTime || null,
        status: task.status || "scheduled",
        priority: task.priority || "medium",
        type: task.type || "task",
        group_id: task.groupId || null
      }));

      const { error } = await supabaseClient.from("tasks").upsert(rows);

      if (error) {
        console.error("Could not save tasks to Supabase:", error);
        return;
      }
    }

    console.log("Tasks synced with Supabase.");
  } catch (err) {
    console.error("Could not sync tasks:", err);
  }
}


/* ---------- 6. DATE HELPERS ---------- */

function startOfDay(date) {
  const d = new Date(date);

  d.setHours(0, 0, 0, 0);

  return d;
}

function isSameDay(a, b) {
  return formatDateISO(a) === formatDateISO(b);
}

function localDateFromISO(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);

  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function getStartOfWeek(date) {
  const d = new Date(date);

  const day = d.getDay();

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
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");

  return `${y}-${m}-${d}`;
}

function formatTimeInput(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");

  return `${h}:${min}`;
}

function formatLocalDateTime(date) {
  return `${formatDateISO(date)}T${formatTimeInput(date)}:00`;
}

function formatTimeShort(date) {
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatDayLabel(date) {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric"
  });
}

function formatWeekLabel(weekStart) {
  const weekEnd = addDays(weekStart, 6);

  const opts = { month: "short", day: "numeric" };

  return `${weekStart.toLocaleDateString(undefined, opts)} – ${weekEnd.toLocaleDateString(undefined, opts)}`;
}

function getTaskEnd(task) {
  if (!task.scheduledStart) return null;

  const start = new Date(task.scheduledStart);

  return new Date(start.getTime() + (task.durationMinutes || 60) * 60 * 1000);
}

function formatRelative(minutes) {
  const m = Math.max(0, Math.round(minutes));

  if (m < 1) return "now";
  if (m < 60) return `${m} min`;

  const h = Math.floor(m / 60);
  const rest = m % 60;

  if (h >= 24) {
    const d = Math.round(h / 24);

    return `${d} day${d === 1 ? "" : "s"}`;
  }

  return rest ? `${h}h ${rest}m` : `${h}h`;
}


/* ---------- 7. BLOCKED TIMES + HABITS ---------- */

// Blocked times (lunch, class, sleep) as intervals on a given day.
function blockedIntervalsForDay(day) {
  const dow = day.getDay();
  const out = [];

  settings.blocked.forEach((b) => {
    if (!b.days.includes(dow)) return;

    const start = startOfDay(day);
    start.setMinutes(parseHM(b.start));

    const end = startOfDay(day);
    end.setMinutes(parseHM(b.end));

    if (end > start) {
      out.push({ start: start.getTime(), end: end.getTime(), label: b.label });
    }
  });

  return out;
}

function overlapsBlocked(startMs, endMs) {
  if (!settings.blocked.length) return false;

  const firstDay = startOfDay(new Date(startMs));
  const lastDay = startOfDay(new Date(endMs - 1));

  for (let d = firstDay; d <= lastDay; d = addDays(d, 1)) {
    const hit = blockedIntervalsForDay(d).some(
      (b) => startMs < b.end && endMs > b.start
    );

    if (hit) return true;
  }

  return false;
}

function bucketForHour(hour) {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";

  return "evening";
}

/*
   Learns when you actually finish things.
   Looks at past tasks: finished vs. left undone, per part of the day.
   Returns a small score nudge per bucket, or null if there isn't
   enough history yet.
*/
function computeHabitProfile() {
  if (!settings.learn) return null;

  const now = new Date();

  const buckets = {
    morning: { done: 0, total: 0 },
    afternoon: { done: 0, total: 0 },
    evening: { done: 0, total: 0 }
  };

  let done = 0;
  let total = 0;

  tasks.forEach((t) => {
    if (t.type !== "task" || !t.scheduledStart) return;

    const start = new Date(t.scheduledStart);

    if (Number.isNaN(start.getTime()) || start >= now) return;

    const bucket = buckets[bucketForHour(start.getHours())];

    bucket.total++;
    total++;

    if (t.status === "done") {
      bucket.done++;
      done++;
    }
  });

  if (total < 8) return null;

  const overall = done / total;
  const profile = {};

  Object.keys(buckets).forEach((key) => {
    const b = buckets[key];

    profile[key] =
      b.total >= 4 ? clamp((b.done / b.total - overall) * 40, -15, 15) : 0;
  });

  return profile;
}


/* ---------- 8. SCHEDULING ---------- */

function findOpenSlot(task) {
  const now = new Date();

  const durationMinutes = Number(task?.durationMinutes || 60);

  if (
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0 ||
    durationMinutes > (DAY_END_HOUR - DAY_START_HOUR) * 60
  ) {
    return null;
  }

  const durationMs = durationMinutes * 60 * 1000;
  const bufferMs = settings.bufferMinutes * 60 * 1000;

  const deadline = task.deadline
    ? new Date(`${task.deadline}T23:59:59`)
    : addDays(now, 14);

  if (Number.isNaN(deadline.getTime()) || deadline < now) {
    return null;
  }

  const habit = computeHabitProfile();

  let cursorDay = startOfDay(now);

  const candidates = [];

  while (cursorDay <= deadline) {
    const dayISO = formatDateISO(cursorDay);

    if (task.excludeDates && task.excludeDates.has(dayISO)) {
      cursorDay = addDays(cursorDay, 1);
      continue;
    }

    const dayStart = new Date(cursorDay);
    dayStart.setHours(DAY_START_HOUR, 0, 0, 0);

    const dayEnd = new Date(cursorDay);
    dayEnd.setHours(DAY_END_HOUR, 0, 0, 0);

    for (
      let slotStart = dayStart.getTime();
      slotStart + durationMs <= dayEnd.getTime();
      slotStart += SLOT_MINUTES * 60 * 1000
    ) {
      const candidateStart = new Date(slotStart);
      const candidateEnd = new Date(slotStart + durationMs);

      if (candidateStart < now) continue;
      if (task.earliestStart && candidateStart < task.earliestStart) continue;
      if (candidateEnd > deadline) continue;

      // Keep a gap around other items, and stay out of blocked times.
      const paddedStart = new Date(candidateStart.getTime() - bufferMs);
      const paddedEnd = new Date(candidateEnd.getTime() + bufferMs);

      if (!isSlotFree(paddedStart, paddedEnd, task.id || null, true)) {
        continue;
      }

      candidates.push({
        start: candidateStart,
        score: scoreTimeSlot(candidateStart, candidateEnd, task, deadline, habit)
      });
    }

    cursorDay = addDays(cursorDay, 1);
  }

  if (candidates.length === 0) {
    return null;
  }

  // Highest score wins; ties go to the earlier slot.
  candidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return a.start.getTime() - b.start.getTime();
  });

  return formatLocalDateTime(candidates[0].start);
}


function scoreTimeSlot(candidateStart, candidateEnd, task, deadline, habit) {
  let score = 0;

  const now = new Date();
  const hour = candidateStart.getHours();
  const candidateDate = formatDateISO(candidateStart);

  const priority = ["low", "medium", "high"].includes(
    String(task.priority || "").toLowerCase()
  )
    ? String(task.priority || "").toLowerCase()
    : "medium";

  // Higher-priority tasks are more strongly favored for earlier slots.
  const priorityWeight = { low: 0.75, medium: 2, high: 4 }[priority];

  const hoursFromNow = Math.max(
    0,
    (candidateStart.getTime() - now.getTime()) / 3600000
  );

  // A closer deadline increases the cost of waiting.
  const hoursUntilDeadline =
    (deadline.getTime() - candidateEnd.getTime()) / 3600000;

  let deadlineMultiplier = 1;

  if (hoursUntilDeadline <= 24) {
    deadlineMultiplier = 2.5;
  } else if (hoursUntilDeadline <= 72) {
    deadlineMultiplier = 1.75;
  } else if (hoursUntilDeadline <= 168) {
    deadlineMultiplier = 1.25;
  }

  score -= hoursFromNow * priorityWeight * deadlineMultiplier;

  // Time-of-day preference: the task's own, else the user's focus time.
  // Always a bonus, never a hard rule.
  const pref = task.preferredTime || settings.focusTime || null;
  const prefBonus = task.preferredTime ? 35 : 20;

  if (pref === "morning" && hour >= 7 && hour < 12) {
    score += prefBonus;
  } else if (pref === "afternoon" && hour >= 12 && hour < 17) {
    score += prefBonus;
  } else if (pref === "evening" && hour >= 17 && hour < 22) {
    score += prefBonus;
  }

  // With no preference at all, gently avoid very early starts.
  if (!pref && hour < 9) {
    score -= 10;
  }

  // Avoid the very end of the day when possible.
  if (hour >= 21) {
    score -= 20;
  }

  // What you actually tend to finish.
  if (habit) {
    score += habit[bucketForHour(hour)] || 0;
  }

  // Sessions of the same task prefer different days.
  if (task.avoidDates && task.avoidDates.has(candidateDate)) {
    score -= 80;
  }

  const tasksThatDay = tasks.filter((existingTask) => {
    if (
      existingTask.id === task.id ||
      existingTask.status !== "scheduled" ||
      !existingTask.scheduledStart
    ) {
      return false;
    }

    const existingStart = new Date(existingTask.scheduledStart);

    return (
      !Number.isNaN(existingStart.getTime()) &&
      formatDateISO(existingStart) === candidateDate
    );
  });

  const existingMinutes = tasksThatDay.reduce(
    (total, existingTask) =>
      total +
      (Number.isFinite(Number(existingTask.durationMinutes)) &&
      Number(existingTask.durationMinutes) > 0
        ? Number(existingTask.durationMinutes)
        : 60),
    0
  );

  const projectedMinutes = existingMinutes + Number(task.durationMinutes || 60);

  // Increasing penalties for days that are already too full.
  if (projectedMinutes > 240) {
    score -= Math.min(30, (projectedMinutes - 240) / 12);
  }

  if (projectedMinutes > 360) {
    score -= Math.min(35, (projectedMinutes - 360) / 6);
  }

  if (projectedMinutes > 480) {
    score -= 40;
  }

  // The user's own daily limit.
  if (projectedMinutes > settings.maxHoursPerDay * 60) {
    score -= 60;
  }

  // Penalize awkwardly tight transitions with existing commitments.
  for (const existingTask of tasksThatDay) {
    const existingStart = new Date(existingTask.scheduledStart);

    const existingDuration =
      Number(existingTask.durationMinutes) > 0
        ? Number(existingTask.durationMinutes)
        : 60;

    const existingEnd = new Date(
      existingStart.getTime() + existingDuration * 60000
    );

    const gapBefore =
      (candidateStart.getTime() - existingEnd.getTime()) / 60000;

    const gapAfter =
      (existingStart.getTime() - candidateEnd.getTime()) / 60000;

    if (
      (gapBefore >= 0 && gapBefore < 15) ||
      (gapAfter >= 0 && gapAfter < 15)
    ) {
      score -= 18;
    }
  }

  return score;
}


/* ---------- CHECK FOR CONFLICTS ---------- */

function isSlotFree(
  candidateStart,
  candidateEnd,
  ignoreTaskId = null,
  respectBlocks = false
) {
  const startMs = new Date(candidateStart).getTime();
  const endMs = new Date(candidateEnd).getTime();

  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return false;
  }

  // Blocked times only constrain the automatic scheduler.
  // You can still place something there by hand.
  if (respectBlocks && overlapsBlocked(startMs, endMs)) {
    return false;
  }

  return tasks.every((task) => {
    if (
      (ignoreTaskId && task.id === ignoreTaskId) ||
      task.status !== "scheduled" ||
      !task.scheduledStart
    ) {
      return true;
    }

    const existingStartMs = new Date(task.scheduledStart).getTime();

    // Invalid existing entries can't be checked reliably.
    if (!Number.isFinite(existingStartMs)) {
      console.warn(
        "Plannr: Ignoring an item with an invalid start date:",
        task
      );
      return true;
    }

    const rawDuration = Number(task.durationMinutes);
    const durationMinutes =
      Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 60;

    const existingEndMs = existingStartMs + durationMinutes * 60000;

    // Adjacent items are allowed; actual overlap is not.
    return endMs <= existingStartMs || startMs >= existingEndMs;
  });
}

// Shared by the edit popup, drag to move, and resize.
function validateMove(task, newStart, newEnd) {
  if (Number.isNaN(newStart.getTime()) || Number.isNaN(newEnd.getTime())) {
    return "Please enter a valid date and time.";
  }

  const dayStart = new Date(newStart);
  dayStart.setHours(DAY_START_HOUR, 0, 0, 0);

  const dayEnd = new Date(newStart);
  dayEnd.setHours(DAY_END_HOUR, 0, 0, 0);

  if (newStart < dayStart || newEnd > dayEnd) {
    return `Keep it between ${fmtHour(DAY_START_HOUR)} and ${fmtHour(DAY_END_HOUR)} on the same day.`;
  }

  const startChanged =
    !task.scheduledStart ||
    new Date(task.scheduledStart).getTime() !== newStart.getTime();

  if (startChanged && newStart < new Date()) {
    return "You can't move something into the past.";
  }

  if (task.status === "scheduled" && !isSlotFree(newStart, newEnd, task.id)) {
    return "That time overlaps another task or event.";
  }

  return null;
}


/* ---------- 9. RENDERING ---------- */

function getHourHeight() {
  return (
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--hour-height"
      )
    ) || 56
  );
}

function renderWeekLabel() {
  const el = document.getElementById("week-label");

  if (!el) return;

  el.textContent =
    viewDays === 1 ? formatDayLabel(viewStart) : formatWeekLabel(viewStart);

  updateViewToggle();
}

function renderCalendar() {
  const grid = document.getElementById("calendar-grid");

  if (!grid) return;

  grid.innerHTML = "";

  const totalHours = DAY_END_HOUR - DAY_START_HOUR;
  const gutter = window.innerWidth < 720 ? 36 : 56;

  grid.style.gridTemplateColumns = `${gutter}px repeat(${viewDays}, 1fr)`;
  grid.style.gridTemplateRows = `auto repeat(${totalHours}, var(--hour-height))`;

  // Empty top-left corner
  const corner = document.createElement("div");
  corner.style.gridRow = "1";
  corner.style.gridColumn = "1";
  grid.appendChild(corner);

  const todayISO = formatDateISO(new Date());

  // Day headers
  for (let i = 0; i < viewDays; i++) {
    const dayDate = addDays(viewStart, i);

    const header = document.createElement("div");
    header.className = "day-header";

    const isToday = formatDateISO(dayDate) === todayISO;

    if (isToday) {
      header.classList.add("is-today");
    }

    header.style.gridColumn = i + 2;

    header.innerHTML = `
      <span class="day-name">
        ${dayDate.toLocaleDateString(undefined, { weekday: "short" })} ${dayDate.getDate()}
      </span>
      ${isToday ? '<span class="today-label">TODAY</span>' : ""}
    `;

    grid.appendChild(header);
  }

  // Hour labels
  for (let h = 0; h < totalHours; h++) {
    const label = document.createElement("div");
    label.className = "hour-label";
    label.style.gridRow = h + 2;
    label.textContent = fmtHour(DAY_START_HOUR + h);

    grid.appendChild(label);
  }

  // Day columns
  for (let i = 0; i < viewDays; i++) {
    const col = document.createElement("div");
    col.className = "day-column";
    col.style.gridColumn = i + 2;
    col.style.gridRow = `2 / span ${totalHours}`;
    col.dataset.date = formatDateISO(addDays(viewStart, i));

    grid.appendChild(col);
  }

  placeBlockedOnGrid();
  placeTasksOnGrid();
  renderNowLine();
  renderDashboard();

  runProactiveInsights();
}

function placeBlockedOnGrid() {
  if (!settings.blocked.length) return;

  const hourH = getHourHeight();
  const gridMinutes = (DAY_END_HOUR - DAY_START_HOUR) * 60;

  document.querySelectorAll(".day-column").forEach((col) => {
    const day = localDateFromISO(col.dataset.date);

    blockedIntervalsForDay(day).forEach((b) => {
      const s = new Date(b.start);
      const e = new Date(b.end);

      const startMin =
        s.getHours() * 60 + s.getMinutes() - DAY_START_HOUR * 60;
      const endMin = e.getHours() * 60 + e.getMinutes() - DAY_START_HOUR * 60;

      const from = Math.max(0, startMin);
      const to = Math.min(gridMinutes, endMin);

      if (to <= from) return;

      const el = document.createElement("div");
      el.className = "blocked-block";
      el.style.top = `${(from / 60) * hourH}px`;
      el.style.height = `${((to - from) / 60) * hourH}px`;
      el.innerHTML = `<span>${escapeHTML(b.label)}</span>`;

      col.appendChild(el);
    });
  });
}

function placeTasksOnGrid() {
  const columnsByDate = {};

  document.querySelectorAll(".day-column").forEach((col) => {
    columnsByDate[col.dataset.date] = col;
  });

  const hourH = getHourHeight();
  const gridMinutes = (DAY_END_HOUR - DAY_START_HOUR) * 60;

  tasks.forEach((task) => {
    if (!task.scheduledStart) {
      return;
    }

    const start = new Date(task.scheduledStart);

    if (Number.isNaN(start.getTime())) {
      return;
    }

    const col = columnsByDate[formatDateISO(start)];

    if (!col) {
      return;
    }

    const duration =
      Number(task.durationMinutes) > 0 ? Number(task.durationMinutes) : 60;

    const startMin =
      (start.getHours() - DAY_START_HOUR) * 60 + start.getMinutes();
    const endMin = startMin + duration;

    // Entirely outside the visible hours: nothing to draw.
    if (endMin <= 0 || startMin >= gridMinutes) {
      return;
    }

    // Clamp partially visible items to the grid.
    const clampedStart = Math.max(0, startMin);
    const clampedEnd = Math.min(gridMinutes, endMin);

    const topPx = (clampedStart / 60) * hourH;
    const heightPx = ((clampedEnd - clampedStart) / 60) * hourH;

    const colorIndex =
      (Math.abs(
        [...String(task.id)].reduce((sum, char) => sum + char.charCodeAt(0), 0)
      ) %
        6) +
      1;

    const block = document.createElement("div");

    block.className =
      "task-block event-color-" +
      colorIndex +
      (task.type === "event" ? " is-event" : "") +
      (task.status === "done" ? " is-done" : "");

    block.dataset.taskId = task.id;
    block.style.top = `${topPx}px`;
    block.style.height = `${Math.max(heightPx, 20)}px`;

    block.innerHTML = `
      <span class="task-title">${escapeHTML(task.title)}</span>
      <span class="task-time">${formatTimeShort(start)}</span>
      <span class="resize-handle" aria-hidden="true"></span>
    `;

    attachBlockInteractions(block, task);

    col.appendChild(block);
  });
}

function renderNowLine() {
  document.querySelectorAll(".now-line").forEach((n) => n.remove());

  const now = new Date();

  const col = document.querySelector(
    `.day-column[data-date="${formatDateISO(now)}"]`
  );

  if (!col) return;

  const minutes = now.getHours() * 60 + now.getMinutes() - DAY_START_HOUR * 60;

  if (minutes < 0 || minutes > (DAY_END_HOUR - DAY_START_HOUR) * 60) return;

  const line = document.createElement("div");
  line.className = "now-line";
  line.style.top = `${(minutes / 60) * getHourHeight()}px`;

  col.appendChild(line);
}


/* ---------- 10. DRAG TO MOVE / RESIZE ---------- */

let suppressClickUntil = 0;

function attachBlockInteractions(block, task) {
  block.addEventListener("click", () => {
    if (Date.now() < suppressClickUntil) return;

    openTaskModal(task.id);
  });

  block.addEventListener("pointerdown", (e) => {
    // Touch keeps normal scrolling; tap opens the popup instead.
    if (e.pointerType === "touch" || e.button !== 0) return;

    const mode = e.target.closest(".resize-handle") ? "resize" : "move";

    beginDrag(e, block, task, mode);
  });
}

function beginDrag(startEvent, block, task, mode) {
  const columns = [...document.querySelectorAll(".day-column")];

  if (!columns.length || !task.scheduledStart) return;

  const origStart = new Date(task.scheduledStart);
  const origDuration =
    Number(task.durationMinutes) > 0 ? Number(task.durationMinutes) : 60;

  const hourH = getHourHeight();
  const startX = startEvent.clientX;
  const startY = startEvent.clientY;
  const grabOffsetMin =
    ((startY - block.getBoundingClientRect().top) / hourH) * 60;

  const target = {
    date: formatDateISO(origStart),
    startMin: origStart.getHours() * 60 + origStart.getMinutes(),
    duration: origDuration
  };

  let moved = false;

  const onMove = (e) => {
    if (!moved) {
      if (Math.abs(e.clientX - startX) < 5 && Math.abs(e.clientY - startY) < 5) {
        return;
      }

      moved = true;
      block.classList.add("is-dragging");
      document.body.classList.add("is-dragging-block");
    }

    e.preventDefault();

    if (mode === "resize") {
      const colRect = block.parentElement.getBoundingClientRect();
      const rawEnd =
        DAY_START_HOUR * 60 + ((e.clientY - colRect.top) / hourH) * 60;

      const endMin = clamp(
        snapTo(rawEnd, 15),
        target.startMin + 15,
        DAY_END_HOUR * 60
      );

      target.duration = endMin - target.startMin;
      block.style.height = `${Math.max((target.duration / 60) * hourH, 20)}px`;

      return;
    }

    const col =
      columns.find((c) => {
        const r = c.getBoundingClientRect();

        return e.clientX >= r.left && e.clientX < r.right;
      }) || columns.find((c) => c.dataset.date === target.date);

    const colRect = col.getBoundingClientRect();

    const rawStart =
      DAY_START_HOUR * 60 +
      ((e.clientY - colRect.top) / hourH) * 60 -
      grabOffsetMin;

    const maxStart = Math.max(
      DAY_START_HOUR * 60,
      DAY_END_HOUR * 60 - target.duration
    );

    target.startMin = clamp(snapTo(rawStart, 15), DAY_START_HOUR * 60, maxStart);
    target.date = col.dataset.date;

    if (block.parentElement !== col) {
      col.appendChild(block);
    }

    block.style.top = `${((target.startMin - DAY_START_HOUR * 60) / 60) * hourH}px`;
  };

  const cleanup = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    document.body.classList.remove("is-dragging-block");
  };

  const onUp = () => {
    cleanup();

    if (!moved) return;

    suppressClickUntil = Date.now() + 250;

    commitMove(task, target);
  };

  const onCancel = () => {
    cleanup();

    if (moved) renderCalendar();
  };

  document.addEventListener("pointermove", onMove, { passive: false });
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
}

function commitMove(task, target) {
  const [y, m, d] = target.date.split("-").map(Number);

  const newStart = new Date(
    y,
    m - 1,
    d,
    Math.floor(target.startMin / 60),
    target.startMin % 60,
    0,
    0
  );

  const newEnd = new Date(newStart.getTime() + target.duration * 60000);

  const oldStart = new Date(task.scheduledStart);
  const oldDuration =
    Number(task.durationMinutes) > 0 ? Number(task.durationMinutes) : 60;

  if (
    newStart.getTime() === oldStart.getTime() &&
    target.duration === oldDuration
  ) {
    renderCalendar();
    return;
  }

  const error = validateMove(task, newStart, newEnd);

  if (error) {
    setStatus(error, true);
    renderCalendar();
    return;
  }

  task.scheduledStart = formatLocalDateTime(newStart);
  task.durationMinutes = target.duration;

  saveTasks();
  renderCalendar();

  let message = `Moved "${task.title}" to ${newStart.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  })}.`;

  if (task.deadline && newEnd > new Date(`${task.deadline}T23:59:59`)) {
    message += " Heads up: that's after its deadline.";
  }

  setStatus(message);
}


/* ---------- 11. STATUS + TOAST ---------- */

function setStatus(message, isError = false) {
  const el = document.getElementById("status-line");

  if (!el) return;

  el.textContent = message;

  el.classList.toggle("is-error", isError);
}

let toastTimer = null;

function showToast(
  message,
  { actionLabel = null, onAction = null, timeout = 5000 } = {}
) {
  const el = document.getElementById("plannr-toast");

  if (!el) return;

  clearTimeout(toastTimer);

  el.innerHTML = `
    <span class="toast-msg">${escapeHTML(message)}</span>
    ${actionLabel ? `<button type="button" class="toast-action">${escapeHTML(actionLabel)}</button>` : ""}
    <button type="button" class="toast-close" aria-label="Dismiss">×</button>
  `;

  el.classList.add("is-visible");

  const hide = () => el.classList.remove("is-visible");

  el.querySelector(".toast-close").onclick = hide;

  if (actionLabel && onAction) {
    el.querySelector(".toast-action").onclick = () => {
      hide();
      onAction();
    };
  }

  toastTimer = setTimeout(hide, timeout);
}

// Remove items, with an Undo button.
function deleteTasks(list, message) {
  const ids = new Set(list.map((t) => t.id));
  const removed = tasks.filter((t) => ids.has(t.id));

  if (!removed.length) return;

  tasks = tasks.filter((t) => !ids.has(t.id));

  saveTasks();
  renderCalendar();

  setStatus(message);

  showToast(message, {
    actionLabel: "Undo",
    timeout: 8000,
    onAction: async () => {
      tasks.push(...removed);

      await saveTasks();

      renderCalendar();
      setStatus("Restored.");
    }
  });
}


/* ---------- 12. COMPLETE TASK ---------- */

function toggleTaskDone(taskId) {
  const task = tasks.find((t) => t.id === taskId);

  if (!task) {
    return;
  }

  // Un-completing must not create an overlap.
  if (task.status === "done" && task.scheduledStart) {
    const start = new Date(task.scheduledStart);
    const end = new Date(
      start.getTime() + (task.durationMinutes || 60) * 60000
    );

    if (!isSlotFree(start, end, task.id)) {
      setStatus("Can't undo: that time is now taken. Try replanning it.", true);
      return;
    }
  }

  task.status = task.status === "done" ? "scheduled" : "done";

  saveTasks();

  renderCalendar();
}


/* ---------- 13. EDIT / DELETE POPUP ---------- */

let editingTaskId = null;

function openTaskModal(taskId) {
  const task = tasks.find((t) => t.id === taskId);
  const modal = document.getElementById("task-modal");

  if (!task || !modal) {
    return;
  }

  editingTaskId = taskId;

  const start = task.scheduledStart ? new Date(task.scheduledStart) : null;

  document.getElementById("edit-title").value = task.title;
  document.getElementById("edit-date").value = start ? formatDateISO(start) : "";
  document.getElementById("edit-start").value = start
    ? formatTimeInput(start)
    : "";
  document.getElementById("edit-duration").value = task.durationMinutes || 60;
  document.getElementById("edit-done-btn").textContent =
    task.status === "done" ? "Mark not done" : "Mark done";

  const groupBtn = document.getElementById("edit-delete-group-btn");
  const groupCount = task.groupId
    ? tasks.filter((t) => t.groupId === task.groupId).length
    : 0;

  if (groupBtn) {
    groupBtn.classList.toggle("is-hidden", groupCount < 2);
    groupBtn.textContent = `Delete all ${groupCount}`;
  }

  modal.classList.remove("is-hidden");
}

function closeTaskModal() {
  editingTaskId = null;

  const modal = document.getElementById("task-modal");

  if (modal) modal.classList.add("is-hidden");
}

function handleEditSubmit(event) {
  event.preventDefault();

  const task = tasks.find((t) => t.id === editingTaskId);

  if (!task) {
    closeTaskModal();
    return;
  }

  const title = document.getElementById("edit-title").value.trim();
  const date = document.getElementById("edit-date").value;
  const time = document.getElementById("edit-start").value;
  const duration = Number(document.getElementById("edit-duration").value);

  if (
    !title ||
    !date ||
    !time ||
    !Number.isFinite(duration) ||
    duration < 15 ||
    duration > (DAY_END_HOUR - DAY_START_HOUR) * 60
  ) {
    alert("Please fill in every field with valid values.");
    return;
  }

  const newStart = new Date(`${date}T${time}`);
  const newEnd = new Date(newStart.getTime() + duration * 60000);

  const error = validateMove(task, newStart, newEnd);

  if (error) {
    alert(error);
    return;
  }

  if (task.deadline && newEnd > new Date(`${task.deadline}T23:59:59`)) {
    if (!confirm("This is after the deadline. Save anyway?")) {
      return;
    }
  }

  task.title = title;
  task.durationMinutes = duration;
  task.scheduledStart = formatLocalDateTime(newStart);

  saveTasks();

  focusDate(newStart);

  closeTaskModal();
  setStatus(`Updated "${title}".`);
  renderWeekLabel();
  renderCalendar();
}

function handleEditDelete() {
  const task = tasks.find((t) => t.id === editingTaskId);

  if (!task) {
    closeTaskModal();
    return;
  }

  closeTaskModal();

  deleteTasks([task], `Deleted "${task.title}".`);
}

function handleEditDeleteGroup() {
  const task = tasks.find((t) => t.id === editingTaskId);

  if (!task || !task.groupId) return;

  const group = tasks.filter((t) => t.groupId === task.groupId);

  closeTaskModal();

  deleteTasks(group, `Deleted ${group.length} items.`);
}

function handleEditToggleDone() {
  const id = editingTaskId;

  closeTaskModal();

  if (id) {
    toggleTaskDone(id);
  }
}


/* ---------- 14. MANUAL EVENTS ---------- */

function handleAddEvent(event) {
  event.preventDefault();

  const title = document.getElementById("event-title").value.trim();
  const date = document.getElementById("event-date").value;
  const startTime = document.getElementById("event-start").value;
  const endTime = document.getElementById("event-end").value;

  if (!title || !date || !startTime || !endTime) {
    return;
  }

  const start = new Date(`${date}T${startTime}`);
  const end = new Date(`${date}T${endTime}`);

  if (end <= start) {
    alert("End time must be after start time.");
    return;
  }

  const durationMinutes = Math.round(
    (end.getTime() - start.getTime()) / (1000 * 60)
  );

  // Manual events can't be created in the past.
  if (start < new Date()) {
    alert("You cannot create an event in the past.");
    return;
  }

  if (!isSlotFree(start, end)) {
    alert("That time overlaps another task or event.");
    return;
  }

  tasks.push({
    id: makeId(),
    title,
    durationMinutes,
    deadline: null,
    preferredTime: null,
    status: "scheduled",
    priority: "medium",
    scheduledStart: formatLocalDateTime(start),
    type: "event"
  });

  saveTasks();

  focusDate(start);

  document.getElementById("event-form").reset();
  document.getElementById("event-modal").classList.add("is-hidden");

  renderWeekLabel();
  renderCalendar();
}


/* ============================================================
   15. PROACTIVE INSIGHTS
   ============================================================ */

function findInsightSlot(task) {
  return findOpenSlot({
    title: task.title,
    durationMinutes: task.durationMinutes || 60,
    deadline: task.deadline || null,
    preferredTime: task.preferredTime || null,
    status: "scheduled",
    priority: task.priority || "medium",
    scheduledStart: null,
    type: "task"
  });
}

function analyzeTaskDeadline(task) {
  if (task.type !== "task" || task.status === "done" || !task.deadline) {
    return null;
  }

  const now = new Date();
  const deadline = new Date(`${task.deadline}T23:59:59`);

  const scheduledStart = task.scheduledStart
    ? new Date(task.scheduledStart)
    : null;

  const scheduledEnd = scheduledStart ? getTaskEnd(task) : null;

  // Scheduled after the deadline
  if (scheduledEnd && scheduledEnd > deadline) {
    return {
      type: "deadline",
      severity: "high",
      task,
      message: `"${task.title}" is scheduled after its deadline.`
    };
  }

  // Not scheduled yet
  if (!scheduledStart) {
    const hoursUntilDeadline =
      (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursUntilDeadline <= 48) {
      return {
        type: "unscheduled",
        severity: hoursUntilDeadline <= 24 ? "high" : "medium",
        task,
        suggestedSlot: findInsightSlot(task),
        message: `"${task.title}" is due soon but isn't scheduled yet.`
      };
    }
  }

  return null;
}

function analyzeScheduleLoad(task) {
  if (!task || task.status === "done" || !task.scheduledStart) {
    return null;
  }

  const start = new Date(task.scheduledStart);
  const dayKey = start.toDateString();

  const totalMinutes = tasks
    .filter(
      (t) =>
        t.scheduledStart &&
        t.status !== "done" &&
        new Date(t.scheduledStart).toDateString() === dayKey
    )
    .reduce((sum, t) => sum + (Number(t.durationMinutes) || 0), 0);

  const weekday = start.toLocaleDateString([], { weekday: "long" });
  const hours = Math.round(totalMinutes / 60);
  const limit = settings.maxHoursPerDay * 60;

  if (totalMinutes >= Math.max(420, limit)) {
    return {
      type: "overloaded",
      severity: "high",
      task,
      totalMinutes,
      message: `Your ${weekday} is heavily packed with about ${hours} hours of scheduled work.`
    };
  }

  if (totalMinutes >= Math.min(300, limit * 0.75)) {
    return {
      type: "overloaded",
      severity: "medium",
      task,
      totalMinutes,
      message: `Your ${weekday} is getting pretty full with about ${hours} hours scheduled.`
    };
  }

  return null;
}

const dismissedInsights = new Set();

function getProactiveInsights() {
  const insights = [];

  tasks.forEach((task) => {
    const deadlineInsight = analyzeTaskDeadline(task);
    if (deadlineInsight) insights.push(deadlineInsight);
  });

  tasks.forEach((task) => {
    const scheduleInsight = analyzeScheduleLoad(task);
    if (scheduleInsight) insights.push(scheduleInsight);
  });

  const severityScore = { high: 3, medium: 2, low: 1 };

  insights.sort(
    (a, b) => (severityScore[b.severity] || 0) - (severityScore[a.severity] || 0)
  );

  return insights;
}

function insightKey(insight) {
  if (insight.type === "overloaded") {
    return `overloaded:${new Date(insight.task.scheduledStart).toDateString()}`;
  }

  return `${insight.type}:${insight.task.id}`;
}

function formatInsightTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit"
  });
}

function renderProactiveInsight() {
  let container = document.getElementById("proactive-insight");

  if (!container) {
    container = document.createElement("div");
    container.id = "proactive-insight";
    (document.querySelector("main") || document.body).prepend(container);
  }

  container.innerHTML = "";

  const insight = getProactiveInsights().find(
    (i) => !dismissedInsights.has(insightKey(i))
  );

  if (!insight) {
    container.style.display = "none";
    return;
  }

  const task = insight.task;
  const severityClass =
    insight.severity === "high" ? "insight-high" : "insight-medium";

  let actionHTML = "";

  if (insight.type === "overloaded") {
    actionHTML = `
      <div class="insight-suggestion">
        Consider moving some work to another day to keep your schedule manageable.
      </div>`;
  } else if (insight.suggestedSlot) {
    actionHTML = `
      <div class="insight-suggestion">
        I found an open time:
        <strong>${escapeHTML(formatInsightTime(insight.suggestedSlot))}</strong>
      </div>
      <button type="button" class="insight-action"
        data-insight-action="schedule" data-task-id="${escapeAttr(task.id)}">
        Schedule it
      </button>`;
  }

  container.innerHTML = `
    <div class="insight-card ${severityClass}">
      <div class="insight-content">
        <div class="insight-label">
          ${insight.severity === "high" ? "Needs attention" : "Plannr noticed something"}
        </div>
        <div class="insight-title">${escapeHTML(insight.message)}</div>
        ${actionHTML}
      </div>
      <button type="button" class="insight-dismiss"
        data-insight-action="dismiss" aria-label="Dismiss">×</button>
    </div>`;

  container.style.display = "block";

  const scheduleButton = container.querySelector(
    '[data-insight-action="schedule"]'
  );

  if (scheduleButton) {
    scheduleButton.addEventListener("click", () =>
      scheduleInsightTask(scheduleButton.dataset.taskId)
    );
  }

  container
    .querySelector('[data-insight-action="dismiss"]')
    .addEventListener("click", () => {
      dismissedInsights.add(insightKey(insight));
      container.style.display = "none";
    });
}

async function scheduleInsightTask(taskId) {
  const task = tasks.find((t) => t.id === taskId);

  if (!task) {
    return;
  }

  const suggestedSlot = findInsightSlot(task);

  if (!suggestedSlot) {
    setStatus(`I couldn't find an open time for "${task.title}".`, true);
    return;
  }

  // Update the EXISTING task. Do not create a duplicate.
  task.scheduledStart = suggestedSlot;
  task.status = "scheduled";

  await saveTasks();

  focusDate(new Date(suggestedSlot));

  setStatus(
    `Scheduled "${task.title}" for ${new Date(suggestedSlot).toLocaleString(
      undefined,
      { weekday: "long", hour: "numeric", minute: "2-digit" }
    )}.`
  );

  renderWeekLabel();
  renderCalendar();
}

function runProactiveInsights() {
  // Small delay so the insight doesn't appear before the calendar renders.
  setTimeout(() => {
    renderProactiveInsight();
  }, 100);
}


/* ---------- 16. DEADLINE PROGRESS ---------- */

function getDeadlineProgress() {
  const now = new Date();
  const today = startOfDay(now);
  const groups = new Map();

  tasks.forEach((t) => {
    if (t.type !== "task" || !t.deadline) return;

    const key = t.groupId || t.id;

    if (!groups.has(key)) {
      groups.set(key, {
        title: baseTitle(t.title),
        deadline: t.deadline,
        total: 0,
        done: 0,
        missed: 0,
        unscheduled: 0
      });
    }

    const g = groups.get(key);
    const minutes = Number(t.durationMinutes) > 0 ? Number(t.durationMinutes) : 60;

    g.total += minutes;

    if (t.status === "done") {
      g.done += minutes;
    } else if (!t.scheduledStart) {
      g.unscheduled += minutes;
    } else if (new Date(t.scheduledStart) < now) {
      g.missed += minutes;
    }
  });

  return [...groups.values()]
    .filter((g) => g.done < g.total)
    .map((g) => {
      const daysLeft = Math.round(
        (localDateFromISO(g.deadline) - today) / 86400000
      );

      let state = "ontrack";

      if (daysLeft < 0) state = "overdue";
      else if (g.missed > 0 || g.unscheduled > 0) state = "atrisk";

      return {
        ...g,
        daysLeft,
        state,
        percent: g.total ? Math.round((g.done / g.total) * 100) : 0
      };
    })
    .sort((a, b) => a.deadline.localeCompare(b.deadline));
}


/* ---------- 17. DASHBOARD (today + deadlines) ---------- */

function renderDashboard() {
  const el = document.getElementById("plannr-dashboard");

  if (!el) return;

  const now = new Date();

  const scheduled = tasks
    .filter((t) => t.scheduledStart && t.status === "scheduled")
    .map((t) => ({
      task: t,
      start: new Date(t.scheduledStart),
      end: getTaskEnd(t)
    }))
    .filter((x) => !Number.isNaN(x.start.getTime()))
    .sort((a, b) => a.start - b.start);

  const current = scheduled.find((x) => x.start <= now && x.end > now);
  const upcoming = scheduled.find((x) => x.start > now);
  const missedCount = getReplanCandidates("week", null, now).length;
  const todayRemaining = scheduled.filter(
    (x) => isSameDay(x.start, now) && x.end > now
  ).length;

  let nowHTML;

  if (current) {
    nowHTML = `
      <div class="dash-label">Happening now</div>
      <div class="dash-title">${escapeHTML(current.task.title)}</div>
      <div class="dash-sub">Until ${escapeHTML(formatTimeShort(current.end))}</div>
      <div class="dash-actions">
        <button type="button" class="dash-btn" data-dash="done" data-id="${escapeAttr(current.task.id)}">Mark done</button>
      </div>`;
  } else if (upcoming) {
    const mins = (upcoming.start - now) / 60000;
    const when = isSameDay(upcoming.start, now)
      ? formatTimeShort(upcoming.start)
      : upcoming.start.toLocaleString(undefined, {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit"
        });

    nowHTML = `
      <div class="dash-label">Next up</div>
      <div class="dash-title">${escapeHTML(upcoming.task.title)}</div>
      <div class="dash-sub">${escapeHTML(when)} · in ${escapeHTML(formatRelative(mins))}</div>
      <div class="dash-actions">
        <button type="button" class="dash-btn" data-dash="open" data-id="${escapeAttr(upcoming.task.id)}">Open</button>
      </div>`;
  } else {
    nowHTML = `
      <div class="dash-label">Today</div>
      <div class="dash-title">You're all clear</div>
      <div class="dash-sub">Nothing coming up. Add something above.</div>`;
  }

  let extraHTML = "";

  if (missedCount > 0) {
    extraHTML += `
      <div class="dash-actions">
        <button type="button" class="dash-btn dash-btn-accent" data-dash="replan-missed">
          Replan ${missedCount} missed
        </button>
      </div>`;
  }

  if (todayRemaining > 0) {
    extraHTML += `
      <div class="dash-late">
        <span>Running late?</span>
        <button type="button" class="dash-btn" data-dash="late" data-minutes="30">+30 min</button>
        <button type="button" class="dash-btn" data-dash="late" data-minutes="60">+1 hr</button>
        <button type="button" class="dash-btn" data-dash="late" data-minutes="120">+2 hr</button>
      </div>`;
  }

  const progress = getDeadlineProgress().slice(0, 4);

  const stateLabel = {
    overdue: "Overdue",
    atrisk: "At risk",
    ontrack: "On track"
  };

  const progressHTML = progress.length
    ? progress
        .map((p) => {
          const due =
            p.daysLeft < 0
              ? `${Math.abs(p.daysLeft)} day${Math.abs(p.daysLeft) === 1 ? "" : "s"} overdue`
              : p.daysLeft === 0
                ? "due today"
                : p.daysLeft === 1
                  ? "due tomorrow"
                  : `due in ${p.daysLeft} days`;

          return `
            <div class="dash-deadline">
              <div class="dash-deadline-head">
                <span class="dash-deadline-title">${escapeHTML(p.title)}</span>
                <span class="dash-badge is-${p.state}">${stateLabel[p.state]}</span>
              </div>
              <div class="dash-bar"><span style="width:${p.percent}%"></span></div>
              <div class="dash-sub">${escapeHTML(formatDuration(p.done))} of ${escapeHTML(formatDuration(p.total))} done · ${escapeHTML(due)}</div>
            </div>`;
        })
        .join("")
    : `<div class="dash-sub">No deadlines yet. Try "Study chemistry 6 hours before Friday".</div>`;

  const existing = el.querySelector("details");
  const wasOpen = existing ? existing.open : true;

  el.innerHTML = `
    <details class="dash" ${wasOpen ? "open" : ""}>
      <summary>Today &amp; deadlines</summary>
      <div class="dash-grid">
        <div class="dash-card">${nowHTML}${extraHTML}</div>
        <div class="dash-card">
          <div class="dash-label">Deadlines</div>
          ${progressHTML}
        </div>
      </div>
    </details>`;
}

function handleDashboardClick(e) {
  const btn = e.target.closest("[data-dash]");

  if (!btn) return;

  const action = btn.dataset.dash;

  if (action === "done") {
    toggleTaskDone(btn.dataset.id);
  } else if (action === "open") {
    const task = tasks.find((t) => t.id === btn.dataset.id);

    if (task && task.scheduledStart) {
      focusDate(new Date(task.scheduledStart));
      renderWeekLabel();
      renderCalendar();
      openTaskModal(task.id);
    }
  } else if (action === "replan-missed") {
    runReplan({ scope: "week" });
  } else if (action === "late") {
    const minutes = Number(btn.dataset.minutes) || 30;

    runReplan({
      scope: "today",
      earliest: computeEarliestStart({ shiftMinutes: minutes })
    });
  }
}


/* ---------- 18. ANSWER CARD ---------- */

function showAnswer(title, lines) {
  const el = document.getElementById("plannr-answer");

  if (!el) return;

  const body = (lines || [])
    .map((line) => `<li>${escapeHTML(line)}</li>`)
    .join("");

  el.innerHTML = `
    <div class="insight-card insight-medium answer-card">
      <div class="insight-content">
        <div class="insight-label">Plannr</div>
        <div class="insight-title">${escapeHTML(title)}</div>
        ${body ? `<ul>${body}</ul>` : ""}
      </div>
      <button type="button" class="insight-dismiss" data-answer="dismiss" aria-label="Dismiss">×</button>
    </div>`;

  el.style.display = "block";
}

function clearAnswer() {
  const el = document.getElementById("plannr-answer");

  if (el) {
    el.innerHTML = "";
    el.style.display = "none";
  }
}


/* ---------- 19. FIND EXISTING TASK ---------- */

function findTaskByTitle(targetTitle) {
  if (typeof targetTitle !== "string" || !targetTitle.trim()) {
    return null;
  }

  const target = targetTitle.toLowerCase().trim();

  // Only scheduled tasks with valid titles, earliest first so that
  // "finished chemistry" picks the next session, not a random one.
  const scheduledTasks = tasks
    .filter(
      (task) =>
        task &&
        task.status === "scheduled" &&
        typeof task.title === "string" &&
        task.title.trim() !== ""
    )
    .sort(
      (a, b) =>
        new Date(a.scheduledStart || 0).getTime() -
        new Date(b.scheduledStart || 0).getTime()
    );

  // 1. Exact title match
  let match = scheduledTasks.find(
    (task) => task.title.toLowerCase().trim() === target
  );

  if (match) {
    return match;
  }

  // 2. Partial title match
  match = scheduledTasks.find((task) => {
    const title = task.title.toLowerCase().trim();

    return title.includes(target) || target.includes(title);
  });

  if (match) {
    return match;
  }

  // 3. Match meaningful words
  const ignoredWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "into",
    "move",
    "reschedule",
    "schedule",
    "delete",
    "remove",
    "task",
    "event",
    "please",
    "my",
    "to"
  ]);

  const words = target
    .split(/\s+/)
    .filter((word) => word.length > 2 && !ignoredWords.has(word));

  if (words.length === 0) {
    return null;
  }

  let bestMatch = null;
  let bestScore = 0;

  scheduledTasks.forEach((task) => {
    const title = task.title.toLowerCase();
    let score = 0;

    words.forEach((word) => {
      if (title.includes(word)) {
        score++;
      }
    });

    if (score > bestScore) {
      bestScore = score;
      bestMatch = task;
    }
  });

  return bestScore > 0 ? bestMatch : null;
}


/* ---------- 20. RESCHEDULE / DELETE / COMPLETE (AI) ---------- */

function rescheduleTask(parsed) {
  if (!parsed || !parsed.targetTitle) {
    setStatus("Please specify which task to reschedule.", true);
    return false;
  }

  const task = findTaskByTitle(parsed.targetTitle);

  if (!task) {
    setStatus("Task not found on your calendar.", true);
    return false;
  }

  const oldStart = new Date(task.scheduledStart);

  if (Number.isNaN(oldStart.getTime())) {
    setStatus("This task has an invalid scheduled time.", true);
    return false;
  }

  // Keep the original date / time if none was provided.
  const newDate = parsed.date || formatDateISO(oldStart);
  const newTime = parsed.time || formatTimeInput(oldStart);

  if (
    typeof newDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(newDate) ||
    typeof newTime !== "string" ||
    !/^\d{2}:\d{2}$/.test(newTime)
  ) {
    setStatus("Please provide a valid date and time.", true);
    return false;
  }

  const [year, month, day] = newDate.split("-").map(Number);
  const [hour, minute] = newTime.split(":").map(Number);

  const newStart = new Date(year, month - 1, day, hour, minute, 0, 0);

  // Reject impossible dates such as February 31.
  if (
    newStart.getFullYear() !== year ||
    newStart.getMonth() !== month - 1 ||
    newStart.getDate() !== day
  ) {
    setStatus("That date does not exist.", true);
    return false;
  }

  const duration = Number(task.durationMinutes);

  if (!Number.isFinite(duration) || duration <= 0) {
    setStatus("This task has an invalid duration.", true);
    return false;
  }

  const newEnd = new Date(newStart.getTime() + duration * 60 * 1000);

  if (newStart < new Date()) {
    setStatus("I can't move a task into the past.", true);
    return false;
  }

  if (!isSlotFree(newStart, newEnd, task.id)) {
    setStatus("That time overlaps another task or event.", true);
    return false;
  }

  // Update the existing task without changing its ID.
  task.scheduledStart = formatLocalDateTime(newStart);

  saveTasks();

  focusDate(newStart);

  setStatus("Task rescheduled successfully.");

  renderWeekLabel();
  renderCalendar();

  return true;
}

function deleteTaskWithAI(parsed) {
  if (!parsed || !parsed.targetTitle) {
    setStatus("Please specify which task to delete.", true);
    return false;
  }

  const task = findTaskByTitle(parsed.targetTitle);

  if (!task) {
    setStatus(`I couldn't find "${parsed.targetTitle}" on your calendar.`, true);
    return false;
  }

  // "delete write essay (2/4)" or "delete session 2" means just that one.
  const namesOneSession =
    /\(\s*\d+\s*\/\s*\d+\s*\)|\b(session|part)\s*\d+\b/i.test(
      parsed.targetTitle
    );

  // Part of a group (split task or repeating event): remove all of it.
  if (task.groupId && !namesOneSession) {
    const group = tasks.filter((t) => t.groupId === task.groupId);

    deleteTasks(
      group,
      `Deleted all ${group.length} of "${baseTitle(task.title)}".`
    );

    return true;
  }

  deleteTasks([task], `Deleted "${task.title}".`);

  return true;
}

function completeTaskWithAI(parsed) {
  if (!parsed || !parsed.targetTitle) {
    setStatus("Please tell me which task you finished.", true);
    return false;
  }

  const task = findTaskByTitle(parsed.targetTitle);

  if (!task) {
    setStatus(`I couldn't find "${parsed.targetTitle}" on your calendar.`, true);
    return false;
  }

  task.status = "done";

  saveTasks();

  setStatus(`Nice work! Marked "${task.title}" as done.`);

  renderCalendar();

  return true;
}


/* ---------- 21. SPLITTING LONG TASKS INTO SESSIONS ---------- */

const SPLIT_THRESHOLD_MINUTES = 240; // longer than 4h gets split automatically
const DEFAULT_SESSION_MINUTES = 120;
const MAX_SESSION_MINUTES = 240;
const MAX_SESSIONS = 14;
const MIN_SESSION_MINUTES = 60;

function shouldSplit(parsed) {
  const total = Number(parsed.durationMinutes) || 60;
  const dayWindow = (DAY_END_HOUR - DAY_START_HOUR) * 60;
  const asked = Number(parsed.sessions) >= 2;

  // An exact date + time that fits in one day stays a single block.
  if (parsed.date && parsed.time && total <= dayWindow && !asked) {
    return false;
  }

  if (asked) return true;

  if (
    Number(parsed.sessionMinutes) > 0 &&
    Number(parsed.sessionMinutes) < total
  ) {
    return true;
  }

  return total > SPLIT_THRESHOLD_MINUTES;
}

function planSessionLengths(total, { sessions, sessionMinutes } = {}) {
  const dayWindow = (DAY_END_HOUR - DAY_START_HOUR) * 60;
  const maxSize = Math.min(MAX_SESSION_MINUTES, dayWindow);

  let size;

  if (Number(sessionMinutes) > 0) {
    size = Math.round(Number(sessionMinutes) / 30) * 30;
  } else if (Number(sessions) >= 2) {
    size = Math.ceil(total / Number(sessions) / 30) * 30;
  } else {
    size = DEFAULT_SESSION_MINUTES;
  }

  // Never go below the minimum, even if the AI asked for it.
  size = Math.min(maxSize, Math.max(MIN_SESSION_MINUTES, size));
  size = Math.min(size, total);

  const lengths = [];
  let left = total;

  while (left > 0) {
    const len = Math.min(size, left);
    lengths.push(len);
    left -= len;
  }

  // Fold a short leftover into the previous session
  if (
    lengths.length > 1 &&
    lengths[lengths.length - 1] < MIN_SESSION_MINUTES
  ) {
    const extra = lengths.pop();
    lengths[lengths.length - 1] += extra;
  }

  return lengths.length > MAX_SESSIONS ? null : lengths;
}

/*
   Places work as one or more sessions, one at a time so each
   placement is visible to the next. All or nothing.
   Used by AI commands and by syllabus import.
*/
function placeSessions({
  title,
  lengths,
  deadline,
  storedDeadline = null,
  preferredTime = null,
  priority = "medium"
}) {
  const multiple = lengths.length > 1;
  const groupId = multiple ? makeId() : null;
  const usedDates = new Set();
  const created = [];

  for (const length of lengths) {
    const slotTask = {
      title,
      durationMinutes: length,
      deadline,
      preferredTime,
      status: "scheduled",
      priority,
      scheduledStart: null,
      type: "task"
    };

    // First choice: a day with no session yet.
    let slot = findOpenSlot({ ...slotTask, excludeDates: usedDates });

    // Not enough free days: allow a repeat day, with a scoring penalty.
    if (!slot) {
      slot = findOpenSlot({ ...slotTask, avoidDates: usedDates });
    }

    if (!slot) {
      // All or nothing: undo the sessions placed so far
      const ids = new Set(created.map((t) => t.id));

      tasks = tasks.filter((t) => !ids.has(t.id));

      return { ok: false, created: [] };
    }

    const task = {
      id: makeId(),
      groupId,
      title,
      durationMinutes: length,
      deadline: storedDeadline,
      preferredTime,
      status: "scheduled",
      priority,
      scheduledStart: slot,
      type: "task"
    };

    tasks.push(task);
    created.push(task);
    usedDates.add(slot.slice(0, 10));
  }

  if (multiple) {
    // Number the sessions in calendar order: "Study chemistry (1/3)"
    created.sort(
      (a, b) => new Date(a.scheduledStart) - new Date(b.scheduledStart)
    );

    created.forEach((task, i) => {
      task.title = `${title} (${i + 1}/${created.length})`;
    });
  }

  return { ok: true, created };
}

async function createSplitTasks(parsed, rawText) {
  const total = parsed.durationMinutes || 60;
  const lengths = planSessionLengths(total, parsed);

  if (!lengths) {
    setStatus(
      `That would need more than ${MAX_SESSIONS} sessions. Try a smaller total.`,
      true
    );
    return false;
  }

  // Not worth splitting after all: use the normal single-block path.
  if (lengths.length < 2) {
    return createTask(parsed, rawText, false);
  }

  const deadline = parsed.deadline || parsed.date || null;

  const result = placeSessions({
    title: parsed.title || rawText,
    lengths,
    deadline,
    storedDeadline: parsed.deadline || null,
    preferredTime: parsed.preferredTime || null,
    priority: parsed.priority || "medium"
  });

  if (!result.ok) {
    setStatus(
      `I couldn't fit all ${formatDuration(total)} ${
        deadline ? "before that deadline" : "in the next two weeks"
      }. Try a later deadline or a smaller total.`,
      true
    );
    return false;
  }

  await saveTasks();

  focusDate(new Date(result.created[0].scheduledStart));

  const when = result.created
    .map((task) =>
      new Date(task.scheduledStart).toLocaleString(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit"
      })
    )
    .join(", ");

  setStatus(
    `Scheduled ${result.created.length} sessions (${formatDuration(total)} total): ${when}.`
  );

  renderWeekLabel();
  renderCalendar();

  return true;
}


/* ---------- 22. REPEATING EVENTS ---------- */

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function describeRepeat(parsed) {
  if (parsed.repeat === "daily") return "every day";
  if (parsed.repeat === "weekdays") return "every weekday";
  if (parsed.repeat === "monthly") return "every month";

  if (parsed.repeatDays && parsed.repeatDays.length) {
    return `every ${parsed.repeatDays.map((d) => DAY_NAMES[d]).join(", ")}`;
  }

  return "every week";
}

async function createRecurring(parsed, rawText) {
  const duration = parsed.durationMinutes || 60;

  if (duration > (DAY_END_HOUR - DAY_START_HOUR) * 60) {
    setStatus("That's longer than one day's planning window.", true);
    return false;
  }

  const now = new Date();
  const first = parsed.date ? localDateFromISO(parsed.date) : startOfDay(now);

  const horizonDays = parsed.repeat === "monthly" ? 180 : 56;
  const until = parsed.repeatUntil
    ? localDateFromISO(parsed.repeatUntil)
    : addDays(first, horizonDays);

  // Pick a time of day: the one given, or the best open time near the start.
  let timeOfDay = parsed.time || null;

  if (!timeOfDay) {
    const slot = findOpenSlot({
      title: parsed.title || rawText,
      durationMinutes: duration,
      deadline: formatDateISO(addDays(first, 14)),
      earliestStart: first,
      preferredTime: parsed.preferredTime || null,
      status: "scheduled",
      priority: parsed.priority || "medium",
      scheduledStart: null,
      type: "event"
    });

    if (!slot) {
      setStatus("Couldn't find a good time for that. Try giving a time.", true);
      return false;
    }

    timeOfDay = slot.slice(11, 16);
  }

  const [hh, mm] = timeOfDay.split(":").map(Number);

  const matches = (d) => {
    if (parsed.repeat === "daily") return true;
    if (parsed.repeat === "weekdays") return d.getDay() >= 1 && d.getDay() <= 5;

    if (parsed.repeat === "monthly") {
      return d.getDate() === first.getDate();
    }

    // weekly
    if (parsed.repeatDays && parsed.repeatDays.length) {
      return parsed.repeatDays.includes(d.getDay());
    }

    return d.getDay() === first.getDay();
  };

  const groupId = makeId();
  const title = parsed.title || rawText;
  const created = [];
  let skipped = 0;

  for (
    let d = new Date(first), guard = 0;
    d <= until && created.length < 60 && guard < 400;
    d = addDays(d, 1), guard++
  ) {
    if (!matches(d)) continue;

    const start = new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      hh,
      mm,
      0,
      0
    );

    const end = new Date(start.getTime() + duration * 60000);

    if (start < now) continue;

    if (!isSlotFree(start, end)) {
      skipped++;
      continue;
    }

    const item = {
      id: makeId(),
      groupId,
      title,
      durationMinutes: duration,
      deadline: null,
      preferredTime: null,
      status: "scheduled",
      priority: parsed.priority || "medium",
      scheduledStart: formatLocalDateTime(start),
      type: "event"
    };

    tasks.push(item);
    created.push(item);
  }

  if (!created.length) {
    setStatus("I couldn't find any open times for that.", true);
    return false;
  }

  await saveTasks();

  focusDate(new Date(created[0].scheduledStart));

  setStatus(
    `Added "${title}" ${describeRepeat(parsed)} at ${formatTimeShort(
      new Date(created[0].scheduledStart)
    )} (${created.length} times${skipped ? `, skipped ${skipped} that overlapped` : ""}).`
  );

  renderWeekLabel();
  renderCalendar();

  return true;
}


/* ---------- 23. CREATE TASK ---------- */

async function createTask(parsed, rawText, allowSplit = true) {
  const durationMinutes = parsed.durationMinutes || 60;

  // Long or explicitly split work becomes several sessions.
  if (allowSplit && shouldSplit(parsed)) {
    return createSplitTasks(parsed, rawText);
  }

  // The calendar only shows DAY_START_HOUR to DAY_END_HOUR.
  if (durationMinutes > (DAY_END_HOUR - DAY_START_HOUR) * 60) {
    setStatus(
      `That's longer than one day's planning window (${DAY_END_HOUR - DAY_START_HOUR} hours). Try a shorter block.`,
      true
    );
    return false;
  }

  /*
     If the AI gave an exact date AND time, use that exact time.
     Otherwise use our scheduling algorithm.
  */

  let scheduledStart = null;

  if (parsed.date && parsed.time) {
    const exactStart = new Date(`${parsed.date}T${parsed.time}`);

    const exactEnd = new Date(
      exactStart.getTime() + durationMinutes * 60 * 1000
    );

    if (exactStart < new Date()) {
      setStatus("That time has already passed. Try a future time.", true);
      return false;
    }

    if (!isSlotFree(exactStart, exactEnd)) {
      setStatus("That time overlaps another task or event.", true);
      return false;
    }

    scheduledStart = formatLocalDateTime(exactStart);
  } else {
    const taskForScheduling = {
      title: parsed.title || rawText,
      durationMinutes,
      deadline: parsed.deadline || null,
      preferredTime: parsed.preferredTime || null,
      status: "scheduled",
      priority: parsed.priority || "medium",
      scheduledStart: null,
      type: "task"
    };

    // A date without a time means "that day", so search only that day.
    if (parsed.date && !parsed.time) {
      taskForScheduling.earliestStart = new Date(`${parsed.date}T00:00:00`);
      taskForScheduling.deadline = parsed.date;
    }

    scheduledStart = findOpenSlot(taskForScheduling);

    if (!scheduledStart) {
      setStatus(
        "Couldn't find an open future slot before that deadline.",
        true
      );
      return false;
    }
  }

  tasks.push({
    id: makeId(),
    title: parsed.title || rawText,
    durationMinutes,
    deadline: parsed.deadline || null,
    preferredTime: parsed.preferredTime || null,
    status: "scheduled",
    priority: parsed.priority || "medium",
    scheduledStart,
    type: "task"
  });

  await saveTasks();

  focusDate(new Date(scheduledStart));

  setStatus(
    `Scheduled for ${new Date(scheduledStart).toLocaleString(undefined, {
      weekday: "long",
      hour: "numeric",
      minute: "2-digit"
    })}.`
  );

  renderWeekLabel();
  renderCalendar();

  return true;
}


/* ---------- 24. AI API ---------- */

// 429 is deliberately NOT retried: from our own API it means "rate limited".
const RETRYABLE_STATUS = [503, 504];

async function waitBeforeRetry(attempt, onRetry) {
  if (onRetry) onRetry(attempt);

  const delay = 700 * 2 ** (attempt - 1) + Math.random() * 300;

  await new Promise((resolve) => setTimeout(resolve, delay));
}

async function callParseAPI(payload, { onRetry = null, maxAttempts = 2 } = {}) {
  const {
    data: { session }
  } = await supabaseClient.auth.getSession();

  if (!session) {
    const e = new Error("Please sign in again.");
    e.kind = "auth";
    throw e;
  }

  const body = JSON.stringify({
    today: formatDateISO(new Date()),
    nowTime: formatTimeInput(new Date()),
    settings: {
      dayStartHour: DAY_START_HOUR,
      dayEndHour: DAY_END_HOUR
    },
    ...payload
  });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;

    try {
      response = await fetch("/api/parse-task", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`
        },
        body
      });
    } catch (networkErr) {
      if (attempt === maxAttempts) {
        const e = new Error("Network error. Check your connection.");
        e.kind = "network";
        throw e;
      }

      await waitBeforeRetry(attempt, onRetry);
      continue;
    }

    // Some gateway errors aren't JSON, so parse defensively.
    let data = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.ok) {
      if (!data || typeof data !== "object") {
        const e = new Error("The AI returned an invalid response.");
        e.kind = "invalid";
        throw e;
      }

      return data;
    }

    if (response.status === 401) {
      const e = new Error("Session expired.");
      e.kind = "auth";
      throw e;
    }

    if (response.status === 403) {
      const e = new Error(data?.error || "Not allowed.");
      e.kind = "forbidden";
      throw e;
    }

    if (response.status === 413) {
      const e = new Error(data?.error || "That's too long.");
      e.kind = "too_long";
      throw e;
    }

    if (response.status === 429) {
      const e = new Error(data?.error || "Too many requests.");
      e.kind = "rate_limit";
      throw e;
    }

    const retryable = RETRYABLE_STATUS.includes(response.status);

    if (retryable && attempt < maxAttempts) {
      await waitBeforeRetry(attempt, onRetry);
      continue;
    }

    const e = new Error(data?.error || "AI task parsing failed.");
    e.kind = retryable ? "busy" : "bad_request";
    throw e;
  }
}

function parseTaskWithAI(rawText, onRetry) {
  return callParseAPI(
    { text: rawText, features: AI_FEATURES },
    { onRetry }
  );
}

function describeAIError(err) {
  switch (err && err.kind) {
    case "busy":
      return "The AI is overloaded right now. Please try again in a minute.";
    case "network":
      return "Network error. Check your connection and try again.";
    case "auth":
      return "Your session expired. Please sign in again.";
    case "forbidden":
      return err.message || "You don't have access to do that.";
    case "too_long":
      return err.message || "That's too long. Please shorten it.";
    case "rate_limit":
      return err.message || "You're going a bit fast. Please wait a bit and try again.";
    default:
      return "Something went wrong reading that. Try rephrasing it.";
  }
}


/* ============================================================
   25. SMART AUTO-RESCHEDULING
   ============================================================ */

const MISSED_LOOKBACK_DAYS = 7;

let lastReplanUndo = null; // [{ id, scheduledStart }]
let missedBannerDismissed = false;

function getReplanContainer() {
  let el = document.getElementById("replan-banner");

  if (!el) {
    el = document.createElement("div");
    el.id = "replan-banner";
    (document.querySelector("main") || document.body).prepend(el);
  }

  return el;
}

function clearReplanBanner() {
  const el = document.getElementById("replan-banner");

  if (el) {
    el.innerHTML = "";
    el.style.display = "none";
  }
}

function computeEarliestStart(parsed) {
  const now = new Date();
  let earliest = new Date(now);

  const shift = Number(parsed.shiftMinutes);

  if (Number.isFinite(shift) && shift > 0) {
    earliest = new Date(now.getTime() + shift * 60000);
  }

  if (
    typeof parsed.availableFrom === "string" &&
    /^\d{2}:\d{2}$/.test(parsed.availableFrom)
  ) {
    const [h, m] = parsed.availableFrom.split(":").map(Number);
    const fromTime = new Date(now);

    fromTime.setHours(h, m, 0, 0);

    if (fromTime > earliest) {
      earliest = fromTime;
    }
  }

  return earliest;
}

function getReplanCandidates(scope, targetTask, earliest) {
  if (scope === "task") {
    return targetTask ? [targetTask] : [];
  }

  const now = new Date();
  const lookbackStart = addDays(now, -MISSED_LOOKBACK_DAYS);
  const todayKey = formatDateISO(now);

  return tasks.filter((task) => {
    // Events (practice, appointments) never move on their own.
    if (
      task.type !== "task" ||
      task.status !== "scheduled" ||
      !task.scheduledStart
    ) {
      return false;
    }

    const start = new Date(task.scheduledStart);

    if (Number.isNaN(start.getTime()) || start >= earliest) {
      return false;
    }

    if (scope === "today") {
      return formatDateISO(start) === todayKey;
    }

    // "week": anything unfinished from the last few days
    return start >= lookbackStart;
  });
}

// Deadline first, then priority, then original time.
function compareForReplan(a, b) {
  const deadlineMs = (t) =>
    t.deadline ? new Date(`${t.deadline}T23:59:59`).getTime() : Infinity;

  const priorityRank = { high: 0, medium: 1, low: 2 };

  const da = deadlineMs(a);
  const db = deadlineMs(b);

  if (da !== db) {
    return da < db ? -1 : 1;
  }

  const pa = priorityRank[a.priority] ?? 1;
  const pb = priorityRank[b.priority] ?? 1;

  if (pa !== pb) {
    return pa - pb;
  }

  return new Date(a.scheduledStart) - new Date(b.scheduledStart);
}

function replanTasks(candidates, earliest, excludeDates = null) {
  const ordered = [...candidates].sort(compareForReplan);

  // Remember where everything was, for Undo
  const undo = ordered.map((task) => ({
    id: task.id,
    scheduledStart: task.scheduledStart
  }));

  const originals = new Map(undo.map((u) => [u.id, u.scheduledStart]));

  // Free up their old slots so they don't block each other
  ordered.forEach((task) => {
    task.scheduledStart = null;
  });

  const now = new Date();
  const moved = [];
  const failed = [];

  // Place them one by one with the EXISTING scheduler.
  // Each placement is visible to the next one.
  ordered.forEach((task) => {
    const slot = findOpenSlot({
      ...task,
      earliestStart: earliest,
      excludeDates
    });

    if (slot) {
      task.scheduledStart = slot;
      moved.push(task);
      return;
    }

    // Couldn't fit it: put it back and report why
    task.scheduledStart = originals.get(task.id);

    const deadlinePassed =
      task.deadline && new Date(`${task.deadline}T23:59:59`) < now;

    failed.push({
      task,
      reason: deadlinePassed
        ? "its deadline has passed"
        : "no open time before its deadline"
    });
  });

  return { moved, failed, undo };
}

// Shared tail of every "move things around" action.
async function finishMove({ moved, failed, undo, headline = null }) {
  missedBannerDismissed = true;

  const movedIds = new Set(moved.map((task) => task.id));

  lastReplanUndo = moved.length
    ? undo.filter((u) => movedIds.has(u.id))
    : null;

  await saveTasks();

  if (moved.length) {
    const firstStart = moved
      .map((task) => new Date(task.scheduledStart))
      .sort((a, b) => a - b)[0];

    focusDate(firstStart);
  }

  renderWeekLabel();
  renderCalendar();

  showReplanSummary(moved, failed, headline);

  setStatus(
    moved.length
      ? `Moved ${moved.length} task${moved.length === 1 ? "" : "s"}.`
      : "I couldn't fit those tasks in.",
    moved.length === 0
  );
}

async function runReplan({ scope, targetTask = null, earliest = new Date() }) {
  const candidates = getReplanCandidates(scope, targetTask, earliest);

  if (candidates.length === 0) {
    setStatus("Nothing needs replanning. You're all caught up.");
    clearReplanBanner();
    return false;
  }

  const result = replanTasks(candidates, earliest);

  await finishMove(result);

  return true;
}

async function replanWithAI(parsed) {
  const earliest = computeEarliestStart(parsed);

  const scope = ["task", "today", "week"].includes(parsed.replanScope)
    ? parsed.replanScope
    : parsed.targetTitle
      ? "task"
      : "today";

  let targetTask = null;

  if (scope === "task") {
    targetTask = findTaskByTitle(parsed.targetTitle);

    if (!targetTask) {
      setStatus(
        `I couldn't find "${parsed.targetTitle || "that task"}" on your calendar.`,
        true
      );
      return false;
    }
  }

  return runReplan({ scope, targetTask, earliest });
}

// "Clear my Friday": move every task off a day (events stay put).
async function clearDayWithAI(parsed) {
  const now = new Date();
  const day = parsed.date ? localDateFromISO(parsed.date) : startOfDay(now);
  const dayEnd = addDays(day, 1);
  const label = formatDayLabel(day);

  if (dayEnd <= now) {
    setStatus("That day is already over.", true);
    return false;
  }

  const onDay = tasks.filter(
    (t) =>
      t.status === "scheduled" &&
      t.scheduledStart &&
      isSameDay(new Date(t.scheduledStart), day) &&
      new Date(t.scheduledStart) >= now
  );

  const candidates = onDay.filter((t) => t.type === "task");
  const events = onDay.filter((t) => t.type !== "task");

  if (!candidates.length) {
    setStatus(
      events.length
        ? `Nothing to move on ${label}. Fixed events stay where they are.`
        : `${label} is already clear.`
    );
    return true;
  }

  const exclude = new Set([formatDateISO(day)]);

  // First choice: push things later (or to the day the user named).
  let earliest = parsed.targetDate ? localDateFromISO(parsed.targetDate) : dayEnd;

  if (earliest < now) earliest = now;

  const first = replanTasks(candidates, earliest, exclude);

  let moved = first.moved;
  let failed = first.failed;

  // Anything that can't go later (deadline) may go earlier instead.
  if (failed.length && !parsed.targetDate) {
    const retry = replanTasks(
      failed.map((f) => f.task),
      now,
      exclude
    );

    moved = moved.concat(retry.moved);
    failed = retry.failed;
  }

  await finishMove({
    moved,
    failed,
    undo: first.undo,
    headline: `Cleared ${label}${
      events.length
        ? ` (${events.length} fixed event${events.length === 1 ? "" : "s"} stay)`
        : ""
    }`
  });

  return true;
}


/* ---------- SUMMARY CARD WITH UNDO ---------- */

function showReplanSummary(moved, failed, headlineOverride = null) {
  const container = getReplanContainer();

  const formatSlot = (iso) =>
    new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit"
    });

  const movedHTML = moved
    .map(
      (task) =>
        `<li>${escapeHTML(task.title)} → <strong>${escapeHTML(
          formatSlot(task.scheduledStart)
        )}</strong></li>`
    )
    .join("");

  const failedHTML = failed
    .map(
      (item) =>
        `<li>${escapeHTML(item.task.title)}: couldn't fit (${escapeHTML(
          item.reason
        )})</li>`
    )
    .join("");

  const headline =
    headlineOverride ||
    (moved.length
      ? `Replanned ${moved.length} task${moved.length === 1 ? "" : "s"}`
      : "Couldn't replan");

  container.innerHTML = `
    <div class="insight-card ${failed.length ? "insight-high" : "insight-medium"}">
      <div class="insight-content">
        <div class="insight-label">Smart replan</div>
        <div class="insight-title">${escapeHTML(headline)}</div>
        ${moved.length ? `<ul>${movedHTML}</ul>` : ""}
        ${failed.length ? `<ul>${failedHTML}</ul>` : ""}
        ${
          lastReplanUndo
            ? `<button type="button" class="insight-action" data-replan-action="undo">Undo</button>`
            : ""
        }
      </div>
      <button type="button" class="insight-dismiss" data-replan-action="dismiss" aria-label="Dismiss">×</button>
    </div>
  `;

  container.style.display = "block";

  const undoBtn = container.querySelector('[data-replan-action="undo"]');

  if (undoBtn) {
    undoBtn.addEventListener("click", undoReplan);
  }

  container
    .querySelector('[data-replan-action="dismiss"]')
    .addEventListener("click", clearReplanBanner);
}

async function undoReplan() {
  if (!lastReplanUndo) {
    return;
  }

  // Only restore the tasks the replan moved,
  // so anything added since then is untouched.
  lastReplanUndo.forEach((entry) => {
    const task = tasks.find((t) => t.id === entry.id);

    if (task) {
      task.scheduledStart = entry.scheduledStart;
    }
  });

  lastReplanUndo = null;

  await saveTasks();

  clearReplanBanner();

  renderCalendar();

  setStatus("Undid the change.");
}

function checkMissedTasks() {
  if (
    missedBannerDismissed ||
    localStorage.getItem(MISSED_DISMISS_KEY) === formatDateISO(new Date())
  ) {
    return;
  }

  const missed = getReplanCandidates("week", null, new Date());

  if (missed.length === 0) {
    return;
  }

  const container = getReplanContainer();

  container.innerHTML = `
    <div class="insight-card insight-medium">
      <div class="insight-content">
        <div class="insight-label">Plannr noticed something</div>
        <div class="insight-title">
          ${missed.length} task${missed.length === 1 ? " was" : "s were"} missed. Replan ${missed.length === 1 ? "it" : "them"}?
        </div>
        <button type="button" class="insight-action" data-replan-action="replan">
          Replan
        </button>
      </div>
      <button type="button" class="insight-dismiss" data-replan-action="dismiss" aria-label="Dismiss">×</button>
    </div>
  `;

  container.style.display = "block";

  container
    .querySelector('[data-replan-action="replan"]')
    .addEventListener("click", () => runReplan({ scope: "week" }));

  container
    .querySelector('[data-replan-action="dismiss"]')
    .addEventListener("click", () => {
      missedBannerDismissed = true;
      localStorage.setItem(MISSED_DISMISS_KEY, formatDateISO(new Date()));
      clearReplanBanner();
    });
}


/* ---------- 26. ASK YOUR CALENDAR ---------- */

// Open stretches in a day, after tasks and blocked times.
function getFreeWindows(day) {
  const dayStart = new Date(day);
  dayStart.setHours(DAY_START_HOUR, 0, 0, 0);

  const dayEnd = new Date(day);
  dayEnd.setHours(DAY_END_HOUR, 0, 0, 0);

  let from = dayStart.getTime();
  const now = Date.now();

  if (isSameDay(day, new Date()) && now > from) {
    from = Math.ceil(now / (15 * 60000)) * 15 * 60000;
  }

  const busy = [];

  tasks.forEach((t) => {
    if (!t.scheduledStart || t.status !== "scheduled") return;

    const s = new Date(t.scheduledStart).getTime();
    const e = s + (Number(t.durationMinutes) > 0 ? Number(t.durationMinutes) : 60) * 60000;

    if (e > from && s < dayEnd.getTime()) busy.push([s, e]);
  });

  blockedIntervalsForDay(day).forEach((b) => busy.push([b.start, b.end]));

  busy.sort((a, b) => a[0] - b[0]);

  const windows = [];
  let cursor = from;

  for (const [s, e] of busy) {
    if (s > cursor) windows.push([cursor, Math.min(s, dayEnd.getTime())]);

    cursor = Math.max(cursor, e);

    if (cursor >= dayEnd.getTime()) break;
  }

  if (cursor < dayEnd.getTime()) windows.push([cursor, dayEnd.getTime()]);

  return windows.filter((w) => w[1] - w[0] >= 15 * 60000);
}

function clipWindows(windows, day, startHour, endHour) {
  const from = new Date(day);
  from.setHours(startHour, 0, 0, 0);

  const to = new Date(day);
  to.setHours(endHour, 0, 0, 0);

  return windows
    .map(([s, e]) => [Math.max(s, from.getTime()), Math.min(e, to.getTime())])
    .filter(([s, e]) => e - s >= 15 * 60000);
}

function agendaLines(day) {
  return tasks
    .filter(
      (t) =>
        t.scheduledStart && isSameDay(new Date(t.scheduledStart), day)
    )
    .sort((a, b) => new Date(a.scheduledStart) - new Date(b.scheduledStart))
    .map((t) => {
      const s = new Date(t.scheduledStart);
      const e = getTaskEnd(t);

      return `${formatTimeShort(s)} – ${formatTimeShort(e)}  ${t.title}${
        t.status === "done" ? " (done)" : ""
      }`;
    });
}

function answerQuery(parsed) {
  const now = new Date();
  const day = parsed.date ? localDateFromISO(parsed.date) : startOfDay(now);
  const type = parsed.queryType || "agenda";

  if (type === "agenda") {
    const lines = agendaLines(day);

    showAnswer(
      lines.length
        ? `${formatDayLabel(day)}: ${lines.length} item${lines.length === 1 ? "" : "s"}`
        : `${formatDayLabel(day)}: nothing scheduled`,
      lines
    );

    setStatus("Here's your day.");

    return true;
  }

  if (type === "free_time") {
    const needed = parsed.durationMinutes && parsed.durationMinutes > 1
      ? parsed.durationMinutes
      : 30;

    let windows = getFreeWindows(day);

    if (parsed.preferredTime) {
      const range = {
        morning: [DAY_START_HOUR, 12],
        afternoon: [12, 17],
        evening: [17, DAY_END_HOUR]
      }[parsed.preferredTime];

      windows = clipWindows(windows, day, range[0], range[1]);
    }

    windows = windows.filter((w) => (w[1] - w[0]) / 60000 >= needed);

    const lines = windows
      .slice(0, 6)
      .map(
        ([s, e]) =>
          `${formatTimeShort(new Date(s))} – ${formatTimeShort(new Date(e))}  (${formatDuration(
            (e - s) / 60000
          )} free)`
      );

    showAnswer(
      lines.length
        ? `Free on ${formatDayLabel(day)}${parsed.preferredTime ? ` (${parsed.preferredTime})` : ""}`
        : `No free time of ${formatDuration(needed)} on ${formatDayLabel(day)}`,
      lines
    );

    setStatus(lines.length ? "Here's when you're free." : "That day is full.");

    return true;
  }

  if (type === "next") {
    const upcoming = tasks
      .filter(
        (t) =>
          t.scheduledStart &&
          t.status === "scheduled" &&
          new Date(t.scheduledStart) > now
      )
      .sort((a, b) => new Date(a.scheduledStart) - new Date(b.scheduledStart));

    const current = tasks.find(
      (t) =>
        t.scheduledStart &&
        t.status === "scheduled" &&
        new Date(t.scheduledStart) <= now &&
        getTaskEnd(t) > now
    );

    const lines = [];

    if (current) {
      lines.push(`Now: ${current.title} (until ${formatTimeShort(getTaskEnd(current))})`);
    }

    upcoming.slice(0, 3).forEach((t) => {
      const s = new Date(t.scheduledStart);

      lines.push(
        `${isSameDay(s, now) ? "" : s.toLocaleDateString(undefined, { weekday: "short" }) + " "}${formatTimeShort(s)}  ${t.title}  (in ${formatRelative((s - now) / 60000)})`
      );
    });

    showAnswer(lines.length ? "Coming up" : "Nothing coming up", lines);

    setStatus(lines.length ? "Here's what's next." : "You're clear.");

    return true;
  }

  // summary: the week containing the date
  const weekStart = getStartOfWeek(day);
  const lines = [];
  let busiest = null;
  let lightest = null;

  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);

    const items = tasks.filter(
      (t) =>
        t.scheduledStart &&
        t.status !== "done" &&
        isSameDay(new Date(t.scheduledStart), d)
    );

    const minutes = items.reduce(
      (sum, t) => sum + (Number(t.durationMinutes) > 0 ? Number(t.durationMinutes) : 60),
      0
    );

    lines.push(
      `${d.toLocaleDateString(undefined, { weekday: "short" })}: ${
        minutes ? formatDuration(minutes) : "free"
      }${items.length ? ` · ${items.length} item${items.length === 1 ? "" : "s"}` : ""}`
    );

    if (!busiest || minutes > busiest.minutes) busiest = { d, minutes };
    if (!lightest || minutes < lightest.minutes) lightest = { d, minutes };
  }

  const dueThisWeek = getDeadlineProgress().filter((p) => {
    const due = localDateFromISO(p.deadline);

    return due >= weekStart && due < addDays(weekStart, 7);
  });

  dueThisWeek.forEach((p) => {
    lines.push(
      `Due ${localDateFromISO(p.deadline).toLocaleDateString(undefined, {
        weekday: "short"
      })}: ${p.title} (${p.percent}% done)`
    );
  });

  showAnswer(
    `Week of ${formatWeekLabel(weekStart)}` +
      (busiest && busiest.minutes
        ? ` · busiest ${busiest.d.toLocaleDateString(undefined, { weekday: "long" })}`
        : ""),
    lines
  );

  setStatus("Here's your week.");

  return true;
}


/* ============================================================
   27. SYLLABUS IMPORT
   ============================================================ */

let importItems = [];

function openImportModal() {
  const modal = document.getElementById("import-modal");

  if (!modal) return;

  modal.classList.remove("is-hidden");

  const text = document.getElementById("import-text");

  if (text) text.focus();
}

function closeImportModal() {
  const modal = document.getElementById("import-modal");

  if (modal) modal.classList.add("is-hidden");
}

function setImportStatus(message, isError = false) {
  const el = document.getElementById("import-status");

  if (!el) return;

  el.textContent = message;
  el.classList.toggle("is-error", isError);
}

async function findImportItems() {
  const textEl = document.getElementById("import-text");
  const text = textEl ? textEl.value.trim() : "";

  if (!text) {
    setImportStatus("Paste a syllabus or a list of deadlines first.", true);
    return;
  }

  const findBtn = document.getElementById("import-find");

  if (findBtn) findBtn.disabled = true;

  setImportStatus("Reading it…");

  document.getElementById("import-results").innerHTML = "";
  document.getElementById("import-add").classList.add("is-hidden");

  try {
    const data = await callParseAPI(
      { text, mode: "import" },
      { maxAttempts: 1 }
    );

    importItems = Array.isArray(data.items) ? data.items : [];

    if (!importItems.length) {
      setImportStatus("I couldn't find any dated items in that.", true);
      return;
    }

    renderImportResults();

    setImportStatus(
      `Found ${importItems.length} item${importItems.length === 1 ? "" : "s"}. Untick anything you don't want, and adjust prep time if needed.`
    );

    document.getElementById("import-add").classList.remove("is-hidden");
  } catch (err) {
    console.error(err);
    setImportStatus(describeAIError(err), true);
  } finally {
    if (findBtn) findBtn.disabled = false;
  }
}

function renderImportResults() {
  const kindLabel = {
    exam: "Exam",
    quiz: "Quiz",
    assignment: "Assignment",
    project: "Project",
    reading: "Reading",
    other: "Other"
  };

  document.getElementById("import-results").innerHTML = importItems
    .map((item, i) => {
      const due = localDateFromISO(item.date).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric"
      });

      return `
        <label class="import-row">
          <input type="checkbox" data-import-check="${i}" checked>
          <span class="import-main">
            <span class="import-title">${escapeHTML(item.title)}</span>
            <span class="import-meta">${escapeHTML(kindLabel[item.kind] || "Other")} · ${escapeHTML(due)}${item.time ? ` at ${escapeHTML(item.time)}` : ""}</span>
          </span>
          <span class="import-hours">
            <input type="number" min="0.25" max="16" step="0.25"
              value="${(item.estimatedMinutes / 60).toFixed(2).replace(/\.?0+$/, "")}"
              data-import-hours="${i}" aria-label="Prep hours">
            <span>h prep</span>
          </span>
        </label>`;
    })
    .join("");
}

function collectImportSelection() {
  const picked = [];

  importItems.forEach((item, i) => {
    const check = document.querySelector(`[data-import-check="${i}"]`);
    const hoursEl = document.querySelector(`[data-import-hours="${i}"]`);

    if (!check || !check.checked) return;

    const hours = Number(hoursEl ? hoursEl.value : item.estimatedMinutes / 60);

    const minutes = Number.isFinite(hours)
      ? clamp(Math.round((hours * 60) / 15) * 15, 0, 960)
      : item.estimatedMinutes;

    picked.push({ ...item, estimatedMinutes: minutes });
  });

  return picked;
}

async function addImportedItems(items) {
  const now = new Date();
  const problems = [];
  const valid = [];

  let eventCount = 0;
  let prepCount = 0;
  let firstFocus = null;

  [...items]
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((item) => {
      if (new Date(`${item.date}T23:59:59`) < now) {
        problems.push(`${item.title}: that date has already passed`);
      } else {
        valid.push(item);
      }
    });

  // Fixed-time items (exams with a time) go in first, so prep avoids them.
  for (const item of valid) {
    if (!item.time) continue;

    const start = new Date(`${item.date}T${item.time}`);
    const minutes = item.kind === "exam" ? 90 : item.kind === "quiz" ? 45 : 30;
    const end = new Date(start.getTime() + minutes * 60000);

    if (start <= now || !isSlotFree(start, end)) {
      problems.push(
        `${item.title}: couldn't add the ${item.time} entry (overlap or past)`
      );
      continue;
    }

    tasks.push({
      id: makeId(),
      title: item.title,
      durationMinutes: minutes,
      deadline: null,
      preferredTime: null,
      status: "scheduled",
      priority: "high",
      scheduledStart: formatLocalDateTime(start),
      type: "event"
    });

    eventCount++;

    if (!firstFocus || start < firstFocus) firstFocus = start;
  }

  const verbs = {
    exam: "Study for",
    quiz: "Study for",
    assignment: "Work on",
    project: "Work on",
    reading: "Read:",
    other: "Prep:"
  };

  // Then prep sessions, soonest deadline first.
  for (const item of valid) {
    const total = item.estimatedMinutes;

    if (!(total > 0)) continue;

    const lengths = planSessionLengths(total, {});

    if (!lengths) {
      problems.push(`${item.title}: prep time is too long to schedule`);
      continue;
    }

    // Studying should end before an exam day, not on it.
    let deadlineISO = item.date;

    if (item.kind === "exam" || item.kind === "quiz") {
      const dayBefore = addDays(localDateFromISO(item.date), -1);

      if (dayBefore >= startOfDay(now)) {
        deadlineISO = formatDateISO(dayBefore);
      }
    }

    const result = placeSessions({
      title: `${verbs[item.kind] || "Prep:"} ${item.title}`,
      lengths,
      deadline: deadlineISO,
      storedDeadline: deadlineISO,
      priority: item.priority || "medium"
    });

    if (!result.ok) {
      problems.push(
        `${item.title}: not enough free time before ${deadlineISO}`
      );
      continue;
    }

    prepCount += result.created.length;

    const first = new Date(result.created[0].scheduledStart);

    if (!firstFocus || first < firstFocus) firstFocus = first;
  }

  await saveTasks();

  if (firstFocus) focusDate(firstFocus);

  renderWeekLabel();
  renderCalendar();

  closeImportModal();

  setStatus(
    `Added ${prepCount} prep session${prepCount === 1 ? "" : "s"}${
      eventCount ? ` and ${eventCount} fixed event${eventCount === 1 ? "" : "s"}` : ""
    }.`
  );

  if (problems.length) {
    showAnswer("A few things couldn't be added", problems);
  } else {
    clearAnswer();
  }
}


/* ============================================================
   28. CALENDAR FILES (.ics)
   ============================================================ */

function icsEscape(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function icsUnescape(s) {
  return String(s)
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function icsLocal(d) {
  const p = (n) => String(n).padStart(2, "0");

  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
}

function icsUTC(d) {
  const p = (n) => String(n).padStart(2, "0");

  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function exportICS() {
  const items = tasks.filter((t) => t.scheduledStart);

  if (!items.length) {
    setStatus("There's nothing on your calendar to export yet.", true);
    return;
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Plannr//EN",
    "CALSCALE:GREGORIAN"
  ];

  const stamp = icsUTC(new Date());

  items.forEach((t) => {
    const start = new Date(t.scheduledStart);
    const end = getTaskEnd(t);

    lines.push(
      "BEGIN:VEVENT",
      `UID:${t.id}@plannr`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsLocal(start)}`,
      `DTEND:${icsLocal(end)}`,
      `SUMMARY:${icsEscape(t.title)}`,
      `DESCRIPTION:${icsEscape(
        `${t.type === "event" ? "Event" : "Task"} · priority ${t.priority || "medium"}${
          t.status === "done" ? " · done" : ""
        }`
      )}`,
      "END:VEVENT"
    );
  });

  lines.push("END:VCALENDAR");

  const blob = new Blob([lines.join("\r\n") + "\r\n"], {
    type: "text/calendar;charset=utf-8"
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = `plannr-${formatDateISO(new Date())}.ics`;

  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);

  setStatus(`Exported ${items.length} item${items.length === 1 ? "" : "s"}.`);
}

function parseICSDate(value) {
  const v = String(value).trim();

  let m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);

  if (m) {
    const [, y, mo, d, h, mi, s, z] = m;

    return {
      allDay: false,
      date: z
        ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)))
        : new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0))
    };
  }

  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);

  if (m) {
    return { allDay: true, date: new Date(+m[1], +m[2] - 1, +m[3]) };
  }

  return null;
}

function parseICSDuration(value) {
  const m = String(value).match(
    /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/
  );

  if (!m) return null;

  return (
    (+m[1] || 0) * 7 * 1440 +
    (+m[2] || 0) * 1440 +
    (+m[3] || 0) * 60 +
    (+m[4] || 0)
  );
}

function parseICS(text) {
  const lines = String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");

  const events = [];
  let cur = null;

  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) {
      cur = {};
      continue;
    }

    if (line.startsWith("END:VEVENT")) {
      if (cur) events.push(cur);
      cur = null;
      continue;
    }

    if (!cur) continue;

    const idx = line.indexOf(":");

    if (idx < 0) continue;

    const key = line.slice(0, idx).split(";")[0].toUpperCase();
    const value = line.slice(idx + 1);

    if (key === "SUMMARY") cur.summary = icsUnescape(value);
    else if (key === "DTSTART") cur.start = parseICSDate(value);
    else if (key === "DTEND") cur.end = parseICSDate(value);
    else if (key === "DURATION") cur.duration = parseICSDuration(value);
    else if (key === "RRULE") cur.recurring = true;
  }

  return events;
}

async function importICSFile(file) {
  if (!file) return;

  if (file.size > 1.5 * 1024 * 1024) {
    setStatus("That file is too large (limit 1.5 MB).", true);
    return;
  }

  let text;

  try {
    text = await file.text();
  } catch {
    setStatus("I couldn't read that file.", true);
    return;
  }

  const events = parseICS(text).slice(0, 300);

  if (!events.length) {
    setStatus("I couldn't find any events in that file.", true);
    return;
  }

  const now = new Date();
  const stats = { added: 0, past: 0, overlap: 0, allDay: 0, outside: 0, repeating: 0 };
  let first = null;

  for (const ev of events) {
    if (!ev.start) continue;

    if (ev.start.allDay) {
      stats.allDay++;
      continue;
    }

    const start = ev.start.date;

    let minutes = 60;

    if (ev.end && !ev.end.allDay) {
      minutes = Math.round((ev.end.date - start) / 60000);
    } else if (ev.duration) {
      minutes = ev.duration;
    }

    if (!(minutes >= 15)) minutes = 60;

    const end = new Date(start.getTime() + minutes * 60000);

    if (start < now) {
      stats.past++;
      continue;
    }

    const dayStart = new Date(start);
    dayStart.setHours(DAY_START_HOUR, 0, 0, 0);

    const dayEnd = new Date(start);
    dayEnd.setHours(DAY_END_HOUR, 0, 0, 0);

    if (start < dayStart || end > dayEnd) {
      stats.outside++;
      continue;
    }

    if (!isSlotFree(start, end)) {
      stats.overlap++;
      continue;
    }

    tasks.push({
      id: makeId(),
      title: (ev.summary || "Event").slice(0, 120),
      durationMinutes: minutes,
      deadline: null,
      preferredTime: null,
      status: "scheduled",
      priority: "medium",
      scheduledStart: formatLocalDateTime(start),
      type: "event"
    });

    if (ev.recurring) stats.repeating++;

    stats.added++;

    if (!first || start < first) first = start;
  }

  if (stats.added) {
    await saveTasks();

    if (first) focusDate(first);

    renderWeekLabel();
    renderCalendar();
  }

  const notes = [];

  if (stats.past) notes.push(`${stats.past} in the past`);
  if (stats.overlap) notes.push(`${stats.overlap} overlapping`);
  if (stats.allDay) notes.push(`${stats.allDay} all-day`);
  if (stats.outside) notes.push(`${stats.outside} outside your day hours`);

  setStatus(
    `Imported ${stats.added} event${stats.added === 1 ? "" : "s"}${
      notes.length ? `. Skipped ${notes.join(", ")}` : ""
    }${stats.repeating ? `. ${stats.repeating} repeat in your file, only the next one was added` : ""}.`,
    stats.added === 0
  );
}


/* ============================================================
   29. SETTINGS POPUP
   ============================================================ */

function hourOptions(min, max, selected) {
  let html = "";

  for (let h = min; h <= max; h++) {
    html += `<option value="${h}" ${h === selected ? "selected" : ""}>${fmtHour(h)}</option>`;
  }

  return html;
}

function blockRowHTML(b) {
  const days = ["S", "M", "T", "W", "T", "F", "S"];

  return `
    <div class="block-row" data-block-id="${escapeAttr(b.id)}">
      <input type="text" class="block-label" value="${escapeAttr(b.label)}" maxlength="40" placeholder="Label">
      <input type="time" class="block-start" value="${escapeAttr(b.start)}">
      <span class="block-to">to</span>
      <input type="time" class="block-end" value="${escapeAttr(b.end)}">
      <div class="block-days">
        ${days
          .map(
            (d, i) => `
          <label class="day-chip">
            <input type="checkbox" value="${i}" ${b.days.includes(i) ? "checked" : ""}>
            <span>${d}</span>
          </label>`
          )
          .join("")}
      </div>
      <button type="button" class="block-remove" aria-label="Remove">×</button>
    </div>`;
}

function renderBlockedRows(list) {
  const el = document.getElementById("set-blocked-list");

  if (!el) return;

  el.innerHTML = list.length
    ? list.map(blockRowHTML).join("")
    : `<p class="modal-hint">No blocked times yet. Plannr will keep these clear when it schedules for you.</p>`;
}

function readBlockedRows() {
  const rows = [...document.querySelectorAll("#set-blocked-list .block-row")];
  const out = [];

  for (const row of rows) {
    const label = row.querySelector(".block-label").value.trim() || "Busy";
    const start = row.querySelector(".block-start").value;
    const end = row.querySelector(".block-end").value;

    const days = [...row.querySelectorAll(".block-days input:checked")].map((c) =>
      Number(c.value)
    );

    if (!start || !end || !days.length) {
      return { error: `"${label}" needs a start, an end, and at least one day.` };
    }

    if (parseHM(end) <= parseHM(start)) {
      return { error: `"${label}": the end time must be after the start time.` };
    }

    out.push({ id: row.dataset.blockId || makeId(), label, days, start, end });
  }

  return { blocked: out };
}

function openSettings() {
  const modal = document.getElementById("settings-modal");

  if (!modal) return;

  document.getElementById("set-start").innerHTML = hourOptions(
    0,
    22,
    settings.dayStartHour
  );
  document.getElementById("set-end").innerHTML = hourOptions(
    1,
    24,
    settings.dayEndHour
  );
  document.getElementById("set-focus").value = settings.focusTime || "";
  document.getElementById("set-maxhours").value = settings.maxHoursPerDay;
  document.getElementById("set-buffer").value = String(settings.bufferMinutes);
  document.getElementById("set-learn").checked = settings.learn;
  document.getElementById("set-reminders").checked = settings.reminders;
  document.getElementById("set-reminder-min").value = String(
    settings.reminderMinutes
  );
  document.getElementById("set-theme").value = settings.theme;
  document.getElementById("set-view").value = settings.view;

  renderBlockedRows(settings.blocked);

  modal.classList.remove("is-hidden");
}

function closeSettings() {
  const modal = document.getElementById("settings-modal");

  if (modal) modal.classList.add("is-hidden");
}

function countItemsOutside(startHour, endHour) {
  return tasks.filter((t) => {
    if (!t.scheduledStart) return false;

    const s = new Date(t.scheduledStart);
    const e = getTaskEnd(t);

    const sMin = s.getHours() * 60 + s.getMinutes();
    const eMin = sMin + (Number(t.durationMinutes) > 0 ? Number(t.durationMinutes) : 60);

    return sMin < startHour * 60 || eMin > endHour * 60 || !isSameDay(s, e);
  }).length;
}

async function saveSettingsFromForm(event) {
  event.preventDefault();

  const blockedResult = readBlockedRows();

  if (blockedResult.error) {
    alert(blockedResult.error);
    return;
  }

  const next = sanitizeSettings({
    dayStartHour: document.getElementById("set-start").value,
    dayEndHour: document.getElementById("set-end").value,
    focusTime: document.getElementById("set-focus").value || null,
    maxHoursPerDay: document.getElementById("set-maxhours").value,
    bufferMinutes: document.getElementById("set-buffer").value,
    blocked: blockedResult.blocked,
    learn: document.getElementById("set-learn").checked,
    reminders: document.getElementById("set-reminders").checked,
    reminderMinutes: document.getElementById("set-reminder-min").value,
    theme: document.getElementById("set-theme").value,
    view: document.getElementById("set-view").value
  });

  const hoursChanged =
    next.dayStartHour !== settings.dayStartHour ||
    next.dayEndHour !== settings.dayEndHour;

  if (hoursChanged) {
    const outside = countItemsOutside(next.dayStartHour, next.dayEndHour);

    if (
      outside > 0 &&
      !confirm(
        `${outside} item${outside === 1 ? " falls" : "s fall"} outside your new day hours and will be hidden from the calendar. Continue?`
      )
    ) {
      return;
    }
  }

  settings = next;

  applySettings();

  viewDays = computeViewDays();
  focusDate(viewStart);

  persistSettings();

  if (
    settings.reminders &&
    "Notification" in window &&
    Notification.permission === "default"
  ) {
    try {
      Notification.requestPermission();
    } catch {
      /* ignore */
    }
  }

  closeSettings();

  renderWeekLabel();
  renderCalendar();

  showToast("Settings saved.");
}

function resetSettings() {
  if (!confirm("Reset all settings to their defaults?")) return;

  settings = sanitizeSettings({});

  applySettings();

  viewDays = computeViewDays();
  focusDate(viewStart);

  persistSettings();

  closeSettings();

  renderWeekLabel();
  renderCalendar();

  showToast("Settings reset.");
}


/* ============================================================
   30. EXTRA UI (built here so app.html stays unchanged)
   ============================================================ */

function ensureUI() {
  const topbar = document.querySelector(".topbar");
  const main = document.querySelector("main") || document.body;
  const inputSection = document.querySelector(".input-section");

  /* ---------- toolbar ---------- */

  if (topbar && !document.getElementById("plannr-toolbar")) {
    const bar = document.createElement("div");

    bar.id = "plannr-toolbar";
    bar.className = "toolbar";
    bar.innerHTML = `
      <button type="button" class="tool-btn" data-tool="import">Import syllabus</button>
      <button type="button" class="tool-btn" data-tool="ics-import">Import .ics</button>
      <button type="button" class="tool-btn" data-tool="ics-export">Export .ics</button>
      <button type="button" class="tool-btn" data-tool="settings">Settings</button>
      <input type="file" id="ics-file" accept=".ics,text/calendar" hidden>
    `;

    const tagline = topbar.querySelector(".tagline");

    if (tagline) tagline.after(bar);
    else topbar.appendChild(bar);

    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tool]");

      if (!btn) return;

      const tool = btn.dataset.tool;

      if (tool === "import") openImportModal();
      else if (tool === "settings") openSettings();
      else if (tool === "ics-export") exportICS();
      else if (tool === "ics-import") document.getElementById("ics-file").click();
    });

    document.getElementById("ics-file").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];

      e.target.value = "";

      importICSFile(file);
    });
  }

  /* ---------- answer card + dashboard ---------- */

  if (!document.getElementById("plannr-answer")) {
    const answer = document.createElement("div");

    answer.id = "plannr-answer";
    answer.style.display = "none";

    answer.addEventListener("click", (e) => {
      if (e.target.closest("[data-answer='dismiss']")) clearAnswer();
    });

    const dash = document.createElement("div");

    dash.id = "plannr-dashboard";
    dash.addEventListener("click", handleDashboardClick);

    if (inputSection) {
      inputSection.after(answer, dash);
    } else {
      main.prepend(dash);
      main.prepend(answer);
    }
  }

  /* ---------- week nav extras ---------- */

  const nav = document.querySelector(".week-nav");

  if (nav && !document.getElementById("today-btn")) {
    const todayBtn = document.createElement("button");

    todayBtn.type = "button";
    todayBtn.id = "today-btn";
    todayBtn.className = "week-nav-text-btn";
    todayBtn.textContent = "Today";
    todayBtn.addEventListener("click", goToToday);

    const toggle = document.createElement("div");

    toggle.className = "view-toggle";
    toggle.innerHTML = `
      <button type="button" data-view="week">Week</button>
      <button type="button" data-view="day">Day</button>
    `;

    toggle.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-view]");

      if (btn) setViewMode(btn.dataset.view);
    });

    const next = document.getElementById("next-week");

    if (next) {
      next.after(todayBtn, toggle);
    } else {
      nav.append(todayBtn, toggle);
    }
  }

  /* ---------- toast ---------- */

  if (!document.getElementById("plannr-toast")) {
    const toast = document.createElement("div");

    toast.id = "plannr-toast";
    toast.className = "toast";
    toast.setAttribute("role", "status");

    document.body.appendChild(toast);
  }

  /* ---------- settings popup ---------- */

  if (!document.getElementById("settings-modal")) {
    const modal = document.createElement("div");

    modal.id = "settings-modal";
    modal.className = "event-modal is-hidden";
    modal.innerHTML = `
      <div class="event-modal-card wide-card">
        <h2>Settings</h2>
        <form id="settings-form" class="form-stack">

          <fieldset>
            <legend>Your day</legend>
            <div class="field-row">
              <label>Day starts <select id="set-start"></select></label>
              <label>Day ends <select id="set-end"></select></label>
            </div>
            <label>Best time to focus
              <select id="set-focus">
                <option value="">No preference</option>
                <option value="morning">Mornings</option>
                <option value="afternoon">Afternoons</option>
                <option value="evening">Evenings</option>
              </select>
            </label>
            <div class="field-row">
              <label>Max planned hours per day
                <input type="number" id="set-maxhours" min="2" max="14" step="1">
              </label>
              <label>Gap between tasks
                <select id="set-buffer">
                  <option value="0">None</option>
                  <option value="5">5 min</option>
                  <option value="10">10 min</option>
                  <option value="15">15 min</option>
                  <option value="30">30 min</option>
                </select>
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Blocked times</legend>
            <p class="modal-hint">Lunch, classes, commutes. Plannr won't schedule tasks here (you can still add things by hand).</p>
            <div id="set-blocked-list"></div>
            <div class="field-row">
              <button type="button" id="set-add-block" class="btn-secondary">+ Add blocked time</button>
              <button type="button" id="set-add-lunch" class="btn-secondary">+ Lunch</button>
            </div>
          </fieldset>

          <fieldset>
            <legend>Smart features</legend>
            <label class="check"><input type="checkbox" id="set-learn"> Learn when I tend to finish things</label>
            <label class="check"><input type="checkbox" id="set-reminders"> Remind me before things start</label>
            <label>Reminder lead time
              <select id="set-reminder-min">
                <option value="5">5 min</option>
                <option value="10">10 min</option>
                <option value="15">15 min</option>
                <option value="30">30 min</option>
              </select>
            </label>
          </fieldset>

          <fieldset>
            <legend>Appearance</legend>
            <div class="field-row">
              <label>Theme
                <select id="set-theme">
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="system">Match my device</option>
                </select>
              </label>
              <label>Default view
                <select id="set-view">
                  <option value="auto">Automatic</option>
                  <option value="week">Week</option>
                  <option value="day">Day</option>
                </select>
              </label>
            </div>
          </fieldset>

          <div class="event-modal-actions">
            <button type="button" id="set-reset" class="btn-danger">Reset</button>
            <button type="button" id="set-cancel" class="btn-secondary">Cancel</button>
            <button type="submit" class="btn-primary">Save</button>
          </div>
        </form>
      </div>`;

    document.body.appendChild(modal);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeSettings();
    });

    document.getElementById("settings-form").addEventListener("submit", saveSettingsFromForm);
    document.getElementById("set-cancel").addEventListener("click", closeSettings);
    document.getElementById("set-reset").addEventListener("click", resetSettings);

    document.getElementById("set-add-block").addEventListener("click", () => {
      const current = readBlockedRows();
      const list = current.blocked || settings.blocked;

      renderBlockedRows([
        ...list,
        { id: makeId(), label: "Busy", days: [1, 2, 3, 4, 5], start: "09:00", end: "10:00" }
      ]);
    });

    document.getElementById("set-add-lunch").addEventListener("click", () => {
      const current = readBlockedRows();
      const list = current.blocked || settings.blocked;

      renderBlockedRows([
        ...list,
        { id: makeId(), label: "Lunch", days: [0, 1, 2, 3, 4, 5, 6], start: "12:00", end: "13:00" }
      ]);
    });

    document.getElementById("set-blocked-list").addEventListener("click", (e) => {
      const btn = e.target.closest(".block-remove");

      if (!btn) return;

      btn.closest(".block-row").remove();
    });
  }

  /* ---------- import popup ---------- */

  if (!document.getElementById("import-modal")) {
    const modal = document.createElement("div");

    modal.id = "import-modal";
    modal.className = "event-modal is-hidden";
    modal.innerHTML = `
      <div class="event-modal-card wide-card">
        <h2>Import from a syllabus</h2>
        <p class="modal-hint">Paste a syllabus, course outline, or a list of deadlines. Plannr finds the dates and schedules prep time before each one.</p>
        <textarea id="import-text" rows="8" maxlength="8000"
          placeholder="e.g. Midterm exam Oct 21. Lab report 2 due Oct 28. Final project due Dec 5…"></textarea>
        <p id="import-status" class="modal-status"></p>
        <div id="import-results"></div>
        <div class="event-modal-actions">
          <button type="button" id="import-close" class="btn-secondary">Close</button>
          <button type="button" id="import-find" class="btn-primary">Find items</button>
          <button type="button" id="import-add" class="btn-primary is-hidden">Add to calendar</button>
        </div>
      </div>`;

    document.body.appendChild(modal);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeImportModal();
    });

    document.getElementById("import-close").addEventListener("click", closeImportModal);
    document.getElementById("import-find").addEventListener("click", findImportItems);

    document.getElementById("import-add").addEventListener("click", async () => {
      const picked = collectImportSelection();

      if (!picked.length) {
        setImportStatus("Tick at least one item.", true);
        return;
      }

      const addBtn = document.getElementById("import-add");

      addBtn.disabled = true;

      try {
        await addImportedItems(picked);
      } finally {
        addBtn.disabled = false;
      }
    });
  }
}

function updateViewToggle() {
  document.querySelectorAll(".view-toggle [data-view]").forEach((btn) => {
    const active = (btn.dataset.view === "day") === (viewDays === 1);

    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
}

function setViewMode(mode) {
  if (mode !== "week" && mode !== "day") return;

  settings.view = mode;
  viewDays = computeViewDays();

  focusDate(viewDays === 1 ? new Date() : viewStart);

  persistSettings();

  renderWeekLabel();
  renderCalendar();
}

function goToToday() {
  focusDate(new Date());

  renderWeekLabel();
  renderCalendar();
}


/* ---------- 31. VOICE INPUT ---------- */

function setupVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const form = document.getElementById("task-form");

  if (!SR || !form || document.getElementById("mic-btn")) return;

  const btn = document.createElement("button");

  btn.type = "button";
  btn.id = "mic-btn";
  btn.className = "mic-btn";
  btn.title = "Speak a command";
  btn.setAttribute("aria-label", "Speak a command");
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><path d="M12 18v3"></path></svg>';

  const submit = document.getElementById("task-submit");

  form.insertBefore(btn, submit);

  const rec = new SR();

  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let listening = false;

  rec.onresult = (e) => {
    const text = [...e.results].map((r) => r[0].transcript).join(" ");

    document.getElementById("task-input").value = text;
  };

  rec.onend = () => {
    listening = false;
    btn.classList.remove("is-listening");
    setStatus("Check the text, then press Add to week.");
  };

  rec.onerror = (e) => {
    listening = false;
    btn.classList.remove("is-listening");

    if (e.error === "not-allowed") {
      setStatus("Microphone access was blocked.", true);
    } else if (e.error !== "no-speech" && e.error !== "aborted") {
      setStatus("Voice input didn't work. Try typing instead.", true);
    }
  };

  btn.addEventListener("click", () => {
    if (listening) {
      rec.stop();
      return;
    }

    try {
      rec.start();

      listening = true;
      btn.classList.add("is-listening");
      setStatus("Listening…");
    } catch {
      /* already started */
    }
  });
}


/* ---------- 32. REMINDERS ---------- */

const remindedKeys = new Set();

function checkReminders() {
  if (!settings.reminders) return;

  const now = Date.now();
  const lead = settings.reminderMinutes * 60000;

  tasks.forEach((t) => {
    if (t.status !== "scheduled" || !t.scheduledStart) return;

    const start = new Date(t.scheduledStart).getTime();

    if (!Number.isFinite(start) || start <= now || start - now > lead) return;

    const key = `${t.id}:${t.scheduledStart}`;

    if (remindedKeys.has(key)) return;

    remindedKeys.add(key);

    const minutes = Math.max(1, Math.round((start - now) / 60000));
    const message = `${t.title} starts in ${minutes} min`;

    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification("Plannr", { body: message });
      } catch {
        /* some browsers only allow this from a service worker */
      }
    }

    showToast(message, { timeout: 8000 });
  });
}


/* ---------- 33. NAVIGATION + SHORTCUTS ---------- */

function handlePrevWeek() {
  viewStart = addDays(viewStart, -viewDays);

  renderWeekLabel();
  renderCalendar();
}

function handleNextWeek() {
  viewStart = addDays(viewStart, viewDays);

  renderWeekLabel();
  renderCalendar();
}

function isTypingTarget(el) {
  if (!el) return false;

  const tag = el.tagName;

  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

function anyModalOpen() {
  return [...document.querySelectorAll(".event-modal")].some(
    (m) => !m.classList.contains("is-hidden")
  );
}

function setupShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target) || anyModalOpen()) return;

    if (e.key === "/") {
      e.preventDefault();

      const input = document.getElementById("task-input");

      if (input) input.focus();
    } else if (e.key === "t" || e.key === "T") {
      goToToday();
    } else if (e.key === "ArrowLeft") {
      handlePrevWeek();
    } else if (e.key === "ArrowRight") {
      handleNextWeek();
    } else if (e.key === "d" || e.key === "D") {
      setViewMode("day");
    } else if (e.key === "w" || e.key === "W") {
      setViewMode("week");
    }
  });
}

function setupResizeWatcher() {
  let timer = null;

  window.addEventListener("resize", () => {
    clearTimeout(timer);

    timer = setTimeout(() => {
      if (settings.view !== "auto") return;

      const next = computeViewDays();

      if (next !== viewDays) {
        viewDays = next;
        focusDate(viewStart);

        renderWeekLabel();
        renderCalendar();
      }
    }, 200);
  });
}


/* ---------- 34. MAIN AI HANDLER ---------- */

async function handleAddTask(event) {
  event.preventDefault();

  const input = document.getElementById("task-input");
  const submitBtn = document.getElementById("task-submit");
  const rawText = input.value.trim();

  if (!rawText) {
    return;
  }

  submitBtn.disabled = true;
  setStatus("Reading that…");

  try {
    const parsed = await parseTaskWithAI(rawText, (attempt) =>
      setStatus(`AI is busy, retrying (${attempt})…`)
    );

    console.log("AI PARSED:", parsed);

    let ok = true;

    if (parsed.action === "create") {
      ok = parsed.repeat
        ? await createRecurring(parsed, rawText)
        : await createTask(parsed, rawText);
    } else if (parsed.action === "reschedule") {
      ok = rescheduleTask(parsed);
    } else if (parsed.action === "delete") {
      ok = deleteTaskWithAI(parsed);
    } else if (parsed.action === "complete") {
      ok = completeTaskWithAI(parsed);
    } else if (parsed.action === "replan") {
      ok = await replanWithAI(parsed);
    } else if (parsed.action === "query") {
      ok = answerQuery(parsed);
    } else if (parsed.action === "clear") {
      ok = await clearDayWithAI(parsed);
    } else {
      const e = new Error("Unrecognized action from AI: " + parsed.action);
      e.kind = "invalid";
      throw e;
    }

    // Keep the text if the action didn't work, so it can be edited.
    if (ok !== false) {
      input.value = "";
    }
  } catch (err) {
    console.error(err);

    setStatus(describeAIError(err), true);
  } finally {
    submitBtn.disabled = false;
  }
}


/* ---------- 35. SIGN OUT ---------- */

async function handleSignOut() {
  const btn = document.getElementById("signout-btn");

  if (btn) btn.disabled = true;

  try {
    await supabaseClient.auth.signOut();
  } catch (err) {
    console.error("Sign out failed:", err);
  }

  // Clear cached data so the next person on this browser can't see it
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem(MISSED_DISMISS_KEY);

  window.location.href = "index.html";
}


/* ---------- 36. INITIALIZATION ---------- */

function setupApp() {
  ensureUI();

  /* ---------- AI TASK FORM ---------- */

  const taskForm = document.getElementById("task-form");

  if (taskForm) {
    taskForm.addEventListener("submit", handleAddTask);
  }

  /* ---------- WEEK NAVIGATION ---------- */

  const prevWeek = document.getElementById("prev-week");

  if (prevWeek) {
    prevWeek.addEventListener("click", handlePrevWeek);
  }

  const nextWeek = document.getElementById("next-week");

  if (nextWeek) {
    nextWeek.addEventListener("click", handleNextWeek);
  }

  /* ---------- ADD EVENT ---------- */

  const addEventButton = document.getElementById("add-event-btn");
  const eventModal = document.getElementById("event-modal");
  const eventDate = document.getElementById("event-date");
  const eventStart = document.getElementById("event-start");
  const eventEnd = document.getElementById("event-end");

  if (addEventButton && eventModal) {
    addEventButton.addEventListener("click", () => {
      eventModal.classList.remove("is-hidden");

      if (eventDate) eventDate.value = formatDateISO(new Date());
      if (eventStart) eventStart.value = "17:00";
      if (eventEnd) eventEnd.value = "18:00";
    });
  } else {
    console.error("Plannr: Add Event elements not found.");
  }

  const cancelEventButton = document.getElementById("cancel-event-btn");

  if (cancelEventButton && eventModal) {
    cancelEventButton.addEventListener("click", () => {
      eventModal.classList.add("is-hidden");
    });
  }

  const eventForm = document.getElementById("event-form");

  if (eventForm) {
    eventForm.addEventListener("submit", handleAddEvent);
  }

  /* ---------- EDIT / DELETE POPUP ---------- */

  const editForm = document.getElementById("edit-form");
  const taskModal = document.getElementById("task-modal");

  if (editForm && taskModal) {
    editForm.addEventListener("submit", handleEditSubmit);

    document
      .getElementById("edit-cancel-btn")
      .addEventListener("click", closeTaskModal);

    document
      .getElementById("edit-delete-btn")
      .addEventListener("click", handleEditDelete);

    const groupDeleteBtn = document.getElementById("edit-delete-group-btn");

    if (groupDeleteBtn) {
      groupDeleteBtn.addEventListener("click", handleEditDeleteGroup);
    }

    document
      .getElementById("edit-done-btn")
      .addEventListener("click", handleEditToggleDone);

    // Click the dark backdrop to close
    taskModal.addEventListener("click", (e) => {
      if (e.target === taskModal) closeTaskModal();
    });
  } else {
    console.error("Plannr: Edit popup elements not found.");
  }

  // Click the backdrop of the Add Event popup to close it too
  if (eventModal) {
    eventModal.addEventListener("click", (e) => {
      if (e.target === eventModal) eventModal.classList.add("is-hidden");
    });
  }

  // Escape closes whichever popup is open
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;

    document.querySelectorAll(".event-modal").forEach((m) => {
      if (!m.classList.contains("is-hidden")) {
        m.classList.add("is-hidden");
      }
    });

    editingTaskId = null;
  });

  /* ---------- SIGN OUT ---------- */

  const signOutBtn = document.getElementById("signout-btn");

  if (signOutBtn) {
    signOutBtn.addEventListener("click", handleSignOut);
  }

  // If the session ends (expired, or signed out in another tab), leave the app.
  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      window.location.href = "index.html";
    }
  });

  /* ---------- EXTRAS ---------- */

  setupVoice();
  setupShortcuts();
  setupResizeWatcher();

  setInterval(renderNowLine, 60 * 1000);
  setInterval(renderDashboard, 60 * 1000);
  setInterval(checkReminders, 30 * 1000);

  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: light)");

    if (mq.addEventListener) {
      mq.addEventListener("change", () => {
        if (settings.theme === "system") applyTheme();
      });
    }
  }

  /* ---------- INITIAL RENDER ---------- */

  loadCalendarData();
}


/* Load saved data before rendering the calendar */

async function loadCalendarData() {
  try {
    const {
      data: { user },
      error: authError
    } = await supabaseClient.auth.getUser();

    if (authError || !user) {
      window.location.href = "index.html";
      return;
    }

    // Settings follow your account across devices.
    const cloudSettings = user.user_metadata && user.user_metadata.plannr_settings;

    if (cloudSettings) {
      settings = sanitizeSettings(cloudSettings);

      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        /* ignore */
      }

      applySettings();

      viewDays = computeViewDays();
      focusDate(new Date());
    }

    const { data: cloudTasks, error: tasksError } = await supabaseClient
      .from("tasks")
      .select("*")
      .eq("user_id", user.id)
      .order("scheduled_start", { ascending: true });

    if (tasksError) {
      throw tasksError;
    }

    tasks = (cloudTasks || []).map((task) => ({
      id: task.id,
      groupId: task.group_id || null,
      title: task.title,
      durationMinutes: task.duration_minutes,
      scheduledStart: task.scheduled_start
        ? formatLocalDateTime(new Date(task.scheduled_start))
        : null,
      deadline: task.deadline,
      preferredTime: task.preferred_time,
      status: task.status,
      priority: task.priority || "medium",
      type: task.type || "task"
    }));

    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));

    renderWeekLabel();
    renderCalendar();
    checkMissedTasks();
  } catch (error) {
    console.error("Plannr calendar failed to load:", error);

    alert("The calendar could not load. Please refresh the page and try again.");
  }
}


/* Start the app */

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupApp);
} else {
  setupApp();
}
