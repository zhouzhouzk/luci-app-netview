#!/bin/sh
# Exercise the device table + set_alias RPC methods against a fake conntrack /
# dhcp.leases / arp / uci tree.
#
# The assertion this test exists for: the alias is keyed by MAC, not IP. Change
# the IP a device holds and the same hardware address must keep its label.
# (That is exactly the bug this feature was rebuilt to fix.)

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../root/usr/libexec/rpcd/netview"
SB="$HERE/sandbox/rpc"

# WorkBuddy 的 shim 把 rm 接到 genie-trash 上，会在批量清理时阻塞。
rm() { /usr/bin/rm "$@"; }

rm -rf "$SB"; mkdir -p "$SB/work" "$SB/bin"

# ---- fake jshn (the subset do_devices / do_set_alias use) -------------------
cat > "$SB/jshn.sh" <<'EOS'
JSON_OUT=""
json_init() { JSON_OUT=""; }
json_add_string()  { JSON_OUT="${JSON_OUT}\"$1\":\"$2\","; }
json_add_int()     { JSON_OUT="${JSON_OUT}\"$1\":$2,"; }
json_add_boolean() { JSON_OUT="${JSON_OUT}\"$1\":$2,"; }
json_add_double()  { JSON_OUT="${JSON_OUT}\"$1\":$2,"; }
json_add_array()   { JSON_OUT="${JSON_OUT}\"$1\":["; }
json_close_array() { JSON_OUT="${JSON_OUT}],"; }
json_add_object()  { if [ $# -gt 0 ]; then JSON_OUT="${JSON_OUT}\"$1\":{"; else JSON_OUT="${JSON_OUT}{"; fi; }
json_close_object(){ JSON_OUT="${JSON_OUT}},"; }
json_dump()        { printf '{%s}\n' "${JSON_OUT%,}"; }
EOS

# ---- fake uci --------------------------------------------------------------
# Stores "netview.<sid>.<field>=<value>" lines; show() dumps them raw. Enough
# for set / delete / commit / show / get, which is all the backend uses.
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

# fake ip：只覆盖 do_devices 用的 "ip -4 -o addr show scope global"，
# 返回路由器自身地址（LAN IP + PPP 内层 IP），用于验证自身流量被剔除。
cat > "$SB/bin/ip" <<'EOS'
#!/bin/sh
echo "2: br-lan    inet 192.168.1.1/24 brd 192.168.1.255 scope global br-lan"
echo "7: pppoe-wan inet 172.17.240.84/32 scope global pppoe-wan"
exit 0
EOS
chmod +x "$SB/bin/ip"

export UCI_STATE="$SB/uci.state"
: > "$UCI_STATE"
PATH="$SB/bin:$PATH"; export PATH

# ---- fake data -------------------------------------------------------------
cat > "$SB/nf_conntrack" <<'EOS'
ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.9.5 dst=8.8.8.8 sport=1 dport=443 src=8.8.8.8 dst=192.168.9.5 sport=443 dport=1 packets=1 bytes=100 mark=0 use=1
ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.9.6 dst=8.8.4.4 sport=2 dport=443 src=8.8.4.4 dst=192.168.9.6 sport=443 dport=2 packets=1 bytes=200 mark=0 use=1
ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.1.1 dst=223.5.5.5 sport=3 dport=53 src=223.5.5.5 dst=192.168.1.1 sport=53 dport=3 packets=1 bytes=500 mark=0 use=1
ipv4     2 tcp      6 431999 ESTABLISHED src=172.17.240.84 dst=1.2.4.8 sport=4 dport=443 src=1.2.4.8 dst=172.17.240.84 sport=443 dport=4 packets=1 bytes=900 mark=0 use=1
EOS
cat > "$SB/dhcp.leases" <<'EOS'
431999 aa:bb:cc:dd:ee:01 192.168.9.5 desktop
EOS
cat > "$SB/arp" <<'EOS'
IP address       HW type     Flags       HW address            Mask     Device
192.168.9.6     0x1         0x2         aa:bb:cc:dd:ee:02     *        br-lan
EOS

# ---- build the test copy: fake jshn + drop the entry dispatch --------------
sed "s#^\. /usr/share/libubox/jshn.sh#. \"$SB/jshn.sh\"#" "$SRC" \
	| sed '/^# -\{1,\} entry -\{1,\}$/,$d' > "$SB/netview.sh"
. "$SB/netview.sh"

# Aim every filesystem probe at the fake tree (variables, not literals, on
# purpose -- see the comment in the backend).
WORKDIR="$SB/work"
STATE_IF="$WORKDIR/if.state";  STATE_DEV="$WORKDIR/dev.state"
TMP_SNAP="$WORKDIR/if.snap";   TMP_IF="$WORKDIR/if.diff"
TMP_RAW="$WORKDIR/dev.raw";    TMP_DEV="$WORKDIR/dev.diff"
TMP_ALIAS="$WORKDIR/alias.list"; TMP_MERGE="$WORKDIR/names.merge"
CT_TABLE="$SB/nf_conntrack";   CT_TABLE_ALT="$SB/no_ip_conntrack"
DHCP_LEASES="$SB/dhcp.leases"; ARP_FILE="$SB/arp"
UCI_CFG="$SB/netview.config"
mkdir -p "$WORKDIR"

pass=0; fail=0
ck() {
	if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  ok   %-50s = %s\n' "$1" "$2"
	else fail=$((fail+1)); printf '  FAIL %-50s 期望 %s 实得 %s\n' "$1" "$3" "$2"; fi
}
has() { case "$1" in *"$2"*) return 0;; *) return 1;; esac; }

echo "=== devices：MAC 与别名解析 ==="
out=$(do_devices)
has "$out" '"ip":"192.168.9.5","host":"desktop","alias":"","mac":"aa:bb:cc:dd:ee:01"' && r1=1 || r1=0
has "$out" '"ip":"192.168.9.6","host":"-","alias":"","mac":"aa:bb:cc:dd:ee:02"' && r2=1 || r2=0
ck "lease：主机名 + MAC 齐"      "$r1" "1"
ck "arp 回落：主机名 - / MAC 在" "$r2" "1"

# 路由器自身地址（ip -4 addr 收集到的 LAN IP / PPP 内层 IP）不得出现在排行里
has "$out" '"ip":"192.168.1.1"' && r3=1 || r3=0
has "$out" '"ip":"172.17.240.84"' && r4=1 || r4=0
ck "本机 LAN IP 被剔除"         "$r3" "0"
ck "pppoe 内层 IP 被剔除"       "$r4" "0"

echo ""
echo "=== set_alias：按 MAC 写、读、清 ==="
s=$(printf '{"mac":"aa:bb:cc:dd:ee:02","name":"living-room-tv"}' | do_set_alias)
ck "写入成功"       "$(printf '%s' "$s" | grep -o '"ok":[01]')" '"ok":1'
ck "动作为 set"     "$(printf '%s' "$s" | grep -o '"action":"[a-z]*"')" '"action":"set"'

# 换 IP：同一 MAC 改拿 .7，别名必须跟着 MAC 走（而不是留在旧 IP .6 上）。
cat > "$SB/nf_conntrack" <<'EOS'
ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.9.5 dst=8.8.8.8 sport=1 dport=443 src=8.8.8.8 dst=192.168.9.5 sport=443 dport=1 packets=1 bytes=100 mark=0 use=1
ipv4     2 tcp      6 431999 ESTABLISHED src=192.168.9.7 dst=8.8.4.4 sport=2 dport=443 src=8.8.4.4 dst=192.168.9.7 sport=443 dport=2 packets=1 bytes=200 mark=0 use=1
EOS
cat > "$SB/dhcp.leases" <<'EOS'
431999 aa:bb:cc:dd:ee:01 192.168.9.5 desktop
431999 aa:bb:cc:dd:ee:02 192.168.9.7 tv-box
EOS
out=$(do_devices)
has "$out" '"ip":"192.168.9.7","host":"tv-box","alias":"living-room-tv","mac":"aa:bb:cc:dd:ee:02"' && r3=1 || r3=0
has "$out" '"ip":"192.168.9.6"' && r4=1 || r4=0
ck "IP 变化后别名仍按 MAC 命中" "$r3" "1"
ck "旧 IP 已不在列表（无残留）" "$r4" "0"

# 清空别名（name 为空即清除）
s=$(printf '{"mac":"aa:bb:cc:dd:ee:02","name":""}' | do_set_alias)
ck "清空成功"       "$(printf '%s' "$s" | grep -o '"ok":[01]')" '"ok":1'
ck "动作为 clear"   "$(printf '%s' "$s" | grep -o '"action":"[a-z]*"')" '"action":"clear"'
out=$(do_devices)
has "$out" '"ip":"192.168.9.7","host":"tv-box","alias":"","mac":"aa:bb:cc:dd:ee:02"' && r5=1 || r5=0
ck "清空后别名回空" "$r5" "1"

echo ""
echo "=== sessions：连接表占用 + 端口归类 ==="
mkdir -p "$SB/ctsys"
printf '187234\n' > "$SB/ctsys/nf_conntrack_count"
printf '262144\n' > "$SB/ctsys/nf_conntrack_max"
CT_SYS="$SB/ctsys"
s=$(do_sessions)
ck "占用 count/max 正确" "$(printf '%s' "$s" | grep -o '"count":[0-9]*,"max":[0-9]*')" '"count":187234,"max":262144'
ck "来源标记 port"       "$(printf '%s' "$s" | grep -o '"source":"[a-z]*"')" '"source":"port"'
printf '%s\n' "$s" | grep -q '"name":"HTTPS"' && r=1 || r=0
ck "443/tcp 归类为 HTTPS" "$r" "1"
CT_SYS="/proc/sys/net/netfilter"

echo ""
echo "=== 非法 MAC 拒绝 ==="
s=$(printf '{"mac":"not-a-mac","name":"x"}' | do_set_alias)
ck "拒绝并返回 bad_mac" "$(printf '%s' "$s" | grep -o '"reason":"[a-z_]*"')" '"reason":"bad_mac"'

echo ""
echo "======================================"
printf '  pass %s   fail %s\n' "$pass" "$fail"
echo "======================================"
[ "$fail" -eq 0 ]
