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

async function saveTasks() {
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
        scheduled_start: task.scheduledStart || null,
        deadline: task.deadline || null,
        preferred_time: task.preferredTime || null,
        status: task.status || "scheduled"
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

  const deadline = task.deadline
    ? new Date(`${task.deadline}T23:59:59`)
    : addDays(now, 14);

  const [prefStart, prefEnd] =
    preferredHourRange(task.preferredTime);

  const durationMs =
    task.durationMinutes * 60 * 1000;

  /*
     Start searching today.

     IMPORTANT:
     We still start at midnight, but later we
     reject any candidate that has already passed.
  */

  let cursorDay = new Date(now);

  cursorDay.setHours(0, 0, 0, 0);

  const candidates = [];


  while (cursorDay <= deadline) {

    const daySlots = buildDaySlotBounds(
      cursorDay,
      prefStart,
      prefEnd
    );


    for (
      let slotStart = daySlots.start;

      slotStart + durationMs <= daySlots.end;

      slotStart += SLOT_MINUTES * 60 * 1000
    ) {

      const candidateStart =
        new Date(slotStart);

      const candidateEnd =
        new Date(slotStart + durationMs);


      /*
         NEVER schedule something that has
         already started or ended.

         This fixes:
         "It scheduled something yesterday"
         and
         "It scheduled something earlier today."
      */

      if (candidateStart < now) {
        continue;
      }


      /*
         Don't schedule after deadline.
      */

      if (candidateEnd > deadline) {
        continue;
      }


      /*
         Don't overlap another task/event.
      */

      if (
        !isSlotFree(
          candidateStart,
          candidateEnd
        )
      ) {
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
        end: candidateEnd,
        score
      });
    }


    cursorDay = addDays(
      cursorDay,
      1
    );
  }


  if (candidates.length === 0) {
    return null;
  }


  candidates.sort(
    (a, b) => b.score - a.score
  );


  return formatLocalDateTime(
    candidates[0].start
  );
}


function scoreTimeSlot(
  candidateStart,
  candidateEnd,
  task,
  deadline
) {
  let score = 0;

  const hour = candidateStart.getHours();
  const candidateDate = formatDateISO(candidateStart);

  /* ============================================================
     1. PREFER EARLIER TIMES
     ============================================================ */

  const hoursFromNow =
    (
      candidateStart.getTime() - Date.now()
    ) /
    (1000 * 60 * 60);

  score -= hoursFromNow * 2;


  /* ============================================================
     2. PREFERRED TIME OF DAY
     ============================================================ */

  if (
    task.preferredTime === "morning" &&
    hour >= 7 &&
    hour < 12
  ) {
    score += 40;
  }

  if (
    task.preferredTime === "afternoon" &&
    hour >= 12 &&
    hour < 17
  ) {
    score += 40;
  }

  if (
    task.preferredTime === "evening" &&
    hour >= 17 &&
    hour < 22
  ) {
    score += 40;
  }


  /* ============================================================
     3. AVOID VERY LATE TIMES
     ============================================================ */

  if (hour >= 21) {
    score -= 20;
  }


  /* ============================================================
     4. DEADLINE URGENCY
     ============================================================ */

  const hoursUntilDeadline =
    (
      deadline.getTime() -
      candidateStart.getTime()
    ) /
    (1000 * 60 * 60);

  if (hoursUntilDeadline <= 24) {
    score += 40;
  } else if (hoursUntilDeadline <= 48) {
    score += 25;
  } else if (hoursUntilDeadline <= 72) {
    score += 10;
  }


  /* ============================================================
     5. DON'T OVERLOAD ONE DAY
     ============================================================ */

  const tasksThatDay = tasks.filter((t) => {
    if (
      t.status !== "scheduled" ||
      !t.scheduledStart
    ) {
      return false;
    }

    return (
      formatDateISO(
        new Date(t.scheduledStart)
      ) === candidateDate
    );
  });

  score -= tasksThatDay.length * 8;


  /* ============================================================
     6. PREFER A LITTLE SPACE BETWEEN COMMITMENTS
     ============================================================ */

  tasksThatDay.forEach((existingTask) => {
    const existingStart =
      new Date(existingTask.scheduledStart);

    const existingEnd =
      new Date(
        existingStart.getTime() +
        existingTask.durationMinutes * 60 * 1000
      );

    const gapBefore =
      (
        candidateStart.getTime() -
        existingEnd.getTime()
      ) /
      (1000 * 60);

    const gapAfter =
      (
        existingStart.getTime() -
        candidateEnd.getTime()
      ) /
      (1000 * 60);

    /*
       Small gaps are awkward.

       Example:
       4:00–4:30 task
       4:30–5:00 new task

       That's less desirable than giving the user
       some breathing room.
    */

    if (gapBefore >= 0 && gapBefore < 15) {
      score -= 15;
    }

    if (gapAfter >= 0 && gapAfter < 15) {
      score -= 15;
    }


    /*
       A healthy 15–60 minute gap is useful.
    */

    if (gapBefore >= 15 && gapBefore <= 60) {
      score += 8;
    }

    if (gapAfter >= 15 && gapAfter <= 60) {
      score += 8;
    }
  });


  /* ============================================================
     7. DON'T CREATE A RIDICULOUSLY PACKED DAY
     ============================================================ */

  const totalMinutesThatDay =
    tasksThatDay.reduce(
      (total, existingTask) =>
        total +
        (existingTask.durationMinutes || 0),
      0
    );

  if (totalMinutesThatDay >= 300) {
    score -= 20;
  }

  if (totalMinutesThatDay >= 420) {
    score -= 35;
  }


  /* ============================================================
     8. FAVOR TODAY/TOMORROW WITHOUT IGNORING DEADLINES
     ============================================================ */

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(
    tomorrow.getDate() + 1
  );

  if (
    candidateStart >= today &&
    candidateStart < tomorrow
  ) {
    score += 12;
  }

  const dayAfterTomorrow =
    new Date(tomorrow);

  dayAfterTomorrow.setDate(
    dayAfterTomorrow.getDate() + 1
  );

  if (
    candidateStart >= tomorrow &&
    candidateStart < dayAfterTomorrow
  ) {
    score += 8;
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
  candidateEnd
) {

  return tasks.every((t) => {

    if (
      t.status !== "scheduled" ||
      !t.scheduledStart
    ) {
      return true;
    }


    const existingStart =
      new Date(t.scheduledStart);


    const existingEnd =
      new Date(
        existingStart.getTime() +
        t.durationMinutes * 60 * 1000
      );


    return (
      candidateEnd <= existingStart ||
      candidateStart >= existingEnd
    );
  });
}


/* ---------- 6. GEMINI ---------- */

async function parseTaskWithAI(rawText) {

  const response = await fetch(
    "/api/parse-task",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        text: rawText
      })
    }
  );


  if (!response.ok) {

    const errorData =
      await response
        .json()
        .catch(() => null);


    throw new Error(
      errorData?.error ||
      `Server responded with ${response.status}`
    );
  }


  const data =
    await response.json();


  return data;
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

function getTaskEnd(task) {
  if (!task.scheduledStart) {
    return null;
  }

  const start = new Date(task.scheduledStart);

  return new Date(
    start.getTime() +
    (task.durationMinutes || 60) * 60 * 1000
  );
}


/**
 * Find the next available slot for a task.
 *
 * This uses the EXISTING scheduler, so we don't create
 * a second scheduling system.
 */
function findInsightSlot(task) {
  return findOpenSlot({
    title: task.title,

    durationMinutes:
      task.durationMinutes || 60,

    deadline:
      task.deadline || null,

    preferredTime:
      task.preferredTime || null,

    status: "scheduled",

    scheduledStart: null,

    type: "task"
  });
}


/**
 * Determine whether a task has enough scheduled time
 * before its deadline.
 *
 * For now, each task is treated as one block because
 * your current task model stores one scheduledStart.
 */
function analyzeTaskDeadline(task) {
  if (
    task.type !== "task" ||
    task.status === "done" ||
    !task.deadline
  ) {
    return null;
  }

  const now = new Date();

  const deadline = new Date(
    `${task.deadline}T23:59:59`
  );

  const scheduledStart =
    task.scheduledStart
      ? new Date(task.scheduledStart)
      : null;

  const scheduledEnd =
    scheduledStart
      ? getTaskEnd(task)
      : null;


  /*
     Already scheduled after the deadline.
  */
  if (
    scheduledEnd &&
    scheduledEnd > deadline
  ) {
    return {
      type: "deadline",
      severity: "high",
      task,
      message:
        `"${task.title}" is scheduled after its deadline.`
    };
  }


  /*
     Task has no scheduled time yet.
  */
  if (!scheduledStart) {

    const hoursUntilDeadline =
      (
        deadline.getTime() -
        now.getTime()
      ) /
      (1000 * 60 * 60);

    if (hoursUntilDeadline <= 48) {

      const suggestedSlot =
        findInsightSlot(task);

      return {
        type: "unscheduled",
        severity:
          hoursUntilDeadline <= 24
            ? "high"
            : "medium",
        task,
        suggestedSlot,
        message:
          `"${task.title}" is due soon but isn't scheduled yet.`
      };
    }

    return null;
  }


  /*
     The task is scheduled before the deadline,
     so there is currently no problem.
  */
  return null;
}

function analyzeScheduleLoad(task) {
  if (!task || task.status === "done" || !task.scheduledStart) {
    return null;
  }

  const start = new Date(task.scheduledStart);
  const dayKey = start.toDateString();

  const dayTasks = tasks.filter(t => {
    if (!t.scheduledStart || t.status === "done") return false;

    return new Date(t.scheduledStart).toDateString() === dayKey;
  });

  const totalMinutes = dayTasks.reduce((sum, t) => {
    return sum + (Number(t.durationMinutes) || 0);
  }, 0);

  // Very overloaded day
  if (totalMinutes >= 420) {
    return {
      type: "overloaded",
      severity: "high",
      task,
      totalMinutes,
      message: `Your ${start.toLocaleDateString([], {
        weekday: "long"
      })} is heavily packed with about ${Math.round(totalMinutes / 60)} hours of scheduled work.`
    };
  }

  // Moderately busy day
  if (totalMinutes >= 300) {
    return {
      type: "overloaded",
      severity: "medium",
      task,
      totalMinutes,
      message: `Your ${start.toLocaleDateString([], {
        weekday: "long"
      })} is getting pretty full with about ${Math.round(totalMinutes / 60)} hours scheduled.`
    };
  }

  return null;
}


/**
 * Analyze every task on the calendar.
 */
function getProactiveInsights() {
  const insights = [];

  // Existing deadline intelligence
  tasks.forEach(task => {
    const deadlineInsight = analyzeTaskDeadline(task);

    if (deadlineInsight) {
      insights.push(deadlineInsight);
    }
  });

  // NEW: Schedule optimization
  tasks.forEach(task => {
    const scheduleInsight = analyzeScheduleLoad(task);

    if (scheduleInsight) {
      insights.push(scheduleInsight);
    }
  });

  const severityScore = {
    high: 3,
    medium: 2,
    low: 1
  };

  insights.sort((a, b) => {
    return (severityScore[b.severity] || 0) -
           (severityScore[a.severity] || 0);
  });

  return insights;
}
function renderProactiveInsight() {

  let container =
    document.getElementById(
      "proactive-insight"
    );


  /*
     Create the insight container automatically
     if it doesn't exist in the HTML.
  */
  if (!container) {

    container =
      document.createElement("div");

    container.id =
      "proactive-insight";

    document.body.prepend(container);
  }


  const insights =
    getProactiveInsights();


  /*
     Nothing needs attention.
  */
  if (!insights.length) {

    container.innerHTML = "";

    container.style.display = "none";

    return;
  }


  const insight =
    insights[0];

  if (insight.type === "overloaded") {
     const card = document.createElement("div");
     card.className = "insight-card";

     card.innerHTML = `
       <div class="insight-header">
         <strong>Plannr noticed something</strong>
         <button class="insight-dismiss" aria-label="Dismiss">×</button>
       </div>

       <div class="insight-message">
         ${insight.message}
       </div>

       <div class="insight-subtext">
         Consider moving some work to another day to keep your schedule manageable.
       </div>
     `;

     card.querySelector(".insight-dismiss").onclick = () => {
       container.innerHTML = "";
     };

     container.appendChild(card);
     return;
   }

  const task =
    insight.task;


  const severityClass =
    insight.severity === "high"
      ? "insight-high"
      : "insight-medium";


  let actionHTML = "";


  /*
     If we found a possible time,
     show a Schedule it button.
  */
  if (insight.suggestedSlot) {

    const formattedTime =
      formatInsightTime(
        insight.suggestedSlot
      );


    actionHTML = `
      <div class="insight-suggestion">
        I found an open time:
        <strong>${escapeHTML(formattedTime)}</strong>
      </div>

      <button
        type="button"
        class="insight-action"
        data-insight-action="schedule"
        data-task-id="${task.id}"
      >
        Schedule it
      </button>
    `;
  }


  container.innerHTML = `
    <div class="insight-card ${severityClass}">

      <div class="insight-content">

        <div class="insight-label">
          ${insight.severity === "high"
            ? "Needs attention"
            : "Plannr noticed something"}
        </div>

        <div class="insight-title">
          ${escapeHTML(insight.message)}
        </div>

        ${actionHTML}

      </div>

      <button
        type="button"
        class="insight-dismiss"
        data-insight-action="dismiss"
        aria-label="Dismiss"
      >
        ×
      </button>

    </div>
  `;


  container.style.display = "block";


  /*
     Schedule button.
  */
  const scheduleButton =
    container.querySelector(
      '[data-insight-action="schedule"]'
    );

  if (scheduleButton) {

    scheduleButton.addEventListener(
      "click",
      () => {

        const taskId =
          scheduleButton.dataset.taskId;

        scheduleInsightTask(taskId);
      }
    );
  }


  /*
     Dismiss button.
  */
  const dismissButton =
    container.querySelector(
      '[data-insight-action="dismiss"]'
    );

  dismissButton.addEventListener(
    "click",
    () => {

      container.style.display = "none";
    }
  );
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
```

/* ---------- FIND EXISTING TASK ---------- */

function findTaskByTitle(
  targetTitle
) {

  if (
    !targetTitle ||
    typeof targetTitle !== "string"
  ) {
    return null;
  }


  const target =
    targetTitle
      .toLowerCase()
      .trim();


  /*
     First try exact title.
  */

  let match =
    tasks.find(
      (task) =>
        task.status === "scheduled" &&
        task.title
          .toLowerCase()
          .trim() === target
    );


  if (match) {
    return match;
  }


  /*
     Then try if the target is contained
     inside the task title.
  */

  match =
    tasks.find(
      (task) =>
        task.status === "scheduled" &&
        (
          task.title
            .toLowerCase()
            .includes(target) ||
          target.includes(
            task.title
              .toLowerCase()
          )
        )
    );


  if (match) {
    return match;
  }


  /*
     Finally, match individual words.
     This helps with commands like:

     "Move chemistry to Friday"

     when the task is:

     "Study for chemistry"
  */

  const words =
    target
      .split(/\s+/)
      .filter(
        (word) =>
          word.length > 2
      );


  let bestMatch = null;

  let bestScore = 0;


  tasks.forEach((task) => {

    if (
      task.status !== "scheduled"
    ) {
      return;
    }


    const title =
      task.title
        .toLowerCase();


    let score = 0;


    words.forEach((word) => {

      if (
        title.includes(word)
      ) {
        score++;
      }

    });


    if (score > bestScore) {

      bestScore = score;

      bestMatch = task;

    }

  });


  return bestMatch;
}


/* ---------- RESCHEDULE TASK ---------- */

function rescheduleTask(
  parsed
) {

  const task =
    findTaskByTitle(
      parsed.targetTitle
    );


  if (!task) {

    setStatus(
      'Failed to find "${parsed.targetTitle}" on your calendar.`,
      true
    );

    return false;
  }


  const oldStart =
    new Date(
      task.scheduledStart
    );


  let newDate =
    parsed.date;


  let newTime =
    parsed.time;


  /*
     If AI only gave a new date,
     keep the old time.
  */

  if (!newDate) {

    newDate =
      formatDateISO(
        oldStart
      );

  }


  if (!newTime) {

    newTime =
      `${String(
        oldStart.getHours()
      ).padStart(2, "0")}:${String(
        oldStart.getMinutes()
      ).padStart(2, "0")}`;

  }


  const newStart =
    new Date(
      `${newDate}T${newTime}`
    );


  const newEnd =
    new Date(
      newStart.getTime() +
      task.durationMinutes *
      60 *
      1000
    );


  /*
     Don't allow moving a task
     into the past.
  */

  if (
    newStart < new Date()
  ) {

    setStatus(
      "I can't move a task into the past.",
      true
    );

    return false;
  }


  /*
     Temporarily remove the task
     from conflict checking.

     Otherwise it would collide
     with its own old location.
  */

  const originalIndex =
    tasks.indexOf(task);


  tasks.splice(
    originalIndex,
    1
  );


  const free =
    isSlotFree(
      newStart,
      newEnd
    );


  /*
     Put it back if there is a conflict.
  */

  if (!free) {

    tasks.splice(
      originalIndex,
      0,
      task
    );


    setStatus(
      "That time overlaps another task or event.",
      true
    );

    return false;
  }


  /*
     Update the existing task.

     IMPORTANT:
     We do NOT create a new ID.
     This prevents duplicates.
  */

  task.scheduledStart =
    formatLocalDateTime(
      newStart
    );


  tasks.splice(
    originalIndex,
    0,
    task
  );


  saveTasks();


  currentWeekStart =
    getStartOfWeek(
      newStart
    );


  setStatus(
    `Moved "${task.title}" to ${newStart.toLocaleString(
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


/* ---------- DELETE TASK ---------- */

function deleteTaskWithAI(
  parsed
) {

  const task =
    findTaskByTitle(
      parsed.targetTitle
    );


  if (!task) {

    setStatus(
      `I couldn't find "${parsed.targetTitle}" on your calendar.`,
      true
    );

    return false;
  }


  const taskTitle =
    task.title;


  tasks =
    tasks.filter(
      (t) => t.id !== task.id
    );


  saveTasks();


  setStatus(
    `Deleted "${taskTitle}".`
  );


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

      scheduledStart: null,

      type: "task"
    };


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


/* ---------- 10. MAIN AI HANDLER ---------- */

async function handleAddTask(
  event
) {

  event.preventDefault();


  const input =
    document.getElementById(
      "task-input"
    );


  const submitBtn =
    document.getElementById(
      "task-submit"
    );


  const rawText =
    input.value.trim();


  if (!rawText) {
    return;
  }


  submitBtn.disabled = true;


  setStatus(
    "Reading that…"
  );


  try {

    const parsed =
      await parseTaskWithAI(
        rawText
      );


    console.log(
      "AI PARSED:",
      parsed
    );


    /*
       CREATE
    */

    if (
      parsed.action === "create"
    ) {

      await createTask(
        parsed,
        rawText
      );

    }


    /*
       RESCHEDULE
    */

    else if (
      parsed.action === "reschedule"
    ) {

      rescheduleTask(
        parsed
      );

    }


    /*
       DELETE
    */

    else if (
      parsed.action === "delete"
    ) {

      deleteTaskWithAI(
        parsed
      );

    }


    input.value = "";


  } catch (err) {

    console.error(err);


    setStatus(
      "Something went wrong reading that task. Try rephrasing it.",
      true
    );

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
      scheduledStart: task.scheduled_start,
      deadline: task.deadline,
      preferredTime: task.preferred_time,
      status: task.status,
      type: "task"
    }));

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(tasks)
    );

    renderWeekLabel();
    renderCalendar();

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


