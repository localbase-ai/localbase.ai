import { useState, useEffect, useRef } from 'react'
import { Bot, Copy, Check, Github } from 'lucide-react'

const INSTALL_COMMAND = 'curl -fsSL https://localbase.ai/install | bash'

export default function LandingPage({ onEnterApp }) {
  const inputRef = useRef(null)
  const [phase, setPhase] = useState('intro') // intro, typing, ready
  const [introLine, setIntroLine] = useState(0)
  const [typedCommand, setTypedCommand] = useState('')
  const [copied, setCopied] = useState(false)
  const [showSkip, setShowSkip] = useState(false)

  const introLines = [
    '> LocalBase CLI v1.0',
    '> Local-first analytics framework',
    '> Initializing...',
  ]

  // Show skip button after 1 second
  useEffect(() => {
    const timeout = setTimeout(() => setShowSkip(true), 1000)
    return () => clearTimeout(timeout)
  }, [])

  // Intro typing
  useEffect(() => {
    if (phase === 'intro' && introLine < introLines.length) {
      const timeout = setTimeout(() => {
        setIntroLine(prev => prev + 1)
      }, 700)
      return () => clearTimeout(timeout)
    } else if (phase === 'intro' && introLine >= introLines.length) {
      const timeout = setTimeout(() => setPhase('typing'), 400)
      return () => clearTimeout(timeout)
    }
  }, [phase, introLine])

  // Type the curl command
  useEffect(() => {
    if (phase === 'typing') {
      let i = 0
      const typeInterval = setInterval(() => {
        if (i < INSTALL_COMMAND.length) {
          setTypedCommand(INSTALL_COMMAND.slice(0, i + 1))
          i++
        } else {
          clearInterval(typeInterval)
          setTimeout(() => setPhase('ready'), 300)
        }
      }, 30)
      return () => clearInterval(typeInterval)
    }
  }, [phase])

  const handleCopy = async () => {
    await navigator.clipboard.writeText(INSTALL_COMMAND)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const skipIntro = () => {
    setPhase('ready')
    setIntroLine(introLines.length)
    setTypedCommand(INSTALL_COMMAND)
  }

  // Cmd+K to skip
  useEffect(() => {
    const handleGlobalKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        if (phase !== 'ready') {
          skipIntro()
        }
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [phase])

  return (
    <div className="min-h-screen bg-black flex flex-col relative overflow-hidden">
      {/* Background grid effect */}
      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage: `
            linear-gradient(rgba(34, 197, 94, 0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(34, 197, 94, 0.1) 1px, transparent 1px)
          `,
          backgroundSize: '50px 50px'
        }}
      />

      {/* Radial glow */}
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(34, 197, 94, 0.15) 0%, transparent 70%)'
        }}
      />

      {/* Header */}
      <header className="relative z-10 px-6 py-4">
        <div className="flex items-center justify-between max-w-4xl mx-auto">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-green-400" />
            <span className="text-sm font-mono text-zinc-500">localbase</span>
          </div>
          <div className="flex items-center gap-3">
            {showSkip && phase !== 'ready' && (
              <button
                onClick={skipIntro}
                className="px-3 py-1.5 text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                skip intro
              </button>
            )}
            <a
              href="https://github.com/localbase-ai/localbase.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-green-400/50 rounded-xl text-sm text-zinc-400 hover:text-white transition-all"
            >
              <Github className="h-4 w-4" />
              <span className="hidden sm:inline">GitHub</span>
            </a>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 relative z-10">
        <div className="w-full max-w-2xl space-y-6 sm:space-y-8">

          {/* Terminal intro */}
          {(phase === 'intro' || phase === 'typing') && (
            <div className="font-mono text-sm space-y-1 mb-8">
              {introLines.slice(0, introLine).map((line, i) => (
                <div
                  key={i}
                  className={`${i === introLine - 1 ? 'text-green-400' : 'text-zinc-600'} transition-colors`}
                >
                  {line}
                </div>
              ))}
              {introLine < introLines.length && (
                <span className="text-green-400 animate-pulse">█</span>
              )}
            </div>
          )}

          {/* Ready state */}
          {(phase === 'typing' || phase === 'ready') && (
            <>
              {/* Headline */}
              <div className="text-center space-y-4 animate-fade-in">
                <div className="flex justify-center">
                  <div className="relative">
                    <Bot className="h-12 w-12 text-green-400" strokeWidth={1.5} />
                    <div className="absolute inset-0 bg-green-400/20 blur-xl rounded-full" />
                  </div>
                </div>
                <h1 className="text-3xl sm:text-5xl font-bold tracking-tight text-white">
                  LocalBase
                </h1>
                <p className="text-zinc-500 text-base sm:text-lg">
                  Local-first analytics for marketing teams
                </p>
              </div>

              {/* Terminal command box */}
              <div className="relative">
                <div className="absolute -inset-1 bg-gradient-to-r from-green-400/20 via-transparent to-green-400/20 rounded-2xl blur-xl opacity-50" />

                <div className="relative bg-zinc-900 border border-zinc-800 rounded-xl sm:rounded-2xl overflow-hidden">
                  {/* Terminal header */}
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
                    <div className="w-3 h-3 rounded-full bg-red-500/80" />
                    <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                    <div className="w-3 h-3 rounded-full bg-green-500/80" />
                    <span className="ml-2 text-xs text-zinc-600 font-mono">terminal</span>
                  </div>

                  {/* Command */}
                  <div className="flex items-center gap-3 px-4 py-4">
                    <span className="text-green-400 font-mono">$</span>
                    <code className="flex-1 text-white font-mono text-sm sm:text-base break-all">
                      {phase === 'typing' ? typedCommand : INSTALL_COMMAND}
                      {phase === 'typing' && <span className="text-green-400 animate-pulse">█</span>}
                    </code>
                    {phase === 'ready' && (
                      <button
                        onClick={handleCopy}
                        className="p-2 hover:bg-zinc-800 rounded-lg transition-colors"
                        title="Copy to clipboard"
                      >
                        {copied ? (
                          <Check className="h-4 w-4 text-green-400" />
                        ) : (
                          <Copy className="h-4 w-4 text-zinc-500 hover:text-white" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Hint */}
              {phase === 'ready' && (
                <div className="text-center space-y-4">
                  <p className="text-zinc-600 text-xs sm:text-sm">
                    paste in your terminal to install
                  </p>

                  {/* Quick links */}
                  <div className="flex items-center justify-center gap-4 text-xs">
                    <a
                      href="https://github.com/localbase-ai/localbase.ai#readme"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-500 hover:text-green-400 transition-colors"
                    >
                      Documentation
                    </a>
                    <span className="text-zinc-700">•</span>
                    <a
                      href="https://github.com/localbase-ai/localbase.ai/issues"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-500 hover:text-green-400 transition-colors"
                    >
                      Issues
                    </a>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 px-6 py-6">
        <div className="flex items-center justify-center gap-6 text-xs text-zinc-600">
          <span>Open Source</span>
          <span className="text-zinc-700">•</span>
          <span>MIT License</span>
          <span className="text-zinc-700">•</span>
          <span>Your data stays local</span>
        </div>
      </footer>
    </div>
  )
}
