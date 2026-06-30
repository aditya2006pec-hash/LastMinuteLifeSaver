import express from "express";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Helper to clean LLM markdown wrapping before parsing JSON
function cleanJsonString(str: string): string {
  let cleaned = str.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.substring(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.substring(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.substring(0, cleaned.length - 3);
  }
  return cleaned.trim();
}

// Lazy initialization of the Gemini API client to prevent crashing on developer launch
let aiInstance: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    aiInstance = new GoogleGenAI({ apiKey });
  }
  return aiInstance;
}

// API Route: Analyze upcoming Calendar events and recent Emails to extract active commitments and initial steps
app.post("/api/ai/analyze-commitments", async (req, res) => {
  try {
    const { events = [], emails = [], currentTime = new Date().toISOString() } = req.body;
    
    const prompt = `You are an advanced Commitment Detection Agent inside the AI Life Copilot product.
We process the user's raw calendar events and recent emails to detect high-stakes actions, events, or deadlines requiring prior preparation.

Guidelines:
1. Passive events (e.g. holidays, out of office, family dinners, routine social tags, recurring status syncs without deliverables) should be marked as passive (isActive: false).
2. Active commitments (e.g. Job Interviews, Final Exams, Client Pitch Meetings, Code Reviews, Major Presentations, Project Deliverables/Deadlines, or Bank & Tax Audits) must be classified as ACTIVE (isActive: true).
3. For each Active commitment, determine:
   - "type": Choose one of "interview" | "exam" | "meeting" | "pitch" | "assignment" | "other"
   - "riskRationale": A highly specific, concise, professional, yet urgent 1-2 sentence explanation of why this commitment is critical, what fails if they procrastination, and the specific material/knowledge they must prepare.
   - "suggestedSteps": A default checklist of 2-3 action items. Each should show "title" and "durationMinutes" (e.g., 30, 45, 60, 90).

Current Local Time: ${currentTime}

Calendar Events list:
${JSON.stringify(events, null, 2)}

Inbox Email messages:
${JSON.stringify(emails, null, 2)}

Return EXACTLY a JSON array containing the analysis results. No conversational wrapper or markdown coding blocks. The response should strictly parse into this exact TypeScript Type:
Array<{
  calendarEventId: string; // Map back to original calendarEventId or generate email-subject-id if from email
  title: string;
  isActive: boolean;
  type: "interview" | "exam" | "meeting" | "pitch" | "assignment" | "other";
  riskRationale: string;
  suggestedSteps: Array<{ title: string; durationMinutes: number }>;
}>`;

    const ai = getGemini();
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    const text = result.text || "";
    const cleanStr = cleanJsonString(text);
    const parsed = JSON.parse(cleanStr);
    
    res.json({ success: true, count: parsed.length, data: parsed });
  } catch (error: any) {
    console.error("Error in analyze-commitments:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API Route: Generate sequential preparation sub-tasks and a comprehensive research summary document
app.post("/api/ai/generate-plan", async (req, res) => {
  try {
    const { title, type, start, end, description = "" } = req.body;
    if (!title || !type) {
      return res.status(400).json({ success: false, error: "Missing required parameters title/type." });
    }

    const prompt = `You are a high-performance Planning Agent and Executive Assistant.
Generate a structured preparation roadmap and a customized research/study briefing document for this commitment:

Commitment Title: "${title}"
Category: "${type}"
Due/Starts: "${start}" to "${end}"
Context: "${description}"

Generate two components:
1. "tasks": A sequential, 3 to 4-step preparation plan. Format as a list of items, each with "title" (humble, actionable description), "durationMinutes" (e.g. 30, 45, 60, 90), and "order" (1, 2, 3, etc.).
2. "prepBrief": A comprehensive, high-contrast, professional markdown document featuring:
   - "🎯 Key Objectives": Explicit goal outcomes for the commitment.
   - "🔍 Critical Research Brief": Custom summarized knowledge structure, key news/facts to know, or topics list.
   - "💡 High-Impact Cheat Sheet": Tailored mock interview prompts, behavior frameworks, formulas, or cheat sheet highlights to ensure absolute preparation.

Output EXACTLY as a JSON object of this type:
{
  "tasks": Array<{ title: string; durationMinutes: number; order: number }>;
  "prepBrief": string; // The markdown document
}
Return JSON strictly. No outer wrappers.`;

    const ai = getGemini();
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    const text = result.text || "";
    const cleanStr = cleanJsonString(text);
    const parsed = JSON.parse(cleanStr);

    res.json({ success: true, data: parsed });
  } catch (error: any) {
    console.error("Error in generate-plan:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API Route: Generate weekly motivational insights, summaries and adaptive warnings
app.post("/api/ai/insights", async (req, res) => {
  try {
    const { commitments = [], currentScheduleDensity = 0 } = req.body;

    const prompt = `You are a productivity therapist and executive coping coach.
Review this week's active high-stakes commitments:
${JSON.stringify(commitments, null, 2)}
Overall Schedule Density Score: ${currentScheduleDensity} (where 0 is completely free, 100 is completely blocked)

Analyze:
1. The overall workload burden and scheduling crunch days.
2. Procrastination failure warning alerts based on zero completed tasks.
3. Suggest 2-3 specific "Critical Interventions" that are constructive, encouraging, but aggressively specific.

Generate a JSON object conforming exactly to this shape:
{
  "summary": "A 2-3 sentence overview analysis of their schedule, bottlenecks, and focus needs.",
  "highRiskCount": number, // Count of active commitments with riskScore > 60
  "criticalInterventions": Array<string> // Array of 2-3 precise callouts (e.g., '⚠️ Proximity Alert: Your final exam is in 36 hours. You have 0% prep done. Block out 6 PM to 8 PM tonight to review the cheat sheet.')
}
Return raw JSON strictly.`;

    const ai = getGemini();
    const result = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    const text = result.text || "";
    const cleanStr = cleanJsonString(text);
    const parsed = JSON.parse(cleanStr);

    res.json({ success: true, data: parsed });
  } catch (error: any) {
    console.error("Error in insights:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API Route: Parse raw voice transcripts into structured commitment fields
app.post("/api/ai/parse-voice", async (req, res) => {
  try {
    const { transcript, currentTime = new Date().toISOString() } = req.body;
    if (!transcript) {
      return res.status(400).json({ success: false, error: "Missing transcript." });
    }

    const prompt = `You are an AI assistant processing a user's voice memo to create a structured calendar commitment or goal.
    
User Transcript: "${transcript}"
Current Local Time: ${currentTime}

Extract the following details from the transcript to fill a form:
- "title": A concise, actionable title for the commitment (e.g., "Doctor Appointment", "Finish Math Project").
- "type": Classify into one of these EXACT categories: "interview" | "exam" | "meeting" | "pitch" | "assignment" | "goal" | "habit" | "other".
- "start": The inferred start date/time in "YYYY-MM-DDThh:mm" format. If no time is specified, default to exactly 24 hours from Current Local Time.
- "end": The inferred end date/time in "YYYY-MM-DDThh:mm" format. If no end time, default to 1 hour after the start time.
- "description": A cleaned up, concise version of the transcript, or any additional context provided.

Output EXACTLY as a JSON object of this type:
{
  "title": string,
  "type": "interview" | "exam" | "meeting" | "pitch" | "assignment" | "goal" | "habit" | "other",
  "start": string,
  "end": string,
  "description": string
}
Return JSON strictly. No outer wrappers.`;

    const ai = getGemini();
    const result = await ai.models.generateContent({
      model: "gemini-2.5-pro",
      contents: prompt,
    });

    const text = result.text || "";
    const cleanStr = cleanJsonString(text);
    const parsed = JSON.parse(cleanStr);

    res.json({ success: true, data: parsed });
  } catch (error: any) {
    console.error("Error parsing voice:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// Static asset handling and Vite configuration
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[AI Life Copilot] Server listening on http://localhost:${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
  });
}

startServer();
