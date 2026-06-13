import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  BrainCircuit,
  Check,
  Download,
  FileType2,
  ImageIcon,
  Moon,
  RefreshCw,
  Sun,
  Terminal,
  WifiOff,
  Wrench,
} from 'lucide-react'
import App from '../App'
import appIconUrl from '../../../public/icon.png'
import styles from './RuntimeBootstrap.module.css'

type RuntimeStatus = {
  type?: string
  label?: string
  detail?: string
  error?: string
  bytesDone?: number
  bytesTotal?: number
  progressPercent?: number
  coreReady?: boolean
  aiReady?: boolean
  logPath?: string
}

type Screen = 'loading' | 'welcome' | 'theme' | 'requirements' | 'installing'
type Theme = 'light' | 'dark'
type NetworkState = 'idle' | 'checking' | 'online' | 'offline'

function percent(status: RuntimeStatus) {
  const reported = Number(status.progressPercent)
  if (Number.isFinite(reported)) return Math.max(0, Math.min(100, Math.round(reported)))
  const done = Number(status.bytesDone || 0)
  const total = Number(status.bytesTotal || 0)
  return total > 0 ? Math.max(2, Math.min(100, Math.round((done / total) * 100))) : 32
}

export default function RuntimeBootstrap() {
  const api = (window as any).electronAPI
  const initiallyReady = api?.initialRuntimeReady === true
  const [status, setStatus] = useState<RuntimeStatus>({ type: 'checking', label: 'Checking application dependencies' })
  const [ready, setReady] = useState(initiallyReady)
  const [screen, setScreen] = useState<Screen>('loading')
  const [theme, setTheme] = useState<Theme>(() => (
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  ))
  const [network, setNetwork] = useState<NetworkState>('idle')
  const initialized = useRef(false)
  const installing = useRef(false)
  const completed = useRef(false)

  const saveOnboardingState = async (updates: Record<string, unknown>) => {
    const current = await api?.loadSettings?.().catch(() => ({}))
    await api?.saveSettings?.({ ...(current || {}), ...updates })
  }

  const continueToApp = async () => {
    if (completed.current) return
    completed.current = true
    await saveOnboardingState({
      onboardingCompleted: true,
      onboardingInstallStarted: false,
    }).catch(() => undefined)
    setReady(true)
  }

  const checkInternet = async () => {
    setNetwork('checking')
    try {
      const result = await api?.checkRuntimeInternet?.()
      const online = result?.online === true
      setNetwork(online ? 'online' : 'offline')
      return online
    } catch {
      setNetwork('offline')
      return false
    }
  }

  const install = async (persistStart = true) => {
    if (installing.current) return
    if (persistStart) {
      await saveOnboardingState({ onboardingInstallStarted: true })
      setScreen('installing')
    }

    const online = await checkInternet()
    if (!online) {
      setStatus({
        type: 'offline',
        label: 'Internet connection required',
        error: 'Connect to the internet to download the required files.',
      })
      return
    }

    installing.current = true
    setStatus({ type: 'checking', label: 'Preparing dependency installation' })
    try {
      const result = await api?.installRuntime?.()
      if (result?.ok) await continueToApp()
      else {
        setStatus(current => ({
          ...current,
          type: 'error',
          label: 'Installation failed',
          error: result?.error || 'Unknown installation error',
          logPath: result?.logPath || current.logPath,
        }))
      }
    } finally {
      installing.current = false
    }
  }

  const chooseTheme = async (nextTheme: Theme) => {
    setTheme(nextTheme)
    document.documentElement.dataset.theme = nextTheme
    localStorage.setItem('stag-theme', nextTheme)
    window.dispatchEvent(new CustomEvent('stag:themeChanged', { detail: { theme: nextTheme } }))
    await saveOnboardingState({ theme: nextTheme }).catch(() => undefined)
  }

  useEffect(() => {
    if (initialized.current || initiallyReady) return
    initialized.current = true

    const offProgress = api?.onRuntimeProgress?.((next: RuntimeStatus) => {
      setStatus(next)
      if (next.aiReady || next.type === 'done') void continueToApp()
    })

    Promise.all([
      api?.getRuntimeStatus?.(),
      api?.loadSettings?.(),
    ]).then(([current, settings]: [RuntimeStatus, any]) => {
      setStatus(current || {})
      if (current?.aiReady) {
        void continueToApp()
        return
      }
      if (settings?.onboardingInstallStarted === true) {
        setScreen('installing')
        void install(false)
        return
      }
      if (settings?.onboardingCompleted === true) {
        setScreen('installing')
        void install(true)
        return
      }
      setScreen('welcome')
    }).catch((error: any) => {
      setScreen('welcome')
      setStatus({ type: 'error', label: 'Dependency check failed', error: String(error?.message || error) })
    })

    return () => offProgress?.()
  }, [])

  if (ready) return <App />

  return (
    <main className={styles.screen}>
      <section className={styles.shell} aria-live="polite">
        <header className={styles.header}>
          <img className={styles.appIcon} src={appIconUrl} alt="Stag" />
          {screen !== 'installing' && screen !== 'loading' && (
            <div className={styles.progressDots} aria-label={`Onboarding step ${screen === 'welcome' ? 1 : screen === 'theme' ? 2 : 3} of 3`}>
              <span className={styles.currentDot} />
              <span className={screen === 'theme' || screen === 'requirements' ? styles.currentDot : ''} />
              <span className={screen === 'requirements' ? styles.currentDot : ''} />
            </div>
          )}
        </header>

        <div className={styles.content}>
          {screen === 'loading' && <LoadingScreen />}
          {screen === 'welcome' && <WelcomeScreen onNext={() => setScreen('theme')} />}
          {screen === 'theme' && (
            <ThemeScreen
              theme={theme}
              onChoose={next => void chooseTheme(next)}
              onNext={() => setScreen('requirements')}
            />
          )}
          {screen === 'requirements' && (
            <RequirementsScreen
              network={network}
              onCheck={() => void checkInternet()}
              onInstall={() => void install(true)}
            />
          )}
          {screen === 'installing' && (
            <InstallationScreen
              status={status}
              network={network}
              onRetry={() => void install(false)}
              onShowLog={() => status.logPath && api?.showInFolder?.(status.logPath)}
            />
          )}
        </div>
      </section>
    </main>
  )
}

function LoadingScreen() {
  return (
    <div className={styles.loadingScreen}>
      <span className={styles.loadingMark} />
      <p>Opening Stag</p>
    </div>
  )
}

function WelcomeScreen({ onNext }: { onNext: () => void }) {
  return (
    <div className={styles.page}>
      <div className={styles.welcomeGraphic} aria-hidden="true">
        <span className={styles.orbitOne} />
        <span className={styles.orbitTwo} />
        <img src={appIconUrl} alt="" />
      </div>
      <div className={styles.copy}>
        <h1>Welcome to Stag</h1>
        <p>Keep your visual library organized, searchable, and ready when you need it.</p>
      </div>
      <FooterButton onClick={onNext}>Get started</FooterButton>
    </div>
  )
}

function ThemeScreen({
  theme,
  onChoose,
  onNext,
}: {
  theme: Theme
  onChoose: (theme: Theme) => void
  onNext: () => void
}) {
  return (
    <div className={styles.page}>
      <div className={styles.copy}>
        <h1>Choose your theme</h1>
        <p>You can change this later in Settings.</p>
      </div>
      <div className={styles.themeOptions} role="radiogroup" aria-label="App theme">
        <button
          className={`${styles.themeOption} ${theme === 'dark' ? styles.selectedTheme : ''}`}
          type="button"
          role="radio"
          aria-checked={theme === 'dark'}
          onClick={() => onChoose('dark')}
        >
          <span className={`${styles.themePreview} ${styles.darkPreview}`}>
            <span className={styles.previewSidebar} />
            <span className={styles.previewGrid}><i /><i /><i /><i /></span>
          </span>
          <span className={styles.themeLabel}><Moon size={17} /> Dark</span>
          {theme === 'dark' && <Check size={16} className={styles.themeCheck} />}
        </button>
        <button
          className={`${styles.themeOption} ${theme === 'light' ? styles.selectedTheme : ''}`}
          type="button"
          role="radio"
          aria-checked={theme === 'light'}
          onClick={() => onChoose('light')}
        >
          <span className={`${styles.themePreview} ${styles.lightPreview}`}>
            <span className={styles.previewSidebar} />
            <span className={styles.previewGrid}><i /><i /><i /><i /></span>
          </span>
          <span className={styles.themeLabel}><Sun size={17} /> Light</span>
          {theme === 'light' && <Check size={16} className={styles.themeCheck} />}
        </button>
      </div>
      <FooterButton onClick={onNext}>Continue</FooterButton>
    </div>
  )
}

function RequirementsScreen({
  network,
  onCheck,
  onInstall,
}: {
  network: NetworkState
  onCheck: () => void
  onInstall: () => void
}) {
  return (
    <div className={styles.page}>
      <div className={styles.requirementIcon}><Download size={28} /></div>
      <div className={styles.copy}>
        <h1>One last setup</h1>
        <p>Stag needs to download its media and AI tools before your library opens.</p>
      </div>
      <div className={styles.installNote}>
        <Check size={16} />
        <span>Installed privately for Stag</span>
      </div>
      {network === 'offline' && (
        <div className={styles.offlineMessage} role="alert">
          <WifiOff size={18} />
          <div>
            <strong>No internet connection</strong>
            <span>Connect to the internet, then check again.</span>
          </div>
          <button type="button" onClick={onCheck}>Check again</button>
        </div>
      )}
      <FooterButton onClick={onInstall} disabled={network === 'checking' || network === 'offline'}>
        {network === 'checking' ? 'Checking connection' : 'Install dependencies'}
      </FooterButton>
    </div>
  )
}

function InstallationScreen({
  status,
  network,
  onRetry,
  onShowLog,
}: {
  status: RuntimeStatus
  network: NetworkState
  onRetry: () => void
  onShowLog: () => void
}) {
  const downloading = status.type === 'downloading_python'
  const installingPython = status.type === 'installing_python'
  const installingFfmpeg = status.type === 'installing_ffmpeg'
  const installingImageMagick = status.type === 'downloading_imagemagick' || status.type === 'installing_imagemagick'
  const installingGhostscript = status.type === 'installing_ghostscript'
  const verifyingMedia = status.type === 'verifying_media_tools'
  const installingAi = status.type === 'optimizing' || status.type === 'verifying_ai'
  const failed = status.type === 'error'
  const offline = status.type === 'offline' || network === 'offline'
  const progress = percent(status)
  const hasMeasuredProgress = Number(status.bytesTotal || 0) > 0 || Number.isFinite(Number(status.progressPercent))

  const rows = [
    {
      name: downloading ? 'Downloading Python' : installingPython ? 'Installing Python' : 'Python',
      detail: downloading || installingPython ? status.detail || 'Preparing isolated runtime' : installingFfmpeg || installingImageMagick || installingGhostscript || installingAi ? 'Installed' : 'Waiting',
      active: downloading || installingPython,
      complete: installingFfmpeg || installingImageMagick || installingGhostscript || installingAi,
      icon: <Download size={17} />,
    },
    {
      name: installingFfmpeg ? 'Downloading FFmpeg' : 'FFmpeg',
      detail: installingFfmpeg ? status.detail || 'Installing media tools' : installingImageMagick || installingGhostscript || installingAi ? 'Installed' : 'Waiting',
      active: installingFfmpeg,
      complete: installingImageMagick || installingGhostscript || installingAi,
      icon: <Wrench size={17} />,
    },
    {
      name: installingImageMagick ? status.label || 'Installing ImageMagick' : 'ImageMagick',
      detail: installingImageMagick ? status.detail || 'Installing image tools' : installingGhostscript || installingAi ? 'Installed' : 'Waiting',
      active: installingImageMagick,
      complete: installingGhostscript || installingAi,
      icon: <ImageIcon size={17} />,
    },
    {
      name: installingGhostscript ? 'Installing Ghostscript' : verifyingMedia ? status.label || 'Verifying media tools' : 'Ghostscript',
      detail: installingGhostscript || verifyingMedia ? status.detail || 'Checking private executable paths' : installingAi ? 'Installed' : 'Waiting',
      active: installingGhostscript || verifyingMedia,
      complete: installingAi,
      icon: <FileType2 size={17} />,
    },
    {
      name: status.type === 'verifying_ai' ? 'Verifying AI dependencies' : installingAi ? 'Installing AI dependencies' : 'AI dependencies',
      detail: installingAi ? status.detail || 'Optimizing for your hardware' : 'Waiting',
      active: installingAi,
      complete: false,
      icon: <BrainCircuit size={17} />,
    },
  ]

  return (
    <div className={`${styles.page} ${styles.installPage}`}>
      <div className={styles.copy}>
        <h1>Preparing Stag</h1>
        <p>Keep Stag open while the required files are installed.</p>
      </div>
      <div className={styles.steps}>
        {rows.map(row => (
          <div
            className={`${styles.step} ${row.active ? styles.active : ''} ${row.complete ? styles.complete : ''}`}
            key={row.name}
          >
            <span className={styles.icon}>{row.complete ? <Check size={17} /> : row.icon}</span>
            <div>
              <strong>{row.name}</strong>
              <small title={row.detail}>{row.detail}</small>
            </div>
          </div>
        ))}
      </div>

      {!failed && !offline && (
        <>
          <div className={styles.progress}>
            <div
              className={`${styles.fill} ${!hasMeasuredProgress ? styles.indeterminate : ''}`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className={styles.status}>
            <span>{status.label || 'Preparing installation'}</span>
            {hasMeasuredProgress && <strong>{progress}%</strong>}
          </p>
        </>
      )}

      {(failed || offline) && (
        <div className={styles.error}>
          {offline ? <WifiOff size={19} /> : <Terminal size={19} />}
          <div>
            <strong>{offline ? 'Internet connection required' : status.label || 'Installation failed'}</strong>
            <span>{offline ? 'Connect to the internet to continue installation.' : status.error}</span>
          </div>
          <div className={styles.actions}>
            <button type="button" onClick={onRetry} disabled={network === 'checking'}>
              <RefreshCw size={14} /> {network === 'checking' ? 'Checking' : 'Retry'}
            </button>
            {!offline && status.logPath && (
              <button type="button" onClick={onShowLog}><Terminal size={14} /> Show log</button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function FooterButton({
  children,
  disabled = false,
  onClick,
}: {
  children: React.ReactNode
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <footer className={styles.footer}>
      <button className={styles.primaryButton} type="button" disabled={disabled} onClick={onClick}>
        {children}
        <ArrowRight size={17} />
      </button>
    </footer>
  )
}
