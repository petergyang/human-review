import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalTarget, ensureStateDir, pageKey, realFile, statePath, targetKey } from "./paths.js";

/** Anything untouched this long is review debris, not work in progress. */
const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const fresh = (entry, now) => !!entry && now - (entry.updatedAt || 0) < PRUNE_AGE_MS;

/**
 * Atomic write via a unique sibling tmp file. The name is unguessable and the
 * create is exclusive, so a pre-planted symlink can never redirect the write,
 * and a failed rename never leaves a predictable orphan behind.
 */
export function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.human-review.tmp`;
  fs.writeFileSync(tmp, data, { flag: "wx" });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

/**
 * All durable state lives in one JSON file. No database, no network.
 *
 * Shape:
 *   {
 *     pages:   { <key>: { key, file, pristine, comments[], edits[], updatedAt } },
 *     batches: { <entryKey>: { batch, cleanup, updatedAt } },
 *   }
 *
 * Pages are fully independent: no page ever references another. Batches are
 * feedback the user sent that no agent has acknowledged yet; persisting them
 * means "your feedback is safe" stays true across server restarts.
 */
export class Store {
  constructor() {
    this.data = { pages: {}, batches: {} };
    /** Batches this process acked; save() must not resurrect them from disk. */
    this.clearedBatches = new Set();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(statePath(), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.pages) {
        this.data = { pages: parsed.pages, batches: parsed.batches || {} };
      }
    } catch {
      // Missing or unreadable state is not an error; start empty.
    }
    this.prune();
    return this.data;
  }

  /** Drop pages whose file is gone or that nobody has touched in a month. */
  prune() {
    const now = Date.now();
    for (const [key, page] of Object.entries(this.data.pages)) {
      const missingFile = page.kind !== "url" && !fs.existsSync(page.file);
      if (!fresh(page, now) || missingFile) {
        delete this.data.pages[key];
        delete this.data.batches[key];
      }
    }
    for (const [key, batch] of Object.entries(this.data.batches)) {
      if (!fresh(batch, now)) delete this.data.batches[key];
    }
  }

  /**
   * Merge over whatever is on disk rather than overwriting it. If a second
   * server is ever running, a blind write would silently drop the pages and
   * comments it owns.
   */
  save() {
    ensureStateDir();
    const target = statePath();
    let onDisk = { pages: {}, batches: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      if (parsed && parsed.pages) onDisk = { pages: parsed.pages, batches: parsed.batches || {} };
    } catch {
      // No readable state yet; ours becomes the file.
    }
    const merged = {
      pages: { ...onDisk.pages, ...this.data.pages },
      batches: { ...onDisk.batches, ...this.data.batches },
    };
    for (const key of this.clearedBatches) delete merged.batches[key];
    // Age-prune the merged result too, so the file cannot grow without bound.
    const now = Date.now();
    for (const [key, page] of Object.entries(merged.pages)) {
      if (!fresh(page, now)) delete merged.pages[key];
    }
    for (const [key, batch] of Object.entries(merged.batches)) {
      if (!fresh(batch, now)) delete merged.batches[key];
    }
    atomicWrite(target, JSON.stringify(merged, null, 2));
  }

  /** Register a file as a reviewable page, capturing the agent's version. */
  openPage(file, pristine) {
    const key = pageKey(file);
    const existing = this.data.pages[key];
    const page = existing || {
      key,
      kind: "file",
      file: realFile(file),
      pristine: "",
      comments: [],
      edits: [],
      updatedAt: 0,
    };
    page.kind = "file";
    page.file = realFile(file);
    delete page.url;
    if (!existing || typeof pristine === "string") {
      page.pristine = typeof pristine === "string" ? pristine : page.pristine;
    }
    page.updatedAt = Date.now();
    this.data.pages[key] = page;
    this.save();
    return page;
  }

  /** Register a rendered localhost route. Browser edits are never written to it. */
  openUrl(url) {
    const target = canonicalTarget(url);
    if (target.kind !== "url") throw new Error("Expected a localhost URL.");
    const key = targetKey(target.value);
    const existing = this.data.pages[key];
    const page = existing || {
      key,
      kind: "url",
      url: target.value,
      pristine: "",
      comments: [],
      edits: [],
      updatedAt: 0,
    };
    page.kind = "url";
    page.url = target.value;
    delete page.file;
    page.updatedAt = Date.now();
    this.data.pages[key] = page;
    this.save();
    return page;
  }

  page(key) {
    return this.data.pages[key] || null;
  }

  pageForFile(file) {
    return this.page(pageKey(file));
  }

  pageForTarget(target) {
    return this.page(targetKey(target));
  }

  update(key, mutate) {
    const page = this.page(key);
    if (!page) return null;
    mutate(page);
    page.updatedAt = Date.now();
    this.save();
    return page;
  }

  addComment(key, comment) {
    return this.update(key, (page) => {
      page.comments.push(comment);
    });
  }

  removeComment(key, id) {
    return this.update(key, (page) => {
      page.comments = page.comments.filter((c) => c.id !== id);
    });
  }

  /** Reword feedback, optionally turning a delivered instruction into a correction. */
  updateComment(key, id, feedback, { replacementId = "", correctionOf = "" } = {}) {
    let found = false;
    const page = this.update(key, (p) => {
      const index = p.comments.findIndex((c) => c.id === id);
      const comment = p.comments[index];
      if (comment) {
        const updated = {
          ...comment,
          ...(replacementId ? { id: replacementId } : {}),
          feedback,
          updatedAt: Date.now(),
          ...(correctionOf ? { correction: true, correctionOf } : {}),
        };
        p.comments[index] = updated;
        found = true;
      }
    });
    return found ? page : null;
  }

  /**
   * Edits are deduped by label+kind so retyping one block stays one row, but
   * the text is refreshed every time so `after` is always the latest wording.
   */
  addEdit(key, label, kind, before, after, beforeHtml, afterHtml, extra) {
    return this.update(key, (page) => {
      const row = page.edits.find((e) => e.label === label && e.kind === kind);
      if (row) {
        if (after !== undefined) row.after = after;
        if (afterHtml !== undefined) row.after_html = afterHtml;
        // A re-move of the same block replaces its landing spot.
        if (extra) {
          if (extra.staged_assets) {
            const assets = [...(row.staged_assets || []), ...extra.staged_assets];
            extra = { ...extra, staged_assets: [...new Map(assets.map((asset) => [asset.path, asset])).values()] };
          }
          Object.assign(row, extra);
        }
        row.updatedAt = Date.now();
        return;
      }
      page.edits.push({ label, kind, before, after, before_html: beforeHtml, after_html: afterHtml, ...(extra || {}), at: Date.now(), updatedAt: Date.now() });
    });
  }

  clearEdits(key) {
    return this.update(key, (page) => {
      page.edits = [];
    });
  }

  /** After the agent writes, its version becomes the new revert target. */
  setPristine(key, html) {
    return this.update(key, (page) => {
      page.pristine = html;
      page.edits = [];
    });
  }

  /**
   * Drop exactly what the acknowledged batch carried. Comments made after
   * Send have unknown ids; edits made (or retyped) after Send have a newer
   * timestamp than the batch. Both must survive for the next batch.
   */
  clearSent(key, ids, sentAt) {
    return this.update(key, (page) => {
      const drop = new Set(ids);
      page.comments = page.comments.filter((c) => !drop.has(c.id));
      // >= not >: an edit stamped the same millisecond as the send may not
      // have shipped — resending it is harmless, dropping it loses work.
      page.edits = typeof sentAt === "number" ? page.edits.filter((e) => (e.updatedAt || e.at || 0) >= sentAt) : [];
    });
  }

  // Sent-but-unacked feedback, keyed by the entry page the agent polls.

  batch(entryKey) {
    return this.data.batches[entryKey] || null;
  }

  allBatches() {
    return this.data.batches;
  }

  setBatch(entryKey, { batch, cleanup }) {
    this.clearedBatches.delete(entryKey);
    this.data.batches[entryKey] = { batch, cleanup, updatedAt: Date.now() };
    this.save();
  }

  clearBatch(entryKey) {
    delete this.data.batches[entryKey];
    this.clearedBatches.add(entryKey);
    this.save();
  }
}

/** Resolve a sibling asset request without escaping the artifact's directory. */
export function resolveAsset(pageFile, relative) {
  let decoded;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return null;
  }
  const base = path.dirname(pageFile);
  const target = path.resolve(base, decoded);
  const contained = (candidate, root) => {
    const rel = path.relative(root, candidate);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  if (!contained(target, base)) return null;
  // The lexical check alone would follow a symlink out of the directory, so
  // the resolved filesystem path must land inside it too.
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    // Nothing readable at that path — anything a symlink could point to would
    // have resolved. The caller's read fails with a plain 404.
    return target;
  }
  let realBase = base;
  try {
    realBase = fs.realpathSync(base);
  } catch {}
  if (!contained(real, realBase)) return null;
  return real;
}
