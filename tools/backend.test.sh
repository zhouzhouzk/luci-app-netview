#!/bin/sh
# Exercise the new netview backend helpers against a fake sysfs tree.
# The script hardcodes /sys/class/net paths, so the test copy rewrites them to
# point at a sandbox directory -- that lets the bridge-member fallback (the
# trickiest bit of new logic) actually be executed.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../root/usr/libexec/rpcd/netview"
SB="$HERE/sandbox"

rm -rf "$SB"; mkdir -p "$SB/sys/class/net" "$SB/bin"

# ---- fake sysfs -------------------------------------------------------------
N="$SB/sys/class/net"
mkdir -p "$N/eth0" "$N/eth1" "$N/wlan0" "$N/tun0" "$N/utun" "$N/br-lan"
printf '10000\n' > "$N/eth0/speed"
printf '1000\n'  > "$N/eth1/speed"
printf '\n'      > "$N/wlan0/speed"      # wireless: empty
printf -- '-1\n' > "$N/tun0/speed"       # tunnels report -1
# 内核给"没有 phy 的设备"回 ethtool 默认值 1000，而 tun 并没有千兆链路 ——
# 这正是 OpenClash 的 utun 早先在状态列里冒充 "1000M" 的原因。
printf '1000\n'  > "$N/utun/speed"

# 物理网卡在 /sys/class/net/<dev>/device 下挂着总线设备节点；PPP / tun /
# wireguard / 网桥没有，这个节点就是 if_kind 的全部依据。
for d in eth0 eth1 wlan0; do mkdir -p "$N/$d/device"; done

# br-lan 自己没有 speed 文件，速率来自成员口 eth1
mkdir -p "$N/br-lan/brif/eth1"
printf '1000\n' > "$N/br-lan/brif/eth1/speed"
for d in eth0 eth1 br-lan; do printf 'up\n' > "$N/$d/operstate"; done
printf 'down\n' > "$N/wlan0/operstate"

# ---- fake `ip` so addr_of / if_link can be exercised ------------------------
cat > "$SB/bin/ip" <<'EOS'
#!/bin/sh
# 支持的调用形式（够脚本用）：
#   ip [-4|-6] -o addr show dev DEV scope global
#   ip -o link show dev DEV
fam=""; mode=""; dev=""
for a in "$@"; do
	case "$a" in
		-4) fam=4 ;;
		-6) fam=6 ;;
		addr) mode=addr ;;
		link) mode=link ;;
	esac
	case "$prev" in
		dev) dev="$a" ;;
	esac
	prev="$a"
done

if [ "$mode" = "link" ]; then
	case "$dev" in
		eth0|eth1|br-lan)
			echo "2: $dev: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP" ;;
		wlan0)
			# 设备没 up（没 ip link set up）—— 连 UP 都没有
			echo "3: wlan0: <BROADCAST,MULTICAST> mtu 1500 state DOWN" ;;
		tun0)
			# UP 但没有 LOWER_UP：点对点隧道不按以太网那套上报载波
			echo "4: tun0: <POINTOPOINT,NOARP,UP> mtu 1500 state UNKNOWN" ;;
		*)
			echo "Device \"$dev\" does not exist." >&2
			exit 1 ;;
	esac
	exit 0
fi

if [ "$mode" = "addr" ]; then
	if [ "$dev" = "eth0" ]; then
		[ "$fam" = "4" ] && echo "2: eth0    inet 192.168.9.231/24 brd 192.168.9.255 scope global eth0"
		[ "$fam" = "6" ] && echo "2: eth0    inet6 2408:8207:8c1f:2a00::1/64 scope global dynamic"
	fi
	# tun0 没有 LOWER_UP，但有全局地址 —— if_link 的兜底判据
	[ "$dev" = "tun0" ] && echo "4: tun0    inet 10.7.0.2/32 scope global tun0"
	exit 0
fi
exit 0
EOS
chmod +x "$SB/bin/ip"
PATH="$SB/bin:$PATH"; export PATH

# ---- build the test copy of the backend ------------------------------------
# keep everything up to the "---- interfaces ----" banner (the helpers), and
# drop the jshn include: that path only exists on the router, and none of the
# helpers under test need it.
sed "s#/sys/class/net#$SB/sys/class/net#g" "$SRC" \
	| sed -n '1,/^# -\{2,\} interfaces -\{2,\}$/p' \
	| sed '/libubox\/jshn.sh/d' > "$SB/helpers.sh"
. "$SB/helpers.sh"

pass=0; fail=0
ck() {
	if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  ok   %-46s = %s\n' "$1" "$2"
	else fail=$((fail+1)); printf '  FAIL %-46s 期望 %s 实得 %s\n' "$1" "$3" "$2"; fi
}

echo "=== if_speed（协商速率 Mbit/s；0 = 未知）==="
ck "物理网卡 eth0"        "$(if_speed eth0)"            "10000"
ck "物理网卡 eth1"        "$(if_speed eth1)"            "1000"
ck "网桥回退到成员口"      "$(if_speed br-lan)"          "1000"
ck "无线（speed 为空）"    "$(if_speed wlan0)"           "0"
ck "隧道（speed = -1）"    "$(if_speed tun0)"            "0"
ck "隧道（内核回 1000 也不信）" "$(if_speed utun)"        "0"
ck "不存在的设备"          "$(if_speed nosuchdev)"       "0"
ck "空参数"               "$(if_speed '')"              "0"

echo ""
echo "=== if_kind（物理网卡 / 软件接口）==="
ck "物理网卡 eth0"        "$(if_kind eth0)"            "physical"
ck "物理无线 wlan0"       "$(if_kind wlan0)"           "physical"
ck "网桥 br-lan"          "$(if_kind br-lan)"          "virtual"
ck "隧道 tun0"            "$(if_kind tun0)"            "virtual"
ck "OpenClash 的 utun"    "$(if_kind utun)"            "virtual"
ck "不存在的设备按虚拟算"   "$(if_kind nosuchdev)"       "virtual"

echo ""
echo "=== if_link（链路是否可用）==="
# 只看 operstate 会把下面这些点对点设备全判成"未连接"：PPP / tun /
# wireguard 永远停在 unknown，而它们明明在跑流量。
ck "eth0 有载波"          "$(if_link eth0)"            "up"
ck "br-lan 有载波"        "$(if_link br-lan)"          "up"
ck "wlan0 未 up"          "$(if_link wlan0)"           "down"
ck "tun0 无 LOWER_UP 但持有地址" "$(if_link tun0)"      "up"
ck "不存在的设备"          "$(if_link nosuchdev)"       "down"
ck "空参数"               "$(if_link '')"              "down"

echo ""
echo "=== if_operstate ==="
ck "eth0"                "$(if_operstate eth0)"        "up"
ck "wlan0"               "$(if_operstate wlan0)"       "down"
ck "缺失时回落 unknown"   "$(if_operstate nosuchdev)"   "unknown"

echo ""
echo "=== if_roles（同一物理口可承载多个逻辑接口）==="
ck "eth0 = wan + wan6 同口" "$(if_roles eth0 eth0 eth0 br-lan)"     "WAN,WAN6"
ck "br-lan = lan"          "$(if_roles br-lan eth0 eth0 br-lan)"    "LAN"
ck "其他接口无角色"         "$(if_roles eth1 eth0 eth0 br-lan)"      ""
ck "wan6 未配置时只剩 WAN"  "$(if_roles eth0 eth0 '' br-lan)"        "WAN"
ck "全部未解析时为空"       "$(if_roles eth0 '' '' '')"              ""

echo ""
echo "=== if_role（主角色，用于徽章）==="
ck "eth0"                "$(if_role eth0 eth0 br-lan)"      "WAN"
ck "br-lan"              "$(if_role br-lan eth0 br-lan)"    "LAN"
ck "pppoe-wan 按名字识别"  "$(if_role pppoe-wan '' '')"       "WAN"
ck "br-lan 按名字识别"     "$(if_role br-lan '' '')"          "LAN"
ck "wlan0 无角色"         "$(if_role wlan0 eth0 br-lan)"     ""

echo ""
echo "=== addr_of（取首个 global 地址）==="
ck "IPv4"                "$(addr_of eth0 4)"             "192.168.9.231/24"
ck "IPv6"                "$(addr_of eth0 6)"             "2408:8207:8c1f:2a00::1/64"
ck "无地址的接口"         "$(addr_of eth1 4)"             ""
ck "VLAN 语法解析"        "$( w4=$(addr_of eth0 4); printf '%s|%s' "${w4%%/*}" "${w4##*/}" )" "192.168.9.231|24"
ck "空值不产生残留"       "$( w4=$(addr_of eth1 4); printf '%s|%s' "${w4%%/*}" "${w4##*/}" )" "|"

echo ""
echo "======================================"
printf '  pass %s   fail %s\n' "$pass" "$fail"
echo "======================================"
[ "$fail" -eq 0 ]
