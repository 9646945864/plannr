export const config = {
  maxDuration: 30 // seconds; raises Vercel's default function timeout
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
    // Timeout or network failure: treat as a retryable upstream problem
    return {
      ok: false,
      status: err.name === "AbortError" ? 504 : 503,
      data: null
    };
  } finally {
    clearTimeout(timer);
  }
}

/*
  Tries each model in order, retrying temporary failures with backoff.
  Returns { ok: true, data, model } or { ok: false, status, data }.
*/
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

      // Model name wrong or retired: skip straight to the next model
      if (result.status === 404) {
        break;
      }

      // Bad request, bad key, etc.: retrying or switching models won't help
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const { text } = req.body || {};

  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({
      error: "Missing text"
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "GEMINI_API_KEY is missing"
    });
  }

  const today = new Date().toISOString().slice(0, 10);

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
  "targetTitle": null
}

Choose one action: create, reschedule, or delete.

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

Choose one action: create, reschedule, delete, complete, or replan.

For complete:
- targetTitle: existing task the user says they finished.

For replan:
- targetTitle: a specific task that was missed or needs moving, or null.
- replanScope: "task", "today", or "week".
- shiftMinutes: how much the user is delayed (e.g. "2 hours late" = 120), or null.
- availableFrom: HH:mm time the user is free again today, or null.
- Use replan for "I didn't finish X", "I'm running late", "I missed X", "redo my schedule".

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

Return only valid JSON, without Markdown or explanations.

User command:
${JSON.stringify(text)}
`;

  try {
    const result = await generateWithFallback(prompt, apiKey);

    if (!result.ok) {
      // Temporary overload: tell the client it's retryable instead of a generic 502
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
      return res.status(502).json({
        error: "Gemini returned an empty response."
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(resultText);
    } catch {
      console.error("Gemini output was not valid JSON.");
      return res.status(502).json({
        error: "Gemini returned invalid task data."
      });
    }

    const allowedActions = ["create", "reschedule", "delete", "complete", "replan"];

    if (!allowedActions.includes(parsed.action)) {
      return res.status(502).json({
        error: "Gemini returned an unsupported action."
      });
    }

    if (
      !Number.isFinite(parsed.durationMinutes) ||
      parsed.durationMinutes <= 0
    ) {
      parsed.durationMinutes = 60;
    }

    if (!["low", "medium", "high"].includes(parsed.priority)) {
      parsed.priority = "medium";
    }

    return res.status(200).json(parsed);
  } catch (error) {
    console.error("Task parser error:", error);

    return res.status(500).json({
      error: "Task parsing failed. Please try again."
    });
  }
}
