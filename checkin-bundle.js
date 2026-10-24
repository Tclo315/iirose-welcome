/* ============================================================
 * iiRose 每日签到插件 v2.1（checkin-bundle.js）
 * 由 loader 从远端加载，装在 iirose 工具-终端里
 *
 * 签到日模型：以每天 06:00 为界。一个签到日 = 当天06:00 → 次日06:00。
 *   过了 0 点若昨天的还没签，仍会继续等条件补发（不会作废），到次日06:00才翻篇。
 *
 * 每 5 秒检查一次，条件全满足才发 /z：
 *   ① 本签到日还没发过（记录按"签到日"存，刷新/多标签不会重复）
 *   ② 目标成员（默认"小椰"）在房间名单里，且与你在同一房间
 *      —— 名单直接读客户端内存里的全站成员表（Objs.mapHolder.Assets.userJson），
 *         包含"你进房前就已在线"的人；小椰上线后 ≤5 秒会被检测到
 *   条件不满足就静默等待，满足的瞬间自动补签。
 *   名单读不到（iirose 改版）时：保守模式，不发送，控制台提示。
 *
 * 控制台临时调整（改完立即生效，刷新后恢复默认）：
 *  __CHECKIN__.enabled = false            暂停 / true 恢复
 *  __CHECKIN__.time = '07:30'             改签到日界点（当天此时刻 → 次日此时刻为一天）
 *  __CHECKIN__.targetName = '小椰'        改在场判定的成员
 *  __CHECKIN__.trigger()                  立即按当前条件试签一次（测试用）
 *  __CHECKIN__.status()                   查看当前各条件状态
 *  localStorage.removeItem('iirose_checkin_last')   清除"本签到日已发"（测试用）
 * ============================================================ */
(function () {
  if (window.__CHECKIN_LOADED__) { console.log('[签到] 本页面已加载过一次'); return; }
  window.__CHECKIN_LOADED__ = true;

  var CONFIG = {
    time: '06:00',        // 签到日界点：当天此时刻 → 次日此时刻算一个签到日
    message: '/z',        // 发送的内容
    color: 'ffffff',      // 消息颜色，6位十六进制，不带#
    enabled: true,        // 总开关
    targetName: '小椰',   // 在场判定：这个人且与你同房间才签
    strictList: true      // 名单读不到时 true=不发送（保守），false=照常发送
  };
  window.__CHECKIN__ = CONFIG;

  var KEY = 'iirose_checkin_last';   // localStorage 里记录"最后发送的签到日"

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dateStr(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function getLast() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function setLast(v) { try { localStorage.setItem(KEY, v); } catch (e) { } }
  function clearLast() { try { localStorage.removeItem(KEY); } catch (e) { } }

  // 解析界点时刻 {h, mi}
  function boundary() {
    var t = String(CONFIG.time || '06:00').split(':');
    return { h: parseInt(t[0], 10) || 0, mi: parseInt(t[1], 10) || 0 };
  }

  // 当前所属"签到日"的标识：若现在还没过当天的界点，则仍属于昨天开始的那个签到日
  function dayKey() {
    var b = boundary(), now = new Date();
    var passed = now.getHours() > b.h || (now.getHours() === b.h && now.getMinutes() >= b.mi);
    if (passed) return dateStr(now);
    var y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return dateStr(y);
  }

  // 客户端把 WebSocket 挂在 window.socket 上；真实聊天页可能在 mainFrame 框架里
  function findSock() {
    if (window.socket && typeof window.socket._onmessage === 'function') {
      return { sock: window.socket, win: window };
    }
    var f = document.getElementById('mainFrame');
    try {
      if (f && f.contentWindow && f.contentWindow.socket &&
          typeof f.contentWindow.socket._onmessage === 'function') {
        return { sock: f.contentWindow.socket, win: f.contentWindow };
      }
    } catch (e) { /* 跨框架受限时忽略 */ }
    return null;
  }

  // 协议要求 i 字段是 12 位随机数
  function randomId() {
    var s = String(Math.random()).replace('0.', '');
    while (s.length < 12) s += '0';
    return s.slice(0, 12);
  }

  function toast(msg) {
    try {
      var found = findSock();
      var doc = (found && found.win.document) || document;
      var d = doc.createElement('div');
      d.textContent = msg;
      d.style.cssText = 'position:fixed;left:50%;top:15%;transform:translateX(-50%);'
        + 'background:rgba(0,0,0,.75);color:#fff;padding:10px 18px;border-radius:8px;'
        + 'font-size:14px;z-index:99999;pointer-events:none;transition:opacity .4s;';
      doc.body.appendChild(d);
      setTimeout(function () { d.style.opacity = '0'; }, 1800);
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2400);
    } catch (e) { }
    console.log('[签到提示] ' + msg);
  }

  // 当前所在房间 id：优先读全局变量 roomn，读不到再翻 cookie roomsave
  function roomOf(win) {
    try { if (win.roomn) return String(win.roomn); } catch (e) { }
    try {
      var m = win.document.cookie.match(/(?:^|;\s*)roomsave=([^;]*)/);
      if (m) return decodeURIComponent(m[1]);
    } catch (e) { }
    return null;
  }

  // 目标成员在场判定。
  // 返回 true=在名单且与你同房间；false=不在/在别的房间；null=名单或房间读不到
  function targetHere(win) {
    try {
      var assets = win.Objs && win.Objs.mapHolder && win.Objs.mapHolder.Assets;
      if (!assets || !assets.userJson) return null;
      var myRoom = roomOf(win);
      if (!myRoom) return null;
      var rec = assets.userJson[String(CONFIG.targetName || '').toLowerCase()];
      if (!rec) return false;
      return String(rec[4]) === myRoom;    // 记录第5个字段=所在房间id
    } catch (e) { return null; }
  }

  function sendCheckin(found) {
    try {
      found.sock.send(JSON.stringify({ m: CONFIG.message, mc: CONFIG.color, i: randomId() }));
      return true;
    } catch (e) { return false; }
  }

  var lastState = '';   // 去重打印：状态变化才输出日志
  function noteState(s) {
    if (s === lastState) return;
    lastState = s;
    console.log('[签到] ' + s);
  }

  function attemptSend() {
    var found = findSock();
    if (!found) { noteState('等待连接（未登录或未进房）…'); return; }
    if (!CONFIG.enabled) return;
    if (getLast() === dayKey()) return;   // 本签到日已发过

    var p = targetHere(found.win);
    if (p === null) {
      if (CONFIG.strictList) {
        noteState('读不到房间名单（iirose 可能改版），保守模式暂不签到——请反馈给开发者');
        return;
      }
      p = true;   // 宽松模式：读不到当作在场
    }
    if (!p) {
      noteState('本签到日还没签，但 ' + CONFIG.targetName + ' 还不在房间，等待中…');
      return;
    }

    setLast(dayKey());                     // 先占住签到日，多标签/刷新不会重复发
    if (sendCheckin(found)) {
      toast('【签到】已发送 ' + CONFIG.message + ' ✔（签到日 ' + dayKey() + '）');
      lastState = 'sent';
    } else {
      clearLast();                         // 没发出去，下个周期重试
      noteState('发送失败，稍后重试…');
    }
  }

  CONFIG.status = function () {
    var found = findSock();
    var p = found ? targetHere(found.win) : null;
    console.log('[签到状态]', {
      签到日界点: CONFIG.time,
      当前签到日: dayKey(),
      本签到日已发: getLast() === dayKey(),
      判定成员: CONFIG.targetName,
      成员在场: p === true ? '在，且与你同房间' : (p === false ? '不在/在别的房间' : '名单读不到'),
      当前房间: found ? roomOf(found.win) : '未连接',
      开关: CONFIG.enabled ? '开' : '关'
    });
  };
  CONFIG.trigger = function () { attemptSend(); };

  // 主循环：每 5 秒查一次。读的是内存里现成的名单，开销极小。
  // 前台最迟 5 秒反应；后台标签页浏览器会把定时器降到至少 1 分钟一次（可接受）。
  // 电脑睡眠唤醒后靠这个循环自然补上。
  setInterval(attemptSend, 5000);
  setTimeout(attemptSend, 1000);   // 加载完先查一次（上线直接补签）

  console.log('%c[签到插件 v2.1] 已启动：签到日 ' + CONFIG.time + ' 起，' + CONFIG.targetName + ' 在房间时自动发 ' + CONFIG.message,
    'background:#08c;color:#fff;padding:2px 6px');
  console.log('[签到插件] __CHECKIN__.status() 看状态；__CHECKIN__.trigger() 立即试签（测试用）');
})();
