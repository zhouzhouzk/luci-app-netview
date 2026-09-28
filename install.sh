#!/bin/sh
#
# luci-app-netview -- 免编译一键部署
#
# 用法:
#   ./install.sh 192.168.1.1              # 部署（默认 SSH 22 端口，root 用户）
#   ./install.sh 192.168.1.1 2222         # 自定义 SSH 端口
#   ./install.sh --uninstall 192.168.1.1  # 卸载
#
# 依赖: 本地可用的 ssh / scp（Windows 下用 Git Bash 即可）
#

set -e

ACTION="install"
PORT="22"

case "$1" in
	--uninstall|-u)
		ACTION="uninstall"
		shift
		;;
esac

HOST="$1"
[ -n "$HOST" ] || { echo "用法: $0 [--uninstall] <路由器IP> [SSH端口]"; exit 1; }
[ -n "$2" ] && PORT="$2"

SRC="$(cd "$(dirname "$0")" && pwd)"
TARGET="root@$HOST"
SSH="ssh -p $PORT -o StrictHostKeyChecking=no"
SCP="scp -P $PORT -o StrictHostKeyChecking=no"

if [ "$ACTION" = "uninstall" ]; then
	echo "==> 正在从 $HOST 卸载..."
	$SSH "$TARGET" '
		rm -f /usr/libexec/rpcd/netview
		rm -f /usr/share/rpcd/acl.d/luci-app-netview.json
		rm -f /usr/share/luci/menu.d/luci-app-netview.json
		rm -rf /www/luci-static/resources/view/netview
		rm -rf /tmp/netview
		rm -f /tmp/luci-indexcache*
		rm -rf /tmp/luci-modulecache/
		/etc/init.d/rpcd reload 2>/dev/null || true
	'
	echo "==> 已卸载"
	exit 0
fi

echo "==> 目标: $TARGET:$PORT"

echo "==> 创建目录..."
$SSH "$TARGET" 'mkdir -p /www/luci-static/resources/view/netview \
	/usr/libexec/rpcd /usr/share/rpcd/acl.d /usr/share/luci/menu.d'

echo "==> 上传文件..."
$SCP "$SRC/root/usr/libexec/rpcd/netview" \
	"$TARGET:/usr/libexec/rpcd/netview"
$SCP "$SRC/root/usr/share/rpcd/acl.d/luci-app-netview.json" \
	"$TARGET:/usr/share/rpcd/acl.d/luci-app-netview.json"
$SCP "$SRC/root/usr/share/luci/menu.d/luci-app-netview.json" \
	"$TARGET:/usr/share/luci/menu.d/luci-app-netview.json"
$SCP "$SRC/htdocs/luci-static/resources/view/netview/overview.js" \
	"$TARGET:/www/luci-static/resources/view/netview/overview.js"

echo "==> 设置权限并重载 rpcd..."
$SSH "$TARGET" '
	chmod 755 /usr/libexec/rpcd/netview
	# 菜单缓存的实际文件名是 /tmp/luci-indexcache.<hash>.json，缓存的 key 里含
	# menu.d 各文件的 inode/mtime/size —— 刚 scp 过来的文件 mtime 必然变了，
	# 所以不删也会自动重建。这里删一下只是省得等，注意通配符不能少。
	rm -f /tmp/luci-indexcache*
	/etc/init.d/rpcd reload 2>/dev/null || /etc/init.d/rpcd restart
	sleep 2
	if ubus -v list netview >/dev/null 2>&1; then
		echo "    rpcd 插件注册成功"
		ubus -v list netview | sed "s/^/    /"
	else
		echo "    [警告] rpcd 未注册 netview，请检查 /usr/libexec/rpcd/netview"
	fi
'

echo ""
echo "==> 完成，打开: http://$HOST/cgi-bin/luci/admin/status/netview"
