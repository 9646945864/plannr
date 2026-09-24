/* ============================================================
   /api/parse-task
   Parses natural-language calendar commands using Gemini.
   Supports:
   - Creating tasks
   - Rescheduling tasks
   - Deleting tasks
   - Explicit dates and times
   ============================================================ */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { text } = req.body || {};

  if (!text || typeof text !== "string") {
    return res.status(400).json({
      error: "Missing 'text' in request body",
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "Server is missing GEMINI_API_KEY",
    });
  }

  // Use the server's local date as the reference date.
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `
You are the AI command parser for a calendar app called Plannr.

Today's date is ${today}.

The user may want to CREATE, RESCHEDULE, or DELETE a calendar task.

Return ONLY valid JSON with exactly these fields:

{
  "action": "create",
  "title": "short task name",
  "durationMinutes": 60,
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "deadline": "YYYY-MM-DD",
  "preferredTime": "morning",
  "targetTitle": null
}

ACTION RULES:

1. CREATE
Use action "create" when the user wants to add a new task.

Examples:
"Study for chemistry tomorrow for 2 hours"
"Do my history homework Thursday evening"
"Study for math tomorrow at 4 PM"

2. RESCHEDULE
Use action "reschedule" when the user wants to move an existing task.

Examples:
"Move my chemistry study session to Friday at 6 PM"
"Reschedule history homework to tomorrow"
"Move math to Monday at 4"

For reschedule:
- targetTitle should identify the EXISTING task.
- date should be the new date if provided.
- time should be the new time if provided.
- If only a new date is provided, leave time as null.
- If only a new time is provided, leave date as null.
- Do NOT create a new task.

3. DELETE
Use action "delete" when the user wants to remove an existing task.

Examples:
"Delete my chemistry study session"
"Remove my math homework"
"Cancel the history task"

For delete:
- targetTitle should identify the existing task.
- date and time should be null.

DATE RULES:

- Resolve today, tomorrow, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, and Sunday using today's date.
- date must be YYYY-MM-DD or null.
- Never choose a date before today unless the user explicitly asks for a past date.
- If the user says "tomorrow", use tomorrow's actual date.

TIME RULES:

- If the user explicitly gives a time, preserve it.
- "4 PM" = "16:00"
- "6:30 PM" = "18:30"
- "9 AM" = "09:00"
- time must be HH:MM using 24-hour time or null.
- Do NOT turn an explicit time into just morning/afternoon/evening.

DURATION RULES:

- durationMinutes must be a positive number.
- "2 hours" = 120.
- "90 minutes" = 90.
- If no duration is given, use 60.
- For RESCHEDULE and DELETE, use null if duration is not relevant.

PREFERRED TIME:

- Use "morning", "afternoon", "evening", or null.
- If an exact time is given, preferredTime may be null.

TITLE RULES:

- Make titles short and clear.
- For reschedule/delete, targetTitle should contain the main identifying words of the existing task.
- Do not invent unnecessary words.

IMPORTANT:
- Return ONLY JSON.
- No markdown.
- No explanation.
- Do not include any fields other than the seven fields above.

User command:
${JSON.stringify(text)}
`;

  try {
    const geminiResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=" +
        encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            maxOutputTokens: 200,
          },
        }),
      }
    );

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();

      console.error("GEMINI ERROR:", errorText);

      return res.status(geminiResponse.status).json({
        error: "AI service error",
      });
    }

    const data = await geminiResponse.json();

    const rawText =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!rawText) {
      console.error("Gemini returned no text:", data);

      return res.status(502).json({
        error: "Gemini returned an empty response",
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      console.error("Invalid JSON from Gemini:", rawText);

      return res.status(502).json({
        error: "Could not parse AI response",
      });
    }

    // --------------------------------------------------------
    // Validate action
    // --------------------------------------------------------

    if (
      parsed.action !== "create" &&
      parsed.action !== "reschedule" &&
      parsed.action !== "delete"
    ) {
      parsed.action = "create";
    }

    // --------------------------------------------------------
    // Validate title
    // --------------------------------------------------------

    if (typeof parsed.title !== "string") {
      parsed.title = "";
    }

    // --------------------------------------------------------
    // Validate targetTitle
    // --------------------------------------------------------

    if (
      parsed.targetTitle !== null &&
      typeof parsed.targetTitle !== "string"
    ) {
      parsed.targetTitle = null;
    }

    // --------------------------------------------------------
    // Validate duration
    // --------------------------------------------------------

    if (
      parsed.durationMinutes !== null &&
      (
        typeof parsed.durationMinutes !== "number" ||
        parsed.durationMinutes <= 0
      )
    ) {
      parsed.durationMinutes = 60;
    }

    // --------------------------------------------------------
    // Validate date
    // --------------------------------------------------------

    if (
      parsed.date !== null &&
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
    ) {
      parsed.date = null;
    }

    // --------------------------------------------------------
    // Validate time
    // --------------------------------------------------------

    if (
      parsed.time !== null &&
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(parsed.time)
    ) {
      parsed.time = null;
    }

    // --------------------------------------------------------
    // Validate deadline
    // --------------------------------------------------------

    if (
      parsed.deadline !== null &&
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.deadline)
    ) {
      parsed.deadline = null;
    }

    // --------------------------------------------------------
    // Validate preferred time
    // --------------------------------------------------------

    if (
      parsed.preferredTime !== "morning" &&
      parsed.preferredTime !== "afternoon" &&
      parsed.preferredTime !== "evening" &&
      parsed.preferredTime !== null
    ) {
      parsed.preferredTime = null;
    }

    // --------------------------------------------------------
    // Clean up action-specific fields
    // --------------------------------------------------------

    if (parsed.action === "delete") {
      parsed.date = null;
      parsed.time = null;
      parsed.durationMinutes = null;
      parsed.deadline = null;
      parsed.preferredTime = null;
    }

    if (parsed.action === "reschedule") {
      parsed.durationMinutes = null;
      parsed.deadline = null;
      parsed.preferredTime = null;
    }

    return res.status(200).json({
      action: parsed.action,
      title: parsed.title,
      durationMinutes: parsed.durationMinutes,
      date: parsed.date,
      time: parsed.time,
      deadline: parsed.deadline,
      preferredTime: parsed.preferredTime,
      targetTitle: parsed.targetTitle,
    });
  } catch (err) {
    console.error("Server error:", err);

    return res.status(500).json({
      error: "Unexpected server error",
    });
  }
}
