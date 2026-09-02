// KPIテキストから頻度（毎日/曜日指定/週内回数/不明）を推論し、KVにキャッシュする。
// キーは kpiItemKey（担当者名+KPIテキストの内容ハッシュ）。テキストが変わらない限り
// 再推論しない（週替わりで表の行indexが変わってもキャッシュは有効なまま）。
import type { AppConfig } from "./config";
import { kpiItemKey } from "./kpiIdentity";
import { inferKpiCadence } from "./llmAnalyzer";
import type { KpiCadenceLlmResult } from "./schema";

export type KpiCadenceKind = "daily" | "weekdays" | "weekly_count" | "none";

export interface KpiCadence {
  kind: KpiCadenceKind;
  weekdays?: number[]; // 0=日..6=土 (JS Date.getDay() 準拠)
  countPerWeek?: number;
  countUnit?: string;
  confidence: "high" | "medium" | "low";
  rationale: string;
}

const CADENCE_KEY = (itemKey: string) => `kpi-cadence:${itemKey}`;

function fromLlmResult(r: KpiCadenceLlmResult): KpiCadence {
  return {
    kind: r.kind,
    weekdays: r.weekdays ?? undefined,
    countPerWeek: r.count_per_week ?? undefined,
    countUnit: r.count_unit ?? undefined,
    confidence: r.confidence,
    rationale: r.rationale
  };
}

/** KV から cadence を読む。無ければ null（推論はしない・呼び出し側で getOrInferCadence を使うこと）。 */
export async function getCachedCadence(kv: KVNamespace, itemKey: string): Promise<KpiCadence | null> {
  const raw = await kv.get(CADENCE_KEY(itemKey)).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as KpiCadence;
  } catch {
    return null;
  }
}

/** KV になければ LLM 推論して保存する。TTL なし（KPIテキストが変われば別キーになるため無効化は不要）。 */
export async function getOrInferCadence(
  config: AppConfig,
  kv: KVNamespace,
  member: string,
  kpiText: string,
  skillCategory?: string | null
): Promise<{ itemKey: string; cadence: KpiCadence }> {
  const itemKey = await kpiItemKey(member, kpiText);
  const cached = await getCachedCadence(kv, itemKey);
  if (cached) return { itemKey, cadence: cached };

  const inferred = await inferKpiCadence(config, member, kpiText, skillCategory);
  const cadence = fromLlmResult(inferred);
  await kv.put(CADENCE_KEY(itemKey), JSON.stringify(cadence));
  return { itemKey, cadence };
}
