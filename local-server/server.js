/**
 * TexLocal local server
 * - Stores projects on disk under ~/TexLocalProjects/<projectId>/
 * - Compiles with a usable local TeX engine (`latexmk` when available with Perl, otherwise `pdflatex`)
 * - Exposes a small REST API consumed by the React UI
 *
 * No Docker. No cloud. Just Node + your local TeX distribution (TeX Live / MiKTeX).
 */

const express = require("express");
const AdmZip = require("adm-zip");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs/promises");
const multer = require("multer");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

const SERVER_DIR = __dirname;
const ENV_FILE = path.join(SERVER_DIR, ".env");
const DEFAULT_ROOT = path.join(os.homedir(), "TexLocalProjects");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] != null) continue;

    let value = rawValue.trim();
    const quoted =
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"));

    if (quoted) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }

    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

function expandHomeDirectory(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function resolveConfiguredPath(value, fallback) {
  const configured = expandHomeDirectory(String(value || "").trim());
  if (!configured) return fallback;
  return path.isAbsolute(configured) ? configured : path.resolve(SERVER_DIR, configured);
}

loadDotEnv(ENV_FILE);

const PORT = process.env.PORT || 3001;
const ROOT = resolveConfiguredPath(process.env.TEXLOCAL_ROOT, DEFAULT_ROOT);

fs.mkdirSync(ROOT, { recursive: true });

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.text({ limit: "5mb", type: "text/plain" }));

// ---- helpers ----
const META = (id) => path.join(ROOT, id, ".texlocal.json");
const PROJ = (id) => path.join(ROOT, id);
const PROJECT_STATUSES = new Set(["active", "archived", "trashed"]);

const sanitizeId = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");

const normalizeRelativePath = (value) =>
  String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();

function ensureInside(projectDir, target) {
  const abs = path.resolve(projectDir, target);
  if (!abs.startsWith(path.resolve(projectDir) + path.sep) && abs !== path.resolve(projectDir)) {
    throw new Error("Path escape rejected");
  }
  return abs;
}

function normalizeMeta(meta = {}, id = "") {
  return {
    id: String(meta.id || id),
    title: String(meta.title || id || "untitled"),
    owner: String(meta.owner || "You"),
    mainFile:
      meta.mainFile == null
        ? "main.tex"
        : normalizeRelativePath(meta.mainFile),
    updatedAt: meta.updatedAt || new Date().toISOString(),
    status: PROJECT_STATUSES.has(meta.status) ? meta.status : "active",
  };
}

function getProjectTitle(value, fallback = "untitled") {
  const title = String(value || fallback).trim();
  return title || fallback;
}

function createProjectId(title) {
  return sanitizeId(title || "untitled") + "-" + Date.now().toString(36);
}

async function readMeta(id) {
  const raw = await fsp.readFile(META(id), "utf8");
  return normalizeMeta(JSON.parse(raw), id);
}
async function writeMeta(id, meta) {
  await fsp.writeFile(META(id), JSON.stringify(normalizeMeta(meta, id), null, 2));
}

async function createBlankProject(title) {
  const projectTitle = getProjectTitle(title);
  const id = createProjectId(projectTitle);
  await fsp.mkdir(PROJ(id), { recursive: true });

  const meta = normalizeMeta({
    id,
    title: projectTitle,
    owner: "You",
    mainFile: "main.tex",
    status: "active",
    updatedAt: new Date().toISOString(),
  }, id);

  await writeMeta(id, meta);
  await fsp.writeFile(
    path.join(PROJ(id), "main.tex"),
    `\\documentclass{article}\n\\title{${projectTitle}}\n\\author{You}\n\\begin{document}\n\\maketitle\nWrite your content here.\n\\end{document}\n`
  );

  return meta;
}

function normalizeZipEntryPath(value) {
  return normalizeRelativePath(value).replace(/\/+/g, "/");
}

const GENERATED_ARTIFACT_RE = /\.(aux|log|out|toc|fls|fdb_latexmk|synctex\.gz)$/i;

function isGeneratedBuildArtifactPath(relativePath = "") {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return false;
  return GENERATED_ARTIFACT_RE.test(path.posix.basename(normalized));
}

async function cleanGeneratedArtifactsForMain(projDir, mainFile) {
  if (!mainFile) return;

  const normalizedMain = normalizeRelativePath(mainFile);
  if (!normalizedMain) return;

  const mainDir = path.posix.dirname(normalizedMain);
  const stem = path.posix.basename(normalizedMain, path.posix.extname(normalizedMain));
  const absDir = mainDir === "." ? projDir : ensureInside(projDir, mainDir);

  const artifacts = [
    `${stem}.aux`,
    `${stem}.log`,
    `${stem}.out`,
    `${stem}.toc`,
    `${stem}.fls`,
    `${stem}.fdb_latexmk`,
    `${stem}.synctex.gz`,
  ];

  await Promise.all(
    artifacts.map((name) =>
      fsp.rm(path.join(absDir, name), { force: true }).catch(() => {})
    )
  );
}

function shouldSkipZipEntry(relativePath) {
  return (
    !relativePath ||
    relativePath.startsWith("__MACOSX/") ||
    /(^|\/)\.DS_Store$/i.test(relativePath) ||
    /(^|\/)\.git(\/|$)/i.test(relativePath) ||
    isGeneratedBuildArtifactPath(relativePath)
  );
}

function findSharedZipRoot(paths) {
  if (paths.length === 0) return null;
  const firstSegments = paths.map((entry) => entry.split("/")[0]).filter(Boolean);
  if (firstSegments.length !== paths.length) return null;
  const root = firstSegments[0];
  if (!root) return null;
  return firstSegments.every((segment) => segment === root) ? root : null;
}

async function importZipProject(file, title) {
  const fallbackTitle = path.basename(file.originalname || "import", path.extname(file.originalname || "import"));
  const projectTitle = getProjectTitle(title, fallbackTitle);
  const id = createProjectId(projectTitle);
  const projectDir = PROJ(id);

  await fsp.mkdir(projectDir, { recursive: true });

  try {
    const zip = new AdmZip(file.buffer);
    const rawEntries = zip
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => ({
        entry,
        relativePath: normalizeZipEntryPath(entry.entryName),
      }))
      .filter(({ relativePath }) => !shouldSkipZipEntry(relativePath));

    if (rawEntries.length === 0) {
      throw new Error("The ZIP archive is empty.");
    }

    const sharedRoot = findSharedZipRoot(rawEntries.map(({ relativePath }) => relativePath));

    for (const { entry, relativePath } of rawEntries) {
      const strippedPath =
        sharedRoot && relativePath.startsWith(`${sharedRoot}/`)
          ? relativePath.slice(sharedRoot.length + 1)
          : relativePath;

      const targetPath = normalizeRelativePath(strippedPath);
      if (!targetPath) continue;

      const abs = ensureInside(projectDir, targetPath);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, entry.getData());
    }

    const texFiles = await listTexFiles(id);
    if (texFiles.length === 0) {
      throw new Error("The ZIP archive must contain at least one .tex file.");
    }

    const mainFile = await resolveMainFileFallback(id);

    const meta = normalizeMeta({
      id,
      title: projectTitle,
      owner: "You",
      mainFile: mainFile || "",
      status: "active",
      updatedAt: new Date().toISOString(),
    }, id);

    await writeMeta(id, meta);
    return meta;
  } catch (error) {
    await fsp.rm(projectDir, { recursive: true, force: true });
    throw error;
  }
}

async function listTexFiles(id) {
  const files = await listProjectFilesFlat(PROJ(id));
  return files
    .filter((entry) => entry.type === "file" && /\.tex$/i.test(entry.path))
    .map((entry) => entry.path)
    .sort();
}

async function resolveMainFileFallback(id, preferred = null) {
  const texFiles = await listTexFiles(id);
  if (preferred && texFiles.includes(preferred)) return preferred;
  if (texFiles.includes("main.tex")) return "main.tex";
  return texFiles.length === 1 ? texFiles[0] : null;
}

function compareTreeEntries(a, b) {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" });
}

async function listProjectFilesFlat(dir, base = "") {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });

  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (isGeneratedBuildArtifactPath(e.name)) continue;

    const rel = base ? `${base}/${e.name}` : e.name;

    if (e.isDirectory()) {
      out.push(...(await listProjectFilesFlat(path.join(dir, e.name), rel)));
    } else if (!isGeneratedBuildArtifactPath(e.name)) {
      out.push({ path: rel, type: "file" });
    }
  }

  return out;
}

async function listProjectTree(dir, base = "") {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });

  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (isGeneratedBuildArtifactPath(e.name)) continue;

    const rel = base ? `${base}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);

    if (e.isDirectory()) {
      const children = await listProjectTree(abs, rel);
      out.push({ path: rel, type: "dir", children });
      continue;
    }

    if (!isGeneratedBuildArtifactPath(e.name)) {
      out.push({ path: rel, type: "file" });
    }
  }

  out.sort(compareTreeEntries);
  return out;
}

async function createProjectArchiveBuffer(id) {
  const projectDir = PROJ(id);
  const files = await listProjectFilesFlat(projectDir);
  const zip = new AdmZip();

  for (const entry of files) {
    if (entry.type !== "file") continue;
    const abs = ensureInside(projectDir, entry.path);
    zip.addFile(entry.path, await fsp.readFile(abs));
  }

  return zip.toBuffer();
}

// ---- routes ----
app.get("/api/health", (_req, res) => {
  const compiler = resolveCompiler();
  res.json({
    ok: true,
    storageRoot: ROOT,
    compiler: compiler ? compiler.label : null,
  });
});

app.get("/api/projects", async (_req, res) => {
  const ids = await fsp.readdir(ROOT);
  const list = [];
  for (const id of ids) {
    try {
      const meta = await readMeta(id);
      const stat = await fsp.stat(PROJ(id));
      list.push({ ...meta, updatedAt: stat.mtime.toISOString() });
    } catch {}
  }
  list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json(list);
});

app.post("/api/projects", async (req, res) => {
  const meta = await createBlankProject(req.body?.title);
  res.json(meta);
});

app.post("/api/projects/import", upload.single("zip"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("ZIP file is required");
    if (!/\.zip$/i.test(req.file.originalname || "")) {
      return res.status(400).send("Only .zip imports are supported");
    }

    const meta = await importZipProject(req.file, req.body?.title);
    res.json(meta);
  } catch (e) {
    res.status(400).send(String(e.message || e));
  }
});

app.delete("/api/projects/:id", async (req, res) => {
  await fsp.rm(PROJ(req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
});

app.patch("/api/projects/:id", async (req, res) => {
  try {
    const current = await readMeta(req.params.id);
    const next = { ...current };

    if (typeof req.body?.title === "string") {
      const title = req.body.title.trim();
      if (!title) return res.status(400).send("Project title is required");
      next.title = title;
    }

    if (typeof req.body?.mainFile === "string") {
      const mainFile = normalizeRelativePath(req.body.mainFile);
      if (!mainFile) return res.status(400).send("Main file is required");
      if (!/\.tex$/i.test(mainFile)) return res.status(400).send("Main file must end with .tex");

      const abs = ensureInside(PROJ(req.params.id), mainFile);
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) return res.status(400).send("Main file must be a file");
      next.mainFile = mainFile;
    }

    if (typeof req.body?.status === "string") {
      if (!PROJECT_STATUSES.has(req.body.status)) {
        return res.status(400).send("Invalid project status");
      }
      next.status = req.body.status;
    }

    next.updatedAt = new Date().toISOString();
    await writeMeta(req.params.id, next);
    res.json(next);
  } catch (e) {
    res.status(400).send(String(e));
  }
});

app.get("/api/projects/:id", async (req, res) => {
  try {
    const meta = await readMeta(req.params.id);
    const tree = await listProjectTree(PROJ(req.params.id));
    res.json({ project: meta, tree });
  } catch (e) {
    res.status(404).send(String(e));
  }
});

app.get("/api/projects/:id/archive", async (req, res) => {
  try {
    const meta = await readMeta(req.params.id);
    const zipBuffer = await createProjectArchiveBuffer(req.params.id);
    const safeName = sanitizeId(meta.title) || meta.id;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.zip"`);
    res.send(zipBuffer);
  } catch (e) {
    res.status(404).send(String(e));
  }
});

app.get("/api/projects/:id/file", async (req, res) => {
  try {
    const abs = ensureInside(PROJ(req.params.id), normalizeRelativePath(req.query.path));
    res.type("text/plain").send(await fsp.readFile(abs, "utf8"));
  } catch (e) {
    res.status(400).send(String(e));
  }
});

app.post("/api/projects/:id/folder", async (req, res) => {
  try {
    const rel = normalizeRelativePath(req.query.path);
    if (!rel) return res.status(400).send("Folder path is required");
    const abs = ensureInside(PROJ(req.params.id), rel);
    await fsp.mkdir(abs, { recursive: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).send(String(e));
  }
});

app.put("/api/projects/:id/file", async (req, res) => {
  try {
    const abs = ensureInside(PROJ(req.params.id), normalizeRelativePath(req.query.path));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, typeof req.body === "string" ? req.body : "");
    res.json({ ok: true });
  } catch (e) {
    res.status(400).send(String(e));
  }
});

app.post("/api/projects/:id/file", async (req, res) => {
  try {
    const abs = ensureInside(PROJ(req.params.id), normalizeRelativePath(req.query.path));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) await fsp.writeFile(abs, "");
    res.json({ ok: true });
  } catch (e) {
    res.status(400).send(String(e));
  }
});

app.post("/api/projects/:id/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("File is required");

    const folderPath = normalizeRelativePath(req.query.path);
    const fileName = path.basename(req.file.originalname || "upload");
    const relativePath = normalizeRelativePath(folderPath ? `${folderPath}/${fileName}` : fileName);
    const abs = ensureInside(PROJ(req.params.id), relativePath);

    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, req.file.buffer);
    res.json({ ok: true, path: relativePath });
  } catch (e) {
    res.status(400).send(String(e));
  }
});

app.delete("/api/projects/:id/file", async (req, res) => {
  try {
    const rel = normalizeRelativePath(req.query.path);
    const abs = ensureInside(PROJ(req.params.id), rel);

    let stat = null;
    try {
      stat = await fsp.stat(abs);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return res.json({ ok: true });
      }
      throw error;
    }

    await fsp.rm(abs, { recursive: stat.isDirectory(), force: true });

    const meta = await readMeta(req.params.id);
    const deletedMain =
      rel === meta.mainFile || (meta.mainFile && meta.mainFile.startsWith(`${rel}/`));

    if (deletedMain) {
      const fallback = await resolveMainFileFallback(req.params.id);
      await writeMeta(req.params.id, {
        ...meta,
        mainFile: fallback || "",
        updatedAt: new Date().toISOString(),
      });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(400).send(String(e));
  }
});

app.post("/api/projects/:id/rename", async (req, res) => {
  try {
    const from = normalizeRelativePath(req.body?.from);
    const to = normalizeRelativePath(req.body?.to);
    const projDir = PROJ(req.params.id);
    const src = ensureInside(projDir, from);
    const dst = ensureInside(projDir, to);

    let stat = null;
    try {
      stat = await fsp.stat(src);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return res.status(400).send("Source path not found");
      }
      throw error;
    }

    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.rename(src, dst);

    const meta = await readMeta(req.params.id);
    let nextMainFile = meta.mainFile;

    if (meta.mainFile === from) {
      nextMainFile = to;
    } else if (stat.isDirectory() && meta.mainFile?.startsWith(`${from}/`)) {
      nextMainFile = `${to}${meta.mainFile.slice(from.length)}`;
    }

    if (nextMainFile !== meta.mainFile) {
      await writeMeta(req.params.id, {
        ...meta,
        mainFile: nextMainFile,
        updatedAt: new Date().toISOString(),
      });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(400).send(String(e));
  }
});

// ---- compile ----
function which(cmd) {
  try {
    execSync(process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`, {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function resolveCompiler() {
  const hasLatexmk = which("latexmk");
  const hasPerl = which("perl");

  if (hasLatexmk && (process.platform !== "win32" || hasPerl)) {
    return {
      cmd: "latexmk",
      args: ["-pdf", "-cd", "-CF", "-interaction=nonstopmode", "-halt-on-error"],
      passes: 1,
      label: "latexmk",
    };
  }

  if (which("pdflatex")) {
    return {
      cmd: "pdflatex",
      args: ["-interaction=nonstopmode", "-halt-on-error"],
      passes: 2,
      label:
        hasLatexmk && !hasPerl && process.platform === "win32"
          ? "pdflatex (fallback: perl missing for latexmk)"
          : "pdflatex",
    };
  }

  return null;
}

function runCommand(projDir, cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: projDir });
    let log = `$ ${cmd} ${args.join(" ")}\n`;
    child.stdout.on("data", (d) => (log += d.toString()));
    child.stderr.on("data", (d) => (log += d.toString()));
    child.on("close", (code) => resolve({ code, log }));
    child.on("error", (error) => resolve({ code: 1, log: `${log}\n${String(error)}\n` }));
  });
}

function extractCompileLocation(log, mainFile) {
  const lineMatches = Array.from(log.matchAll(/\bl\.(\d+)\b/g));
  const sourceMatches = Array.from(log.matchAll(/\(([^()\r\n]+\.tex)\b/g))
    .map((match) => match[1].replace(/\\/g, "/"));

  const projectSource = sourceMatches
    .filter((value) => !/^[A-Za-z]:\//.test(value))
    .at(-1);

  return {
    sourcePath: projectSource || mainFile,
    line: lineMatches.length > 0 ? Number(lineMatches.at(-1)[1]) : null,
  };
}

function extractFatalMessage(log) {
  return log
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("! "))
    ?.replace(/^!\s*/, "") || null;
}

function diagnoseCompileFailure(log, mainFile) {
  const location = extractCompileLocation(log, mainFile);
  const fatalMessage = extractFatalMessage(log);

  if (/No build target was selected/i.test(log)) {
    return {
      kind: "build-target-missing",
      title: "No build target selected",
      summary: "TexLocal could not determine which .tex file should be compiled.",
      evidence: "No build target was selected.",
      sourcePath: null,
      line: null,
      actions: [
        "Select a .tex file in the file tree before compiling.",
        "Or mark a .tex file with `Use for build` to save it as the project build target.",
        "If you selected a folder, make sure it contains a `main.tex` file or exactly one .tex file.",
      ],
    };
  }

  if (/Build target not found:/i.test(log)) {
    return {
      kind: "build-target-not-found",
      title: "Build target not found",
      summary: "The selected .tex file does not exist anymore in this project.",
      evidence: fatalMessage || "Build target not found.",
      sourcePath: location.sourcePath,
      line: location.line,
      actions: [
        "Select an existing .tex file in the file tree.",
        "Use `Use for build` on the correct file if you want to save the target.",
        "Recompile after choosing a valid file.",
      ],
    };
  }

  if (/Build target must be a file:/i.test(log)) {
    return {
      kind: "build-target-invalid",
      title: "Invalid build target",
      summary: "The selected build target is not a .tex file.",
      evidence: fatalMessage || "Build target must be a file.",
      sourcePath: location.sourcePath,
      line: location.line,
      actions: [
        "Select a .tex file instead of a folder or unsupported path.",
        "If you selected a folder, make sure it contains `main.tex` or exactly one .tex file.",
        "Use `Use for build` on the exact .tex file when several candidates exist.",
      ],
    };
  }

  if (/No usable LaTeX compiler was found in PATH/i.test(log)) {
    return {
      kind: "compiler-missing",
      title: "No LaTeX compiler was found",
      summary: "TexLocal could not find a usable LaTeX compiler in your PATH.",
      evidence: fatalMessage,
      sourcePath: mainFile,
      line: null,
      actions: [
        "Install MiKTeX or TeX Live on this machine.",
        "Restart TexLocal after the installation so the new PATH is picked up.",
        "On Windows, install Perl only if you want to use `latexmk`; otherwise `pdflatex` is enough.",
      ],
    };
  }

  const missingLatexFile =
    log.match(/LaTeX Error: File [`']([^`'\r\n]+)[`'] not found\./i)?.[1] ||
    log.match(/! I can't find file [`']([^`'\r\n]+)[`']/i)?.[1] ||
    null;

  if (missingLatexFile) {
    const isPackageFile = /\.(sty|cls|bst|def|fd)$/i.test(missingLatexFile);

    return {
      kind: isPackageFile ? "missing-package" : "missing-project-file",
      title: isPackageFile ? "A LaTeX package is missing" : "A referenced file is missing",
      summary: isPackageFile
        ? `LaTeX could not find \`${missingLatexFile}\`. This usually means a missing MiKTeX package.`
        : `LaTeX could not find \`${missingLatexFile}\` in the project or TeX search path.`,
      evidence: missingLatexFile,
      sourcePath: location.sourcePath,
      line: location.line,
      actions: isPackageFile
        ? [
            "Open MiKTeX Console and enable automatic on-the-fly package installation if it is disabled.",
            "Recompile. MiKTeX should download the missing dependency when it is available.",
            `If it still fails, install the package that provides \`${missingLatexFile}\` manually from MiKTeX Console.`,
          ]
        : [
            "Check the file tree and confirm the referenced file exists.",
            "Verify the path and filename case in your `\\input`, `\\include`, `\\includegraphics`, or bibliography command.",
            "Recompile after fixing the path.",
          ],
    };
  }

  if (/could not find the script engine 'perl'/i.test(log)) {
    return {
      kind: "missing-perl",
      title: "Perl is missing for latexmk",
      summary: "`latexmk` is installed, but Perl is not available on this Windows machine.",
      evidence: "MiKTeX could not find the script engine 'perl'.",
      sourcePath: mainFile,
      line: null,
      actions: [
        "Keep using the built-in `pdflatex` fallback if your document compiles correctly with it.",
        "Install Strawberry Perl if you want to use `latexmk` on Windows.",
        "Restart TexLocal after installing Perl.",
      ],
    };
  }

  if (/pdfTeX error \(font expansion\): auto expansion is only possible with scalable\s+fonts\.?/i.test(log)) {
    return {
      kind: "font-expansion",
      title: "Font expansion failed",
      summary: "The document uses `microtype`, but pdfTeX reached a font that cannot be expanded. This often happens with `listings` and monospace fonts.",
      evidence: "pdfTeX error (font expansion): auto expansion is only possible with scalable fonts.",
      sourcePath: location.sourcePath,
      line: location.line,
      actions: [
        "Add `\\usepackage{lmodern}` after `\\usepackage[T1]{fontenc}` in your main preamble.",
        "If the error continues, change `\\usepackage{microtype}` to `\\usepackage[expansion=false]{microtype}`.",
        "Recompile after saving the document.",
      ],
    };
  }

  if (/Undefined control sequence\./i.test(log)) {
    return {
      kind: "undefined-control-sequence",
      title: "Unknown LaTeX command",
      summary: "LaTeX found a command it does not recognize.",
      evidence: fatalMessage || "Undefined control sequence.",
      sourcePath: location.sourcePath,
      line: location.line,
      actions: [
        "Check the command name for typos on the reported line.",
        "If the command comes from a package, make sure the package is loaded in the preamble.",
        "Recompile after the command or package list is fixed.",
      ],
    };
  }

  if (/Emergency stop\./i.test(log)) {
    return {
      kind: "emergency-stop",
      title: "LaTeX stopped early",
      summary: "LaTeX hit a fatal error and aborted before finishing the document.",
      evidence: fatalMessage || "Emergency stop.",
      sourcePath: location.sourcePath,
      line: location.line,
      actions: [
        "Look at the first fatal message shown in the full log below.",
        "Fix the missing command, file, or syntax issue near the reported line.",
        "Recompile once the error is corrected.",
      ],
    };
  }

  return {
    kind: "generic-compile-error",
    title: "Compilation failed",
    summary: "LaTeX stopped before producing a PDF.",
    evidence: fatalMessage,
    sourcePath: location.sourcePath,
    line: location.line,
    actions: [
      "Open the full log below and inspect the first line that starts with `!`.",
      "Fix the reported LaTeX issue near the highlighted file and line.",
      "Recompile after the correction.",
    ],
  };
}

async function runCompile(projDir, mainFile) {
  if (!mainFile) {
    const log =
      "ERROR: No build target was selected.\n\n" +
      "Select a .tex file in the file tree, or choose `Use for build` on the file you want to compile.";

    return {
      ok: false,
      log,
      issue: diagnoseCompileFailure(log, mainFile),
    };
  }

  const compiler = resolveCompiler();
  if (!compiler) {
    const log =
      "ERROR: No usable LaTeX compiler was found in PATH.\n\n" +
      "Install a TeX distribution:\n" +
      " - macOS: brew install --cask mactex-no-gui\n" +
      " - Linux: sudo apt install texlive-latex-extra latexmk\n" +
      " - Windows: install MiKTeX or TeX Live, and install Perl if you want latexmk.\n" +
      "   Without Perl, TexLocal will fall back to pdflatex when it is available.";

    return {
      ok: false,
      log,
      issue: diagnoseCompileFailure(log, mainFile),
    };
  }

  let log = `Using compiler: ${compiler.label}\n`;
  let code = 0;

  await cleanGeneratedArtifactsForMain(projDir, mainFile);
  log += "Cleaned stale LaTeX artifacts before compile.\n";

  for (let pass = 0; pass < compiler.passes; pass += 1) {
    const result = await runCommand(projDir, compiler.cmd, [...compiler.args, mainFile]);
    log += result.log;
    code = result.code;
    if (code !== 0) break;
  }

  const pdfName = mainFile.replace(/\.tex$/i, ".pdf");
  const pdfExists = fs.existsSync(path.join(projDir, pdfName));
  const ok = code === 0 && pdfExists;
  return {
    ok,
    log,
    pdfName,
    issue: ok ? null : diagnoseCompileFailure(log, mainFile),
  };
}

app.post("/api/projects/:id/compile", async (req, res) => {
  try {
    const meta = await readMeta(req.params.id);
    const requestedMainFile =
      typeof req.body?.mainFile === "string" ? normalizeRelativePath(req.body.mainFile) : meta.mainFile;

    if (requestedMainFile) {
      const abs = ensureInside(PROJ(req.params.id), requestedMainFile);
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch (error) {
        if (error?.code === "ENOENT") {
          const log =
            `ERROR: Build target not found: ${requestedMainFile}\n\n` +
            "Select an existing .tex file in the file tree, or set the correct one with `Use for build`.";

          return res.json({
            ok: false,
            log,
            issue: diagnoseCompileFailure(log, requestedMainFile),
            pdfUrl: undefined,
          });
        }

        throw error;
      }

      if (!stat.isFile()) {
        const log =
          `ERROR: Build target must be a file: ${requestedMainFile}\n\n` +
          "Select a valid .tex file before compiling.";

        return res.json({
          ok: false,
          log,
          issue: diagnoseCompileFailure(log, requestedMainFile),
          pdfUrl: undefined,
        });
      }
    }

    const result = await runCompile(PROJ(req.params.id), requestedMainFile);
    res.json({
      ok: result.ok,
      log: result.log,
      issue: result.issue ?? null,
      pdfUrl:
        result.ok && requestedMainFile
          ? `/api/projects/${req.params.id}/pdf?path=${encodeURIComponent(requestedMainFile)}`
          : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, log: String(e) });
  }
});

app.get("/api/projects/:id/pdf", async (req, res) => {
  try {
    const meta = await readMeta(req.params.id);
    const requestedMainFile =
      typeof req.query.path === "string" ? normalizeRelativePath(req.query.path) : meta.mainFile;

    if (!requestedMainFile) return res.status(404).send("PDF target not found");

    const pdf = ensureInside(
      PROJ(req.params.id),
      requestedMainFile.replace(/\.tex$/i, ".pdf")
    );
    if (!fs.existsSync(pdf)) return res.status(404).send("PDF not found");
    res.type("application/pdf").sendFile(pdf);
  } catch (e) {
    res.status(404).send(String(e));
  }
});

const server = app.listen(PORT, () => {
  const compiler = resolveCompiler();
  console.log(`\nTexLocal server ready`);
  console.log(`   API:      http://localhost:${PORT}`);
  console.log(`   Storage:  ${ROOT}`);
  console.log(`   LaTeX:    ${compiler ? compiler.label : "NOT FOUND"}\n`);
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use.`);
    console.error(`A TexLocal server may already be running on http://localhost:${PORT}`);
    console.error("If that server is healthy, reuse it and start only the UI.");
    console.error("Otherwise stop the process using that port, or start this server on another port.");
    console.error("");
    console.error("Examples:");
    console.error("  PowerShell:  $env:PORT='3002'; npm run dev:server");
    console.error("  Git Bash:    PORT=3002 npm run dev:server");
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});