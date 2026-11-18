.pragma library

// The gelbooru image hosts 302-redirect every request without a gelbooru.com
// Referer to a hotlink-block page, and QML Image cannot set request headers.
// All plugin image loading goes through here: XHR with the Referer header,
// converted to data URLs for Image.source. Cache state is per QML engine, so
// every surface of the plugin shares one copy of each thumbnail.

var _cache = {}
var _inflight = {}
var _queue = []
var _active = 0
var _maxCache = 256
var _maxActive = 8

function cached(url) {
    return _cache[url] || ""
}

function fetch(url, onDone, cacheable) {
    if (!url) {
        onDone("")
        return
    }
    if (_cache[url]) {
        onDone(_cache[url])
        return
    }
    if (_inflight[url] !== undefined) {
        _inflight[url].push(onDone)
        return
    }
    _inflight[url] = [onDone]
    _queue.push({
        url: url,
        cacheable: cacheable !== false
    })
    _pump()
}

function _pump() {
    while (_active < _maxActive && _queue.length > 0) {
        const item = _queue.shift()
        _active++
        _start(item.url, item.cacheable)
    }
}

function _start(url, cacheable) {
    const request = new XMLHttpRequest()
    request.open("GET", url)
    request.setRequestHeader("Referer", "https://gelbooru.com/")
    request.responseType = "arraybuffer"
    request.onreadystatechange = function() {
        if (request.readyState !== 4)
            return
        _active--
        const waiters = _inflight[url] || []
        delete _inflight[url]
        let dataUrl = ""
        if (request.status === 200) {
            dataUrl = "data:image/jpeg;base64," + base64(new Uint8Array(request.response))
            if (cacheable) {
                const keys = Object.keys(_cache)
                while (keys.length >= _maxCache)
                    delete _cache[keys.shift()]
                _cache[url] = dataUrl
            }
        }
        for (let i = 0; i < waiters.length; i++)
            waiters[i](dataUrl)
        _pump()
    }
    request.send()
}

function base64(bytes) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    let out = ""
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i]
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
        out += alphabet[b0 >> 2]
        out += alphabet[((b0 & 3) << 4) | (b1 >> 4)]
        out += i + 1 < bytes.length ? alphabet[((b1 & 15) << 2) | (b2 >> 6)] : "="
        out += i + 2 < bytes.length ? alphabet[b2 & 63] : "="
    }
    return out
}
