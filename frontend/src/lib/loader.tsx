import type { ComponentType, ReactNode } from 'react'
import { Component, lazy } from 'react'
import { showToast } from './store'

export function lazyLoad<T extends ComponentType<any>>(factory: () => Promise<Record<string, T>>, name: string) {
  return lazy(() => factory().then((m) => ({ default: m[name] })))
}

class ChunkErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    showToast('Не удалось загрузить модуль', 'error')
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

export function LazyBoundary({ children }: { children: ReactNode }) {
  return <ChunkErrorBoundary>{children}</ChunkErrorBoundary>
}
