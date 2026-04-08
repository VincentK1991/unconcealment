import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { PIPELINE_CONSTANTS } from "../constants/pipeline";
import {
  type LlmCandidate,
  type SameAsPair,
  electAndWriteCanonicals,
  localName,
  writeSameAsPairs,
} from "./normalizeEntitiesShared";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── I/O types ───────────────────────────────────────────────────────────────

export interface NormalizeEntitiesLlmInput {
  datasetId:     string;
  indexingRunId: string;
  /** Passed directly from normalizeEntitiesRuleBased output. */
  llmCandidates: LlmCandidate[];
}

export interface NormalizeEntitiesLlmOutput {
  /** Number of sameAs pairs accepted by the LLM and written to the graph. */
  llmPairsAsserted: number;
  /** Candidates accepted by the LLM judge (isSameEntity=true, confidence ≥ threshold). */
  llmAccepted:      number;
  /** Candidates not accepted (rejected, low-confidence, or batch skipped on LLM error). */
  llmRejected:      number;
}

// ─── Zod schema for structured output ────────────────────────────────────────

const PairJudgementSchema = z.object({
  pairIndex:    z.number().int().describe("0-based index into the submitted pairs array"),
  isSameEntity: z.boolean().describe("true if the two entities refer to the same real-world thing"),
  confidence:   z.number().min(0).max(1).describe("judgement confidence [0-1]"),
});

const NormalisationResultSchema = z.object({
  judgements: z.array(PairJudgementSchema),
});

const BATCH_SIZE = 50;

// ─── Activity ────────────────────────────────────────────────────────────────

/**
 * Activity: LLM-based entity normalization (step 2 of 2).
 *
 * Receives medium-confidence candidate pairs from normalizeEntitiesRuleBased.
 * Processes them in sequential batches of 50 via a single structured-output
 * LLM call per batch. Accepted pairs (isSameEntity=true, confidence ≥ threshold)
 * are written to the normalization graph with normalizationMethod="llm-judge".
 *
 * LLM failures are non-fatal: a warning is logged and the batch is skipped so
 * the document remains indexed even if the model returns unusable output.
 */
export async function normalizeEntitiesLlm(
  input: NormalizeEntitiesLlmInput,
): Promise<NormalizeEntitiesLlmOutput> {
  if (input.llmCandidates.length === 0) {
    return { llmPairsAsserted: 0, llmAccepted: 0, llmRejected: 0 };
  }

  const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8080";
  const graphNorm  = `urn:${input.datasetId}:normalization`;
  const allPairs:   SameAsPair[] = [];

  // Process in sequential batches of BATCH_SIZE to avoid context-limit issues.
  for (let offset = 0; offset < input.llmCandidates.length; offset += BATCH_SIZE) {
    const batch = input.llmCandidates.slice(offset, offset + BATCH_SIZE);
    const pairs = await judgeWithLlm(batch);
    allPairs.push(...pairs);
  }

  await writeSameAsPairs(backendUrl, input.datasetId, input.indexingRunId, graphNorm, allPairs);
  if (allPairs.length > 0) {
    const touchedIris = new Set(allPairs.flatMap(p => [p.subjectIri, p.objectIri]));
    await electAndWriteCanonicals(backendUrl, input.datasetId, touchedIris);
  }
  return {
    llmPairsAsserted: allPairs.length,
    llmAccepted:      allPairs.length,
    llmRejected:      input.llmCandidates.length - allPairs.length,
  };
}

// ─── LLM judge ───────────────────────────────────────────────────────────────

async function judgeWithLlm(batch: LlmCandidate[]): Promise<SameAsPair[]> {
  const pairDescriptions = batch.map((p, i) =>
    `Pair ${i}:\n` +
    `  Entity A: label="${p.newLabel}", type="${localName(p.newType)}", description="${p.newDescription}"\n` +
    `  Entity B: label="${p.candidateLabel}", type="${localName(p.candidateType)}", description="${p.candidateDescription}"`,
  ).join("\n\n");

  const systemPrompt =
    "You are a knowledge graph entity normalisation assistant. " +
    "For each pair, decide whether the two entities refer to the same real-world thing. " +
    "Entities may have different ontology types and still be the same — type mismatches alone are not disqualifying. " +
    "Base your decision solely on the labels and descriptions. " +
    "Be conservative: when in doubt, return isSameEntity=false.";

  let parsed: z.infer<typeof NormalisationResultSchema> | null = null;
  try {
    const response = await openai.responses.parse({
      model: PIPELINE_CONSTANTS.models.normalization,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: `Judge each of the following entity pairs:\n\n${pairDescriptions}` },
      ],
      text: { format: zodTextFormat(NormalisationResultSchema, "normalisation_result") },
    });
    parsed = response.output_parsed;
  } catch (err) {
    console.warn(`[normalizeEntitiesLlm] LLM call failed for batch of ${batch.length}: ${err}. Skipping batch.`);
    return [];
  }

  if (!parsed) {
    console.warn(`[normalizeEntitiesLlm] LLM returned no parsed output for batch of ${batch.length}. Skipping batch.`);
    return [];
  }

  const accepted: SameAsPair[] = [];
  for (const j of parsed.judgements) {
    if (!j.isSameEntity) continue;
    if (j.confidence < PIPELINE_CONSTANTS.normalization.llmAcceptThreshold) continue;
    const candidate = batch[j.pairIndex];
    if (!candidate) continue;
    accepted.push({
      subjectIri:          candidate.newIri,
      objectIri:           candidate.candidateIri,
      confidence:          j.confidence,
      normalizationMethod: "llm-judge",
    });
  }
  return accepted;
}
