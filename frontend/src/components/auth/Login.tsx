import faviconUrl from '@/assets/favicon.png'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { showToast } from '@/lib/store'
import { IconArrowRight, IconEye, IconEyeOff, IconLock } from '@tabler/icons-react'
import { useState } from 'react'

interface LoginFormProps {
  mode: 'login' | 'setup'
  onAuth: () => void
}

export function LoginForm({ mode, onAuth }: LoginFormProps) {
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [remember, setRemember] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!password) return
    setLoading(true)
    setInvalid(false)
    try {
      const res = await fetch(mode === 'setup' ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, remember }),
      })
      const data = await res.json()
      if (data.success) {
        onAuth()
      } else {
        setInvalid(true)
        showToast(data.error ?? 'Ошибка', 'error')
      }
    } catch {
      showToast('Ошибка соединения', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="mx-auto w-full max-w-xs space-y-6">
        <div className="space-y-2 text-center">
          <img src={faviconUrl} alt="XKeen UI" className="mx-auto h-12 w-12" />
          <h1 className="text-3xl font-semibold">XKeen UI</h1>
          <p className="text-muted-foreground text-sm text-pretty">
            {mode === 'setup' ? 'Установите пароль для доступа к панели' : 'Введите пароль для входа'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <FieldGroup>
            <Field data-invalid={invalid || undefined}>
              <FieldLabel htmlFor="password">Пароль</FieldLabel>
              <div className="relative">
                <Input
                  id="password"
                  className="ps-9 pe-9"
                  placeholder="Введите пароль..."
                  type={visible ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    setInvalid(false)
                  }}
                  aria-invalid={invalid || undefined}
                  autoFocus
                  required
                />
                <div className="text-muted-foreground/80 pointer-events-none absolute inset-y-0 inset-s-0 flex items-center justify-center ps-3">
                  <IconLock size={16} aria-hidden="true" />
                </div>
                <button
                  type="button"
                  onClick={() => setVisible((v) => !v)}
                  aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'}
                  aria-pressed={visible}
                  className="text-muted-foreground/80 hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 absolute inset-y-0 inset-e-0 flex h-full w-9 items-center justify-center rounded-e-md transition-colors outline-none focus:z-10 focus-visible:ring-[3px]"
                >
                  {visible ? <IconEyeOff size={16} aria-hidden="true" /> : <IconEye size={16} aria-hidden="true" />}
                </button>
              </div>
            </Field>
          </FieldGroup>

          {mode === 'login' && (
            <div className="flex items-center gap-2">
              <Checkbox id="remember" checked={remember} onCheckedChange={(v) => setRemember(!!v)} />
              <Label htmlFor="remember">Запомнить на 7 дней</Label>
            </div>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? '...' : mode === 'setup' ? 'Установить пароль' : 'Войти'}
            {!loading && <IconArrowRight size={16} />}
          </Button>
        </form>
      </div>
    </div>
  )
}
