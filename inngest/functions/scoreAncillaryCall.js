// inngest/functions/scoreAncillaryCall.js
import { inngest } from '../client.js';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DEEPGRAM_API_KEY     = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;

const HIP_SCORING_PROMPT = `You are an expert Medicare ancillary sales coach at Senior Benefits Agency.
You are scoring a recorded Hospital Indemnity (HIP) sales call against the official SBA script.

SCRIPT STRUCTURE — 6 PLATES WITH WEIGHTS:

PLATE 1 — INTRO & ELIGIBILITY (20 pts)
Agent must: introduce themselves by name and agency on a recorded line, ask who they're speaking with, identify themselves as the senior benefits coordinator for the client's state, verify Medicare card (or offer SSN fallback), confirm the client makes their own healthcare decisions (or has POA), ask if on Medicaid, ask about military coverage (VA/Tricare), ask about cognitive impairment (Alzheimer's/Dementia/memory medication), ask about nursing home/ALF/home healthcare status, confirm SS deposit method (Direct Express or bank account), confirm access to banking information.

PLATE 2 — HEALTH REVIEW (15 pts)
Agent must: ask about qualifying health conditions currently treated with prescription medication (probe for diabetes/insulin, heart conditions, COPD if mentioned), ask for prescription medication count and copay amount, ask about last hospitalization (date and bill amount), ask about family cancer history (and note higher risk if positive).

PLATE 3 — PLAN REVIEW (15 pts)
Agent must: open with a positive framing of the client's current plan, call out specific positives present in the plan (zero PCP copay, low/no medical, drug deductible, DVH, giveback), ask if the client is happy with their plan and if they have any complaints.

PLATE 4 — PROBLEM REVEAL (20 pts)
Agent must: explain Medicare Parts A, B, C, D clearly, mention the Part B premium ($202.90/mo in 2026), explain that Part C = Medicare Advantage and Part D = drugs, explain that Medicare is cutting back hospital benefits, introduce "Part E" extended hospital coverage concept, explain the agent didn't attach this to the client's plan, build urgency around hospital cost gap, get explicit acknowledgment.

PLATE 5 — SOLUTION REVEAL (15 pts)
Agent must: explain how Part E works (daily benefit amount + days covered), break down cost vs benefit, subtract the client's daily hospital copay to show net gain, state money goes directly to client tax-free, present monthly premium as less than Part B, offer ambulance/outpatient/cancer rider if applicable.

PLATE 6 — ENROLLMENT (15 pts)
Agent must: collect physical address, confirm phone type, collect email, handle underwriting questions (or note GI with 60-day waiting period), confirm SS benefit date, confirm bank or credit union name, confirm city/state where account was set up, verify routing number, verify account number, provide agent contact info, policy number, and DNCR number (1-888-382-1222).

SCORING INSTRUCTIONS:
- Score each plate 0–100 based on completeness and quality.
- Overall score = Plate1×0.20 + Plate2×0.15 + Plate3×0.15 + Plate4×0.20 + Plate5×0.15 + Plate6×0.15.
- Generate 3–5 specific actionable coaching points ranked HIGH/MEDIUM/LOW, each naming the exact plate, what was missed, and a concrete improvement suggestion.

RESPOND ONLY IN THIS EXACT JSON FORMAT (no markdown, no preamble):
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
    { "priority": "HIGH", "plate": "Plate Name", "text": "Specific coaching point" }
  ],
  "call_summary": "2-3 sentence summary of how the call went overall"
}`;

export const scoreAncillaryCall = inngest.createFunction(
  { id: 'score-ancillary-call', retries: 1, timeout: '10m' },
  { event: 'board/ancillary.call.uploaded' },
  async ({ event, step }) => {
    const { jobId, storagePath, agentName, agentId } = event.data;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Step 1: Mark transcribing
    await step.run('mark-transcribing', async () => {
      await supabase.from('lb_scorer_results').update({ status: 'transcribing' }).eq('id', jobId);
      return { ok: true };
    });

    // Step 2: Download audio — return only base64 length to avoid output_too_large
    // Instead, transcribe directly by streaming from storage URL
    const transcriptResult = await step.run('transcribe', async () => {
      // Get a signed URL from Supabase Storage instead of downloading the file
      const { data: signedData, error: signedError } = await supabase.storage
        .from('lb-scorer-audio')
        .createSignedUrl(storagePath, 300); // 5 min expiry

      if (signedError || !signedData?.signedUrl) {
        throw new Error('Could not get signed URL: ' + (signedError?.message || 'unknown'));
      }

      // Send signed URL directly to Deepgram (no download needed)
      const response = await fetch(
        'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&diarize=true&punctuate=true',
        {
          method: 'POST',
          headers: {
            'Authorization': `Token ${DEEPGRAM_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ url: signedData.signedUrl }),
        }
      );

      if (!response.ok) {
        const err = await response.text();
        throw new Error('Deepgram error: ' + err);
      }

      const data = await response.json();
      const words = data?.results?.channels?.[0]?.alternatives?.[0]?.words || [];

      let transcript = '';
      if (words.length === 0) {
        transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
      } else {
        let lastSpeaker = null;
        for (const w of words) {
          const spk = w.speaker !== undefined ? `Speaker ${w.speaker}` : 'Speaker';
          if (spk !== lastSpeaker) {
            transcript += (transcript ? '\n' : '') + `[${spk}]: `;
            lastSpeaker = spk;
          }
          transcript += w.punctuated_word + ' ';
        }
        transcript = transcript.trim();
      }

      // Save transcript to Supabase immediately, return only length
      await supabase.from('lb_scorer_results')
        .update({ status: 'scoring', transcript })
        .eq('id', jobId);

      return { transcriptLength: transcript.length };
    });

    // Step 3: Score — fetch transcript from DB to avoid passing large strings between steps
    await step.run('score-with-claude', async () => {
      // Re-fetch transcript from Supabase
      const { data: row } = await supabase
        .from('lb_scorer_results')
        .select('transcript')
        .eq('id', jobId)
        .single();

      const transcript = row?.transcript || '';

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
            content: `Score this call transcript:\n\n${transcript}\n\nReturn ONLY the JSON object.`
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
      const result = JSON.parse(clean);

      // Save scores directly to Supabase
      await supabase.from('lb_scorer_results').update({
        status:           'complete',
        agent_name:       agentName,
        agent_id:         agentId || null,
        overall_score:    Math.round(result.overall_score || 0),
        score_intro:      Math.round(result.plate_scores?.intro_eligibility || 0),
        score_health:     Math.round(result.plate_scores?.health_review || 0),
        score_plan:       Math.round(result.plate_scores?.plan_review || 0),
        score_problem:    Math.round(result.plate_scores?.problem_reveal || 0),
        score_solution:   Math.round(result.plate_scores?.solution_reveal || 0),
        score_enrollment: Math.round(result.plate_scores?.enrollment || 0),
        coaching_points:  JSON.stringify(result.coaching_points || []),
        call_summary:     result.call_summary || '',
        completed_at:     new Date().toISOString(),
      }).eq('id', jobId);

      return { ok: true };
    });

    // Step 4: Cleanup audio file
    await step.run('cleanup-audio', async () => {
      await supabase.storage.from('lb-scorer-audio').remove([storagePath]);
      return { ok: true };
    });

    return { jobId };
  }
);
