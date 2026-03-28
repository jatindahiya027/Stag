import { useState } from 'react'
import { useStore } from '../store/useStore'
import SettingsPanel from './SettingsPanel'
import styles from './TitleBar.module.css'

export default function TitleBar() {
  const {
    sidebarOpen, setSidebarOpen, inspectorOpen, setInspectorOpen,
    aiProgress, importProgress, aiSettings, setAiSettings, stopAiQueue,
  } = useStore()
  const [showSettings, setShowSettings] = useState(false)
  const api = (window as any).electronAPI

  const showProgress = (aiProgress?.active) || !!importProgress

  const toggleAi = () => {
    const next = { ...aiSettings, enabled: !aiSettings.enabled }
    setAiSettings(next)
    if (!next.enabled) stopAiQueue()
  }

  return (
    <>
      <div className={styles.titlebar}>

        {/* ── Left: window controls ── */}
        <div className={styles.controls}>
          <button className={`${styles.btn} ${styles.close}`}    onClick={() => api?.close()}    title="Close"><span className={styles.btnIcon}>✕</span></button>
          <button className={`${styles.btn} ${styles.minimize}`} onClick={() => api?.minimize()} title="Minimize"><span className={styles.btnIcon}>−</span></button>
          <button className={`${styles.btn} ${styles.maximize}`} onClick={() => api?.maximize()} title="Maximize"><span className={styles.btnIcon}>⤢</span></button>
        </div>

        {/* ── Center: app title (hidden when progress showing) OR progress bar ── */}
        <div className={styles.center}>
          {!showProgress && (
            <div className={styles.appTitle}>
              <span className={styles.appIcon}>🦌</span>
              <span className={styles.appName}>Stag</span>
            </div>
          )}

          {aiProgress?.active && (
            <div className={styles.progressRow}>
              <span className={styles.progressLabel} style={{color:'var(--accent)'}}>🤖 AI</span>
              <div className={styles.progressTrack}>
                <div className={styles.progressFill} style={{
                  width: `${Math.round((aiProgress.done / Math.max(1, aiProgress.total)) * 100)}%`,
                  background: 'var(--accent)',
                }} />
              </div>
              <span className={styles.progressCount}>{aiProgress.done}/{aiProgress.total}</span>
              {aiProgress.current && (
                <span className={styles.progressFile}>{aiProgress.current}</span>
              )}
            </div>
          )}

          {importProgress && !aiProgress?.active && (
            <div className={styles.progressRow}>
              <span className={styles.progressLabel} style={{color:'#ffd93d'}}>⬆ Import</span>
              <div className={styles.progressTrack}>
                <div className={styles.progressFill} style={{
                  width: `${Math.round((importProgress.current / Math.max(1, importProgress.total)) * 100)}%`,
                  background: '#ffd93d',
                }} />
              </div>
              <span className={styles.progressCount}>{importProgress.current}/{importProgress.total}</span>
              {importProgress.currentName && (
                <span className={styles.progressFile}>{importProgress.currentName}</span>
              )}
            </div>
          )}
        </div>

        {/* ── Right: action buttons ── */}
        <div className={styles.actions}>
          {/* Quick AI toggle */}
          <button
            className={`${styles.aiToggle} ${aiSettings.enabled ? styles.aiOn : styles.aiOff}`}
            onClick={toggleAi}
            title={aiSettings.enabled ? 'AI tagging ON — click to disable' : 'AI tagging OFF — click to enable'}
          >
            <span className={styles.aiIcon}>🤖</span>
            <span className={styles.aiLabel}>{aiSettings.enabled ? 'AI' : 'AI'}</span>
            <span className={styles.aiDot} />
          </button>

          <div className={styles.divider} />

          <button className={`${styles.iconBtn} ${sidebarOpen ? styles.active : ''}`}
            onClick={() => setSidebarOpen(!sidebarOpen)} title="Toggle sidebar">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="2" width="4" height="10" rx="1" fill="currentColor" opacity="0.7"/>
              <rect x="7" y="2" width="6" height="2" rx="0.5" fill="currentColor" opacity="0.5"/>
              <rect x="7" y="6" width="6" height="2" rx="0.5" fill="currentColor" opacity="0.5"/>
              <rect x="7" y="10" width="6" height="2" rx="0.5" fill="currentColor" opacity="0.5"/>
            </svg>
          </button>
          <button className={`${styles.iconBtn} ${inspectorOpen ? styles.active : ''}`}
            onClick={() => setInspectorOpen(!inspectorOpen)} title="Toggle inspector">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="9" y="2" width="4" height="10" rx="1" fill="currentColor" opacity="0.7"/>
              <rect x="1" y="2" width="6" height="2" rx="0.5" fill="currentColor" opacity="0.5"/>
              <rect x="1" y="6" width="6" height="2" rx="0.5" fill="currentColor" opacity="0.5"/>
              <rect x="1" y="10" width="6" height="2" rx="0.5" fill="currentColor" opacity="0.5"/>
            </svg>
          </button>
          <button className={styles.iconBtn} onClick={() => setShowSettings(true)} title="Settings">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <circle cx="6.5" cy="6.5" r="2" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M6.5 1v1.5M6.5 10.5V12M1 6.5h1.5M10.5 6.5H12M2.6 2.6l1.1 1.1M9.3 9.3l1.1 1.1M2.6 10.4l1.1-1.1M9.3 3.7l1.1-1.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </>
  )
}
