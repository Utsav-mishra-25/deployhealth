// Build output and caches that only a directory's context identifies. `cache`, `build`, `target`
// and `storage` are ordinary source folder names in many repositories, so unlike VENDORED_DIRS
// they are skipped only under a known parent (`bootstrap/cache`) or next to a build tool's or
// framework's marker file (Maven's `target/` beside `pom.xml`, Gradle's `build/` and `target/`
// beside a Gradle build file, `storage/` beside Laravel's `artisan`). Laravel's bootstrap/cache and storage/ can hold
// cached config with values: the scanner never opens them.

/** `<parent>/<dir>` pairs skipped at any depth. */
const SKIPPED_PAIRS: ReadonlySet<string> = new Set(['bootstrap/cache', 'public/build']);

/** Directories skipped when their parent directory holds one of these files. */
const GRADLE_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
const SKIPPED_NEXT_TO: ReadonlyMap<string, readonly string[]> = new Map([
  ['storage', ['artisan']],
  ['target', ['pom.xml', ...GRADLE_FILES]],
  ['build', GRADLE_FILES],
]);

/** Every file name SKIPPED_NEXT_TO looks for. */
const MARKER_FILE_NAMES: ReadonlySet<string> = new Set([...SKIPPED_NEXT_TO.values()].flat());

/**
 * Whether the directory `name`, inside a directory named `parentName`, is build output by
 * context. `hasSibling(file)` says whether that parent directory holds a file of that name.
 */
export function isContextualSkip(parentName: string, name: string, hasSibling: (file: string) => boolean): boolean {
  if (SKIPPED_PAIRS.has(`${parentName}/${name}`)) return true;
  const markers = SKIPPED_NEXT_TO.get(name);
  return markers !== undefined && markers.some(hasSibling);
}

/** The directories of a tree that hold marker files, as a trie of path segments. */
export interface TreeMarkers {
  children: Map<string, TreeMarkers>;
  /** Marker file names in this directory. */
  files: Set<string>;
}

/** The marker files of a git tree listing (`treeMarkers`), for `inContextualSkipDir`. One pass. */
export function treeMarkers(paths: Iterable<string>): TreeMarkers {
  const root: TreeMarkers = { children: new Map(), files: new Set() };
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!MARKER_FILE_NAMES.has(name)) continue;
    let node = root;
    let start = 0;
    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', start)) {
      const segment = path.slice(start, slash);
      let child = node.children.get(segment);
      if (!child) node.children.set(segment, (child = { children: new Map(), files: new Set() }));
      node = child;
      start = slash + 1;
    }
    node.files.add(name);
  }
  return root;
}

/**
 * Whether any directory on a POSIX path is build output by context, given the tree's marker
 * files (`treeMarkers`). Walks the path and the trie together: linear in the path's length.
 */
export function inContextualSkipDir(path: string, markers: TreeMarkers): boolean {
  let parent: TreeMarkers | undefined = markers;
  let parentName = '';
  let start = 0;
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', start)) {
    const name = path.slice(start, slash);
    const siblings: TreeMarkers | undefined = parent;
    if (isContextualSkip(parentName, name, (file) => siblings?.files.has(file) === true)) return true;
    parent = parent?.children.get(name);
    parentName = name;
    start = slash + 1;
  }
  return false;
}
