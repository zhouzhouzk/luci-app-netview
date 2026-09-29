#!/bin/sh
# netview × OAF 一键自检（只读，不改任何配置）
#
#   sh oaf-diag.sh                 # 只做检查
#   sh oaf-diag.sh /tmp/xxx.bin    # 另外把这个特征包走一遍"上传 + 安装"
#
# 把整段输出发回来即可定位：上传链路 / 识别链路 哪一环断了。

hr() { printf '\n==== %s ====\n' "$1"; }
RPC=/usr/libexec/rpcd/netview

hr "版本"
opkg list-installed 2>/dev/null | grep -E '^(luci-app-netview|appfilter|kmod-oaf|luci-app-oaf) '
uname -r

hr "1. 上传依赖"
for b in base64 tar gzip killall; do
	if command -v "$b" >/dev/null 2>&1; then echo "  ok   $b"; else echo "  MISS $b   <-- 缺这个上传必然失败"; fi
done
printf 'aGVsbG8=' | base64 -d 2>&1 | grep -q hello && echo "  ok   base64 -d 可用" || echo "  FAIL base64 -d 不可用"

hr "2. rpcd 是否认得新接口"
ubus -v list netview 2>&1 | grep -E 'feature_upload|feature_install|features' || echo "  FAIL netview 对象没有上传接口 -> /etc/init.d/rpcd reload"
grep -o 'feature_upload\|feature_install' /usr/share/rpcd/acl.d/luci-app-netview.json 2>/dev/null | sort -u | sed 's/^/  acl: /'

hr "3. 直接调后端（绕过浏览器）"
R=$(printf '{"chunk":"aGVsbG8=","seq":0}' | "$RPC" call feature_upload 2>&1)
echo "  feature_upload -> $R"
R=$(ubus call netview feature_upload '{"chunk":"aGVsbG8=","seq":0}' 2>&1)
echo "  ubus 调用      -> $R"

hr "4. 特征库"
head -2 /etc/appfilter/feature.cfg 2>/dev/null
echo "  应用条目: $(grep -c '^[0-9][0-9]* ' /etc/appfilter/feature.cfg 2>/dev/null)"
ls -la /etc/appfilter/ 2>/dev/null
echo "  图标数: $(ls /www/luci-static/resources/app_icons/ 2>/dev/null | grep -c png)"

hr "5. 识别链路（内核打标记）"
pidof oafd >/dev/null && echo "  ok   oafd 在跑 (pid $(pidof oafd))" || echo "  FAIL oafd 没在跑 -> /etc/init.d/appfilter restart"
lsmod | grep -E '^oaf ' || echo "  FAIL oaf 内核模块没加载"
for k in enable work_mode lan_ifname record_enable feature_init; do
	printf '  /proc/sys/oaf/%-14s = %s\n' "$k" "$(cat /proc/sys/oaf/$k 2>/dev/null || echo '(无)')"
done
echo "  LAN 网桥: $(uci -q get network.lan.device || uci -q get network.lan.ifname)"
echo "  conntrack acct = $(cat /proc/sys/net/netfilter/nf_conntrack_acct 2>/dev/null)"
T=/proc/net/nf_conntrack
echo "  IPv4 连接: $(grep -c '^ipv4' $T 2>/dev/null)"
echo "  带非零 mark 的连接: $(grep '^ipv4' $T 2>/dev/null | grep -cv 'mark=0 ')"
echo "  mark 取值样本:"; grep -o 'mark=[0-9x]*' $T 2>/dev/null | sort | uniq -c | sort -rn | head -5
echo "  af_client:"; head -5 /proc/net/af_client 2>/dev/null
echo "  af_visit:";  head -5 /proc/net/af_visit 2>/dev/null

if [ -n "$1" ] && [ -f "$1" ]; then
	hr "6. 实跑一次上传安装：$1"
	ls -la "$1"
	# 按前端同样的方式：24KB 分块 base64，逐块交给后端
	N=0; SEQ=0
	SIZE=$(wc -c < "$1")
	while [ $N -lt "$SIZE" ]; do
		B=$(dd if="$1" bs=24576 skip=$SEQ count=1 2>/dev/null | base64 | tr -d '\n')
		R=$(printf '{"chunk":"%s","seq":%d}' "$B" $SEQ | "$RPC" call feature_upload 2>&1)
		case "$R" in *'"ok":1'*|*'"ok": true'*|*'"ok":true'*) ;; *) echo "  第 $SEQ 块失败: $R"; exit 1 ;; esac
		SEQ=$((SEQ + 1)); N=$((SEQ * 24576))
	done
	echo "  上传完成 $SEQ 块，$R"
	echo "  安装 -> $("$RPC" call feature_install </dev/null 2>&1)"
	head -2 /etc/appfilter/feature.cfg
fi
