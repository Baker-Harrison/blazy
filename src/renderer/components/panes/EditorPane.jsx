import { useCallback, useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { ChevronIcon, FileIcon, FolderIcon, PanelLeftIcon } from '../icons';
import ImageViewer from './viewers/ImageViewer';
import SpreadsheetViewer from './viewers/SpreadsheetViewer';
import PdfViewer from './viewers/PdfViewer';
import { markdownLinkForDrop } from '../../lib/dragPaste';

// The code Editor pane: a mini file browser (the "Explorer" panel) on the
// left, showing the folders/files inside the current workspace, and the
// actual text editor (powered by Monaco — the same engine as VS Code) on
// the right, for editing whichever file is selected. This gives the app a
// basic VS-Code-like editing experience.
// Below this width (in pixels), docking the file tree AND the code editor
// side-by-side leaves too little room for either to be comfortably usable
// (the classic symptom: everything looks "squished," lines run off the
// right edge, and you end up scrolling constantly in both directions). See
// the ResizeObserver in EditorPane below, which measures the pane's actual
// on-screen width live and switches the Explorer into a compact,
// pop-open-when-needed drawer once the pane gets this narrow — instead of
// permanently shrinking everything to fit.
const NARROW_BREAKPOINT = 560;

export default function EditorPane({ tab, workspace }) {
  const rootPath = workspace.workspace?.path;
  // The folder tree data (files and subfolders) to show in the Explorer.
  const [tree, setTree] = useState([]);
  // Which folder paths are currently expanded (showing their contents) in
  // the Explorer tree.
  const [expanded, setExpanded] = useState(new Set());
  // Which file is currently open in the editor. Starts from whatever file
  // was previously open on this tab, if reopening.
  const [selectedFile, setSelectedFile] = useState(tab.config?.filePath || null);
  // The text content of the currently open file.
  const [content, setContent] = useState('');
  // A reference to this whole pane's outer element, used below to measure
  // its actual on-screen width so the layout can adapt as it's resized.
  const containerRef = useRef(null);
  // Whether this pane is currently too narrow to comfortably show the file
  // tree docked next to the editor at the same time. Kept up to date live
  // by a ResizeObserver below — dragging a split divider, resizing the
  // window, or opening/closing the app's own sidebar can all change this.
  const [narrow, setNarrow] = useState(false);
  // Whether the Explorer is shown docked open on a WIDE pane (ignored while
  // "narrow" — see the drawer handling below instead). Remembered per tab,
  // the same way BrowserPane remembers its own collapsible tab rail.
  const [explorerOpen, setExplorerOpen] = useState(tab.config?.explorerOpen !== false);
  // On a narrow pane, the Explorer isn't docked at all — it's a temporary
  // floating drawer that pops out over the editor and closes itself again,
  // so browsing files never permanently steals width from the code. This
  // tracks whether that drawer is currently popped open.
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Watch this pane's actual on-screen width and flip into "narrow" mode
  // once it drops below NARROW_BREAKPOINT — this is what makes the
  // Explorer responsive to ANY size change (window resize, split-divider
  // drag, sidebar toggle), not just how big the pane happened to be when
  // it was first opened.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      setNarrow(width < NARROW_BREAKPOINT);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // If the pane grows back past the narrow breakpoint (e.g. the user
  // widens the split, or maximizes the window), don't leave a stale
  // drawer hanging open — it was only ever meant to be a temporary,
  // narrow-pane affordance.
  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);

  // Toggles the Explorer. What exactly that means depends on how much room
  // there currently is: on a wide pane it docks/undocks a real column (and
  // remembers your preference for next time); on a narrow pane there's no
  // room to dock anything, so it just pops the floating drawer open/closed
  // instead.
  const toggleExplorer = () => {
    if (narrow) {
      setDrawerOpen((v) => !v);
      return;
    }
    setExplorerOpen((v) => {
      const next = !v;
      workspace.updateTab(tab.id, { config: { ...tab.config, explorerOpen: next } });
      return next;
    });
  };
  // A little timer we use to "debounce" autosaving — instead of writing to
  // disk on every single keystroke (which would be wasteful), we wait for
  // a short pause in typing before actually saving.
  const autosaveTimer = useRef(null);
  // Whatever edit is still waiting to be written to disk (if any). We keep
  // this around so that if the user switches files (or closes the tab)
  // before the debounce timer fires, we can flush it immediately instead
  // of silently throwing the edit away — otherwise the on-disk file would
  // be missing whatever was typed in the last 250ms.
  const pendingWrite = useRef(null);
  // Holds the live Monaco editor instance once it's mounted, so the drop
  // handler below (see handleEditorDrop) can insert text at the cursor —
  // Monaco hands us this instance via the Editor component's onMount prop.
  const editorRef = useRef(null);

  // Reads a folder's contents, and recursively pre-loads a couple of
  // levels of subfolders too (depth < 2), so expanding a folder in the
  // Explorer usually feels instant instead of needing to fetch again. Any
  // folder we can't read (e.g. permission denied) is silently treated as
  // empty rather than crashing the whole tree.
  const loadDir = useCallback(async (dirPath, depth = 0) => {
    try {
      const entries = await window.fs.readDir(dirPath);
      if (depth < 2) {
        for (const entry of entries) {
          if (entry.isDirectory) {
            entry.children = await loadDir(entry.path, depth + 1);
          }
        }
      }
      return entries;
    } catch {
      return [];
    }
  }, []);

  // Load the workspace's folder tree once we know its root path.
  useEffect(() => {
    if (rootPath) {
      loadDir(rootPath).then(setTree);
    }
  }, [rootPath, loadDir]);

  // What KIND of viewer the currently selected file needs — plain text/code
  // (Monaco), a picture, a spreadsheet, or a PDF. See kindForPath below.
  // Only "text" files get loaded into Monaco and autosaved; the other
  // kinds are read-only viewers that do their own file reading (since
  // their file contents are binary, not text — see the viewer components
  // in ./viewers).
  const fileKind = selectedFile ? kindForPath(selectedFile) : null;

  // Whenever the selected file changes, load its text content from disk —
  // but only for files we're going to show in the text editor. Images,
  // spreadsheets, and PDFs are binary data; reading them as UTF-8 text (as
  // this does) would corrupt them, so those kinds skip this entirely and
  // let their own viewer component read the file instead.
  useEffect(() => {
    if (!selectedFile || fileKind !== 'text') {
      setContent('');
      return;
    }
    // "alive" prevents a slow/late file read from a PREVIOUS selection
    // from overwriting the content of whatever file is selected NOW.
    let alive = true;
    window.fs.readFile(selectedFile).then((text) => {
      // If the user already started typing in this file before the read
      // finished (e.g. it was slow to load), don't stomp on their edit
      // with the older content we just read from disk.
      if (alive && !pendingWrite.current) {
        setContent(text);
      }
    }).catch(() => {
      if (alive && !pendingWrite.current) {
        setContent('');
      }
    });
    return () => {
      alive = false;
      // If we're switching away from this file (or the pane is closing)
      // while an edit was still waiting to be autosaved, write it to disk
      // RIGHT NOW instead of just cancelling the timer — otherwise that
      // last bit of typing would never make it out of memory and the file
      // on disk would silently stay stale.
      if (autosaveTimer.current) {
        clearTimeout(autosaveTimer.current);
        autosaveTimer.current = null;
      }
      if (pendingWrite.current) {
        const { filePath, content: pendingContent } = pendingWrite.current;
        pendingWrite.current = null;
        window.fs.writeFile(filePath, pendingContent);
      }
    };
  }, [selectedFile]);

  // Searches the currently-loaded tree for the folder/file entry at a given
  // path — used to check whether a folder's contents have already been
  // fetched from disk, or still need to be.
  const findEntry = (nodes, targetPath) => {
    for (const node of nodes) {
      if (node.path === targetPath) return node;
      if (node.children) {
        const found = findEntry(node.children, targetPath);
        if (found) return found;
      }
    }
    return null;
  };

  // Expands or collapses a folder in the Explorer tree.
  //
  // loadDir() only eagerly pre-loads a couple of levels of subfolders up
  // front (see its comment above) to keep the initial load fast — anything
  // deeper than that hasn't been fetched yet. So whenever a folder is being
  // expanded, we check whether its contents were actually loaded; if not,
  // we fetch them right now. Without this, expanding a deeply-nested folder
  // would show it as "expanded" but permanently empty, even if it has real
  // files inside — the classic symptom being a folder that LOOKS empty in
  // the Explorer but clearly isn't when you check it on disk.
  const toggleFolder = (path) => {
    const isCurrentlyExpanded = expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

    if (!isCurrentlyExpanded) {
      const entry = findEntry(tree, path);
      if (entry && entry.children === undefined) {
        loadDir(path).then((children) => {
          entry.children = children;
          // We mutated the entry object in place rather than rebuilding the
          // whole tree, so React won't notice anything changed on its own —
          // this makes a fresh copy of the top-level array just to trigger
          // a re-render, which then picks up the newly-fetched children.
          setTree((prevTree) => [...prevTree]);
        });
      }
    }
  };

  // Opens a file for editing, and remembers which file was opened on this
  // tab so reopening the tab later brings you back to the same file. Also
  // closes the floating drawer, if it happened to be open — picking a file
  // from it is the natural "I'm done with this drawer" signal, the same
  // way choosing an item from a mobile app's slide-out menu closes it.
  const openFile = (filePath) => {
    setSelectedFile(filePath);
    workspace.updateTab(tab.id, { config: { ...tab.config, filePath } });
    setDrawerOpen(false);
  };

  // Handles a URL dragged in from a Browser pane's address bar (see
  // BrowserPane.jsx's draggable address-bar icon) and dropped anywhere on
  // this Editor pane: turns it into a markdown link and types it into the
  // editor at the current cursor position, the same as if the user had
  // typed it themselves.
  const handleEditorDrop = (e) => {
    e.preventDefault();
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (!url || !/^https?:\/\//i.test(url)) return; // Not a URL — nothing for us to do (e.g. a file drop, handled elsewhere).
    const title = e.dataTransfer.getData('text/x-blazy-title');
    const markdown = markdownLinkForDrop({ url, title });
    const editor = editorRef.current;
    if (!editor) return;
    // "trigger keyboard type" inserts text exactly as if it had been typed
    // at the current cursor position — including replacing any selection,
    // just like a real paste would.
    editor.trigger('keyboard', 'type', { text: markdown });
    editor.focus();
  };

  // The actual file/folder tree, shared between the two places it can
  // appear below (docked in the sidebar column, or inside the floating
  // drawer) so both stay in sync automatically instead of drifting apart.
  const explorerTree = (
    <div className="min-h-0 flex-1 overflow-y-auto py-1">
      {tree.map((entry) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          level={0}
          expanded={expanded}
          selectedFile={selectedFile}
          onToggle={toggleFolder}
          onSelect={openFile}
        />
      ))}
    </div>
  );

  return (
    <div ref={containerRef} className="relative flex h-full min-h-0 min-w-0 flex-1 bg-app">
      {/* Left sidebar: the file/folder tree ("Explorer"). On a wide pane
          this is a normal docked column you can collapse to a thin icon
          rail. On a narrow pane (see NARROW_BREAKPOINT above) there simply
          isn't room to dock it at all without squeezing the editor down to
          the point of being unusable — so it's ALWAYS shown as just the
          icon rail there, and clicking it pops open a temporary floating
          drawer (below) instead of a permanent column. */}
      <div
        className={`flex shrink-0 flex-col border-r border-edge bg-surface transition-[width] duration-150 ${
          !narrow && explorerOpen ? 'w-48' : 'w-9'
        }`}
      >
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-edge px-2">
          {!narrow && explorerOpen && (
            <span className="truncate pl-1 text-[11px] font-medium uppercase tracking-wide text-ink-dim">
              Explorer
            </span>
          )}
          <button
            type="button"
            onClick={toggleExplorer}
            className={`ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-dim hover:bg-hover hover:text-ink ${
              drawerOpen ? 'bg-hover text-ink' : ''
            }`}
            title={narrow || !explorerOpen ? 'Show file explorer' : 'Hide file explorer'}
          >
            <PanelLeftIcon />
          </button>
        </div>
        {!narrow && explorerOpen && explorerTree}
      </div>

      {/* Floating drawer: only reachable on a narrow pane, and only once
          toggled open. It's positioned ON TOP of the editor (absolute,
          with a click-to-dismiss backdrop) rather than squeezing it, so
          browsing files never costs the editor any of the width it needs
          to stay readable. */}
      {narrow && drawerOpen && (
        <>
          <div
            className="absolute inset-0 z-10 bg-black/30"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 z-20 flex w-56 max-w-[75%] flex-col border-r border-edge bg-surface shadow-lg">
            <div className="flex h-8 shrink-0 items-center border-b border-edge px-3 text-[11px] font-medium uppercase tracking-wide text-ink-dim">
              Explorer
            </div>
            {explorerTree}
          </div>
        </>
      )}

      {/* Right side: whichever viewer fits the selected file (code editor,
          image, spreadsheet, PDF), or a placeholder message if nothing is
          selected yet. */}
      <div
        className="flex min-w-0 flex-1 flex-col"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleEditorDrop}
      >
        {selectedFile ? (
          <>
            <div className="flex h-8 shrink-0 items-center justify-between border-b border-edge px-3">
              <span className="truncate text-[12px] text-ink">{selectedFile}</span>
            </div>
            {fileKind === 'image' && <ImageViewer filePath={selectedFile} />}
            {fileKind === 'spreadsheet' && <SpreadsheetViewer filePath={selectedFile} />}
            {fileKind === 'pdf' && <PdfViewer filePath={selectedFile} />}
            {fileKind === 'text' && (
              <div className="min-h-0 flex-1">
                <Editor
                  theme="vs-dark"
                  path={selectedFile}
                  // Guesses which programming language this file is written
                  // in (based on its file extension) so Monaco can apply the
                  // right syntax highlighting (coloring keywords, strings,
                  // etc. differently) — see languageForPath below.
                  defaultLanguage={languageForPath(selectedFile)}
                  value={content}
                  onMount={(editor) => {
                    editorRef.current = editor;
                  }}
                  onChange={(value) => {
                    const nextContent = value || '';
                    setContent(nextContent);
                    // Autosave: every time the text changes, reset the
                    // debounce timer. If the user keeps typing, the timer
                    // keeps getting pushed back; once they pause for half a
                    // second, we write the current content to disk.
                    if (autosaveTimer.current) {
                      clearTimeout(autosaveTimer.current);
                    }
                    const fileBeingEdited = selectedFile;
                    pendingWrite.current = { filePath: fileBeingEdited, content: nextContent };
                    autosaveTimer.current = setTimeout(() => {
                      autosaveTimer.current = null;
                      pendingWrite.current = null;
                      window.fs.writeFile(fileBeingEdited, nextContent);
                    }, 250);
                  }}
                  options={{
                    minimap: { enabled: false }, // Disables the small zoomed-out code preview on the right edge.
                    fontSize: 13,
                    automaticLayout: true, // Keeps the editor correctly sized as its container resizes.
                    scrollBeyondLastLine: false,
                    // Wraps long lines to fit the visible width instead of
                    // running off the right edge and forcing you to scroll
                    // sideways to read them — this is what actually fixes
                    // "some text is off the right side of this editor" on a
                    // narrow pane, since a fixed font size alone can't make
                    // arbitrarily long lines fit without either shrinking
                    // text to an unreadable size or wrapping it.
                    wordWrap: 'on',
                    wrappingIndent: 'same',
                  }}
                />
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-ink-dim">
            Select a file from the explorer to edit.
          </div>
        )}
      </div>
    </div>
  );
}

// One row in the Explorer's file/folder tree — either a folder (which can
// be expanded/collapsed to reveal its children) or a plain file (which
// opens it in the editor when clicked). This function calls itself
// recursively to draw nested subfolders.
function TreeNode({ entry, level, expanded, selectedFile, onToggle, onSelect }) {
  const isExpanded = expanded.has(entry.path);

  if (entry.isDirectory) {
    return (
      <div>
        <button
          type="button"
          onClick={() => onToggle(entry.path)}
          className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-[12px] text-ink hover:bg-hover"
          // Indents each nested level further to the right, so the tree
          // visually shows how deeply nested each folder/file is — the
          // same visual convention as any file browser's tree view.
          style={{ paddingLeft: `${level * 12 + 8}px` }}
        >
          <ChevronIcon
            className={`shrink-0 transition-transform ${isExpanded ? 'rotate-90' : 'rotate-0'}`}
          />
          <FolderIcon />
          <span className="truncate">{entry.name}</span>
        </button>
        {isExpanded && (
          <div>
            {entry.children?.map((child) => (
              <TreeNode
                key={child.path}
                entry={child}
                level={level + 1}
                expanded={expanded}
                selectedFile={selectedFile}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(entry.path)}
      // Lets you drag this file out of the Explorer and drop it onto a
      // Terminal pane to insert its path — see TerminalPane.jsx's onDrop.
      // "text/plain" is the one data type every drop target can read.
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', entry.path);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      className={`flex w-full items-center gap-1 px-2 py-0.5 text-left text-[12px] hover:bg-hover ${
        selectedFile === entry.path ? 'bg-hover text-white' : 'text-ink-dim'
      }`}
      style={{ paddingLeft: `${level * 12 + 24}px` }}
    >
      <FileIcon />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

// Looks at a file's extension to decide which VIEWER should show it: the
// text/code editor (Monaco), an image viewer, a spreadsheet grid, or a PDF
// reader. This is the one place that decides "what does this file look
// like" — everything else (the Explorer tree, the tab system) stays
// unaware of file types and just hands a path to whichever viewer this
// picks.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);
const SPREADSHEET_EXTENSIONS = new Set(['csv', 'xlsx', 'xls']);

function kindForPath(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (SPREADSHEET_EXTENSIONS.has(ext)) return 'spreadsheet';
  if (ext === 'pdf') return 'pdf';
  return 'text';
}

// Looks at a file's extension (the letters after the last ".") to guess
// which programming language it's written in, so Monaco can apply the
// right syntax highlighting. Anything not in this list falls back to
// "plaintext" (no special highlighting, just plain text).
function languageForPath(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    html: 'html',
    css: 'css',
    py: 'python',
    md: 'markdown',
    sql: 'sql',
  };
  return map[ext] || 'plaintext';
}
