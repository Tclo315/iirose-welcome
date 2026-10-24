/* ============================================================
 * iiRose 每日签到插件 v2.3（checkin-bundle.js）
 * 由 loader 从远端加载，装在 iirose 工具-终端里
 *
 * 签到房间：写死在下方 CONFIG.roomId 里。
 *   在签到房间里 → 小椰在就签、不在就等待（5秒一轮询）；
 *   在其他任何房间 → 完全休眠，不发也不等待。
 *   获取房间id：进入目标房间后运行 __CHECKIN__.status()，"当前房间"一栏的值就是。
 *
 * 签到日模型：以每天 06:00 为界。一个签到日 = 当天06:00 → 次日06:00。
 *   过了 0 点若昨天的还没签，仍会继续等条件补发（不会作废），到次日06:00才翻篇。
 *
 * 名单来源：客户端内存里的全站成员表 Objs.mapHolder.Assets.userJson
 *（开销极小；小椰上线 ≤5 秒被检测到）。
 *
 * 控制台临时调整（改完立即生效，刷新后恢复文件里的默认值）：
 *  __CHECKIN__.roomId = '房间id'          临时指定签到房间
 *  __CHECKIN__.enabled = false            暂停 / true 恢复
 *  __CHECKIN__.time = '07:30'             改签到日界点
 *  __CHECKIN__.targetName = '小椰'        改在场判定的成员
 *  __CHECKIN__.trigger()                  立即按当前条件试签一次（测试用）
 *  __CHECKIN__.status()                   查看当前各条件状态
 *  localStorage.removeItem('iirose_checkin_last')   清除"本签到日已发"（测试用）
 * ============================================================ */
(function () {
  if (window.__CHECKIN_LOADED__) { console.log('[签到] 本页面已加载过一次'); return; }
  window.__CHECKIN_LOADED__ = true;

  var CONFIG = {
    roomId: '638c0ce40f0a6',  // ★ 签到房间id（小椰常驻的房间）
    time: '06:00',        // 签到日界点：当天此时刻 → 次日此时刻算一个签到日
    message: '/z',        // 发送的内容
    color: 'ffffff',      // 消息颜色，6位十六进制，不带#
    enabled: true,        // 总开关
    targetName: '小椰',   // 在场判定的成员（只认签到房间里这个人在不在）
    strictList: true      // 名单读不到时 true=不发送（保守），false=照常发送
  };
  window.__CHECKIN__ = CONFIG;

  var KEY = 'iirose_checkin_last';   // 本签到日已发记录

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dateStr(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { } }

  function boundary() {
    var t = String(CONFIG.time || '06:00').split(':');
    return { h: parseInt(t[0], 10) || 0, mi: parseInt(t[1], 10) || 0 };
  }

  // 当前所属"签到日"：若还没过当天界点，仍属于昨天开始的那个签到日
  function dayKey() {
    var b = boundary(), now = new Date();
    var passed = now.getHours() > b.h || (now.getHours() === b.h && now.getMinutes() >= b.mi);
    if (passed) return dateStr(now);
    return dateStr(new Date(now.getTime() - 24 * 60 * 60 * 1000));
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

  // 目标成员在场判定：在名单里且其所在房间 == 指定房间
  // 返回 true=在；false=不在；null=名单/房间读不到
  function targetInRoom(win, roomId) {
    try {
      var assets = win.Objs && win.Objs.mapHolder && win.Objs.mapHolder.Assets;
      if (!assets || !assets.userJson || !roomId) return null;
      var rec = assets.userJson[String(CONFIG.targetName || '').toLowerCase()];
      if (!rec) return false;
      return String(rec[4]) === roomId;    // 记录第5个字段=所在房间id
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

    var myRoom = roomOf(found.win);
    if (!myRoom) {
      noteState('读不到当前房间信息，保守模式暂不签到');
      return;
    }

    // ── 只在配置的签到房间行动，其他房间休眠 ──
    var target = String(CONFIG.roomId || '');
    if (!target) {
      noteState('未配置签到房间（roomId 为空）——进目标房间跑 status()，把"当前房间"的值填入 CONFIG.roomId');
      return;
    }
    if (myRoom !== target) {
      noteState('当前不在签到房间，休眠中');
      return;
    }

    if (lsGet(KEY) === dayKey()) return;   // 本签到日已发过

    var p = targetInRoom(found.win, target);
    if (p === null) {
      if (CONFIG.strictList) {
        noteState('读不到房间名单（iirose 可能改版），保守模式暂不签到——请反馈给开发者');
        return;
      }
      p = true;   // 宽松模式：读不到当作在场
    }
    if (!p) {
      noteState('本签到日还没签，' + CONFIG.targetName + '不在房间，等待中…');
      return;
    }

    lsSet(KEY, dayKey());                  // 先占住签到日，多标签/刷新不会重复发
    if (sendCheckin(found)) {
      toast('【签到】已发送 ' + CONFIG.message + ' ✔（签到日 ' + dayKey() + '）');
      lastState = 'sent';
    } else {
      lsDel(KEY);                          // 没发出去，下个周期重试
      noteState('发送失败，稍后重试…');
    }
  }

  CONFIG.status = function () {
    var found = findSock();
    var myRoom = found ? roomOf(found.win) : null;
    var p = found && CONFIG.roomId ? targetInRoom(found.win, String(CONFIG.roomId)) : null;
    console.log('[签到状态]', {
      签到房间: CONFIG.roomId || '未配置',
      当前房间: myRoom || '未连接',
      在签到房间: CONFIG.roomId ? (myRoom === String(CONFIG.roomId) ? '是' : '否（休眠）') : '—（未配置）',
      签到日界点: CONFIG.time,
      当前签到日: dayKey(),
      本签到日已发: lsGet(KEY) === dayKey(),
      判定成员: CONFIG.targetName,
      成员在签到房间: p === true ? '在' : (p === false ? '不在' : '名单读不到'),
      开关: CONFIG.enabled ? '开' : '关'
    });
  };
  CONFIG.trigger = function () { attemptSend(); };

  // 主循环：每 5 秒查一次。前台最迟 5 秒反应；后台标签页浏览器会把定时器
  // 降到至少 1 分钟一次（可接受）。电脑睡眠唤醒后靠这个循环自然补上。
  setInterval(attemptSend, 5000);
  setTimeout(attemptSend, 1000);   // 加载完先查一次（上线直接补签）

  console.log('%c[签到插件 v2.3] 已启动：签到日 ' + CONFIG.time + ' 起，在签到房间内 ' + CONFIG.targetName + ' 在场时自动发 ' + CONFIG.message,
    'background:#08c;color:#fff;padding:2px 6px');
  console.log('[签到插件] status() 看状态 / trigger() 试签');
})();
