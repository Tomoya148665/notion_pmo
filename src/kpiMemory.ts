// KPIごとの「いつやると言ったか」「なぜできなかったか」をスプリントをまたいで本人ごとに記憶する
// 長期ストア。KV は TTL なし（channelConfig.ts の saveChannelConfig と同じ、恒久保存の前例に倣う）。
export interface KpiCommitment {
  itemKey: string;
  kpiText: string;
  committedDate: string; // YYYY-MM-DD
  what: string;
  madeAt: string; // ISO timestamp
  fulfilled: "pending" | "fulfilled" | "broken";
  resolvedAt?: string;
}

export interface KpiExcuse {
  itemKey: string;
  kpiText: string;
  excuseText: string;
  givenAt: string; // ISO timestamp
}

/** 本人が説明したKPI記入ルール。週をまたいで会話の前提を引き継ぐ。 */
export interface KpiContextNote {
  itemKey: string;
  kpiText: string;
  note: string;
  recordedAt: string;
}

export interface KpiMemberMemory {
  member: string;
  commitments: KpiCommitment[];
  excuses: KpiExcuse[];
  contextNotes: KpiContextNote[];
}

const KPI_MEMORY_KEY = (member: string) => `kpi-memory:${member}`;
const MAX_ENTRIES = 100;

function emptyMemory(member: string): KpiMemberMemory {
  return { member, commitments: [], excuses: [], contextNotes: [] };
}

function trimFifo<T>(arr: T[], max = MAX_ENTRIES): T[] {
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

export async function getKpiMemory(kv: KVNamespace, member: string): Promise<KpiMemberMemory> {
  const raw = await kv.get(KPI_MEMORY_KEY(member)).catch(() => null);
  if (!raw) return emptyMemory(member);
  try {
    const parsed = JSON.parse(raw) as KpiMemberMemory;
    return {
      member,
      commitments: parsed.commitments ?? [],
      excuses: parsed.excuses ?? [],
      contextNotes: parsed.contextNotes ?? []
    };
  } catch {
    return emptyMemory(member);
  }
}

/** 動作確認用: 特定メンバーの記憶を消去する（本番運用では通常使わない）。 */
export async function clearKpiMemory(kv: KVNamespace, member: string): Promise<void> {
  await kv.delete(KPI_MEMORY_KEY(member)).catch(() => {});
}

async function saveKpiMemory(kv: KVNamespace, memory: KpiMemberMemory): Promise<void> {
  await kv.put(KPI_MEMORY_KEY(memory.member), JSON.stringify(memory));
}

export async function appendKpiCommitment(
  kv: KVNamespace,
  member: string,
  commitment: Omit<KpiCommitment, "resolvedAt">
): Promise<void> {
  const memory = await getKpiMemory(kv, member);
  memory.commitments = trimFifo([...memory.commitments, commitment]);
  await saveKpiMemory(kv, memory);
}

export async function appendKpiExcuse(kv: KVNamespace, member: string, excuse: KpiExcuse): Promise<void> {
  const memory = await getKpiMemory(kv, member);
  memory.excuses = trimFifo([...memory.excuses, excuse]);
  await saveKpiMemory(kv, memory);
}

/** 同じ意味のメモは更新し、古い誤解を次回以降に持ち越さない。 */
export async function rememberKpiContextNote(
  kv: KVNamespace,
  member: string,
  note: KpiContextNote
): Promise<void> {
  const memory = await getKpiMemory(kv, member);
  memory.contextNotes = trimFifo([
    ...memory.contextNotes.filter((n) => !(n.itemKey === note.itemKey && n.note === note.note)),
    note
  ]);
  await saveKpiMemory(kv, memory);
}

/** 過去の commitment を、実際にやったか/やらなかったかで確定させる（未確定分のみ対象）。 */
export async function markCommitmentOutcome(
  kv: KVNamespace,
  member: string,
  itemKey: string,
  committedDate: string,
  outcome: "fulfilled" | "broken"
): Promise<void> {
  const memory = await getKpiMemory(kv, member);
  let changed = false;
  memory.commitments = memory.commitments.map((c) => {
    if (c.itemKey === itemKey && c.committedDate === committedDate && c.fulfilled === "pending") {
      changed = true;
      return { ...c, fulfilled: outcome, resolvedAt: new Date().toISOString() };
    }
    return c;
  });
  if (changed) await saveKpiMemory(kv, memory);
}

/** LLMプロンプトに渡す用に、指定itemKeyの直近履歴だけを絞り込む。 */
export function recentForItem(
  memory: KpiMemberMemory,
  itemKey: string,
  limit = 5
): { commitments: KpiCommitment[]; excuses: KpiExcuse[]; contextNotes: KpiContextNote[] } {
  return {
    commitments: memory.commitments.filter((c) => c.itemKey === itemKey).slice(-limit),
    excuses: memory.excuses.filter((e) => e.itemKey === itemKey).slice(-limit),
    contextNotes: memory.contextNotes.filter((n) => n.itemKey === itemKey).slice(-limit)
  };
}
