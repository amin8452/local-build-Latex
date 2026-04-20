import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Editor, { type OnMount } from "@monaco-editor/react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  File as FileIcon,
  FilePlus,
  FolderPlus,
  Folder,
  FolderOpen,
  Loader2,
  MoreVertical,
  Pencil,
  Play,
  Save,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ServerStatus } from "@/components/ServerStatus";
import { api, type CompileIssue, type CompileResult, type FileNode, type ProjectMeta } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

function registerLatex(monaco: Parameters<OnMount>[1]) {
  if (monaco.languages.getLanguages().some((lang: { id: string }) => lang.id === "latex")) return;

  monaco.languages.register({ id: "latex" });

  monaco.languages.setMonarchTokensProvider("latex", {
    tokenizer: {
      root: [
        [/%.*$/, "comment"],
        [/\$\$/, { token: "keyword.math", next: "@mathDisplay" }],
        [/\$/, { token: "keyword.math", next: "@mathInline" }],
        [/\\(begin|end)\s*\{/, { token: "keyword.control", next: "@envName" }],
        [/\\[a-zA-Z@]+\*?/, "keyword"],
        [/[{}]/, "delimiter.curly"],
        [/[\[\]]/, "delimiter.square"],
        [/[&~^_]/, "operator"],
        [/\d+(\.\d+)?/, "number"],
        [/[^\\$%{}\[\]&~^_]+/, "string"],
      ],
      mathDisplay: [
        [/\$\$/, { token: "keyword.math", next: "@pop" }],
        [/\\[a-zA-Z@]+\*?/, "type.identifier"],
        [/[{}]/, "delimiter.curly"],
        [/./, "number"],
      ],
      mathInline: [
        [/\$/, { token: "keyword.math", next: "@pop" }],
        [/\\[a-zA-Z@]+\*?/, "type.identifier"],
        [/[{}]/, "delimiter.curly"],
        [/./, "number"],
      ],
      envName: [
        [/[a-zA-Z*]+/, "type.identifier"],
        [/\}/, { token: "keyword.control", next: "@pop" }],
      ],
    },
  } as never);

  monaco.editor.defineTheme("texlocal-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6A9955", fontStyle: "italic" },
      { token: "keyword", foreground: "4EC9B0" },
      { token: "keyword.control", foreground: "C586C0" },
      { token: "keyword.math", foreground: "DCDCAA" },
      { token: "type.identifier", foreground: "4FC1FF" },
      { token: "string", foreground: "D4D4D4" },
      { token: "number", foreground: "B5CEA8" },
      { token: "operator", foreground: "D4D4D4" },
      { token: "delimiter.curly", foreground: "FFD700" },
      { token: "delimiter.square", foreground: "DA70D6" },
    ],
    colors: {
      "editor.background": "#1a2332",
      "editor.foreground": "#d4d4d4",
      "editorLineNumber.foreground": "#4a5568",
      "editorLineNumber.activeForeground": "#a0aec0",
      "editor.selectionBackground": "#264f78",
      "editor.lineHighlightBackground": "#1e293b",
      "editorCursor.foreground": "#22c55e",
      "editorIndentGuide.background": "#2d3748",
    },
  });
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

function getNodeLabel(path: string) {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function flattenFilePaths(nodes: FileNode[]): string[] {
  const files: string[] = [];

  const visit = (entries: FileNode[]) => {
    for (const entry of entries) {
      if (entry.type === "file") {
        files.push(entry.path);
        continue;
      }

      if (entry.children?.length) visit(entry.children);
    }
  };

  visit(nodes);
  return files;
}

function collectDirectoryPaths(nodes: FileNode[]): string[] {
  const dirs: string[] = [];

  const visit = (entries: FileNode[]) => {
    for (const entry of entries) {
      if (entry.type !== "dir") continue;
      dirs.push(entry.path);
      if (entry.children?.length) visit(entry.children);
    }
  };

  visit(nodes);
  return dirs;
}

function collectParentDirectories(filePath: string) {
  const segments = filePath.split("/").filter(Boolean);
  const parents: string[] = [];

  for (let index = 1; index < segments.length; index += 1) {
    parents.push(segments.slice(0, index).join("/"));
  }

  return parents;
}

function getParentDirectory(path: string) {
  const segments = path.split("/").filter(Boolean);
  return segments.slice(0, -1).join("/");
}

const EDITABLE_EXTENSIONS = new Set([
  "bib",
  "bst",
  "cls",
  "css",
  "csv",
  "def",
  "html",
  "java",
  "js",
  "json",
  "md",
  "py",
  "sh",
  "sql",
  "sty",
  "tex",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

function isEditableTextFile(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  return Boolean(extension && EDITABLE_EXTENSIONS.has(extension));
}

function resolveCompileTarget(
  tree: FileNode[],
  activePath: string,
  selectedDirectory: string,
  savedMainFile?: string
) {
  const texFiles = flattenFilePaths(tree).filter((path) => /\.tex$/i.test(path)).sort();

  if (selectedDirectory) {
    const texInDirectory = texFiles.filter((path) => path.startsWith(`${selectedDirectory}/`));

    if (/\.tex$/i.test(activePath) && getParentDirectory(activePath) === selectedDirectory) {
      return activePath;
    }

    if (savedMainFile && texInDirectory.includes(savedMainFile)) {
      return savedMainFile;
    }

    const preferredMain = `${selectedDirectory}/main.tex`;
    if (texInDirectory.includes(preferredMain)) return preferredMain;
    return texInDirectory.length === 1 ? texInDirectory[0] : "";
  }

  if (/\.tex$/i.test(activePath)) return activePath;
  if (savedMainFile && texFiles.includes(savedMainFile)) return savedMainFile;
  if (texFiles.length === 1) return texFiles[0];
  return "";
}

interface ProjectTreeNodeProps {
  node: FileNode;
  depth: number;
  activePath: string;
  selectedDirectory: string;
  expandedDirs: Set<string>;
  mainFile?: string;
  onToggleDirectory: (path: string) => void;
  onSelectDirectory: (path: string) => void;
  onOpenFile: (path: string) => void | Promise<void>;
  onSetMainFile: (path: string) => void | Promise<void>;
  onRename: (path: string) => void | Promise<void>;
  onDelete: (path: string) => void | Promise<void>;
}

type FileDialogState =
  | { mode: "create"; value: string }
  | { mode: "create-folder"; value: string }
  | { mode: "rename"; value: string; targetPath: string };

function ProjectTreeNode({
  node,
  depth,
  activePath,
  selectedDirectory,
  expandedDirs,
  mainFile,
  onToggleDirectory,
  onSelectDirectory,
  onOpenFile,
  onSetMainFile,
  onRename,
  onDelete,
}: ProjectTreeNodeProps) {
  const paddingLeft = 12 + depth * 14;
  const label = getNodeLabel(node.path);

  
  if (node.type === "dir") {
  const expanded = expandedDirs.has(node.path);
  const hasActiveDescendant = activePath.startsWith(`${node.path}/`);
  const isSelectedDirectory = selectedDirectory === node.path;

  return (
    <div key={node.path}>
      <div
        className={cn(
          "group flex items-center gap-1 pr-1 hover:bg-sidebar-accent/50",
          (hasActiveDescendant || isSelectedDirectory)
            ? "bg-sidebar-accent/60 text-foreground"
            : "text-sidebar-foreground/85"
        )}
      >
        <button
          onClick={() => {
            onSelectDirectory(node.path);
            onToggleDirectory(node.path);
          }}
          className="flex-1 flex items-center gap-2 py-1.5 pr-3 text-sm text-left min-w-0"
          style={{ paddingLeft }}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          {expanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-brand" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-brand" />
          )}
          <span className="truncate">{label}</span>
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-accent text-muted-foreground hover:text-foreground transition-opacity">
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => onRename(node.path)}>
              <Pencil className="h-3.5 w-3.5 mr-2" /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onDelete(node.path)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {expanded && node.children?.map((child) => (
        <ProjectTreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          activePath={activePath}
          selectedDirectory={selectedDirectory}
          expandedDirs={expandedDirs}
          mainFile={mainFile}
          onToggleDirectory={onToggleDirectory}
          onSelectDirectory={onSelectDirectory}
          onOpenFile={onOpenFile}
          onSetMainFile={onSetMainFile}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

  const isMainFile = mainFile === node.path;
  const isTexFile = /\.tex$/i.test(node.path);

  return (
    <div
      key={node.path}
      className={cn(
        "group flex items-center gap-1 pr-1 hover:bg-sidebar-accent/60",
        activePath === node.path
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground"
      )}
    >
      <button
        onClick={() => onOpenFile(node.path)}
        className="flex-1 flex items-center gap-2 py-1.5 text-sm text-left min-w-0"
        style={{ paddingLeft }}
      >
        <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-accent text-muted-foreground hover:text-foreground transition-opacity">
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {isTexFile && !isMainFile && (
            <DropdownMenuItem onClick={() => onSetMainFile(node.path)}>
              <Play className="h-3.5 w-3.5 mr-2" /> Use for build
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => onRename(node.path)}>
            <Pencil className="h-3.5 w-3.5 mr-2" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onDelete(node.path)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const ProjectEditor = () => {
  const { id = "" } = useParams();
  const [project, setProject] = useState<ProjectMeta | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const [selectedDirectory, setSelectedDirectory] = useState("");
  const [activePath, setActivePath] = useState("");
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | undefined>();
  const [log, setLog] = useState("");
  const [compileIssue, setCompileIssue] = useState<CompileIssue | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [fileDialog, setFileDialog] = useState<FileDialogState | null>(null);
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(null);

  const saveTimer = useRef<number | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const refreshProject = useCallback(async (preferredPath?: string) => {
    const data = await api.getProject(id);
    setProject(data.project);
    setTree(data.tree);

    const filePaths = flattenFilePaths(data.tree);
    const nextPath = preferredPath && filePaths.includes(preferredPath)
      ? preferredPath
      : data.project.mainFile && filePaths.includes(data.project.mainFile)
        ? data.project.mainFile
        : filePaths.length === 1
          ? filePaths[0]
          : "";

    setExpandedDirs((current) => {
      const validDirs = new Set(collectDirectoryPaths(data.tree));
      const next =
        current.size === 0
          ? new Set(validDirs)
          : new Set([...current].filter((dirPath) => validDirs.has(dirPath)));

      for (const dirPath of collectParentDirectories(nextPath)) {
        next.add(dirPath);
      }

      return next;
    });

    setSelectedDirectory((current) => {
      const validDirs = new Set(collectDirectoryPaths(data.tree));
      const nextDirectory = preferredPath
        ? getParentDirectory(preferredPath)
        : current && validDirs.has(current)
          ? current
          : data.project.mainFile
            ? getParentDirectory(data.project.mainFile)
            : "";

      return validDirs.has(nextDirectory) || nextDirectory === "" ? nextDirectory : "";
    });

    if (!nextPath) {
      setActivePath("");
      setContent("");
      setDirty(false);
      setLoadError(null);
      return;
    }

    if (!isEditableTextFile(nextPath)) {
      setActivePath("");
      setContent("");
      setDirty(false);
      setLoadError(null);
      return;
    }

    setActivePath(nextPath);
    setSelectedDirectory(getParentDirectory(nextPath));
    setContent(await api.readFile(id, nextPath));
    setDirty(false);
    setLoadError(null);
  }, [id]);

  const loadProject = useCallback(async () => {
    setLoading(true);
    try {
      await refreshProject();
    } catch (error) {
      const message = getErrorMessage(error);
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [refreshProject]);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  const save = useCallback(async (notifySuccess = false, notifyError = true): Promise<boolean> => {
    if (!activePath) return true;

    try {
      await api.writeFile(id, activePath, content);
      setDirty(false);
      if (notifySuccess) toast.success("Saved");
      return true;
    } catch (error) {
      if (notifyError) toast.error(getErrorMessage(error));
      return false;
    }
  }, [activePath, content, id]);

  useEffect(() => {
    if (!dirty) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void save(false, false);
    }, 800);

    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [content, dirty, save]);

  const openFile = async (path: string) => {
    if (dirty) {
      const saved = await save(false);
      if (!saved) return;
    }

    if (!isEditableTextFile(path)) {
      setSelectedDirectory(getParentDirectory(path));
      toast.error("This file type cannot be edited in the text editor.");
      return;
    }

    try {
      setActivePath(path);
      setSelectedDirectory(getParentDirectory(path));
      setContent(await api.readFile(id, path));
      setDirty(false);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const toggleDirectory = (path: string) => {
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const currentDirectory = selectedDirectory || getParentDirectory(activePath);
  const compileTarget = resolveCompileTarget(tree, activePath, selectedDirectory, project?.mainFile);

  const compile = async () => {
    const saved = await save(false);
    if (!saved) return;

    setCompiling(true);
    setCompileIssue(null);
    setLog("Compiling...");

    try {
      const result: CompileResult = await api.compile(id, compileTarget || undefined);
      setLog(result.log || (result.ok ? "Compiled successfully." : "Compilation failed."));
      setCompileIssue(result.issue ?? null);
      if (result.pdfUrl) setPdfUrl(result.pdfUrl);
      if (!result.ok) {
        setShowLog(true);
        toast.error(result.issue?.title || "Compilation failed");
      } else {
        toast.success(`Compiled ${compileTarget}`.trim());
      }
    } catch (error) {
      const message = getErrorMessage(error);
      setLog(message);
      setCompileIssue({
        kind: "request-error",
        title: "Compilation request failed",
        summary: message,
        evidence: null,
        sourcePath: activePath || project?.mainFile || null,
        line: null,
        actions: [
          "Make sure the local TexLocal server is running.",
          "Check that the LaTeX backend is reachable from the browser.",
          "Retry the compilation once the server is healthy.",
        ],
      });
      setShowLog(true);
      toast.error(message);
    } finally {
      setCompiling(false);
    }
  };

  const openCreateFileDialog = () => {
    setFileDialog({
      mode: "create",
      value: currentDirectory ? `${currentDirectory}/` : "",
    });
  };

  const openCreateFolderDialog = () => {
    setFileDialog({
      mode: "create-folder",
      value: currentDirectory ? `${currentDirectory}/` : "",
    });
  };

  const setMainFile = async (path: string) => {
    try {
      const nextProject = await api.updateProject(id, { mainFile: path });
      setProject(nextProject);
      toast.success(`Build target set to ${path}`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const openRenameFileDialog = (path: string) => {
    setFileDialog({ mode: "rename", targetPath: path, value: path });
  };

  const uploadIntoCurrentDirectory = async (file: File | null) => {
    if (!file) return;

    try {
      const uploadedPath = await api.uploadFile(id, file, currentDirectory || undefined);
      await refreshProject(isEditableTextFile(uploadedPath) ? uploadedPath : activePath);
      setSelectedDirectory(getParentDirectory(uploadedPath));
      toast.success(`Uploaded ${file.name}`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  };

  const deleteFile = async (path: string) => {
  try {
    await api.deleteFile(id, path);

    const nextActivePath =
      activePath === path || activePath.startsWith(`${path}/`) ? undefined : activePath;

    if (selectedDirectory === path || selectedDirectory.startsWith(`${path}/`)) {
      setSelectedDirectory("");
    }

    await refreshProject(nextActivePath);
    toast.success("Item deleted");
  } catch (error) {
    toast.error(getErrorMessage(error));
  }
};

  const submitFileDialog = async () => {
    if (!fileDialog) return;

    const nextValue = fileDialog.value.trim();
    if (!nextValue) {
      toast.error(
        fileDialog.mode === "create"
          ? "File path is required"
          : fileDialog.mode === "create-folder"
            ? "Folder path is required"
            :  "New name is required"
      );
      return;
    }

    try {
      if (fileDialog.mode === "create") {
        await api.createFile(id, nextValue);
        setFileDialog(null);
        await refreshProject(nextValue);
        toast.success(`Created ${nextValue}`);
        return;
      }

      if (fileDialog.mode === "create-folder") {
        await api.createFolder(id, nextValue);
        setFileDialog(null);
        setSelectedDirectory(nextValue);
        setExpandedDirs((current) => new Set(current).add(nextValue));
        await refreshProject(activePath);
        toast.success(`Created folder ${nextValue}`);
        return;
      }

      if (nextValue === fileDialog.targetPath) {
        setFileDialog(null);
        return;
      }

      await api.renameFile(id, fileDialog.targetPath, nextValue);
setFileDialog(null);

const nextActivePath =
  activePath === fileDialog.targetPath
    ? nextValue
    : activePath.startsWith(`${fileDialog.targetPath}/`)
      ? `${nextValue}${activePath.slice(fileDialog.targetPath.length)}`
      : activePath;

if (selectedDirectory === fileDialog.targetPath) {
  setSelectedDirectory(nextValue);
} else if (selectedDirectory.startsWith(`${fileDialog.targetPath}/`)) {
  setSelectedDirectory(`${nextValue}${selectedDirectory.slice(fileDialog.targetPath.length)}`);
}

await refreshProject(nextActivePath);
toast.success(`Renamed to ${nextValue}`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const handleMount: OnMount = (editor, monaco) => {
    registerLatex(monaco);
    const model = editor.getModel();
    if (model) monaco.editor.setModelLanguage(model, "latex");

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void save(true);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      void compile();
    });
  };

  const issueLocation = compileIssue?.sourcePath
    ? `${compileIssue.sourcePath}${compileIssue.line ? `:${compileIssue.line}` : ""}`
    : null;
  const fileDialogTitle =
  fileDialog?.mode === "rename"
    ? "Rename item"
    : fileDialog?.mode === "create-folder"
      ? "Create a new folder"
      : "Create a new file";

const fileDialogDescription =
  fileDialog?.mode === "rename"
    ? "Update the path of the file or folder. Nested folders are supported."
    : fileDialog?.mode === "create-folder"
      ? "Create a folder in the selected location. Nested folders are supported."
      : "Enter a file path such as chapters/intro.tex. Missing folders will be created automatically.";

  if (loading) {
    return (
      <div className="h-screen bg-background flex items-center justify-center text-muted-foreground">
        Loading project...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-xl w-full rounded-lg border border-border bg-elevated p-6 text-center">
          <p className="text-foreground whitespace-pre-line">{loadError}</p>
          <Button className="mt-4" onClick={() => void loadProject()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <Dialog
        open={fileDialog !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setFileDialog(null);
        }}
      >
        <DialogContent className="bg-elevated border-border">
          <DialogHeader>
            <DialogTitle>{fileDialogTitle}</DialogTitle>
            <DialogDescription>{fileDialogDescription}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={fileDialog?.value ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              setFileDialog((current) => (current ? { ...current, value } : current));
            }}
            placeholder={
              fileDialog?.mode === "rename"
                ? "chapters/new-name.tex"
                : fileDialog?.mode === "create-folder"
                  ? "chapters/appendix"
                  : "chapters/intro.tex"
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitFileDialog();
            }}
            className="bg-input border-border rounded-2xl"
          />
          <DialogFooter>
            <Button variant="ghost" className="rounded-full" onClick={() => setFileDialog(null)}>
              Cancel
            </Button>
            <Button className="rounded-full bg-primary hover:bg-primary/90" onClick={() => void submitFileDialog()}>
              {fileDialog?.mode === "rename"? "Rename": fileDialog?.mode === "create-folder"? "Create folder": "Create file"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDeletePath !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingDeletePath(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete item?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeletePath
                ? `This will delete "${pendingDeletePath}" from the project. This action cannot be undone.`
                : "This item will be deleted from the project."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const path = pendingDeletePath;
                setPendingDeletePath(null);
                if (!path) return;
                void deleteFile(path);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <header className="h-12 shrink-0 flex items-center justify-between px-3 bg-sidebar border-b border-sidebar-border">
        <div className="flex items-center gap-2 min-w-0">
          <Link
            to="/"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-transparent text-muted-foreground transition hover:border-border/60 hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">
              {project?.title ?? "Untitled project"}
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              Build target: {compileTarget || "select a .tex file or folder"}
            </div>
          </div>
          {dirty && <span className="text-xs text-muted-foreground">- unsaved</span>}
        </div>
        <div className="flex items-center gap-2">
          <ServerStatus />
          <Button size="sm" variant="ghost" onClick={() => void save(true)} className="h-8 rounded-full">
            <Save className="h-4 w-4 mr-1" /> Save
          </Button>
          <Button
            size="sm"
            onClick={() => void compile()}
            disabled={compiling}
            className="h-8 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold shadow-[0_12px_30px_rgba(34,197,94,0.18)]"
          >
            {compiling ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-1" />
            )}
            Recompile
          </Button>
        </div>
      </header>

      <div className="flex-1 min-h-0">
        <ResizablePanelGroup
          direction="horizontal"
          autoSaveId="texlocal-editor-layout"
          className="h-full w-full"
        >
          <ResizablePanel defaultSize={20} minSize={14} maxSize={32} className="min-w-0">
            <aside className="h-full bg-sidebar flex flex-col">
              <div className="flex items-center justify-between px-3 py-2 border-b border-sidebar-border">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">
                  File tree
                </span>
                <div className="flex items-center gap-1.5">
                  <input
                    ref={uploadInputRef}
                    type="file"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      void uploadIntoCurrentDirectory(file);
                    }}
                  />
                  <button
                    onClick={openCreateFileDialog}
                    title="Add file"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/70 bg-background/45 text-muted-foreground shadow-sm transition hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
                  >
                    <FilePlus className="h-4 w-4" />
                  </button>
                  <button
                    onClick={openCreateFolderDialog}
                    title="Add folder"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/70 bg-background/45 text-muted-foreground shadow-sm transition hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
                  >
                    <FolderPlus className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => uploadInputRef.current?.click()}
                    title="Upload file"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/70 bg-background/45 text-muted-foreground shadow-sm transition hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
                  >
                    <Upload className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="border-b border-sidebar-border px-3 py-1.5 text-[11px] text-muted-foreground">
                Target folder: {currentDirectory || "project root"}
              </div>
              <div className="flex-1 overflow-auto py-1">
                {tree.length === 0 && (
                  <p className="text-xs text-muted-foreground px-3 py-2">No files</p>
                )}
                {tree.map((node) => (
                  <ProjectTreeNode
                    key={node.path}
                    node={node}
                    depth={0}
                    activePath={activePath}
                    selectedDirectory={selectedDirectory}
                    expandedDirs={expandedDirs}
                    mainFile={project?.mainFile}
                    onToggleDirectory={toggleDirectory}
                    onSelectDirectory={setSelectedDirectory}
                    onOpenFile={(path) => {
                      void openFile(path);
                    }}
                    onSetMainFile={(path) => {
                      void setMainFile(path);
                    }}
                    onRename={openRenameFileDialog}
                    onDelete={(path) => setPendingDeletePath(path)}
                  />
                ))}
              </div>
            </aside>
          </ResizablePanel>

          <ResizableHandle
            withHandle
            className="bg-sidebar-border/70 hover:bg-brand/60 transition-colors"
          />

          <ResizablePanel defaultSize={46} minSize={28} className="min-w-0">
            <section className="h-full min-w-0 flex flex-col border-r border-border bg-[#101722]">
              <div className="px-3 py-1.5 text-xs text-slate-300 bg-[#162133] border-b border-slate-800 flex items-center gap-2">
                <FileIcon className="h-3 w-3" />
                {activePath || "No file selected"}
              </div>
              <div className="flex-1 min-h-0 bg-[#101722]">
                <Editor
                  height="100%"
                  theme="texlocal-dark"
                  language="latex"
                  value={content}
                  onChange={(value) => {
                    setContent(value ?? "");
                    setDirty(true);
                  }}
                  onMount={handleMount}
                  options={{
                    automaticLayout: true,
                    minimap: { enabled: false },
                    fontSize: 13,
                    wordWrap: "on",
                    scrollBeyondLastLine: false,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    lineHeight: 20,
                    padding: { top: 8 },
                    renderLineHighlight: "line",
                    cursorBlinking: "smooth",
                    smoothScrolling: true,
                    bracketPairColorization: { enabled: true },
                  }}
                />
              </div>
              {showLog && (
                <div
                  className={cn(
                    "min-h-0 shrink-0 border-t border-slate-800 bg-[#0d131d] flex flex-col",
                    compileIssue ? "h-64" : "h-40"
                  )}
                >
                  <div className="flex items-center justify-between px-3 py-1 text-xs border-b border-slate-800">
                    <span className="flex items-center gap-1.5 text-slate-400">
                      <Terminal className="h-3.5 w-3.5" /> LaTeX log
                    </span>
                    <button
                      onClick={() => setShowLog(false)}
                      className="text-slate-400 hover:text-slate-100"
                    >
                      x
                    </button>
                  </div>
                  <ScrollArea className="min-h-0 flex-1">
                    {compileIssue && (
                      <div className="border-b border-slate-800 p-3">
                        <Alert
                          variant="destructive"
                          className="border-destructive/40 bg-destructive/10 text-slate-100 [&>svg]:text-destructive"
                        >
                          <AlertTriangle className="h-4 w-4" />
                          <AlertTitle className="text-slate-100">{compileIssue.title}</AlertTitle>
                          <AlertDescription className="space-y-3 text-slate-200/85">
                            <p>{compileIssue.summary}</p>
                            {issueLocation && (
                              <p className="text-xs uppercase tracking-wide text-slate-300">
                                Location: {issueLocation}
                              </p>
                            )}
                            {compileIssue.evidence && (
                              <pre className="rounded-md border border-slate-800 bg-[#0b1118] p-2 text-[11px] whitespace-pre-wrap font-mono text-slate-300">
                                {compileIssue.evidence}
                              </pre>
                            )}
                            {compileIssue.actions.length > 0 && (
                              <div className="space-y-1">
                                <p className="text-xs uppercase tracking-wide text-slate-300">
                                  Suggested fix
                                </p>
                                <ul className="list-disc space-y-1 pl-5 text-sm">
                                  {compileIssue.actions.map((action) => (
                                    <li key={action}>{action}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {compileIssue.sourcePath && compileIssue.sourcePath !== activePath && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 border-slate-700 bg-transparent text-slate-100 hover:bg-slate-800 hover:text-slate-100"
                                onClick={() => {
                                  void openFile(compileIssue.sourcePath || "");
                                }}
                              >
                                Open related file
                              </Button>
                            )}
                          </AlertDescription>
                        </Alert>
                      </div>
                    )}
                    <pre className="p-3 text-[11px] leading-relaxed font-mono whitespace-pre-wrap text-slate-200/90">
                      {log}
                    </pre>
                  </ScrollArea>
                </div>
              )}
            </section>
          </ResizablePanel>

          <ResizableHandle
            withHandle
            className="bg-border/80 hover:bg-brand/60 transition-colors"
          />

          <ResizablePanel defaultSize={34} minSize={20} maxSize={52} className="min-w-0">
            <section className="h-full min-w-0 flex flex-col bg-elevated">
              <div className="h-9 px-3 flex items-center justify-between border-b border-border text-xs text-muted-foreground">
                <span>PDF preview</span>
                <div className="flex items-center gap-2">
                  <span className="hidden sm:inline">Main: {project?.mainFile || "not set"}</span>
                  <button
                    onClick={() => setShowLog((current) => !current)}
                    className="hover:text-foreground flex items-center gap-1"
                  >
                    <Terminal className="h-3.5 w-3.5" /> Log
                  </button>
                   {pdfUrl && (
  <a
    href={pdfUrl}
    onClick={async (e) => {
      e.preventDefault();

      const response = await fetch(pdfUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = (project?.mainFile || "document.tex").replace(/\.tex$/i, ".pdf");
      document.body.appendChild(a);
      a.click();
      a.remove();

      URL.revokeObjectURL(objectUrl);
    }}
    className="hover:text-foreground flex items-center gap-1"
  >
    <Download className="h-3.5 w-3.5" /> PDF
  </a>
)}
                </div>
              </div>
              <div className="flex-1 bg-background">
                {pdfUrl ? (
                  <iframe
                    title="pdf"
                    src={pdfUrl}
                    className="w-full h-full border-0"
                  />
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center px-6 text-muted-foreground gap-2">
                    <Play className="h-8 w-8 text-primary" />
                    <p className="text-sm">Click <b>Recompile</b> to build your PDF.</p>
                    <p className="text-xs">Shortcut: Cmd/Ctrl + Enter</p>
                  </div>
                )}
              </div>
            </section>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
};

export default ProjectEditor;
