/*
 * 旅行の公開範囲・フォローの決まりごとだけを扱う純粋関数（docs/adr/0010）。
 * Workers専用のグローバルを使わないので、nodeでそのまま単体テストできる（worker/test/visibility.test.mjs）。
 * 同じ規則のクライアント側のコピーは app.js の Core（canViewByVisibility・nextFollowStatus など）。
 * 食い違わないよう、直すときは両方（とテスト）を直すこと。
 */

export const VISIBILITIES = ["members", "close_friends", "followers", "public"];
export const BIO_MAX = 160;
export const NAME_MAX = 40;

// 知らない値・壊れた値は、いちばん狭い「一緒に行った人だけ」に倒す（勝手に公開されないように）
export function normalizeVisibility(v) {
  return VISIBILITIES.includes(v) ? v : "members";
}

/*
 * 公開の画面（?p=）を、この人が見てよいか。
 *   isOwner        … 見る人が旅行の持ち主
 *   isFollower     … 見る人が持ち主の承認済みフォロワー
 *   isCloseFriend  … 見る人が持ち主の親しい友人リストにいる
 *   blockedByOwner … 持ち主が見る人をブロックしている
 *   blockedByViewer… 見る人が持ち主をブロックしている
 * 持ち主は、どの範囲でも自分の旅行の公開画面を見られる（確認用）。
 * 「一緒に行った人だけ」は、公開の画面では誰にも見せない（一緒に行った人は招待リンクで見る・編集する）。
 * 持ち主にブロックされている人は、全体向け以外（フォロワー・親しい友人）は見られない（全体向けはログインしなくても
 * 見られるので、止めようがない）。見る人が持ち主をブロックしているときは、全体向けでも見せない（自分が隠した相手）。
 * 親しい友人⊂フォロワーなので、フォロワー向けは親しい友人にも見える。
 */
export function canViewByVisibility(o) {
  const visibility = normalizeVisibility(o.visibility);
  if (o.isOwner) return true;
  if (o.blockedByViewer) return false;
  if (visibility === "public") return true;
  if (o.blockedByOwner) return false;
  if (visibility === "followers") return !!(o.isFollower || o.isCloseFriend);
  if (visibility === "close_friends") return !!o.isCloseFriend;
  return false; // members（と知らない値）
}

/*
 * フォローの状態遷移。状態は 'none'（フォローしていない）｜'pending'（承認待ち）｜'approved'（フォロー中）。
 * 操作は follow（フォローする／申請する）｜unfollow（やめる／申請を取り消す）｜
 * approve（申請を承認）｜decline（申請を断る）｜remove（フォロワーから外す）。
 * 戻り値は次の状態。その状態からはできない操作なら null。同じ操作の繰り返しは害がないよう同じ状態を返す。
 */
export function nextFollowStatus(current, action, opts) {
  const cur = current === "pending" || current === "approved" ? current : "none";
  const targetPrivate = !!(opts && opts.targetPrivate);
  switch (action) {
    case "follow":
      if (cur !== "none") return cur;
      return targetPrivate ? "pending" : "approved";
    case "unfollow":
      return "none";
    case "approve":
      return cur === "none" ? null : "approved";
    case "decline":
      return cur === "approved" ? null : "none";
    case "remove":
      return cur === "pending" ? null : "none";
    default:
      return null;
  }
}

// 画面に出す関係の名前（クライアントのCore.followStateと同じ）
export function followStateLabel(status) {
  return status === "approved" ? "following" : status === "pending" ? "requested" : "none";
}

// アイコン用の写真ID（POST /photosが返す形）だけを許す。他人の旅行の写真IDなど任意の文字列は入れさせない
export function validAvatarId(id) {
  return id === "" || /^photo_[0-9a-f]{32}\.(jpg|png|webp)$/.test(id);
}

// 公開用ID（推測できない乱数。URLに載る）
export function newPublicId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return "pub_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function validPublicId(id) {
  return typeof id === "string" && /^pub_[0-9a-f]{32}$/.test(id);
}

function avg(nums) {
  return nums.length ? Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 10) / 10 : null;
}

/*
 * 公開の画面に返す旅行を作る。**許可リスト方式**：ここに書いた項目だけが外へ出る
 * （あとから列が増えても、勝手に漏れない）。入力は getTrip と同じ形（rowToTrip／rowToBlock／rowToEntry／rowToDayInfo）。
 *
 * 出さないもの（理由）：
 *  - trip.id・block.id・entry.id・rating.id：旅行のURL（trip.id）は編集できる招待リンクそのもの。予定・記録のidも、
 *    PATCH/DELETE /blocks/:id・/entries/:id の編集の鍵になる。公開の画面では表示用の通し番号しか返さない
 *  - 費用・精算（costItems・settleUnit・移動の金額 travel.amount）：一緒に行った人だけのもの
 *  - 一緒に行った人の名前（companions のゲスト参加者・members・entry.author・rating の名前／メール）
 *  - 評価のレビュー本文（個人の評価。名前・メールと結びつく）。平均点と件数だけ返す
 *  - 日ごとの音声の文字起こし（voiceTranscript）・座標（lat/lon）・取得時刻
 *  - 自分だけの道（別行動）の予定・記録と、その分岐そのもの（誰がいつ別行動したかが分かるため。みんなの予定だけ出す）
 *  - 作成・更新時刻
 */
export function stripTripForPublic({ trip, blocks, days, publicId }) {
  const sharedBlocks = (blocks || []).filter((b) => !b.branchId);
  return {
    trip: {
      publicId,
      title: trip.title,
      startDate: trip.startDate,
      endDate: trip.endDate,
      tripType: trip.tripType || "",
      coverPhotoId: trip.coverPhotoId || "",
    },
    blocks: sharedBlocks.map((b, i) => ({
      n: i,
      date: b.date,
      time: b.time,
      label: b.label,
      category: b.category,
      transport: b.transport || "",
      moveMinutes: b.moveMinutes || 0,
      manualOrder: typeof b.manualOrder === "number" ? b.manualOrder : null,
      entries: (b.entries || []).map((e) => {
        const scores = (e.ratings || []).map((r) => Number(r.score)).filter((n) => Number.isFinite(n));
        const out = {
          episode: e.episode || "",
          comment: e.comment || "",
          detail: e.detail || "",
          photoIds: e.photoIds || [],
          videoIds: e.videoIds || [],
          waitTime: e.waitTime || "",
          time: e.time || "",
          mapUrl: e.mapUrl || "",
          shopUrl: e.shopUrl || "",
          otherUrl: e.otherUrl || "",
          travel: publicTravel(e.travel),
          ratingAvg: avg(scores),
          ratingCount: scores.length,
        };
        if (typeof e.mapLat === "number" && typeof e.mapLng === "number") {
          out.mapLat = e.mapLat;
          out.mapLng = e.mapLng;
          if (e.mapPlaceName) out.mapPlaceName = e.mapPlaceName;
        }
        return out;
      }),
    })),
    days: (days || []).map((d) => ({
      date: d.date,
      place: d.place || "",
      admin1: d.admin1 || "",
      country: d.country || "",
      weatherCode: d.weatherCode,
      tempMax: d.tempMax,
      tempMin: d.tempMin,
      precipSum: d.precipSum,
      isForecast: !!d.isForecast,
    })),
  };
}

// 移動の情報から、金額（amount）だけを除く
function publicTravel(t) {
  if (!t || typeof t !== "object") return {};
  const out = {};
  for (const k of ["from", "to", "company", "depart", "arrive", "arriveMapUrl", "arriveLat", "arriveLng"]) {
    if (t[k] !== undefined && t[k] !== "") out[k] = t[k];
  }
  return out;
}
