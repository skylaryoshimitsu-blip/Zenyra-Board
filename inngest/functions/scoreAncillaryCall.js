// inngest/functions/scoreAncillaryCall.js
import { inngest } from '../client.js';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DEEPGRAM_API_KEY     = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;

// ── HIP script scoring prompt ──────────────────────────────────────────────
const HIP_SCORING_PROMPT = `You are an expert Medicare ancillary sales coach at Senior Benefits Agency.
You are scoring a recorded Hospital Indemnity (HIP) sales call against the official SBA script.

SCRIPT STRUCTURE — 6 PLATES WITH WEIGHTS:

PLATE 1 — INTRO & ELIGIBILITY (20 pts)
Agent must: introduce themselves by name and agency on a recorded line, ask who they're speaking with, identify themselves as the senior benefits coordinator for the client's state, verify Medicare card (or offer SSN fallback), confirm the client makes their own healthcare decisions (or has POA), ask if on Medicaid, ask about military coverage (VA/Tricare), ask about cognitive impairment (Alzheimer's/Dementia/memory medication), ask about nursing home/ALF/home healthcare status, confirm SS deposit method (Direct Express or bank account), confirm access to banking information.

PLATE 2 — HEALTH REVIEW (15 pts)
Agent must: ask about qualifying health conditions currently treated with prescription medication (probe for diabetes/insulin, heart conditions, COPD if mentioned), ask for prescription medication count and copay amount, ask about last hospitalization (date and bill amount), ask about family cancer history (and note higher risk if positive).

PLATE 3 — PLAN REVIEW (15 pts)
Agent must: open with a positive framing of the client's current plan ("on the surface, this looks like a really good plan"), call out specific positives present in the plan (zero PCP copay, low/no medical, drug deductible, DVH, giveback), ask if the client is happy with their plan and if they have any complaints.

PLATE 4 — PROBLEM REVEAL (20 pts)
Agent must: explain Medicare Parts A, B, C, D clearly, mention the Part B premium ($202.90/mo in 2026), explain that Part C = Medicare Advantage and Part D = drugs, explain that Medicare is cutting back hospital benefits due to baby boomer volume, explain that having only Parts A/B/C/D is now "incomplete" for hospital coverage, introduce "Part E" (extended hospital coverage) concept naturally, explain the agent didn't attach this to the client's plan (not blaming, just correcting), build urgency by asking if the client could cover the daily hospital copay out of pocket, get explicit acknowledgment ("does that make sense?").

PLATE 5 — SOLUTION REVEAL (15 pts)
Agent must: explain how Part E works (daily benefit amount + days covered), break down cost vs. benefit clearly, subtract the client's daily hospital copay from the daily benefit to show net gain, state that money goes directly to the client (not hospital/doctor), confirm it is tax-free, present the monthly premium as significantly less than Part B ($202.90), offer to add ambulance, outpatient, or cancer rider if applicable, handle the premium reveal smoothly with SS benefit payment schedule framing.

PLATE 6 — ENROLLMENT (15 pts)
Agent must: collect physical address, confirm phone number and whether it's landline or cell, collect email, handle underwriting health questions (or note GI with 60-day waiting period), confirm SS benefit date (1st, 3rd, or one of the Wednesdays), confirm bank or credit union name, confirm city/state where account was set up, verify routing number from a check, verify account number, provide agent first and last name, provide agent GHL phone number, provide policy number, give Federal Do Not Call Registry number (1-888-382-1222).

SCORING INSTRUCTIONS:
- Score each plate 0–100 based on completeness (did the agent cover all required elements?) and quality (was it done naturally and effectively?).
- The overall score is a weighted average: Plate1×0.20 + Plate2×0.15 + Plate3×0.15 + Plate4×0.20 + Plate5×0.15 + Plate6×0.15.
- Generate 3–5 specific, actionable coaching points ranked HIGH/MEDIUM/LOW. Each must name the exact plate, what was missed or done poorly, and a concrete suggestion for improvement. Be direct — this is for a sales manager coaching their agent.

RESPOND ONLY IN THIS EXACT JSON FORMAT (no markdown fences, no preamble, no extra text):
{
  "plate_scores": {
    "intro_eligibility": 0,
    "health_review": 0,
    "plan_review": 0,
    "problem_reveal": 0,
    "solution_reveal": 0,
    "enrollment": 0
  },
  "overall_score": 0,
  "coaching_points": [
    {
      "priority": "HIGH",
      "plate": "Plate Name",
      "text": "Specific coaching point"
    }
  ],
  "call_summary": "2-3 sentence summary of how the call went overall"
}`;

export const scoreAncillaryCall = inngest.createFunction(
  { id: 'score-ancillary-call', retries: 1, timeout: '10m' },
  { event: 'board/ancillary.call.uploaded' },
  async ({ event, step }) => {
    const { jobId, storagePath, agentName, agentId } = event.data;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── Step 1: Mark job as transcribing ──────────────────────────────────
    await step.run('mark-transcribing', async () => {
      await supabase.from('lb_scorer_results').update({ status: 'transcribing' }).eq('id', jobId);
    });

    // ── Step 2: Download audio from Supabase Storage ───────────────────────
    const audioBuffer = await step.run('download-audio', async () => {
      const { data, error } = await supabase.storage.from('lb-scorer-audio').download(storagePath);
      if (error) throw new Error('Storage download failed: ' + error.message);
      const arrayBuffer = await data.arrayBuffer();
      return Buffer.from(arrayBuffer).toString('base64');
    });

    // ── Step 3: Transcribe with Deepgram ──────────────────────────────────
    const transcript = await step.run('transcribe', async () => {
      const audioBytes = Buffer.from(audioBuffer, 'base64');
      const response = await fetch(
        'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&diarize=true&punctuate=true',
        {
          method: 'POST',
          headers: {
            'Authorization': `Token ${DEEPGRAM_API_KEY}`,
            'Content-Type': 'audio/mpeg',
          },
          body: audioBytes,
        }
      );
      if (!response.ok) {
        const err = await response.text();
        throw new Error('Deepgram error: ' + err);
      }
      const data = await response.json();
      const words = data?.results?.channels?.[0]?.alternatives?.[0]?.words || [];

      // Build diarized transcript
      if (words.length === 0) {
        return data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
      }
      let text = '';
      let lastSpeaker = null;
      for (const w of words) {
        const spk = w.speaker !== undefined ? `Speaker ${w.speaker}` : 'Speaker';
        if (spk !== lastSpeaker) {
          text += (text ? '\n' : '') + `[${spk}]: `;
          lastSpeaker = spk;
        }
        text += w.punctuated_word + ' ';
      }
      return text.trim();
    });

    // ── Step 4: Mark as scoring ────────────────────────────────────────────
    await step.run('mark-scoring', async () => {
      await supabase.from('lb_scorer_results').update({ status: 'scoring', transcript }).eq('id', jobId);
    });

    // ── Step 5: Score with Claude ──────────────────────────────────────────
    const scoreResult = await step.run('score-with-claude', async () => {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          system: HIP_SCORING_PROMPT,
          messages: [{
            role: 'user',
            content: `Here is the call transcript to score:\n\n${transcript}\n\nScore this call now. Return ONLY the JSON object specified.`
          }]
        })
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error('Anthropic error: ' + err);
      }
      const data = await response.json();
      const raw = data.content?.[0]?.text || '{}';
      const clean = raw.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);
    });

    // ── Step 6: Save completed result ─────────────────────────────────────
    await step.run('save-result', async () => {
      await supabase.from('lb_scorer_results').update({
        status: 'complete',
        agent_name: agentName,
        agent_id: agentId || null,
        transcript,
        overall_score:       Math.round(scoreResult.overall_score || 0),
        score_intro:         Math.round(scoreResult.plate_scores?.intro_eligibility || 0),
        score_health:        Math.round(scoreResult.plate_scores?.health_review || 0),
        score_plan:          Math.round(scoreResult.plate_scores?.plan_review || 0),
        score_problem:       Math.round(scoreResult.plate_scores?.problem_reveal || 0),
        score_solution:      Math.round(scoreResult.plate_scores?.solution_reveal || 0),
        score_enrollment:    Math.round(scoreResult.plate_scores?.enrollment || 0),
        coaching_points:     JSON.stringify(scoreResult.coaching_points || []),
        call_summary:        scoreResult.call_summary || '',
        completed_at:        new Date().toISOString(),
      }).eq('id', jobId);
    });

    // ── Step 7: Clean up audio file ───────────────────────────────────────
    await step.run('cleanup-audio', async () => {
      await supabase.storage.from('lb-scorer-audio').remove([storagePath]);
    });

    return { jobId, overall_score: scoreResult.overall_score };
  }
);
