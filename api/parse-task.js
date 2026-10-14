
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

Return only valid JSON, without Markdown or explanations.

User command:
${JSON.stringify(text)}
`;

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
        encodeURIComponent(apiKey),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.1
          }
        })
      }
    );

    const rawResponse = await response.text();

    let apiData;

    try {
      apiData = JSON.parse(rawResponse);
    } catch {
      console.error("Gemini returned a non-JSON response.");
      return res.status(502).json({
        error: "Gemini returned an invalid response."
      });
    }

    if (!response.ok) {
      console.error(
        "Gemini API error:",
        response.status,
        JSON.stringify(apiData.error || {})
      );

      return res.status(502).json({
        error:
          apiData.error?.message ||
          "Gemini API request failed."
      });
    }

    const resultText =
      apiData.candidates?.[0]?.content?.parts
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

    const allowedActions = ["create", "reschedule", "delete"];

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

