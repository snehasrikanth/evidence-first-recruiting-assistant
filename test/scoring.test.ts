import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCandidateScore,
  projectResumeForScoring,
  ScoreAnswer,
} from "../server/scoring.js";

const ids = [
  "mustHaveCoverage",
  "relevantExperience",
  "technicalDepth",
  "ownershipImpact",
  "externalRelevance",
  "artifactDepth",
  "corroboration",
];

function answers(score: number, confidence = 0.9) {
  return Object.fromEntries(
    ids.map((id) => [
      id,
      {
        type: "score",
        score,
        confidence,
        legend: {
          "0": "None",
          "1": "Limited",
          "2": "Partial",
          "3": "Strong",
          "4": "Comprehensive",
        },
        probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 },
      } satisfies ScoreAnswer,
    ]),
  );
}

test("resume evidence can earn 90 points without an external-profile penalty", () => {
  const result = calculateCandidateScore(
    "Candidate",
    answers(4),
    "Built and owned distributed systems with measurable impact.",
    "Requires distributed systems ownership.",
    [],
    { name: "test", model: "test-model" },
  );

  assert.equal(result.corePoints, 90);
  assert.equal(result.externalBonus, 0);
  assert.equal(result.total, 90);
  assert.equal(result.route, "advance");
  assert.match(result.flags.join(" "), /no penalty/i);
});

test("external evidence is capped at ten points", () => {
  const result = calculateCandidateScore(
    "Candidate",
    answers(4),
    "Built and owned distributed systems with measurable impact.",
    "Requires distributed systems ownership.",
    [
      {
        claim: "Maintains a role-relevant distributed systems project.",
        sourceUrl: "https://github.com/candidate/project",
        sourceType: "github",
      },
    ],
    { name: "test", model: "test-model" },
  );

  assert.equal(result.corePoints, 90);
  assert.equal(result.externalBonus, 10);
  assert.equal(result.total, 100);
});

test("low confidence and must-have gaps always route to review", () => {
  const lowConfidenceAnswers = answers(4, 0.3);
  lowConfidenceAnswers.mustHaveCoverage = {
    ...lowConfidenceAnswers.mustHaveCoverage,
    score: 1,
  };
  const result = calculateCandidateScore(
    "Candidate",
    lowConfidenceAnswers,
    "Some related experience.",
    "Requires production systems ownership.",
    [],
    { name: "test", model: "test-model" },
  );

  assert.equal(result.route, "review");
  assert.ok(result.flags.length >= 2);
});

test("scoring projection removes direct identifiers and sensitive lines", () => {
  const projected = projectResumeForScoring(
    [
      "Alex Rivera",
      "Cambridge, MA",
      "alex@example.com",
      "+1 (617) 555-1234",
      "Religion: example",
      "Built production APIs.",
    ].join("\n"),
    "Alex Rivera",
    "Cambridge, MA",
  );

  assert.doesNotMatch(projected, /Alex Rivera|Cambridge|alex@example|617|Religion/i);
  assert.match(projected, /Built production APIs/);
});
