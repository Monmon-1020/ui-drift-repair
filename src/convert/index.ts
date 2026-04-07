#!/usr/bin/env node
import 'dotenv/config';

/**
 * convert — ヘルプ記事 + 対象サイトURL → contract.json を自動生成
 *
 * インタラクティブモード: ステップごとに observe → LLM → resolve → act → verify
 * を実行し、UI上で動作することを検証済みのcontractを出力する。
 *
 * Usage:
 *   npx tsx src/convert/index.ts --help_file <md> --url <url> --out <json> [--auth] [--max_steps N]
 */

import * as readline from 'readline';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { chromium, type Page } from 'playwright';
import type { Contract, PageSnapshot, PostCondition, Step } from '../types.js';
import { observe } from '../observe/index.js';
import { resolve as resolveAnchor } from '../resolve/index.js';
import { act } from '../act/index.js';
import { verify } from '../verify/index.js';

// ============================================================================
// 型
// ============================================================================

export interface ConvertResult {
  contract: Contract;
  stepsGenerated: number;
  stepsVerified: number;
  errors: string[];
}

interface StepGenerationRecord {
  step_id: string;
  action: Step['action'];
  anchor: Step['anchor'];
  post: PostCondition;
  actualUrl: string;
  actualHeadings: string[];
}

interface GeneratedStep {
  action: Step['action'];
  anchor: Step['anchor'];
  post: PostCondition;
  done: boolean;
}

// ============================================================================
// LLM 呼び出し
// ============================================================================

const SYSTEM_PROMPT = `You are a help-article-to-contract converter.
Given a help article and the current page's interactive elements,
generate the NEXT step the user should take.

Output JSON only. No markdown fences.`;

function buildUserPrompt(
  helpText: string,
  completedSteps: StepGenerationRecord[],
  snapshot: PageSnapshot,
  currentUrl: string
): string {
  const progress = completedSteps.length === 0
    ? '(none yet)'
    : completedSteps
        .map(
          (r) =>
            `  Step ${r.step_id}: ${r.action.type} "${r.anchor.name}" (${r.anchor.role}, container=${r.anchor.signature?.container_kind || '?'}) → arrived at ${r.actualUrl}, heading="${r.actualHeadings[0] || ''}"`
        )
        .join('\n');

  const elements = snapshot.candidates
    .filter((c) => c.visible && c.enabled)
    .slice(0, 40)
    .map(
      (c) =>
        `  [${c.eid}] ${c.role} "${c.name}" (container=${c.container}, visible, enabled)`
    )
    .join('\n');

  return `## Help Article
${helpText}

## Progress So Far
${progress}

## Current Page
URL: ${currentUrl}
Title: ${snapshot.title}

## Interactive Elements on Current Page
${elements}

## Task
Based on the help article, what is the NEXT step the user should take?
If all steps from the article are already completed, set "done": true.

Output format:
{
  "action": { "type": "click" },
  "anchor": {
    "role": "link",
    "name": "exact name from elements list",
    "signature": {
      "container_kind": "nav or sidebar or main or header etc"
    }
  },
  "post": {
    "must_have_heading": ["expected page heading after this action"],
    "url_pattern": "expected url substring after this action",
    "must_have_text": ["optional text"]
  },
  "done": false
}

Rules:
- anchor.name MUST exactly match one of the element names listed above
- anchor.role MUST match the element's role
- post MUST include at least TWO conditions (heading + url_pattern recommended)
- If the help article says "you will see X page", use that as must_have_heading
- For url_pattern, predict the URL path based on the action (e.g., clicking "Teams" → "/teams")
- Set "done": true ONLY when the help article has no more UI steps to perform
- Do NOT generate steps for non-UI actions (reading text, copying values, etc.)
- If the user is ALREADY on the destination page described in the help article (URL matches and headings show the right content), set "done": true. Do not invent extra clicks just to "confirm".
- If a previous step landed on the SAME URL as the page before it (no navigation happened), the help article likely had no more UI steps — set "done": true.`;
}

async function generateNextStep(
  openai: OpenAI,
  model: string,
  helpText: string,
  completedSteps: StepGenerationRecord[],
  snapshot: PageSnapshot,
  currentUrl: string
): Promise<GeneratedStep | null> {
  const prompt = buildUserPrompt(helpText, completedSteps, snapshot, currentUrl);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) continue;

      const parsed = JSON.parse(content) as GeneratedStep;
      return parsed;
    } catch (e: any) {
      console.warn(`  [LLM] attempt ${attempt + 1} failed: ${e.message}`);
    }
  }

  return null;
}

// ============================================================================
// postcondition 自動抽出（フォールバック）
// ============================================================================

async function extractActualPostcondition(page: Page): Promise<PostCondition> {
  const url = page.url();
  const headings = await page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (parseFloat(style.opacity || '1') === 0) return false;
      return true;
    };

    // dialog/search/nav 配下を除外
    const isInExcluded = (el: Element): boolean => {
      let n: Element | null = el;
      while (n) {
        const role = n.getAttribute('role');
        const tag = n.tagName.toLowerCase();
        if (role === 'dialog' || role === 'search' || tag === 'dialog') return true;
        n = n.parentElement;
      }
      return false;
    };

    // h1優先、なければh2
    const collect = (selector: string): string[] =>
      Array.from(document.querySelectorAll(selector))
        .filter((el) => isVisible(el) && !isInExcluded(el))
        .map((el) => (el.textContent || '').trim())
        .filter((t) => t.length > 0 && t.length < 200);

    const h1s = collect('h1');
    if (h1s.length > 0) return h1s;
    return collect('h2');
  });

  const post: PostCondition = {};

  if (headings.length > 0) {
    post.must_have_heading = [headings[0]];
  }

  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      post.url_pattern = '/' + segments.slice(-2).join('/');
    } else if (segments.length === 1) {
      post.url_pattern = '/' + segments[0];
    }
  } catch {}

  return post;
}

// ============================================================================
// メインループ
// ============================================================================

export async function convertArticleToContract(
  helpText: string,
  startUrl: string,
  caseId: string,
  page: Page,
  maxSteps: number = 10
): Promise<ConvertResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY required');
  const openai = new OpenAI({ apiKey });
  const model = process.env.LLM_MODEL || 'gpt-4o';

  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const steps: Step[] = [];
  const records: StepGenerationRecord[] = [];
  const errors: string[] = [];
  let stepsVerified = 0;
  let stuckCount = 0;

  for (let i = 0; i < maxSteps; i++) {
    const stepId = `s${i + 1}`;

    // 1. observe
    const snapshot = await observe(page);
    console.log(`\n  [${stepId}] candidates=${snapshot.candidates.length} url=${page.url()}`);

    // 2. LLM
    const generated = await generateNextStep(
      openai,
      model,
      helpText,
      records,
      snapshot,
      page.url()
    );

    if (!generated) {
      errors.push(`${stepId}: LLM failed to generate`);
      break;
    }

    if (generated.done) {
      console.log(`  [${stepId}] LLM says done after ${steps.length} steps`);
      break;
    }

    console.log(`  [${stepId}] generated: ${generated.action.type} "${generated.anchor.name}"`);

    const step: Step = {
      step_id: stepId,
      action: generated.action,
      anchor: generated.anchor,
      post: generated.post,
    };

    // 3. resolve
    const resolveResult = resolveAnchor(page, step.anchor, snapshot.candidates);
    if (resolveResult.status !== 'FOUND') {
      errors.push(`${stepId}: resolve failed (${resolveResult.status}) for "${step.anchor.name}"`);
      steps.push(step);
      break;
    }

    // 4. act
    const actResult = await act(resolveResult.locator, step);
    if (actResult.status !== 'ok') {
      errors.push(`${stepId}: act failed (${actResult.status})`);
      steps.push(step);
      break;
    }

    await page.waitForTimeout(2000);

    // 5. verify
    const verifyResult = await verify(page, step.post);
    if (!verifyResult.passed) {
      const actualPost = await extractActualPostcondition(page);
      console.log(
        `  [${stepId}] LLM postcondition failed, using actual: ${JSON.stringify(actualPost)}`
      );
      step.post = actualPost;
      errors.push(`${stepId}: LLM postcondition was overridden`);
    }

    stepsVerified++;
    steps.push(step);

    // 実行記録
    const actualHeadings = await page.evaluate(() =>
      Array.from(document.querySelectorAll('h1,h2,h3'))
        .map((el) => el.textContent?.trim() || '')
        .filter(Boolean)
    );

    const newUrl = page.url();
    const prevUrl = records.length > 0 ? records[records.length - 1].actualUrl : startUrl;

    records.push({
      step_id: stepId,
      action: step.action,
      anchor: step.anchor,
      post: step.post,
      actualUrl: newUrl,
      actualHeadings,
    });

    // ループ検出: URLが変わらないステップが2連続したら終了
    if (newUrl === prevUrl) {
      stuckCount++;
      if (stuckCount >= 2) {
        console.log(`  [${stepId}] URL unchanged for 2 consecutive steps, stopping`);
        break;
      }
    } else {
      stuckCount = 0;
    }
  }

  const contract: Contract = {
    tutorial_id: caseId,
    doc_url: startUrl,
    start_url: startUrl,
    steps,
    meta: {
      source: 'auto-generated',
      drift_type: 'none',
      patch_type: 'REPLACE_TARGET',
      change_date: new Date().toISOString().slice(0, 10),
      rationale: 'Auto-generated from help article by Convert phase',
    },
  };

  return { contract, stepsGenerated: steps.length, stepsVerified, errors };
}

// ============================================================================
// CLI
// ============================================================================

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  let helpFile = '';
  let url = '';
  let out = '';
  let caseId = `case_${Date.now()}`;
  let authMode = false;
  let maxSteps = 10;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--help_file': helpFile = args[++i]; break;
      case '--url': url = args[++i]; break;
      case '--out': out = args[++i]; break;
      case '--case_id': caseId = args[++i]; break;
      case '--auth': authMode = true; break;
      case '--max_steps': maxSteps = parseInt(args[++i], 10); break;
    }
  }

  if (!helpFile || !url || !out) {
    console.error(
      'Usage: npx tsx src/convert/index.ts --help_file <md> --url <url> --out <json> [--auth] [--max_steps N]'
    );
    process.exit(1);
  }

  console.log(`=== Convert: Help → Contract ===`);
  console.log(`Help: ${helpFile}`);
  console.log(`URL:  ${url}`);
  console.log(`Out:  ${out}`);
  console.log(`Auth: ${authMode ? 'ON' : 'OFF'}`);

  const helpText = fs.readFileSync(helpFile, 'utf-8');

  const userDataDir = path.resolve('.browser-profile');
  const context = authMode
    ? await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: { width: 1280, height: 900 },
      })
    : await chromium.launchPersistentContext('', { headless: true });

  const page = context.pages()[0] || (await context.newPage());

  if (authMode) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForEnter('  ログイン済みなら Enter > ');
  }

  try {
    const result = await convertArticleToContract(helpText, url, caseId, page, maxSteps);

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(result.contract, null, 2));

    console.log(`\n=== Convert Result ===`);
    console.log(`Steps generated: ${result.stepsGenerated}`);
    console.log(`Steps verified:  ${result.stepsVerified}`);
    if (result.errors.length > 0) {
      console.log(`Errors:`);
      result.errors.forEach((e) => console.log(`  ${e}`));
    }
    console.log(`Saved: ${out}`);
  } finally {
    await context.close();
  }
}

// ESMでの直接実行検出
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
