#!/usr/bin/env python3
"""公開前シークレット/個人情報スキャナ。

pre-push フックから呼ばれ、push されるツリーに秘密や個人情報が無いか検査する。
1件でも見つかれば exit 1 で push を止める（＝ミスしても物理的に公開されない）。

使い方:
  python scripts/secret-scan.py [<commit-sha>]
    引数あり: その commit のツリーを検査（pre-push が push 先の sha を渡す）
    引数なし: 現在追跡中のファイル（git ls-files）を検査

外部依存なし。Python だけで動く。
"""
import re
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# このスキャナ自身（パターン文字列を含む）と、明らかに安全なものはスキャン対象外。
SKIP_FILES = {
    "scripts/secret-scan.py",
}
SKIP_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".exe", ".pdf",
            ".woff", ".woff2", ".ttf", ".otf", ".mp4", ".zip", ".gz")

# ===== 検出ルール =====（name, 正規表現, 説明）
RULES = [
    # --- このプロジェクト固有：絶対に公開してはいけない個人情報 ---
    ("personal-domain", r"laovisa", "個人ドメイン r.laovisa.net"),
    ("personal-email", r"kledg3", "個人メール kledg3"),
    ("work-handle", r"cnpstorys", "他案件名義 cnpstorys"),
    ("personal-path", r"Users[\\/]+testa", "個人PCパス C:\\Users\\testa"),
    # --- 認証トークン/秘密（値付き代入のみ。空の .env.example は通す） ---
    # 値が行末で終わるもの（.env行 や "..." 代入）だけ検出。関数呼び出し(foo())や
    # os.getenv("KEY") のようなコード参照は行末でないので誤検知しない。
    ("env-secret", r"(AGENT_TOKEN|CLOUDFLARE_TUNNEL_TOKEN|CF_TOKEN|ANTHROPIC_API_KEY|JWT_SECRET|CLOUDFLARE_GLOBAL_API_KEY|CLOUDFLARE_EMAIL)\s*[:=]\s*['\"]?[A-Za-z0-9_\-./+=]{12,}['\"]?\s*$",
     ".env の実トークン/キー値"),
    # --- 一般的なシークレット形式 ---
    ("pem-key", r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "PEM 秘密鍵"),
    ("github-token", r"\b(ghp|gho|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b", "GitHub トークン"),
    ("openai-key", r"\bsk-[A-Za-z0-9]{20,}\b|\bsk_live_[A-Za-z0-9]{20,}\b", "OpenAI/Stripe 系キー"),
    ("aws-key", r"\bAKIA[0-9A-Z]{16}\b", "AWS アクセスキー"),
    ("google-key", r"\bAIza[0-9A-Za-z_\-]{35}\b", "Google API キー"),
    ("slack-token", r"\bxox[baprs]-[A-Za-z0-9-]{10,}", "Slack トークン"),
    ("jwt", r"\beyJ[A-Za-z0-9_=\-]{10,}\.eyJ[A-Za-z0-9_=\-]{10,}\.[A-Za-z0-9_=\-]{6,}", "JWT トークン"),
    # --- 暗号通貨の「秘密鍵」（公開アドレスは40hex/base58で対象外。64hexは秘密鍵の疑い） ---
    ("crypto-privkey", r"\b(0x)?[0-9a-fA-F]{64}\b", "暗号通貨の秘密鍵らしき 64桁hex"),
    ("mnemonic", r"\b(mnemonic|seed[\s_-]?phrase|recovery[\s_-]?phrase)\b\s*[:=]", "ニーモニック/シードフレーズ"),
]

# メール PII（正規/プレースホルダは除外）
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
EMAIL_OK = re.compile(r"(example\.|noreply|users\.noreply|your[\-.]|@example|@domain|@mail\.com\b|name@)", re.I)

# 実 IP（ローカル/プレースホルダ除外）
IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
IP_OK = {"127.0.0.1", "0.0.0.0", "1.2.3.4", "255.255.255.255", "8.8.8.8", "192.168.1.1"}

# ツリーに存在してはいけないファイル（万一 add されても push を止める）
FORBIDDEN_FILES = [
    re.compile(r"(^|/)\.env$"),
    re.compile(r"(^|/)config\.json$"),
    re.compile(r"\.pem$"), re.compile(r"\.jwt$"),
    re.compile(r"-qr\.png$"),
    re.compile(r"(^|/)tax[-_].*\.pdf$"),
    re.compile(r"credentials\.json$"),
]

# 64hex 誤検知を減らすため、明らかに無害な文脈（integrity ハッシュ等）は対象外にしたいが
# 安全側に倒して検出する。ただし行に "sha512-" や "integrity" があれば 64hex はスキップ。
HEX64_CONTEXT_OK = re.compile(r"integrity|sha512-|sha384-|sha256-|cache|hash", re.I)


def tracked_files(sha):
    if sha:
        out = subprocess.run(["git", "ls-tree", "-r", "--name-only", sha],
                             capture_output=True, text=True)
    else:
        out = subprocess.run(["git", "ls-files"], capture_output=True, text=True)
    return [f for f in out.stdout.splitlines() if f.strip()]


def read_blob(sha, path):
    ref = f"{sha}:{path}" if sha else path
    try:
        if sha:
            r = subprocess.run(["git", "show", ref], capture_output=True)
            data = r.stdout
        else:
            with open(path, "rb") as fh:
                data = fh.read()
    except Exception:
        return None
    if b"\x00" in data[:8000]:
        return None  # バイナリ
    try:
        return data.decode("utf-8", errors="replace")
    except Exception:
        return None


def scan_text(path, text):
    findings = []
    for i, line in enumerate(text.splitlines(), 1):
        for name, pat, desc in RULES:
            if name == "crypto-privkey" and HEX64_CONTEXT_OK.search(line):
                continue
            if re.search(pat, line):
                findings.append((i, name, desc, line.strip()[:80]))
        # email
        for m in EMAIL_RE.finditer(line):
            if not EMAIL_OK.search(m.group(0)):
                findings.append((i, "email-pii", "メールアドレス(PII)", m.group(0)))
        # ip
        for m in IP_RE.finditer(line):
            ip = m.group(0)
            if ip not in IP_OK and not ip.startswith(("10.", "192.168.", "172.16.")):
                findings.append((i, "ip", "実IPアドレスらしき値", ip))
    return findings


def main():
    sha = sys.argv[1] if len(sys.argv) > 1 else None
    files = tracked_files(sha)
    total = 0

    for path in files:
        # 禁止ファイル名チェック
        for fre in FORBIDDEN_FILES:
            if fre.search(path):
                print(f"  ❌ {path}: 公開禁止ファイルがツリーに含まれています")
                total += 1
        if path in SKIP_FILES or path.lower().endswith(SKIP_EXT):
            continue
        text = read_blob(sha, path)
        if text is None:
            continue
        for ln, name, desc, snippet in scan_text(path, text):
            print(f"  ❌ {path}:{ln} [{name}] {desc}")
            print(f"        > {snippet}")
            total += 1

    if total:
        print(f"\n  検出 {total} 件。これらが公開リポに出ようとしています。")
        return 1
    print("  ✅ secret-scan: 問題なし（秘密/個人情報の検出ゼロ）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
