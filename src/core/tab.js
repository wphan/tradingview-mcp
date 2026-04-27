/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import { getClient, evaluate, connectToTarget } from '../connection.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const tabs = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Open a new chart tab.
 *
 * Cmd+T in TradingView Desktop is bound to "superchats", not new tab. The
 * supported path is the layout dropdown's "Create new layout" item, which
 * opens a dialog. The dialog needs a name and the "Open in new tab" checkbox
 * checked; otherwise it just navigates the current tab to a fresh layout.
 *
 * Steps:
 *   1. Click "Manage layouts" (data-name="save-load-menu") to open the dropdown.
 *   2. Click the "Create new layout" item.
 *   3. In the resulting dialog: fill the name input, tick "Open in new tab", click Create.
 *   4. Wait for the new target to register with CDP and report before/after counts.
 */
export async function newTab({ name = 'New' } = {}) {
  const before = await list();

  // Open the layout dropdown menu
  const menuOpened = await evaluate(`
    (function() {
      var menuBtn = document.querySelector('[data-name="save-load-menu"]');
      if (!menuBtn) return { error: 'save-load-menu button not found' };
      menuBtn.click();
      return { ok: true };
    })()
  `);
  if (menuOpened?.error) throw new Error(menuOpened.error);
  await new Promise(r => setTimeout(r, 250));

  // Click "Create new layout" — opens the create-layout dialog
  const itemClicked = await evaluate(`
    (function() {
      var item = document.querySelector('[aria-label="Create new layout"]');
      if (!item) return { found: false };
      item.click();
      return { found: true };
    })()
  `);
  if (!itemClicked?.found) {
    throw new Error('"Create new layout" menu item not found — is the layout dropdown rendered?');
  }

  // Poll for the dialog name input — React mounts the form async.
  // The text input has no `type` attribute (defaults to "text"), so the CSS selector
  // `input[type="text"]` won't match. Use the placeholder instead, which is stable.
  let inputReady = false;
  for (let i = 0; i < 30; i++) {
    const ready = await evaluate(`
      (function() {
        var d = document.querySelector('[data-name="create-dialog"]');
        return !!(d && d.querySelector('input[placeholder="My layout"]'));
      })()
    `);
    if (ready) { inputReady = true; break; }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!inputReady) throw new Error('create-layout dialog or its name input did not appear within 3s');

  // Fill the dialog: name + "Open in new tab" checkbox + Create.
  // React uses controlled inputs, so we must use the native value setter and
  // dispatch input/change events for the form to register the value.
  const submitted = await evaluate(`
    (function() {
      var dialog = document.querySelector('[data-name="create-dialog"]');
      if (!dialog) return { error: 'create-dialog not found' };

      var input = dialog.querySelector('input[placeholder="My layout"]');
      if (!input) return { error: 'name input not found' };
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(name)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      var checkbox = dialog.querySelector('input[type="checkbox"]');
      if (checkbox && !checkbox.checked) checkbox.click();

      var createBtn = Array.from(dialog.querySelectorAll('button')).find(function(b) {
        return b.textContent.trim() === 'Create';
      });
      if (!createBtn) return { error: 'Create button not found' };
      if (createBtn.disabled) return { error: 'Create button disabled (invalid name?)' };
      createBtn.click();
      return { ok: true };
    })()
  `);
  if (submitted?.error) throw new Error(submitted.error);

  // Wait for new tab to register with CDP
  await new Promise(r => setTimeout(r, 2000));

  const after = await list();
  return {
    success: true,
    action: 'new_tab_opened',
    name,
    tabs_before: before.tab_count,
    tabs_after: after.tab_count,
    new_tab_added: after.tab_count > before.tab_count,
    ...after,
  };
}

/**
 * Close the current tab via keyboard shortcut (Ctrl+W / Cmd+W).
 */
export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const c = await getClient();
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2;

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'w', code: 'KeyW' });

  await new Promise(r => setTimeout(r, 1000));

  const after = await list();
  return { success: true, action: 'tab_closed', tabs_before: before.tab_count, tabs_after: after.tab_count };
}

/**
 * Switch to a tab by index. Reconnects CDP to the new target so subsequent
 * API calls (pane_list, screenshot, evaluate, etc.) operate on the chosen tab.
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  // 1. Activate the tab via the CDP HTTP endpoint (asks the browser to bring it to front)
  let activateOk = false;
  try {
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${target.id}`);
    activateOk = resp.ok;
  } catch {}

  // 2. Re-attach the CDP client to the new target. This is the load-bearing step:
  //    without it, every subsequent call still hits the previous tab.
  await connectToTarget(target.id);

  // 3. Page.bringToFront — extra nudge for Electron/BrowserView visibility.
  try {
    const c = await getClient();
    await c.Page.bringToFront();
  } catch {}

  return {
    success: true,
    action: 'switched',
    index: idx,
    tab_id: target.id,
    chart_id: target.chart_id,
    activate_endpoint_ok: activateOk,
  };
}
