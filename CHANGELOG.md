# Changelog / 変更履歴

このファイルは「目に見える挙動が変わった修正」を新しい順にまとめます。
細かい履歴は `git log` を参照（[GitHub commits](https://github.com/baadee55/ai-coding-hub/commits/main)）。

## Unreleased

### Fixed
- **watchdog: スマホで 502 になる不具合を修正** — watchdog が IPv4 `127.0.0.1` だけで
  listen していたため、`localhost` を IPv6 `::1` で解決する環境（多くの cloudflared/ブラウザ）
  でループバックに繋がらず、トンネルが 502 を返していた。IPv4(`127.0.0.1`) と IPv6(`::1`) の
  **両ループバックで listen** するよう変更し、Cloudflare 側の設定を変えずに解消。公開IF
  (`0.0.0.0`/`::`) には出さないのでセキュリティモデル（loopback-only + `cf-connecting-ip`
  でのリモート判定）は不変。IPv6 無効環境では IPv4 のみで自動フォールバック。
  詳細: [docs/CONFIGURATION.md#6-トラブルシュート](docs/CONFIGURATION.md)。
