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

# oaf.ko 的探活依据是它在 /proc/net 下建的节点。这里刻意**没有**任何
# /proc/sys/oaf/* —— 上一版的 OAF 判据正是去读那个目录，而内核模块从来不建
# 它，于是探测在真机上恒为假；当时的假 sysfs 跟着代码一起造了个 enable 出来，
# 所以测试全绿。夹具现在按内核源码里的节点名建，只建真的有那几个。
mk_oaf_mod() {
	: > "$SB/proc/net/af_active_app"
	: > "$SB/proc/net/af_conn"
	: > "$SB/proc/net/af_client"
}
rm_oaf_mod() {
	rm -f "$SB/proc/net/af_active_app" "$SB/proc/net/af_conn" "$SB/proc/net/af_client"
}

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

# ---- fake OAF ---------------------------------------------------------------
# OAF 的 ubus 门面有两代，对象名、请求形状、回复信封三者都不同：
#
#   老  ubus call appfilter class_list
#       -> {"class_list":[{"name":"视频","app_list":["1001,YouTube,1"]}]}
#
#   新  ubus call fwx common '{"CopyRight":"…","api":"class_list","data":{…}}'
#       -> {"code":2000,"data":{"class_list":[…]},"CopyRight":"…"}
#
# app_list 里的图标标志是可选的（有的构建带、有的不带），这里两种都放进去。
cat > "$SB/classlist.json" <<'EOS'
{
	"class_list": [
		{
			"name": "视频",
			"app_list": [ "1001,YouTube,1", "1002,抖音" ]
		},
		{
			"name": "游戏",
			"app_list": [ "2001,王者荣耀,0" ]
		}
	]
}
EOS

# 新架构的在线更新三件套，按 oafd 真实字段名给出。
cat > "$SB/featinfo.json" <<'EOS'
{"code":2000,"data":{"loaded":1,"version":"2026.08.30","type":0,"free":0,"format":"v4.0","app_count":13422}}
EOS

cat > "$SB/featlist.json" <<'EOS'
{"code":2000,"data":{"version":"v4.0","announcement":"","count":2,"files":[
{"id":"1001","version":"2026.09.20","type":0,"free":1,"lang":"cn","md5":"0123456789abcdef0123456789abcdef","count":13560,"desc":"新增 xxx 识别","date":"2026-09-20"},
{"id":"1002","version":"2026.06.01","type":0,"free":1,"lang":"cn","md5":"fedcba9876543210fedcba9876543210","count":12980,"desc":"常规更新","date":"2026-06-01"}]}}
EOS

cat > "$SB/featstatus.json" <<'EOS'
{"code":2000,"data":{"state":"idle","stage":"idle","status_code":0,"message":"","id":"","icons_skipped":0,"download_total":0,"download_now":0,"elapsed":0}}
EOS

# FAKE_OAF 没设时模拟"模块在，但 oafd 没在跑" —— 探活必须能分辨这一点。
#
# 假 ubus 故意做窄，而且按真机的规矩校验请求：
#   * 真机不回答的（对象名、方法名不对）这里也不回答；
#   * 新架构的请求必须带 "api"，class_list 还必须有 CopyRight。
# 前几轮 OAF 代码恒不生效，全是在这层被吞掉的：调了要 mac 参数的
# dev_visit_list、把请求键写成 api_name（真键是 api）、探活探了内核根本不建的
# /proc/sys/oaf。夹具不严，这些错就都能"通过测试"。
cat > "$SB/bin/ubus" <<'EOS'
#!/bin/sh
gen="${FAKE_OAF:-}"
[ -n "$gen" ] || exit 1

if [ "$1" = "-v" ] && [ "$2" = "list" ]; then
	case "$gen" in
		old) [ "$3" = "appfilter" ] && { echo '{"appfilter":{"class_list":{},"dev_list":{},"dev_visit_list":{}}}'; exit 0; } ;;
		new) [ "$3" = "fwx" ]       && { echo '{"fwx":{"common":{},"debug":{}}}'; exit 0; } ;;
	esac
	exit 1
fi

[ "$1" = "call" ] || exit 1

if [ "$gen" = "old" ]; then
	[ "$2" = "appfilter" ] || exit 1
	# 老架构只有 class_list 这一套，没有特征库在线更新
	[ "$3" = "class_list" ] && { cat "$FAKE_CLASS"; exit 0; }
	exit 1
fi

[ "$2" = "fwx" ] || exit 1
[ "$3" = "common" ] || exit 1
req="$4"
echo "$req" >> "$FAKE_LOG"

# 请求键必须是 "api"：真机取的就是这一个键，写错只会得到 {"code":4000}
api=$(printf '%s' "$req" | sed -n 's/.*"api":"\([^"]*\)".*/\1/p')
[ -n "$api" ] || { echo '{"code":4000}'; exit 0; }

case "$api" in
	class_list)
		# 唯一一个校验 CopyRight 的接口
		case "$req" in
			*'"CopyRight":"www.fanchmwrt.com"'*) ;;
			*) echo '{"code":4000}'; exit 0 ;;
		esac
		printf '{"code":2000,"data":'
		cat "$FAKE_CLASS"
		printf ',"CopyRight":"www.fanchmwrt.com"}\n'
		;;
	get_feature_info)                 cat "$FAKE_FEATINFO" ;;
	get_feature_online_update_status) cat "$FAKE_FEATSTATUS" ;;
	get_feature_online_list)
		# refresh=0 时 oafd 直接吐本地缓存，只有 refresh=1 才联网。
		# 夹具照做：两种情形回复里的 announcement 不同，测试据此断言
		# 后端确实把 refresh 透传下去了。
		case "$req" in
			*'"refresh":1'*)
				sed 's/"announcement":""/"announcement":"fetched"/' "$FAKE_FEATLIST" ;;
			*)
				sed 's/"announcement":""/"announcement":"cached"/' "$FAKE_FEATLIST" ;;
		esac
		;;
	start_feature_online_update)
		# id 无效或重复触发时真机回 {"code":4000,"data":{"status_code":400,"message":"…"}}
		case "$req" in
			*'"id":"1001"'*)
				echo '{"code":2000,"data":{"state":"running","stage":"downloading","status_code":0,"message":"","id":"1001","icons_skipped":0,"download_total":0,"download_now":0,"elapsed":0}}' ;;
			*)
				echo '{"code":4000,"data":{"status_code":400,"message":"invalid file id"}}' ;;
		esac
		;;
	*) exit 1 ;;
esac
EOS
chmod +x "$SB/bin/ubus"
FAKE_CLASS="$SB/classlist.json"; export FAKE_CLASS
FAKE_FEATINFO="$SB/featinfo.json"; export FAKE_FEATINFO
FAKE_FEATLIST="$SB/featlist.json"; export FAKE_FEATLIST
FAKE_FEATSTATUS="$SB/featstatus.json"; export FAKE_FEATSTATUS
: > "$SB/ubus.log"; FAKE_LOG="$SB/ubus.log"; export FAKE_LOG

# ct_apps 专用夹具。mark 的低 16 位就是 app_id：
#   1-2  同一终端同一应用的两条连接，必须合并
#   3    另一个终端另一个应用
#   4    mark=0，OAF 没识别出来，整条丢掉
#   5    经端口转发进来的入站连接：LAN 侧在 original 的 dst，
#        所以上行取 reply 的字节、下行取 original 的（方向要翻过来）
#   6    mark 用十六进制写（0x03E9 = 1001）—— 内核打印格式不保证是十进制
#   7    IPv6 整条跳过，否则 1001 会被重复计入
cat > "$SB/ct_apps.txt" <<'EOS'
ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.9.101 dst=142.250.1.1 sport=52341 dport=443 packets=10 bytes=2000 src=142.250.1.1 dst=192.168.9.101 sport=443 dport=52341 packets=8 bytes=8000 [ASSURED] mark=1001 use=1
ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.9.101 dst=142.250.1.2 sport=52342 dport=443 packets=5 bytes=1000 src=142.250.1.2 dst=192.168.9.101 sport=443 dport=52342 packets=4 bytes=4000 [ASSURED] mark=1001 use=1
ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.9.102 dst=140.82.1.3 sport=52343 dport=443 packets=3 bytes=500 src=140.82.1.3 dst=192.168.9.102 sport=443 dport=52343 packets=2 bytes=2500 [ASSURED] mark=2001 use=1
ipv4     2 udp     17 29 src=192.168.9.101 dst=8.8.8.8 sport=52344 dport=53 packets=1 bytes=300 src=8.8.8.8 dst=192.168.9.101 sport=53 dport=52344 packets=1 bytes=900 [ASSURED] mark=0 use=1
ipv4     2 tcp      6 431999 ESTABLISHED src=203.0.113.9 dst=192.168.9.104 sport=40000 dport=22 packets=4 bytes=700 src=192.168.9.104 dst=203.0.113.9 sport=22 dport=40000 packets=6 bytes=2800 [ASSURED] mark=3001 use=1
ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.9.102 dst=3.3.3.3 sport=52345 dport=443 packets=1 bytes=100 src=3.3.3.3 dst=192.168.9.102 sport=443 dport=52345 packets=1 bytes=500 [ASSURED] mark=0x03E9 use=1
ipv6     2 tcp      6 431999 ESTABLISHED src=2408:8207::1 dst=2408:8888::1 sport=52346 dport=443 src=2408:8888::1 dst=2408:8207::1 sport=443 dport=52346 [ASSURED] mark=1001 use=1
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
echo "=== oaf_mod / oaf_ready（模块加载了没有 / oafd 在不在）==="
# 判据必须是内核模块真建的节点。上一版读的是 /proc/sys/oaf/enable，那个目录
# oaf.ko 从来不建 —— 真机上 oaf_ready 因此恒为假，而夹具跟着造了个 enable，
# 于是测试全绿。这一节就守着这一点。
mk_oaf_mod
ck "模块在 + oafd 在"             "$(FAKE_OAF=new oaf_ready; echo $?)" "0"
ck "模块在 + oafd 没跑"           "$(FAKE_OAF= oaf_ready; echo $?)"   "1"
rm_oaf_mod
ck "没有模块时不认 OAF（哪怕 oafd 在）" \
	"$(FAKE_OAF=new oaf_ready; echo $?)" "1"
ck "模块在"                       "$(mk_oaf_mod; oaf_mod; echo $?)"   "0"
ck "没有模块"                     "$(rm_oaf_mod; oaf_mod; echo $?)"   "1"
mk_oaf_mod

echo ""
echo "=== oaf_gen（区分两代 ubus 门面）==="
ck "老架构：appfilter 上的 class_list" "$(FAKE_OAF=old oaf_gen)" "old"
ck "新架构：fwx 上的 common 分发器"     "$(FAKE_OAF=new oaf_gen)" "new"
ck "都没有时如实说 none"               "$(FAKE_OAF= oaf_gen)"    "none"

echo ""
echo "=== oaf_api（请求形状：新架构必须带 api + CopyRight）==="
# 夹具按真机规矩校验请求，形状错了只会拿到 {"code":4000} 或者干脆没回复。
: > "$SB/ubus.log"
ck "新架构 class_list 能拿到载荷" \
	"$(FAKE_OAF=new oaf_api class_list | grep -c '"class_list"')" "1"
ck "请求里带上了 api 键" \
	"$(grep -c '"api":"class_list"' "$SB/ubus.log")" "1"
ck "class_list 请求带上了 CopyRight" \
	"$(grep -c '"CopyRight":"www.fanchmwrt.com"' "$SB/ubus.log")" "1"
ck "老架构调用的是独立方法" \
	"$(FAKE_OAF=old oaf_api class_list | grep -c '"class_list"')" "1"
ck "老架构没有的接口返回空" \
	"$(FAKE_OAF=old oaf_api get_feature_info)" ""
ck "新架构能取特征库信息" \
	"$(FAKE_OAF=new oaf_api get_feature_info | grep -c '13422')" "1"
ck "data 参数原样透传（refresh 生效）" \
	"$(FAKE_OAF=new oaf_api get_feature_online_list '{"refresh":1}' | grep -c 'fetched')" "1"
ck "refresh 缺省时走缓存" \
	"$(FAKE_OAF=new oaf_api get_feature_online_list '{"refresh":0}' | grep -c 'cached')" "1"

echo ""
echo "=== json_str / json_flat / flat_get（两种信封都要能读）==="
OLD_CLASS="$(cat "$SB/classlist.json")"
NEW_CLASS="$(FAKE_OAF=new oaf_api class_list)"
ck "扁平信封里取字符串"   "$(printf '%s' "$OLD_CLASS" | json_str name)" "视频"
ck "带信封的也能取到"     "$(printf '%s' "$NEW_CLASS" | json_str name)" "视频"
ck "冒号后有空格也认"     "$(printf '%s' '{"name": "视频"}' | json_str name)" "视频"
ck "键不在时不凭空取值"   "$(printf '%s' "$NEW_CLASS" | json_str nosuchkey)" ""
ck "空字符串是有效值"     "$(printf '%s' '{"message":""}' | json_str message)" ""
# json_str 只认带引号的值，裸数字交给 json_flat —— 这条守着这个分工
ck "json_str 不抓裸数字"  "$(printf '%s' '{"count":3}' | json_str count)" ""
FT="$(printf '%s' '{"code":2000,"data":{"state":"idle","status_code":0,"download_total":1024}}' | json_flat 'code state status_code download_total')"
ck "信封里的 code"        "$(flat_get "$FT" code)"           "2000"
ck "嵌套 data 里的字符串" "$(flat_get "$FT" state)"          "idle"
ck "嵌套 data 里的数字"   "$(flat_get "$FT" status_code)"    "0"
ck "数字后面跟着 }"       "$(flat_get "$FT" download_total)" "1024"
ck "没要的键不输出"       "$(flat_get "$FT" message)"        ""

echo ""
echo "=== json_atom / num_or0 / req_flag（喂给 ubus 和 jshn 前先收口）==="
ck "id 里的引号被去掉"    "$(json_atom '1001","x":"')"  "1001x"
ck "md5 原样保留"         "$(json_atom '0123456789abcdef')" "0123456789abcdef"
ck "中文被剔除"           "$(json_atom '视频1001')"      "1001"
ck "空值仍是空"           "$(json_atom '')"              ""
ck "非数字归零"           "$(num_or0 'abc')"             "0"
ck "空值归零"             "$(num_or0 '')"                "0"
ck "数字原样"             "$(num_or0 '13422')"           "13422"
ck "refresh=true 认"      "$(req_flag '{"refresh":true}' refresh)"  "1"
ck "refresh=1 认"         "$(req_flag '{"refresh":1}' refresh)"     "1"
ck "refresh=false 不认"   "$(req_flag '{"refresh":false}' refresh)" "0"
ck "缺省不认"             "$(req_flag '{}' refresh)"                "0"

echo ""
echo "=== feat_files（在线目录 -> 每条一行）==="
FL="$(FAKE_OAF=new oaf_api get_feature_online_list '{"refresh":1}' | feat_files)"
ck "两条都解析出来"       "$(printf '%s\n' "$FL" | wc -l | tr -d ' ')" "2"
ck "第 1 条 id"           "$(printf '%s\n' "$FL" | awk -F'\t' 'NR==1{print $1}')" "1001"
ck "第 1 条 version"      "$(printf '%s\n' "$FL" | awk -F'\t' 'NR==1{print $2}')" "2026.09.20"
ck "第 1 条 count"        "$(printf '%s\n' "$FL" | awk -F'\t' 'NR==1{print $5}')" "13560"
ck "第 1 条 md5"          "$(printf '%s\n' "$FL" | awk -F'\t' 'NR==1{print $7}')" "0123456789abcdef0123456789abcdef"
ck "第 2 条 desc"         "$(printf '%s\n' "$FL" | awk -F'\t' 'NR==2{print $8}')" "常规更新"
# 目录自己的 count 字段在 files 之前，不能被当成某一条的 count
ck "外层 count 不串到条目上" "$(printf '%s\n' "$FL" | awk -F'\t' '{s+=$5} END{print s}')" "26540"
ck "没有 files 时安静地空"  "$(printf '%s' '{"code":2000,"data":{"count":0,"files":[]}}' | feat_files | wc -l | tr -d ' ')" "0"
ck "条目缺 id 就丢掉"       "$(printf '%s' '{"files":[{"version":"1.0"}]}' | feat_files | wc -l | tr -d ' ')" "0"

echo ""
echo "=== oaf_map_fetch（class_list -> appid / 分类 / 应用名）==="
FAKE_OAF=old oaf_map_fetch
ck "老架构调用形式能解析"     "$(awk -F'\t' 'NR>1{printf "%s/%s ", $2, $3}' "$TMP_APPMAP")" "视频/YouTube 视频/抖音 游戏/王者荣耀 "
FAKE_OAF=new oaf_map_fetch
ck "新架构调用形式能解析"     "$(awk -F'\t' 'NR>1{printf "%s ", $1}' "$TMP_APPMAP")" "1001 1002 2001 "
ck "带不带图标标志都认"       "$(awk -F'\t' '$1==1002{print $3}' "$TMP_APPMAP")" "抖音"
ck "第 1 行是缓存时间戳"      "$(sed -n '1p' "$TMP_APPMAP" | grep -cE '^[0-9]+$')" "1"
ck "ubus 不在时失败而非写坏缓存" "$(rm -f "$TMP_APPMAP"; FAKE_OAF= oaf_map_fetch; echo $?)" "1"

echo ""
echo "=== oaf_appmap（缓存命中 / 过期降级）==="
FAKE_OAF=old oaf_map_fetch
ck "TTL 内命中缓存（ubus 已不可用也照用）" \
	"$(FAKE_OAF= oaf_appmap; awk -F'\t' 'NR>1{printf "%s ", $1}' "$TMP_APPMAP")" "1001 1002 2001 "
# 把时间戳拨回 0 让它过期；此时 ubus 拿不到新数据，应当留着旧缓存而不是清空
{ echo 0; tail -n +2 "$TMP_APPMAP"; } > "$TMP_APPMAP.t" && mv -f "$TMP_APPMAP.t" "$TMP_APPMAP"
FAKE_OAF= oaf_appmap
ck "过期且取不到新数据时保留旧缓存" \
	"$(awk -F'\t' 'NR>1{printf "%s ", $1}' "$TMP_APPMAP")" "1001 1002 2001 "

echo ""
echo "=== ct_apps（mark 低 16 位当 app_id，按终端聚合字节）==="
APP="$(ct_apps "$SB/ct_apps.txt")"
ck "mark=0 与 IPv6 行都被丢掉"    "$(printf '%s\n' "$APP" | wc -l | tr -d ' ')" "4"
ck "同终端同应用的两条连接合并"    "$(printf '%s\n' "$APP" | grep -F "$(printf '192.168.9.101\t1001\t')")" "$(printf '192.168.9.101\t1001\t3000\t12000')"
ck "入站连接的方向要翻过来"        "$(printf '%s\n' "$APP" | grep -F "$(printf '192.168.9.104\t3001\t')")" "$(printf '192.168.9.104\t3001\t2800\t700')"
ck "十六进制的 mark 也能解"        "$(printf '%s\n' "$APP" | grep -F "$(printf '192.168.9.102\t1001\t')")" "$(printf '192.168.9.102\t1001\t100\t500')"

echo ""
echo "=== app_join（换成应用名 + 每设备只留 Top N）==="
FAKE_OAF=old oaf_map_fetch
ct_apps "$SB/ct_apps.txt" > "$TMP_APPRAW"
ck "Top 3 时 4 行全留"           "$(app_join 3 | wc -l | tr -d ' ')" "4"
ck "appid 换成了应用名"          "$(app_join 3 | grep -cF "$(printf '192.168.9.101\tYouTube\t3000\t12000')")" "1"
ck "未收录的 appid 用 #id 兜底"  "$(app_join 3 | grep -cF "$(printf '192.168.9.104\t#3001\t')")" "1"
ck "Top 1 时每台设备只剩一行"     "$(app_join 1 | wc -l | tr -d ' ')" "3"
ck "Top 1 留的是流量大的那个"     "$(app_join 1 | grep -cF '王者荣耀')" "1"

echo ""
echo "======================================"
printf '  pass %s   fail %s\n' "$pass" "$fail"
echo "======================================"
[ "$fail" -eq 0 ]
