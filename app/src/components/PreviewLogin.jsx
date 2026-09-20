import { useState } from 'react'
import { Bot, LockKeyhole } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function PreviewLogin({ workspace, onAuthenticated }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const result = await window.electronAPI.auth.login(password)
      if (result.success) {
        setPassword('')
        onAuthenticated(result)
      } else {
        setError(result.error || 'Sign-in failed. Check your password and try again.')
      }
    } catch {
      setError('Unable to sign in right now. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mx-auto w-full max-w-md border-green-400/25 bg-card/80 text-left shadow-2xl backdrop-blur-md">
      <CardHeader className="space-y-3 pb-4">
        <Bot className="h-8 w-8 text-green-400" strokeWidth={1.5} />
        <CardTitle className="font-mono text-lg tracking-tight text-foreground">
          {workspace || 'Workspace'}
        </CardTitle>
        <p className="text-sm leading-6 text-muted-foreground">sign in to view this localbase workspace</p>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground" htmlFor="workspace-password">
            workspace password
          </label>
          <div className="relative">
            <LockKeyhole className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-green-400/80" />
            <input
              id="workspace-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-10 w-full rounded-md border border-border bg-background/70 pl-10 pr-3 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:border-green-400/60 focus-visible:ring-2 focus-visible:ring-green-400/30"
              required
              autoFocus
            />
          </div>
          {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
          <Button
            type="submit"
            disabled={busy || !password}
            className="h-10 w-full bg-green-400 font-mono text-sm text-black hover:bg-green-300"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
