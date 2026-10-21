/* ============================================================
   PLANNR — app.js

   Handles:
   - Calendar rendering
   - AI task creation
   - AI task rescheduling
   - AI task deletion
   - Manual events
   - Task completion
   - Local browser storage

   ============================================================ */


/* ---------- 1. CONFIG ---------- */

const SUPABASE_URL = "https://tlimbaewebfyibhxdcbk.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Wkqp70DOPk_vDZNChqLi_g_70dmrgay";

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY
);

const DAY_START_HOUR = 7;
const DAY_END_HOUR = 22;
const SLOT_MINUTES = 30;

const STORAGE_KEY = "plannr_tasks_v1";


/* ---------- 2. TASK DATA ----------

   Task:
   {
     id: "t_123",
     title: "Study for chemistry",
     durationMinutes: 120,
     deadline: "2026-09-25",
     preferredTime: "evening",
     status: "scheduled",
     scheduledStart: "2026-09-25T18:00:00",
     type: "task"
   }

   Event:
   {
     id: "e_123",
     title: "Football practice",
     durationMinutes: 60,
     deadline: null,
     preferredTime: null,
     status: "scheduled",
     scheduledStart: "2026-09-25T17:00:00",
     type: "event"
   }

------------------------------------------------- */

let tasks = loadTasks();

let currentWeekStart = getStartOfWeek(new Date());


/* ---------- 3. STORAGE ---------- */

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error("Could not load saved tasks:", err);
    return [];
  }
}

let saveChain = Promise.resolve();

function saveTasks() {
  saveChain = saveChain.then(syncTasksNow).catch(console.error);
  return saveChain;
}

async function syncTasksNow() {
  try {
    // Keep the local backup
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(tasks)
    );

    // Get the signed-in user
    const {
      data: { user },
      error: userError
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      console.error("No signed-in user:", userError);
      return;
    }

    // Get the tasks currently stored for this user
    const { data: existingTasks, error: fetchError } =
      await supabaseClient
        .from("tasks")
        .select("id")
        .eq("user_id", user.id);

    if (fetchError) {
      console.error(
        "Could not check existing Supabase tasks:",
        fetchError
      );
      return;
    }

    // Find tasks that were deleted from Plannr
    const currentIds = new Set(
      tasks.map((task) => task.id)
    );

    const deletedIds =
      (existingTasks || [])
        .filter((task) => !currentIds.has(task.id))
        .map((task) => task.id);

    // Delete them from Supabase
    if (deletedIds.length > 0) {
      const { error: deleteError } =
        await supabaseClient
          .from("tasks")
          .delete()
          .eq("user_id", user.id)
          .in("id", deletedIds);

      if (deleteError) {
        console.error(
          "Could not delete tasks from Supabase:",
          deleteError
        );
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
      }));

      const { error } = await supabaseClient
        .from("tasks")
        .upsert(rows);

      if (error) {
        console.error(
          "Could not save tasks to Supabase:",
          error
        );
        return;
      }
    }

    console.log("Tasks synced with Supabase.");

  } catch (err) {
    console.error(
      "Could not sync tasks:",
      err
    );
  }
}

/* ---------- 4. DATE HELPERS ---------- */

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


function formatLocalDateTime(date) {
  const y = date.getFullYear();

  const m = String(date.getMonth() + 1).padStart(2, "0");

  const d = String(date.getDate()).padStart(2, "0");

  const h = String(date.getHours()).padStart(2, "0");

  const min = String(date.getMinutes()).padStart(2, "0");

  return `${y}-${m}-${d}T${h}:${min}:00`;
}


function formatWeekLabel(weekStart) {
  const weekEnd = addDays(weekStart, 6);

  const opts = {
    month: "short",
    day: "numeric"
  };

  return `${weekStart.toLocaleDateString(undefined, opts)} – ${weekEnd.toLocaleDateString(undefined, opts)}`;
}


/* ---------- 5. SCHEDULING ---------- */

function preferredHourRange(preferredTime) {

  switch (preferredTime) {

    case "morning":
      return [7, 12];

    case "afternoon":
      return [12, 17];

    case "evening":
      return [17, 22];

    default:
      return [
        DAY_START_HOUR,
        DAY_END_HOUR
      ];
  }
}


/* ---------- FIND OPEN SLOT ---------- */

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

  const deadline = task.deadline
    ? new Date(`${task.deadline}T23:59:59`)
    : addDays(now, 14);

  if (
    Number.isNaN(deadline.getTime()) ||
    deadline < now
  ) {
    return null;
  }

  let cursorDay = new Date(now);
  cursorDay.setHours(0, 0, 0, 0);

  const candidates = [];

  while (cursorDay <= deadline) {
    // Search the entire scheduling window.
    // Preferred hours are a scoring bonus, not a restriction.
    const daySlots = buildDaySlotBounds(
      cursorDay,
      DAY_START_HOUR,
      DAY_END_HOUR
    );

    for (
      let slotStart = daySlots.start;
      slotStart + durationMs <= daySlots.end;
      slotStart += SLOT_MINUTES * 60 * 1000
    ) {
      const candidateStart = new Date(slotStart);
      const candidateEnd = new Date(slotStart + durationMs);

      if (candidateStart < now) continue;
      if (task.earliestStart && candidateStart < task.earliestStart) continue;
      if (candidateEnd > deadline) continue;

      if (!isSlotFree(candidateStart, candidateEnd)) {
        continue;
      }

      const score = scoreTimeSlot(
        candidateStart,
        candidateEnd,
        task,
        deadline
      );

      candidates.push({
        start: candidateStart,
        score
      });
    }

    cursorDay = addDays(cursorDay, 1);
  }

  if (candidates.length === 0) {
    return null;
  }

  // Break ties in favor of the earlier slot.
  candidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return a.start.getTime() - b.start.getTime();
  });

  return formatLocalDateTime(candidates[0].start);
}


function scoreTimeSlot(
  candidateStart,
  candidateEnd,
  task,
  deadline
) {
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
  const priorityWeight = {
    low: 0.75,
    medium: 2,
    high: 4
  }[priority];

  const hoursFromNow = Math.max(
    0,
    (candidateStart.getTime() - now.getTime()) / 3600000
  );

  // A closer deadline increases the cost of waiting.
  const hoursUntilDeadline = (
    deadline.getTime() - candidateEnd.getTime()
  ) / 3600000;

  let deadlineMultiplier = 1;

  if (hoursUntilDeadline <= 24) {
    deadlineMultiplier = 2.5;
  } else if (hoursUntilDeadline <= 72) {
    deadlineMultiplier = 1.75;
  } else if (hoursUntilDeadline <= 168) {
    deadlineMultiplier = 1.25;
  }

  score -= hoursFromNow * priorityWeight * deadlineMultiplier;

  // Preferred time is a bonus, not a hard restriction.
  if (
    task.preferredTime === "morning" &&
    hour >= 7 && hour < 12
  ) {
    score += 35;
  } else if (
    task.preferredTime === "afternoon" &&
    hour >= 12 && hour < 17
  ) {
    score += 35;
  } else if (
    task.preferredTime === "evening" &&
    hour >= 17 && hour < 22
  ) {
    score += 35;
  }

  // Avoid scheduling too close to the end of the day when possible.
  if (hour >= 21) {
    score -= 20;
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
      total + (
        Number.isFinite(Number(existingTask.durationMinutes)) &&
        Number(existingTask.durationMinutes) > 0
          ? Number(existingTask.durationMinutes)
          : 60
      ),
    0
  );

  const projectedMinutes =
    existingMinutes + Number(task.durationMinutes || 60);

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

    const gapBefore = (
      candidateStart.getTime() - existingEnd.getTime()
    ) / 60000;

    const gapAfter = (
      existingStart.getTime() - candidateEnd.getTime()
    ) / 60000;

    if (
      (gapBefore >= 0 && gapBefore < 15) ||
      (gapAfter >= 0 && gapAfter < 15)
    ) {
      score -= 18;
    }
  }

  return score;
}

/* ---------- DAY SLOT BOUNDS ---------- */

function buildDaySlotBounds(
  day,
  prefStartHour,
  prefEndHour
) {

  const start = new Date(day);

  start.setHours(
    Math.max(
      prefStartHour,
      DAY_START_HOUR
    ),
    0,
    0,
    0
  );


  const end = new Date(day);

  end.setHours(
    Math.min(
      prefEndHour,
      DAY_END_HOUR
    ),
    0,
    0,
    0
  );


  return {
    start: start.getTime(),
    end: end.getTime()
  };
}


/* ---------- CHECK FOR CONFLICTS ---------- */

function isSlotFree(
  candidateStart,
  candidateEnd,
  ignoreTaskId = null
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

  return tasks.every((task) => {
    if (
      (ignoreTaskId && task.id === ignoreTaskId) ||
      task.status !== "scheduled" ||
      !task.scheduledStart
    ) {
      return true;
    }

    const existingStartMs = new Date(
      task.scheduledStart
    ).getTime();

    // Invalid existing entries cannot be reliably checked.
    // Report them in the console so they can be corrected.
    if (!Number.isFinite(existingStartMs)) {
      console.warn(
        "Plannr: Ignoring an item with an invalid start date:",
        task
      );
      return true;
    }

    const rawDuration = Number(task.durationMinutes);
    const durationMinutes =
      Number.isFinite(rawDuration) && rawDuration > 0
        ? rawDuration
        : 60;

    const existingEndMs =
      existingStartMs + durationMinutes * 60000;

    // Adjacent events are allowed; actual overlap is not.
    return (
      endMs <= existingStartMs ||
      startMs >= existingEndMs
    );
  });
}


/* ---------- 7. RENDERING ---------- */

function renderWeekLabel() {

  document.getElementById(
    "week-label"
  ).textContent =
    formatWeekLabel(
      currentWeekStart
    );
}


function renderCalendar() {

  const grid =
    document.getElementById(
      "calendar-grid"
    );


  grid.innerHTML = "";


  const totalHours =
    DAY_END_HOUR -
    DAY_START_HOUR;


  grid.style.gridTemplateRows =
    `auto repeat(${totalHours}, var(--hour-height))`;


  /*
     Empty top-left corner
  */

  const corner =
    document.createElement("div");

  corner.style.gridRow = "1";

  corner.style.gridColumn = "1";

  grid.appendChild(corner);


  /*
     Today's date
  */

  const todayISO =
    formatDateISO(
      new Date()
    );


  /*
     Day headers
  */

  for (let i = 0; i < 7; i++) {

    const dayDate =
      addDays(
        currentWeekStart,
        i
      );


    const header =
      document.createElement("div");


    header.className =
      "day-header";


    const isToday =
      formatDateISO(dayDate) ===
      todayISO;


    if (isToday) {
      header.classList.add(
        "is-today"
      );
    }


    header.style.gridColumn =
      i + 2;


    header.innerHTML = `
      <span class="day-name">
        ${dayDate.toLocaleDateString(
          undefined,
          {
            weekday: "short"
          }
        )} ${dayDate.getDate()}
      </span>

      ${
        isToday
          ? '<span class="today-label">TODAY</span>'
          : ""
      }
    `;


    grid.appendChild(header);
  }


  /*
     Hour labels
  */

  for (
    let h = 0;
    h < totalHours;
    h++
  ) {

    const label =
      document.createElement("div");


    label.className =
      "hour-label";


    label.style.gridRow =
      h + 2;


    const hour =
      DAY_START_HOUR + h;


    const displayHour =
      hour % 12 === 0
        ? 12
        : hour % 12;


    const ampm =
      hour < 12
        ? "am"
        : "pm";


    label.textContent =
      `${displayHour}${ampm}`;


    grid.appendChild(label);
  }


  /*
     Day columns
  */

  for (let i = 0; i < 7; i++) {

    const col =
      document.createElement("div");


    col.className =
      "day-column";


    col.style.gridColumn =
      i + 2;


    col.style.gridRow =
      `2 / span ${totalHours}`;


    col.dataset.date =
      formatDateISO(
        addDays(
          currentWeekStart,
          i
        )
      );


    grid.appendChild(col);
  }


  placeTasksOnGrid();

  runProactiveInsights();
}


/* ---------- PLACE TASKS ON CALENDAR ---------- */

function placeTasksOnGrid() {

  const columns =
    document.querySelectorAll(
      ".day-column"
    );


  const columnsByDate = {};


  columns.forEach((col) => {

    columnsByDate[
      col.dataset.date
    ] = col;

  });


  tasks.forEach((task) => {

    if (!task.scheduledStart) {
      return;
    }


    const start =
      new Date(
        task.scheduledStart
      );


    const dateKey =
      formatDateISO(start);


    const col =
      columnsByDate[dateKey];


    if (!col) {
      return;
    }


    const hourHeightPx =
      parseFloat(
        getComputedStyle(
          document.documentElement
        ).getPropertyValue(
          "--hour-height"
        )
      );


    const startMinutesFromDayStart =
      (
        start.getHours() -
        DAY_START_HOUR
      ) *
        60 +
      start.getMinutes();


    const topPx =
      (
        startMinutesFromDayStart /
        60
      ) *
      hourHeightPx;


    const heightPx =
      (
        task.durationMinutes /
        60
      ) *
      hourHeightPx;


    const block =
      document.createElement("div");

    block.className =
      "task-block event-color-" +
      (
        Math.abs(
          [...task.id].reduce(
            (sum, char) => sum + char.charCodeAt(0),
            0
          )
        ) % 6 + 1
      ) +
      (
        task.status === "done"
          ? " is-done"
          : ""
      );
     
    block.style.top =
      `${topPx}px`;


    block.style.height =
      `${Math.max(
        heightPx,
        20
      )}px`;


    block.innerHTML = `
      <span class="task-title">
        ${escapeHTML(task.title)}
      </span>

      <span class="task-time">
        ${formatTimeShort(start)}
      </span>
    `;


    block.addEventListener(
      "click",
      () => toggleTaskDone(task.id)
    );


    col.appendChild(block);

  });
}


/* ---------- FORMAT TIME ---------- */

function formatTimeShort(date) {

  return date.toLocaleTimeString(
    undefined,
    {
      hour: "numeric",
      minute: "2-digit"
    }
  );
}


/* ---------- ESCAPE HTML ---------- */

function escapeHTML(str) {

  const div =
    document.createElement("div");

  div.textContent = str;

  return div.innerHTML;
}


/* ---------- COMPLETE TASK ---------- */

function toggleTaskDone(taskId) {

  const task =
    tasks.find(
      (t) => t.id === taskId
    );


  if (!task) {
    return;
  }

  if (task.status === "done" && task.scheduledStart) {
    const start = new Date(task.scheduledStart);
    const end = new Date(start.getTime() + (task.durationMinutes || 60) * 60000);
   
    if (!isSlotFree(start, end, task.id)) {
       setStatus("Can't undo: that time is now taken. Try replanning it.", true);
       return;
    }
  }

  task.status =
    task.status === "done"
      ? "scheduled"
      : "done";


  saveTasks();

  renderCalendar();
}


/* ---------- 8. MANUAL EVENTS ---------- */

function handleAddEvent(event) {

  event.preventDefault();


  const title =
    document.getElementById(
      "event-title"
    ).value.trim();


  const date =
    document.getElementById(
      "event-date"
    ).value;


  const startTime =
    document.getElementById(
      "event-start"
    ).value;


  const endTime =
    document.getElementById(
      "event-end"
    ).value;


  if (
    !title ||
    !date ||
    !startTime ||
    !endTime
  ) {
    return;
  }


  const start =
    new Date(
      `${date}T${startTime}`
    );


  const end =
    new Date(
      `${date}T${endTime}`
    );


  if (end <= start) {

    alert(
      "End time must be after start time."
    );

    return;
  }


  const durationMinutes =
    Math.round(
      (
        end.getTime() -
        start.getTime()
      ) /
      (1000 * 60)
    );


  /*
     Prevent manual events from being
     created in the past.
  */

  if (start < new Date()) {

    alert(
      "You cannot create an event in the past."
    );

    return;
  }


  const newEvent = {

    id:
      crypto.randomUUID(),

    title,

    durationMinutes,

    deadline: null,

    preferredTime: null,

    status: "scheduled",

    scheduledStart:
      formatLocalDateTime(start),

    type: "event"
  };


  if (
    !isSlotFree(
      start,
      end
    )
  ) {

    alert(
      "That time overlaps another task or event."
    );

    return;
  }


  tasks.push(newEvent);

  saveTasks();


  /*
     Show the week containing
     the new event.
  */

  currentWeekStart =
    getStartOfWeek(start);


  document.getElementById(
    "event-form"
  ).reset();


  document.getElementById(
    "event-modal"
  ).classList.add(
    "is-hidden"
  );


  renderWeekLabel();

  renderCalendar();
}


/* ---------- 9. STATUS ---------- */

function setStatus(
  message,
  isError = false
) {

  const el =
    document.getElementById(
      "status-line"
    );


  el.textContent =
    message;


  el.classList.toggle(
    "is-error",
    isError
  );
}

/* ============================================================
   9.5. PROACTIVE INSIGHTS
   Looks for tasks that are at risk of missing their deadline.
   ============================================================ */

const dismissedInsights = new Set();

function insightKey(insight) {
  if (insight.type === "overloaded") {
    return `overloaded:${new Date(insight.task.scheduledStart).toDateString()}`;
  }
  return `${insight.type}:${insight.task.id}`;
}

function formatInsightTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "long", hour: "numeric", minute: "2-digit"
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
        data-insight-action="schedule" data-task-id="${task.id}">
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

  const scheduleButton = container.querySelector('[data-insight-action="schedule"]');
  if (scheduleButton) {
    scheduleButton.addEventListener("click", () =>
      scheduleInsightTask(scheduleButton.dataset.taskId)
    );
  }

  container.querySelector('[data-insight-action="dismiss"]').addEventListener("click", () => {
    dismissedInsights.add(insightKey(insight));
    container.style.display = "none";
  });
}
/**
 * Schedule a task using the slot discovered
 * by the proactive insight engine.
 */
async function scheduleInsightTask(taskId) {

  const task =
    tasks.find(
      (t) => t.id === taskId
    );


  if (!task) {
    return;
  }


  const suggestedSlot =
    findInsightSlot(task);


  if (!suggestedSlot) {

    setStatus(
      `I couldn't find an open time for "${task.title}".`,
      true
    );

    return;
  }


  /*
     Update the EXISTING task.
     Do not create a duplicate.
  */
  task.scheduledStart =
    suggestedSlot;


  task.status =
    "scheduled";


  await saveTasks();


  /*
     Show the week containing
     the newly scheduled task.
  */
  currentWeekStart =
    getStartOfWeek(
      new Date(suggestedSlot)
    );


  setStatus(
    `Scheduled "${task.title}" for ${new Date(
      suggestedSlot
    ).toLocaleString(
      undefined,
      {
        weekday: "long",
        hour: "numeric",
        minute: "2-digit"
      }
    )}.`
  );


  renderWeekLabel();

  renderCalendar();

  renderProactiveInsight();
}


/**
 * Run proactive analysis.
 */
function runProactiveInsights() {

  /*
     Small delay prevents the insight from appearing
     before the calendar has finished rendering.
  */
  setTimeout(
    () => {
      renderProactiveInsight();
    },
    100
  );
}


/* ---------- FIND EXISTING TASK ---------- */

function findTaskByTitle(targetTitle) {
  if (
    typeof targetTitle !== "string" ||
    !targetTitle.trim()
  ) {
    return null;
  }

  const target = targetTitle.toLowerCase().trim();

  // Only consider scheduled tasks with valid titles.
  const scheduledTasks = tasks.filter(
    (task) =>
      task &&
      task.status === "scheduled" &&
      typeof task.title === "string" &&
      task.title.trim() !== ""
  );

  // 1. Try an exact title match.
  let match = scheduledTasks.find(
    (task) =>
      task.title.toLowerCase().trim() === target
  );

  if (match) {
    return match;
  }

  // 2. Try a partial title match.
  match = scheduledTasks.find((task) => {
    const title = task.title.toLowerCase().trim();

    return (
      title.includes(target) ||
      target.includes(title)
    );
  });

  if (match) {
    return match;
  }

  // 3. Match meaningful words in the title.
  const ignoredWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "into",
    "move",
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
    .filter(
      (word) =>
        word.length > 2 &&
        !ignoredWords.has(word)
    );

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

  // Require at least one meaningful matching word.
  return bestScore > 0 ? bestMatch : null;
}


/* ---------- RESCHEDULE TASK ---------- */

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

  // Keep the original date if no new date was provided.
  const newDate = parsed.date || formatDateISO(oldStart);

  // Keep the original time if no new time was provided.
  let newTime = parsed.time;

  if (!newTime) {
    const hours = String(oldStart.getHours()).padStart(2, "0");
    const minutes = String(oldStart.getMinutes()).padStart(2, "0");

    newTime = `${hours}:${minutes}`;
  }

  // Validate the date and time before creating a Date.
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

  if (
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59
  ) {
    setStatus("Please provide a valid date and time.", true);
    return false;
  }

  const newStart = new Date(
    year,
    month - 1,
    day,
    hour,
    minute,
    0,
    0
  );

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

  const newEnd = new Date(
    newStart.getTime() + duration * 60 * 1000
  );

  if (newStart < new Date()) {
    setStatus("I can't move a task into the past.", true);
    return false;
  }

  const originalIndex = tasks.indexOf(task);

  const free = isSlotFree(
  newStart,
  newEnd,
  task.id
  );

  if (!free) {
    setStatus("That time overlaps another task or event.", true);
    return false;
  }

  // Update the existing task without changing its ID.
  task.scheduledStart = formatLocalDateTime(newStart);

  saveTasks();

  currentWeekStart = getStartOfWeek(newStart);

  setStatus("Task rescheduled successfully.");

  renderWeekLabel();
  renderCalendar();

  return true;
}


/* ---------- DELETE TASK ---------- */

function deleteTaskWithAI(parsed) {
  if (!parsed || !parsed.targetTitle) {
    setStatus("Please specify which task to delete.", true);
    return false;
  }

  const task = findTaskByTitle(parsed.targetTitle);

  if (!task) {
    setStatus(
      `I couldn't find "${parsed.targetTitle}" on your calendar.`,
      true
    );
    return false;
  }

  const taskTitle = task.title;
  const taskId = task.id;

  // Remove only the selected task.
  tasks = tasks.filter(
    (item) => item.id !== taskId
  );

  saveTasks();

  setStatus(`Deleted "${taskTitle}".`);

  renderCalendar();

  return true;
}


/* ---------- CREATE TASK ---------- */

async function createTask(
  parsed,
  rawText
) {

  /*
     If the AI gave an exact date AND time,
     use that exact time.

     Otherwise use our scheduling algorithm.
  */

  let scheduledStart = null;


  if (
    parsed.date &&
    parsed.time
  ) {

    const exactStart =
      new Date(
        `${parsed.date}T${parsed.time}`
      );


    const exactEnd =
      new Date(
        exactStart.getTime() +
        (
          parsed.durationMinutes ||
          60
        ) *
        60 *
        1000
      );


    /*
       Don't allow past times.
    */

    if (
      exactStart < new Date()
    ) {

      setStatus(
        "That time has already passed. Try a future time.",
        true
      );

      return false;
    }


    /*
       Don't allow conflicts.
    */

    if (
      !isSlotFree(
        exactStart,
        exactEnd
      )
    ) {

      setStatus(
        "That time overlaps another task or event.",
        true
      );

      return false;
    }


    scheduledStart =
      formatLocalDateTime(
        exactStart
      );

  } else {

    /*
       No exact time was given.
       Let our scheduler choose one.
    */

    const taskForScheduling = {

      title:
        parsed.title ||
        rawText,

      durationMinutes:
        parsed.durationMinutes ||
        60,

      deadline:
        parsed.deadline ||
        null,

      preferredTime:
        parsed.preferredTime ||
        null,

      status: "scheduled",

      priority: parsed.priority || "medium",

      scheduledStart: null,

      type: "task"
    };

    if (parsed.date && !parsed.time) {
      taskForScheduling.earliestStart = new Date(`${parsed.date}T00:00:00`);
      taskForScheduling.deadline = parsed.date;
    }
    
    scheduledStart =
     findOpenSlot(
     taskForScheduling
    );


    if (!scheduledStart) {

      setStatus(
        "Couldn't find an open future slot before that deadline.",
        true
      );

      return false;
    }
  }


  /*
     Create the actual task.
  */

  const task = {

    id:
      crypto.randomUUID(),
     
    title:
      parsed.title ||
      rawText,

    durationMinutes:
      parsed.durationMinutes ||
      60,

    deadline:
      parsed.deadline ||
      null,

    preferredTime:
      parsed.preferredTime ||
      null,

    status: "scheduled",

    priority: parsed.priority || "medium",

    scheduledStart,

    type: "task"
  };


  tasks.push(task);

  await saveTasks();


  /*
     Automatically show the week
     where the task was created.
  */

  currentWeekStart =
    getStartOfWeek(
      new Date(scheduledStart)
    );


  setStatus(
    `Scheduled for ${new Date(
      scheduledStart
    ).toLocaleString(
      undefined,
      {
        weekday: "long",
        hour: "numeric",
        minute: "2-digit"
      }
    )}.`
  );


  renderWeekLabel();

  renderCalendar();


  return true;
}


/* ---------- AI PARSING (with retry) ---------- */

const RETRYABLE_STATUS = [429, 500, 502, 503, 504];

async function waitBeforeRetry(attempt, onRetry) {
  if (onRetry) onRetry(attempt);
  const delay = 700 * 2 ** (attempt - 1) + Math.random() * 300; // ~0.7s, 1.4s, 2.8s
  await new Promise((resolve) => setTimeout(resolve, delay));
}

async function parseTaskWithAI(rawText, onRetry) {
  const maxAttempts = 4;

  const { data: { session } } = await supabaseClient.auth.getSession();

  if (!session) {
     const e = new Error("Please sign in again.");
     e.kind = "auth";
     throw e;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;

    try {
      response = await fetch("/api/parse-task", {
        method: "POST",
        headers: {
           "Content-Type": "application/json",
           "Authorization": `Bearer ${session.access_token}`
         },
         body: JSON.stringify({ text: rawText, today: formatDateISO(new Date()) })
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

    // A 502 from Vercel may not return JSON, so parse defensively
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

/* ============================================================
   SMART AUTO-RESCHEDULING
   ============================================================ */

const MISSED_LOOKBACK_DAYS = 7;

let lastReplanUndo = null;        // [{ id, scheduledStart }]
let missedBannerDismissed = false;

const MISSED_DISMISS_KEY = "plannr_missed_dismissed";


/* ---------- BANNER CONTAINER ---------- */

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


/* ---------- COMPLETE TASK (AI) ---------- */

function completeTaskWithAI(parsed) {
  if (!parsed || !parsed.targetTitle) {
    setStatus("Please tell me which task you finished.", true);
    return false;
  }

  const task = findTaskByTitle(parsed.targetTitle);

  if (!task) {
    setStatus(
      `I couldn't find "${parsed.targetTitle}" on your calendar.`,
      true
    );
    return false;
  }

  task.status = "done";

  saveTasks();

  setStatus(`Nice work! Marked "${task.title}" as done.`);

  renderCalendar();

  return true;
}


/* ---------- WHEN IS THE USER AVAILABLE AGAIN? ---------- */

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


/* ---------- WHICH TASKS NEED TO MOVE? ---------- */

function getReplanCandidates(scope, targetTask, earliest) {
  if (scope === "task") {
    return targetTask ? [targetTask] : [];
  }

  const now = new Date();
  const lookbackStart = addDays(now, -MISSED_LOOKBACK_DAYS);
  const todayKey = formatDateISO(now);

  return tasks.filter((task) => {
    // Events (football practice, appointments) never move on their own
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


/* ---------- ORDER: DEADLINE FIRST, THEN PRIORITY ---------- */

function compareForReplan(a, b) {
  const deadlineMs = (t) =>
    t.deadline
      ? new Date(`${t.deadline}T23:59:59`).getTime()
      : Infinity;

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


/* ---------- THE RE-PLANNER ---------- */

function replanTasks(candidates, earliest) {
  const ordered = [...candidates].sort(compareForReplan);

  // Remember where everything was, for Undo
  const undo = ordered.map((task) => ({
    id: task.id,
    scheduledStart: task.scheduledStart
  }));

  const originals = new Map(
    undo.map((u) => [u.id, u.scheduledStart])
  );

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
      earliestStart: earliest
    });

    if (slot) {
      task.scheduledStart = slot;
      moved.push(task);
      return;
    }

    // Couldn't fit it: put it back and report why
    task.scheduledStart = originals.get(task.id);

    const deadlinePassed =
      task.deadline &&
      new Date(`${task.deadline}T23:59:59`) < now;

    failed.push({
      task,
      reason: deadlinePassed
        ? "its deadline has passed"
        : "no open time before its deadline"
    });
  });

  return { moved, failed, undo };
}


/* ---------- RUN A REPLAN ---------- */

async function runReplan({
  scope,
  targetTask = null,
  earliest = new Date()
}) {
  const candidates = getReplanCandidates(
    scope,
    targetTask,
    earliest
  );

  if (candidates.length === 0) {
    setStatus("Nothing needs replanning. You're all caught up.");
    clearReplanBanner();
    return false;
  }

  const { moved, failed, undo } = replanTasks(candidates, earliest);

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

    currentWeekStart = getStartOfWeek(firstStart);
  }

  renderWeekLabel();
  renderCalendar();

  showReplanSummary(moved, failed);

  setStatus(
    moved.length
      ? `Replanned ${moved.length} task${moved.length === 1 ? "" : "s"}.`
      : "I couldn't fit those tasks in.",
    moved.length === 0
  );

  return true;
}


/* ---------- AI ENTRY POINT ---------- */

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


/* ---------- SUMMARY CARD WITH UNDO ---------- */

function showReplanSummary(moved, failed) {
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

  const headline = moved.length
    ? `Replanned ${moved.length} task${moved.length === 1 ? "" : "s"}`
    : "Couldn't replan";

  container.innerHTML = `
    <div class="insight-card ${failed.length ? "insight-high" : "insight-medium"}">
      <div class="insight-content">
        <div class="insight-label">Smart replan</div>
        <div class="insight-title">${headline}</div>
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


/* ---------- UNDO ---------- */

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

  setStatus("Undid the replan.");
}


/* ---------- MISSED-TASK BANNER ON LOAD ---------- */

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

/* ---------- 10. MAIN AI HANDLER ---------- */

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

    if (parsed.action === "create") {
      await createTask(parsed, rawText);
    } else if (parsed.action === "reschedule") {
      rescheduleTask(parsed);
    } else if (parsed.action === "delete") {
      deleteTaskWithAI(parsed);
    } else if (parsed.action === "complete") {
      completeTaskWithAI(parsed);
    } else if (parsed.action === "replan") {
      await replanWithAI(parsed);
    } else {
      const e = new Error("Unrecognized action from AI: " + parsed.action);
      e.kind = "invalid";
      throw e;
    }

    // Only clear the input on success, so the text is kept if something fails
    input.value = "";
  } catch (err) {
    console.error(err);

    if (err.kind === "busy") {
      setStatus("The AI is overloaded right now. Please try again in a minute.", true);
    } else if (err.kind === "network") {
      setStatus("Network error. Check your connection and try again.", true);
    } else if (err.kind === "auth") {
      setStatus("Your session expired. Please sign in again.", true);
    } else {
      setStatus("Something went wrong reading that task. Try rephrasing it.", true);
    }
  } finally {
    submitBtn.disabled = false;
  }
}

/* ---------- 11. WEEK NAVIGATION ---------- */

function handlePrevWeek() {

  currentWeekStart =
    addDays(
      currentWeekStart,
      -7
    );


  renderWeekLabel();

  renderCalendar();
}


function handleNextWeek() {

  currentWeekStart =
    addDays(
      currentWeekStart,
      7
    );


  renderWeekLabel();

  renderCalendar();
}


/* ---------- 12. INITIALIZATION ---------- */

function setupApp() {

  /* ---------- AI TASK FORM ---------- */

  const taskForm =
    document.getElementById("task-form");

  if (taskForm) {
    taskForm.addEventListener(
      "submit",
      handleAddTask
    );
  }


  /* ---------- PREVIOUS WEEK ---------- */

  const prevWeek =
    document.getElementById("prev-week");

  if (prevWeek) {
    prevWeek.addEventListener(
      "click",
      handlePrevWeek
    );
  }


  /* ---------- NEXT WEEK ---------- */

  const nextWeek =
    document.getElementById("next-week");

  if (nextWeek) {
    nextWeek.addEventListener(
      "click",
      handleNextWeek
    );
  }


  /* ---------- ADD EVENT ---------- */

  const addEventButton =
    document.getElementById("add-event-btn");

  const eventModal =
    document.getElementById("event-modal");

  const eventDate =
    document.getElementById("event-date");

  const eventStart =
    document.getElementById("event-start");

  const eventEnd =
    document.getElementById("event-end");


  if (addEventButton && eventModal) {

    addEventButton.addEventListener(
      "click",
      () => {

        eventModal.classList.remove(
          "is-hidden"
        );

        if (eventDate) {
          eventDate.value =
            formatDateISO(new Date());
        }

        if (eventStart) {
          eventStart.value = "17:00";
        }

        if (eventEnd) {
          eventEnd.value = "18:00";
        }

      }
    );

  } else {

    console.error(
      "Plannr: Add Event elements not found."
    );

  }


  /* ---------- CANCEL EVENT ---------- */

  const cancelEventButton =
    document.getElementById(
      "cancel-event-btn"
    );

  if (cancelEventButton && eventModal) {

    cancelEventButton.addEventListener(
      "click",
      () => {

        eventModal.classList.add(
          "is-hidden"
        );

      }
    );

  }


  /* ---------- EVENT FORM ---------- */

  const eventForm =
    document.getElementById("event-form");

  if (eventForm) {

    eventForm.addEventListener(
      "submit",
      handleAddEvent
    );

  }


  /* ---------- INITIAL RENDER ---------- */

  
  /* ---------- INITIAL RENDER ---------- */

  loadCalendarData();

}

/* Load saved tasks before rendering the calendar */

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

    const {
      data: cloudTasks,
      error: tasksError
    } = await supabaseClient
      .from("tasks")
      .select("*")
      .eq("user_id", user.id)
      .order("scheduled_start", {
        ascending: true
      });

    if (tasksError) {
      throw tasksError;
    }

    tasks = (cloudTasks || []).map((task) => ({
      id: task.id,
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

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(tasks)
    );

    renderWeekLabel();
    renderCalendar();
    checkMissedTasks();

  } catch (error) {
    console.error(
      "Plannr calendar failed to load:",
      error
    );

    alert(
      "The calendar could not load. Please refresh the page and try again."
    );
  }
}

/* Start the app */

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    setupApp
  );
} else {
  setupApp();
}


