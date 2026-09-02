// KPI項目の安定識別子。週ごとに表の行indexが変わっても同一KPIを追跡できるよう、
// 行indexではなく「担当者名 + KPIテキスト」の内容ハッシュをキーにする。

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeKpiText(kpiText: string): string {
  return kpiText.trim().normalize("NFKC").replace(/\s+/g, " ");
}

/** 担当者名+KPIテキストから安定した識別子を作る（cadenceキャッシュ・長期記憶・週またぎのストリーク照合で共通利用）。 */
export async function kpiItemKey(member: string, kpiText: string): Promise<string> {
  const raw = `${member.trim()}::${normalizeKpiText(kpiText)}`;
  const hex = await sha256Hex(raw);
  return hex.slice(0, 20);
}
