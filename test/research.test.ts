import assert from "node:assert/strict";
import test from "node:test";
import {
  assessIdentity,
  extractResumeLocation,
  isLinkedInBlockedPage,
  locationsConflict,
  urlsFromText,
} from "../server/research.js";

test("extracts candidate-provided professional URLs without broad discovery", () => {
  const urls = urlsFromText(`
    LinkedIn: linkedin.com/in/alex-rivera
    GitHub: https://github.com/alexrivera
    Portfolio: https://alexrivera.dev/work
    Employer: https://www.linkedin.com/company/example
  `);

  assert.deepEqual(urls, [
    "https://linkedin.com/in/alex-rivera",
    "https://github.com/alexrivera",
    "https://alexrivera.dev/work",
  ]);
});

test("deduplicates equivalent LinkedIn URL forms", () => {
  const urls = urlsFromText(`
    https://linkedin.com/in/meghvakharia
    https://www.linkedin.com/in/meghvakharia/
    https://www.linkedin.com/in/meghvakharia?trk=resume
  `);

  assert.deepEqual(urls, ["https://linkedin.com/in/meghvakharia"]);
});

test("corroborates identity only when name and professional evidence overlap", () => {
  const result = assessIdentity(
    "Alex Rivera",
    "Alex Rivera worked at Northstar and built distributed systems with Kubernetes.",
    "Alex Rivera — Northstar engineer. Kubernetes platform projects.",
    true,
  );

  assert.equal(result.confidence, "corroborated");
  assert.ok(
    result.signals.some((signal) =>
      signal.startsWith("Shared professional evidence:"),
    ),
  );
});

test("keeps a name-only match at likely confidence", () => {
  const result = assessIdentity(
    "Alex Rivera",
    "Alex Rivera builds distributed systems at Northstar.",
    "Alex Rivera public profile.",
    true,
  );

  assert.equal(result.confidence, "likely");
});

test("marks unavailable content ambiguous rather than negative", () => {
  const result = assessIdentity(
    "Alex Rivera",
    "Alex Rivera builds distributed systems.",
    "",
    false,
  );

  assert.equal(result.confidence, "ambiguous");
  assert.match(result.signals[0], /unavailable/i);
});

test("does not use protected traits as corroborating professional evidence", () => {
  const result = assessIdentity(
    "Alex Rivera",
    "Alex Rivera gender ethnicity religion",
    "Alex Rivera gender ethnicity religion",
    true,
  );

  assert.equal(result.confidence, "likely");
  assert.equal(
    result.signals.some((signal) =>
      signal.startsWith("Shared professional evidence:"),
    ),
    false,
  );
});

test("rejects LinkedIn sign-in and legal pages as evidence", () => {
  assert.equal(
    isLinkedInBlockedPage(`
      Title: Sign Up | LinkedIn
      [Your California Privacy Choices](https://www.linkedin.com/legal/privacy)
    `),
    true,
  );
  assert.equal(
    isLinkedInBlockedPage("Kannan Sundaram — machine learning engineer"),
    false,
  );
});

test("extracts a resume header location and rejects a conflicting GitHub location", () => {
  const resumeLocation = extractResumeLocation(`
    KANNAN SUNDARAM
    Cambridge, MA
    Machine learning engineer
  `);

  assert.equal(resumeLocation, "Cambridge, MA");
  assert.equal(locationsConflict(resumeLocation!, "Dubai, UAE"), true);
  assert.equal(locationsConflict(resumeLocation!, "Boston, MA"), false);
});
