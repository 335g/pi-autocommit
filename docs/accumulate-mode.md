# TurnLog 蓄積 + バッチコミット

pi-git は各 `agent_end` で会話ログ（TurnLog）を自動蓄積し、`/git-agg-commit` 実行時に蓄積された全コンテキストを使って AI が高品質な Hunk 分割とコミットメッセージを生成します。

## 動作

### TurnLog の蓄積

- 各 `agent_end` で、ターンの以下の情報が TurnLog に自動蓄積されます
  - ユーザーメッセージ（要約版）
  - アシスタント応答の抜粋
  - 変更ファイル一覧
  - **元の system プロンプト**（`before_agent_start` から取得）
  - **元の user プロンプト**（`before_agent_start` から取得）
- TurnLog はセッションスコープのインメモリデータで、`session_start` で初期化されます
- セッションを切り替えると TurnLog はリセットされます
- 最大 20 ターン、AI プロンプト予算 12KB の制限があります
  - system プロンプトはエントリあたり最大 1,000 文字
  - user プロンプトはエントリあたり最大 1,500 文字
  - 超過分は切り詰められます

### Footer 表示

| 状態 | 表示 |
|------|------|
| 通常 | `auto-commit: accumulate (3ターン) \| 5ファイル` |
| 警告 (5ターン以上) | `⚠ auto-commit: accumulate (7ターン) \| 12ファイル` |
| 重大 (10ターン以上) | `!! auto-commit: accumulate (15ターン) \| 28ファイル — /git-agg-commit を実行してください` |

### コミット

`/git-agg-commit` を実行すると:

1. 最終的な diff を収集
2. TurnLog の会話コンテキストを AI プロンプトに注入
3. AI が diff を論理的な Hunk に分割し、コミットメッセージを生成
4. 各 Hunk を順次コミット
5. TurnLog をクリア

AI プロンプトの優先順位: **diff（最優先） > ファイル共起 > TurnLog Files > TurnLog 会話テキスト > 元の system/user プロンプト**

分析用の system prompt は固定の命令を維持し、保存された元の system/user プロンプトは「会話履歴」セクション内に含めて補足情報として利用します。

`/git-agg-commit --review` を付けると、コミット前にインタラクティブな Hunk レビュー画面が表示されます。

### コミット後

- TurnLog はクリアされ、次のターンから再蓄積が始まります
- ステージング領域はリセットされます
- Footer 表示が更新されます

## 設定

| キー | 型 | デフォルト | 説明 |
|------|----|-----------|------|
| `lang` | `string` | `"en"` | 表示・コミットメッセージの言語 |
| `analysis_model` | `string` | `""` | diff 分析に使用する AI モデル |

## 既知の制限

- 8 ファイル以上の大きな diff では全 TurnLog が全バッチに送られます（部分フィルタ未実装）
- `session_shutdown` での自動コミットは未実装
- 確認ダイアログでの TurnLog 抜粋表示は未実装
- 元の system/user プロンプトは `before_agent_start` イベントから取得します。`agent_end` までの間にセッションが切り替わるなど、対応する `before_agent_start` が失われた場合はプロンプトが記録されません

## トラブルシューティング

| 症状 | 原因 / 解決策 |
|------|-------------|
| TurnLog が消えた | セッション切替または `/git-agg-commit` 実行でクリアされます（正常動作） |
| 20 ターン以上前の会話が TurnLog にない | MAX_ENTRIES = 20 の制限によるもの（正常動作） |
| `/git-agg-commit` に TurnLog コンテキストが使われない | TurnLog が空の場合、従来の diff-only 分析にフォールバック |
| `/git-agg-commit` がブロックされる | 別の git 操作が実行中。完了を待ってから再実行 |
| 手動で `git commit` した後に古い TurnLog が残る | diff が主軸なので AI は実際の変更に基づいて判断します（許容範囲） |
