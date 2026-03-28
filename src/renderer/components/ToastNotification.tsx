import { useEffect } from 'react'
import { useStore } from '../store/useStore'
import styles from './ToastNotification.module.css'

export default function ToastNotification() {
  const { toast, clearToast } = useStore()

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(clearToast, toast.duration || 2500)
    return () => clearTimeout(t)
  }, [toast])

  if (!toast) return null

  return (
    <div className={`${styles.toast} ${styles[toast.type || 'info']}`} onClick={clearToast}>
      {toast.type === 'success' && '✓ '}
      {toast.type === 'error' && '✕ '}
      {toast.message}
    </div>
  )
}
