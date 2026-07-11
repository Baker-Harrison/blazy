// This file runs in the app's "main" process — the background part of the
// Electron app that has full access to the computer's file system (unlike
// the on-screen "renderer" process, which is sandboxed for security and
// can't read/write files directly). This file exposes a few safe, specific
// file operations (list a folder, read a file, write a file) that the
// on-screen UI can ask for through a controlled messaging channel.

const { ipcMain } = require('electron');
const fs = require('fs'); // Node.js's built-in file system toolkit.
const path = require('path'); // Helpers for building/joining file paths correctly.
const os = require('os'); // Used below just for the current user's home folder path.

// Lists everything inside a folder (files and subfolders), similar to what
// you'd see opening that folder in File Explorer/Finder.
//
// This uses the non-blocking ("asynchronous") version of the file-reading
// function — fs.promises.readdir — instead of the plain fs.readdirSync one.
// The "Sync" version freezes this WHOLE background process (which also
// handles every open terminal's output and every browser tab's on-screen
// position) until the folder listing finishes reading from disk. That's
// invisible for a small folder, but for a big one (or a slow network
// drive) it can freeze terminals and browser tabs mid-scroll for as long
// as the listing takes. The "await fs.promises.readdir(...)" version below
// instead hands the actual disk work off to Node's own background thread
// pool and lets everything else in the app keep running while it waits.
async function readDir(dirPath) {
  // Ask the operating system for every item directly inside this folder.
  // "withFileTypes: true" means each item also tells us whether it's a
  // file or a folder, so we don't have to ask separately.
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  return entries
    .map((entry) => ({
      name: entry.name,
      path: path.join(dirPath, entry.name), // The full path to this item.
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }))
    // Sort the results the way a typical file browser does: all folders
    // first (alphabetically), then all files (alphabetically).
    .sort((a, b) => {
      if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
      return a.isDirectory ? -1 : 1;
    });
}

// Reads the full text contents of a single file (used, for example, when
// opening a file in the code editor pane). Uses the non-blocking
// fs.promises.readFile — see readDir's comment above for why the plain,
// blocking "Sync" versions are avoided everywhere in this file.
async function readFile(filePath) {
  return fs.promises.readFile(filePath, 'utf-8');
}

// Saves text content to a file, overwriting whatever was there before (used
// when you hit "save" in the code editor). Uses the non-blocking
// fs.promises.writeFile.
async function writeFile(filePath, content) {
  await fs.promises.writeFile(filePath, content, 'utf-8');
}

// The biggest binary file we'll read and hand over to the on-screen UI, in
// bytes (100 MB). Binary files travel to the renderer as one giant base64
// text string (see below) — base64 makes the data about a third BIGGER
// than the original file, and that whole string has to be built in memory
// and copied across the IPC bridge in one piece. Without a limit, opening
// an accidentally-huge PDF or spreadsheet could balloon memory usage by
// hundreds of megabytes and freeze/crash the on-screen window. Viewing a
// file bigger than this cleanly fails instead (see the viewer components'
// "Couldn't load this file" messages), rather than the app choking on it.
const MAX_BINARY_FILE_BYTES = 100 * 1024 * 1024;

// Reads a file as raw bytes and hands it back as "base64" — a way of
// encoding arbitrary binary data (like an image or a spreadsheet file) as
// plain text, since that's the only kind of data that can travel cleanly
// over the messaging bridge between the background process and the
// on-screen UI. This is used for file types where reading as plain text
// (like readFile above does) would corrupt the data — images, .xlsx
// spreadsheets, PDFs, etc. Uses the non-blocking fs.promises.readFile.
async function readFileBinary(filePath) {
  // Check the file's size BEFORE reading it, so an oversized file fails
  // fast with a clear error instead of us reading the whole thing into
  // memory first and only then deciding it was too big.
  const stats = await fs.promises.stat(filePath);
  if (stats.size > MAX_BINARY_FILE_BYTES) {
    throw new Error(`File is too large to open (${Math.round(stats.size / (1024 * 1024))} MB)`);
  }
  const buffer = await fs.promises.readFile(filePath);
  return buffer.toString('base64');
}

// Reports the current user's home folder (e.g. "C:\Users\you"). The
// on-screen UI has no way to know this on its own — unlike the background
// process, it can't ask the operating system directly — so it asks here.
// Used by the Terminal pane to expand a "~/..." path (as commonly printed
// by CLI tools to mean "relative to your home folder") into a real,
// checkable full path before treating it as a clickable file link.
function getHomeDir() {
  return os.homedir();
}

// Checks whether something (a file or a folder) exists at a given path,
// without caring which kind it is or reading its contents. This is used by
// the Terminal pane: before it underlines a piece of printed text as a
// clickable "file link," it first asks the background process to confirm
// that path is actually real, so random text that merely LOOKS like a path
// (e.g. "C:\this\is\not\real.txt" typed by a user, not a real file) doesn't
// get turned into a misleading clickable link.
async function pathExists(targetPath) {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    // fs.promises.access throws if the path doesn't exist (or we don't have
    // permission to see it) — either way, treat it as "doesn't exist" rather
    // than crashing the caller.
    return false;
  }
}

// Creates a new, empty file inside a folder — this is what runs when you
// right-click a folder in the Explorer and choose "New File," type a name,
// and press Enter. Refuses to overwrite something that's already there,
// since "New File" should never silently erase an existing file.
async function createFile(parentPath, name) {
  const targetPath = path.join(parentPath, name);
  // "wx" is a special file-opening mode meaning "write, but only if this
  // file doesn't already exist — fail instead of overwriting." That's
  // exactly the safety check we want here.
  const handle = await fs.promises.open(targetPath, 'wx');
  await handle.close();
  return targetPath;
}

// Creates a new, empty folder inside a parent folder — the "New Folder"
// counterpart to createFile above. fs.promises.mkdir already fails on its
// own if a folder with that name already exists there, which is the
// behavior we want (no silent overwrite).
async function createFolder(parentPath, name) {
  const targetPath = path.join(parentPath, name);
  await fs.promises.mkdir(targetPath);
  return targetPath;
}

// Renames a file or folder to a new NAME, keeping it in the same parent
// folder — this is the "type a new name and press Enter" rename the
// Explorer's inline rename feature uses. Takes just the new name (not a
// whole new path) since the on-screen UI has no way to safely build a
// correct full path itself (joining path pieces has OS-specific rules,
// like whether to use "\" or "/") — that's exactly the kind of detail this
// background process, not the web-page UI, should handle. Returns the full
// new path, so the caller can update anything that was tracking the old one
// (e.g. re-point an open editor tab at the renamed file).
async function renamePath(oldPath, newName) {
  const newPath = path.join(path.dirname(oldPath), newName);
  await fs.promises.rename(oldPath, newPath);
  return newPath;
}

// Permanently deletes a file or folder. "recursive: true" means that if the
// target is a folder, everything inside it gets deleted too (matching what
// most people expect "Delete" to do to a folder in a file browser). This is
// a destructive, unrecoverable action — the on-screen UI is expected to ask
// the person "are you sure?" BEFORE ever calling this.
async function deletePath(targetPath) {
  await fs.promises.rm(targetPath, { recursive: true, force: false });
}

// Wires up the functions above so the on-screen UI can call them.
// "ipcMain.handle" registers a named channel (like a phone extension
// number) — when the UI "calls" that channel name (e.g. 'fs:readFile'),
// Electron runs the matching function here in the background process and
// sends the result back. This is the security boundary that keeps random
// web content from directly touching your files — only these exact
// operations are allowed through.
function registerFileHandlers() {
  ipcMain.handle('fs:readDir', (_e, dirPath) => readDir(dirPath));
  ipcMain.handle('fs:readFile', (_e, filePath) => readFile(filePath));
  ipcMain.handle('fs:writeFile', (_e, filePath, content) => writeFile(filePath, content));
  ipcMain.handle('fs:readFileBinary', (_e, filePath) => readFileBinary(filePath));
  ipcMain.handle('fs:exists', (_e, targetPath) => pathExists(targetPath));
  ipcMain.handle('fs:homeDir', () => getHomeDir());
  ipcMain.handle('fs:createFile', (_e, parentPath, name) => createFile(parentPath, name));
  ipcMain.handle('fs:createFolder', (_e, parentPath, name) => createFolder(parentPath, name));
  ipcMain.handle('fs:rename', (_e, oldPath, newName) => renamePath(oldPath, newName));
  ipcMain.handle('fs:delete', (_e, targetPath) => deletePath(targetPath));
}

module.exports = { registerFileHandlers };
