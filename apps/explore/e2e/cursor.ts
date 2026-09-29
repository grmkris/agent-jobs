/**
 * A visible, human-looking mouse for Playwright recordings (headless Chromium draws no pointer).
 * The overlay is positioned from Node on every step, so it keeps moving over iframes (Privy) where the page never
 * sees mousemove. Movement follows an eased, slightly curved path; clicks show a press and a ripple.
 */
type Page = any
type Locator = any

const INIT = `(() => {
  const mk = () => {
    if (document.getElementById('__cur')) return
    const c = document.createElement('div')
    c.id = '__cur'
    c.innerHTML = '<svg width="30" height="30" viewBox="0 0 30 30"><path d="M4 2 L4 24 L10 18.5 L14 27 L18 25.2 L14 16.8 L22 16.8 Z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>'
    Object.assign(c.style, { position: 'fixed', left: '0', top: '0', width: '30px', height: '30px', zIndex: '2147483647',
      pointerEvents: 'none', transform: 'translate(-100px,-100px)', transition: 'none', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.35))' })
    document.documentElement.appendChild(c)
  }
  window.__curSet = (x, y, down) => {
    mk()
    const c = document.getElementById('__cur')
    c.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 2) + 'px) scale(' + (down ? 0.86 : 1) + ')'
  }
  window.__curRipple = (x, y) => {
    const r = document.createElement('div')
    Object.assign(r.style, { position: 'fixed', left: (x - 22) + 'px', top: (y - 22) + 'px', width: '44px', height: '44px',
      borderRadius: '50%', border: '3px solid rgba(198,255,61,.95)', background: 'rgba(198,255,61,.25)', zIndex: '2147483646',
      pointerEvents: 'none', transform: 'scale(.3)', opacity: '1', transition: 'transform .45s ease-out, opacity .45s ease-out' })
    document.documentElement.appendChild(r)
    requestAnimationFrame(() => { r.style.transform = 'scale(1.4)'; r.style.opacity = '0' })
    setTimeout(() => r.remove(), 600)
  }
  const zoom = () => { if (window.top === window && /agentjobs-explore|hireling.xyz$/.test(location.hostname)) setTimeout(() => (document.getElementById('root') ?? document.documentElement).style.zoom = '1.5', 0) }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { mk(); zoom() }); else { mk(); zoom() }
})()`

export class Cursor {
  x = 960
  y = 600
  constructor(private page: Page) {}

  static async install(ctx: any) {
    await ctx.addInitScript(INIT)
  }

  private async draw(down = false) {
    await this.page.evaluate(([x, y, d]: [number, number, boolean]) => (window as any).__curSet?.(x, y, d), [this.x, this.y, down]).catch(() => {})
  }

  /** Re-show the pointer after a navigation. */
  async show() {
    await this.page.evaluate(INIT).catch(() => {})
    await this.draw()
  }

  private seed = 7
  private rnd() {
    this.seed = (this.seed * 16807) % 2147483647
    return this.seed / 2147483647
  }

  /**
   * Move to (x, y) the way a hand does: fast off the mark, slowing into the target (Fitts), a slight arc and wobble,
   * and on long moves a small overshoot that settles back.
   */
  async moveTo(x: number, y: number, ms?: number) {
    const dist = Math.hypot(x - this.x, y - this.y)
    if (dist < 2) return
    const long = dist > 280
    const ox = long ? (x - this.x) / dist * (5 + this.rnd() * 6) : 0
    const oy = long ? (y - this.y) / dist * (5 + this.rnd() * 6) : 0
    await this.path(x + ox, y + oy, ms ?? Math.min(480, 110 + dist * 0.26))
    if (long) await this.path(x, y, 70 + this.rnd() * 40)
  }

  private async path(x: number, y: number, dur: number) {
    const x0 = this.x, y0 = this.y
    const bend = (this.rnd() - 0.5) * 0.3
    const cx = (x0 + x) / 2 + (y - y0) * bend, cy = (y0 + y) / 2 - (x - x0) * bend
    const steps = Math.max(5, Math.round(dur / 16))
    const phase = this.rnd() * 6.28
    for (let i = 1; i <= steps; i++) {
      const t0 = i / steps
      const t = 1 - (1 - t0) ** 4 // ease-out quart: quick start, gentle landing
      const wob = Math.sin(t0 * 9 + phase) * (1 - t0) * 1.6
      this.x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t ** 2 * x + wob
      this.y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t ** 2 * y - wob
      await this.page.mouse.move(this.x, this.y)
      await this.draw()
      await this.page.waitForTimeout(8)
    }
    this.x = x
    this.y = y
  }

  private async centre(loc: Locator) {
    await loc.waitFor({ state: 'visible', timeout: 60_000 })
    await this.scrollIntoView(loc)
    // wait for the element to stop moving (Privy's modal slides in), so the click lands where it is now
    let b = await loc.boundingBox()
    for (let i = 0; i < 25; i++) {
      await this.page.waitForTimeout(60)
      const n = await loc.boundingBox()
      if (b && n && Math.abs(n.x - b.x) < 1 && Math.abs(n.y - b.y) < 1 && Math.abs(n.width - b.width) < 1) break
      b = n
    }
    if (!b) throw new Error('element has no box')
    // land somewhere inside the element, not always dead centre
    return { x: b.x + b.width * (0.35 + this.rnd() * 0.3), y: b.y + b.height * (0.4 + this.rnd() * 0.2) }
  }

  /** Scroll with the wheel, in small steps, until the element sits comfortably in view. */
  async scrollIntoView(loc: Locator) {
    const vh = this.page.viewportSize()?.height ?? 1080
    for (let i = 0; i < 60; i++) {
      const b = await loc.boundingBox()
      if (!b) return
      const top = vh * 0.18, bottom = vh * 0.8
      if (b.y >= top && b.y + b.height <= bottom) return
      const delta = b.y < top ? Math.max(-140, b.y - top) : Math.min(140, b.y + b.height - bottom)
      if (Math.abs(delta) < 4) return
      await this.page.mouse.wheel(0, delta)
      await this.page.waitForTimeout(28)
    }
  }

  /** Scroll the page by dy pixels, smoothly. */
  async scroll(dy: number) {
    const n = Math.max(1, Math.round(Math.abs(dy) / 60))
    for (let i = 0; i < n; i++) {
      await this.page.mouse.wheel(0, dy / n)
      await this.page.waitForTimeout(24)
    }
  }

  async hover(loc: Locator) {
    const c = await this.centre(loc)
    await this.moveTo(c.x, c.y)
  }

  async click(loc: Locator) {
    let c = await this.centre(loc)
    await this.moveTo(c.x, c.y)
    // re-check after the move; if the target shifted, follow it
    const b = await loc.boundingBox()
    if (b && (c.x < b.x + 2 || c.x > b.x + b.width - 2 || c.y < b.y + 2 || c.y > b.y + b.height - 2)) {
      c = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      await this.moveTo(c.x, c.y, 140)
    }
    await this.page.waitForTimeout(45 + this.rnd() * 40)
    await this.draw(true)
    await this.page.evaluate(([x, y]: [number, number]) => (window as any).__curRipple?.(x, y), [c.x, c.y]).catch(() => {})
    await this.page.mouse.down()
    await this.page.waitForTimeout(55)
    await this.page.mouse.up()
    await this.draw(false)
    await this.page.waitForTimeout(80)
  }

  /** Click into a field, select what is there, and type like a person. */
  async type(loc: Locator, text: string, delay = 28) {
    await this.click(loc)
    await this.page.keyboard.press('Control+A')
    await this.page.keyboard.type(text, { delay })
  }
}
