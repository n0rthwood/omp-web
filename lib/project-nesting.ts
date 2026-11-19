export interface ProjectForestNode {
  root: string;
  name: string;
  children: ProjectForestNode[];
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function comparablePath(value: string, windows: boolean): string {
  const normalized = windows ? value.replace(/\\/g, "/").toLowerCase() : value;
  return normalized.replace(/\/+$/, "") || (normalized.startsWith("/") ? "/" : "");
}

/** Match whole path segments, using Windows comparison rules for Windows roots. */
export function isProjectWithin(projectPath: string, root: string): boolean {
  if (!root || !projectPath) return false;
  const windows = isWindowsAbsolutePath(projectPath) || isWindowsAbsolutePath(root);
  const normalizedRoot = comparablePath(root, false);
  if (normalizedRoot === "/") {
    return projectPath.startsWith("/") || isWindowsAbsolutePath(projectPath);
  }
  const comparable = comparablePath(projectPath, windows);
  const comparableRoot = comparablePath(root, windows);
  return comparable === comparableRoot || comparable.startsWith(comparableRoot + "/");
}

export function projectDisplayName(root: string): string {
  const stripped = root.replace(/[\\/]+$/, "");
  return stripped.slice(Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\")) + 1) || root;
}

/** Preserve exact cwd keys; only existing, strictly containing roots become parents. */
export function buildProjectForest(roots: string[]): ProjectForestNode[] {
  const nodes = [...new Set(roots)].sort().map((root) => ({
    root,
    name: projectDisplayName(root),
    children: [] as ProjectForestNode[],
  }));
  const forest: ProjectForestNode[] = [];
  for (const node of nodes) {
    let parent: ProjectForestNode | undefined;
    let parentLength = -1;
    for (const candidate of nodes) {
      if (candidate === node || !isProjectWithin(node.root, candidate.root) || isProjectWithin(candidate.root, node.root)) continue;
      const windows = isWindowsAbsolutePath(node.root) || isWindowsAbsolutePath(candidate.root);
      const length = comparablePath(candidate.root, windows).length;
      if (length > parentLength) {
        parent = candidate;
        parentLength = length;
      }
    }
    if (parent) parent.children.push(node);
    else forest.push(node);
  }
  return forest;
}
