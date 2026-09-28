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
mkdir -p "$N/eth0" "$N/eth1" "$N/wlan0" "$N/tun0" "$N/br-lan"
printf '10000\n' > "$N/eth0/speed"
printf '1000\n'  > "$N/eth1/speed"
printf '\n'      > "$N/wlan0/speed"      # wireless: empty
printf -- '-1\n' > "$N/tun0/speed"       # tunnels report -1
# br-lan itself has no speed file; its member eth1 does
mkdir -p "$N/br-lan/brif/eth1"
printf '1000\n' > "$N/br-lan/brif/eth1/speed"
for d in eth0 eth1 br-lan; do printf 'up\n' > "$N/$d/operstate"; done
printf 'down\n' > "$N/wlan0/operstate"

# ---- fake `ip` so addr_of can be exercised ---------------------------------
cat > "$SB/bin/ip" <<'EOS'
#!/bin/sh
# args: -4|-6 -o addr show dev DEV scope global
fam=""
case "$1" in -4) fam=4 ;; -6) fam=6 ;; esac
dev=""
for a in "$@"; do
	case "$prev" in
		dev) dev="$a" ;;
	esac
	prev="$a"
done
if [ "$fam" = "4" ] && [ "$dev" = "eth0" ]; then
	echo "2: eth0    inet 192.168.9.231/24 brd 192.168.9.255 scope global eth0"
fi
if [ "$fam" = "6" ] && [ "$dev" = "eth0" ]; then
	echo "2: eth0    inet6 2408:8207:8c1f:2a00::1/64 scope global dynamic"
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
ck "不存在的设备"          "$(if_speed nosuchdev)"       "0"
ck "空参数"               "$(if_speed '')"              "0"

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
