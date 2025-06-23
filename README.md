# Claude Code Runner

macOS上でiTermを通じて、指定した時刻にClaude CLIコマンドを実行するTauri 2.0デスクトップアプリケーション。

<img src="./src/assets/icon.png" alt="Claude Code Runner" width="128" height="128">

## 機能

- 🕐 **スケジュール実行**: 指定した時刻にClaudeコマンドを実行
- 🔄 **Rate Limit自動リトライ**: Rate Limitを検出したら自動的に再実行
- 📊 **リアルタイム監視**: 実行状況とターミナル出力を追跡
- 💾 **設定の永続化**: 設定を保存して次回も利用可能
- 🖥️ **iTerm統合**: iTermとのシームレスな統合
- 🎯 **ウィンドウ管理**: 新規ウィンドウまたは既存セッションでの実行を選択可能

## 必要な環境

- macOS（iTerm統合のため必須）
- [iTerm](https://iterm2.com/)がインストールされていること
- [Claude CLI](https://docs.anthropic.com/claude/docs/claude-cli)がインストール・設定済みであること
- Node.js 16以上とnpm/pnpm
- Rustツールチェーン（ビルド用）

## インストール

### ソースからビルド

1. リポジトリをクローン:
```bash
git clone https://github.com/yourusername/tauri-claude-code-runner.git
cd tauri-claude-code-runner
```

2. 依存関係をインストール:
```bash
npm install
```

3. アプリケーションをビルド:
```bash
npm run tauri build
```

4. ビルドされたアプリケーションは `src-tauri/target/release/bundle/` にあります

### アクセシビリティ権限の設定

インストール後、アクセシビリティ権限を付与する必要があります：

1. **システム設定** > **プライバシーとセキュリティ** > **アクセシビリティ** を開く
2. **Claude Code Runner** をリストに追加
3. アプリの横にあるチェックボックスを有効にする

## 使い方

### 基本的な使用方法

1. **アプリケーションを起動**
2. **実行時刻を設定**: Claudeコマンドを実行する時刻を選択
3. **ディレクトリを選択**: コマンドを実行する作業ディレクトリを選択
4. **オプションを設定**: Claude CLIのオプションを設定（デフォルト: `--model opus`）
5. **コマンドを入力**: Claudeに実行させたいコマンドを入力
6. **「開始」をクリック**: アプリは指定時刻まで待機して実行

### 実行モード

#### 新規ウィンドウモード（デフォルト）
- 新しいiTermウィンドウを作成
- 指定されたディレクトリに移動
- 完全なClaudeコマンドを実行

#### 既存ウィンドウモード
- 現在のiTermセッションにコマンドのみを送信
- セッションでClaude CLIが既に実行されている必要があります
- 会話を継続する場合に便利

### Rate Limit処理

アプリはRate Limit処理のための2つのモードを提供：

1. **自動リトライモード**: 
   - Rate Limitメッセージを監視
   - 制限がリセットされるまで待機
   - 自動的に実行を継続

2. **終了モード**:
   - Rate Limitが検出されたら実行を停止
   - 検出を通知

### モニタリング

実行中、アプリは以下を表示：
- 実行時刻までのカウントダウンタイマー
- リアルタイムのターミナル出力（最後の20行）
- 処理ステータスと完了時間
- Rate Limit検出と待機時間

## 開発

### 開発環境のセットアップ

1. 依存関係をインストール:
```bash
npm install
```

2. 開発サーバーを起動:
```bash
npm run tauri dev
```

### 利用可能なスクリプト

- `npm run dev` - Vite開発サーバーのみ起動
- `npm run tauri dev` - Tauriを開発モードで起動
- `npm run build` - フロントエンドアセットをビルド
- `npm run tauri build` - アプリケーション全体をビルド
- `npm run fmt` - TypeScript/CSSファイルをフォーマット
- `npm run tauri:fmt` - Rustコードをフォーマット

### プロジェクト構成

```
├── src/                    # フロントエンド（React + TypeScript）
│   ├── App.tsx            # メインアプリケーションコンポーネント
│   └── assets/            # 静的アセット
├── src-tauri/             # バックエンド（Rust）
│   ├── src/
│   │   └── lib.rs        # Tauriのコアロジック
│   └── tauri.conf.json   # Tauri設定
└── CLAUDE.md             # AIアシスタント用の指示
```

## 設定

### デフォルト設定

- **モデル**: `opus`（Claudeの最も高性能なモデル）
- **実行モード**: 新規iTermウィンドウ
- **自動リトライ**: デフォルトで無効

### 永続化される設定

以下の設定はlocalStorageに保存されます：
- ターゲットディレクトリ
- Claudeオプション
- 最後のコマンド
- 自動リトライの設定
- ウィンドウモードの設定

## 技術詳細

### Rate Limit検出

アプリは以下の方法でRate Limitを検出：
1. 60秒ごとにターミナル出力を監視
2. 「esc to interrupt」の存在を確認（実行中を示す）
3. 「reset at」メッセージを検出（3回連続で出現）
4. リセット時刻を解析して待機時間を計算

### iTerm統合

AppleScriptを使用してiTermを制御：
- ウィンドウとタブの管理
- コマンドの実行
- 出力の取得
- セッション制御

### バージョン管理

バージョン形式: `YY.M.D`（例: 2025年6月23日の場合 `25.6.23`）
- ビルド時に自動更新
- package.json、Cargo.toml、tauri.conf.json間で同期

## トラブルシューティング

### iTermが検出されない

- [iterm2.com](https://iterm2.com/)からiTermがインストールされているか確認
- iTermのプロセス名が「iTerm2」であることを確認
- 更新ボタンをクリックしてステータスを更新

### アクセシビリティ権限

コマンドが実行されない場合：
1. システム設定 > プライバシーとセキュリティ > アクセシビリティを確認
2. Claude Code Runnerを削除して再追加
3. アプリケーションを再起動

### Rate Limitの問題

- システム時刻が正しいか確認
- Claude CLIが適切に認証されているか確認
- 特定のエラーメッセージのターミナル出力を監視

## 貢献

1. リポジトリをフォーク
2. フィーチャーブランチを作成（`git checkout -b feature/amazing-feature`）
3. 変更をコミット（`git commit -m 'Add some amazing feature'`）
4. ブランチにプッシュ（`git push origin feature/amazing-feature`）
5. プルリクエストを作成

## ライセンス

このプロジェクトはMITライセンスのもとで公開されています - 詳細はLICENSEファイルを参照してください。

## 謝辞

- [Tauri](https://tauri.app/)で構築
- UIは[React](https://react.dev/)と[Tailwind CSS](https://tailwindcss.com/)を使用
- Anthropic社の[Claude CLI](https://docs.anthropic.com/claude/docs/claude-cli)と統合
