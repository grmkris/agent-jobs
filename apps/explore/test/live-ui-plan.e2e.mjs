import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { drivePlan } from './live-ui-plan.mjs';

// Local DOM only: no wallet, hosted requests, or transaction submission.
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/home/kristjan/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.setContent(`<button id="outside" onclick="this.dataset.clicked='yes'">Cancel the job</button>
    <section role="dialog" aria-label="Cancel this job?">
      <button id="inside" onclick="this.dataset.clicked='yes'">Cancel the job</button>
    </section>`);
  const click = { action: 'click', role: 'button', name: 'Cancel the job', exact: true };
  const run = steps => drivePlan({ page, origin: 'https://unused.invalid', steps, capture: async () => {} });
  await assert.rejects(run([click]), /strict mode violation|exactly one control/);
  assert.equal(await page.locator('#outside').getAttribute('data-clicked'), null);
  assert.equal(await page.locator('#inside').getAttribute('data-clicked'), null);
  await run([{ ...click, within: { role: 'dialog', name: 'Cancel this job?' } }]);
  assert.equal(await page.locator('#outside').getAttribute('data-clicked'), null);
  assert.equal(await page.locator('#inside').getAttribute('data-clicked'), 'yes');
  await assert.rejects(run([{ ...click, within: { role: 'main', name: 'Cancel this job?' } }]), /only a named dialog/);
  await page.locator('section').evaluate(node => node.after(node.cloneNode(true)));
  await assert.rejects(run([{ ...click, within: { role: 'dialog', name: 'Cancel this job?' } }]), /strict mode violation|exactly one dialog/);
  await page.setContent('<div role="status"><div><span>✓</span>Staked. Your fee tier counts it now.</div></div>');
  assert.equal(await page.getByText('Staked. Your fee tier counts it now.', { exact: true }).count(), 0);
  await run([{ action: 'wait', text: 'Staked. Your fee tier counts it now.', exact: false }]);
  console.log('PASS: scoped confirmation clicks only its dialog; ambiguous controls/dialogs refuse');
} finally {
  await browser.close();
}
