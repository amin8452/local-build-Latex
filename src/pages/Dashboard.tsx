import { type ComponentType, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Archive,
  Download,
  FileText,
  FolderOpen,
  Plus,
  RotateCcw,
  Search,
  Tag,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AppHeader } from "@/components/AppHeader";
import { ServerStatus } from "@/components/ServerStatus";
import { api, type ProjectMeta, type ProjectStatus } from "@/lib/api";
import { toast } from "sonner";

type SidebarFilter = "all" | "mine" | "shared" | "archived" | "trashed";

interface SidebarItem {
  key: SidebarFilter;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

type PendingProjectAction =
  | { mode: "trash"; project: ProjectMeta }
  | { mode: "destroy"; project: ProjectMeta };

const LOCAL_OWNER = "You";

const SIDE_ITEMS: SidebarItem[] = [
  { key: "all", label: "All projects", icon: FolderOpen },
  { key: "mine", label: "Your projects", icon: FileText },
  { key: "shared", label: "Shared with you", icon: Users },
  { key: "archived", label: "Archived projects", icon: Archive },
  { key: "trashed", label: "Trashed projects", icon: Trash2 },
];

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hours ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} days ago`;
  return `${Math.floor(d / 30)} months ago`;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

function matchesFilter(project: ProjectMeta, filter: SidebarFilter) {
  switch (filter) {
    case "all":
      return project.status !== "trashed";
    case "mine":
      return project.owner === LOCAL_OWNER && project.status === "active";
    case "shared":
      return project.owner !== LOCAL_OWNER && project.status !== "trashed";
    case "archived":
      return project.status === "archived";
    case "trashed":
      return project.status === "trashed";
  }
}

function getFilterTitle(filter: SidebarFilter) {
  return SIDE_ITEMS.find((item) => item.key === filter)?.label ?? "Projects";
}

function getEmptyMessage(filter: SidebarFilter, hasQuery: boolean) {
  if (hasQuery) return "No projects match your search.";

  switch (filter) {
    case "mine":
      return "No local projects yet.";
    case "shared":
      return "Sharing is unavailable in local mode.";
    case "archived":
      return "No archived projects.";
    case "trashed":
      return "Trash is empty.";
    default:
      return "No projects yet. Click New project to start.";
  }
}

function getStatusLabel(status: ProjectStatus) {
  switch (status) {
    case "archived":
      return "Archived";
    case "trashed":
      return "In trash";
    default:
      return "Active";
  }
}

const Dashboard = () => {
  const navigate = useNavigate();
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [currentFilter, setCurrentFilter] = useState<SidebarFilter>("all");
  const [pendingAction, setPendingAction] = useState<PendingProjectAction | null>(null);

  const refresh = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await api.listProjects();
      setProjects(list);
    } catch (error) {
      const message = getErrorMessage(error);
      setProjects([]);
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = useMemo(() => {
    const visible = projects.filter((project) => matchesFilter(project, currentFilter));
    const q = query.trim().toLowerCase();
    if (!q) return visible;
    return visible.filter((project) => project.title.toLowerCase().includes(q));
  }, [projects, query, currentFilter]);

  const resetCreateDialog = () => {
    setOpen(false);
    setNewName("");
    setZipFile(null);
    if (zipInputRef.current) zipInputRef.current.value = "";
  };

  const create = async () => {
    try {
      const project = zipFile
        ? await api.importProject(zipFile, newName.trim() || undefined)
        : newName.trim()
          ? await api.createProject(newName.trim())
          : null;

      if (!project) return;

      resetCreateDialog();
      await refresh();
      navigate(`/project/${project.id}`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const updateProjectStatus = async (id: string, status: ProjectStatus, successMessage: string) => {
    try {
      await api.updateProject(id, { status });
      await refresh();
      toast.success(successMessage);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const archive = async (id: string) => {
    await updateProjectStatus(id, "archived", "Project archived");
  };

  const restore = async (id: string) => {
    await updateProjectStatus(id, "active", "Project restored");
  };

  const moveToTrash = async (id: string) => {
    await updateProjectStatus(id, "trashed", "Project moved to trash");
  };

  const destroy = async (id: string) => {
    try {
      await api.deleteProject(id);
      await refresh();
      toast.success("Project permanently deleted");
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <AppHeader right={<ServerStatus />} />

      <div className="flex-1 flex">
        <aside className="w-72 shrink-0 bg-sidebar border-r border-sidebar-border px-4 py-5 flex flex-col gap-5">
          <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) {
                resetCreateDialog();
                return;
              }

              setOpen(true);
            }}
          >
            <DialogTrigger asChild>
              <Button className="h-12 w-full justify-center rounded-full bg-primary text-[1.05rem] font-semibold text-primary-foreground shadow-[0_14px_32px_rgba(34,197,94,0.2)] hover:bg-primary/90">
                <Plus className="mr-1 h-4 w-4" /> New project
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-elevated border-border">
              <DialogHeader>
                <DialogTitle>Create a new project</DialogTitle>
                <DialogDescription>
                  Start from a blank LaTeX project or import an existing ZIP archive.
                </DialogDescription>
              </DialogHeader>

              <Input
                autoFocus
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder={zipFile ? "Optional project title" : "My beautiful thesis"}
                onKeyDown={(event) => event.key === "Enter" && void create()}
                className="bg-input border-border"
              />

              <div className="rounded-md border border-dashed border-border bg-background/40 p-4">
                <input
                  ref={zipInputRef}
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    setZipFile(file);
                  }}
                />
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Import a ZIP project</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Upload an existing LaTeX project archive and open it directly in TexLocal.
                    </p>
                    {zipFile && (
                      <p className="text-xs text-brand mt-2">
                        Selected: {zipFile.name}
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => zipInputRef.current?.click()}
                    className="shrink-0 rounded-full"
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    Choose ZIP
                  </Button>
                </div>
              </div>

              <DialogFooter>
                <Button variant="ghost" className="rounded-full" onClick={resetCreateDialog}>
                  Cancel
                </Button>
                <Button onClick={() => void create()} className="rounded-full bg-primary hover:bg-primary/90">
                  {zipFile ? "Import project" : "Create"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <AlertDialog
            open={pendingAction !== null}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) setPendingAction(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingAction?.mode === "destroy" ? "Delete project permanently?" : "Move project to trash?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingAction?.mode === "destroy"
                    ? `This will permanently delete "${pendingAction.project.title}" from local storage. This action cannot be undone.`
                    : `"${pendingAction?.project.title}" will be moved to trash. You can restore it later from the trash view.`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className={
                    pendingAction?.mode === "destroy"
                      ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      : "bg-primary text-primary-foreground hover:bg-primary/90"
                  }
                  onClick={() => {
                    const action = pendingAction;
                    setPendingAction(null);
                    if (!action) return;
                    if (action.mode === "destroy") {
                      void destroy(action.project.id);
                      return;
                    }
                    void moveToTrash(action.project.id);
                  }}
                >
                  {pendingAction?.mode === "destroy" ? "Delete permanently" : "Move to trash"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <nav className="flex flex-col gap-1">
            {SIDE_ITEMS.map((item) => (
              <button
                key={item.key}
                onClick={() => setCurrentFilter(item.key)}
                className={`flex items-center gap-3 px-4 py-3 text-[1.02rem] rounded-md text-left transition ${
                  currentFilter === item.key
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60"
                }`}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </button>
            ))}
          </nav>

          <div className="mt-2 pt-6 border-t border-sidebar-border">
            <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground px-4 mb-3">
              Organize tags
            </p>
            <button className="flex items-center gap-3 px-4 py-3 text-[1.02rem] text-sidebar-foreground hover:bg-sidebar-accent/60 rounded-md w-full">
              <Tag className="h-4 w-4" /> New tag
            </button>
          </div>
        </aside>

        <main className="flex-1 p-8 overflow-auto">
          <div className="max-w-7xl mx-auto bg-elevated rounded-lg border border-border p-6">
            <div className="flex items-center justify-between mb-6">
              <h1 className="text-2xl font-semibold">{getFilterTitle(currentFilter)}</h1>
              <div className="flex items-center gap-3 text-sm">
              </div>
            </div>

            <div className="relative mb-5">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search in ${getFilterTitle(currentFilter).toLowerCase()}...`}
                className="pl-9 bg-input border-border h-10"
              />
            </div>

            <div className="rounded-md overflow-hidden border border-border">
              <table className="w-full text-sm">
                <thead className="bg-background/40 text-muted-foreground">
                  <tr className="text-left">
                    <th className="w-10 p-3"></th>
                    <th className="p-3 font-medium">Title</th>
                    <th className="p-3 font-medium">Owner</th>
                    <th className="p-3 font-medium">Status</th>
                    <th className="p-3 font-medium">Last modified</th>
                    <th className="p-3 font-medium text-right pr-5">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-muted-foreground">
                        Loading...
                      </td>
                    </tr>
                  )}

                  {!loading && loadError && (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-muted-foreground">
                        <p className="whitespace-pre-line">{loadError}</p>
                        <Button variant="outline" className="mt-4" onClick={() => void refresh()}>
                          Retry
                        </Button>
                      </td>
                    </tr>
                  )}

                  {!loading && !loadError && filtered.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-12 text-center text-muted-foreground">
                        {getEmptyMessage(currentFilter, query.trim().length > 0)}
                      </td>
                    </tr>
                  )}

                  {!loading && !loadError && filtered.map((project) => (
                    <tr
                      key={project.id}
                      className="border-t border-border hover:bg-background/30 transition"
                    >
                      <td className="p-3">
                        <Checkbox />
                      </td>
                      <td className="p-3">
                        <Link
                          to={`/project/${project.id}`}
                          className="text-brand hover:underline font-medium"
                        >
                          {project.title}
                        </Link>
                      </td>
                      <td className="p-3 text-foreground/80">{project.owner}</td>
                      <td className="p-3 text-foreground/70">{getStatusLabel(project.status)}</td>
                      <td className="p-3 text-foreground/70">
                        {timeAgo(project.updatedAt)} by {project.owner}
                      </td>
                      <td className="p-3">
                        <TooltipProvider delayDuration={120}>
                          <div className="flex items-center justify-end gap-1.5 text-muted-foreground">
                            {project.status !== "trashed" && (
                              <ActionIconBtn
                                title="Open project"
                                icon={FolderOpen}
                                onClick={() => navigate(`/project/${project.id}`)}
                              />
                            )}

                            <ActionIconLink
                              title="Download ZIP"
                              icon={Download}
                              href={api.getProjectArchiveUrl(project.id)}
                              download
                            />

                            {project.status === "active" && (
                              <ActionIconBtn
                                title="Archive project"
                                icon={Archive}
                                onClick={() => void archive(project.id)}
                              />
                            )}

                            {project.status === "archived" && (
                              <ActionIconBtn
                                title="Restore project"
                                icon={RotateCcw}
                                onClick={() => void restore(project.id)}
                              />
                            )}

                            {project.status !== "trashed" && (
                              <ActionIconBtn
                                title="Move to trash"
                                icon={Trash2}
                                onClick={() => setPendingAction({ mode: "trash", project })}
                                danger
                              />
                            )}

                            {project.status === "trashed" && (
                              <>
                                <ActionIconBtn
                                  title="Restore project"
                                  icon={RotateCcw}
                                  onClick={() => void restore(project.id)}
                                />
                                <ActionIconBtn
                                  title="Delete permanently"
                                  icon={Trash2}
                                  onClick={() => setPendingAction({ mode: "destroy", project })}
                                  danger
                                />
                              </>
                            )}
                          </div>
                        </TooltipProvider>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
};

function ActionIconBtn({
  title,
  icon: Icon,
  onClick,
  danger,
}: {
  title: string;
  icon: ComponentType<{ className?: string }>;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          aria-label={title}
          className={`inline-flex h-10 w-10 items-center justify-center rounded-full border shadow-sm transition ${
            danger
              ? "border-destructive/30 bg-destructive/5 text-destructive hover:bg-destructive/12"
              : "border-border/70 bg-background/50 text-foreground/80 hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
          }`}
        >
          <Icon className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

function ActionIconLink({
  title,
  icon: Icon,
  href,
  download,
}: {
  title: string;
  icon: ComponentType<{ className?: string }>;
  href: string;
  download?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={href}
          download={download}
          aria-label={title}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border/70 bg-background/50 text-foreground/80 shadow-sm transition hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
        >
          <Icon className="h-4 w-4" />
        </a>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

export default Dashboard;
