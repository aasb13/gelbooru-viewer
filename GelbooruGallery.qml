import QtQuick
import qs.Common
import qs.DCommon.Widgets

Item {
    id: root

    property var posts: []
    property string query: ""
    property int page: 0
    property int totalPages: 0
    property bool loading: false
    property int fetchTick: 0
    property int columns: 3
    property var mutate: null
    property color baseColor: Theme.hostSurface

    property var selectedPost: null

    property var thumbs: ({})
    property var detailCache: ({})
    property string detailSource: ""
    property bool detailIsVideo: false

    property var _imageCache: ({})
    property var _imageInflight: ({})
    property var _imageQueue: []
    property int _imageActive: 0

    readonly property int cellSize: Math.max(120, Math.floor((width - Theme.spacingS * Math.max(0, columns - 1)) / Math.max(1, columns)))
    readonly property int defaultRows: 3
    readonly property int defaultGridHeight: defaultRows * cellSize + (defaultRows - 1) * Theme.spacingS

    implicitHeight: headerRow.height + Theme.spacingM + defaultGridHeight + Theme.spacingM + footerRow.height

    function refresh() {
        if (!mutate)
            return
        mutate("fetchTick", fetchTick + 1)
    }

    function submitSearch() {
        if (!mutate)
            return
        mutate("page", 0)
        mutate("query", searchInput.text.trim())
        mutate("fetchTick", fetchTick + 1)
    }

    function gotoPage(target) {
        if (!mutate)
            return
        const clamped = Math.min(Math.max(0, target), Math.max(0, totalPages - 1))
        if (clamped === page)
            return
        mutate("page", clamped)
        mutate("fetchTick", fetchTick + 1)
    }

    function requestThumb(url) {
        if (!url)
            return
        fetchImage(url, function(dataUrl) {
            root.store("thumbs", url, dataUrl)
        })
    }

    // The gelbooru image hosts 302-redirect every request without a gelbooru.com
    // Referer to a hotlink-block page, and QML Image cannot set request headers:
    // all images are fetched here and handed to Image.source as data URLs.
    // This logic is deliberately inline — external .js imports from plugin QML
    // fail in the running shell ("File name case mismatch", 2026-11-19).
    function fetchImage(url, onDone, cacheable) {
        if (!url) {
            onDone("")
            return
        }
        if (_imageCache[url] !== undefined) {
            onDone(_imageCache[url])
            return
        }
        if (_imageInflight[url] !== undefined) {
            _imageInflight[url].push(onDone)
            return
        }
        _imageInflight[url] = [onDone]
        _imageQueue.push({
            url: url,
            cacheable: cacheable !== false
        })
        _pump()
    }

    function _pump() {
        while (_imageActive < 8 && _imageQueue.length > 0) {
            const item = _imageQueue.shift()
            _imageActive++
            _startImage(item.url, item.cacheable)
        }
    }

    function _startImage(url, cacheable) {
        const request = new XMLHttpRequest()
        request.open("GET", url)
        request.setRequestHeader("Referer", "https://gelbooru.com/")
        request.responseType = "arraybuffer"
        request.onreadystatechange = function() {
            if (request.readyState !== 4)
                return
            _imageActive--
            const waiters = _imageInflight[url] || []
            delete _imageInflight[url]
            let dataUrl = ""
            if (request.status === 200) {
                dataUrl = "data:image/jpeg;base64," + base64(new Uint8Array(request.response))
                if (cacheable) {
                    const keys = Object.keys(_imageCache)
                    while (keys.length >= 256)
                        delete _imageCache[keys.shift()]
                    _imageCache[url] = dataUrl
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

    function store(mapName, url, dataUrl) {
        if (!url || !dataUrl)
            return
        const map = root[mapName]
        if (map[url] === dataUrl)
            return
        const next = {}
        for (const key in map)
            next[key] = map[key]
        next[url] = dataUrl
        root[mapName] = next
    }

    onSelectedPostChanged: loadDetail(selectedPost ? (selectedPost.fileUrl ?? "") : "")

    function loadDetail(url) {
        detailSource = ""
        detailIsVideo = /\.(mp4|webm|mov|mkv)(\?|$)/.test(url)
        if (!url || detailIsVideo)
            return
        if (detailCache[url]) {
            detailSource = detailCache[url]
            return
        }
        fetchImage(url, function(dataUrl) {
            if (!dataUrl)
                return
            root.store("detailCache", url, dataUrl)
            const keys = Object.keys(root.detailCache)
            while (keys.length > 2) {
                delete root.detailCache[keys.shift()]
            }
            if ((root.selectedPost ? (root.selectedPost.fileUrl ?? "") : "") === url)
                root.detailSource = dataUrl
        }, false)
    }

    Item {
        id: headerRow

        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        height: Theme.buttonHeightM + Theme.spacingS

        Rectangle {
            id: searchBox

            anchors.left: parent.left
            anchors.right: searchButton.left
            anchors.rightMargin: Theme.spacingS
            anchors.verticalCenter: parent.verticalCenter
            height: Theme.buttonHeightM
            radius: Theme.fullRadius(width, height)
            color: Theme.chipSurface
            border.width: 1
            border.color: searchInput.activeFocus ? Theme.primary : Theme.outline

            DIcon {
                id: searchIcon

                anchors.left: parent.left
                anchors.leftMargin: Theme.spacingM
                anchors.verticalCenter: parent.verticalCenter
                name: "search"
                size: Theme.iconSizeSmall
                color: Theme.onSurfaceVariant
            }

            TextInput {
                id: searchInput

                anchors.left: searchIcon.right
                anchors.leftMargin: Theme.spacingS
                anchors.right: parent.right
                anchors.rightMargin: Theme.spacingM
                anchors.verticalCenter: parent.verticalCenter
                text: root.query
                color: Theme.onSurface
                font.pixelSize: Theme.fontSizeMedium
                clip: true

                Keys.onReturnPressed: root.submitSearch()
                Keys.onEnterPressed: root.submitSearch()
            }

            StyledText {
                visible: searchInput.text.length === 0
                anchors.left: searchIcon.right
                anchors.leftMargin: Theme.spacingS
                anchors.right: parent.right
                anchors.rightMargin: Theme.spacingM
                anchors.verticalCenter: parent.verticalCenter
                text: "Search tags"
                color: Theme.onSurfaceVariant
                font.pixelSize: Theme.fontSizeMedium
            }
        }

        DActionButton {
            id: searchButton

            anchors.right: refreshButton.left
            anchors.rightMargin: Theme.spacingS
            anchors.verticalCenter: parent.verticalCenter
            buttonSize: Theme.buttonHeightM
            iconSize: Theme.iconSize
            iconName: "search"
            iconColor: Theme.onSurface
            onClicked: root.submitSearch()
        }

        DActionButton {
            id: refreshButton

            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            buttonSize: Theme.buttonHeightM
            iconSize: Theme.iconSize
            iconName: "refresh"
            iconColor: Theme.onSurface
            enabled: !root.loading
            onClicked: root.refresh()
        }
    }

    GridView {
        id: grid

        anchors.top: headerRow.bottom
        anchors.topMargin: Theme.spacingM
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: footerRow.top
        anchors.bottomMargin: Theme.spacingM
        visible: root.selectedPost === null
        clip: true
        cellWidth: root.cellSize
        cellHeight: root.cellSize
        model: root.posts

        delegate: Item {
            width: grid.cellWidth
            height: grid.cellHeight

            Image {
                id: thumbImage

                property string url: modelData && modelData.previewUrl ? modelData.previewUrl : ""

                anchors.fill: parent
                anchors.margins: Theme.spacingXS
                asynchronous: true
                source: root.thumbs[thumbImage.url] ?? ""
                fillMode: Image.PreserveAspectCrop

                MouseArea {
                    anchors.fill: parent
                    onClicked: root.selectedPost = modelData
                }

                Component.onCompleted: root.requestThumb(thumbImage.url)
                onUrlChanged: root.requestThumb(thumbImage.url)
            }
        }
    }

    StyledText {
        visible: root.selectedPost === null && root.posts.length === 0
        anchors.centerIn: grid
        text: root.loading ? "Loading" : "No posts"
        color: Theme.onSurfaceVariant
        font.pixelSize: Theme.fontSizeMedium
    }

    Rectangle {
        anchors.fill: parent
        visible: root.selectedPost !== null
        color: root.baseColor
        radius: Theme.cornerRadiusM

        DActionButton {
            id: backButton

            anchors.top: parent.top
            anchors.left: parent.left
            anchors.margins: Theme.spacingM
            buttonSize: Theme.buttonHeightM
            iconSize: Theme.iconSize
            iconName: "arrow_back"
            iconColor: Theme.onSurface
            onClicked: root.selectedPost = null
        }

        Flickable {
            id: detailArea

            anchors.top: backButton.bottom
            anchors.bottom: detailCaption.top
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.margins: Theme.spacingM
            clip: true
            contentWidth: width
            contentHeight: detailImage.height

            Image {
                id: detailImage

                readonly property real aspect: (implicitWidth > 0 && implicitHeight > 0) ? implicitHeight / implicitWidth : 0

                asynchronous: true
                visible: !root.detailIsVideo
                width: parent.width
                height: aspect > 0 ? width * aspect : parent.height
                source: root.detailSource
                fillMode: Image.PreserveAspectFit
            }

            StyledText {
                visible: root.detailIsVideo
                anchors.centerIn: detailArea
                text: "Video preview not supported"
                color: Theme.onSurfaceVariant
                font.pixelSize: Theme.fontSizeMedium
            }
        }

        StyledText {
            id: detailCaption

            anchors.bottom: parent.bottom
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.margins: Theme.spacingM
            height: implicitHeight + Theme.spacingS
            visible: root.selectedPost !== null
            elide: Text.ElideRight
            maximumLineCount: 1
            font.pixelSize: Theme.fontSizeSmall
            color: Theme.onSurfaceVariant
            text: {
                if (!root.selectedPost)
                    return ""
                const post = root.selectedPost
                const tags = (post.tags ?? "").split(/\s+/).slice(0, 12).join(", ")
                return "score " + (post.score ?? 0) + "  " + (post.width ?? 0) + "x" + (post.height ?? 0)
                    + (tags.length > 0 ? "  " + tags : "")
            }
        }
    }

    Item {
        id: footerRow

        anchors.bottom: parent.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        height: Theme.buttonHeightM
        visible: root.selectedPost === null

        DActionButton {
            id: prevButton

            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            buttonSize: Theme.buttonHeightM
            iconSize: Theme.iconSize
            iconName: "chevron_left"
            iconColor: Theme.onSurface
            enabled: root.page > 0 && !root.loading
            onClicked: root.gotoPage(root.page - 1)
        }

        StyledText {
            anchors.centerIn: parent
            text: root.loading
                ? "Loading"
                : "Page " + (root.page + 1) + (root.totalPages > 0 ? " of " + root.totalPages : "")
            color: Theme.onSurfaceVariant
            font.pixelSize: Theme.fontSizeSmall
        }

        DActionButton {
            id: nextButton

            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            buttonSize: Theme.buttonHeightM
            iconSize: Theme.iconSize
            iconName: "chevron_right"
            iconColor: Theme.onSurface
            enabled: !root.loading && (root.totalPages <= 0 || root.page < root.totalPages - 1)
            onClicked: root.gotoPage(root.page + 1)
        }
    }
}
