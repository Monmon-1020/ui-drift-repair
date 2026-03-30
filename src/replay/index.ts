/**
 * replay — パッチ適用後の Contract を Playwright で再実行して検証する
 */

import type { Browser, Page } from 'playwright';
import type { Contract, Patch, Step } from '../types.js';

export interface ReplayResult {
  success: boolean;
  firstFailedStepId: string | null;
  failureReason: string | null;
  stepsExecuted: Array<{ step_id: string; status: string; error?: string }>;
}

/**
 * パッチを Contract に適用する（純粋関数）
 */
export function applyPatch(contract: Contract, patch: Patch): Contract {
  const patched: Contract = JSON.parse(JSON.stringify(contract));
  const stepIdx = patched.steps.findIndex((s) => s.step_id === patch.step_id);
  if (stepIdx === -1) return patched;

  switch (patch.patch_type) {
    case 'REPLACE_TARGET': {
      const changes = patch.changes as { new_anchor: { role: string; name: string } };
      patched.steps[stepIdx].anchor = {
        ...patched.steps[stepIdx].anchor,
        ...changes.new_anchor,
      };
      break;
    }
    case 'INSERT_STEP': {
      const changes = patch.changes as { insert_before: boolean; new_step: Step };
      const insertIdx = changes.insert_before ? stepIdx : stepIdx + 1;
      patched.steps.splice(insertIdx, 0, changes.new_step);
      break;
    }
    case 'UPDATE_POSTCONDITION': {
      const changes = patch.changes as { new_post: Contract['steps'][0]['post'] };
      patched.steps[stepIdx].post = changes.new_post;
      break;
    }
  }

  return patched;
}

/**
 * パッチ適用済みの Contract を Playwright で再実行する
 * patchedStepId: 修復対象のステップID。このステップまで到達・成功すれば OK。
 */
export async function replay(
  contract: Contract,
  page: Page,
  patchedStepId?: string
): Promise<ReplayResult> {
  const result: ReplayResult = {
    success: false,
    firstFailedStepId: null,
    failureReason: null,
    stepsExecuted: [],
  };

  try {
    const startUrl = contract.start_url || contract.doc_url;
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    for (const step of contract.steps) {
      // CLI系アクションはスキップ
      if (!['click', 'type', 'check', 'select', 'press', 'navigate'].includes(step.action.type)) {
        result.stepsExecuted.push({ step_id: step.step_id, status: 'skipped' });
        continue;
      }

      const stepResult = await executeReplayStep(page, step);
      result.stepsExecuted.push({
        step_id: step.step_id,
        status: stepResult.status,
        error: stepResult.error,
      });

      if (stepResult.status !== 'success') {
        result.firstFailedStepId = step.step_id;
        result.failureReason = stepResult.error || 'execution_failed';
        break;
      }

      // 修復対象ステップまで到達・成功したら、残りは実行しない
      if (patchedStepId && step.step_id === patchedStepId) {
        result.success = true;
        return result;
      }

      await page.waitForTimeout(1000);
    }

    if (!result.firstFailedStepId) {
      result.success = true;
    }
  } catch (error: any) {
    result.failureReason = error.message;
  }

  return result;
}

// ロケータ戦略のホワイトリスト
const ROLE_WHITELIST = new Set([
  'button', 'link', 'tab', 'menuitem', 'checkbox',
  'switch', 'combobox', 'textbox', 'radio', 'option',
]);

async function executeReplayStep(
  page: Page,
  step: Step
): Promise<{ status: string; error?: string }> {
  try {
    const { role, name } = step.anchor;
    const action = step.action.type;

    // CLI系アクションはスキップ（成功扱い）
    if (!['click', 'type', 'check', 'select', 'press', 'navigate'].includes(action)) {
      return { status: 'success' };
    }

    let element = null;

    if (ROLE_WHITELIST.has(role)) {
      for (const exact of [true, false]) {
        const locator = page.getByRole(role as any, { name, exact });
        const count = await locator.count().catch(() => 0);
        if (count > 0) {
          for (let i = 0; i < Math.min(count, 5); i++) {
            const candidate = locator.nth(i);
            if (await candidate.isVisible().catch(() => false)) {
              element = candidate;
              break;
            }
          }
          if (element) break;
        }
      }
    }

    if (!element) {
      const textLocator = page.getByText(name, { exact: false });
      const count = await textLocator.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 5); i++) {
        const candidate = textLocator.nth(i);
        if (await candidate.isVisible().catch(() => false)) {
          element = candidate;
          break;
        }
      }
    }

    if (!element) {
      return { status: 'failed', error: 'element_not_found' };
    }

    await element.scrollIntoViewIfNeeded().catch(() => {});

    if (action === 'click') {
      await element.click({ timeout: 5000 });
    } else if (action === 'type') {
      await element.fill(step.action.value || '');
    }

    return { status: 'success' };
  } catch (error: any) {
    return { status: 'failed', error: error.message };
  }
}
