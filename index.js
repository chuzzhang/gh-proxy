'use strict'

/**
 * static files (404.html, sw.js, conf.js)
 */
const ASSET_URL = 'https://hunshcn.github.io/gh-proxy/'
// 前缀，如果自定义路由为example.com/gh/*，将PREFIX改为 '/gh/'，注意，少一个杠都会错！
const PREFIX = '/'
// 分支文件使用jsDelivr镜像的开关，0为关闭，默认关闭
const Config = {
    jsdelivr: 0
}

const whiteList = [] // 白名单，路径里面有包含字符的才会通过，e.g. ['/username/']

/** @type {RequestInit} */
const PREFLIGHT_INIT = {
    status: 204,
    headers: new Headers({
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
        'access-control-max-age': '1728000',
    }),
}


const exp2 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i
const exp4 = /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i
const exp5 = /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i

// 只放行这几个静态资源名，其余裸路径一律补成 github.com
const STATIC_FILES = new Set(['', '404.html', 'sw.js', 'conf.js', 'favicon.ico', 'robots.txt'])

// ============================================================
// HTML 重写：把页面里 https://github.com/ 开头的绝对地址改写成
// /https://github.com/... ，让浏览器发到本 worker 而不是跨域直连 github.com。
// 这是 release 页面 Assets 一直转圈的根因：
//   <include-fragment src="https://github.com/o/r/releases/expanded_assets/<tag>">
// 绝对地址 → 浏览器直连 github.com → GitHub 不返回 Access-Control-Allow-Origin
// → fetch 被浏览器拦掉 → include-fragment 保留 fallback（spinner）→ 永远转圈。
// 只选必要元素，避免通配选择器拖慢 HTMLRewriter。
// ============================================================
const REWRITE_SELECTOR = [
    'a', 'area', 'link', 'script', 'img', 'source', 'iframe',
    'video', 'audio', 'track', 'form', 'object', 'use',
    'include-fragment', 'turbo-frame', 'blockquote'
].join(',')

/**
 * @param {string} v
 * @returns {string|null} 改写后的值，不需要改写返回 null
 */
function rewriteGithubUrl(v) {
    if (!v) return null
    if (v.startsWith('https://github.com/') || v.startsWith('http://github.com/')) {
        return PREFIX + v.replace(/^http:\/\//i, 'https://')
    }
    return null
}

/**
 * @param {string} v
 * @returns {string|null}
 */
function rewriteSrcset(v) {
    if (!v || v.indexOf('github.com/') === -1) return null
    let changed = false
    const out = v.split(',').map(part => {
        const s = part.trim()
        if (!s) return part
        const seg = s.split(/\s+/)
        const nv = rewriteGithubUrl(seg[0])
        if (nv) {
            seg[0] = nv
            changed = true
        }
        return seg.join(' ')
    }).join(', ')
    return changed ? out : null
}

const REWRITE_HANDLER = {
    element(el) {
        // 先把属性快照下来，setAttribute 后再遍历同一个迭代器行为未定义
        const attrs = []
        for (const a of el.attributes) attrs.push(a)
        for (const [name, value] of attrs) {
            const nv = name === 'srcset' ? rewriteSrcset(value) : rewriteGithubUrl(value)
            if (nv) el.setAttribute(name, nv)
        }
    }
}

/**
 * @param {any} body
 * @param {number} status
 * @param {Object<string, string>} headers
 */
function makeRes(body, status = 200, headers = {}) {
    headers['access-control-allow-origin'] = '*'
    return new Response(body, {status, headers})
}


/**
 * @param {string} urlStr
 */
function newUrl(urlStr) {
    try {
        return new URL(urlStr)
    } catch (err) {
        return null
    }
}


addEventListener('fetch', e => {
    const ret = fetchHandler(e)
        .catch(err => makeRes('cfworker error:\n' + err.stack, 502))
    e.respondWith(ret)
})


// location 只要还是 github 系域名，就改写成走本 worker，让浏览器的地址栏跟过去，
// 而不是在 worker 内部偷偷 follow（那样地址栏停在旧 URL，刷新会错）
const expLocation = /^https?:\/\/(?:github\.com|raw\.(?:githubusercontent|github)\.com|gist\.(?:githubusercontent|github)\.com)\//i

function checkUrl(u) {
    return expLocation.test(u)
}

/**
 * @param {FetchEvent} e
 */
async function fetchHandler(e) {
    const req = e.request
    const urlStr = req.url
    const urlObj = new URL(urlStr)
    let path = urlObj.searchParams.get('q')
    if (path) {
        return Response.redirect('https://' + urlObj.host + PREFIX + path, 301)
    }
    // cfworker 会把路径中的 `//` 合并成 `/`
    path = urlObj.href.substr(urlObj.origin.length + PREFIX.length).replace(/^https?:\/+/, 'https://')

    // 裸路径补全：GitHub 页面里的 /o/r/... 、/apps 、/login 这类根相对地址
    // 会被浏览器发到 <你的域名>/o/r/... ，不补全就落进静态资源分支变 404
    if (path && !/^https?:\/\//i.test(path) && !STATIC_FILES.has(path)) {
        path = 'https://github.com/' + path
    }

    if (path.search(exp2) === 0) {
        // blob
        if (Config.jsdelivr) {
            const newUrl = path.replace('/blob/', '@').replace(/^(?:https?:\/\/)?github\.com/, 'https://cdn.jsdelivr.net/gh')
            return Response.redirect(newUrl, 302)
        }
        return httpHandler(req, path.replace('/blob/', '/raw/'))
    }
    if (path.search(exp4) === 0) {
        // raw.githubusercontent.com
        if (Config.jsdelivr) {
            const newUrl = path.replace(/(?<=com\/.+?\/.+?)\/(.+?\/)/, '@$1').replace(/^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com/, 'https://cdn.jsdelivr.net/gh')
            return Response.redirect(newUrl, 302)
        }
        return httpHandler(req, path)
    }
    if (path.search(exp5) === 0) {
        return httpHandler(req, path)
    }
    // github.com 的任意路径：releases / archive / expanded_assets / download /
    // issues / wiki / 仓库首页 / apps / login 全部走代理
    if (/^https?:\/\/github\.com\//i.test(path)) {
        return httpHandler(req, path)
    }
    return fetch(ASSET_URL + path)
}


/**
 * @param {Request} req
 * @param {string} pathname
 */
function httpHandler(req, pathname) {
    const reqHdrRaw = req.headers

    // preflight
    if (req.method === 'OPTIONS' &&
        reqHdrRaw.has('access-control-request-headers')
    ) {
        return new Response(null, PREFLIGHT_INIT)
    }

    const reqHdrNew = new Headers(reqHdrRaw)

    let urlStr = pathname
    let flag = !Boolean(whiteList.length)
    for (let i of whiteList) {
        if (urlStr.includes(i)) {
            flag = true
            break
        }
    }
    if (!flag) {
        return new Response("blocked", {status: 403})
    }
    if (urlStr.startsWith('github')) {
        urlStr = 'https://' + urlStr
    }
    const urlObj = newUrl(urlStr)
    if (!urlObj) {
        return makeRes('bad url: ' + urlStr, 400)
    }

    /** @type {RequestInit} */
    const reqInit = {
        method: req.method,
        headers: reqHdrNew,
        redirect: 'manual',
        body: req.body
    }
    return proxy(urlObj, reqInit)
}


/**
 *
 * @param {URL} urlObj
 * @param {RequestInit} reqInit
 * @param {number} depth
 */
async function proxy(urlObj, reqInit, depth = 0) {
    if (depth > 6) {
        return makeRes('too many redirects', 508)
    }
    const res = await fetch(urlObj.href, reqInit)
    const resHdrOld = res.headers
    const resHdrNew = new Headers(resHdrOld)

    const status = res.status

    if (resHdrNew.has('location')) {
        let _location = resHdrNew.get('location')
        // location 可能是相对路径，必须基于本次请求 URL 解析，否则 newUrl() 得到 null 直接炸
        const absLoc = new URL(_location, urlObj.href).href
        if (checkUrl(absLoc)) {
            resHdrNew.set('location', PREFIX + absLoc)
        } else {
            // 跟随时必须降级成 GET 并丢掉 body，否则带 body 重定向会抛错
            reqInit.redirect = 'follow'
            reqInit.method = 'GET'
            reqInit.body = undefined
            return proxy(new URL(absLoc), reqInit, depth + 1)
        }
    }
    resHdrNew.set('access-control-expose-headers', '*')
    resHdrNew.set('access-control-allow-origin', '*')

    resHdrNew.delete('content-security-policy')
    resHdrNew.delete('content-security-policy-report-only')
    resHdrNew.delete('clear-site-data')

    const ct = (resHdrNew.get('content-type') || '').toLowerCase()
    const isHtml = ct.includes('text/html') && res.body !== null && status !== 204 && status !== 304

    if (isHtml) {
        // 长度会变，交给运行时重算
        resHdrNew.delete('content-length')
        return new HTMLRewriter()
            .on(REWRITE_SELECTOR, REWRITE_HANDLER)
            .transform(new Response(res.body, {status, headers: resHdrNew}))
    }

    return new Response(res.body, {
        status,
        headers: resHdrNew,
    })
}
