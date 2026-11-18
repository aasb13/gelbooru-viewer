import QtQuick
import qs.Common
import qs.DCommon.Widgets
import "GelbooruNet.js" as Net

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
        Net.fetch(url, function(dataUrl) {
            root.store("thumbs", url, dataUrl)
        })
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
        Net.fetch(url, function(dataUrl) {
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
