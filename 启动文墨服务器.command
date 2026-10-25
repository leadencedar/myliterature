#!/bin/bash
# ============================================================
# 文墨 · 本地开发服务器启动器
#
# 双击本文件即可启动 http://localhost:5173，无需打开终端敲命令。
#   - 首次运行会自动安装依赖
#   - 服务器就绪后自动打开浏览器
#   - 同一 Wi-Fi 下手机 / 平板可用局域网地址访问
#   - 服务器已在运行时：回车打开浏览器 / n 退出 / s 停止服务器
#   - 停止：Ctrl+C 或直接关闭本窗口
# ============================================================

cd "$(dirname "$0")" || exit 1

PORT=5173
URL="http://localhost:${PORT}"

# 找不到 npm 时给出可操作的提示（终端里能跑 npm，双击时环境应该一致）
if ! command -v npm >/dev/null 2>&1; then
  echo "❌ 找不到 npm。请确认电脑已安装 Node.js（https://nodejs.org）。"
  read -r -p "按回车关闭窗口…"
  exit 1
fi

# 端口 5173 上正在监听的进程 PID（没有则为空）
listener_pid() {
  lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1
}

# 这个端口上跑的是不是文墨：看返回页面里有没有它的 manifest 标记。
# 用页面内容判断而不是进程名，避免误判，也不依赖 ps 的输出格式。
is_our_app() {
  curl -s --max-time 2 "$URL" | grep -q "manifest.webmanifest"
}

existing="$(listener_pid)"

if [ -n "$existing" ]; then
  echo "端口 $PORT 已有进程在监听。"
  if is_our_app; then
    echo "看起来就是文墨的开发服务器，已经开着了。"
    read -r -p "回车=打开浏览器 / 输入 n 退出 / 输入 s 停止服务器： " choice
    case "$choice" in
      s|S)
        kill "$existing"
        echo "✅ 已停止服务器。按回车关闭窗口…"
        read -r
        exit 0
        ;;
      n|N)
        exit 0
        ;;
      *)
        open "$URL"
        exit 0
        ;;
    esac
  else
    echo "⚠️  端口被其他程序占用，而且它返回的页面不是文墨。"
    echo "    请先关闭占用 5173 端口的程序，或改掉 vite.config.ts 里的端口。"
    read -r -p "按回车关闭窗口…"
    exit 1
  fi
fi

if [ ! -d node_modules ]; then
  echo "未找到依赖，首次运行需要安装（约几分钟，之后就不用等了）…"
  npm install || {
    echo "❌ 依赖安装失败。按回车关闭窗口…"
    read -r
    exit 1
  }
fi

echo "🚀 正在启动文墨开发服务器…"
echo "   本机访问：    $URL"
local_host="$(scutil --get LocalHostName 2>/dev/null)"
[ -n "$local_host" ] && echo "   手机 / 平板： http://${local_host}.local:${PORT}（同一 Wi-Fi）"
lan_ip="$(ipconfig getifaddr en0 2>/dev/null)"
[ -n "$lan_ip" ] && echo "   或 IP 访问：  http://${lan_ip}:${PORT}"
echo "   停止服务器：  Ctrl+C 或关闭本窗口"
echo

# 等服务器就绪后自动打开浏览器（最多 40 秒）
(
  for _ in $(seq 1 80); do
    if curl -s -o /dev/null --max-time 1 "$URL"; then
      open "$URL"
      exit 0
    fi
    sleep 0.5
  done
  echo "⚠️  40 秒内服务器未就绪，请手动打开 $URL"
) &
waiter=$!
trap 'kill "$waiter" 2>/dev/null' EXIT

npm run dev
