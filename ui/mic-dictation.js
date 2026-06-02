// ===== 音声入力（日本語）のコアロジック =====
// app.js の本番ロジックのミラー（Node 単体テスト用）。本番（ui/app.js の音声入力部）と
// 同じ振る舞いをここで純関数として切り出し、ブラウザなしで検証する。
//
// 設計（過去の重複バグ「ゆっくり話すと重複」「続けると大量重複」を断つ）:
//   状態は base / final / interim の3つ。表示は常に base + final + interim。
//   - base    : 録音開始時点の入力欄テキスト（録音中は不変）
//   - final   : この録音で確定した語の連結（確定するたびに追記）
//   - interim : 喋っている途中の暫定（確定で必ず置き換わる）
//   onresult では resultIndex 以降だけを見て、isFinal セルを final に追記、未確定を
//   interim にする。results 全体を毎回足し直さないので二重化しない。
//   onend では base / final を一切いじらない（焼き戻しが過去の重複の元凶だった）。

(function () {
  function createDictation(initialText) {
    const base = (initialText || "").trim();
    return { base: base, final: "", interim: "" };
  }

  // 2つの文字列を必要なときだけ空白1つでつなぐ（二重空白は作らない）。
  function joinWithSep(base, add) {
    if (!base) return add;
    if (!add) return base;
    return /\s$/.test(base) || /^\s/.test(add) ? base + add : base + " " + add;
  }

  // SpeechRecognition の onresult 相当。
  //   resultIndex: 今回新しく届いた最初のセル位置
  //   results: [{ isFinal, transcript }, ...]（セッション先頭からの全セル）
  // resultIndex 以降のみ処理し、確定は final に追記・未確定は interim に。
  function applyResult(state, resultIndex, results) {
    let interim = "";
    for (let i = resultIndex; i < results.length; i++) {
      const seg = results[i].transcript;
      if (results[i].isFinal) state.final = joinWithSep(state.final, seg.trim());
      else interim += seg;
    }
    state.interim = interim;
    return render(state);
  }

  // 録音停止時（ユーザー停止 / onend いずれも）。未確定 interim は破棄、確定は残す。
  // base / final はいじらない（押し直しで続けられるよう確定を保持）。
  function finalize(state) {
    state.interim = "";
    return render(state);
  }

  function render(state) {
    return joinWithSep(joinWithSep(state.base, state.final), state.interim.trim());
  }

  const api = { createDictation, applyResult, finalize, render, joinWithSep };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof window !== "undefined") {
    window.MicDictation = api;
  }
})();
