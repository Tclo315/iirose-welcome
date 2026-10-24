/* ============================================================
 * iiRose 每日签到插件 v1（checkin-bundle.js）
 * 由 loader 从远端加载，装在 iirose 工具-终端里
 *
 * 功能：
 *  - 每天到设定时刻（默认 06:00，本机时间）自动发送 /z
 *  - 补发：6 点后页面才打开（或才加载插件）时，当天没发就立即补发
 *  - 防重发：本地记录"今天已发"，刷新页面/重复加载/多开标签都不会发第二次
 *  - 断线兜底：到点时 socket 恰好断开，下个周期自动重试
 *
 * 控制台临时调整（改完立即生效，刷新后恢复默认）：
 *  __CHECKIN__.enabled = false      暂停 / true 恢复
 *  __CHECKIN__.time = '07:30'       改触发时间
 *  __CHECKIN__.message = '/z'       改发送内容
 *  localStorage.removeItem('iirose_checkin_last')   清除"今天已发"记录（测试用）
 * ============================================================ */
(function () {
  if (window.__CHECKIN_LOADED__) { console.log('[签到] 本页面已加载过一次'); return; }
  window.__CHECKIN_LOADED__ = true;

  var CONFIG = {
    time: '06:00',        // 每天发送的时刻（本机时间，24小时制）
    message: '/z',        // 发送的内容
    color: 'ffffff',      // 消息颜色，6位十六进制，不带#
    enabled: true,        // 总开关
    catchUp: true         // 补发：过了时间点打开页面时，当天没发就立即补
  };
  window.__CHECKIN__ = CONFIG;

  var KEY = 'iirose_checkin_last';   // localStorage 里记录"最后发送日期"

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function getLast() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function setLast(v) { try { localStorage.setItem(KEY, v); } catch (e) { } }
  function clearLast() { try { localStorage.removeItem(KEY); } catch (e) { } }

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

  function sendCheckin() {
    var found = findSock();
    if (!found) return false;
    found.sock.send(JSON.stringify({ m: CONFIG.message, mc: CONFIG.color, i: randomId() }));
    return true;
  }

  // 现在是否已过了当天的触发时刻
  function timeReached() {
    var t = String(CONFIG.time || '06:00').split(':');
    var h = parseInt(t[0], 10) || 0, mi = parseInt(t[1], 10) || 0;
    var now = new Date();
    return now.getHours() > h || (now.getHours() === h && now.getMinutes() >= mi);
  }

  // 补发关闭时，只在触发时刻后 60 分钟内发（过了窗口就等明天）
  function inWindow() {
    if (CONFIG.catchUp) return true;
    var t = String(CONFIG.time || '06:00').split(':');
    var h = parseInt(t[0], 10) || 0, mi = parseInt(t[1], 10) || 0;
    var now = new Date();
    var passed = (now.getHours() - h) * 60 + (now.getMinutes() - mi);
    return passed >= 0 && passed <= 60;
  }

  function tick() {
    if (!CONFIG.enabled) return;
    if (!timeReached() || !inWindow()) return;
    if (getLast() === todayStr()) return;   // 今天已发过

    setLast(todayStr());                    // 先占住日期，多标签/刷新不会重复发
    if (sendCheckin()) {
      toast('【签到】已发送 ' + CONFIG.message + ' ✔');
    } else {
      clearLast();                          // 没发出去（socket 没就绪），下个周期重试
      console.warn('[签到] socket 未就绪，稍后重试');
    }
  }

  // 主循环：每 30 秒查一次"到点没发"。
  // 前台精确到半分钟内；后台标签页浏览器会把定时器降到至少 1 分钟一次，
  // 也就晚一两分钟，可接受。电脑睡眠唤醒后靠这个循环自然补上。
  setInterval(tick, 30000);
  setTimeout(tick, 1000);   // 加载完先查一次：覆盖"6点后才打开页面"的补发场景

  console.log('%c[签到插件 v1] 已启动：每天 ' + CONFIG.time + ' 发送 ' + CONFIG.message,
    'background:#08c;color:#fff;padding:2px 6px');
  console.log('[签到插件] 控制台输 __CHECKIN__ 可查看/修改配置');
})();
