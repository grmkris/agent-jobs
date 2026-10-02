// U-PERF-A11Y: what a page must hold on a phone, checked in Chromium (shots.mjs --audit):
//   - every touch target at least 44 × 44 px (Apple's minimum), except links inside running text;
//   - every interactive element with an accessible name, as Chromium's accessibility tree computes it;
//   - no horizontal scroll;
//   - no layout shift while chain reads arrive late (window.__chainLatency in the fixtures).
export const TARGET = 44;

/** Init script, before the page loads: records each layout shift, with what moved. */
export function trackShifts() {
  window.__shifts = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.hadRecentInput) continue;
      const sources = (entry.sources ?? []).map(({ node }) =>
        node instanceof Element ? `<${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}> "${(node.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 50)}"` : (node?.nodeName ?? '?'),
      );
      window.__shifts.push({ value: Math.round(entry.value * 10000) / 10000, at: Math.round(entry.startTime), sources });
    }
  }).observe({ type: 'layout-shift', buffered: true });
}

const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=radio], [role=tab], [role=switch], [role=checkbox], [role=menuitem]';

/** Targets under 44 px on either side, by what they say and where. */
export function smallTargets(page) {
  return page.evaluate(({ selector, min }) => {
    const found = [];
    const seen = new Set();
    for (let el of document.querySelectorAll(selector)) {
      const style = getComputedStyle(el);
      if (el.getClientRects().length === 0 || style.visibility === 'hidden' || style.display === 'none' || el.closest('[aria-hidden="true"], [inert]') !== null) continue;
      let rect = el.getBoundingClientRect();
      // A visually hidden control (a file input, a segmented control's radio) is reached through its label.
      if (rect.width <= 2 || rect.height <= 2) {
        const owner = el.closest('label') ?? (el.id === '' ? null : document.querySelector(`label[for="${el.id}"]`));
        if (owner === null) continue;
        el = owner;
        rect = el.getBoundingClientRect();
      }
      // A link inside a sentence is exempt (WCAG 2.5.8's inline exception): its line sets its height.
      const inline = el.tagName === 'A' && getComputedStyle(el).display === 'inline' && (el.parentElement?.textContent ?? '').trim().length > (el.textContent ?? '').trim().length + 1;
      if (seen.has(el) || inline) continue;
      seen.add(el);
      const label = (el.getAttribute('aria-label') ?? el.textContent ?? el.getAttribute('placeholder') ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (rect.width < min || rect.height < min) found.push({ target: `<${el.tagName.toLowerCase()}> "${label}"`, size: `${Math.round(rect.width)}×${Math.round(rect.height)}` });
    }
    return found;
  }, { selector: INTERACTIVE, min: TARGET });
}

const NAMED_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'slider', 'spinbutton', 'listbox']);

/** Interactive elements whose accessible name (Chromium's computed one) is empty. */
export async function unnamed(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const found = [];
    for (const node of nodes) {
      if (node.ignored || !NAMED_ROLES.has(node.role?.value) || (node.name?.value ?? '').trim() !== '' || node.backendDOMNodeId === undefined) continue;
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId });
      const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { return this.outerHTML.slice(0, 180) }', returnByValue: true });
      found.push({ role: node.role.value, html: result.value });
    }
    return found;
  } finally {
    await cdp.detach();
  }
}

/** Horizontal scroll, with the widest elements past the right edge. */
export function overflow(page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= width) return null;
    const past = [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > width + 1 && el.getClientRects().length > 0)
      .filter((el) => ![...el.children].some((child) => child.getBoundingClientRect().right > width + 1))
      .slice(0, 5)
      .map((el) => `<${el.tagName.toLowerCase()}> right ${Math.round(el.getBoundingClientRect().right)} "${(el.textContent ?? '').trim().slice(0, 40)}"`);
    return { scrollWidth: document.documentElement.scrollWidth, width, past };
  });
}

/** Layout shifts recorded since load: their sum (CLS-style, one session) and each one with what moved. */
export async function shifts(page) {
  const list = await page.evaluate(() => window.__shifts ?? []);
  return { total: Math.round(list.reduce((sum, s) => sum + s.value, 0) * 10000) / 10000, list };
}
