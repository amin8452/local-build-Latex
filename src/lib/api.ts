// Talks to the local Node server (see /local-server).

export const API_BASE =
  ((import.meta.env.VITE_LATEX_API as string | undefined) ?? "http://localhost:3001").replace(/\/$/, "");

export type ProjectStatus = "active" | "archived" | "trashed";

export interface ProjectMeta {
  id: string;
  title: string;
  owner: string;
  updatedAt: string; // ISO
  mainFile: string;
  status: ProjectStatus;
}

export interface FileNode {
  path: string;     // relative path inside project
  type: "file" | "dir";
  children?: FileNode[];
}

export interface CompileIssue {
  kind: string;
  title: string;
  summary: string;
  evidence?: string | null;
  sourcePath?: string | null;
  line?: number | null;
  actions: string[];
}

export interface CompileResult {
  ok: boolean;
  pdfUrl?: string;  // absolute URL to PDF served by local server
  log: string;
  issue?: CompileIssue | null;
}

export interface ServerInfo {
  ok: boolean;
  storageRoot?: string;
  compiler?: string | null;
}

type ProjectUpdate = Partial<Pick<ProjectMeta, "title" | "mainFile" | "status">>;

function serverUnavailableMessage() {
  return (
    `Local LaTeX server unavailable at ${API_BASE}.\n\n` +
    "Start it with:\n" +
    "  cd local-server\n" +
    "  npm install\n" +
    "  npm start"
  );
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, init);
  } catch {
    throw new Error(serverUnavailableMessage());
  }
}

async function readBody(res: Response): Promise<string> {
  const body = await res.text();
  if (!res.ok) {
    throw new Error(body || `${res.status} ${res.statusText}`);
  }
  return body;
}

async function httpJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await request(path, init);
  const body = await readBody(res);
  return (body ? JSON.parse(body) : null) as T;
}

async function httpText(path: string, init?: RequestInit): Promise<string> {
  const res = await request(path, init);
  return readBody(res);
}

async function httpVoid(path: string, init?: RequestInit): Promise<void> {
  const res = await request(path, init);
  await readBody(res);
}

export async function getServerInfo(): Promise<ServerInfo | null> {
  try {
    const r = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return (await r.json()) as ServerInfo;
  } catch {
    return null;
  }
}

export async function checkServer(): Promise<boolean> {
  const info = await getServerInfo();
  return Boolean(info?.ok);
}

// ---------- API ----------
export const api = {
  async listProjects(): Promise<ProjectMeta[]> {
    return httpJson<ProjectMeta[]>("/api/projects");
  },

  async createProject(title: string): Promise<ProjectMeta> {
    return httpJson<ProjectMeta>("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
  },

  async importProject(zip: File, title?: string): Promise<ProjectMeta> {
    const form = new FormData();
    form.append("zip", zip);
    if (title?.trim()) form.append("title", title.trim());

    return httpJson<ProjectMeta>("/api/projects/import", {
      method: "POST",
      body: form,
    });
  },

  async deleteProject(id: string): Promise<void> {
    await httpVoid(`/api/projects/${id}`, { method: "DELETE" });
  },

  async updateProject(id: string, data: ProjectUpdate): Promise<ProjectMeta> {
    return httpJson<ProjectMeta>(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  },

  async getProject(id: string): Promise<{ project: ProjectMeta; tree: FileNode[] }> {
    return httpJson(`/api/projects/${id}`);
  },

  async readFile(id: string, path: string): Promise<string> {
    return httpText(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`);
  },

  async writeFile(id: string, path: string, content: string): Promise<void> {
    await httpVoid(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: content,
    });
  },

  async createFile(id: string, path: string): Promise<void> {
    await httpVoid(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`, {
      method: "POST",
    });
  },

  async createFolder(id: string, path: string): Promise<void> {
    await httpVoid(`/api/projects/${id}/folder?path=${encodeURIComponent(path)}`, {
      method: "POST",
    });
  },

  async uploadFile(id: string, file: File, directoryPath?: string): Promise<string> {
    const form = new FormData();
    form.append("file", file);

    const suffix = directoryPath?.trim()
      ? `?path=${encodeURIComponent(directoryPath.trim())}`
      : "";

    const data = await httpJson<{ ok: boolean; path: string }>(`/api/projects/${id}/upload${suffix}`, {
      method: "POST",
      body: form,
    });

    return data.path;
  },

  async deleteFile(id: string, path: string): Promise<void> {
    await httpVoid(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    });
  },

  async renameFile(id: string, from: string, to: string): Promise<void> {
    await httpVoid(`/api/projects/${id}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
  },

  async compile(id: string, mainFile?: string): Promise<CompileResult> {
    const data = await httpJson<CompileResult & { pdfUrl?: string }>(`/api/projects/${id}/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mainFile ? { mainFile } : {}),
    });

    return {
      ok: data.ok,
      log: data.log,
      issue: data.issue ?? null,
      pdfUrl: data.pdfUrl
  ? `${API_BASE}${data.pdfUrl}${data.pdfUrl.includes("?") ? "&" : "?"}t=${Date.now()}`
  : undefined,
    };
  },

  getPdfUrl(id: string): string {
    return `${API_BASE}/api/projects/${id}/pdf`;
  },

  getProjectArchiveUrl(id: string): string {
    return `${API_BASE}/api/projects/${id}/archive`;
  },
};
