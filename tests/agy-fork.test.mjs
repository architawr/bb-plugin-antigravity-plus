import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkAgyConversation, resolveAgyAppDataDir } from '../agy-fork.ts';

const SOURCE = '11111111-2222-4333-8444-555555555555';
const TRAJECTORY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = '99999999-8888-4777-8666-555555555555';
const NEW = '12345678-1234-4234-8234-123456789abc';

function fixture() {
  const app = mkdtempSync(join(tmpdir(), 'agy-fork-'));
  mkdirSync(join(app, 'conversations'));
  mkdirSync(join(app, 'brain', SOURCE, 'scratch'), { recursive: true });
  mkdirSync(join(app, 'annotations'));
  writeFileSync(join(app, 'brain', SOURCE, 'scratch', 'notes.md'), 'artifact');
  writeFileSync(join(app, 'annotations', `${SOURCE}.pbtxt`), 'title:"Source"');
  const db = new DatabaseSync(join(app, 'conversations', `${SOURCE}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, PRIMARY KEY (trajectory_id))');
  db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, metadata blob, note text)');
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run(TRAJECTORY, SOURCE);
  const blob = Buffer.concat([Buffer.from([10, 36]), Buffer.from(SOURCE), Buffer.from([18, 36]), Buffer.from(TRAJECTORY), Buffer.from([26, 36]), Buffer.from(OTHER), Buffer.from(SOURCE)]);
  db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, blob, `brain/${SOURCE}/scratch`);
  db.close();
  return app;
}

function readAll(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      meta: db.prepare('SELECT * FROM trajectory_meta').get(),
      step: db.prepare('SELECT * FROM steps').get(),
      journal: db.prepare('PRAGMA journal_mode').get().journal_mode,
    };
  } finally {
    db.close();
  }
}

test('copies a conversation under a new id, swapping its ids byte for byte', () => {
  const app = fixture();
  try {
    const sourceFile = join(app, 'conversations', `${SOURCE}.db`);
    const before = readAll(sourceFile);
    assert.equal(forkAgyConversation(app, SOURCE, DatabaseSync, NEW), NEW);
    const fork = readAll(join(app, 'conversations', `${NEW}.db`));
    assert.equal(fork.journal, 'wal');
    assert.equal(fork.meta.cascade_id, NEW);
    assert.notEqual(fork.meta.trajectory_id, TRAJECTORY);
    const blob = Buffer.from(fork.step.metadata);
    assert.equal(blob.length, Buffer.from(before.step.metadata).length);
    assert.equal(blob.includes(SOURCE), false);
    assert.equal(blob.includes(TRAJECTORY), false);
    assert.equal(blob.indexOf(NEW), 2);
    assert.equal(blob.includes(fork.meta.trajectory_id), true);
    assert.equal(blob.includes(OTHER), true, 'unrelated ids are kept');
    assert.equal(fork.step.note, `brain/${NEW}/scratch`);
    assert.deepEqual(readAll(sourceFile), before, 'the source is unchanged');
    assert.equal(readFileSync(join(app, 'brain', NEW, 'scratch', 'notes.md'), 'utf8'), 'artifact');
    assert.equal(readFileSync(join(app, 'annotations', `${NEW}.pbtxt`), 'utf8'), 'title:"Source"');
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('refuses malformed or missing conversations and cleans up a failed copy', () => {
  const app = fixture();
  try {
    assert.throws(() => forkAgyConversation(app, '../etc/passwd', DatabaseSync, NEW), /not an Antigravity conversation id/);
    assert.throws(() => forkAgyConversation(app, OTHER, DatabaseSync, NEW), /not found/);
    const broken = join(app, 'conversations', `${OTHER}.db`);
    const db = new DatabaseSync(broken);
    db.exec('CREATE TABLE steps (idx integer)');
    db.close();
    assert.throws(() => forkAgyConversation(app, OTHER, DatabaseSync, NEW), /trajectory_meta/);
    assert.equal(existsSync(join(app, 'conversations', `${NEW}.db`)), false);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

test('follows agy --gemini-dir and --app-data-dir', () => {
  assert.equal(resolveAgyAppDataDir(['acp'], '/home/u'), join('/home/u', '.gemini', 'antigravity-cli'));
  assert.equal(resolveAgyAppDataDir(['acp', '--gemini-dir', '/g'], '/home/u'), join('/g', 'antigravity-cli'));
  assert.equal(resolveAgyAppDataDir(['acp', '--gemini_dir=g2', '--app-data-dir', 'custom'], '/home/u'), join('/home/u', 'g2', 'custom'));
  assert.equal(resolveAgyAppDataDir(['acp', '--app_data_dir=/abs'], '/home/u'), '/abs');
});
