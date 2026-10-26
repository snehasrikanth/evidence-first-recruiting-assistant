import {
  ChangeEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  useRef,
  useState,
} from "react";

const MAX_RESUMES = 20;
const ALLOWED_EXTENSIONS = [".pdf", ".doc", ".docx"];
const SOURCE_LABELS = {
  github: "GitHub",
  linkedin: "LinkedIn",
  portfolio: "Portfolio",
} as const;

type SourceType = keyof typeof SOURCE_LABELS;

type EvidenceSource = {
  type: SourceType;
  url: string;
  status: "retrieved" | "unavailable" | "excluded";
  identityConfidence: "corroborated" | "likely" | "ambiguous";
  identitySignals: string[];
  evidence: Array<{ claim: string; sourceUrl: string }>;
  provenance: {
    attributedBy: "resume" | "bounded-discovery";
    retrievedAt: string;
    adapter: string;
  };
  message?: string;
};

type SourceSuggestion = {
  url: string;
  type: "github" | "portfolio";
  title: string;
  identityConfidence: "corroborated" | "likely";
  identitySignals: string[];
  discoveredVia: "github-user-search" | "github-profile-website";
};

type CandidateResearch = {
  resumeName: string;
  candidateName: string;
  resumeLocation: string | null;
  extractedUrls: string[];
  sources: EvidenceSource[];
  suggestions: SourceSuggestion[];
};

type CriterionScore = {
  id: string;
  label: string;
  maxPoints: number;
  points: number;
  score: number;
  confidence: number;
  level: string;
  evidence: Array<{ text: string; sourceUrl?: string }>;
};

type CandidateScore = {
  candidateName: string;
  corePoints: number;
  externalBonus: number;
  total: number;
  route: "advance" | "review";
  criteria: CriterionScore[];
  flags: string[];
  provider: {
    name: string;
    model: string;
    inputTokens?: number;
  };
};

function fileExtension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileKey(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function DocumentIcon({ extension }: { extension: string }) {
  return (
    <span className={`file-icon file-icon--${extension.slice(1) || "doc"}`}>
      {extension.slice(1).toUpperCase() || "DOC"}
    </span>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5V19h14v-4.5" />
    </svg>
  );
}

export default function App() {
  const [jobTitle, setJobTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [resumes, setResumes] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [step, setStep] = useState<"setup" | "research" | "compare">("setup");
  const [isResearching, setIsResearching] = useState(false);
  const [research, setResearch] = useState<CandidateResearch[]>([]);
  const [researchError, setResearchError] = useState("");
  const [excludedSources, setExcludedSources] = useState<Set<string>>(new Set());
  const [retryingSources, setRetryingSources] = useState<Set<string>>(new Set());
  const [confirmingSuggestions, setConfirmingSuggestions] = useState<Set<string>>(
    new Set(),
  );
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const [isScoring, setIsScoring] = useState(false);
  const [scoringError, setScoringError] = useState("");
  const [scores, setScores] = useState<CandidateScore[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (incoming: File[]) => {
    setResearch([]);
    const valid = incoming.filter((file) =>
      ALLOWED_EXTENSIONS.includes(fileExtension(file.name)),
    );
    const invalidCount = incoming.length - valid.length;
    const existingKeys = new Set(resumes.map(fileKey));
    const unique = valid.filter((file) => !existingKeys.has(fileKey(file)));
    const availableSlots = MAX_RESUMES - resumes.length;

    if (availableSlots <= 0) {
      setError(`You can upload up to ${MAX_RESUMES} resumes.`);
      return;
    }

    setResumes((current) => [...current, ...unique.slice(0, availableSlots)]);

    if (invalidCount > 0) {
      setError("Some files were skipped. Upload PDF, DOC, or DOCX files only.");
    } else if (unique.length > availableSlots) {
      setError(`Only the first ${MAX_RESUMES} resumes were added.`);
    } else if (unique.length < valid.length) {
      setError("Duplicate files were skipped.");
    } else {
      setError("");
    }
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  const openFilePicker = () => inputRef.current?.click();

  const handleDropzoneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openFilePicker();
    }
  };

  const removeResume = (key: string) => {
    setResumes((current) => current.filter((file) => fileKey(file) !== key));
    setResearch([]);
    setError("");
  };

  const canContinue =
    jobDescription.trim().length > 0 &&
    resumes.length > 0 &&
    !isResearching;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canContinue) return;
    setIsResearching(true);
    setStep("research");
    setResearch([]);
    setResearchError("");
    setExcludedSources(new Set());
    setConfirmingSuggestions(new Set());
    setSourceErrors({});

    const formData = new FormData();
    formData.set("jobTitle", jobTitle);
    formData.set("jobDescription", jobDescription);
    resumes.forEach((resume) => formData.append("resumes", resume));

    try {
      const response = await fetch("/api/research", {
        method: "POST",
        body: formData,
      });
      const body = (await response.json()) as {
        candidates?: CandidateResearch[];
        error?: string;
      };
      if (!response.ok || !body.candidates) {
        throw new Error(body.error ?? "Research could not be completed.");
      }
      setResearch(body.candidates);
    } catch (requestError) {
      setResearchError(
        requestError instanceof Error
          ? requestError.message
          : "Research could not be completed.",
      );
    } finally {
      setIsResearching(false);
    }
  };

  const sourceKey = (candidateIndex: number, sourceIndex: number) =>
    `${candidateIndex}:${sourceIndex}`;

  const toggleSourceExclusion = (
    candidateIndex: number,
    sourceIndex: number,
  ) => {
    const key = sourceKey(candidateIndex, sourceIndex);
    setExcludedSources((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const retrySource = async (
    candidateIndex: number,
    sourceIndex: number,
    sourceUrl: string,
  ) => {
    const key = sourceKey(candidateIndex, sourceIndex);
    const resume = resumes[candidateIndex];
    if (!resume) return;
    setRetryingSources((current) => new Set(current).add(key));
    setSourceErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });

    const formData = new FormData();
    formData.set("resume", resume);
    formData.set("jobDescription", jobDescription);
    formData.set("sourceUrl", sourceUrl);

    try {
      const response = await fetch("/api/research/source/retry", {
        method: "POST",
        body: formData,
      });
      const body = (await response.json()) as {
        source?: EvidenceSource;
        error?: string;
      };
      if (!response.ok || !body.source) {
        throw new Error(body.error ?? "Source retry failed.");
      }
      setResearch((current) =>
        current.map((candidate, currentCandidateIndex) =>
          currentCandidateIndex !== candidateIndex
            ? candidate
            : {
                ...candidate,
                sources: candidate.sources.map((source, currentSourceIndex) =>
                  currentSourceIndex === sourceIndex ? body.source! : source,
                ),
              },
        ),
      );
    } catch (retryError) {
      setSourceErrors((current) => ({
        ...current,
        [key]:
          retryError instanceof Error
            ? retryError.message
            : "Source retry failed.",
      }));
    } finally {
      setRetryingSources((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const confirmSuggestion = async (
    candidateIndex: number,
    suggestionIndex: number,
    sourceUrl: string,
  ) => {
    const key = `suggestion:${candidateIndex}:${suggestionIndex}`;
    const resume = resumes[candidateIndex];
    if (!resume) return;
    setConfirmingSuggestions((current) => new Set(current).add(key));
    setSourceErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });

    const formData = new FormData();
    formData.set("resume", resume);
    formData.set("jobDescription", jobDescription);
    formData.set("sourceUrl", sourceUrl);

    try {
      const response = await fetch("/api/research/source/confirm", {
        method: "POST",
        body: formData,
      });
      const body = (await response.json()) as {
        source?: EvidenceSource;
        error?: string;
      };
      if (!response.ok || !body.source) {
        throw new Error(body.error ?? "Source confirmation failed.");
      }
      setResearch((current) =>
        current.map((candidate, currentCandidateIndex) =>
          currentCandidateIndex !== candidateIndex
            ? candidate
            : {
                ...candidate,
                sources: [...candidate.sources, body.source!],
                suggestions: candidate.suggestions.filter(
                  (_, currentSuggestionIndex) =>
                    currentSuggestionIndex !== suggestionIndex,
                ),
              },
        ),
      );
    } catch (confirmationError) {
      setSourceErrors((current) => ({
        ...current,
        [key]:
          confirmationError instanceof Error
            ? confirmationError.message
            : "Source confirmation failed.",
      }));
    } finally {
      setConfirmingSuggestions((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const dismissSuggestion = (
    candidateIndex: number,
    suggestionIndex: number,
  ) => {
    setResearch((current) =>
      current.map((candidate, currentCandidateIndex) =>
        currentCandidateIndex !== candidateIndex
          ? candidate
          : {
              ...candidate,
              suggestions: candidate.suggestions.filter(
                (_, currentSuggestionIndex) =>
                  currentSuggestionIndex !== suggestionIndex,
              ),
            },
      ),
    );
  };

  const startScoring = async () => {
    setStep("compare");
    setIsScoring(true);
    setScoringError("");
    setScores([]);

    const externalEvidence = research.map((candidate, candidateIndex) => ({
      evidence: candidate.sources
        .filter(
          (source, sourceIndex) =>
            source.status === "retrieved" &&
            source.identityConfidence === "corroborated" &&
            !excludedSources.has(sourceKey(candidateIndex, sourceIndex)),
        )
        .flatMap((source) =>
          source.evidence.map((item) => ({
            claim: item.claim,
            sourceUrl: item.sourceUrl,
            sourceType: source.type,
          })),
        ),
    }));

    const formData = new FormData();
    formData.set("jobTitle", jobTitle);
    formData.set("jobDescription", jobDescription);
    formData.set("externalEvidence", JSON.stringify(externalEvidence));
    resumes.forEach((resume) => formData.append("resumes", resume));

    try {
      const response = await fetch("/api/score", {
        method: "POST",
        body: formData,
      });
      const body = (await response.json()) as {
        candidates?: CandidateScore[];
        error?: string;
      };
      if (!response.ok || !body.candidates) {
        throw new Error(body.error ?? "Candidate scoring failed.");
      }
      setScores(body.candidates);
    } catch (scoreError) {
      setScoringError(
        scoreError instanceof Error
          ? scoreError.message
          : "Candidate scoring failed.",
      );
    } finally {
      setIsScoring(false);
    }
  };

  const corroboratedCount = research.reduce(
    (total, candidate) =>
      total +
      candidate.sources.filter(
        (source) => source.identityConfidence === "corroborated",
      ).length,
    0,
  );
  const reviewCount = research.filter(
    (candidate) =>
      candidate.sources.length === 0 ||
      candidate.sources.some((source) =>
        ["likely", "ambiguous"].includes(source.identityConfidence),
      ),
  ).length;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div>
            <strong>Recruiting Decision Support</strong>
            <span>Local candidate evaluation workspace</span>
          </div>
        </div>
        <div className="workspace-status">
          <span className="status-dot" />
          Local workspace ready
        </div>
      </header>

      <aside className="sidebar">
        <p className="eyebrow">Evaluation flow</p>
        <nav aria-label="Evaluation progress">
          {["Setup", "Research", "Compare", "Review"].map((label, index) => (
            <div
              className={`nav-step ${
                index ===
                (step === "setup" ? 0 : step === "research" ? 1 : 2)
                  ? "nav-step--active"
                  : ""
              }`}
              key={label}
            >
              <span>{index + 1}</span>
              {label}
            </div>
          ))}
        </nav>
        <div className="sidebar-note">
          <span aria-hidden="true">ⓘ</span>
          Every final rejection requires human confirmation. Missing evidence
          always goes to review.
        </div>
      </aside>

      <main className="main">
        {step === "setup" ? (
          <>
        <div className="page-heading">
          <p className="eyebrow blue">Step 1 of 4</p>
          <h1>Evaluate candidates</h1>
          <p>
            Define the role and add the resumes you want to compare. Your files
            stay in this workspace.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="content-grid">
            <section className="card form-card">
              <div className="section-heading">
                <div>
                  <h2>Job details</h2>
                  <p>These requirements will guide the comparison.</p>
                </div>
                <span className="required-note">* Required</span>
              </div>

              <label htmlFor="job-title">Job title</label>
              <input
                id="job-title"
                type="text"
                value={jobTitle}
                onChange={(event) => {
                  setJobTitle(event.target.value);
                  setResearch([]);
                }}
                placeholder="e.g. Senior Backend Engineer"
                autoComplete="off"
              />

              <label htmlFor="job-description">
                Job description <span aria-hidden="true">*</span>
              </label>
              <textarea
                id="job-description"
                value={jobDescription}
                onChange={(event) => {
                  setJobDescription(event.target.value);
                  setResearch([]);
                }}
                placeholder="Paste the responsibilities, required skills, and experience for this role..."
                rows={8}
                required
              />
              <div className="field-meta">
                <span>Include must-have and nice-to-have qualifications.</span>
                <span>{jobDescription.length.toLocaleString()} characters</span>
              </div>
            </section>

            <section className="card upload-card">
              <div className="section-heading">
                <div>
                  <h2>Candidate resumes</h2>
                  <p>Add between 1 and {MAX_RESUMES} candidate files.</p>
                </div>
                <span className="file-count">
                  {resumes.length} / {MAX_RESUMES}
                </span>
              </div>

              <input
                ref={inputRef}
                className="visually-hidden"
                type="file"
                accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                multiple
                onChange={handleFileInput}
                tabIndex={-1}
              />
              <div
                className={`dropzone ${isDragging ? "dropzone--active" : ""}`}
                onClick={openFilePicker}
                onKeyDown={handleDropzoneKeyDown}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                    setIsDragging(false);
                  }
                }}
                onDrop={handleDrop}
                role="button"
                tabIndex={0}
                aria-label="Upload candidate resumes"
              >
                <div className="upload-icon">
                  <UploadIcon />
                </div>
                <strong>Drop resumes here or choose files</strong>
                <span>PDF, DOC, or DOCX · up to {MAX_RESUMES} files</span>
              </div>

              {error && (
                <p className="upload-error" role="alert">
                  {error}
                </p>
              )}

              {resumes.length > 0 && (
                <div className="file-list" aria-label="Uploaded resumes">
                  {resumes.map((file) => {
                    const extension = fileExtension(file.name);
                    const key = fileKey(file);
                    return (
                      <div className="file-row" key={key}>
                        <DocumentIcon extension={extension} />
                        <div className="file-details">
                          <strong>{file.name}</strong>
                          <span>{formatBytes(file.size)} · Ready</span>
                        </div>
                        <button
                          type="button"
                          className="remove-button"
                          onClick={() => removeResume(key)}
                          aria-label={`Remove ${file.name}`}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

          <section className="action-panel">
            <div>
              <h2>Ready to continue?</h2>
              <p>
                Add a job description and at least one resume. You can review
                everything before any analysis begins.
              </p>
            </div>
            <button className="primary-button" type="submit" disabled={!canContinue}>
              Parse and research
              <span aria-hidden="true">→</span>
            </button>
          </section>
        </form>
          </>
        ) : step === "research" ? (
          <section className="research-view" aria-live="polite">
            <div className="research-toolbar">
              <div className="page-heading">
                <p className="eyebrow blue">Step 2 of 4</p>
                <h1>Professional evidence</h1>
                <p>
                  Resume-attributed sources only. Ambiguous identities are
                  excluded from fit evidence.
                </p>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setStep("setup")}
                disabled={isResearching}
              >
                ← Edit setup
              </button>
            </div>

            {isResearching ? (
              <div className="research-loading card" role="status">
                <span className="spinner" aria-hidden="true" />
                <div>
                  <h2>Checking candidate evidence</h2>
                  <p>
                    Parsing resumes, extracting attributed links, and checking
                    public professional sources.
                  </p>
                </div>
              </div>
            ) : researchError ? (
              <div className="research-loading card" role="alert">
                <div>
                  <h2>Research could not be completed</h2>
                  <p>{researchError}</p>
                </div>
              </div>
            ) : (
              <>
                <div className="summary-grid">
                  <div className="summary-card">
                    <strong>{research.length}</strong>
                    <span>Candidates parsed</span>
                  </div>
                  <div className="summary-card">
                    <strong>{corroboratedCount}</strong>
                    <span>Corroborated sources</span>
                  </div>
                  <div className="summary-card">
                    <strong>{reviewCount}</strong>
                    <span>Need human review</span>
                  </div>
                </div>

                <div className="candidate-results">
                  {research.map((candidate, candidateIndex) => (
                    <article className="candidate-card" key={candidate.resumeName}>
                      <div className="candidate-heading">
                        <div>
                          <p className="candidate-file">{candidate.resumeName}</p>
                          <h2>{candidate.candidateName}</h2>
                          <p>
                            {candidate.extractedUrls.length > 0
                              ? `${candidate.extractedUrls.length} candidate-provided ${
                                  candidate.extractedUrls.length === 1
                                    ? "source"
                                    : "sources"
                                } found.`
                              : "No professional URLs were found. No broad name search was performed."}
                          </p>
                          {candidate.resumeLocation && (
                            <p>
                              Resume location signal: {candidate.resumeLocation}
                            </p>
                          )}
                        </div>
                        <span className="status-pill status-pill--parsed">
                          Resume parsed
                        </span>
                      </div>

                      {candidate.sources.length > 0 ? (
                        <div className="source-list">
                          {candidate.sources.map((source, sourceIndex) => {
                            const key = sourceKey(candidateIndex, sourceIndex);
                            const isExcluded = excludedSources.has(key);
                            const isRetrying = retryingSources.has(key);
                            return (
                            <div
                              className={`source-row ${
                                isExcluded ? "source-row--excluded" : ""
                              }`}
                              key={source.url}
                            >
                              <div className={`source-mark source-mark--${source.type}`}>
                                {SOURCE_LABELS[source.type].slice(0, 2)}
                              </div>
                              <div className="source-content">
                                <div className="source-title">
                                  <strong>{SOURCE_LABELS[source.type]}</strong>
                                  <span
                                    className={`identity-badge identity-badge--${
                                      isExcluded
                                        ? "excluded"
                                        : source.identityConfidence
                                    }`}
                                  >
                                    {isExcluded
                                      ? "excluded"
                                      : source.identityConfidence}
                                  </span>
                                </div>
                                <a
                                  href={source.url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {source.url}
                                </a>
                                <p>
                                  {isExcluded
                                    ? "Excluded by the reviewer from candidate comparison."
                                    : source.message ??
                                      source.identitySignals.join(" · ")}
                                </p>
                                {!isExcluded && source.evidence.length > 0 && (
                                  <div className="evidence-list">
                                    <span>Job-relevant evidence</span>
                                    {source.evidence.map((item) => (
                                      <p key={item.claim}>{item.claim}</p>
                                    ))}
                                  </div>
                                )}
                                <small>
                                  Retrieved via {source.provenance.adapter} ·{" "}
                                  {new Date(
                                    source.provenance.retrievedAt,
                                  ).toLocaleString()}
                                </small>
                                {sourceErrors[key] && (
                                  <p className="source-error" role="alert">
                                    {sourceErrors[key]}
                                  </p>
                                )}
                                <div className="source-actions">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      retrySource(
                                        candidateIndex,
                                        sourceIndex,
                                        source.url,
                                      )
                                    }
                                    disabled={isRetrying}
                                  >
                                    {isRetrying ? "Retrying…" : "Retry source"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      toggleSourceExclusion(
                                        candidateIndex,
                                        sourceIndex,
                                      )
                                    }
                                  >
                                    {isExcluded ? "Include source" : "Exclude source"}
                                  </button>
                                </div>
                              </div>
                            </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="empty-evidence">
                          <strong>No usable online evidence</strong>
                          <p>
                            This is not negative evidence. Evaluate the resume
                            directly and keep the candidate in human review.
                          </p>
                        </div>
                      )}

                      {(candidate.suggestions?.length ?? 0) > 0 && (
                        <div className="suggestion-list">
                          <div className="suggestion-heading">
                            <strong>Possible professional sources</strong>
                            <span>Confirm before evidence is retrieved</span>
                          </div>
                          {(candidate.suggestions ?? []).map(
                            (suggestion, suggestionIndex) => {
                              const key = `suggestion:${candidateIndex}:${suggestionIndex}`;
                              const isConfirming =
                                confirmingSuggestions.has(key);
                              return (
                                <div className="suggestion-row" key={suggestion.url}>
                                  <div
                                    className={`source-mark source-mark--${suggestion.type}`}
                                  >
                                    {SOURCE_LABELS[suggestion.type].slice(0, 2)}
                                  </div>
                                  <div className="source-content">
                                    <div className="source-title">
                                      <strong>{suggestion.title}</strong>
                                      <span
                                        className={`identity-badge identity-badge--${suggestion.identityConfidence}`}
                                      >
                                        possible match
                                      </span>
                                    </div>
                                    <a
                                      href={suggestion.url}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      {suggestion.url}
                                    </a>
                                    <p>{suggestion.identitySignals.join(" · ")}</p>
                                    <small>
                                      Found via{" "}
                                      {suggestion.discoveredVia ===
                                      "github-user-search"
                                        ? "GitHub user search"
                                        : "matched GitHub profile"}
                                    </small>
                                    {sourceErrors[key] && (
                                      <p className="source-error" role="alert">
                                        {sourceErrors[key]}
                                      </p>
                                    )}
                                    <div className="source-actions">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          confirmSuggestion(
                                            candidateIndex,
                                            suggestionIndex,
                                            suggestion.url,
                                          )
                                        }
                                        disabled={isConfirming}
                                      >
                                        {isConfirming
                                          ? "Checking…"
                                          : "Confirm and research"}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          dismissSuggestion(
                                            candidateIndex,
                                            suggestionIndex,
                                          )
                                        }
                                        disabled={isConfirming}
                                      >
                                        Dismiss
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              );
                            },
                          )}
                        </div>
                      )}
                    </article>
                  ))}
                </div>

                <div className="safety-banner">
                  <span>ⓘ</span>
                  <p>
                    This step verifies professional evidence; it does not make
                    an employment decision. Personal or protected information
                    must not be scored.
                  </p>
                </div>

                <section className="action-panel">
                  <div>
                    <h2>Compare against the role</h2>
                    <p>
                      Resume evidence supplies up to 90 points. Corroborated
                      professional evidence can add at most 10 points.
                    </p>
                  </div>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={startScoring}
                  >
                    Score candidates
                    <span aria-hidden="true">→</span>
                  </button>
                </section>
              </>
            )}
          </section>
        ) : (
          <section className="compare-view" aria-live="polite">
            <div className="research-toolbar">
              <div className="page-heading">
                <p className="eyebrow blue">Step 3 of 4</p>
                <h1>Candidate comparison</h1>
                <p>
                  Job-relevant evidence scored against a fixed rubric. Every
                  recommendation remains subject to recruiter review.
                </p>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setStep("research")}
                disabled={isScoring}
              >
                ← Review sources
              </button>
            </div>

            {isScoring ? (
              <div className="research-loading card" role="status">
                <span className="spinner" aria-hidden="true" />
                <div>
                  <h2>Scoring candidate evidence</h2>
                  <p>
                    Applying the same typed rubric to each resume and its
                    corroborated evidence.
                  </p>
                </div>
              </div>
            ) : scoringError ? (
              <div className="scoring-error card" role="alert">
                <h2>Scoring is not available</h2>
                <p>{scoringError}</p>
                {scoringError.includes("TYPESAFE_API_KEY") && (
                  <code>TYPESAFE_API_KEY=your_key</code>
                )}
              </div>
            ) : (
              <>
                <div className="summary-grid">
                  <div className="summary-card">
                    <strong>{scores.length}</strong>
                    <span>Candidates scored</span>
                  </div>
                  <div className="summary-card">
                    <strong>
                      {
                        scores.filter((candidate) => candidate.route === "advance")
                          .length
                      }
                    </strong>
                    <span>Recommended to advance</span>
                  </div>
                  <div className="summary-card">
                    <strong>
                      {
                        scores.filter((candidate) => candidate.route === "review")
                          .length
                      }
                    </strong>
                    <span>Need human review</span>
                  </div>
                </div>

                <div className="score-results">
                  {scores
                    .slice()
                    .sort((left, right) => right.total - left.total)
                    .map((candidate, candidateIndex) => (
                      <article
                        className="score-card"
                        key={`${candidate.candidateName}-${candidateIndex}`}
                      >
                        <div className="score-card-heading">
                          <div>
                            <p className="candidate-file">
                              Evidence-based recommendation
                            </p>
                            <h2>{candidate.candidateName}</h2>
                            <p>
                              {candidate.corePoints}/90 resume · +
                              {candidate.externalBonus}/10 external evidence
                            </p>
                          </div>
                          <div className="total-score">
                            <strong>{candidate.total}</strong>
                            <span>/ 100</span>
                            <b className={`route-badge route-badge--${candidate.route}`}>
                              {candidate.route === "advance"
                                ? "Advance"
                                : "Human review"}
                            </b>
                          </div>
                        </div>

                        <div className="score-progress" aria-hidden="true">
                          <span style={{ width: `${candidate.total}%` }} />
                        </div>

                        <div className="criteria-list">
                          {candidate.criteria.map((criterion) => (
                            <section className="criterion-row" key={criterion.id}>
                              <div className="criterion-summary">
                                <div>
                                  <strong>{criterion.label}</strong>
                                  <span>{criterion.level}</span>
                                </div>
                                <div className="criterion-points">
                                  {criterion.points} / {criterion.maxPoints}
                                </div>
                              </div>
                              <div className="criterion-confidence">
                                Confidence{" "}
                                {Math.round(criterion.confidence * 100)}%
                              </div>
                              {criterion.evidence.length > 0 && (
                                <div className="criterion-evidence">
                                  {criterion.evidence.map((item, evidenceIndex) => (
                                    <p key={`${item.text}-${evidenceIndex}`}>
                                      “{item.text}”
                                      {item.sourceUrl && (
                                        <a
                                          href={item.sourceUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                        >
                                          Source
                                        </a>
                                      )}
                                    </p>
                                  ))}
                                </div>
                              )}
                            </section>
                          ))}
                        </div>

                        {candidate.flags.length > 0 && (
                          <div className="score-flags">
                            {candidate.flags.map((flag) => (
                              <p key={flag}>ⓘ {flag}</p>
                            ))}
                          </div>
                        )}
                        <small className="provider-note">
                          Scored by {candidate.provider.model}
                          {candidate.provider.inputTokens
                            ? ` · ${candidate.provider.inputTokens.toLocaleString()} input tokens`
                            : ""}
                        </small>
                      </article>
                    ))}
                </div>

                <div className="safety-banner">
                  <span>ⓘ</span>
                  <p>
                    Scores organize evidence; they are not employment
                    decisions. No candidate is automatically rejected.
                  </p>
                </div>
              </>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
