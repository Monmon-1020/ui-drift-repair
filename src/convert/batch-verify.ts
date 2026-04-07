#!/usr/bin/env node
import 'dotenv/config';

/**
 * batch-verify — 非ドリフトのヘルプ記事リストに対して Convert を実行し、
 * 成功率を計測する。
 *
 * Usage:
 *   npx tsx src/convert/batch-verify.ts --input <jsonl> --out <jsonl> [--auth]
 *
 * 入力 (.jsonl):
 *   {"case_id": "gh_test_01", "help_file": "path/to/help.md", "url": "https://..."}
 */

import * as readline from 'readline';
import fs from 'fs';
import path from 'path';
import { chromium, type Page } from 'playwright';
import { convertArticleToContract } from './index.js';

interface InputCase {
  case_id: string;
  help_file: string;
  url: string;
}

interface VerifyResult {
  case_id: string;
  steps_generated: number;
  steps_verified: number;
  all_passed: boolean;
  errors: string[];
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let input = '';
  let outFile = '';
  let authMode = false;
  let maxSteps = 10;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input': input = args[++i]; break;
      case '--out': outFile = args[++i]; break;
      case '--auth': authMode = true; break;
      case '--max_steps': maxSteps = parseInt(args[++i], 10); break;
    }
  }

  if (!input || !outFile) {
    console.error(
      'Usage: npx tsx src/convert/batch-verify.ts --input <jsonl> --out <jsonl> [--auth]'
    );
    process.exit(1);
  }

  // 入力読み込み
  const cases: InputCase[] = fs
    .readFileSync(input, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  // ドメイン順にソート
  cases.sort((a, b) => getDomain(a.url).localeCompare(getDomain(b.url)));

  console.log(`=== Convert Batch Verify ===`);
  console.log(`Input: ${input}`);
  console.log(`Cases: ${cases.length}`);
  console.log(`Auth:  ${authMode ? 'ON' : 'OFF'}`);

  if (authMode) {
    const groups = new Map<string, number>();
    for (const c of cases) {
      const d = getDomain(c.url);
      groups.set(d, (groups.get(d) || 0) + 1);
    }
    for (const [d, n] of groups) {
      console.log(`  ${d}: ${n} cases`);
    }
  }

  // ブラウザ起動
  const userDataDir = path.resolve('.browser-profile');
  const context = authMode
    ? await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: { width: 1280, height: 900 },
      })
    : await chromium.launchPersistentContext('', { headless: true });

  let page: Page = context.pages()[0] || (await context.newPage());

  async function safePage(): Promise<Page> {
    try {
      await page.evaluate(() => true);
      return page;
    } catch {
      page = await context.newPage();
      return page;
    }
  }

  // 既存結果をスキップ
  const doneIds = new Set<string>();
  if (fs.existsSync(outFile)) {
    for (const l of fs.readFileSync(outFile, 'utf-8').split('\n')) {
      if (!l.trim()) continue;
      try {
        doneIds.add(JSON.parse(l).case_id);
      } catch {}
    }
    if (doneIds.size > 0) {
      console.log(`Skipping ${doneIds.size} already-completed cases`);
    }
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const results: VerifyResult[] = [];
  let lastDomain = '';

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (doneIds.has(c.case_id)) continue;

    const domain = getDomain(c.url);
    console.log(`\n--- [${i + 1}/${cases.length}] ${c.case_id} ---`);

    if (authMode && domain !== lastDomain) {
      console.log(`\n=== Domain: ${domain} ===`);
      page = await safePage();
      await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitForEnter(`  ${domain} にログインして Enter > `);
    }
    lastDomain = domain;

    try {
      page = await safePage();
      const helpText = fs.readFileSync(c.help_file, 'utf-8');
      const result = await convertArticleToContract(
        helpText,
        c.url,
        c.case_id,
        page,
        maxSteps
      );

      const verifyResult: VerifyResult = {
        case_id: c.case_id,
        steps_generated: result.stepsGenerated,
        steps_verified: result.stepsVerified,
        all_passed:
          result.stepsGenerated > 0 &&
          result.stepsVerified === result.stepsGenerated &&
          result.errors.length === 0,
        errors: result.errors,
      };

      results.push(verifyResult);
      fs.appendFileSync(outFile, JSON.stringify(verifyResult) + '\n');

      console.log(
        `  → generated=${result.stepsGenerated}, verified=${result.stepsVerified}, passed=${verifyResult.all_passed}`
      );
    } catch (e: any) {
      console.error(`  ERROR: ${e.message}`);
      const verifyResult: VerifyResult = {
        case_id: c.case_id,
        steps_generated: 0,
        steps_verified: 0,
        all_passed: false,
        errors: [`fatal: ${e.message}`],
      };
      results.push(verifyResult);
      fs.appendFileSync(outFile, JSON.stringify(verifyResult) + '\n');
    }
  }

  await context.close();

  // サマリー（既存結果も含めて再集計）
  const allResults: VerifyResult[] = fs
    .readFileSync(outFile, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const total = allResults.length;
  const allPassed = allResults.filter((r) => r.all_passed).length;
  const partial = allResults.filter(
    (r) => !r.all_passed && r.steps_verified > 0
  ).length;
  const failed = allResults.filter((r) => r.steps_verified === 0).length;

  console.log(`\n=== Convert Verification Summary ===`);
  console.log(`Total cases: ${total}`);
  console.log(
    `All steps passed: ${allPassed} (${((allPassed / total) * 100).toFixed(1)}%)`
  );
  console.log(`Partial pass: ${partial}`);
  console.log(`Failed: ${failed}`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
