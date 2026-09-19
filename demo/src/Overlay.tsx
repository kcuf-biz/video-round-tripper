import { useEffect, type ReactNode } from 'react'

/**
 * The control surface, as an overlay rather than a column beside the stage.
 *
 * Two reasons it has to be an overlay. The obvious one is that a side panel forces the effect
 * into an inset frame, and the piece wants the full edge of the viewport. The load-bearing one
 * is that this UI must live OUTSIDE .rt-content: anything inside that subtree gets captured and
 * round-tripped, so the controls would be encoded along with the page and become unreadable at
 * exactly the coarseness settings you need them to adjust.
 */
export function Overlay({
  open,
  onToggle,
  children,
}: {
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'c' || e.metaKey || e.ctrlKey || e.altKey) return
      // The page underneath has real, focusable inputs — never steal a keystroke from one.
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.isContentEditable ||
          t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT')
      ) {
        return
      }
      e.preventDefault()
      onToggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onToggle])

  return (
    <>
      <button
        type="button"
        className="ui-toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="rt-ui"
      >
        {open ? 'hide' : 'controls'} <kbd>c</kbd>
      </button>
      <div id="rt-ui" className="ui-panel" hidden={!open}>
        {children}
      </div>
    </>
  )
}
