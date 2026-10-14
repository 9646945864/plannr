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

  // Use a consistent date reference for interpreting commands.
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `
You are the calendar parser for Plannr, an AI scheduling assistant.

Today's date is ${today}.

Return ONLY one valid JSON object with exactly these fields:

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

ACTION RULES

Choose exactly one action:
- "create": create a new task.
- "reschedule": move an existing task.
- "delete": delete an existing task.

CREATE RULES

- title: concise name of the task.
- durationMinutes: requested duration in minutes; default to 60.
- date: explicitly requested scheduled date in YYYY-MM-DD format, or null.
- time: explicitly requested start time in 24-hour HH:mm format, or null.
- deadline: requested completion deadline in YYYY-MM-DD format, or null.
- preferredTime: "morning", "afternoon", "evening", or null.
- priority: "low", "medium", or "high".
- targetTitle: null.

PRIORITY RULES

Use the user's explicit priority whenever provided:
- "high": explicitly urgent, very important, top priority, or critical.
- "low": explicitly low priority, optional, or not important.
- "medium": normal priority or no priority specified.

Do not automatically mark every task with a deadline as high priority.
A deadline affects scheduling urgency, while priority reflects importance.
Never invent a priority the user explicitly contradicted.

RESCHEDULE RULES

- targetTitle: name of the existing task to move.
- date: newly requested scheduled date, or null if unspecified.
- time: newly requested exact start time, or null if unspecified.
- Keep fields required by the JSON schema; use null for irrelevant fields.
- priority: "medium" unless the user explicitly requests a priority change.

DELETE RULES

- targetTitle: name of the existing task to delete.
- Keep fields required by the JSON schema; use null for irrelevant fields.
- priority: "medium".

DATE AND TIME RULES

- Resolve relative dates such as "tomorrow" and weekdays using today's date.
- Convert times to 24-hour HH:mm format.
- "4 PM" becomes "16:00"; "9 AM" becomes "09:00".
- "6:30 PM" becomes "18:30".
- Convert durations to minutes: "2 hours" becomes 120; "90 minutes" becomes 90.
- Do not confuse a completion deadline with a requested start date/time.
- If the user requests a deadline but not a start time, set deadline and leave time null.
- If the user requests a preferred time of day rather than an exact time, use preferredTime and leave time null.
- Do not invent a date, time, or deadline that the user did not imply.

Return ONLY the JSON object. Do not include Markdown or explanations.

User command:
${JSON.stringify(text)}
`;

  try {
    const response
