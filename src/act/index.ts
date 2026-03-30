/**
 * act — Playwright で要素に対してアクションを実行する
 */

import type { Locator } from 'playwright';
import type { ActResult, Step } from '../types.js';

const DESTRUCTIVE_WORDS = [
  'delete', 'remove', 'destroy', 'terminate',
  'cancel subscription', 'revoke',
];

/**
 * 要素に対してアクションを実行し、結果を返す
 */
export async function act(
  locator: Locator,
  step: Step
): Promise<ActResult> {
  try {
    // 可視性チェック
    await locator.waitFor({ state: 'visible', timeout: 5000 });

    // disabled チェック
    const disabled = await locator.isDisabled().catch(() => false);
    if (disabled) {
      return { status: 'disabled' };
    }

    const action = step.action.type;

    if (action === 'click') {
      // 破壊的操作のブロック
      const text = (await locator.textContent().catch(() => '')) || '';
      if (DESTRUCTIVE_WORDS.some((w) => text.toLowerCase().includes(w))) {
        return { status: 'error', message: 'destructive_action_blocked' };
      }

      await locator.click({ timeout: 5000 });
    } else if (action === 'type') {
      await locator.fill(step.action.value || '');
    } else if (action === 'check') {
      await locator.check();
    } else if (action === 'select') {
      await locator.selectOption(step.action.value || '');
    } else if (action === 'press') {
      await locator.press(step.action.value || 'Enter');
    }

    // アクション後の安定待ち
    await locator.page().waitForTimeout(1000);

    return { status: 'ok' };
  } catch (error: any) {
    if (error.message?.includes('disabled') || error.message?.includes('not enabled')) {
      return { status: 'disabled' };
    }
    return { status: 'error', message: error.message };
  }
}
