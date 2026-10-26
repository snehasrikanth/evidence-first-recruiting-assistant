import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import * as cheerio from "cheerio";
import { strFromU8, unzipSync } from "fflate";
import { extractLinks, extractText, getDocumentProxy } from "unpdf";
import WordExtractor from "word-extractor";

export type SourceType = "github" | "linkedin" | "portfolio";
export type IdentityConfidence = "corroborated" | "likely" | "ambiguous";

export interface ResumeInput {
  originalname: string;
  buffer: Buffer;
}

export interface SourceResult {
  url: string;
  type: SourceType;
  status: "retrieved" | "unavailable" | "excluded";
  identityConfidence: IdentityConfidence;
  identitySignals: string[];
  evidence: Array<{ claim: string; sourceUrl: string }>;
  provenance: {
    attributedBy: "resume" | "bounded-discovery";
    retrievedAt: string;
    adapter: string;
  };
  message?: string;
}

export interface SourceSuggestion {
  url: string;
  type: "github" | "portfolio";
  title: string;
  identityConfidence: "corroborated" | "likely";
  identitySignals: string[];
  discoveredVia: "github-user-search" | "github-profile-website";
}

export interface CandidateResearch {
  resumeName: string;
  candidateName: string;
  resumeLocation: string | null;
  extractedUrls: string[];
  sources: SourceResult[];
  suggestions: SourceSuggestion[];
}

const wordExtractor = new WordExtractor();
const MAX_SOURCE_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 10_000;
const LINKEDIN_TIMEOUT_MS = 25_000;
const SOURCE_CACHE_TTL_MS = 15 * 60 * 1000;
const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain"]);
const ALLOWED_PROTOCOLS = new Set(["https:"]);
const URL_PATTERN =
  /(?:https?:\/\/|www\.)[^\s<>{}[\]"']+|(?:linkedin\.com\/in|github\.com\/)[^\s<>{}[\]"']+/gi;
const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "from",
  "have",
  "into",
  "job",
  "linkedin",
  "https",
  "content",
  "professional",
  "profile",
  "role",
  "that",
  "the",
  "their",
  "this",
  "using",
  "with",
  "will",
  "years",
]);
const SENSITIVE_TERMS =
  /\b(age|birthday|birth date|gender|sex|race|ethnicity|religion|marital|pregnan|disab|medical|nationality|citizenship|political|sexual orientation)\b/i;
const sourceCache = new Map<
  string,
  { expiresAt: number; value: { text: string; adapter: string } }
>();
const suggestionCache = new Map<
  string,
  { expiresAt: number; value: SourceSuggestion[] }
>();

export function isLinkedInBlockedPage(text: string) {
  return (
    /title:\s*(sign up|log in)\s*\|\s*linkedin/i.test(text) ||
    /linkedin\.com\/legal\/|authwall|join linkedin today/i.test(text)
  );
}

function cleanUrl(value: string) {
  return value.replace(/[),.;:!?]+$/g, "");
}

function normalizeUrl(value: string): string | null {
  try {
    const withProtocol = /^https?:\/\//i.test(value)
      ? value
      : `https://${value.replace(/^www\./i, "www.")}`;
    const url = new URL(cleanUrl(withProtocol));
    if (!ALLOWED_PROTOCOLS.has(url.protocol) || url.username || url.password) {
      return null;
    }
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (hostname === "linkedin.com" || hostname === "github.com") {
      url.hostname = hostname;
      url.pathname = url.pathname.replace(/\/+$/, "");
      url.search = "";
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function sourceType(url: string): SourceType {
  const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  if (hostname === "github.com") return "github";
  if (hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")) {
    return "linkedin";
  }
  return "portfolio";
}

function isCandidateProfessionalUrl(url: string) {
  const parsed = new URL(url);
  const type = sourceType(url);
  if (type === "linkedin") return /^\/in\/[^/]+\/?$/i.test(parsed.pathname);
  if (type === "github") {
    const firstSegment = parsed.pathname.split("/").filter(Boolean)[0];
    return Boolean(firstSegment) && !["features", "topics", "orgs", "search"].includes(firstSegment);
  }
  return true;
}

export function urlsFromText(text: string) {
  const matches = text.match(URL_PATTERN) ?? [];
  return [
    ...new Set(
      matches
        .map(normalizeUrl)
        .filter((url): url is string => Boolean(url))
        .filter(isCandidateProfessionalUrl),
    ),
  ];
}

export async function parseResume(file: ResumeInput) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (extension === ".pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(file.buffer));
    const [{ text }, { links }] = await Promise.all([
      extractText(pdf, { mergePages: true }),
      extractLinks(pdf),
    ]);
    return { text, embeddedUrls: links };
  }

  if (extension === ".docx") {
    const [document, archive] = await Promise.all([
      wordExtractor.extract(file.buffer),
      Promise.resolve(unzipSync(new Uint8Array(file.buffer))),
    ]);
    const relationships = archive["word/_rels/document.xml.rels"];
    const relationshipXml = relationships ? strFromU8(relationships) : "";
    const embeddedUrls = [...relationshipXml.matchAll(/<Relationship\b[^>]*>/gi)]
      .map(([tag]) => {
        const target = tag.match(/\bTarget="([^"]+)"/i)?.[1];
        const targetMode = tag.match(/\bTargetMode="([^"]+)"/i)?.[1];
        if (!target || targetMode?.toLowerCase() !== "external") return null;
        return target.replace(/&amp;/g, "&");
      })
      .filter((url): url is string => Boolean(url));
    return { text: document.getBody(), embeddedUrls };
  }

  if (extension === ".doc") {
    const document = await wordExtractor.extract(file.buffer);
    return { text: document.getBody(), embeddedUrls: [] as string[] };
  }

  throw new Error("Unsupported resume type");
}

export function inferCandidateName(text: string) {
  const rejected = /@|https?:|www\.|\d{3}|resume|curriculum|profile|summary/i;
  const candidate = text
    .split(/\r?\n/)
    .slice(0, 12)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .find(
      (line) =>
        line.length >= 3 &&
        line.length <= 60 &&
        !rejected.test(line) &&
        /^[\p{L}.' -]+$/u.test(line) &&
        line.split(/\s+/).length <= 6,
    );
  return candidate ?? "Candidate";
}

const US_STATE_CODES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";
const LOCATION_ALIASES: Record<string, string> = {
  ma: "massachusetts",
  ca: "california",
  ny: "newyork",
  nj: "newjersey",
  tx: "texas",
  wa: "washington",
  il: "illinois",
  dc: "washington",
  nyc: "newyork",
  uae: "emirates",
  usa: "unitedstates",
  us: "unitedstates",
  uk: "unitedkingdom",
};

export function extractResumeLocation(text: string) {
  const header = text.slice(0, 1_200);
  const stateMatch = header.match(
    new RegExp(
      `\\b([A-Z][A-Za-z.' -]{1,35}),?\\s+(${US_STATE_CODES})\\b(?:\\s+\\d{5})?`,
      "i",
    ),
  );
  if (stateMatch) return `${stateMatch[1].trim()}, ${stateMatch[2].toUpperCase()}`;

  const countryMatch = header.match(
    /\b([A-Z][A-Za-z.' -]{1,35}),\s*(United States|USA|UAE|United Arab Emirates|Canada|India|United Kingdom|UK)\b/i,
  );
  return countryMatch
    ? `${countryMatch[1].trim()}, ${countryMatch[2].trim()}`
    : null;
}

function locationTokens(location: string) {
  return new Set(
    location
      .toLowerCase()
      .replace(/united states(?: of america)?/g, "unitedstates")
      .replace(/united arab emirates/g, "emirates")
      .replace(/united kingdom/g, "unitedkingdom")
      .match(/[a-z]+/g)
      ?.map((token) => LOCATION_ALIASES[token] ?? token)
      .filter(
        (token) =>
          !["area", "greater", "metropolitan", "region"].includes(token),
      ) ?? [],
  );
}

export function locationsConflict(resumeLocation: string, sourceLocation: string) {
  const resumeTokens = locationTokens(resumeLocation);
  const sourceTokens = locationTokens(sourceLocation);
  return ![...resumeTokens].some((token) => sourceTokens.has(token));
}

function isBlockedAddress(address: string) {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^127\./.test(normalized) ||
    /^10\./.test(normalized) ||
    /^169\.254\./.test(normalized) ||
    /^192\.168\./.test(normalized) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) ||
    normalized === "0.0.0.0"
  );
}

async function assertPublicUrl(url: URL) {
  if (!ALLOWED_PROTOCOLS.has(url.protocol) || url.port && url.port !== "443") {
    throw new Error("Only public HTTPS sources are allowed");
  }
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(hostname)) throw new Error("Private hosts are not allowed");
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error("Private addresses are not allowed");
    return;
  }
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error("Source did not resolve to a public address");
  }
}

async function safeFetch(
  urlValue: string,
  headers: Record<string, string> = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
) {
  let current = new URL(urlValue);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    await assertPublicUrl(current);
    const response = await fetch(current, {
      headers: {
        Accept: "text/html,application/json",
        "User-Agent": "RecruitingDecisionSupport/0.1",
        ...headers,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Source returned an invalid redirect");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_SOURCE_BYTES) throw new Error("Source is too large");
    return response;
  }
  throw new Error("Source redirected too many times");
}

function jobKeywords(jobDescription: string) {
  return new Set(
    jobDescription
      .toLowerCase()
      .match(/[a-z][a-z0-9+#.-]{2,}/g)
      ?.filter((word) => word.length > 3 && !STOP_WORDS.has(word))
      .slice(0, 100) ?? [],
  );
}

function relevantEvidence(text: string, jobDescription: string, sourceUrl: string) {
  const keywords = jobKeywords(jobDescription);
  if (!keywords.size) return [];
  const seen = new Set<string>();
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(
      (sentence) =>
        sentence.length >= 25 &&
        sentence.length <= 280 &&
        !SENSITIVE_TERMS.test(sentence) &&
        [...keywords].some((keyword) => sentence.toLowerCase().includes(keyword)),
    )
    .filter((sentence) => {
      const key = sentence.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5)
    .map((claim) => ({ claim, sourceUrl }));
}

function matchingProfessionalTerms(
  resumeText: string,
  sourceText: string,
  excludedTerms: string[],
) {
  const withoutUrls = (value: string) =>
    value.replace(/(?:https?:\/\/|www\.)\S+/gi, " ");
  const source = withoutUrls(sourceText).toLowerCase();
  const terms =
    withoutUrls(resumeText)
      .toLowerCase()
      .match(/[a-z][a-z0-9+#.-]{3,}/g)
      ?.filter(
        (term) =>
          term.length > 4 &&
          !STOP_WORDS.has(term) &&
          !excludedTerms.includes(term) &&
          !SENSITIVE_TERMS.test(term) &&
          source.includes(term),
      ) ?? [];
  return [...new Set(terms)].slice(0, 6);
}

export function assessIdentity(
  candidateName: string,
  resumeText: string,
  sourceText: string,
  retrieved: boolean,
) {
  if (!retrieved) {
    return {
      confidence: "ambiguous" as const,
      signals: ["Source content was unavailable; identity could not be checked"],
    };
  }
  if (candidateName === "Candidate") {
    return {
      confidence: "likely" as const,
      signals: ["URL was supplied in the resume", "Candidate name could not be parsed reliably"],
    };
  }
  const nameTokens = candidateName
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 1);
  const normalizedSource = sourceText.toLowerCase();
  const matchingTokens = nameTokens.filter((token) => normalizedSource.includes(token));
  const professionalTerms = matchingProfessionalTerms(
    resumeText,
    sourceText,
    nameTokens,
  );
  if (
    matchingTokens.length === nameTokens.length &&
    professionalTerms.length > 0
  ) {
    return {
      confidence: "corroborated" as const,
      signals: [
        "URL was supplied in the resume",
        "Candidate name matches the source",
        `Shared professional evidence: ${professionalTerms.join(", ")}`,
      ],
    };
  }
  if (matchingTokens.length > 0 || professionalTerms.length >= 2) {
    return {
      confidence: "likely" as const,
      signals: [
        "URL was supplied in the resume",
        matchingTokens.length === nameTokens.length
          ? "Candidate name matches; additional corroboration was limited"
          : "Candidate identity partially matches the source",
        ...(professionalTerms.length
          ? [`Shared professional evidence: ${professionalTerms.join(", ")}`]
          : []),
      ],
    };
  }
  return {
    confidence: "ambiguous" as const,
    signals: ["URL was supplied in the resume", "Candidate name was not found on the source"],
  };
}

async function fetchGithub(url: string) {
  const parsed = new URL(url);
  const [owner, repository] = parsed.pathname.split("/").filter(Boolean);
  const apiUrl = repository
    ? `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
    : `https://api.github.com/users/${encodeURIComponent(owner)}`;
  const response = await safeFetch(apiUrl, {
    Accept: "application/vnd.github+json",
    ...(process.env.GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {}),
  });
  const data = (await response.json()) as Record<string, unknown>;
  let repositories: Array<Record<string, unknown>> = [];
  if (!repository) {
    try {
      const repositoriesResponse = await safeFetch(
        `https://api.github.com/users/${encodeURIComponent(owner)}/repos?sort=updated&per_page=10`,
        {
          Accept: "application/vnd.github+json",
          ...(process.env.GITHUB_TOKEN
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
      );
      repositories = (await repositoriesResponse.json()) as Array<
        Record<string, unknown>
      >;
    } catch {
      // Profile evidence remains usable if repository retrieval is unavailable.
    }
  }
  const text = [
    data.name,
    data.login,
    data.bio,
    data.company,
    data.description,
    data.language,
    ...(Array.isArray(data.topics) ? data.topics : []),
    ...repositories.flatMap((item) => [
      item.name,
      item.description,
      item.language,
      ...(Array.isArray(item.topics) ? item.topics : []),
    ]),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(". ");
  return { text, adapter: "github-api" };
}

async function fetchWebPage(url: string) {
  const response = await safeFetch(url);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    throw new Error("Source is not a readable web page");
  }
  const html = (await response.text()).slice(0, MAX_SOURCE_BYTES);
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, img, video, audio").remove();
  const text = [
    $("title").text(),
    $('meta[name="description"]').attr("content"),
    $("main").text() || $("body").text(),
  ]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return { text, adapter: "direct-web" };
}

async function fetchLinkedIn(url: string) {
  const readerUrl = `https://r.jina.ai/${url}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await safeFetch(
        readerUrl,
        { Accept: "text/plain" },
        LINKEDIN_TIMEOUT_MS,
      );
      const text = (await response.text()).slice(0, MAX_SOURCE_BYTES);
      if (isLinkedInBlockedPage(text)) {
        throw new Error(
          "LinkedIn returned a sign-in page instead of a public profile.",
        );
      }
      return {
        text,
        adapter: attempt === 0 ? "jina-reader" : "jina-reader-retry",
      };
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  throw lastError;
}

function githubHeaders() {
  return {
    Accept: "application/vnd.github+json",
    ...(process.env.GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {}),
  };
}

async function discoverProfessionalSources(
  resumeText: string,
  candidateName: string,
  existingUrls: string[],
): Promise<SourceSuggestion[]> {
  if (candidateName === "Candidate") return [];
  const cacheKey = `${candidateName.toLowerCase()}::${existingUrls
    .slice()
    .sort()
    .join("|")}`;
  const cached = suggestionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const existing = new Set(existingUrls);
    const resumeLocation = extractResumeLocation(resumeText);
    const existingGithubProfile = existingUrls.find((url) => {
      if (sourceType(url) !== "github") return false;
      return new URL(url).pathname.split("/").filter(Boolean).length === 1;
    });
    let profiles: Array<Record<string, unknown>> = [];
    let searched = false;

    if (existingGithubProfile) {
      const login = new URL(existingGithubProfile).pathname
        .split("/")
        .filter(Boolean)[0];
      const response = await safeFetch(
        `https://api.github.com/users/${encodeURIComponent(login)}`,
        githubHeaders(),
      );
      profiles = [(await response.json()) as Record<string, unknown>];
    } else {
      searched = true;
      const query = `"${candidateName}" in:fullname type:user`;
      const response = await safeFetch(
        `https://api.github.com/search/users?q=${encodeURIComponent(query)}&per_page=2`,
        githubHeaders(),
      );
      const payload = (await response.json()) as {
        items?: Array<{ login?: string }>;
      };
      const logins = (payload.items ?? [])
        .map((item) => item.login)
        .filter((login): login is string => Boolean(login))
        .slice(0, 2);
      profiles = await Promise.all(
        logins.map(async (login) => {
          const profileResponse = await safeFetch(
            `https://api.github.com/users/${encodeURIComponent(login)}`,
            githubHeaders(),
          );
          return (await profileResponse.json()) as Record<string, unknown>;
        }),
      );
    }

    const suggestions: SourceSuggestion[] = [];
    for (const profile of profiles) {
      const login = typeof profile.login === "string" ? profile.login : "";
      if (!login) continue;
      const githubUrl =
        typeof profile.html_url === "string"
          ? normalizeUrl(profile.html_url)
          : normalizeUrl(`https://github.com/${login}`);
      const profileText = [
        profile.name,
        profile.login,
        profile.bio,
        profile.company,
        profile.location,
      ]
        .filter((value): value is string => typeof value === "string")
        .join(". ");
      const githubLocation =
        typeof profile.location === "string" && profile.location.trim()
          ? profile.location.trim()
          : null;
      if (
        resumeLocation &&
        githubLocation &&
        locationsConflict(resumeLocation, githubLocation)
      ) {
        continue;
      }
      const identity = assessIdentity(
        candidateName,
        resumeText,
        profileText,
        true,
      );
      if (identity.confidence === "ambiguous") continue;
      const identitySignals = [
        ...identity.signals,
        ...(resumeLocation && githubLocation
          ? [
              `Location is consistent: resume ${resumeLocation}; GitHub ${githubLocation}`,
            ]
          : []),
      ];

      if (searched && githubUrl && !existing.has(githubUrl)) {
        suggestions.push({
          url: githubUrl,
          type: "github",
          title:
            typeof profile.name === "string"
              ? `${profile.name} (@${login})`
              : `@${login}`,
          identityConfidence: identity.confidence,
          identitySignals,
          discoveredVia: "github-user-search",
        });
      }

      const blog =
        typeof profile.blog === "string" ? normalizeUrl(profile.blog.trim()) : null;
      if (
        blog &&
        new URL(blog).protocol === "https:" &&
        sourceType(blog) === "portfolio" &&
        !existing.has(blog)
      ) {
        suggestions.push({
          url: blog,
          type: "portfolio",
          title: `Website listed by @${login}`,
          identityConfidence: identity.confidence,
          identitySignals: [
            ...identitySignals,
            "Website is linked from the matched GitHub profile",
          ],
          discoveredVia: "github-profile-website",
        });
      }
    }

    const unique = suggestions.filter(
      (suggestion, index, all) =>
        all.findIndex((item) => item.url === suggestion.url) === index,
    );
    suggestionCache.set(cacheKey, {
      expiresAt: Date.now() + SOURCE_CACHE_TTL_MS,
      value: unique,
    });
    return unique;
  } catch {
    return [];
  }
}

async function retrieveSource(
  url: string,
  type: SourceType,
  forceRefresh: boolean,
) {
  const cached = sourceCache.get(url);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return { ...cached.value, adapter: `${cached.value.adapter}-cache` };
  }
  if (cached) sourceCache.delete(url);

  const value =
    type === "github"
      ? await fetchGithub(url)
      : type === "linkedin"
        ? await fetchLinkedIn(url)
        : await fetchWebPage(url);
  sourceCache.set(url, {
    expiresAt: Date.now() + SOURCE_CACHE_TTL_MS,
    value,
  });
  return value;
}

async function researchSource(
  url: string,
  candidateName: string,
  resumeText: string,
  jobDescription: string,
  forceRefresh = false,
  attributedBy: "resume" | "bounded-discovery" = "resume",
): Promise<SourceResult> {
  const type = sourceType(url);
  const retrievedAt = new Date().toISOString();
  try {
    const { text, adapter } = await retrieveSource(url, type, forceRefresh);
    const identity = assessIdentity(candidateName, resumeText, text, true);
    return {
      url,
      type,
      status: identity.confidence === "ambiguous" ? "excluded" : "retrieved",
      identityConfidence: identity.confidence,
      identitySignals: identity.signals,
      evidence:
        identity.confidence === "ambiguous"
          ? []
          : relevantEvidence(text, jobDescription, url),
      provenance: { attributedBy, retrievedAt, adapter },
      ...(identity.confidence === "ambiguous"
        ? { message: "Excluded because identity could not be corroborated." }
        : {}),
    };
  } catch (error) {
    const identity = assessIdentity(candidateName, resumeText, "", false);
    return {
      url,
      type,
      status: "unavailable",
      identityConfidence: identity.confidence,
      identitySignals: identity.signals,
      evidence: [],
      provenance: {
        attributedBy,
        retrievedAt,
        adapter:
          type === "github"
            ? "github-api"
            : type === "linkedin"
              ? "jina-reader"
              : "direct-web",
      },
      message: error instanceof Error ? error.message : "Source retrieval failed",
    };
  }
}

export async function researchCandidates(
  files: ResumeInput[],
  jobDescription: string,
): Promise<CandidateResearch[]> {
  return Promise.all(
    files.map(async (file) => {
      const parsed = await parseResume(file);
      const extractedUrls = [
        ...new Set(
          [...urlsFromText(parsed.text), ...parsed.embeddedUrls]
            .map(normalizeUrl)
            .filter((url): url is string => Boolean(url))
            .filter(isCandidateProfessionalUrl),
        ),
      ].slice(0, 10);
      const candidateName = inferCandidateName(parsed.text);
      const [sources, suggestions] = await Promise.all([
        Promise.all(
          extractedUrls.map((url) =>
            researchSource(url, candidateName, parsed.text, jobDescription),
          ),
        ),
        discoverProfessionalSources(
          parsed.text,
          candidateName,
          extractedUrls,
        ),
      ]);
      return {
        resumeName: file.originalname,
        candidateName,
        resumeLocation: extractResumeLocation(parsed.text),
        extractedUrls,
        sources,
        suggestions,
      };
    }),
  );
}

export async function retryCandidateSource(
  file: ResumeInput,
  jobDescription: string,
  requestedUrl: string,
) {
  const parsed = await parseResume(file);
  const extractedUrls = [
    ...new Set(
      [...urlsFromText(parsed.text), ...parsed.embeddedUrls]
        .map(normalizeUrl)
        .filter((url): url is string => Boolean(url))
        .filter(isCandidateProfessionalUrl),
    ),
  ].slice(0, 10);
  const normalizedRequestedUrl = normalizeUrl(requestedUrl);
  if (
    !normalizedRequestedUrl ||
    !extractedUrls.includes(normalizedRequestedUrl)
  ) {
    throw new Error("The requested source was not found in this resume.");
  }
  const candidateName = inferCandidateName(parsed.text);
  const source = await researchSource(
    normalizedRequestedUrl,
    candidateName,
    parsed.text,
    jobDescription,
    true,
  );
  return { candidateName, source };
}

export async function confirmCandidateSource(
  file: ResumeInput,
  jobDescription: string,
  requestedUrl: string,
) {
  const parsed = await parseResume(file);
  const extractedUrls = [
    ...new Set(
      [...urlsFromText(parsed.text), ...parsed.embeddedUrls]
        .map(normalizeUrl)
        .filter((url): url is string => Boolean(url))
        .filter(isCandidateProfessionalUrl),
    ),
  ].slice(0, 10);
  const candidateName = inferCandidateName(parsed.text);
  const suggestions = await discoverProfessionalSources(
    parsed.text,
    candidateName,
    extractedUrls,
  );
  const normalizedRequestedUrl = normalizeUrl(requestedUrl);
  const suggestion = suggestions.find(
    (item) => item.url === normalizedRequestedUrl,
  );
  if (!suggestion || !normalizedRequestedUrl) {
    throw new Error("The requested source is not a current discovery suggestion.");
  }
  const source = await researchSource(
    normalizedRequestedUrl,
    candidateName,
    parsed.text,
    jobDescription,
    true,
    "bounded-discovery",
  );
  return { candidateName, source };
}
