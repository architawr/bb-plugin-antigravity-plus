/*
 * What: copies an Antigravity CLI conversation under a new id, so ACP session/fork can continue it separately.
 *
 * Why: bb's Fork action needs the agent to advertise session/fork. agy has a native
 * ForkConversation and a `/fork` command, but exposes neither over ACP, and refuses `/fork`
 * in print mode. agy does resume any conversation whose `<id>.db` exists, so a fork is a
 * consistent copy of the source database with its ids swapped.
 *
 * Design notes:
 * - Layout (agy 1.5.14): `<appData>/conversations/<id>.db` (SQLite, WAL), `<appData>/brain/<id>/`
 *   (artifacts, transcripts), `<appData>/annotations/<id>.pbtxt` (title). The shared index files
 *   (cache/*.json, conversation_summaries.db) hold no per-conversation entries agy needs to resume.
 * - The conversation (cascade) id and the trajectory id live in `trajectory_meta` and inside
 *   protobuf blobs. Both are 36-character UUIDs, so a byte-for-byte swap keeps every protobuf
 *   length prefix valid. Other UUIDs (steps, messages, projects) are left alone.
 * - `VACUUM INTO` takes a transactionally consistent snapshot, including rows still in the
 *   source's WAL, and writes nothing to the source rows. The source is opened read-write on
 *   purpose: agy deletes -wal/-shm when it exits, and SQLite cannot open a WAL database
 *   read-only without them.
 * - The SQLite class is passed in, so importing this module never loads `node:sqlite`
 *   (unavailable or flagged on older Node 22 releases).
 *
 * Gotchas:
 * - Ported from mturilin/antigravity-acp src/conversation/fork.ts (Bun) to node:sqlite.
 * - Brain and annotation copies are best effort; the database copy is what makes the fork resumable.
 * - Forks only at the tip: the whole history is copied.
 */
import { randomUUID } from "node:crypto";
import { cpSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Statement {
  all(...params: unknown[]): any[];
  run(...params: unknown[]): unknown;
}
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
export type SqliteDatabaseClass = new (path: string, options?: Record<string, unknown>) => SqliteDatabase;

/** Where agy keeps conversations, following its --gemini-dir and --app-data-dir flags. */
export function resolveAgyAppDataDir(agyArgs: readonly string[], home = homedir()): string {
  const flag = (...names: string[]) => {
    for (let i = 0; i < agyArgs.length; i++) {
      for (const name of names) {
        if (agyArgs[i] === name) return agyArgs[i + 1];
        if (agyArgs[i].startsWith(`${name}=`)) return agyArgs[i].slice(name.length + 1);
      }
    }
    return undefined;
  };
  const gemini = flag("--gemini-dir", "--gemini_dir") ?? ".gemini";
  const geminiDir = isAbsolute(gemini) ? gemini : join(home, gemini);
  const appData = flag("--app-data-dir", "--app_data_dir") ?? "antigravity-cli";
  return isAbsolute(appData) ? appData : join(geminiDir, appData);
}

/** Returns a copy of `value` with every pair swapped, or undefined when nothing matched. */
function replaceBytes(value: Uint8Array, pairs: Array<[Buffer, Buffer]>): Buffer | undefined {
  const view = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  let copy: Buffer | undefined;
  for (const [from, to] of pairs) {
    let at = (copy ?? view).indexOf(from);
    if (at === -1) continue;
    copy ??= Buffer.from(view);
    while (at !== -1) {
      copy.set(to, at);
      at = copy.indexOf(from, at + to.length);
    }
  }
  return copy;
}

function rewriteIds(db: SqliteDatabase, ids: Map<string, string>): void {
  const pairs = [...ids].map(([from, to]) => [Buffer.from(from), Buffer.from(to)] as [Buffer, Buffer]);
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(row => String(row.name));
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => String(row.name));
    for (const row of db.prepare(`SELECT rowid AS __rowid, * FROM ${quote(table)}`).all()) {
      for (const column of columns) {
        const value = row[column];
        let next: Buffer | string | undefined;
        if (value instanceof Uint8Array) {
          next = replaceBytes(value, pairs);
        } else if (typeof value === "string") {
          let text = value;
          for (const [from, to] of ids) text = text.split(from).join(to);
          if (text !== value) next = text;
        }
        if (next !== undefined) db.prepare(`UPDATE ${quote(table)} SET ${quote(column)} = ? WHERE rowid = ?`).run(next, row.__rowid);
      }
    }
  }
}

/**
 * Copies conversation `sourceId` under a new id and returns the id. The source is only read.
 * Throws if the id is malformed, the conversation does not exist, or the copy fails.
 */
export function forkAgyConversation(
  appDataDir: string,
  sourceId: string,
  Database: SqliteDatabaseClass,
  newId: string = randomUUID(),
  log: (message: string) => void = () => {},
): string {
  if (!UUID_PATTERN.test(sourceId)) throw new Error(`not an Antigravity conversation id: ${sourceId}`);
  const conversations = join(appDataDir, "conversations");
  const sourcePath = join(conversations, `${sourceId}.db`);
  if (!existsSync(sourcePath)) throw new Error(`Antigravity conversation not found: ${sourceId}`);
  const targetPath = join(conversations, `${newId}.db`);
  const brainTarget = join(appDataDir, "brain", newId);
  try {
    const source = new Database(sourcePath);
    try {
      source.prepare("VACUUM INTO ?").run(targetPath);
    } finally {
      source.close();
    }
    const target = new Database(targetPath);
    try {
      // VACUUM INTO writes a rollback-journal database; agy keeps conversations in WAL mode.
      target.exec("PRAGMA journal_mode = WAL");
      const ids = new Map<string, string>([[sourceId, newId]]);
      for (const row of target.prepare("SELECT trajectory_id FROM trajectory_meta").all()) {
        const trajectoryId = row.trajectory_id;
        if (typeof trajectoryId === "string" && UUID_PATTERN.test(trajectoryId)) ids.set(trajectoryId, randomUUID());
      }
      target.exec("BEGIN");
      try {
        rewriteIds(target, ids);
        target.exec("COMMIT");
      } catch (error) {
        target.exec("ROLLBACK");
        throw error;
      }
    } finally {
      target.close();
    }
  } catch (error) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${targetPath}${suffix}`, { force: true });
    throw error;
  }
  const brainSource = join(appDataDir, "brain", sourceId);
  try {
    if (existsSync(brainSource)) cpSync(brainSource, brainTarget, { recursive: true });
  } catch (error) {
    log(`could not copy the conversation's brain folder for the fork: ${error instanceof Error ? error.message : String(error)}`);
  }
  const annotation = join(appDataDir, "annotations", `${sourceId}.pbtxt`);
  try {
    if (existsSync(annotation)) copyFileSync(annotation, join(appDataDir, "annotations", `${newId}.pbtxt`));
  } catch (error) {
    log(`could not copy the conversation's title for the fork: ${error instanceof Error ? error.message : String(error)}`);
  }
  return newId;
}
