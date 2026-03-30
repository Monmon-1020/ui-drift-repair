/**
 * observe — ページ上の全インタラクティブ要素を抽出する
 */

import type { Page } from 'playwright';
import type { Candidate, PageSnapshot } from '../types.js';

const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="option"]',
].join(', ');

/**
 * ページの状態を観測し、全候補要素をリストアップする
 */
export async function observe(page: Page): Promise<PageSnapshot> {
  const url = page.url();
  const title = await page.title();

  const candidates = await page.evaluate((selector: string) => {
    const elements = document.querySelectorAll(selector);
    const results: Array<{
      role: string;
      name: string;
      visible: boolean;
      enabled: boolean;
      container: string;
      nearestHeading: string;
      href?: string;
    }> = [];

    const seen = new Set<string>();

    for (const el of elements) {
      // 名前の取得: aria-label > aria-labelledby > textContent
      const name = (
        el.getAttribute('aria-label') ||
        el.textContent?.trim() ||
        ''
      ).slice(0, 200).trim();

      if (!name) continue;

      // 重複排除
      const role = el.getAttribute('role') || inferRole(el);
      const key = `${role}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // container の推定
      const container = findContainer(el);

      // 最寄りの見出し
      const nearestHeading = findNearestHeading(el);

      // 可視性と有効性
      const visible = el.checkVisibility?.() ?? true;
      const enabled = !(el as HTMLButtonElement).disabled &&
                      el.getAttribute('aria-disabled') !== 'true';

      results.push({
        role,
        name,
        visible,
        enabled,
        container,
        nearestHeading,
        href: (el as HTMLAnchorElement).href || undefined,
      });
    }

    return results;

    function inferRole(el: Element): string {
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'input') {
        const type = (el as HTMLInputElement).type;
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        return 'textbox';
      }
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      return tag;
    }

    function findContainer(el: Element): string {
      let node: Element | null = el;
      while (node) {
        const role = node.getAttribute('role');
        const tag = node.tagName.toLowerCase();
        if (role === 'navigation' || tag === 'nav') return 'nav';
        if (role === 'dialog' || tag === 'dialog') return 'dialog';
        if (tag === 'aside') return 'sidebar';
        if (tag === 'header') return 'header';
        if (tag === 'footer') return 'footer';
        if (tag === 'main') return 'main';
        node = node.parentElement;
      }
      return 'unknown';
    }

    function findNearestHeading(el: Element): string {
      // 前方に最も近い見出しを探す
      let node: Element | null = el;
      while (node) {
        const prev: Element | null = node.previousElementSibling;
        if (prev) {
          const heading = prev.tagName.match(/^H[1-6]$/)
            ? prev.textContent?.trim() || ''
            : prev.querySelector('h1,h2,h3,h4,h5,h6')?.textContent?.trim() || '';
          if (heading) return heading;
          node = prev;
        } else {
          node = node.parentElement;
        }
      }
      return '';
    }
  }, INTERACTIVE_SELECTOR);

  // eid を付与
  const withEid: Candidate[] = candidates.map((c, i) => ({
    ...c,
    eid: `e${i}`,
  }));

  return { url, title, candidates: withEid };
}
