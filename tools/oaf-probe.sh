#!/bin/sh
# OAF 接入探测（只读，不改任何配置）
#
# 目的：在装好 kmod-oaf 之后，确认 netview 能否实现
#       「终端 × 应用 × 真实字节数」。
#
# 判据有三条，缺一条这条路就走不通：
#   1. /proc/net/nf_conntrack 每行能看到 mark=      -> OAF 给连接打了应用标签
#   2. mark 的低 16 位就是 app_id                   -> 能与下面的名字对上
#   3. 每行还能看到 bytes=                          -> 有真实字节数
#
# 用法：
#   sh oaf-probe.sh            直接看输出
#   sh oaf-probe.sh > /tmp/oaf-probe.txt 2>&1    存文件再贴回来
#
# 全程只读：不写 sysctl、不改 uci、不重启服务。

sec() { printf '\n\033[1m--- %s ---\033[0m\n' "$1"; }
say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- 环境 ---
sec "环境"
say "内核        : $(uname -r)"
say "系统        : $(sed -n 's/^DISTRIB_DESCRIPTION=//p' /etc/openwrt_release 2>/dev/null | tr -d \"'\")"
say "架构        : $(sed -n 's/^DISTRIB_ARCH=//p' /etc/openwrt_release 2>/dev/null | tr -d \"'\")"

if have opkg; then
	say "相关软件包  :"
	opkg list-installed 2>/dev/null | grep -Ei 'oaf|appfilter' | sed 's/^/              /'
else
	say "相关软件包  : 没有 opkg（apk 系统请用 apk list --installed 自查）"
fi

say "oafd 进程   :"
ps 2>/dev/null | grep -E 'oafd|rule_manager' | grep -v grep | sed 's/^/              /'
[ -n "$(ps 2>/dev/null | grep -E 'oafd|rule_manager' | grep -v grep)" ] || say "              (没有在跑)"

# ------------------------------------------------------------ 内核模块 ---
sec "1. 内核模块"
if [ -d /proc/sys/oaf ]; then
	say "/proc/sys/oaf 存在，内容："
	ls -l /proc/sys/oaf/ | sed 's/^/  /'
	for f in /proc/sys/oaf/*; do
		[ -f "$f" ] && say "  $(basename "$f") = $(cat "$f" 2>/dev/null)"
	done
else
	say "!! /proc/sys/oaf 不存在 —— kmod-oaf 没加载，后面都不用看了"
fi

say ""
say "内核模块是否在内存里："
(lsmod 2>/dev/null | grep -i oaf | sed 's/^/  /') || say "  (lsmod 无 oaf)"
say ""

say "OAF 自带的 /proc/net 接口："
for p in /proc/net/af_client /proc/net/af_visit /proc/net/af_client_visit_list \
         /proc/net/af_conn /proc/net/af_active_app /proc/net/af_active_host; do
	if [ -e "$p" ]; then
		say "  有  $p"
	else
		say "  无  $p"
	fi
done
if [ -d /proc/net/fwx_client ]; then
	say "  有  /proc/net/fwx_client/  （每设备一个子目录）"
	ls /proc/net/fwx_client/ 2>/dev/null | head -5 | sed 's/^/        设备: /'
else
	say "  无  /proc/net/fwx_client/"
fi

# ------------------------------------------------------------- 特征库 ---
sec "2. 特征库"
for p in /etc/fwxd/feature.bin /etc/fwxd/feature.bin.bak /etc/fwxd/custom_feature.cfg \
         /etc/fwxd/feature_list.json /etc/fwxd/oaf_version /tmp/feature.cfg \
         /tmp/feature.bin /tmp/feature_info.json; do
	if [ -e "$p" ]; then
		say "  有  $(ls -l "$p" | awk '{print $5" 字节  "$9}')"
	else
		say "  无  $p"
	fi
done
if [ -f /tmp/feature.cfg ]; then
	say ""
	say "/tmp/feature.cfg 前 6 行："
	head -6 /tmp/feature.cfg | sed 's/^/  /'
fi

# ------------------------------------------------------ conntrack 关键 ---
sec "3. conntrack 的 mark 与 bytes  ← 最关键的一段"
CT=/proc/net/nf_conntrack
[ -r "$CT" ] || CT=/proc/net/ip_conntrack
# 允许用 OAF_PROBE_CT 指向一份样本，便于离线验证本段的统计逻辑
[ -n "$OAF_PROBE_CT" ] && CT="$OAF_PROBE_CT"
if [ ! -r "$CT" ]; then
	say "!! 两个 conntrack 表都读不到"
else
	say "表文件      : $CT"
	say "连接总数    : $(grep -c 'src=' "$CT" 2>/dev/null)"
	say "acct 开关   : $(cat /proc/sys/net/netfilter/nf_conntrack_acct 2>/dev/null || echo '读不到')"
	say "            （=1 才有 bytes=；=0 时 OAF 路线也拿不到字节数）"
	say ""
	say "一条原始样本（看清楚字段长什么样）："
	grep 'src=' "$CT" 2>/dev/null | head -1 | sed 's/^/  /'
	say ""

	awk '
		/src=/ {
			mark = ""; bytes = 0; nbytes = 0
			for (i = 1; i <= NF; i++) {
				if (mark == "" && $i ~ /^mark=/) mark = substr($i, 6)
				if ($i ~ /^bytes=/) { nbytes++; if (nbytes == 1) bytes = substr($i, 7) }
			}
			total++
			if (nbytes > 0)   withbytes++
			if (mark != "") { withmark++; m[mark]++ }
			if (mark != "" && mark + 0 != 0) {
				nonzero++
				app = mark + 0
				app = app % 65536
				appcount[app]++
			}
		}
		END {
			printf "  总连接        : %d\n", total
			printf "  含 mark= 的   : %d\n", withmark
			printf "  含 bytes= 的  : %d\n", withbytes
			printf "  mark 非 0 的  : %d\n", nonzero
			printf "\n"
			printf "  mark 取值分布（前 10）：\n"
			n = 0
			for (k in m) { n++; if (n <= 10) printf "    mark=%-12s 出现 %d 次   低16位=%d\n", k, m[k], (k + 0) % 65536 }
			if (n == 0) printf "    （一个 mark 都没有）\n"
			printf "\n"
			printf "  按低16位当成 app_id 聚合（前 10）：\n"
			n = 0
			for (k in appcount) { n++; if (n <= 10) printf "    app_id=%-6d 连接数=%d\n", k, appcount[k] }
			if (n == 0) printf "    （没有非零 mark，说明 OAF 还没给任何连接打过标签）\n"
		}
	' "$CT"

	say ""
	say "  3 条带非零 mark 的完整样本（用来核对方向与字节数）："
	awk '
		{
			mark = ""
			for (i = 1; i <= NF; i++) if (mark == "" && $i ~ /^mark=/) mark = substr($i, 6)
			if (mark != "" && mark + 0 != 0 && n < 3) { print "    " $0; n++ }
		}
	' "$CT"
fi

# ----------------------------------------------------------------- ubus ---
sec "4. ubus 接口"
if ! have ubus; then
	say "!! 没有 ubus 命令"
else
	say "appfilter 对象是否注册："
	if ubus -v list appfilter >/dev/null 2>&1; then
		say "  是。方法清单："
		ubus -v list appfilter 2>/dev/null | sed 's/^/    /'
	else
		say "  否 —— oafd 没在跑，或对象名不是 appfilter"
	fi

	say ""
	say "【A 老架构】ubus call appfilter class_list"
	ubus call appfilter class_list 2>&1 | head -c 1200 | sed 's/^/    /'
	say ""
	say "【A 老架构】ubus call appfilter dev_list"
	ubus call appfilter dev_list 2>&1 | head -c 2000 | sed 's/^/    /'

	say ""
	say "【B 新架构】ubus call appfilter common '{\"api_name\":\"class_list\"}'"
	ubus call appfilter common '{"api_name":"class_list"}' 2>&1 | head -c 1200 | sed 's/^/    /'
	say ""
	say "【B 新架构】ubus call appfilter common '{\"api_name\":\"dev_list\"}'"
	ubus call appfilter common '{"api_name":"dev_list"}' 2>&1 | head -c 2000 | sed 's/^/    /'

	say ""
	say "每设备接口（取第一个设备试）："
	MAC=$(ubus call appfilter dev_list 2>/dev/null \
		| sed -n 's/.*"mac":"\([0-9a-fA-F:]*\)".*/\1/p' | head -1)
	if [ -z "$MAC" ]; then
		MAC=$(cat /tmp/dhcp.leases 2>/dev/null | awk 'NR==1{print $2}')
	fi
	if [ -n "$MAC" ]; then
		say "  用 mac=$MAC"
		say "  ubus call appfilter dev_visit_list '{\"mac\":\"$MAC\"}'"
		ubus call appfilter dev_visit_list "{\"mac\":\"$MAC\"}" 2>&1 | head -c 1500 | sed 's/^/    /'
		say ""
		say "  /proc/net/fwx_client/<mac>/visit_list"
		MACDASH=$(printf '%s' "$MAC" | tr -d ':')
		cat "/proc/net/fwx_client/$MACDASH/visit_list" 2>/dev/null | head -c 1500 | sed 's/^/    /'
		cat "/proc/net/fwx_client/$MAC/visit_list" 2>/dev/null | head -c 1500 | sed 's/^/    /'
	else
		say "  拿不到 mac，跳过"
	fi
fi

# ----------------------------------------------------------- 内核日志 ---
sec "5. 内核日志里的 oaf（看特征库有没有推送成功）"
(dmesg 2>/dev/null | grep -i 'oaf\|fwx\|feature' | tail -25 | sed 's/^/  /') || say "  (读不到 dmesg)"

# --------------------------------------------------------------- 判定 ---
sec "判定"
MARK=$(awk '/src=/{for(i=1;i<=NF;i++) if($i ~ /^mark=/){n++; break}} END{print n+0}' "$CT" 2>/dev/null)
NZ=$(awk '/src=/{m="";for(i=1;i<=NF;i++) if(m==""&&$i~/^mark=/){m=substr($i,6)}; if(m!=""&&m+0!=0)c++} END{print c+0}' "$CT" 2>/dev/null)
BY=$(awk '/src=/{for(i=1;i<=NF;i++) if($i ~ /^bytes=/){c++; break}} END{print c+0}' "$CT" 2>/dev/null)
ACCT=$(cat /proc/sys/net/netfilter/nf_conntrack_acct 2>/dev/null)

if [ -d /proc/sys/oaf ]; then
	say "[ok]   kmod-oaf 已加载"
else
	say "[缺失] kmod-oaf 没加载 —— 请先确认模块装上并 modprobe oaf"
fi

if [ "$MARK" -gt 0 ] 2>/dev/null; then
	say "[ok]   conntrack 里有 mark= 字段（$MARK 条）"
else
	say "[缺失] conntrack 里没有 mark= 字段 —— 缺少 CONFIG_NF_CONNTRACK_MARK"
fi

if [ "$NZ" -gt 0 ] 2>/dev/null; then
	say "[ok]   已有 $NZ 条连接被 OAF 打上非零 mark → 应用识别在工作"
	say "       → 「终端 × 应用」可以做到，名字需再取 ubus class_list/dev_list"
else
	say "[注意] 目前没有非零 mark。KPI：先让设备产生流量（刷个视频），再看第 3 节"
	say "       若 oafd 没跑 / 特征库没推入内核，也会一直为 0"
fi

if [ "$BY" -gt 0 ] 2>/dev/null; then
	say "[ok]   conntrack 带 bytes= （$BY 条）→ 真实字节数可拿"
else
	say "[缺失] conntrack 没有 bytes= —— 需要 nf_conntrack_acct=1（当前 ${ACCT:-未知}）"
	say "       开法：echo 1 > /proc/sys/net/netfilter/nf_conntrack_acct"
	say "       持久化：echo 'net.netfilter.nf_conntrack_acct=1' >> /etc/sysctl.conf"
	say "       注意：软件流卸载(flow offload)会让已卸载连接的字节数不再增长"
fi

say ""
say "把整份输出贴回来即可。"
