#!/bin/sh
# Exercise the new netview backend helpers against a fake sysfs tree.
# The script hardcodes /sys/class/net paths, so the test copy rewrites them to
# point at a sandbox directory -- that lets the bridge-member fallback (the
# trickiest bit of new logic) actually be executed.

set -u

# WorkBuddy 的 shell 把 rm 包装成"移入回收站"(genie-trash)，无 GUI 环境会永久
# 阻塞；测试要的是真实删除，这里改回原生 rm。真机上没有这层包装，无影响。
rm() { /usr/bin/rm "$@"; }

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

# ---- fake conntrack ---------------------------------------------------------
mkdir -p "$SB/proc/sys/net/netfilter" "$SB/proc/net"
printf '8\n'     > "$SB/proc/sys/net/netfilter/nf_conntrack_count"
printf '65536\n' > "$SB/proc/sys/net/netfilter/nf_conntrack_max"

# Six shapes that the classifier has to get right, one row each:
#   1-3  outbound TCP 443          -> HTTPS
#   4-5  outbound UDP 443          -> QUIC
#   6    inbound SSH               -> SSH  (service port is in the ORIGINAL
#                                    tuple; the reply tuple holds the client's
#                                    ephemeral port and must not be used)
#   7    port-forwarded HTTP       -> HTTP (original dst is the public WAN
#                                    address, so only dport identifies it --
#                                    an "is the dst private" test misses this)
#   8    ICMP, no port             -> 其他
#   9    IPv6 and must be skipped entirely
cat > "$SB/proc/nf_conntrack" <<'EOS'
ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.9.101 dst=142.250.1.1 sport=52341 dport=443 src=142.250.1.1 dst=192.168.9.231 sport=443 dport=52341 [ASSURED] mark=0 use=1
ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.9.102 dst=142.250.1.2 sport=52342 dport=443 src=142.250.1.2 dst=192.168.9.231 sport=443 dport=52342 [ASSURED] mark=0 use=1
ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.9.103 dst=140.82.1.3  sport=52343 dport=443 src=140.82.1.3  dst=192.168.9.231 sport=443 dport=52343 [ASSURED] mark=0 use=1
ipv4     2 udp     17 29 src=192.168.9.101 dst=142.250.1.1 sport=52344 dport=443 src=142.250.1.1 dst=192.168.9.231 sport=443 dport=52344 [ASSURED] mark=0 use=1
ipv4     2 udp     17 29 src=192.168.9.102 dst=142.250.1.2 sport=52345 dport=443 src=142.250.1.2 dst=192.168.9.231 sport=443 dport=52345 [ASSURED] mark=0 use=1
ipv4     2 tcp      6 431999 ESTABLISHED src=203.0.113.9 dst=192.168.9.231 sport=40000 dport=22 src=192.168.9.231 dst=203.0.113.9 sport=22 dport=40000 [ASSURED] mark=0 use=1
ipv4     2 tcp      6 431999 ESTABLISHED src=203.0.113.9 dst=1.2.3.4 sport=40001 dport=8080 src=192.168.9.101 dst=203.0.113.9 sport=80 dport=40001 [ASSURED] mark=0 use=1
ipv4     2 icmp     1 29 src=192.168.9.101 dst=1.1.1.1 type=8 code=0 id=1234 src=1.1.1.1 dst=192.168.9.231 type=0 code=0 id=1234 mark=0 use=1
ipv6     2 tcp      6 431999 ESTABLISHED src=2408:8207::1 dst=2408:8888::1 sport=52346 dport=443 src=2408:8888::1 dst=2408:8207::1 sport=443 dport=52346 [ASSURED] mark=0 use=1
EOS

# ---- build the test copy of the backend ------------------------------------
# keep everything up to the "---- interfaces ----" banner (the helpers), and
# drop the jshn include: that path only exists on the router, and none of the
# helpers under test need it.
# A second, fully rewritten copy is built further down for the RPC-layer tests,
# where the whole script runs against a stand-in jshn.
sed \
	-e "s#^CT_SYS=.*#CT_SYS=\"$SB/proc/sys/net/netfilter\"#" \
	-e "s#^CT_TABLE=.*#CT_TABLE=\"$SB/proc/nf_conntrack\"#" \
	-e "s#^CT_TABLE_ALT=.*#CT_TABLE_ALT=\"$SB/proc/ip_conntrack\"#" \
	-e "s#^WORKDIR=.*#WORKDIR=\"$SB/work\"#" \
	-e "s#^OAF_MOD_PROCS=.*#OAF_MOD_PROCS=\"$SB/proc/net/af_active_app $SB/proc/net/af_conn\"#" \
	-e "s#/sys/class/net#$SB/sys/class/net#g" "$SRC" \
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
echo "=== ct_limits（连接表占用 / 上限）==="
ck "读到 count 与 max"   "$(ct_limits)"  "8 65536"

echo ""
echo "=== ct_ports（按被访问的服务端口归类）==="
# 逐项断言而不是比对整段输出：count 相同的项在 top_list 里顺序不保证。
PORTS=$(ct_ports "$SB/proc/nf_conntrack")
pc() { printf '%s\n' "$PORTS" | awk -F'\t' -v n="$1" '$1 == n { print $2 }'; }
ck "出站 TCP 443 归 HTTPS"      "$(pc HTTPS)"  "3"
ck "出站 UDP 443 归 QUIC"       "$(pc QUIC)"   "2"
ck "入站 SSH 用原始方向端口"     "$(pc SSH)"    "1"
ck "端口转发进来的 8080 归 HTTP" "$(pc HTTP)"   "1"
ck "ICMP 无端口归其他"           "$(pc 其他)"   "1"
# 若 IPv6 那行被算进来，HTTPS 会变成 4 —— 这条就是为它设的闸
ck "IPv6 行整体跳过"            "$(printf '%s\n' "$PORTS" | \
	awk -F'\t' '{ s += $2 } END { print s }')" "8"
ck "表不存在时静默返回空"        "$(ct_ports "$SB/nosuch")" ""

echo ""
echo "=== top_list（取前 N，余量并进其他）==="
ck "取前 2 并把余量归并" \
	"$(printf 'a\t5\nb\t4\nc\t3\nd\t2\n' | top_list 2)" \
	"$(printf 'a\t5\nb\t4\n其他\t5')"
ck "已有的其他被并入而非重复出现" \
	"$(printf 'a\t5\n其他\t2\nb\t1\n' | top_list 1)" \
	"$(printf 'a\t5\n其他\t3')"
ck "不足 N 项时不凭空造出其他" \
	"$(printf 'a\t2\nb\t1\n' | top_list 5)" "$(printf 'a\t2\nb\t1')"

echo ""
# ---- RPC-layer tests --------------------------------------------------------
# The entry point needs jshn; the router ships it, the sandbox does not. This
# stand-in implements just the primitives the script uses -- enough to drive
# This stand-in implements just the primitives the script uses -- enough to
cat > "$SB/jshn.sh" <<'EOS'
JSON_OUT=""; JSON_IN=""
json_init() { JSON_OUT=""; }
json_load() { JSON_IN="$1"; }
json_get_var() {
	local __var="$1" __key="$2" __v=""
	__v=$(printf '%s' "$JSON_IN" | awk -v key="$__key" '
		{ n = split($0, t, "\"")
		  for (i = 1; i <= n; i++)
		  	if (t[i] == key && t[i+1] ~ /^[ \t]*:/) { print t[i+2]; exit } }')
	if [ -z "$__v" ]; then
		__v=$(printf '%s' "$JSON_IN" | \
			sed -n 's/.*"'"$__key"'":[ \t]*\([0-9][0-9]*\).*/\1/p' | head -n1)
	fi
	eval "$__var=\"\$__v\""
}
json_add_string()  { JSON_OUT="$JSON_OUT\"$1\":\"$2\","; }
json_add_int()     { JSON_OUT="$JSON_OUT\"$1\":$2,"; }
json_add_boolean() { JSON_OUT="$JSON_OUT\"$1\":$2,"; }
json_add_double()  { JSON_OUT="$JSON_OUT\"$1\":$2,"; }
json_add_object()  { JSON_OUT="${JSON_OUT:-}\"$1\":{"; }
json_close_object(){ JSON_OUT="${JSON_OUT:-}},"; }
json_add_array()   { JSON_OUT="${JSON_OUT:-}\"$1\":["; }
json_close_array() { JSON_OUT="${JSON_OUT:-}],"; }
json_dump()        { printf '{%s}\n' "${JSON_OUT%,}"; }
EOS

# busybox-uci subset: enough for the named-section alias store. State is a
# flat key=value file; `show` prints it with the package prefix prepended.
cat > "$SB/bin/uci" <<'EOS'
#!/bin/sh
while [ "$1" = "-q" ]; do Q=1; shift; done
S="${UCI_STATE:?}"
touch "$S" 2>/dev/null || exit 1
cmd="$1"; shift
case "$cmd" in
	set)
		k="${1%%=*}"; v="${1#*=}"
		grep -v "^$k=" "$S" > "$S.n" 2>/dev/null
		printf '%s=%s\n' "$k" "$v" >> "$S.n"
		mv -f "$S.n" "$S"; exit 0 ;;
	delete)
		grep -vE "^$1(=|[.])" "$S" > "$S.n" 2>/dev/null
		mv -f "$S.n" "$S"; exit 0 ;;
	get)
		v=$(grep "^$1=" "$S" | head -n1 | cut -d= -f2-)
		[ -n "$v" ] && { printf '%s\n' "$v"; exit 0; }
		[ "$Q" = 1 ] && exit 0; exit 1 ;;
	commit) exit 0 ;;
	show) grep -v '^$' "$S" 2>/dev/null; exit 0 ;;
esac
[ "$Q" = 1 ] && exit 0
exit 1
EOS
chmod +x "$SB/bin/uci"

# A full copy of the backend with every filesystem knob aimed at the sandbox.
sed \
	-e "s#^CT_SYS=.*#CT_SYS=\"$SB/proc/sys/net/netfilter\"#" \
	-e "s#^CT_TABLE=.*#CT_TABLE=\"$SB/proc/nf_conntrack\"#" \
	-e "s#^CT_TABLE_ALT=.*#CT_TABLE_ALT=\"$SB/proc/ip_conntrack\"#" \
	-e "s#^WORKDIR=.*#WORKDIR=\"$SB/work\"#" \
	-e "s#^OAF_MOD_PROCS=.*#OAF_MOD_PROCS=\"$SB/proc/net/af_active_app $SB/proc/net/af_conn\"#" \
	-e "s#^OAF_CFG_DIR=.*#OAF_CFG_DIR=\"$SB/appfilter\"#" \
	-e "s#^OAF_CFG_FILE=.*#OAF_CFG_FILE=\"$SB/appfilter/feature.cfg\"#" \
	-e "s#^OAF_ICONS_DIR=.*#OAF_ICONS_DIR=\"$SB/www/app_icons\"#" \
	-e "s#^FEAT_UP_TMP=.*#FEAT_UP_TMP=\"$SB/work/feature.upload\"#" \
	-e "s#^FEAT_EXTRACT=.*#FEAT_EXTRACT=\"$SB/work/featup\"#" \
	-e "s#^OAF_SYSCTL=.*#OAF_SYSCTL=\"$SB/proc/sys/oaf\"#" \
	-e "s#^DHCP_LEASES=.*#DHCP_LEASES=\"$SB/dhcp.leases\"#" \
	-e "s#^ARP_FILE=.*#ARP_FILE=\"$SB/proc/net/arp\"#" \
	-e "s#/sys/class/net#$SB/sys/class/net#g" \
	-e "s#^\. /usr/share/libubox/jshn.sh#. \"$SB/jshn.sh\"#" \
	"$SRC" > "$SB/netview.rpc"

mkdir -p "$SB/appfilter" "$SB/www/app_icons" "$SB/proc/sys/oaf"
printf 'br-lan\n' > "$SB/proc/sys/oaf/lan_ifname"
printf '0\n'      > "$SB/proc/sys/oaf/work_mode"
printf '#version v26.04.10\n#format v3.0\n#id name:[proto]\n1001 YouTube:[tcp;;443;youtube;;]\n2001 王者荣耀:[tcp;;;;;00:33]\n' \
	> "$SB/appfilter/feature.cfg"
# rpc() runs the full backend entry. Calls that pass a request payload pipe it
# in themselves; every other call MUST be given </dev/null -- oaf_req reads
# stdin when it is not a tty, and an inherited never-EOF pipe would hang it.
# (rpcd itself closes stdin after writing the args, so the real path is fine.)
rpc() { PATH="$SB/bin:$PATH" sh "$SB/netview.rpc" call "$@"; }
: > "$SB/uci.state"; export UCI_STATE="$SB/uci.state"

echo ""
echo "=== devices（别名 > DHCP 主机名，MAC 双来源）==="
# 重写 conntrack 夹具为带 bytes= 的两行（helper 段的 ct_ports 测试已跑完）
printf 'ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.9.5 dst=8.8.8.8 sport=1 dport=443 src=8.8.8.8 dst=192.168.9.5 sport=443 dport=1 packets=1 bytes=100 mark=0 use=1\nipv4     2 tcp      6 431999 ESTABLISHED src=192.168.9.6 dst=8.8.4.4 sport=2 dport=443 src=8.8.4.4 dst=192.168.9.6 sport=443 dport=2 packets=1 bytes=200 mark=0 use=1\n' > "$SB/proc/nf_conntrack"
printf '431999 aa:bb:cc:dd:ee:01 192.168.9.5 desktop\n' > "$SB/dhcp.leases"
printf 'IP address       HW type     Flags       HW address            Mask     Device\n192.168.9.6     0x1         0x2         aa:bb:cc:dd:ee:02     *        br-lan\n' > "$SB/proc/net/arp"
OUT=$(rpc devices < /dev/null)
ck "dhcp 主机名进表"       "$(printf '%s' "$OUT" | grep -c '"host":"desktop"')" "1"
ck "mac 来自 lease"        "$(printf '%s' "$OUT" | grep -c 'aa:bb:cc:dd:ee:01')" "1"
ck "mac 回落 arp 表"       "$(printf '%s' "$OUT" | grep -c 'aa:bb:cc:dd:ee:02')" "1"
ck "无名字按未知处理"      "$(printf '%s' "$OUT" | grep -c '"host":"-"')" "1"

echo ""
echo "=== set_alias（UCI 命名节，按 IP 定位）==="
OUT=$(printf '{"ip":"192.168.9.6","name":"我的盒子"}' | rpc set_alias)
ck "设置成功"             "$(printf '%s' "$OUT" | grep -c '"ok":1')" "1"
OUT=$(rpc devices < /dev/null)
ck "别名优先于未知"        "$(printf '%s' "$OUT" | grep -c '"host":"我的盒子"')" "1"
ck "aliased 标志置位"      "$(printf '%s' "$OUT" | grep -c '"aliased":1')" "1"
OUT=$(printf '{"ip":"192.168.9.6","name":""}' | rpc set_alias)
ck "清空备注成功"          "$(printf '%s' "$OUT" | grep -c '"action":"clear"')" "1"
OUT=$(rpc devices < /dev/null)
ck "清空后回到未知"        "$(printf '%s' "$OUT" | grep -c '"host":"我的盒子"')" "0"
OUT=$(printf '{"ip":"999","name":"x"}' | rpc set_alias)
ck "坏 IP 被拒"           "$(printf '%s' "$OUT" | grep -c 'bad_ip')" "1"

echo ""
echo "======================================"
printf '  pass %s   fail %s\n' "$pass" "$fail"
echo "======================================"
[ "$fail" -eq 0 ]
