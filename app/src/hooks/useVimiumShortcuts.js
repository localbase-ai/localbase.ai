import { useEffect } from 'react'

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

    const handleKeyPress = (e) => {
      // Don't handle Command/Ctrl+R - let App.jsx handle it
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
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
          e.target.isContentEditable) {
        return
      }

      const scrollAmount = 120
      const halfPage = window.innerHeight

      // Find the scrollable element (main content area)
      const scrollableElement = document.querySelector('.overflow-auto') || document.documentElement

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

    // Listen for link hint requests from iframes
    const handleMessage = (event) => {
      if (event.data?.type === 'SHOW_LINK_HINTS') {
        showLinkHints(event.data.newTab)
      } else if (event.data?.type === 'HIDE_LINK_HINTS') {
        hideLinkHints()
      } else if (event.data?.type === 'HINT_KEY_PRESS') {
        handleHintInput(event.data.key)
      } else if (event.data?.type === 'CLICK_HINT') {
        const hint = hintElements.find(h => h.label === event.data.label)
        if (hint) {
          hideLinkHints()
          hint.element.click()
        }
      }
    }

    window.addEventListener('keydown', handleKeyPress)
    window.addEventListener('message', handleMessage)

    return () => {
      window.removeEventListener('keydown', handleKeyPress)
      window.removeEventListener('message', handleMessage)
      if (ggTimeout) clearTimeout(ggTimeout)
      hideLinkHints()
    }
  }, [])
}
