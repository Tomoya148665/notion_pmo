import type { Bindings } from "./config";
import { getConfig, resolveTeamKChannelId } from "./config";
import { resolveConfig } from "./channelConfig";
import { chatPostMessage, chatUpdate, conversationsOpen, conversationsReplies, bulletListBlocks, viewsOpen } from "./slackBot";
import {
  getPendingAction,
  deletePendingAction,
  deletePendingCreateRef,
  getPmThread,
  savePmThread,
  getThreadState,
  saveThreadState,
  toJstDateString,
  appendReply,
  savePhoneReminder,
  getPhoneReminder,
  deletePhoneReminder,
  appendThreadCreatedTasks,
  getCurrentTaskThread,
  saveCurrentTaskThread,
  saveTaskSnapshot,
  claimTaskCreation,
  getDailyCheckinSession,
  markDailyCheckinDone,
  getSprintPlanLockSession,
  saveSprintPlanBaseline,
  getSprintPlanBaseline,
  type DailyCheckinSession,
  type DailyCheckinTask
} from "./workflow";
import {
  executeNotionActions,
  executeTaskCreation,
  sendCompletionNotification
} from "./slackEvents";
import { ensureUserCatalog, makeAssigneeResolver, type AssigneeResolver } from "./userCatalog";
import { interpretPmReply } from "./llmAnalyzer";
import {
  fetchNotionUserMap,
  buildUserMapFromDatabase,
  appendPageContent,
  appendLinksToPage,
  updateTaskPage,
  appendDailyUpdateLog,
  updateTaskSprintClass
} from "./notionWriter";
import { fetchTaskPropertiesById } from "./notionApi";
import type { AllocationProposal, NewTask } from "./schema";

// ── HMAC-SHA256 signature verification (same as slackEvents) ───────────────

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

// ── Block Kit button builders ──────────────────────────────────────────────

/** Build an actions block with approve/cancel buttons for task or update confirmation */
export function buildApprovalButtons(actionIdPrefix: string): unknown[] {
  return [
    {
      type: "actions",
      block_id: `${actionIdPrefix}_buttons`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ 承認", emoji: true },
          style: "primary",
          action_id: `${actionIdPrefix}_approve`
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ キャンセル", emoji: true },
          style: "danger",
          action_id: `${actionIdPrefix}_cancel`
        }
      ]
    }
  ];
}

/** Build buttons for PM report approval */
export function buildPmReportButtons(): unknown[] {
  return [
    {
      type: "actions",
      block_id: "pm_report_buttons",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ OK", emoji: true },
          style: "primary",
          action_id: "pm_report_approve"
        }
      ]
    }
  ];
}

/** Build buttons for EOD reminder */
export function buildEodReminderButtons(): unknown[] {
  return [
    {
      type: "actions",
      block_id: "eod_reminder_buttons",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ 更新済み", emoji: true },
          style: "primary",
          action_id: "eod_updated"
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🔄 作業中", emoji: true },
          action_id: "eod_in_progress"
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🚫 今日は進捗なし", emoji: true },
          action_id: "eod_no_progress"
        }
      ]
    }
  ];
}

/** 担当者別Daily Updateモーダルを開く。 */
export function buildDailyCheckinButton(sessionId: string): unknown[] {
  return [
    {
      type: "actions",
      block_id: "daily_checkin_buttons",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "⏱️ 30秒で更新", emoji: true },
          style: "primary",
          action_id: "daily_checkin_open",
          value: sessionId
        }
      ]
    }
  ];
}

/** Sprint Planning DraftをPMが確定する。 */
export function buildSprintPlanLockButton(sessionId: string): unknown[] {
  return [
    {
      type: "actions",
      block_id: "sprint_plan_lock_buttons",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🔒 計画をロック", emoji: true },
          style: "primary",
          action_id: "sprint_plan_lock",
          value: sessionId,
          confirm: {
            title: { type: "plain_text", text: "Sprint計画を確定" },
            text: { type: "mrkdwn", text: "Commit/Stretch案をNotionへ反映し、この時点をScope baselineとして保存します。" },
            confirm: { type: "plain_text", text: "ロックする" },
            deny: { type: "plain_text", text: "戻る" }
          }
        }
      ]
    }
  ];
}

/** Build time selection buttons for phone reminder */
export function buildTimeSelectionButtons(
  userId: string,
  channel: string,
  threadTs: string
): unknown {
  return {
    type: "actions",
    block_id: "phone_time_select",
    elements: [1, 3, 6, 24].map(h => ({
      type: "button",
      text: { type: "plain_text", text: `${h}時間`, emoji: true },
      action_id: `phone_reminder_schedule_${h}`,
      value: JSON.stringify({ hours: h, userId, channel, threadTs })
    }))
  };
}

/** Build reminder delivery buttons (stop + reschedule) */
export function buildReminderDeliveryButtons(
  userId: string,
  channel: string,
  threadTs: string
): unknown {
  return {
    type: "actions",
    block_id: "phone_reminder_actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "リマインド終了", emoji: true },
        style: "danger",
        action_id: "phone_reminder_stop",
        value: JSON.stringify({ userId, channel, threadTs })
      },
      ...[1, 3, 6, 24].map(h => ({
        type: "button",
        text: { type: "plain_text", text: `${h}時間`, emoji: true },
        action_id: `phone_reminder_schedule_${h}`,
        value: JSON.stringify({ hours: h, userId, channel, threadTs })
      }))
    ]
  };
}

/** Build a text section block from text */
function textSection(text: string): unknown {
  return {
    type: "section",
    text: { type: "mrkdwn", text }
  };
}

// ── Interactive payload handler ────────────────────────────────────────────

interface SlackInteractionPayload {
  type: string;
  callback_id?: string;
  user: { id: string; username?: string };
  channel: { id: string };
  message: {
    ts: string;
    text: string;
    user?: string;
    blocks?: unknown[];
    thread_ts?: string;
  };
  actions?: Array<{
    type: string;
    action_id: string;
    value?: string;
    block_id?: string;
  }>;
  trigger_id: string;
  response_url?: string;
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: {
      values?: Record<string, Record<string, {
        type?: string;
        value?: string;
        selected_option?: { value?: string };
      }>>;
    };
  };
}

export async function handleSlackInteractions(
  request: Request,
  env: Bindings,
  ctx?: ExecutionContext
): Promise<Response> {
  const body = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";

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

  // Parse URL-encoded payload
  const params = new URLSearchParams(body);
  const payloadStr = params.get("payload");
  if (!payloadStr) {
    return new Response("Missing payload", { status: 400 });
  }

  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(payloadStr) as SlackInteractionPayload;
  } catch {
    return new Response("Invalid payload JSON", { status: 400 });
  }

  // Background processing
  const bg = (work: Promise<void>) => {
    if (ctx) {
      ctx.waitUntil(work.catch((err) => console.error("interaction bg task failed:", err)));
    } else {
      return work;
    }
    return Promise.resolve();
  };

  // ── Message shortcut (message_action) ──────────────────────────────────
  if (payload.type === "message_action") {
    if (payload.callback_id === "set_reminder") {
      await bg(handleSetReminderShortcut(env, payload));
    }
    return new Response("ok");
  }

  // ── Modal submissions (view_submission) ─────────────────────────────────
  if (payload.type === "view_submission") {
    if (payload.view?.callback_id === "daily_checkin_submit") {
      return await handleDailyCheckinSubmission(env, payload, ctx);
    }
    return new Response("ok");
  }

  // ── Button clicks (block_actions) ──────────────────────────────────────
  if (payload.type !== "block_actions") {
    return new Response("ok");
  }

  const action = payload.actions?.[0];
  if (!action) return new Response("ok");

  const actionId = action.action_id;

  // Determine the handler for this action
  let handler: Promise<void> | null = null;

  if (actionId === "task_action_approve" || actionId === "task_action_cancel") {
    handler = handleTaskActionButton(env, payload, actionId === "task_action_approve");
  } else if (actionId === "pm_report_approve") {
    handler = handlePmReportButton(env, payload);
  } else if (actionId.startsWith("eod_")) {
    handler = handleEodButton(env, payload, actionId);
  } else if (actionId.startsWith("phone_reminder_schedule")) {
    handler = handleReminderScheduleButton(env, payload, action);
  } else if (actionId === "phone_reminder_stop") {
    handler = handleReminderStopButton(env, payload, action);
  } else if (actionId === "daily_checkin_open") {
    handler = handleDailyCheckinOpenButton(env, payload, action);
  } else if (actionId === "sprint_plan_lock") {
    handler = handleSprintPlanLockButton(env, payload, action);
  }

  if (!handler) {
    return new Response("ok");
  }

  // Respond to Slack immediately (must ack within 3s or user sees timeout error).
  // The actual work runs in ctx.waitUntil and updates the original message via chatUpdate when done.
  const task = handler.catch((err) => {
    console.error("interaction handler failed:", err);
  });
  if (ctx) ctx.waitUntil(task);
  return new Response("");
}

// ── 30秒 Daily Update ─────────────────────────────────────────────────────

function modalValue(
  payload: SlackInteractionPayload,
  blockId: string,
  actionId: string
): string {
  const input = payload.view?.state?.values?.[blockId]?.[actionId];
  return input?.selected_option?.value ?? input?.value ?? "";
}

function dailyCheckinModal(
  sessionId: string,
  tasks: Array<{ id: string; name: string; status: string | null }>
): unknown {
  const statusOptions = [
    "doing(20%)",
    "doing(40%)",
    "doing(60%)",
    "doing(80%)",
    "他者ボール・レビュー中",
    "ペンディング",
    "完了"
  ];
  return {
    type: "modal",
    callback_id: "daily_checkin_submit",
    private_metadata: sessionId,
    title: { type: "plain_text", text: "30秒 Daily Update" },
    submit: { type: "plain_text", text: "Notionへ反映" },
    close: { type: "plain_text", text: "キャンセル" },
    blocks: [
      {
        type: "input",
        block_id: "daily_task",
        label: { type: "plain_text", text: "更新するタスク" },
        element: {
          type: "static_select",
          action_id: "task",
          placeholder: { type: "plain_text", text: "タスクを選択" },
          options: tasks.slice(0, 100).map((task) => ({
            text: { type: "plain_text", text: task.name.slice(0, 75) || "(no title)" },
            value: task.id
          }))
        }
      },
      {
        type: "input",
        block_id: "daily_status",
        label: { type: "plain_text", text: "今日時点の進捗" },
        element: {
          type: "static_select",
          action_id: "status",
          options: statusOptions.map((status) => ({
            text: { type: "plain_text", text: status },
            value: status
          }))
        }
      },
      {
        type: "input",
        block_id: "daily_actual",
        label: { type: "plain_text", text: "累積の実績工数(h)" },
        element: {
          type: "plain_text_input",
          action_id: "actual",
          placeholder: { type: "plain_text", text: "例: 6.5" }
        }
      },
      {
        type: "input",
        block_id: "daily_remaining",
        label: { type: "plain_text", text: "現在の残工数(h)" },
        element: {
          type: "plain_text_input",
          action_id: "remaining",
          placeholder: { type: "plain_text", text: "例: 2" }
        }
      },
      {
        type: "input",
        optional: true,
        block_id: "daily_blocker",
        label: { type: "plain_text", text: "ブロッカー（なければ空欄）" },
        element: {
          type: "plain_text_input",
          action_id: "blocker",
          multiline: true
        }
      },
      {
        type: "input",
        optional: true,
        block_id: "daily_evidence",
        label: { type: "plain_text", text: "Evidence URL" },
        element: {
          type: "url_text_input",
          action_id: "evidence",
          placeholder: { type: "plain_text", text: "成果物・PR・資料のURL" }
        }
      },
      {
        type: "input",
        optional: true,
        block_id: "daily_next",
        label: { type: "plain_text", text: "次にやること" },
        element: {
          type: "plain_text_input",
          action_id: "next",
          multiline: true
        }
      }
    ]
  };
}

async function handleDailyCheckinOpenButton(
  env: Bindings,
  payload: SlackInteractionPayload,
  action: { value?: string }
): Promise<void> {
  const sessionId = action.value ?? "";
  const session = await getDailyCheckinSession(env.NOTIFY_CACHE, sessionId);
  const channel = payload.channel.id;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;
  if (!session) {
    await chatPostMessage(config.slackBotToken, channel, "⚠️ Daily Updateの有効期限が切れています。最新のボタンを使ってください。", undefined, payload.message.thread_ts ?? payload.message.ts);
    return;
  }
  if (session.slackUserId && session.slackUserId !== payload.user.id) {
    await chatPostMessage(config.slackBotToken, channel, `⚠️ この更新ボタンは <@${session.slackUserId}> 専用です。`, undefined, session.threadTs);
    return;
  }
  await viewsOpen(
    config.slackBotToken,
    payload.trigger_id,
    dailyCheckinModal(session.id, session.tasks)
  );
}

async function handleDailyCheckinSubmission(
  env: Bindings,
  payload: SlackInteractionPayload,
  ctx?: ExecutionContext
): Promise<Response> {
  const sessionId = payload.view?.private_metadata ?? "";
  const session = await getDailyCheckinSession(env.NOTIFY_CACHE, sessionId);
  const errors: Record<string, string> = {};
  if (!session) {
    errors.daily_task = "有効期限が切れています。最新のDaily Updateボタンを使ってください。";
  } else if (session.slackUserId && session.slackUserId !== payload.user.id) {
    errors.daily_task = "このフォームは別の担当者用です。";
  } else if (session.date !== toJstDateString()) {
    errors.daily_task = "日付が変わりました。今日のDaily Updateボタンを使ってください。";
  }

  const taskId = modalValue(payload, "daily_task", "task");
  const status = modalValue(payload, "daily_status", "status");
  const actualText = modalValue(payload, "daily_actual", "actual").trim();
  const remainingText = modalValue(payload, "daily_remaining", "remaining").trim();
  const blocker = modalValue(payload, "daily_blocker", "blocker").trim();
  const evidence = modalValue(payload, "daily_evidence", "evidence").trim();
  const nextAction = modalValue(payload, "daily_next", "next").trim();
  const actualHours = Number(actualText);
  const remainingHours = status === "完了" ? 0 : Number(remainingText);
  const task = session?.tasks.find((item) => item.id === taskId);

  if (!task) errors.daily_task = errors.daily_task ?? "更新対象のタスクを選択してください。";
  if (!Number.isFinite(actualHours) || actualHours < 0) {
    errors.daily_actual = "0以上の数値で入力してください。";
  }
  if (!Number.isFinite(remainingHours) || remainingHours < 0) {
    errors.daily_remaining = "0以上の数値で入力してください。";
  }
  if (status === "ペンディング" && !blocker) {
    errors.daily_blocker = "ペンディング理由と、解除に必要なことを入力してください。";
  }
  const requiresEvidence = /doing\((60|80)%\)|レビュー|他者ボール|完了/iu.test(status);
  if (requiresEvidence && !evidence && !task?.evidenceUrl) {
    errors.daily_evidence = "60%以上・レビュー・完了ではEvidence URLが必要です。";
  }
  if (evidence && !/^https?:\/\//i.test(evidence)) {
    errors.daily_evidence = "http:// または https:// で始まるURLを入力してください。";
  }

  if (Object.keys(errors).length > 0) {
    return new Response(JSON.stringify({ response_action: "errors", errors }), {
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  const work = processDailyCheckinSubmission(env, payload.user.id, session!, task!, {
    status,
    actualHours,
    remainingHours,
    blocker,
    evidence,
    nextAction
  }).catch((error) => console.error("daily checkin submission failed:", error));
  if (ctx) ctx.waitUntil(work);
  else await work;
  return new Response("");
}

async function processDailyCheckinSubmission(
  env: Bindings,
  slackUserId: string,
  session: DailyCheckinSession,
  task: DailyCheckinTask,
  input: {
    status: string;
    actualHours: number;
    remainingHours: number;
    blocker: string;
    evidence: string;
    nextAction: string;
  }
): Promise<void> {
  const config = await resolveConfig(env, session.channel);
  if (!config.slackBotToken) return;
  await updateTaskPage(config.notionToken, task.id, {
    status: input.status,
    actualHours: input.actualHours,
    remainingHours: input.remainingHours,
    progressUpdatedDate: session.date,
    completedDate: input.status === "完了" ? session.date : undefined,
    blocker: input.blocker,
    blockerStartedAt: input.blocker ? task.blockerStartedAt ?? session.date : null,
    evidenceUrl: input.evidence || undefined
  });
  await appendDailyUpdateLog(config.notionToken, task.id, {
    date: session.date,
    status: input.status,
    nextAction: input.nextAction
  }).catch(() => {});
  await markDailyCheckinDone(env.NOTIFY_CACHE, session.date, task.id);
  await chatPostMessage(
    config.slackBotToken,
    session.channel,
    `✅ <@${slackUserId}> が <${task.url}|${task.name}> を更新しました｜${input.status}｜実績 ${input.actualHours}h｜残 ${input.remainingHours}h${input.blocker ? `｜Blocker: ${input.blocker}` : ""}`,
    undefined,
    session.threadTs
  );
}

// ── Sprint計画Lock ────────────────────────────────────────────────────────

async function handleSprintPlanLockButton(
  env: Bindings,
  payload: SlackInteractionPayload,
  action: { value?: string }
): Promise<void> {
  const session = await getSprintPlanLockSession(env.NOTIFY_CACHE, action.value ?? "");
  const channel = payload.channel.id;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;
  if (!session) {
    await chatPostMessage(config.slackBotToken, channel, "⚠️ Planning Draftの有効期限が切れています。もう一度生成してください。", undefined, payload.message.thread_ts ?? payload.message.ts);
    return;
  }
  if (session.channel !== channel) {
    await chatPostMessage(config.slackBotToken, channel, "⚠️ このPlanning Draftは別チャンネル用です。", undefined, payload.message.thread_ts ?? payload.message.ts);
    return;
  }
  if (config.slackPmUserId && payload.user.id !== config.slackPmUserId) {
    await chatPostMessage(config.slackBotToken, channel, `⚠️ 計画LockはPM <@${config.slackPmUserId}> のみ実行できます。`, undefined, session.threadTs ?? session.messageTs);
    return;
  }
  const existingBaseline = await getSprintPlanBaseline(
    env.NOTIFY_CACHE,
    session.baseline.sprintId
  );
  if (existingBaseline?.lockedAt) {
    await chatPostMessage(
      config.slackBotToken,
      channel,
      `🔒 ${existingBaseline.sprintName} は既に <@${existingBaseline.lockedBy}> が計画Lock済みです。`,
      undefined,
      session.threadTs ?? session.messageTs
    );
    return;
  }

  const baseline = {
    ...session.baseline,
    lockedAt: new Date().toISOString(),
    lockedBy: payload.user.id,
    tasks: session.baseline.tasks.map((task) => ({
      ...task,
      sprintClass: task.recommendedClass
    }))
  };
  for (const task of session.baseline.tasks) {
    if (task.sprintClass !== "Commit" && task.sprintClass !== "Stretch") {
      await updateTaskSprintClass(config.notionToken, task.id, task.recommendedClass);
    }
  }
  await saveSprintPlanBaseline(env.NOTIFY_CACHE, baseline);
  const blocksWithoutActions = (payload.message.blocks ?? []).filter(
    (block: unknown) => (block as Record<string, unknown>).type !== "actions"
  );
  const lockedText = `🔒 <@${payload.user.id}> がSprint計画をロックしました｜Baseline ${baseline.totalSp}SP / ${baseline.totalHours}h`;
  await chatUpdate(
    config.slackBotToken,
    channel,
    payload.message.ts,
    `${payload.message.text}\n\n${lockedText}`,
    [...blocksWithoutActions, textSection(lockedText)]
  );
  await chatPostMessage(config.slackBotToken, channel, lockedText, undefined, session.threadTs ?? session.messageTs);
}

// ── Task/Update approval button handler ────────────────────────────────────

async function handleTaskActionButton(
  env: Bindings,
  payload: SlackInteractionPayload,
  approved: boolean
): Promise<void> {
  const channel = payload.channel.id;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;
  const messageTs = payload.message.ts;
  const threadTs = payload.message.thread_ts;
  const userId = payload.user.id;

  const pending = await getPendingAction(env.NOTIFY_CACHE, channel, messageTs);
  if (!pending) {
    console.log(`Button click but no pending action found: channel=${channel} ts=${messageTs}`);
    return;
  }

  // Remove buttons from the original message
  const originalText = payload.message.text;
  const blocksWithoutActions = (payload.message.blocks ?? []).filter(
    (b: unknown) => (b as Record<string, unknown>).type !== "actions"
  );

  if (!approved) {
    // Cancel: update message to show cancelled state, delete pending action
    await chatUpdate(
      config.slackBotToken,
      channel,
      messageTs,
      originalText + "\n\n❌ キャンセルされました",
      [
        ...blocksWithoutActions,
        textSection(`❌ <@${userId}> がキャンセルしました`)
      ]
    );
    await deletePendingAction(env.NOTIFY_CACHE, channel, messageTs);
    if (pending.threadTs) {
      await deletePendingCreateRef(env.NOTIFY_CACHE, channel, pending.threadTs);
    }
    console.log(`Action cancelled by ${userId}: channel=${channel} ts=${messageTs}`);
    return;
  }

  // Approved: まず即座にボタンを消して「処理中」を表示する。
  // この後の Notion 処理は数秒かかるため、押した人へのフィードバックと
  // 二重クリックによる重複起票の防止を兼ねる。完了後に下の chatUpdate が結果で上書きする。
  await chatUpdate(
    config.slackBotToken,
    channel,
    messageTs,
    originalText + "\n\n⏳ 処理中です…",
    [
      ...blocksWithoutActions,
      textSection(`⏳ <@${userId}> が承認しました — 処理中です…`)
    ]
  );

  // Approved: execute actions
  const createActions = pending.actions.filter((a) => a.action === "create_task");

  if (createActions.length > 0) {
    // Task creation flow
    const dbUserMap = config.taskDbId
      ? await buildUserMapFromDatabase(config.notionToken, config.taskDbId)
      : new Map<string, string>();
    const notionUserMap = await fetchNotionUserMap(config.notionToken);
    const userMaps = { dbUserMap, notionUserMap };

    // Assignee resolver from the cached user catalog (no live Slack/Notion user crawl)
    const resolveAssignee = makeAssigneeResolver(await ensureUserCatalog(env, config));

    const taskResults = await Promise.all(
      createActions.map(async (createAction) => {
        const newTask = JSON.parse(createAction.new_value) as NewTask & {
          sprintId?: string;
          projectIds?: string[];
          project?: string | null;
          description?: string;
          relevantUrls?: string[];
        };
        // 冪等化: 同一スレッド+タスク名の二重作成を防ぐ（訂正リプライ連投で確認が並存するケース）
        const dedupThreadKey = threadTs ?? pending.threadTs ?? messageTs;
        const claimed = await claimTaskCreation(env.NOTIFY_CACHE, channel, dedupThreadKey, newTask.task_name);
        if (!claimed) {
          console.warn(`Skip duplicate task creation: "${newTask.task_name}" in thread ${dedupThreadKey}`);
          return { result: { message: `⚠️ 「${newTask.task_name}」は直近に作成済みのため重複作成をスキップしました`, pageId: undefined as string | undefined }, newTask };
        }
        const result = await executeTaskCreation(
          {
            notionToken: config.notionToken,
            taskDbId: config.taskDbId,
            taskSprintRelationProperty: config.taskSprintRelationProperty,
            dryRun: config.dryRun,
            memberExclude: config.memberExclude,
            memberExtra: config.memberExtra
          },
          newTask,
          userMaps,
          resolveAssignee
        );

        if (result.pageId && newTask.description) {
          try {
            await appendPageContent(config.notionToken, result.pageId, newTask.description);
          } catch (err) {
            console.warn(`Failed to append description: ${(err as Error).message}`);
          }
        }

        // Append Slack thread URL and relevant URLs to Notion page
        if (result.pageId) {
          const slackThreadUrl = `https://slack.com/archives/${channel}/p${(threadTs ?? messageTs).replace(".", "")}`;
          try {
            await appendLinksToPage(config.notionToken, result.pageId, slackThreadUrl, newTask.relevantUrls ?? []);
          } catch (err) {
            console.warn(`Failed to append links: ${(err as Error).message}`);
          }
        }

        return { result, newTask };
      })
    );

    const allResults = taskResults.map((r) => r.result.message);

    await deletePendingAction(env.NOTIFY_CACHE, channel, messageTs);
    if (pending.threadTs) {
      await deletePendingCreateRef(env.NOTIFY_CACHE, channel, pending.threadTs);
    }

    // 作成したタスクの page_id をスレッド単位で記憶（後続の「担当者変更」等で参照できるように）
    const threadKey = threadTs ?? pending.threadTs ?? messageTs;
    const createdForThread = taskResults
      .filter((r) => r.result.pageId)
      .map((r) => ({ pageId: r.result.pageId as string, taskName: r.newTask.task_name }));
    if (createdForThread.length > 0) {
      await appendThreadCreatedTasks(env.NOTIFY_CACHE, channel, threadKey, createdForThread).catch(() => {});
      console.log(`Saved ${createdForThread.length} created task(s) for thread ${threadKey}`);
    }

    // Update original message: remove buttons, add result
    await chatUpdate(
      config.slackBotToken,
      channel,
      messageTs,
      originalText + "\n\n" + allResults.join("\n\n"),
      [
        ...blocksWithoutActions,
        textSection(`✅ <@${userId}> が承認しました\n\n${allResults.join("\n\n")}`)
      ]
    );

    // タスク追加通知（当日 MMDD_タスク スレッドに投稿）
    const pmoChannel = resolveTeamKChannelId(env);
    if (pmoChannel && !config.dryRun) {
      let taskThread = await getCurrentTaskThread(env.NOTIFY_CACHE, pmoChannel).catch(() => null);

      // スレッドが未作成の場合は MMDD_タスク 親メッセージを新規作成して保存
      if (!taskThread) {
        const now = new Date();
        const jstDate = toJstDateString(now);
        const dateLabel = jstDate.slice(5).replace("-", "/"); // "MM/DD"
        const parent = await chatPostMessage(config.slackBotToken, pmoChannel, `${dateLabel}_タスク`).catch(() => null);
        if (parent?.ts) {
          taskThread = parent.ts;
          await saveCurrentTaskThread(env.NOTIFY_CACHE, pmoChannel, taskThread).catch(() => {});
        }
      }

      const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
      const fmtDue = (due: string | null | undefined): string => {
        if (!due) return "-";
        const d = new Date(`${due}T00:00:00+09:00`);
        const m = d.getMonth() + 1;
        const day = d.getDate();
        const w = WEEKDAYS[d.getDay()];
        return `${m}/${day}(${w})`;
      };
      // タイトル行 + rich_text_list で箇条書き（タスクごとにブロックを分ける）
      const taskBulletSets = taskResults.map((r) => {
        const t = r.newTask;
        const proj = t.project ? t.project : "-";
        return {
          title: `✅ タスク追加`,
          bullet: `追加「${t.task_name}」（担当：${t.assignee}、Prj：${proj}、期限：${fmtDue(t.due)}、SP：${t.sp}）`,
        };
      });
      const fallback = taskBulletSets.map((s) => `${s.title}\n${s.bullet}`).join("\n\n");
      const blocks = taskBulletSets.flatMap((s) => bulletListBlocks(s.title, [s.bullet]));
      await chatPostMessage(config.slackBotToken, pmoChannel, fallback, blocks, taskThread ?? undefined);

      // 起票したタスクの snapshot を Notion 正式値で保存 → 以降の更新を webhook が当日スレッドに通知できる
      if (taskThread) {
        for (const r of taskResults) {
          if (!r.result.pageId) continue;
          const props = await fetchTaskPropertiesById(config, r.result.pageId).catch(() => null);
          if (!props) continue;
          await saveTaskSnapshot(env.NOTIFY_CACHE, r.result.pageId, {
            threadTs: taskThread,
            channel: pmoChannel,
            taskName: props.name || r.newTask.task_name,
            status: props.status,
            assignees: props.assignees,
            due: props.due,
            sp: props.sp
          }).catch(() => {});
        }
        console.log(`Saved snapshots for ${taskResults.length} newly created task(s)`);
      }
    }
  } else {
    // Update actions (update_due, update_sp, update_status, update_assignee, etc.)
    // Build assignee resolver only when an assignee change is present (avoids extra API calls)
    let resolveAssignee: AssigneeResolver | undefined;
    if (pending.actions.some((a) => a.action === "update_assignee")) {
      resolveAssignee = makeAssigneeResolver(await ensureUserCatalog(env, config));
    }

    const results = await executeNotionActions(
      config.notionToken,
      pending.actions,
      config.dryRun,
      config.projectDbId,
      resolveAssignee
    );

    await deletePendingAction(env.NOTIFY_CACHE, channel, messageTs);
    if (pending.threadTs) {
      await deletePendingCreateRef(env.NOTIFY_CACHE, channel, pending.threadTs);
    }

    // 更新内容は全て Notion webhook が当日スレッドに before/after 形式で通知するため、
    // ここでは承認ボタンメッセージに「承認しました」と表示するだけ（重複通知を廃止）
    const summaryMsg = "✅ 承認しました（変更内容はスレッドに通知されます）";

    await chatUpdate(
      config.slackBotToken,
      channel,
      messageTs,
      originalText + "\n\n" + summaryMsg,
      [
        ...blocksWithoutActions,
        textSection(`✅ <@${userId}> が承認しました\n\n${summaryMsg}`)
      ]
    );
  }

  console.log(`Action approved by ${userId}: channel=${channel} ts=${messageTs}`);
}

// ── Task modify button handler ─────────────────────────────────────────────

async function handleTaskModifyButton(
  env: Bindings,
  payload: SlackInteractionPayload
): Promise<void> {
  const channel = payload.channel.id;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;
  const messageTs = payload.message.ts;
  const threadTs = payload.message.thread_ts ?? messageTs;
  const userId = payload.user.id;

  // Remove buttons from original message, keep the content
  const originalText = payload.message.text;
  const blocksWithoutActions = (payload.message.blocks ?? []).filter(
    (b: unknown) => (b as Record<string, unknown>).type !== "actions"
  );

  await chatUpdate(
    config.slackBotToken,
    channel,
    messageTs,
    originalText,
    [
      ...blocksWithoutActions,
      textSection(`✏️ <@${userId}> が修正を選択しました`)
    ]
  );

  // Post a prompt in the thread asking for modification details
  await chatPostMessage(
    config.slackBotToken,
    channel,
    `<@${userId}> 修正内容をこのスレッドに返信してください。\n例: 「担当を佐藤に変更」「SPを5に」「期限を来週金曜に」`,
    undefined,
    threadTs
  );

  console.log(`Action modify requested by ${userId}: channel=${channel} ts=${messageTs}`);
}

// ── PM Report approval button handler ──────────────────────────────────────

async function handlePmReportButton(
  env: Bindings,
  payload: SlackInteractionPayload
): Promise<void> {
  const channel = payload.channel.id;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;
  const messageTs = payload.message.ts;
  const userId = payload.user.id;

  const today = toJstDateString();
  // Try channel-scoped PM thread first, then global (backward compat)
  let pmThread = await getPmThread(env.NOTIFY_CACHE, today, channel);
  let pmThreadScope: string | undefined = channel;
  if (!pmThread) {
    pmThread = await getPmThread(env.NOTIFY_CACHE, today);
    pmThreadScope = undefined;
  }

  if (!pmThread || pmThread.state !== "pending" || pmThread.channel !== channel || pmThread.ts !== messageTs) {
    console.log(`PM report button mismatch: pmThread=${pmThread ? JSON.stringify({ state: pmThread.state, ts: pmThread.ts, channel: pmThread.channel }) : "null"}, clicked: channel=${channel} ts=${messageTs}, today=${today}`);
    await chatPostMessage(
      config.slackBotToken,
      channel,
      `⚠️ このボタンは既に処理済みか、有効期限が切れています。`,
      undefined,
      messageTs
    );
    return;
  }

  // Remove buttons from original message
  const originalText = payload.message.text;
  const blocksWithoutActions = (payload.message.blocks ?? []).filter(
    (b: unknown) => (b as Record<string, unknown>).type !== "actions"
  );

  // Mark as processed FIRST to prevent reminder from firing during execution
  // Save back to the SAME scope key we read from, so the reminder cron sees "processed"
  console.log(`[PM-PROCESSED-BY] handlePmReportButton (OK button), scope=${pmThreadScope}, channel=${channel}, ts=${messageTs}`)
  await savePmThread(env.NOTIFY_CACHE, today, { ...pmThread, state: "processed" }, undefined, pmThreadScope);
  // Also mark the other scope as processed in case reminder checks both
  if (pmThreadScope === undefined) {
    await savePmThread(env.NOTIFY_CACHE, today, { ...pmThread, state: "processed" }, undefined, channel);
  } else {
    await savePmThread(env.NOTIFY_CACHE, today, { ...pmThread, state: "processed" }, undefined, undefined);
  }

  // Full approval
  const proposal = JSON.parse(pmThread.proposalJson) as AllocationProposal;
  const approvalText = "全提案を承認します";
  const actions = await interpretPmReply(config, proposal, approvalText);

  // PM report approvals reassign owners — resolver from the cached user catalog
  const pmResolveAssignee = makeAssigneeResolver(await ensureUserCatalog(env, config));

  const results = await executeNotionActions(
    config.notionToken,
    actions.actions,
    config.dryRun,
    config.projectDbId,
    pmResolveAssignee
  );

  const summaryMsg = results.length > 0
    ? `\n\nNotion更新完了:\n${results.join("\n")}`
    : "";

  await chatUpdate(
    config.slackBotToken,
    channel,
    messageTs,
    originalText + summaryMsg,
    [
      ...blocksWithoutActions,
      textSection(`✅ <@${userId}> がOKしました${summaryMsg}`)
    ]
  );

  // Thread reply for visibility
  await chatPostMessage(
    config.slackBotToken,
    channel,
    `✅ <@${userId}> がOKしました${summaryMsg}`,
    undefined,
    messageTs
  );

  // 完了通知は当日の MM/DD_タスクスレッドに入れる
  const pmoChannel = resolveTeamKChannelId(env);
  if (pmoChannel) {
    const taskThread = await getCurrentTaskThread(env.NOTIFY_CACHE, pmoChannel).catch(() => null);
    await sendCompletionNotification(config.slackBotToken, pmoChannel, results, config.dryRun, taskThread ?? undefined);
  }

  console.log(`PM report approved by ${userId}`);
}

// ── EOD reminder button handler ────────────────────────────────────────────

async function handleEodButton(
  env: Bindings,
  payload: SlackInteractionPayload,
  actionId: string
): Promise<void> {
  const channel = payload.channel.id;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;
  const messageTs = payload.message.ts;
  const threadTs = payload.message.thread_ts ?? messageTs;
  const userId = payload.user.id;

  // Map action to response text
  const responseMap: Record<string, string> = {
    eod_updated: "✅ タスクのステータスを更新済みです！",
    eod_in_progress: "🔄 まだ作業中です。後で更新します。",
    eod_no_progress: "🚫 今日は進捗がありませんでした。"
  };
  const responseText = responseMap[actionId] ?? "回答済み";

  // Remove buttons from original message
  const originalText = payload.message.text;
  const blocksWithoutActions = (payload.message.blocks ?? []).filter(
    (b: unknown) => (b as Record<string, unknown>).type !== "actions"
  );

  await chatUpdate(
    config.slackBotToken,
    channel,
    messageTs,
    originalText + `\n\n<@${userId}>: ${responseText}`,
    [
      ...blocksWithoutActions,
      textSection(`<@${userId}>: ${responseText}`)
    ]
  );

  // Find and update the thread state if this is a tracked thread
  const threadState = await getThreadState(env.NOTIFY_CACHE, channel, threadTs);
  if (threadState && threadState.state === "pending") {
    await saveThreadState(env.NOTIFY_CACHE, channel, threadTs, {
      ...threadState,
      state: "replied"
    });

    await appendReply(env.NOTIFY_CACHE, channel, threadTs, {
      text: responseText,
      userId,
      receivedAt: new Date().toISOString()
    });
  }

  console.log(`EOD response from ${userId}: ${actionId}`);
}

// ── Message shortcut: set reminder ─────────────────────────────────────────

async function handleSetReminderShortcut(
  env: Bindings,
  payload: SlackInteractionPayload
): Promise<void> {
  const channel = payload.channel.id;
  const config = await resolveConfig(env, channel);
  if (!config.slackBotToken) return;

  const userId = payload.user.id;
  const messageTs = payload.message.ts;
  const threadTs = payload.message.thread_ts ?? messageTs;

  // Fetch the target message
  let messages: Awaited<ReturnType<typeof conversationsReplies>> = [];
  try {
    messages = await conversationsReplies(config.slackBotToken, channel, threadTs, 1, true);
    if (messages.length > 1) messages = [messages[0]];
  } catch {
    // thread_not_found — link-only
  }

  const threadLink = `https://slack.com/archives/${channel}/p${threadTs.replace(".", "")}`;
  const messageContent = messages.length > 0
    ? `<@${messages[0].user}>: ${messages[0].text}`
    : "";

  const dmText =
    `☎️ *リマインド設定されたメッセージ*\n` +
    `<${threadLink}|メッセージを見る>\n\n` +
    (messageContent ? `───────────────\n${messageContent}\n───────────────\n\n` : "") +
    `_以下のボタンからリマインドまでの時間を選択してください。_`;

  const dmChannelId = await conversationsOpen(config.slackBotToken, userId);
  if (!dmChannelId) {
    console.error(`Failed to open DM channel for user ${userId}`);
    return;
  }

  const dmResult = await chatPostMessage(
    config.slackBotToken,
    dmChannelId,
    dmText,
    [buildTimeSelectionButtons(userId, channel, threadTs)]
  );

  const now = new Date().toISOString();
  await savePhoneReminder(env.NOTIFY_CACHE, userId, channel, threadTs, {
    userId,
    channel,
    threadTs,
    messageContent,
    threadLink,
    createdAt: now,
    remindAt: "",
    dmChannel: dmChannelId,
    initialDmTs: dmResult.ts,
    status: "pending"
  });

  console.log(`Reminder set via shortcut: user=${userId}, channel=${channel}, threadTs=${threadTs}`);
}

// ── Phone reminder schedule button handler ──────────────────────────────────

async function handleReminderScheduleButton(
  env: Bindings,
  payload: SlackInteractionPayload,
  action: { value?: string }
): Promise<void> {
  const payloadChannel = payload.channel.id;
  const config = await resolveConfig(env, payloadChannel);
  if (!config.slackBotToken) return;

  if (!action.value) return;
  const { hours, userId, channel, threadTs } = JSON.parse(action.value) as {
    hours: number;
    userId: string;
    channel: string;
    threadTs: string;
  };

  const reminder = await getPhoneReminder(env.NOTIFY_CACHE, userId, channel, threadTs);
  if (!reminder) {
    console.log(`handleReminderScheduleButton: no reminder found for user=${userId}, threadTs=${threadTs}`);
    const dmChannel = payload.channel.id;
    const dmTs = payload.message.ts;
    await chatUpdate(
      config.slackBotToken,
      dmChannel,
      dmTs,
      "⚠️ リマインダーが見つかりません。もう一度 ☎️ リアクションを付けてください。",
      [textSection("⚠️ リマインダーが見つかりません。もう一度 ☎️ リアクションを付けてください。")]
    );
    return;
  }

  // Calculate remind time
  const remindAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();

  // Update KV
  await savePhoneReminder(env.NOTIFY_CACHE, userId, channel, threadTs, {
    ...reminder,
    remindAt,
    status: "pending"
  });

  // Build updated DM content
  const dmText =
    `☎️ *${hours}時間後にリマインドします！*\n` +
    `<${reminder.threadLink}|メッセージを見る>\n\n` +
    (reminder.messageContent ? `───────────────\n${reminder.messageContent}\n───────────────\n\n` : "") +
    `_変更したい場合は以下のボタンから再度選択してください。_`;

  // Update the DM message (replace buttons with new state)
  const dmChannel = payload.channel.id;
  const dmTs = payload.message.ts;

  await chatUpdate(
    config.slackBotToken,
    dmChannel,
    dmTs,
    dmText,
    [
      textSection(dmText),
      buildTimeSelectionButtons(userId, channel, threadTs)
    ]
  );

  console.log(`Reminder scheduled: user=${userId}, hours=${hours}, remindAt=${remindAt}`);
}

// ── Phone reminder stop button handler ──────────────────────────────────────

async function handleReminderStopButton(
  env: Bindings,
  payload: SlackInteractionPayload,
  action: { value?: string }
): Promise<void> {
  const payloadChannel = payload.channel.id;
  const config = await resolveConfig(env, payloadChannel);
  if (!config.slackBotToken) return;

  if (!action.value) return;
  const { userId, channel, threadTs } = JSON.parse(action.value) as {
    userId: string;
    channel: string;
    threadTs: string;
  };

  // Delete from KV
  await deletePhoneReminder(env.NOTIFY_CACHE, userId, channel, threadTs);

  // Update DM to show stopped state (remove buttons)
  const dmChannel = payload.channel.id;
  const dmTs = payload.message.ts;

  await chatUpdate(
    config.slackBotToken,
    dmChannel,
    dmTs,
    "☎️ リマインドを終了しました。",
    [textSection("☎️ リマインドを終了しました。")]
  );

  console.log(`Reminder stopped via button: user=${userId}, channel=${channel}, threadTs=${threadTs}`);
}
