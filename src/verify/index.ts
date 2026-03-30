/**
 * verify — 事後条件を検証する
 */

import type { Page } from 'playwright';
import type { PostCondition, VerifyResult } from '../types.js';

/**
 * ステップの事後条件を検証する。
 * 最大 5 秒間ポーリングして条件が満たされるのを待つ。
 */
export async function verify(
  page: Page,
  post: PostCondition
): Promise<VerifyResult> {
  const checks: VerifyResult['checks'] = [];

  // must_have_heading チェック
  if (post.must_have_heading && post.must_have_heading.length > 0) {
    for (const expected of post.must_have_heading) {
      const result = await pollCheck(
        () => checkHeading(page, expected),
        5000
      );
      checks.push({ predicate: `heading_exists:${expected}`, result });
    }
  }

  // url_pattern チェック
  if (post.url_pattern) {
    const result = await pollCheck(
      () => Promise.resolve(page.url().includes(post.url_pattern!)),
      5000
    );
    checks.push({ predicate: `url_contains:${post.url_pattern}`, result });
  }

  // element_exists チェック
  if (post.element_exists) {
    const result = await pollCheck(
      () => checkElementExists(page, post.element_exists!),
      5000
    );
    checks.push({ predicate: `element_exists:${post.element_exists}`, result });
  }

  // チェックがなければ自動的に成功（postcondition未定義のステップ）
  if (checks.length === 0) {
    return { passed: true, checks: [] };
  }

  const passed = checks.every((c) => c.result);
  return { passed, checks };
}

async function checkHeading(page: Page, expected: string): Promise<boolean> {
  const headings = await page.evaluate(() =>
    Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .map((el) => el.textContent?.trim() || '')
  );
  const lower = expected.toLowerCase();
  return headings.some((h) => h.toLowerCase().includes(lower));
}

async function checkElementExists(page: Page, selector: string): Promise<boolean> {
  const count = await page.locator(selector).count().catch(() => 0);
  return count > 0;
}

/**
 * 最大 maxMs ミリ秒間、checker が true を返すまでポーリングする
 */
async function pollCheck(
  checker: () => Promise<boolean>,
  maxMs: number
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await checker()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
