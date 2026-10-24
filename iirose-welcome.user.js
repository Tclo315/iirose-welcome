// ==UserScript==
// @name         iiRose 进房欢迎
// @namespace    vaimer
// @version      1.3
// @description  检测到有人进入房间时，自动发消息 @ 欢迎对方。房间里发 "#欢迎" 可开关（该命令不会真的发出）
// @match        https://www.iirose.com/*
// @match        https://iirose.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* ============================================================
 * iiRose 进房欢迎插件 v1.3
 *
 * 功能：
 *  - 有人进房自动 @ 欢迎，多条欢迎语随机轮换
 *  - 排队节流：消息一条条发，间隔 queueGapMs 毫秒，防刷屏
 *  - 房间里输入 #欢迎 回车：切换开关，并弹出提示显示当前状态
 *    （这条命令会被本地拦截，不会真的发送出去）
 *  - 同一人5分钟冷却；跳过自己；断线重连自动重挂
 *
 * 配置（电脑端 F12 控制台，改完立即生效）：
 *  __WELCOME__.enabled = false                 暂停 / true 恢复
 *  __WELCOME__.templates = ['，新欢迎语1','，新欢迎语2']   换欢迎语池
 *  __WELCOME__.delayMs = 1500                  进房到发消息的延迟
 *  __WELCOME__.queueGapMs = 500                排队发送的间隔
 * ============================================================ */
(function () {
  if (window.__WELCOME_LOADED__) { console.log('[欢迎] 本页面已加载过一次'); return; }

  /* ================= 配置区：想改就改这里 ================= */
  var CONFIG = {
    templates: [                    // 欢迎语池：每次随机挑一条（自动拼在 @某人 后面）
      '，欢迎来到本房间～',
      '，欢迎欢迎～',
      '，欢迎来玩～',
      '，来啦？欢迎～',
      '，欢迎光临～',
      '，欢迎加入我们～',
      '，见到你真高兴，欢迎～',
      '，又添新朋友啦，欢迎～'
    ],
    color: 'ffffff',               // 消息颜色，6位十六进制，不带#
    delayMs: 1500,                 // 检测到进房后延迟多少毫秒再入队
    queueGapMs: 500,               // 排队节流：两条消息之间的最小间隔
    cooldownMs: 300000,            // 同一个人5分钟内反复进出，只欢迎一次
    welcomeReconnect: true,        // 掉线重连回来的人要不要也欢迎
    enabled: true                  // 总开关（房间里发 #欢迎 也能切换）
  };
  window.__WELCOME__ = CONFIG;
  window.__WELCOME_LOADED__ = true;

  /* ================= 工具函数 ================= */
  // 客户端把 WebSocket 挂在 window.socket 上；真实聊天页可能在 mainFrame 框架里，
  // 所以两个地方都找一遍（同域名，跨框架操作是允许的）
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

  // 消息里的人名可能带 HTML 转义，发 @ 前先还原
  function unescapeName(s) {
    return String(s || '')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }

  // 协议要求 i 字段是 12 位随机数
  function randomId() {
    var s = String(Math.random()).replace('0.', '');
    while (s.length < 12) s += '0';
    return s.slice(0, 12);
  }

  // 在聊天页面里弹一个几秒后消失的提示条（手机/网页/桌面通用）
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
    console.log('[欢迎提示] ' + msg);
  }

  /* ================= 发送排队节流 ================= */
  var sendQueue = [];        // 待发送的消息文本
  var queueTimer = null;     // 队列的定时器（存在表示队列正在工作）

  function sendNow(text) {
    var found = findSock();
    if (!found || !text) return;
    found.sock.send(JSON.stringify({ m: text, mc: CONFIG.color, i: randomId() }));
    console.log('%c[欢迎] 已发送：' + text, 'color:#0af');
  }

  function enqueueSend(text) {
    sendQueue.push(text);
    if (!queueTimer) {
      sendNow(sendQueue.shift());          // 队列空闲：第一条立即发
      queueTimer = setInterval(function () {
        if (!sendQueue.length) {           // 发完了，队列休眠，下次来消息再立即发
          clearInterval(queueTimer);
          queueTimer = null;
          return;
        }
        sendNow(sendQueue.shift());        // 队列不空：每 queueGapMs 发一条
      }, Math.max(200, CONFIG.queueGapMs));
    }
  }

  /* ================= 核心逻辑：识别进房事件 ================= */
  var lastWelcome = {};     // uid -> 上次欢迎的时间戳
  var loggedMarkers = {};   // 调试用：每种未知事件标记只打印一次，避免刷屏

  function pickTemplate() {
    var list = CONFIG.templates || [];
    if (!list.length) return '，欢迎～';
    return list[Math.floor(Math.random() * list.length)];
  }

  function sendWelcome(name) {
    // iiRose 的 @ 格式： [*名字*] ，方括号星号包住，前后都必须有空格，
    // 少了空格客户端就不认为是 @，只会显示成普通文字 [*名字*]
    var text = ' [*' + name + '*] ' + pickTemplate().replace(/^\s+/, '');
    enqueueSend(text);
    console.log('[欢迎] 已加入发送队列：' + text);
  }

  function handleFrame(text) {
    if (!CONFIG.enabled) return;
    // 只关心公屏类帧：以 " 开头；"" 开头是私聊，跳过
    if (typeof text !== 'string' || text.charAt(0) !== '"' || text.charAt(1) === '"') return;

    var f = text.split('>');
    if (f.length < 10) return;

    // 成员变动帧的特征：某一段是 '1（进房）。
    // 兼容两种字段位置（不同版本客户端见过两种排布）
    if (f[3] === "'1" || f[4] === "'1") {
      /* 是进房事件，继续往下处理 */
    } else {
      var m = f[3] && f[3].charAt(0) === "'" ? f[3] : (f[4] && f[4].charAt(0) === "'" ? f[4] : null);
      if (m && !loggedMarkers[m]) {
        loggedMarkers[m] = true;
        console.log('[欢迎] 发现未处理的成员事件标记 ' + m + '，整帧：', text);
      }
      return;
    }

    var uid = f[8];
    var name = unescapeName(f[2]);
    if (!uid || !name) return;

    // 自己进房不打招呼
    var found = findSock();
    var myUid = null;
    try { myUid = (found ? found.win : window).uid || null; } catch (e) {}
    if (myUid && uid === myUid) return;

    // 是新进房还是重连：最后一个字段以 'n 结尾是新人，'d 是重连
    var last = f[f.length - 1] || '';
    var isReconnect = /'d$/.test(last);
    if (isReconnect && !CONFIG.welcomeReconnect) return;

    // 冷却：同一人短时间内只欢迎一次
    var now = Date.now();
    if (lastWelcome[uid] && now - lastWelcome[uid] < CONFIG.cooldownMs) return;
    lastWelcome[uid] = now;

    console.log('[欢迎] 检测到进房：' + name + '（' + (isReconnect ? '重连' : '新进') + '）');
    setTimeout(function () { sendWelcome(name); }, CONFIG.delayMs);
  }

  /* ================= 聊天命令：#欢迎 ================= */
  function toggleWelcome() {
    CONFIG.enabled = !CONFIG.enabled;
    if (!CONFIG.enabled) sendQueue.length = 0;   // 关闭时把还没发的排队消息全部作废
    toast(CONFIG.enabled ? '【欢迎插件】已开启 ✔' : '【欢迎插件】已关闭 ✘');
  }

  /* ================= 挂钩 socket：收包监听 + 发包拦截 ================= */
  function tryHook() {
    var found = findSock();
    if (!found) return false;
    var sock = found.sock;

    // 1) 收包监听：包一层 _onmessage（socket 重建后这里会再次挂上）
    if (!sock._onmessage.__welcomeWrapped) {
      var origOn = sock._onmessage;
      sock._onmessage = function () {
        try { handleFrame(arguments[0]); } catch (e) {
          console.warn('[欢迎] 处理帧出错（已放行给客户端，不影响正常聊天）', e);
        }
        return origOn.apply(this, arguments);
      };
      sock._onmessage.__welcomeWrapped = true;
    }

    // 2) 发包拦截：识别 #欢迎 命令，本地处理不发送
    if (!sock.send.__welcomeWrapped) {
      var origSend = sock.send;
      sock.send = function (data) {
        try {
          var s = String(data);
          if (s.charAt(0) === 'm' && s.charAt(1) === '@') s = s.slice(2); // 兼容带前缀的写法
          if (s.charAt(0) === '{') {
            var o = JSON.parse(s);
            if (o && typeof o.m === 'string' && o.m.replace(/^\s+|\s+$/g, '') === '#欢迎') {
              toggleWelcome();
              return;                       // 拦截：命令不出本机，其他人看不到
            }
          }
        } catch (e) { /* 不是 JSON 的数据原样放行 */ }
        return origSend.apply(this, arguments);
      };
      sock.send.__welcomeWrapped = true;
    }
    return true;
  }

  // 定时器常驻不退出：socket 晚出现要能等到；断线重连后客户端会重建 socket，
  // 新 socket 的 _onmessage / send 是原始的、没我们的标记，这里会自动重新挂上。
  var everHooked = false, waited = 0;
  setInterval(function () {
    waited++;
    if (tryHook()) {
      if (!everHooked) {
        everHooked = true;
        console.log('%c[欢迎插件 v1.3] 已挂载！有人进房间就会自动 @ 欢迎', 'background:#0c0;color:#fff;padding:2px 6px');
        console.log('[欢迎插件] 房间里发 #欢迎 可开关；控制台改 __WELCOME__ 可调配置');
      }
    } else if (!everHooked && waited === 80) { // 约2分钟还没挂上才提醒一次
      console.warn('[欢迎插件] 很久都没找到 socket —— 确认已登录并进入房间');
    }
  }, 1500);
})();
