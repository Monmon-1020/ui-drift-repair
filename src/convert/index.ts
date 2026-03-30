#!/usr/bin/env node
/**
 * convert — ヘルプ記事 (markdown) → Contract JSON 変換
 *
 * Usage:
 *   npx tsx src/convert/index.ts --help_file <md> --url <url> --out <json>
 */

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { chromium } from 'playwright';
import type { Contract } from '../types.js';

async function extractPageElements(url: string) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const title = await page.title();

  const elements = await page.evaluate(() => {
    const selectors = 'button, a[href], input, select, [role=tab], [role=menuitem], [role=link], [role=button]';
    return Array.from(document.querySelectorAll(selectors))
      .slice(0, 80)
      .map((el) => ({
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        name: (el.getAttribute('aria-label') || el.textContent?.trim() || '').slice(0, 100),
        tag: el.tagName.toLowerCase(),
      }))
      .filter((e) => e.name);
  });

  await browser.close();
  return { title, elements };
}

async function convertWithLLM(
  helpText: string,
  pageInfo: { title: string; elements: Array<{ role: string; name: string; tag: string }> },
  url: string,
  caseId: string
): Promise<Contract> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY required');

  const openai = new OpenAI({ apiKey });

  const elementList = pageInfo.elements
    .slice(0, 50)
    .map((e) => `  ${e.role}: "${e.name}"`)
    .join('\n');

  const prompt = `Convert this help article into step-by-step Contract JSON.

## Help Article
${helpText}

## Page: ${pageInfo.title} (${url})
## Interactive Elements
${elementList}

## Output Format
{
  "tutorial_id": "${caseId}",
  "doc_url": "${url}",
  "start_url": "${url}",
  "steps": [
    {
      "step_id": "s1",
      "action": { "type": "click" },
      "anchor": { "role": "link", "name": "exact name from elements list" },
      "post": { "must_have_heading": ["expected heading"] }
    }
  ],
  "meta": {
    "source": "auto-converted",
    "drift_type": "unknown",
    "patch_type": "REPLACE_TARGET",
    "change_date": "${new Date().toISOString().slice(0, 10)}",
    "rationale": "Auto-generated from help article"
  }
}

Rules:
- Use EXACT element names from the list above
- Every step needs a postcondition (must_have_heading or url_pattern)
- Only include steps that involve clicking/typing on UI elements`;

  const response = await openai.chat.completions.create({
    model: process.env.LLM_MODEL || 'gpt-4o',
    messages: [
      { role: 'system', content: 'Convert help articles to structured step specs. Output valid JSON only.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('Empty LLM response');
  return JSON.parse(content);
}

async function main() {
  const args = process.argv.slice(2);
  let helpFile = '', url = '', out = '', caseId = `case_${Date.now()}`;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help_file') helpFile = args[++i];
    if (args[i] === '--url') url = args[++i];
    if (args[i] === '--out') out = args[++i];
    if (args[i] === '--case_id') caseId = args[++i];
  }

  if (!helpFile || !url || !out) {
    console.error('Usage: npx tsx src/convert/index.ts --help_file <md> --url <url> --out <json>');
    process.exit(1);
  }

  console.log(`=== Help → Contract Converter ===`);
  const helpText = fs.readFileSync(helpFile, 'utf-8');
  console.log(`Help: ${helpText.length} chars`);

  console.log('Extracting page elements...');
  const pageInfo = await extractPageElements(url);
  console.log(`Found ${pageInfo.elements.length} elements`);

  console.log('Converting with LLM...');
  const contract = await convertWithLLM(helpText, pageInfo, url, caseId);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(contract, null, 2));
  console.log(`Saved: ${out} (${contract.steps?.length || 0} steps)`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
