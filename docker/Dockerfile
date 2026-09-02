# Ralph Loop 用の隔離実行イメージ
# claude -p をこのコンテナ内で bypassPermissions のまま走らせる。
# マウントした /work 以外には触れないため、暴走しても被害は /work 内に限定される。
FROM node:24-slim

# git: クローン/差分操作用 / ca-certificates: API への TLS
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code@2.1.161

# 非 root ユーザーで実行（さらに権限を絞る）
RUN useradd -m -u 1000 ralph
USER ralph

WORKDIR /work

# 認証は実行時に CLAUDE_CODE_OAUTH_TOKEN を環境変数で渡す（イメージには焼かない）
COPY --chmod=755 ralph-entry.sh /usr/local/bin/ralph-entry.sh
ENTRYPOINT ["/usr/local/bin/ralph-entry.sh"]
