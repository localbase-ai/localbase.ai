import { useEffect } from 'react'
import { VIZ_ORIGIN } from '@/lib/vizOrigin'

/**
 * Vimium-style keyboard shortcuts
 * j/k - scroll down/up
 * gg - scroll to top
 * G - scroll to bottom
 * d/u - scroll half page down/up
 * h/l - go back/forward in history
 * f - link hints (same tab)
 * F - link hints (new tab)
 */
export function useVimiumShortcuts() {
  useEffect(() => {
    let ggTimeout = null
    let linkHintsMode = false
    let hintElements = []
    let hintInput = ''

    // Generate hint labels (aa, ab, ac, ..., ba, bb, ...)
    const generateHintLabels = (count) => {
      const labels = []
      const chars = 'abcdefghijklmnopqrstuvwxyz'
      for (let i = 0; i < count; i++) {
        let label = ''
        let num = i
        do {
          label = chars[num % chars.length] + label
          num = Math.floor(num / chars.length) - 1
        } while (num >= 0)
        labels.push(label)
      }
      return labels
    }

    // Show link hints
    const showLinkHints = (newTab = false) => {
      console.log('🎯 showLinkHints called, newTab:', newTab)
      linkHintsMode = true
      hintInput = ''

      // Set global flag so terminal knows to block keys
      window.vimHintsActive = true

      // Create or get hints container at max z-index FIRST
      let container = document.getElementById('vimium-hints-container')
      if (!container) {
        container = document.createElement('div')
        container.id = 'vimium-hints-container'
        container.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          z-index: 2147483647;
        `
        document.body.appendChild(container)
      }

      // Find all clickable elements (including viz cards)
      const clickables = document.querySelectorAll(
        'a, button, input[type="button"], input[type="submit"], [role="button"], [onclick], [tabindex]:not([tabindex="-1"]), [class*="cursor-pointer"]'
      )

      console.log('🔍 Found', clickables.length, 'clickable elements')

      // Filter to visible elements only BEFORE generating labels
      const visibleElements = []
      for (let i = 0; i < clickables.length; i++) {
        const el = clickables[i]
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          visibleElements.push({ el, rect })
        }
      }

      const labels = generateHintLabels(visibleElements.length)

      // Batch DOM operations with DocumentFragment
      const fragment = document.createDocumentFragment()

      visibleElements.forEach(({ el, rect }, i) => {
        const hint = document.createElement('div')
        hint.textContent = labels[i]
        hint.className = 'vimium-hint'
        hint.style.cssText = `
          position: fixed;
          top: ${rect.top}px;
          left: ${rect.left}px;
          background: #ffd76e;
          color: #000;
          padding: 2px 6px;
          font-size: 12px;
          font-weight: bold;
          font-family: monospace;
          border: 1px solid #c38a22;
          border-radius: 3px;
          z-index: 2147483647;
          pointer-events: none;
          text-transform: uppercase;
        `

        fragment.appendChild(hint)
        hintElements.push({ label: labels[i], element: el, hint, newTab })
      })

      // Single DOM append operation
      container.appendChild(fragment)
      console.log('✅ Created', visibleElements.length, 'visible hints out of', clickables.length, 'clickable elements')
    }

    // Hide link hints
    const hideLinkHints = () => {
      linkHintsMode = false

      // Remove the entire hints container
      const container = document.getElementById('vimium-hints-container')
      if (container && container.parentNode) {
        container.parentNode.removeChild(container)
      }

      hintElements = []
      hintInput = ''

      // Clear global flag so terminal can process keys normally
      window.vimHintsActive = false
    }

    // Handle hint input
    const handleHintInput = (key) => {
      hintInput += key.toLowerCase()

      // Filter hints
      const matches = hintElements.filter(({ label }) =>
        label.startsWith(hintInput)
      )

      if (matches.length === 0) {
        hideLinkHints()
        return
      }

      if (matches.length === 1) {
        const { element, newTab } = matches[0]
        hideLinkHints()

        if (element.tagName === 'A' && newTab) {
          window.open(element.href, '_blank')
        } else {
          element.click()
        }
        return
      }

      // Update visible hints
      hintElements.forEach(({ hint, label }) => {
        if (label.startsWith(hintInput)) {
          hint.textContent = label.substring(hintInput.length)
        } else {
          hint.style.display = 'none'
        }
      })
    }

    // Where j/k/d/u/gg/G should scroll. A key bridged from a viz iframe
    // scrolls that iframe's own document. Otherwise take the first container
    // that actually overflows: on a viz page the shell's .overflow-auto wrapper
    // is exactly the iframe's height, so it has nothing to scroll and the
    // content that does scroll lives inside the iframe.
    //
    // A viz on another origin (the operator app loads them from the API port)
    // can't be scrolled from here, so it gets a stand-in that asks the viz to
    // scroll itself — see tools/server/viz-bridge.js.
    const remoteScrollTarget = (win) => ({
      remote: true,
      scrollHeight: Number.MAX_SAFE_INTEGER,
      scrollBy: ({ top }) => win.postMessage({ type: 'lb:scroll', by: top }, VIZ_ORIGIN),
      scrollTo: ({ top }) => win.postMessage({ type: 'lb:scroll', to: top === 0 ? 'top' : 'bottom' }, VIZ_ORIGIN),
    })

    const findScrollTarget = (source) => {
      if (source?.remote) return source
      if (source) return source.scrollingElement || source.documentElement
      const overflows = el => el.scrollHeight > el.clientHeight + 1 && el.getClientRects().length > 0
      const container = [...document.querySelectorAll('.overflow-auto')].find(overflows)
      if (container) return container
      let crossOrigin = null
      for (const frame of document.querySelectorAll('iframe')) {
        const visible = frame.getClientRects().length > 0
        let doc = null
        try { doc = frame.contentDocument } catch { /* cross-origin */ }
        if (!doc) {
          if (visible && !crossOrigin && frame.contentWindow) crossOrigin = frame.contentWindow
          continue
        }
        const el = doc.scrollingElement || doc.documentElement
        if (el && visible && el.scrollHeight > el.clientHeight + 1) return el
      }
      if (crossOrigin) return remoteScrollTarget(crossOrigin)
      return document.scrollingElement || document.documentElement
    }

    const handleKeyPress = (e, sourceDoc = null) => {
      // Don't handle Command/Ctrl+R - let App.jsx handle it
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        return
      }

      // Modified keys belong to someone else: ⌘K focuses search in the viz
      // gallery and in several vizzes, and must not also scroll up.
      if (!linkHintsMode && (e.metaKey || e.ctrlKey || e.altKey)) {
        return
      }

      // A viz that handled the key itself wins.
      if (e.defaultPrevented) {
        return
      }

      // Handle link hints mode
      if (linkHintsMode) {
        if (e.key === 'Escape') {
          hideLinkHints()
          e.preventDefault()
          return
        }
        if (e.key.length === 1 && e.key.match(/[a-z]/i)) {
          handleHintInput(e.key)
          e.preventDefault()
          return
        }
      }

      // Don't trigger hints when typing in input fields
      // Note: Terminal is handled separately via attachCustomKeyEventHandler
      if (e.target.tagName === 'INPUT' ||
          e.target.tagName === 'TEXTAREA' ||
          e.target.tagName === 'SELECT' ||
          e.target.isContentEditable) {
        return
      }

      // Link hints only label the shell's own elements, not what's inside a
      // viz, so f/F from an iframe would hint everything except the page
      // being looked at. Scroll and history keys still work from there.
      if (sourceDoc && (e.key === 'f' || e.key === 'F')) {
        return
      }

      const scrollAmount = 120
      const halfPage = window.innerHeight

      const scrollableElement = findScrollTarget(sourceDoc)

      // Handle Shift+F for link hints (new tab)
      if (e.shiftKey && e.key === 'F') {
        showLinkHints(true)
        e.preventDefault()
        return
      }

      switch (e.key) {
        case 'f':
          // Link hints (same tab)
          showLinkHints(false)
          e.preventDefault()
          break

        case 'j':
          // Scroll down
          scrollableElement.scrollBy({ top: scrollAmount, behavior: 'smooth' })
          e.preventDefault()
          break

        case 'k':
          // Scroll up
          scrollableElement.scrollBy({ top: -scrollAmount, behavior: 'smooth' })
          e.preventDefault()
          break

        case 'd':
          // Scroll half page down
          scrollableElement.scrollBy({ top: halfPage, behavior: 'smooth' })
          e.preventDefault()
          break

        case 'u':
          // Scroll half page up
          scrollableElement.scrollBy({ top: -halfPage, behavior: 'smooth' })
          e.preventDefault()
          break

        case 'g':
          // Double tap 'g' to go to top
          if (ggTimeout) {
            clearTimeout(ggTimeout)
            ggTimeout = null
            scrollableElement.scrollTo({ top: 0, behavior: 'smooth' })
          } else {
            ggTimeout = setTimeout(() => {
              ggTimeout = null
            }, 500)
          }
          e.preventDefault()
          break

        case 'G':
          // Shift+G to go to bottom
          scrollableElement.scrollTo({ top: scrollableElement.scrollHeight, behavior: 'smooth' })
          e.preventDefault()
          break

        case 'h':
          // Go back in history
          window.history.back()
          break

        case 'l':
          // Go forward in history
          window.history.forward()
          break

        case 'r':
          // Reload page
          if (e.shiftKey) {
            window.location.reload()
          }
          break

        default:
          break
      }
    }

    // Once a viz iframe has focus (any click inside it), keydown fires in the
    // iframe's window and never reaches this one. Vizzes are served from this
    // origin, so listen inside each iframe and route keys back through the
    // same handler. Every navigation of an iframe makes a new document, so
    // re-attach on each load; the WeakSet stops double-binding one document.
    const bridged = new WeakSet()
    const bridgedListeners = []
    const bridgeFrame = (frame) => {
      let win = null, doc = null
      try { win = frame.contentWindow; doc = frame.contentDocument } catch { return }
      if (!win || !doc || bridged.has(doc)) return
      bridged.add(doc)
      // Bubble phase, so the viz's own handlers run first and can claim a key.
      const listener = (e) => handleKeyPress(e, doc)
      win.addEventListener('keydown', listener)
      bridgedListeners.push([win, listener])
    }
    // Keys from a cross-origin viz arrive as lb:key messages from the bridge.
    // Only the viz origin is trusted, and only when it differs from ours (in
    // the same-origin preview, bridgeFrame above already sees the keys).
    const BRIDGED_KEYS = new Set(['j', 'k', 'd', 'u', 'g', 'G'])
    const handleBridgeMessage = (e) => {
      if (VIZ_ORIGIN === window.location.origin || e.origin !== VIZ_ORIGIN) return
      if (e.data?.type !== 'lb:key' || typeof e.data.key !== 'string' || !e.source) return
      // A viz only gets to scroll itself — not drive history, reload, or type
      // into link hints (which click app buttons).
      if (linkHintsMode || !BRIDGED_KEYS.has(e.data.key)) return
      const synthetic = {
        key: e.data.key, shiftKey: !!e.data.shiftKey,
        metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false,
        target: { tagName: '' }, preventDefault: () => {},
      }
      handleKeyPress(synthetic, remoteScrollTarget(e.source))
    }

    // load doesn't bubble, but it does pass through document in capture phase.
    const handleFrameLoad = (e) => {
      if (e.target?.tagName === 'IFRAME') bridgeFrame(e.target)
    }
    document.querySelectorAll('iframe').forEach(bridgeFrame)

    window.addEventListener('keydown', handleKeyPress)
    window.addEventListener('message', handleBridgeMessage)
    document.addEventListener('load', handleFrameLoad, true)

    return () => {
      window.removeEventListener('keydown', handleKeyPress)
      window.removeEventListener('message', handleBridgeMessage)
      document.removeEventListener('load', handleFrameLoad, true)
      bridgedListeners.forEach(([win, listener]) => {
        try { win.removeEventListener('keydown', listener) } catch { /* window gone */ }
      })
      if (ggTimeout) clearTimeout(ggTimeout)
      hideLinkHints()
    }
  }, [])
}
