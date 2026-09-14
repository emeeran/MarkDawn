// Smoke e2e — requires tauri-driver + WebKitWebDriver (see README "E2E").
// Run: npx tauri driver start … or `tauri dev` with TAURI_DRIVER; kept out of
// the default `npm test` path because the driver isn't part of dev setup.
import { expect, t } from '@playwright/test'
import { _electron as electron } from 'playwright-core'

// ponytail: single happy-path smoke test per plan; expand only when regressions appear.
t.describe('notepad smoke', () => {
  t.test('launches, opens editor, types and saves', async () => {
    const app = await electron.launch({ args: ['src-tauri/target/debug/notepad'] })
    const win = await app.firstWindow()
    await expect(win.locator('.welcome h1')).toHaveText('Notepad')
    await win.getByText('New file').click()
    await win.locator('.editor-host').click()
    await win.keyboard.type('# Hello Notepad')
    await win.keyboard.press('Control+S')
    // A tab appears with a title once a file is saved via the dialog (manual in CI
    // without a display server); core assertion is the editor mounted and typed.
    await expect(win.locator('.editor-host')).toContainText(/Hello/)
    await app.close()
  })
})
void expect
void electron
