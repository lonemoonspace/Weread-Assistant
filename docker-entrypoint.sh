#!/bin/sh
set -e

# 数据目录通常是从宿主机挂载进来的，属主可能是 root。
# 以 root 启动时先把数据目录本身与面板写入的文件中不属于 node 用户的改过来，再降权以 node 用户运行；
# 数据目录中的其他文件（用户自己放进去的）不改。
# 由 tini 作为 1 号进程启动面板：转发停止信号，并回收内置浏览器退出后留下的进程
if [ "$(id -u)" = "0" ]; then
  dir="${PANEL_DATA_DIR:-data}"
  case "$dir" in
    /*) ;;
    *) dir="/app/$dir" ;;
  esac
  # 新建的数据目录只允许属主访问
  [ -d "$dir" ] || mkdir -p -m 700 "$dir"
  find "$dir" -maxdepth 0 ! -user node -exec chown -h node:node {} +
  for name in panel.json panel.json.bak panel.lock panel.log accounts runs; do
    if [ -e "$dir/$name" ] || [ -L "$dir/$name" ]; then
      find "$dir/$name" ! -user node -exec chown -h node:node {} +
    fi
  done
  exec su-exec node /sbin/tini -- "$@"
fi

exec /sbin/tini -- "$@"
