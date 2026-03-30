# CODING.md — コード規約とプロジェクト構成

## 技術スタック

| 技術 | 用途 |
|---|---|
| TypeScript 5.x | メイン言語 |
| Playwright | ブラウザ操作（observe, act, replay） |
| OpenAI GPT-4o | パッチ生成・ヘルプ変換 |
| Zod | ランタイムスキーマ検証 |
| tsx | TypeScript直接実行 |
| Jest | テスト |

## ディレクトリ構成

```
research/
├── src/
│   ├── types.ts            # 全型定義（Contract, Step, Patch, etc.）
│   ├── convert/            # ヘルプ記事 → Contract 変換
│   │   └── index.ts
│   ├── observe/            # ページからインタラクティブ要素を抽出
│   │   └── index.ts
│   ├── resolve/            # Contract の anchor と DOM 要素をマッチング
│   │   └── index.ts
│   ├── act/                # Playwright でアクション実行
│   │   └── index.ts
│   ├── verify/             # 事前・事後条件の検証
│   │   └── index.ts
│   ├── diagnose/           # 失敗ラベルの決定（ルールベース）
│   │   └── index.ts
│   ├── repair/             # LLM パッチ生成
│   │   ├── index.ts        # 修復パイプライン
│   │   ├── policy.ts       # ラベル → 修復タイプのマッピング
│   │   └── prompt.ts       # タイプ別プロンプト構築
│   ├── replay/             # パッチ適用 → 再実行 → 検証
│   │   └── index.ts
│   └── runner/             # 全体パイプライン統合
│       └── index.ts
├── dataset/
│   └── cases/
│       └── targets_extra/  # 26 件のテストケース
│           └── <case_id>/
│               ├── contract.json
│               ├── README.md
│               └── patch.json (一部)
├── CODING.md               # このファイル
├── ARCHITECTURE.md         # アーキテクチャ設計
├── tsconfig.json
├── package.json
└── .env                    # OPENAI_API_KEY
```

## Contract 形式（入力データ）

各テストケースの `contract.json` は以下の形式:

```json
{
  "tutorial_id": "case_id",
  "doc_url": "https://...",
  "start_url": "https://...",
  "steps": [
    {
      "step_id": "s1",
      "action": { "type": "click" },
      "anchor": {
        "role": "link",
        "name": "Settings",
        "signature": {
          "container_kind": "sidebar",
          "section_path": ["Navigation"],
          "context_text": ["Context hints"]
        }
      },
      "post": {
        "must_have_heading": ["Settings"],
        "url_pattern": "example.com/settings"
      }
    }
  ],
  "meta": {
    "source": "https://changelog-url",
    "drift_type": "target_replacement",
    "patch_type": "TARGET_REPLACEMENT",
    "change_date": "2025-01-01",
    "rationale": "Why this UI changed"
  }
}
```

### 重要なフィールド

- `anchor.role` + `anchor.name`: 操作対象の要素を特定する（Playwright の getByRole に対応）
- `anchor.signature`: 曖昧さ解消のための追加情報（container, section_path）
- `post.must_have_heading`: 操作後に存在すべき見出し
- `post.url_pattern`: 操作後の URL に含まれるべき文字列
- `meta.patch_type`: この Contract が壊れたとき必要な修復の種類

## コーディング規約

### 全般

- **1ファイル1モジュール**: 各モジュールは `index.ts` に主要な関数を export
- **副作用なし**: 関数はできるだけ純粋に。Playwright Page 等の副作用は引数で受け取る
- **エラーは返す、投げない**: Result 型（`{ ok: true, data } | { ok: false, error }`）を使う
- **ログは console.log**: 構造化ログは不要。`[MODULE]` プレフィックスで十分

### 命名

- ファイル: `snake_case.ts`（ただし index.ts は例外）
- 関数: `camelCase`
- 型: `PascalCase`
- 定数: `UPPER_SNAKE_CASE`

### TypeScript

- `strict: true`
- `any` は外部データの境界でのみ許可（contract.json の読み込み等）
- Zod でランタイム検証してから型付きデータとして扱う
- `import type` を型のみの import に使う

### テスト

- テストファイルは `src/<module>/__tests__/` に配置
- 命名: `<module>.test.ts`
- Playwright を使うテストは `@playwright` タグで区別

### Git

- 機密情報（.env, API キー）は絶対にコミットしない
- node_modules/ はコミットしない

## 実行方法

```bash
# 単一ケースの検査
npx tsx src/runner/index.ts --case <case_id>

# ヘルプ記事から Contract を生成
npx tsx src/convert/index.ts --help_file <md> --url <url> --out <json>

# 全ケースで実験
npx tsx src/runner/index.ts --all --out results.jsonl

# テスト
npm test

# 型チェック
npx tsc --noEmit
```
