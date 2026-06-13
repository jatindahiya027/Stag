const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Database = require('better-sqlite3')

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stag-sqlite-smoke-'))
const databasePath = path.join(tempDir, 'smoke.sqlite')

try {
  assert(process.versions.electron, 'Smoke test must run with Electron.')

  let database = new Database(databasePath)
  assert.strictEqual(database.pragma('journal_mode = WAL', { simple: true }), 'wal')
  database.exec(`
    CREATE TABLE assets (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      indexed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tags (
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      value TEXT NOT NULL
    );
  `)

  const insertAsset = database.prepare(
    'INSERT INTO assets (name, indexed) VALUES (?, ?)',
  )
  const insertTag = database.prepare(
    'INSERT INTO tags (asset_id, value) VALUES (?, ?)',
  )
  database.transaction(() => {
    const first = insertAsset.run('first.jpg', 0)
    const second = insertAsset.run('second.pdf', 1)
    insertTag.run(first.lastInsertRowid, 'image')
    insertTag.run(second.lastInsertRowid, 'document')
  })()

  database.prepare('UPDATE assets SET indexed = 1 WHERE name = ?').run('first.jpg')
  const rows = database.prepare(`
    SELECT assets.name, assets.indexed, tags.value
    FROM assets
    JOIN tags ON tags.asset_id = assets.id
    ORDER BY assets.id
  `).all()
  assert.deepStrictEqual(rows, [
    { name: 'first.jpg', indexed: 1, value: 'image' },
    { name: 'second.pdf', indexed: 1, value: 'document' },
  ])
  database.close()

  database = new Database(databasePath, { readonly: true })
  assert.strictEqual(database.pragma('integrity_check', { simple: true }), 'ok')
  assert.strictEqual(database.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 2)
  database.close()

  console.log(JSON.stringify({
    electron: process.versions.electron,
    node: process.versions.node,
    modules: process.versions.modules,
    betterSqlite3: require('better-sqlite3/package.json').version,
    integrity: 'ok',
  }))
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}
