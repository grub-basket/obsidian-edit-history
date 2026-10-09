import {
    AbstractInputSuggest,
    App,
    ButtonComponent,
    DropdownComponent,
    FileView,
    Modal,
    normalizePath,
    Notice,
    Plugin, 
    PluginSettingTab, 
    setIcon,
    Setting, 
    TAbstractFile,
    TextComponent,
    TFile,
    TFolder,
    ToggleComponent,
    Vault
} from "obsidian";
import { DiffMatchPatch, Diff } from "diff-match-patch-ts";
// diff-match-patch-ts doesn't export properly module enums, it uses a const
// enum (instead of a non const enum) which is removed at compile time and not
// visible by importers:
//  - Without isolatedModules set it errors out with "Cannot access ambient
//    const enums when the '--isolatedModules' flag is provided" 
//  - With isolated isolatedModules set to false in tsconfig.json, when
//    importing DiffOp the DiffOp object exists but it's null and the defines
//    cannot be used 
// Copy them here from diff-op.enum.d.ts
const enum DiffOp {
    Delete = -1,
    Equal = 0,
    Insert = 1
}

// @ts-ignore: Complains about default export this way, but since jszip 3.10
// this is the recommended way
import JSZip from "jszip";


// Debuglevels in increasing severity so messages >= indexOf(debugLevel) will be
// shown
const debugLevels = ["debug", "info", "warn", "error"];

let logError = function(message?: any, ...optionalParams: any[]) {};
let logWarn = function(message?: any, ...optionalParams: any[]) {};
// Note console.log is an alias of console.info
let logInfo = function(message?: any, ...optionalParams: any[]) {};
let logDbg = function(message?: any, ...optionalParams: any[]) {};

function hookLogFunctions(debugLevelIndex: number, tag: string) {
    logInfo("hookLogFunctions", debugLevelIndex, tag);

    const logIgnore = function(message?: any, ...optionalParams: any[]) {};
    logError = (debugLevelIndex <= debugLevels.indexOf("error")) ? 
        console.error.bind(console, tag + "[ERROR]:") :
        logIgnore;
    logWarn = (debugLevelIndex <= debugLevels.indexOf("warn")) ?
        console.warn.bind(console, tag + "[WARN]:") :
        logIgnore;
    logInfo = (debugLevelIndex <= debugLevels.indexOf("info")) ?
        console.info.bind(console, tag + "[INFO]:") :
        logIgnore;
    logDbg = (debugLevelIndex <= debugLevels.indexOf("debug")) ?
        console.debug.bind(console, tag + "[DEBUG]:") :
        logIgnore;
}

function debugbreak() {
    debugger;
}

 const htmlChars :  { [key: string]: string } = {
    "&" : "&amp;",
    "\"": "&quot;",
    "'": '&#39;',
    "<" : '&lt;',
    ">": '&gt;',
    "\n": "<br>\n",
 };
 const htmlCharsRegexp = new RegExp(Object.keys(htmlChars).join("|"), "g");

 const htmlWhitespaceChars : { [key: string]: string } = {
     ...htmlChars,
    "\t": "&rarr;\t",
    " ": "&middot;",
    "\n": "&para;<br>\n"
 };
 const htmlWhitespaceCharsRegexp = new RegExp(Object.keys(htmlWhitespaceChars).join("|"), "g");

function htmlEncode(str: string, whitespace: boolean): string {
    // XXX or use document.createTextNode(str).textContent?
    // This can be a performance hotspot, so use an efficient way of replacing
    // multiple strings in a single pass
    return (whitespace) 
        ? str.replace(htmlWhitespaceCharsRegexp, c => htmlWhitespaceChars[c])
        : str.replace(htmlCharsRegexp, c => htmlChars[c]);
}

enum DiffDisplayFormat {
    Raw        = "RAW",
    Timeline   = "TIMELINE",
    Inline     = "INLINE",
    Horizontal = "HORIZONTAL",
    Vertical   = "VERTICAL",
};

const diffDisplayFormatToString: Record<DiffDisplayFormat, string> = {
    [DiffDisplayFormat.Raw]        : "raw",
    [DiffDisplayFormat.Timeline]   : "timeline",
    [DiffDisplayFormat.Inline]     : "inline",
    [DiffDisplayFormat.Horizontal] : "side by side",
    [DiffDisplayFormat.Vertical]   : "top by bottom",
};

interface EditHistorySettings {
    minSecondsBetweenEdits: string;
    maxEdits: string;
    maxEditAge: string;
    maxHistoryFileSizeKB: string;
    editHistoryRootFolder: string;
    extensionWhitelist: string;
    // Comma separated list of extensions ever seen in the vault by the
    // extension scan, so new extensions can be detected and notified
    knownExtensions: string;
    // How often to scan the vault for new extensions: "off", "daily", "weekly"
    extensionScanInterval: string;
    // Epoch in milliseconds of the last extension scan, 0 if never scanned
    lastExtensionScanTime: number;
    substringBlacklist: string;
    // Skip capturing history while Obsidian Sync is actively syncing, to avoid
    // the feedback loop where a synced note write triggers a history write that
    // then has to be synced (and can conflict across devices)
    pauseDuringSync: boolean;
    showOnStatusBar: boolean;
    diffDisplayFormat: string;
    showWhitespace: boolean;
    debugLevel: string;
    // XXX Have color setting for addition fore/back, deletion fore/back 
}

const DEFAULT_SETTINGS: EditHistorySettings = {
    minSecondsBetweenEdits: "60",
    maxEditAge: "0",
    maxEdits: "0",
    maxHistoryFileSizeKB: "0",
    editHistoryRootFolder: "",
    extensionWhitelist: ".md, .base, .canvas, .txt, .csv, .json, .yaml, .yml, .js, .css, .htm, .html",
    knownExtensions: "",
    extensionScanInterval: "weekly",
    lastExtensionScanTime: 0,
    substringBlacklist: "",
    pauseDuringSync: true,
    showOnStatusBar: true,
    diffDisplayFormat: DiffDisplayFormat.Inline,
    showWhitespace: true,
    debugLevel: "warn"
}

const EDIT_HISTORY_FILE_EXT = ".edtz";

// XXX Use Github actions to release plugin 
//     See https://docs.obsidian.md/Plugins/Releasing/Release+your+plugin+with+GitHub+Actions
//     See https://github.com/marcusolsson/obsidian-projects/blob/main/.github/workflows/release.yml

// XXX Ignore changes if not enough diffs/too small?

// XXX Allow merging entries in the edit history file older than a given time,
//     at a given granularity

// XXX Feed the editor undo stack with the contents of the history file? (could
//     be done without private apis by inserting the text in edit history order at file
//     load, will probably need a flag to prevent from storing double history)

// XXX Allow management in the edit history modal, merging diffs, deleting, deleting all historyç

// XXX tgz reduces size by half, use native browser gzip plus tar? (at the
//     expense of having to uncompress the whole file in memory, not clear jszip
//     does that already anyway?)
//     See https://stackoverflow.com/questions/65446607/how-do-i-extract-data-from-a-tar-gz-file-stored-in-the-cloud-from-a-browser


export default class EditHistory extends Plugin {
    settings: EditHistorySettings;
    statusBarItemEl: HTMLElement;

    // Minimum number of milliseconds between edits or Infinity, if a
    // modification occurs before that time will be ignored at this moment and
    // lumped with later modifications once the minimum time has passed and a
    // new modification is done This means that the edit file may not contain
    // the latest version Note that because of the current filename being
    // derived from the epoch in seconds, changes done less than one second
    // apart are ignored and lumped with the next change 
    minMsBetweenEdits: number;
    // Maximum number of age in milliseconds or Infinity
    maxEditAgeMs: number;
    // Maximum number of edits to keep or Infinity
    maxEdits: number;
    // Maximum size in bytes of the history file or Infinity
    maxEditHistoryFileSize: number;
    // Whitelist of note filename extensions to store edit history for. In
    // lowercase and including the initial dot. Empty for all.
    extensionWhitelist: string[];
    // Extensions ever seen in the vault by the extension scan. In lowercase
    // and including the initial dot.
    knownExtensions: string[];
    // Blacklist of note filepath substrings not to store edit history for. In
    // lowercase, empty for none. Note obsidian normalizes paths to use forward
    // slash, so substrings for paths should use forward slashes
    substringBlacklist: string[];
    // Vault folder holding all the history files, mirroring the note folders,
    // or "" to keep each history file alongside its note. Set from the
    // "History folder" setting, which moves existing history files over
    editHistoryRootFolder: string;
    // Folders whose history write failure was already reported this session,
    // so a folder that can't take history files shows one notice, not one per
    // edit
    reportedWriteFailureFolders: Set<string> = new Set();
    // Runs a task on the vault event queue (set in onload), so history folder
    // moves don't interleave with history writes
    runOnVaultQueue: (task: () => Promise<void>) => Promise<void>;

    /**
     * @return true if an edit history file should be kept for this file
     */
    keepEditHistoryForFile(file: TAbstractFile): boolean {
        // Don't keep edit history for folders
        if (!(file instanceof TFile)) {
            return false;
        }

        // The vault will call on change callback on the edit history file when
        // modified using the Obsidian API, trap it so it's ignored downstream
        if (file.name.endsWith(EDIT_HISTORY_FILE_EXT)) {
            return false;
        }

        // Nothing inside the history folder is a note
        if ((this.editHistoryRootFolder != "") && file.path.startsWith(this.editHistoryRootFolder + "/")) {
            return false;
        }

        // Don't keep edit history file for filepaths containing the substring
        // blacklist
        if (this.substringBlacklist.length > 0) {
            const filepath = file.path.toLowerCase();
            for (let substring of this.substringBlacklist) {
                if (filepath.contains(substring)) {
                    logInfo("Not keeping history file '" + filepath + "' due to blacklist substring '" + substring + "'");
                    return false;
                }
            }
        }

        // Keep an edit history file for all files if there are no extensions,
        // otherwise just for the extensions that match
        if (this.extensionWhitelist.length == 0) {
            return true;
        } else {
            const filename = file.name.toLowerCase();
            for (let ext of this.extensionWhitelist) {
                if (filename.endsWith(ext)) {
                    return true;
                }
            }
        }
        return false;
    }

    keepEditHistoryForActiveFile(): boolean {
        const activeFile = this.app.workspace.getActiveFile();

        return ((activeFile != null) && (this.keepEditHistoryForFile(activeFile)));
    }

    /**
     * @return true if the Obsidian Sync core plugin is enabled and currently
     *         syncing. Uses the sync plugin's internal instance, which is not a
     *         public API, so it's wrapped in a try/catch and treated as "not
     *         syncing" if the shape ever changes. Only detects the official
     *         Obsidian Sync; filesystem/third-party sync isn't observable here.
     */
    isObsidianSyncing(): boolean {
        try {
            const sync = (this.app as any).internalPlugins?.plugins?.sync;
            if ((sync == null) || !sync.enabled) {
                return false;
            }
            return !!sync.instance?.syncing;
        } catch (e) {
            return false;
        }
    }

    /**
     * @return the file shown in the currently active leaf, or null if the
     *         active leaf isn't a file view. Reads the active FileView's file
     *         rather than workspace.getActiveFile(), which falls back to the
     *         last opened note when a non-file view (eg a plugin's own view) is
     *         focused.
     */
    getActiveFileViewFile(): TFile | null {
        const view = this.app.workspace.getActiveViewOfType(FileView);
        return (view != null) ? view.file : null;
    }

    /**
     * Refresh the status bar for the currently active file. Called on load and
     * whenever the active leaf or open file changes, so it follows the file the
     * user is looking at rather than the last saved one. Distinguishes: a
     * tracked file's edit count, a file whose type isn't tracked, and a
     * non-file view (a custom editor) with no file to track.
     */
    async updateStatusBar() {
        if ((this.statusBarItemEl == null) || !this.settings.showOnStatusBar) {
            return;
        }

        let text: string;
        let tooltip: string;
        // Only the tracked-file state opens the modal on click; mirror that on
        // the cursor so the other states don't look clickable.
        let clickable = false;
        const file = this.getActiveFileViewFile();
        if (file == null) {
            // No file view is active (a custom editor / non-file view, or an
            // empty tab), so there's nothing to keep history for.
            text = "no file";
            tooltip = "Edit History: no file open to track";
        } else if (!this.keepEditHistoryForFile(file)) {
            // A file, but its type isn't in the tracked formats.
            text = "not tracked";
            tooltip = "Edit History: this file type isn't tracked (see the plugin settings)";
        } else {
            const zipFilepath = this.getEditHistoryFilepath(file.path);
            const zipFile = this.app.vault.getAbstractFileByPath(zipFilepath);
            let numEdits = 0;
            if ((zipFile != null) && (zipFile instanceof TFile)) {
                try {
                    const zip = new JSZip();
                    await zip.loadAsync(await this.app.vault.readBinary(zipFile));
                    zip.forEach(() => { numEdits++; });
                } catch (e) {
                    logError("Error reading edit history for status bar", zipFilepath, e);
                    this.statusBarItemEl.setText("? edits");
                    this.statusBarItemEl.setAttribute("aria-label", "Edit History: couldn't read the history file");
                    this.statusBarItemEl.toggleClass("mod-clickable", false);
                    return;
                }
            }
            text = numEdits + " edits";
            tooltip = "Show edit history for this file";
            clickable = true;
        }
        this.statusBarItemEl.setText(text);
        this.statusBarItemEl.setAttribute("aria-label", tooltip);
        this.statusBarItemEl.toggleClass("mod-clickable", clickable);
    }

    getEditHistoryFilepath(filepath: string): string {
        return normalizePath(this.editHistoryRootFolder + "/" + filepath + EDIT_HISTORY_FILE_EXT);
    }

    /**
     * @return the history folder setting value in canonical form: "" for
     *         alongside the notes, otherwise a vault path without leading or
     *         trailing slashes
     */
    normalizeHistoryFolder(folder: string): string {
        const trimmed = folder.trim().replace(/^[/\\]+|[/\\]+$/g, "");
        return (trimmed == "") ? "" : normalizePath(trimmed);
    }

    /**
     * @return why the given (normalized) folder can't be the history folder,
     *         or null if it can
     */
    checkHistoryFolder(folder: string): string | null {
        if (folder == "") {
            return null;
        }
        // Obsidian doesn't index dot folders, so history files there could be
        // written but never found again
        if (folder.split("/").some(part => part.startsWith("."))) {
            return "Folder names can't start with a dot: Obsidian doesn't see dot folders, so the history saved there couldn't be read back.";
        }
        const current = this.editHistoryRootFolder;
        if ((current != "") && (folder.startsWith(current + "/") || current.startsWith(folder + "/"))) {
            return "The new history folder can't be inside the current one, or contain it.";
        }
        const existing = this.app.vault.getAbstractFileByPath(folder);
        if (existing instanceof TFile) {
            return "\"" + folder + "\" is a file, not a folder.";
        }
        if (existing instanceof TFolder) {
            // History paths mirror note paths, so notes living in the history
            // folder would get mixed up with the history files
            let hasNotes = false;
            Vault.recurseChildren(existing, (child: TAbstractFile) => {
                if ((child instanceof TFile) && !child.name.endsWith(EDIT_HISTORY_FILE_EXT)) {
                    hasNotes = true;
                }
            });
            if (hasNotes) {
                return "\"" + folder + "\" already has notes in it. Pick a new or empty folder.";
            }
        }
        return null;
    }

    /**
     * @return the history files to move when the history folder changes from
     *         oldFolder to newFolder, as [file, new path] pairs
     */
    planHistoryFolderMoves(oldFolder: string, newFolder: string): [TFile, string][] {
        const prefix = (oldFolder == "") ? "" : oldFolder + "/";
        const moves: [TFile, string][] = [];
        for (const file of this.app.vault.getFiles()) {
            if (!file.path.endsWith(EDIT_HISTORY_FILE_EXT) || !file.path.startsWith(prefix)) {
                continue;
            }
            const notePath = file.path.slice(prefix.length, file.path.length - EDIT_HISTORY_FILE_EXT.length);
            // When the history files are next to the notes, only those whose
            // note exists are known to be "alongside" ones: a history file
            // left behind in an old history folder (eg one that couldn't be
            // moved out) would otherwise be nested inside the new one
            if ((oldFolder == "") && (this.app.vault.getAbstractFileByPath(notePath) == null)) {
                continue;
            }
            const newPath = normalizePath(newFolder + "/" + notePath + EDIT_HISTORY_FILE_EXT);
            if (newPath != file.path) {
                moves.push([file, newPath]);
            }
        }
        return moves;
    }

    /**
     * Switch the history folder and move the existing history files there.
     * Runs on the vault event queue so no history write lands in between.
     * Never overwrites: a history file already at the destination is left
     * where it was.
     */
    async changeHistoryFolder(newFolder: string): Promise<void> {
        await this.runOnVaultQueue(async () => {
            const oldFolder = this.editHistoryRootFolder;
            const moves = this.planHistoryFolderMoves(oldFolder, newFolder);
            this.settings.editHistoryRootFolder = newFolder;
            try {
                await this.saveSettings();
            } catch (e) {
                // Nothing moved yet: put the old folder back so the setting
                // and the files stay in agreement
                logError("Can't save the history folder setting", e);
                this.settings.editHistoryRootFolder = oldFolder;
                this.parseSettings(this.settings);
                new Notice("Edit History: couldn't save the new history folder, so nothing was moved. " + ((e instanceof Error) ? e.message : String(e)), 0);
                return;
            }
            this.reportedWriteFailureFolders.clear();

            let moved = 0;
            let copied = 0;
            const skipped: string[] = [];
            const failed: string[] = [];
            for (const [file, newPath] of moves) {
                if (this.app.vault.getAbstractFileByPath(newPath) != null) {
                    skipped.push(file.path);
                    continue;
                }
                const dirpath = newPath.substring(0, newPath.lastIndexOf("/"));
                if (dirpath != "") {
                    await this.app.vault.createFolder(dirpath).catch(() => null);
                }
                try {
                    await this.app.vault.rename(file, newPath);
                    moved++;
                } catch (e) {
                    // A rename can be refused, eg Folder Bridge doesn't move
                    // files out of a mounted folder. Copy instead and leave the
                    // original in place
                    logWarn("Can't move history file, copying instead", file.path, e);
                    try {
                        await this.app.vault.createBinary(newPath, await this.app.vault.readBinary(file));
                        copied++;
                    } catch (e2) {
                        logError("Can't copy history file", file.path, e2);
                        failed.push(file.path);
                    }
                }
            }

            const where = (newFolder == "") ? "next to each note" : "to \"" + newFolder + "\"";
            let message = "Edit History: history files are now saved " + where + ".";
            if (moves.length > 0) {
                message += " Moved " + moved + " of " + moves.length + " existing history files.";
            }
            if (copied > 0) {
                message += " " + copied + " couldn't be moved, so they were copied and the originals left in place.";
            }
            if (skipped.length > 0) {
                message += " " + skipped.length + " were left where they were because a history file already existed at the new place.";
                logWarn("History files left in place (destination exists):", skipped);
            }
            if (failed.length > 0) {
                message += " " + failed.length + " couldn't be moved or copied; their history won't show until the folder is changed back.";
                logError("History files that couldn't be moved:", failed);
            }
            if ((skipped.length > 0) || (failed.length > 0)) {
                message += " The file list is in the developer console.";
            }
            new Notice(message, (moved == moves.length) ? 5000 : 0);
        });
    }

    /**
     * Tell the user, once per folder per session, that a history file
     * couldn't be written, eg because the note lives in a read-only or
     * filtered folder (like a Folder Bridge "notes only" mount). Without this
     * the failure only reaches the console and history silently stops
     */
    reportHistoryWriteFailure(notePath: string, error: unknown) {
        logError("Can't save edit history for", notePath, error);
        const folder = notePath.substring(0, notePath.lastIndexOf("/"));
        if (this.reportedWriteFailureFolders.has(folder)) {
            return;
        }
        this.reportedWriteFailureFolders.add(folder);
        const reason = (error instanceof Error) ? error.message : String(error ?? "unknown error");
        let message = "Edit History couldn't save the history of \"" + notePath + "\": " + reason;
        if (this.editHistoryRootFolder == "") {
            message += "\n\nTo keep history for notes in this folder, set a History folder in Edit History's settings. History is then saved inside this vault instead of next to each note.";
        }
        new Notice(message, 0);
    }

    getEditCompressedSize(zip: JSZip, filepath: string): number {
        // The only way of getting the file size is by accessing
        // the internal field _data
        // See https://github.com/Stuk/jszip/issues/247
        const file = zip.file(filepath);
        // Guard against a missing entry (eg the name doesn't round trip after
        // normalization) or an unexpected JSZip internal shape, so callers in
        // the purge and calendar paths don't throw on a corrupt history file
        if ((file == null) || (file._data == null)) {
            logWarn("Unable to get compressed size for edit", filepath);
            return 0;
        }
        return file._data.compressedSize;
    }

    /**
     * @return true if the zip entry name is a well formed edit filename, ie a
     *         base36 UTC epoch optionally ending in "$" for full entries. Entry
     *         names come from the (possibly externally synced or corrupt) edit
     *         history file, validate them before parsing so a bad name can't
     *         inject a NaN epoch into sorting, purging, or the calendar.
     */
    isValidEditFilename(editFilename: string): boolean {
        return /^[0-9a-z]+\$?$/.test(editFilename) && Number.isFinite(this.getEditEpoch(editFilename));
    }

    getEditEpoch(editFilename: string): number {
        return parseInt(editFilename, 36) * 1000;
    }

    getEditDate(editFilename: string): Date {
        return new Date(this.getEditEpoch(editFilename));
    }

    getEditLocalDateStr(editFilename: string): string {
        return this.getEditDate(editFilename).toLocaleString();
    }

    getEditFileTime(editFilename: string): number {
        // Note this ignores the hh:mm:ss part of the time
        let d = this.getEditDate(editFilename);
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const t = d.getTime();
        return t;
    }

    getEditIsDiff(editFilename: string): boolean {
        return !editFilename.endsWith("$");
    }
    
    buildEditFilename(mtime: number, isDiff: boolean): string {
        const utcepoch = Math.floor(mtime / 1000);
        const editFilename = utcepoch.toString(36) + (isDiff ? "" : "$"); 
        return editFilename;
    }

    /**
     * Sort in place
     */
    sortEdits(filenames: string[], descending: boolean = true) {
        const i = descending ? 1 : -1; 
        // Note this cannot do straight alphabetical sort on the base-36 encoded
        // epochs since theoretically strings could be different lengths, convert
        // to epoch before sorting
        // XXX Could do .length plus < checks, though, removing trailing $ when
        //     necessary)
        filenames.sort((a,b) => i * (this.getEditEpoch(b) - this.getEditEpoch(a)));
    }

    commaSeparatedToList(s: string) {
        let list : string[] = [];
        // typescript string.split() returns 1-element array with empty item if
        // s is empty, return empty list instead. Note if s is whitespace still
        // want to return a single element list with a whitespace item.
        if (s != "") {
            list = s.split(",");
            for (let i in list) {
                list[i] = list[i].trim().toLowerCase();
            }
        }
        
        return list;
    }

    /**
     * @return the extension in canonical whitelist form: trimmed, lowercase,
     *         with the initial dot, or "" if there's nothing left after
     *         cleaning up
     */
    normalizeExtension(ext: string): string {
        ext = ext.trim().toLowerCase().replace(/^\.+/, "");
        return (ext == "") ? "" : "." + ext;
    }

    /**
     * @return sorted list of the extensions of all the files currently in the
     *         vault, in canonical whitelist form, ignoring edit history files
     *         and files without extension
     */
    getVaultExtensions(): string[] {
        const exts = new Set<string>();
        for (const file of this.app.vault.getFiles()) {
            if (file.name.endsWith(EDIT_HISTORY_FILE_EXT)) {
                continue;
            }
            if (file.extension != "") {
                exts.add("." + file.extension.toLowerCase());
            }
        }
        return Array.from(exts).sort();
    }

    /**
     * Scan the vault for extensions not seen in previous scans and record them
     * in the known extensions setting. Extensions stay known even if all files
     * with that extension are later deleted, so they are not re-notified and
     * can still be re-added from the settings.
     *
     * @param notify show a Notice if new extensions are found
     * @return the list of extensions new to this scan
     */
    async scanVaultExtensions(notify: boolean): Promise<string[]> {
        const known = new Set(this.knownExtensions);
        const newExtensions = this.getVaultExtensions().filter(ext => !known.has(ext));

        this.settings.lastExtensionScanTime = Date.now();
        if (newExtensions.length > 0) {
            newExtensions.forEach(ext => known.add(ext));
            this.settings.knownExtensions = Array.from(known).sort().join(", ");
            if (notify) {
                // Empty whitelist means all files are stored
                const stored = (this.extensionWhitelist.length == 0) ||
                    newExtensions.every(ext => this.extensionWhitelist.includes(ext));
                new Notice("Edit History: new file types found in the vault: " +
                    newExtensions.join(", ") + "\nEdits for these are " +
                    (stored ? "" : "not ") +
                    "being stored, review the tracked file types in the Edit History settings.");
            }
        }
        await this.saveSettings();

        logInfo("scanVaultExtensions new extensions", newExtensions);
        return newExtensions;
    }

    /**
     * Run the periodic extension scan if it's enabled and due. The first ever
     * scan just records the current extensions without notifying, so vaults
     * updating to this version aren't notified about extensions that were
     * already there.
     */
    async scanVaultExtensionsIfDue() {
        // The first scan seeds the baseline silently, even when the periodic
        // scan is off, so the settings can show the untracked file types and a
        // later first periodic scan doesn't notify about pre-existing ones
        if (this.settings.lastExtensionScanTime == 0) {
            await this.scanVaultExtensions(false);
            return;
        }
        const scanIntervalMs = { "daily" : 24 * 60 * 60 * 1000, "weekly" : 7 * 24 * 60 * 60 * 1000 }[this.settings.extensionScanInterval];
        if (scanIntervalMs == undefined) {
            // "off" or unknown value
            return;
        }
        if (Date.now() - this.settings.lastExtensionScanTime >= scanIntervalMs) {
            await this.scanVaultExtensions(true);
        }
    }

    async addTrackedExtension(ext: string) {
        ext = this.normalizeExtension(ext);
        if (ext == "") {
            return;
        }
        const list = this.commaSeparatedToList(this.settings.extensionWhitelist).filter(e => e != "");
        if (!list.includes(ext)) {
            list.push(ext);
            this.settings.extensionWhitelist = list.join(", ");
            // Make sure a manually added extension can be re-added from the
            // untracked row if it's later removed, even if no file with that
            // extension exists in the vault yet
            const known = new Set(this.knownExtensions);
            if (!known.has(ext)) {
                known.add(ext);
                this.settings.knownExtensions = Array.from(known).sort().join(", ");
            }
            await this.saveSettings();
        }
    }

    async removeTrackedExtension(ext: string) {
        // Remove both the raw and the normalized form, so legacy whitelist
        // entries without the initial dot can be removed too
        const normalized = this.normalizeExtension(ext);
        const list = this.commaSeparatedToList(this.settings.extensionWhitelist).filter(e => (e != "") && (e != ext) && (e != normalized));
        this.settings.extensionWhitelist = list.join(", ");
        await this.saveSettings();
    }

    parseSettings(settings: EditHistorySettings) {
        // Hook log functions as early as possible so any console output is seen
        // if enabled
        hookLogFunctions(debugLevels.indexOf(settings.debugLevel), "EditHistoryPlugin");

        this.minMsBetweenEdits = parseInt(settings.minSecondsBetweenEdits) * 1000 || Infinity; 
        this.maxEdits = parseInt(settings.maxEdits) || Infinity;
        this.maxEditAgeMs = parseInt(settings.maxEditAge) * 1000 || Infinity;
        // XXX This needs to remove all edit history files when
        //     extensions/substrings are removed/added?
        this.extensionWhitelist = this.commaSeparatedToList(settings.extensionWhitelist)
        this.knownExtensions = this.commaSeparatedToList(settings.knownExtensions);
        this.substringBlacklist = this.commaSeparatedToList(settings.substringBlacklist);
        this.maxEditHistoryFileSize = parseInt(settings.maxHistoryFileSizeKB) * 1024 || Infinity;
        this.editHistoryRootFolder = settings.editHistoryRootFolder;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.parseSettings(this.settings);
    }

    // Settings changed on disk, eg synced from another device: pick them up,
    // so a history folder chosen there is used here too
    async onExternalSettingsChange() {
        await this.loadSettings();
        this.statusBarItemEl?.toggle(this.settings.showOnStatusBar);
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.parseSettings(this.settings);
    }

    async onload() {
        // Load settings as early as possible console output is seen if enabled
        await this.loadSettings();

        // XXX Make this a member variable?
        let dmpobj = new DiffMatchPatch();

        logInfo("onLoad");

        // Serialize all vault event handling through a single FIFO queue.
        // Obsidian delivers the modify/rename/delete callbacks synchronously in
        // order but does not await them, so the async handler bodies can
        // otherwise interleave and even finish out of order across event types
        // (eg an in-flight modify writing back the old history file path after
        // a rename has already moved it). Enqueuing synchronously in the event
        // callback and running each task to completion before the next keeps
        // the handlers running in Obsidian's delivery order, which is the
        // correct one. Edits are human-paced so serializing across files costs
        // nothing in practice.
        let handlerQueue: Promise<void> = Promise.resolve();
        const enqueue = (task: () => Promise<void>): void => {
            handlerQueue = handlerQueue
                .then(task)
                .catch((e) => logError("Error in edit history vault handler", e));
        };
        this.runOnVaultQueue = (task: () => Promise<void>) => new Promise<void>((resolve) => {
            enqueue(() => task().finally(resolve));
        });
        const processModify = async (fileOrFolder: TAbstractFile, force: boolean = false, enqueuedPath?: string, enqueuedMtime?: number) => {
            logInfo("vault modify", fileOrFolder.path);
            // This reports any files or folders modified via the api, ignore
            // non whitelisted files/folders
            if (!(this.keepEditHistoryForFile(fileOrFolder))) {
                logDbg("Ignoring non whitelisted file", fileOrFolder.path);
                return;
            }

            if ((this.minMsBetweenEdits == Infinity) && !force) {
                // Don't generate a history file when manual saving is on until
                // it's done manually. This prevents generating empty history
                // files below for files that may never be manually saved
                logDbg("Ignoring due to manual saving enabled")
                return;
            }

            let file = fileOrFolder as TFile;
            // Edit time captured synchronously when this modify was enqueued, so
            // a later modify that bumps file.stat.mtime before this runs can't
            // retime this entry (the vault fires the callback synchronously, so
            // the enqueue-time value is the edit's true mtime).
            const mtime = enqueuedMtime ?? file.stat.mtime;
            // Use the note path captured when this modify was enqueued, not the
            // live file.path: a rename queued behind this modify mutates
            // file.path before this runs, which would send the history file to
            // the post-rename path and collide with the rename handler's move
            // (leaving an orphan). The captured path keeps the history file
            // where the note was when the edit happened; the rename handler then
            // moves it to the new path.
            let zipFilepath = this.getEditHistoryFilepath(enqueuedPath ?? file.path);
            let zipFile = this.app.vault.getAbstractFileByPath(zipFilepath);
            if ((zipFile != null) && !(zipFile instanceof TFile)) {
                // Not a file, error
                logError("Edit history file is not a file", zipFilepath);
                return;
            }
            
            // XXX Cleanup all naming:
            //
            //     - revision/edit: each individual file stored inside the zip
            //       file containg a dmp patch in text form (collection of
            //       contextless dmp diffs). Has a unique date and time. The
            //       file stores the diff between this version and the previous
            //       one and has the date at which the current version was
            //       saved. First the whole version is saved verbatim without
            //       diffs, when the next version comes across, then the current
            //       version is diffed against the verbatim version and the
            //       verbatin replaced with that diff
            //
            //     - diff: a version has one or more diffs (or none if the file
            //       was stored verbatim).
            //
            //     - dmp diff: A dmp diff is context-full, it can be traversed.
            //       Each diff has one DiffOp operation (delete, equal, insert)
            //       with one or more lines of payload
            //
            //     - dmp patch: A dmp a patch is context-less, ie a set of diffs
            //       that requires the file in order to be applied. Only has
            //       delete and insert operations, equal has been removed so
            //       they cannot be applied without the original file

            // Ignore changes less than a given time ago unless forcing (ie event
            // was triggered explicitly in order to force saving pending edits)
            // XXX Abstract this and remove the force flag?
            
            // Note this uses the zipFile time and not the entry time (which
            // requires reading the zipFile and has a DOS date 2-second
            // inaccuracy and is local time) or the name to timestamp
            // translation (which is accurate and UTC but requires hitting the
            // zipFile)
            
            // XXX The zipFile date could be cached for later invocations to
            //     early exit above without even decoding the zipfile path? (but
            //     requires a per zipFile cache)
            
            // XXX Still there can be some minor inaccuracy because the zipFile
            //     date is not reset, see
            //     https://github.com/antoniotejada/obsidian-edit-history/issues/15

            // XXX This has the issue that edits that are far apart in time 
            //      could appear merged together:
            //      1) An edit A was done at time T but it was too close to
            //         the previous edit so it's ignored
            //      2) Edit B is done hours later, now edit A and B are
            //         stored as a single edit
            //     This should either 
            //     a) merge the current edit with the previous one as long
            //        as not enough time has passed (inefficient since it will
            //        be doing idle work on every modification) 
            //     b) fire a timer on every modification, and only save from
            //        that timer. Probably delay that timer if already running
            //        so edits are only saved after "n seconds of idle time"
            //        Using a timer also avoids any date checks on the file
            //        This needs to watch out for any race conditions with a
            //        simultaneous change, hopefully none since the file api
            //        should be safe? (and typescript should be single
            //        threaded) but still the file could have been deleted in 
            //        the interim? Note this approach will still merge
            //        unrelated edits when the app is closed before the timer
            //        expires. The timer needs to be per file/editor?
            //     See https://github.com/antoniotejada/obsidian-edit-history/issues/9
            if (!force &&
                (zipFile != null) && ((mtime - zipFile.stat.mtime) < this.minMsBetweenEdits)) {
                logDbg("Need to pass",
                    (this.minMsBetweenEdits - (mtime - zipFile.stat.mtime)) / 1000, "s between edits, ignoring");
                return;
            }

            // Ideally, in order to minimize history file size, the history file
            // would store only diffs and then, at modify time:
            // 1. recreate the currently stored version applying the last stored
            //    diff to the pre-modified file
            // 2. compute the diff between the pre-modified file and the
            //    modified file
            // 3. store that diff 
            //
            // Unfortunately there's no way to get the pre-modified version here
            // since when the callback is called, the file has already been
            // modified, so only the modified version is available. The solution
            // is to always store the last modified version in full and then
            // when a new modification is done, replace that version with the
            // diff and store the full version, rinse repeat.
            //
            // Storing the latest version in full in the history file has
            // benefits, though:
            // - The history file can act as a backup even if the main file is
            //   deleted
            // - The history file is still valid even if the original file is
            //   modified from outside Obsidian
            
            // XXX Another option that would likely make the Edit History File
            //     smaller is to do the diffs backwards and store the first
            //     version fully and build diffs on top of that first version.
            //     That would make saving slower, though, since it will have to
            //     rebuild the history from the start on every save, or cache
            //     that the first time. Would also make trimming the history
            //     file slightly harder (needs to rebuild the version that will
            //     now become the first version when older versions are removed
            //     from the file).

            // Load the modified file data
            let fileData = await this.app.vault.read(file);
            let newFilename = this.buildEditFilename(mtime, false);

            // Create or open the zip with the versions of this file
            let zip: JSZip = new JSZip();
            let zipData = (zipFile == null) ? null : await this.app.vault.readBinary(zipFile);
            let numEdits = 0;
            if (zipData != null) {
                // There's an existing zip file, update the most recent
                // edit in the zip from full to diff wrt the incoming
                // file
                await zip.loadAsync(zipData);
                
                // Read the latest edit which, if it exists, it should
                // be stored in full (vs diffed)
                
                // jszip seems to return newest files first, so arguably it
                // would be enough with getting the first file in the list,
                // but go through all of them and sort for robustness
                let filepaths:string[] = [];
                zip.forEach(function (relativePath:string, file: JSZip.JSZipObject) {
                    filepaths.push(relativePath);
                });
                // Ignore entries that aren't well formed edit filenames so a
                // corrupt or externally tampered history file can't corrupt the
                // purge ordering (NaN epochs make the sort non deterministic)
                filepaths = filepaths.filter(fp => this.isValidEditFilename(fp));

                // Sort most recent first
                this.sortEdits(filepaths);

                // Purge entries, oldest first
                let todayUTC = new Date().getTime();
                let zipFileSize = zipData.byteLength;
                while (filepaths.length > 0) {
                    let purge = false;
                    // Note entries are purged last entry first
                    let filepath = filepaths[filepaths.length-1];
                    // Note there's a new edit incoming, so check max number of
                    // edits for equality too
                    if (filepaths.length >= this.maxEdits) {
                        logInfo("Will purge entry", filepath, "over max count", 
                            filepaths.length, ">", this.maxEdits)
                        purge = true;
                    }
                    let filepathAgeMs = todayUTC - this.getEditEpoch(filepath);
                    if (filepathAgeMs > this.maxEditAgeMs) {
                        logInfo("Will purge entry", filepath, "over max age", 
                            filepathAgeMs * 1000, ">", this.maxEditAgeMs * 1000);
                        purge = true;
                    }
                    if (zipFileSize > this.maxEditHistoryFileSize) {
                        logInfo("Will purge entry", filepath, "over max size", 
                            zipFileSize, ">", this.maxEditHistoryFileSize);
                        // XXX Instead of just purging this could do something
                        //     smarter like merging entries which could also
                        //     decrease the history file size?
                        purge = true;
                        zipFileSize -= this.getEditCompressedSize(zip, filepath);
                    }
                    if (!purge) {
                        // Entries are purged from the end, loop can exit if
                        // this entry is not purged
                        break;
                    }
                    logInfo("Purging entry", filepath);
                    filepaths.pop();
                    zip.remove(filepath);
                }
                numEdits = filepaths.length;
                
                if (filepaths.length > 0) {
                    // Diff the latest stored edit against the incoming file
                    // data, if the zip file is empty just store the incoming
                    // file. If there are no stored edits, continue to store the
                    // incoming one fully

                    // Note it needs to store the incoming file in full and not
                    // the diff because otherwise there's no way to reconstruct
                    // the previous version to diff against (Obsidian calls
                    // "modify" after the file has been written)

                    // XXX Will this ever be used for binary files? Don't do
                    //     diffs on binary files/extensions and always store
                    //     fully? Show some binary diff in the modal? image
                    //     diff?
                    
                    let mostRecentFilename = filepaths[0];
                    let mostRecentFile = zip.file(mostRecentFilename);

                    if (this.getEditEpoch(mostRecentFilename) == this.getEditEpoch(newFilename)) {
                        // Don't allow changes done at the same epoch since it
                        // will get the same filename and overwrite the previous
                        // version, corrupting the history. With the current
                        // epoch granularity this essentially means that changes
                        // have to be at least one second apart, which is almost
                        // always the case unless there's a forced save.
                        // XXX This could just remove the last change and update
                        //     to this one?
                        logInfo("Delaying entry due to colliding epochs");
                        return;
                    }
                    
                    logInfo("unpacking " + mostRecentFilename);
                    let prevFileData = await mostRecentFile.async("string");
                    // @ts-ignore: complains about missing opt_c, but
                    // passing only two arguments is actually allowed by the
                    // diff-match-patch API
                    let diffs = dmpobj.patch_make(fileData, prevFileData.toString());
                    if (diffs.length > 0) {
                        let patch = dmpobj.patch_toText(diffs);

                        // XXX Don't save the version if it has less than a
                        //     given size in bytes? (but it has already done the
                        //     work and the savings because of merging updates
                        //     may not be that big, although at the very least
                        //     it shouldn't save versions where most of it are
                        //     control chars?)
                        
                        // Don't bother replacing with the diffed version if
                        // the diff is larger than the original
                        if (patch.length < prevFileData.length) {
                            // Replace the previous version with a diff wrt the
                            // newest version
                            logInfo("Removing ", mostRecentFilename);
                            zip.remove(mostRecentFilename);
                            // Store as a diff
                            mostRecentFilename = this.buildEditFilename(
                                this.getEditEpoch(mostRecentFilename), 
                                true
                            );
                            logInfo("Storing ", mostRecentFilename, " with date ", 
                                mostRecentFile.date, " timestamp ", mostRecentFile.extendedTimestamp);
                            // XXX Investigate why there's no need to undo
                            //     the UTC offset here: 
                            //     - Javascript UTC dates are stored as is
                            //       in the zip object metadata
                            //     - To prevent bad dates 
                            //
                            await zip.file(mostRecentFilename, patch,
                                { date: mostRecentFile.date, compression:"DEFLATE" });
                        }
                    } else {
                        logInfo("No changes detected, ignoring");
                        return;
                    }
                }  
            }

            // Store the newest version in full

            // jszip stores dates in UTC but the zip standard and zip tools
            // expect the date in local times (DOS times). Also, note that
            // dates in zip are only accurate to even seconds because DOS
            // times only use 16 bytes, which can only fit 5 bits for
            // seconds.

            // If we want tools (explorer, total commander...) to display
            // the right date, we could store the local date by providing
            // jszip with the UTC offset undone:
            //     dateWithOffset = new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000);
            // But it has limited use since those tools won't show the right
            // date across timezones or DST changes, eg a file in a zip
            // saved before DST with time 10.30 will be displayed with time
            // 9.30 after DST. 

            // see https://github.com/Stuk/jszip/issues/369
            // see https://github.com/Stuk/jszip/blob/master/lib/reader/DataReader.js#L113
            // see https://opensource.apple.com/source/zip/zip-6/unzip/unzip/proginfo/extra.fld
            // see https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
            let dateWithOffset = new Date(file.stat.mtime - new Date().getTimezoneOffset() * 60000);
            logInfo("Storing", newFilename, " with date", dateWithOffset);
            zip.file(newFilename, fileData, { date: dateWithOffset, compression:"DEFLATE" });
            
            // Generate zip archive and save
            let newZipData = await zip.generateAsync({type: "arraybuffer", compression: "DEFLATE"});
            if (zipFile == null) {
                // No existing zip file, create
                
                // The directory may not exist if history files are not saved
                // alongside notes, and createBinary won't create the directory,
                // so create it here. Do it unconditionally for simplicity and
                // ignore errors, let createBinary fail if there was a problem
                
                // XXX Obsidian has issues with directories starting with "." :
                //     - createBinary succeeds in creating the binary in a
                //       directory starting with "." but returns null instead of a TFile
                //     - createFolder succeeds in creating a folder starting with "."
                //     - getAbstractFileByPath of a path starting with "." returns null
                let dirpath = zipFilepath.substring(0, zipFilepath.lastIndexOf("/")+1);
                logInfo("Conservatively creating dir", dirpath);
                await this.app.vault.createFolder(dirpath).catch(()=>null);
                let zipFile;
                try {
                    zipFile = await this.app.vault.createBinary(zipFilepath, newZipData);
                } catch (e) {
                    this.reportHistoryWriteFailure(enqueuedPath ?? file.path, e);
                    return;
                }
                if (zipFile == null) {
                    logError("Can't create edit history file", zipFilepath);
                    return;
                }
            } else {
                // Update the zip file
                try {
                    await this.app.vault.modifyBinary(zipFile, newZipData);
                } catch (e) {
                    this.reportHistoryWriteFailure(enqueuedPath ?? file.path, e);
                    return;
                }
            }
            // XXX This needs to update when switching panes, etc, or set a timer
            this.statusBarItemEl.setText((numEdits + 1) + " edits");
        };
        this.registerEvent(this.app.vault.on("modify", (fileOrFolder: TAbstractFile, force: boolean = false) => {
            // Skip capturing history while Obsidian Sync is actively syncing
            // (unless this is a forced/manual save). A synced note write fires a
            // modify here, which would write a new history file that Sync then
            // has to upload (and which can conflict with the history file the
            // originating device already synced) -- so pausing breaks that loop.
            // The change is still captured on the device that made the edit, and
            // that history file syncs across, so nothing is lost.
            if (!force && this.settings.pauseDuringSync && this.isObsidianSyncing()) {
                logDbg("Ignoring modify during Obsidian Sync", fileOrFolder.path);
                return;
            }
            // Capture the path and edit time now, at enqueue time (the vault
            // calls this callback synchronously), so a rename or later modify
            // that lands before this one is dequeued can't redirect the history
            // file or retime the entry.
            const enqueuedPath = fileOrFolder.path;
            const enqueuedMtime = (fileOrFolder instanceof TFile) ? fileOrFolder.stat.mtime : undefined;
            enqueue(() => processModify(fileOrFolder, force, enqueuedPath, enqueuedMtime));
        }));

        const processRename = async (file: TAbstractFile, oldPath: string) => {
            logInfo("vault rename path", file.path);
            // This reports any files or folders modified via the api, ignore
            // non whitelisted files/folders
            // Note if a folder is renamed each children will get a call here
            // with the new path
            // A renamed history folder was already followed when the event
            // arrived (see the rename callback below)
            const rootFolder = this.editHistoryRootFolder;

            if (!(this.keepEditHistoryForFile(file))) {
                logDbg("Ignoring non whitelisted file", file.path);
                return;
            }


            // Since Obsidian will move the folder contents when a folder is
            // moved, only move the history file when the note is renamed or
            // moved to a different parent (or if history files are kept in
            // their own directory)
            // Otherwise, moving the edit history file would cause Obsidian to
            // throw a benign error when it tries to move the edit history file
            // and finds it's not there anymore.
            const oldFiledirs = oldPath.split("/");
            const oldFilename = oldFiledirs.pop();
            const oldParentFolder = (oldFiledirs.length > 0) ? oldFiledirs.pop() : "";
            const filedirs = file.path.split("/");
            const filename = filedirs.pop();
            const parentFolder = (filedirs.length > 0) ? filedirs.pop() : "";
            if ((this.settings.editHistoryRootFolder == "") && 
                ((oldParentFolder == parentFolder) && (oldFilename == filename))) {
                logDbg("Not moving edit history, expected to be moved later alongside parent folder");
                return;
            }

            // Rename the edit history file if any
            let zipFilepath = this.getEditHistoryFilepath(oldPath);
            let zipFile = this.app.vault.getAbstractFileByPath(zipFilepath);
            if (zipFile != null) {
                let newZipFilepath = this.getEditHistoryFilepath(file.path);
                logInfo("Renaming edit history file", zipFilepath,"to", newZipFilepath);
                if (rootFolder != "") {
                    // In the history folder the note's new parent may not have
                    // a mirror folder yet
                    const dirpath = newZipFilepath.substring(0, newZipFilepath.lastIndexOf("/"));
                    await this.app.vault.createFolder(dirpath).catch(() => null);
                }
                await this.app.vault.rename(zipFile, newZipFilepath);
            }
        };
        // oldPath is a stable string; file.path is read when the task runs but
        // by then any earlier-enqueued modify has already flushed to the old
        // path, so the history file exists to be moved
        this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
            // The history folder (or a folder containing it) was renamed or
            // moved in the file explorer: follow it right away, in memory,
            // before any queued task runs. The history files already moved
            // on disk with the folder, so every task still in the queue
            // (modifies queued before the rename, and the renames of the
            // folder's notes, which Obsidian may report before or after the
            // folder itself) must look them up under the new path
            const rootFolder = this.editHistoryRootFolder;
            if ((file instanceof TFolder) && (rootFolder != "") &&
                ((oldPath == rootFolder) || rootFolder.startsWith(oldPath + "/"))) {
                const newRootFolder = file.path + rootFolder.slice(oldPath.length);
                logInfo("Renaming history folder, updating settings from",
                    rootFolder, "to", newRootFolder);
                this.settings.editHistoryRootFolder = newRootFolder;
                this.editHistoryRootFolder = newRootFolder;
                enqueue(() => this.saveSettings());
                return;
            }
            enqueue(() => processRename(file, oldPath));
        }));

        const processDelete = async (file: TAbstractFile) => {
            logInfo("vault delete path", file.path);
            // This reports any files or folders modified via the api, ignore
            // non whitelisted files/folders
            if (!(this.keepEditHistoryForFile(file))) {
                logDbg("Ignoring non whitelisted file", file.path);
                return;
            }
            // Delete the edit history file if any
            let zipFilepath = this.getEditHistoryFilepath(file.path);
            let zipFile = this.app.vault.getAbstractFileByPath(zipFilepath);
            if (zipFile != null) {
                logInfo("Deleting edit history file", zipFilepath);
                // XXX Should this trash instead of delete? (the Obsidian
                //     setting under Files and Links allows choosing between
                //     system trash, obsidian trash and delete)
                await this.app.vault.delete(zipFile);
            }
        };
        this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => {
            enqueue(() => processDelete(file));
        }));

        // XXX Use notices for some information/error messages

        // The ribbon can be disabled from Obsidian UI, no need to check for a
        // specific disable here
        const ribbonIconEl = this.addRibbonIcon("clock", "Open edit history", (evt: MouseEvent) => {
            if (this.keepEditHistoryForActiveFile()) {
                new EditHistoryModal(this).open();
            }
        });

        const statusBarItemEl = this.addStatusBarItem();
        statusBarItemEl.setText("? edits");
        this.statusBarItemEl = statusBarItemEl;
        const plugin = this;
        statusBarItemEl.onclick = function () {
            // Resolve the file the same way the status bar text does (the active
            // FileView, not workspace.getActiveFile()), so clicking only opens
            // the modal when the bar actually shows a tracked file's count and
            // never for a non-file view that getActiveFile() would resolve to a
            // background note.
            const file = plugin.getActiveFileViewFile();
            if ((file != null) && plugin.keepEditHistoryForFile(file)) {
                new EditHistoryModal(plugin).open();
            }
        };
        
        this.statusBarItemEl.toggle(this.settings.showOnStatusBar);

        // Keep the status bar count in sync with the active file, not just the
        // last saved one. active-leaf-change covers tab switches (including to
        // custom/non-file views); file-open covers opening a file in place.
        this.registerEvent(this.app.workspace.on("active-leaf-change", () => { this.updateStatusBar(); }));
        this.registerEvent(this.app.workspace.on("file-open", () => { this.updateStatusBar(); }));
        this.app.workspace.onLayoutReady(() => { this.updateStatusBar(); });

        this.addCommand({
            id: "open-edit-history",
            name: "Open edit history for this file",
            checkCallback: (checking: boolean) => {
                if (this.keepEditHistoryForActiveFile()) {
                    if (!checking) {
                        new EditHistoryModal(this).open();
                    }
                    return true;
                } 
                return false;
            }
        });

        this.addCommand({
            id: "save-edit-history",
            name: "Save current edit in the edit history",
            checkCallback: (checking: boolean) => {
                if (this.keepEditHistoryForActiveFile()) {
                    if (!checking) {
                        logInfo("Forcing storing edit");
                        this.app.vault.trigger("modify", this.app.workspace.getActiveFile(), true);
                    }
                    return true;
                } 
                return false;
            }
        });


        // Scan for new file extensions once the vault index is ready, then
        // check hourly whether the daily/weekly scan is due (for vaults that
        // stay open across days)
        this.app.workspace.onLayoutReady(() => { this.scanVaultExtensionsIfDue(); });
        this.registerInterval(window.setInterval(() => { this.scanVaultExtensionsIfDue(); }, 60 * 60 * 1000));

        this.addSettingTab(new EditHistorySettingTab(this.app, this));
    }

    onunload() {
        logInfo("unload");
    }
}

class EditHistoryModal extends Modal { 
    plugin: EditHistory;
    currentVersionData: string;
    curDiffIndex: number;
    diffElements: NodeListOf<HTMLElement>;
    
    constructor(plugin: EditHistory) { 
        super(plugin.app);
        this.plugin = plugin;
    }

    renderCalendar(calendarDiv: HTMLElement, select: DropdownComponent, zipFile: TFile, zip: JSZip, filepaths: string[]) {
        // XXX Abstract this more? problems are revstats requiring the zip file
        //     or recalculate values outside. select should also be removed and
        //     take a cell onclick callback or do the cell onclick in the caller?

        // Display the list of changes for the currently selected year as a
        // table with one color-coded cell per day of the year, similar to
        // github commit activity: one cell per day, one row per day of the
        // week, one column per week, multiple columns per month.

        const selectedEdit = select.getValue();
        const year = this.plugin.getEditDate(selectedEdit).getFullYear();
        
        let calendarHtml = '<table class="calendar">';
        let fileTimeToEditCount = new Map<number, number>();
        let fileSize = 0;
        let numFiles = 0;

        // Collect the times of all edits in the given year, note it's possible
        // filepaths is empty when the file hasn't been saved yet. 
        // XXX Ideally this should also add the current time if note contents
        //     different from last stored, but this needs the cell clicking code
        //     to be able to respond to that date. Eventually this function
        //     should just take a list of days and shades, or the shade and
        //     clicking done in the caller after calendar building? 
        for (let fp of filepaths) {
            // XXX filepaths are sorted by decreasing date, could binary search
            //     to the selected year, probably overkill?
            let d = this.plugin.getEditDate(fp);
            if (d.getFullYear() == year) {
                const t = this.plugin.getEditFileTime(fp);
                const count = fileTimeToEditCount.get(t) || 0;
                fileTimeToEditCount.set(t, count + 1);
                fileSize += this.plugin.getEditCompressedSize(zip, fp);
                numFiles++;
            } else if (d.getFullYear() < year) {
                // filepaths are sorted newest first, exit when switching
                // to a previous year
                break;
            }
        }
        // Shade the days looking at how many edits there were for the given day
        // Note this doesn't count diffs inside an edit, but edits in a day,
        // since counting diffs would require uncompressing and parsing all
        // edits in the day, which is expensive
        const editCounts = Array.from(fileTimeToEditCount.values());
        const maxFileEditCount = Math.max(...editCounts);
        const minFileEditCount = Math.min(...editCounts);
        const editCountRange = maxFileEditCount - minFileEditCount;
        const maxShade = 5; // From 0 to maxShade shade levels
        const selectedFileTime = this.plugin.getEditFileTime(selectedEdit);
        const firstDayOfYear = new Date(year, 0, 1);
        const startDate = new Date(year, 0, 1 - firstDayOfYear.getDay());
        // one row per day of the week
        const numRows = 7;
        // Check if the last day of February is 29 by setting the day of the
        // March (0-based) to 0, which typescript adjusts to the last day of the
        // previous month
        const leapDelta =  new Date(year, 2, 0).getDate() - 28;
        // need to show at least 365 days plus padding for previous year
        // plus leap
        const numCols = Math.round((365 + firstDayOfYear.getDay() + leapDelta) / numRows);
        
        let month = 0;
        let monthColStart = 0;
        calendarHtml += `<thead><tr><th>${year}</th>`;
        
        // Generate the HTML for the month column headers, each month is a
        // variable number of columns depending on the day of the week the first
        // day of the month falls in and the length of the month in days
        
        // set d at the bottom row, will indicate when the current column spills
        // to the next month and a new column header is needed
        let d = new Date(startDate);
        d.setDate(d.getDate() + 6);
        for (let col = 0; col < numCols; ++col) {
            // Spill the previous month if this column ends in a new month, this
            // is done after the fact since that's when colspan is known, so it
            // also needs to spill if the last column
            if ((month != d.getMonth()) || (col == numCols - 1)) {
                const dd = new Date(d.getFullYear(), month, 1);
                calendarHtml += `<th colspan="${(col - monthColStart)}">${dd.toLocaleDateString(undefined, { month: 'short' })}</th>`;
                monthColStart = col;
                month = d.getMonth();
            }
            d.setDate(d.getDate() + 7);
        }
        calendarHtml += "</tr></thead><tbody>";

        // Generate HTML for the day cells, one cell per day, one day of the
        // week per row, one week per column
        for (let row = 0; row < numRows; ++row) {
            let d =  new Date(startDate);
            // It's okay to overflow days in setDate, Typescript does carry over
            d.setDate(d.getDate() + row);
            calendarHtml += `<tr><th>${d.toLocaleDateString(undefined, { weekday: 'short' })}</th>`;
            for (let col = 0; col < numCols; ++col) {
                const t = d.getTime();
                const count = fileTimeToEditCount.get(t) || 0;
                // Note month is 0-based
                let styleClass = "calendar-empty-"  +  ((d.getMonth() & 1) ? "odd" : "even");
                let tooltip = d.toLocaleDateString();
                if (d.getFullYear() != year) {
                    // Note count is zero in this case, since only times in the
                    // current year are counted
                    styleClass = "calendar-black";
                } else if (count > 0) {
                    const shadeLevel = (editCountRange == 0) ? maxShade : Math.round(((count-minFileEditCount) * maxShade) / editCountRange);
                    if (t == selectedFileTime) {
                        styleClass = "calendar-selected ";
                    } else {
                        styleClass = "calendar-level ";
                    }
                    styleClass += "clickable level-" + shadeLevel;
                    tooltip += ` (${count} edits)`;
                } 
                calendarHtml += `<td id="calendar-${t}" class="${styleClass}" title="${tooltip}"></td>`;
                d.setDate(d.getDate()+7);
            }
            calendarHtml += "</tr>";
        }
        calendarHtml += "</tbody></table>";
        calendarDiv.innerHTML = calendarHtml;
        const calendarTable = calendarDiv.querySelector("table") as HTMLElement;
        // Hook on cell click to change the cell selection and the drop down (on
        // unselected but also on selected cells, since cell selection can be
        // toggled without regenerating the whole calendar)
        const cells = calendarTable.querySelectorAll('td.calendar-level, td.calendar-selected');
        cells.forEach(cell => {
            // Set the onclick handler
            cell.addEventListener('click', () => {
                // Select the first date that matches in the drop down (since
                // this is a date without time, there can be multiple matching
                // diffs in the same day). No need to toggle the cell selection
                // itself since the dropdown change handler takes care of that
                logDbg('Cell clicked:', cell);
                const cellFileTime = parseInt(cell.id.slice(cell.id.indexOf("-")+1));
                // XXX store data-filetime in the option and do this search with
                //     queryselector?
                //     document.querySelector(`[data-filetime="${cellFileTime}"]`);
                const selectEl = select.selectEl;
                const options = selectEl.options;
                for (let i = 0; i < options.length; i++) {
                    let d = this.plugin.getEditDate(options[i].value);
                    d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
                    const optionFileTime = d.getTime();
                    if (optionFileTime == cellFileTime) {
                        if (i != selectEl.selectedIndex) {
                            selectEl.selectedIndex = i;
                            selectEl.trigger("change");
                        }
                        break;
                    }
                }
            });
        });
        let revStats = calendarDiv.createEl("small");
        // Fill in the stats now that all the information is available
        // XXX Use human friendly units (KB, MB, GB, etc)
        revStats.setText(
            `${numFiles}/${filepaths.length} edit${(filepaths.length > 1) ? "s " : " "}` +
            `${fileSize}/${(zipFile as TFile).stat.size} bytes compressed, ${this.app.workspace.getActiveFile()?.stat.size} note bytes`
        );
    }

    async renderDiffsTimeline(zip: JSZip, dmpobj: DiffMatchPatch, filepaths: string[], selectedEdit: string, latestData: string, showWhitespace: boolean): Promise<string> {
        
        let annots : string[] = [];
        let lineToRefLine : number[] = [];
        let lines : string[] = [];
        let annotate = false;
        let remainingAnnots = 0;
        let data = latestData;
        let newerData = latestData;
        let prevFileDateStr = "";
        
        let notice = null;

        let nextReportPct = 0;
        const reportIntervalPct = 5;
        const startTime = Date.now();
        for (const [ifp, filepath] of filepaths.entries()) {
            // Timeline can take a long time with lots of edits, report, but
            // only every few iterations to avoid unnecessary overhead
            // XXX Find a way to allow cancel?
            // XXX Decrease execution time by doing coarse timeline that only
            //     shows per day diffs? (merge all edits done the same day,
            //     rebuilding the diff in a single call and pointing the click
            //     to the first or last edit of that day)
            const pct = Math.round((100*ifp)/filepaths.length);
            if (pct >= nextReportPct) {
                if (nextReportPct == reportIntervalPct) {
                    // On the first progress report, check if the estimate of
                    // the whole work will be over a given threshold (this
                    // prevents the notice quickly flashing with files with few
                    // edits) and report if so
                    const currentTime = Date.now();
                    if (((currentTime - startTime) * 100 / nextReportPct) > 1000) {
                        // Create a notice to report progress, set duration to
                        // zero to prevent the notice from disappearing while
                        // still working, hide explicitly below when done.
                        notice = new Notice("", 0);
                    }
                }
                // Note this may not reach 100% if the loop early exists below,
                // but it's very unlikely
                notice?.setMessage(`Computing timeline ${pct}%`);
                nextReportPct += reportIntervalPct;
            }
            // Loop over filepaths,
            // - first rebuilding the file contents for the selectedEdit
            // - once found, keep rebuilding versions and also store the time
            //   annotation for each line (ie time of the edit that most
            //   recently modified that line)
            const diff = await zip.file(filepath).async("string");
            newerData = data;
            if (this.plugin.getEditIsDiff(filepath)) {
                // Rebuild the data from the diff applied to the current data
                const patch = dmpobj.patch_fromText(diff);
                data = dmpobj.patch_apply(patch, data)[0];
            } else {
                // The full file was stored, there's no diff
                data = diff;
            }
            if (!annotate && (selectedEdit == filepath)) {
                // Note split returns 2 for a string with a single \n, no need
                // to +1
                lines = data.split("\n");
                const numLines = lines.length;
                annots = new Array(numLines).fill("");
                // lineToRefLine[i] : for line i of the current data, what is
                // the line of the reference filepath. Could be -1 if the
                // reference filepath doesn't contain that line and could have
                // less than the reference lines if the current filepath doesn't
                // contain that line
                lineToRefLine = Array.from({ length: numLines + 1 }, (_, i) => i);
                annotate = true;
                prevFileDateStr = this.plugin.getEditLocalDateStr(filepath);  
                remainingAnnots = annots.length;
            } else if (annotate) {
                // Get the diff to go from the newer version to the older
                // version (backwards diff), so newer lines appear as deletions
                // and viceversa (this allows to replace the line diff with with
                // the stored diffs in the future, which also store a backwards
                // diff)
                // Use linemode since we are interested in full line changes,
                // but note that line diffs still include carriage returns
                // inside so they need to be looped over below
                // XXX This should use the patch and not recreate the diff, but
                //     patches are contextless and require tracking how lines
                //     are inserted or deleted as if the patch were applied
                const diffs = dmpobj.diff_lineMode(newerData, data);
                let line = 0;
                for (const [op, diffData] of diffs) {
                    // Counting diffs and diff_linemode above are by far the
                    // hotspots of this function (eg 280ms and 170ms each).
                    // For counting lines .split().length is 270ms vs.
                    // .match().length 346ms
                    const numLines = diffData.split("\n").length-1;
                    for (let i=0; i < numLines; ++i) {
                        const refLine = lineToRefLine[line];
                        switch (op as number) {
                            case DiffOp.Delete:
                                // If the old file doesn't have this line, it
                                // means the new file inserted the line, annotate
                                // as such unless it's already annotated
                                lineToRefLine.splice(line, 1);
                                if ((refLine != -1) && (annots[refLine] == "")) {
                                    annots[refLine] = prevFileDateStr;
                                    remainingAnnots--;
                                }
                            break;
                            case DiffOp.Insert:
                                // The new file doesn't have this line, it means
                                // the new file deleted it, nothing to annotate,
                                // but tag this line as not present 
                                lineToRefLine.splice(line, 0, -1);
                                line++;
                            break;
                            case DiffOp.Equal:
                                line++;
                            break;
                        }
                        // Early exit if all the lines have annotations. This is
                        // unlikely to hit unless at some point the whole file
                        // was rewritten
                        if (remainingAnnots == 0) {
                            break;
                        }
                    }
                    if (remainingAnnots == 0) {
                        break;
                    }
                }
                prevFileDateStr = this.plugin.getEditLocalDateStr(filepath);
            }
        }

        // Generate a table with the annotated file, time annotations on the
        // left column and text lines on the right
        let diffHtml: string = "<table>";
        const fileDateStr = this.plugin.getEditLocalDateStr(selectedEdit);
        for (let i=0; i < lines.length; ++i) {
            const hdata1 = htmlEncode(annots[i], false);
            const hdata2 = htmlEncode(lines[i], showWhitespace);

            if (annots[i] == fileDateStr) {
                // If the annotation date is the selectedEdit, tag as diff-line
                // so it gets highlighted and can be navigated and counted as
                // diff for stats display (but can only tag insertions,
                // deletions are missing by definition of the timeline view)
                
                // XXX This causes the scroll to move when navigating by
                //     clicking the time because the first diff-line is focused
                //     when the select changes, which may undesirable since the
                //     clicked time line may be scrolled out, fix?
                diffHtml += `<tr class="diff-line"><td class="clickable diff-time">${hdata1}</td><td class="mod-right">${hdata2}</td></tr>`;
            } else {
                diffHtml += `<tr><td class="clickable diff-time ${(annots[i] == fileDateStr) ? "diff-line" : ""}">${hdata1}</td><td>${hdata2}</td></tr>`;
            }
        }
        diffHtml += "</table>";

        notice?.hide();

        return diffHtml;
    }

    renderDiffsInline(diffs: Diff[], showWhitespace: boolean): string {
        let diffHtml = "";
        // This is equivalent to diff_prettyHtml, but that one inserts
        // hard-coded background colors, use styles instead. See
        // https://github.com/google/diff-match-patch/blob/master/javascript/diff_match_patch_uncompressed.js
        for (const [op, data] of diffs) {
            // Some Insert/Delete diffs are empty independently of
            // calling diff_cleanupSemantic, ignore. See
            // https://github.com/google/diff-match-patch/issues/105
            if (data == "") {
                continue;
            }
            let hdata = htmlEncode(data, showWhitespace);
            switch (op as number) {
                case  DiffOp.Delete:
                    diffHtml += `<del class="diff-line mod-left">${hdata}</del>`;
                break;
                case DiffOp.Insert: 
                    diffHtml += `<ins class="diff-line mod-right">${hdata}</ins>`;
                break;
                case DiffOp.Equal:
                    diffHtml += `<span>${hdata}</span>`;
                break;
            }
        }
        return diffHtml;
    }

    renderDiffsSideOrTop(diffs: Diff[], sideBySide: boolean, showWhitespace: boolean): string {
        // Group the diffs by carriage-terminated blocks of lines,
        // display them in a table side by side or top by bottom

        // For every diff, 
        // - if it's an equal diff
        //   - Append the first line to the current right and left
        //     blocks, flush the blocks
        //   - Initialize left and right to the last line
        //   - Flush any in between lines as non-diff right and left
        //     blocks
        // - if it's a delete diff, accumulate into the left block
        // - if it's an insertion diff, accumulate into right block and
        //   flush if it ends in carriage return
        
        let left = "";
        let right = "";
        let diffHtml = '<table width="100%"><tbody>';
        // Append a dummy terminator to detect the loop end and flush
        for (const [op, data] of [...diffs, [DiffOp.Equal as number, ""] as Diff]) {
            // Some Insert/Delete diffs are empty independently of
            // calling diff_cleanupSemantic, ignore. See
            // https://github.com/google/diff-match-patch/issues/105
            // (don't remove empty Equal since it's used loop as
            // terminator below)
            if ((data == "") && ((op as number) != DiffOp.Equal)) {
                continue;
            }
            let hdata = htmlEncode(data, showWhitespace);
            // XXX Hack to guarantee a flush at the end, do it elsewhere
            //     since it will add an spurious (but invisible in html)
            //     carriage return
            if (hdata == "") {
                hdata = "\n";
            }
            switch (op as number) {
                case DiffOp.Delete:
                    left += `<del>${hdata}</del>`;
                    // Don't flush even if it ends in a carriage return,
                    // the right side is the one that tracks returns.
                    // This will pair the deletion to the next insertion
                    // or equal block (empirically looks like deletions
                    // always appear before insertions, so this seems to
                    // work fine).
                    
                    // XXX This could also assign deletions to the wrong
                    //     block, but it's not deterministic what the
                    //     proper block is anyway.
                break;
                case DiffOp.Insert:
                    right += `<ins>${hdata}</ins>`;
                    // Flush left and right if right ends in carriage
                    // return, otherwise wait for a carriage return
                    // either in an Insert or in an Equal diff. No need
                    // to flush each line individually since it's
                    // desirable to group the whole insertion in the
                    // same block
                    if (hdata.endsWith("\n")) {
                        if (sideBySide) {
                            diffHtml += `<tr class="diff-line"><td class="mod-left">${left}</td><td class="mod-right">${right}</td></tr>`;
                        } else {
                            diffHtml += `<tr class="diff-line"><td><div class="mod-left">${left}</div><div class="mod-right">${right}</td></tr>`;
                        }
                        left = "";
                        right = "";
                    }
                break;
                case DiffOp.Equal:
                    let i;
                    // Flush any pending left & right blocks upto the
                    // first carriage return in the equal data,
                    // inclusive
                    i = hdata.indexOf("\n");
                    if ((i != -1) && ((left != "") || (right != ""))) {
                        let end = hdata.slice(0, i+1);
                        left += end;
                        right += end;
                        hdata = hdata.slice(i+1);

                        if (sideBySide) {
                            diffHtml += `<tr class="diff-line"><td width="50%" class="mod-left">${left}</td><td width="50%" class="mod-right">${right}</td></tr>`;
                        } else {
                            diffHtml += `<tr class="diff-line"><td><div class="mod-left">${left}</div><div class="mod-right">${right}</div></td></tr>`;
                        }
                        left = "";
                        right = "";
                    }
                    // Flush all the equal data upto the last carriage
                    // return, inclusive
                    i = hdata.lastIndexOf("\n");
                    if (i != -1) {
                        let start = hdata.slice(0, i+1);
                        if (sideBySide) {
                            diffHtml += `<tr><td>${start}</td><td>${start}</td></tr>`;
                        } else {
                            diffHtml += `<tr><td>${start}</td></tr>`;
                        }
                        hdata = hdata.slice(i+1);
                    }
                    // Append to left and right the equal data from the
                    // last carriage return, exclusive 
                    right += hdata;
                    left += hdata;
                break;
            }
        }
        diffHtml += "</tbody></table>";
        
        return diffHtml;
    }

    async onOpen() {
        const file = this.app.workspace.getActiveFile();

        this.titleEl.setText("Edits for ");
        this.titleEl.createEl("i", { text: file?.name });
        this.titleEl.createEl("span", { text: " " });

        const calendarIcon = this.titleEl.createEl("span")
        // XXX This icon is not visible on mobile on some older versions,
        //     find out which version and increase the required version?
        setIcon(calendarIcon, "calendar-plus-2");
        
        this.modalEl.addClass("edit-history-modal");

        const {contentEl} = this;        
        contentEl.addClass("edit-history-modal-content");

        if ((file == null) || (!this.plugin.keepEditHistoryForFile(file))) {
            // XXX This should never happen since callers don't fire the modal?
            logWarn("Edit history not allowed for active file");
            contentEl.createEl("p", { text: "No edit history"});
            return;
        }

        // Note this may differ from the last edit stored in the zip since not
        // all edits are stored in the file depending on the value of
        // this.minMsBetweenEdits
        const latestData = await this.app.vault.read(file);
    
        // Create or open the zip with the edit history of this file

        // XXX Review perf notes at https://stuk.github.io/jszip/documentation/limitations.html
        const zip: JSZip = new JSZip();
        const zipFilepath = this.plugin.getEditHistoryFilepath(file.path);
        logInfo("Opening zip file ", zipFilepath);
        const zipFile = this.app.vault.getAbstractFileByPath(zipFilepath);
        if ((zipFile == null) || (!(zipFile instanceof TFile))) {
            logWarn("No history file or not a file", zipFilepath);
            contentEl.createEl("p", { text: "No edit history file"});
            return;
        }
        
        const zipData = await this.app.vault.readBinary(zipFile);
        if (zipData == null) {
            logWarn("Unable to read history file");
            contentEl.createEl("p", { text: "No edit history"});
            return;
        }

        await zip.loadAsync(zipData);

        let filepaths:string[] = [];
        zip.forEach(function (relativePath:string) {
            filepaths.push(relativePath);
        });
        // Ignore entries that aren't well formed edit filenames so a corrupt or
        // externally tampered history file can't produce NaN dates in the
        // calendar/timeline rendering
        filepaths = filepaths.filter(fp => this.plugin.isValidEditFilename(fp));
        if (filepaths.length == 0) {
            logWarn("Empty edit history file");
            contentEl.createEl("p", { text: "Empty edit history"});
            return;
        }
        // Sort most recent first (although probably unnecessary since the zip
        // seems to list in creation order already)
        this.plugin.sortEdits(filepaths);

        const dmpobj = new DiffMatchPatch();
        
        // XXX Allow searching in the diff text rendering

        const calendarDiv = contentEl.createDiv();
        // The calendar is too tall for mobile, allow collapsing/expanding
        calendarIcon.addEventListener('click', () => {
            if (calendarDiv.style.display === "none") {
                calendarDiv.style.display = "block";
                setIcon(calendarIcon, "calendar-minus-2");
            } else {
                calendarDiv.style.display = "none";
                setIcon(calendarIcon, "calendar-plus-2");
            }
        });

        const control = contentEl.createDiv("setting-item-control");
        control.style.justifyContent = "flex-start";
        const select = new DropdownComponent(control);
        select.selectEl.focus();

        const diffDisplaySelect = new DropdownComponent(control)
            .addOptions(diffDisplayFormatToString)
            .setValue(this.plugin.settings.diffDisplayFormat)
            .onChange(async () => {
                select.selectEl.trigger("change");
            });
        
        const diffInfo: HTMLElement = control.createEl("span");

        // XXX With the new buttons, this is too tall and too wide on mobile,
        //     reorganize/resize/downscale font?
        const copyButton = new ButtonComponent(control)
            .setButtonText("Copy")
            .setClass("mod-cta")
            .onClick(() => {
                logInfo("Copied to clipboard");
                navigator.clipboard.writeText(this.currentVersionData);
            });

        const prevButton = new ButtonComponent(control)
            .setButtonText("Previous")
            .setClass("mod-cta")
            .onClick(() => {
                logInfo("Prev diff");
                if (this.diffElements.length > 0) {
                    // XXX Disable button on start instead of cycling?
                    this.diffElements[this.curDiffIndex].removeClass("current");
                    this.curDiffIndex = (this.curDiffIndex + this.diffElements.length - 1) % this.diffElements.length;
                    this.diffElements[this.curDiffIndex].scrollIntoView({block: "center"});
                    this.diffElements[this.curDiffIndex].addClass("current");
                    diffInfo.setText((this.curDiffIndex + 1) + "/" + this.diffElements.length + " diff" + ((this.diffElements.length != 1) ? "s" : ""));
                }
            });

        const nextButton = new ButtonComponent(control)
            .setButtonText("Next")
            .setClass("mod-cta")
            .onClick(() => {
                logInfo("Next diff");
                if (this.diffElements.length > 0) {
                    // XXX Disable button on end instead of cycling?
                    this.diffElements[this.curDiffIndex].removeClass("current");
                    this.curDiffIndex = (this.curDiffIndex + 1) % this.diffElements.length;
                    this.diffElements[this.curDiffIndex].scrollIntoView({block: "center"});
                    this.diffElements[this.curDiffIndex].addClass("current");
                    diffInfo.setText((this.curDiffIndex + 1) + "/" + this.diffElements.length + " diff" + ((this.diffElements.length != 1) ? "s" : ""));
                }
            });

        control.createEl("span").setText("Whitespace");
        const whitespaceCheckbox = new ToggleComponent(control) 
            .setValue(this.plugin.settings.showWhitespace)
            .onChange(async () => {
                select.selectEl.trigger("change");
            });
        
        // Set tabindex to 0 so it can receive key events
        contentEl.setAttr("tabindex", 0);
        contentEl.addEventListener("keydown", (event: KeyboardEvent) => {
            // Hook on ctrl+arrow up/down and p/n for prev/next diff (don't use
            // alt+up/down since it's used to unfold dropdowns)
            logDbg("key", event);
            const navigateDiff = event.ctrlKey && !event.shiftKey;
            const navigateDate = event.ctrlKey && event.shiftKey;
            if ((event.key === "p") || (navigateDiff && (event.key === 'ArrowUp'))) {
                event.preventDefault();
                prevButton.buttonEl.trigger("click");
            } else if ((event.key === "P") || (navigateDate && (event.key === 'ArrowUp'))) {
                event.preventDefault();
                const nextIndex = select.selectEl.selectedIndex - 1;
                if (nextIndex >= 0) {
                    select.selectEl.selectedIndex = nextIndex;
                    select.selectEl.trigger("change");
                }
            } else if ((event.key === "n")  || (navigateDiff && (event.key === 'ArrowDown'))) {
                event.preventDefault();
                nextButton.buttonEl.trigger("click");
            } else if ((event.key === "N") || (navigateDate && (event.key === 'ArrowDown'))) {
                event.preventDefault();
                const nextIndex = select.selectEl.selectedIndex + 1;
                if (nextIndex < select.selectEl.options.length) {
                    select.selectEl.selectedIndex = nextIndex;
                    select.selectEl.trigger("change");
                }
            } else if ((event.key === "c") && event.ctrlKey) {
                event.preventDefault();
                copyButton.buttonEl.trigger("click");
            }
        });
        
        const diffDiv = contentEl.createDiv("diff-div");
        let selectedDayCell : HTMLElement|null = null;
        select.onChange( async () => {
            // This is called implicitly from the event dispatcher but also
            // explicitly via .trigger()
            // XXX Abstract out instead?
            const selectedEdit = select.getValue();

            // Update the selected cell or the whole calendar if the cell is not
            // found (ie calendar not rendered yet or year changed)
            const selectedFileTime = this.plugin.getEditFileTime(selectedEdit);
            const dayCell = document.getElementById(`calendar-${selectedFileTime}`) as HTMLElement|null;
            if (dayCell) {
                // Calendar already generated, highlight the new cell and
                // lowlight the old one
                if (selectedDayCell) {
                    selectedDayCell.addClass("calendar-level");
                    selectedDayCell.removeClass("calendar-selected");
                }
                selectedDayCell = dayCell;
                selectedDayCell.addClass("calendar-selected");
                selectedDayCell.removeClass("calendar-level");
            } else {
                this.renderCalendar(calendarDiv, select, zipFile as TFile, zip, filepaths);
                selectedDayCell = document.getElementById(`calendar-${selectedFileTime}`) as HTMLElement|null;
            }

            // Rebuild the file data of the given edit by applying the patches
            // in reverse, if one of the edits is stored fully, discard the
            // accumulated patched data and use the full data
            let data = latestData;
            let currentData = latestData;
            let currentDiff = null;

            // XXX This should cache currentData so sequentially traversing
            //     filepaths doesn't need to recreate this, and even if it's not
            //     sequential going to an earlier date can be done faster by
            //     using a non-current previousData. Only do it for the lifetime
            //     of the modal, so no need to keep one per each edited file.
            let found = false;
            let previousFound = false;
            for (let filepath of filepaths) {
                // filepath contains the negative backward diff to go from the
                // immediately newer date to filepath's date, need to
                // reconstruct the data upto the selected filepath and also the
                // immediately older one so the positive forward diff from older
                // to selected can be displayed
                let diff = await zip.file(filepath).async("string");
                
                if (this.plugin.getEditIsDiff(filepath)) {
                    // Rebuild the data from the diff applied to the current
                    // data
                    let patch = dmpobj.patch_fromText(diff);
                    // XXX This could collect patches and apply them in a
                    //     single call after the loop, not clear it's faster
                    data = dmpobj.patch_apply(patch, data)[0];
                } else {
                    // The full file was stored, there's no diff
                    data = diff;
                }

                if (found) {
                    previousFound = true;
                    break;
                }
                found = (selectedEdit == filepath);

                currentDiff = diff;
                currentData = data;
            }
            
            // If selectedEdit is the oldest edit, it won't find a previous one
            // to diff against, assume the previous is the empty file and diff
            // against that (this will be incorrect if the plugin wasn't enabled
            // when this file was created and already contained text, but
            // there's nothing that can be done in that case)
            if (!previousFound) {
                data = "";
            }

            // Display the diff against the latest edit
            // XXX Have an option to diff against an arbitrary non-sequential edit?
            // XXX This redoes the diff which shouldn't be necessary since
            //     we have all the patches, but it's not clear how to
            //     convert from patch to diff, looks like patch.diff is the
            //     set of diffs for a given patch? (but will still need to 
            //     re-diff when the whole file is saved instead of the diff)
            // XXX Add fold/unfold before/after context lines to the UI like
            //     file recovery does
            let diffHtml = "";
            // Store the currently selected version so it can be copied to
            // clipboard from the copy button handler
            this.currentVersionData = currentData;
            const showWhitespace = whitespaceCheckbox.getValue();
            // For side by side, getting line diffs via diff_lineMode could be
            // used instead which would avoid having to find line breaks below,
            // but using diff_main allows highlighting char-level diffs inside
            // each line 
            const diffs = dmpobj.diff_main(data, currentData);
            dmpobj.diff_cleanupSemantic(diffs);
            const diffDisplayFormat = diffDisplaySelect.getValue() as DiffDisplayFormat;
            switch (diffDisplayFormat) {
                case DiffDisplayFormat.Raw:
                    // XXX Missing setting the 1/n diffcount that is displayed
                    //     by the dropdowns (maybe by counting @@ and dividing
                    //     by 2?), but it's currently extracted from
                    //     diffElements.length, so that needs changing

                    // Note raw display of the diff looks counter-intuitive
                    // because the diff stores the difference between the
                    // version newer than filepath and filepath, which is a
                    // "negative forward" diff. Arguably it should show the
                    // "positive backward" diff between filepath and the version
                    // previous to filepath, but then it's not "raw"
                    let hdata = htmlEncode(currentDiff, showWhitespace);
                    diffHtml = "<tt>" + hdata + "</tt>";
                break;
                case DiffDisplayFormat.Timeline:
                    diffHtml = await this.renderDiffsTimeline(zip, dmpobj, filepaths, selectedEdit, latestData, showWhitespace);
                break;
                case DiffDisplayFormat.Inline:
                    diffHtml = this.renderDiffsInline(diffs, showWhitespace);
                break;
                default:
                    const sideBySide = (diffDisplayFormat == DiffDisplayFormat.Horizontal);
                    diffHtml = this.renderDiffsSideOrTop(diffs, sideBySide, showWhitespace);
                break;
            }
            // Remove carriage returns since <br> have been added in htmlEncode
            // XXX Do this in htmlEncode but \n can't be removed right away
            //     since it's used to detect end of line in side by side
            //     displays above
            // XXX Removing carriage returns seems to be needed because in
            //     styles.css .diff-div uses pre-wrap instead of just wrap in
            //     order to preserve spaces/tabs so diff of a space is still
            //     visible, but don't want to show carriage returns since
            //     htmlEncode has converted them to <br>\n. Convert spaces/tabs
            //     to nbsp in htmlEncode? Don't convert to <br> in htmlEncode?
            diffHtml = diffHtml.replace(/\n/g, "");
            
            // XXX Make colors configurable, in modal setting or per theme
            //     light/dark
            //     See https://github.com/friebetill/obsidian-file-diff/issues/1#issuecomment-1425157959
            // XXX Have a button to roll back to version
            // XXX innerHTML is discouraged for security reasons, change?
            //     (note this is safe because diffHtml is escaped)
            //     See https://github.com/obsidianmd/obsidian-releases/blob/master/plugin-review.md#avoid-innerhtml-outerhtml-and-insertadjacenthtml
            // XXX This is a performance hotspot, calls the internal parseHtml,
            //     not clear this can be done faster by creating nodes manually
            //     instead (chatgpt actually says parsing is faster). Creating
            //     nodes and storing them would also also avoid calling
            //     querySelectorAll below which is also a hotspot
            diffDiv.innerHTML = diffHtml;
            // Diffs are spans of <ins> or <del> tags, scroll to the first one
            this.curDiffIndex = 0;
            // diffElements is used for navigating prev/next diffs in all diff
            // displays but Raw. diff-line marks added/deleted lines in side by
            // side/top by bottom, individual changes in inline, and added lines
            // in timeline
            const diffElements = diffDiv.querySelectorAll<HTMLElement>(".diff-line");
            this.diffElements = diffElements;
            this.diffElements[this.curDiffIndex]?.scrollIntoView({block: "center"});
            this.diffElements[this.curDiffIndex]?.addClass("current");
            // XXX Number of diffs is ok for navigating but not a great
            //     statistic, this could also show chars added/chars deleted?
            diffInfo.setText((this.curDiffIndex + 1) + "/" + this.diffElements.length + " diff" + ((this.diffElements.length != 1) ? "s" : ""));
            // Navigate edits on click in the timeline view
            // XXX Clicking navigates the timeline "backwards", have a way of
            //     navigating forwards?
            const table = diffDiv.querySelector("table");
            const cells = table?.querySelectorAll("td.diff-time");
            cells?.forEach(cell => {
                // Set the onclick handler
                cell.addEventListener('click', () => {
                    logDbg('Cell clicked:', cell);
                    // cell contents are in the same format as the drop down
                    const text = cell.textContent as string;
                    // Select the first date that matches in the drop down
                    // (since this is a date without time, there can be multiple
                    // matching diffs in the same day)
                    const selectEl = select.selectEl;
                    const options = selectEl.options;
                    for (let i = 0; i < options.length; i++) {
                        if (options[i].text == text) {
                            if (i != selectEl.selectedIndex) {
                                selectEl.selectedIndex = i;
                                selectEl.trigger("change");
                            }
                            break;
                        }
                    }
                });
            });
        });

        // Create option entries
        for (let filepath of filepaths) {
            // XXX The drop down displays the changes between the selected
            //     date and the immediately older date
            //     This means that:
            //      -  the first entry should be a dummy entry with the current
            //         contents date that displays the diff from the current
            //         contents to the first file in the history (probably no
            //         changes if a revision was recently saved)
            //      - the last entry is a diff from that entry's date to the 
            //        empty file
            //     Missing setting the first dummy entry
            select.addOption(filepath, this.plugin.getEditLocalDateStr(filepath));
        }
        // Force initialization done inside onChange
        select.selectEl.trigger("change");
        
        // Update the status bar
        // XXX This shouldn't be here, but this is the best until it's done when
        //     switching panes, etc (or use a timer?)
        this.plugin.statusBarItemEl.setText(filepaths.length + " edits");
    }

    onClose() {
        logInfo("onClose");
        const {contentEl} = this;
        contentEl.empty();
    }
}

/**
 * Yes/no question in a modal. ask() resolves true only when the confirm
 * button is pressed; closing the modal any other way resolves false
 */
class ConfirmModal extends Modal {
    private confirmed = false;
    private resolve: ((confirmed: boolean) => void) | null = null;

    constructor(app: App, private title: string, private message: string, private confirmText: string) {
        super(app);
    }

    ask(): Promise<boolean> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    onOpen() {
        this.titleEl.setText(this.title);
        this.contentEl.createEl("p", { text: this.message });
        new Setting(this.contentEl)
            .addButton(button => button
                .setButtonText("Cancel")
                .onClick(() => this.close()))
            .addButton(button => button
                .setButtonText(this.confirmText)
                .setCta()
                .onClick(() => {
                    this.confirmed = true;
                    this.close();
                }));
    }

    onClose() {
        this.contentEl.empty();
        this.resolve?.(this.confirmed);
        this.resolve = null;
    }
}

/**
 * Suggest vault folders while typing in inputEl. AbstractInputSuggest only
 * exists from Obsidian 1.4.10, so on older versions the field stays a plain
 * text box (the class is defined here, not at the top level, so loading the
 * plugin doesn't touch it)
 */
function attachFolderSuggest(app: App, inputEl: HTMLInputElement) {
    if (typeof AbstractInputSuggest !== "function") {
        return;
    }
    class FolderSuggest extends AbstractInputSuggest<string> {
        getSuggestions(query: string): string[] {
            const q = query.toLowerCase();
            return app.vault.getAllLoadedFiles()
                .filter((f): f is TFolder => (f instanceof TFolder) && !f.isRoot())
                .map(f => f.path)
                .filter(p => p.toLowerCase().contains(q))
                .slice(0, 50);
        }

        renderSuggestion(value: string, el: HTMLElement) {
            el.setText(value);
        }

        selectSuggestion(value: string) {
            inputEl.value = value;
            inputEl.dispatchEvent(new Event("input"));
            this.close();
        }
    }
    new FolderSuggest(app, inputEl);
}

class EditHistorySettingTab extends PluginSettingTab { plugin:
    EditHistory;

    constructor(app: App, plugin: EditHistory) {
        super(app, plugin);
        this.plugin = plugin;
    }
    hide(): any {
        logInfo("hide");
        super.hide();
    }
    display(): void {
        const {containerEl} = this;

        containerEl.empty();

        containerEl.createEl("small", { text: "Created by "})
            .appendChild(createEl("a", { text: "Antonio Tejada", href:"https://github.com/antoniotejada/"}));

        // h2 is abnormally small in settings, start with h3 which has the right
        // size (other plugins do the same)
        containerEl.createEl("h3", {text: "General"});

        new Setting(containerEl)
            .setName("Minimum seconds between edits")
            .setDesc("Minimum number of seconds that must pass from the previous edit to store a new edit, set to 0 to disable. Modifications done between those seconds will be merged into the next edit, reducing the edit history file size at the expense of less history granularity.")
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.minSecondsBetweenEdits)
                .setValue(this.plugin.settings.minSecondsBetweenEdits)
                .onChange(async (value) => {
                    logInfo("Minimum seconds between edits: " + value);
                    this.plugin.settings.minSecondsBetweenEdits = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
                .setName("Maximum number of edits")
                .setDesc("Maximum number of edits to keep, set to 0 for no limit. Older edits will be deleted from the history in the next update, reducing the edit history file size at the expense of less history.")
                .addText(text => text
                    .setPlaceholder(DEFAULT_SETTINGS.maxEdits)
                    .setValue(this.plugin.settings.maxEdits)
                    .onChange(async (value) => {
                        logInfo("Maximum number of edits: " + value);
                        this.plugin.settings.maxEdits = value;
                        await this.plugin.saveSettings();
                    }));

        new Setting(containerEl)
            .setName("Maximum age of edits")
            .setDesc("Oldest edit to keep in seconds, eg set to 3600 to delete edits that are more than one hour old, set to 0 for no limit. Older edits will be deleted from the history in the next update, reducing the edit history file size at the expense of less history.")
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.maxEditAge)
                .setValue(this.plugin.settings.maxEditAge)
                .onChange(async (value) => {
                    logInfo("Maximum age of edits: " + value);
                    this.plugin.settings.maxEditAge = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Maximum size of the history file (KB)")
            .setDesc("Maximum size of the history file in kilobytes, set to 0 for no limit. When over the size, edits will be deleted from the history in the next update, older edits first, reducing the edit history file size at the expense of less history.")
            .addText(text => text
                .setPlaceholder(DEFAULT_SETTINGS.maxHistoryFileSizeKB)
                .setValue(this.plugin.settings.maxHistoryFileSizeKB)
                .onChange(async (value) => {
                    logInfo("Maximum history file size: " + value);
                    this.plugin.settings.maxHistoryFileSizeKB = value;
                    await this.plugin.saveSettings();
                }));

        const whitelist = this.plugin.commaSeparatedToList(this.plugin.settings.extensionWhitelist).filter(e => e != "");

        let addExtensionText: TextComponent;
        const addExtension = async () => {
            const value = addExtensionText.getValue();
            if (value.trim() != "") {
                logInfo("Adding tracked file type: " + value);
                await this.plugin.addTrackedExtension(value);
                this.display();
            }
        };
        new Setting(containerEl)
            .setName("Tracked file types")
            .setDesc("Edits are stored for files with these extensions (case insensitive). Click an extension to stop tracking it, use the text box to track a new one. If no extensions are listed, edits are stored for ALL files.\nNote if an extension stops being tracked, old edit history files will need to be removed manually.")
            .addText(text => {
                addExtensionText = text;
                text.setPlaceholder(".xyz");
                text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
                    if (e.key == "Enter") {
                        e.preventDefault();
                        addExtension();
                    }
                });
            })
            .addExtraButton(button => button
                .setIcon("plus")
                .setTooltip("Track file type")
                .onClick(addExtension));

        const trackedDiv = containerEl.createDiv("edit-history-chips");
        if (whitelist.length == 0) {
            trackedDiv.createSpan({ cls: "edit-history-chips-empty", text: "No file types listed, edits are stored for all files." });
            const seedButton = trackedDiv.createEl("button", { text: "Track only the file types currently in the vault" });
            seedButton.onclick = async () => {
                logInfo("Seeding tracked file types from vault");
                this.plugin.settings.extensionWhitelist = this.plugin.getVaultExtensions().join(", ");
                await this.plugin.saveSettings();
                this.display();
            };
        } else {
            for (const ext of whitelist) {
                const chip = trackedDiv.createSpan("edit-history-chip");
                chip.createSpan({ text: ext });
                setIcon(chip.createSpan("edit-history-chip-icon"), "x");
                chip.setAttribute("aria-label", "Stop tracking " + ext);
                chip.onclick = async () => {
                    logInfo("Removing tracked file type: " + ext);
                    await this.plugin.removeTrackedExtension(ext);
                    this.display();
                };
            }
        }

        // Offer every extension ever seen in the vault, minus the tracked
        // ones, so a just-untracked extension can be re-tracked even if no
        // file with that extension exists in the vault anymore
        const untracked = Array.from(new Set([...this.plugin.knownExtensions, ...this.plugin.getVaultExtensions()]))
            .filter(ext => !whitelist.includes(ext))
            .sort();

        new Setting(containerEl)
            .setName("Untracked file types")
            .setDesc("File types seen in this vault that are not tracked. Click an extension to start tracking it.");
        const untrackedDiv = containerEl.createDiv("edit-history-chips");
        if (whitelist.length == 0) {
            untrackedDiv.createSpan({ cls: "edit-history-chips-empty", text: "All file types are currently tracked." });
        } else if (untracked.length == 0) {
            untrackedDiv.createSpan({ cls: "edit-history-chips-empty", text: "None." });
        } else {
            for (const ext of untracked) {
                const chip = untrackedDiv.createSpan({ cls: ["edit-history-chip", "edit-history-chip-untracked"] });
                chip.createSpan({ text: ext });
                setIcon(chip.createSpan("edit-history-chip-icon"), "plus");
                chip.setAttribute("aria-label", "Track " + ext);
                chip.onclick = async () => {
                    logInfo("Adding tracked file type: " + ext);
                    await this.plugin.addTrackedExtension(ext);
                    this.display();
                };
            }
        }

        new Setting(containerEl)
            .setName("Scan for new file types")
            .setDesc("Periodically scan the vault for file types not seen before and show a notification when some are found. The scan runs when the vault is opened and while it stays open, whenever the chosen interval has passed since the last scan.")
            .addDropdown(dropdown => dropdown
                .addOption("off", "Never")
                .addOption("daily", "Daily")
                .addOption("weekly", "Weekly")
                .setValue(this.plugin.settings.extensionScanInterval)
                .onChange(async (value) => {
                    logInfo("Extension scan interval: " + value);
                    this.plugin.settings.extensionScanInterval = value;
                    await this.plugin.saveSettings();
                }))
            .addExtraButton(button => button
                .setIcon("search")
                .setTooltip("Scan now")
                .onClick(async () => {
                    const newExtensions = await this.plugin.scanVaultExtensions(false);
                    new Notice((newExtensions.length > 0) ?
                        "New file types found in the vault: " + newExtensions.join(", ") :
                        "No new file types found in the vault");
                    this.display();
                }));


        new Setting(containerEl)
                .setName("Filepath substring blacklist")
                .setDesc("Comma separated list of substrings of note filepaths to not store edits for (case insensitive). Empty to store edits for all files.\nUse forward slashes as folder separator\nNote if a substring is added, old edit history files will need to be removed manually.")
                .addText(text => text
                    .setPlaceholder(DEFAULT_SETTINGS.substringBlacklist)
                    .setValue(this.plugin.settings.substringBlacklist)
                    .onChange(async (value) => {
                        logInfo("File substring blacklist: '" + value + "'");
                        this.plugin.settings.substringBlacklist = value;
                        await this.plugin.saveSettings();
                    }));

        const historyFolderDesc = createFragment(frag => {
            frag.appendText("Where history files are saved. Leave empty to save each one next to its note (Budget.md gets Budget.md.edtz). ");
            frag.appendText("Set a folder, for example \"Edit History\", to keep all history in one place inside this vault, in the same folder layout as your notes. ");
            frag.appendText("That's useful for notes in shared or mounted folders, where history files would be visible to others or can't be written. ");
            frag.appendText("Type a folder and press Apply; changing it moves the existing history files. Don't rename or move folders inside the history folder by hand.");
        });
        let historyFolderText: TextComponent;
        let applying = false;
        // Applied explicitly, not per keystroke: each change moves history
        // files around
        const applyHistoryFolder = async () => {
            if (applying) {
                return;
            }
            const plugin = this.plugin;
            const current = plugin.editHistoryRootFolder;
            const folder = plugin.normalizeHistoryFolder(historyFolderText.getValue());
            if (folder == current) {
                historyFolderText.setValue(current);
                return;
            }
            const problem = plugin.checkHistoryFolder(folder);
            if (problem != null) {
                new Notice(problem);
                return;
            }
            applying = true;
            try {
                const count = plugin.planHistoryFolderMoves(current, folder).length;
                const from = (current == "") ? "next to their notes" : "\"" + current + "\"";
                const to = (folder == "") ? "next to their notes" : "\"" + folder + "\"";
                const confirmed = (count == 0) || await new ConfirmModal(this.app,
                    "Move history files?",
                    "Move " + count + " history file" + ((count == 1) ? "" : "s") + " from " + from + " to " + to + "? Nothing is overwritten.",
                    "Move").ask();
                if (!confirmed) {
                    historyFolderText.setValue(current);
                    return;
                }
                await plugin.changeHistoryFolder(folder);
                this.display();
            } finally {
                applying = false;
            }
        };
        new Setting(containerEl)
            .setName("History folder")
            .setDesc(historyFolderDesc)
            .setClass("edit-history-folder-setting")
            .addText(text => {
                historyFolderText = text;
                text.setPlaceholder("Next to each note")
                    .setValue(this.plugin.settings.editHistoryRootFolder);
                attachFolderSuggest(this.app, text.inputEl);
            })
            .addButton(button => button
                .setButtonText("Apply")
                .onClick(() => applyHistoryFolder()));

        new Setting(containerEl)
            .setName("Pause during Obsidian Sync")
            .setDesc("Don't capture edit history while Obsidian Sync is actively syncing. Recommended: it avoids a slowdown where each synced note write triggers a history write that Sync then has to upload (and that can conflict across devices). The edit is still captured on the device that made it, and that history file syncs across. Manual saves are never paused. Only affects the official Obsidian Sync.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.pauseDuringSync)
                .onChange(async (value) => {
                    logInfo("Pause during sync: " + value);
                    this.plugin.settings.pauseDuringSync = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl("h3", {text: "Appearance"});
        new Setting(containerEl)
            .setName("Show on status bar")
            .setDesc("Show edit history file information on the status bar. Click the status bar to show the edit history for the current file.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showOnStatusBar)
                .onChange(async (value) => {
                    logInfo("Show edits on status bar: " + value);
                    this.plugin.settings.showOnStatusBar = value;
                    await this.plugin.saveSettings();
                    this.plugin.statusBarItemEl.toggle(this.plugin.settings.showOnStatusBar);
            }));

        new Setting(containerEl)
            .setName("Diff display type")
            .setDesc("In the diff view, display the diff raw, timeline, inline, horizontally (side by side), or vertically (top by bottom).")
            .addDropdown(dropdown => dropdown
                .addOptions(diffDisplayFormatToString)
                .setValue(this.plugin.settings.diffDisplayFormat)
                .onChange(async (value) => {
                    logInfo("Diff display position: " + value);
                    this.plugin.settings.diffDisplayFormat = value;
                    await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName("Show whitespace")
            .setDesc("Show whitespace in the diff view.")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showWhitespace)
                .onChange(async (value) => {
                    logInfo("Show whitespace: " + value);
                    this.plugin.settings.showWhitespace = value;
                    await this.plugin.saveSettings();
            }));

        containerEl.createEl("h3", {text: "Debugging"});
        new Setting(containerEl)
            .setName("Debug level")
            .setDesc("Messages to show in the javascript console.")
            .addDropdown(dropdown => dropdown
                .addOption("error", "Errors")
                .addOption("warn", "Warnings")
                .addOption("info", "Information")
                .addOption("debug", "Verbose")
                .setValue(this.plugin.settings.debugLevel)
                .onChange(async (value) => {
                    logInfo("Debug level: " + value);
                    this.plugin.settings.debugLevel = value;
                    await this.plugin.saveSettings();
                }));


        /* Notes on the "History folder" setting (General section above):
            - the history folder mirrors the note folders (alternatively a
              flat folder of hashed names, but that makes renames more
              involved and history files harder to find by hand)
            - it can't be a dot folder: Obsidian doesn't index those, so
              createBinary works there but getAbstractFileByPath returns null
              and the file can never be modified or read back via the vault
            - it's applied with a button, not per keystroke, since each change
              moves every history file; moves never overwrite, and a refused
              rename (eg out of a Folder Bridge mount) falls back to a copy
            - renaming or moving the history folder (or a folder containing
              it) in the file explorer is followed by the rename handler;
              renaming folders INSIDE it desyncs those history files, which
              the setting description warns about
            - folders emptied by a move are left in place
        */


}
}
