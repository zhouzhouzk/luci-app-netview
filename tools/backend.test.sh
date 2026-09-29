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

# ---- fake conntrack ---------------------------------------------------------
mkdir -p "$SB/proc/sys/net/netfilter" "$SB/proc/sys/oaf"
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

# ---- fake OAF ---------------------------------------------------------------
# feature.cfg 是普通文本，后端直接解析它（不走 ubus），所以这里放一份真的。
cat > "$SB/feature.cfg" <<'EOS'
#class 视频
1001 YouTube:[tcp;;443;youtube.com;;]
1002 抖音:[tcp;;443;douyin.com;;]
#class 游戏
2001 王者荣耀:[udp;;;;;;]
EOS

# appname 在 OAF 的 ubus 回复里是硬编码的 "unknown"，只有 appid 是真的 ——
# 这份样例照抄那个形态，顺带确保解析只认 appid。
cat > "$SB/visit.json" <<'EOS'
{
	"dev_list": [
		{
			"hostname": "unknown",
			"mac": "aa:bb:cc:00:00:01",
			"ip": "192.168.9.101",
			"visit_info": [
				{ "appname": "unknown", "appid": 1001, "latest_action": 0, "first_time": 100, "latest_time": 200 },
				{ "appname": "unknown", "appid": 2001, "latest_action": 0, "first_time": 100, "latest_time": 200 }
			]
		},
		{
			"hostname": "unknown",
			"mac": "aa:bb:cc:00:00:02",
			"ip": "192.168.9.102",
			"visit_info": [
				{ "appname": "unknown", "appid": 1001, "latest_action": 0, "first_time": 100, "latest_time": 200 }
			]
		}
	]
}
EOS

# 只实现 oaf_ready / oaf_classes 用到的那两种调用。FAKE_OAF 没设时模拟
# "内核模块在，但 oafd 没在跑" —— ubus 探活必须能分辨这一点。
cat > "$SB/bin/ubus" <<'EOS'
#!/bin/sh
[ -n "$FAKE_OAF" ] || exit 1
if [ "$1" = "-v" ] && [ "$2" = "list" ]; then
	echo '{"appfilter":{"dev_visit_list":{}}}'
	exit 0
fi
if [ "$1" = "call" ] && [ "$2" = "appfilter" ] && [ "$3" = "dev_visit_list" ]; then
	cat "$FAKE_VISIT"
	exit 0
fi
exit 1
EOS
chmod +x "$SB/bin/ubus"
FAKE_VISIT="$SB/visit.json"; export FAKE_VISIT

# ---- build the test copy of the backend ------------------------------------
# keep everything up to the "---- interfaces ----" banner (the helpers), and
# drop the jshn include: that path only exists on the router, and none of the
# helpers under test need it.
sed \
	-e "s#^CT_SYS=.*#CT_SYS=\"$SB/proc/sys/net/netfilter\"#" \
	-e "s#^CT_TABLE=.*#CT_TABLE=\"$SB/proc/nf_conntrack\"#" \
	-e "s#^CT_TABLE_ALT=.*#CT_TABLE_ALT=\"$SB/proc/ip_conntrack\"#" \
	-e "s#^OAF_PROC=.*#OAF_PROC=\"$SB/proc/sys/oaf\"#" \
	-e "s#^OAF_CFG=.*#OAF_CFG=\"$SB/feature.cfg\"#" \
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
echo "=== oaf_ready（OAF 是否真的可用）==="
ck "模块没加载时不认 OAF"     "$(oaf_ready; echo $?)"        "1"
printf '1\n' > "$SB/proc/sys/oaf/enable"
ck "有模块但 oafd 没在跑"     "$(FAKE_OAF= oaf_ready; echo $?)" "1"
ck "模块 + 守护进程 + 特征库齐备" "$(FAKE_OAF=1 oaf_ready; echo $?)" "0"

echo ""
echo "=== oaf_app_map（appid -> 分类 / 应用名）==="
ck "解析 #class 分段与逐行应用" "$(oaf_app_map "$SB/feature.cfg")" \
	"$(printf '1001\t视频\tYouTube\n1002\t视频\t抖音\n2001\t游戏\t王者荣耀')"
ck "特征库不存在时返回空"       "$(oaf_app_map "$SB/nosuch")" ""

echo ""
echo "=== oaf_classes（应用分类 -> 使用设备数）==="
# 同一个 appid 出现在两台设备上就该计 2 —— OAF 的 visit_info 是每设备每应用
# 一条，所以这个数读作"该分类被多少台设备用到"。它没有字节数可算。
ck "同一应用出现在两台设备计 2" "$(FAKE_OAF=1 oaf_classes "$SB/feature.cfg")" \
	"$(printf '视频\t2\n游戏\t1')"
ck "ubus 不可用时静默返回空"     "$(FAKE_OAF= oaf_classes "$SB/feature.cfg")" ""

echo ""
echo "======================================"
printf '  pass %s   fail %s\n' "$pass" "$fail"
echo "======================================"
[ "$fail" -eq 0 ]
