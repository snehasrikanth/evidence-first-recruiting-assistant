export interface ExternalEvidence {
  claim: string;
  sourceUrl: string;
  sourceType: "github" | "linkedin" | "portfolio";
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

export interface ScoringProvider {
  name: string;
  score(
    state: Record<string, unknown>,
    questions: Record<string, ScoreQuestion>,
  ): Promise<{
    model: string;
    answers: Record<string, ScoreAnswer>;
    usage?: { input_tokens?: number; output_tokens?: number };
  }>;
}

interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

interface CriterionDefinition {
  id: string;
  label: string;
  maxPoints: number;
  instructions: string;
  criteria: string[];
  evidenceTerms: string[];
}

export interface CriterionResult {
  id: string;
  label: string;
  maxPoints: number;
  points: number;
  score: number;
  confidence: number;
  level: string;
  evidence: Array<{ text: string; sourceUrl?: string }>;
}

export interface CandidateScore {
  candidateName: string;
  corePoints: number;
  externalBonus: number;
  total: number;
  route: "advance" | "review";
  criteria: CriterionResult[];
  flags: string[];
  provider: {
    name: string;
    model: string;
    inputTokens?: number;
  };
}

const SHARED_SCORE_LEVELS = [
  "No job-relevant evidence is present.",
  "Limited or indirect evidence; substantial gaps remain.",
  "Partial evidence; some requirements are demonstrated but important gaps remain.",
  "Strong, specific evidence demonstrates most requirements.",
  "Comprehensive, specific evidence clearly demonstrates the requirement.",
];

const CORE_CRITERIA: CriterionDefinition[] = [
  {
    id: "mustHaveCoverage",
    label: "Must-have coverage",
    maxPoints: 40,
    instructions:
      "Evaluate only explicit must-have requirements in the role. Do not infer missing qualifications. Missing evidence is not proof that the candidate lacks a skill.",
    criteria: SHARED_SCORE_LEVELS,
    evidenceTerms: ["required", "must", "experience", "proficient", "expert"],
  },
  {
    id: "relevantExperience",
    label: "Relevant experience",
    maxPoints: 25,
    instructions:
      "Evaluate how directly the candidate's demonstrated work relates to the responsibilities and domain in the role description.",
    criteria: SHARED_SCORE_LEVELS,
    evidenceTerms: ["experience", "built", "developed", "implemented", "delivered"],
  },
  {
    id: "technicalDepth",
    label: "Technical or functional depth",
    maxPoints: 15,
    instructions:
      "Evaluate demonstrated hands-on depth. Prefer specific work and outcomes over skill lists, titles, employer prestige, or credentials alone.",
    criteria: SHARED_SCORE_LEVELS,
    evidenceTerms: ["designed", "architected", "implemented", "optimized", "scaled"],
  },
  {
    id: "ownershipImpact",
    label: "Ownership and impact",
    maxPoints: 10,
    instructions:
      "Evaluate evidence of ownership and measurable impact. Do not infer leadership from job titles alone.",
    criteria: SHARED_SCORE_LEVELS,
    evidenceTerms: [
      "owned",
      "led",
      "launched",
      "improved",
      "reduced",
      "increased",
      "mentored",
    ],
  },
];

const BONUS_CRITERIA: CriterionDefinition[] = [
  {
    id: "externalRelevance",
    label: "External evidence relevance",
    maxPoints: 4,
    instructions:
      "Using only external_evidence, evaluate whether it adds new, role-relevant evidence beyond the resume. Profile presence or polish alone earns no credit.",
    criteria: SHARED_SCORE_LEVELS,
    evidenceTerms: [],
  },
  {
    id: "artifactDepth",
    label: "Demonstrated artifact depth",
    maxPoints: 3,
    instructions:
      "Using only external_evidence, evaluate the depth of demonstrated work artifacts. Ignore stars, followers, popularity, and posting frequency.",
    criteria: SHARED_SCORE_LEVELS,
    evidenceTerms: [],
  },
  {
    id: "corroboration",
    label: "Resume corroboration",
    maxPoints: 3,
    instructions:
      "Using only external_evidence, evaluate how strongly it corroborates specific resume claims. Repetition without independent detail earns no credit.",
    criteria: SHARED_SCORE_LEVELS,
    evidenceTerms: [],
  },
];

const SENSITIVE_LINE =
  /\b(age|birthday|birth date|gender|sex|race|ethnicity|religion|marital|pregnan|disab|medical|nationality|citizenship|political|sexual orientation)\b/i;
const COMMON_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "for",
  "from",
  "have",
  "into",
  "that",
  "the",
  "their",
  "this",
  "with",
  "will",
  "years",
]);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function projectResumeForScoring(
  resumeText: string,
  candidateName: string,
  candidateLocation: string | null,
) {
  const namePattern =
    candidateName && candidateName !== "Candidate"
      ? new RegExp(escapeRegExp(candidateName), "gi")
      : null;
  const locationPattern = candidateLocation
    ? new RegExp(escapeRegExp(candidateLocation), "gi")
    : null;

  return resumeText
    .split(/\r?\n/)
    .filter((line) => !SENSITIVE_LINE.test(line))
    .join("\n")
    .replace(namePattern ?? /$^/, "[candidate]")
    .replace(locationPattern ?? /$^/, "[location removed]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email removed]")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "[url removed]")
    .replace(/(?:\+?\d[\d(). -]{7,}\d)/g, "[phone removed]")
    .slice(0, 100_000);
}

function jobTerms(jobDescription: string) {
  return [
    ...new Set(
      jobDescription
        .toLowerCase()
        .match(/[a-z][a-z0-9+#.-]{3,}/g)
        ?.filter((term) => term.length > 4 && !COMMON_WORDS.has(term)) ?? [],
    ),
  ].slice(0, 80);
}

function resumeEvidence(
  resumeText: string,
  jobDescription: string,
  criterion: CriterionDefinition,
) {
  const terms = [...jobTerms(jobDescription), ...criterion.evidenceTerms];
  return resumeText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(
      (text) =>
        text.length >= 25 &&
        text.length <= 320 &&
        !SENSITIVE_LINE.test(text),
    )
    .map((text) => ({
      text,
      matches: terms.filter((term) => text.toLowerCase().includes(term)).length,
    }))
    .filter((item) => item.matches > 0)
    .sort((left, right) => right.matches - left.matches)
    .slice(0, 3)
    .map(({ text }) => ({ text }));
}

function asQuestion(definition: CriterionDefinition): ScoreQuestion {
  return {
    type: "score",
    instructions: definition.instructions,
    criteria: definition.criteria,
  };
}

function validateAnswer(answer: ScoreAnswer | undefined, id: string) {
  if (
    !answer ||
    answer.type !== "score" ||
    !Number.isFinite(answer.score) ||
    !Number.isFinite(answer.confidence)
  ) {
    throw new Error(`Scoring provider returned an invalid answer for ${id}.`);
  }
  return answer;
}

function round(value: number, places = 1) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

export function calculateCandidateScore(
  candidateName: string,
  answers: Record<string, ScoreAnswer>,
  resumeText: string,
  jobDescription: string,
  externalEvidence: ExternalEvidence[],
  provider: { name: string; model: string; inputTokens?: number },
): CandidateScore {
  const definitions = [...CORE_CRITERIA, ...BONUS_CRITERIA];
  const criteria = definitions.map((definition) => {
    const answer = validateAnswer(answers[definition.id], definition.id);
    const boundedScore = Math.min(4, Math.max(0, answer.score));
    const points =
      definition.id.startsWith("external") ||
      definition.id === "artifactDepth" ||
      definition.id === "corroboration"
        ? externalEvidence.length
          ? (boundedScore / 4) * definition.maxPoints
          : 0
        : (boundedScore / 4) * definition.maxPoints;
    const roundedLevel = String(
      Math.min(4, Math.max(0, Math.round(boundedScore))),
    );
    return {
      id: definition.id,
      label: definition.label,
      maxPoints: definition.maxPoints,
      points: round(points),
      score: round(boundedScore, 2),
      confidence: round(Math.min(1, Math.max(0, answer.confidence)), 2),
      level: answer.legend?.[roundedLevel] ?? definition.criteria[Number(roundedLevel)],
      evidence: BONUS_CRITERIA.some((item) => item.id === definition.id)
        ? externalEvidence.slice(0, 4).map((item) => ({
            text: item.claim,
            sourceUrl: item.sourceUrl,
          }))
        : resumeEvidence(resumeText, jobDescription, definition),
    };
  });

  const coreCriteria = criteria.filter((item) =>
    CORE_CRITERIA.some((definition) => definition.id === item.id),
  );
  const bonusCriteria = criteria.filter((item) =>
    BONUS_CRITERIA.some((definition) => definition.id === item.id),
  );
  const corePoints = round(
    coreCriteria.reduce((sum, criterion) => sum + criterion.points, 0),
  );
  const externalBonus = round(
    Math.min(10, bonusCriteria.reduce((sum, criterion) => sum + criterion.points, 0)),
  );
  const total = round(Math.min(100, corePoints + externalBonus));
  const mustHave = criteria.find((criterion) => criterion.id === "mustHaveCoverage")!;
  const averageCoreConfidence =
    coreCriteria.reduce((sum, criterion) => sum + criterion.confidence, 0) /
    coreCriteria.length;
  const flags: string[] = [];
  if (mustHave.score < 2.5) flags.push("Must-have coverage requires human review.");
  if (averageCoreConfidence < 0.55) flags.push("Scoring confidence is below the review threshold.");
  if (!externalEvidence.length) {
    flags.push("No corroborated external evidence was used; no penalty was applied.");
  }

  const route =
    total >= 75 && mustHave.score >= 2.5 && averageCoreConfidence >= 0.55
      ? "advance"
      : "review";

  return {
    candidateName,
    corePoints,
    externalBonus,
    total,
    route,
    criteria,
    flags,
    provider,
  };
}

export class JevScoringProvider implements ScoringProvider {
  readonly name = "jev";

  constructor(
    private readonly apiKey: string,
    private readonly model = "jev-1.14.0",
    private readonly baseUrl = "https://api.typesafe.ai",
  ) {}

  async score(
    state: Record<string, unknown>,
    questions: Record<string, ScoreQuestion>,
  ) {
    const response = await fetch(`${this.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, state, questions }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(
        `Jev scoring failed with HTTP ${response.status}${
          detail ? `: ${detail}` : ""
        }`,
      );
    }
    return (await response.json()) as {
      model: string;
      answers: Record<string, ScoreAnswer>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
  }
}

export async function scoreCandidate(
  provider: ScoringProvider,
  input: {
    candidateName: string;
    candidateLocation: string | null;
    resumeText: string;
    jobTitle: string;
    jobDescription: string;
    externalEvidence: ExternalEvidence[];
  },
) {
  const projectedResume = projectResumeForScoring(
    input.resumeText,
    input.candidateName,
    input.candidateLocation,
  );
  const definitions = [...CORE_CRITERIA, ...BONUS_CRITERIA];
  const questions = Object.fromEntries(
    definitions.map((definition) => [definition.id, asQuestion(definition)]),
  );
  const response = await provider.score(
    {
      role: {
        title: input.jobTitle,
        description: input.jobDescription.slice(0, 40_000),
      },
      resume: projectedResume,
      external_evidence: input.externalEvidence,
      policy: {
        external_evidence_is_bonus_only: true,
        missing_external_evidence_is_not_negative: true,
        ignore_popularity_and_protected_traits: true,
      },
    },
    questions,
  );
  return calculateCandidateScore(
    input.candidateName,
    response.answers,
    projectedResume,
    input.jobDescription,
    input.externalEvidence,
    {
      name: provider.name,
      model: response.model,
      inputTokens: response.usage?.input_tokens,
    },
  );
}
