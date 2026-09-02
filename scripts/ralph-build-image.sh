#!/usr/bin/env bash
#
# Ralph Loop — Docker イメージのビルド & 認証トークンのセットアップ補助
#
# 使い方:
#   ./scripts/ralph-build-image.sh build      # イメージをビルド
#   ./scripts/ralph-build-image.sh token      # 長期トークンの保存方法を案内
#   ./scripts/ralph-build-image.sh check      # 前提（Docker/トークン）が揃っているか確認
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE="ralph-notion-pmo:latest"
TOKEN_FILE="$HOME/.config/ralph/token"

cmd="${1:-check}"

case "$cmd" in
  build)
    if ! docker info >/dev/null 2>&1; then
      echo "Docker デーモンが起動していません。Docker Desktop を起動してから再実行してください。" >&2
      exit 1
    fi
    echo "イメージをビルド: $IMAGE"
    docker build -t "$IMAGE" "$REPO_DIR/docker"
    echo "完了: $IMAGE"
    ;;
  token)
    cat <<EOF
=== Claude 長期トークンの発行と保存 ===

1) ホスト（このMac）で対話的に発行する:
     claude setup-token
   ブラウザ認証後、'sk-ant-oat...' 形式のトークンが表示されます。

2) それを安全に保存する（リポジトリには絶対に置かない）:
     mkdir -p "$(dirname "$TOKEN_FILE")"
     printf '%s' '<コピーしたトークン>' > "$TOKEN_FILE"
     chmod 600 "$TOKEN_FILE"

ランナーは $TOKEN_FILE を読んでコンテナに CLAUDE_CODE_OAUTH_TOKEN として渡します。
EOF
    ;;
  check)
    echo "=== 前提チェック ==="
    if docker info >/dev/null 2>&1; then echo "[OK] Docker デーモン稼働中"; else echo "[NG] Docker デーモン未起動（Docker Desktop を起動）"; fi
    if docker image inspect "$IMAGE" >/dev/null 2>&1; then echo "[OK] イメージ $IMAGE あり"; else echo "[NG] イメージ未ビルド → $0 build"; fi
    if [ -s "$TOKEN_FILE" ]; then echo "[OK] トークン $TOKEN_FILE あり"; else echo "[NG] トークン未保存 → $0 token"; fi
    ;;
  *)
    echo "usage: $0 {build|token|check}"
    exit 1
    ;;
esac
