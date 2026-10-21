export const config = {
  maxDuration: 30
};

const MODELS = [
  process.env.GEMINI_MODEL || "gemini-3.8-flash",
  process.env.GEMINI_FALLBACK_MODEL || "gemini-3.7-flash",
  process.env.GEMINI_FALLBACK_MODEL_2 || "gemini-3.5-flash-lite"
];

const RETRYABLE_STATUS = [429, 500, 503, 504];
const ATTEMPTS_PER_MODEL = 2;
const REQUEST_TIMEOUT_MS = 8000;
const TOTAL_BUDGET_MS = 22000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini(model, prompt, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0
          }
        }),
        signal: controller.signal
      }
    );

    const raw = await response.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }

    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    return {
      ok: false,
      status: err.name === "AbortError" ? 504 : 503,
      data: null
    };
  } finally {
    clearTimeout(timer);
  }
}

async function generateWithFallback(prompt, apiKey) {
  const startedAt = Date.now();
  let last = { ok: false, status: 503, data: null };

  for (const model of MODELS) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
      if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
        return last;
      }

      const result = await callGemini(model, prompt, apiKey);

      if (result.ok) {
        return { ...result, model };
      }

      last = result;

      console.error(
        `Gemini ${model} attempt ${attempt} failed:`,
        result.status,
        JSON.stringify(result.data?.error || {})
      );

      if (result.status === 404) {
        break;
      }

      if (!RETRYABLE_STATUS.includes(result.status)) {
        return result;
      }

      if (attempt < ATTEMPTS_PER_MODEL) {
        await sleep(600 * 2 ** (attempt - 1) + Math.random() * 300);
      }
    }
  }

  return last;
}

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://tlimbaewebfyibhxdcbk.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable_Wkqp70DOPk_vDZNChqLi_g_70dmrgay";

async function getUserFromRequest(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return null;

  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY }
    });

    if (!r.ok) return null;

    const user = await r.json();
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getUserFromRequest(req);

  if (!user) {
    return res.status(401).json({ error: "Please sign in again." });
  }

  const { text, hint, today: clientToday } = req.body || {};

  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Missing text" });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY is missing" });
  }

  const today =
    typeof clientToday === "string" && /^\d{4}-\d{2}-\d{2}$/.test(clientToday)
      ? clientToday
      : new Date().toISOString().slice(0, 10);
  
  const weekday = new Date(`${today}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long"
  });

  const hintLine =
    hint === "replan"
      ? 'This message describes a schedule problem or availability. The action MUST be "replan" or "complete", never "create".'
      : "";

  const prompt = `
You are the calendar parser for Plannr, an AI scheduling assistant.
Today's date is ${today}.

Return ONLY one valid JSON object with these fields:
{
  "action": "create",
  "title": "",
  "durationMinutes": 60,
  "date": null,
  "time": null,
  "deadline": null,
  "preferredTime": null,
  "priority": "medium",
  "targetTitle": null,
  "replanScope": null,
  "shiftMinutes": null,
  "availableFrom": null
}

Choose one action: create, reschedule, delete, complete, or replan.

For create:
- title: concise task name.
- durationMinutes: requested minutes; default 60.
- date: explicitly requested date in YYYY-MM-DD format, or null.
- time: explicitly requested start time in HH:mm format, or null.
- deadline: requested completion date in YYYY-MM-DD format, or null.
- preferredTime: morning, afternoon, evening, or null.
- priority: low, medium, or high.
- targetTitle: null.

For reschedule:
- targetTitle: existing task name to move.
- date and time: newly requested date/time, or null.
- priority: medium unless explicitly changed.

For delete:
- targetTitle: existing task name to delete.
- priority: medium.

For complete:
- targetTitle: existing task the user says they finished.

For replan:
- Use replan when the user describes a schedule problem or their availability.
  They are NOT asking to add a new task.
- targetTitle: a specific task that was missed or needs moving, or null.
- replanScope: "task", "today", or "week".
- shiftMinutes: how much the user is delayed (e.g. "2 hours late" = 120), or null.
- availableFrom: HH:mm time the user is free again today, or null.

Replan and complete examples:
"I didn't finish chemistry" -> action replan, targetTitle "chemistry", replanScope "task"
"I'm running 2 hours late today" -> action replan, replanScope "today", shiftMinutes 120
"I'm free after 3pm today" -> action replan, replanScope "today", availableFrom "15:00"
"I can't start until 5pm" -> action replan, replanScope "today", availableFrom "17:00"
"Replan my week" -> action replan, replanScope "week"
"I finished chemistry" -> action complete, targetTitle "chemistry"

Never create a task or event titled "free time" or "busy". Availability statements are replan.

Priority rules:
- high for explicitly urgent, critical, or very important tasks.
- low for explicitly optional or unimportant tasks.
- medium otherwise.
- A deadline alone does not mean high priority.

Date/time rules:
- Resolve relative dates using today's date.
- Use 24-hour HH:mm times.
- Convert durations to minutes.
- Distinguish a completion deadline from a start time.
- Do not invent dates or times.
- Use null for irrelevant or unspecified fields.

Return only valid JSON, without Markdown or explanations.

${hintLine}

User command:
${JSON.stringify(text)}
`;

  try {
    const result = await generateWithFallback(prompt, apiKey);

    if (!result.ok) {
      if (RETRYABLE_STATUS.includes(result.status) || result.status === 404) {
        return res.status(503).json({
          error: "The AI is busy right now. Please try again shortly.",
          retryable: true
        });
      }

      return res.status(502).json({
        error: result.data?.error?.message || "Gemini API request failed."
      });
    }

    const resultText = result.data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();

    if (!resultText) {
      return res.status(502).json({ error: "Gemini returned an empty response." });
    }

    let parsed;

    try {
      parsed = JSON.parse(resultText);
    } catch {
      console.error("Gemini output was not valid JSON.");
      return res.status(502).json({ error: "Gemini returned invalid task data." });
    }

    const allowedActions = ["create", "reschedule", "delete", "complete", "replan"];

    if (!allowedActions.includes(parsed.action)) {
      return res.status(502).json({ error: "Gemini returned an unsupported action." });
    }

    if (!Number.isFinite(parsed.durationMinutes) || parsed.durationMinutes <= 0) {
      parsed.durationMinutes = 60;
    }

    if (!["low", "medium", "high"].includes(parsed.priority)) {
      parsed.priority = "medium";
    }

   const isDate = (v) =>
     typeof v === "string" &&
     /^\d{4}-\d{2}-\d{2}$/.test(v) &&
     !Number.isNaN(Date.parse(v));
   const isTime = (v) =>
     typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
    
   parsed.date = isDate(parsed.date) ? parsed.date : null;
   parsed.deadline = isDate(parsed.deadline) ? parsed.deadline : null;
   parsed.time = isTime(parsed.time) ? parsed.time : null;
   parsed.availableFrom = isTime(parsed.availableFrom) ? parsed.availableFrom : null;
    
   if (!Number.isFinite(parsed.shiftMinutes) || parsed.shiftMinutes < 0) {
     parsed.shiftMinutes = null;
   }
   if (!["task", "today", "week"].includes(parsed.replanScope)) {
     parsed.replanScope = null;
   }

    return res.status(200).json(parsed);
  } catch (error) {
    console.error("Task parser error:", error);

    return res.status(500).json({
      error: "Task parsing failed. Please try again."
    });
  }
}
