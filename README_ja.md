# ORNELYON v0.4.2（日本語）

OpenAI Codex、Claude Code、OpenAI互換のローカルLLMを、ひとつのセットアップ画面とひとつのコマンドから使うための小さなローカルハーネスです。OpenAI、Google、Microsoft、Anthropic とは無関係で、各社の公式製品でも、各社が承認・後援するものでもありません。Codex や Claude Code のサインインを使う前に、[アカウント・課金・各社の利用規約](#アカウント課金各社の利用規約)をお読みください。

> 状態：**Public Preview**（v0.4.2）。安定版ではなく、下記に書いた以外の保証はありません。オフラインテスト 286 件が通過（偽 Agent・ローカルの偽モデル・手組みの履歴・公式 MCP SDK クライアント、有料呼び出しなし）。実 Claude Code の実行は、読み取り専用のタスクと Claude Code から Claude Code への読み取り専用の引き継ぎ（v0.3.0、v0.3.1、および v0.4.2 のビルドで各 1 回）で、v0.4.0 と v0.4.1 では実 Agent を呼んでいません。v0.4.2 では実 Claude Code を 2 回（読み取り専用タスク 1 回と Claude Code から Claude Code への引き継ぎ 1 回、2026-11-02）呼び、実 Codex は呼んでいません。方針として、従量課金・利用枠外の Agent 呼び出しでは v0.4.1 と v0.4.2 をテストしません。実ファイル編集、実際の失敗、Codex の実タスク（Codex を含む引き継ぎも）、他の OS、Claude Code / Codex から MCP サーバーへの実接続は **未実施（NOT_TESTED）** です。Efficiency Benchmark は手組み・合成・偽 Agent の履歴でしか確認しておらず、実際のトークン・費用の節約はまだ示せません。詳細は [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md) の 13〜17 節を参照してください。

## ORNELYON でできること

- 利用者が選んだ Agent（Codex CLI、Claude Code CLI、OpenAI 互換のローカルモデル）で、ローカルの GUI またはコマンドラインからタスクを 1 件実行します。
- 実行ごとに履歴を残し、3 つを別々に判定します。**Execution**（Agent が処理を終えたか）、**Verification**（検査が示す結果）、**Acceptance**（利用者の判断）。
- 検査は利用者が選んだものだけで行います。ファイル、JSON、信頼済みコマンド、変更範囲の規則、任意の独立レビューです。検査がなければ、成功した実行も検証済みとは表示しません。
- Task Passport を保存し、利用者が依頼したときだけ別の Agent に引き継げます。
- 他ツール向けの読み取り専用 MCP サーバー（任意）、自分の履歴から作る効率ベンチマーク、実験的な Research コマンドがあります。

**できないこと：** 代わりにサインインすること、API キーやサインイン用トークンを保存すること、自己改善ループ、Agent セッションの再開、WSL やコンテナによる隔離。Smart Dispatch の追加レビューは既定で無効です。

## 必要なもの

- **Node.js 20 以上**（https://nodejs.org）。ほかにグローバルなインストールは不要で、管理者権限も要りません。これまで検証したのは Windows の Node.js 24 です。
- 使いたいエージェントごとの任意の項目：
  - Codex：OpenAI が公開している Codex CLI をご自身で入れ、`codex login` を実行。
  - Claude Code：Anthropic が公開している Claude Code CLI をご自身で入れ、`claude auth login` を実行。
  - ローカルLLM：OpenAI互換のサーバー（Ollama、LM Studio、llama.cpp server など）。

## 公開プレビューで確認済みの内容

これは公開プレビューの第一版です。下表は、確認したことと確認していないことを示します。「NOT_TESTED」は実行していないという意味で、動かないという意味ではありません。

| 項目 | 状態 |
| --- | --- |
| Windows 11 と Node.js 24：`npm test`（オフラインテスト 286 件）、ビルド、パッケージ化、起動 | 作者がローカルで確認 |
| Node.js 20、macOS、Linux | **実機では未確認。** CI の定義（`.github/workflows/ci.yml`）はありますが、まだ実行していません |
| 実 Claude Code の実行 | 読み取り専用のタスクと、Claude Code から Claude Code への読み取り専用の引き継ぎ：v0.3.0 と v0.3.1、および v0.4.2 のビルドで各 1 回（2026-11-02、Claude Code 2.1.311、サブスクリプションのサインイン、計 2 回、どちらも成功）。**v0.4.0 と v0.4.1 では実 Agent を実行していません** |
| 実 Codex タスク | NOT_TESTED（v0.4.2 でも実行していません。以前の確認では、作者の Windows 環境で Codex のサンドボックス設定により BLOCKED でした） |
| 引き継ぎ経路 9 通り（[引き継ぎ経路](#引き継ぎ経路実装済みは検証済みではない) を参照） | 9 通りとも読み取り専用の引き継ぎとして実装済み。実 Agent で実行したのは Claude Code から Claude Code への 1 通りのみ。残り 8 通りは NOT_TESTED |
| 実ファイル編集、実際の失敗 | NOT_TESTED |
| Claude Code / Codex から MCP サーバーへの実接続 | NOT_TESTED |
| 効率ベンチマークの実際のトークン・費用の節約 | **未確認。** 合成データと手組みの履歴でのみ確認 |
| サブスクリプションのサインインで自動実行してよいか | **未確認（NOT CONFIRMED）。** [アカウント・課金・各社の利用規約](#アカウント課金各社の利用規約)を参照 |
| Gemini CLI | **未実装・非対応** |

テストは偽の Agent と、ローカルの偽モデルを使います。コードがテストどおりに動くことは示しますが、実際の Agent の振る舞いは示しません。

## アカウント・課金・各社の利用規約

Codex または Claude Code のサインインで ORNELYON を動かす前にお読みください。各社の公開ページを 2026-11-01 に確認した内容です。技術的な説明であり法的助言ではなく、この文書の免責が各社の規約を変えることもありません。

- **独立したプロジェクトです。** ORNELYON は OpenAI、Anthropic、Google、Microsoft と提携しておらず、各社の承認・後援も受けていません。各社の製品名は、ORNELYON が連携できるツールを示すためだけに使っています。「ORNELYON」はこのプロジェクト独自の名称で、どの会社の製品名でもありません。
- **CLI の使い方。** ORNELYON は、**あなたが** インストールした Codex CLI と Claude Code CLI を、改変せずに通常の子プロセスとして非対話モード（`codex exec`、`claude -p`）で起動します。ログイン用トークンや認証情報ファイルは、読み取り・複製・保存・中継・送信をしません。独自のサインイン機能もなく、OpenAI や Anthropic の Web API を自分で呼ぶこともありません。サインインは各 CLI に任せています。ローカルLLMアダプターは、あなたが設定した OpenAI 互換の URL を呼びます。外部のホスト型サービスを指定した場合は、そのサービスの規約と課金があなたに適用されます。
- **課金は想定と違うことがあります。** 認証と課金の方式は、各 CLI が決めます。サブスクリプションのサインイン、CLI が保存した API キー、API キーの環境変数のいずれかです。ORNELYON は自分の環境変数をそのまま CLI に渡し、方式を選んだり切り替えたりしません。そのため、環境に API キー（各社のドキュメントに載っている名前のもの）があると、サブスクリプションでサインインしていても従量課金になることがあります。実行前に、CLI のログイン状態（`codex login status`、`claude auth status`）と環境変数を確認し、各社の課金に関する説明を読んでください。費用は、Agent が報告した場合のみ表示します。
- **規約上の状態：未確認（NOT CONFIRMED）。** CLI 自身の非対話モードと、ORNELYON のような第三者のツールがそれを **サブスクリプションのサインインで** 動かしてよいかは、別の問題です。ORNELYON は、許可されているとも禁止されているとも主張しません。次の 2 経路は未確認です。
  - Anthropic：ORNELYON が Claude のサブスクリプションのサインインで `claude -p` を動かす場合。
  - OpenAI：ORNELYON が ChatGPT のサインインで `codex exec` を動かす場合。

  最新の規約をご自身で確認する（または各社に問い合わせる）までは、これらの経路はご自身の責任での利用としてください。各社の文書は、自動化やプログラムからの利用に API キー認証を勧めています。その点も確認してください。複数 Agent 機能（レビュー、フォールバック、引き継ぎ）は、設定した上限の範囲内で、同じサインインを通じて呼び出しを増やすことがあります。
- **確認すべき規約。**
  - Anthropic：[Consumer Terms](https://www.anthropic.com/legal/consumer-terms)、[Claude Code の法務・コンプライアンス](https://code.claude.com/docs/en/legal-and-compliance)、[Claude Code のヘッドレスモード](https://code.claude.com/docs/en/headless)。
  - OpenAI：[利用規約](https://openai.com/policies/terms-of-use/)（欧州経済地域・スイス・英国以外の利用者向け）、[欧州経済地域・スイス・英国向けの利用規約](https://openai.com/policies/eu-terms-of-use/)、API や企業向けの利用については各ページからリンクされている事業者用取引規約、[Codex の認証](https://developers.openai.com/codex/auth)。
- **Gemini CLI：未実装・非対応。** このバージョンには Gemini CLI のアダプターも、それを起動するコードもありません。そのため、ルーティングやフォールバックの実行先にはなりません。方針として、ORNELYON は Google アカウントのサブスクリプション／OAuth サインインによる Gemini CLI の自動実行をサポートせず、その OAuth 認証情報を取得・転用・中継しません。将来対応する場合は、Google が認める認証方式と利用条件を確認してから判断します。Gemini API と Vertex AI は別経路で、未実装です。将来実装する場合は、明示的な有効化と課金への同意を必要とします。

## はじめ方

1. パッケージを展開します。
2. Windows は **`start-ornelyon.bat`** をダブルクリック。macOS/Linux は展開したフォルダでターミナルを開き **`sh start-ornelyon.sh`** を実行します。（ZIP は実行権限を保持しないため、`./start-ornelyon.sh` は `chmod +x` するまで動きません。macOS/Linux の起動スクリプトは実機で未確認です。）
3. ターミナルに表示されたリンクをブラウザで開きます。リンクにはセッション用のトークンが含まれ、ORNELYON が動いている間だけ有効です。
4. **Setup** でプリセットを選び、メインAIを決め、確認項目をチェックしてから **Complete setup** を押します。
5. **Task** で指示を入力し **Run** を押します。

GUI を使っている間はターミナルを閉じないでください。停止するには、そのターミナルで Ctrl+C を押します。

### コマンドライン

```bash
node dist/interface/cli.js doctor
node dist/interface/cli.js run "このフォルダのファイルを要約して" --agent local
node dist/interface/cli.js history
node dist/interface/cli.js cost
node dist/interface/cli.js tool WebFetch DORMANT
```

## インストールプリセット

| プリセット | 有効になる機能 |
| --- | --- |
| Lite | エージェント1つ。マルチAIは隠され、読み込まれません。 |
| Standard | 手動切替と相互レビュー、失敗ループ検出、実行履歴、コスト表示。 |
| Research | Standard に加えて自動振り分けと、実験的な Research コマンド（下記）。v0.1 に自動の自己改善ループはありません。 |

### Research（実験的）

Research プリセットのときだけ、利用者が実行したときに動きます。Research は **有効な** Agent だけを起動し、通常のタスクと同じ `maxCalls` に従います。各バリアントは `--samples` 回呼ぶため、既定の 3 バリアントで `--samples 1` なら 3 回です。`maxCalls` を超える計画は、実行前に拒否されます。呼び出しは由来（origin）付きで履歴に記録されます。

```bash
node dist/interface/cli.js research run "2 + 2 は？数字だけで答えて。" --agent local --expect "^4$" --samples 1
node dist/interface/cli.js research list
node dist/interface/cli.js research show <id>
node dist/interface/cli.js research apply <id> --yes
```

タスクに複数の指示の前置きを付けて試し、`--expect` の正規表現で回答を判定します。基準（前置きなし）より良かった前置きだけを **pending** の候補として保存します。適用すると変わるのは、そのエージェントの `promptPrefix` だけです。サンドボックス、ループ検出、予算、ツール、キーは変わりません。

プリセットは初期値を決めるだけです。あとから Setup や Agents 画面で自由に変更できます。

## 協調レベル

| レベル | 意味 |
| --- | --- |
| L0 | 単一エージェント |
| L1 | 手動切替：利用者がエージェントを選びます。自動では切り替えません。 |
| L2 | 相互レビュー：メインの回答を、別の有効なエージェントが評価します。 |
| L3 | ルールベース振り分け：エージェントが宣言した能力・優先順位・日次予算に従い、最初に条件を満たす利用可能なエージェントを実行します。失敗時は次の候補に切り替えます。 |
| L4 | 協調実行：v0.1 では**未実装**です。 |

すべてのタスクには上限があります。最大エージェント呼び出し数（`maxCalls`、既定3回。再試行とレビューを含む）、最大のネスト深さ、エージェントごとのタイムアウト、そして（エージェントがコストを報告する場合）1日あたりの予算です。

## 安全設定の既定値

- GUI は **127.0.0.1 のみ**で待ち受けます。想定外の `Host` ヘッダーを拒否し、API 呼び出しには起動ごとのトークンが必要です。
- Codex は既定で **read-only サンドボックス**で動きます。Claude Code は読み取りタスクで **plan モード**を使い、権限バイパスのフラグは使いません。
- エージェントは設定した**ワークスペースフォルダの中**でだけ作業します。シンボリックリンクを含め、外へ出るパスは拒否します。
- **APIキーは設定ファイルに保存しません。** ローカルLLMでは、キーを入れた環境変数の名前だけを保存します。
- ログと履歴から、代表的なキー形式と、指定した環境変数の値を取り除きます。
- 設定の保存は一時ファイル経由で行い、直前の版を `config.json.bak` に残します。設定が壊れた場合はバックアップから復元し、壊れたファイルは `config.json.corrupt` として残します。

## 既知の制限

- **Public Preview。** 安定版になるまで、インターフェース、ファイル形式、既定値は変わることがあります。先に [公開プレビューで確認済みの内容](#公開プレビューで確認済みの内容) をお読みください。
- **動作確認の範囲：** 実行したのは Windows と Node.js 24 だけです。macOS、Linux、Node.js 20 は未確認です。
- **実 Agent：** v0.4.0 と v0.4.1 では実 Agent の確認を追加していません。v0.4.2 のビルド（2026-11-02、Claude Code のサブスクリプションのサインイン）では、読み取り専用の Claude Code タスク 1 回と、読み取り専用の Claude Code から Claude Code への引き継ぎ 1 回が成功しました。引き継ぎコンテキストのハッシュは送ったものと一致し、受け取った Agent の回答はファイルの内容と一致しました。受け取った Agent がファイルを開いたことを示す記録はないため、それは証明されていません。Codex を含む引き継ぎ、ローカル LLM との引き継ぎ、実 Codex の作業、実ファイル編集、実際の失敗、クライアントからの MCP 接続は NOT_TESTED です。サブスクリプションのサインインによる自動利用が許されるかは NOT CONFIRMED です。
- **Gemini CLI** は未実装で、Google アカウントのサインインによる利用はサポートしません。
- **コスト**：エージェントが報告した場合のみ表示します。それ以外は「不明」と表示します。価格の推定は行いません。
- **失敗ループ検出**は、再試行と切替の間で働きます。実行中の Codex や Claude のセッションに割り込むことはできません。
- **ツールの休眠（Dormancy）**：ローカルLLMへのリクエストからツールを除き、Claude Code には使用禁止として渡します。Codex CLI にはツール単位の切替がないため対象外です。ツールの状態を変えるのは利用者だけです。
- **サブエージェント**は既定で無効（`allowSubagents`）です。Codex は `multi_agent` 機能を無効にして起動します。Claude Code はサブエージェント用ツールを名前で拒否します。ツール名は Claude Code のバージョンごとに確認できていません。
- **Claude の workspace-write** は `acceptEdits` で動きます。ファイル編集は自動承認され、承認が必要な操作はヘッドレスでは拒否されます。
- **セッション継続**は未実装です。タスクごとに新しい一時セッションで実行します。
- v0.1 では自己改善の自動ループ、ベンチマーク、WSL やコンテナによる隔離は含みません。

### 同じCLIが複数インストールされている場合

`doctor` でエージェントが壊れていると表示される場合や、スタンドアロン版と npm 版の両方がある場合は、**Agents → Executable path** に絶対パスを指定してください。指定したファイルをそのまま実行します。

## v0.2 の新機能

v0.2 は、エージェントの作業に検査を加えます。操作は CLI で完結し、GUI は同じ結果を表示して採用・差し戻しを記録できます。GUI がなくても全機能を使えます。

**タスクごとに 3 つを独立して判定します**（`run`、`history`、`verdict`、Runs 画面に表示）。

| 項目 | 値 | 意味 |
| --- | --- | --- |
| Execution（実行） | SUCCESS、FAILED、BLOCKED、CANCELLED、UNKNOWN | エージェントの処理が有用な回答で終わったか。正しさの判定ではありません。 |
| Verification（検証） | PASS、FAIL、UNVERIFIED、NOT_RUN | 確認可能な証拠が示す結果。終了コード 0 だけでは PASS になりません。 |
| Acceptance（採用） | PENDING、ACCEPTED、REJECTED、NOT_REQUIRED | ACCEPTED と REJECTED は利用者の判断だけで設定されます。エージェントの「テスト成功」では設定されません。 |

検査はタスクごとに選びます。

```bash
ornelyon run "アップロード処理にリトライを追加" --sandbox workspace-write --allow-write \
  --allow-files src/upload.ts,test/upload.test.ts \
  --verify-file src/upload.ts --verify-json package.json \
  --verify-command unit-tests --require-review
```


- `--allow-files` は実行後に、ワークスペースのスナップショットで確認します（workspace-write の実行と、このオプションを付けた read-only の実行）。一覧の外への変更を検出しますが、防止はしません。
- `--verify-file パス[:sha256]` は、ファイルの存在と、指定した場合はハッシュの一致を確認します。
- `--verify-json` はファイルが JSON として読めるかを確認します。
- `--verify-command 名前` は `config.json` に登録したコマンドを実行します。エージェントは追加できません。
- `--require-review` は、有効な別のエージェントに独立レビューを依頼します。`VERDICT: OK` は検査結果として記録されます。ただし AI の判断であり、証明ではありません。

**採用。** `ornelyon accept <task-id> --reason "..."`。実行が成功していない場合、検証が失敗した場合、必須の検査が欠けている場合は拒否されます。`--override` と理由を付ければ採用できますが、上書きは記録されます。採用は結果への判断を記録するもので、既に変更されたファイルを適用・承認するものではありません。

**ドライラン。** `ornelyon run "..." --dry-run` は、振り分けの計画と実行される検査を表示します。エージェントは起動せず、利用可否も確認しません。

**信頼済みの検証コマンド** は `config.json` に書きます。絶対パスで指定し、シェルを介さずに実行され、タスクが名前で指定したときだけ動きます。`allowCommands` は既定で無効です。

```json
"verification": {
  "allowCommands": true,
  "commands": {
    "unit-tests": { "command": "C:\\Program Files\\nodejs\\node.exe", "args": ["test.js"], "timeoutSec": 300 }
  }
}
```

**Smart Dispatch**（既定で無効）。`multiAi.smartDispatch.enabled` を有効にすると、重要な種類（`criticalKinds`、例：`security`）の回答に対し、別の有効なエージェントが独立レビューを 1 回だけ行います。同じレビューで既に PASS したものは再利用します。同じ失敗が繰り返された場合は、手法の変更を促して止まります。`--require-review` は Smart Dispatch が無効でも動きます。レビューは `maxCalls` と日次予算に数えられ、隠れた呼び出しはありません。

**Task Passport と引き継ぎ。** `ornelyon passport save <task-id>` は、タスクの状態の要約を `data/passports/` に保存します。内容は、目的（1 行目のみ）、各状態、変更ファイルとハッシュ、未解決事項、次の作業、ワークスペースの git コミット（ある場合）です。Passport には整合性ハッシュが付き、改変や切り詰めがあると拒否されます。`ornelyon handoff <task-id> --to <agent>` は、その Passport から別のエージェントで読み取り専用の新しいタスクを始めます。実行は利用者が依頼したときだけです。Passport の保存後にファイルが変わっていた場合は、一覧を表示して止まります。続ける場合は `--accept-current-state` を付けます。また、対象エージェントが無効・利用不可の場合、必要な能力（capability）を宣言していない場合、日次予算を使い切っている場合、`multiAi.maxHandoffs` を超える場合は、エージェントを起動する前に拒否されます。引き継ぎは指定したエージェントだけを実行し、振り分けや代替は行いません。

**2 つの上限（v0.3）。** `multiAi.maxDepth` は「入れ子」の呼び出し（1 つのタスクの中で、エージェントが別のエージェントを呼ぶこと。例：レビュー）を制限します。`multiAi.maxHandoffs` は、1 つの連鎖で手動の引き継ぎを何回続けられるか（既定 2）を制限します。この 2 つは互いに影響しません。引き継ぎ回数は Passport ではなく履歴から数えるため、Passport を作り直しても回数はリセットされません。履歴から回数を証明できない場合（前のタスクが履歴にない、連鎖が循環している）は、回数をゼロとはみなさず、引き継ぎを拒否します。v0.3 より前の設定ファイルには `maxHandoffs` がありません。その場合は旧 `maxDepth` の値から始まり、v0.2.1 より緩くなることはありません。

**v0.2 の制限：**
- 検証は、選んだ検査の強さまでしか保証しません。検査がなければ、成功した実行は PASS ではなく UNVERIFIED か NOT_RUN になります。
- ワークスペースのスナップショットは、作業フォルダだけでなくワークスペース全体を対象にします（最大 20,000 件、各 256 MiB まで）。リンクとジャンクションは記録しますが辿りません。除外フォルダ（`node_modules`、`.git`、`.serena`、`data`、`dist`、`dist-package`）、大きすぎるファイル、読めない項目、件数の上限は「検査できなかった範囲（gap）」として報告します。gap が 1 つでもあれば scope チェックは `PASS` ではなく `UNVERIFIED` になるため、`.git` や `node_modules` があるワークスペースでは scope が `PASS` になりません。read-only 設定は「変更なし」の証拠とは見なしません。scope の指定があれば read-only の実行も測定します。
- 変更可能ファイルの一覧は、実行後に検出するもので、防止はしません。
- 検証の順序は次のとおりです。すべての検証コマンドを 1 回ずつ実行し、終了を待ちます。次に最終のワークスペース・スナップショットを取り、Agent 実行前の基準と比べてスコープを検査します。最後に、ファイル・ハッシュ・JSON の検査を同じ最終状態に対して行います。スナップショット後に変わったファイルの結果は UNVERIFIED です。最終スナップショットが取れなかった場合は、ファイル・ハッシュ・JSON の検査も UNVERIFIED になります。失敗・起動できなかったコマンドも同じ方法で測定します。
- スナップショットが示せることと示せないことです。定義されたワークスペースを、観測時点の間で比較します。書き込みを防止するものではありません。ワークスペースの外への書き込み、次の観測までに完全に元へ戻された変更、最終検査の後も書き続ける別プロセスについては保証しません。スナップショットに見えたワークスペース内の変更は報告しますが、それが意図的だったかは判定しません。
- 検証コマンドは、そのスクリプトと同じだけしか独立していません。Agent がスクリプトを編集できる場合（例えば許可ファイルの中にある場合）、そのコマンドの成功は独立した検証証拠ではありません。スクリプトが検査を通すために編集されたかは判定できません。検証スクリプトは Agent の許可ファイルの外に置き、変更があれば利用者ご自身で確認してください。
- Codex や Claude Code 内部のセッション再開は使いません。引き継ぎは要約を渡して新しく実行します。
- 自動引き継ぎは未実装です。

## 引き継ぎ経路：実装済みは検証済みではない

引き継ぎは利用者が起動したときだけ動きます（`ornelyon handoff`、または確認チェック付きの GUI ボタン）。**自動引き継ぎは未実装です。** コードは 3 種類のエージェントを、引き継ぎ元にも引き継ぎ先にも指定できるため、下の 9 通りの経路がすべて存在します。次の 4 つは別のことなので、分けて書きます。

1. **コード上の実装：** 9 通りすべて、読み取り専用。
2. **オフラインテスト（偽 Agent とローカルの偽モデル、有料呼び出しなし）：** 代表的な経路のみ。引き継ぎ先が Codex、Claude Code、ローカルモデルの場合の開始と、各引き継ぎ先の拒否条件をテストしています。9 通りの組み合わせを 1 つずつ最後まで実行しているわけでは **ありません**。
3. **実 Agent での検証：** Claude Code から Claude Code のみ（下記）。
4. **未検証：** 残り 8 通り、Codex を含むすべての引き継ぎ、異種 Agent 間のすべての引き継ぎ、ローカル LLM を含むすべての引き継ぎ、ファイル編集を伴う引き継ぎ。

| 引き継ぎ元 | 引き継ぎ先 | 区分 | コード上の対応 | 実 Agent での検証 |
| --- | --- | --- | --- | --- |
| Claude Code | Claude Code | 同種 | 読み取り専用 | **成功**：v0.3.0 と v0.3.1、および v0.4.2 のビルド（2026-11-02）で再度 |
| Claude Code | Codex | 異種 | 読み取り専用 | NOT_TESTED |
| Claude Code | ローカル LLM | 異種 | 読み取り専用 | NOT_TESTED |
| Codex | Claude Code | 異種 | 読み取り専用 | NOT_TESTED |
| Codex | Codex | 同種 | 読み取り専用 | NOT_TESTED |
| Codex | ローカル LLM | 異種 | 読み取り専用 | NOT_TESTED |
| ローカル LLM | Claude Code | 異種 | 読み取り専用 | NOT_TESTED |
| ローカル LLM | Codex | 異種 | 読み取り専用 | NOT_TESTED |
| ローカル LLM | ローカル LLM | 同種 | 読み取り専用 | NOT_TESTED |

- **実際の実行の内容。** 隔離したフォルダー内の小さな作業用ファイルに対する読み取り専用タスクで、Claude Code のサブスクリプションのサインインを使い、API キーは使っていません（[IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md) の 13、15、18 節）。v0.3.0 と v0.3.1 で実行し、v0.4.0 と v0.4.1 では繰り返しておらず、v0.4.2 でタスク 1 回と引き継ぎ 1 回（計 2 回、どちらも成功）を繰り返しました。**Codex は呼んでいません。** 次の Agent の回答だけを証拠とはしません。証拠は、ORNELYON のファイルハッシュ検査と、送ったテキストのハッシュです。
- **引き継ぎは読み取り専用です。** 引き継ぎ先は常に読み取り専用で動きます。ファイル編集を伴う引き継ぎは **非対応** です。これは通常のタスク実行（`ornelyon run`）とは別です。通常のタスクは、選んだサンドボックスによってワークスペースのファイルを編集できます。
- **同種と異種で同じ検査を使います。** コードは両者を区別しません。異種 Agent 間は、偽 Agent でしか試していません。
- **Agent を起動する前に確認する条件**（1 つでも満たさなければ、何も起動しません）：
  - 引き継ぎ先がエージェント設定で **有効** であること。
  - 確認した時点で引き継ぎ先が **利用可能** であること（直近の確認が再利用されることがあります）。Codex CLI と Claude Code CLI では、プログラムが見つかり、バージョン確認コマンドが動き、ログイン状態の確認コマンドがサインイン済みを返すことを指します。**ローカル LLM** では、設定した URL の `GET /models` が HTTP 500 未満で応答することだけを指します。**API キーが不要** なローカルサーバーでも利用可能です。`apiKeyEnv` を設定しない限り、キーは要りません。サーバーが応答しない場合や、`/models` が HTTP 500 以上で応答した場合は、利用不可になります。拒否された API キー（例：HTTP 401）、存在しないモデル名、その後のチャット要求でのエラーは、この確認では **見つかりません**。
  - **能力（capability）の検査。** Passport にタスクの種類が記録されている場合（例：`--kind code`）だけ行います。引き継ぎ先がその種類を capabilities に宣言している必要があります。**種類が記録されていない** Passport（`--kind` なしで始めたタスク、または v0.2.1 より前の Passport）では、この検査を行いません。
  - 引き継ぎ回数が履歴から証明でき、`multiAi.maxHandoffs` 以内であること。
  - 引き継ぎ先の日次予算を使い切っていないこと（予算を設定している場合）。
  - Passport の保存後にファイルが変わっていないこと（変わっている場合は `--accept-current-state` が必要）。
- **Agent を動かして初めて分かること：** 確認の後に切れたサインイン、拒否されたローカルの API キー、存在しないモデル、チャット要求でのサーバーエラー、タイムアウト、Agent CLI 自身のエラー、サンドボックスの問題（以前の確認では、作者の Windows 環境で Codex がこれにより動きませんでした）。この場合は失敗として記録し、引き継ぎ成功とは扱いません。
- **サブスクリプションのサインイン。** Codex CLI や Claude Code CLI を、サブスクリプションのサインインで ORNELYON が自動実行してよいかは **NOT CONFIRMED** です（[アカウント・課金・各社の利用規約](#アカウント課金各社の利用規約) を参照）。1 回実行できたことで、この状態は変わりません。
- **Gemini CLI は未実装** で、引き継ぎ元にも引き継ぎ先にもなりません。

## 引き継ぎが運ぶ内容（v0.3.1）

引き継ぎでは、ORNELYON が履歴と Passport から **Handoff Context** を作って次のエージェントに渡します。作成にモデル呼び出しは使いません。構成は 9 項目です：元の目的、現在の目的、前のエージェント、前のエージェントの報告、検証済みの証拠、未解決事項、次の作業、制約、あなたの指示。

- **報告は「主張」であり証明ではありません。** 「信頼できないデータ」と明示した枠の中に入れ、各行に印を付けるため、見出しや枠の終端を装えません。権限・サンドボックス・予算・上限は常に設定ファイルで決まり、報告や指示の文面では変わりません。
- **ORNELYON が消したものは明示されます。** ワークスペース内のパスは `./相対` に、外部のパスと秘密情報らしき値は置換、v0.4.1 からは **メールアドレスも `[email-removed]` に置換** します。件数をコンテキストに書くので、マーカーを前の Agent の記述と取り違えません。あなた自身の指示は、パス書き換えもメール置換もしません（あなたが選んだ文面のため）。秘密情報だけは伏せます。
- **証拠は別扱いです。** 前のタスクに対する ORNELYON 自身の検査結果を、Passport 保存時のファイルハッシュと現在のハッシュと並べて表示します。前のタスクの Verification PASS は引き継がれません。新しいタスクは NOT_RUN から始まり、新しいタスクへの検査だけがそれを変えます。
- **元の目的は A → B → C でも保持されます。** 「Handoff from task ...」という管理行は目的として扱いません。
- **欠落は補わず、明示します。** v0.3.1 より前の Passport には報告の写しがないため、履歴から読み、その旨をコンテキストに書きます。報告がない、履歴と食い違う、ハッシュがない場合も、コンテキストと警告に明記します。
- **サイズには上限があります。** `multiAi.handoffContextMaxChars`（既定 6000、1000〜20000）。長い報告は切り詰め、その事実を明記します。必須部分だけで上限を超える場合は、エージェント起動前に拒否します。
- **送った内容は記録されます。** タスク記録に送信テキストそのもの、summary 記録に長さ・sha256・元の記録・指示・切り詰めや欠落を残します。

```bash
node dist/interface/cli.js handoff <task-id> --to claude --preview --instruction "報告とファイルを照合して"   # 送信内容をそのまま表示（何も起動しない）
node dist/interface/cli.js handoff <task-id> --to claude --instruction "報告とファイルを照合して"            # 実行
```

API：`POST /api/handoffs/preview`（`/api/handoffs` と同じ項目、`confirm` 不要、何も起動しない）と、`POST /api/handoffs` の `instruction`（1000 文字まで）。

## MCP Server Lite（v0.4、任意、読み取り専用。v0.4.1 で公開範囲を追加）

`ornelyon mcp` は、MCP 対応の他ツール（Claude Code、Codex、エディタ等）が ORNELYON に問い合わせるための **stdio** サーバーです。独立した入口で、使わなくても ORNELYON は同じように動きます。実行時の依存は増えません。

| ツール | 答える内容 |
| --- | --- |
| `ornelyon_status` | Agent の有効・導入・ログイン状態、主要設定と上限 |
| `ornelyon_recent_tasks` | **公開範囲内** のタスクの Agent・種類・Execution / Verification / Acceptance（プロンプト・出力は含まない） |
| `ornelyon_dispatch_preview` | Smart Dispatch の判断（`run --dry-run`、`POST /api/dispatch/plan` と同じ関数） |
| `ornelyon_evidence` | 範囲内の 1 タスクの Evidence Gate 結果（検査ごと） |
| `ornelyon_passport` | 範囲内の 1 タスクの Passport と、各 Agent への引き継ぎが何になるか |
| `ornelyon_handoff_preview` | 引き継ぎコンテキストのサイズ・ハッシュ・報告の状態・ファイル状態。本文はコンテンツモードのときだけ |

**できないこと：** Agent の起動、引き継ぎの実行、accept / reject の記録、設定・履歴・Passport の変更。該当ツールは存在せず、パス・コマンド・設定・確認フラグを受け取るツールもなく、余分な引数は拒否されます。Codex のサンドボックスを回避する手段ではありません。

**誰が何を見られるか（v0.4.1）。** stdio サーバーを起動したプログラムは識別も認証もできません。そのため唯一のアクセス制御は **起動時に運用者が固定する公開範囲** です。ツール注釈（`readOnlyHint` など）はクライアント向けのヒントであり、データを守るものではありません。

| オプション | 効果 |
| --- | --- |
| （なし） | どのタスクも見えません。`ornelyon_status` と `ornelyon_dispatch_preview` は使えます。 |
| `--recent N` | サーバー起動時点の新しい N 件（1〜20）。以後のタスクは再起動まで見えません。 |
| `--allow-task <id>` | 指定したタスクだけ（複数指定可）。 |
| `--all-tasks` | 履歴の全タスク。`--expose-content` とは併用不可。 |
| `--expose-content` | 目的・報告・次の作業・承認理由・引き継ぎ本文を、**範囲内のタスクに限って** 追加します。 |
| `--tools a,b` | 指定したツールだけ提供します。 |

範囲外のタスクへの応答は、存在しないタスクと同じです。タスク ID は正確な UUID のみ受け付け、それ以外はファイルに触れる前に拒否します。壊れた Passport はツールエラーになります。履歴ファイルの読めない行は読み飛ばし、履歴を読む 4 つのツール（`ornelyon_recent_tasks`、`ornelyon_evidence`、`ornelyon_passport`、`ornelyon_handoff_preview`）は、回答に `historyComplete: false`、`skippedHistoryLines` と警告を加えます。そのような回答は、記録が欠けている可能性があるものとして扱ってください。サーバーは設定を書き込まずに読むため、壊れた `config.json` が質問のたびにコピー・バックアップされることはありません。

**クリーニング。** 返すものは、引き継ぎと同じクリーナーを通ります：ワークスペース内のパスは `./相対`、外部のパス・秘密情報らしき値・**メールアドレス**（`[email-removed]`）は置換、長い文字列は切り詰め。報告は「Agent が書いたデータ」と明示します。パターン方式は機密が残らないことを証明できないため、公開範囲は狭くしてください。

**登録はあなたが行います。** ORNELYON はクライアントの設定を書き換えません：

```bash
node dist/interface/cli.js mcp --print-config                      # claude / codex / mcp.json 形式を表示（既定の範囲は --recent 5）
node dist/interface/cli.js mcp --print-config --allow-task <id>    # 指定タスクのみ
```

**プロトコル。** stdio 上で MCP 2025-11-25・2025-06-18・2025-03-26・2024-11-05 に対応します（独自の小さな処理で、公式 TypeScript SDK のクライアントで確認）。**2026-07-28 版には未対応** です（`server/discover` なし。この版は `initialize` を廃止）。両世代に対応するクライアントは、`server/discover` が「method not found」で返ると `initialize` にフォールバックします（このサーバーはそう返します）。2026-07-28 のみのクライアントは利用できません。

**v0.4.0 からの移行：** v0.4.0 の登録には範囲指定がなかったため、v0.4.1 では **どのタスクも見えません**。`--recent N` または `--allow-task` を付けて登録し直してください。コンテンツモードも範囲指定が必要になり、`--all-tasks` とは併用できません。

ツール定義は呼び出し側 Agent のコンテキストに入ります（短い 6 件、約 850 トークン）。ツール呼び出しでモデルは起動しません。


**ネイティブGUI連携(v0.5.0 Phase 0)。** `--print-config` は Codex の `config.toml` 用ブロック(Codexアプリ・IDE拡張・CLIで共通)と Claude デスクトップ Code タブ向けの案内も出力します。`node dist/interface/cli.js mcp --self-test` はクライアントと同じ方法でサーバーを起動して PASS/FAIL を報告します(モデル呼び出しなし)。GUIからの実接続は引き続き NOT_TESTED です。手順・確認結果・制約: [docs/NATIVE_GUI_INTEGRATION.md](docs/NATIVE_GUI_INTEGRATION.md)(英語)。
## Efficiency Benchmark（v0.4）

`ornelyon benchmark` は **履歴** から測定します。Agent は呼ばず、何も書き込みません。

```bash
node dist/interface/cli.js benchmark --by shape        # single / multi（レビュー・フォールバック追加）/ handoff
node dist/interface/cli.js benchmark --by agent --kind code --hours 168
node dist/interface/cli.js benchmark compare --a "shape=single" --b "shape=multi"
node dist/interface/cli.js benchmark synth --out synthetic.jsonl   # 測定コード確認用の合成データ
node dist/interface/cli.js benchmark --history synthetic.jsonl --by shape
```

- **タスク単位：** 呼び出し数（追加呼び出し）、Execution / Verification / Acceptance、Agent 時間、トークン、報告された費用、成功 1 件あたりの費用、追加呼び出しの費用。
- **報告値のみ・推測しない：** トークンと費用は各 Agent の報告値です。未報告の呼び出しを含むタスクはその項目が不明となり、平均から除外し、数えた件数と除外件数を表示します。プロバイダーごとにトークンの数え方が違うため、Agent が異なる場合は警告します。
- **二重計上なし：** 数えるのは Agent 呼び出しだけです。summary / decision は呼び出しではなく、ファイル内で重複した呼び出し記録は除外して件数を表示します。
- **比較は違いを明示：** 履歴のタスクは条件を揃えて選ばれていません。`compare` は種類・最終 Agent・重複・件数の違いを列挙し、最初のプロンプトが同一の依頼を対にし、条件が揃わなければ「NOT a like-for-like comparison」と表示します。揃っても観察データであり、対照実験ではありません。
- **偽データは明示：** fake / test / synthetic の呼び出しは数えて警告します。その数値は測定コードの確認用です。
- **呼び出しの由来（v0.4.1）：** ORNELYON が構築したアダプターから各呼び出し記録に `origin` を書きます。`cli`（Codex / Claude Code コマンド）と `local-endpoint` は実利用、`fake-adapter` と `test-command`（テスト用コマンドを指す実アダプター）は実利用ではありません。origin のない記録（v0.4.1 より前の全履歴）は **不明** として扱い、実とも偽とも見なしません。全タスクに実の origin が記録されているときだけ like-for-like と表示し、違う条件（種類・最終 Agent・shape・重複・件数・origin）を列挙します。
- **再現可能：** 同じ履歴なら同じ出力と同じ `data sha256` になります。

単一 Agent と ORNELYON 経由の実際の比較には、同じ依頼を実 Agent で両方式実行する必要があります。これは別途承認を得て行う方針です。

## v0.3 の GUI（任意）

以下はすべて CLI と HTTP API でも使えます。GUI は同じ結果を表示するだけです。

- **Agents → Smart Dispatch**：有効・無効、重要な種類（critical kinds）の設定と、判断のプレビュー（ルーティング方針、選ばれたエージェント、判断、理由、追加のエージェント呼び出しが必要かどうか）。プレビューは何も起動しません。判断は `run --dry-run` と同じ Core のルールが行います。
- **Runs → Passport**：タスクを展開すると、エージェント、状態、検証結果、未解決事項、次の作業、引き継ぎ履歴を表示します。Passport が未保存なら **Save passport** ボタンが出ます。
- **手動の引き継ぎ**（同じパネル内）：対象を選び（許可される最初の対象が選択済み。拒否される対象は理由を表示）、確認にチェックして **Hand off now** を押します。確認なしでは何も起動しません。サーバーも `"confirm": true` のない要求を拒否します。

API：`POST /api/handoffs`（`fromGroupId`、`to`、`confirm: true`、任意で `acceptCurrentState`、`timeoutSec`）、`GET /api/passports/<id>`（引き継ぎの概要を含む）、`POST /api/dispatch/plan`。

### GUI なしで使う

```bash
node dist/interface/cli.js run "..." --agent claude      # 1 件のタスク
node dist/interface/cli.js passport save <task-id>
node dist/interface/cli.js passport show <task-id>       # 引き継ぎ回数と上限も表示
node dist/interface/cli.js handoff <task-id> --to codex  # 手動の引き継ぎ
node dist/interface/cli.js run "..." --dry-run           # 実行計画を表示（何も起動しない）
```

## 名称と互換性

ORNELYON はこのプロジェクトの名称で、どの会社の製品名でもありません。「CHIMERA Harness」「NEXORA Harness」は旧名称です。

- 既存の `config.json` と `history.jsonl` はそのまま読み込めます。v0.2 の項目は任意で、既定ではすべて無効です。
- `CHIMERA_HOME` は引き続き使えます。`ORNELYON_HOME` は同じ設定の新しい名前です。
- `start-chimera.bat` と `start-chimera.sh` も使えます。どちらも ORNELYON を起動します。
- `chimera` コマンドは `ornelyon` の別名です。

## オプションの外部コンポーネント（ORNELYON は自動導入しません）

- **Microsoft TokenEconomizer**（Claude Code と Codex 用のプラグイン。https://github.com/microsoft/TokenEconomizer）。ORNELYON はエージェントの設定にプラグイン名があるかだけを読み、**Setup** 画面に状態とエージェントのバージョンを表示します。インストールや設定変更はしません。プラグインは各エージェントのセッション内で動きます。ORNELYON のループ検出とツール休眠はタスク間で働き、別物です。対応バージョンは上流の wiki に基づく二次情報なので、ご自身で確認してください。
- **Google Harness²**（https://github.com/google-research/harness2）。Linux、Python 3.12、uv が必要です。ORNELYON はこれらの有無を表示するだけで、Harness² はまだ実行しません。Research コマンドは ORNELYON 独自の小さな実験で、Harness² ではありません。

## 開発

```bash
npm install
npm test          # ビルドとオフラインテスト（有料APIは呼びません）
npm run package   # dist-package/ORNELYON-0.4.2.zip を作成
```

実行時の依存パッケージはありません。開発時の依存は TypeScript、Node の型定義、公式 MCP TypeScript SDK（テストでクライアントとして 1 件使用。ZIP には不要）です。

## ドキュメント

- [README.md](README.md)：English version
- [ARCHITECTURE.md](ARCHITECTURE.md)：層構成、データファイル、アダプタの契約
- [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md)：実装内容、確認内容、未確認の内容
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：ライセンスと参考プロジェクト
- [UNINSTALL.md](UNINSTALL.md)：削除方法
- [CONTRIBUTING.md](CONTRIBUTING.md)：貢献、フォーク、再配布について
- [SECURITY.md](SECURITY.md)：セキュリティ上の問題の報告方法

## アンインストール

ORNELYON はグローバルに何もインストールせず、サービスも登録しません。Ctrl+C で停止し、展開したフォルダを削除してください。設定と履歴は `data` フォルダにあるため、残したい場合は先にそのフォルダをコピーしてください。API キーやサインイン用トークンは保存しません。公式ツールからサインアウトするには `codex logout` または `claude auth logout` を使ってください。詳しくは [UNINSTALL.md](UNINSTALL.md) を参照してください。

## 問題の報告

https://github.com/amane3914/ORNELYON/issues で Issue を開いてください。次の情報を含めてください。

- バージョン（`ORNELYON-0.4.2`）、OS、Node.js のバージョン（`node --version`）；
- 実行したコマンドや GUI の操作と、期待した結果；
- `node dist/interface/cli.js doctor` の出力（公開したくないパスやアカウント情報は取り除く）；
- 結果に関する問題なら、タスク ID と `verdict <task-id>` の該当部分。

**API キー、サインイン用トークン、秘密情報を含む `config.json`、非公開のプロンプトやコードを含む履歴ファイルは投稿しないでください。** セキュリティ上の問題と思われる場合は [SECURITY.md](SECURITY.md) を読み、公開の Issue には書かないでください。

## 貢献

フォーク、改変、再配布は MIT ライセンスのもとで歓迎します。[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## ライセンス

MIT。[LICENSE](LICENSE) を参照してください。
