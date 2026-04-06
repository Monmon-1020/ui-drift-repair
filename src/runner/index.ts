#!/usr/bin/env node
import 'dotenv/config';

/**
 * runner — 全体パイプライン統合
 *
 * Usage:
 *   npx tsx src/runner/index.ts --case <case_id>
 *   npx tsx src/runner/index.ts --all --out results.jsonl
 *   npx tsx src/runner/index.ts --all --auth --skip hr_ --out results.jsonl
 *
 * --auth:  ブラウザを表示。ドメインが変わるときだけログイン待ち。
 * --skip:  指定プレフィックスのケースを除外（複数指定可）。
 * 既に results.jsonl にあるケースは自動スキップ。
 */

import * as readline from 'readline';
import fs from 'fs';
import path from 'path';
import { chromium, type Page } from 'playwright';
import type { CaseResult, Contract, Diagnosis, StepResult } from '../types.js';
import { observe, observePostState } from '../observe/index.js';
import { resolve } from '../resolve/index.js';
import { act } from '../act/index.js';
import { verify } from '../verify/index.js';
import { diagnose } from '../diagnose/index.js';
import { repair } from '../repair/index.js';
import { choosePatchType } from '../repair/policy.js';
import { applyPatch, replay } from '../replay/index.js';

const CASES_DIR = process.env.CASES_DIR || 'dataset/cases/targets_extra';

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

function getDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function getStartUrl(contract: Contract): string {
  return contract.start_url || contract.doc_url;
}

/**
 * 1ケースを実行。同じ page（タブ）を使い回す。
 */
async function runCase(
  caseId: string,
  page: Page
): Promise<CaseResult> {
  const contractPath = path.join(CASES_DIR, caseId, 'contract.json');
  if (!fs.existsSync(contractPath)) {
    throw new Error(`Contract not found: ${contractPath}`);
  }

  const contract: Contract = JSON.parse(fs.readFileSync(contractPath, 'utf-8'));
  const startUrl = getStartUrl(contract);
  console.log(`\n[${caseId}] ${startUrl}`);

  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const stepResults: StepResult[] = [];
  let failedDiagnosis: Diagnosis | null = null;
  let failedStep: typeof contract.steps[0] | null = null;

  for (const step of contract.steps) {
    const action = step.action.type;
    if (!['click', 'type', 'check', 'select', 'press', 'navigate'].includes(action)) {
      console.log(`  Step ${step.step_id}: SKIP (action=${action})`);
      continue;
    }

    console.log(`  Step ${step.step_id}: ${action} "${step.anchor.name}"`);

    const snapshot = await observe(page);
    console.log(`    Candidates: ${snapshot.candidates.length}`);

    const resolveResult = resolve(page, step.anchor, snapshot.candidates);
    console.log(`    Resolve: ${resolveResult.status}`);

    let actResult = null;
    if (resolveResult.status === 'FOUND') {
      actResult = await act(resolveResult.locator, step);
      console.log(`    Act: ${actResult.status}`);
    }

    let verifyResult = null;
    let postSnapshot = undefined;
    if (actResult?.status === 'ok') {
      verifyResult = await verify(page, step.post);
      console.log(`    Verify: ${verifyResult.passed ? 'PASS' : 'FAIL'}`);
      postSnapshot = await observePostState(page);
    }

    const diagnosis = diagnose(step, resolveResult, actResult, verifyResult, snapshot, postSnapshot);
    console.log(`    Diagnosis: ${diagnosis.label}`);

    stepResults.push({ step_id: step.step_id, diagnosis });

    if (diagnosis.label !== 'SUCCESS') {
      failedDiagnosis = diagnosis;
      failedStep = step;
      break;
    }
  }

  const caseResult: CaseResult = {
    case_id: caseId,
    steps: stepResults,
    needs_repair: failedDiagnosis !== null,
  };

  if (failedDiagnosis && failedStep) {
    const patchType = choosePatchType(failedDiagnosis.label);
    if (patchType) {
      console.log(`  Repair type: ${patchType}`);

      const patch = await repair(failedStep, failedDiagnosis);
      if (patch) {
        caseResult.patch = patch;
        console.log(`  Patch generated: ${patch.rationale}`);

        // 同じ page でリプレイ（認証セッション維持）
        const patchedContract = applyPatch(contract, patch);
        const replayResult = await replay(patchedContract, page, patch.step_id);
        caseResult.replay_success = replayResult.success;
        console.log(`  Replay: ${replayResult.success ? 'SUCCESS' : 'FAILED'}`);
        if (!replayResult.success) {
          console.log(`    Failed at: ${replayResult.firstFailedStepId} — ${replayResult.failureReason}`);
        }
      } else {
        console.log(`  Patch generation failed (unresolved)`);
      }
    }
  } else {
    console.log(`  All steps passed — no repair needed`);
  }

  return caseResult;
}

async function main() {
  const args = process.argv.slice(2);
  let caseIds: string[] = [];
  let outFile: string | null = null;
  let authMode = false;
  let retryFailed = false;
  const skipPrefixes: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--case': caseIds.push(args[++i]); break;
      case '--all':
        caseIds = fs.readdirSync(CASES_DIR)
          .filter((d) => fs.existsSync(path.join(CASES_DIR, d, 'contract.json')))
          .sort();
        break;
      case '--out': outFile = args[++i]; break;
      case '--auth': authMode = true; break;
      case '--skip': skipPrefixes.push(args[++i]); break;
      case '--retry-failed': retryFailed = true; break;
    }
  }

  // --skip
  if (skipPrefixes.length > 0) {
    caseIds = caseIds.filter((id) => !skipPrefixes.some((p) => id.startsWith(p)));
  }

  // 既存結果の処理
  if (outFile && fs.existsSync(outFile)) {
    const existingLines = fs.readFileSync(outFile, 'utf-8').split('\n').filter(Boolean);
    const existingResults = existingLines.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    if (retryFailed) {
      // --retry-failed: 失敗したケースだけ再実行。成功分は残す。
      const failedIds = new Set(
        existingResults
          .filter((r: any) => r.needs_repair && r.replay_success !== true)
          .map((r: any) => r.case_id)
      );
      const successLines = existingLines.filter((line) => {
        try {
          const r = JSON.parse(line);
          return !failedIds.has(r.case_id);
        } catch { return false; }
      });
      // 成功分だけ残して書き直す
      fs.writeFileSync(outFile, successLines.join('\n') + (successLines.length ? '\n' : ''));
      caseIds = caseIds.filter((id) => failedIds.has(id));
      console.log(`Retrying ${caseIds.length} failed cases (keeping ${successLines.length} successes)`);
    } else {
      // 通常: 既存結果のケースをスキップ
      const doneIds = new Set(existingResults.map((r: any) => r.case_id));
      const before = caseIds.length;
      caseIds = caseIds.filter((id) => !doneIds.has(id));
      if (before !== caseIds.length) {
        console.log(`Skipping ${before - caseIds.length} already-completed cases`);
      }
    }
  }

  if (caseIds.length === 0) {
    console.error('No cases to run.');
    process.exit(0);
  }

  // ドメイン別にグループ化・ソート
  const caseContracts = caseIds.map((id) => {
    const cpath = path.join(CASES_DIR, id, 'contract.json');
    const contract: Contract = JSON.parse(fs.readFileSync(cpath, 'utf-8'));
    return { id, domain: getDomain(getStartUrl(contract)) };
  });
  caseContracts.sort((a, b) => a.domain.localeCompare(b.domain));
  const sortedIds = caseContracts.map((c) => c.id);

  console.log(`=== UI Drift Repair Runner ===`);
  console.log(`Cases: ${sortedIds.length}, Auth: ${authMode ? 'ON' : 'OFF'}`);

  if (authMode) {
    const domainGroups = new Map<string, string[]>();
    for (const c of caseContracts) {
      if (!domainGroups.has(c.domain)) domainGroups.set(c.domain, []);
      domainGroups.get(c.domain)!.push(c.id);
    }
    for (const [domain, ids] of domainGroups) {
      console.log(`  ${domain}: ${ids.length} cases`);
    }
  }

  // --auth: Cookie が保存されるブラウザプロファイルを使う
  // 一度ログインすれば次回以降は自動でログイン済み
  const userDataDir = path.resolve('.browser-profile');
  const context = authMode
    ? await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: { width: 1280, height: 900 },
      })
    : await chromium.launchPersistentContext('', { headless: true });

  let page = context.pages()[0] || await context.newPage();

  async function safePage(): Promise<Page> {
    try {
      await page.evaluate(() => true);
      return page;
    } catch {
      page = await context.newPage();
      return page;
    }
  }

  const results: CaseResult[] = [];
  let lastDomain = '';

  for (let i = 0; i < sortedIds.length; i++) {
    const caseId = sortedIds[i];
    const domain = caseContracts.find((c) => c.id === caseId)!.domain;

    console.log(`\n--- [${i + 1}/${sortedIds.length}] ---`);

    // ドメインが変わったとき: --auth なら Enter 待ち（初回ログイン用）
    if (authMode && domain !== lastDomain) {
      console.log(`\n=== Domain: ${domain} ===`);
      page = await safePage();
      const cpath = path.join(CASES_DIR, caseId, 'contract.json');
      const contract: Contract = JSON.parse(fs.readFileSync(cpath, 'utf-8'));
      await page.goto(getStartUrl(contract), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitForEnter(`  ログイン済みなら Enter / ログインが必要ならログインして Enter > `);
    }
    lastDomain = domain;

    try {
      page = await safePage();
      const result = await runCase(caseId, page);
      results.push(result);
      if (outFile) {
        fs.appendFileSync(outFile, JSON.stringify(result) + '\n');
      }
    } catch (error: any) {
      console.error(`[${caseId}] ERROR: ${error.message}`);
    }
  }

  await page.close().catch(() => {});
  await context.close();

  // サマリー
  const total = results.length;
  const noRepairNeeded = results.filter((r) => !r.needs_repair).length;
  const repaired = results.filter((r) => r.replay_success === true).length;
  const failed = results.filter((r) => r.needs_repair && r.replay_success !== true).length;

  console.log(`\n=== Summary ===`);
  console.log(`Total: ${total}`);
  console.log(`No repair needed: ${noRepairNeeded}`);
  console.log(`Repaired: ${repaired}`);
  console.log(`Failed: ${failed}`);
  if (total > 0) {
    console.log(`Success rate: ${(((noRepairNeeded + repaired) / total) * 100).toFixed(1)}%`);
  }
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
