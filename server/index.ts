import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import { createServer as createViteServer } from "vite";
import {
  confirmCandidateSource,
  extractResumeLocation,
  inferCandidateName,
  parseResume,
  researchCandidates,
  retryCandidateSource,
} from "./research.js";
import {
  ExternalEvidence,
  JevScoringProvider,
  scoreCandidate,
} from "./scoring.js";

const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? "127.0.0.1";
const isProduction = process.env.NODE_ENV === "production";
const app = express();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 20,
    fileSize: 10 * 1024 * 1024,
    fields: 4,
  },
  fileFilter: (_request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, [".pdf", ".doc", ".docx"].includes(extension));
  },
});

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.post(
  "/api/research",
  upload.array("resumes", 20),
  async (request, response, next) => {
    try {
      const files = (request.files ?? []) as Express.Multer.File[];
      const jobDescription =
        typeof request.body?.jobDescription === "string"
          ? request.body.jobDescription.trim()
          : "";

      if (!jobDescription) {
        response.status(400).json({ error: "A job description is required." });
        return;
      }
      if (jobDescription.length > 50_000) {
        response.status(400).json({ error: "The job description is too long." });
        return;
      }
      if (!files.length) {
        response.status(400).json({ error: "Add at least one supported resume." });
        return;
      }

      const candidates = await researchCandidates(files, jobDescription);
      response.json({
        candidates,
        policy: {
          discovery: "candidate-provided-urls-only",
          ambiguousSources: "excluded",
          missingSourcesAffectScore: false,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/research/source/retry",
  upload.single("resume"),
  async (request, response, next) => {
    try {
      const jobDescription =
        typeof request.body?.jobDescription === "string"
          ? request.body.jobDescription.trim()
          : "";
      const sourceUrl =
        typeof request.body?.sourceUrl === "string"
          ? request.body.sourceUrl.trim()
          : "";
      if (!request.file || !jobDescription || !sourceUrl) {
        response.status(400).json({
          error: "The resume, job description, and source URL are required.",
        });
        return;
      }

      const result = await retryCandidateSource(
        request.file,
        jobDescription,
        sourceUrl,
      );
      response.json(result);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "The requested source was not found in this resume."
      ) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  },
);

app.post(
  "/api/research/source/confirm",
  upload.single("resume"),
  async (request, response, next) => {
    try {
      const jobDescription =
        typeof request.body?.jobDescription === "string"
          ? request.body.jobDescription.trim()
          : "";
      const sourceUrl =
        typeof request.body?.sourceUrl === "string"
          ? request.body.sourceUrl.trim()
          : "";
      if (!request.file || !jobDescription || !sourceUrl) {
        response.status(400).json({
          error: "The resume, job description, and source URL are required.",
        });
        return;
      }

      const result = await confirmCandidateSource(
        request.file,
        jobDescription,
        sourceUrl,
      );
      response.json(result);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          "The requested source is not a current discovery suggestion."
      ) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  },
);

app.post(
  "/api/score",
  upload.array("resumes", 20),
  async (request, response, next) => {
    try {
      const files = (request.files ?? []) as Express.Multer.File[];
      const jobTitle =
        typeof request.body?.jobTitle === "string"
          ? request.body.jobTitle.trim()
          : "";
      const jobDescription =
        typeof request.body?.jobDescription === "string"
          ? request.body.jobDescription.trim()
          : "";
      const apiKey =
        process.env.TYPESAFE_API_KEY?.trim() || process.env.JEV_API_KEY?.trim();

      if (!apiKey) {
        response.status(503).json({
          error:
            "Scoring is not configured. Add TYPESAFE_API_KEY to the local environment.",
          code: "SCORING_NOT_CONFIGURED",
        });
        return;
      }
      if (!files.length || !jobDescription) {
        response.status(400).json({
          error: "At least one resume and a job description are required.",
        });
        return;
      }

      let submittedEvidence: Array<{ evidence?: ExternalEvidence[] }> = [];
      if (typeof request.body?.externalEvidence === "string") {
        try {
          const parsed = JSON.parse(request.body.externalEvidence) as unknown;
          if (Array.isArray(parsed)) submittedEvidence = parsed;
        } catch {
          response.status(400).json({ error: "External evidence is malformed." });
          return;
        }
      }

      const provider = new JevScoringProvider(apiKey);
      const candidates = await Promise.all(
        files.map(async (file, index) => {
          const parsed = await parseResume(file);
          const candidateName = inferCandidateName(parsed.text);
          const candidateLocation = extractResumeLocation(parsed.text);
          const evidence = (submittedEvidence[index]?.evidence ?? [])
            .filter(
              (item) =>
                item &&
                typeof item.claim === "string" &&
                item.claim.length <= 500 &&
                typeof item.sourceUrl === "string" &&
                item.sourceUrl.startsWith("https://") &&
                ["github", "linkedin", "portfolio"].includes(item.sourceType),
            )
            .slice(0, 30);
          return scoreCandidate(provider, {
            candidateName,
            candidateLocation,
            resumeText: parsed.text,
            jobTitle,
            jobDescription,
            externalEvidence: evidence,
          });
        }),
      );

      response.json({
        candidates,
        policy: {
          coreMaximum: 90,
          externalBonusMaximum: 10,
          missingExternalEvidencePenalty: 0,
          automaticRejection: false,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

app.use(
  (
    error: Error & { code?: string },
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    if (error instanceof multer.MulterError) {
      response.status(400).json({
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? "Each resume must be 10 MB or smaller."
            : "The uploaded files could not be accepted.",
      });
      return;
    }
    console.error(error);
    response.status(500).json({
      error: "Research could not be completed. No candidate outcome was created.",
    });
  },
);

if (isProduction) {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (_request, response) => {
    response.sendFile(path.join(root, "dist", "index.html"));
  });
} else {
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

app.listen(PORT, HOST, () => {
  console.log(`Recruiting Decision Support running at http://${HOST}:${PORT}`);
});
