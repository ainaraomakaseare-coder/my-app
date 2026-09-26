/*
 * レシートのOCRテキスト（Cloud VisionのfullTextAnnotation.text。改行区切り）を、
 * 費用明細（品目名と金額）の配列に分けるルールベースの処理（docs/adr/0011）。
 * OpenAI（gpt-5.6-sol）に読み取らせていたときと同じ { items: [{label, amount}] } の形で返すため、
 * index.jsのscanReceipt・app.jsのhandleScanReceiptはどちらの経路でもそのまま使える。
 * 純粋関数として切り出しているので、Workers専用のグローバル（fetch等）を使わずnodeで単体テストできる
 * （test/receipt-parse.test.mjs）。
 */

// 品目ではない行（合計・税・お預り・お釣り・値引き・ポイント・支払方法・店の連絡先など）は除く。
// 実際のレシート数枚を見て、品目名に出てこなそうな語だけを選んだ（「カード」のように品目名に
// 混じりうる語は、行末に金額が無い単独行でしか誤って拾わない前提）。
const SKIP_LINE_RE = /(合計|小計|総計|内税|外税|消費税|税抜|税込|お預り|お預かり|預り|お釣り|釣銭|おつり|値引|割引|ポイント|point|pt|点数|クレジット|カード|現金|対象|支払|領収|レシート|ありがとう|tel|電話|no\.|№|登録番号|軽減税率|営業時間|定休日)/i;

// 行末の金額：¥1,234 / ￥1234 / 1,234円 / 1234円（全角数字はparseReceiptText側でNFKC正規化済み）
const PRICE_RE = /(?:[¥￥]\s*([0-9][0-9,]*))|(?:([0-9][0-9,]*)\s*円)\s*$/;

// 行から末尾の金額を取り出す。無ければnull。restは金額を取り除いた残り（品目名の候補）。
function extractPrice(line) {
  const m = PRICE_RE.exec(line);
  if (!m) return null;
  const digits = (m[1] || m[2] || "").replace(/,/g, "");
  if (!digits) return null;
  const amount = parseInt(digits, 10);
  if (!isFinite(amount) || amount < 0) return null;
  return { amount, rest: line.slice(0, m.index).trim() };
}

// text：Cloud VisionのfullTextAnnotation.text（1行1品目とは限らないレシートのOCR結果）。
// 「品目名だけの行」の次に「金額だけの行」が来るレシート（品目名が長くて折り返す機種）にも
// 対応するため、金額の無い行は次に金額が見つかるまで品目名の候補として持ち越す。
function parseReceiptText(text) {
  const lines = String(text || "")
    .normalize("NFKC") // 全角数字・全角記号を半角に揃える
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const items = [];
  let pendingName = "";

  for (const line of lines) {
    if (SKIP_LINE_RE.test(line)) {
      pendingName = ""; // 合計行などをはさんだら、直前の品目名らしき行はもう使わない
      continue;
    }
    const priced = extractPrice(line);
    if (priced) {
      const name = priced.rest || pendingName;
      if (name) items.push({ label: name, amount: priced.amount });
      pendingName = "";
    } else {
      pendingName = line;
    }
  }

  return { items };
}

export { parseReceiptText };
