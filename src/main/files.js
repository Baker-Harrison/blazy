// This file runs in the app's "main" process — the background part of the
// Electron app that has full access to the computer's file system (unlike
// the on-screen "renderer" process, which is sandboxed for security and
// can't read/write files directly). This file exposes a few safe, specific
// file operations (list a folder, read a file, write a file) that the
// on-screen UI can ask for through a controlled messaging channel.

const { ipcMain } = require('electron');
const fs = require('fs'); // Node.js's built-in file system toolkit.
const path = require('path'); // Helpers for building/joining file paths correctly.

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
}

module.exports = { registerFileHandlers };
