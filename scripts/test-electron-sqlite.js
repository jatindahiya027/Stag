const assert = require('assert')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const electronPath = require('electron')
const expectedElectron = require(path.join(root, 'node_modules', 'electron', 'package.json')).version
const result = spawnSync(electronPath, [path.join(__dirname, 'electron-sqlite-smoke.js')], {
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  },
  encoding: 'utf8',
})

if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
assert.strictEqual(result.status, 0, `Electron SQLite smoke test exited ${result.status}.`)

const output = result.stdout.trim().split(/\r?\n/).at(-1)
const details = JSON.parse(output)
assert.strictEqual(details.electron, expectedElectron)
assert.strictEqual(details.integrity, 'ok')
console.log('Electron better-sqlite3 ABI and database smoke test passed.')
