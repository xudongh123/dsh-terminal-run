/*
 * Client half of @local/dsh-terminal-run.
 *
 * On every shell code block in the conversation it puts a small "run" button
 * next to the language label. Clicking it:
 *   1. reuses this Session's own terminal tab (opens one when there is none);
 *   2. waits until that tab's terminal view is writable;
 *   3. writes the snippet + carriage return through the tab's own attachment.
 *
 * Deliberately no Host RPC and no extra attachment: the terminal tab body owns
 * the attachment and the input control, and a second attachment would take the
 * control away from the user's own view.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-terminal-run',
  factory(require) {
    'use strict'

    const ATTR = 'data-dsh-terminal-run'
    const BUTTON_CLASS = 'dsh-terminal-run-button'
    const STATE_ATTR = 'data-dsh-terminal-run-state'
    const SCAN_INTERVAL = 400
    const SCAN_DEBOUNCE = 60
    const READY_TIMEOUT = 8000
    const SHELL_LANGUAGES = {
      bash: true, sh: true, shell: true, zsh: true, shellscript: true, console: true,
      powershell: true, pwsh: true, ps1: true, cmd: true, bat: true, batch: true, dos: true,
    }

    const ZH = /^zh/i.test((window.navigator && window.navigator.language) || '')
    const TEXT = ZH
      ? { label: '▶ 终端', ready: '运行中', sending: '发送中…', done: '✓ 已发送', failed: '✗ 失败', tip: '在右侧栏终端中运行这段命令' }
      : { label: '▶ Term', ready: 'Running', sending: 'Sending…', done: '✓ Sent', failed: '✗ Failed', tip: 'Run this snippet in the right sidebar terminal' }

    const CSS = [
      '.dsh-terminal-run-button{display:inline-flex;align-items:center;gap:3px;margin-inline-start:6px;padding:0 6px;',
      'font:inherit;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);',
      'background:transparent;border:1px solid var(--dsw-alias-border-l2,currentColor);border-radius:5px;',
      'cursor:pointer;white-space:nowrap;opacity:.85;transition:opacity .12s,color .12s,border-color .12s}',
      '.dsh-terminal-run-button:hover{opacity:1;color:var(--dsw-alias-label-primary,inherit)}',
      '.dsh-terminal-run-button[data-dsh-terminal-run-state="busy"]{opacity:.6;cursor:progress}',
      '.dsh-terminal-run-button[data-dsh-terminal-run-state="ok"]{color:var(--dsw-alias-state-success-primary,#2f9e44);border-color:currentColor;opacity:1}',
      '.dsh-terminal-run-button[data-dsh-terminal-run-state="err"]{color:var(--dsw-alias-state-error-primary,#e03131);border-color:currentColor;opacity:1}',
    ].join('')

    /** Language chip of a code block banner, lower-cased, first token only. */
    function languageOf(banner) {
      const chip = banner.querySelector('div')
      if (chip === null) return ''
      const text = (chip.textContent || '').trim().toLowerCase()
      return text === '' ? '' : text.split(/[\s,;]+/)[0]
    }

    /** The code block element that owns a banner. */
    function blockOf(banner) {
      const outer = banner.parentElement
      return outer && outer.parentElement ? outer.parentElement : outer || banner
    }

    /** Command text of a code block, without trailing blank lines. */
    function commandOf(block) {
      const pre = block.querySelector('pre')
      const text = pre === null ? '' : pre.textContent || ''
      return text.replace(/\s+$/, '')
    }

    /** Where the button goes: the banner's right-hand control cluster. */
    function seatOf(banner) {
      return banner.querySelector('div:last-child') || banner
    }

    function setButton(button, state, label, tip) {
      button.setAttribute(STATE_ATTR, state)
      button.textContent = label
      if (tip !== undefined) button.title = tip
    }

    function flash(button, state, label, tip, ms) {
      setButton(button, state, label, tip)
      window.setTimeout(() => {
        if (!button.isConnected) return
        setButton(button, 'idle', TEXT.label, TEXT.tip)
      }, ms)
    }

    function install(ctx) {
      /** sessionId -> tabId of the terminal tab this plugin reuses. */
      const tracked = new Map()
      /** Last Session the composer dock reported, used when the click target is ambiguous. */
      const seen = { sessionId: null }

      function Dock(props) {
        const id = props && typeof props.sessionId === 'string' ? props.sessionId : null
        if (id !== null) seen.sessionId = id
        return null
      }

      const tabsOf = (sessionId) => {
        try {
          return ctx.sidebarRight.tabsIn(sessionId) || []
        } catch (error) {
          return []
        }
      }

      function terminalTab(sessionId, tabId) {
        if (tabId === undefined) return undefined
        for (const tab of tabsOf(sessionId)) {
          if (tab.id === tabId && tab.kind === 'terminal') return tab
        }
        return undefined
      }

      function openTerminalTab(sessionId) {
        const before = new Set(tabsOf(sessionId).map((tab) => tab.id))
        ctx.sidebarRight.openTabIn(sessionId, 'terminal', {})
        for (const tab of tabsOf(sessionId)) {
          if (tab.kind === 'terminal' && !before.has(tab.id)) return tab
        }
        return undefined
      }

      function ensureTab(sessionId) {
        const existing = terminalTab(sessionId, tracked.get(sessionId))
        if (existing !== undefined) {
          ctx.sidebarRight.focus(existing.id)
          return existing
        }
        const opened = openTerminalTab(sessionId)
        if (opened !== undefined) tracked.set(sessionId, opened.id)
        return opened
      }

      function viewOf(sessionId, tab) {
        let bound
        try {
          bound = ctx.webTerminals.boundTerminal(sessionId, tab.contentId)
        } catch (error) {
          bound = undefined
        }
        return ctx.webTerminals.view(sessionId, tab.id, tab.contentId, bound)
      }

      /** Resolve once the terminal view accepts input, or report why it never will. */
      function waitWritable(view, timeoutMs) {
        return new Promise((resolve) => {
          const deadline = Date.now() + timeoutMs
          const tick = () => {
            let snapshot
            try {
              snapshot = view.state.getSnapshot()
            } catch (error) {
              resolve({ ok: false, reason: 'no-state' })
              return
            }
            if (snapshot.writable === true) {
              resolve({ ok: true })
              return
            }
            const info = snapshot.info
            if (snapshot.phase === 'failed' || snapshot.phase === 'closed') {
              resolve({ ok: false, reason: 'failed' })
              return
            }
            if (info && (info.state === 'exited' || info.state === 'failed')) {
              resolve({ ok: false, reason: 'exited' })
              return
            }
            if (Date.now() > deadline) {
              resolve({ ok: false, reason: 'timeout' })
              return
            }
            window.setTimeout(tick, 50)
          }
          tick()
        })
      }

      async function runCommand(sessionId, command, button) {
        setButton(button, 'busy', TEXT.sending, TEXT.ready)
        let tab = ensureTab(sessionId)
        if (tab === undefined) {
          flash(button, 'err', TEXT.failed, 'cannot open a terminal tab', 2000)
          return
        }
        let view = viewOf(sessionId, tab)
        let ready = await waitWritable(view, READY_TIMEOUT)
        if (!ready.ok && ready.reason === 'exited') {
          // A finished terminal cannot be written to: replace its tab once.
          try {
            ctx.sidebarRight.closeIn(sessionId, tab.id)
          } catch (error) {
            /* the tab may already be gone */
          }
          tracked.delete(sessionId)
          tab = ensureTab(sessionId)
          if (tab === undefined) {
            flash(button, 'err', TEXT.failed, 'cannot open a terminal tab', 2000)
            return
          }
          view = viewOf(sessionId, tab)
          ready = await waitWritable(view, READY_TIMEOUT)
        }
        if (!ready.ok) {
          console.error('[dsh-terminal-run] terminal not ready', ready.reason)
          flash(button, 'err', TEXT.failed, 'terminal not ready: ' + ready.reason, 2000)
          return
        }
        try {
          view.write(command + '\r', true)
          flash(button, 'ok', TEXT.done, TEXT.tip, 1400)
        } catch (error) {
          console.error('[dsh-terminal-run] write failed', error)
          flash(button, 'err', TEXT.failed, 'write failed', 2000)
        }
      }

      function injectButton(block) {
        const banner = block.querySelector('[data-code-block-banner]')
        if (banner === null) return
        if (banner.querySelector('[' + ATTR + ']') !== null) return
        if (SHELL_LANGUAGES[languageOf(banner)] !== true) return
        const command = commandOf(block)
        if (command === '') return
        const button = window.document.createElement('button')
        button.type = 'button'
        button.className = BUTTON_CLASS
        button.setAttribute(ATTR, '')
        button.setAttribute(STATE_ATTR, 'idle')
        button.title = TEXT.tip
        button.setAttribute('aria-label', TEXT.tip)
        button.textContent = TEXT.label
        button.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (button.getAttribute(STATE_ATTR) === 'busy') return
          const target = ctx.sidebarRight.commandTarget(button)
          const sessionId = (target && target.sessionId) || seen.sessionId
          if (!sessionId) {
            flash(button, 'err', TEXT.failed, 'no Session for this message', 2000)
            return
          }
          void runCommand(sessionId, command, button)
        })
        seatOf(banner).appendChild(button)
      }

      function scan() {
        const doc = window.document
        const banners = doc.querySelectorAll('[data-code-block-banner]')
        for (let index = 0; index < banners.length; index += 1) {
          const banner = banners[index]
          if (banner.querySelector('[' + ATTR + ']') !== null) continue
          injectButton(blockOf(banner))
        }
      }

      ctx.effect(() => {
        const style = window.document.createElement('style')
        style.setAttribute('data-dsh-terminal-run-style', '')
        style.textContent = CSS
        window.document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-terminal-run.style')

      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: '@local/dsh-terminal-run',
      }, Dock)), 'dsh-terminal-run.session')

      ctx.effect(() => {
        const doc = window.document
        let timer = null
        const schedule = () => {
          if (timer !== null) return
          timer = window.setTimeout(() => {
            timer = null
            scan()
          }, SCAN_DEBOUNCE)
        }
        const observer = new window.MutationObserver(schedule)
        observer.observe(doc.body, { childList: true, subtree: true })
        const interval = window.setInterval(scan, SCAN_INTERVAL)
        scan()
        return () => {
          observer.disconnect()
          window.clearInterval(interval)
          if (timer !== null) window.clearTimeout(timer)
          for (const button of doc.querySelectorAll('[' + ATTR + ']')) button.remove()
        }
      }, 'dsh-terminal-run.blocks')
    }

    return {
      inject: ['slots', 'sidebarRight', 'webTerminals'],
      apply(ctx) {
        try {
          install(ctx)
        } catch (error) {
          console.error('[dsh-terminal-run] apply failed', error)
        }
      },
    }
  },
})
