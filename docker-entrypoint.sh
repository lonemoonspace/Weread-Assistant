#!/bin/sh
set -e

# 数据目录通常是从宿主机挂载进来的，属主可能是 root。
# 以 root 启动时先把其中不属于 node 用户的文件改过来，再降权以 node 用户运行
if [ "$(id -u)" = "0" ]; then
  dir="${PANEL_DATA_DIR:-data}"
  case "$dir" in
    /*) ;;
    *) dir="/app/$dir" ;;
  esac
  mkdir -p "$dir"
  find "$dir" ! -user node -exec chown -h node:node {} +
  exec su-exec node "$@"
fi

exec "$@"
