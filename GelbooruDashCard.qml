import QtQuick
import qs.Common
import qs.DCommon.Widgets
import qs.Modules.Plugins

DashCardComponent {
    id: root

    clickable: true

    readonly property var posts: pluginData.posts ?? []
    readonly property var latest: posts.length > 0 ? posts[0] : null
    readonly property string thumbUrl: latest ? (latest.previewUrl ?? "") : ""

    property var thumbs: ({})
    property var _imageCache: ({})

    Component.onCompleted: requestThumb(thumbUrl)
    onThumbUrlChanged: requestThumb(thumbUrl)

    function requestThumb(url) {
        if (!url)
            return
        fetchImage(url, function(dataUrl) {
            root.store(url, dataUrl)
        })
    }

    // Same Referer-aware fetcher as GelbooruGallery (kept inline for the same
    // reason: external .js imports fail in the running shell).
    function fetchImage(url, onDone) {
        if (!url) {
            onDone("")
            return
        }
        if (_imageCache[url] !== undefined) {
            onDone(_imageCache[url])
            return
        }
        const request = new XMLHttpRequest()
        request.open("GET", url)
        request.setRequestHeader("Referer", "https://gelbooru.com/")
        request.responseType = "arraybuffer"
        request.onreadystatechange = function() {
            if (request.readyState !== 4)
                return
            if (request.status !== 200) {
                onDone("")
                return
            }
            const dataUrl = "data:image/jpeg;base64," + base64(new Uint8Array(request.response))
            _imageCache[url] = dataUrl
            onDone(dataUrl)
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

    function store(url, dataUrl) {
        if (!url || !dataUrl)
            return
        if (thumbs[url] === dataUrl)
            return
        const next = {}
        for (const key in thumbs)
            next[key] = thumbs[key]
        next[url] = dataUrl
        thumbs = next
    }

    Item {
        anchors.fill: parent

        Image {
            visible: root.latest !== null
            anchors.fill: parent
            asynchronous: true
            source: root.thumbs[root.thumbUrl] ?? ""
            fillMode: Image.PreserveAspectCrop
        }

        Column {
            visible: root.latest === null
            anchors.centerIn: parent
            spacing: Theme.spacingS

            DIcon {
                anchors.horizontalCenter: parent.horizontalCenter
                name: "image"
                size: Theme.iconSizeLarge
                color: root.contentColor
            }

            StyledText {
                anchors.horizontalCenter: parent.horizontalCenter
                text: "Gelbooru"
                color: root.contentColor
                font.pixelSize: Theme.fontSizeMedium
            }
        }
    }
}
