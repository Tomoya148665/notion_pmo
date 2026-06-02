import type { Bindings } from "./config";
import { getConfig } from "./config";
import { resolveConfig } from "./channelConfig";
import {
  getThreadState,
  saveThreadState,
  getPmThread,
  savePmThread,
  appendReply,
  savePendingAction,
  getPendingAction,
  deletePendingAction,
  getMentionHistory,
  appendMentionHistory,
  savePendingProjectSelection,
  getPendingProjectSelection,
  deletePendingProjectSelection,
  savePendingCreateRef,
  getPendingCreateRef,
  deletePendingCreateRef,
  toJstDateString,
  savePhoneReminder,
  deletePhoneReminder,
  getThreadCreatedTasks
} from "./workflow";
import { chatPostMessage, conversationsHistory, conversationsReplies, conversationsOpen, conversationsInfo, usersInfo } from "./slackBot";
import { ensureProjectCatalog, resolveProjectFromCache, resolveProjectByChannelName, topProjectCandidates, extractProjectFromText, saveProjectAlias, resolveProjectByAlias, type CachedProject } from "./projectCatalog";
import { ensureUserCatalog, makeAssigneeResolver, resolveMemberBySlackId, extractAssigneesFromText, type AssigneeResolver, type CachedUser } from "./userCatalog";
import { interpretPmReply, interpretMention, evaluateAssigneeReply, generateTaskDescription } from "./llmAnalyzer";
import { updateTaskPage, updateTaskSprint, updateTaskProject, createTaskPage, fetchNotionUserMap, buildUserMapFromDatabase, searchProjectsByName, appendPageContent } from "./notionWriter";
import { fetchCurrentSprintTasksSummary, fetchCurrentSprintInfo, fetchSprintCapacity, fetchAllSprints, fetchReferenceDbItems, fetchTaskStatusOptions } from "./notionApi";
import { fetchMembers } from "./memberApi";
import {
  calculateAvgDailySpConsumption,
  calcAvgDailySpFromSprint,
  detectStagnantDoingTasks,
  calculateWeeklyDiff
} from "./index";
import { fetchScheduleData, analyzeScheduleDeviation } from "./sheetsApi";
import type { AllocationProposal, NewTask, MentionContext } from "./schema";
import { buildApprovalButtons, buildTimeSelectionButtons } from "./slackInteractions";

// ── HMAC-SHA256 signature verification ────────────────────────────────────

async function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${timestamp}:${body}`)
  );
  const computed =
    "v0=" +
    Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  return computed === signature;
}

// ── Intent pre-detection (rule-based, no LLM) ─────────────────────────────────

/**
 * 単純なルールベースでメンションの意図を推定する。
 * "create" を返した場合、起票専用の軽量パスを使って fetch とプロンプトを削減する。
 * 確信が持てない場合は "other" を返す (= 既存のフル context フロー)。
 */
function detectIntentHint(text: string): "create" | "other" {
  const t = text.trim();
  if (!t) return "other";
  if (/起票/.test(t)) return "create";
  if (/タスク[をに]?(?:追加|作成|登録|作って|新規)/u.test(t)) return "create";
  // "Xを松田君に追加" の様な末尾パターン
  if (/に追加(?:して|お願い|します)?[!！。.]*$/u.test(t)) return "create";
  if (/(?:作って|追加して|登録して)(?:[くだ]さい)?[!！。.]*$/u.test(t)) return "create";
  return "other";
}

// ── Assignee name resolver ───────────────────────────────────────────────
// 担当者解決ロジックは src/userCatalog.ts に移動（KVキャッシュ化）。
// AssigneeResolver / makeAssigneeResolver / resolveMemberBySlackId を import して使う。

// ── Execute a Notion task creation ──────────────────────────────────────────

export async function executeTaskCreation(
  config: {
    notionToken: string;
    taskDbId?: string;
    taskSprintRelationProperty: string;
    dryRun: boolean;
    memberExclude?: string[];
    memberExtra?: Record<string, string>;
  },
  task: NewTask & { sprintId?: string; projectIds?: string[]; project?: string | null },
  userMaps?: { dbUserMap: Map<string, string>; notionUserMap: Map<string, string> },
  resolveAssignee?: AssigneeResolver
): Promise<{ message: string; pageId?: string }> {
  if (!config.taskDbId) {
    return { message: "❌ TASK_DB_URL が未設定のためタスクを作成できません" };
  }

  // 担当者から除外する名前(部分一致)。チーム外のコラボレーター等を割り当て対象から外す。
  const excludeList = config.memberExclude ?? [];
  const isExcluded = (notionName: string): boolean =>
    excludeList.some((ex) => notionName.includes(ex) || ex.includes(notionName));

  // 表示名 → Notion 上の正式名へのエイリアス (例: 松田直樹 → Matsuda Naoki)
  const memberExtra = config.memberExtra ?? {};

  // Strip Japanese honorifics so "松田君" / "古鉄さん" etc. resolve like the bare name
  const stripHonorific = (name: string): string =>
    name.replace(/(さん|くん|ちゃん|様|さま|殿|氏|君)$/u, "").trim();

  // Resolve assignee name → Notion user ID
  // Try exact match first, then partial match (e.g. "北川" matches "北川楓")
  const findUser = (map: Map<string, string>, rawName: string): string | undefined => {
    const name = stripHonorific(rawName);
    // Alias check: if input name has an alias, resolve via that alias name
    const aliased = memberExtra[name];
    if (aliased) {
      const aliasId = map.get(aliased);
      if (aliasId && !isExcluded(aliased)) {
        console.log(`Assignee alias: "${rawName}" → "${aliased}" (${aliasId})`);
        return aliasId;
      }
      // Try partial match on aliased name
      for (const [notionName, id] of map) {
        if (isExcluded(notionName)) continue;
        if (notionName.includes(aliased) || aliased.includes(notionName)) {
          console.log(`Assignee alias+partial: "${rawName}" → "${aliased}" → "${notionName}" (${id})`);
          return id;
        }
      }
    }
    // Exact match (must not be excluded)
    const exact = map.get(name);
    if (exact && !isExcluded(name)) return exact;
    // Partial match: input is substring of Notion name, or vice versa
    for (const [notionName, id] of map) {
      if (isExcluded(notionName)) continue;
      if (notionName.includes(name) || name.includes(notionName)) {
        console.log(`Assignee partial match: "${rawName}" → "${notionName}" (${id})`);
        return id;
      }
    }
    return undefined;
  };

  let assigneeId: string | undefined;
  // Primary: pre-built member alias resolver (handles kanji/hiragana/romaji variations)
  if (resolveAssignee) {
    assigneeId = resolveAssignee(task.assignee);
    console.log(`Assignee via resolver: "${task.assignee}" → ${assigneeId ?? "(not found)"}`);
  }
  // Fallback: legacy findUser against Notion task DB + workspace users (for non-member names)
  if (!assigneeId) {
    const dbMap = userMaps?.dbUserMap ?? (config.taskDbId ? await buildUserMapFromDatabase(config.notionToken, config.taskDbId) : new Map<string, string>());
    assigneeId = findUser(dbMap, task.assignee);
    if (!assigneeId) {
      const notionMap = userMaps?.notionUserMap ?? await fetchNotionUserMap(config.notionToken);
      assigneeId = findUser(notionMap, task.assignee);
    }
  }

  // ── Due date safety net: if LLM returned a past date, override with SP-based default ──
  const todayJst = toJstDateString(new Date());
  let finalDue = task.due;
  if (finalDue && finalDue < todayJst) {
    const addDays = (n: number): string => {
      const d = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const sp = task.sp ?? 3;
    const offset = sp <= 3 ? 2 : sp <= 5 ? 3 : sp <= 8 ? 4 : 5;
    finalDue = addDays(offset);
    console.warn(`Due overridden: LLM returned past date "${task.due}" (today=${todayJst}); using SP-based default "${finalDue}" (sp=${sp})`);
  }

  const properties: Record<string, unknown> = {
    名前: { title: [{ text: { content: task.task_name } }] },
    期限: { date: { start: finalDue } },
    SP: { number: task.sp },
    ステータス: { status: { name: task.status } },
    カテゴリ: { select: { name: "タスク" } }
  };

  if (assigneeId) {
    properties["担当者"] = { people: [{ id: assigneeId }] };
  }

  if (task.sprintId) {
    properties[config.taskSprintRelationProperty] = {
      relation: [{ id: task.sprintId }]
    };
  }

  // Project IDs are already resolved in handleMention before confirmation
  const resolvedProjectIds = task.projectIds ?? [];
  if (resolvedProjectIds.length > 0) {
    properties["プロジェクト"] = {
      relation: resolvedProjectIds.map((id) => ({ id }))
    };
  }

  console.log(`createTask: sprintId=${task.sprintId ?? "(none)"}, projectIds=${task.projectIds?.join(",") ?? "(none)"}, assigneeId=${assigneeId ?? "(none)"}`);
  console.log(`createTask properties:`, JSON.stringify(properties));

  if (config.dryRun) {
    const assigneeNote = assigneeId
      ? `${task.assignee} (${assigneeId})`
      : `${task.assignee} (⚠️ Notion ユーザー未検出)`;
    console.log(`DRY_RUN: create task "${task.task_name}" assignee=${assigneeNote}`);
    return { message: `（DRY_RUN）タスク「${task.task_name}」を作成予定\n担当: ${assigneeNote}\n期限: ${task.due}\nSP: ${task.sp}` };
  }

  let createdPage: { id: string; url: string } | undefined;
  try {
    createdPage = await createTaskPage(config.notionToken, config.taskDbId, properties);
  } catch (err) {
    console.error(`Failed to create task "${task.task_name}"`, (err as Error).message);
    return { message: `❌ タスク作成失敗: ${task.task_name}\nエラー: ${(err as Error).message}` };
  }

  const assigneeNote = assigneeId
    ? task.assignee
    : `${task.assignee}（⚠️ Notion ユーザー未検出のため担当者未設定）`;

  const taskLink = createdPage?.url
    ? `<${createdPage.url}|${task.task_name}>`
    : task.task_name;

  return {
    message: `✅ タスク作成完了\n・タスク名: ${taskLink}\n・担当: ${assigneeNote}\n・期限: ${finalDue}\n・SP: ${task.sp}`,
    pageId: createdPage?.id
  };
}

// ── Fetch recent top-level channel messages (thread replies excluded) ────
// チャンネルに直接メンションされたとき用。直近 N 件のトップレベルメッセージ
// のみを返し、各メッセージにぶら下がるスレッド返信の中身は取得しない。
// （conversations.history は元々スレッド返信を含まず、親メッセージのみを返す）

async function fetchChannelContext(
  token: string,
  channel: string,
  limit = 15
): Promise<Array<{ text: string; user: string; ts: string }>> {
  try {
    const messages = await conversationsHistory(token, channel, limit);
    console.log(`fetchChannelContext: got ${messages.length} messages from channel`);

    const result: Array<{ text: string; user: string; ts: string }> = [];
    for (const msg of messages) {
      if (!msg.text) continue;
      result.push({ text: msg.text, user: msg.user, ts: msg.ts });
    }

    console.log(`fetchChannelContext: ${result.length} recent channel messages (no thread replies)`);
    return result.slice(0, limit);
  } catch (err) {
    console.warn(`fetchChannelContext error: ${(err as Error).message}`);
    return [];
  }
}

// ── Step 9: Channel-wide completion notification ─────────────────────────

export async function sendCompletionNotification(
  botToken: string,
  channel: string,
  results: string[],
  dryRun: boolean,
  threadTs?: string
): Promise<void> {
  if (results.length === 0) return;

  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const month = jst.getMonth() + 1;
  const day = jst.getDate();
  const hours = String(jst.getHours()).padStart(2, "0");
  const minutes = String(jst.getMinutes()).padStart(2, "0");
  const timestamp = `${month}/${day} ${hours}:${minutes}`;

  const prefix = dryRun ? "（DRY_RUN）" : "";
  // 更新系の完了通知は 🔄。ステータスの before/after(↗️/↘️) は Notion webhook 側で別途通知。
  const text = `${prefix}:arrows_counterclockwise: タスクが更新されました（${timestamp}）\n\n${results.join("\n")}`;

  // threadTs があれば当日の MM/DD_タスクスレッドに投稿（チャンネルへの直接投稿を避ける）
  await chatPostMessage(botToken, channel, text, undefined, threadTs);
}

// ── Execute a list of Notion update actions ────────────────────────────────

function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

export async function executeNotionActions(
  token: string,
  actions: Array<{
    action: string;
    page_id: string;
    task_name: string;
    new_value: string;
  }>,
  dryRun: boolean,
  projectDbId?: string,
  resolveAssignee?: AssigneeResolver
): Promise<string[]> {
  const results: string[] = [];

  // Deduplicate: keep only the last action per (page_id, action) pair
  const seen = new Map<string, number>();
  for (let i = 0; i < actions.length; i++) {
    seen.set(`${actions[i].page_id}::${actions[i].action}`, i);
  }
  const deduped = actions.filter((_, i) => {
    const a = actions[i];
    return seen.get(`${a.page_id}::${a.action}`) === i;
  });

  for (const action of deduped) {
    // update_assignee — change task assignee in Notion
    if (action.action === "update_assignee") {
      if (dryRun) {
        console.log(`DRY_RUN: update_assignee ${action.task_name} → ${action.new_value}`);
        results.push(`（DRY_RUN）${action.task_name}: 担当者変更 → ${action.new_value}`);
        continue;
      }
      try {
        // 複数担当者対応: "松田, 北川" 等をカンマ/読点/スラッシュで分割し、各名を個別に解決
        const names = action.new_value
          .split(/[,、，･・\/／]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const resolvedIds: string[] = [];
        const unresolved: string[] = [];
        for (const n of names) {
          const id = resolveAssignee ? resolveAssignee(n) : undefined;
          if (id && !resolvedIds.includes(id)) resolvedIds.push(id);
          else if (!id) unresolved.push(n);
        }
        const link = notionPageUrl(action.page_id);
        if (resolvedIds.length > 0) {
          // 解決できた担当者を people 配列にまとめてセット（複数可）
          await updateTaskPage(token, action.page_id, { assigneeIds: resolvedIds });
          const note = unresolved.length > 0 ? `（⚠️ 未検出: ${unresolved.join(", ")}）` : "";
          results.push(`・<${link}|${action.task_name}>: 担当者変更 → ${names.join(", ")}${note}`);
        } else {
          // 1人も解決できなかった場合は名前ベースのフォールバック（単一名）
          await updateTaskPage(token, action.page_id, { assignee: action.new_value });
          results.push(`・<${link}|${action.task_name}>: 担当者変更 → ${action.new_value}（⚠️ Notion ユーザー未検出のため未設定）`);
        }
      } catch (err) {
        console.error(`Failed to update assignee for ${action.page_id}`, (err as Error).message);
        results.push(`・${action.task_name}: 担当者変更失敗 (${(err as Error).message})`);
      }
      continue;
    }

    // update_sprint — move task to another sprint or backlog
    if (action.action === "update_sprint") {
      if (dryRun) {
        const label = action.new_value ? `スプリント ${action.new_value}` : "バックログ";
        console.log(`DRY_RUN: update_sprint ${action.task_name} → ${label}`);
        results.push(`（DRY_RUN）${action.task_name}: スプリント移動 → ${label}`);
        continue;
      }
      try {
        await updateTaskSprint(token, action.page_id, action.new_value);
        const label = action.new_value ? `スプリント移動` : "バックログ戻し";
        const link = notionPageUrl(action.page_id);
        results.push(`・<${link}|${action.task_name}>: ${label}`);
      } catch (err) {
        console.error(`Failed to update sprint for ${action.page_id}`, (err as Error).message);
        results.push(`・${action.task_name}: スプリント移動失敗 (${(err as Error).message})`);
      }
      continue;
    }

    // update_project — change task's project relation in Notion
    if (action.action === "update_project") {
      if (dryRun) {
        console.log(`DRY_RUN: update_project ${action.task_name} → ${action.new_value}`);
        results.push(`（DRY_RUN）${action.task_name}: プロジェクト変更 → ${action.new_value}`);
        continue;
      }
      try {
        const candidates = await searchProjectsByName(token, action.new_value, projectDbId);
        console.log(`update_project: search "${action.new_value}" → ${candidates.length} candidates: ${candidates.map(c => `${c.name}(${c.id.slice(0,8)})`).join(", ")}`);
        if (candidates.length === 0) {
          results.push(`・${action.task_name}: プロジェクト「${action.new_value}」が見つかりませんでした`);
        } else {
          console.log(`update_project: updating page ${action.page_id} with project ${candidates[0].id} (${candidates[0].name})`);
          await updateTaskProject(token, action.page_id, [candidates[0].id]);
          const link = notionPageUrl(action.page_id);
          results.push(`・<${link}|${action.task_name}>: プロジェクト変更 → ${candidates[0].name}`);
        }
      } catch (err) {
        console.error(`Failed to update project for ${action.page_id}:`, (err as Error).message);
        results.push(`・${action.task_name}: プロジェクト変更失敗 (${(err as Error).message})`);
      }
      continue;
    }

    // append_description — append text to task page content
    if (action.action === "append_description") {
      if (dryRun) {
        console.log(`DRY_RUN: append_description ${action.task_name}`);
        results.push(`（DRY_RUN）${action.task_name}: 説明文追記`);
        continue;
      }
      try {
        await appendPageContent(token, action.page_id, action.new_value);
        const link = notionPageUrl(action.page_id);
        results.push(`・<${link}|${action.task_name}>: 説明文を追記しました`);
      } catch (err) {
        console.error(`Failed to append description for ${action.page_id}`, (err as Error).message);
        results.push(`・${action.task_name}: 説明文追記失敗 (${(err as Error).message})`);
      }
      continue;
    }

    const updates =
      action.action === "update_due"
        ? { due: action.new_value }
        : action.action === "update_sp"
        ? { sp: parseFloat(action.new_value) }
        : action.action === "update_status"
        ? { status: action.new_value }
        : {};

    if (Object.keys(updates).length === 0) {
      console.warn(`Unknown action type: ${action.action}`);
      continue;
    }

    if (dryRun) {
      console.log(`DRY_RUN: ${action.action} ${action.task_name} → ${action.new_value}`);
      results.push(`（DRY_RUN）${action.task_name}: ${action.action} → ${action.new_value}`);
      continue;
    }

    try {
      await updateTaskPage(token, action.page_id, updates);
      // ステータス変更は Notion webhook 側で before/after(↗️/↘️)を通知するため、
      // 🔄 の完了通知(results)には含めない（二重通知を避ける）。
      if (action.action === "update_status") {
        console.log(`update_status ${action.task_name} → ${action.new_value}（completionには出さずwebhookに委譲）`);
        continue;
      }
      const link = notionPageUrl(action.page_id);
      const label =
        action.action === "update_due" ? "期限変更" : action.action === "update_sp" ? "SP変更" : action.action;
      results.push(`・<${link}|${action.task_name}>: ${label} → ${action.new_value}`);
    } catch (err) {
      console.error(`Failed to update task ${action.page_id}`, (err as Error).message);
      results.push(`・${action.task_name}: 更新失敗 (${(err as Error).message})`);
    }
  }

  return results;
}

// ── SP → 推定時間 変換テーブル（非線形） ──────────────────────────────────
// 8SP=~10h, 5SP=~6h, 3SP=~2.5h, 2SP=~1.5h
const SP_HOURS_TABLE: [number, number][] = [
  [1, 0.5],
  [2, 1.5],
  [3, 2.5],
  [5, 6],
  [8, 10],
];

function estimateHoursFromSp(sp: number): number {
  if (sp <= 0) return 0;

  // Exact match
  const exact = SP_HOURS_TABLE.find(([s]) => s === sp);
  if (exact) return exact[1];

  // Below minimum — extrapolate from first segment
  if (sp < SP_HOURS_TABLE[0][0]) {
    const [s1, h1] = SP_HOURS_TABLE[0];
    const [s2, h2] = SP_HOURS_TABLE[1];
    const rate = (h2 - h1) / (s2 - s1);
    return Math.max(0, h1 + rate * (sp - s1));
  }

  // Interpolation between known points
  for (let i = 0; i < SP_HOURS_TABLE.length - 1; i++) {
    const [s1, h1] = SP_HOURS_TABLE[i];
    const [s2, h2] = SP_HOURS_TABLE[i + 1];
    if (sp > s1 && sp < s2) {
      const ratio = (sp - s1) / (s2 - s1);
      return h1 + ratio * (h2 - h1);
    }
  }

  // Above maximum — extrapolate from last segment
  const [sN1, hN1] = SP_HOURS_TABLE[SP_HOURS_TABLE.length - 2];
  const [sN, hN] = SP_HOURS_TABLE[SP_HOURS_TABLE.length - 1];
  const rate = (hN - hN1) / (sN - sN1);
  return hN + rate * (sp - sN);
}

// ── Handle project selection reply (番号でプロジェクト選択) ─────────────────

async function handleProjectSelectionReply(
  env: Bindings,
  event: Record<string, unknown>
): Promise<boolean> {
  const channel = event.channel as string;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return false;
  const threadTs = event.thread_ts as string;
  const text = ((event.text as string) ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
  const userId = (event.user as string) ?? "";
  const userMention = userId ? `<@${userId}> ` : "";

  const pending = await getPendingProjectSelection(env.NOTIFY_CACHE, channel, threadTs);
  if (!pending) return false;

  // Only the original requester can select
  if (pending.requestedBy !== userId) return false;

  // Cancel keywords
  const cancelWords = ["キャンセル", "cancel", "やめる", "中止"];
  if (cancelWords.some((w) => text.toLowerCase().includes(w))) {
    await deletePendingProjectSelection(env.NOTIFY_CACHE, channel, threadTs);
    await chatPostMessage(
      config.slackBotToken,
      channel,
      `${userMention}タスク作成をキャンセルしました。`,
      undefined,
      threadTs
    );
    return true;
  }

  // Parse number
  const num = parseInt(text, 10);
  if (isNaN(num) || num < 1 || num > pending.candidates.length) {
    await chatPostMessage(
      config.slackBotToken,
      channel,
      `${userMention}1〜${pending.candidates.length} の番号で選んでください！（キャンセルする場合は「キャンセル」と送ってください）`,
      undefined,
      threadTs
    );
    return true;
  }

  const selected = pending.candidates[num - 1];
  const resolvedProjectIds = [selected.id];

  await deletePendingProjectSelection(env.NOTIFY_CACHE, channel, threadTs);

  // 略称→プロジェクトの対応を記録（次回から同じ略称で番号選択不要になる）
  if (pending.query) {
    await saveProjectAlias(env.NOTIFY_CACHE, pending.query, { id: selected.id, name: selected.name, team: "" }).catch(() => {});
    console.log(`Project alias saved: "${pending.query}" → ${selected.name}`);
  }

  // Build confirmation message
  const task = pending.newTask;
  const responseText = [
    "以下のタスクを追加します。問題なければ ✅ 承認ボタンを押してください:",
    `・タスク名: *${task.task_name}*`,
    `・担当: ${task.assignee}`,
    `・期限: ${task.due}`,
    `・SP: ${task.sp}`,
    `・ステータス: ${task.status}`,
    `📁 プロジェクト: *${selected.name}*`
  ].join("\n");

  const projSelectBlocks = [
    { type: "section", text: { type: "mrkdwn", text: `${userMention}${responseText}` } },
    ...buildApprovalButtons("task_action")
  ];
  const confirmMsg = await chatPostMessage(
    config.slackBotToken,
    channel,
    `${userMention}${responseText}`,
    projSelectBlocks,
    threadTs
  );

  // Store as pending action (same as normal create_task flow)
  await savePendingAction(env.NOTIFY_CACHE, confirmMsg.channel, confirmMsg.ts, {
    actions: [{
      action: "create_task",
      page_id: "",
      task_name: task.task_name,
      new_value: JSON.stringify({
        ...task,
        projectIds: resolvedProjectIds
      })
    }],
    requestedBy: userId,
    requestedAt: new Date().toISOString(),
    threadTs
  });

  // Save thread-level reference for potential modifications
  await savePendingCreateRef(env.NOTIFY_CACHE, channel, threadTs, {
    confirmMsgTs: confirmMsg.ts
  });

  console.log(`Project selected: "${selected.name}" (${selected.id}) for task "${task.task_name}"`);
  return true;
}

// ── Deterministic project / assignee resolution helpers ────────────────────

interface ProjectResolution {
  resolvedProjectIds: string[];
  projectDisplay: string | null;
  /** カタログに当てはまらず聞き返しが必要な場合の候補とクエリ */
  selection?: { candidates: Array<{ id: string; name: string }>; query: string };
}

/**
 * 起票タスクのプロジェクトを決定的に解決する。
 *  - project === ""     → プロジェクトなし
 *  - project = 名前      → カタログ照合（ミスなら候補提示）
 *  - project === null    → チャンネル名からカタログ照合（ミスなら候補提示）
 * スプリント多数決などのデフォルト補完は行わない。
 */
async function resolveTaskProject(
  kv: KVNamespace,
  projectVal: string | null | undefined,
  channelName: string,
  catalog: CachedProject[]
): Promise<ProjectResolution> {
  if (projectVal === "") {
    return { resolvedProjectIds: [], projectDisplay: null };
  }
  if (projectVal) {
    // ① 記録済みエイリアス（過去に番号選択で確定した略称）を最優先
    const aliasHit = await resolveProjectByAlias(kv, projectVal, catalog);
    if (aliasHit) return { resolvedProjectIds: [aliasHit.id], projectDisplay: aliasHit.name };
    // ② 通常マッチ（exact → 部分一致 → 文字重なりの大雑把マッチ）
    const hit = resolveProjectFromCache(catalog, projectVal);
    if (hit) return { resolvedProjectIds: [hit.id], projectDisplay: hit.name };
    return {
      resolvedProjectIds: [],
      projectDisplay: null,
      selection: { candidates: topProjectCandidates(catalog, projectVal), query: projectVal }
    };
  }
  // null（明示なし）→ チャンネル名で推定
  const hit = resolveProjectByChannelName(catalog, channelName);
  if (hit) return { resolvedProjectIds: [hit.id], projectDisplay: hit.name };
  return {
    resolvedProjectIds: [],
    projectDisplay: null,
    selection: { candidates: topProjectCandidates(catalog, channelName), query: channelName }
  };
}

/**
 * 本文中の @メンション（Bot自身を除く）から担当者メンバー名を1件だけ特定する。
 * 非Botメンションがちょうど1件で、それがカタログのメンバーに一致したときのみ返す。
 */
function extractMentionedMemberName(
  rawText: string,
  botUserId: string | undefined,
  catalog: CachedUser[]
): string | undefined {
  const ids: string[] = [];
  for (const m of rawText.matchAll(/<@([A-Z0-9]+)>/g)) {
    if (botUserId && m[1] === botUserId) continue;
    ids.push(m[1]);
  }
  if (ids.length !== 1) return undefined; // 0件 or 複数 → 上書きしない
  return resolveMemberBySlackId(catalog, ids[0])?.name;
}

const SELF_REFERENCE_RE = /^(自分|私|わたし|俺|おれ|僕|ぼく|me)$/i;

// ── Handle @mention (app_mention event) ───────────────────────────────────

async function handleMention(
  env: Bindings,
  event: Record<string, unknown>,
  botUserId?: string
): Promise<void> {
  const channel = event.channel as string;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;

  const threadTs = (event.thread_ts as string | undefined) ?? (event.ts as string);
  const rawText = (event.text as string) ?? "";
  const userId = (event.user as string) ?? "";
  const userMention = userId ? `<@${userId}> ` : "";

  console.log(`handleMention: channel=${channel}, threadTs=${threadTs}, rawText="${rawText}", userId=${userId}`);

  // Strip bot mention tokens like <@U12345>
  const userText = rawText.replace(/<@[A-Z0-9]+>/g, "").trim();

  // ── 設定変更 command ──────────────────────────────────────────────────
  if (userText === "設定変更" || userText === "settings") {
    if (!config.slackBotToken) return;
    await chatPostMessage(
      config.slackBotToken,
      channel,
      "設定を変更します。下のボタンから設定画面を開いてください。",
      [{
        type: "actions",
        block_id: "onboarding_setup",
        elements: [{
          type: "button",
          text: { type: "plain_text", text: "設定変更", emoji: true },
          style: "primary",
          action_id: "onboarding_open_modal"
        }]
      }]
    );
    return;
  }

  if (!userText) {
    await chatPostMessage(
      config.slackBotToken,
      channel,
      `${userMention}何かお手伝いできますか？ タスク状況の確認や更新をリクエストしてください。`,
      undefined,
      threadTs
    );
    return;
  }

  // Shortcut: if user @mentions with a number and there's a pending project selection,
  // handle it directly without LLM call
  if (/^\d+$/.test(userText) || /^(キャンセル|cancel|やめる|中止)$/i.test(userText)) {
    const pendingSelection = await getPendingProjectSelection(env.NOTIFY_CACHE, channel, threadTs);
    if (pendingSelection) {
      const handled = await handleProjectSelectionReply(env, {
        ...event,
        text: userText
      });
      if (handled) return;
    }
  }

  try {
    const now = new Date();
    const today = toJstDateString(now);
    const hasThread = !!event.thread_ts;
    // Rule-based intent hint computed before any fetch so we can choose the light path
    const intentHint = detectIntentHint(userText);
    const skipForCreate = intentHint === "create";
    // If the user mentions sprint explicitly, we still need the full sprint list for matching
    const mentionsSprint = /スプリント|sprint|s\d+|バックログ|backlog/iu.test(userText);
    if (skipForCreate) {
      console.log(`Intent hint: create — using light fetch path${mentionsSprint ? " (sprint mentioned, keeping allSprints)" : ""}`);
    }

    // Fetch current sprint info — light version (no task list) for create-task fast path
    const summary = skipForCreate
      ? await fetchCurrentSprintInfo(config, now)
      : await fetchCurrentSprintTasksSummary(config, now);

    // Build current task snapshot for helper functions (empty for create — those helpers are skipped anyway)
    const currentSnapshot = summary.assignees.flatMap((a) =>
      a.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status ?? null,
        sp: t.sp ?? null
      }))
    );

    const [
      members,
      capacities,
      scheduleDataResult,
      spConsumption,
      weeklyDiff,
      stagnantTasks,
      allSprints,
      referenceItems,
      rawThreadMsgs,
      rawChannelMsgs,
      threadStateResult,
      conversationHistoryResult,
      pendingCreateRefResult,
      channelInfoResult,
      cachedProjectsResult,
      userCatalogResult
    ] = await Promise.all([
      fetchMembers(config).catch(() => []),
      skipForCreate ? Promise.resolve([]) : fetchSprintCapacity(config, summary.sprint.id).catch(() => []),
      skipForCreate ? Promise.resolve(null) : fetchScheduleData(config).catch(() => null),
      skipForCreate ? Promise.resolve(null) : calculateAvgDailySpConsumption(env.NOTIFY_CACHE, summary.sprint.id, today).catch(() => null),
      skipForCreate ? Promise.resolve(null) : calculateWeeklyDiff(env.NOTIFY_CACHE, summary.sprint.id, today, currentSnapshot).catch(() => null),
      skipForCreate ? Promise.resolve([]) : detectStagnantDoingTasks(env.NOTIFY_CACHE, summary.sprint.id, today, currentSnapshot).catch(() => []),
      // Skip fetchAllSprints in create fast path unless user explicitly references a sprint
      skipForCreate && !mentionsSprint
        ? Promise.resolve([])
        : fetchAllSprints(config).catch(() => []),
      hasThread || skipForCreate ? Promise.resolve([]) : fetchReferenceDbItems(config).catch(() => []),
      // Thread context: スレッド内メンション時はそのスレッドのみを見る
      hasThread
        ? conversationsReplies(config.slackBotToken, channel, threadTs, 30, true).catch(() => [] as Array<{ ts: string; text: string; user: string }>)
        : Promise.resolve([] as Array<{ ts: string; text: string; user: string }>),
      // Channel context: チャンネル直接メンション時は直近15件を見る。
      // create 時も「これ起票して」の『これ』が指す会話（内容・期限）を拾うために必要なので省略しない。
      hasThread
        ? Promise.resolve([] as Array<{ text: string; user: string; ts: string }>)
        : fetchChannelContext(config.slackBotToken, channel, 15).catch(() => [] as Array<{ text: string; user: string; ts: string }>),
      // KV lookups (parallelized with above)
      getThreadState(env.NOTIFY_CACHE, channel, threadTs).catch(() => null),
      getMentionHistory(env.NOTIFY_CACHE, channel, threadTs).catch(() => [] as Array<{ role: "user" | "assistant"; content: string }>),
      getPendingCreateRef(env.NOTIFY_CACHE, channel, threadTs).catch(() => null),
      conversationsInfo(config.slackBotToken, channel).catch(() => ({ name: "" })),
      ensureProjectCatalog(env, config).catch(() => []),
      ensureUserCatalog(env, config).catch(() => [] as CachedUser[])
    ]);

    // Merge capacity data into members
    for (const member of members) {
      const cap = capacities.find(
        (c) => c.name === member.name || c.name.includes(member.name) || member.name.includes(c.name)
      );
      if (cap) member.availableHours = cap.remainingHours;
    }

    // Calculate avg daily SP (priority: KV 7-day history > sprint-level)
    // For create-task fast path, skip these computations entirely so they're omitted from the LLM prompt.
    let avgDailySp: number | null = null;
    let planSp: number | null = null;
    let progressSp: number | null = null;
    let requiredSpPerDay: number | null = null;

    if (!skipForCreate) {
      avgDailySp = spConsumption ? spConsumption.avgDailySp : null;
      if (avgDailySp == null) {
        avgDailySp = calcAvgDailySpFromSprint(summary, today);
      }
      planSp = typeof summary.sprint_metrics?.plan_sp === "number"
        ? summary.sprint_metrics.plan_sp : null;
      progressSp = typeof summary.sprint_metrics?.progress_sp === "number"
        ? summary.sprint_metrics.progress_sp : null;
      const remainingSpLocal = planSp != null && progressSp != null ? planSp - progressSp : null;
      const endDate = new Date(`${summary.sprint.end_date}T00:00:00Z`);
      const startDate = new Date(`${summary.sprint.start_date}T00:00:00Z`);
      const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
      const elapsedDays = Math.ceil((now.getTime() - startDate.getTime()) / 86400000) + 1;
      const remainingDays = totalDays > 0 ? Math.max(totalDays - elapsedDays, 1) : 1;
      requiredSpPerDay = typeof summary.sprint_metrics?.required_sp_per_day === "number"
        ? summary.sprint_metrics.required_sp_per_day
        : remainingSpLocal != null
          ? Math.round((remainingSpLocal / remainingDays) * 100) / 100
          : null;
    }
    const remainingSp = planSp != null && progressSp != null ? planSp - progressSp : null;

    // Build schedule deviation summary
    let scheduleDeviation: MentionContext["scheduleDeviation"] = null;
    if (scheduleDataResult && scheduleDataResult.rows.length > 0) {
      const deviation = analyzeScheduleDeviation(scheduleDataResult, today);
      scheduleDeviation = {
        onTrack: deviation.onTrack.length,
        delayed: deviation.delayed.length,
        atRisk: deviation.atRisk.length,
        delayedItems: deviation.delayed.map((row) => ({
          category: row.category,
          item: row.item,
          plannedEnd: row.plannedEnd ?? ""
        })),
        atRiskItems: deviation.atRisk.map((row) => ({
          category: row.category,
          item: row.item,
          plannedEnd: row.plannedEnd ?? ""
        }))
      };
    }

    // Build member context with workload info (partial name matching)
    // requiredHours is calculated per-task using non-linear SP→hours conversion
    const memberContext: MentionContext["members"] = members.map((m) => {
      const assigneeTasks = summary.assignees.find(
        (a) => a.name === m.name || a.name.includes(m.name) || m.name.includes(a.name)
      );
      const cap = capacities.find(
        (c) => c.name === m.name || c.name.includes(m.name) || m.name.includes(c.name)
      );
      const taskCount = assigneeTasks?.tasks.length ?? 0;
      const totalSp = assigneeTasks?.tasks.reduce((sum, t) => sum + (t.sp ?? 0), 0) ?? 0;
      const requiredHours = assigneeTasks?.tasks.reduce(
        (sum, t) => sum + estimateHoursFromSp(t.sp ?? 0), 0
      ) ?? 0;
      const hoursPerSp = totalSp > 0 ? Math.round((requiredHours / totalSp) * 100) / 100 : 0;
      const remainingHours = cap?.remainingHours ?? m.availableHours ?? null;
      const totalHours = cap?.totalHours ?? null;
      const utilization = remainingHours != null && remainingHours > 0
        ? Math.round((requiredHours / remainingHours) * 100)
        : null;
      return {
        name: assigneeTasks?.name ?? m.name,
        remainingHours,
        totalHours,
        hoursPerSp,
        currentTaskCount: taskCount,
        currentTotalSp: totalSp,
        requiredHours: Math.round(requiredHours * 10) / 10,
        utilization
      };
    });

    const mentionContext: MentionContext = {
      sprintMetrics: {
        plan_sp: planSp,
        progress_sp: progressSp,
        remaining_sp: remainingSp,
        required_sp_per_day: requiredSpPerDay
      },
      avgDailySp,
      members: memberContext,
      scheduleDeviation,
      weeklyDiff,
      stagnantTasks,
      availableSprints: allSprints.map((s) => ({
        id: s.id,
        name: s.name,
        start_date: s.start_date,
        end_date: s.end_date
      })),
      ...(channelInfoResult.name ? { channelName: channelInfoResult.name } : {})
      // availableProjects はLLMに注入しない: プロジェクト選択はコード側で決定的に行う
    };

    // Resolve Slack user ID → member name for "自分" resolution
    const requestUserName = members.find((m) => m.slackUserId === userId)?.name;

    // Build Slack user ID → member name map for resolving <@U12345> mentions
    const slackIdToName = new Map<string, string>();
    for (const m of members) {
      if (m.slackUserId) {
        slackIdToName.set(m.slackUserId, m.name);
      }
    }

    // Fallback: resolve unknown User IDs via Slack users.info
    // (covers people not registered in the Notion member DB)
    const unknownIds = new Set<string>();
    const collectId = (uid: string) => {
      if (uid && !slackIdToName.has(uid)) unknownIds.add(uid);
    };
    const collectMentions = (text: string) => {
      for (const match of text.matchAll(/<@([A-Z0-9]+)>/g)) collectId(match[1]);
    };
    for (const m of rawThreadMsgs) {
      collectId(m.user);
      collectMentions(m.text);
    }
    for (const m of rawChannelMsgs) {
      collectId(m.user);
      collectMentions(m.text);
    }
    if (unknownIds.size > 0) {
      const token = config.slackBotToken;
      const resolved = await Promise.all(
        [...unknownIds].map(async (uid) => {
          const info = await usersInfo(token, uid).catch(() => null);
          const name = info ? (info.displayName || info.realName) : "";
          return [uid, name] as const;
        })
      );
      for (const [uid, name] of resolved) {
        if (name) slackIdToName.set(uid, name);
      }
    }

    const resolveSlackMentions = (text: string): string =>
      text.replace(/<@([A-Z0-9]+)>/g, (_, id) => {
        const name = slackIdToName.get(id);
        return name ? `@${name}` : `<@${id}>`;
      });
    const resolveUserIdName = (uid: string): string =>
      slackIdToName.get(uid) ?? uid;

    // Process thread/channel context from parallel fetch results.
    // スレッド内メンション → threadContext のみ / チャンネル直接メンション → channelContext のみ
    // （rawThreadMsgs と rawChannelMsgs は hasThread によって排他的に populate される）
    let threadContext: Array<{ text: string; user: string }> | undefined;
    let channelContext: Array<{ text: string; user: string }> | undefined;
    if (rawThreadMsgs.length > 0) {
      threadContext = rawThreadMsgs.map((m) => ({
        text: resolveSlackMentions(m.text),
        user: resolveUserIdName(m.user)
      }));
      console.log(`Thread context: ${threadContext.length} messages from thread ${threadTs}`);
    }
    if (rawChannelMsgs.length > 0) {
      channelContext = rawChannelMsgs.map((m) => ({
        text: resolveSlackMentions(m.text),
        user: resolveUserIdName(m.user)
      }));
      console.log(`Channel context: ${channelContext.length} recent channel messages`);
    }

    // Process thread state from parallel fetch result
    const threadState = threadStateResult;
    if (threadState) {
      // Save as assignee reply (for evening flow)
      await appendReply(env.NOTIFY_CACHE, channel, threadTs, {
        text: userText,
        userId,
        receivedAt: new Date().toISOString()
      });
      await saveThreadState(env.NOTIFY_CACHE, channel, threadTs, {
        ...threadState,
        state: "replied"
      });
      console.log(`Also saved as assignee reply from ${threadState.assigneeName}`);
    }

    // Process conversation history from parallel fetch result
    let conversationHistory = conversationHistoryResult;

    // If this is a morning flow thread and no mention history yet,
    // inject the original morning message context so LLM knows what "そのタスク" refers to
    if (threadState && conversationHistory.length === 0) {
      const taskList = threadState.tasks
        .map((t) => `- ${t.name}（ステータス: ${t.status ?? "不明"}、SP: ${t.sp ?? "不明"}）`)
        .join("\n");
      const syntheticAssistantMsg =
        `${threadState.assigneeName}さんへの進捗確認メッセージ:\n担当タスク:\n${taskList}`;
      conversationHistory = [
        { role: "assistant" as const, content: syntheticAssistantMsg }
      ];
    }

    // Process pending actions from parallel fetch result
    let pendingCreateTasks: Array<{ task_name: string; assignee: string; due: string; sp: number; status: string; project: string | null; description: string | null; sprint: string | null }> | null = null;
    let pendingUpdateActions: Array<{ action: string; page_id: string; task_name: string; new_value: string }> | null = null;
    const pendingCreateRef = pendingCreateRefResult;
    if (pendingCreateRef) {
      const oldPending = await getPendingAction(env.NOTIFY_CACHE, channel, pendingCreateRef.confirmMsgTs);
      if (oldPending) {
        const createActions = oldPending.actions.filter((a) => a.action === "create_task");
        if (createActions.length > 0) {
          pendingCreateTasks = createActions.map((a) => {
            const parsed = JSON.parse(a.new_value) as { task_name: string; assignee: string; due: string; sp: number; status: string; project?: string | null; description?: string | null; sprintId?: string; sprintName?: string | null };
            return {
              task_name: parsed.task_name,
              assignee: parsed.assignee,
              due: parsed.due,
              sp: parsed.sp,
              status: parsed.status,
              project: parsed.project ?? null,
              description: parsed.description ?? null,
              sprint: parsed.sprintName ?? null
            };
          });
        } else {
          // Pending update actions
          pendingUpdateActions = oldPending.actions;
        }
      } else {
        // Pending action no longer exists — clean up stale ref
        await deletePendingCreateRef(env.NOTIFY_CACHE, channel, threadTs);
      }
    }

    // Trim context data to keep LLM prompt within reasonable size
    // Thread context: limit each message to 500 chars, max 20 messages (keep first few + last few for TODO context)
    const trimmedThreadContext = threadContext
      ?.map((m) => ({ ...m, text: m.text.slice(0, 500) }))
      .slice(0, 20);
    // Channel context: limit each message to 300 chars, max 20 messages
    const trimmedChannelContext = channelContext
      ?.map((m) => ({ ...m, text: m.text.slice(0, 300) }))
      .slice(0, 20);
    // Reference items: limit content to 500 chars per section, max 10 sections
    const trimmedReferenceItems = referenceItems
      ?.map((r) => ({ ...r, content: r.content.slice(0, 500) }))
      .slice(0, 10);

    // スレッドで作成済みのタスク（スプリント未設定でcurrent_tasksに無いもの）を更新対象に含める
    const threadCreatedTasks = await getThreadCreatedTasks(env.NOTIFY_CACHE, channel, threadTs).catch(() => []);
    if (threadCreatedTasks.length > 0) {
      mentionContext.threadCreatedTasks = threadCreatedTasks;
      console.log(`Thread created tasks available for update: ${threadCreatedTasks.map((t) => t.taskName).join(", ")}`);
    }

    // タスクDBの実際のステータス選択肢をLLMに渡す（doing(20%) 等の曖昧指定マッピング用）
    const availableStatuses = await fetchTaskStatusOptions(config).catch(() => []);
    if (availableStatuses.length > 0) {
      mentionContext.availableStatuses = availableStatuses;
    }

    const result = await interpretMention(config, userText, summary, mentionContext, requestUserName, conversationHistory, pendingCreateTasks, pendingUpdateActions, trimmedThreadContext, trimmedChannelContext, trimmedReferenceItems);

    // Guard: if pending create tasks exist but LLM returned intent="update",
    // merge the update actions back into the pending create tasks.
    // Tasks don't exist in Notion yet, so update actions would fail with invalid page_id.
    if (pendingCreateTasks && pendingCreateTasks.length > 0 && result.intent === "update" && result.actions.length > 0) {
      console.log(`Converting update intent to create_task modification (${result.actions.length} actions on ${pendingCreateTasks.length} pending tasks)`);
      const actionMap: Record<string, string> = {};
      for (const act of result.actions) {
        actionMap[act.action] = act.new_value;
      }
      result.intent = "create_task";
      result.new_tasks = pendingCreateTasks.map((t) => ({
        task_name: t.task_name,
        assignee: actionMap["update_assignee"] ?? t.assignee,
        due: actionMap["update_due"] ?? t.due,
        sp: actionMap["update_sp"] ? Number(actionMap["update_sp"]) : t.sp,
        status: actionMap["update_status"] ?? t.status,
        project: actionMap["update_project"] !== undefined ? actionMap["update_project"] : t.project,
        description: t.description,
        sprint: actionMap["update_sprint"] !== undefined ? actionMap["update_sprint"] : t.sprint
      }));
      result.actions = [];
    }

    if (result.intent === "create_task" && result.new_tasks.length > 0) {
      // If modifying a pending create, clean up old pending action first
      if (pendingCreateRef) {
        await deletePendingAction(env.NOTIFY_CACHE, channel, pendingCreateRef.confirmMsgTs);
        await deletePendingCreateRef(env.NOTIFY_CACHE, channel, threadTs);
        console.log(`Cleaned up old pending create: confirmMsgTs=${pendingCreateRef.confirmMsgTs}`);
      }

      // ── 担当者を決定的に特定（ルール優先・曖昧時のみLLM） ───────────────
      // 優先順: ①本文の@メンション(Bot除く) ②本文走査でちょうど1人一致 ③「自分」=発言者
      // ①②③のいずれにも当たらなければ LLM 抽出の assignee をそのまま使う（フォールバック）。
      const assigneeResolver = makeAssigneeResolver(userCatalogResult);
      const mentionedName = extractMentionedMemberName(rawText, botUserId, userCatalogResult);
      const textAssignees = extractAssigneesFromText(userCatalogResult, userText);
      const ruleAssigneeName =
        mentionedName ?? (textAssignees.length === 1 ? textAssignees[0].name : undefined);
      for (const t of result.new_tasks) {
        if (ruleAssigneeName) {
          t.assignee = ruleAssigneeName;
        } else if (SELF_REFERENCE_RE.test((t.assignee ?? "").trim()) && requestUserName) {
          t.assignee = requestUserName;
        }
      }
      // 単一タスクで最終的な担当者名がカタログに解決できない → 後段で聞き返す。
      // ただしカタログが空(コールドスタート失敗等)のときは聞き返さず、承認時の解決に委ねる。
      const assigneeNeedsHearing =
        result.new_tasks.length === 1 &&
        userCatalogResult.length > 0 &&
        !assigneeResolver((result.new_tasks[0].assignee ?? "").trim());

      // プロジェクト名のルールベース抽出（本文走査）。ちょうど1件ならそれを採用。
      const ruleProjectMatches = extractProjectFromText(cachedProjectsResult, userText);

      // プロジェクト未マッチ時の聞き返し情報（単一タスクのみ保持）
      let projectSelection: { candidates: Array<{ id: string; name: string }>; query: string } | null = null;

      // Resolve projects and generate descriptions for each task, then build message in code
      const taskActions: Array<{ action: "create_task"; page_id: string; task_name: string; new_value: string }> = [];
      let needsDescriptionHearing = false;
      const taskBlocks: string[] = [];

      for (let i = 0; i < result.new_tasks.length; i++) {
        const newTask = result.new_tasks[i];
        // プロジェクトを決定的に解決（ルール優先・曖昧時のみLLM）:
        //   ① project="" → 明示的になし
        //   ② 本文走査でちょうど1件 → それを採用（ルールベース）
        //   ③ それ以外(0件/複数) → LLM抽出名 or チャンネル名にフォールバック
        // 未マッチ時は候補提示で聞き返す（スプリント多数決デフォルトは廃止）。
        let resolvedProjectIds: string[] = [];
        let projectDisplay: string | null = null;
        if (newTask.project === "") {
          resolvedProjectIds = [];
          projectDisplay = null;
        } else if (ruleProjectMatches.length === 1) {
          resolvedProjectIds = [ruleProjectMatches[0].id];
          projectDisplay = ruleProjectMatches[0].name;
        } else {
          const projRes = await resolveTaskProject(env.NOTIFY_CACHE, newTask.project, channelInfoResult.name ?? "", cachedProjectsResult);
          resolvedProjectIds = projRes.resolvedProjectIds;
          projectDisplay = projRes.projectDisplay;
          if (projRes.selection) {
            if (result.new_tasks.length === 1 && projRes.selection.candidates.length > 0) {
              projectSelection = projRes.selection;
              projectDisplay = "（候補から選択）";
            } else {
              // 複数タスク or 候補なし(カタログ空)時は聞き返さず未設定にする
              projectDisplay = "未設定（プロジェクト未特定）";
            }
          }
        }

        // Generate or carry over task description
        let taskDescription: string | null = null;
        if (pendingCreateTasks) {
          taskDescription = newTask.description ?? null;
        } else if (newTask.description) {
          taskDescription = newTask.description;
        } else if (result.new_tasks.length === 1) {
          try {
            const channelMsgs = await fetchChannelContext(config.slackBotToken, channel);
            if (channelMsgs.length > 0) {
              taskDescription = await generateTaskDescription(config, newTask.task_name, channelMsgs);
            }
          } catch (err) {
            console.warn(`Description generation failed: ${(err as Error).message}`);
          }
        }

        // Track if single-task creation needs description hearing
        if (!taskDescription && !pendingCreateTasks && result.new_tasks.length === 1) {
          needsDescriptionHearing = true;
        }

        // Resolve sprint from LLM output (null = backlog)
        let resolvedSprintId: string | undefined;
        let sprintDisplay: string | null = null;
        if (newTask.sprint) {
          const sprintVal = newTask.sprint.trim();
          const normalize = (s: string) => s.trim().toLowerCase().replace(/[\s\u3000]+/g, "");
          // Match sprint: prefer exact match, then prefix/suffix boundary match (avoid "S1" matching "S10")
          const nVal = normalize(sprintVal);
          const matchedSprint =
            allSprints.find(
              (s) =>
                s.id === sprintVal ||
                s.id.replace(/-/g, "") === sprintVal.replace(/-/g, "") ||
                normalize(s.name) === nVal
            ) ??
            allSprints.find((s) => {
              const nName = normalize(s.name);
              // Only allow substring match when the remaining part is NOT alphanumeric
              // e.g. "s10" includes "s1" but the next char is "0" (digit) → reject
              if (nName.includes(nVal)) {
                const idx = nName.indexOf(nVal);
                const after = nName[idx + nVal.length];
                return !after || !/[a-z0-9]/.test(after);
              }
              if (nVal.includes(nName)) {
                const idx = nVal.indexOf(nName);
                const after = nVal[idx + nName.length];
                return !after || !/[a-z0-9]/.test(after);
              }
              return false;
            });
          if (matchedSprint) {
            resolvedSprintId = matchedSprint.id;
            sprintDisplay = matchedSprint.name;
          } else {
            // Fallback: use current sprint if available
            const currentSprint = allSprints.find((s) => s.id === summary.sprint.id);
            if (currentSprint) {
              resolvedSprintId = currentSprint.id;
              sprintDisplay = `${currentSprint.name}（「${sprintVal}」→ 現スプリントに設定）`;
              console.log(`Sprint fuzzy fallback: "${sprintVal}" → current sprint "${currentSprint.name}"`);
            } else {
              sprintDisplay = `${sprintVal}（⚠️ 未検出）`;
            }
          }
        }
        // sprint が null → バックログ（sprintId なし）

        // Build task display block with description inline
        const label = result.new_tasks.length > 1 ? `【タスク${i + 1}】\n` : "";
        const lines = [
          `${label}・タスク名: *${newTask.task_name}*`,
          `・担当: ${newTask.assignee}`,
          `・期限: ${newTask.due}`,
          `・SP: ${newTask.sp}`,
          `・ステータス: ${newTask.status ?? "Backlog"}`
        ];
        lines.push(`・プロジェクト: ${projectDisplay ? `*${projectDisplay}*` : "未設定"}`);
        lines.push(`・スプリント: ${sprintDisplay ?? "未設定"}`);
        if (taskDescription) lines.push(`・📝 概要: ${taskDescription}`);
        taskBlocks.push(lines.join("\n"));

        taskActions.push({
          action: "create_task",
          page_id: "",
          task_name: newTask.task_name,
          new_value: JSON.stringify({
            ...newTask,
            ...(resolvedSprintId ? { sprintId: resolvedSprintId } : {}),
            sprintName: newTask.sprint,
            projectIds: resolvedProjectIds,
            ...(taskDescription ? { description: taskDescription } : {}),
            relevantUrls: result.relevant_urls ?? []
          })
        });
      }

      const responseText = `以下のタスクを追加します。問題なければ ✅ 承認ボタンを押してください:\n\n${taskBlocks.join("\n\n")}`;

      // ── 聞き返し①: 担当者が未解決（単一タスク）→ @メンション/名前で再指定を依頼 ──
      // taskActions を pending として保存しておけば、スレッド返信が handleMention に
      // 再投入され、pending_create_tasks 経由で担当者がマージ→再解決される。
      if (assigneeNeedsHearing) {
        const askText =
          `${userMention}このタスクの担当者を特定できませんでした 🙇\n` +
          `担当者を @メンション するか、お名前で教えてください。\n\n${responseText}`;
        const askMsg = await chatPostMessage(config.slackBotToken, channel, askText, undefined, threadTs);
        await savePendingAction(env.NOTIFY_CACHE, askMsg.channel, askMsg.ts, {
          actions: taskActions,
          requestedBy: userId,
          requestedAt: new Date().toISOString(),
          threadTs
        });
        await savePendingCreateRef(env.NOTIFY_CACHE, channel, threadTs, { confirmMsgTs: askMsg.ts });
        await appendMentionHistory(env.NOTIFY_CACHE, channel, threadTs, userText, askText);
        console.log(`Assignee hearing asked: task="${result.new_tasks[0].task_name}", ts=${askMsg.ts}`);
        return;
      }

      // ── 聞き返し②: プロジェクト未マッチ（単一タスク）→ 候補を提示して番号選択 ──
      if (projectSelection && projectSelection.candidates.length > 0) {
        const task0 = JSON.parse(taskActions[0].new_value) as {
          task_name: string; assignee: string; due: string; sp: number; status: string;
          sprintId?: string; sprintName?: string | null; description?: string; relevantUrls?: string[];
        };
        const candidates = projectSelection.candidates;
        const listText = candidates.map((c, idx) => `${idx + 1}. ${c.name}`).join("\n");
        const noteTrunc = cachedProjectsResult.length > candidates.length
          ? `\n（全${cachedProjectsResult.length}件中 上位${candidates.length}件を表示）`
          : "";
        const askText =
          `${userMention}「${projectSelection.query}」に対応するプロジェクトを特定できませんでした。\n` +
          `番号で選んでください（「キャンセル」で中止）:\n${listText}${noteTrunc}`;
        await chatPostMessage(config.slackBotToken, channel, askText, undefined, threadTs);
        await savePendingProjectSelection(env.NOTIFY_CACHE, channel, threadTs, {
          newTask: {
            task_name: task0.task_name,
            assignee: task0.assignee,
            due: task0.due,
            sp: task0.sp,
            status: task0.status,
            ...(task0.sprintId ? { sprintId: task0.sprintId } : {}),
            sprintName: task0.sprintName ?? null,
            ...(task0.description ? { description: task0.description } : {}),
            relevantUrls: task0.relevantUrls ?? []
          },
          candidates,
          requestedBy: userId,
          requestedAt: new Date().toISOString(),
          fallbackProjectIds: [],
          query: projectSelection.query
        });
        await appendMentionHistory(env.NOTIFY_CACHE, channel, threadTs, userText, askText);
        console.log(`Project selection asked: query="${projectSelection.query}", ${candidates.length} candidates`);
        return;
      }

      if (needsDescriptionHearing) {
        // Single task with no description — ask user for description
        const askMsg = await chatPostMessage(
          config.slackBotToken,
          channel,
          `${userMention}${responseText}\n\nこのタスクの概要を教えてください！背景や目的など、関連する情報があれば共有してください 📝\n（「概要なし」と返信すればスキップできます）`,
          undefined,
          threadTs
        );

        await savePendingAction(env.NOTIFY_CACHE, askMsg.channel, askMsg.ts, {
          actions: taskActions,
          requestedBy: userId,
          requestedAt: new Date().toISOString(),
          threadTs
        });

        await savePendingCreateRef(env.NOTIFY_CACHE, channel, threadTs, {
          confirmMsgTs: askMsg.ts
        });

        console.log(`Asking for task description: "${result.new_tasks[0].task_name}", ts=${askMsg.ts}`);
      } else {
        // Has description or multiple tasks — send confirmation with buttons
        const modifyHint = "_修正したい場合は、修正内容をこのスレッドに返信してください_";
        const createBlocks = [
          { type: "section", text: { type: "mrkdwn", text: `${userMention}${responseText}` } },
          { type: "section", text: { type: "mrkdwn", text: modifyHint } },
          ...buildApprovalButtons("task_action")
        ];
        const confirmMsg = await chatPostMessage(
          config.slackBotToken,
          channel,
          `${userMention}${responseText}`,
          createBlocks,
          threadTs
        );

        await savePendingAction(env.NOTIFY_CACHE, confirmMsg.channel, confirmMsg.ts, {
          actions: taskActions,
          requestedBy: userId,
          requestedAt: new Date().toISOString(),
          threadTs
        });

        await savePendingCreateRef(env.NOTIFY_CACHE, channel, threadTs, {
          confirmMsgTs: confirmMsg.ts
        });

        console.log(`Pending task creation saved: ${result.new_tasks.length} tasks, ts=${confirmMsg.ts}`);
      }
    } else if (result.intent === "create_task" && result.new_tasks.length === 0) {
      // Missing required fields — ask PM for more info
      await chatPostMessage(
        config.slackBotToken,
        channel,
        `${userMention}${result.response_text}`,
        undefined,
        threadTs
      );
    } else if (result.intent === "update" && result.actions.length > 0) {
      // If modifying a pending update, clean up old pending action first
      if (pendingCreateRef && pendingUpdateActions) {
        await deletePendingAction(env.NOTIFY_CACHE, channel, pendingCreateRef.confirmMsgTs);
        await deletePendingCreateRef(env.NOTIFY_CACHE, channel, threadTs);
        console.log(`Cleaned up old pending update: confirmMsgTs=${pendingCreateRef.confirmMsgTs}`);
      }

      // Resolve project names for update_project actions
      for (const act of result.actions) {
        if (act.action === "update_project" && act.new_value) {
          const candidates = await searchProjectsByName(config.notionToken, act.new_value, config.projectDbId);
          if (candidates.length > 0 && candidates[0].name !== act.new_value) {
            act.new_value = candidates[0].name;
          }
        }
      }

      // Build structured confirmation text in code (same pattern as create_task)
      const actionLabels: Record<string, string> = {
        update_assignee: "担当者",
        update_due: "期限",
        update_sp: "SP",
        update_status: "ステータス",
        update_sprint: "スプリント",
        update_project: "プロジェクト",
        append_description: "説明文追記"
      };
      const updateLines: string[] = [];
      for (const act of result.actions) {
        const label = actionLabels[act.action] ?? act.action;
        if (act.action === "append_description") {
          // Show truncated description preview
          const preview = act.new_value.length > 80 ? act.new_value.slice(0, 80) + "…" : act.new_value;
          updateLines.push(`・「${act.task_name}」: ${label}\n  「${preview}」`);
        } else {
          updateLines.push(`・「${act.task_name}」: ${label} → ${act.new_value}`);
        }
      }
      const updateResponseText = `以下の更新を実行します。問題なければ ✅ 承認ボタンを押してください:\n\n${updateLines.join("\n")}`;

      // Send confirmation message with explicitly constructed blocks (same as create_task)
      const updateModifyHint = "_修正したい場合は、修正内容をこのスレッドに返信してください_";
      const updateBlocks = [
        { type: "section", text: { type: "mrkdwn", text: `${userMention}${updateResponseText}` } },
        { type: "section", text: { type: "mrkdwn", text: updateModifyHint } },
        ...buildApprovalButtons("task_action")
      ];
      const confirmMsg = await chatPostMessage(
        config.slackBotToken,
        channel,
        `${userMention}${updateResponseText}`,
        updateBlocks,
        threadTs
      );

      await savePendingAction(env.NOTIFY_CACHE, confirmMsg.channel, confirmMsg.ts, {
        actions: result.actions,
        requestedBy: userId,
        requestedAt: new Date().toISOString(),
        threadTs
      });

      // Save thread-level reference so modifications can find this pending action
      await savePendingCreateRef(env.NOTIFY_CACHE, channel, threadTs, {
        confirmMsgTs: confirmMsg.ts
      });

      console.log(`Pending action saved: ${result.actions.length} actions, ts=${confirmMsg.ts}`);
    } else {
      // Query or unknown — just reply
      await chatPostMessage(
        config.slackBotToken,
        channel,
        `${userMention}${result.response_text}`,
        undefined,
        threadTs
      );
    }

    // Save conversation history for follow-up questions
    await appendMentionHistory(
      env.NOTIFY_CACHE,
      channel,
      threadTs,
      userText,
      result.response_text
    );
  } catch (err) {
    console.error("handleMention failed", (err as Error).message);
    await chatPostMessage(
      config.slackBotToken,
      channel,
      `${userMention}エラーが発生しました: ${(err as Error).message}`,
      undefined,
      threadTs
    );
  }
}

// ── Handle ☎️ phone reaction → send thread content as DM ────────────────

const PHONE_REACTIONS = ["phone", "telephone_receiver"];

async function handlePhoneReaction(
  env: Bindings,
  event: Record<string, unknown>
): Promise<void> {
  const userId = event.user as string;
  const item = event.item as Record<string, unknown>;
  const channel = item.channel as string;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;
  const messageTs = item.ts as string;

  console.log(`handlePhoneReaction: user=${userId}, channel=${channel}, messageTs=${messageTs}`);

  try {
    // Fetch only the reacted message (not the full thread)
    let messages: Awaited<ReturnType<typeof conversationsReplies>> = [];
    try {
      messages = await conversationsReplies(
        config.slackBotToken,
        channel,
        messageTs,
        1,
        true
      );
      if (messages.length > 1) messages = [messages[0]];
    } catch {
      console.log(`handlePhoneReaction: conversationsReplies failed for ${messageTs}, using link-only`);
    }

    const threadLink = `https://slack.com/archives/${channel}/p${messageTs.replace(".", "")}`;
    const messageContent = messages.length > 0
      ? `<@${messages[0].user}>: ${messages[0].text}`
      : "";

    const dmText =
      `☎️ *リマインド設定されたメッセージ*\n` +
      `<${threadLink}|メッセージを見る>\n\n` +
      (messageContent ? `───────────────\n${messageContent}\n───────────────\n\n` : "") +
      `_以下のボタンからリマインドまでの時間を選択してください。_`;

    // Open DM channel with user
    const dmChannelId = await conversationsOpen(config.slackBotToken, userId);
    if (!dmChannelId) {
      console.error(`handlePhoneReaction: Failed to open DM channel for user ${userId}`);
      return;
    }

    // Send DM with time selection buttons
    const dmResult = await chatPostMessage(
      config.slackBotToken,
      dmChannelId,
      dmText,
      [buildTimeSelectionButtons(userId, channel, messageTs)]
    );
    console.log(`handlePhoneReaction: DM sent to ${userId} in ${dmChannelId}, ts=${dmResult.ts}`);

    // Save reminder to KV (new format)
    const now = new Date().toISOString();
    await savePhoneReminder(env.NOTIFY_CACHE, userId, channel, messageTs, {
      userId,
      channel,
      threadTs: messageTs,
      messageContent,
      threadLink,
      createdAt: now,
      remindAt: "",
      dmChannel: dmChannelId,
      initialDmTs: dmResult.ts,
      status: "pending"
    });

    console.log(`handlePhoneReaction: reminder saved, user=${userId}, channel=${channel}, threadTs=${messageTs}`);
  } catch (err) {
    console.error(`handlePhoneReaction failed: user=${userId}, channel=${channel}, messageTs=${messageTs}`, err);
  }
}

// ── Handle reaction_removed (cancel ☎️ reminder) ────────────────────────

async function handleReactionRemoved(
  env: Bindings,
  event: Record<string, unknown>
): Promise<void> {
  const reaction = event.reaction as string;
  if (!PHONE_REACTIONS.includes(reaction)) return;

  const userId = event.user as string;
  const item = event.item as Record<string, unknown> | undefined;
  if (!item || item.type !== "message") return;

  const channel = item.channel as string;
  const messageTs = item.ts as string;

  await deletePhoneReminder(env.NOTIFY_CACHE, userId, channel, messageTs);
  console.log(`Phone reminder removed: user=${userId}, channel=${channel}, threadTs=${messageTs}`);

  // Notify user that reminder was cancelled
  const config = await resolveConfig(env, channel);
  if (config.slackBotToken) {
    const dmChannelId = await conversationsOpen(config.slackBotToken, userId);
    if (dmChannelId) {
      await chatPostMessage(
        config.slackBotToken,
        dmChannelId,
        "☎️ リマインドを解除しました。"
      );
    }
  }
}

// ── Handle ✅ reaction (reaction_added event) ──────────────────────────────

async function handleReactionAdded(
  env: Bindings,
  event: Record<string, unknown>
): Promise<void> {
  const reaction = event.reaction as string;

  const item = event.item as Record<string, unknown> | undefined;
  if (!item || item.type !== "message") return;

  const channel = item.channel as string;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;
  const messageTs = item.ts as string;

  console.log(`handleReactionAdded: reaction=${reaction}, channel=${channel}, messageTs=${messageTs}`);

  // ── ☎️ phone reaction → thread reminder DM ─────────────────────────────
  if (PHONE_REACTIONS.includes(reaction)) {
    await handlePhoneReaction(env, event);
    return;
  }

  // ✅ stamp approval has been deprecated — only ☎️ phone reaction is handled
}

// ── Handle assignee thread replies (message event in tracked thread) ───────

async function handleAssigneeReply(
  env: Bindings,
  event: Record<string, unknown>
): Promise<void> {
  // Skip bot messages (defensive: Slack may omit bot_id in edge cases)
  if (event.bot_id || event.bot_profile || !event.user) return;

  const channel = event.channel as string;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;
  const threadTs = event.thread_ts as string;
  const text = (event.text as string) ?? "";
  const user = (event.user as string) ?? "";

  const threadState = await getThreadState(env.NOTIFY_CACHE, channel, threadTs);
  if (!threadState) return;

  // Already replied — check for additional progress, otherwise treat as casual chat
  if (threadState.state === "replied") {
    let hasAdditionalProgress = false;
    try {
      hasAdditionalProgress = await evaluateAssigneeReply(
        config,
        text,
        threadState.assigneeName,
        threadState.tasks
      );
    } catch (err) {
      console.error("evaluateAssigneeReply failed (post-reply)", (err as Error).message);
    }

    if (hasAdditionalProgress) {
      await appendReply(env.NOTIFY_CACHE, channel, threadTs, {
        text,
        userId: user,
        receivedAt: new Date().toISOString()
      });
      await chatPostMessage(config.slackBotToken, channel, "追加情報ありがとうございます！反映しますね :+1:", undefined, threadTs);
      console.log(`Additional progress from ${threadState.assigneeName} in thread ${threadTs}`);
    } else {
      await chatPostMessage(config.slackBotToken, channel, "ありがとうございます！頑張ってくださいね :blush:", undefined, threadTs);
      console.log(`Casual reply from ${threadState.assigneeName} in thread ${threadTs} (already replied)`);
    }
    return;
  }

  // LLM judges if the reply is substantive
  let isValid = false;
  try {
    isValid = await evaluateAssigneeReply(
      config,
      text,
      threadState.assigneeName,
      threadState.tasks
    );
  } catch (err) {
    console.error("evaluateAssigneeReply failed, treating as valid", (err as Error).message);
    isValid = true; // fail-open so replies aren't lost
  }

  if (isValid) {
    // Good reply: save to KV, mark as replied, stop reminders
    await appendReply(env.NOTIFY_CACHE, channel, threadTs, {
      text,
      userId: user,
      receivedAt: new Date().toISOString()
    });
    await saveThreadState(env.NOTIFY_CACHE, channel, threadTs, {
      ...threadState,
      state: "replied"
    });
    await chatPostMessage(config.slackBotToken, channel, "確認できました！今日も頑張りましょう :muscle:", undefined, threadTs);
    console.log(`Valid reply from ${threadState.assigneeName} in thread ${threadTs}`);
  } else {
    // Insufficient reply: don't save, keep pending so reminders continue
    await chatPostMessage(config.slackBotToken, channel, "もう少し具体的にお願い！", undefined, threadTs);
    console.log(`Insufficient reply from ${threadState.assigneeName} in thread ${threadTs}`);
  }
}

// ── Handle PM DM thread reply (message event → Step 8) ────────────────────

async function handlePmReply(
  env: Bindings,
  event: Record<string, unknown>
): Promise<void> {
  // Skip bot messages (defensive: Slack may omit bot_id in edge cases)
  if (event.bot_id || event.bot_profile || !event.user) return;

  const channel = event.channel as string;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;
  const threadTs = event.thread_ts as string;
  const text = (event.text as string) ?? "";

  const today = toJstDateString();
  // Try channel-scoped PM thread first, then global (backward compat)
  let pmThread = await getPmThread(env.NOTIFY_CACHE, today, channel);
  let pmThreadScope: string | undefined = channel;
  if (!pmThread) {
    pmThread = await getPmThread(env.NOTIFY_CACHE, today);
    pmThreadScope = undefined;
  }

  if (
    !pmThread ||
    pmThread.state !== "pending" ||
    pmThread.channel !== channel ||
    pmThread.ts !== threadTs
  ) {
    return;
  }

  console.log(`PM replied in thread ${threadTs}; processing Step 8`);

  try {
    const proposal = JSON.parse(pmThread.proposalJson) as AllocationProposal;
    const actions = await interpretPmReply(config, proposal, text);

    // Build confirmation message for PM
    const actionLines = actions.actions
      .map((a) => `・${a.task_name}: ${a.action} → ${a.new_value}`)
      .join("\n");
    const confirmText =
      actions.actions.length > 0
        ? `以下の更新を実行します。問題なければ ✅ 承認ボタンを押してください:\n\n${actionLines}`
        : "更新する内容が見当たりませんでした。もう少し具体的に教えてください。";

    const pmConfirmBlocks = actions.actions.length > 0
      ? [
          { type: "section", text: { type: "mrkdwn", text: confirmText } },
          ...buildApprovalButtons("task_action")
        ]
      : undefined;
    const confirmMsg = await chatPostMessage(
      config.slackBotToken,
      channel,
      confirmText,
      pmConfirmBlocks,
      threadTs
    );

    if (actions.actions.length > 0) {
      // Save pending action keyed by the confirmation message ts
      await savePendingAction(env.NOTIFY_CACHE, confirmMsg.channel, confirmMsg.ts, {
        actions: actions.actions,
        requestedBy: (event.user as string) ?? "",
        requestedAt: new Date().toISOString()
      });
    }

    // Save back to the SAME scope key we read from + mark the other scope too
    console.log(`[PM-PROCESSED-BY] handlePmReply (thread reply), scope=${pmThreadScope}, channel=${channel}, threadTs=${threadTs}, text="${text.slice(0, 50)}"`)
    await savePmThread(env.NOTIFY_CACHE, today, { ...pmThread, state: "processed" }, undefined, pmThreadScope);
    if (pmThreadScope === undefined) {
      await savePmThread(env.NOTIFY_CACHE, today, { ...pmThread, state: "processed" }, undefined, channel);
    } else {
      await savePmThread(env.NOTIFY_CACHE, today, { ...pmThread, state: "processed" }, undefined, undefined);
    }
  } catch (err) {
    console.error("handlePmReply failed", (err as Error).message);
    await chatPostMessage(
      config.slackBotToken,
      channel,
      `❌ エラー: ${(err as Error).message}`,
      undefined,
      threadTs
    );
  }
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function handleSlackEvents(
  request: Request,
  env: Bindings,
  ctx?: ExecutionContext
): Promise<Response> {
  const body = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";

  // Parse body first (needed for url_verification)
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // URL verification — no signature check needed
  if (payload.type === "url_verification") {
    return new Response(
      JSON.stringify({ challenge: payload.challenge }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // Ignore Slack retries (X-Slack-Retry-Num > 0)
  const retryNum = request.headers.get("x-slack-retry-num");
  if (retryNum && parseInt(retryNum, 10) > 0) {
    return new Response("ok");
  }

  // Replay attack prevention
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parseInt(timestamp, 10)) > 300) {
    return new Response("Request timestamp too old", { status: 400 });
  }

  // Signature verification
  const config = getConfig(env);
  if (!config.slackSigningSecret) {
    console.error("SLACK_SIGNING_SECRET not configured");
    return new Response("Server configuration error", { status: 500 });
  }

  const isValid = await verifySlackSignature(
    body,
    timestamp,
    signature,
    config.slackSigningSecret
  );
  if (!isValid) {
    return new Response("Invalid signature", { status: 401 });
  }

  if (payload.type !== "event_callback") {
    return new Response("ok");
  }

  const event = (payload.event as Record<string, unknown>) ?? {};
  const eventType = event.type as string | undefined;
  const botId = event.bot_id as string | undefined;
  const subtype = event.subtype as string | undefined;

  // Extract bot user ID from Slack authorizations for accurate mention detection
  const authorizations = payload.authorizations as Array<{ user_id: string }> | undefined;
  const botUserId = authorizations?.[0]?.user_id;

  // Helper: run long-running work that survives past the Response.
  // Uses a deferred Response pattern so that the fetch handler stays open
  // (Cloudflare keeps the Worker alive as long as the Response hasn't been
  // fully sent — we stream a delayed body to keep it open for up to 5 min).
  const respondAndProcess = (work: (env: Bindings) => Promise<void>): Response => {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    const task = (async () => {
      try {
        await work(env);
      } catch (err) {
        console.error("bg task failed:", err);
      } finally {
        // Write "ok" and close — Slack ignores the body for 200 responses
        await writer.write(new TextEncoder().encode("ok"));
        await writer.close();
      }
    })();

    // ctx.waitUntil as a safety net (not the primary mechanism)
    if (ctx) ctx.waitUntil(task);

    return new Response(readable, {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    });
  };

  // ── reaction_added ──────────────────────────────────────────────────────
  if (eventType === "reaction_added") {
    return respondAndProcess(() => handleReactionAdded(env, event));
  }

  // ── reaction_removed (cancel ☎️ reminder) ──────────────────────────────
  if (eventType === "reaction_removed") {
    return respondAndProcess(() => handleReactionRemoved(env, event));
  }

  // ── app_mention ─────────────────────────────────────────────────────────
  if (eventType === "app_mention" && !botId) {
    return respondAndProcess(() => handleMention(env, event, botUserId));
  }

  // ── message (thread replies only, not from bots) ────────────────────────
  // Also filter by event.user: Slack may deliver bot messages without bot_id in edge cases
  const eventUserId = event.user as string | undefined;
  const isSelfMessage = botUserId ? eventUserId === botUserId : false;
  if (eventType === "message" && !botId && !subtype && !isSelfMessage) {
    const threadTs = event.thread_ts as string | undefined;
    const channel = event.channel as string | undefined;

    if (channel && threadTs) {
      const rawText = (event.text as string) ?? "";
      // Check if the bot itself is mentioned (not just any @mention)
      const isBotMentioned = botUserId
        ? rawText.includes(`<@${botUserId}>`)
        : /<@[A-Z0-9]+>/.test(rawText); // fallback if authorizations unavailable

      if (!isBotMentioned) {
        return respondAndProcess(async () => {
          const handled = await handleProjectSelectionReply(env, event);
          if (!handled) {
            const createRef = await getPendingCreateRef(env.NOTIFY_CACHE, channel, threadTs);
            if (createRef) {
              await handleMention(env, event, botUserId);
            } else {
              await handleAssigneeReply(env, event);
              await handlePmReply(env, event);
            }
          }
        });
      }
      // isBotMentioned === true → app_mention handler will process this
    }
  }

  return new Response("ok");
}
