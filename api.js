/* ============================================================
   api.js — نسخة التطبيق (بدون أي بروكسيات CORS)
   ------------------------------------------------------------
   ما تغيّر: أُزيلت كل البروكسيات (codetabs / corsproxy.org /
   corsfix / allorigins / worker / corsproxy.io) وأصبح كل طلب
   يذهب مباشرة إلى https://kick.com بنفس الترويسات ونفس شكل
   المُخرجات تماماً: { res, proxyUsed } مع proxyUsed = -1 دائماً.
   نفس أسماء الدوال: proxiedFetch / fetchXsrf / refreshXsrf /
   sendMessage — حتى يعمل كود الواجهة بدون أي تعديل في الاستدعاءات.
   ============================================================ */

var KICK_BASE = 'https://kick.com';
var $ = function(id) { return document.getElementById(id); };

/* عنصر قديم باقٍ فقط لأن كود الواجهة يقرأ/يكتب عنده عند تصدير
   واستيراد الإعدادات — لا علاقة له بأي بروكسي الآن. */
var _bestProxy = -1;
function saveBestProxy() {}

/* عدّاد فشل قديم ما زال كود الواجهة يكتب فيه — لا أثر له بدون بروكسيات */
var _proxyFailCount = {};

var xsrfToken = '';
var isDirectMode = false;

function detectMode() {
    try {
        isDirectMode = window.location.hostname === 'kick.com' || window.location.hostname.endsWith('.kick.com');
    } catch(e) { isDirectMode = false; }
}

/* fetch مع مهلة زمنية حقيقية (يُلغي الطلب عند انتهاء المهلة) */
async function fetchWithTimeout(url, opts, timeout) {
    timeout = timeout || 8000;
    if (typeof AbortController === 'undefined') {
        return await Promise.race([
            fetch(url, opts),
            new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout')); }, timeout); })
        ]);
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function() { try { ctrl.abort(); } catch(e) {} }, timeout);
    try {
        var o = Object.assign({}, opts);
        o.signal = ctrl.signal;
        return await fetch(url, o);
    } finally { clearTimeout(timer); }
}

/* نفس اسم الدالة القديمة ونفس شكل الإرجاع — لكن الطلب مباشر بلا وسيط */
async function proxiedFetch(kickPath, options) {
    options = options || {};
    var method = options.method || 'GET';
    var body = options.body || null;
    var headers = options.headers || {};
    var timeout = options.timeout || 8000;
    var skipAuth = options.skipAuth || false;
    var token = options.token || '';
    var isPost = (method !== 'GET');

    var defHeaders = { 'Accept':'application/json' };
    if (isPost) defHeaders['Content-Type'] = 'application/json';
    defHeaders['Origin'] = KICK_BASE;
    if (!skipAuth && token) defHeaders['Authorization'] = 'Bearer ' + token;
    if (xsrfToken) defHeaders['X-XSRF-TOKEN'] = xsrfToken;
    for (var k in headers) defHeaders[k] = headers[k];

    var fetchOpts = { method:method, headers:defHeaders, credentials:isDirectMode ? 'include' : 'omit' };
    if (body && isPost) fetchOpts.body = JSON.stringify(body);

    var res = await fetchWithTimeout(KICK_BASE + kickPath, fetchOpts, timeout);
    return { res: res, proxyUsed: -1 };
}

/* قراءة كوكي (تفيد في وضع kick.com المباشر فقط) */
function _readCookie(name) {
    try {
        var parts = String(document.cookie || '').split(';');
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            if (p.indexOf(name + '=') === 0) return decodeURIComponent(p.substring(name.length + 1));
        }
    } catch(e) {}
    return '';
}

async function fetchXsrf() {
    xsrfToken = '';
    try {
        try { await proxiedFetch('/sanctum/csrf-cookie', {skipAuth:true, timeout:8000}); } catch(e){}
        var pr = await proxiedFetch('/', {skipAuth:true, timeout:8000});
        if (pr.res.ok) {
            var html = await pr.res.text(); var m;
            m = html.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i);
            if (m) { xsrfToken=m[1]; return; }
            m = html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i);
            if (m) { xsrfToken=m[1]; return; }
            m = html.match(/"csrf[^"]*"\s*:\s*"([^"]+)"/i);
            if (m) { xsrfToken=m[1]; return; }
        }
    } catch(e){}
    var c = _readCookie('XSRF-TOKEN');
    if (c) xsrfToken = c;
}

async function refreshXsrf() { xsrfToken=''; await fetchXsrf(); }

async function sendMessage(chatroomId, content, token, preferredProxy) {
    var endpoints = [
        { path:'/api/v2/messages/send/'+chatroomId, body:{content:content, type:'message'} },
        { path:'/api/v1/chat-messages', body:{content:content, chatroom_id:parseInt(chatroomId)} }
    ];
    var lastErr = null;
    var statusCounts = {};
    var xsrfRefreshed = false;

    for (var ei = 0; ei < endpoints.length; ei++) {
        var ep = endpoints[ei];
        for (var attempt = 0; attempt < 2; attempt++) {
            try {
                var r = await proxiedFetch(ep.path, {
                    method:'POST', token:token, timeout:10000, body:ep.body
                });
                if (r.res.ok) { return { success:true, proxyUsed:-1 }; }
                var st = r.res.status;
                if (st === 419) {
                    if (!xsrfRefreshed) { xsrfRefreshed = true; try { await refreshXsrf(); } catch(e){} continue; }
                    lastErr = new Error('HTTP 419');
                    break;
                }
                if (st === 401 || st === 403 || st === 429) {
                    statusCounts[st] = (statusCounts[st] || 0) + 1;
                }
                lastErr = new Error('HTTP '+st);
                break;
            } catch(e) {
                lastErr = e;
                break;
            }
        }
    }

    if (statusCounts[429] >= 2) throw new Error('حظر مؤقت');
    if (statusCounts[403] >= 2) throw new Error('لا صلاحية');
    if (statusCounts[401] >= 2) throw new Error('توكن منتهي');
    if (lastErr instanceof TypeError || (lastErr && lastErr.message && lastErr.message.indexOf('Failed to fetch')>=0)) throw new Error('خطأ اتصال');
    throw lastErr || new Error('فشل الإرسال');
}
