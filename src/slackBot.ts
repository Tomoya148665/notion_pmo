import { withRetry } from "./retry";

interface PostMessageResult {
  ts: string;
  channel: string;
}

async function slackApiCall(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<unknown> {
  return withRetry(
    async () => {
      const res = await fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        throw new Error(`Slack API HTTP error: ${res.status} ${method}`);
      }

      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        ts?: string;
        channel?: string;
        messages?: unknown[];
      };

      if (!data.ok) {
        throw new Error(`Slack API error [${method}]: ${data.error ?? "unknown"}`);
      }

      return data;
    },
    { label: `Slack ${method}` }
  );
}

export interface SlackMessage {
  ts: string;
  text: string;
  user: string;
  reply_count?: number;
  thread_ts?: string;
}

export async function conversationsHistory(
  token: string,
  channel: string,
  limit = 50,
  oldest?: string
): Promise<SlackMessage[]> {
  const body: Record<string, unknown> = { channel, limit };
  if (oldest) body.oldest = oldest;

  const data = (await slackApiCall(token, "conversations.history", body)) as {
    messages?: Array<{
      ts?: string;
      text?: string;
      user?: string;
      reply_count?: number;
      thread_ts?: string;
    }>;
  };

  return (data.messages ?? []).map((m) => ({
    ts: m.ts ?? "",
    text: m.text ?? "",
    user: m.user ?? "",
    reply_count: m.reply_count,
    thread_ts: m.thread_ts
  }));
}

export async function conversationsReplies(
  token: string,
  channel: string,
  threadTs: string,
  limit = 20,
  includeParent = false
): Promise<SlackMessage[]> {
  const params = new URLSearchParams({
    channel,
    ts: threadTs,
    limit: String(limit)
  });

  const res = await withRetry(
    async () => {
      const r = await fetch(
        `https://slack.com/api/conversations.replies?${params.toString()}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      if (!r.ok) {
        throw new Error(`Slack API HTTP error: ${r.status} conversations.replies`);
      }
      const d = (await r.json()) as {
        ok: boolean;
        error?: string;
        messages?: Array<{
          ts?: string;
          text?: string;
          user?: string;
        }>;
      };
      if (!d.ok) {
        throw new Error(`Slack API error [conversations.replies]: ${d.error ?? "unknown"}`);
      }
      return d;
    },
    { label: "Slack conversations.replies" }
  );

  return (res.messages ?? [])
    .filter((m) => includeParent || m.ts !== threadTs)
    .map((m) => ({
      ts: m.ts ?? "",
      text: m.text ?? "",
      user: m.user ?? ""
    }));
}

export async function conversationsOpen(
  token: string,
  userId: string
): Promise<string> {
  const data = (await slackApiCall(token, "conversations.open", {
    users: userId
  })) as { channel?: { id?: string } };
  return data.channel?.id ?? "";
}

/**
 * 「タイトル行 + ネイティブ箇条書き」の Slack blocks を組み立てる。
 * Slack の section(mrkdwn) は "- "/"• " をネイティブの箇条書きに変換しないため、
 * rich_text_list(style:bullet) を使う（インデント付きの正式な箇条書きで描画される）。
 * タイトルは絵文字ショートコード(:arrow_upper_right: 等)を描画させるため mrkdwn section に置く。
 */
export function bulletListBlocks(title: string, bullets: string[]): unknown[] {
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: title } }
  ];
  if (bullets.length > 0) {
    blocks.push({
      type: "rich_text",
      elements: [
        {
          type: "rich_text_list",
          style: "bullet",
          elements: bullets.map((b) => ({
            type: "rich_text_section",
            elements: [{ type: "text", text: b }]
          }))
        }
      ]
    });
  }
  return blocks;
}

export async function chatPostMessage(
  token: string,
  channel: string,
  text: string,
  blocks?: unknown[],
  threadTs?: string
): Promise<PostMessageResult> {
  const body: Record<string, unknown> = { channel, text };
  if (blocks) {
    // If blocks already contain section blocks (pre-built), use as-is.
    // Otherwise, prepend text as a section block so it's visible alongside buttons.
    const hasSection = blocks.some(
      (b: unknown) => (b as Record<string, unknown>).type === "section"
    );
    if (hasSection) {
      body.blocks = blocks;
    } else {
      const textBlock = {
        type: "section",
        text: { type: "mrkdwn", text }
      };
      body.blocks = [textBlock, ...blocks];
    }
  }
  if (threadTs) body.thread_ts = threadTs;

  const data = (await slackApiCall(token, "chat.postMessage", body)) as {
    ts: string;
    channel: string;
  };
  return { ts: data.ts, channel: data.channel };
}

export async function chatUpdate(
  token: string,
  channel: string,
  ts: string,
  text: string,
  blocks?: unknown[]
): Promise<void> {
  const body: Record<string, unknown> = { channel, ts, text };
  if (blocks) body.blocks = blocks;
  await slackApiCall(token, "chat.update", body);
}

export async function viewsOpen(
  token: string,
  triggerId: string,
  view: unknown
): Promise<void> {
  await slackApiCall(token, "views.open", {
    trigger_id: triggerId,
    view
  });
}

export async function conversationsMembers(
  token: string,
  channel: string
): Promise<string[]> {
  const data = (await slackApiCall(token, "conversations.members", {
    channel,
    limit: 200
  })) as { members?: string[] };
  return data.members ?? [];
}

// NOTE: Slack の users.info / conversations.info は POST+JSON で user/channel パラメータを
// 受け付けない（user_not_found / invalid_arguments になる）。GET + query string で呼ぶこと。
async function slackApiGet(
  token: string,
  method: string,
  params: Record<string, string>
): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  return withRetry(
    async () => {
      const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        throw new Error(`Slack API HTTP error: ${res.status} ${method}`);
      }
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        throw new Error(`Slack API error [${method}]: ${data.error ?? "unknown"}`);
      }
      return data;
    },
    { label: `Slack ${method}` }
  );
}

export async function usersInfo(
  token: string,
  userId: string
): Promise<{ realName: string; displayName: string }> {
  const data = (await slackApiGet(token, "users.info", {
    user: userId
  })) as { user?: { real_name?: string; profile?: { display_name?: string } } };
  return {
    realName: data.user?.real_name ?? "",
    displayName: data.user?.profile?.display_name ?? ""
  };
}

export async function conversationsInfo(
  token: string,
  channel: string
): Promise<{ name: string }> {
  const data = (await slackApiGet(token, "conversations.info", {
    channel
  })) as { channel?: { name?: string } };
  return {
    name: data.channel?.name ?? ""
  };
}

export async function authTest(
  token: string
): Promise<{ userId: string; botId: string }> {
  const data = (await slackApiCall(token, "auth.test", {})) as {
    user_id?: string;
    bot_id?: string;
  };
  return {
    userId: data.user_id ?? "",
    botId: data.bot_id ?? ""
  };
}

/**
 * チャンネル名から channel ID を解決する（conversations.list, public+private）。
 * 必要スコープ: channels:read / groups:read。見つからなければ null。
 */
export async function findChannelIdByName(token: string, name: string): Promise<string | null> {
  const target = name.replace(/^#/, "").trim();
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const params: Record<string, string> = { types: "public_channel,private_channel", limit: "200" };
    if (cursor) params.cursor = cursor;
    let data: { channels?: Array<{ id: string; name: string }>; response_metadata?: { next_cursor?: string } };
    try {
      data = (await slackApiGet(token, "conversations.list", params)) as typeof data;
    } catch (err) {
      console.warn(`findChannelIdByName error: ${(err as Error).message}`);
      return null;
    }
    const hit = (data.channels ?? []).find((c) => c.name === target);
    if (hit) return hit.id;
    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return null;
}

/**
 * 画像バイトを Slack にアップロードしてチャンネル/スレッドに表示する（files v2 フロー）。
 * 必須スコープ: files:write
 *  1) files.getUploadURLExternal でアップロードURL+file_idを取得
 *  2) そのURLにバイトをPOST
 *  3) files.completeUploadExternal でチャンネル/スレッドに添付
 */
export async function uploadImageToSlack(
  token: string,
  channelId: string,
  threadTs: string | undefined,
  filename: string,
  bytes: Uint8Array,
  initialComment?: string
): Promise<string | undefined> {
  // 1) upload URL
  const r1 = await fetch("https://slack.com/api/files.getUploadURLExternal", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ filename, length: String(bytes.byteLength) }).toString()
  });
  const j1 = (await r1.json()) as { ok: boolean; error?: string; upload_url?: string; file_id?: string };
  if (!j1.ok || !j1.upload_url || !j1.file_id) {
    throw new Error(`files.getUploadURLExternal failed: ${j1.error ?? "unknown"}`);
  }

  // 2) PUT bytes to the upload URL（Workers ランタイムは Uint8Array をそのまま body にできる）
  const r2 = await fetch(j1.upload_url, { method: "POST", body: bytes as unknown as BodyInit });
  if (!r2.ok) throw new Error(`file bytes upload failed: ${r2.status}`);

  // 3) complete
  const completeBody: Record<string, unknown> = {
    files: [{ id: j1.file_id, title: filename }],
    channel_id: channelId
  };
  if (threadTs) completeBody.thread_ts = threadTs;
  if (initialComment) completeBody.initial_comment = initialComment;
  const r3 = await fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(completeBody)
  });
  const j3 = (await r3.json()) as { ok: boolean; error?: string; files?: Array<{ id?: string }> };
  if (!j3.ok) throw new Error(`files.completeUploadExternal failed: ${j3.error ?? "unknown"}`);

  // 投稿されたファイルメッセージの ts を取得（スレッド起点にするため）。
  const fid = j3.files?.[0]?.id ?? j1.file_id;
  return await findUploadedFileTs(token, channelId, fid).catch(() => undefined);
}

/**
 * 複数画像を1メッセージにまとめて投稿する。
 * files.getUploadURLExternal を画像ごとに呼び、completeUploadExternal で一括添付。
 */
export async function uploadMultipleImagesToSlack(
  token: string,
  channelId: string,
  threadTs: string | undefined,
  files: Array<{ filename: string; bytes: Uint8Array; title?: string }>,
  initialComment?: string
): Promise<string | undefined> {
  const fileData: Array<{ uploadUrl: string; fileId: string; title: string }> = [];
  for (const file of files) {
    const r1 = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ filename: file.filename, length: String(file.bytes.byteLength) }).toString()
    });
    const j1 = (await r1.json()) as { ok: boolean; error?: string; upload_url?: string; file_id?: string };
    if (!j1.ok || !j1.upload_url || !j1.file_id) {
      throw new Error(`files.getUploadURLExternal failed: ${j1.error ?? "unknown"}`);
    }
    fileData.push({ uploadUrl: j1.upload_url, fileId: j1.file_id, title: file.title ?? file.filename });
  }
  for (let i = 0; i < files.length; i++) {
    const r2 = await fetch(fileData[i].uploadUrl, { method: "POST", body: files[i].bytes as unknown as BodyInit });
    if (!r2.ok) throw new Error(`file bytes upload failed: ${r2.status}`);
  }
  const completeBody: Record<string, unknown> = {
    files: fileData.map((f) => ({ id: f.fileId, title: f.title })),
    channel_id: channelId
  };
  if (threadTs) completeBody.thread_ts = threadTs;
  if (initialComment) completeBody.initial_comment = initialComment;
  const r3 = await fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(completeBody)
  });
  const j3 = (await r3.json()) as { ok: boolean; error?: string; files?: Array<{ id?: string }> };
  if (!j3.ok) throw new Error(`files.completeUploadExternal failed: ${j3.error ?? "unknown"}`);
  const fid = j3.files?.[0]?.id ?? fileData[0]?.fileId;
  return await findUploadedFileTs(token, channelId, fid).catch(() => undefined);
}

/** メッセージを削除する（bot が投稿したメッセージのみ）。 */
export async function deleteSlackMessage(token: string, channelId: string, ts: string): Promise<boolean> {
  const res = await fetch("https://slack.com/api/chat.delete", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: channelId, ts })
  });
  const j = (await res.json()) as { ok: boolean; error?: string };
  return j.ok;
}

/** アップロード直後のファイルメッセージの ts を conversations.history から探す（file_id 照合）。 */
async function findUploadedFileTs(
  token: string,
  channel: string,
  fileId: string
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = (await slackApiGet(token, "conversations.history", {
      channel,
      limit: "10"
    }).catch(() => null)) as {
      messages?: Array<{ ts?: string; files?: Array<{ id?: string }> }>;
    } | null;
    const hit = (data?.messages ?? []).find((m) => (m.files ?? []).some((f) => f.id === fileId));
    if (hit?.ts) return hit.ts;
    await new Promise((r) => setTimeout(r, 800));
  }
  return undefined;
}

