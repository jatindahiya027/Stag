import { useState, useEffect } from 'react'
import { AiSettings } from '../types'
import { useStore } from '../store/useStore'
import styles from './SettingsPanel.module.css'

interface Settings {
  libraryPath: string; threads: number
  bgColor: string; accentColor: string
  glassOpacity: number
  blurStrength: number
  aiSettings?: AiSettings
}

interface Props { onClose: () => void }

function hexToRgb(hex: string): [number,number,number] {
  const h = hex.replace('#','')
  const n = parseInt(h.length === 3 ? h.split('').map(c=>c+c).join('') : h, 16)
  return [(n>>16)&255,(n>>8)&255,n&255]
}

function applyTheme(s: { bgColor: string; accentColor: string; glassOpacity: number; blurStrength: number }) {
  const r = document.documentElement
  const [br,bg,bb] = hexToRgb(s.bgColor)
  // Lighten bg slightly for panel layers
  const l1 = (v: number, a: number) => Math.min(255, Math.round(v + a))
  const rgba = (rv: number, gv: number, bv: number, a: number) => `rgba(${rv},${gv},${bv},${a})`

  r.style.setProperty('--bg-app',       s.bgColor)
  r.style.setProperty('--bg-base',      s.bgColor)
  r.style.setProperty('--bg-primary',   rgba(l1(br,4), l1(bg,4), l1(bb,6), 0.97))
  r.style.setProperty('--bg-secondary', rgba(l1(br,8), l1(bg,8), l1(bb,12), 0.97))
  r.style.setProperty('--bg-tertiary',  rgba(l1(br,14), l1(bg,14), l1(bb,20), 0.93))
  r.style.setProperty('--bg-card',      rgba(l1(br,10), l1(bg,10), l1(bb,16), 0.90))
  r.style.setProperty('--accent',       s.accentColor)
  r.style.setProperty('--accent-hover', s.accentColor + 'ee')
  r.style.setProperty('--accent-dim',   s.accentColor + '28')
  r.style.setProperty('--glass-opacity', String(s.glassOpacity))
  r.style.setProperty('--blur-strength', `${s.blurStrength}px`)

  // Directly set elements that bypass CSS vars
  const root = document.getElementById('root')
  if (root) root.style.background = [
    'radial-gradient(ellipse 130% 60% at 50% -5%, rgba(74,158,255,0.06) 0%, transparent 55%)',
    'radial-gradient(ellipse 70% 45% at 100% 100%, rgba(60,80,200,0.04) 0%, transparent 55%)',
    s.bgColor,
  ].join(',')
  document.body.style.background = s.bgColor
}

export default function SettingsPanel({ onClose }: Props) {
  const [s, setS] = useState<Settings>({
    libraryPath: '', threads: 8, bgColor: '#0a0c10', accentColor: '#4a9eff',
    glassOpacity: 0.07, blurStrength: 18,
  })
  const [libPath, setLibPath] = useState('')
  const [webGrabPath, setWebGrabPath] = useState('')
  const [webGrabMsg, setWebGrabMsg] = useState('')
  const [moving, setMoving] = useState(false)
  const [moveMsg, setMoveMsg] = useState('')
  const [saved, setSaved] = useState(false)
  const [ai, setAi] = useState<AiSettings>({ enabled: false, ollamaUrl: 'http://localhost:11434', model: 'llava' })
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [ollamaStatus, setOllamaStatus] = useState<'idle'|'checking'|'ok'|'error'>('idle')
  const [ollamaMsg, setOllamaMsg] = useState('')
  const [tab, setTab] = useState<'appearance'|'library'|'performance'|'ai'>('appearance')
  const [copyEnabled, setCopyEnabled] = useState(false)
  const [copyPath, setCopyPath] = useState('')
  const [copyMsg, setCopyMsg] = useState('')

  useEffect(() => {
    ;(async () => {
      const saved = await (window as any).electronAPI?.loadSettings()
      const lp = await (window as any).electronAPI?.getLibraryPath()
      const wgp = await (window as any).electronAPI?.getWebGrabPath?.()
      if (saved) { setS(prev => ({ ...prev, ...saved })); applyTheme({ ...s, ...saved }) }
      if (saved?.aiSettings) setAi(saved.aiSettings)
      if (lp) setLibPath(lp)
      if (wgp) setWebGrabPath(wgp)
      // Load import-copy settings
      if (saved?.importCopyEnabled !== undefined) setCopyEnabled(!!saved.importCopyEnabled)
      if (saved?.importCopyPath) setCopyPath(saved.importCopyPath)
    })()
  }, [])

  // Live preview on every slider/color change
  useEffect(() => { applyTheme(s) }, [s.accentColor, s.bgColor, s.glassOpacity, s.blurStrength])

  // Auto-fetch models when switching to AI tab (silent, no error display)
  useEffect(() => {
    if (tab !== 'ai') return
    if (ollamaModels.length > 0) return  // already loaded
    ;(async () => {
      const models = await (window as any).electronAPI?.ollamaGetModels?.(ai.ollamaUrl)
      if (models?.length) {
        setOllamaModels(models)
        setOllamaStatus('ok')
        setOllamaMsg(`✓ ${models.length} model${models.length !== 1 ? 's' : ''} found`)
        if (!ai.model || !models.includes(ai.model)) {
          const vision = models.find((m: string) => /llava|bakllava|moondream|cogvlm|minicpm|qwen.*vl|gemma.*vision|vision/i.test(m))
          if (vision) setAi((x: any) => ({...x, model: vision}))
        }
      }
    })()
  }, [tab])

  const save = async () => {
    await (window as any).electronAPI?.saveSettings({ ...s, aiSettings: ai, importCopyEnabled: copyEnabled, importCopyPath: copyPath })
    const store = useStore.getState()
    const wasEnabled = store.aiSettings.enabled
    store.setAiSettings(ai)
    // If user just enabled AI tagging, kick off the queue for untagged images
    if (ai.enabled && !wasEnabled && !store.ollamaSessionFailed) {
      const untagged = await (window as any).electronAPI?.dbGetUntaggedImages?.() || []
      if (untagged.length > 0) {
        const storeAssets = useStore.getState().assets
        const toTag = untagged.map((u: any) => storeAssets.find((a: any) => a.id === u.id)).filter(Boolean)
        if (toTag.length) setTimeout(() => useStore.getState().startAiQueue(toTag), 200)
      }
    }
    setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  const chooseLibrary = async () => {
    const dir = await (window as any).electronAPI?.selectDirectory()
    if (!dir) return
    setMoving(true); setMoveMsg('Moving library…')
    const res = await (window as any).electronAPI?.moveLibrary(dir)
    if (res?.success) { setLibPath(res.newPath); setMoveMsg('✓ Moved') }
    else setMoveMsg('✕ ' + (res?.error || 'Failed'))
    setMoving(false); setTimeout(() => setMoveMsg(''), 4000)
  }

  const chooseWebGrabPath = async () => {
    const dir = await (window as any).electronAPI?.selectDirectory()
    if (!dir) return
    setWebGrabMsg('Saving…')
    const res = await (window as any).electronAPI?.setWebGrabPath?.(dir)
    if (res?.ok) { setWebGrabPath(res.path); setWebGrabMsg('✓ Saved') }
    else setWebGrabMsg('✕ ' + (res?.error || 'Failed'))
    setTimeout(() => setWebGrabMsg(''), 3000)
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>Settings</h2>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.tabs}>
          {(['appearance','library','performance','ai'] as const).map(t => (
            <button key={t} className={`${styles.tab} ${tab===t?styles.tabActive:''}`} onClick={() => setTab(t)}>
              {t === 'ai' ? '🤖 AI Tags' : t.charAt(0).toUpperCase()+t.slice(1)}
            </button>
          ))}
        </div>

        <div className={styles.body}>
          {tab === 'appearance' && <>
            <Row label="Accent colour">
              <ColorRow value={s.accentColor} onChange={v => setS(x => ({...x, accentColor: v}))} />
            </Row>
            <Row label="Background colour">
              <ColorRow value={s.bgColor} onChange={v => setS(x => ({...x, bgColor: v}))} />
            </Row>
            <Row label="Glass transparency">
              <SliderRow value={s.glassOpacity} min={0} max={0.4} step={0.01}
                display={`${Math.round(s.glassOpacity*100)}%`}
                onChange={v => setS(x => ({...x, glassOpacity: v}))} />
            </Row>
            <Row label="Blur strength">
              <SliderRow value={s.blurStrength} min={0} max={40} step={1}
                display={`${s.blurStrength}px`}
                onChange={v => setS(x => ({...x, blurStrength: v}))} />
            </Row>
            <p className={styles.hint}>All changes preview live instantly.</p>
          </>}

          {tab === 'library' && <>
            <Row label="Location"><div className={styles.pathBox}>{libPath || 'Default'}</div></Row>
            <div style={{marginTop:8}}>
              <button className={styles.btn} onClick={chooseLibrary} disabled={moving}>
                {moving ? '…' : 'Change Location'}
              </button>
            </div>
            {moveMsg && <div className={`${styles.msg} ${moveMsg.startsWith('✓')?styles.ok:styles.err}`}>{moveMsg}</div>}
            <p className={styles.hint}>Data is automatically migrated when you change location.</p>

            <div style={{marginTop:20,paddingTop:16,borderTop:'1px solid var(--border)'}}>
              <Row label="Web Grab Folder">
                <div className={styles.pathBox} style={{flex:1}}>{webGrabPath || 'Default (library/inbox)'}</div>
              </Row>
              <p className={styles.hint} style={{marginBottom:8}}>Images grabbed from the browser extension are saved here. Change to any folder — a watcher picks them up automatically.</p>
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                <button className={styles.btn} onClick={chooseWebGrabPath}>Change Folder</button>
                {webGrabPath && (
                  <button className={styles.btn} style={{opacity:0.6}} onClick={async () => {
                    const res = await (window as any).electronAPI?.setWebGrabPath?.('')
                    if (res?.ok) { setWebGrabPath(''); setWebGrabMsg('✓ Reset to default') }
                    setTimeout(() => setWebGrabMsg(''), 3000)
                  }}>Reset to Default</button>
                )}
              </div>
              {webGrabMsg && <div className={`${styles.msg} ${webGrabMsg.startsWith('✓')?styles.ok:styles.err}`} style={{marginTop:6}}>{webGrabMsg}</div>}
            </div>

            {/* ── Import Copy Folder ── */}
            <div style={{marginTop:20,paddingTop:16,borderTop:'1px solid var(--border)'}}>
              <Row label="Copy on Import">
                <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer'}}>
                  <input type="checkbox" checked={copyEnabled}
                    onChange={e => setCopyEnabled(e.target.checked)}
                    style={{width:16,height:16,cursor:'pointer',accentColor:'var(--accent)'}} />
                  <span style={{fontSize:12,color: copyEnabled ? 'var(--accent)' : 'var(--text-muted)',fontWeight: copyEnabled ? 600 : 400}}>
                    {copyEnabled ? 'Enabled' : 'Disabled'}
                  </span>
                </label>
              </Row>
              <p className={styles.hint} style={{marginBottom:8}}>
                When enabled, every imported file is <strong>copied</strong> to the folder below before being added to the library.
                The library will track the copy — not the original. Copies are deleted from disk when you permanently delete them from Stag.
                Originals are never touched.
              </p>
              <Row label="Copy Destination">
                <div className={styles.pathBox} style={{flex:1,opacity: copyEnabled ? 1 : 0.45}}>
                  {copyPath || <em style={{opacity:0.5}}>Not set — choose a folder</em>}
                </div>
              </Row>
              <div style={{display:'flex',gap:8,alignItems:'center',marginTop:6}}>
                <button className={styles.btn} disabled={!copyEnabled} onClick={async () => {
                  const dir = await (window as any).electronAPI?.selectDirectory()
                  if (!dir) return
                  setCopyPath(dir)
                  setCopyMsg('✓ Folder selected — save to apply')
                  setTimeout(() => setCopyMsg(''), 4000)
                }}>Choose Folder</button>
                {copyPath && copyEnabled && (
                  <button className={styles.btn} style={{opacity:0.6}} onClick={() => {
                    setCopyPath('')
                    setCopyMsg('✓ Cleared — save to apply')
                    setTimeout(() => setCopyMsg(''), 3000)
                  }}>Clear</button>
                )}
              </div>
              {copyMsg && <div className={`${styles.msg} ${copyMsg.startsWith('✓')?styles.ok:styles.err}`} style={{marginTop:6}}>{copyMsg}</div>}
            </div>
          </>}

          {tab === 'performance' && <>
            <Row label="Import threads">
              <SliderRow value={s.threads} min={1} max={16} step={1} display={String(s.threads)}
                onChange={v => setS(x => ({...x, threads: v}))} />
            </Row>
            <p className={styles.hint}>Higher = faster bulk import. Don't exceed CPU core count.</p>
          </>}

          {tab === 'ai' && <>
            <Row label="AI Auto-Tagging">
              <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer'}}>
                <input type="checkbox" checked={ai.enabled}
                  onChange={e => setAi(x => ({...x, enabled: e.target.checked}))}
                  style={{width:16,height:16,cursor:'pointer',accentColor:'var(--accent)'}} />
                <span style={{fontSize:12,color: ai.enabled ? 'var(--accent)' : 'var(--text-muted)',fontWeight: ai.enabled ? 600 : 400}}>
                  {ai.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </label>
            </Row>

            <Row label="Ollama URL">
              <div style={{display:'flex',gap:6,flex:1}}>
                <input type="text" value={ai.ollamaUrl}
                  onChange={e => { setAi(x => ({...x, ollamaUrl: e.target.value})); setOllamaStatus('idle'); setOllamaModels([]) }}
                  style={{flex:1,background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:5,padding:'4px 8px',color:'var(--text-primary)',fontSize:12,fontFamily:'monospace'}} />
              </div>
            </Row>

            <Row label="Vision Model">
              <div style={{display:'flex',gap:6,flex:1,alignItems:'center'}}>
                <select
                  value={ollamaModels.includes(ai.model) ? ai.model : (ollamaModels.length > 0 ? '' : ai.model)}
                  onChange={e => setAi(x => ({...x, model: e.target.value}))}
                  style={{flex:1,background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:5,padding:'4px 8px',color: ollamaModels.length === 0 ? 'var(--text-muted)' : 'var(--text-primary)',fontSize:12,cursor:'pointer'}}>
                  {ollamaModels.length === 0
                    ? <option value={ai.model}>{ai.model || 'Click Refresh to load models'}</option>
                    : <>
                        {!ollamaModels.includes(ai.model) && ai.model && (
                          <option value={ai.model}>{ai.model} (typed)</option>
                        )}
                        {ollamaModels.map(m => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </>
                  }
                </select>
                <button
                  title="Fetch installed models from Ollama"
                  style={{flexShrink:0,background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:5,padding:'4px 8px',color:'var(--text-secondary)',fontSize:11,cursor:'pointer',whiteSpace:'nowrap'}}
                  disabled={ollamaStatus === 'checking'}
                  onClick={async () => {
                    setOllamaStatus('checking'); setOllamaMsg('')
                    const r = await (window as any).electronAPI?.ollamaCheck(ai.ollamaUrl)
                    if (r?.ok) {
                      setOllamaStatus('ok')
                      const mods: string[] = r.models || []
                      setOllamaModels(mods)
                      setOllamaMsg(`✓ ${mods.length} model${mods.length !== 1 ? 's' : ''} found`)
                      // Auto-select first vision model if none set
                      if (mods.length > 0 && (!ai.model || !mods.includes(ai.model))) {
                        const vision = mods.find((m: string) => /llava|bakllava|moondream|cogvlm|minicpm|qwen.*vl|gemma.*vision|vision/i.test(m))
                        setAi(x => ({...x, model: vision || mods[0]}))
                      }
                    } else {
                      setOllamaStatus('error')
                      setOllamaMsg(r?.error || 'Cannot connect')
                      setOllamaModels([])
                    }
                  }}>
                  {ollamaStatus === 'checking' ? '…' : '↻ Refresh'}
                </button>
              </div>
            </Row>

            {ollamaMsg && (
              <div style={{marginBottom:8,padding:'5px 8px',borderRadius:5,fontSize:11.5,
                background: ollamaStatus==='ok' ? 'rgba(107,203,119,0.12)' : 'rgba(224,82,82,0.12)',
                color: ollamaStatus==='ok' ? '#6bcb77' : '#e05252',
                border: `1px solid ${ollamaStatus==='ok' ? 'rgba(107,203,119,0.3)' : 'rgba(224,82,82,0.3)'}`}}>
                {ollamaStatus === 'ok' ? '✓ ' : '✕ '}{ollamaMsg}
              </div>
            )}

            <p className={styles.hint}>
              Requires <strong>Ollama</strong> running locally with a vision model installed.<br/>
              Recommended: <code style={{fontSize:10.5,background:'var(--bg-tertiary)',padding:'1px 4px',borderRadius:3}}>ollama pull llava</code><br/>
              Tags &amp; descriptions are added to images after import. Disabled by default.
            </p>
          </>}
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button className={`${styles.saveBtn} ${saved?styles.savedBtn:''}`} onClick={save}>
            {saved ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,marginBottom:14}}>
      <span style={{fontSize:12.5,color:'var(--text-secondary)',flexShrink:0,minWidth:130}}>{label}</span>
      {children}
    </div>
  )
}
function ColorRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{display:'flex',alignItems:'center',gap:8}}>
      <input type="color" style={{width:32,height:28,border:'1px solid var(--border)',borderRadius:5,cursor:'pointer',background:'none',padding:2}} value={value} onChange={e => onChange(e.target.value)} />
      <span style={{fontSize:11.5,color:'var(--text-muted)',fontFamily:'monospace'}}>{value}</span>
    </div>
  )
}
function SliderRow({ value, min, max, step, display, onChange }: { value: number; min: number; max: number; step: number; display: string; onChange: (v: number) => void }) {
  return (
    <div style={{display:'flex',alignItems:'center',gap:8}}>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{width:130,cursor:'pointer'}} />
      <span style={{fontSize:11.5,color:'var(--text-muted)',minWidth:36,textAlign:'right'}}>{display}</span>
    </div>
  )
}
