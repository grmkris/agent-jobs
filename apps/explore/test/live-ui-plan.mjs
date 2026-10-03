import assert from 'node:assert/strict';

const allowedPage = (path) => /^\/(?:me|stake|publish|collect|sponsorship|job\/[0-9]+)(?:\?[^#]*)?$/.test(path);

// Operator-authored Playwright steps, pinned in the release/session card. No arbitrary browser evaluation, raw RPC,
// admin routes, or worker actions. Stop at each crew handoff; resume with the same persisted browser/wallet state.
export async function drivePlan({ page, origin, steps, capture }) {
  assert.ok(Array.isArray(steps) && steps.length > 0 && steps.length <= 60, 'plan needs 1–60 reviewed steps');
  for (const [index, step] of steps.entries()) {
    if (step.action === 'goto') {
      assert.ok(allowedPage(step.path), 'only K6 user pages may be opened');
      await page.goto(`${origin}${step.path}`, { waitUntil: 'domcontentloaded' });
    } else if (step.action === 'capture') {
      assert.match(step.name, /^[a-zA-Z0-9_-]+$/);
      await capture(step.name);
    } else {
      let scope = page;
      if (step.within !== undefined) {
        assert.equal(step.within.role, 'dialog', 'only a named dialog may scope a control');
        assert.ok(typeof step.within.name === 'string' && step.within.name.trim().length > 0, 'dialog name is required');
        scope = page.getByRole('dialog', { name: step.within.name, exact: true });
        await scope.waitFor({ state: 'visible', timeout: 60_000 });
        assert.equal(await scope.count(), 1, `step ${index + 1} must identify exactly one dialog`);
      }
      let locator;
      if (step.role !== undefined) locator = scope.getByRole(step.role, { name: step.name, exact: step.exact ?? true });
      else if (step.text !== undefined) locator = scope.getByText(step.text, { exact: step.exact ?? true });
      else {
        assert.match(step.id, /^[a-zA-Z][a-zA-Z0-9_-]*$/);
        locator = scope.locator(`#${step.id}`);
      }
      await locator.waitFor({ state: 'visible', timeout: 60_000 });
      assert.equal(await locator.count(), 1, `step ${index + 1} must identify exactly one control`);
      if (step.action === 'fill') await locator.fill(step.value);
      else if (step.action === 'click') await locator.click();
      else if (step.action === 'wait') await locator.waitFor({ state: 'visible', timeout: 60_000 });
      else throw new Error('Unknown plan action');
    }
  }
}
