export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const { text } = req.body || {};

  if (!text || typeof text !== "string") {
    return res.status(400).json({
      error: "Missing task text"
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
You are Plannr, an AI calendar command parser.

Today's date is ${today}.

Read the user's command and return ONLY JSON.

Return exactly:

{
  "action": "create",
  "title": "task name",
  "durationMinutes": 60,
  "date": null,
  "time": null,
  "deadline": null,
  "preferredTime": null,
  "targetTitle": null
}

ACTION:

Use "create" when the user wants to add something.

Use "reschedule" when the user wants to move an existing calendar item.

Use "delete" when the user wants to remove an existing calendar item.

CREATE example:
"Study chemistry tomorrow for 2 hours"

RESCHEDULE example:
"Move chemistry to Friday at 6 PM"

DELETE example:
"Delete chemistry"

DATE:

Resolve today, tomorrow, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, and Sunday using today's date.

date must be YYYY-MM-DD or null.

TIME:

If the user gives an exact time, convert it to 24-hour time.

Examples:
4 PM = 16:00
6 PM = 18:00
9 AM = 09:00
6:30 PM = 18:30

time must be HH:MM or null.

DURATION:

"2 hours" = 120
"90 minutes" = 90

If creating a task and no duration is given, use 60.

For reschedule/delete, durationMinutes can be null.

PREFERRED TIME:

Use only:
"morning"
"afternoon"
"evening"
or null.

If an exact time is provided, preferredTime can be null.

DEADLINE:

Use YYYY-MM-DD or null.

TARGET TITLE:

For reschedule and delete, targetTitle should identify the existing calendar item.

For create, targetTitle must be null.

IMPORTANT:

Never invent a past date unless the user explicitly asks for one.

Return ONLY JSON.
No markdown.
No explanation.

User command:
${JSON.stringify(text)}
`;

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=" +
        encodeURIComponent(apiKey),
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],

          generationConfig: {
            temperature: 0,
            maxOutputTokens: 200,
            responseMimeType: "application/json"
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      console.error("Gemini error:", errorText);

      return res.status(500).json({
        error: "Gemini request failed"
      });
    }

    const data = await response.json();

    const rawText =
      data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      console.error("No Gemini response:", data);

      return res.status(500).json({
        error: "Gemini returned no response"
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      console.error("Invalid Gemini JSON:", rawText);

      return res.status(500).json({
        error: "AI returned invalid JSON"
      });
    }

    /*
     * Make sure every expected property exists.
     */

    if (
      parsed.action !== "create" &&
      parsed.action !== "reschedule" &&
      parsed.action !== "delete"
    ) {
      parsed.action = "create";
    }

    if (typeof parsed.title !== "string") {
      parsed.title = "";
    }

    if (
      typeof parsed.durationMinutes !== "number" ||
      parsed.durationMinutes <= 0
    ) {
      parsed.durationMinutes = 60;
    }

    if (
      parsed.date !== null &&
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
    ) {
      parsed.date = null;
    }

    if (
      parsed.time !== null &&
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(parsed.time)
    ) {
      parsed.time = null;
    }

    if (
      parsed.deadline !== null &&
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.deadline)
    ) {
      parsed.deadline = null;
    }

    if (
      parsed.preferredTime !== "morning" &&
      parsed.preferredTime !== "afternoon" &&
      parsed.preferredTime !== "evening" &&
      parsed.preferredTime !== null
    ) {
      parsed.preferredTime = null;
    }

    if (
      parsed.targetTitle !== null &&
      typeof parsed.targetTitle !== "string"
    ) {
      parsed.targetTitle = null;
    }

    /*
     * Return the exact structure app.js expects.
     */

    return res.status(200).json({
      action: parsed.action,
      title: parsed.title,
      durationMinutes: parsed.durationMinutes,
      date: parsed.date,
      time: parsed.time,
      deadline: parsed.deadline,
      preferredTime: parsed.preferredTime,
      targetTitle: parsed.targetTitle
    });

  } catch (err) {
    console.error("Server error:", err);

    return res.status(500).json({
      error: "Unexpected server error"
    });
  }
}
