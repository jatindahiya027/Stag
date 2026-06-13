import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import styles from './ToastNotification.module.css'

export default function ToastNotification() {
  const { toast, clearToast } = useStore()
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    if (!toast) { setExiting(false); return }
    const duration = toast.duration || 2500
    const exitDelay = duration - 200
    const exitT = setTimeout(() => setExiting(true), Math.max(exitDelay, 0))
    const clearT = setTimeout(clearToast, duration)
    return () => { clearTimeout(exitT); clearTimeout(clearT) }
  }, [toast])

  if (!toast) return null

  const dismiss = () => { setExiting(true); setTimeout(clearToast, 180) }

  return (
    <div
      className={`${styles.toast} ${styles[toast.type || 'info']} ${exiting ? styles.toastExiting : ''}`}
      onClick={dismiss}
    >
      {toast.type === 'success' && '✓ '}
      {toast.type === 'error' && '✕ '}
      {toast.message}
    </div>
  )
}
