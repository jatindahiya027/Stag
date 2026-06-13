const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const sharp = require('sharp')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8')
const bootstrap = fs.readFileSync(path.join(root, 'src/renderer/components/RuntimeBootstrap.tsx'), 'utf8')
const store = fs.readFileSync(path.join(root, 'src/renderer/store/useStore.ts'), 'utf8')

async function auditImageOrientation(tmpDir) {
  const source = path.join(tmpDir, 'orientation-6.jpg')
  await sharp({
    create: { width: 120, height: 60, channels: 3, background: '#d33' },
  }).withMetadata({ orientation: 6 }).jpeg().toFile(source)

  const result = await sharp(source)
    .rotate()
    .resize(100, 100, { fit: 'inside' })
    .toBuffer({ resolveWithObject: true })

  assert.deepStrictEqual(
    [result.info.width, result.info.height],
    [50, 100],
    'EXIF orientation must be applied before thumbnail resize.',
  )
assert(
    main.includes('.rotate()') && main.includes('const swapsAxes = meta.orientation'),
    'Main thumbnail pipeline must rotate pixels and store oriented dimensions.',
)
assert(
  main.includes('function reconcileMissingThumbnailFiles()') &&
    main.includes('reconcileMissingThumbnailFiles()') &&
    main.includes("thumbLog('worker:deferred:runtime-not-ready')") &&
    main.includes('setImmediate(() => runThumbWorker())'),
  'Missing persisted thumbnails must be reconciled and regenerated after managed tools become ready.',
)
assert(
  bootstrap.includes("import appIconUrl from '../../../public/icon.png'") &&
    bootstrap.includes('className={styles.appIcon} src={appIconUrl}') &&
    bootstrap.includes('<img src={appIconUrl} alt="" />'),
  'First-run screens must use the packaged Stag app icon.',
)
  assert(
    main.includes('migrateOrientedImageThumbsV9') &&
      main.includes("dbRun('UPDATE assets SET hasThumb=0 WHERE id=?', [row.id])"),
    'Existing EXIF-oriented thumbnails must be invalidated once.',
  )
}

function auditVideoFrames(tmpDir) {
  const ffmpeg = require('ffmpeg-static')
  const mp4 = path.join(tmpDir, 'scrub.mp4')
  const f4v = path.join(tmpDir, 'scrub.f4v')
  const frame = path.join(tmpDir, 'frame.jpg')

  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10',
    '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', mp4,
  ])
  fs.copyFileSync(mp4, f4v)
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-ss', '0.5', '-i', f4v, '-frames:v', '1', '-y', frame,
  ])

  assert(fs.statSync(frame).size > 64, 'ffmpeg must extract a frame from F4V.')
  assert(
    main.includes("const VIDEO_EXTS = new Set(['mp4','webm','mov','avi','mkv','m4v','f4v'"),
    'Main video extension set must include F4V.',
  )
  assert(
    main.includes("if (transient || ext === 'ts' || ext === 'mts' || ext === 'm2ts' || ext === 'f4v')"),
    'Transient scrub frames and F4V must use ffmpeg.',
  )
  assert(
    !main.includes('stat.size > 500 * 1024 * 1024'),
    'Large videos must not be rejected before streamed ffmpeg extraction.',
  )
}

function auditRecentWindow() {
  assert(
    store.includes('const RECENT_ASSET_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000'),
    'Recently Used must use a 48-hour window.',
  )
  assert(
    store.includes('now - entry.usedAt <= RECENT_ASSET_MAX_AGE_MS'),
    'Expired recent entries must be pruned.',
  )
}

async function mainAudit() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stag-media-audit-'))
  try {
    await auditImageOrientation(tmpDir)
    auditVideoFrames(tmpDir)
    auditRecentWindow()
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
  console.log('Media contract audit passed: EXIF orientation, F4V/large-video scrub, 48-hour recents.')
}

mainAudit().catch(error => {
  console.error(error)
  process.exit(1)
})
